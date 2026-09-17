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

  // Spec 4.2's `manual {docId, title}`. Asserted in both directions because
  // the convention being followed is nullable-but-always-present (get_visit's
  // snapshotUrl/description): the no-manual case has to prove the KEY is
  // there carrying null, which `toBeNull()` alone would also report for a
  // key that was simply never emitted - hence the explicit `in` check.
  it('returns manual: null, with the key present, for an appliance with no manual on file', async () => {
    const h = await modernClient();
    close = h.close;
    const list = await h.client.callTool({ name: 'list_appliances', arguments: { category: 'laundry' } });
    const id = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    const r = await h.client.callTool({ name: 'get_appliance', arguments: { applianceId: id } });
    const sc = r.structuredContent as { manual: { docId: string; title: string } | null };
    expect('manual' in sc).toBe(true);
    expect(sc.manual).toBeNull();
  });

  it('resolves manualDocId through the DOC# row scripts/manuals.ts writes', async () => {
    const h = await modernClient();
    close = h.close;
    const list = await h.client.callTool({ name: 'list_appliances', arguments: { category: 'laundry' } });
    const id = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    const appliance = (await h.deps.repo.getAppliance(id))!;
    await h.deps.repo.putDoc({
      id: 'doc_aaaaaaaaaaaaaaaa',
      applianceId: id,
      title: 'Whirlpool WFW5620HW use and care guide',
      s3Key: 'manuals/hh_test/doc_aaaaaaaaaaaaaaaa.pdf',
      pages: 64,
      kbSync: { status: 'synced', at: '2026-09-13T10:00:00.000Z' }
    });
    await h.deps.repo.putAppliance({ ...appliance, manualDocId: 'doc_aaaaaaaaaaaaaaaa' });
    const r = await h.client.callTool({ name: 'get_appliance', arguments: { applianceId: id } });
    const sc = r.structuredContent as { manual: { docId: string; title: string } | null };
    // Exactly the two spec fields, no s3Key/kbSync leakage into the tool surface.
    expect(sc.manual).toEqual({ docId: 'doc_aaaaaaaaaaaaaaaa', title: 'Whirlpool WFW5620HW use and care guide' });
  });

  it('returns manual: null when manualDocId points at a DOC# row that is gone', async () => {
    const h = await modernClient();
    close = h.close;
    const list = await h.client.callTool({ name: 'list_appliances', arguments: { category: 'laundry' } });
    const id = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    const appliance = (await h.deps.repo.getAppliance(id))!;
    await h.deps.repo.putAppliance({ ...appliance, manualDocId: 'doc_bbbbbbbbbbbbbbbb' });
    const r = await h.client.callTool({ name: 'get_appliance', arguments: { applianceId: id } });
    const sc = r.structuredContent as { manual: { docId: string; title: string } | null };
    expect(r.isError).toBeFalsy();
    expect(sc.manual).toBeNull();
  });
});
