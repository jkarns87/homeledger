import { randomBytes } from 'node:crypto';

export type IdPrefix = 'appl' | 'visit' | 'doc' | 'alert' | 'evt' | 'log' | 'dev' | 'hh';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function newId(prefix: IdPrefix): string {
  const bytes = randomBytes(10); // 80 bits → 16 base32 chars
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
  return `${prefix}_${out}`;
}
