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
});
