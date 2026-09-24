import type { ElicitationOption, TurnEvent } from '../shared/events.js';

export type Entry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      tool: string;
      status: 'running' | 'ok' | 'failed';
      spoken: string;
      message: string;
      /** The result's content array, for the widget host. Null on a running or a failed call, always. */
      content: unknown;
      structured: unknown;
      widgetUri: string | null;
      ms: number | null;
    }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'failure' };

export interface PendingQuestion {
  elicitationId: string;
  callId: string;
  prompt: string;
  field: string;
  kind: 'choice' | 'confirm';
  options: ElicitationOption[];
}

export interface Progress {
  callId: string;
  progress: number;
  total: number;
  message: string;
}

export interface AgentState {
  entries: Entry[];
  pending: PendingQuestion | null;
  progress: Progress | null;
  running: boolean;
  turnId: string | null;
}

export const INITIAL_STATE: AgentState = { entries: [], pending: null, progress: null, running: false, turnId: null };

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

export function askedByUser(state: AgentState, text: string): AgentState {
  return { ...state, entries: [...state.entries, { kind: 'user', id: nextId('user'), text }], running: true };
}

/** Replaces the tool entry with this id, or appends one when the start was never seen. */
function upsertTool(entries: Entry[], id: string, make: (previous: Entry | undefined) => Entry): Entry[] {
  const index = entries.findIndex(entry => entry.kind === 'tool' && entry.id === id);
  if (index === -1) return [...entries, make(undefined)];
  const next = [...entries];
  next[index] = make(entries[index]);
  return next;
}

/**
 * Folds one event into what is on screen.
 *
 * Pure and exported so the whole transcript can be tested without React, and
 * so the one property that matters most is checked directly: a `tool-failed`
 * event can only produce an entry with `status: 'failed'`, `spoken: ''` and
 * `structured: null`. There is no path by which a failure acquires the fields
 * a success renderer reads (FL-039).
 *
 * `turn-failed` is never gated on `running` or on whether `turn-finished` has
 * already been folded in. The server can emit `turn-finished` (the loop's own
 * `finally`) before `turn-failed` (the route's catch) when a turn throws after
 * its `finally` already ran - a failure that arrived "late" by that ordering
 * is not a failure to discard, so this case has no dependency on `state.running`
 * at all.
 */
export function reduceTurn(state: AgentState, event: TurnEvent): AgentState {
  switch (event.type) {
    case 'turn-started':
      return { ...state, running: true, turnId: event.turnId };

    case 'assistant-text': {
      const last = state.entries[state.entries.length - 1];
      if (last?.kind === 'assistant') {
        const entries = [...state.entries];
        entries[entries.length - 1] = { ...last, text: last.text + event.text };
        return { ...state, entries };
      }
      return { ...state, entries: [...state.entries, { kind: 'assistant', id: nextId('assistant'), text: event.text }] };
    }

    case 'tool-started':
      return {
        ...state,
        entries: upsertTool(state.entries, event.callId, () => ({
          kind: 'tool',
          id: event.callId,
          tool: event.tool,
          status: 'running',
          spoken: '',
          message: '',
          content: null,
          structured: null,
          widgetUri: null,
          ms: null
        }))
      };

    case 'tool-succeeded':
      return {
        ...state,
        progress: state.progress?.callId === event.callId ? null : state.progress,
        entries: upsertTool(state.entries, event.callId, () => ({
          kind: 'tool',
          id: event.callId,
          tool: event.tool,
          content: event.content,
          status: 'ok',
          spoken: event.spoken,
          message: '',
          structured: event.structured,
          widgetUri: event.widgetUri,
          ms: event.ms
        }))
      };

    case 'tool-failed':
      return {
        ...state,
        progress: state.progress?.callId === event.callId ? null : state.progress,
        entries: upsertTool(state.entries, event.callId, () => ({
          kind: 'tool',
          id: event.callId,
          tool: event.tool,
          status: 'failed',
          spoken: '',
          message: event.message,
          content: null,
          structured: null,
          widgetUri: null,
          ms: event.ms
        }))
      };

    case 'progress':
      return { ...state, progress: { callId: event.callId, progress: event.progress, total: event.total, message: event.message } };

    case 'elicitation-opened':
      return {
        ...state,
        pending: {
          elicitationId: event.elicitationId,
          callId: event.callId,
          prompt: event.prompt,
          field: event.field,
          kind: event.kind,
          options: event.options
        }
      };

    case 'elicitation-closed':
      return state.pending?.elicitationId === event.elicitationId ? { ...state, pending: null } : state;

    case 'session-rebuilt':
      return { ...state, entries: [...state.entries, { kind: 'notice', id: nextId('notice'), text: event.note, tone: 'info' }] };

    case 'turn-failed':
      return { ...state, entries: [...state.entries, { kind: 'notice', id: nextId('notice'), text: event.message, tone: 'failure' }] };

    case 'turn-finished':
      return { ...state, running: false, pending: null, progress: null };

    default:
      return state;
  }
}
