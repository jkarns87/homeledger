import { describe, expect, it } from 'vitest';
import { decodeWebhook } from '../src/ring/envelope.js';
import { fixture } from './fakes.js';

const RECEIVED = '2026-10-06T13:20:02.000Z';

describe('decodeWebhook over Ring’s documented payloads (amendment §12.3)', () => {
  it('decodes a button press', () => {
    expect(decodeWebhook(fixture('button-press'), RECEIVED)).toEqual({
      ok: true,
      event: {
        requestId: 'req-bp-0001',
        accountId: 'acct-123',
        eventId: 'evt-bp-0001',
        type: 'button_press',
        subType: null,
        deviceId: 'dev-doorbell-1',
        at: '2026-10-06T13:20:00.000Z'
      }
    });
  });

  it('reads the motion classification from data.subType', () => {
    const r = decodeWebhook(fixture('motion-human'), RECEIVED);
    expect(r.ok && r.event.subType).toBe('human');
    expect(r.ok && r.event.at).toBe('2026-10-06T13:20:05.000Z');
  });

  it('decodes a sensor event with the device from attributes.source', () => {
    const r = decodeWebhook(fixture('flood-detected'), RECEIVED);
    expect(r.ok && [r.event.type, r.event.deviceId, r.event.at]).toEqual(['flood_detected', 'dev-flood-1', '2026-10-06T21:15:00.000Z']);
  });

  it('gives no device for an event whose source is the account', () => {
    const r = decodeWebhook(fixture('app-integration-added'), RECEIVED);
    expect(r.ok && [r.event.type, r.event.deviceId]).toEqual(['app_integration_added', null]);
  });
});

describe('decodeWebhook is total: odd input is data, never a crash (spec §4 step 2)', () => {
  const base = fixture<{ meta: Record<string, unknown>; data: Record<string, unknown> }>('button-press');

  it('keeps an unknown event type as it came', () => {
    const r = decodeWebhook({ ...base, data: { ...base.data, type: 'tamper_detected' } }, RECEIVED);
    expect(r.ok && r.event.type).toBe('tamper_detected');
  });

  it('records a missing type as unknown', () => {
    const { type: _t, ...data } = base.data;
    const r = decodeWebhook({ ...base, data }, RECEIVED);
    expect(r.ok && r.event.type).toBe('unknown');
  });

  it('falls back to meta.time, then to the receive time, when the event carries no timestamp', () => {
    const noStamp = { ...base, data: { ...base.data, attributes: { source: 'dev-doorbell-1', source_type: 'devices' } } };
    expect((decodeWebhook(noStamp, RECEIVED) as { event: { at: string } }).event.at).toBe('2026-10-06T13:20:01.000Z');
    const noTimes = { ...noStamp, meta: { request_id: 'req-bp-0001' } };
    expect((decodeWebhook(noTimes, RECEIVED) as { event: { at: string } }).event.at).toBe(RECEIVED);
  });

  it('also reads the older field names the research recorded, should the Playground or staging send them', () => {
    const legacy = {
      meta: { request_id: 'req-legacy-1', time: '2026-10-06T13:20:01Z' },
      data: {
        type: 'event',
        id: 'req-legacy-1',
        attributes: { event_type: 'motion_detected', sub_type: 'human', device_id: 'dev-doorbell-1', timestamp: '2026-10-06T13:20:00Z', component_ids: [] }
      }
    };
    const r = decodeWebhook(legacy, RECEIVED);
    expect(r.ok && [r.event.type, r.event.subType, r.event.deviceId, r.event.at]).toEqual([
      'motion_detected',
      'human',
      'dev-doorbell-1',
      '2026-10-06T13:20:00.000Z'
    ]);
  });

  it('refuses a body with no request id — dedupe is impossible without it', () => {
    expect(decodeWebhook({ ...base, meta: { account_id: 'acct-123' } }, RECEIVED)).toEqual({ ok: false, reason: 'no meta.request_id' });
  });

  it('refuses a body that is not a JSON object', () => {
    for (const body of [null, [], 'button_press', 42]) expect(decodeWebhook(body, RECEIVED).ok).toBe(false);
  });
});

describe('decodeWebhook over live Ring payloads (captured 2026-09-29)', () => {
  const RECEIVED_LIVE = '2026-09-29T16:00:00.000Z';

  type LiveBody = { meta: { request_id: string }; data: { id: string; attributes: { source: string; source_type: string; timestamp: number } } };

  // Every live capture except the app-integration one is sourced from a device; that one's source is the account.
  const liveCases: Array<{ file: string; type: string; accountIsSource: boolean }> = [
    { file: 'live-app-integration-added-1', type: 'app_integration_added', accountIsSource: true },
    { file: 'live-device-added-1', type: 'device_added', accountIsSource: false },
    { file: 'live-device-added-2', type: 'device_added', accountIsSource: false },
    { file: 'live-button-press-1', type: 'button_press', accountIsSource: false },
    { file: 'live-button-press-2', type: 'button_press', accountIsSource: false },
    { file: 'live-flood-detected-1', type: 'flood_detected', accountIsSource: false },
    { file: 'live-flood-detected-2', type: 'flood_detected', accountIsSource: false },
    { file: 'live-flood-detected-3', type: 'flood_detected', accountIsSource: false },
    { file: 'live-flood-cleared-1', type: 'flood_cleared', accountIsSource: false },
    { file: 'live-flood-cleared-2', type: 'flood_cleared', accountIsSource: false },
    { file: 'live-flood-cleared-3', type: 'flood_cleared', accountIsSource: false }
  ];

  for (const { file, type, accountIsSource } of liveCases) {
    it(`decodes ${file} (${type})`, () => {
      const body = fixture<LiveBody>(file);
      const r = decodeWebhook(body, RECEIVED_LIVE);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.event.type).toBe(type);
      expect(r.event.requestId).toBe(body.meta.request_id);
      expect(r.event.deviceId).toBe(accountIsSource ? null : body.data.attributes.source);
      expect(r.event.at).toBe(new Date(body.data.attributes.timestamp).toISOString());
    });
  }

  // Observation 1 (Task 18 checklist): the live run showed the six flood events' meta.request_id
  // truncated to exactly 64 characters. What that truncation does to the trailing word depends on
  // which word it is: "water_detected" (14 chars) loses its final "d" and lands mid-word, but
  // "water_cleared" (13 chars) already fits inside the 64-char budget whole, so a cleared event's
  // id ends on a complete word even though it is truncated to the same total length.
  it('truncates a sensor event’s meta.request_id to exactly 64 characters (detected ends mid-word; cleared does not need to)', () => {
    const detected = ['live-flood-detected-1', 'live-flood-detected-2', 'live-flood-detected-3'];
    const cleared = ['live-flood-cleared-1', 'live-flood-cleared-2', 'live-flood-cleared-3'];
    const requestId = (file: string) => fixture<LiveBody>(file).meta.request_id;

    const allSix = [...detected, ...cleared].map(requestId);
    for (const id of allSix) expect(id).toHaveLength(64);
    expect(new Set(allSix).size).toBe(allSix.length); // distinct across all six live sensor events

    for (const file of detected) {
      const id = requestId(file);
      expect(id.endsWith('water_detecte')).toBe(true); // truncated: the closing "d" of "detected" is cut off
      expect(id.endsWith('water_detected')).toBe(false);
    }
    for (const file of cleared) {
      expect(requestId(file).endsWith('water_cleared')).toBe(true); // the complete word — "cleared" is one letter shorter, so it fits
    }
  });

  // Observation 2: a device event's data.id is `<device id>_<kind>_<ms timestamp>`, not an opaque
  // event id. The "<kind>" segment is Ring's internal name for the event, which is not always the
  // same string as the outer data.type — a button press's kind is "ding", not "button_press".
  it('builds data.id for a device event as <device id>_<kind>_<ms timestamp>, not an opaque event id', () => {
    const cases: Array<{ file: string; kind: string }> = [
      { file: 'live-button-press-1', kind: 'ding' },
      { file: 'live-button-press-2', kind: 'ding' },
      { file: 'live-device-added-1', kind: 'device_added' },
      { file: 'live-device-added-2', kind: 'device_added' },
      { file: 'live-flood-detected-1', kind: 'flood_detected' },
      { file: 'live-flood-detected-2', kind: 'flood_detected' },
      { file: 'live-flood-detected-3', kind: 'flood_detected' },
      { file: 'live-flood-cleared-1', kind: 'flood_cleared' },
      { file: 'live-flood-cleared-2', kind: 'flood_cleared' },
      { file: 'live-flood-cleared-3', kind: 'flood_cleared' }
    ];
    for (const { file, kind } of cases) {
      const body = fixture<LiveBody>(file);
      expect(body.data.id).toBe(`${body.data.attributes.source}_${kind}_${body.data.attributes.timestamp}`);
    }
  });
});
