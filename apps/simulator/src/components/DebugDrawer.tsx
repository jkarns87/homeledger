'use client';

import type { AgentState } from '../lib/transcript.js';

export interface JsonRpcLine {
  at: number;
  direction: 'out' | 'in';
  method: string;
  id: string | number | null;
  ms: number | null;
  status: number | null;
}

export interface DebugSnapshot {
  endpointHost: string;
  endpointPath: string;
  addressing: 'url' | 'arn' | 'name';
  /** What the two ends negotiated, or null if they have not. Never a constant of this application's. */
  protocolVersion: string | null;
  sessionId: string | null;
  rebuilds: number;
  tools: string[];
  /** Methods and timings, oldest first. No payloads ever reach this — see `HomeLedgerMcp.record`. */
  log: JsonRpcLine[];
}

const ADDRESSING: Record<DebugSnapshot['addressing'], string> = {
  url: 'pinned by URL',
  arn: 'pinned by ARN',
  name: 'resolved by name'
};

export function DebugDrawer({ snapshot, state }: { snapshot: DebugSnapshot | null; state: AgentState }) {
  const calls = state.entries.filter((entry): entry is Extract<AgentState['entries'][number], { kind: 'tool' }> => entry.kind === 'tool');
  return (
    <details className="debug" data-testid="debug">
      <summary>Connection</summary>
      {snapshot === null ? (
        <p className="muted">not connected</p>
      ) : (
        <ul className="muted">
          <li>
            {snapshot.endpointHost}
            {snapshot.endpointPath}
          </li>
          <li>{ADDRESSING[snapshot.addressing]}</li>
          {/* Spec section 7 asks for the protocol version by name. Shown as
              what it is — negotiated or not — rather than defaulted, because a
              default here would read as a successful handshake. */}
          <li>{snapshot.protocolVersion === null ? 'protocol not negotiated' : `protocol ${snapshot.protocolVersion}`}</li>
          <li>session {snapshot.sessionId ?? 'none'}</li>
          <li>
            {snapshot.rebuilds} session rebuild{snapshot.rebuilds === 1 ? '' : 's'}
          </li>
          <li>{snapshot.tools.length} tools</li>
        </ul>
      )}
      <ul className="muted">
        {calls.map(call => (
          <li key={call.id}>{call.ms === null ? `${call.tool} running` : `${call.tool} ${call.ms} ms`}</li>
        ))}
      </ul>
      {/* The JSON-RPC log. `←` lines are server-initiated — an elicitation, a
          progress notification — and they are the ones that explain a
          `tools/call` that has been open for two minutes. */}
      <ul className="muted rpc">
        {snapshot === null || snapshot.log.length === 0 ? (
          <li>no traffic yet</li>
        ) : (
          snapshot.log.map((line, index) => (
            <li key={`${line.at}-${index}`} data-testid={`rpc-${index}`}>
              {line.direction === 'out' ? '→' : '←'} {line.method}
              {line.status === null ? '' : ` ${line.status}`}
              {line.ms === null ? '' : ` ${line.ms} ms`}
            </li>
          ))
        )}
      </ul>
    </details>
  );
}
