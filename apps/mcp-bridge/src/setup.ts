import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_AWS_PROFILE, DEFAULT_REGION } from './config.js';

const execFileAsync = promisify(execFile);

/**
 * The Terraform outputs this helper reads, and the only ones it may read.
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

export interface OutputReader {
  (name: string): Promise<string>;
}

export function createTerraformReader(cwd: string): OutputReader {
  return async name => {
    const { stdout } = await execFileAsync('terraform', ['output', '-raw', name], { cwd });
    return stdout.trim();
  };
}

export interface SetupValues {
  runtimeArn: string;
  tokenUrl: string;
  clientId: string;
}

export async function readSetupValues(read: OutputReader): Promise<SetupValues> {
  const [runtimeArn, tokenUrl, clientId] = await Promise.all(READABLE_TERRAFORM_OUTPUTS.map(name => read(name)));
  if (!runtimeArn) throw new Error(`\`terraform output -raw agent_runtime_arn\` in ${PLATFORM_ROOT} is empty — the runtime has not been applied yet.`);
  return { runtimeArn: runtimeArn, tokenUrl: tokenUrl ?? '', clientId: clientId ?? '' };
}

export interface SetupRenderOptions {
  values: SetupValues;
  entrypoint: string;
  region?: string;
  profile?: string;
}

/** Renders the block the owner pastes. Kept pure so the exact text is asserted in a test rather than eyeballed once. */
export function renderSetup({ values, entrypoint, region = DEFAULT_REGION, profile = DEFAULT_AWS_PROFILE }: SetupRenderOptions): string {
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
    ''
  ].join('\n');
}
