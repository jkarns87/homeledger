import { readFileSync } from 'node:fs';

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
