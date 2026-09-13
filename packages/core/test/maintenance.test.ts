import { describe, expect, it } from 'vitest';
import { computeNextDue, isOverdue } from '../src/domain/maintenance.js';

describe('maintenance math', () => {
  it('adds interval days to the last-done date', () => {
    expect(computeNextDue('2026-06-01', 90)).toBe('2026-08-30');
  });
  it('flags overdue when nextDue is before now', () => {
    expect(isOverdue('2026-08-30', '2026-09-13')).toBe(true);
    expect(isOverdue('2026-09-30', '2026-09-13')).toBe(false);
  });
});
