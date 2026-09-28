import { createMemoryRepository, type Repository, type Visit } from '@homeledger/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { correlateArrival, type CorrelatorDeps, type RingEventDetail } from '../src/handlers/visit-correlator.js';
import type { ImageAnswer } from '../src/ring/client.js';
import { JPEG_BYTES, clock, recordingPublisher } from './fakes.js';

const PRESS_AT = '2026-10-06T13:20:00.000Z';
const press: RingEventDetail = {
  requestId: 'req-bp-0001',
  accountId: 'acct-123',
  eventId: 'evt-bp-0001',
  type: 'button_press',
  subType: null,
  deviceId: 'dev-doorbell-1',
  deviceName: 'Front Door',
  at: PRESS_AT
};
const humanMotion: RingEventDetail = {
  ...press,
  requestId: 'req-mo-0001',
  eventId: 'evt-mo-0001',
  type: 'motion_detected',
  subType: 'human',
  at: '2026-10-06T13:20:05.000Z'
};
const booked: Visit = {
  id: 'visit_aaaaaaaaaaaaaaaa',
  providerId: 'prov_kettle_water',
  providerName: 'Kettle Creek Water Heaters',
  category: 'water_heater',
  applianceId: 'appl_waterheater22222',
  issue: 'no hot water',
  windowStart: '2026-10-06T13:00:00.000Z',
  windowEnd: '2026-10-06T15:00:00.000Z',
  status: 'scheduled',
  ringEventIds: [],
  snapshotKey: null,
  description: null,
  snapshotStatus: null,
  snapshotLatencyMs: null,
  arrivedAt: null,
  createdAt: '2026-10-04T12:00:00.000Z'
};

let repo: Repository;
let bus: ReturnType<typeof recordingPublisher>;
let stored: Array<{ key: string; bytes: Buffer; contentType: string }>;

function deps(answers: ImageAnswer[] = [{ kind: 'image', bytes: JPEG_BYTES, contentType: 'image/jpeg' }], over: Partial<CorrelatorDeps> = {}): CorrelatorDeps {
  const c = clock(Date.parse(PRESS_AT) + 3_000);
  let i = 0;
  return {
    repo,
    requestImage: async () => answers[Math.min(i++, answers.length - 1)]!,
    putSnapshot: async (key, bytes, contentType) => {
      stored.push({ key, bytes, contentType });
    },
    describe: async () => 'A person holding a toolbox stands at the front door.',
    publish: bus.publish,
    householdId: 'hh_harlow',
    nowMs: c.now,
    sleep: c.sleep,
    ...over
  };
}

beforeEach(async () => {
  repo = createMemoryRepository('hh_harlow');
  bus = recordingPublisher();
  stored = [];
  await repo.putVisit(booked);
});

describe('correlateArrival (spec §5)', () => {
  it('marks the booked visit arrived on a press, stores the photo byte-for-byte, describes it, and pushes once', async () => {
    const outcome = await correlateArrival(deps(), press);
    expect(outcome).toEqual({ outcome: 'arrived', visitId: 'visit_aaaaaaaaaaaaaaaa', snapshotStatus: 'ok', snapshotLatencyMs: 3_000 });
    const v = await repo.getVisit('visit_aaaaaaaaaaaaaaaa');
    expect(v).toMatchObject({
      status: 'arrived',
      arrivedAt: PRESS_AT,
      ringEventIds: ['req-bp-0001'],
      snapshotKey: 'snapshots/hh_harlow/visit_aaaaaaaaaaaaaaaa.jpg',
      snapshotStatus: 'ok',
      description: 'A person holding a toolbox stands at the front door.',
      snapshotLatencyMs: 3_000
    });
    expect(stored).toEqual([{ key: 'snapshots/hh_harlow/visit_aaaaaaaaaaaaaaaa.jpg', bytes: JPEG_BYTES, contentType: 'image/jpeg' }]);
    expect(bus.entries).toEqual([
      { source: 'homeledger.events', detailType: 'visit.arrived', detail: { cardType: 'visit.arrived', id: 'visit_aaaaaaaaaaaaaaaa' } }
    ]);
  });

  it('learns that the pressing device is a doorbell (R3)', async () => {
    await correlateArrival(deps(), press);
    expect(await repo.getDevice('dev-doorbell-1')).toMatchObject({ name: 'Front Door', kind: 'doorbell' });
  });

  it('accepts human motion only from a device already known to be a doorbell', async () => {
    expect(await correlateArrival(deps(), humanMotion)).toEqual({ outcome: 'not-a-doorbell-arrival' });
    expect((await repo.getVisit('visit_aaaaaaaaaaaaaaaa'))?.status).toBe('scheduled');
    await repo.putDevice({
      id: 'dev_aaaaaaaaaaaaaaaa',
      ringDeviceId: 'dev-doorbell-1',
      name: 'Front Door',
      kind: 'doorbell',
      online: true,
      lastSeenAt: null,
      sensorState: null
    });
    expect((await correlateArrival(deps(), humanMotion)).outcome).toBe('arrived');
  });

  it('ignores motion that is not a person, and anything without a device', async () => {
    await repo.putDevice({
      id: 'dev_aaaaaaaaaaaaaaaa',
      ringDeviceId: 'dev-doorbell-1',
      name: 'Front Door',
      kind: 'doorbell',
      online: true,
      lastSeenAt: null,
      sensorState: null
    });
    expect(await correlateArrival(deps(), { ...humanMotion, subType: 'vehicle' })).toEqual({ outcome: 'not-a-doorbell-arrival' });
    expect(await correlateArrival(deps(), { ...press, deviceId: null })).toEqual({ outcome: 'not-a-doorbell-arrival' });
    expect(bus.entries).toEqual([]);
  });

  it('pushes nothing and changes nothing when no visit is booked around the press', async () => {
    expect(await correlateArrival(deps(), { ...press, at: '2026-10-06T18:00:00.000Z' })).toEqual({ outcome: 'no-visit' });
    expect((await repo.getVisit('visit_aaaaaaaaaaaaaaaa'))?.status).toBe('scheduled');
    expect(bus.entries).toEqual([]);
    expect(stored).toEqual([]);
  });

  it('turns a press and the motion that follows it into one arrival and one push', async () => {
    await correlateArrival(deps(), press);
    expect(await correlateArrival(deps(), humanMotion)).toEqual({ outcome: 'already-arrived', visitId: 'visit_aaaaaaaaaaaaaaaa' });
    expect(bus.entries).toHaveLength(1);
  });

  it('does not take over an arrival another delivery is still photographing', async () => {
    // The press's Lambda has marked the visit arrived and is still waiting on
    // Ring for the picture; the motion event lands on a second instance now.
    await repo.putDevice({
      id: 'dev_aaaaaaaaaaaaaaaa',
      ringDeviceId: 'dev-doorbell-1',
      name: 'Front Door',
      kind: 'doorbell',
      online: true,
      lastSeenAt: null,
      sensorState: null
    });
    await repo.putVisit({ ...booked, status: 'arrived', arrivedAt: PRESS_AT, ringEventIds: ['req-bp-0001'] });
    expect(await correlateArrival(deps(), humanMotion)).toEqual({ outcome: 'already-arrived', visitId: 'visit_aaaaaaaaaaaaaaaa' });
    expect(bus.entries).toEqual([]);
    expect(stored).toEqual([]);
  });

  it('still records the arrival and pushes when Ring refuses the photo, with no image stored', async () => {
    const outcome = await correlateArrival(deps([{ kind: 'refused', status: 403, code: 'TIME_RANGE_NOT_AUTHORIZED' }]), press);
    expect(outcome).toMatchObject({ outcome: 'arrived', snapshotStatus: 'forbidden' });
    expect(await repo.getVisit('visit_aaaaaaaaaaaaaaaa')).toMatchObject({
      status: 'arrived',
      snapshotKey: null,
      snapshotStatus: 'forbidden',
      description: null
    });
    expect(stored).toEqual([]);
    expect(bus.entries).toHaveLength(1);
  });

  it('keeps the photo without a sentence when the description fails, or when there is no describer', async () => {
    await correlateArrival(deps(undefined, { describe: async () => Promise.reject(new Error('529')) }), press);
    expect(await repo.getVisit('visit_aaaaaaaaaaaaaaaa')).toMatchObject({ snapshotStatus: 'ok', description: null });
    await repo.putVisit(booked);
    stored = [];
    await correlateArrival(deps(undefined, { describe: null }), { ...press, requestId: 'req-bp-0002' });
    expect(await repo.getVisit('visit_aaaaaaaaaaaaaaaa')).toMatchObject({ snapshotStatus: 'ok', description: null });
  });

  it('calls a photo that could not be stored an error, with no key pointing at nothing', async () => {
    await correlateArrival(deps(undefined, { putSnapshot: async () => Promise.reject(new Error('AccessDenied')) }), press);
    expect(await repo.getVisit('visit_aaaaaaaaaaaaaaaa')).toMatchObject({ snapshotKey: null, snapshotStatus: 'error', description: null });
  });

  it('resumes after a failed invocation instead of losing the snapshot and the push', async () => {
    const recordOnceFails = vi
      .fn()
      .mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded'))
      .mockImplementation((id: string, s: Parameters<Repository['recordVisitSnapshot']>[1]) => repo.recordVisitSnapshot(id, s));
    const flaky = { ...repo, recordVisitSnapshot: recordOnceFails } as Repository;
    await expect(correlateArrival(deps(undefined, { repo: flaky }), press)).rejects.toThrow('ProvisionedThroughputExceeded');
    expect(bus.entries).toEqual([]);
    const retry = await correlateArrival(deps(undefined, { repo: flaky }), press);
    expect(retry).toMatchObject({ outcome: 'arrived', snapshotStatus: 'ok' });
    expect(bus.entries).toHaveLength(1);
    expect((await repo.getVisit('visit_aaaaaaaaaaaaaaaa'))?.ringEventIds).toEqual(['req-bp-0001']);
  });
});
