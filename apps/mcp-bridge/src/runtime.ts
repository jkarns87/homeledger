import type { AwsIdentityContext } from './aws-errors.js';
import { awsFailureMessage } from './aws-errors.js';
import { readKnownProfiles } from './aws-profiles.js';
import type { RuntimeTarget } from './config.js';
import { ConfigError, invocationUrlFromArn } from './config.js';
import type { AgentRuntimeRow, RuntimeLister } from './discover.js';
import { collectPages, createAwsCaller, describeScope, selectRuntimeArn } from './discover.js';
import { PRINT_SETUP_COMMAND } from './errors.js';

/**
 * Turns "which runtime" into a URL, at every bridge start rather than once at setup time.
 *
 * This module is the fix for FL-039. Before it, `--print-setup` discovered the
 * runtime by name through `ListAgentRuntimes` and baked the resulting ARN into
 * the `claude mcp add` command, and the bridge did nothing but percent-encode
 * whatever ARN it was handed. That looks like discovery and is not: it is one
 * lookup, performed once, whose answer is then pinned for the life of a config
 * file. AgentCore generates a runtime's id at create time and offers no alias
 * layer (FL-038), so the day the runtime is destroyed and recreated, every
 * pinned ARN addresses something that no longer exists — and the bridge, which
 * had the means to look it up again, never did.
 *
 * Resolving by name here costs nothing new. The bridge already needs an AWS
 * session to read the Cognito client secret out of Secrets Manager before it
 * relays a single byte, so anyone who can start the bridge can already make the
 * one read-only `ListAgentRuntimes` call this needs.
 */

/** Appended to a by-name resolution failure that is not about credentials, so the owner learns there are two ways to pin past it. */
export function resolveByNameNote(name: string): string {
  return `The bridge resolves the runtime by name (${name}) every time it starts, which is what makes a config survive the runtime being recreated. Set HOMELEDGER_RUNTIME_ARN to pin one ARN, or HOMELEDGER_MCP_URL to pin a whole invocation URL, if you need to address a specific runtime instead.`;
}

export interface ResolvedRuntime {
  /** The AgentCore invocation URL the bridge will POST to. */
  url: string;
  /** The ARN behind that URL. Undefined only when HOMELEDGER_MCP_URL supplied a URL nothing parsed an ARN out of. */
  arn: string | undefined;
  /** How the address was arrived at. Quoted in the ready line so `/mcp` shows whether this config can survive a rotation. */
  origin: RuntimeTarget['kind'];
  /**
   * Looks the runtime up by name again and returns a fresh URL, or undefined
   * when the bridge must not move off this address.
   *
   * Present only for the `name` origin. A URL or an ARN the owner supplied is
   * an instruction about *which* runtime to talk to, and quietly talking to a
   * different one because the named one is easier to find would be the same
   * mistake `selectUniqueValue` refuses to make when it declines to take
   * `rows[0]`.
   */
  reresolve: (() => Promise<string>) | undefined;
}

export interface ResolveRuntimeOptions {
  target: RuntimeTarget;
  qualifier: string;
  identity: AwsIdentityContext;
  /**
   * Builds the `ListAgentRuntimes` caller. A function rather than a value so
   * the `HOMELEDGER_MCP_URL` path constructs no AWS client and imports no AWS
   * SDK at all, and so every test in this project passes rows instead.
   */
  lister: () => Promise<RuntimeLister>;
  log: (message: string) => void;
  readProfiles?: () => Promise<ReadonlySet<string> | undefined>;
}

/**
 * The region field of an ARN, or undefined when the string is not an ARN.
 *
 * Used for one decision only: whether `ListAgentRuntimes` in the region the
 * bridge is pointed at is even capable of answering "does this ARN exist". It
 * is not, for an ARN in another region, and refusing to start on the strength
 * of a list that could never have contained the answer would be worse than not
 * checking.
 */
export function regionOfArn(arn: string): string | undefined {
  const parts = arn.split(':');
  if (parts.length < 6 || parts[0] !== 'arn') return undefined;
  return parts[3]?.trim() || undefined;
}

/**
 * What the owner reads when the ARN in their `claude mcp add` command names a runtime that is gone.
 *
 * Written to be read at `/mcp` by a person who has no reason to suspect
 * AgentCore of anything, so it says what happened, names the runtime that is
 * there now, and gives the two ways out — with the durable one second, because
 * it is the one they should end on.
 */
export function stalePinnedArnMessage(arn: string, rows: readonly AgentRuntimeRow[], identity: AwsIdentityContext, name: string): string {
  const live = [
    ...new Set(
      rows
        .filter(row => row.agentRuntimeName === name)
        .map(row => row.agentRuntimeArn)
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    )
  ].sort((a, b) => a.localeCompare(b));
  let nowClause: string;
  if (live.length === 1) nowClause = ` The runtime named ${name} is now ${live[0]}.`;
  else if (live.length === 0) nowClause = ` There is no runtime named ${name} there either, so the stack may be torn down rather than recreated.`;
  else nowClause = ` There are ${live.length} runtimes named ${name} there and this will not pick between them: ${live.join(', ')}.`;
  return (
    `HOMELEDGER_RUNTIME_ARN pins an AgentCore runtime that does not exist in ${describeScope(identity)}: ${arn}.` +
    ` AgentCore generates a runtime's id when the runtime is created and offers no alias layer, so a runtime that was destroyed and recreated comes back under a different ARN and every address issued before that silently stops resolving (FRICTION-LOG.md FL-038).${nowClause}` +
    ` Re-run \`${PRINT_SETUP_COMMAND}\` and the \`claude mcp add\` command it prints, or remove \`-e HOMELEDGER_RUNTIME_ARN\` from your existing entry so the bridge resolves the runtime by name every time it starts.`
  );
}

/**
 * Checks a supplied ARN against the runtimes that exist, and refuses rather than repairs.
 *
 * **Validated, not trusted, and the API call is worth it.** A stale pinned ARN
 * is the exact failure FL-039 records, so trusting one reproduces that bug for
 * every owner who pinned deliberately — and the cost of not trusting it is one
 * `ListAgentRuntimes` per bridge *start*, which happens once per Claude Code
 * session, alongside a `GetSecretValue` and a Cognito token mint that were
 * already there. What it buys is where the failure lands: a refusal at startup
 * is one line in `/mcp` before any conversation begins, while the alternative
 * is a 404 in the middle of a tool call, which an LLM client will explain to
 * its user as "there are no appliances registered". A wrong answer delivered
 * confidently is a worse outcome than a bridge that would not start.
 *
 * Two things it deliberately does not do. It does not substitute the runtime it
 * found for the one that was asked for — the owner named an ARN, and picking a
 * different one for them is guessing. And it does not fail the start when the
 * *check itself* fails: a throttle, a missing `bedrock-agentcore:ListAgentRuntimes`
 * permission or an ARN in another region leave the pin in force with one
 * diagnostic line, because in none of those cases has anything been learned
 * about whether the runtime exists.
 */
export async function validatePinnedArn(arn: string, name: string, options: ResolveRuntimeOptions): Promise<void> {
  const { identity, log } = options;
  const arnRegion = regionOfArn(arn);
  if (arnRegion && arnRegion !== identity.region) {
    log(
      `HOMELEDGER_RUNTIME_ARN names a runtime in ${arnRegion} but AWS_REGION is ${identity.region}, so it was used as given and not checked. Note the invocation URL's host is built from AWS_REGION, so those two disagreeing is itself worth a look.`
    );
    return;
  }

  let rows: AgentRuntimeRow[];
  try {
    rows = await (await options.lister()).listAgentRuntimes();
  } catch (err) {
    log(
      `could not check HOMELEDGER_RUNTIME_ARN against ListAgentRuntimes, so it was used as given: ${awsFailureMessage(err, { ...identity, action: 'bedrock-agentcore:ListAgentRuntimes' })}`
    );
    return;
  }

  if (rows.some(row => row.agentRuntimeArn === arn)) return;
  throw new ConfigError(stalePinnedArnMessage(arn, rows, identity, name));
}

/** One `ListAgentRuntimes`, matched on the exact name by the same rule `--print-setup` uses. */
async function runtimeArnByName(name: string, options: ResolveRuntimeOptions): Promise<string> {
  const call = createAwsCaller(options.identity, options.readProfiles ?? (() => readKnownProfiles(process.env)), resolveByNameNote(name));
  const rows = await call(async () => (await options.lister()).listAgentRuntimes(), 'bedrock-agentcore:ListAgentRuntimes');
  return selectRuntimeArn(rows, name, describeScope(options.identity));
}

/** Resolves the configured target into an address the bridge can POST to. Makes at most one AWS call. */
export async function resolveRuntime(options: ResolveRuntimeOptions): Promise<ResolvedRuntime> {
  const { target, qualifier, identity } = options;
  const urlFor = (arn: string): string => invocationUrlFromArn(arn, identity.region, qualifier);

  if (target.kind === 'url') return { url: target.url, arn: undefined, origin: 'url', reresolve: undefined };

  if (target.kind === 'arn') {
    await validatePinnedArn(target.arn, target.name, options);
    return { url: urlFor(target.arn), arn: target.arn, origin: 'arn', reresolve: undefined };
  }

  const arn = await runtimeArnByName(target.name, options);
  return {
    url: urlFor(arn),
    arn,
    origin: 'name',
    reresolve: async () => urlFor(await runtimeArnByName(target.name, options))
  };
}

/**
 * The only implementation that reaches AWS.
 *
 * Imported lazily and kept to a pass-through for the same reason
 * `createAwsDiscoveryApi` is, with one difference that matters on this path: it
 * constructs the AgentCore control client and nothing else, so a running bridge
 * never loads the Cognito SDK it has no call for.
 */
export async function createAwsRuntimeLister(identity: AwsIdentityContext): Promise<RuntimeLister> {
  const { BedrockAgentCoreControlClient, ListAgentRuntimesCommand } = await import('@aws-sdk/client-bedrock-agentcore-control');
  const agentcore = new BedrockAgentCoreControlClient({ region: identity.region, profile: identity.profile });
  return {
    listAgentRuntimes: () =>
      collectPages(async token => {
        const out = await agentcore.send(new ListAgentRuntimesCommand({ maxResults: 100, nextToken: token }));
        return { items: out.agentRuntimes ?? [], nextToken: out.nextToken };
      }, 'ListAgentRuntimes')
  };
}
