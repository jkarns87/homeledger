'use client';

import { useState } from 'react';
import { Composer } from '../components/Composer.js';
import { DebugDrawer } from '../components/DebugDrawer.js';
import { ElicitationCard } from '../components/ElicitationCard.js';
import { Frame, type Theme } from '../components/Frame.js';
import { ProgressMeter } from '../components/ProgressMeter.js';
import { Transcript } from '../components/Transcript.js';
import { useAgentTurn } from '../lib/useAgentTurn.js';
import { useDebugSnapshot } from '../lib/useDebugSnapshot.js';

export default function Home() {
  const [theme, setTheme] = useState<Theme>('dark');
  const turn = useAgentTurn();
  // Polls `/api/debug` roughly once a second while a turn is running or a
  // question is open, so the log and rebuild count are live during the turn
  // they explain rather than stale until it ends (spec section 7).
  const snapshot = useDebugSnapshot(turn.state.running || turn.state.pending !== null);
  return (
    <Frame theme={theme} onToggleTheme={() => setTheme(current => (current === 'dark' ? 'light' : 'dark'))}>
      <Transcript state={turn.state} theme={theme} />
      {turn.state.progress ? <ProgressMeter progress={turn.state.progress} /> : null}
      {turn.state.pending ? <ElicitationCard question={turn.state.pending} onAnswer={(action, content) => void turn.answer(action, content)} /> : null}
      <Composer disabled={turn.state.running || turn.state.pending !== null} onAsk={text => void turn.ask(text)} />
      <DebugDrawer snapshot={snapshot} state={turn.state} />
    </Frame>
  );
}
