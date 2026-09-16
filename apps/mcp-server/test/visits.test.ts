import { afterEach, describe, expect, it } from 'vitest';
import { hasJson } from '../src/voice.js';
import { modernClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
});

describe('get_visit', () => {
  it('returns the visit with empty snapshot and description fields', async () => {
    const h = await modernClient();
    close = h.close;
    const appliance = (await h.deps.repo.listAppliances({ category: 'water_heater' }))[0]!;
    await h.deps.repo.putVisit({
      id: 'visit_aaaaaaaaaaaaaaaa',
      providerId: 'prov_kettle_water',
      providerName: 'Kettle Creek Water Heaters',
      category: 'water_heater',
      applianceId: appliance.id,
      issue: 'water heater leaking at the base',
      windowStart: '2026-09-15T13:00:00.000Z',
      windowEnd: '2026-09-15T15:00:00.000Z',
      status: 'scheduled',
      ringEventIds: [],
      snapshotKey: null,
      description: null,
      arrivedAt: null,
      createdAt: '2026-09-13T12:00:00.000Z'
    });
    const r = await h.client.callTool({ name: 'get_visit', arguments: { visitId: 'visit_aaaaaaaaaaaaaaaa' } });
    const sc = r.structuredContent as {
      visit: { providerName: string; applianceName: string; status: string; arrivedAt: string | null };
      snapshotUrl: string | null;
      description: string | null;
    };
    expect(sc.visit.providerName).toBe('Kettle Creek Water Heaters');
    expect(sc.visit.applianceName).toBe('Water heater');
    expect(sc.visit.status).toBe('scheduled');
    expect(sc.visit.arrivedAt).toBeNull();
    expect(sc.snapshotUrl).toBeNull();
    expect(sc.description).toBeNull();
    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(hasJson(text)).toBe(false);
    expect(text).toBe('Kettle Creek Water Heaters is scheduled for the water heater on Tuesday, September 15, 1 to 3 PM.');
  });

  it('speaks an arrived visit differently', async () => {
    const h = await modernClient();
    close = h.close;
    const appliance = (await h.deps.repo.listAppliances({ category: 'water_heater' }))[0]!;
    await h.deps.repo.putVisit({
      id: 'visit_bbbbbbbbbbbbbbbb',
      providerId: 'prov_kettle_water',
      providerName: 'Kettle Creek Water Heaters',
      category: 'water_heater',
      applianceId: appliance.id,
      issue: 'water heater leaking at the base',
      windowStart: '2026-09-15T13:00:00.000Z',
      windowEnd: '2026-09-15T15:00:00.000Z',
      status: 'arrived',
      ringEventIds: ['ring-evt-1'],
      snapshotKey: 'snapshots/hh_test/visit_b.jpg',
      description: null,
      arrivedAt: '2026-09-15T13:07:00.000Z',
      createdAt: '2026-09-13T12:00:00.000Z'
    });
    const r = await h.client.callTool({ name: 'get_visit', arguments: { visitId: 'visit_bbbbbbbbbbbbbbbb' } });
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe('Kettle Creek Water Heaters arrived for the water heater on Tuesday, September 15.');
    expect((r.structuredContent as { snapshotUrl: string | null }).snapshotUrl).toBeNull();
  });

  it('answers an unknown visit id with a friendly error', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'get_visit', arguments: { visitId: 'visit_zzzzzzzzzzzzzzzz' } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("I couldn't find that visit.");
  });
});
