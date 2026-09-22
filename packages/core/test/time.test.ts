import { describe, expect, it } from 'vitest';
import {
  HouseholdSchema,
  SEED_TIMEZONE,
  TimeZone,
  createMemoryRepository,
  isIanaTimeZone,
  normaliseSpaces,
  timeZoneDataProblem,
  todayInZone
} from '../src/index.js';

/**
 * Stands in for a Node built `--without-intl`: `DateTimeFormat` exists, never
 * throws on an unknown `timeZone`, and ignores the option entirely. That is the
 * shape of the failure, and it is why a bare `expect(timeZoneDataProblem()).
 * toBeNull()` proves nothing on its own - it passes because the machine is
 * fine, not because the probe works.
 */
class StubDateTimeFormat {
  format(value: number | Date): string {
    return new Date(value).toISOString();
  }
  formatToParts(): Intl.DateTimeFormatPart[] {
    return [];
  }
}

function withStubbedIntl<T>(fn: () => T): T {
  const real = globalThis.Intl;
  globalThis.Intl = { DateTimeFormat: StubDateTimeFormat } as unknown as typeof Intl;
  try {
    return fn();
  } finally {
    globalThis.Intl = real;
  }
}

describe('timeZoneDataProblem', () => {
  it('reports nothing on a runtime that really carries IANA data', () => {
    // If this fails, the runtime this suite is on cannot localise a time and
    // every other expectation in this file is meaningless.
    expect(timeZoneDataProblem()).toBeNull();
  });

  it('catches a runtime whose Intl ignores the timeZone option', () => {
    const problem = withStubbedIntl(timeZoneDataProblem);
    expect(problem).not.toBeNull();
    expect(problem).toContain('no IANA time-zone data');
    expect(problem).toContain('America/Chicago');
  });

  it('is the only thing standing between a stubbed Intl and silently wrong times', () => {
    // The consequence the probe exists to prevent, demonstrated rather than
    // asserted: with no real ICU, the zone validator cannot tell a real zone
    // from a fictional one, so every zone "validates" and every rendered time
    // is really UTC wearing the household's zone name.
    expect(withStubbedIntl(() => isIanaTimeZone('America/Nowhere'))).toBe(true);
    expect(isIanaTimeZone('America/Nowhere')).toBe(false);
  });
});

describe('isIanaTimeZone', () => {
  it('accepts region/location names, including multi-segment ones and UTC', () => {
    expect(isIanaTimeZone('America/Chicago')).toBe(true);
    expect(isIanaTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isIanaTimeZone('Europe/London')).toBe(true);
    expect(isIanaTimeZone('UTC')).toBe(true);
  });

  it('rejects UTC offsets, which Intl itself would accept', () => {
    // Not a hypothetical: `new Intl.DateTimeFormat('en-US', { timeZone: '+05:00' })`
    // constructs fine on Node 22 and 24 and resolves to '+05:00'. An offset is
    // frozen, so a household stored as -05:00 in September renders every
    // November visit an hour early. Only the NAME carries the DST rules.
    expect(isIanaTimeZone('+05:00')).toBe(false);
    expect(isIanaTimeZone('-0600')).toBe(false);
    expect(isIanaTimeZone('GMT')).toBe(false);
    expect(isIanaTimeZone('EST')).toBe(false);
  });

  it('rejects names ICU does not know, and the empty string', () => {
    expect(isIanaTimeZone('America/Nowhere')).toBe(false);
    expect(isIanaTimeZone('Middle/Earth')).toBe(false);
    expect(isIanaTimeZone('')).toBe(false);
  });

  it('names the offending value in the schema error rather than saying "invalid"', () => {
    const failed = TimeZone.safeParse('-0600');
    expect(failed.success).toBe(false);
    expect(failed.error?.issues[0]?.message).toContain('"-0600"');
    expect(failed.error?.issues[0]?.message).toContain('America/Chicago');
  });
});

describe('HouseholdSchema.timezone', () => {
  const household = (timezone: string) => ({ id: 'hh_test', name: 'Test household', timezone });

  it('accepts the seeded zone', () => {
    expect(HouseholdSchema.parse(household(SEED_TIMEZONE)).timezone).toBe('America/Chicago');
  });

  it('refuses an unknown zone and an offset', () => {
    expect(HouseholdSchema.safeParse(household('America/Nowhere')).success).toBe(false);
    expect(HouseholdSchema.safeParse(household('-05:00')).success).toBe(false);
  });
});

describe('putHousehold', () => {
  it('rejects a bad zone at the write instead of storing it', async () => {
    const repo = createMemoryRepository('hh_test');
    await expect(repo.putHousehold({ id: 'hh_test', name: 'Test household', timezone: '-05:00' })).rejects.toThrow(/IANA time zone/);
    // The write did not half-happen: nothing was stored, so a later read
    // cannot pick up the rejected value.
    expect(await repo.getHousehold()).toBeNull();
  });

  it('stores a valid zone unchanged', async () => {
    const repo = createMemoryRepository('hh_test');
    await repo.putHousehold({ id: 'hh_test', name: 'Test household', timezone: 'Europe/London' });
    expect((await repo.getHousehold())?.timezone).toBe('Europe/London');
  });
});

describe('todayInZone', () => {
  it('is the household calendar day, which is not always UTC"s', () => {
    // 02:00Z on the 13th is 9 PM on the 12th in Chicago. `iso.slice(0, 10)` -
    // what every "today" in the server used to be - returns 2026-09-13 here,
    // which is how a task due on the 12th started being called overdue to
    // someone whose own evening was still the 12th.
    expect(todayInZone('2026-09-13T02:00:00.000Z', 'America/Chicago')).toBe('2026-09-12');
    expect(todayInZone('2026-09-13T02:00:00.000Z', 'UTC')).toBe('2026-09-13');
  });

  it('runs ahead of UTC east of the line', () => {
    expect(todayInZone('2026-09-13T22:00:00.000Z', 'Asia/Tokyo')).toBe('2026-09-14');
  });

  it('agrees with UTC in the middle of the UTC day', () => {
    expect(todayInZone('2026-09-13T12:00:00.000Z', 'America/Chicago')).toBe('2026-09-13');
  });
});

// Built with fromCodePoint rather than written inline: Prettier rewrites a
// \u escape in a string literal into the literal character, and an invisible
// U+202F sitting in source next to an ordinary space is unreadable and one
// careless edit away from becoming a vacuous assertion.
const NARROW_NO_BREAK_SPACE = String.fromCodePoint(0x202f);
const NO_BREAK_SPACE = String.fromCodePoint(0x00a0);

describe('normaliseSpaces', () => {
  it('collapses the narrow no-break space ICU 72+ puts before AM/PM', () => {
    // Without this, an expected '8:00 AM' compares unequal to the formatter's
    // output on ICU 72+ and equal on older ICU - a suite that passes or fails
    // on the base image's ICU version rather than on the code. The deployed
    // image emits a plain space today (checked: node:22-bookworm-slim, ICU
    // 78.2), which is precisely why this has to be proved here rather than
    // inferred from an end-to-end string comparison that happens to match.
    expect(normaliseSpaces(`8:00${NARROW_NO_BREAK_SPACE}AM CDT`)).toBe('8:00 AM CDT');
    expect(normaliseSpaces(`8:00${NO_BREAK_SPACE}AM`)).toBe('8:00 AM');
    expect(normaliseSpaces('8:00 AM')).toBe('8:00 AM');
  });
});
