import { afterEach, describe, expect, it } from 'vitest';
import { hasJson } from '../src/voice.js';
import { modernClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
});

describe('tools/list', () => {
  it('lists tools in the fixed order with output schemas', async () => {
    const h = await modernClient();
    close = h.close;
    const { tools } = await h.client.listTools();
    expect(tools.map(t => t.name)).toEqual([
      'list_appliances',
      'get_appliance',
      'maintenance_due',
      'log_maintenance',
      'recent_events',
      'ask_manual',
      'book_service',
      'get_visit',
      'echo_confirm'
    ]);
    for (const t of tools) expect(t.outputSchema).toBeDefined();
  });
});

describe('list_appliances', () => {
  it('speaks at most five names and returns the full list structured', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'list_appliances', arguments: {} });
    const text = (r.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    expect(hasJson(text)).toBe(false);
    expect(text.startsWith('6 appliances:')).toBe(true);
    expect(text).toContain('and 1 more');
    const sc = r.structuredContent as { appliances: Array<{ id: string; name: string; warrantyStatus: string }> };
    expect(sc.appliances.length).toBe(6);
    expect(sc.appliances.every(a => /^appl_/.test(a.id))).toBe(true);
    expect(sc.appliances.find(a => a.name === 'Furnace')?.warrantyStatus).toBe('active');
    expect(sc.appliances.find(a => a.name === 'Washer')?.warrantyStatus).toBe('expired');
  });
  it('filters by room', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'list_appliances', arguments: { room: 'Kitchen' } });
    const sc = r.structuredContent as { appliances: Array<{ name: string }> };
    expect(sc.appliances.map(a => a.name).sort()).toEqual(['Dishwasher', 'Refrigerator']);
  });
});

describe('get_appliance', () => {
  it('returns maintenance state for a known appliance', async () => {
    const h = await modernClient();
    close = h.close;
    const list = await h.client.callTool({ name: 'list_appliances', arguments: { category: 'hvac' } });
    const id = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    const r = await h.client.callTool({ name: 'get_appliance', arguments: { applianceId: id } });
    const sc = r.structuredContent as { appliance: { name: string }; maintenance: Array<{ taskType: string; nextDueAt: string; overdue: boolean }> };
    expect(sc.appliance.name).toBe('Furnace');
    const filter = sc.maintenance.find(m => m.taskType === 'filter_change');
    expect(filter?.nextDueAt).toBe('2026-08-30');
    expect(filter?.overdue).toBe(true);
    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(text).toContain('Furnace');
    expect(hasJson(text)).toBe(false);
  });
  it('answers an unknown id with a friendly error', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'get_appliance', arguments: { applianceId: 'appl_zzzzzzzzzzzzzzzz' } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("I couldn't find that appliance.");
  });
});
