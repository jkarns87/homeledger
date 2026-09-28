import { describe, expect, it, vi } from 'vitest';
import { describeDeadLetter, handleDeadLetters } from '../src/handlers/dlq-alerter.js';
import { REFRESH_MARGIN_MS, RING_ACCESS_LAPSED_MESSAGE, refreshIfDue } from '../src/handlers/token-refresh.js';
import { RingApiError, type RingOAuth } from '../src/ring/client.js';
import type { TokenRecord } from '../src/aws/tokens.js';
import { memoryTokenStore } from './fakes.js';

const NOW = Date.parse('2026-10-06T13:00:00.000Z');
const linked = (expiresInMs: number): TokenRecord => ({
  accountId: 'acct-123',
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: new Date(NOW + expiresInMs).toISOString(),
  status: 'linked',
  updatedAt: '2026-10-06T09:00:00.000Z'
});
const oauth =
  (refresh: RingOAuth['refresh']): (() => Promise<RingOAuth>) =>
  async () => ({ exchangeCode: vi.fn(), refresh });

describe('token refresh (spec §3: ahead of expiry with a one-hour margin; never silent)', () => {
  it('does nothing before a link', async () => {
    const refresh = vi.fn();
    expect(await refreshIfDue({ store: memoryTokenStore(), oauth: oauth(refresh), nowMs: () => NOW, alert: vi.fn() })).toBe('not-linked');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('leaves a token with more than an hour left alone', async () => {
    expect(REFRESH_MARGIN_MS).toBe(3_600_000);
    const refresh = vi.fn();
    expect(await refreshIfDue({ store: memoryTokenStore(linked(REFRESH_MARGIN_MS + 1)), oauth: oauth(refresh), nowMs: () => NOW, alert: vi.fn() })).toBe(
      'fresh'
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes inside the margin and keeps the new refresh token Ring hands back', async () => {
    const store = memoryTokenStore(linked(REFRESH_MARGIN_MS));
    const refresh = vi.fn(async () => ({ accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: '2026-10-06T17:00:00.000Z' }));
    expect(await refreshIfDue({ store, oauth: oauth(refresh), nowMs: () => NOW, alert: vi.fn() })).toBe('refreshed');
    expect(refresh).toHaveBeenCalledWith('rt-1');
    expect(store.current()).toEqual({
      ...linked(0),
      accessToken: 'at-2',
      refreshToken: 'rt-2',
      expiresAt: '2026-10-06T17:00:00.000Z',
      updatedAt: '2026-10-06T13:00:00.000Z'
    });
  });

  it('raises one alert when Ring refuses the refresh token, then stays quiet', async () => {
    const store = memoryTokenStore(linked(60_000));
    const alert = vi.fn(async () => {});
    const refresh = vi.fn(async () => Promise.reject(new RingApiError(400, 'invalid_grant', 'x')));
    expect(await refreshIfDue({ store, oauth: oauth(refresh), nowMs: () => NOW, alert })).toBe('lapsed');
    expect(alert).toHaveBeenCalledWith(RING_ACCESS_LAPSED_MESSAGE);
    expect(store.current()?.status).toBe('lapsed');
    expect(await refreshIfDue({ store, oauth: oauth(refresh), nowMs: () => NOW, alert })).toBe('not-linked');
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('throws on a transient failure so the schedule retries, without an alert', async () => {
    const alert = vi.fn();
    const refresh = vi.fn(async () => Promise.reject(new RingApiError(503, 'SERVER_BUSY', 'x')));
    await expect(refreshIfDue({ store: memoryTokenStore(linked(60_000)), oauth: oauth(refresh), nowMs: () => NOW, alert })).rejects.toThrow();
    expect(alert).not.toHaveBeenCalled();
  });

  it('says what lapsed and what to do, without reassurance', () => {
    expect(RING_ACCESS_LAPSED_MESSAGE).toBe('Ring access lapsed, so doorbell and sensor events have stopped. Link the Ring account again from the Ring app.');
  });
});

describe('dead-letter alerter (spec §4: a dead-lettered event becomes an ALERT# row)', () => {
  it('names the kind of event that could not be processed', () => {
    const body = JSON.stringify({ 'detail-type': 'button_press', source: 'ring.webhook', detail: { requestId: 'req-bp-0001' } });
    expect(describeDeadLetter(body)).toBe('A doorbell press could not be processed. It is kept for review.');
    expect(describeDeadLetter(JSON.stringify({ 'detail-type': 'flood_detected' }))).toBe(
      'A flood or freeze sensor event could not be processed. It is kept for review.'
    );
    expect(describeDeadLetter(JSON.stringify({ 'detail-type': 'visit.arrived' }))).toBe('A display update could not be delivered. It is kept for review.');
    expect(describeDeadLetter('not json')).toBe('An unrecognised home event could not be processed. It is kept for review.');
  });

  it('raises one alert per dead letter', async () => {
    const alert = vi.fn(async () => {});
    expect(await handleDeadLetters({ alert }, ['{"detail-type":"button_press"}', 'x'])).toBe(2);
    expect(alert).toHaveBeenCalledTimes(2);
  });
});
