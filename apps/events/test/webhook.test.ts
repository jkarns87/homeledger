import { createMemoryRepository, type Repository } from '@homeledger/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleWebhook, type WebhookDeps } from '../src/handlers/webhook.js';
import { webhookSignature } from '../src/ring/hmac.js';
import { TEST_HMAC_KEY, fixture, recordingPublisher, signedRequest } from './fakes.js';

let repo: Repository;
let bus: ReturnType<typeof recordingPublisher>;
let deps: WebhookDeps;

beforeEach(async () => {
  repo = createMemoryRepository('hh_test');
  bus = recordingPublisher();
  deps = { hmacKey: async () => TEST_HMAC_KEY, repo, publish: bus.publish, now: () => '2026-10-06T13:20:02.000Z' };
  await repo.putDevice({
    id: 'dev_aaaaaaaaaaaaaaaa',
    ringDeviceId: 'dev-doorbell-1',
    name: 'Front Door',
    kind: 'doorbell',
    online: true,
    lastSeenAt: null,
    sensorState: null
  });
});

describe('webhook ingest (spec §4, amendment §12.3)', () => {
  it('verifies, records, and publishes a button press with the device’s name', async () => {
    const reply = await handleWebhook(deps, signedRequest(fixture('button-press')));
    expect([reply.statusCode, JSON.parse(reply.body)]).toEqual([200, { status: 'accepted' }]);
    expect(bus.entries).toEqual([
      {
        source: 'ring.webhook',
        detailType: 'button_press',
        detail: {
          requestId: 'req-bp-0001',
          accountId: 'acct-123',
          eventId: 'evt-bp-0001',
          type: 'button_press',
          subType: null,
          deviceId: 'dev-doorbell-1',
          deviceName: 'Front Door',
          at: '2026-10-06T13:20:00.000Z'
        }
      }
    ]);
    const rows = await repo.listEvents('2026-10-06T00:00:00.000Z');
    expect(rows.map(r => [r.ringEventId, r.type, r.deviceName, r.at])).toEqual([['req-bp-0001', 'button_press', 'Front Door', '2026-10-06T13:20:00.000Z']]);
  });

  it('verifies a body API Gateway delivered as Base64 against its decoded bytes', async () => {
    expect((await handleWebhook(deps, signedRequest(fixture('button-press'), { base64: true }))).statusCode).toBe(200);
  });

  it('answers 401 and does nothing for a bad or missing signature — Ring does not retry a 4xx', async () => {
    expect((await handleWebhook(deps, signedRequest(fixture('button-press'), { key: 'other-key' }))).statusCode).toBe(401);
    expect((await handleWebhook(deps, signedRequest(fixture('button-press'), { signature: null }))).statusCode).toBe(401);
    expect(bus.entries).toEqual([]);
    expect(await repo.listEvents('2026-10-06T00:00:00.000Z')).toEqual([]);
  });

  it('answers 200 and publishes nothing for a redelivery of an event already on the bus', async () => {
    await handleWebhook(deps, signedRequest(fixture('button-press')));
    const again = await handleWebhook(deps, signedRequest(fixture('button-press')));
    expect([again.statusCode, JSON.parse(again.body)]).toEqual([200, { status: 'duplicate' }]);
    expect(bus.entries).toHaveLength(1);
  });

  it('answers 500 when publishing fails, and lets Ring’s retry through to publish it once', async () => {
    bus.failNext(1);
    const first = await handleWebhook(deps, signedRequest(fixture('button-press')));
    expect(first.statusCode).toBe(500);
    expect(bus.entries).toEqual([]);
    const retry = await handleWebhook(deps, signedRequest(fixture('button-press')));
    expect(retry.statusCode).toBe(200);
    expect(bus.entries).toHaveLength(1);
    expect(await repo.listEvents('2026-10-06T00:00:00.000Z')).toHaveLength(1);
  });

  it('answers 500 when the signing key cannot be read, so Ring retries', async () => {
    const reply = await handleWebhook({ ...deps, hmacKey: async () => Promise.reject(new Error('throttled')) }, signedRequest(fixture('button-press')));
    expect(reply.statusCode).toBe(500);
  });

  it('answers 400 for a body with no request id, and for a body that is not JSON', async () => {
    const payload = fixture<{ meta: object; data: object }>('button-press');
    expect((await handleWebhook(deps, signedRequest({ ...payload, meta: {} }))).statusCode).toBe(400);
    const raw = Buffer.from('{not json', 'utf8');
    expect(
      (await handleWebhook(deps, { body: raw.toString('utf8'), isBase64Encoded: false, headers: { 'x-signature': webhookSignature(raw, TEST_HMAC_KEY) } }))
        .statusCode
    ).toBe(400);
  });

  it('stores and publishes an event type nothing routes, and names an unknown device plainly', async () => {
    const reply = await handleWebhook(deps, signedRequest(fixture('flood-detected')));
    expect(reply.statusCode).toBe(200);
    expect(bus.entries[0]!.detailType).toBe('flood_detected');
    expect(bus.entries[0]!.detail.deviceName).toBe('Ring device');
  });

  it('records an account-level event against the account, not a device', async () => {
    await handleWebhook(deps, signedRequest(fixture('app-integration-added')));
    expect(bus.entries[0]!.detail).toMatchObject({ type: 'app_integration_added', deviceId: null, deviceName: 'Ring account' });
    expect((await repo.listEvents('1970-01-01T00:00:00.000Z'))[0]!.deviceId).toBe('account:acct-123');
  });
});
