import { describe, expect, it } from 'vitest';
import { gsi1, gsi2, pk, sk } from '../src/repo/keys.js';

describe('keys', () => {
  it('builds partition and sort keys', () => {
    expect(pk('hh_harlow')).toBe('HH#hh_harlow');
    expect(sk.appliance('appl_a')).toBe('APPL#appl_a');
    expect(sk.maintenance('appl_a', 'filter_change')).toBe('MAINT#appl_a#filter_change');
    expect(sk.log('2026-09-13T10:00:00.000Z', 'log_1')).toBe('LOG#2026-09-13T10:00:00.000Z#log_1');
    expect(sk.event('2026-09-13T10:00:00.000Z', 'evt_1')).toBe('EVENT#2026-09-13T10:00:00.000Z#evt_1');
    expect(sk.household()).toBe('HOUSEHOLD');
    expect(gsi1.due('hh_harlow')).toBe('HH#hh_harlow#DUE');
    expect(gsi2.visit('hh_harlow')).toBe('HH#hh_harlow#VISIT');
  });
});
