export interface ElicitationOption {
  value: string;
  label: string;
}

/**
 * Everything one turn can tell the browser.
 *
 * A closed union rather than a bag of strings, because the transcript decides
 * what to render from `type` alone and a failure must be impossible to render
 * as a success. In particular `tool-failed` is a separate member from
 * `tool-succeeded` with no shared "result" field: there is no shape a failed
 * call can take that a success renderer would accept (FL-039).
 */
export type TurnEvent =
  | { type: 'turn-started'; turnId: string }
  | { type: 'assistant-text'; text: string }
  | { type: 'tool-started'; callId: string; tool: string; args: Record<string, unknown> }
  /** `content` is the result's whole content array, the shape the MCP Apps view protocol expects beside `structuredContent`; `spoken` is its first text block, flattened for the transcript. */
  | { type: 'tool-succeeded'; callId: string; tool: string; spoken: string; content: unknown; structured: unknown; widgetUri: string | null; ms: number }
  | { type: 'tool-failed'; callId: string; tool: string; message: string; ms: number }
  | { type: 'progress'; callId: string; progress: number; total: number; message: string }
  | {
      type: 'elicitation-opened';
      callId: string;
      elicitationId: string;
      prompt: string;
      field: string;
      kind: 'choice' | 'confirm';
      options: ElicitationOption[];
    }
  | { type: 'elicitation-closed'; elicitationId: string; action: 'accept' | 'decline' | 'cancel' | 'abandoned' }
  | { type: 'session-rebuilt'; note: string }
  | { type: 'turn-failed'; message: string }
  | { type: 'turn-finished'; turnId: string };

/**
 * One event, one SSE message.
 *
 * JSON.stringify is what keeps a newline inside an assistant's text from
 * starting a second `data:` field, which would split one event across two
 * frames and desynchronise the stream from that point on.
 */
export function encodeSse(event: TurnEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function parseFrame(frame: string): TurnEvent | undefined {
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') continue;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
  }
  if (dataLines.length === 0) return undefined;
  try {
    return JSON.parse(dataLines.join('\n')) as TurnEvent;
  } catch {
    return undefined;
  }
}

/**
 * Splits a byte stream into events as they arrive.
 *
 * Incremental for the same reason `apps/mcp-bridge/src/sse.ts` is: the stream
 * this reads stays open across three questions the person on the other end has
 * not answered yet, so anything that waits for it to finish before looking at
 * its contents waits for an answer that cannot be given. Handing back a
 * partial-frame buffer between calls is the whole mechanism.
 */
export function createSseDecoder(): (chunk: string) => TurnEvent[] {
  let buffer = '';
  return chunk => {
    buffer = (buffer + chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const events: TurnEvent[] = [];
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary === -1) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseFrame(frame);
      if (parsed) events.push(parsed);
    }
    return events;
  };
}
