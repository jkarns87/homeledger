import { describe, expect, it } from 'vitest';
import { newId } from '../src/ids.js';

describe('newId', () => {
  it('prefixes and produces 16 lowercase base32 characters', () => {
    const id = newId('appl');
    expect(id).toMatch(/^appl_[a-z2-7]{16}$/);
  });
  it('is unique across 1000 draws', () => {
    const set = new Set(Array.from({ length: 1000 }, () => newId('visit')));
    expect(set.size).toBe(1000);
  });
});
