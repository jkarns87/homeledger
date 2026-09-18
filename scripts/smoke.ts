import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SEED_APPLIANCE_COUNT } from '@homeledger/core';
import { SMOKE_MANUAL_TITLE } from './seed-manual.js';

export const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

const BUDGET_MS = 3000;

// Registration order is frozen (server.ts's own comment says so) and mirrors
// apps/mcp-server/test/tools.test.ts's in-process assertion of the same
// list against the real buildServer() output.
export const EXPECTED_TOOLS = [
  'list_appliances',
  'get_appliance',
  'maintenance_due',
  'log_maintenance',
  'recent_events',
  'ask_manual',
  'book_service',
  'get_visit',
  'echo_confirm'
];

/**
 * Tool -> widget URI, for every tool spec 4.2 wires to a widget
 * (apps/mcp-server/src/widgets/index.ts WIDGET_URIS, set via each tool's
 * `_meta: uiMeta(...)`). The Task 13 brief only checked maintenance_due and
 * get_visit; extended to all five per controller ruling, since a
 * silently-dropped `_meta` on list_appliances, get_appliance, or
 * book_service is exactly the kind of regression this script exists to
 * catch, and it is the same code shape as the two-tool version. Mirrors
 * apps/mcp-server/test/widgets.test.ts's "points the five widget-backed
 * tools..." in-process assertion of the same map against the real server.
 */
export const WIDGET_EXPECTATIONS: ReadonlyArray<readonly [tool: string, uri: string]> = [
  ['list_appliances', 'ui://homeledger/appliances'],
  ['get_appliance', 'ui://homeledger/appliance'],
  ['maintenance_due', 'ui://homeledger/calendar'],
  ['book_service', 'ui://homeledger/visit'],
  ['get_visit', 'ui://homeledger/visit']
];

/** Narrowed shape of an MCP `Tool` this script actually reads, so the widget/order checks below can be driven with plain fixtures in tests. */
export interface SmokeTool {
  name: string;
  _meta?: unknown;
}

export function widgetUriOf(tools: SmokeTool[], name: string): string | undefined {
  return (tools.find(t => t.name === name)?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
}

export function assertToolOrder(names: string[]): void {
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) throw new Error(`tool order ${names.join(',')}`);
}

export function assertWidgetWiring(tools: SmokeTool[]): void {
  for (const [name, uri] of WIDGET_EXPECTATIONS) {
    if (widgetUriOf(tools, name) !== uri) throw new Error(`${name} lost its widget reference`);
  }
}

/**
 * FL-023 regression guard, restored per controller ruling: re-seeding
 * without a reset once added SEED_APPLIANCE_COUNT more appliance rows on
 * every run instead of overwriting the same ones, and the live table
 * reached roughly 4x its intended size before anyone noticed. The fix was
 * fixed seed ids plus Repository.resetHousehold(); this assertion is what
 * proves that fix still holds. Deliberately an exact match, not a floor
 * (`< SEED_APPLIANCE_COUNT` alone would miss the actual failure mode, which
 * is too MANY rows, not too few) - see the mutation check in the task
 * report/FL-031 for a duplicated-count case this exact-match form catches
 * and a floor-only form would not.
 */
export function assertApplianceCount(count: number): void {
  if (count !== SEED_APPLIANCE_COUNT)
    throw new Error(`expected ${SEED_APPLIANCE_COUNT} seeded appliances, got ${count} - table may hold duplicates from before the reset-before-seed fix`);
}

export interface ManualPassage {
  text: string;
  docTitle: string;
  page: number | null;
}

/**
 * Confirms ask_manual answered from the deployed Knowledge Base, not the
 * server's own createFixtureRetriever fallback (task-13-review.md Finding
 * 1, CRITICAL). apps/mcp-server/src/deps.ts silently returns the fixture
 * retriever whenever KNOWLEDGE_BASE_ID is unset on the runtime revision -
 * including the brief's own "apply didn't replace the revision" failure
 * mode, and today's actual state, which is NOT what an earlier version of
 * this comment claimed: the Knowledge Base applied cleanly and exists, but
 * nothing has ever been ingested into it because the account-wide Bedrock
 * model block refuses the embedding call (FL-019, FL-032) - and
 * @homeledger/core's SAMPLE_MANUAL_PASSAGES[0] matches this smoke's exact
 * question on four keywords and contains "F21", so a bare substring check
 * on "F21" cannot tell the two apart: it would report SMOKE OK against a
 * system with no Knowledge Base, S3 Vectors index, ingestion job, or
 * Bedrock call at all. SMOKE_MANUAL_TITLE is the literal title
 * seed-manual.ts writes into the sidecar the KB retriever reads docTitle
 * from (packages/core/src/retrieval/bedrock.ts); no fixture passage
 * carries it, so requiring BOTH docTitle and the F21 text can only pass
 * against real ingested content.
 */
export function assertManualPassages(passages: readonly ManualPassage[]): void {
  if (passages.length === 0) throw new Error('ask_manual returned no passages; run seed:manual and confirm the ingestion job completed');
  // Every field access here is optional-chained and type-checked before use.
  // Not defensive decoration: this is the same class of bug as the
  // `structuredContent.passages` crash in run 35290491286 - a malformed
  // passage (missing `text`, a null entry) would make `p.text.includes`
  // throw a TypeError and kill the run before the legacy block, which is
  // exactly the outcome readManualResult exists to prevent one level up. A
  // passage that is not the right SHAPE is not the seeded document, so it
  // correctly fails the match rather than crashing the comparison.
  if (!passages.some(p => p?.docTitle === SMOKE_MANUAL_TITLE && typeof p?.text === 'string' && p.text.includes('F21')))
    throw new Error(
      `ask_manual did not return the seeded KB document; got: ${passages.map(p => `${p?.docTitle} p${p?.page}`).join(', ')} - the runtime may be falling back to the fixture retriever (KNOWLEDGE_BASE_ID unset on this revision)`
    );
}

/**
 * The first content block's text, or '' when there is not one.
 *
 * `content` is typed as an array by the SDK but is genuinely absent on some
 * results, and `(undefined as unknown[])[0]` throws rather than yielding
 * undefined - so the call site's old `(manual.content as Array<...>)[0]?.text`
 * was a TypeError waiting for the same result shape that crashed
 * run 35290491286, with the `?.` giving false reassurance one level too late.
 */
export function firstTextBlock(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const first: unknown = content[0];
  if (typeof first !== 'object' || first === null) return '';
  const text = (first as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

export type ManualResult = { kind: 'passages'; passages: ManualPassage[] } | { kind: 'error'; detail: string };

/**
 * Classifies an `ask_manual` tool result without ever dereferencing a field
 * that may be absent.
 *
 * Run 35290491286 died on `(manual.structuredContent as {...}).passages` with
 * `TypeError: Cannot read properties of undefined`. The cause is sharper than
 * the state it exposed: retrieval embeds the QUERY, not just the documents,
 * so under the account-wide Bedrock block `Retrieve` is refused server-side
 * even against a Knowledge Base that exists. `createKnowledgeBaseRetriever`
 * does not catch that (packages/core/src/retrieval/bedrock.ts calls
 * `sender.send` bare), `ask_manual` does not catch it either
 * (apps/mcp-server/src/tools/manual.ts), so it propagates to the MCP SDK,
 * which converts a thrown handler into `{ isError: true, content: [...] }`
 * with NO `structuredContent` at all.
 *
 * This function is deliberately total: every input, including `undefined`, a
 * string, a result with no `structuredContent`, and a `structuredContent`
 * whose `passages` is not an array, maps to a `ManualResult` rather than to a
 * throw. A smoke script must fail with a sentence that names what went wrong
 * or skip with a sentence that says why - never with a stack trace from a
 * property access, which says nothing about the system under test and stops
 * every later assertion from running.
 *
 * Classifying is ALL it does. Whether an error result is tolerable is
 * `checkManualPassages`'s decision and only its decision.
 */
export function readManualResult(result: unknown): ManualResult {
  if (typeof result !== 'object' || result === null)
    return { kind: 'error', detail: `tool result was ${result === null ? 'null' : typeof result}, not an object` };
  const row = result as { isError?: unknown; content?: unknown; structuredContent?: unknown };
  const spoken = firstTextBlock(row.content);
  if (row.isError === true) return { kind: 'error', detail: `isError result: ${spoken || '(no text content)'}` };
  const structured: unknown = row.structuredContent;
  if (typeof structured !== 'object' || structured === null)
    return {
      kind: 'error',
      detail: `result carried no structuredContent (got ${structured === null ? 'null' : typeof structured}); first text block: ${spoken || '(none)'}`
    };
  const passages: unknown = (structured as { passages?: unknown }).passages;
  if (!Array.isArray(passages))
    return { kind: 'error', detail: `structuredContent.passages was ${passages === null ? 'null' : typeof passages}, not an array` };
  return { kind: 'passages', passages: passages as ManualPassage[] };
}

export const ASK_MANUAL_SKIP_NO_KNOWLEDGE_BASE =
  '\n!! ask_manual: SKIPPED - no KNOWLEDGE_BASE_ID configured, so no Knowledge Base is provisioned and this run proves nothing about real retrieval (FRICTION-LOG.md FL-019).\n';

export const ASK_MANUAL_SKIP_INGESTION_BLOCKED =
  '\n!! ask_manual: SKIPPED - a Knowledge Base IS provisioned, but seed:manual could not ingest into it: Bedrock model invocation is blocked account-wide, so the Knowledge Base role cannot call the embedding model (FRICTION-LOG.md FL-019, FL-032). The Knowledge Base is therefore empty and ask_manual is answering from the fixture retriever. This run proves nothing about real retrieval; every other assertion below still ran.\n';

/**
 * Reads the workflow's `MANUAL_INGESTION_SKIPPED` signal.
 *
 * Fails CLOSED, and that is the whole design of this function: only an
 * explicit affirmative counts as "ingestion was skipped". Unset, empty,
 * whitespace, `0`, `false`, and anything unrecognised all mean "enforce".
 * The alternative - treating any non-empty string as truthy, the reflexive
 * shell idiom - would turn a stray `MANUAL_INGESTION_SKIPPED=false` or a
 * copy-paste of the variable name into a permanent, silent disabling of the
 * one assertion in this file that exists to stop a false green. Making the
 * skip opt-in by exact value means the failure mode of a mistyped signal is
 * a red pipeline, not a green one that proves nothing.
 */
export function manualIngestionSkipped(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * The fourth state's line, built around the detail readManualResult
 * extracted, so the log carries the server's own words rather than this
 * script's guess about them.
 */
export function askManualRetrievalUnavailableLine(detail: string): string {
  return `\n!! ask_manual: SKIPPED - a Knowledge Base IS provisioned, but RETRIEVAL ITSELF is impossible: Bedrock has to embed the QUERY, not just the documents, so Retrieve is refused server-side under the account-wide model block even against a Knowledge Base that exists (FRICTION-LOG.md FL-019, FL-032). ask_manual returned an error result instead of passages, which is expected in this state and is why it is tolerated HERE and nowhere else. The tool was still reached, invoked and answered in budget. Server said: ${detail}\n`;
}

export type ManualCheckOutcome = 'skipped-no-knowledge-base' | 'skipped-ingestion-blocked' | 'skipped-retrieval-unavailable' | 'asserted';

/**
 * Decides between skipping the Knowledge Base check and enforcing it, and is
 * the ONLY place that decision is made. There are three states, not two.
 *
 * 1. No `KNOWLEDGE_BASE_ID` -> no Knowledge Base exists to retrieve from.
 *    The value comes from .github/workflows/smoke.yml, which exports it from
 *    the platform root's `knowledge_base_id` Terraform output - the same
 *    value Terraform feeds the runtime's `environment_variables` map and the
 *    same variable apps/mcp-server/src/deps.ts reads to choose the Bedrock
 *    retriever over the fixture one. Nothing to prove; skip.
 *
 * 2. `KNOWLEDGE_BASE_ID` set, but ingestion was skipped. This state did not
 *    exist when this function was first written, and its absence is what
 *    broke smoke run 35238251562: the Knowledge Base module applied cleanly
 *    (bucket, Knowledge Base, IAM role all real), so the binary
 *    "is it provisioned" test says yes, while the account-wide Bedrock block
 *    means no document has ever been embedded into it. Provisioned-but-empty
 *    is a third state, and treating it as state 3 made one blocked embedding
 *    call hide the eight tools that do work. Skip, loudly. See FL-032.
 *
 * 2b. `KNOWLEDGE_BASE_ID` set, ingestion was skipped, AND ask_manual came
 *    back an error result rather than passages. Found by live run
 *    35290491286, which is where the previous version of this function died:
 *    it assumed a provisioned-but-empty Knowledge Base would at least
 *    RETRIEVE, returning an empty passage list. It does not. Retrieval
 *    embeds the query as well as the documents, so the same account-level
 *    block that refuses ingestion also refuses `Retrieve`, and the tool
 *    returns `isError` with no `structuredContent`. Skip, loudly, quoting
 *    the server's own message.
 *
 * 3. `KNOWLEDGE_BASE_ID` set and ingestion happened -> enforce, no opt-out.
 *
 * What separates state 2 from state 3 is NOT anything observable in the
 * passages: a Knowledge Base that was never ingested into and a Knowledge
 * Base serving the wrong document both come back as "no passage carries
 * SMOKE_MANUAL_TITLE", and the runtime falls back to the fixture retriever
 * in both cases. They are indistinguishable from here by construction, so
 * the distinction has to be carried in from the seed step that knows: the
 * workflow sets `MANUAL_INGESTION_SKIPPED` only when seed:manual printed its
 * skip sentinel, and `manualIngestionSkipped` above accepts only an explicit
 * affirmative. Inferring it instead - "empty result means nothing was
 * ingested" - would be precisely the false green this assertion exists to
 * prevent, because that is also what a runtime quietly serving fixtures
 * looks like.
 *
 * What this must NOT do, and does not: soften state 3. A configured
 * Knowledge Base that WAS ingested into, returning content that does not
 * carry SMOKE_MANUAL_TITLE, is the "apply didn't replace the revision" case
 * - Terraform's output populated, the running revision still unset, fixtures
 * being served, `SMOKE OK` printed against a system with no real retrieval
 * at all. It throws, exactly as before. And state 2b's tolerance of an error
 * result does NOT leak into it: when ingestion was not skipped, an error
 * result, an absent `structuredContent`, an empty passage list and a wrong
 * title all still fail hard. The error-result branch is checked FIRST and
 * gated on `ingestionSkipped` precisely so that tolerance cannot be reached
 * any other way - including with no Knowledge Base at all, where the runtime
 * serves in-memory fixtures and therefore has nothing that can legitimately
 * error.
 */
export function checkManualPassages(knowledgeBaseId: string | undefined, ingestionSkipped: boolean, result: ManualResult): ManualCheckOutcome {
  if (result.kind === 'error') {
    if (ingestionSkipped) return 'skipped-retrieval-unavailable';
    throw new Error(
      `ask_manual returned an error result instead of passages: ${result.detail} - retrieval is broken, or the runtime cannot reach the Knowledge Base. Not skippable: nothing signalled that ingestion was skipped, so a working retrieval path was expected here.`
    );
  }
  if (!knowledgeBaseId || knowledgeBaseId.trim() === '') return 'skipped-no-knowledge-base';
  if (ingestionSkipped) return 'skipped-ingestion-blocked';
  assertManualPassages(result.passages);
  return 'asserted';
}

/**
 * Voice-first contract check on a tool's first content block
 * (task-13-review.md Finding 3, IMPORTANT): an empty or missing content
 * array coerced through `?? ''` made the previous "spoke JSON" regex
 * vacuously pass, since '' never matches /[{}[\]]/. Presence is asserted
 * before shape, so a regression to no spoken text at all fails loudly
 * instead of reading as OK.
 */
export function assertSpokenProse(text: string): void {
  if (text.length === 0) throw new Error('ask_manual returned no spoken text');
  if (/[{}[\]]/.test(text)) throw new Error(`ask_manual spoke JSON: ${text}`);
}

export async function timedWithBudget<T>(label: string, fn: () => Promise<T>, budgetMs: number, enforce = true): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  const ms = Math.round(performance.now() - t0);
  console.log(`${label}: ${ms} ms`);
  if (enforce && ms > budgetMs) throw new Error(`${label} exceeded ${budgetMs} ms`);
  return out;
}

async function timed<T>(label: string, fn: () => Promise<T>, enforce = true): Promise<T> {
  return timedWithBudget(label, fn, BUDGET_MS, enforce);
}

export interface ElicitRequestedSchema {
  properties: Record<string, { enum?: string[] }>;
}

/**
 * Legacy elicitation auto-fulfilment, matching what the deployed shim's
 * three book_service rounds and echo_confirm's single round need: 'confirm'
 * always accepts true; any other single-property schema accepts its first
 * enum option, after validating the option count is in (0, 5]. Extracted
 * from the inline client.setRequestHandler(ElicitRequestSchema, ...) body
 * so it can be driven with synthetic requests offline instead of only
 * against a live session.
 */
export function buildElicitResponse(requestedSchema: ElicitRequestedSchema, asked: string[]): { action: 'accept'; content: Record<string, unknown> } {
  const field = Object.keys(requestedSchema.properties)[0] ?? '';
  asked.push(field);
  if (field === 'confirm') return { action: 'accept', content: { confirm: true } };
  const options = requestedSchema.properties[field]?.enum ?? [];
  if (options.length === 0) throw new Error(`elicitation for ${field} offered no options`);
  if (options.length > 5) throw new Error(`elicitation for ${field} offered ${options.length} options`);
  return { action: 'accept', content: { [field]: options[0] } };
}

// ESM's canonical "am I the entrypoint" check. manuals.ts and seed-manual.ts
// now carry the identical realpathSync form; for a period they carried the
// unhardened version this comment claimed they matched, which pointed a
// reader at the two defective copies as the reference. Keeps every export
// above importable - and therefore unit-testable - without requiring
// MCP_URL/COGNITO_* or touching the network merely to import this module.
//
// realpathSync on process.argv[1] is required, not cosmetic
// (task-13-review.md Finding 2, IMPORTANT): Node's ESM loader resolves
// import.meta.url through symlinks, but process.argv[1] is the path as
// typed. On a symlinked workspace (a self-hosted runner, a container
// bind-mount, macOS /tmp -> /private/tmp) the two would disagree with no
// realpath, this whole block would be silently skipped, and the process
// would exit 0 having run zero assertions. Confirmed empirically by the
// reviewer: the same file through a symlinked directory produced no output
// and exit 0 before this fix. The CI step's `grep -q '^SMOKE OK$'` in
// .github/workflows/smoke.yml is the second, independent half of this
// fix - belt and braces, since this guard can otherwise disable every
// other assertion in the script at once.
const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isEntrypoint) {
  const url = need('MCP_URL');
  const tokenUrl = need('COGNITO_TOKEN_URL');
  const clientId = need('COGNITO_CLIENT_ID');
  const clientSecret = need('COGNITO_CLIENT_SECRET');

  const token = async (): Promise<string> => {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'homeledger/mcp' })
    });
    if (!res.ok) throw new Error(`token: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { access_token: string }).access_token;
  };

  const bearer = await token();
  console.log('token: ok');

  // Modern client (2026-07-28): tool order, widget wiring, a read tool, and real retrieval.
  {
    const client = new Client({ name: 'smoke-modern', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } });
    await timed('modern connect (cold)', () => client.connect(transport), false);
    const { tools } = await timed('modern tools/list', () => client.listTools());
    assertToolOrder(tools.map(t => t.name));
    assertWidgetWiring(tools);

    // Unfiltered, not the legacy block's category-filtered call below: FL-023's
    // duplication bug inflated the WHOLE household's appliance count, and a
    // filtered call could stay looking healthy while the underlying table
    // still held duplicates outside that filter.
    const list = await timed('modern list_appliances', () => client.callTool({ name: 'list_appliances', arguments: {} }));
    const applianceCount = (list.structuredContent as { appliances: unknown[] }).appliances.length;
    console.log(`seeded appliance count: ${applianceCount}`);
    assertApplianceCount(applianceCount);

    const due = await timed('modern maintenance_due', () => client.callTool({ name: 'maintenance_due', arguments: {} }));
    if (!(due.structuredContent as { items: unknown[] }).items.length) throw new Error('no maintenance items; run seed:remote');

    // Real Knowledge Base retrieval against the document seed:manual ingested,
    // when one is provisioned AND something was actually ingested into it.
    // In either skip state the tool is answering from the fixture retriever
    // by construction; the run says so loudly and continues rather than
    // failing forever, because a pipeline that is permanently red on a
    // known, unfixable-from-here blocker is a pipeline people stop reading -
    // and because failing here aborts the process before the legacy block
    // below, so one blocked embedding call would take the other eight tools'
    // coverage down with it. Nothing else is relaxed: the call still has to
    // succeed, come back in budget, and speak prose, in every state.
    // The call is made in EVERY state, including the two skips, and that is
    // deliberate. It is the only assertion that proves ask_manual is
    // registered, reachable through the deployed runtime, accepts its input
    // schema, and answers inside the budget - tools/list proves registration
    // but never invocation, so skipping the call outright would drop the
    // ninth tool's coverage entirely to avoid an error the script can simply
    // recognise. It is also the signal that says when Bedrock comes back:
    // the day the block lifts, this stops being an error result and starts
    // being passages, and the run says so instead of silently continuing to
    // skip. What changes per state is how the RESULT is read, never whether
    // the call happens.
    const manual = await timed('modern ask_manual (knowledge base)', () =>
      client.callTool({ name: 'ask_manual', arguments: { question: 'What does error code F21 mean on the washer?' } })
    );
    const manualResult = readManualResult(manual);
    const manualOutcome = checkManualPassages(process.env.KNOWLEDGE_BASE_ID, manualIngestionSkipped(process.env.MANUAL_INGESTION_SKIPPED), manualResult);
    if (manualOutcome === 'skipped-no-knowledge-base') console.log(ASK_MANUAL_SKIP_NO_KNOWLEDGE_BASE);
    else if (manualOutcome === 'skipped-ingestion-blocked') console.log(ASK_MANUAL_SKIP_INGESTION_BLOCKED);
    else if (manualOutcome === 'skipped-retrieval-unavailable')
      console.log(askManualRetrievalUnavailableLine(manualResult.kind === 'error' ? manualResult.detail : ''));
    else if (manualResult.kind === 'passages')
      console.log(
        `ask_manual: ${manualResult.passages.length} passage(s), first from ${manualResult.passages[0]!.docTitle} page ${manualResult.passages[0]!.page}`
      );

    // Gated on the outcome, not skipped wholesale. In the retrieval-
    // unavailable state the first content block is the SDK's rendering of a
    // thrown handler, so "did the tool speak prose?" is not a question about
    // this system at all - the answer would be about AWS's error string. In
    // every other state, including both other skips (where the tool really
    // does answer, from fixtures or with "I couldn't find anything"), the
    // voice-first contract is enforced exactly as before.
    if (manualOutcome !== 'skipped-retrieval-unavailable') assertSpokenProse(firstTextBlock(manual.content));

    await client.close();
  }

  // Legacy client (2025-era): elicitation through the shim, one round and three.
  {
    const client = new LegacyClient({ name: 'Alexa+ MCP Client', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    const asked: string[] = [];
    // Captured and re-thrown below rather than left to the SDK
    // (task-13-review.md Minor 7): a throw from inside this request handler
    // is converted by the SDK into a JSON-RPC error response instead of
    // failing the process, so without this the operator only ever sees the
    // vaguer downstream comparison failure ("legacy book_service asked
    // provider") instead of the specific cause ("elicitation for provider
    // offered 0 options").
    let elicitError: Error | undefined;
    client.setRequestHandler(ElicitRequestSchema, async request => {
      try {
        // ElicitRequestSchema.params is a form/url mode union in this SDK
        // version (the brief predates url-mode elicitation); homeledger's own
        // elicit.ts only ever builds form-mode requests (enumField/
        // booleanField), so url mode here would itself be a regression worth
        // failing loudly on rather than a case to silently handle.
        if (request.params.mode === 'url') throw new Error(`legacy elicitation arrived in url mode: ${request.params.url}`);
        return buildElicitResponse(request.params.requestedSchema as ElicitRequestedSchema, asked);
      } catch (err) {
        elicitError = err instanceof Error ? err : new Error(String(err));
        throw err;
      }
    });
    const transport = new LegacyTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } });
    await timed('legacy initialize (cold)', () => client.connect(transport), false);
    if (!transport.sessionId) throw new Error('legacy: no Mcp-Session-Id');
    console.log(`legacy session: ${transport.sessionId}`);

    const echo = await timed('legacy echo_confirm (elicitation)', () => client.callTool({ name: 'echo_confirm', arguments: { message: 'smoke' } }));
    if (elicitError) throw elicitError;
    if (JSON.stringify(echo.structuredContent) !== JSON.stringify({ confirmed: true, message: 'smoke' }))
      throw new Error(`legacy elicitation result ${JSON.stringify(echo.structuredContent)}`);

    const list = await timed('legacy list_appliances', () => client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } }));
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]?.id;
    if (!applianceId) throw new Error('no water heater in the table; run seed:remote');

    asked.length = 0;
    const progress: number[] = [];
    const booked = await timed(
      'legacy book_service (three elicitations plus progress)',
      () =>
        client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'smoke test booking' } }, undefined, {
          onprogress: p => progress.push(p.progress)
        }),
      false
    );
    if (elicitError) throw elicitError;
    if (JSON.stringify(asked) !== JSON.stringify(['provider', 'window', 'confirm'])) throw new Error(`legacy book_service asked ${asked.join(',')}`);
    const visit = booked.structuredContent as { visitId: string; provider: string; status: string };
    if (visit.status !== 'scheduled') throw new Error(`legacy book_service status ${visit.status}`);
    if (!/^visit_[a-z2-7]{16}$/.test(visit.visitId)) throw new Error(`legacy book_service visitId ${visit.visitId}`);
    if (!visit.provider) throw new Error('legacy book_service returned an empty provider name');
    console.log(`legacy book_service: ${visit.provider} ${visit.visitId}, progress ${progress.join(',') || 'none'}`);

    // Both fields checked, not just providerName (task-13-review.md Minor
    // 5): comparing only providerName leaves an `undefined !== undefined`
    // blind spot if both sides ever lost the field at once; id is a second,
    // independent point of agreement between the two tools' responses.
    const fetched = await timed('legacy get_visit', () => client.callTool({ name: 'get_visit', arguments: { visitId: visit.visitId } }));
    const fetchedVisit = (fetched.structuredContent as { visit: { id: string; providerName: string }; snapshotUrl: string | null }).visit;
    if (fetchedVisit.id !== visit.visitId) throw new Error(`get_visit returned visit ${fetchedVisit.id}, expected ${visit.visitId}`);
    if (fetchedVisit.providerName !== visit.provider) throw new Error(`get_visit returned provider ${fetchedVisit.providerName}, expected ${visit.provider}`);

    try {
      await transport.terminateSession();
    } catch (err) {
      // AgentCore Runtime has been observed not to route this explicit DELETE
      // termination call to the same microVM that served the session, even
      // though every prior POST/GET on the session (including the elicitation
      // round trips above) did route correctly — see FL-022. AgentCore manages
      // session lifecycle itself via idle timeout, so an on-demand DELETE is
      // best-effort cleanup, not part of the smoke contract; log and continue.
      console.log(`legacy terminateSession: non-fatal - ${err instanceof Error ? err.message : String(err)}`);
    }
    await client.close();
  }

  console.log('SMOKE OK');
}
