import { readFileSync } from 'node:fs';
import type { BusEntry, EventPublisher } from '../src/aws/bus.js';
import { webhookSignature } from '../src/ring/hmac.js';

/** A Ring fixture's `payload` (Task 1). The wrapper's `source` names the Ring document it came from. */
export function fixture<T = unknown>(name: string): T {
  return (JSON.parse(readFileSync(new URL(`./fixtures/ring/${name}.json`, import.meta.url), 'utf8')) as { payload: T }).payload;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  redirect: RequestRedirect | undefined;
}

/** A fetch that records every request and answers from `respond`. Nothing leaves the process. */
export function fakeFetch(respond: (req: RecordedRequest) => Response | Promise<Response>): { fetch: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    const body = init?.body === undefined || init.body === null ? null : init.body instanceof URLSearchParams ? init.body.toString() : String(init.body);
    const req: RecordedRequest = { url: String(input), method: init?.method ?? 'GET', headers, body, redirect: init?.redirect };
    calls.push(req);
    return respond(req);
  };
  return { fetch: impl as typeof fetch, calls };
}

export const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A clock that only moves when told to. `sleep` advances it and records the delay. */
export function clock(startMs: number): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[]; advance: (ms: number) => void } {
  let t = startMs;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async ms => {
      slept.push(ms);
      t += ms;
    },
    slept,
    advance: ms => {
      t += ms;
    }
  };
}

/** Three bytes of JPEG magic plus filler; four of PNG; and bytes that are neither. */
export const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const OPAQUE_BYTES = Buffer.from('ENCRYPTED-CONTENT-v1', 'utf8');

export const TEST_HMAC_KEY = 'test-hmac-signing-key';

export function recordingPublisher(): { publish: EventPublisher; entries: BusEntry[]; failNext: (n: number) => void } {
  const entries: BusEntry[] = [];
  let failures = 0;
  return {
    entries,
    failNext: n => {
      failures = n;
    },
    publish: async batch => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('EventBridge refused 1 of 1 entries: InternalFailure');
      }
      entries.push(...batch);
    }
  };
}

/** A webhook request as API Gateway (HTTP API, payload v2) hands it over: lower-case headers, body as a string. */
export function signedRequest(payload: unknown, opts: { key?: string; base64?: boolean; signature?: string | null } = {}) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = opts.signature === undefined ? webhookSignature(raw, opts.key ?? TEST_HMAC_KEY) : opts.signature;
  return {
    body: opts.base64 ? raw.toString('base64') : raw.toString('utf8'),
    isBase64Encoded: opts.base64 === true,
    headers: { 'content-type': 'application/json', ...(signature === null ? {} : { 'x-signature': signature }) } as Record<string, string | undefined>
  };
}
