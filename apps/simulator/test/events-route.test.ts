import { afterEach, describe, expect, it, vi } from 'vitest';
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

  describe('cleanup (one idempotent cleanup: unsubscribe and stop the keepalive)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('stops the keepalive timer as well as the subscription when the browser goes away', async () => {
      vi.useFakeTimers();
      const { conversation, hub } = convo();
      const r = handleEvents(conversation, new Request('http://127.0.0.1:3000/api/agent/events', { headers: { host: '127.0.0.1:3000' } }), {
        keepaliveMs: 10
      });
      expect(vi.getTimerCount()).toBe(1);
      await r.body!.cancel();
      expect(hub.size()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('stops the keepalive timer as well as the subscription when an event cannot be sent', () => {
      vi.useFakeTimers();
      const { conversation, hub } = convo();
      handleEvents(conversation, new Request('http://127.0.0.1:3000/api/agent/events', { headers: { host: '127.0.0.1:3000' } }), { keepaliveMs: 10 });
      expect([hub.size(), vi.getTimerCount()]).toEqual([1, 1]);
      // An event that will not serialise takes the same catch path as an
      // enqueue on a closed controller.
      hub.publish({ type: 'push-received', cardType: 'visit.arrived', id: 1n } as unknown as TurnEvent);
      expect([hub.size(), vi.getTimerCount()]).toEqual([0, 0]);
    });
  });
});
