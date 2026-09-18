import { randomUUID } from 'node:crypto';

/** A configuration problem the owner can fix, carrying a message written to be read rather than parsed. */
export class ConfigError extends Error {}

export const DEFAULT_REGION = 'us-east-1';
export const DEFAULT_QUALIFIER = 'DEFAULT';
export const DEFAULT_SCOPE = 'homeledger/mcp';
/** Matches `local.name_prefix` + the literal path in infra/live/demo/platform/main.tf's `cognito` module block. */
export const DEFAULT_SECRET_ID = 'demo-homeledger/cognito/client-secret';
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

export interface BridgeConfig {
  /** Full AgentCore invocation URL, either given directly or derived from the runtime ARN. */
  mcpUrl: string;
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
  /** Value for `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`, or undefined when the header is suppressed. */
  agentCoreSessionId: string | undefined;
  /** Whether to hold open the spec's standalone server-to-client SSE stream (`GET`). */
  standaloneStream: boolean;
}

function required(env: NodeJS.ProcessEnv, key: string, hint: string): string {
  const value = env[key]?.trim();
  if (value) return value;
  throw new ConfigError(
    `${key} is not set. ${hint}\nRun \`pnpm --filter @homeledger/mcp-bridge setup\` to print the exact \`claude mcp add\` command with every value filled in.`
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

/**
 * Decides the AgentCore runtime session id.
 *
 * Default is a fresh value per bridge process, which pins every request from
 * one Claude Code session to one runtime instance. That matters here and does
 * not for the smoke: the deployed server holds 2025-era MCP sessions in an
 * in-memory map inside a single microVM (`apps/mcp-server/src/legacy.ts`), and
 * a Claude Code session is idle for minutes at a time between tool calls, so a
 * request routed to a second instance would come back `-32001 Session not
 * found`. FL-022 already observed AgentCore failing to route one request of a
 * live session back to the instance holding it. This is the documented remedy
 * and it is unverified against the live endpoint — `off` turns it back into
 * exactly what the smoke does today.
 */
export function resolveAgentCoreSessionId(raw: string | undefined, generate: () => string = () => `homeledger-bridge-${randomUUID()}`): string | undefined {
  const value = raw?.trim();
  if (value === 'off') return undefined;
  if (!value) return generate();
  if (value.length < MIN_AGENTCORE_SESSION_ID_LENGTH)
    throw new ConfigError(
      `HOMELEDGER_AGENTCORE_SESSION_ID must be at least ${MIN_AGENTCORE_SESSION_ID_LENGTH} characters (AgentCore rejects shorter ids); got ${value.length}. Unset it to have one generated, or set it to 'off' to send no session header at all.`
    );
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): BridgeConfig {
  const region = env.AWS_REGION?.trim() || DEFAULT_REGION;
  const qualifier = env.HOMELEDGER_RUNTIME_QUALIFIER?.trim() || DEFAULT_QUALIFIER;

  const directUrl = env.HOMELEDGER_MCP_URL?.trim();
  const runtimeArn = env.HOMELEDGER_RUNTIME_ARN?.trim();
  if (!directUrl && !runtimeArn)
    throw new ConfigError(
      'Neither HOMELEDGER_MCP_URL nor HOMELEDGER_RUNTIME_ARN is set, so the bridge does not know which runtime to reach.\nRun `pnpm --filter @homeledger/mcp-bridge setup` to print the exact `claude mcp add` command with every value filled in.'
    );
  const mcpUrl = directUrl ?? invocationUrlFromArn(runtimeArn!, region, qualifier);

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
    mcpUrl,
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
    standaloneStream: env.HOMELEDGER_BRIDGE_SSE?.trim() !== 'off'
  };
}
