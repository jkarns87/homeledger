import { createDynamoRepository, newId, pushPayload } from '@homeledger/core';
import { raiseSystemAlert } from '../aws/alerts.js';
import { HOMELEDGER_SOURCE, createEventPublisher } from '../aws/bus.js';
import { createSecretsPort } from '../aws/secrets.js';
import { createTokenStore, type TokenStore } from '../aws/tokens.js';
import { requireEnv } from '../env.js';
import { RingApiError, createRingOAuth, type RingOAuth } from '../ring/client.js';

export const REFRESH_MARGIN_MS = 3_600_000;
export const RING_ACCESS_LAPSED_MESSAGE = 'Ring access lapsed, so doorbell and sensor events have stopped. Link the Ring account again from the Ring app.';

/**
 * Spec §3: refresh ahead of expiry with a one-hour margin; a failed refresh is
 * never silent. Ring refusing the refresh token (4xx) means only a re-link
 * helps: alert once and mark the record lapsed. Anything else is transient:
 * throw, and the schedule's next run tries again.
 */
export async function refreshIfDue(deps: {
  store: TokenStore;
  oauth: () => Promise<RingOAuth>;
  nowMs: () => number;
  alert: (message: string) => Promise<void>;
}): Promise<'not-linked' | 'fresh' | 'refreshed' | 'lapsed'> {
  const record = await deps.store.read();
  if (!record || record.status !== 'linked') return 'not-linked';
  if (Date.parse(record.expiresAt) - deps.nowMs() > REFRESH_MARGIN_MS) return 'fresh';
  try {
    const tokens = await (await deps.oauth()).refresh(record.refreshToken);
    await deps.store.write({ ...record, ...tokens, updatedAt: new Date(deps.nowMs()).toISOString() });
    return 'refreshed';
  } catch (err) {
    if (err instanceof RingApiError && err.status >= 400 && err.status < 500) {
      await deps.store.write({ ...record, status: 'lapsed', updatedAt: new Date(deps.nowMs()).toISOString() });
      await deps.alert(RING_ACCESS_LAPSED_MESSAGE);
      return 'lapsed';
    }
    throw err;
  }
}

export const handler = async (): Promise<void> => {
  const secrets = createSecretsPort();
  const repo = createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') });
  const publish = createEventPublisher(requireEnv('EVENT_BUS_NAME'));
  const outcome = await refreshIfDue({
    store: createTokenStore(secrets, requireEnv('RING_TOKENS_SECRET_ID')),
    oauth: async () => createRingOAuth({ clientId: requireEnv('RING_CLIENT_ID'), clientSecret: await secrets.read(requireEnv('RING_CLIENT_SECRET_ID')) }),
    nowMs: () => Date.now(),
    alert: async message => {
      const alert = await raiseSystemAlert({ repo, newId: () => newId('alert'), now: () => new Date().toISOString() }, message);
      await publish([{ source: HOMELEDGER_SOURCE, detailType: 'alert.raised', detail: pushPayload('alert.raised', alert.id) }]);
    }
  });
  console.log(JSON.stringify({ msg: 'token-refresh', outcome }));
};
