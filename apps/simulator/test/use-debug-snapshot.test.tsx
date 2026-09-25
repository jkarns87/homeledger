import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDebugSnapshot } from '../src/lib/useDebugSnapshot.js';

function debugResponse(): Response {
  return new Response(
    JSON.stringify({ endpointHost: 'h', endpointPath: '/p', addressing: 'url', protocolVersion: null, sessionId: null, rebuilds: 0, tools: [], log: [] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useDebugSnapshot', () => {
  it('fetches more than once while live, and stops the moment it is not', async () => {
    // Fix round 1, Important 2: the first draft only re-read /api/debug on
    // the running -> idle transition, so the log's `← elicitation/create`
    // and `← notifications/progress` lines - the whole point of a transport
    // tap rather than a client-side call list - never appeared until the
    // turn they explain was already over. This proves the opposite property
    // with a fake clock: repeated reads while `live` is true, and the
    // interval actually cleared (not merely slowed) the moment it goes false.
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => debugResponse());

    const { rerender } = renderHook(({ live }: { live: boolean }) => useDebugSnapshot(live, fetchImpl as unknown as typeof fetch, 1000), {
      initialProps: { live: true }
    });

    // the immediate read on mount, before any tick
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchImpl.mock.calls).toHaveLength(1);

    // three more 1s ticks while the turn is still live
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    const whileLive = fetchImpl.mock.calls.length;

    // the turn ends: `live` goes false. The transition still reads once...
    rerender({ live: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const atIdle = fetchImpl.mock.calls.length;
    expect(atIdle).toBe(whileLive + 1);

    // ...and then polling has genuinely stopped, however long we wait.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchImpl.mock.calls).toHaveLength(atIdle);
  });
});
