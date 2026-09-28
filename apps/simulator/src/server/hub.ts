import type { TurnEvent } from '../shared/events.js';

/** Fan-out from the process that holds the conversation to every open /api/agent/events stream. */
export interface EventHub {
  subscribe(listener: (event: TurnEvent) => void): () => void;
  publish(event: TurnEvent): void;
  size(): number;
}

export function createEventHub(): EventHub {
  const listeners = new Set<(event: TurnEvent) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    publish(event) {
      for (const listener of [...listeners]) listener(event);
    },
    size: () => listeners.size
  };
}
