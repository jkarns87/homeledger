'use client';

import { useEffect, useState } from 'react';
import type { DebugSnapshot } from '../components/DebugDrawer.js';

/**
 * Reads `/api/debug`, polling while `live` is true.
 *
 * Fix round 1, Important 2: a single read on the running -> idle transition
 * is not what spec section 7 asks for. It asks for a LIVE JSON-RPC log, and
 * the whole reason the drawer taps the transport rather than listing calls
 * this side made is to show a `← elicitation/create` or a
 * `← notifications/progress` line arriving in the middle of a `tools/call`
 * that stays open for two minutes (FL-033) - `DebugDrawer`'s own comment
 * says as much. A drawer that only refreshed once the turn was already over
 * showed none of that until there was nothing left to explain.
 *
 * `live` is `running || pending !== null` in `page.tsx`: the interval starts
 * the moment a turn begins and keeps running through every elicitation
 * inside it, not only while a tool call is literally in flight. The idle
 * read on every transition (including into `live`) is kept as well as the
 * interval, not replaced by it, so a rebuild that lands between two ticks or
 * right as the turn ends is still visible one read later rather than lost to
 * a race between the last tick and the state settling.
 *
 * `fetchImpl` and `intervalMs` are parameters, not hard-coded, for the same
 * reason `useAgentTurn` takes `fetchImpl`: a fake clock and a fake fetch are
 * how this is proven to poll and to stop, without a live server or a real
 * second of wall-clock time in the test run.
 */
export function useDebugSnapshot(live: boolean, fetchImpl: typeof fetch = fetch, intervalMs = 1000): DebugSnapshot | null {
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void fetchImpl('/api/debug')
        .then(response => (response.ok ? (response.json() as Promise<DebugSnapshot>) : null))
        .then(value => {
          if (!cancelled) setSnapshot(value);
        })
        .catch(() => undefined);
    };
    load();
    const interval = live ? setInterval(load, intervalMs) : undefined;
    return () => {
      cancelled = true;
      if (interval !== undefined) clearInterval(interval);
    };
  }, [live, fetchImpl, intervalMs]);

  return snapshot;
}
