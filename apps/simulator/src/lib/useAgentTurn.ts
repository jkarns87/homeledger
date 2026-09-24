'use client';

import { useCallback, useRef, useState } from 'react';
import { createSseDecoder } from '../shared/events.js';
import { INITIAL_STATE, askedByUser, reduceTurn, type AgentState } from './transcript.js';

export interface AgentTurn {
  state: AgentState;
  ask(text: string): Promise<void>;
  answer(action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>): Promise<void>;
}

async function failureMessage(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.length > 0) return parsed.message;
  } catch {
    /* a non-JSON error body is still worth showing, trimmed */
  }
  return body.slice(0, 400) || `the server answered ${response.status} with no message`;
}

/** The sentence shown when the stream itself never delivered `turn-finished` - the connection closed or errored before the turn could say it was done. */
function connectionEndedMessage(cause: unknown): string {
  const base = 'The connection ended before the turn finished.';
  if (cause === undefined) return base;
  return `${base} ${cause instanceof Error ? cause.message : String(cause)}`;
}

export function useAgentTurn(fetchImpl: typeof fetch = fetch): AgentTurn {
  const [state, setState] = useState<AgentState>(INITIAL_STATE);
  // Held in a ref as well as in state so `answer` can read the turn id without
  // being re-created on every event, which would restart the stream reader.
  const latest = useRef<AgentState>(INITIAL_STATE);
  const apply = useCallback((next: (previous: AgentState) => AgentState) => {
    setState(previous => {
      const value = next(previous);
      latest.current = value;
      return value;
    });
  }, []);

  const ask = useCallback(
    async (text: string) => {
      apply(previous => askedByUser(previous, text));
      let response: Response;
      try {
        response = await fetchImpl('/api/agent/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      } catch (error) {
        apply(previous => reduceTurn(reduceTurn(previous, { type: 'turn-failed', message: String(error) }), { type: 'turn-finished', turnId: '' }));
        return;
      }
      if (!response.ok || !response.body) {
        const message = await failureMessage(response);
        apply(previous => reduceTurn(reduceTurn(previous, { type: 'turn-failed', message }), { type: 'turn-finished', turnId: '' }));
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const decode = createSseDecoder();
      // Tracked from the events this call itself decoded, never from React
      // state: state updates are asynchronous, so reading `state.running` or
      // `latest.current` here could observe a stale value left by an earlier
      // turn and either skip the failure this loop needs to raise, or raise
      // one for a turn that already finished cleanly.
      let finished = false;
      let readFailure: unknown;
      // Read and apply as events arrive. The stream stays open across every
      // question this turn asks, and each answer is sent from `answer()` on a
      // separate request while this loop is still reading.
      //
      // Two silent-failure holes live here without the try/catch and the
      // post-loop check below: the stream can end (`done`) without ever
      // sending `turn-finished` (a proxy or the server process going away
      // mid-turn), and `reader.read()` itself can reject (a socket reset).
      // Either one, left unhandled, leaves `running: true` forever with
      // nothing on the transcript explaining why - a frozen composer with no
      // message is a papered-over failure exactly as much as a swallowed
      // `tool-failed` would be.
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const events = decode(decoder.decode(value, { stream: true }));
          for (const event of events) {
            if (event.type === 'turn-finished') finished = true;
            apply(previous => reduceTurn(previous, event));
          }
        }
      } catch (error) {
        readFailure = error;
      }
      if (!finished) {
        apply(previous =>
          reduceTurn(reduceTurn(previous, { type: 'turn-failed', message: connectionEndedMessage(readFailure) }), { type: 'turn-finished', turnId: '' })
        );
      }
    },
    [apply, fetchImpl]
  );

  const answer = useCallback(
    async (action: 'accept' | 'decline' | 'cancel', content: Record<string, unknown> = {}) => {
      const current = latest.current;
      if (!current.pending || !current.turnId) return;
      let response: Response;
      try {
        response = await fetchImpl('/api/agent/answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ turnId: current.turnId, elicitationId: current.pending.elicitationId, action, content })
        });
      } catch (error) {
        // The turn's own SSE stream is still open and will end on its own -
        // no `turn-finished` here. This is the answer-request twin of `ask`'s
        // fetch-failure branch, and it exists because Task 12 fires this as
        // `void turn.answer(...)` from a card click: with no catch, a network
        // failure here is an unhandled rejection and the card just sits there
        // having done nothing.
        apply(previous =>
          reduceTurn(previous, { type: 'turn-failed', message: `The answer could not be sent. ${error instanceof Error ? error.message : String(error)}` })
        );
        return;
      }
      if (response.ok) return;
      // 409 unknown-turn is the FL-039 shape arriving in a browser: the click
      // reached a server that is not running this turn. It is shown, in the
      // server's own words, rather than leaving a card that does nothing.
      const message = await failureMessage(response);
      apply(previous => reduceTurn(previous, { type: 'turn-failed', message }));
    },
    [apply, fetchImpl]
  );

  return { state, ask, answer };
}
