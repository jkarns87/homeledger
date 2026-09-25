'use client';

import { useEffect, useRef, useState } from 'react';
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
  // Once per page load, and the composer waits for it. The history the model
  // is handed lives on the server and outlives a reload; the transcript does
  // not. Without this, a retake carried every earlier take's turns into the
  // model's context, unseen (final review I3). The ref, not the effect's
  // dependency list, is what keeps it to once: React's development mode runs
  // a mount effect twice, and a second reset that landed after the first
  // question was sent would abort that question's turn.
  const { reset } = turn;
  const resetOnce = useRef(false);
  useEffect(() => {
    if (resetOnce.current) return;
    resetOnce.current = true;
    void reset();
  }, [reset]);
  // Polls `/api/debug` roughly once a second while a turn is running or a
  // question is open, so the log and rebuild count are live during the turn
  // they explain rather than stale until it ends (spec section 7).
  const snapshot = useDebugSnapshot(turn.state.running || turn.state.pending !== null);
  return (
    <Frame theme={theme} onToggleTheme={() => setTheme(current => (current === 'dark' ? 'light' : 'dark'))} scripted={snapshot?.scripted ?? false}>
      <Transcript state={turn.state} theme={theme} />
      {turn.state.progress ? <ProgressMeter progress={turn.state.progress} /> : null}
      {/* Keyed by question, so each question gets a fresh card with its own
          answered-once guard rather than inheriting the last card's. */}
      {turn.state.pending ? (
        <ElicitationCard
          key={turn.state.pending.elicitationId}
          question={turn.state.pending}
          onAnswer={(question, action, content) => void turn.answer(question, action, content)}
        />
      ) : null}
      <Composer disabled={!turn.ready || turn.state.running || turn.state.pending !== null} onAsk={text => void turn.ask(text)} />
      <DebugDrawer snapshot={snapshot} state={turn.state} />
    </Frame>
  );
}
