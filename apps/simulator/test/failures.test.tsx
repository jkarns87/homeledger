import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugDrawer } from '../src/components/DebugDrawer.js';
import { Transcript } from '../src/components/Transcript.js';
import { NOTHING_RETRIEVED } from '../src/lib/failures.js';
import { INITIAL_STATE, reduceTurn } from '../src/lib/transcript.js';

// Fix round 1, Ruling (was Minor 6): the `declined` fixture below is `status:
// 'ok'` with a `widgetUri`, so rendering it mounts a real `WidgetFrame`, which
// fires an unstubbed `fetch('/api/widget?...')` in what is otherwise a pure
// component-rendering unit test. It was silent only because `WidgetFrame`
// sets `cancelled = true` on unmount before the rejected fetch's `.catch`
// runs - a real network call this file never needed and never declared.
// Stubbed globally for every test here rather than per-test, since any test
// in this file could gain a widget-bearing fixture later and the point is
// that NONE of them should reach the network.
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('<!doctype html><html><body></body></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

const blocked = [
  { type: 'tool-started', callId: 'c1', tool: 'ask_manual', args: { question: 'what does F21 mean' } },
  { type: 'tool-failed', callId: 'c1', tool: 'ask_manual', message: 'Error 002: Access to Bedrock models is not allowed for this account', ms: 1130 }
].reduce(reduceTurn, INITIAL_STATE);

const declined = [
  { type: 'tool-started', callId: 'c9', tool: 'book_service', args: { applianceId: 'appl_x', issue: 'leak' } },
  {
    type: 'tool-succeeded',
    callId: 'c9',
    tool: 'book_service',
    spoken: "Okay, I haven't booked anything.",
    content: [{ type: 'text', text: "Okay, I haven't booked anything." }],
    structured: { booked: false },
    widgetUri: 'ui://homeledger/visit',
    ms: 220
  }
].reduce(reduceTurn, INITIAL_STATE);

describe('Transcript failures', () => {
  it('explains a blocked manual search instead of showing the AWS sentence alone', () => {
    render(<Transcript state={blocked} theme="dark" />);
    const card = screen.getByTestId('tool-c1');
    expect(card.dataset.status).toBe('failed');
    expect(card.textContent).toContain('The manuals could not be searched');
    expect(card.textContent).toContain('model access is blocked on this AWS account');
  });

  it('still shows the server’s own words, so the cause is not lost in the explanation', () => {
    render(<Transcript state={blocked} theme="dark" />);
    expect(screen.getByTestId('tool-c1').textContent).toContain('Error 002');
  });

  it('shows a decline as a call that worked, and never runs it through the failure explanation', () => {
    // The other half of Task 5, Step 1, rendered. With `isError` on the
    // server's decline this row read `data-status="failed"` and
    // `explainFailure` produced "book_service failed - Nothing was retrieved,
    // so this is not an answer and not an empty one either", which is untrue
    // about somebody who chose not to book.
    render(<Transcript state={declined} theme="dark" />);
    const card = screen.getByTestId('tool-c9');
    expect(card.dataset.status).toBe('ok');
    expect(card.textContent).toContain("Okay, I haven't booked anything.");
    expect(card.textContent).not.toContain('failed');
    expect(card.textContent).not.toContain(NOTHING_RETRIEVED);
  });
});

describe('DebugDrawer', () => {
  const snapshot = {
    endpointHost: 'bedrock-agentcore.us-east-1.amazonaws.com',
    endpointPath: '/runtimes/arn%3Aaws%3A.../invocations',
    addressing: 'name' as const,
    protocolVersion: '2025-11-25',
    sessionId: '259104a7-f052-4c35-958e-15b2057dfddf',
    rebuilds: 1,
    tools: ['list_appliances', 'book_service'],
    log: [
      { at: 1758400000000, direction: 'out' as const, method: 'initialize', id: 0, ms: 214, status: 200 },
      { at: 1758400001000, direction: 'out' as const, method: 'tools/call', id: 3, ms: 1840, status: 200 },
      { at: 1758400001500, direction: 'in' as const, method: 'elicitation/create', id: null, ms: null, status: null }
    ]
  };

  it('shows the endpoint, how it was addressed, the protocol version, the session and the rebuild count', () => {
    render(<DebugDrawer snapshot={snapshot} state={INITIAL_STATE} />);
    const drawer = screen.getByTestId('debug');
    expect(drawer.textContent).toContain('bedrock-agentcore.us-east-1.amazonaws.com');
    expect(drawer.textContent).toContain('resolved by name');
    // Spec section 7 asks for this by name, and it is the negotiated one
    // rather than a constant: a drawer that showed what this client asked for
    // would say the same thing whatever the server answered.
    expect(drawer.textContent).toContain('protocol 2025-11-25');
    expect(drawer.textContent).toContain('259104a7-f052-4c35-958e-15b2057dfddf');
    expect(drawer.textContent).toContain('1 session rebuild');
  });

  it('shows the JSON-RPC log with direction, method and outcome, newest last', () => {
    render(<DebugDrawer snapshot={snapshot} state={INITIAL_STATE} />);
    const lines = screen.getAllByTestId(/^rpc-/).map(node => node.textContent ?? '');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('→ initialize');
    expect(lines[0]).toContain('200');
    expect(lines[0]).toContain('214 ms');
    // A server-initiated request, which never passes through the outbound tap
    // and is the whole reason the drawer needs a transport wrapper rather than
    // a list of calls this side made: it is what fills the two-minute gap in
    // the middle of a booking.
    expect(lines[2]).toContain('← elicitation/create');
  });

  it('says the log is empty rather than rendering an empty list with no explanation', () => {
    render(<DebugDrawer snapshot={{ ...snapshot, log: [] }} state={INITIAL_STATE} />);
    expect(screen.queryAllByTestId(/^rpc-/)).toHaveLength(0);
    expect(screen.getByTestId('debug').textContent).toContain('no traffic yet');
  });

  it('says the protocol was not negotiated rather than inventing a version', () => {
    render(<DebugDrawer snapshot={{ ...snapshot, protocolVersion: null }} state={INITIAL_STATE} />);
    expect(screen.getByTestId('debug').textContent).toContain('protocol not negotiated');
  });

  it('times every call that has finished, and says so for the ones that have not', () => {
    const state = [
      { type: 'tool-started', callId: 'c1', tool: 'maintenance_due', args: {} },
      { type: 'tool-succeeded', callId: 'c1', tool: 'maintenance_due', spoken: 'Two.', content: null, structured: {}, widgetUri: null, ms: 937 },
      { type: 'tool-started', callId: 'c2', tool: 'book_service', args: {} }
    ].reduce(reduceTurn, INITIAL_STATE);
    render(<DebugDrawer snapshot={snapshot} state={state} />);
    expect(screen.getByTestId('debug').textContent).toContain('maintenance_due 937 ms');
    expect(screen.getByTestId('debug').textContent).toContain('book_service running');
  });

  it('says the endpoint is unknown rather than rendering nothing when there is no snapshot', () => {
    render(<DebugDrawer snapshot={null} state={INITIAL_STATE} />);
    expect(screen.getByTestId('debug').textContent).toContain('not connected');
  });
});
