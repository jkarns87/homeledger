import type Anthropic from '@anthropic-ai/sdk';
import { SEED_TIMEZONE } from '@homeledger/core';
import { createElicitRouter, type ElicitRouter } from './agent.js';
import { isUnauthenticatedLocal, resolveUpstream } from './credentials.js';
import { ElicitationRegistry } from './elicitation.js';
import { readSimulatorEnv, SimulatorConfigError, type SimulatorEnv } from './env.js';
import { HomeLedgerMcp } from './mcp.js';
import { createAnthropicClient, createModelPort, type ModelPort } from './model.js';
import { createScriptedModel } from './scripted-model.js';
import type { McpToolDescriptor } from './tools.js';

export interface Conversation {
  mcp: HomeLedgerMcp;
  registry: ElicitationRegistry;
  router: ElicitRouter;
  model: ModelPort;
  /** Read once at connect, in the server's frozen order. A tool added to the server is picked up by restarting this process, not by a redeploy of it. */
  tools: McpToolDescriptor[];
  env: SimulatorEnv;
  /** How the address was FOUND, which does not change. Where it points does — read `mcp.endpointUrl` for that. */
  endpoint: { arn: string | undefined; origin: 'url' | 'arn' | 'name' };
  /** The household's IANA zone. Every date this process speaks is computed in it, never in UTC. */
  timeZone: string;
  /** The one clock this conversation reads, for tool timings and for the calendar date alike. */
  now: () => number;
  history: Anthropic.MessageParam[];
  /**
   * True when `model` is the scripted stand-in, never the real Anthropic
   * client. Carried on the conversation, not just logged, so `handleDebug`
   * can expose it and the UI can show a visible marker — a judged demo must
   * never pass scripted text off as a model's, and a startup log line nobody
   * is watching is not that guarantee.
   */
  scripted: boolean;
}

/**
 * The household's time zone, from the household's own record.
 *
 * Read rather than configured, because the server reads it the same way
 * (`resolveHouseholdTimeZone`) and a second source would let the spoken date
 * and the rendered one disagree — which is the bug class spec §4.2 exists to
 * close. `SEED_TIMEZONE` is the fallback and **UTC is not**: falling back to
 * UTC would put the date back on the boundary that flips five hours early in
 * US Central, quietly, on the one day somebody is watching. The fallback is
 * logged every time it is taken, because a wrong-but-plausible zone is the
 * hardest kind of wrong to notice.
 */
export async function householdTimeZone(mcp: Pick<HomeLedgerMcp, 'readResource'>, log: (m: string) => void = () => {}): Promise<string> {
  try {
    const record: unknown = JSON.parse(await mcp.readResource('homeledger://household'));
    const zone = typeof record === 'object' && record !== null ? (record as { timezone?: unknown }).timezone : undefined;
    if (typeof zone === 'string' && zone.trim() !== '') return zone.trim();
    log(`the household record named no time zone; speaking dates in ${SEED_TIMEZONE}`);
  } catch (error) {
    log(`could not read homeledger://household (${error instanceof Error ? error.message : String(error)}); speaking dates in ${SEED_TIMEZONE}`);
  }
  return SEED_TIMEZONE;
}

/**
 * One conversation per process, built on first use.
 *
 * Process-wide rather than per-request because the MCP session, the tool list
 * and the chat history all have to outlive one HTTP request, and because an
 * elicitation answer arriving on its own request must find the turn that asked
 * — which is only possible inside the process running it. That is a real
 * constraint on how this can be deployed and it is written down rather than
 * assumed: behind more than one instance, `POST /api/agent/answer` reaches the
 * wrong one and the registry reports `unknown-turn`, which is the same class of
 * failure as FL-039 and is why the route says so in a sentence instead of
 * failing silently.
 */
export const SCRIPTED_MODEL_FLAG = 'HOMELEDGER_SIMULATOR_SCRIPTED_MODEL';

/**
 * Whether to answer from a fixed script instead of from the model.
 *
 * On for the end-to-end suite only, and opt-in by exact value for the same
 * reason `MANUAL_INGESTION_SKIPPED` is (FL-032): a flag that accepts anything
 * truthy is a flag that gets switched on by a stray `0` or a typo, and a demo
 * that quietly stopped calling the model would look exactly like a demo that
 * was calling it. The startup log says which mode is running, every time.
 */
export function scriptedModelRequested(source: NodeJS.ProcessEnv = process.env): boolean {
  return source[SCRIPTED_MODEL_FLAG] === '1';
}

/**
 * Refuses scripted mode against anything but a local, unauthenticated
 * upstream — the same gate `resolveUpstream` uses to decide whether to skip
 * Cognito, reused here so the two can never disagree.
 *
 * The flag alone is not a safety property: it works exactly as well pointed
 * at the deployed runtime as at a local one, and `.env.local` is exactly the
 * kind of file a person edits for one run and does not always edit back.
 * Left ungated, a leftover `HOMELEDGER_SIMULATOR_SCRIPTED_MODEL=1` would let
 * a judged, recorded demo against the real AgentCore runtime answer every
 * question from `scripted-model.ts`'s fixed script, with nothing on screen
 * saying so — the single console line in `build()` is not a guarantee,
 * because nobody watches server logs during a recorded demo. Throwing here
 * turns that into the same readable 503 a missing `ANTHROPIC_API_KEY`
 * already produces (every route already catches `getConversation()`'s
 * rejection and passes the message through — see `src/app/api/*\/route.ts`),
 * rather than a silent wrong answer.
 */
export function assertScriptedModeAllowed(source: NodeJS.ProcessEnv = process.env): void {
  if (!scriptedModelRequested(source) || isUnauthenticatedLocal(source)) return;
  throw new SimulatorConfigError(
    `${SCRIPTED_MODEL_FLAG}=1 answers every turn from a fixed script, never from a model, and must never run against the deployed runtime. ` +
      'It only runs when HOMELEDGER_MCP_URL is a loopback address (127.0.0.1, localhost or [::1]) with no HOMELEDGER_COGNITO_TOKEN_URL configured ' +
      `(see isUnauthenticatedLocal in credentials.ts). Unset ${SCRIPTED_MODEL_FLAG}, or point HOMELEDGER_MCP_URL at a local server, to continue.`
  );
}

/**
 * Where the singleton actually lives.
 *
 * A plain module-scope `let` is not one process-wide slot under `next dev`:
 * every route handler (`turn`, `answer`, `debug`, `widget`, `widget/tool`)
 * compiles as its own on-demand entry, and each entry gets its own evaluation
 * of this module — confirmed by the startup log line above printing once per
 * route the first time it is hit, not once per process. Four separate
 * `Conversation`s means four separate `ElicitationRegistry`s, so a click's
 * `POST /api/agent/answer` reaches a registry that never heard of the turn
 * `/api/agent/turn` opened seconds earlier and reports `unknown-turn` on the
 * first click, every time — not the FL-039 class of failure the docstring
 * above describes (a lost session on the far side), but a self-inflicted copy
 * of it caused by dev-mode module isolation on THIS side. `globalThis`, unlike
 * a module-scope binding, is one object for the whole Node process regardless
 * of how many times a route's module graph is separately evaluated, which is
 * the same fix Prisma's own Next.js guidance prescribes for the identical
 * symptom. Production (`next build && next start`) bundles every route into
 * one server process without this per-entry isolation, so the plain variable
 * would have been correct there — it is only wrong for the runtime every
 * `pnpm dev` and every Playwright run actually uses.
 */
const GLOBAL_SLOT = Symbol.for('homeledger.simulator.conversation');

interface ConversationSlot {
  pending?: Promise<Conversation>;
}

function conversationSlot(): ConversationSlot {
  const store = globalThis as typeof globalThis & { [GLOBAL_SLOT]?: ConversationSlot };
  store[GLOBAL_SLOT] ??= {};
  return store[GLOBAL_SLOT];
}

export async function getConversation(): Promise<Conversation> {
  const slot = conversationSlot();
  slot.pending ??= build().catch(error => {
    // A failed build must not be cached, or one expired SSO session poisons
    // the process until it is restarted.
    slot.pending = undefined;
    throw error;
  });
  return slot.pending;
}

async function build(): Promise<Conversation> {
  const say = (message: string): void => console.log(JSON.stringify({ msg: 'simulator', detail: message }));
  // Checked before anything else touches the network: a misconfigured
  // scripted flag must refuse before minting a Cognito token or connecting
  // to a real runtime, not after.
  assertScriptedModeAllowed();
  const env = readSimulatorEnv();
  const upstream = await resolveUpstream(process.env, say);
  const router = createElicitRouter();
  const mcp = new HomeLedgerMcp({
    url: upstream.url,
    token: upstream.token,
    // Both wired, both from the bridge's own implementations. A refused bearer
    // is repaired by invalidating and retrying; a runtime that was recreated
    // is repaired by looking it up by name again. Leaving either unconnected
    // leaves one of the two failure modes this project has already paid for
    // with no repair at all (FL-038, FL-039).
    invalidateToken: upstream.invalidateToken,
    resolveUrl: upstream.resolveUrl,
    onElicit: prompt => router.dispatch(prompt),
    log: say
  });
  await mcp.connect();
  const scripted = scriptedModelRequested();
  if (scripted) console.log(JSON.stringify({ msg: 'simulator', detail: `${SCRIPTED_MODEL_FLAG}=1: answering from a fixed script, NOT from the model` }));
  const model = scripted ? createScriptedModel() : createModelPort({ messages: createAnthropicClient(env.anthropicApiKey).messages, model: env.model });
  return {
    mcp,
    registry: new ElicitationRegistry(),
    router,
    model,
    tools: await mcp.listTools(),
    env,
    endpoint: { arn: upstream.arn, origin: upstream.origin },
    timeZone: await householdTimeZone(mcp, say),
    now: () => Date.now(),
    history: [],
    scripted
  };
}
