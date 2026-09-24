'use client';

import { useEffect, useState } from 'react';
import { Composer } from '../components/Composer.js';
import { DebugDrawer, type DebugSnapshot } from '../components/DebugDrawer.js';
import { ElicitationCard } from '../components/ElicitationCard.js';
import { Frame, type Theme } from '../components/Frame.js';
import { ProgressMeter } from '../components/ProgressMeter.js';
import { Transcript } from '../components/Transcript.js';
import { useAgentTurn } from '../lib/useAgentTurn.js';

export default function Home() {
  const [theme, setTheme] = useState<Theme>('dark');
  const turn = useAgentTurn();
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);
  // Re-read after every turn, so a session rebuilt mid-conversation shows up
  // in the count rather than only in the transcript.
  useEffect(() => {
    if (turn.state.running) return;
    let cancelled = false;
    void fetch('/api/debug')
      .then(response => (response.ok ? (response.json() as Promise<DebugSnapshot>) : null))
      .then(value => {
        if (!cancelled) setSnapshot(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [turn.state.running]);
  return (
    <Frame theme={theme} onToggleTheme={() => setTheme(current => (current === 'dark' ? 'light' : 'dark'))}>
      <Transcript state={turn.state} />
      {turn.state.progress ? <ProgressMeter progress={turn.state.progress} /> : null}
      {turn.state.pending ? <ElicitationCard question={turn.state.pending} onAnswer={(action, content) => void turn.answer(action, content)} /> : null}
      <Composer disabled={turn.state.running || turn.state.pending !== null} onAsk={text => void turn.ask(text)} />
      <DebugDrawer snapshot={snapshot} state={turn.state} />
    </Frame>
  );
}
