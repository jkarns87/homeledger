import type { EventBridgeEvent } from 'aws-lambda';
import {
  arrivalWindowFor,
  createDynamoRepository,
  derivedId,
  pickArrivalVisit,
  pushPayload,
  type Repository,
  type SnapshotStatusValue,
  type Visit
} from '@homeledger/core';
import { HOMELEDGER_SOURCE, createEventPublisher, type EventPublisher } from '../aws/bus.js';
import { createAnthropicDescriber, type Describer } from '../aws/describe.js';
import { createSnapshotWriter, snapshotKeyFor, type PutSnapshot } from '../aws/objects.js';
import { createSecretsPort } from '../aws/secrets.js';
import { createTokenStore, linkedAccessToken } from '../aws/tokens.js';
import { optionalEnv, requireEnv } from '../env.js';
import { createRingApi, type RingApi } from '../ring/client.js';
import { fetchDoorbellSnapshot, imageKind } from '../ring/snapshot.js';

export interface RingEventDetail {
  requestId: string;
  accountId: string | null;
  eventId: string | null;
  type: string;
  subType: string | null;
  deviceId: string | null;
  deviceName: string;
  at: string;
}

export interface CorrelatorDeps {
  repo: Pick<Repository, 'getDevice' | 'putDevice' | 'listVisitsInWindow' | 'markVisitArrived' | 'recordVisitSnapshot'>;
  requestImage: RingApi['requestImage'];
  putSnapshot: PutSnapshot;
  describe: Describer | null;
  publish: EventPublisher;
  householdId: string;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
}

export type CorrelationOutcome =
  | { outcome: 'not-a-doorbell-arrival' }
  | { outcome: 'no-visit' }
  | { outcome: 'already-arrived'; visitId: string }
  | { outcome: 'arrived'; visitId: string; snapshotStatus: SnapshotStatusValue; snapshotLatencyMs: number };

/** R3: a press always qualifies and teaches us the device is a doorbell; human motion qualifies only from a known doorbell. */
async function qualifies(deps: CorrelatorDeps, detail: RingEventDetail): Promise<boolean> {
  if (!detail.deviceId) return false;
  const device = await deps.repo.getDevice(detail.deviceId);
  if (detail.type === 'button_press') {
    if (device?.kind !== 'doorbell') {
      await deps.repo.putDevice(
        device
          ? { ...device, kind: 'doorbell' }
          : {
              id: derivedId('dev', detail.deviceId),
              ringDeviceId: detail.deviceId,
              name: detail.deviceName,
              kind: 'doorbell',
              online: true,
              lastSeenAt: detail.at,
              sensorState: null
            }
      );
    }
    return true;
  }
  return detail.type === 'motion_detected' && detail.subType === 'human' && device?.kind === 'doorbell';
}

async function snapshotAndPush(deps: CorrelatorDeps, visit: Visit, detail: RingEventDetail): Promise<CorrelationOutcome> {
  const snap = await fetchDoorbellSnapshot(
    { requestImage: deps.requestImage, now: deps.nowMs, sleep: deps.sleep },
    { deviceId: detail.deviceId!, eventAtMs: Date.parse(detail.at) }
  );
  let status = snap.status;
  let snapshotKey: string | null = null;
  let description: string | null = null;
  const kind = snap.bytes ? imageKind(snap.bytes) : null;
  if (status === 'ok' && snap.bytes && kind) {
    const mediaType = kind === 'png' ? 'image/png' : 'image/jpeg';
    try {
      snapshotKey = snapshotKeyFor(deps.householdId, visit.id, kind);
      await deps.putSnapshot(snapshotKey, snap.bytes, mediaType);
    } catch (err) {
      console.log(JSON.stringify({ msg: 'visit-correlator', outcome: 'snapshot-store-failed', error: err instanceof Error ? err.message : String(err) }));
      snapshotKey = null;
      status = 'error';
    }
    if (snapshotKey && deps.describe) {
      description = await deps.describe(snap.bytes, mediaType).catch(err => {
        console.log(JSON.stringify({ msg: 'visit-correlator', outcome: 'describe-failed', error: err instanceof Error ? err.message : String(err) }));
        return null;
      });
    }
  }
  await deps.repo.recordVisitSnapshot(visit.id, { snapshotKey, snapshotStatus: status, description, snapshotLatencyMs: snap.latencyMs });
  await deps.publish([{ source: HOMELEDGER_SOURCE, detailType: 'visit.arrived', detail: pushPayload('visit.arrived', visit.id) }]);
  console.log(
    JSON.stringify({
      msg: 'visit-correlator',
      outcome: 'arrived',
      snapshotStatus: status,
      snapshotLatencyMs: snap.latencyMs,
      attempts: snap.attempts,
      lastRefusal: snap.lastRefusal
    })
  );
  return { outcome: 'arrived', visitId: visit.id, snapshotStatus: status, snapshotLatencyMs: snap.latencyMs };
}

export async function correlateArrival(deps: CorrelatorDeps, detail: RingEventDetail): Promise<CorrelationOutcome> {
  if (!(await qualifies(deps, detail))) return { outcome: 'not-a-doorbell-arrival' };
  const { fromIso, toIso } = arrivalWindowFor(detail.at);
  const candidates = await deps.repo.listVisitsInWindow(fromIso, toIso);

  // A retry of this very delivery after it marked the visit arrived: resume.
  const unfinished = candidates.find(v => v.status === 'arrived' && v.ringEventIds.includes(detail.requestId) && (v.snapshotStatus ?? null) === null);
  if (unfinished) return snapshotAndPush(deps, unfinished, detail);

  const visit = pickArrivalVisit(candidates, detail.at);
  if (!visit) {
    const arrivedAlready = candidates.find(v => v.status === 'arrived');
    return arrivedAlready ? { outcome: 'already-arrived', visitId: arrivedAlready.id } : { outcome: 'no-visit' };
  }
  if ((await deps.repo.markVisitArrived(visit.id, detail.at, detail.requestId)) === 'not-scheduled') return { outcome: 'already-arrived', visitId: visit.id };
  return snapshotAndPush(deps, visit, detail);
}

let live: CorrelatorDeps | undefined;
function liveDeps(): CorrelatorDeps {
  if (live) return live;
  const secrets = createSecretsPort();
  const api = createRingApi({ accessToken: linkedAccessToken(createTokenStore(secrets, requireEnv('RING_TOKENS_SECRET_ID'))) });
  live = {
    repo: createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') }),
    requestImage: (id, window) => api.requestImage(id, window),
    putSnapshot: createSnapshotWriter(requireEnv('SNAPSHOT_BUCKET')),
    describe: createAnthropicDescriber({
      apiKey: () => secrets.read(requireEnv('ANTHROPIC_KEY_SECRET_ID')),
      model: optionalEnv('ANTHROPIC_MODEL') ?? 'claude-sonnet-5'
    }),
    publish: createEventPublisher(requireEnv('EVENT_BUS_NAME')),
    householdId: requireEnv('HOUSEHOLD_ID'),
    nowMs: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
  };
  return live;
}

/** Target of the rule matching `button_press`, and `motion_detected` with `detail.subType = human`. Throws on failure so EventBridge retries and then dead-letters. */
export const handler = async (event: EventBridgeEvent<string, RingEventDetail>): Promise<void> => {
  const outcome = await correlateArrival(liveDeps(), event.detail);
  console.log(JSON.stringify({ msg: 'visit-correlator', trigger: event['detail-type'], requestId: event.detail.requestId, ...outcome }));
};
