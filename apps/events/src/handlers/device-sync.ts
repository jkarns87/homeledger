import type { EventBridgeEvent } from 'aws-lambda';
import { createDynamoRepository, derivedId, newId, pushPayload, type Device, type Repository } from '@homeledger/core';
import { raiseSystemAlert } from '../aws/alerts.js';
import { HOMELEDGER_SOURCE, createEventPublisher } from '../aws/bus.js';
import { createSecretsPort } from '../aws/secrets.js';
import { RingNotLinkedError, createTokenStore, linkedAccessToken } from '../aws/tokens.js';
import { requireEnv } from '../env.js';
import { createRingApi, type RingApi, type RingDeviceStatus } from '../ring/client.js';

export interface SyncDeps {
  repo: Pick<Repository, 'listDevices' | 'getDevice' | 'putDevice'>;
  now: () => string;
}

/** R3: the kind is ours to record; sensor state belongs to the sensor rules. */
export async function syncDevices(deps: SyncDeps, api: Pick<RingApi, 'listDevices' | 'deviceStatus'>): Promise<Device[]> {
  const listed = await api.listDevices();
  const seen = new Set<string>();
  const written: Device[] = [];
  for (const summary of listed) {
    seen.add(summary.id);
    const existing = await deps.repo.getDevice(summary.id);
    let status: RingDeviceStatus | null = null;
    try {
      status = await api.deviceStatus(summary.id);
    } catch (err) {
      console.log(JSON.stringify({ msg: 'device-sync', outcome: 'status-failed', error: err instanceof Error ? err.message : String(err) }));
    }
    const isSensor = status !== null && (status.flood !== null || status.freeze !== null);
    const device: Device = {
      id: existing?.id ?? derivedId('dev', summary.id),
      ringDeviceId: summary.id,
      name: summary.name,
      kind: isSensor ? 'sensor' : (existing?.kind ?? 'other'),
      online: status?.online ?? false,
      lastSeenAt: status?.online ? deps.now() : (existing?.lastSeenAt ?? null),
      sensorState: existing?.sensorState ?? null
    };
    await deps.repo.putDevice(device);
    written.push(device);
  }
  for (const gone of (await deps.repo.listDevices()).filter(d => !seen.has(d.ringDeviceId) && d.online)) await deps.repo.putDevice({ ...gone, online: false });
  return written;
}

export const RING_UNLINKED_MESSAGE = 'Ring was disconnected from HomeLedger in the Ring app. Doorbell and sensor events will stop until it is linked again.';

export interface DeviceEventDeps {
  sync: () => Promise<Device[]>;
  raiseUnlinked: () => Promise<void>;
}

const SYNC_ON = new Set(['device_added', 'device_removed', 'device_online', 'device_offline', 'app_integration_added', 'Scheduled Event']);

/**
 * 'not-linked': no linked tokens (before the first link, after an unlink, or
 * after a lapse). That is a state, not a failure: throwing would make Lambda
 * retry, dead-letter, and raise a false alert every night.
 */
export async function handleDeviceEvent(deps: DeviceEventDeps, detailType: string): Promise<'synced' | 'unlinked' | 'not-linked' | 'ignored'> {
  if (detailType === 'app_integration_removed') {
    await deps.raiseUnlinked();
    return 'unlinked';
  }
  if (!SYNC_ON.has(detailType)) return 'ignored';
  try {
    await deps.sync();
  } catch (err) {
    if (err instanceof RingNotLinkedError) return 'not-linked';
    throw err;
  }
  return 'synced';
}

let live: DeviceEventDeps | undefined;
function liveDeps(): DeviceEventDeps {
  if (live) return live;
  const repo = createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') });
  const store = createTokenStore(createSecretsPort(undefined, { ttlMs: 0 }), requireEnv('RING_TOKENS_SECRET_ID'));
  const publish = createEventPublisher(requireEnv('EVENT_BUS_NAME'));
  const now = () => new Date().toISOString();
  live = {
    sync: () => syncDevices({ repo, now }, createRingApi({ accessToken: linkedAccessToken(store) })),
    raiseUnlinked: async () => {
      const alert = await raiseSystemAlert({ repo, newId: () => newId('alert'), now }, RING_UNLINKED_MESSAGE);
      await publish([{ source: HOMELEDGER_SOURCE, detailType: 'alert.raised', detail: pushPayload('alert.raised', alert.id) }]);
    }
  };
  return live;
}

/** EventBridge rule targets (device_* and app_integration_* from the webhook) and the nightly schedule, whose detail-type is 'Scheduled Event'. */
export const handler = async (event: EventBridgeEvent<string, unknown>): Promise<void> => {
  const outcome = await handleDeviceEvent(liveDeps(), event['detail-type']);
  console.log(JSON.stringify({ msg: 'device-sync', trigger: event['detail-type'], outcome }));
};
