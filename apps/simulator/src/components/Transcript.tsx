'use client';

import { FailureCard } from './FailureCard.js';
import type { Theme } from './Frame.js';
import { WidgetFrame } from './WidgetFrame.js';
import type { AgentState, Entry } from '../lib/transcript.js';

function ToolRow({ entry, theme }: { entry: Extract<Entry, { kind: 'tool' }>; theme: Theme }) {
  return (
    <div className={`card tool ${entry.status}`} data-testid={`tool-${entry.id}`} data-status={entry.status}>
      <div className="row">
        <span className="name">{entry.tool}</span>
        <span className="pill">{entry.status === 'running' ? 'working' : entry.status === 'ok' ? `${entry.ms ?? 0} ms` : 'failed'}</span>
      </div>
      {entry.status === 'ok' && entry.spoken !== '' ? <p className="spoken">{entry.spoken}</p> : null}
      {entry.status === 'failed' ? <FailureCard tool={entry.tool} message={entry.message} /> : null}
      {entry.status === 'ok' && entry.widgetUri ? (
        <WidgetFrame uri={entry.widgetUri} content={entry.content} structured={entry.structured} theme={theme} />
      ) : null}
    </div>
  );
}

export function Transcript({ state, theme }: { state: AgentState; theme: Theme }) {
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
        if (entry.kind === 'tool') return <ToolRow key={entry.id} entry={entry} theme={theme} />;
        return (
          <p key={entry.id} className={entry.tone === 'failure' ? 'notice warn' : 'notice muted'} data-testid={`notice-${entry.id}`}>
            {entry.text}
          </p>
        );
      })}
    </div>
  );
}
