import { createMemoryRepository, derivedId } from '@homeledger/core';
import { describe, expect, it, vi } from 'vitest';
import { RING_UNLINKED_MESSAGE, handleDeviceEvent, syncDevices } from '../src/handlers/device-sync.js';
import { RingNotLinkedError } from '../src/aws/tokens.js';
import { fakeRingApi } from './fakes.js';

const now = () => '2026-10-06T12:00:00.000Z';

describe('syncDevices (amendment §12.6, R3)', () => {
  it('records a device with a flood or freeze detector as a sensor, anything else as other, with stable ids', async () => {
    const repo = createMemoryRepository('hh_test');
    const api = fakeRingApi({
      devices: [
        { id: 'dev-doorbell-1', name: 'Front Door' },
        { id: 'dev-flood-1', name: 'Water Heater' }
      ],
      statuses: { 'dev-flood-1': { online: true, flood: false, freeze: false } }
    });
    await syncDevices({ repo, now }, api);
    expect(await repo.listDevices()).toEqual([
      {
        id: derivedId('dev', 'dev-doorbell-1'),
        ringDeviceId: 'dev-doorbell-1',
        name: 'Front Door',
        kind: 'other',
        online: true,
        lastSeenAt: '2026-10-06T12:00:00.000Z',
        sensorState: null
      },
      {
        id: derivedId('dev', 'dev-flood-1'),
        ringDeviceId: 'dev-flood-1',
        name: 'Water Heater',
        kind: 'sensor',
        online: true,
        lastSeenAt: '2026-10-06T12:00:00.000Z',
        sensorState: null
      }
    ]);
  });

  it('keeps a learned doorbell kind and the last known sensor state, and takes the new name', async () => {
    const repo = createMemoryRepository('hh_test');
    await repo.putDevice({
      id: 'dev_aaaaaaaaaaaaaaaa',
      ringDeviceId: 'dev-doorbell-1',
      name: 'Porch',
      kind: 'doorbell',
      online: true,
      lastSeenAt: null,
      sensorState: null
    });
    await repo.putDevice({
      id: 'dev_bbbbbbbbbbbbbbbb',
      ringDeviceId: 'dev-flood-1',
      name: 'Water Heater',
      kind: 'sensor',
      online: true,
      lastSeenAt: null,
      sensorState: { flood: true, freeze: false }
    });
    const api = fakeRingApi({
      devices: [
        { id: 'dev-doorbell-1', name: 'Front Door' },
        { id: 'dev-flood-1', name: 'Water Heater' }
      ],
      // The flood is dry now; sync must NOT write that - the sensor rules own transitions.
      statuses: { 'dev-flood-1': { online: true, flood: false, freeze: false } }
    });
    await syncDevices({ repo, now }, api);
    expect(await repo.getDevice('dev-doorbell-1')).toMatchObject({ id: 'dev_aaaaaaaaaaaaaaaa', name: 'Front Door', kind: 'doorbell' });
    expect((await repo.getDevice('dev-flood-1'))?.sensorState).toEqual({ flood: true, freeze: false });
  });

  it('marks a device Ring no longer lists as offline, and keeps going when one status call fails', async () => {
    const repo = createMemoryRepository('hh_test');
    await repo.putDevice({
      id: 'dev_cccccccccccccccc',
      ringDeviceId: 'dev-gone',
      name: 'Garage',
      kind: 'other',
      online: true,
      lastSeenAt: null,
      sensorState: null
    });
    const api = fakeRingApi({ devices: [{ id: 'dev-flood-1', name: 'Water Heater' }], statuses: { 'dev-flood-1': new Error('503') } });
    await syncDevices({ repo, now }, api);
    expect((await repo.getDevice('dev-gone'))?.online).toBe(false);
    expect(await repo.getDevice('dev-flood-1')).toMatchObject({ kind: 'other', online: false, lastSeenAt: null });
  });
});

describe('device and integration events', () => {
  it('syncs on every device event and on the link notice, and says so', async () => {
    const sync = vi.fn(async () => []);
    const raiseUnlinked = vi.fn(async () => {});
    for (const t of ['device_added', 'device_removed', 'device_online', 'device_offline', 'app_integration_added', 'Scheduled Event'])
      expect(await handleDeviceEvent({ sync, raiseUnlinked }, t)).toBe('synced');
    expect(sync).toHaveBeenCalledTimes(6);
    expect(raiseUnlinked).not.toHaveBeenCalled();
  });

  it('raises an alert, and does not call Ring, when the owner removes the app', async () => {
    const sync = vi.fn(async () => []);
    const raiseUnlinked = vi.fn(async () => {});
    expect(await handleDeviceEvent({ sync, raiseUnlinked }, 'app_integration_removed')).toBe('unlinked');
    expect(sync).not.toHaveBeenCalled();
    expect(raiseUnlinked).toHaveBeenCalledTimes(1);
    expect(RING_UNLINKED_MESSAGE).toBe('Ring was disconnected from HomeLedger in the Ring app. Doorbell and sensor events will stop until it is linked again.');
  });

  it('says not-linked, without throwing, when Ring is not linked yet (so the nightly schedule does not retry and dead-letter)', async () => {
    const raiseUnlinked = vi.fn(async () => {});
    const sync = vi.fn(async () => {
      throw new RingNotLinkedError('Ring is not linked to HomeLedger yet.');
    });
    expect(await handleDeviceEvent({ sync, raiseUnlinked }, 'Scheduled Event')).toBe('not-linked');
    expect(sync).toHaveBeenCalledTimes(1);
    expect(raiseUnlinked).not.toHaveBeenCalled();
  });

  it('still throws any other sync failure, so Lambda retries it', async () => {
    const sync = vi.fn(async () => {
      throw new Error('Ring 503');
    });
    await expect(handleDeviceEvent({ sync, raiseUnlinked: vi.fn() }, 'Scheduled Event')).rejects.toThrow('Ring 503');
  });

  it('ignores anything else', async () => {
    expect(await handleDeviceEvent({ sync: vi.fn(), raiseUnlinked: vi.fn() }, 'subscription_activated')).toBe('ignored');
  });
});
