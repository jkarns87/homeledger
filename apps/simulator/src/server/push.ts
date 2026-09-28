import WebSocket from 'ws';
import { parsePushPayload, type PushPayload } from '@homeledger/core';
import type { PushStatus } from '../shared/events.js';

export const PUSH_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];
/** API Gateway closes a WebSocket idle for ten minutes; a ping every five keeps it (Plan 4 Task 12). */
export const PUSH_KEEPALIVE_MS = 300_000;
export const KEEPALIVE_MESSAGE = '{"action":"ping"}';

export interface SocketLike {
  on(event: 'open' | 'close', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const REAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>)
};

export interface PushClient {
  start(): void;
  stop(): void;
  status(): PushStatus;
}

/**
 * The simulator server's end of spec §7's push channel. The bearer travels in
 * the Authorization header of the upgrade (Node's global WebSocket cannot set
 * one; a query-string token would be logged). A connection refused before it
 * opens invalidates the cached token, so an expired token is not retried
 * forever. Missed pushes stay readable through recent_events (spec §7).
 */
export function createPushClient(opts: {
  url: string;
  token: () => Promise<string>;
  invalidateToken?: () => void;
  onPush: (p: PushPayload) => void;
  onStatus: (s: PushStatus) => void;
  connect?: SocketFactory;
  timers?: Timers;
  log?: (message: string) => void;
}): PushClient {
  const connect: SocketFactory = opts.connect ?? ((url, headers) => new WebSocket(url, { headers }) as unknown as SocketLike);
  const timers = opts.timers ?? REAL_TIMERS;
  const log = opts.log ?? (() => {});
  let state: PushStatus = 'off';
  let stopped = true;
  let attempt = 0;
  let socket: SocketLike | null = null;
  let keepalive: unknown = null;
  let retry: unknown = null;

  const setStatus = (next: PushStatus) => {
    if (state === next) return;
    state = next;
    opts.onStatus(next);
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    setStatus('reconnecting');
    const delay = PUSH_BACKOFF_MS[Math.min(attempt, PUSH_BACKOFF_MS.length - 1)]!;
    attempt += 1;
    retry = timers.setTimeout(() => {
      retry = null;
      void open();
    }, delay);
  };

  const open = async (): Promise<void> => {
    if (stopped) return;
    let token: string;
    try {
      token = await opts.token();
    } catch (err) {
      log(`push: no token (${err instanceof Error ? err.message : String(err)})`);
      scheduleReconnect();
      return;
    }
    if (stopped) return;
    let opened = false;
    const s = connect(opts.url, { authorization: `Bearer ${token}` });
    socket = s;
    s.on('open', () => {
      opened = true;
      attempt = 0;
      setStatus('connected');
      keepalive = timers.setInterval(() => s.send(KEEPALIVE_MESSAGE), PUSH_KEEPALIVE_MS);
    });
    s.on('message', data => {
      const payload = parsePushPayload(String(data));
      if (payload) opts.onPush(payload);
      else log('push: ignored a message that is not a push pointer');
    });
    s.on('error', err => log(`push: ${err.message}`));
    s.on('close', () => {
      if (keepalive !== null) {
        timers.clearInterval(keepalive);
        keepalive = null;
      }
      if (socket === s) socket = null;
      if (!opened) opts.invalidateToken?.();
      scheduleReconnect();
    });
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      setStatus('connecting');
      void open();
    },
    stop() {
      stopped = true;
      if (retry !== null) timers.clearTimeout(retry);
      retry = null;
      if (keepalive !== null) timers.clearInterval(keepalive);
      keepalive = null;
      const s = socket;
      socket = null;
      s?.close();
      setStatus('off');
    },
    status: () => state
  };
}
