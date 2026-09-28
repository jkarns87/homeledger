'use client';

import { useEffect } from 'react';
import type { TurnEvent } from '../shared/events.js';
import { reduceTurn, type AgentState } from './transcript.js';

/** Subscribes to /api/agent/events for the life of the page. EventSource reconnects on its own; the server resends the push status on every open. */
export function useHomeEvents(
  apply: (next: (previous: AgentState) => AgentState) => void,
  EventSourceImpl: typeof EventSource | undefined = typeof EventSource === 'undefined' ? undefined : EventSource
): void {
  useEffect(() => {
    if (!EventSourceImpl) return;
    const source = new EventSourceImpl('/api/agent/events');
    source.onmessage = message => {
      let event: TurnEvent;
      try {
        event = JSON.parse(String(message.data)) as TurnEvent;
      } catch {
        return;
      }
      apply(previous => reduceTurn(previous, event));
    };
    return () => source.close();
  }, [apply, EventSourceImpl]);
}
