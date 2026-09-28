import type { SnapshotStatusValue, Visit } from './schemas.js';

/** Spec §5: the visit's window, widened by thirty minutes on each side. */
export const ARRIVAL_SLACK_MS = 30 * 60_000;

/**
 * The query range for `listVisitsInWindow`. That query returns every visit
 * whose window overlaps [from, to]; with from/to = event ± slack, "overlaps"
 * is exactly "the event falls inside the window ± slack", so the repository
 * returns the candidates and `pickArrivalVisit` chooses among them.
 */
export function arrivalWindowFor(eventAtIso: string): { fromIso: string; toIso: string } {
  const at = Date.parse(eventAtIso);
  return { fromIso: new Date(at - ARRIVAL_SLACK_MS).toISOString(), toIso: new Date(at + ARRIVAL_SLACK_MS).toISOString() };
}

/**
 * The scheduled visit a doorbell event belongs to, or null. Compares instants,
 * never calendar dates, so the household's zone and daylight time cannot move a
 * match. Several candidates: the one whose window starts nearest the event;
 * an exact tie goes to the earlier start.
 */
export function pickArrivalVisit(candidates: readonly Visit[], eventAtIso: string): Visit | null {
  const at = Date.parse(eventAtIso);
  const eligible = candidates.filter(
    v => v.status === 'scheduled' && Date.parse(v.windowStart) - ARRIVAL_SLACK_MS <= at && at <= Date.parse(v.windowEnd) + ARRIVAL_SLACK_MS
  );
  eligible.sort((x, y) => Math.abs(Date.parse(x.windowStart) - at) - Math.abs(Date.parse(y.windowStart) - at) || x.windowStart.localeCompare(y.windowStart));
  return eligible[0] ?? null;
}

const SENTENCES: Record<SnapshotStatusValue, string> = {
  ok: 'Photo from the doorbell at the moment of the ring.',
  encrypted: "The doorbell's video encryption kept the photo private, so there is no picture. The arrival was still recorded.",
  'none-in-window': 'The doorbell had no picture from that moment.',
  forbidden: 'Ring did not allow HomeLedger to fetch a photo from that moment.',
  error: 'The doorbell photo could not be fetched.'
};

/** The card's line for a snapshot outcome. Null only before an arrival. */
export function snapshotSentence(status: SnapshotStatusValue | null): string | null {
  return status === null ? null : SENTENCES[status];
}

/** Spec §5: the link to the booked provider comes from HomeLedger's matching, never from the image — and the card says so. */
export function arrivalMatchNote(input: { windowLabel: string; providerName: string }): string {
  return `Matches your ${input.windowLabel} visit from ${input.providerName}. HomeLedger matched it by the time of the ring, not by the photo.`;
}
