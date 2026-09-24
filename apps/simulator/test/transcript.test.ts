import { describe, expect, it } from 'vitest';
import { INITIAL_STATE, askedByUser, reduceTurn, type AgentState } from '../src/lib/transcript.js';
import type { TurnEvent } from '../src/shared/events.js';

function run(events: TurnEvent[], from: AgentState = INITIAL_STATE): AgentState {
  return events.reduce(reduceTurn, from);
}

describe('reduceTurn', () => {
  it('joins streamed assistant deltas into one entry rather than one per delta', () => {
    const state = run([
      { type: 'turn-started', turnId: 't1' },
      { type: 'assistant-text', text: 'Six ' },
      { type: 'assistant-text', text: 'appliances.' }
    ]);
    expect(state.entries).toEqual([{ kind: 'assistant', id: expect.any(String), text: 'Six appliances.' }]);
    expect(state.running).toBe(true);
    expect(state.turnId).toBe('t1');
  });

  it('starts a new assistant entry after a tool interrupts the stream', () => {
    const state = run([
      { type: 'turn-started', turnId: 't1' },
      { type: 'assistant-text', text: 'Looking.' },
      { type: 'tool-started', callId: 'c1', tool: 'list_appliances', args: {} },
      {
        type: 'tool-succeeded',
        callId: 'c1',
        tool: 'list_appliances',
        spoken: 'Six.',
        content: [{ type: 'text', text: 'Six.' }],
        structured: { appliances: [] },
        widgetUri: 'ui://homeledger/appliances',
        ms: 120
      },
      { type: 'assistant-text', text: 'Six appliances.' }
    ]);
    expect(state.entries.map(e => e.kind)).toEqual(['assistant', 'tool', 'assistant']);
    expect(state.entries[0]).toMatchObject({ text: 'Looking.' });
    expect(state.entries[2]).toMatchObject({ text: 'Six appliances.' });
  });

  it('flips a running call to ok and keeps its content, its widget and its timing', () => {
    const state = run([
      { type: 'tool-started', callId: 'c1', tool: 'maintenance_due', args: { horizonDays: 30 } },
      {
        type: 'tool-succeeded',
        callId: 'c1',
        tool: 'maintenance_due',
        spoken: 'Two are due.',
        content: [{ type: 'text', text: 'Two are due.' }],
        structured: { items: [] },
        widgetUri: 'ui://homeledger/calendar',
        ms: 940
      }
    ]);
    expect(state.entries).toEqual([
      {
        kind: 'tool',
        id: 'c1',
        tool: 'maintenance_due',
        status: 'ok',
        spoken: 'Two are due.',
        message: '',
        // Carried, not dropped. This is the half of the MCP Apps tool-result
        // payload the widget host pushes beside `structuredContent`, and the
        // only place it can come from is here.
        content: [{ type: 'text', text: 'Two are due.' }],
        structured: { items: [] },
        widgetUri: 'ui://homeledger/calendar',
        ms: 940
      }
    ]);
  });

  it('flips a running call to failed and never gives it spoken text, content or structure', () => {
    const state = run([
      { type: 'tool-started', callId: 'c1', tool: 'ask_manual', args: { question: 'what is F21' } },
      { type: 'tool-failed', callId: 'c1', tool: 'ask_manual', message: 'Model access is blocked on this account.', ms: 1130 }
    ]);
    const entry = state.entries[0];
    expect(entry).toMatchObject({ kind: 'tool', status: 'failed', message: 'Model access is blocked on this account.', spoken: '', ms: 1130 });
    expect(entry && entry.kind === 'tool' && entry.structured).toBeNull();
    // Nulled with the rest. A failure that kept a content array from an
    // earlier attempt would be a failure a widget could still render, which is
    // the whole shape FL-039 is about.
    expect(entry && entry.kind === 'tool' && entry.content).toBeNull();
  });

  it('records a result for a call it never saw start rather than dropping it', () => {
    const state = run([{ type: 'tool-failed', callId: 'ghost', tool: 'get_visit', message: 'Session not found.', ms: 4 }]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({ kind: 'tool', id: 'ghost', status: 'failed' });
  });

  it('holds one pending question at a time and clears it when it closes', () => {
    const opened: TurnEvent = {
      type: 'elicitation-opened',
      callId: 'c1',
      elicitationId: 'e1',
      prompt: 'Who should I book?',
      field: 'provider',
      kind: 'choice',
      options: [{ value: 'prov_a', label: 'Alpha' }]
    };
    const asked = run([opened]);
    expect(asked.pending).toEqual({
      elicitationId: 'e1',
      callId: 'c1',
      prompt: 'Who should I book?',
      field: 'provider',
      kind: 'choice',
      options: [{ value: 'prov_a', label: 'Alpha' }]
    });
    expect(run([{ type: 'elicitation-closed', elicitationId: 'e1', action: 'accept' }], asked).pending).toBeNull();
  });

  it('ignores a close for a question it is not showing', () => {
    const opened: TurnEvent = { type: 'elicitation-opened', callId: 'c1', elicitationId: 'e1', prompt: 'p', field: 'provider', kind: 'choice', options: [] };
    const asked = run([opened]);
    expect(run([{ type: 'elicitation-closed', elicitationId: 'other', action: 'cancel' }], asked).pending).toEqual(asked.pending);
  });

  it('keeps the latest progress and drops it when the call that reported it settles', () => {
    const during = run([
      { type: 'tool-started', callId: 'c1', tool: 'book_service', args: {} },
      { type: 'progress', callId: 'c1', progress: 2, total: 3, message: 'Comparing arrival windows' }
    ]);
    expect(during.progress).toEqual({ callId: 'c1', progress: 2, total: 3, message: 'Comparing arrival windows' });
    const after = run(
      [{ type: 'tool-succeeded', callId: 'c1', tool: 'book_service', spoken: 'Booked.', content: null, structured: {}, widgetUri: null, ms: 1800 }],
      during
    );
    expect(after.progress).toBeNull();
  });

  it('shows a rebuilt session as a notice, and a stopped turn as a failure', () => {
    const state = run([
      { type: 'session-rebuilt', note: 'The connection had expired.' },
      { type: 'turn-failed', message: 'The assistant used its 8 tool rounds without finishing.' }
    ]);
    expect(state.entries).toEqual([
      { kind: 'notice', id: expect.any(String), text: 'The connection had expired.', tone: 'info' },
      { kind: 'notice', id: expect.any(String), text: 'The assistant used its 8 tool rounds without finishing.', tone: 'failure' }
    ]);
  });

  it('stops running and drops any pending question when the turn finishes', () => {
    const state = run([
      { type: 'turn-started', turnId: 't1' },
      { type: 'elicitation-opened', callId: 'c1', elicitationId: 'e1', prompt: 'p', field: 'confirm', kind: 'confirm', options: [] },
      { type: 'turn-finished', turnId: 't1' }
    ]);
    expect(state.running).toBe(false);
    expect(state.pending).toBeNull();
  });

  // RULING 1 (EVENT-ORDER PIN, task-11 brief): Task 8-9's server can emit
  // `turn-finished` before `turn-failed` on a turn that threw after its
  // `finally` had already run (see task-11-brief's "Context the brief cannot
  // know"). A failure that arrives after the turn is already marked finished
  // must still land on the transcript rather than being silently dropped -
  // this pins that today, so a later "ignore events once finished" change
  // (which would seem harmless, since the turn already looks done) fails
  // this test instead of shipping a swallowed failure.
  it('keeps a failure notice that arrives after the turn has already finished', () => {
    const state = run([
      { type: 'turn-started', turnId: 't1' },
      { type: 'turn-finished', turnId: 't1' },
      { type: 'turn-failed', message: 'The model connection reset while finishing this turn.' }
    ]);
    expect(state.running).toBe(false);
    expect(state.entries).toEqual([{ kind: 'notice', id: expect.any(String), text: 'The model connection reset while finishing this turn.', tone: 'failure' }]);
  });
});

describe('askedByUser', () => {
  it('appends the question and marks the conversation as running before any event arrives', () => {
    const state = askedByUser(INITIAL_STATE, 'what appliances do we have');
    expect(state.entries).toEqual([{ kind: 'user', id: expect.any(String), text: 'what appliances do we have' }]);
    expect(state.running).toBe(true);
  });
});
