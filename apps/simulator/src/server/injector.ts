import type { PushPayload } from '@homeledger/core';
import type { TurnEvent } from '../shared/events.js';
import { HOME_EVENT_PREFIX } from './prompt.js';

/** The injected turn's text: which record, and which tool reads it. The model reads the record over MCP; the push never carries it (spec §7, FL-039). */
export function homeEventNote(pushes: readonly PushPayload[]): string {
  return pushes
    .map(p =>
      p.cardType === 'visit.arrived'
        ? `${HOME_EVENT_PREFIX} The doorbell matched a booked visit, ${p.id}. Call get_visit with that id and tell the household what it returned.`
        : `${HOME_EVENT_PREFIX} An alert was raised, ${p.id}. Call recent_events and tell the household what it returned about that alert.`
    )
    .join('\n');
}

export type TurnStarter = (text: string, emit: (event: TurnEvent) => void) => { done: Promise<void> } | 'busy';

export interface Injector {
  enqueue(p: PushPayload): void;
  idle(): Promise<void>;
  pending(): number;
}

/**
 * Spec §7 turn discipline: a push waits for the running turn; pushes that
 * arrive while waiting are coalesced into one turn; a repeat of a queued id is
 * dropped. Every push is announced on the hub at once, so the display shows
 * it even while it waits.
 */
export function createInjector(deps: {
  activeTurn: () => { settled: Promise<void> } | undefined;
  startTurn: TurnStarter;
  publish: (e: TurnEvent) => void;
  log?: (m: string) => void;
}): Injector {
  const queue: PushPayload[] = [];
  let draining: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const running = deps.activeTurn();
      if (running) {
        await running.settled;
        continue;
      }
      const batch = queue.splice(0);
      const started = deps.startTurn(homeEventNote(batch), deps.publish);
      if (started === 'busy') {
        queue.unshift(...batch);
        await (deps.activeTurn()?.settled ?? new Promise(resolve => setTimeout(resolve, 50)));
        continue;
      }
      await started.done;
    }
  };

  const kick = () => {
    if (draining) return;
    draining = drain()
      .catch(err => deps.log?.(`push: injected turn failed (${err instanceof Error ? err.message : String(err)})`))
      .finally(() => {
        draining = null;
        if (queue.length > 0) kick();
      });
  };

  return {
    enqueue(p) {
      deps.publish({ type: 'push-received', cardType: p.cardType, id: p.id });
      if (!queue.some(q => q.id === p.id)) queue.push(p);
      kick();
    },
    idle: async () => {
      while (draining) await draining;
    },
    pending: () => queue.length
  };
}
