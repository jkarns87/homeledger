import { normaliseSpaces } from '@homeledger/core';

export const VOICE_MAX_ITEMS = 5;

export function speakList(items: string[], noun: string): string {
  const plural = (n: number) => (n === 1 ? noun : `${noun}s`);
  if (items.length === 0) return `No ${plural(0)}.`;
  const shown = items.slice(0, VOICE_MAX_ITEMS);
  const rest = items.length - shown.length;
  let joined: string;
  if (rest > 0) joined = `${shown.join(', ')}, and ${rest} more`;
  else if (shown.length === 1) joined = shown[0]!;
  else if (shown.length === 2) joined = `${shown[0]} and ${shown[1]}`;
  else joined = `${shown.slice(0, -1).join(', ')}, and ${shown[shown.length - 1]}`;
  return `${items.length} ${plural(items.length)}: ${joined}.`;
}

export function hasJson(text: string): boolean {
  return /[{}[\]]/.test(text);
}

/**
 * FLOATING CALENDAR DATES ONLY - `warrantyUntil`, `nextDueAt`, `lastDoneAt`,
 * `doneAt`. These are days, not instants: "the filter is due on August 28" is
 * true in every time zone at once, and the `T00:00:00Z` anchor plus
 * `timeZone: 'UTC'` here is what keeps the printed day equal to the stored
 * string.
 *
 * Do NOT "localise" these to the household zone. `2026-08-28T00:00:00Z`
 * rendered in America/Chicago is August 27, so doing so would move every due
 * date a day earlier - a real bug wearing the costume of a fix. Instants
 * (`windowStart`, `arrivedAt`, an event's `at`) are the values that DO carry a
 * zone, and they go through `speakZonedWindow`/`speakZonedInstant` below.
 */
export function speakDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** As `speakDate`, with the weekday. Floating calendar dates only - see the warning above. */
export function speakWeekdayDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

const dayFormat = (zone: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long', month: 'long', day: 'numeric' });
const clockFormat = (zone: string, withZoneName: boolean) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...(withZoneName ? { timeZoneName: 'short' as const } : {})
  });

/** The weekday and date an instant falls on IN THE HOUSEHOLD'S ZONE: "Tuesday, September 15". */
export function speakZonedDay(iso: string, zone: string): string {
  return normaliseSpaces(dayFormat(zone).format(new Date(iso)));
}

/**
 * The clock time of an instant in the household's zone, with the zone
 * abbreviation: "8:00 AM CDT".
 *
 * The abbreviation is not decoration. It is the difference between a time a
 * person can act on and the "1:00 PM (UTC)" that started this: it says WHOSE
 * clock, and it changes with the date (CST in January, CDT in June), which is
 * exactly what a stored offset could not do.
 */
export function speakZonedClock(iso: string, zone: string, withZoneName = true): string {
  return normaliseSpaces(clockFormat(zone, withZoneName).format(new Date(iso)));
}

/**
 * A service window, spoken: "Tuesday, September 15, 8:00 AM to 10:00 AM CDT".
 *
 * When the two ends land on different DAYS in the household's zone - a late
 * window near midnight - the end day is spoken too rather than silently
 * dropped, because "11:00 PM to 1:00 AM" with one date on it is a sentence a
 * person would read wrongly.
 */
export function speakZonedWindow(startIso: string, endIso: string, zone: string): string {
  const startDay = speakZonedDay(startIso, zone);
  const endDay = speakZonedDay(endIso, zone);
  const start = speakZonedClock(startIso, zone, false);
  const end = speakZonedClock(endIso, zone);
  return startDay === endDay ? `${startDay}, ${start} to ${end}` : `${startDay}, ${start} to ${endDay}, ${end}`;
}

/** One instant, spoken whole: "Tuesday, September 15, 8:07 AM CDT". */
export function speakZonedInstant(iso: string, zone: string): string {
  return `${speakZonedDay(iso, zone)}, ${speakZonedClock(iso, zone)}`;
}

/** Task types are snake_case; every underscore becomes a space, not just the first. */
export function taskWords(taskType: string): string {
  return taskType.replaceAll('_', ' ');
}
