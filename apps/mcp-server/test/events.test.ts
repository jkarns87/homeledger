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
      windowStart: '2026-09-13T13:00:00.000Z',
      windowEnd: '2026-09-13T15:00:00.000Z',
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
    await h.deps.repo.putAlert({
      id: 'alert_aaaaaaaaaaaaaaaa',
      sensorType: 'freeze',
      deviceName: 'Garage sensor',
      at: '2026-09-13T03:00:00.000Z',
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
    expect(sc.events.map(e => e.kind)).toEqual(['visit', 'door', 'alert']);
    expect(sc.events[0]?.visitId).toBe('visit_aaaaaaaaaaaaaaaa');
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
