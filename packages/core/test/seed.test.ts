import { describe, expect, it } from 'vitest';
import { createMemoryRepository } from '../src/repo/memory.js';
import { SEED_APPLIANCES, seedRepository } from '../src/seed/household.js';

describe('seed', () => {
  it('writes the household, every appliance, and one maintenance item per template', async () => {
    const repo = createMemoryRepository('hh_harlow');
    const { applianceIds } = await seedRepository(repo, 'hh_harlow', '2026-09-13');
    expect(applianceIds.length).toBe(SEED_APPLIANCES.length);
    expect((await repo.getHousehold())?.name).toBe('The Harlow household');
    const due = await repo.listMaintenanceDue(3650, '2026-09-13');
    const templateCount = SEED_APPLIANCES.reduce((n, a) => n + a.templates.length, 0);
    expect(due.length).toBe(templateCount);
  });

  it('uses fixed appliance ids that are stable across calls', async () => {
    const first = await seedRepository(createMemoryRepository('hh_harlow'), 'hh_harlow', '2026-09-13');
    const second = await seedRepository(createMemoryRepository('hh_harlow'), 'hh_harlow', '2026-09-13');
    expect(second.applianceIds).toEqual(first.applianceIds);
    expect(new Set(first.applianceIds).size).toBe(SEED_APPLIANCES.length);
  });

  it('seeding the same repository twice overwrites rather than accumulates', async () => {
    const repo = createMemoryRepository('hh_harlow');
    await seedRepository(repo, 'hh_harlow', '2026-09-13');
    await seedRepository(repo, 'hh_harlow', '2026-09-13');
    expect(await repo.listAppliances()).toHaveLength(SEED_APPLIANCES.length);
    const due = await repo.listMaintenanceDue(3650, '2026-09-13');
    const templateCount = SEED_APPLIANCES.reduce((n, a) => n + a.templates.length, 0);
    expect(due).toHaveLength(templateCount);
  });
});
