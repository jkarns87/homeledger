import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as timers from 'node:timers';

// vi.useFakeTimers() does not intercept node:timers' own named exports (only
// globalThis's), and vi.spyOn cannot redefine them either (ESM module
// namespaces are non-configurable) — confirmed by hand before writing this.
// vi.mock is the one technique that reaches a module-level import like
// elicitation.ts's, and wrapping the real implementation keeps every other
// test's actual timing intact; only the call bookkeeping is new. vi.mock
// calls are hoisted above the imports below, so elicitation.ts picks up the
// wrapped module even though this call reads after them on the page.
vi.mock('node:timers', async importOriginal => {
  const actual = await importOriginal<typeof import('node:timers')>();
  return { ...actual, setTimeout: vi.fn(actual.setTimeout), clearTimeout: vi.fn(actual.clearTimeout) };
});

import { ElicitationRegistry, ElicitationTimeoutError, TurnClosedError } from '../src/server/elicitation.js';

const accept = { action: 'accept', content: { provider: 'prov_kettle_water' } } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ElicitationRegistry', () => {
  it('resolves the question the answer names, with the answer', async () => {
    const registry = new ElicitationRegistry();
    registry.open('t1');
    const q = registry.ask('t1', 1000);
    expect(registry.answer('t1', q.elicitationId, accept)).toBe('delivered');
    await expect(q.answer).resolves.toEqual(accept);
  });

  it('keeps two questions on one turn independent', async () => {
    const registry = new ElicitationRegistry();
    registry.open('t1');
    const first = registry.ask('t1', 1000);
    const second = registry.ask('t1', 1000);
    expect(second.elicitationId).not.toBe(first.elicitationId);
    registry.answer('t1', second.elicitationId, { action: 'decline' });
    await expect(second.answer).resolves.toEqual({ action: 'decline' });
    registry.answer('t1', first.elicitationId, accept);
    await expect(first.answer).resolves.toEqual(accept);
  });

  it('reports an answer for a turn it does not hold, and resolves nothing', async () => {
    const registry = new ElicitationRegistry();
    registry.open('t1');
    const q = registry.ask('t1', 1000);
    expect(registry.answer('t2', q.elicitationId, accept)).toBe('unknown-turn');
    let settled = false;
    // Caught rather than left floating: q.answer rejects later in this test
    // (via close()), and an unhandled rejection on the .then() chain would
    // fail the run even though every assertion below passes.
    q.answer.then(
      () => {
        settled = true;
      },
      () => {}
    );
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    registry.close('t1', 'test over');
    await expect(q.answer).rejects.toBeInstanceOf(TurnClosedError);
  });

  it('reports a second answer to the same question as unknown rather than delivering it twice', async () => {
    const registry = new ElicitationRegistry();
    registry.open('t1');
    const q = registry.ask('t1', 1000);
    expect(registry.answer('t1', q.elicitationId, accept)).toBe('delivered');
    expect(registry.answer('t1', q.elicitationId, { action: 'cancel' })).toBe('unknown-question');
    await expect(q.answer).resolves.toEqual(accept);
  });

  it('rejects every outstanding question when the turn closes, with the reason', async () => {
    const registry = new ElicitationRegistry();
    registry.open('t1');
    const first = registry.ask('t1', 1000);
    const second = registry.ask('t1', 1000);
    registry.close('t1', 'the browser disconnected');
    await expect(first.answer).rejects.toThrow('the browser disconnected');
    await expect(second.answer).rejects.toThrow('the browser disconnected');
    expect(registry.has('t1')).toBe(false);
  });

  it('rejects a question nobody answers inside its budget', async () => {
    const registry = new ElicitationRegistry();
    registry.open('t1');
    const q = registry.ask('t1', 20);
    await expect(q.answer).rejects.toBeInstanceOf(ElicitationTimeoutError);
    // The slot is gone, so a late click is reported rather than delivered to a
    // promise that has already rejected.
    expect(registry.answer('t1', q.elicitationId, accept)).toBe('unknown-question');
  });

  it('refuses to ask on a turn that was never opened', () => {
    const registry = new ElicitationRegistry();
    expect(() => registry.ask('t9', 1000)).toThrow(TurnClosedError);
  });

  it('closing a turn that is not open is a no-op, not a throw', () => {
    const registry = new ElicitationRegistry();
    expect(() => registry.close('t9', 'gone')).not.toThrow();
  });
});

// A settled promise ignores every later resolve()/reject() call by spec, so
// none of the tests above can tell an implementation that forgets to clear
// its native timer from one that clears it correctly: both leave q.answer
// looking identical from the outside. The only way to see the difference is
// to watch the timer itself, which is what this block does. Each test here
// mutation-checked clean against the version that drops the clearTimeout it
// is named for (see task-4-report.md) — every one of them fails without it.
describe('ElicitationRegistry timer hygiene', () => {
  it('clears its native timer once a question is answered', async () => {
    const registry = new ElicitationRegistry();
    registry.open('t1');
    const q = registry.ask('t1', 1000);
    expect(timers.setTimeout).toHaveBeenCalledTimes(1);
    expect(timers.clearTimeout).not.toHaveBeenCalled();
    registry.answer('t1', q.elicitationId, accept);
    await expect(q.answer).resolves.toEqual(accept);
    expect(timers.clearTimeout).toHaveBeenCalledTimes(1);
  });

  it('clears every outstanding timer when the turn closes, not only the promises', async () => {
    const registry = new ElicitationRegistry();
    registry.open('t1');
    const first = registry.ask('t1', 1000);
    const second = registry.ask('t1', 1000);
    expect(timers.clearTimeout).not.toHaveBeenCalled();
    registry.close('t1', 'gone');
    expect(timers.clearTimeout).toHaveBeenCalledTimes(2);
    await expect(first.answer).rejects.toBeInstanceOf(TurnClosedError);
    await expect(second.answer).rejects.toBeInstanceOf(TurnClosedError);
  });

  it('an answer that lands before a soon-due timeout wins the race outright, and the timer never fires', async () => {
    const registry = new ElicitationRegistry();
    registry.open('t1');
    // 5ms is long enough for a real timer to exist and short enough that, if
    // answer() did not win outright, the suite would see the timeout instead.
    const q = registry.ask('t1', 5);
    // Answered in the same synchronous turn ask() returned in — before the
    // event loop has had any chance to run the timer's callback — so a
    // genuine ordering is being proven, not a fast-enough coincidence.
    expect(registry.answer('t1', q.elicitationId, accept)).toBe('delivered');
    await expect(q.answer).resolves.toEqual(accept);
    expect(timers.clearTimeout).toHaveBeenCalledTimes(1);
    // Wait past the original 5ms deadline. If the timer had not really been
    // cancelled, it would fire now and reject an already-resolved promise —
    // silently, by spec, which is exactly why this could not be seen any
    // other way. What is observable is that nothing about the slot changes:
    // a second answer to the same id is still reported, not delivered.
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(registry.answer('t1', q.elicitationId, { action: 'cancel' })).toBe('unknown-question');
  });
});
