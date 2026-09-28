import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export class SecretMissingError extends Error {}

export interface SecretsPort {
  read(secretId: string): Promise<string>;
  write(secretId: string, value: string): Promise<void>;
}

/**
 * Cached per container for five minutes: a warm Lambda serving a burst of
 * webhooks should not pay a Secrets Manager call per delivery. A write
 * replaces the cached value, so the token refresh and the link see their own
 * writes. Errors name the secret, never its value.
 */
export function createSecretsPort(client: SecretsManagerClient = new SecretsManagerClient({}), opts: { now?: () => number; ttlMs?: number } = {}): SecretsPort {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 300_000;
  const cache = new Map<string, { value: string; at: number }>();
  return {
    async read(secretId) {
      const hit = cache.get(secretId);
      if (hit && now() - hit.at < ttl) return hit.value;
      let value: string | undefined;
      try {
        value = (await client.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString;
      } catch (err) {
        if ((err as { name?: string }).name === 'ResourceNotFoundException') throw new SecretMissingError(`Secret ${secretId} has no value.`);
        throw err;
      }
      if (!value) throw new SecretMissingError(`Secret ${secretId} has no value.`);
      cache.set(secretId, { value, at: now() });
      return value;
    },
    async write(secretId, value) {
      await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: value }));
      cache.set(secretId, { value, at: now() });
    }
  };
}
