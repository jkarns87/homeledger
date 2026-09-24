'use client';

import { useState } from 'react';
import { Composer } from '../components/Composer.js';
import { Frame, type Theme } from '../components/Frame.js';
import { Transcript } from '../components/Transcript.js';
import { useAgentTurn } from '../lib/useAgentTurn.js';

export default function Home() {
  const [theme, setTheme] = useState<Theme>('dark');
  const turn = useAgentTurn();
  return (
    <Frame theme={theme} onToggleTheme={() => setTheme(current => (current === 'dark' ? 'light' : 'dark'))}>
      <Transcript state={turn.state} />
      <Composer disabled={turn.state.running} onAsk={text => void turn.ask(text)} />
    </Frame>
  );
}
