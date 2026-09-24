'use client';

import { useState } from 'react';
import { Composer } from '../components/Composer.js';
import { ElicitationCard } from '../components/ElicitationCard.js';
import { Frame, type Theme } from '../components/Frame.js';
import { ProgressMeter } from '../components/ProgressMeter.js';
import { Transcript } from '../components/Transcript.js';
import { useAgentTurn } from '../lib/useAgentTurn.js';

export default function Home() {
  const [theme, setTheme] = useState<Theme>('dark');
  const turn = useAgentTurn();
  return (
    <Frame theme={theme} onToggleTheme={() => setTheme(current => (current === 'dark' ? 'light' : 'dark'))}>
      <Transcript state={turn.state} />
      {turn.state.progress ? <ProgressMeter progress={turn.state.progress} /> : null}
      {turn.state.pending ? <ElicitationCard question={turn.state.pending} onAnswer={(action, content) => void turn.answer(action, content)} /> : null}
      <Composer disabled={turn.state.running || turn.state.pending !== null} onAsk={text => void turn.ask(text)} />
    </Frame>
  );
}
