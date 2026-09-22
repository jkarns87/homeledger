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
      visit: {
        providerName: string;
        applianceName: string;
        status: string;
        windowStart: string;
        windowLabel: string;
        arrivedAt: string | null;
        arrivedAtLabel: string | null;
      };
      snapshotUrl: string | null;
      description: string | null;
    };
    expect(sc.visit.providerName).toBe('Kettle Creek Water Heaters');
    expect(sc.visit.applianceName).toBe('Water heater');
    expect(sc.visit.status).toBe('scheduled');
    expect(sc.visit.arrivedAt).toBeNull();
    expect(sc.visit.arrivedAtLabel).toBeNull();
    expect(sc.snapshotUrl).toBeNull();
    expect(sc.description).toBeNull();
    // The stored instant is untouched; the label beside it is the same moment
    // in America/Chicago. 13:00Z would read "1:00 PM" in UTC, so these two
    // lines together are what say the household's zone was applied.
    expect(sc.visit.windowStart).toBe('2026-09-15T13:00:00.000Z');
    expect(sc.visit.windowLabel).toBe('Tuesday, September 15, 8:00 AM to 10:00 AM CDT');
    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(hasJson(text)).toBe(false);
    expect(text).toBe('Kettle Creek Water Heaters is scheduled for the water heater on Tuesday, September 15, 8:00 AM to 10:00 AM CDT.');
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
    const sc = r.structuredContent as { visit: { arrivedAt: string | null; arrivedAtLabel: string | null }; snapshotUrl: string | null };
    expect(sc.snapshotUrl).toBeNull();
    // 13:07Z is 8:07 AM Central. The widget shows this line verbatim, so the
    // raw instant it replaced is also asserted to still be stored as UTC.
    expect(sc.visit.arrivedAt).toBe('2026-09-15T13:07:00.000Z');
    expect(sc.visit.arrivedAtLabel).toBe('Tuesday, September 15, 8:07 AM CDT');
  });

  it('crosses midnight in the household zone without losing the second day', async () => {
    const h = await modernClient();
    close = h.close;
    const appliance = (await h.deps.repo.listAppliances({ category: 'water_heater' }))[0]!;
    // 2026-09-17T04:00Z to 06:00Z is 11 PM Wednesday to 1 AM Thursday in
    // Chicago. Rendered on the start day alone it would read "Wednesday,
    // September 16, 11:00 PM to 1:00 AM CDT", which a person reads as a
    // two-hour window ending 22 hours before it does.
    await h.deps.repo.putVisit({
      id: 'visit_dddddddddddddddd',
      providerId: 'prov_kettle_water',
      providerName: 'Kettle Creek Water Heaters',
      category: 'water_heater',
      applianceId: appliance.id,
      issue: 'no hot water',
      windowStart: '2026-09-17T04:00:00.000Z',
      windowEnd: '2026-09-17T06:00:00.000Z',
      status: 'scheduled',
      ringEventIds: [],
      snapshotKey: null,
      description: null,
      arrivedAt: null,
      createdAt: '2026-09-13T12:00:00.000Z'
    });
    const r = await h.client.callTool({ name: 'get_visit', arguments: { visitId: 'visit_dddddddddddddddd' } });
    expect((r.structuredContent as { visit: { windowLabel: string } }).visit.windowLabel).toBe(
      'Wednesday, September 16, 11:00 PM to Thursday, September 17, 1:00 AM CDT'
    );
  });

  it('answers an unknown visit id with a friendly error', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'get_visit', arguments: { visitId: 'visit_zzzzzzzzzzzzzzzz' } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("I couldn't find that visit.");
  });
});
