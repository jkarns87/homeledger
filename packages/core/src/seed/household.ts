import type { Appliance, TaskTypeValue } from '../domain/schemas.js';
import { computeNextDue } from '../domain/maintenance.js';
import type { Repository } from '../repo/repository.js';

type SeedAppliance = Omit<Appliance, 'manualDocId'> & { lastDone: Partial<Record<TaskTypeValue, string>> };

// Fixed ids (not `newId('appl')`) so re-running the seed is idempotent: the
// same appliance always gets the same id, so `putAppliance`/`putMaintenance`
// overwrite the same items instead of accumulating new ones on every run.
// Each id is a mnemonic slug padded to the 16-char [a-z2-7] body
// `ApplianceSchema` requires (see packages/core/src/domain/schemas.ts).
export const SEED_APPLIANCES: SeedAppliance[] = [
  {
    id: 'appl_furnace222222222',
    name: 'Furnace',
    brand: 'Carrier',
    model: '59SC5A060E17',
    serial: null,
    room: 'Basement',
    category: 'hvac',
    purchasedAt: '2019-10-01',
    warrantyUntil: '2029-10-01',
    templates: [
      { taskType: 'filter_change', intervalDays: 90 },
      { taskType: 'inspection', intervalDays: 365 }
    ],
    lastDone: { filter_change: '2026-06-01', inspection: '2025-10-15' }
  },
  {
    id: 'appl_waterheater22222',
    name: 'Water heater',
    brand: 'Rheem',
    model: 'XG50T12HE40U0',
    serial: null,
    room: 'Basement',
    category: 'water_heater',
    purchasedAt: '2021-03-12',
    warrantyUntil: '2033-03-12',
    templates: [
      { taskType: 'flush', intervalDays: 365 },
      { taskType: 'inspection', intervalDays: 180 }
    ],
    lastDone: { flush: '2025-09-01', inspection: '2026-03-01' }
  },
  {
    id: 'appl_washer2222222222',
    name: 'Washer',
    brand: 'LG',
    model: 'WM4000HWA',
    serial: null,
    room: 'Laundry',
    category: 'laundry',
    purchasedAt: '2022-05-20',
    warrantyUntil: '2023-05-20',
    templates: [{ taskType: 'clean', intervalDays: 30 }],
    lastDone: { clean: '2026-08-20' }
  },
  {
    id: 'appl_dishwasher222222',
    name: 'Dishwasher',
    brand: 'Bosch',
    model: 'SHPM88Z75N',
    serial: null,
    room: 'Kitchen',
    category: 'kitchen',
    purchasedAt: '2020-11-02',
    warrantyUntil: '2021-11-02',
    templates: [{ taskType: 'clean', intervalDays: 30 }],
    lastDone: { clean: '2026-09-01' }
  },
  {
    id: 'appl_refrigerator2222',
    name: 'Refrigerator',
    brand: 'Samsung',
    model: 'RF28R7351SG',
    serial: null,
    room: 'Kitchen',
    category: 'kitchen',
    purchasedAt: '2020-11-02',
    warrantyUntil: '2021-11-02',
    templates: [{ taskType: 'replace_part', intervalDays: 180 }],
    lastDone: { replace_part: '2026-04-10' }
  },
  {
    id: 'appl_sumppump22222222',
    name: 'Sump pump',
    brand: 'Zoeller',
    model: 'M53',
    serial: null,
    room: 'Basement',
    category: 'plumbing',
    purchasedAt: '2018-04-01',
    warrantyUntil: '2021-04-01',
    templates: [{ taskType: 'test', intervalDays: 90 }],
    lastDone: { test: '2026-07-01' }
  }
];

export const SEED_APPLIANCE_COUNT = SEED_APPLIANCES.length;

export async function seedRepository(repo: Repository, householdId: string, today: string): Promise<{ applianceIds: string[] }> {
  await repo.putHousehold({ id: householdId, name: 'The Harlow household', timezone: 'America/Chicago' });
  const applianceIds: string[] = [];
  for (const seed of SEED_APPLIANCES) {
    const { lastDone, ...rest } = seed;
    await repo.putAppliance({ ...rest, manualDocId: null });
    for (const t of seed.templates) {
      const last = lastDone[t.taskType] ?? today;
      await repo.putMaintenance({
        applianceId: seed.id,
        taskType: t.taskType,
        intervalDays: t.intervalDays,
        lastDoneAt: last,
        nextDueAt: computeNextDue(last, t.intervalDays),
        notes: null
      });
    }
    applianceIds.push(seed.id);
  }
  return { applianceIds };
}
