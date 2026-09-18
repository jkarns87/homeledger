import type { BridgeConfig } from './config.js';
import { protectSecret } from './redact.js';

/**
 * Error names that mean "this machine has no usable AWS credentials right now".
 *
 * `CredentialsProviderError` covers both halves of the single most likely
 * failure the owner will hit — an SSO session that has expired, and one that
 * was never established — because the AWS SDK's credential chain raises the
 * same error name for both and the fix is the same sentence either way.
 * `SSOTokenProviderFailure` is what `@aws-sdk/token-providers` raises when the
 * cached SSO token in ~/.aws/sso/cache is past its expiry. The two STS names
 * cover a session that expired between the credential resolve and the API call.
 *
 * Deliberately excludes `AccessDeniedException`: a signed-in principal without
 * `secretsmanager:GetSecretValue` is a permissions problem, and telling that
 * owner to sign in again would send them round a loop that cannot terminate.
 */
const EXPIRED_SESSION_ERROR_NAMES = new Set(['CredentialsProviderError', 'SSOTokenProviderFailure', 'ExpiredTokenException', 'ExpiredToken']);

/**
 * Message fragments for the same condition arriving under a generic error name,
 * which is what STS does when the expiry is detected service-side rather than
 * by the local token provider.
 */
const EXPIRED_SESSION_MESSAGE_MARKERS = ['sso session', 'could not be refreshed', 'security token included in the request is expired', 'token has expired'];

export function isExpiredSessionError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  if (typeof name === 'string' && EXPIRED_SESSION_ERROR_NAMES.has(name)) return true;
  if (typeof message !== 'string') return false;
  const lower = message.toLowerCase();
  return EXPIRED_SESSION_MESSAGE_MARKERS.some(marker => lower.includes(marker));
}

/**
 * The one line the owner needs when the thing that broke is the SSO session.
 *
 * The brief calls this out as the single most likely failure, and it is the
 * only failure in this program whose remedy is one command — so it gets one
 * sentence, with the command in it, and no stack trace.
 */
export function expiredSessionMessage(profile: string | undefined): string {
  const flag = profile ? ` --profile ${profile}` : '';
  return `Your AWS SSO session expired, run \`aws login${flag}\``;
}

export class SecretError extends Error {}

export interface SecretReader {
  (secretId: string): Promise<string | undefined>;
}

/**
 * Reads the Cognito client secret, preferring an explicit environment variable
 * and otherwise reading Secrets Manager with the local profile.
 *
 * Secrets Manager is the default rather than the environment variable, and the
 * reason is where `claude mcp add`'s `-e` values end up: in `.mcp.json` at the
 * repository root when the server is added at project scope, or in
 * `~/.claude.json` at user scope. The first of those is a tracked file. A
 * default that puts the client secret on a `claude mcp add` command line is
 * therefore a default that ends with the secret in a config file and, one
 * `git add -A` later, in the repository — which this project forbids outright.
 * Reading it at startup instead means the only credential on the machine is the
 * SSO session, which expires on its own and which the owner already has for
 * everything else. The environment variable stays supported for CI and
 * containers, where there is no SSO session and no repository to leak into.
 */
export async function resolveClientSecret(config: BridgeConfig, readerFactory: () => Promise<SecretReader>): Promise<string> {
  if (config.clientSecretFromEnv) {
    protectSecret(config.clientSecretFromEnv);
    return config.clientSecretFromEnv;
  }
  let value: string | undefined;
  try {
    // The factory is called here, not by the caller, so the environment path
    // neither imports the AWS SDK nor constructs a client it will not use.
    value = await (await readerFactory())(config.secretId);
  } catch (err) {
    if (isExpiredSessionError(err)) throw new SecretError(expiredSessionMessage(config.awsProfile));
    const name = typeof (err as { name?: unknown })?.name === 'string' ? (err as { name: string }).name : 'Error';
    const detail = err instanceof Error ? err.message : String(err);
    if (name === 'AccessDeniedException')
      throw new SecretError(
        `The AWS identity from profile ${config.awsProfile ?? '(default)'} is not allowed to read ${config.secretId} in ${config.region}. Grant it secretsmanager:GetSecretValue, or set HOMELEDGER_COGNITO_CLIENT_SECRET instead.`
      );
    if (name === 'ResourceNotFoundException')
      throw new SecretError(
        `No secret named ${config.secretId} exists in ${config.region}. Check HOMELEDGER_COGNITO_SECRET_ID and AWS_REGION, or confirm the platform Terraform root has been applied.`
      );
    throw new SecretError(`Could not read ${config.secretId} from Secrets Manager in ${config.region}: ${detail}`);
  }
  // Terraform writes the raw client secret as the secret string — see
  // `secret_string_wo` in infra/modules/cognito-m2m/main.tf — so there is no
  // JSON envelope to unwrap here, and pretending there might be would add a
  // branch nothing in this repository can produce.
  if (!value)
    throw new SecretError(
      `Secret ${config.secretId} in ${config.region} has no string value. It may have been created without a version, or hold binary rather than text.`
    );
  protectSecret(value);
  return value;
}

/** Builds the real Secrets Manager reader. Imported lazily by the entrypoint so that tests never construct an AWS client. */
export async function createSecretsManagerReader(config: BridgeConfig): Promise<SecretReader> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region: config.region, profile: config.awsProfile });
  return async (secretId: string) => {
    const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    return out.SecretString;
  };
}
