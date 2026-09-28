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
