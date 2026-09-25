'use client';

import type { Progress } from '../lib/transcript.js';

/**
 * How far along a call that reports its own progress has got.
 *
 * Its own file rather than a second export of the elicitation card: it is
 * shown while the server is WORKING, and the card is shown while the server is
 * WAITING, so the two are never on screen for the same reason and one can
 * change without the other. `book_service`'s availability check reports 0 of 3
 * through 3 of 3 (`apps/mcp-server/src/progress.ts`); the numbers come from
 * the notification, never from a timer, because a bar that moves on a timer is
 * a bar that lies when the server is slow.
 */
export function ProgressMeter({ progress }: { progress: Progress }) {
  return (
    <div className="card progress" data-testid="progress">
      <div role="progressbar" aria-valuenow={progress.progress} aria-valuemin={0} aria-valuemax={progress.total} aria-label="Checking availability">
        <span className="bar" style={{ width: `${progress.total === 0 ? 0 : (progress.progress / progress.total) * 100}%` }} />
      </div>
      <p className="muted">{progress.message}</p>
    </div>
  );
}
