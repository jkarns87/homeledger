import { describe, expect, it } from 'vitest';
import { derivedId, newId } from '../src/ids.js';

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

describe('derivedId', () => {
  it('matches the same id shape as newId', () => {
    const id = derivedId('visit', 'hh_test\u0000appl_x\u0000prov_y\u00002026-09-15T13:00:00.000Z');
    expect(id).toMatch(/^visit_[a-z2-7]{16}$/);
  });
  it('is stable across calls for the same seed', () => {
    const seed = 'hh_test\u0000appl_x\u0000prov_y\u00002026-09-15T13:00:00.000Z';
    expect(derivedId('visit', seed)).toBe(derivedId('visit', seed));
  });
  it('differs for different seeds', () => {
    const a = derivedId('visit', 'hh_test\u0000appl_x\u0000prov_y\u00002026-09-15T13:00:00.000Z');
    const b = derivedId('visit', 'hh_test\u0000appl_x\u0000prov_z\u00002026-09-15T13:00:00.000Z');
    expect(a).not.toBe(b);
  });
});
