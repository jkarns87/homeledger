import { describe, expect, it } from 'vitest';
import { sseEvents } from '../src/sse.js';

function streamOf(chunks: string[], hold?: { release: Promise<void> }): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index === chunks.length) {
        if (hold) await hold.release;
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index++]!));
    }
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const event of sseEvents(stream)) out.push(event.data);
  return out;
}

describe('sseEvents', () => {
  it('reads one event per frame', async () => {
    expect(await collect(streamOf(['data: {"a":1}\n\ndata: {"b":2}\n\n']))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    expect(await collect(streamOf(['data: {"a"', ':1}\n', '\ndata: {"b":2}\n\n']))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('joins a multi-line data field with newlines, as the spec requires', async () => {
    expect(await collect(streamOf(['data: line one\ndata: line two\n\n']))).toEqual(['line one\nline two']);
  });

  it('handles CRLF framing', async () => {
    expect(await collect(streamOf(['data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n']))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('handles a CRLF split across a chunk boundary without inventing a frame separator', async () => {
    // '\r' ends the first chunk and '\n' starts the second. Normalising each
    // chunk in isolation would turn that pair into two newlines and split one
    // event into two truncated halves.
    expect(await collect(streamOf(['data: {"a":1}\r', '\n\r\n']))).toEqual(['{"a":1}']);
  });

  it('ignores comments and keepalives', async () => {
    expect(await collect(streamOf([': keepalive\n\ndata: {"a":1}\n\n']))).toEqual(['{"a":1}']);
  });

  it('keeps the event and id fields alongside the data', async () => {
    const events: Array<{ event: string | undefined; id: string | undefined }> = [];
    for await (const event of sseEvents(streamOf(['event: message\nid: 7\ndata: {"a":1}\n\n']))) events.push({ event: event.event, id: event.id });
    expect(events).toEqual([{ event: 'message', id: '7' }]);
  });

  it('yields a final frame that the stream ended without terminating', async () => {
    expect(await collect(streamOf(['data: {"a":1}']))).toEqual(['{"a":1}']);
  });

  it('strips exactly one leading space after the colon, and no more', async () => {
    expect(await collect(streamOf(['data:  {"a":1}\n\n']))).toEqual([' {"a":1}']);
  });

  it('yields each event before the stream closes, which is what stops the elicitation flow deadlocking', async () => {
    // The generator must produce the first event while the producer is still
    // open. A consumer that only sees events after close cannot answer a
    // question whose answer is what closes the stream.
    let release!: () => void;
    const hold = { release: new Promise<void>(resolve => (release = resolve)) };
    const iterator = sseEvents(streamOf(['data: {"question":1}\n\n'], hold))[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.data).toBe('{"question":1}');
    release();
    await iterator.return?.(undefined);
  });
});
