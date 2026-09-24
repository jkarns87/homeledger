import type Anthropic from '@anthropic-ai/sdk';
import { SEED_TIMEZONE } from '@homeledger/core';
import { createElicitRouter, type ElicitRouter } from './agent.js';
import { resolveUpstream } from './credentials.js';
import { ElicitationRegistry } from './elicitation.js';
import { readSimulatorEnv, type SimulatorEnv } from './env.js';
import { HomeLedgerMcp } from './mcp.js';
import { createAnthropicClient, createModelPort, type ModelPort } from './model.js';
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
let pending: Promise<Conversation> | undefined;

export async function getConversation(): Promise<Conversation> {
  pending ??= build().catch(error => {
    // A failed build must not be cached, or one expired SSO session poisons
    // the process until it is restarted.
    pending = undefined;
    throw error;
  });
  return pending;
}

async function build(): Promise<Conversation> {
  const say = (message: string): void => console.log(JSON.stringify({ msg: 'simulator', detail: message }));
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
  return {
    mcp,
    registry: new ElicitationRegistry(),
    router,
    model: createModelPort({ messages: createAnthropicClient(env.anthropicApiKey).messages, model: env.model }),
    tools: await mcp.listTools(),
    env,
    endpoint: { arn: upstream.arn, origin: upstream.origin },
    timeZone: await householdTimeZone(mcp, say),
    now: () => Date.now(),
    history: []
  };
}
