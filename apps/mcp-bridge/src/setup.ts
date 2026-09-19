import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AwsIdentityContext } from './aws-errors.js';
import { DEFAULT_AWS_PROFILE, DEFAULT_REGION } from './config.js';

const execFileAsync = promisify(execFile);

/** The three values the `claude mcp add` command carries. Structurally identical whichever source produced them. */
export interface SetupValues {
  runtimeArn: string;
  tokenUrl: string;
  clientId: string;
}

/**
 * Where `--print-setup` gets its three values.
 *
 * `aws` is the default and the only path a new contributor is asked to take;
 * see `discover.ts` for why. `terraform` is kept because it is the source of
 * record when the two disagree — if a rename lands in `infra/` and the names in
 * `discover.ts` have not caught up, the Terraform outputs are still right — but
 * it is behind an explicit `--from-terraform` and it is not what an unflagged
 * run can fall back into. A fallback would be worse than no Terraform path at
 * all: the failure a new user hit was `terraform init`, and an automatic
 * fallback would put that exact message back in front of them as the *second*
 * half of a two-part error, which is harder to read than the first was.
 */
export type SetupSource = 'aws' | 'terraform';

/** `aws` unless the owner asked for the other one by name. Never inferred from the environment's shape, and never fallen back into. */
export function resolveSetupSource(argv: readonly string[], env: NodeJS.ProcessEnv): SetupSource {
  if (argv.includes('--from-terraform')) return 'terraform';
  return env.HOMELEDGER_SETUP_SOURCE?.trim() === 'terraform' ? 'terraform' : 'aws';
}

/**
 * The Terraform outputs the `--from-terraform` path reads, and the only ones it may read.
 *
 * Every name here is a non-sensitive identifier: a URL, a client id, an ARN.
 * They are safe to print to a terminal, safe to paste into a `claude mcp add`
 * command, and safe to sit in `~/.claude.json` afterwards.
 */
export const READABLE_TERRAFORM_OUTPUTS = ['agent_runtime_arn', 'cognito_token_url', 'cognito_client_id'] as const;

/**
 * Outputs this helper must never read, because reading them prints a secret to
 * a terminal and into the operator's shell history.
 *
 * `cognito_client_secret` is marked `sensitive` in
 * infra/live/demo/platform/outputs.tf, which stops `terraform output` printing
 * it by accident — but NOT `terraform output -raw cognito_client_secret`, and
 * not `terraform output -json`, which includes sensitive values in full. That
 * is precisely why this helper reads named outputs one at a time with `-raw`
 * and never reaches for `-json`: the convenient call is the leaking one.
 */
export const FORBIDDEN_TERRAFORM_OUTPUTS = ['cognito_client_secret'] as const;

export const PLATFORM_ROOT = 'infra/live/demo/platform';

/**
 * What a bare `terraform init` needs and does not have, quoted in the failure message.
 *
 * `infra/live/demo/platform/backend.tf` declares `backend "s3" {}` with an
 * empty body and `.github/workflows/deploy.yml` supplies the bucket and region
 * as `-backend-config` flags at init time. So the Terraform path is not merely
 * uninitialised on a fresh checkout — it is not self-initialising, and a
 * contributor who runs `terraform init` on the advice of the raw error gets a
 * second error rather than a working directory.
 */
export const TERRAFORM_BACKEND_NOTE =
  'The Terraform path needs an initialised S3 backend, and this root does not configure its own: CI passes -backend-config=bucket=… and -backend-config=region=… to `terraform init`. Drop --from-terraform to read the same values from AWS instead.';

export interface OutputReader {
  (name: string): Promise<string>;
}

export function createTerraformReader(cwd: string): OutputReader {
  return async name => {
    const { stdout } = await execFileAsync('terraform', ['output', '-raw', name], { cwd });
    return stdout.trim();
  };
}

export async function readSetupValues(read: OutputReader): Promise<SetupValues> {
  const [runtimeArn, tokenUrl, clientId] = await Promise.all(READABLE_TERRAFORM_OUTPUTS.map(name => read(name)));
  if (!runtimeArn) throw new Error(`\`terraform output -raw agent_runtime_arn\` in ${PLATFORM_ROOT} is empty — the runtime has not been applied yet.`);
  return { runtimeArn: runtimeArn, tokenUrl: tokenUrl ?? '', clientId: clientId ?? '' };
}

/**
 * Turns a `terraform output` failure into a sentence that names the real cause.
 *
 * The raw error the owner used to get — "Backend initialization required,
 * please run `terraform init`" — is accurate about Terraform and useless about
 * HomeLedger, because running `terraform init` here fails too. Both branches
 * therefore end at the same place: this path is opt-in, and the way out is to
 * stop opting in.
 */
export function terraformFailureMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if ((err as { code?: unknown })?.code === 'ENOENT')
    return `--from-terraform needs the terraform binary on PATH and it is not there. Drop --from-terraform to read the same values from AWS instead.`;
  return `\`terraform output\` failed in ${PLATFORM_ROOT}: ${detail.trim()}\n${TERRAFORM_BACKEND_NOTE}`;
}

/**
 * Decides which AWS profile this helper signs its own calls with, and records
 * whether the owner chose it.
 *
 * The precedence copies `loadConfig`'s deliberately, so the profile the helper
 * reads AWS with is the same one it writes into the `claude mcp add` command,
 * which is in turn the same one the running bridge will use for Secrets
 * Manager. Three places resolving a profile three ways is how an owner ends up
 * with a helper that works and a bridge that cannot start.
 *
 * `fromEnvironment` exists only so that a credentials failure can say which of
 * two different things went wrong: a session that lapsed on the profile the
 * owner picked, or no choice having been made at all. The second is the case
 * the owner hit, and an "expired session" message for a profile they never
 * named is a dead end.
 */
export function resolveSetupIdentity(env: NodeJS.ProcessEnv): AwsIdentityContext {
  const named = env.AWS_PROFILE?.trim() || env.HOMELEDGER_AWS_PROFILE?.trim();
  return {
    region: env.AWS_REGION?.trim() || DEFAULT_REGION,
    profile: named || DEFAULT_AWS_PROFILE,
    profileFromEnvironment: Boolean(named)
  };
}

export interface SetupRenderOptions {
  values: SetupValues;
  entrypoint: string;
  region?: string;
  profile?: string;
  /** False when AWS_PROFILE was unset and the default was used; the rendered block then says so. */
  profileFromEnvironment?: boolean;
}

/** Renders the block the owner pastes. Kept pure so the exact text is asserted in a test rather than eyeballed once. */
export function renderSetup({
  values,
  entrypoint,
  region = DEFAULT_REGION,
  profile = DEFAULT_AWS_PROFILE,
  profileFromEnvironment = true
}: SetupRenderOptions): string {
  return [
    'Add the deployed HomeLedger server to Claude Code:',
    '',
    '  claude mcp add homeledger \\',
    '    --scope user \\',
    `    -e HOMELEDGER_RUNTIME_ARN='${values.runtimeArn}' \\`,
    `    -e HOMELEDGER_COGNITO_TOKEN_URL='${values.tokenUrl}' \\`,
    `    -e HOMELEDGER_COGNITO_CLIENT_ID='${values.clientId}' \\`,
    `    -e AWS_REGION='${region}' \\`,
    `    -e AWS_PROFILE='${profile}' \\`,
    `    -- node ${entrypoint}`,
    '',
    `No client secret appears above, and none should: the bridge reads it from Secrets Manager with the ${profile} profile at startup.`,
    `Sign in first with \`aws login --profile ${profile}\`; the bridge needs that session only while it starts.`,
    // The -e AWS_PROFILE above pins the profile for the spawned bridge whether
    // or not the owner has one exported, so an unset AWS_PROFILE is not an
    // error here — but it is worth one line, because the values above were
    // discovered with that same defaulted profile and an owner whose session
    // lives elsewhere should know which account they are looking at.
    ...(profileFromEnvironment ? [] : [`AWS_PROFILE was not set, so ${profile} was used to look these up and is written into the command above.`]),
    ''
  ].join('\n');
}
