import type { AwsIdentityContext } from './aws-errors.js';
import { awsFailureMessage, isCredentialFailure } from './aws-errors.js';
import { readKnownProfiles } from './aws-profiles.js';
import { DEFAULT_RUNTIME_NAME } from './config.js';
import type { SetupValues } from './setup.js';

/**
 * Finds the three identifiers `claude mcp add` needs by asking AWS, not Terraform.
 *
 * This file exists because the version that shelled out to `terraform output
 * -raw` could not work on any machine but the author's. Every Terraform apply
 * in this project happens in GitHub Actions — that is the stated architecture,
 * and `.github/workflows/deploy.yml` passes the S3 backend's bucket and region
 * as `-backend-config` flags, so a contributor cannot even run a bare
 * `terraform init` to catch up. The documented first command therefore failed
 * on a clean checkout with "Backend initialization required", which is a
 * sentence about a tool the reader was never asked to install. FL-035.
 *
 * Reading AWS instead adds no prerequisite at all: the bridge already needs an
 * AWS session to pull the Cognito client secret out of Secrets Manager at
 * startup, so anyone who can run the bridge can already run the discovery.
 *
 * None of the four calls below can return a secret. That is a property of the
 * APIs chosen, not of the code: `ListUserPoolClients` answers with
 * `UserPoolClientDescription`, whose entire shape is `ClientId`, `UserPoolId`
 * and `ClientName`. `DescribeUserPoolClient` would have been the obvious call
 * for a client id and it returns `UserPoolClientType`, which carries
 * `ClientSecret` — so the convenient call is again the leaking one, exactly as
 * it was for `terraform output -json`, and it is named in
 * `FORBIDDEN_DISCOVERY_CALLS` so that reaching for it later is a visible
 * decision rather than a quiet one.
 */

/** A discovery problem the owner can fix, carrying a message written to be read rather than parsed. */
export class DiscoveryError extends Error {}

/**
 * The names Terraform gives these resources, resolved here rather than guessed.
 *
 * `infra/live/demo/platform/main.tf` sets `name_prefix = "${var.env}-homeledger"`
 * with `env` validated to the single value `"demo"`, so the prefix is
 * `demo-homeledger`. The runtime takes `local.runtime_name`, which is that
 * prefix with hyphens replaced by underscores plus `_mcp`; AgentCore runtime
 * names cannot contain hyphens, which is why the two spellings differ. The user
 * pool takes `"${local.name_prefix}-mcp"` and the app client takes the literal
 * `client_name` passed to the `cognito-m2m` module.
 */
export interface ResourceNames {
  runtime: string;
  userPool: string;
  appClient: string;
}

export const RESOURCE_NAMES: ResourceNames = {
  // Shared with the running bridge, which resolves its own address by this
  // name. One spelling, so a rename cannot fix setup and leave startup broken.
  runtime: DEFAULT_RUNTIME_NAME,
  userPool: 'demo-homeledger-mcp',
  appClient: 'homeledger-simulator'
};

/**
 * API calls this helper must never make, and why.
 *
 * Each of these returns the Cognito client secret in its ordinary success
 * response. The bridge reads that secret from Secrets Manager at startup and
 * never prints it; a discovery helper that fetched it here would put it one
 * `console.log` away from the owner's terminal and shell history for no benefit
 * — the value is not needed to build a `claude mcp add` command, because the
 * command deliberately does not carry it.
 */
export const FORBIDDEN_DISCOVERY_CALLS = [
  'cognito-idp:DescribeUserPoolClient',
  'cognito-idp:ListUserPoolClientSecrets',
  'cognito-idp:AddUserPoolClientSecret'
] as const;

/** The fields of `AgentRuntime` this helper reads. Named as the API names them so the adapter is a pass-through. */
export interface AgentRuntimeRow {
  agentRuntimeName?: string | undefined;
  agentRuntimeArn?: string | undefined;
}

/** The fields of `UserPoolDescriptionType` this helper reads. */
export interface UserPoolRow {
  Id?: string | undefined;
  Name?: string | undefined;
}

/** The whole of `UserPoolClientDescription` bar `UserPoolId` — this type cannot express a secret, which is the point. */
export interface UserPoolClientRow {
  ClientId?: string | undefined;
  ClientName?: string | undefined;
}

/** The two domain fields of `UserPoolType`. Nothing else from `DescribeUserPool` is read. */
export interface UserPoolDomains {
  Domain?: string | undefined;
  CustomDomain?: string | undefined;
}

/**
 * The one read the running bridge needs, split out of `DiscoveryApi` so the
 * bridge's startup path can depend on `ListAgentRuntimes` alone.
 *
 * `DiscoveryApi` satisfies this structurally, which is the point: `print-setup`
 * and the bridge resolve the runtime through the same interface and the same
 * selection rule, so "discovery found it" and "the bridge found it" cannot mean
 * two different things.
 */
export interface RuntimeLister {
  listAgentRuntimes(): Promise<AgentRuntimeRow[]>;
}

/**
 * The four reads, behind an interface, so every test in this file runs against
 * rows rather than against a mocked AWS client. `createAwsDiscoveryApi` is the
 * only implementation that touches the network.
 */
export interface DiscoveryApi extends RuntimeLister {
  listUserPools(): Promise<UserPoolRow[]>;
  listUserPoolClients(userPoolId: string): Promise<UserPoolClientRow[]>;
  describeUserPoolDomains(userPoolId: string): Promise<UserPoolDomains>;
}

/**
 * Upper bound on pages walked by `collectPages`.
 *
 * A paginated AWS list that keeps handing back a token is the one failure mode
 * that turns a setup helper into an infinite loop, and it is not hypothetical:
 * a token echoed back unchanged by a service bug, or a page function that
 * forgets to forward the token, both produce exactly that. 20 pages is far past
 * anything this account holds and still terminates.
 */
export const MAX_DISCOVERY_PAGES = 20;

export interface Page<T> {
  items: T[];
  nextToken: string | undefined;
}

/** Walks a paginated AWS list to the end, or fails loudly rather than spinning. */
export async function collectPages<T>(fetchPage: (token: string | undefined) => Promise<Page<T>>, label: string, maxPages = MAX_DISCOVERY_PAGES): Promise<T[]> {
  const all: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const { items, nextToken } = await fetchPage(token);
    all.push(...items);
    if (!nextToken) return all;
    token = nextToken;
  }
  throw new DiscoveryError(
    `${label} did not stop paginating after ${maxPages} pages. Fill the values into the \`claude mcp add\` command by hand, or narrow the account.`
  );
}

export interface SelectOptions<T> {
  rows: T[];
  /** The exact name to match. Exact and case-sensitive: these names come from Terraform, not from a human typing them. */
  wanted: string;
  nameOf: (row: T) => string | undefined;
  valueOf: (row: T) => string | undefined;
  /** Singular noun for the resource, e.g. `AgentCore runtime`. Pluralised with a bare `s` in the ambiguity message. */
  resource: string;
  /** What is being extracted, e.g. `ARN`. */
  valueLabel: string;
  /** Region and profile, rendered once by the caller so all four messages agree. */
  scope: string;
  /** Sentence appended when nothing matched. Says what the owner should check. */
  absentHint: string;
  /** Sentence appended when more than one distinct value matched. Says how to break the tie. */
  ambiguousHint: string;
}

/**
 * Picks the one row whose name matches, and refuses to pick when it cannot be sure.
 *
 * The rule that matters is the one this replaces. Taking `[0]` out of a list
 * works on an account holding exactly one of everything and silently returns
 * the wrong resource on the day a second appears — and "silently" is the whole
 * problem, because the wrong runtime ARN produces a bridge that starts fine and
 * talks to something else. So: match on the name Terraform assigned, and where
 * the answer is not unique, say so and stop.
 *
 * Ambiguity is measured on the extracted value rather than on the row count.
 * Two rows carrying the same name AND the same ARN are not an ambiguity — they
 * are one resource listed twice, which is a shape `ListAgentRuntimes` can
 * produce, since its row type carries `agentRuntimeVersion` and an AgentCore
 * runtime ARN does not include the version. Counting rows there would fail a
 * setup that has exactly one correct answer.
 */
export function selectUniqueValue<T>(options: SelectOptions<T>): string {
  const { rows, wanted, nameOf, valueOf, resource, valueLabel, scope, absentHint, ambiguousHint } = options;
  const matched = rows.filter(row => nameOf(row) === wanted);
  if (matched.length === 0) {
    const seen = rows.map(nameOf).filter((name): name is string => typeof name === 'string' && name.length > 0);
    seen.sort((a, b) => a.localeCompare(b));
    const sawClause = seen.length === 0 ? `No ${resource} of any name is there either.` : `Names present: ${seen.join(', ')}.`;
    throw new DiscoveryError(`No ${resource} named ${wanted} in ${scope}. ${absentHint} ${sawClause}`);
  }
  const values = [...new Set(matched.map(valueOf).filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
  if (values.length === 0) throw new DiscoveryError(`The ${resource} named ${wanted} in ${scope} has no ${valueLabel}. ${absentHint}`);
  if (values.length > 1) {
    values.sort((a, b) => a.localeCompare(b));
    throw new DiscoveryError(
      `Found ${values.length} ${resource}s named ${wanted} in ${scope} with different ${valueLabel}s, so this will not guess between them: ${values.join(', ')}. ${ambiguousHint}`
    );
  }
  return values[0] as string;
}

/**
 * Picks the AgentCore runtime ARN out of a `ListAgentRuntimes` page set.
 *
 * Lifted out of `discoverSetupValues` so the running bridge resolves its own
 * address through this exact function rather than through a second copy of the
 * same three rules. That matters more here than anywhere else in this file:
 * FL-039 is a bug about setup-time discovery and runtime discovery being
 * different mechanisms, and two `selectUniqueValue` call sites with slightly
 * different hints would be the same bug growing back.
 */
export function selectRuntimeArn(rows: AgentRuntimeRow[], wanted: string, scope: string): string {
  return selectUniqueValue({
    rows,
    wanted,
    nameOf: row => row.agentRuntimeName,
    valueOf: row => row.agentRuntimeArn,
    resource: 'AgentCore runtime',
    valueLabel: 'ARN',
    scope,
    absentHint:
      'The demo stack may not be deployed — `.github/workflows/deploy.yml` applies it on a push to main, and it creates the runtime only once an image has been pushed.',
    ambiguousHint: 'Put the one you want into the `claude mcp add` command as HOMELEDGER_RUNTIME_ARN, or delete the other.'
  });
}

/**
 * Builds the Cognito token endpoint from whatever domain the pool actually has.
 *
 * Mirrors `infra/modules/cognito-m2m/outputs.tf`'s `token_url`, which composes
 * the prefix form. The custom-domain branch is not what this stack deploys —
 * Terraform creates an `aws_cognito_user_pool_domain` with a prefix — but it is
 * one line and the alternative is composing a URL that resolves to nothing for
 * anyone who later attaches one. A Cognito domain *prefix* is restricted to
 * lowercase letters, digits and hyphens, so the presence of a dot is an exact
 * test for "this is already a fully qualified host", not a heuristic.
 */
export function tokenUrlFromDomains(domains: UserPoolDomains, region: string, poolName: string, scope: string): string {
  const domain = domains.Domain?.trim() || domains.CustomDomain?.trim();
  if (!domain)
    throw new DiscoveryError(
      `The Cognito user pool ${poolName} in ${scope} has no hosted domain, so it has no token endpoint. The platform Terraform root creates one (aws_cognito_user_pool_domain); the stack may be half applied.`
    );
  const host = domain.includes('.') ? domain : `${domain}.auth.${region}.amazoncognito.com`;
  return `https://${host}/oauth2/token`;
}

export interface DiscoverOptions {
  names?: ResourceNames;
  /**
   * Lists the profiles defined on this machine. Called at most once, and only
   * after a call has already failed on credentials — a working setup never
   * touches the filesystem here.
   */
  readProfiles?: () => Promise<ReadonlySet<string> | undefined>;
}

/** Renders the region-and-profile clause that every discovery message ends up quoting. */
export function describeScope(identity: AwsIdentityContext): string {
  return `${identity.region} (profile ${identity.profile})`;
}

/**
 * Runs the four reads in order and turns each failure into one sentence.
 *
 * Sequential rather than parallel, and deliberately: the runtime is what an
 * undeployed stack is missing, so it should be the first thing that fails, and
 * a fixed order means the message an owner sees for a given account state is
 * the same every time rather than a race between two equally true complaints.
 * Four round trips on a command a person runs once is not a latency budget
 * worth spending determinism on.
 */
export async function discoverSetupValues(api: DiscoveryApi, identity: AwsIdentityContext, options: DiscoverOptions = {}): Promise<SetupValues> {
  const names = options.names ?? RESOURCE_NAMES;
  const scope = describeScope(identity);
  const readProfiles = options.readProfiles ?? (() => readKnownProfiles(process.env));
  const call = createAwsCaller(identity, readProfiles);

  const runtimes = await call(() => api.listAgentRuntimes(), 'bedrock-agentcore:ListAgentRuntimes');
  const runtimeArn = selectRuntimeArn(runtimes, names.runtime, scope);

  const pools = await call(() => api.listUserPools(), 'cognito-idp:ListUserPools');
  const userPoolId = selectUniqueValue({
    rows: pools,
    wanted: names.userPool,
    nameOf: row => row.Name,
    valueOf: row => row.Id,
    resource: 'Cognito user pool',
    valueLabel: 'id',
    scope,
    absentHint:
      'The demo stack may not be deployed — the platform Terraform root creates this pool, and `.github/workflows/deploy.yml` applies it on a push to main.',
    ambiguousHint:
      'Cognito does not require pool names to be unique. Delete the one you do not want, or fill HOMELEDGER_COGNITO_TOKEN_URL and HOMELEDGER_COGNITO_CLIENT_ID into the command by hand.'
  });

  const clients = await call(() => api.listUserPoolClients(userPoolId), 'cognito-idp:ListUserPoolClients');
  const clientId = selectUniqueValue({
    rows: clients,
    wanted: names.appClient,
    nameOf: row => row.ClientName,
    valueOf: row => row.ClientId,
    resource: 'Cognito app client',
    valueLabel: 'id',
    scope: `user pool ${userPoolId} in ${scope}`,
    absentHint: 'The pool exists but its client-credentials app client does not, which means the platform Terraform root is only half applied.',
    ambiguousHint: 'Cognito does not require app client names to be unique. Fill the one you want into the command as HOMELEDGER_COGNITO_CLIENT_ID.'
  });

  const domains = await call(() => api.describeUserPoolDomains(userPoolId), 'cognito-idp:DescribeUserPool');
  const tokenUrl = tokenUrlFromDomains(domains, identity.region, names.userPool, scope);

  return { runtimeArn, tokenUrl, clientId };
}

/**
 * Wraps each AWS call so a credential, profile or permission failure arrives as an instruction.
 *
 * The profile list is read at most once per run, lazily, and only when the
 * failure is about credentials in the first place — a permissions error or a
 * throttle never touches the filesystem, and neither does a run that works.
 *
 * Exported because the running bridge now makes one of these calls too, and the
 * sentence an owner gets for an expired session must not depend on whether they
 * were running `--print-setup` or starting the bridge.
 *
 * `hint` is appended only to failures that are *not* about credentials. An
 * expired SSO session is the single most likely failure in this program and its
 * one-line remedy is quoted verbatim in the README; a caller's extra paragraph
 * about how it resolves runtimes would bury the one command that fixes it.
 */
export function createAwsCaller(identity: AwsIdentityContext, readProfiles: () => Promise<ReadonlySet<string> | undefined>, hint?: string) {
  let profiles: ReadonlySet<string> | undefined;
  let looked = false;
  return async function call<T>(run: () => Promise<T>, action: string): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof DiscoveryError) throw err;
      const credentials = isCredentialFailure(err);
      if (credentials && !looked) {
        looked = true;
        profiles = await readProfiles().catch(() => undefined);
      }
      const message = awsFailureMessage(err, { ...identity, action, knownProfiles: profiles });
      throw new DiscoveryError(hint && !credentials ? `${message}\n${hint}` : message);
    }
  };
}

/**
 * The only implementation that reaches AWS.
 *
 * Imported lazily, and kept to pass-throughs for the same reason
 * `createSecretsManagerReader` is: nothing in the test suite should construct an
 * AWS client, and every decision worth testing has been moved above this line.
 */
export async function createAwsDiscoveryApi(identity: AwsIdentityContext): Promise<DiscoveryApi> {
  const { BedrockAgentCoreControlClient, ListAgentRuntimesCommand } = await import('@aws-sdk/client-bedrock-agentcore-control');
  const { CognitoIdentityProviderClient, DescribeUserPoolCommand, ListUserPoolClientsCommand, ListUserPoolsCommand } =
    await import('@aws-sdk/client-cognito-identity-provider');
  const clientConfig = { region: identity.region, profile: identity.profile };
  const agentcore = new BedrockAgentCoreControlClient(clientConfig);
  const cognito = new CognitoIdentityProviderClient(clientConfig);

  return {
    listAgentRuntimes: () =>
      collectPages(async token => {
        const out = await agentcore.send(new ListAgentRuntimesCommand({ maxResults: 100, nextToken: token }));
        return { items: out.agentRuntimes ?? [], nextToken: out.nextToken };
      }, 'ListAgentRuntimes'),
    listUserPools: () =>
      collectPages(async token => {
        // MaxResults is required on this operation and capped at 60.
        const out = await cognito.send(new ListUserPoolsCommand({ MaxResults: 60, NextToken: token }));
        return { items: out.UserPools ?? [], nextToken: out.NextToken };
      }, 'ListUserPools'),
    listUserPoolClients: userPoolId =>
      collectPages(async token => {
        const out = await cognito.send(new ListUserPoolClientsCommand({ UserPoolId: userPoolId, MaxResults: 60, NextToken: token }));
        return { items: out.UserPoolClients ?? [], nextToken: out.NextToken };
      }, 'ListUserPoolClients'),
    describeUserPoolDomains: async userPoolId => {
      const out = await cognito.send(new DescribeUserPoolCommand({ UserPoolId: userPoolId }));
      // Only the two domain fields are lifted out. The rest of UserPoolType is
      // left behind rather than returned and ignored, so nothing downstream can
      // print a field this helper never meant to read.
      return { Domain: out.UserPool?.Domain, CustomDomain: out.UserPool?.CustomDomain };
    }
  };
}
