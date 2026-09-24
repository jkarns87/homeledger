'use client';

import { FailureCard } from './FailureCard.js';
import type { AgentState, Entry } from '../lib/transcript.js';

function ToolRow({ entry }: { entry: Extract<Entry, { kind: 'tool' }> }) {
  return (
    <div className={`card tool ${entry.status}`} data-testid={`tool-${entry.id}`} data-status={entry.status}>
      <div className="row">
        <span className="name">{entry.tool}</span>
        <span className="pill">{entry.status === 'running' ? 'working' : entry.status === 'ok' ? `${entry.ms ?? 0} ms` : 'failed'}</span>
      </div>
      {entry.status === 'ok' && entry.spoken !== '' ? <p className="spoken">{entry.spoken}</p> : null}
      {entry.status === 'failed' ? <FailureCard tool={entry.tool} message={entry.message} /> : null}
    </div>
  );
}

export function Transcript({ state }: { state: AgentState }) {
  return (
    <div className="transcript" data-testid="transcript">
      {state.entries.map(entry => {
        if (entry.kind === 'user')
          return (
            <p key={entry.id} className="said user">
              {entry.text}
            </p>
          );
        if (entry.kind === 'assistant')
          return (
            <p key={entry.id} className="said assistant">
              {entry.text}
            </p>
          );
        if (entry.kind === 'tool') return <ToolRow key={entry.id} entry={entry} />;
        return (
          <p key={entry.id} className={entry.tone === 'failure' ? 'notice warn' : 'notice muted'} data-testid={`notice-${entry.id}`}>
            {entry.text}
          </p>
        );
      })}
    </div>
  );
}
