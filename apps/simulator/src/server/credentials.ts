import type { AwsIdentityContext } from '@homeledger/mcp-bridge/aws-errors';
import { DEFAULT_AWS_PROFILE, loadConfig } from '@homeledger/mcp-bridge/config';
import { redact } from '@homeledger/mcp-bridge/redact';
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
  const config = loadConfig(source);
  /**
   * The caller's log, with the bridge's redaction net in front of it.
   *
   * This is the one place this module deliberately adds to the task brief, and
   * it is here to remove a divergence rather than to create one. In the bridge
   * the same `log` slot is filled with `logDiagnostic`, which pipes every line
   * through `redact()` before it reaches stderr — and `redact.ts` says in as
   * many words why: "no call site interpolates the secret" is a property a
   * future edit can quietly break, while a net at the single writer keeps
   * holding. `resolveRuntime` hands this callback `err.message` verbatim out of
   * `awsFailureMessage`, so the simulator passing the raw callback straight
   * through would have been the same code with the net taken off.
   *
   * What it can and cannot cover is worth being exact about. `protectSecret` is
   * called by `resolveClientSecret` and by `createTokenSource`, both of which
   * run below this line, so lines emitted during the first runtime lookup are
   * unredacted — and they are also the only lines in the process that cannot
   * carry a credential, because none has been read yet. Everything after that,
   * including every `resolveUrl()` re-lookup and whatever the agent route logs
   * for the life of the process, is covered.
   */
  const safeLog = (message: string): void => log(redact(message));
  const identity: AwsIdentityContext = {
    region: config.region,
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
    token: () => tokens.get(),
    invalidateToken: () => tokens.invalidate(),
    resolveUrl: async () => (await lookUp()).url
  };
}
