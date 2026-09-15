import { beforeEach, describe, expect, it } from 'vitest';
import type { Repository } from '../src/repo/repository.js';
import type { Appliance, Event, MaintenanceItem, Visit } from '../src/domain/schemas.js';

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
  });
}
