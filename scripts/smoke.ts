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
 * including today's actual state (Knowledge Base never applied, FL-019) and
 * the brief's own "apply didn't replace the revision" failure mode - and
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
  if (!passages.some(p => p.docTitle === SMOKE_MANUAL_TITLE && p.text.includes('F21')))
    throw new Error(
      `ask_manual did not return the seeded KB document; got: ${passages.map(p => `${p.docTitle} p${p.page}`).join(', ')} - the runtime may be falling back to the fixture retriever (KNOWLEDGE_BASE_ID unset on this revision)`
    );
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

// ESM's canonical "am I the entrypoint" check (same pattern as manuals.ts
// and seed-manual.ts): keeps every export above importable - and therefore
// unit-testable - without requiring MCP_URL/COGNITO_* or touching the
// network merely to import this module.
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

    // Real Knowledge Base retrieval against the document seed:manual ingested.
    const manual = await timed('modern ask_manual (knowledge base)', () =>
      client.callTool({ name: 'ask_manual', arguments: { question: 'What does error code F21 mean on the washer?' } })
    );
    const passages = (manual.structuredContent as { passages: ManualPassage[] }).passages;
    assertManualPassages(passages);
    console.log(`ask_manual: ${passages.length} passage(s), first from ${passages[0]!.docTitle} page ${passages[0]!.page}`);

    const manualText = (manual.content as Array<{ text?: string }>)[0]?.text ?? '';
    assertSpokenProse(manualText);

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
