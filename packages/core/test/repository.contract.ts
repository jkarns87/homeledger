import { beforeEach, describe, expect, it } from 'vitest';
import type { Repository } from '../src/repo/repository.js';
import type { Alert, Appliance, Connection, Device, Event, MaintenanceItem, Visit } from '../src/domain/schemas.js';

export const appliance = (over: Partial<Appliance> = {}): Appliance => ({
  id: 'appl_aaaaaaaaaaaaaaaa',
  name: 'Furnace',
  brand: 'Carrier',
  model: '59SC5A',
  serial: null,
  room: 'Basement',
  category: 'hvac',
  purchasedAt: '2019-10-01',
  warrantyUntil: '2029-10-01',
  manualDocId: null,
  templates: [{ taskType: 'filter_change', intervalDays: 90 }],
  ...over
});

export const maintenance = (over: Partial<MaintenanceItem> = {}): MaintenanceItem => ({
  applianceId: 'appl_aaaaaaaaaaaaaaaa',
  taskType: 'filter_change',
  intervalDays: 90,
  lastDoneAt: '2026-06-01',
  nextDueAt: '2026-08-30',
  notes: null,
  ...over
});

export const visit = (over: Partial<Visit> = {}): Visit => ({
  id: 'visit_aaaaaaaaaaaaaaaa',
  providerId: 'p_reliable',
  providerName: 'Reliable Plumbing',
  category: 'plumbing',
  applianceId: 'appl_aaaaaaaaaaaaaaaa',
  issue: 'Water heater leaking at the base',
  windowStart: '2026-09-22T13:00:00.000Z',
  windowEnd: '2026-09-22T15:00:00.000Z',
  status: 'scheduled',
  ringEventIds: [],
  snapshotKey: null,
  description: null,
  snapshotStatus: null,
  snapshotLatencyMs: null,
  arrivedAt: null,
  createdAt: '2026-09-13T10:00:00.000Z',
  ...over
});

export const event = (over: Partial<Event> = {}): Event => ({
  id: 'evt_aaaaaaaaaaaaaaaa',
  ringEventId: 'ring-evt-1',
  type: 'button_press',
  subType: null,
  deviceId: 'ava1.ring.device.1',
  deviceName: 'Front Door',
  at: '2026-09-22T13:20:00.000Z',
  rawS3Key: null,
  ...over
});

export const alert = (over: Partial<Alert> = {}): Alert => ({
  id: 'alert_aaaaaaaaaaaaaaaa',
  sensorType: 'freeze',
  severity: 'high',
  ringDeviceId: 'ava1.ring.device.9',
  message: null,
  deviceName: 'Garage sensor',
  at: '2026-09-22T03:00:00.000Z',
  maintenanceRef: null,
  status: 'open',
  ...over
});

export const device = (over: Partial<Device> = {}): Device => ({
  id: 'dev_aaaaaaaaaaaaaaaa',
  ringDeviceId: 'ava1.ring.device.1',
  name: 'Front Door',
  kind: 'doorbell',
  online: true,
  lastSeenAt: '2026-09-22T13:00:00.000Z',
  sensorState: null,
  ...over
});

export function runRepositoryContract(name: string, make: () => Promise<Repository>) {
  describe(`Repository contract: ${name}`, () => {
    let repo: Repository;
    beforeEach(async () => {
      repo = await make();
    });

    it('stores and lists appliances with filters', async () => {
      await repo.putAppliance(appliance());
      await repo.putAppliance(appliance({ id: 'appl_bbbbbbbbbbbbbbbb', name: 'Washer', room: 'Laundry', category: 'laundry' }));
      expect((await repo.listAppliances()).map(a => a.name).sort()).toEqual(['Furnace', 'Washer']);
      expect((await repo.listAppliances({ room: 'Laundry' })).map(a => a.name)).toEqual(['Washer']);
      expect((await repo.listAppliances({ category: 'hvac' })).map(a => a.name)).toEqual(['Furnace']);
      expect(await repo.getAppliance('appl_zzzzzzzzzzzzzzzz')).toBeNull();
    });

    it('lists maintenance due within a horizon, overdue first', async () => {
      await repo.putMaintenance(maintenance());
      await repo.putMaintenance(maintenance({ taskType: 'inspection', intervalDays: 365, lastDoneAt: '2025-10-01', nextDueAt: '2026-10-01' }));
      await repo.putMaintenance(
        maintenance({ applianceId: 'appl_bbbbbbbbbbbbbbbb', taskType: 'clean', intervalDays: 30, lastDoneAt: '2026-09-10', nextDueAt: '2026-12-10' })
      );
      const due = await repo.listMaintenanceDue(30, '2026-09-13');
      expect(due.map(m => m.taskType)).toEqual(['filter_change', 'inspection']);
    });

    it('deduplicates events by ring event id', async () => {
      expect(await repo.putEvent(event())).toBe('created');
      expect(await repo.putEvent(event({ id: 'evt_bbbbbbbbbbbbbbbb' }))).toBe('duplicate');
      expect((await repo.listEvents('2026-09-22T00:00:00.000Z')).length).toBe(1);
      expect((await repo.listEvents('2026-09-23T00:00:00.000Z')).length).toBe(0);
    });

    it('finds visits by window and since', async () => {
      await repo.putVisit(visit());
      await repo.putVisit(visit({ id: 'visit_bbbbbbbbbbbbbbbb', windowStart: '2026-09-25T13:00:00.000Z', windowEnd: '2026-09-25T15:00:00.000Z' }));
      const inWindow = await repo.listVisitsInWindow('2026-09-22T12:30:00.000Z', '2026-09-22T15:30:00.000Z');
      expect(inWindow.map(v => v.id)).toEqual(['visit_aaaaaaaaaaaaaaaa']);
      expect((await repo.listVisitsSince('2026-09-24T00:00:00.000Z')).map(v => v.id)).toEqual(['visit_bbbbbbbbbbbbbbbb']);
      const fetched = await repo.getVisit('visit_aaaaaaaaaaaaaaaa');
      expect(fetched?.providerName).toBe('Reliable Plumbing');
    });

    it('resetHousehold deletes the household, appliances, and maintenance items', async () => {
      await repo.putHousehold({ id: 'hh_test', name: 'Test household', timezone: 'America/Chicago' });
      await repo.putAppliance(appliance());
      await repo.putMaintenance(maintenance());
      await repo.resetHousehold();
      expect(await repo.getHousehold()).toBeNull();
      expect(await repo.listAppliances()).toEqual([]);
      expect(await repo.getMaintenance('appl_aaaaaaaaaaaaaaaa', 'filter_change')).toBeNull();
    });

    it('appends and lists logs newest first', async () => {
      await repo.appendLog({
        id: 'log_aaaaaaaaaaaaaaaa',
        applianceId: 'appl_aaaaaaaaaaaaaaaa',
        taskType: 'filter_change',
        doneAt: '2026-06-01',
        notes: null,
        createdAt: '2026-06-01T12:00:00.000Z'
      });
      await repo.appendLog({
        id: 'log_bbbbbbbbbbbbbbbb',
        applianceId: 'appl_aaaaaaaaaaaaaaaa',
        taskType: 'filter_change',
        doneAt: '2026-09-13',
        notes: 'MERV 11',
        createdAt: '2026-09-13T12:00:00.000Z'
      });
      const logs = await repo.listLogs('appl_aaaaaaaaaaaaaaaa', 10);
      expect(logs.map(l => l.doneAt)).toEqual(['2026-09-13', '2026-06-01']);
    });

    it('replaces a visit in place and reads the new state back', async () => {
      await repo.putVisit(visit());
      await repo.putVisit(
        visit({
          status: 'arrived',
          arrivedAt: '2026-09-22T13:20:00.000Z',
          snapshotKey: 'snapshots/hh_test/visit_a.jpg',
          description: 'A person in a blue jacket at the door.',
          ringEventIds: ['ring-evt-1']
        })
      );
      const after = await repo.getVisit('visit_aaaaaaaaaaaaaaaa');
      expect(after?.status).toBe('arrived');
      expect(after?.arrivedAt).toBe('2026-09-22T13:20:00.000Z');
      expect(after?.snapshotKey).toBe('snapshots/hh_test/visit_a.jpg');
      expect(after?.description).toBe('A person in a blue jacket at the door.');
      expect(after?.ringEventIds).toEqual(['ring-evt-1']);
      expect((await repo.listVisitsSince('2026-09-22T00:00:00.000Z')).length).toBe(1);
      expect(await repo.getVisit('visit_zzzzzzzzzzzzzzzz')).toBeNull();
    });

    it('stores alerts and lists them newest first within a window', async () => {
      await repo.putAlert(alert());
      await repo.putAlert(
        alert({
          id: 'alert_bbbbbbbbbbbbbbbb',
          sensorType: 'flood',
          deviceName: 'Basement sensor',
          at: '2026-09-22T09:00:00.000Z',
          maintenanceRef: { applianceId: 'appl_aaaaaaaaaaaaaaaa', taskType: 'test' }
        })
      );
      const recent = await repo.listAlerts('2026-09-22T00:00:00.000Z');
      expect(recent.map(a => a.id)).toEqual(['alert_bbbbbbbbbbbbbbbb', 'alert_aaaaaaaaaaaaaaaa']);
      expect(recent[0]?.maintenanceRef?.taskType).toBe('test');
      expect((await repo.listAlerts('2026-09-23T00:00:00.000Z')).length).toBe(0);
    });

    it('keys devices by ring device id and lists them by name', async () => {
      await repo.putDevice(device());
      await repo.putDevice(device({ id: 'dev_bbbbbbbbbbbbbbbb', ringDeviceId: 'ava1.ring.device.2', name: 'Back Door', kind: 'camera' }));
      await repo.putDevice(device({ id: 'dev_cccccccccccccccc', name: 'Front Door', online: false, lastSeenAt: null }));
      const devices = await repo.listDevices();
      expect(devices.map(d => d.name)).toEqual(['Back Door', 'Front Door']);
      expect(devices.find(d => d.name === 'Front Door')?.online).toBe(false);
      expect(devices.find(d => d.name === 'Front Door')?.lastSeenAt).toBeNull();
      expect(devices.find(d => d.name === 'Front Door')?.id).toBe('dev_cccccccccccccccc');
    });

    it('replaces an alert by id and reads the new state back', async () => {
      await repo.putAlert(alert());
      await repo.putAlert(alert({ status: 'acknowledged' }));
      const alerts = await repo.listAlerts('2026-09-22T00:00:00.000Z');
      expect(alerts.length).toBe(1);
      expect(alerts[0]?.status).toBe('acknowledged');
      expect(alerts[0]?.id).toBe('alert_aaaaaaaaaaaaaaaa');
      expect(alerts[0]?.at).toBe('2026-09-22T03:00:00.000Z');
    });

    it('claims a webhook event once, lets an unpublished one through again, and drops a published one', async () => {
      const e = event({ ringEventId: 'req-bp-0001' });
      expect(await repo.claimEvent(e)).toBe('new');
      // Checked before the retry call, whose own write would otherwise mask a
      // 'new' claim that recorded the marker but not the event row.
      expect((await repo.listEvents('2026-09-22T00:00:00.000Z')).map(x => x.id)).toEqual([e.id]);
      expect(await repo.claimEvent(e)).toBe('retry');
      expect((await repo.listEvents('2026-09-22T00:00:00.000Z')).map(x => x.id)).toEqual([e.id]);
      await repo.markEventPublished('req-bp-0001');
      expect(await repo.claimEvent(e)).toBe('published');
      expect(await repo.claimEvent(event({ id: 'evt_bbbbbbbbbbbbbbbb', ringEventId: 'req-bp-0002' }))).toBe('new');
    });

    it('marks a scheduled visit arrived exactly once, and never a visit that is not scheduled', async () => {
      await repo.putVisit(visit());
      expect(await repo.markVisitArrived('visit_aaaaaaaaaaaaaaaa', '2026-09-22T13:20:00.000Z', 'req-bp-0001')).toBe('arrived');
      expect(await repo.markVisitArrived('visit_aaaaaaaaaaaaaaaa', '2026-09-22T13:20:05.000Z', 'req-mo-0001')).toBe('not-scheduled');
      const after = await repo.getVisit('visit_aaaaaaaaaaaaaaaa');
      expect(after?.status).toBe('arrived');
      expect(after?.arrivedAt).toBe('2026-09-22T13:20:00.000Z');
      expect(after?.ringEventIds).toEqual(['req-bp-0001']);
      // Still findable by window: the arrival must not knock it out of the visit index.
      expect((await repo.listVisitsInWindow('2026-09-22T12:30:00.000Z', '2026-09-22T15:30:00.000Z')).map(v => v.status)).toEqual(['arrived']);
      expect(await repo.markVisitArrived('visit_zzzzzzzzzzzzzzzz', '2026-09-22T13:20:00.000Z', 'req-bp-0003')).toBe('not-scheduled');
      await repo.putVisit(visit({ id: 'visit_bbbbbbbbbbbbbbbb', status: 'completed' }));
      expect(await repo.markVisitArrived('visit_bbbbbbbbbbbbbbbb', '2026-09-22T13:20:00.000Z', 'req-bp-0004')).toBe('not-scheduled');
    });

    it('records a snapshot outcome on a visit, and refuses a visit that does not exist', async () => {
      await repo.putVisit(visit({ status: 'arrived', arrivedAt: '2026-09-22T13:20:00.000Z' }));
      await repo.recordVisitSnapshot('visit_aaaaaaaaaaaaaaaa', {
        snapshotKey: 'snapshots/hh_test/visit_aaaaaaaaaaaaaaaa.jpg',
        snapshotStatus: 'ok',
        description: 'A person holding a toolbox stands at the front door.',
        snapshotLatencyMs: 4200
      });
      const after = await repo.getVisit('visit_aaaaaaaaaaaaaaaa');
      expect(after?.snapshotKey).toBe('snapshots/hh_test/visit_aaaaaaaaaaaaaaaa.jpg');
      expect(after?.snapshotStatus).toBe('ok');
      expect(after?.description).toBe('A person holding a toolbox stands at the front door.');
      expect(after?.snapshotLatencyMs).toBe(4200);
      expect(after?.status).toBe('arrived');
      await expect(
        repo.recordVisitSnapshot('visit_zzzzzzzzzzzzzzzz', { snapshotKey: null, snapshotStatus: 'error', description: null, snapshotLatencyMs: 10 })
      ).rejects.toThrow('No visit visit_zzzzzzzzzzzzzzzz');
    });

    it('reads one device by its Ring id', async () => {
      await repo.putDevice(device({ ringDeviceId: 'dev-flood-1', name: 'Water Heater', kind: 'sensor', sensorState: { flood: false, freeze: false } }));
      expect((await repo.getDevice('dev-flood-1'))?.sensorState).toEqual({ flood: false, freeze: false });
      expect(await repo.getDevice('dev-missing')).toBeNull();
    });

    it('finds the newest open alert for one device and sensor type, and nothing else', async () => {
      await repo.putAlert(alert({ id: 'alert_aaaaaaaaaaaaaaaa', sensorType: 'flood', ringDeviceId: 'dev-flood-1', at: '2026-10-06T21:15:00.000Z' }));
      await repo.putAlert(alert({ id: 'alert_bbbbbbbbbbbbbbbb', sensorType: 'flood', ringDeviceId: 'dev-flood-1', at: '2026-10-06T22:00:00.000Z' }));
      await repo.putAlert(
        alert({ id: 'alert_cccccccccccccccc', sensorType: 'flood', ringDeviceId: 'dev-flood-1', at: '2026-10-06T23:00:00.000Z', status: 'resolved' })
      );
      await repo.putAlert(alert({ id: 'alert_dddddddddddddddd', sensorType: 'freeze', ringDeviceId: 'dev-flood-1', at: '2026-10-07T00:00:00.000Z' }));
      await repo.putAlert(alert({ id: 'alert_eeeeeeeeeeeeeeee', sensorType: 'flood', ringDeviceId: 'dev-flood-2', at: '2026-10-07T01:00:00.000Z' }));
      expect((await repo.findOpenAlert('dev-flood-1', 'flood'))?.id).toBe('alert_bbbbbbbbbbbbbbbb');
      expect(await repo.findOpenAlert('dev-flood-3', 'flood')).toBeNull();
      // The newest of any status, and the clearing time survives the round trip.
      await repo.putAlert(
        alert({ id: 'alert_cccccccccccccccc', sensorType: 'flood', ringDeviceId: 'dev-flood-1', at: '2026-10-06T23:00:00.000Z', status: 'resolved', resolvedAt: '2026-10-06T23:00:05.000Z' })
      );
      expect(await repo.findLatestAlert('dev-flood-1', 'flood')).toMatchObject({ id: 'alert_cccccccccccccccc', resolvedAt: '2026-10-06T23:00:05.000Z' });
      expect(await repo.findLatestAlert('dev-flood-3', 'flood')).toBeNull();
    });

    it('keeps live display connections, hides expired ones, and forgets a closed one', async () => {
      const live: Connection = { connectionId: 'Ab1=', connectedAt: '2026-10-06T13:00:00.000Z', expiresAt: 2_000 };
      await repo.putConnection(live);
      await repo.putConnection({ connectionId: 'Cd2=', connectedAt: '2026-10-06T11:00:00.000Z', expiresAt: 1_000 });
      // Exactly the stored shape: no TTL attribute or key leaking back out.
      expect(await repo.listConnections(1_500)).toEqual([live]);
      await repo.deleteConnection('Ab1=');
      expect(await repo.listConnections(1_500)).toEqual([]);
    });

    it('resetHousehold also forgets connections and event markers', async () => {
      await repo.putConnection({ connectionId: 'Ab1=', connectedAt: '2026-10-06T13:00:00.000Z', expiresAt: 2_000 });
      await repo.claimEvent(event({ ringEventId: 'req-bp-0001' }));
      await repo.resetHousehold();
      expect(await repo.listConnections(0)).toEqual([]);
      expect(await repo.claimEvent(event({ ringEventId: 'req-bp-0001' }))).toBe('new');
    });
  });
}
