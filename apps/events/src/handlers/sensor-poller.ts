import type { Device } from '@homeledger/core';
import { createDynamoRepository } from '@homeledger/core';
import { createSecretsPort } from '../aws/secrets.js';
import { createTokenStore, linkedAccessToken } from '../aws/tokens.js';
import { requireEnv } from '../env.js';
import { RingApiError, createRingApi, type RingApi } from '../ring/client.js';
import { applySensorObservation, liveSensorDeps, type SensorDeps } from './sensor-rules.js';

/**
 * The reconciliation adapter (R2, amendment §12.4): Ring says to treat
 * /status as the authority. A 429 ends this round — the schedule's next tick
 * is the backoff — and is logged, as spec §6 requires.
 */
export async function pollSensors(
  deps: SensorDeps & { enabled: boolean; listDevices: () => Promise<Device[]>; status: RingApi['deviceStatus']; now: () => string }
): Promise<{ polled: number; raised: number; failed: number; backedOff: boolean } | 'disabled'> {
  if (!deps.enabled) return 'disabled';
  const result = { polled: 0, raised: 0, failed: 0, backedOff: false };
  for (const device of (await deps.listDevices()).filter(d => d.kind === 'sensor')) {
    let status: Awaited<ReturnType<RingApi['deviceStatus']>>;
    try {
      status = await deps.status(device.ringDeviceId);
    } catch (err) {
      result.failed += 1;
      if (err instanceof RingApiError && err.status === 429) {
        result.backedOff = true;
        console.log(JSON.stringify({ msg: 'sensor-poller', outcome: 'rate-limited' }));
        break;
      }
      console.log(JSON.stringify({ msg: 'sensor-poller', outcome: 'status-failed', error: err instanceof Error ? err.message : String(err) }));
      continue;
    }
    result.polled += 1;
    const observed = { ...(status.flood === null ? {} : { flood: status.flood }), ...(status.freeze === null ? {} : { freeze: status.freeze }) };
    const out = await applySensorObservation(deps, { ringDeviceId: device.ringDeviceId, deviceName: device.name, observed, at: deps.now(), source: 'poll' });
    result.raised += out.raised.length;
  }
  return result;
}

export const handler = async (): Promise<void> => {
  const base = liveSensorDeps();
  const repo = createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') });
  const api = createRingApi({ accessToken: linkedAccessToken(createTokenStore(createSecretsPort(), requireEnv('RING_TOKENS_SECRET_ID'))) });
  const outcome = await pollSensors({
    ...base,
    listDevices: () => repo.listDevices(),
    status: id => api.deviceStatus(id),
    now: () => new Date().toISOString()
  });
  console.log(JSON.stringify({ msg: 'sensor-poller', outcome }));
};
