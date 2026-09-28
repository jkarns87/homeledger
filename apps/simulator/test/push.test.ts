import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { KEEPALIVE_MESSAGE, PUSH_BACKOFF_MS, PUSH_KEEPALIVE_MS, createPushClient, type SocketLike, type Timers } from '../src/server/push.js';
import { readSimulatorEnv, SimulatorConfigError } from '../src/server/env.js';
import type { PushStatus } from '../src/shared/events.js';

class FakeSocket extends EventEmitter implements SocketLike {
  sent: string[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>
  ) {
    super();
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.emit('close');
  }
}

function manualTimers() {
  const timeouts: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const intervals: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const t = { fn, ms, live: true };
      timeouts.push(t);
      return t;
    },
    clearTimeout: h => void ((h as { live: boolean }).live = false),
    setInterval: (fn, ms) => {
      const t = { fn, ms, live: true };
      intervals.push(t);
      return t;
    },
    clearInterval: h => void ((h as { live: boolean }).live = false)
  };
  return { timers, timeouts, intervals };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(tokens: string[] = ['tok-1', 'tok-2', 'tok-3']) {
  const sockets: FakeSocket[] = [];
  const statuses: PushStatus[] = [];
  const pushes: unknown[] = [];
  const t = manualTimers();
  const invalidateToken = vi.fn();
  let n = 0;
  const client = createPushClient({
    url: 'wss://wsapi01.execute-api.us-east-1.amazonaws.com/demo',
    token: async () => tokens[Math.min(n++, tokens.length - 1)]!,
    invalidateToken,
    onPush: p => pushes.push(p),
    onStatus: s => statuses.push(s),
    connect: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
    timers: t.timers
  });
  return { client, sockets, statuses, pushes, invalidateToken, ...t };
}

describe('push client (spec §7: the server holds the socket)', () => {
  it('connects with the bearer in the Authorization header and hands on valid pushes only', async () => {
    const x = setup();
    x.client.start();
    await flush();
    expect(x.sockets[0]!.headers).toEqual({ authorization: 'Bearer tok-1' });
    x.sockets[0]!.emit('open');
    expect(x.statuses).toEqual(['connecting', 'connected']);
    x.sockets[0]!.emit('message', Buffer.from('{"cardType":"visit.arrived","id":"visit_abcdefghijklmnop"}'));
    x.sockets[0]!.emit('message', Buffer.from('{"cardType":"visit.arrived","id":"visit_abcdefghijklmnop","description":"x"}'));
    x.sockets[0]!.emit('message', Buffer.from('not json'));
    expect(x.pushes).toEqual([{ cardType: 'visit.arrived', id: 'visit_abcdefghijklmnop' }]);
  });

  it('pings every five minutes so API Gateway does not close it as idle', async () => {
    const x = setup();
    x.client.start();
    await flush();
    x.sockets[0]!.emit('open');
    expect(PUSH_KEEPALIVE_MS).toBe(300_000);
    expect(x.intervals.map(i => i.ms)).toEqual([300_000]);
    x.intervals[0]!.fn();
    expect(x.sockets[0]!.sent).toEqual([KEEPALIVE_MESSAGE]);
    expect(KEEPALIVE_MESSAGE).toBe('{"action":"ping"}');
  });

  it('reconnects with backoff and a fresh token when the socket closes, and resets the backoff once connected', async () => {
    const x = setup();
    x.client.start();
    await flush();
    x.sockets[0]!.emit('open');
    x.sockets[0]!.emit('close');
    expect(x.statuses.at(-1)).toBe('reconnecting');
    expect(x.intervals[0]!.live).toBe(false);
    expect(x.timeouts.map(t => t.ms)).toEqual([PUSH_BACKOFF_MS[0]]);
    x.timeouts[0]!.fn();
    await flush();
    expect(x.sockets[1]!.headers).toEqual({ authorization: 'Bearer tok-2' });
    x.sockets[1]!.emit('open');
    x.sockets[1]!.emit('close');
    expect(x.timeouts.map(t => t.ms)).toEqual([1_000, 1_000]);
    expect([...PUSH_BACKOFF_MS]).toEqual([1_000, 2_000, 5_000, 10_000, 30_000]);
  });

  it('grows the backoff while the connection keeps failing, and invalidates the token when a handshake is refused', async () => {
    const x = setup();
    x.client.start();
    await flush();
    x.sockets[0]!.emit('close'); // refused before open, e.g. 403 from the authorizer
    x.timeouts[0]!.fn();
    await flush();
    x.sockets[1]!.emit('close');
    expect(x.timeouts.map(t => t.ms)).toEqual([1_000, 2_000]);
    expect(x.invalidateToken).toHaveBeenCalledTimes(2);
  });

  it('stops for good: closes the socket, cancels the retry, and reports off', async () => {
    const x = setup();
    x.client.start();
    await flush();
    x.sockets[0]!.emit('open');
    x.client.stop();
    expect(x.sockets[0]!.closed).toBe(true);
    expect(x.client.status()).toBe('off');
    expect(x.timeouts.filter(t => t.live)).toEqual([]);
    expect(x.sockets).toHaveLength(1);
  });
});

describe('HOMELEDGER_PUSH_URL', () => {
  const base = { NODE_ENV: 'test' as const, ANTHROPIC_API_KEY: 'k' };
  it('is optional, accepts wss://, and refuses anything that is not a WebSocket URL', () => {
    expect(readSimulatorEnv(base).pushUrl).toBeUndefined();
    expect(readSimulatorEnv({ ...base, HOMELEDGER_PUSH_URL: 'wss://wsapi01.execute-api.us-east-1.amazonaws.com/demo' }).pushUrl).toBe(
      'wss://wsapi01.execute-api.us-east-1.amazonaws.com/demo'
    );
    expect(readSimulatorEnv({ ...base, HOMELEDGER_PUSH_URL: 'ws://127.0.0.1:3900' }).pushUrl).toBe('ws://127.0.0.1:3900');
    expect(() => readSimulatorEnv({ ...base, HOMELEDGER_PUSH_URL: 'https://wsapi01.execute-api.us-east-1.amazonaws.com/demo' })).toThrow(SimulatorConfigError);
    expect(() => readSimulatorEnv({ ...base, HOMELEDGER_PUSH_URL: 'ws://example.com/demo' })).toThrow(SimulatorConfigError);
  });
});
