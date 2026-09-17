import { afterEach, describe, expect, it } from 'vitest';
import { hasJson } from '../src/voice.js';
import { modernClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
});

describe('recent_events', () => {
  it('merges visits, door events, and alerts newest first within the window', async () => {
    const h = await modernClient();
    close = h.close;
    const applianceId = (await h.deps.repo.listAppliances({ category: 'water_heater' }))[0]!.id;
    await h.deps.repo.putVisit({
      id: 'visit_aaaaaaaaaaaaaaaa',
      providerId: 'p1',
      providerName: 'Reliable Plumbing',
      category: 'plumbing',
      applianceId,
      issue: 'leak',
      windowStart: '2026-09-13T11:00:00.000Z',
      windowEnd: '2026-09-13T15:00:00.000Z',
      status: 'scheduled',
      ringEventIds: [],
      snapshotKey: null,
      description: null,
      arrivedAt: null,
      createdAt: '2026-09-12T10:00:00.000Z'
    });
    // Scheduled well in the future relative to the harness's now
    // (2026-09-13T12:00:00.000Z): must not appear in "recent" events even
    // though its windowStart falls within the sinceHours lookback window.
    await h.deps.repo.putVisit({
      id: 'visit_cccccccccccccccc',
      providerId: 'p2',
      providerName: 'Future HVAC',
      category: 'hvac',
      applianceId,
      issue: 'inspection',
      windowStart: '2026-09-14T09:00:00.000Z',
      windowEnd: '2026-09-14T11:00:00.000Z',
      status: 'scheduled',
      ringEventIds: [],
      snapshotKey: null,
      description: null,
      arrivedAt: null,
      createdAt: '2026-09-12T10:00:00.000Z'
    });
    await h.deps.repo.putEvent({
      id: 'evt_aaaaaaaaaaaaaaaa',
      ringEventId: 'r1',
      type: 'button_press',
      subType: null,
      deviceId: 'd1',
      deviceName: 'Front Door',
      at: '2026-09-13T09:30:00.000Z',
      rawS3Key: null
    });
    // 11:30, deliberately NEWER than the 11:00 visit even though alerts are
    // the LAST of the three sources events.ts merges. The fixture's time
    // order therefore disagrees with the merge's source order, which is what
    // forces the descending .sort() in events.ts to do real work: with the
    // sort deleted the tool emits literal merge order (visit, door, alert)
    // and the expectation below goes red. An earlier fixture put this at
    // 03:00, where descending time and source order coincided and deleting
    // the sort left the whole suite green.
    await h.deps.repo.putAlert({
      id: 'alert_aaaaaaaaaaaaaaaa',
      sensorType: 'freeze',
      deviceName: 'Garage sensor',
      at: '2026-09-13T11:30:00.000Z',
      maintenanceRef: null,
      status: 'open'
    });
    await h.deps.repo.putEvent({
      id: 'evt_bbbbbbbbbbbbbbbb',
      ringEventId: 'r0',
      type: 'motion_detected',
      subType: 'human',
      deviceId: 'd1',
      deviceName: 'Front Door',
      at: '2026-09-11T09:30:00.000Z',
      rawS3Key: null
    });
    const r = await h.client.callTool({ name: 'recent_events', arguments: { sinceHours: 24 } });
    const sc = r.structuredContent as { events: Array<{ kind: string; at: string; summary: string; visitId: string | null }> };
    // Neither of these is the source order events.ts builds the array in
    // (visits, then doors, then alerts), so both fail if the sort is removed
    // or reversed. The `at` list is asserted alongside the kinds because it
    // is the actual ordering key; the kinds alone would still pass if two
    // rows of different kinds ever carried the same timestamp.
    expect(sc.events.map(e => e.kind)).toEqual(['alert', 'visit', 'door']);
    expect(sc.events.map(e => e.at)).toEqual(['2026-09-13T11:30:00.000Z', '2026-09-13T11:00:00.000Z', '2026-09-13T09:30:00.000Z']);
    expect(sc.events.find(e => e.kind === 'visit')?.visitId).toBe('visit_aaaaaaaaaaaaaaaa');
    expect(sc.events.some(e => e.visitId === 'visit_cccccccccccccccc')).toBe(false);
    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(hasJson(text)).toBe(false);
    expect(text).toContain('Reliable Plumbing');
  });
  it('speaks a quiet day', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'recent_events', arguments: {} });
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe('Nothing happened in the last 24 hours.');
  });
});
