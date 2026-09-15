import { describe, expect, it } from 'vitest';
import { hasJson, speakList } from '../src/voice.js';

describe('speakList', () => {
  it('reads up to five items and counts the rest', () => {
    expect(speakList(['Furnace', 'Washer'], 'appliance')).toBe('2 appliances: Furnace and Washer.');
    expect(speakList(['A', 'B', 'C', 'D', 'E', 'F', 'G'], 'appliance')).toBe('7 appliances: A, B, C, D, E, and 2 more.');
    expect(speakList(['Furnace'], 'appliance')).toBe('1 appliance: Furnace.');
    expect(speakList([], 'appliance')).toBe('No appliances.');
  });
});

describe('hasJson', () => {
  it('detects braces and brackets that look like JSON', () => {
    expect(hasJson('{"a":1}')).toBe(true);
    expect(hasJson('items: ["a"]')).toBe(true);
    expect(hasJson('Two appliances: Furnace and Washer.')).toBe(false);
  });
});
