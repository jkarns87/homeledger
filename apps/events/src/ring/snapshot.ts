import type { SnapshotStatusValue } from '@homeledger/core';
import type { RingApi } from './client.js';

/** Spec §5: retry for up to about a minute. The actual press-to-image delay is undocumented, so it is measured, not assumed. */
export const SNAPSHOT_BUDGET_MS = 60_000;
export const SNAPSHOT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000];
const LOOK_BACK_MS = 5_000;
const LOOK_AHEAD_MS = 30_000;

export function imageKind(bytes: Buffer): 'jpeg' | 'png' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return null;
}

export interface SnapshotResult {
  status: SnapshotStatusValue;
  bytes: Buffer | null;
  contentType: string | null;
  latencyMs: number;
  attempts: number;
  lastRefusal: string | null;
}

/**
 * Asks Ring for the latest image between five seconds before the ring and
 * thirty after it (never past now), until an image arrives or the budget is
 * spent. 416/425 mean "not yet" and 5xx/network mean "try again"; 403 and
 * other 4xx are final. `latencyMs` runs from the ring itself, so it is the
 * figure the spec asks to report: how long a real press takes to become a
 * retrievable picture.
 */
export async function fetchDoorbellSnapshot(
  deps: { requestImage: RingApi['requestImage']; now: () => number; sleep: (ms: number) => Promise<void> },
  input: { deviceId: string; eventAtMs: number },
  budgetMs: number = SNAPSHOT_BUDGET_MS
): Promise<SnapshotResult> {
  const started = deps.now();
  let attempts = 0;
  let lastRefusal: string | null = null;
  let lastTransient: 'none-in-window' | 'error' = 'error';
  const done = (status: SnapshotStatusValue, bytes: Buffer | null = null, contentType: string | null = null): SnapshotResult => ({
    status,
    bytes,
    contentType,
    latencyMs: Math.max(0, deps.now() - input.eventAtMs),
    attempts,
    lastRefusal
  });

  for (;;) {
    attempts += 1;
    const window = { startMs: input.eventAtMs - LOOK_BACK_MS, endMs: Math.min(input.eventAtMs + LOOK_AHEAD_MS, deps.now()) };
    let answer;
    try {
      answer = await deps.requestImage(input.deviceId, window);
    } catch (err) {
      answer = null;
      lastRefusal = `network: ${err instanceof Error ? err.message : String(err)}`;
      lastTransient = 'error';
    }
    if (answer?.kind === 'image') {
      return imageKind(answer.bytes) ? done('ok', answer.bytes, answer.contentType) : done('encrypted');
    }
    if (answer?.kind === 'refused') {
      lastRefusal = `${answer.status}${answer.code ? ` ${answer.code}` : ''}`;
      if (answer.status === 403) return done('forbidden');
      if (answer.status === 416 || answer.status === 425) lastTransient = 'none-in-window';
      else if (answer.status >= 500) lastTransient = 'error';
      else return done('error');
    }
    const delay = SNAPSHOT_BACKOFF_MS[Math.min(attempts - 1, SNAPSHOT_BACKOFF_MS.length - 1)]!;
    if (deps.now() - started + delay > budgetMs) return done(lastTransient);
    await deps.sleep(delay);
  }
}
