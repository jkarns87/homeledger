import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Ring signs two things with the one HMAC key, and encodes them differently
 * (amendment §12.1, §12.2). Webhooks: lowercase hex, prefixed `sha256=`.
 * Link nonces: URL-safe Base64 with no padding. The key is used as its UTF-8
 * bytes — never Base64-decoded.
 */
const mac = (hmacKey: string) => createHmac('sha256', Buffer.from(hmacKey, 'utf8'));

function equalInConstantTime(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function webhookSignature(rawBody: Buffer, hmacKey: string): string {
  return `sha256=${mac(hmacKey).update(rawBody).digest('hex')}`;
}

/** Over the bytes exactly as received — a parsed-and-restringified body has different whitespace and a different HMAC. */
export function verifyWebhookSignature(rawBody: Buffer, header: string | undefined, hmacKey: string): boolean {
  if (!header) return false;
  return equalInConstantTime(webhookSignature(rawBody, hmacKey), header.trim());
}

export function linkNonce(timeMs: string, accountId: string, hmacKey: string): string {
  return mac(hmacKey).update(`${timeMs}:${accountId}`, 'utf8').digest('base64url');
}

export function verifyLinkNonce(nonce: string, timeMs: string, accountId: string, hmacKey: string): boolean {
  return equalInConstantTime(linkNonce(timeMs, accountId, hmacKey), nonce);
}

/** Ring's validation window for a link redirect. */
export const LINK_WINDOW_MS = 600_000;

export function isFreshLinkTime(timeMs: string, nowMs: number): boolean {
  if (!/^\d{13}$/.test(timeMs)) return false;
  const age = nowMs - Number(timeMs);
  return age >= 0 && age <= LINK_WINDOW_MS;
}
