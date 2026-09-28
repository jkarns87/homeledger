import { describe, expect, it } from 'vitest';
import { createInjector, homeEventNote } from '../src/server/injector.js';
import type { TurnEvent } from '../src/shared/events.js';

const visit = { cardType: 'visit.arrived' as const, id: 'visit_abcdefghijklmnop' };
const alert = { cardType: 'alert.raised' as const, id: 'alert_abcdefghijklmnop' };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => (resolve = r));
  return { promise, resolve };
}

/** `done` is what each started turn's `done` is; resolved at once by default. */
function harness(done: () => Promise<void> = () => Promise.resolve()) {
  let active: { settled: Promise<void> } | undefined;
  const texts: string[] = [];
  const published: TurnEvent[] = [];
  const injector = createInjector({
    activeTurn: () => active,
    startTurn: (text, emit) => {
      if (active) return 'busy';
      texts.push(text);
      emit({ type: 'turn-started', turnId: `t${texts.length}` });
      emit({ type: 'turn-finished', turnId: `t${texts.length}` });
      return { done: done() };
    },
    publish: e => published.push(e)
  });
  return {
    injector,
    texts,
    published,
    setActive: (a: { settled: Promise<void> } | undefined) => {
      active = a;
    }
  };
}

describe('homeEventNote', () => {
  it('names each record and the tool that reads it, one line per push', () => {
    expect(homeEventNote([visit, alert])).toBe(
      '[Home event] The doorbell matched a booked visit, visit_abcdefghijklmnop. Call get_visit with that id and tell the household what it returned.\n' +
        '[Home event] An alert was raised, alert_abcdefghijklmnop. Call recent_events and tell the household what it returned about that alert.'
    );
  });
});

describe('injected turns (spec §7 turn discipline)', () => {
  it('runs one turn for a push when nothing is running, after announcing the push', async () => {
    const h = harness();
    h.injector.enqueue(visit);
    await h.injector.idle();
    expect(h.texts).toEqual([homeEventNote([visit])]);
    expect(h.published.map(e => e.type)).toEqual(['push-received', 'turn-started', 'turn-finished']);
    expect(h.published[0]).toEqual({ type: 'push-received', cardType: 'visit.arrived', id: 'visit_abcdefghijklmnop' });
  });

  it('waits for a running turn to settle, then coalesces everything that arrived into one turn', async () => {
    const h = harness();
    const running = deferred();
    h.setActive({ settled: running.promise });
    h.injector.enqueue(visit);
    h.injector.enqueue(alert);
    h.injector.enqueue(visit); // a repeat while queued
    await new Promise(r => setImmediate(r));
    expect(h.texts).toEqual([]);
    expect(h.injector.pending()).toBe(2);
    h.setActive(undefined);
    running.resolve();
    await h.injector.idle();
    expect(h.texts).toEqual([homeEventNote([visit, alert])]);
  });

  it('keeps going when a push lands just as the drain finishes', async () => {
    // The window this guards is the few microtasks between the drain loop
    // finding the queue empty and its `finally` clearing `draining`: a push
    // enqueued there sees a drain still in progress, so `enqueue` does not
    // start one, and only the `finally` re-kick picks it up. Swept across every
    // tick from the turn settling to well past the drain's end, so the test
    // lands in that window without depending on exactly how many ticks it is.
    for (let ticks = 0; ticks <= 8; ticks++) {
      const turn = deferred();
      const h = harness(() => turn.promise);
      h.injector.enqueue(visit);
      turn.resolve();
      for (let i = 0; i < ticks; i++) await Promise.resolve();
      h.injector.enqueue(alert);
      await h.injector.idle();
      expect(h.texts, `alert enqueued ${ticks} ticks after the turn settled`).toEqual([homeEventNote([visit]), homeEventNote([alert])]);
    }
  });
});
