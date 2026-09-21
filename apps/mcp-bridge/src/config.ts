import { randomUUID } from 'node:crypto';

/** A configuration problem the owner can fix, carrying a message written to be read rather than parsed. */
export class ConfigError extends Error {}

export const DEFAULT_REGION = 'us-east-1';
export const DEFAULT_QUALIFIER = 'DEFAULT';
export const DEFAULT_SCOPE = 'homeledger/mcp';
/** Matches `local.name_prefix` + the literal path in infra/live/demo/platform/main.tf's `cognito` module block. */
export const DEFAULT_SECRET_ID = 'demo-homeledger/cognito/client-secret';
/**
 * The AgentCore runtime's `agent_runtime_name`, which is the only identifier
 * this project has that survives the runtime being destroyed and recreated.
 *
 * `infra/live/demo/platform/main.tf` sets `name_prefix = "${var.env}-homeledger"`
 * with `env` validated to the single value `"demo"`; `local.runtime_name` is
 * that prefix with hyphens replaced by underscores plus `_mcp`, because
 * AgentCore runtime names cannot contain hyphens. It lives here rather than in
 * `discover.ts` only because `discover.ts` may import this module and not the
 * other way round; `RESOURCE_NAMES.runtime` is this value.
 */
export const DEFAULT_RUNTIME_NAME = 'demo_homeledger_mcp';
/** The profile the deployed stack's owner signs into; see the README. Overridden by a real AWS_PROFILE in the environment. */
export const DEFAULT_AWS_PROFILE = 'homeledger-admin';

/**
 * AgentCore rejects a runtime session id shorter than this. Documented on the
 * InvokeAgentRuntime API reference for
 * `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`; enforced here so a pinned
 * value that is too short fails at startup with a sentence, rather than as an
 * opaque 400 on the first tool call.
 */
export const MIN_AGENTCORE_SESSION_ID_LENGTH = 33;

/**
 * Which runtime the bridge is being asked to reach, and who decided.
 *
 * Three cases rather than the two `mcpUrl` used to collapse them into, because
 * the bridge has to treat them differently and FL-039 is the bill for not
 * distinguishing them. `url` and `arn` are addresses the owner supplied; `name`
 * is an address the bridge works out for itself at startup, and is the default.
 * The rule the rest of the program is written to: **the bridge never silently
 * moves off an address the owner supplied, and always re-resolves one it chose.**
 */
export type RuntimeTarget =
  | { kind: 'url'; url: string }
  /** `name` rides along on a pinned ARN so a refusal can say what the ARN *would* have resolved to. */
  | { kind: 'arn'; arn: string; name: string }
  | { kind: 'name'; name: string };

export interface BridgeConfig {
  /** What the bridge was told to reach. Turned into a URL by `resolveRuntime`, which may make one AWS call to do it. */
  target: RuntimeTarget;
  /** AgentCore endpoint name in the invocation URL's `?qualifier=`. Not a version; see FRICTION-LOG.md FL-038. */
  qualifier: string;
  tokenUrl: string;
  clientId: string;
  scope: string;
  /** Secrets Manager id holding the Cognito client secret. Unused when `clientSecretFromEnv` is set. */
  secretId: string;
  /** Escape hatch for environments with no SSO session (CI, a container). Undefined on the owner's machine. */
  clientSecretFromEnv: string | undefined;
  region: string;
  /** Profile used to read the secret. Undefined means "whatever the default credential chain resolves". */
  awsProfile: string | undefined;
  /** Value for `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`, or undefined when the header is suppressed (the default). */
  agentCoreSessionId: string | undefined;
  /** True only when the bridge minted the id itself, which is the one case it may mint a replacement after a lost session. */
  agentCoreSessionGenerated: boolean;
  /** Whether to hold open the spec's standalone server-to-client SSE stream (`GET`). */
  standaloneStream: boolean;
}

function required(env: NodeJS.ProcessEnv, key: string, hint: string): string {
  const value = env[key]?.trim();
  if (value) return value;
  throw new ConfigError(
    `${key} is not set. ${hint}\nRun \`pnpm --filter @homeledger/mcp-bridge run print-setup\` to print the exact \`claude mcp add\` command with every value filled in.`
  );
}

/**
 * Builds the AgentCore DEFAULT-qualifier invocation URL from a runtime ARN.
 *
 * Mirrors `infra/modules/agentcore-runtime/outputs.tf`'s `invocation_url`,
 * whose Terraform `urlencode` and this `encodeURIComponent` agree on every
 * character an ARN can contain (letters, digits, and `:` `/` `-` `_` `.`): both
 * percent-encode `:` and `/` and leave the rest alone. They differ only on
 * space, which encodes as `+` in Terraform and `%20` here — and an ARN has no
 * spaces. Kept as a separate exported function so that agreement is asserted
 * against a real ARN in `test/config.test.ts` rather than assumed.
 */
export function invocationUrlFromArn(arn: string, region: string, qualifier: string): string {
  return `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(arn)}/invocations?qualifier=${encodeURIComponent(qualifier)}`;
}

/** Generates a runtime session id long enough for AgentCore to accept. Exported so the bridge can rotate one mid-session. */
export function newAgentCoreSessionId(): string {
  return `homeledger-bridge-${randomUUID()}`;
}

/**
 * Decides the AgentCore runtime session id, and defaults to sending no such header at all.
 *
 * **This default is a reversal, and the reversal is the point.** The bridge used
 * to mint a value per process and pin every request to it, on the reasoning
 * that the deployed server keeps 2025-era MCP sessions in one microVM's memory
 * (`apps/mcp-server/src/legacy.ts`) and a Claude Code session idles for minutes
 * between tool calls, so the requests either side of a pause had better reach
 * the same instance. FL-033 recorded that as "the one design decision in the
 * bridge that no offline test can check", and it was not checked.
 *
 * What the evidence says now that it has been looked at. AgentCore's own
 * stateful-features contract pins an MCP session to one instance by
 * `Mcp-Session-Id`, which is the header the bridge already forwards in both
 * directions (FL-009). `scripts/smoke.ts` sends no runtime session header
 * whatsoever and its legacy branch nevertheless carries `echo_confirm`'s
 * elicitation round trip — several POSTs and a held-open GET across one
 * session — to the same instance on every observed run, across a full teardown
 * and bring-up cycle. So the routing the pin was invented to guarantee is
 * already provided by the platform, keyed off a header the platform manages.
 *
 * What the pin adds, then, is not routing but a *second* session whose lifetime
 * nothing keeps in step with the MCP session's: a process-lifetime constant
 * that AgentCore ages out on its own idle timeout, after which requests still
 * carrying it land on an instance holding no MCP session and the container
 * answers 404 / -32001. That is the failure in FL-039, and it happened with the
 * pin on, in the configuration the smoke does not exercise. The pin is not
 * proven to have caused it — an idle gap may be sufficient on its own — but a
 * mechanism with no demonstrated benefit and one demonstrated failure beside it
 * does not deserve to be the default.
 *
 * So: `on` mints one per process, an explicit value pins that value, and
 * anything else — including unset — sends no header and leaves routing to
 * AgentCore, which is exactly what the smoke does.
 */
export function resolveAgentCoreSessionId(raw: string | undefined, generate: () => string = newAgentCoreSessionId): string | undefined {
  const value = raw?.trim();
  if (!value || value === 'off') return undefined;
  if (value === 'on') return generate();
  if (value.length < MIN_AGENTCORE_SESSION_ID_LENGTH)
    throw new ConfigError(
      `HOMELEDGER_AGENTCORE_SESSION_ID must be at least ${MIN_AGENTCORE_SESSION_ID_LENGTH} characters (AgentCore rejects shorter ids); got ${value.length}. Set it to 'on' to have one generated per process, or unset it to send no session header at all.`
    );
  return value;
}

/**
 * Decides which runtime the bridge will address, and never falls back into a URL.
 *
 * Precedence is most-specific-first: a whole URL beats an ARN beats a name. The
 * absence of all three is no longer an error, which is the change FL-039 asked
 * for — resolving `demo_homeledger_mcp` by name through `ListAgentRuntimes` is
 * what a config with nothing pinned in it now does, and it is the only form of
 * this configuration that survives the runtime being recreated.
 */
export function resolveRuntimeTarget(env: NodeJS.ProcessEnv): RuntimeTarget {
  const name = env.HOMELEDGER_RUNTIME_NAME?.trim() || DEFAULT_RUNTIME_NAME;
  const url = env.HOMELEDGER_MCP_URL?.trim();
  if (url) return { kind: 'url', url };
  const arn = env.HOMELEDGER_RUNTIME_ARN?.trim();
  if (arn) return { kind: 'arn', arn, name };
  return { kind: 'name', name };
}

export function loadConfig(env: NodeJS.ProcessEnv): BridgeConfig {
  const region = env.AWS_REGION?.trim() || DEFAULT_REGION;
  const qualifier = env.HOMELEDGER_RUNTIME_QUALIFIER?.trim() || DEFAULT_QUALIFIER;

  // An explicitly-set-but-empty secret is a misconfiguration, not a request to
  // fall back to Secrets Manager: it is what a shell writes when the variable
  // the owner meant to interpolate was itself unset, and silently reaching for
  // a different credential source there hides the mistake.
  const rawSecret = env.HOMELEDGER_COGNITO_CLIENT_SECRET;
  if (rawSecret !== undefined && rawSecret.trim() === '')
    throw new ConfigError(
      'HOMELEDGER_COGNITO_CLIENT_SECRET is set but empty. Unset it entirely to read the secret from Secrets Manager, or give it a real value.'
    );

  return {
    target: resolveRuntimeTarget(env),
    qualifier,
    tokenUrl: required(env, 'HOMELEDGER_COGNITO_TOKEN_URL', "It is the platform root's `cognito_token_url` Terraform output."),
    clientId: required(env, 'HOMELEDGER_COGNITO_CLIENT_ID', "It is the platform root's `cognito_client_id` Terraform output."),
    scope: env.HOMELEDGER_COGNITO_SCOPE?.trim() || DEFAULT_SCOPE,
    secretId: env.HOMELEDGER_COGNITO_SECRET_ID?.trim() || DEFAULT_SECRET_ID,
    clientSecretFromEnv: rawSecret?.trim() || undefined,
    region,
    // A profile already in the environment always wins: the owner may be
    // signed into one shell-wide, and silently substituting a different one
    // would produce an AccessDenied nobody could explain.
    awsProfile: env.AWS_PROFILE?.trim() || env.HOMELEDGER_AWS_PROFILE?.trim() || DEFAULT_AWS_PROFILE,
    agentCoreSessionId: resolveAgentCoreSessionId(env.HOMELEDGER_AGENTCORE_SESSION_ID),
    agentCoreSessionGenerated: env.HOMELEDGER_AGENTCORE_SESSION_ID?.trim() === 'on',
    standaloneStream: env.HOMELEDGER_BRIDGE_SSE?.trim() !== 'off'
  };
}
