import { describe, expect, it } from 'vitest';
import { handleEvents } from '../src/server/http.js';
import { createEventHub } from '../src/server/hub.js';
import type { Conversation } from '../src/server/session.js';
import { createSseDecoder, type TurnEvent } from '../src/shared/events.js';

function convo(allowOrigin?: string) {
  const hub = createEventHub();
  return { hub, conversation: { env: { allowOrigin }, hub, push: { status: () => 'connected' as const } } as unknown as Conversation };
}

async function readEvents(response: Response, count: number): Promise<TurnEvent[]> {
  const reader = response.body!.getReader();
  const decode = createSseDecoder();
  const out: TurnEvent[] = [];
  while (out.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(...decode(new TextDecoder().decode(value)));
  }
  await reader.cancel();
  return out;
}

describe('GET /api/agent/events', () => {
  it('refuses a foreign origin, like every other route', () => {
    const { conversation } = convo();
    const r = handleEvents(
      conversation,
      new Request('http://127.0.0.1:3000/api/agent/events', { headers: { host: '127.0.0.1:3000', origin: 'https://evil.example' } })
    );
    expect(r.status).toBe(403);
  });

  it('streams the push status first, then whatever the hub publishes, as unbuffered SSE', async () => {
    const { conversation, hub } = convo();
    const r = handleEvents(conversation, new Request('http://127.0.0.1:3000/api/agent/events', { headers: { host: '127.0.0.1:3000' } }));
    expect(r.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(r.headers.get('x-accel-buffering')).toBe('no');
    const reading = readEvents(r, 2);
    await new Promise(resolve => setImmediate(resolve));
    hub.publish({ type: 'push-received', cardType: 'visit.arrived', id: 'visit_abcdefghijklmnop' });
    expect(await reading).toEqual([
      { type: 'push-status', status: 'connected' },
      { type: 'push-received', cardType: 'visit.arrived', id: 'visit_abcdefghijklmnop' }
    ]);
  });

  it('unsubscribes when the browser goes away', async () => {
    const { conversation, hub } = convo();
    const r = handleEvents(conversation, new Request('http://127.0.0.1:3000/api/agent/events', { headers: { host: '127.0.0.1:3000' } }));
    await readEvents(r, 1);
    expect(hub.size()).toBe(0);
  });
});
