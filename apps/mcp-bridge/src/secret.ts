import type { BridgeConfig } from './config.js';
import { expiredSessionMessage, isExpiredSessionError, isMissingProfileError, missingProfileMessage } from './aws-errors.js';
import { protectSecret } from './redact.js';

// Re-exported because this module was the original home of both, and because
// `test/secret.test.ts` and the README both name them here. The definitions
// moved to `aws-errors.ts` when `--print-setup` started making AWS calls of its
// own and needed the identical vocabulary; the alternative was two copies of
// "your session expired" drifting apart.
export { expiredSessionMessage, isExpiredSessionError };

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
    // Checked before the expiry branch, and for the same reason it is checked
    // first in `awsFailureMessage`: both conditions arrive as
    // `CredentialsProviderError`, and a wrong AWS_PROFILE in the generated
    // `claude mcp add` command would otherwise be reported as an expired
    // session for a profile that does not exist.
    if (isMissingProfileError(err))
      throw new SecretError(missingProfileMessage({ region: config.region, profile: config.awsProfile ?? '(default)', profileFromEnvironment: true }));
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
