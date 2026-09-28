import { SecretMissingError, type SecretsPort } from './secrets.js';

/**
 * The one linked Ring account's tokens, as JSON in `demo-homeledger/ring/tokens`.
 * `unclaimed` between the Token Exchange URL and the sign-in at the Account
 * Link URL (amendment §12.1); `linked` after the PATCH succeeds; `lapsed`
 * once Ring refuses the refresh token, so the refresh job raises its alert
 * once rather than every half hour (Task 11).
 */
export interface TokenRecord {
  accountId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  status: 'unclaimed' | 'linked' | 'lapsed';
  updatedAt: string;
}

export interface TokenStore {
  read(): Promise<TokenRecord | null>;
  write(record: TokenRecord): Promise<void>;
}

export class RingNotLinkedError extends Error {}

function isRecord(v: unknown): v is TokenRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    ['accountId', 'accessToken', 'refreshToken', 'expiresAt', 'updatedAt'].every(k => typeof r[k] === 'string') &&
    (r.status === 'unclaimed' || r.status === 'linked' || r.status === 'lapsed')
  );
}

export function createTokenStore(secrets: SecretsPort, secretId: string): TokenStore {
  return {
    async read() {
      let raw: string;
      try {
        raw = await secrets.read(secretId);
      } catch (err) {
        if (err instanceof SecretMissingError) return null;
        throw err;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        return isRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    async write(record) {
      await secrets.write(secretId, JSON.stringify(record));
    }
  };
}

export function linkedAccessToken(store: TokenStore): () => Promise<string> {
  return async () => {
    const record = await store.read();
    if (!record || record.status !== 'linked') throw new RingNotLinkedError('Ring is not linked to HomeLedger yet.');
    return record.accessToken;
  };
}
