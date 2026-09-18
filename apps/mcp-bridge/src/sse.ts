export interface SseEvent {
  event: string | undefined;
  data: string;
  id: string | undefined;
}

function parseFrame(frame: string): SseEvent | undefined {
  if (frame.trim() === '') return undefined;
  const dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // One optional leading space after the colon is part of the framing, not the value.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  }
  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join('\n'), id };
}

/**
 * Yields server-sent events from a byte stream as they arrive.
 *
 * "As they arrive" is the whole point and the reason this exists rather than a
 * `await response.text()` followed by a split. On this server a `tools/call`
 * for `book_service` answers with an SSE stream that stays open across three
 * `elicitation/create` requests, and each of those is answered by the client on
 * a *separate* HTTP request that can only be sent once the question has been
 * read off this stream. Anything that waits for the stream to finish before
 * looking at its contents deadlocks: the stream is waiting for the answer, the
 * answer is waiting for the stream.
 *
 * Line endings are normalised because CRLF is legal SSE framing; the trailing
 * lone CR is held back so that a chunk boundary falling between the CR and the
 * LF of one CRLF cannot be mistaken for a frame separator.
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  // Decoded incrementally with `stream: true` so that a chunk boundary falling
  // inside a multi-byte character does not produce a replacement character.
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const trailingCr = buffer.endsWith('\r');
      const settled = trailingCr ? buffer.slice(0, -1) : buffer;
      buffer = settled.replace(/\r\n/g, '\n').replace(/\r/g, '\n') + (trailingCr ? '\r' : '');
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary === -1) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
      }
    }
    // A stream that ends without a final blank line still carries a message.
    const tail = parseFrame((buffer + decoder.decode()).replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
    if (tail) yield tail;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
