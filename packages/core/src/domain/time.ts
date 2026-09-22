import * as z from 'zod/v4';

/** U+202F (narrow no-break space, ICU 72+) and U+00A0 collapsed to a plain space, so formatted output is stable across ICU versions. */
export function normaliseSpaces(text: string): string {
  return text.replace(/[  ]/g, ' ');
}

/**
 * An IANA region/location name: `America/Chicago`, `America/Argentina/Buenos_Aires`.
 *
 * Every zone name that carries daylight-saving rules is of this shape. The
 * handful of IANA identifiers without a slash are either bare offsets (`GMT`,
 * `EST`, `UCT`) or country aliases for a zone that has a proper name anyway
 * (`Japan` -> `Asia/Tokyo`), so requiring the slash costs a household nothing
 * and removes the whole class of frozen-offset values in one rule.
 */
const REGION_LOCATION = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/;

/**
 * True when `value` is an IANA time-zone name this runtime can actually resolve.
 *
 * Three things are being refused here, and only the third is something `Intl`
 * would refuse on its own:
 *
 *  - Bare UTC offsets. `Intl.DateTimeFormat` ACCEPTS `'+05:00'`, `'-0600'` and
 *    `'GMT'` (verified on Node 22 and 24; `'+05:00'` resolves to `+05:00`), so
 *    Intl alone is not a sufficient check. An offset is wrong for a household
 *    because it is frozen: a booking made in September for a visit in November
 *    renders an hour off once the zone leaves daylight saving. Only a zone
 *    NAME carries the rules that make that transition correct.
 *  - Slash-less aliases, for the reason above REGION_LOCATION.
 *  - Names ICU does not know, which is what the `RangeError` catch tests.
 *
 * `UTC` is the one slash-less value allowed, because it is the honest thing to
 * render in when a household has no usable zone - see `resolveHouseholdTimeZone`
 * in apps/mcp-server/src/deps.ts.
 *
 * The ICU gate is only meaningful on a runtime with real ICU data. A Node built
 * `--without-intl` stubs `Intl` and silently accepts anything, which would make
 * this function return `true` for nonsense - `timeZoneDataProblem()` below is
 * the guard for that, and the server refuses to start when it reports one.
 */
export function isIanaTimeZone(value: string): boolean {
  if (value.toUpperCase() !== 'UTC' && !REGION_LOCATION.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The household's time zone: an IANA name, rejected at the boundary when it is
 * anything else. `HouseholdSchema` uses it, and both `Repository`
 * implementations parse that schema inside `putHousehold`, so an unknown or
 * offset-shaped zone cannot reach the table at all instead of surfacing later
 * as a wrong clock time nobody can trace.
 */
export const TimeZone = z.string().refine(isIanaTimeZone, {
  error: issue => `${JSON.stringify(issue.input)} is not an IANA time zone name (expected something like "America/Chicago", not a UTC offset)`
});

/** 2026-01-15T18:30Z is 12:30 PM in Chicago, and CST rather than CDT - so the probe pins the offset AND the abbreviation. */
const PROBE_INSTANT = Date.UTC(2026, 0, 15, 18, 30);
const PROBE_ZONE = 'America/Chicago';
const PROBE_EXPECTED = '12:30 PM CST';
const PROBE_NONSENSE = 'Nowhere/Imaginary';

/**
 * Why this exists: a Node with no ICU data does not THROW on
 * `toLocaleString(..., { timeZone })`. It ignores the option and hands back a
 * UTC-ish string, so every "localised" time in this server would quietly be the
 * UTC time with a household zone's name implied. That is the exact bug this
 * feature removes, reintroduced by a base image rather than by code, and
 * nothing in the test suite on a developer laptop would catch it.
 *
 * Returns a sentence naming the problem, or `null` when the runtime is sound.
 * Two independent probes, because the two failure modes look different:
 *   - a runtime that cannot APPLY a zone formats the probe instant wrongly;
 *   - a stubbed `Intl` that accepts everything cannot REJECT a bad zone, which
 *     silently disarms `isIanaTimeZone` above.
 *
 * `apps/mcp-server/src/deps.ts` calls this at startup and refuses to boot on a
 * non-null result. See FRICTION-LOG.md FL-040.
 */
export function timeZoneDataProblem(): string | null {
  let formatted: string;
  try {
    formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: PROBE_ZONE,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short'
    }).format(PROBE_INSTANT);
  } catch (err) {
    return `Intl could not format a time in ${PROBE_ZONE}: ${err instanceof Error ? err.message : String(err)}. This Node has no IANA time-zone data.`;
  }
  // ICU 72+ separates the time from AM/PM with U+202F, older ICU with a plain
  // space. Both are correct output; comparing without normalising would make
  // this probe fail on exactly the runtimes it is meant to pass.
  const normalised = normaliseSpaces(formatted);
  if (normalised !== PROBE_EXPECTED)
    return `Intl formatted ${new Date(PROBE_INSTANT).toISOString()} in ${PROBE_ZONE} as ${JSON.stringify(normalised)}, expected ${JSON.stringify(PROBE_EXPECTED)}. This Node has no IANA time-zone data, so every "localised" time would really be UTC.`;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: PROBE_NONSENSE });
  } catch {
    return null;
  }
  return `Intl accepted the nonexistent time zone ${JSON.stringify(PROBE_NONSENSE)}, so an invalid household zone cannot be rejected. This Node's Intl is a stub.`;
}

/**
 * The calendar date it is RIGHT NOW in `zone`, as `YYYY-MM-DD`.
 *
 * `instantIso.slice(0, 10)` - what this code used to do everywhere - is the
 * UTC date, and the two disagree for a real part of every day: at
 * 2026-09-13T02:00Z it is still 2026-09-12 in Chicago. Maintenance "overdue"
 * and "due today" are computed against this, and a task that flips to overdue
 * at 7 PM the evening before is the same class of wrong as quoting UTC aloud.
 *
 * Built from `formatToParts` rather than from a locale that happens to print
 * ISO order (`en-CA`), so the result does not depend on a locale's formatting
 * choices.
 */
export function todayInZone(instantIso: string, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instantIso));
  const find = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${find('year')}-${find('month')}-${find('day')}`;
}
