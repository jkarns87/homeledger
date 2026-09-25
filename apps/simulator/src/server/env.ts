/**
 * Every value the simulator needs from its own environment, read lazily.
 *
 * Lazily is load-bearing twice over. `next build` runs in CI with no
 * credentials at all, so a module-scope read would fail the required `test`
 * job on a machine that has no business holding an API key. And the process
 * that serves a turn is long-lived, so reading per request means a key
 * rotation takes effect on the next turn rather than on the next deploy.
 */
export class SimulatorConfigError extends Error {}

/**
 * Sonnet, not Opus, by default. This agent's work is tool-calling and short
 * spoken replies to a person waiting in front of a display — turn latency
 * matters more here than maximum reasoning depth, which is exactly the
 * tradeoff Sonnet is for. `HOMELEDGER_SIMULATOR_MODEL` overrides it per
 * `readSimulatorEnv` below, so a deployed run can move to Opus without a code
 * change if the tool-calling accuracy ever needs it.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5';
/** Model turns per user turn before the loop gives up. Eight covers list -> get -> book (three elicitations) with room to spare. */
export const DEFAULT_MAX_ROUNDS = 8;
/** How long one elicitation may wait for a person to click. Two minutes: a demo pause, not an outage. */
export const DEFAULT_ELICITATION_TIMEOUT_MS = 120_000;

export interface SimulatorEnv {
  anthropicApiKey: string;
  model: string;
  maxRounds: number;
  elicitationTimeoutMs: number;
  /**
   * When set, every route accepts only this Origin. Undefined is NOT "off": it
   * is the strict default in `checkOrigin` (`http.ts`) — the `Host` header must
   * name a loopback address, and an `Origin`, when one is sent, must match it.
   */
  allowOrigin: string | undefined;
}

function positiveInt(source: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = source[key]?.trim();
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0)
    throw new SimulatorConfigError(`${key} must be a positive whole number of ${key.endsWith('_MS') ? 'milliseconds' : 'rounds'}; got ${JSON.stringify(raw)}.`);
  return Number(raw);
}

export function readSimulatorEnv(source: NodeJS.ProcessEnv = process.env): SimulatorEnv {
  const anthropicApiKey = source.ANTHROPIC_API_KEY?.trim();
  if (!anthropicApiKey)
    throw new SimulatorConfigError(
      'ANTHROPIC_API_KEY is not set. The simulator drives the deployed MCP server with an agent on the Anthropic API, not on Bedrock, because Bedrock model invocation is blocked account-wide on this AWS account (FRICTION-LOG.md FL-019). Put the key in apps/simulator/.env.local, which is git-ignored, or export it in the shell you start `pnpm --filter @homeledger/simulator run dev` from.'
    );
  return {
    anthropicApiKey,
    model: source.HOMELEDGER_SIMULATOR_MODEL?.trim() || DEFAULT_MODEL,
    maxRounds: positiveInt(source, 'HOMELEDGER_SIMULATOR_MAX_ROUNDS', DEFAULT_MAX_ROUNDS),
    elicitationTimeoutMs: positiveInt(source, 'HOMELEDGER_SIMULATOR_ELICITATION_TIMEOUT_MS', DEFAULT_ELICITATION_TIMEOUT_MS),
    allowOrigin: source.HOMELEDGER_SIMULATOR_ALLOW_ORIGIN?.trim() || undefined
  };
}
