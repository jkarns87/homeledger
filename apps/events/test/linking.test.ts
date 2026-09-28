import { describe, expect, it, vi } from 'vitest';
import type { Device } from '@homeledger/core';
import { handleLink, accountIdentifierFor, type LinkDeps } from '../src/handlers/link.js';
import { handleTokenExchange } from '../src/handlers/token-exchange.js';
import { RingApiError, type RingOAuth } from '../src/ring/client.js';
import type { TokenRecord } from '../src/aws/tokens.js';
import { TEST_HMAC_KEY, fakeRingApi, memoryTokenStore } from './fakes.js';

const T = 1771130906289; // the link's time parameter, ms
const NONCE = 'IEV-fda_gDgbfFvtVJ1Bbi10n29TIGJ6e2v0ZmJ8N1c'; // for acct-123 at T under TEST_HMAC_KEY (Task 5)
const form = (fields: Record<string, string>) => ({
  body: new URLSearchParams(fields).toString(),
  isBase64Encoded: false,
  headers: { 'content-type': 'application/x-www-form-urlencoded' }
});
const unclaimed: TokenRecord = {
  accountId: 'acct-123',
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: '2026-10-06T17:00:00.000Z',
  status: 'unclaimed',
  updatedAt: '2026-10-06T13:00:00.000Z'
};

describe('Token Exchange URL (amendment §12.1 step 2)', () => {
  const oauth = (answer: 'ok' | 'fail'): RingOAuth => ({
    exchangeCode: vi.fn(async (code: string) => {
      if (answer === 'fail') throw new RingApiError(400, 'invalid_grant', 'The Ring code exchange failed with 400 invalid_grant');
      expect(code).toBe('code-abc');
      return { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: '2026-10-06T17:00:00.000Z' };
    }),
    refresh: vi.fn()
  });

  it('exchanges the code, reads the account, and holds the tokens unclaimed until the owner signs in', async () => {
    const store = memoryTokenStore();
    const reply = await handleTokenExchange(
      { oauth: async () => oauth('ok'), accountIdFor: async t => (t === 'at-1' ? 'acct-123' : 'wrong'), store, now: () => '2026-10-06T13:00:00.000Z' },
      form({ code: 'code-abc' })
    );
    expect(reply.statusCode).toBe(200);
    expect(store.current()).toEqual(unclaimed);
  });

  it('answers 400 with no code, and 502 without writing anything when Ring refuses the exchange', async () => {
    const store = memoryTokenStore();
    const deps = { oauth: async () => oauth('fail'), accountIdFor: async () => 'acct-123', store, now: () => '2026-10-06T13:00:00.000Z' };
    expect((await handleTokenExchange(deps, form({}))).statusCode).toBe(400);
    expect((await handleTokenExchange(deps, form({ code: 'code-abc' }))).statusCode).toBe(502);
    expect(store.current()).toBeNull();
  });

  it('refuses a second Ring account while one is linked — v1 is one household, one account', async () => {
    const store = memoryTokenStore({ ...unclaimed, accountId: 'acct-999', status: 'linked' });
    const reply = await handleTokenExchange(
      { oauth: async () => oauth('ok'), accountIdFor: async () => 'acct-123', store, now: () => 'x' },
      form({ code: 'code-abc' })
    );
    expect(reply.statusCode).toBe(409);
    expect(store.current()?.accountId).toBe('acct-999');
  });
});

describe('Account Link URL (amendment §12.1 steps 3–5)', () => {
  const devices: Device[] = [];
  const deps = (over: Partial<LinkDeps> = {}): LinkDeps & { api: ReturnType<typeof fakeRingApi>; store: ReturnType<typeof memoryTokenStore> } => {
    const api = fakeRingApi({ devices: [{ id: 'dev-doorbell-1', name: 'Front Door' }] });
    const store = memoryTokenStore(unclaimed);
    return {
      hmacKey: async () => TEST_HMAC_KEY,
      passphrase: async () => 'correct horse battery staple',
      store,
      apiFor: token => {
        expect(token).toBe('at-1');
        return api;
      },
      sync: async () => [
        { id: 'dev_aaaaaaaaaaaaaaaa', ringDeviceId: 'dev-doorbell-1', name: 'Front Door', kind: 'other', online: true, lastSeenAt: null, sensorState: null },
        ...devices
      ],
      householdId: 'hh_harlow',
      nowMs: () => T + 60_000,
      api,
      ...over
    } as LinkDeps & { api: ReturnType<typeof fakeRingApi>; store: ReturnType<typeof memoryTokenStore> };
  };
  const get = (query: Record<string, string>) => ({ method: 'GET', query, body: undefined, isBase64Encoded: false, headers: {} });
  const post = (fields: Record<string, string>) => ({ method: 'POST', query: {}, ...form(fields) });

  it('masks the household as the account identifier Ring shows the owner', () => {
    expect(accountIdentifierFor('hh_harlow')).toBe('hh_h***w');
  });

  it('shows a sign-in form carrying the nonce and time, locked down against framing and scripts', async () => {
    const reply = await handleLink(deps(), get({ nonce: NONCE, time: String(T) }));
    expect(reply.statusCode).toBe(200);
    expect(reply.headers).toEqual({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"
    });
    expect(reply.body).toContain(`<input type="hidden" name="nonce" value="${NONCE}">`);
    expect(reply.body).toContain(`<input type="hidden" name="time" value="${T}">`);
    expect(reply.body).toContain('<input type="password" name="passphrase"');
  });

  it('refuses a stale or malformed link before showing any form', async () => {
    expect((await handleLink(deps({ nowMs: () => T + 600_001 }), get({ nonce: NONCE, time: String(T) }))).statusCode).toBe(400);
    expect((await handleLink(deps(), get({ nonce: '<script>', time: String(T) }))).statusCode).toBe(400);
    expect((await handleLink(deps(), get({ nonce: NONCE }))).statusCode).toBe(400);
  });

  it('with the right passphrase and a matching nonce, confirms then completes the link, marks it linked, and syncs devices', async () => {
    const d = deps();
    const reply = await handleLink(d, post({ nonce: NONCE, time: String(T), passphrase: 'correct horse battery staple' }));
    expect(reply.statusCode).toBe(200);
    expect(d.api.calls).toEqual([`confirmLink:${NONCE}:hh_h***w`, 'completeLink:hh_h***w']);
    expect(d.store.current()?.status).toBe('linked');
    expect(reply.body).toContain('Ring is linked to HomeLedger. Found 1 device: Front Door.');
  });

  it('answers 401 for the wrong passphrase and calls Ring for nothing', async () => {
    const d = deps();
    expect((await handleLink(d, post({ nonce: NONCE, time: String(T), passphrase: 'wrong' }))).statusCode).toBe(401);
    expect(d.api.calls).toEqual([]);
    expect(d.store.current()?.status).toBe('unclaimed');
  });

  it('answers 400 when the nonce belongs to another account or another moment', async () => {
    const d = deps();
    expect((await handleLink(d, post({ nonce: NONCE, time: String(T + 1), passphrase: 'correct horse battery staple' }))).statusCode).toBe(400);
    expect(d.api.calls).toEqual([]);
  });

  it('answers 409 when Ring has not sent the tokens yet', async () => {
    const d = deps({ store: memoryTokenStore(null) });
    expect((await handleLink(d, post({ nonce: NONCE, time: String(T), passphrase: 'correct horse battery staple' }))).statusCode).toBe(409);
  });

  it('checks the nonce before the passphrase, so a forged link cannot be used to test passphrases', async () => {
    const passphrase = vi.fn(async () => 'correct horse battery staple');
    const d = deps({ passphrase });
    expect((await handleLink(d, post({ nonce: NONCE, time: String(T + 1), passphrase: 'wrong' }))).statusCode).toBe(400);
    expect(
      (await handleLink(deps({ passphrase, store: memoryTokenStore(null) }), post({ nonce: NONCE, time: String(T), passphrase: 'wrong' }))).statusCode
    ).toBe(409);
    expect(passphrase).not.toHaveBeenCalled();
    expect(d.api.calls).toEqual([]);
  });

  it('answers 502 and leaves the tokens unclaimed when Ring refuses to complete the link', async () => {
    const api = fakeRingApi({ refuse: { completeLink: new RingApiError(400, 'INVALID_STATUS_TRANSITION', 'x') } });
    const d = deps({ apiFor: () => api });
    const reply = await handleLink(d, post({ nonce: NONCE, time: String(T), passphrase: 'correct horse battery staple' }));
    expect(reply.statusCode).toBe(502);
    expect(reply.body).toContain('Ring refused the link (400 INVALID_STATUS_TRANSITION).');
    expect(d.store.current()?.status).toBe('unclaimed');
  });

  it("escapes Ring's refusal code on the error page", async () => {
    const api = fakeRingApi({ refuse: { completeLink: new RingApiError(400, '<b>x</b>', 'x') } });
    const reply = await handleLink(deps({ apiFor: () => api }), post({ nonce: NONCE, time: String(T), passphrase: 'correct horse battery staple' }));
    expect(reply.statusCode).toBe(502);
    expect(reply.body).toContain('<p>Ring refused the link (400 &lt;b&gt;x&lt;/b&gt;). Start again from the Ring app.</p>');
    expect(reply.body).not.toContain('<b>x</b>');
  });

  it('still reports the link as done when only the device sync fails — the nightly sync recovers it', async () => {
    const d = deps({ sync: async () => Promise.reject(new Error('throttled')) });
    const reply = await handleLink(d, post({ nonce: NONCE, time: String(T), passphrase: 'correct horse battery staple' }));
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toContain('Ring is linked to HomeLedger. The device list will appear within a day.');
  });
});
