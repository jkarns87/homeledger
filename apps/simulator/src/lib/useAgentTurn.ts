'use client';

import { useCallback, useState } from 'react';
import { createSseDecoder } from '../shared/events.js';
import { INITIAL_STATE, askedByUser, reduceTurn, type AgentState, type PendingQuestion } from './transcript.js';

export interface AgentTurn {
  state: AgentState;
  /** False until `reset()` has settled, either way. The composer waits on it, so a first question cannot race the reset and be aborted by it. */
  ready: boolean;
  ask(text: string): Promise<void>;
  /** Answers THIS question - the one on the card that was clicked - never whichever question the state holds by the time the request is built. */
  answer(question: PendingQuestion, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>): Promise<void>;
  /** Asks the server to start the conversation over. Called once when the page loads. */
  reset(): Promise<void>;
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
  const [ready, setReady] = useState(false);
  // No ref of the latest state any more. `answer` used to read the question id
  // from one, so a second click on a card already answered - or a click that
  // landed after the next question was folded in - posted whatever question
  // the state held THEN (final review I2). The card now says which question
  // it is answering.
  const apply = useCallback((next: (previous: AgentState) => AgentState) => setState(next), []);

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
    async (question: PendingQuestion, action: 'accept' | 'decline' | 'cancel', content: Record<string, unknown> = {}) => {
      let response: Response;
      try {
        response = await fetchImpl('/api/agent/answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ turnId: question.turnId, elicitationId: question.elicitationId, action, content })
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

  const reset = useCallback(async () => {
    try {
      const response = await fetchImpl('/api/agent/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!response.ok) {
        const message = await failureMessage(response);
        apply(previous => reduceTurn(previous, { type: 'turn-failed', message: `A fresh conversation could not be started. ${message}` }));
      }
    } catch (error) {
      apply(previous =>
        reduceTurn(previous, {
          type: 'turn-failed',
          message: `A fresh conversation could not be started. ${error instanceof Error ? error.message : String(error)}`
        })
      );
    } finally {
      setReady(true);
    }
  }, [apply, fetchImpl]);

  return { state, ready, ask, answer, reset };
}
