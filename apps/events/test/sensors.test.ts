import { createMemoryRepository, seedRepository, type Repository } from '@homeledger/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { applySensorObservation, handleSensorEvent, householdToday, type SensorDeps } from '../src/handlers/sensor-rules.js';
import { pollSensors } from '../src/handlers/sensor-poller.js';
import type { RingEventDetail } from '../src/handlers/visit-correlator.js';
import { RingApiError } from '../src/ring/client.js';
import { decodeWebhook } from '../src/ring/envelope.js';
import { fixture, recordingPublisher } from './fakes.js';

const AT = '2026-10-06T21:15:00.000Z'; // 4:15 PM Central
let repo: Repository;
let bus: ReturnType<typeof recordingPublisher>;
let ids: number;

function deps(over: Partial<SensorDeps> = {}): SensorDeps {
  return {
    repo,
    publish: bus.publish,
    newAlertId: () => `alert_${'abcdefghijklmnop'.slice(0, 15)}${'abcdefgh'[ids++]}`,
    today: householdToday(repo, () => AT),
    sensorApplianceId: 'appl_waterheater22222',
    ...over
  };
}
const flood = (type: string, at = AT): RingEventDetail => ({
  requestId: `req-${type}-${at}`,
  accountId: 'acct-123',
  eventId: null,
  type,
  subType: null,
  deviceId: 'dev-flood-1',
  deviceName: 'Water Heater',
  at
});

beforeEach(async () => {
  repo = createMemoryRepository('hh_harlow');
  await seedRepository(repo, 'hh_harlow', '2026-10-06');
  await repo.putDevice({
    id: 'dev_aaaaaaaaaaaaaaaa',
    ringDeviceId: 'dev-flood-1',
    name: 'Water Heater',
    kind: 'sensor',
    online: true,
    lastSeenAt: null,
    sensorState: null
  });
  bus = recordingPublisher();
  ids = 0;
});

describe('flood and freeze (spec §6 rule table, amendment §12.4)', () => {
  it('raises a high flood alert, advances the water heater’s inspection, remembers the state, and pushes', async () => {
    const out = await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected'));
    expect(out).toEqual({ raised: ['alert_abcdefghijklmnoa'], resolved: [], reopened: [] });
    expect(await repo.listAlerts('2026-10-06T00:00:00.000Z')).toEqual([
      {
        id: 'alert_abcdefghijklmnoa',
        sensorType: 'flood',
        severity: 'high',
        ringDeviceId: 'dev-flood-1',
        message: null,
        deviceName: 'Water Heater',
        at: AT,
        maintenanceRef: { applianceId: 'appl_waterheater22222', taskType: 'inspection' },
        status: 'open'
      }
    ]);
    // The seeded inspection was already overdue (2026-08-28): it keeps that date and gains the note.
    expect(await repo.getMaintenance('appl_waterheater22222', 'inspection')).toMatchObject({
      nextDueAt: '2026-08-28',
      notes: 'Check for a leak near the Water Heater.'
    });
    expect((await repo.getDevice('dev-flood-1'))?.sensorState).toEqual({ flood: true, freeze: false });
    expect(bus.entries).toEqual([
      { source: 'homeledger.events', detailType: 'alert.raised', detail: { cardType: 'alert.raised', id: 'alert_abcdefghijklmnoa' } }
    ]);
  });

  it('does not alert twice for one trip — a redelivery, or the poll that follows the webhook', async () => {
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected'));
    await handleSensorEvent({ ...deps(), enabled: true }, { ...flood('flood_detected'), requestId: 'req-other' });
    await applySensorObservation(deps(), {
      ringDeviceId: 'dev-flood-1',
      deviceName: 'Water Heater',
      observed: { flood: true, freeze: false },
      at: AT,
      source: 'poll'
    });
    expect(await repo.listAlerts('2026-10-06T00:00:00.000Z')).toHaveLength(1);
    expect(bus.entries).toHaveLength(1);
  });

  it('does not raise a second open alert even when the remembered state was lost', async () => {
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected'));
    await repo.putDevice({
      id: 'dev_aaaaaaaaaaaaaaaa',
      ringDeviceId: 'dev-flood-1',
      name: 'Water Heater',
      kind: 'sensor',
      online: true,
      lastSeenAt: null,
      sensorState: null
    });
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected'));
    expect(await repo.listAlerts('2026-10-06T00:00:00.000Z')).toHaveLength(1);
  });

  it('resolves the open alert when the water clears, and leaves the maintenance item for a person to close', async () => {
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected'));
    const out = await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_cleared', '2026-10-06T21:40:00.000Z'));
    expect(out).toEqual({ raised: [], resolved: ['alert_abcdefghijklmnoa'], reopened: [] });
    expect((await repo.listAlerts('2026-10-06T00:00:00.000Z'))[0]?.status).toBe('resolved');
    expect((await repo.getMaintenance('appl_waterheater22222', 'inspection'))?.notes).toBe('Check for a leak near the Water Heater.');
    expect(bus.entries).toHaveLength(1);
  });

  it('records when the alert cleared', async () => {
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected'));
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_cleared', '2026-10-06T21:15:05.000Z'));
    expect((await repo.listAlerts('2026-10-06T00:00:00.000Z'))[0]).toMatchObject({ status: 'resolved', resolvedAt: '2026-10-06T21:15:05.000Z' });
  });

  it('re-opens the alert, without a second push, when water returns within two minutes of clearing (FL-063)', async () => {
    // The live sequence: wet, dry 5 s later, wet 5 s after that, dry again.
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected', '2026-10-06T21:15:00.000Z'));
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_cleared', '2026-10-06T21:15:05.000Z'));
    const again = await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected', '2026-10-06T21:15:10.000Z'));
    expect(again).toEqual({ raised: [], resolved: [], reopened: ['alert_abcdefghijklmnoa'] });
    const alerts = await repo.listAlerts('2026-10-06T00:00:00.000Z');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ status: 'open', resolvedAt: null, at: '2026-10-06T21:15:00.000Z' });
    expect(bus.entries).toHaveLength(1);
    // And the next clear resolves that same alert.
    const dry = await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_cleared', '2026-10-06T21:15:15.000Z'));
    expect(dry).toEqual({ raised: [], resolved: ['alert_abcdefghijklmnoa'], reopened: [] });
  });

  it('raises a new alert, and pushes, when water returns more than two minutes after clearing', async () => {
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected', '2026-10-06T21:15:00.000Z'));
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_cleared', '2026-10-06T21:15:05.000Z'));
    // 120 s is still inside the window; 120.001 s is not.
    const edge = await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected', '2026-10-06T21:17:05.000Z'));
    expect(edge).toMatchObject({ reopened: ['alert_abcdefghijklmnoa'] });
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_cleared', '2026-10-06T21:17:06.000Z'));
    const later = await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected', '2026-10-06T21:19:06.001Z'));
    expect(later).toEqual({ raised: ['alert_abcdefghijklmnob'], resolved: [], reopened: [] });
    expect(bus.entries).toHaveLength(2);
  });

  it('raises a new alert after one resolved before clearing times were recorded', async () => {
    // Rows resolved before resolvedAt existed carry none: a raise after one is a new alert.
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected', '2026-10-06T21:15:00.000Z'));
    const [row] = await repo.listAlerts('2026-10-06T00:00:00.000Z');
    const { resolvedAt: _dropped, ...legacy } = { ...row!, status: 'resolved' as const, resolvedAt: undefined };
    await repo.putAlert(legacy);
    await repo.putDevice({ ...(await repo.getDevice('dev-flood-1'))!, sensorState: { flood: false, freeze: false } });
    const out = await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected', '2026-10-06T21:15:10.000Z'));
    expect(out).toEqual({ raised: ['alert_abcdefghijklmnob'], resolved: [], reopened: [] });
  });

  it('treats freeze independently of flood', async () => {
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected'));
    const out = await handleSensorEvent({ ...deps(), enabled: true }, flood('freeze_detected'));
    expect(out).toEqual({ raised: ['alert_abcdefghijklmnob'], resolved: [], reopened: [] });
    expect((await repo.getDevice('dev-flood-1'))?.sensorState).toEqual({ flood: true, freeze: true });
    expect((await repo.getMaintenance('appl_waterheater22222', 'inspection'))?.notes).toBe('Check pipe insulation near the Water Heater.');
  });

  it('opens an inspection due on the household’s day, not the UTC one', async () => {
    // 03:00Z on the 7th is 10 PM on the 6th in Chicago. The washer has no inspection item yet.
    const late = '2026-10-07T03:00:00.000Z';
    await handleSensorEvent(
      { ...deps({ sensorApplianceId: 'appl_washer2222222222', today: householdToday(repo, () => late) }), enabled: true },
      flood('flood_detected', late)
    );
    expect(await repo.getMaintenance('appl_washer2222222222', 'inspection')).toEqual({
      applianceId: 'appl_washer2222222222',
      taskType: 'inspection',
      intervalDays: 180,
      lastDoneAt: null,
      nextDueAt: '2026-10-06',
      notes: 'Check for a leak near the Water Heater.'
    });
  });

  it('raises an informational contact alert with no maintenance, and resolves it on close', async () => {
    const door: RingEventDetail = { ...flood('contact_sensor_faulted'), deviceId: 'dev-contact-1', deviceName: 'Back Door' };
    const out = await handleSensorEvent({ ...deps(), enabled: true }, door);
    expect(out).toEqual({ raised: ['alert_abcdefghijklmnoa'], resolved: [], reopened: [] });
    expect((await repo.listAlerts('2026-10-06T00:00:00.000Z'))[0]).toMatchObject({ sensorType: 'contact', severity: 'info', maintenanceRef: null });
    const closed = await handleSensorEvent({ ...deps(), enabled: true }, { ...door, type: 'contact_sensor_cleared' });
    expect(closed).toEqual({ raised: [], resolved: ['alert_abcdefghijklmnoa'], reopened: [] });
  });

  it('does nothing while the sensor path is switched off (spec §6 flag), and ignores other types', async () => {
    expect(await handleSensorEvent({ ...deps(), enabled: false }, flood('flood_detected'))).toBe('disabled');
    expect(await handleSensorEvent({ ...deps(), enabled: true }, flood('tamper_detected'))).toBe('not-a-sensor-event');
    expect(await repo.listAlerts('2026-10-06T00:00:00.000Z')).toEqual([]);
  });
});

describe('reconciliation poll (R2)', () => {
  it('reads only sensors, raises from a status the webhook never delivered, and is silent on a repeat', async () => {
    await repo.putDevice({
      id: 'dev_bbbbbbbbbbbbbbbb',
      ringDeviceId: 'dev-doorbell-1',
      name: 'Front Door',
      kind: 'doorbell',
      online: true,
      lastSeenAt: null,
      sensorState: null
    });
    const asked: string[] = [];
    const status = async (id: string) => {
      asked.push(id);
      return { online: true, flood: true, freeze: false };
    };
    const run = () => pollSensors({ ...deps(), enabled: true, listDevices: () => repo.listDevices(), status, now: () => AT });
    expect(await run()).toEqual({ polled: 1, raised: 1, failed: 0, backedOff: false });
    expect(await run()).toEqual({ polled: 1, raised: 0, failed: 0, backedOff: false });
    expect(asked).toEqual(['dev-flood-1', 'dev-flood-1']);
  });

  it('stops the round on a 429 and says it backed off', async () => {
    await repo.putDevice({
      id: 'dev_cccccccccccccccc',
      ringDeviceId: 'dev-flood-2',
      name: 'Sink',
      kind: 'sensor',
      online: true,
      lastSeenAt: null,
      sensorState: null
    });
    let calls = 0;
    const status = async () => {
      calls += 1;
      throw new RingApiError(429, null, 'Reading a Ring device status failed with 429');
    };
    expect(await pollSensors({ ...deps(), enabled: true, listDevices: () => repo.listDevices(), status, now: () => AT })).toEqual({
      polled: 0,
      raised: 0,
      failed: 1,
      backedOff: true
    });
    expect(calls).toBe(1);
  });

  it('keeps polling past a device whose status fails for another reason', async () => {
    await repo.putDevice({
      id: 'dev_cccccccccccccccc',
      ringDeviceId: 'dev-flood-2',
      name: 'Sink',
      kind: 'sensor',
      online: true,
      lastSeenAt: null,
      sensorState: null
    });
    const status = async (id: string) => {
      if (id === 'dev-flood-2') throw new RingApiError(503, 'SERVER_BUSY', 'x');
      return { online: true, flood: false, freeze: false };
    };
    expect(await pollSensors({ ...deps(), enabled: true, listDevices: () => repo.listDevices(), status, now: () => AT })).toEqual({
      polled: 1,
      raised: 0,
      failed: 1,
      backedOff: false
    });
  });

  it('does nothing while switched off', async () => {
    expect(
      await pollSensors({
        ...deps(),
        enabled: false,
        listDevices: () => repo.listDevices(),
        status: async () => ({ online: true, flood: true, freeze: true }),
        now: () => AT
      })
    ).toBe('disabled');
  });
});

describe('live Ring flood replay (captured 2026-09-29, FL-063)', () => {
  const LIVE_FILES = [
    'live-flood-detected-1',
    'live-flood-cleared-1',
    'live-flood-detected-2',
    'live-flood-cleared-2',
    'live-flood-detected-3',
    'live-flood-cleared-3'
  ];
  const LIVE_RECEIVED_AT = '2026-09-29T16:00:00.000Z';
  const LIVE_DEVICE_NAME = 'Live Water Sensor';

  it('replays the six live flood webhooks through decodeWebhook and handleSensorEvent, and ends with one resolved alert', async () => {
    // Decode every live capture with the real envelope decoder first, in delivery order, so the
    // detail below is built from what production actually parsed — not from data invented for the test.
    const decoded = LIVE_FILES.map(file => {
      const result = decodeWebhook(fixture(file), LIVE_RECEIVED_AT);
      if (!result.ok) throw new Error(`fixture ${file} failed to decode: ${result.reason}`);
      return result.event;
    });
    const ringDeviceId = decoded[0]!.deviceId!;
    expect(decoded.every(e => e.deviceId === ringDeviceId)).toBe(true); // all six are the same redacted sensor

    await repo.putDevice({
      id: 'dev_liveflood2222222',
      ringDeviceId,
      name: LIVE_DEVICE_NAME,
      kind: 'sensor',
      online: true,
      lastSeenAt: null,
      sensorState: null
    });

    // handleSensorEvent takes a RingEventDetail, which is what the webhook Lambda publishes to the
    // bus (apps/events/src/handlers/webhook.ts, handleWebhook) — decodeWebhook's own RingWebhook plus
    // deviceName. Production does not export that mapping as its own function, so it is reproduced
    // here field for field rather than invented: requestId, accountId, eventId, type, subType,
    // deviceId and at pass straight through, and deviceName is the same lookup handleWebhook does.
    let last: Awaited<ReturnType<typeof handleSensorEvent>> | undefined;
    for (const event of decoded) {
      const detail: RingEventDetail = {
        requestId: event.requestId,
        accountId: event.accountId,
        eventId: event.eventId,
        type: event.type,
        subType: event.subType,
        deviceId: event.deviceId,
        deviceName: LIVE_DEVICE_NAME,
        at: event.at
      };
      last = await handleSensorEvent({ ...deps(), enabled: true }, detail);
    }

    const alerts = await repo.listAlerts('2026-09-29T00:00:00.000Z');
    expect(alerts).toHaveLength(1);
    const lastClearedAt = decoded[decoded.length - 1]!.at;
    expect(alerts[0]).toMatchObject({ status: 'resolved', resolvedAt: lastClearedAt, sensorType: 'flood', ringDeviceId });
    // Two raises within the 120 s FL-063 window re-open the same alert instead of pushing again.
    expect(bus.entries).toEqual([{ source: 'homeledger.events', detailType: 'alert.raised', detail: { cardType: 'alert.raised', id: alerts[0]!.id } }]);
    expect(last).toEqual({ raised: [], resolved: [alerts[0]!.id], reopened: [] });
  });
});
