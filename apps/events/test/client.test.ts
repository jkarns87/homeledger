import { describe, expect, it } from 'vitest';
import { RING_API_BASE, RING_HTTP_TIMEOUT_MS, RING_OAUTH_TOKEN_URL, RingApiError, createRingApi, createRingOAuth } from '../src/ring/client.js';
import { JPEG_BYTES, fakeFetch, fixture, jsonResponse } from './fakes.js';

const NOW = Date.parse('2026-10-06T13:00:00.000Z');
const tokenBody = { access_token: 'at-1', refresh_token: 'rt-1', scope: 'ava', expires_in: 14400, token_type: 'Bearer' };

describe('Ring OAuth (amendment §12.1)', () => {
  it('exchanges a code with a form post and dates the access token from expires_in', async () => {
    const f = fakeFetch(() => jsonResponse(200, tokenBody));
    const oauth = createRingOAuth({ clientId: 'client-1', clientSecret: 's3cret-value', fetch: f.fetch, now: () => NOW });
    expect(await oauth.exchangeCode('code-abc')).toEqual({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: '2026-10-06T17:00:00.000Z' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(RING_OAUTH_TOKEN_URL);
    expect(f.calls[0]!.method).toBe('POST');
    expect(f.calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(f.calls[0]!.body!))).toEqual({
      grant_type: 'authorization_code',
      code: 'code-abc',
      client_id: 'client-1',
      client_secret: 's3cret-value'
    });
  });

  it('refreshes with the refresh token and keeps the new refresh token Ring returns', async () => {
    const f = fakeFetch(() => jsonResponse(200, { ...tokenBody, access_token: 'at-2', refresh_token: 'rt-2' }));
    const oauth = createRingOAuth({ clientId: 'client-1', clientSecret: 's3cret-value', fetch: f.fetch, now: () => NOW });
    expect(await oauth.refresh('rt-1')).toEqual({ accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: '2026-10-06T17:00:00.000Z' });
    expect(Object.fromEntries(new URLSearchParams(f.calls[0]!.body!))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
      client_id: 'client-1',
      client_secret: 's3cret-value'
    });
  });

  it('fails with the status and Ring’s code, and never with the secret or the code in the message', async () => {
    const f = fakeFetch(() => jsonResponse(400, { errors: [{ status: '400', code: 'invalid_grant' }] }));
    const oauth = createRingOAuth({ clientId: 'client-1', clientSecret: 's3cret-value', fetch: f.fetch, now: () => NOW });
    const err = await oauth.exchangeCode('code-abc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RingApiError);
    expect((err as RingApiError).status).toBe(400);
    expect((err as RingApiError).code).toBe('invalid_grant');
    expect((err as Error).message).toBe('The Ring code exchange failed with 400 invalid_grant');
  });

  it('refuses a 200 whose body is not a token response', async () => {
    const f = fakeFetch(() => jsonResponse(200, { access_token: 'at-1' }));
    const oauth = createRingOAuth({ clientId: 'client-1', clientSecret: 's3cret-value', fetch: f.fetch, now: () => NOW });
    await expect(oauth.exchangeCode('code-abc')).rejects.toThrow('The Ring code exchange returned an unexpected body');
  });
});

describe('Ring API', () => {
  const api = (respond: Parameters<typeof fakeFetch>[0]) => {
    const f = fakeFetch(respond);
    let n = 0;
    return { api: createRingApi({ accessToken: async () => `tok-${++n}`, fetch: f.fetch }), calls: f.calls };
  };

  it('reads the Account ID from users/me with a fresh bearer per call', async () => {
    const { api: ring, calls } = api(() => jsonResponse(200, fixture('users-me')));
    expect(await ring.accountId()).toBe('acct-123');
    await ring.accountId();
    expect(calls.map(c => [c.url, c.headers.authorization])).toEqual([
      [`${RING_API_BASE}/v1/users/me`, 'Bearer tok-1'],
      [`${RING_API_BASE}/v1/users/me`, 'Bearer tok-2']
    ]);
  });

  it('lists devices as id and name only — Ring gives no type (amendment §12.6)', async () => {
    const { api: ring } = api(() => jsonResponse(200, fixture('devices')));
    expect(await ring.listDevices()).toEqual([
      { id: 'dev-doorbell-1', name: 'Front Door' },
      { id: 'dev-flood-1', name: 'Water Heater' }
    ]);
  });

  it('reads both flood and freeze from a sensor’s status, and null from a doorbell’s', async () => {
    const { api: ring, calls } = api(req => jsonResponse(200, fixture(req.url.includes('dev-flood-1') ? 'status-flood-freeze' : 'status-doorbell')));
    expect(await ring.deviceStatus('dev-flood-1')).toEqual({ online: true, flood: false, freeze: false });
    expect(await ring.deviceStatus('dev-doorbell-1')).toEqual({ online: true, flood: null, freeze: null });
    expect(calls[0]!.url).toBe(`${RING_API_BASE}/v1/devices/dev-flood-1/status`);
  });

  it('confirms the link with the nonce, then completes it — both calls are required', async () => {
    const { api: ring, calls } = api(req => jsonResponse(200, req.method === 'POST' ? { status: 'awaiting' } : { status: 'completed' }));
    await ring.confirmLink('IEV-fda_gDgbfFvtVJ1Bbi10n29TIGJ6e2v0ZmJ8N1c', 'hh_h***w');
    await ring.completeLink('hh_h***w');
    expect(calls.map(c => [c.method, c.url, c.body])).toEqual([
      [
        'POST',
        `${RING_API_BASE}/v1/accounts/me/app-integrations`,
        JSON.stringify({ account_identifier: 'hh_h***w', nonce: 'IEV-fda_gDgbfFvtVJ1Bbi10n29TIGJ6e2v0ZmJ8N1c' })
      ],
      ['PATCH', `${RING_API_BASE}/v1/accounts/me/app-integrations`, JSON.stringify({ account_identifier: 'hh_h***w', status: 'completed' })]
    ]);
  });

  it('surfaces Ring’s error code when the nonce is refused', async () => {
    const { api: ring } = api(() => jsonResponse(400, { errors: [{ status: '400', code: 'INVALID_NONCE', title: 'Invalid Nonce' }] }));
    const err = await ring.confirmLink('bad', 'hh_h***w').catch((e: unknown) => e);
    expect([(err as RingApiError).status, (err as RingApiError).code]).toEqual([400, 'INVALID_NONCE']);
  });

  it('requests an image without following the redirect, then fetches the presigned Location without the bearer', async () => {
    const { api: ring, calls } = api(req =>
      req.method === 'POST'
        ? new Response(null, { status: 303, headers: { location: 'https://media.api.amazonvision.com/v1/download?security_token=x' } })
        : new Response(JPEG_BYTES, { status: 200, headers: { 'content-type': 'image/jpeg', 'x-media-origin': 'recording' } })
    );
    const answer = await ring.requestImage('dev-doorbell-1', { startMs: 1791292795000, endMs: 1791292830000 });
    expect(answer).toEqual({ kind: 'image', bytes: JPEG_BYTES, contentType: 'image/jpeg' });
    expect(calls[0]!.url).toBe(`${RING_API_BASE}/v1/devices/dev-doorbell-1/media/image/download`);
    expect(calls[0]!.redirect).toBe('manual');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      type: 'latest_in_range',
      start_timestamp: 1791292795000,
      end_timestamp: 1791292830000,
      image_options: { format: 'jpeg' }
    });
    expect(calls[1]!.url).toBe('https://media.api.amazonvision.com/v1/download?security_token=x');
    expect(calls[1]!.headers.authorization).toBeUndefined();
  });

  it('reports a refusal on either leg with its status and code', async () => {
    const onPost = api(() => jsonResponse(403, { errors: [{ status: '403', code: 'TIME_RANGE_NOT_AUTHORIZED' }] }));
    expect(await onPost.api.requestImage('dev-doorbell-1', { startMs: 1, endMs: 2 })).toEqual({
      kind: 'refused',
      status: 403,
      code: 'TIME_RANGE_NOT_AUTHORIZED'
    });
    const onGet = api(req =>
      req.method === 'POST'
        ? new Response(null, { status: 303, headers: { location: 'https://media.api.amazonvision.com/x' } })
        : jsonResponse(416, { errors: [{ status: '416', code: 'MEDIA_NOT_FOUND' }] })
    );
    expect(await onGet.api.requestImage('dev-doorbell-1', { startMs: 1, endMs: 2 })).toEqual({ kind: 'refused', status: 416, code: 'MEDIA_NOT_FOUND' });
  });
});

describe('Ring timeouts', () => {
  it('bounds every Ring request, OAuth and API, including both legs of the image download', async () => {
    expect(RING_HTTP_TIMEOUT_MS).toBe(10_000);
    const f = fakeFetch(req => {
      if (req.url === RING_OAUTH_TOKEN_URL) return jsonResponse(200, tokenBody);
      if (req.url.endsWith('/media/image/download')) return new Response(null, { status: 303, headers: { location: 'https://media.api.amazonvision.com/x' } });
      if (req.url === 'https://media.api.amazonvision.com/x') return new Response(JPEG_BYTES, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      if (req.url.endsWith('/v1/users/me')) return jsonResponse(200, fixture('users-me'));
      if (req.url.endsWith('/v1/devices')) return jsonResponse(200, fixture('devices'));
      if (req.url.endsWith('/status')) return jsonResponse(200, fixture('status-doorbell'));
      return jsonResponse(200, { status: 'completed' });
    });
    const oauth = createRingOAuth({ clientId: 'client-1', clientSecret: 's3cret-value', fetch: f.fetch, now: () => NOW });
    const ring = createRingApi({ accessToken: async () => 'tok', fetch: f.fetch });
    await oauth.exchangeCode('code-abc');
    await oauth.refresh('rt-1');
    await ring.accountId();
    await ring.listDevices();
    await ring.deviceStatus('dev-doorbell-1');
    await ring.confirmLink('IEV-fda_gDgbfFvtVJ1Bbi10n29TIGJ6e2v0ZmJ8N1c', 'hh_h***w');
    await ring.completeLink('hh_h***w');
    await ring.requestImage('dev-doorbell-1', { startMs: 1, endMs: 2 });
    expect(f.calls.map(c => [c.method, c.url, c.signal instanceof AbortSignal])).toEqual([
      ['POST', RING_OAUTH_TOKEN_URL, true],
      ['POST', RING_OAUTH_TOKEN_URL, true],
      ['GET', `${RING_API_BASE}/v1/users/me`, true],
      ['GET', `${RING_API_BASE}/v1/devices`, true],
      ['GET', `${RING_API_BASE}/v1/devices/dev-doorbell-1/status`, true],
      ['POST', `${RING_API_BASE}/v1/accounts/me/app-integrations`, true],
      ['PATCH', `${RING_API_BASE}/v1/accounts/me/app-integrations`, true],
      ['POST', `${RING_API_BASE}/v1/devices/dev-doorbell-1/media/image/download`, true],
      ['GET', 'https://media.api.amazonvision.com/x', true]
    ]);
  });
});
