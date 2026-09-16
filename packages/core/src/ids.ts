import { createHash, randomBytes } from 'node:crypto';

export type IdPrefix = 'appl' | 'visit' | 'doc' | 'alert' | 'evt' | 'log' | 'dev' | 'hh';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Encodes 10 bytes (80 bits) into 16 lowercase base32 characters — the `[a-z2-7]{16}` id body every prefixed schema expects. */
function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${encodeBase32(randomBytes(10))}`; // 80 bits → 16 base32 chars
}

/**
 * Deterministic id derived from `seed`: hashes `seed` with SHA-256 and
 * base32-encodes the first 10 bytes of the digest through the same encoder
 * `newId` uses, so the result satisfies the same `^<prefix>_[a-z2-7]{16}$`
 * shape `prefixed()` (schemas.ts) validates.
 *
 * The same seed always yields the same id. This makes a write idempotent
 * under retry: a caller that seeds on the values that uniquely identify one
 * logical write (e.g. a booking's household, appliance, provider, and
 * arrival window) gets the same id back if the same logical write is
 * attempted twice, so a replayed write overwrites the same row — every
 * `Repository.put*` is replace-by-id — instead of appending a duplicate.
 */
export function derivedId(prefix: IdPrefix, seed: string): string {
  const digest = createHash('sha256').update(seed).digest();
  return `${prefix}_${encodeBase32(digest.subarray(0, 10))}`;
}
