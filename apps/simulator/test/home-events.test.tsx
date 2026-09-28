import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { INITIAL_STATE, type AgentState } from '../src/lib/transcript.js';
import { useHomeEvents } from '../src/lib/useHomeEvents.js';

class FakeEventSource {
  static last: FakeEventSource | undefined;
  onmessage: ((m: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  close() {
    this.closed = true;
  }
}

function Probe({ onState }: { onState: (s: AgentState) => void }) {
  const [state, setState] = useState<AgentState>(INITIAL_STATE);
  useHomeEvents(next => setState(next), FakeEventSource as unknown as typeof EventSource);
  onState(state);
  return null;
}

describe('useHomeEvents', () => {
  it('listens on /api/agent/events and folds what arrives into the transcript state', () => {
    let latest = INITIAL_STATE;
    const view = render(<Probe onState={s => (latest = s)} />);
    expect(FakeEventSource.last!.url).toBe('/api/agent/events');
    act(() => FakeEventSource.last!.onmessage!({ data: JSON.stringify({ type: 'push-status', status: 'connected' }) }));
    act(() => FakeEventSource.last!.onmessage!({ data: '{not json' }));
    expect(latest.pushStatus).toBe('connected');
    view.unmount();
    expect(FakeEventSource.last!.closed).toBe(true);
  });
});
