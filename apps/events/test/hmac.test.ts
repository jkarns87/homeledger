import { describe, expect, it } from 'vitest';
import { LINK_WINDOW_MS, isFreshLinkTime, linkNonce, verifyLinkNonce, verifyWebhookSignature, webhookSignature } from '../src/ring/hmac.js';

const KEY = 'test-hmac-signing-key';
const BODY = '{"meta":{"request_id":"req-1"},"data":{"type":"button_press"}}';
// The same JSON, re-serialised with spaces: what a parse-then-stringify would hand the verifier.
const RESERIALISED = '{"meta": {"request_id": "req-1"}, "data": {"type": "button_press"}}';

// Computed independently:
//   printf '%s' "$BODY" | openssl dgst -sha256 -hmac test-hmac-signing-key -hex
const BODY_SIG = 'sha256=c35d7d8c23cdcfc8758c7ad20d4af807220957d80140ee8bedee54226d19f9a5';
//   printf '%s' "$RESERIALISED" | openssl dgst -sha256 -hmac test-hmac-signing-key -hex
const RESERIALISED_SIG = 'sha256=1115782492492990a5513acb599f22d1e149f7789ff0c77e733a92705bf774d5';
//   printf '%s' "$BODY" | openssl dgst -sha256 -hmac other-key -hex
const OTHER_KEY_SIG = 'sha256=9495cc7004b1f8c44971a2866e9283ae6b5b3b652140aa57403bed3966fd7ab8';
//   printf '%s' "$BODY" | openssl dgst -sha256 -hmac test-hmac-signing-key -binary | base64
const BODY_SIG_AS_BASE64 = 'sha256=w119jCPNz8h1jHrSDUr4ByIJV9gBQO6L7e5UIm0Z+aU=';

describe('webhook signature (amendment §12.2: sha256=<hex> over the raw body)', () => {
  it('produces the lowercase hex digest Ring sends', () => {
    expect(webhookSignature(Buffer.from(BODY, 'utf8'), KEY)).toBe(BODY_SIG);
  });

  it('accepts Ring’s signature over the exact bytes received', () => {
    expect(verifyWebhookSignature(Buffer.from(BODY, 'utf8'), BODY_SIG, KEY)).toBe(true);
  });

  it('rejects a signature over the same JSON re-serialised — verification must use raw bytes', () => {
    expect(verifyWebhookSignature(Buffer.from(RESERIALISED, 'utf8'), BODY_SIG, KEY)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(RESERIALISED, 'utf8'), RESERIALISED_SIG, KEY)).toBe(true);
  });

  it('rejects a tampered body, the wrong key, a truncated signature, a missing header, and the Base64 form', () => {
    expect(verifyWebhookSignature(Buffer.from(BODY.replace('button_press', 'motion_detected'), 'utf8'), BODY_SIG, KEY)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(BODY, 'utf8'), OTHER_KEY_SIG, KEY)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(BODY, 'utf8'), BODY_SIG.slice(0, -1), KEY)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(BODY, 'utf8'), undefined, KEY)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(BODY, 'utf8'), BODY_SIG_AS_BASE64, KEY)).toBe(false);
  });
});

describe('link nonce (amendment §12.1: URL-safe Base64, no padding, over "<time>:<account_id>")', () => {
  // printf '%s' "1771130906289:acct-123" | openssl dgst -sha256 -hmac test-hmac-signing-key -binary | base64 | tr '+/' '-_' | tr -d '='
  const NONCE = 'IEV-fda_gDgbfFvtVJ1Bbi10n29TIGJ6e2v0ZmJ8N1c';
  // the same for acct-456
  const OTHER_ACCOUNT_NONCE = '8Rg0MLWO0qWod8Zz1Akoe-xtflZ5A3lPOvPVZtaPagc';

  it('computes the nonce Ring puts on the redirect — the literal contains - and _, so plain Base64 would not match', () => {
    expect(linkNonce('1771130906289', 'acct-123', KEY)).toBe(NONCE);
  });

  it('matches only the account whose tokens are held', () => {
    expect(verifyLinkNonce(NONCE, '1771130906289', 'acct-123', KEY)).toBe(true);
    expect(verifyLinkNonce(OTHER_ACCOUNT_NONCE, '1771130906289', 'acct-123', KEY)).toBe(false);
    expect(verifyLinkNonce(NONCE, '1771130906290', 'acct-123', KEY)).toBe(false);
    expect(verifyLinkNonce(`${NONCE}=`, '1771130906289', 'acct-123', KEY)).toBe(false);
  });

  it('refuses a link older than ten minutes, from the future, or with a malformed time', () => {
    expect(LINK_WINDOW_MS).toBe(600_000);
    const t = 1771130906289;
    expect(isFreshLinkTime(String(t), t)).toBe(true);
    expect(isFreshLinkTime(String(t), t + 600_000)).toBe(true);
    expect(isFreshLinkTime(String(t), t + 600_001)).toBe(false);
    expect(isFreshLinkTime(String(t), t - 1)).toBe(false);
    expect(isFreshLinkTime('17711309062', t)).toBe(false);
    expect(isFreshLinkTime('1771130906289abc', t)).toBe(false);
  });
});
