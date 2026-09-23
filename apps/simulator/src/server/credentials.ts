import type { AwsIdentityContext } from '@homeledger/mcp-bridge/aws-errors';
import { DEFAULT_AWS_PROFILE, loadConfig } from '@homeledger/mcp-bridge/config';
import { protectSecret, redact } from '@homeledger/mcp-bridge/redact';
import { createAwsRuntimeLister, resolveRuntime } from '@homeledger/mcp-bridge/runtime';
import { createSecretsManagerReader, resolveClientSecret } from '@homeledger/mcp-bridge/secret';
import { createTokenSource } from '@homeledger/mcp-bridge/token';

export interface UpstreamCredentials {
  /** The AgentCore invocation URL, complete with its `?qualifier=`. */
  url: string;
  arn: string | undefined;
  origin: 'url' | 'arn' | 'name';
  /** Yields the current bearer. Called per HTTP request so a mid-conversation refresh needs no plumbing upstream. */
  token: () => Promise<string>;
  /** Drops the cached bearer. Called by the MCP client on a 401 or 403, which is the bridge's rule (`proxy.ts:160-185`). */
  invalidateToken: () => void;
  /**
   * Re-resolves the runtime by name and yields its current invocation URL.
   *
   * Every consumer of this interface is long-lived, and the address it was
   * handed at startup is correct only until the runtime is next recreated:
   * AgentCore generates the id at create time and has no alias layer, so a
   * URL goes stale with nothing to say it did (FL-038, FL-039). The bridge
   * answers a 404 that carries no session with `healAddress()` — a fresh
   * lookup by name — rather than with a retry against the same place, and
   * this is what lets the simulator do the same. It re-runs only the lookup;
   * the config, the identity and the token source are already resolved.
   */
  resolveUrl: () => Promise<string>;
}

/**
 * How deep a `cause` chain is followed when scrubbing a thrown error.
 *
 * Nothing in the bridge sets `cause` today, so in practice this walks one
 * error. It is bounded rather than unbounded because a chain can be cyclic and
 * this runs on a failure path, where the last thing wanted is a hang.
 */
const MAX_CAUSE_DEPTH = 4;

/**
 * Scrubs every registered secret out of an error before it leaves this module.
 *
 * The bridge does this at `index.ts:115-120`, where its top-level catch routes
 * the thrown error through `logDiagnostic`. `safeLog` below copies the *log*
 * half of that wiring; this is the *throw* half, and it was the half missing
 * from the first version of this file. Three paths needed it: `resolveUpstream`
 * itself, `resolveUrl()` (whose rejection runs `awsFailureMessage`, which
 * interpolates `err.message` verbatim), and `token()` (whose rejection echoes
 * up to 300 characters of the Cognito error body — `token.ts`'s
 * `MAX_ERROR_BODY`).
 *
 * The error is repaired in place rather than replaced with a fresh `Error`,
 * because `ConfigError`, `SecretError`, `TokenError` and `DiscoveryError` are
 * all meaningful to callers and wrapping would break every `instanceof`.
 * Replacement is the fallback for a frozen error, and keeps the original on
 * `cause`.
 *
 * `stack` is scrubbed as well as `message`, and which of those two is doing the
 * work depends on when the stack was first read. V8 formats `stack` lazily and
 * memoises it, so for an error nobody has touched, assigning `message` first is
 * already sufficient — the later read formats from the clean message. The
 * assignment matters only for an error whose stack was *already* materialised
 * while the message was raw, which is any error that passed through a logger or
 * an inspector on its way here. No path inside this module does that today,
 * which is exactly why the case is covered by a direct unit test on this
 * function rather than through `resolveUpstream`: routed through the module it
 * would pass with the line deleted, and prove nothing.
 *
 * Exported for that test. It has a contract worth pinning independently of the
 * three call sites that use it.
 */
export function scrubError(err: unknown): unknown {
  if (!(err instanceof Error)) return new Error(redact(String(err)));
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    try {
      current.message = redact(current.message);
      if (typeof current.stack === 'string') current.stack = redact(current.stack);
    } catch {
      // A frozen or sealed error cannot be repaired, so it is replaced. Only
      // the outermost one can be handed back this way; a frozen `cause` deeper
      // in the chain is left alone rather than detached from its parent.
      if (depth === 0) return new Error(redact(err.message), { cause: err });
      break;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return err;
}

/** Runs `run`, and lets nothing out of it carrying a credential. */
async function scrubbed<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw scrubError(err);
  }
}

/**
 * Resolves which runtime to talk to and how to authenticate to it, reusing the
 * bridge's implementations rather than copying them.
 *
 * Reuse is not tidiness here. `resolveRuntime` is FL-039's fix: it looks the
 * runtime up by name at every start, because AgentCore generates a runtime's id
 * at create time and offers no alias layer (FL-038), so a pinned ARN is correct
 * only until the runtime is next recreated and nothing tells you when that
 * happened. A second implementation in this package would be a second thing to
 * get wrong, and it would get wrong exactly the part that has already cost this
 * project two confidently wrong answers.
 */
export async function resolveUpstream(source: NodeJS.ProcessEnv = process.env, log: (m: string) => void = () => {}): Promise<UpstreamCredentials> {
  return scrubbed(async () => {
    const config = loadConfig(source);
    // Registered here, not where the secret is consumed, and the distance
    // between those two points was a live leak. `loadConfig` reads
    // HOMELEDGER_COGNITO_CLIENT_SECRET out of the environment into
    // `config.clientSecretFromEnv` on the line above; `resolveClientSecret`,
    // which is the first thing in the bridge to call `protectSecret`, does not
    // run until after the first runtime lookup below. In between, the
    // credential is in memory and unknown to `redact`, so a diagnostic from
    // that lookup printed it in full. The env-var path is the *normal* one in
    // CI and in containers, where there is no SSO session, so this window was
    // open exactly where it was least visible. `protectSecret` ignores
    // undefined, so the Secrets Manager path pays nothing for this.
    protectSecret(config.clientSecretFromEnv);

    /**
     * The caller's log, with the bridge's redaction net in front of it.
     *
     * In the bridge the same `log` slot is filled with `logDiagnostic`, which
     * pipes every line through `redact()` before it reaches stderr — and
     * `redact.ts` says in as many words why: "no call site interpolates the
     * secret" is a property a future edit can quietly break, while a net at
     * the single writer keeps holding. `resolveRuntime` hands this callback
     * `err.message` verbatim out of `awsFailureMessage`, so passing the raw
     * callback straight through would have been the same code with the net
     * taken off.
     *
     * What `redact` covers is worth naming rather than implying. `protectSecret`
     * is called for the Cognito client secret (here and in `secret.ts`), the
     * Basic credential and every bearer (`token.ts`). It is never called for
     * ANTHROPIC_API_KEY, AWS_SECRET_ACCESS_KEY or AWS_SESSION_TOKEN — three of
     * the four names the client-side guard defends — so the net cannot scrub
     * those from anything. That is deliberate: this module never reads them,
     * the AWS SDK holds its own, and `readSimulatorEnv` keeps the Anthropic key
     * on the server. The guard, not the net, is what defends those three.
     */
    const safeLog = (message: string): void => log(redact(message));
    const identity: AwsIdentityContext = {
      region: config.region,
      // `config.awsProfile` is in fact never undefined — `config.ts` ends that
      // chain with `|| DEFAULT_AWS_PROFILE`. The `??` is here to satisfy
      // `BridgeConfig`, which types the field `string | undefined`, and not
      // because the right-hand side is reachable. Left explicit rather than
      // cast so the day the bridge widens that field this still compiles.
      profile: config.awsProfile ?? DEFAULT_AWS_PROFILE,
      profileFromEnvironment: Boolean(source.AWS_PROFILE?.trim() || source.HOMELEDGER_AWS_PROFILE?.trim())
    };
    const lookUp = () =>
      resolveRuntime({
        target: config.target,
        qualifier: config.qualifier,
        identity,
        lister: () => createAwsRuntimeLister(identity),
        log: safeLog
      });
    const runtime = await lookUp();
    const clientSecret = await resolveClientSecret(config, () => createSecretsManagerReader(config));
    const tokens = createTokenSource({ tokenUrl: config.tokenUrl, clientId: config.clientId, clientSecret, scope: config.scope });
    return {
      url: runtime.url,
      arn: runtime.arn,
      origin: runtime.origin,
      // Both of these reject, and both rejections used to carry a credential in
      // full: `resolveUrl` through `awsFailureMessage`, `token` through the 300
      // characters of Cognito error body `token.ts` deliberately echoes.
      token: () => scrubbed(() => tokens.get()),
      invalidateToken: () => tokens.invalidate(),
      resolveUrl: () => scrubbed(async () => (await lookUp()).url)
    };
  });
}
