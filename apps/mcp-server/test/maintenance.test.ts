import { afterEach, describe, expect, it } from 'vitest';
import { hasJson } from '../src/voice.js';
import { modernClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
});

async function furnaceId(client: Awaited<ReturnType<typeof modernClient>>['client']) {
  const list = await client.callTool({ name: 'list_appliances', arguments: { category: 'hvac' } });
  return (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
}

describe('maintenance_due', () => {
  it('returns overdue and upcoming items within the horizon, overdue first', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'maintenance_due', arguments: { horizonDays: 30 } });
    const sc = r.structuredContent as { items: Array<{ applianceName: string; taskType: string; nextDueAt: string; overdue: boolean }> };
    // Seeded order by nextDueAt: water heater inspection 2026-08-28, furnace filter 2026-08-30, water heater flush 2026-09-01, ...
    expect(sc.items[0]).toMatchObject({ applianceName: 'Water heater', taskType: 'inspection', nextDueAt: '2026-08-28', overdue: true });
    expect(sc.items[1]).toMatchObject({ applianceName: 'Furnace', taskType: 'filter_change', nextDueAt: '2026-08-30', overdue: true });
    expect(sc.items.some(i => i.applianceName === 'Water heater' && i.taskType === 'flush')).toBe(true);
    expect(sc.items.some(i => i.applianceName === 'Furnace' && i.taskType === 'inspection')).toBe(false); // 2026-10-15 is outside 30 days
    expect(sc.items.every(i => i.nextDueAt <= '2026-10-13')).toBe(true);
    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(hasJson(text)).toBe(false);
    expect(text).toContain('Furnace filter change');
  });
  it('defaults the horizon to 30 days', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'maintenance_due', arguments: {} });
    const sc = r.structuredContent as { items: Array<{ nextDueAt: string }> };
    expect(sc.items.every(i => i.nextDueAt <= '2026-10-13')).toBe(true);
  });
});

describe('log_maintenance', () => {
  it('records the task and advances the next due date', async () => {
    const h = await modernClient();
    close = h.close;
    const id = await furnaceId(h.client);
    const r = await h.client.callTool({
      name: 'log_maintenance',
      arguments: { applianceId: id, taskType: 'filter_change', date: '2026-09-13', notes: 'MERV 11' }
    });
    expect(r.structuredContent).toEqual({ logged: true, nextDueAt: '2026-12-12' });
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe('Logged the furnace filter change for September 13. Next one is due December 12.');
    const after = await h.client.callTool({ name: 'get_appliance', arguments: { applianceId: id } });
    const m = (after.structuredContent as { maintenance: Array<{ taskType: string; nextDueAt: string; lastDoneAt: string | null }> }).maintenance.find(
      x => x.taskType === 'filter_change'
    );
    expect(m).toMatchObject({ lastDoneAt: '2026-09-13', nextDueAt: '2026-12-12' });
    const logs = await h.deps.repo.listLogs(id, 5);
    expect(logs[0]?.notes).toBe('MERV 11');
  });
  it('rejects a task type the appliance does not have', async () => {
    const h = await modernClient();
    close = h.close;
    const id = await furnaceId(h.client);
    const r = await h.client.callTool({ name: 'log_maintenance', arguments: { applianceId: id, taskType: 'flush' } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("The furnace doesn't have a flush task.");
  });
});
