import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Transcript } from '../src/components/Transcript.js';
import { INITIAL_STATE, reduceTurn } from '../src/lib/transcript.js';
import { useAgentTurn } from '../src/lib/useAgentTurn.js';
import { UNKNOWN_TURN_MESSAGE } from '../src/server/http.js';
import { encodeSse, type TurnEvent } from '../src/shared/events.js';

function streamOf(events: TurnEvent[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode(encodeSse(event)));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * A stream that stays open after its initial events, the way the real server
 * does for as long as a turn holds an open elicitation (FL-033) - closing it
 * is a separate step the test takes once it is done watching the open state.
 * `streamOf` above is only ever safe to `await ask()` all the way through
 * because it closes itself immediately; anything that needs to observe state
 * *while* a turn is still in flight (an open `pending` question, an
 * in-progress read loop) needs this instead.
 */
function openStream(events: TurnEvent[]): { response: Response; finish(extra?: TurnEvent[]): void } {
  const encoder = new TextEncoder();
  let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      for (const event of events) controller.enqueue(encoder.encode(encodeSse(event)));
    }
  });
  const response = new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  return {
    response,
    finish(extra = []) {
      for (const event of extra) controllerRef.enqueue(encoder.encode(encodeSse(event)));
      controllerRef.close();
    }
  };
}

/** A stream whose body errors instead of closing cleanly - the network-drop half of ruling 2. */
function erroringStream(events: TurnEvent[], error: Error): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode(encodeSse(event)));
      controller.error(error);
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('useAgentTurn', () => {
  it('posts the question and folds every streamed event into the state', async () => {
    const fetchImpl = vi.fn(async () =>
      streamOf([
        { type: 'turn-started', turnId: 't1' },
        { type: 'assistant-text', text: 'Six appliances.' },
        { type: 'turn-finished', turnId: 't1' }
      ])
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useAgentTurn(fetchImpl));
    await act(async () => {
      await result.current.ask('what appliances do we have');
    });

    await waitFor(() => expect(result.current.state.running).toBe(false));
    expect(result.current.state.entries.map(e => e.kind)).toEqual(['user', 'assistant']);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe('/api/agent/turn');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ text: 'what appliances do we have' });
  });

  it('reports a non-200 as a visible failure instead of an empty answer', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Your AWS SSO session expired.' }), { status: 503 })) as unknown as typeof fetch;
    const { result } = renderHook(() => useAgentTurn(fetchImpl));
    await act(async () => {
      await result.current.ask('hello');
    });
    const notice = result.current.state.entries.find(e => e.kind === 'notice');
    expect(notice).toMatchObject({ tone: 'failure' });
    expect(notice && notice.kind === 'notice' && notice.text).toContain('Your AWS SSO session expired.');
    expect(result.current.state.running).toBe(false);
  });

  it('posts an answer against the turn that asked', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const stream = openStream([
      { type: 'turn-started', turnId: 't7' },
      { type: 'elicitation-opened', callId: 'c1', elicitationId: 'e1', prompt: 'Who?', field: 'provider', kind: 'choice', options: [] }
    ]);
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      if (url === '/api/agent/turn') return stream.response;
      return new Response('{"ok":true}', { status: 202 });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useAgentTurn(fetchImpl));
    let askPromise!: Promise<void>;
    act(() => {
      askPromise = result.current.ask('book a plumber');
    });
    await waitFor(() => expect(result.current.state.pending).not.toBeNull());
    await act(async () => {
      await result.current.answer('accept', { provider: 'prov_a' });
    });
    const answer = calls.find(([url]) => url === '/api/agent/answer');
    expect(answer).toBeDefined();
    expect(JSON.parse(String(answer![1].body))).toEqual({ turnId: 't7', elicitationId: 'e1', action: 'accept', content: { provider: 'prov_a' } });

    // Close out the still-open stream so the ask() call this test started resolves before the test ends.
    await act(async () => {
      stream.finish([{ type: 'turn-finished', turnId: 't7' }]);
      await askPromise;
    });
  });

  // RULING 2(a) (STREAM-END, task-11 brief): the stream can end (`done`) without
  // ever sending `turn-finished` - a network intermediary closing the
  // connection, or a server process dying mid-turn. Left unhandled, `running`
  // stays `true` forever with nothing on the transcript explaining why.
  it('shows a failure and stops running when the stream ends without a turn-finished', async () => {
    const fetchImpl = vi.fn(async () =>
      streamOf([
        { type: 'turn-started', turnId: 't1' },
        { type: 'assistant-text', text: 'Partway there.' }
      ])
    ) as unknown as typeof fetch;
    const { result } = renderHook(() => useAgentTurn(fetchImpl));
    await act(async () => {
      await result.current.ask('what appliances do we have');
    });
    await waitFor(() => expect(result.current.state.running).toBe(false));
    const notice = result.current.state.entries.find(e => e.kind === 'notice');
    expect(notice).toMatchObject({ tone: 'failure' });
    expect(notice && notice.kind === 'notice' && notice.text).toContain('connection ended before the turn finished');
  });

  // RULING 2(b) (READ-REJECT, task-11 brief): `reader.read()` itself can
  // reject - a socket reset, not merely a clean close. An uncaught rejection
  // here has the identical symptom as 2(a): `running` never returns to `false`
  // and nothing renders, except this time it is an unhandled promise
  // rejection rather than a quiet `done`.
  it('shows a failure and stops running when the read itself rejects', async () => {
    const fetchImpl = vi.fn(async () => erroringStream([{ type: 'turn-started', turnId: 't1' }], new Error('socket hang up'))) as unknown as typeof fetch;
    const { result } = renderHook(() => useAgentTurn(fetchImpl));
    await act(async () => {
      await result.current.ask('what appliances do we have');
    });
    await waitFor(() => expect(result.current.state.running).toBe(false));
    const notice = result.current.state.entries.find(e => e.kind === 'notice');
    expect(notice).toMatchObject({ tone: 'failure' });
    expect(notice && notice.kind === 'notice' && notice.text).toContain('connection ended before the turn finished');
    expect(notice && notice.kind === 'notice' && notice.text).toContain('socket hang up');
  });

  // RULING 3 (ANSWER-REJECT, controller follow-up): `answer()`'s own fetch can
  // reject the same way `ask()`'s can - Task 12 fires it as `void
  // turn.answer(...)` from a card click, so an uncaught rejection here leaves
  // the card sitting there having done nothing, with no failure on screen and
  // no way to tell the click even registered.
  it('shows a failure when the answer request itself rejects, rather than leaving a dead card', async () => {
    const stream = openStream([
      { type: 'turn-started', turnId: 't7' },
      { type: 'elicitation-opened', callId: 'c1', elicitationId: 'e1', prompt: 'Who?', field: 'provider', kind: 'choice', options: [] }
    ]);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === '/api/agent/turn') return stream.response;
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useAgentTurn(fetchImpl));
    let askPromise!: Promise<void>;
    act(() => {
      askPromise = result.current.ask('book a plumber');
    });
    await waitFor(() => expect(result.current.state.pending).not.toBeNull());
    await act(async () => {
      await result.current.answer('accept', { provider: 'prov_a' });
    });
    const notice = result.current.state.entries.find(e => e.kind === 'notice');
    expect(notice).toMatchObject({ tone: 'failure' });
    expect(notice && notice.kind === 'notice' && notice.text).toContain('network down');
    // The turn's own stream is still open - only the sibling answer request
    // failed - so `turn-finished` must NOT have been applied on its behalf.
    expect(result.current.state.running).toBe(true);

    await act(async () => {
      stream.finish([{ type: 'turn-finished', turnId: 't7' }]);
      await askPromise;
    });
  });

  // MUTATION 9 (task-11 brief, Step 8): the answer-side 409 path
  // (`unknown-turn`) has no test in the brief's own Step 2 file. A batched
  // read of every streamed event does not exercise `answer()`'s error path at
  // all, so this is added specifically to prove it.
  it('shows the answer-side 409 as a failure rather than leaving a dead card', async () => {
    const stream = openStream([
      { type: 'turn-started', turnId: 't7' },
      { type: 'elicitation-opened', callId: 'c1', elicitationId: 'e1', prompt: 'Who?', field: 'provider', kind: 'choice', options: [] }
    ]);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === '/api/agent/turn') return stream.response;
      return new Response(JSON.stringify({ message: UNKNOWN_TURN_MESSAGE }), { status: 409 });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useAgentTurn(fetchImpl));
    let askPromise!: Promise<void>;
    act(() => {
      askPromise = result.current.ask('book a plumber');
    });
    await waitFor(() => expect(result.current.state.pending).not.toBeNull());
    await act(async () => {
      await result.current.answer('accept', { provider: 'prov_a' });
    });
    const notice = result.current.state.entries.find(e => e.kind === 'notice');
    expect(notice).toMatchObject({ tone: 'failure' });
    expect(notice && notice.kind === 'notice' && notice.text).toBe(UNKNOWN_TURN_MESSAGE);

    await act(async () => {
      stream.finish([{ type: 'turn-finished', turnId: 't7' }]);
      await askPromise;
    });
  });

  // MUTATION 7 (task-11 brief, Step 8): the browser-side twin of the
  // deadlock `apps/mcp-bridge/src/proxy.ts` already paid for. If `ask()`
  // collected every decoded event and applied them only after the read loop
  // ends, `pending` would never become non-null until the whole stream
  // closes - and this stream is deliberately held open by the test until
  // `pending` is observed, so a batching implementation cannot ever satisfy
  // the `waitFor` below; it can only time out.
  it('applies each event to state as it streams, not batched until the loop ends', async () => {
    let close: (() => void) | undefined;
    const fetchImpl = vi.fn(async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              encodeSse({ type: 'elicitation-opened', callId: 'c1', elicitationId: 'e1', prompt: 'Who?', field: 'provider', kind: 'choice', options: [] })
            )
          );
          close = () => {
            controller.enqueue(encoder.encode(encodeSse({ type: 'turn-finished', turnId: 't9' })));
            controller.close();
          };
        }
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useAgentTurn(fetchImpl));
    let askPromise!: Promise<void>;
    act(() => {
      askPromise = result.current.ask('book a plumber');
    });
    // If this never resolves, the code under test is batching rather than
    // streaming - see the mutation note above for why `close()` is withheld
    // until this passes.
    await waitFor(() => expect(result.current.state.pending).not.toBeNull());
    close?.();
    await act(async () => {
      await askPromise;
    });
    expect(result.current.state.running).toBe(false);
  });
});

describe('Transcript', () => {
  it('renders the spoken line of a successful call and no raw JSON', () => {
    const state = [
      { type: 'tool-started', callId: 'c1', tool: 'maintenance_due', args: {} },
      {
        type: 'tool-succeeded',
        callId: 'c1',
        tool: 'maintenance_due',
        spoken: 'Two tasks are due.',
        content: [{ type: 'text', text: 'Two tasks are due.' }],
        structured: { items: [{ id: 1 }] },
        widgetUri: null,
        ms: 900
      }
    ].reduce(reduceTurn, INITIAL_STATE);
    render(<Transcript state={state} />);
    expect(screen.getByText('Two tasks are due.')).toBeDefined();
    expect(document.body.textContent).not.toContain('"items"');
  });

  it('renders a failed call as a failure naming the tool and the reason', () => {
    const state = [
      { type: 'tool-started', callId: 'c1', tool: 'ask_manual', args: {} },
      { type: 'tool-failed', callId: 'c1', tool: 'ask_manual', message: 'Model access is blocked on this account.', ms: 1130 }
    ].reduce(reduceTurn, INITIAL_STATE);
    render(<Transcript state={state} />);
    const failure = screen.getByTestId('tool-c1');
    expect(failure.dataset.status).toBe('failed');
    expect(failure.textContent).toContain('ask_manual');
    expect(failure.textContent).toContain('Model access is blocked on this account.');
  });
});
