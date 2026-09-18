import { afterEach, describe, expect, it } from 'vitest';
import { Bridge, createLineReader, protocolVersionOf, requestIdsOf } from '../src/proxy.js';
import { REDACTION, protectSecret, resetProtectedSecrets } from '../src/redact.js';

afterEach(() => {
  resetProtectedSecrets();
});

const URL_UNDER_TEST = 'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/x/invocations?qualifier=DEFAULT';
const SESSION_ID = '9f1c0f0e-0000-4000-8000-000000000001';

interface Seen {
  method: string;
  headers: Headers;
  body: unknown;
}

const encoder = new TextEncoder();
const sse = (message: unknown) => encoder.encode(`data: ${JSON.stringify(message)}\n\n`);

/**
 * A stand-in for AgentCore plus the deployed server, shaped to the HTTP trace
 * this server actually produces for `book_service`: the `tools/call` POST
 * answers with an event stream that carries three `elicitation/create` requests
 * and only closes once each has been answered — by a separate POST that has to
 * be sent while this response is still open.
 */
function fakeUpstream(options: { elicitFields?: string[] } = {}) {
  const fields = options.elicitFields ?? ['provider', 'window', 'confirm'];
  const seen: Seen[] = [];
  const answers = new Map<number, () => void>();
  let nextServerId = 100;

  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit);
    const raw = typeof init?.body === 'string' ? init.body : '';
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    seen.push({ method: init?.method ?? 'GET', headers, body });

    if ((init?.method ?? 'GET') === 'GET') return new Response(null, { status: 405 });
    if ((init?.method ?? 'GET') === 'DELETE') return new Response(null, { status: 204 });

    const message = body as { id?: number; method?: string; result?: unknown };

    // An answer to a server-initiated request: resolve the round it unblocks.
    if (message.method === undefined && typeof message.id === 'number') {
      answers.get(message.id)?.();
      answers.delete(message.id);
      return new Response(null, { status: 202 });
    }
    if (message.method === 'initialize') {
      return new Response(
        sse({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'homeledger', version: '0.1.0' } }
        }),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'mcp-session-id': SESSION_ID }
        }
      );
    }
    if (message.id === undefined) return new Response(null, { status: 202 });

    const callId = message.id;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          for (const field of fields) {
            const id = nextServerId++;
            const answered = new Promise<void>(resolve => answers.set(id, resolve));
            controller.enqueue(
              sse({
                jsonrpc: '2.0',
                id,
                method: 'elicitation/create',
                params: { mode: 'form', message: `Which ${field}?`, requestedSchema: { type: 'object', properties: { [field]: { type: 'string' } } } }
              })
            );
            await answered;
            controller.enqueue(
              sse({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: { progressToken: callId, progress: fields.indexOf(field) + 1, total: fields.length }
              })
            );
          }
          controller.enqueue(
            sse({
              jsonrpc: '2.0',
              id: callId,
              result: {
                content: [{ type: 'text', text: 'Booked Kettle Creek Water Heaters.' }],
                structuredContent: { visitId: 'visit_abcdefgh12345678', status: 'scheduled' }
              }
            })
          );
          controller.close();
        })();
      }
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;

  return { fetchImpl, seen };
}

interface HarnessOptions {
  fetchImpl: typeof fetch;
  agentCoreSessionId?: string;
  standaloneStream?: boolean;
  tokens?: string[];
  /** Answers elicitation requests as Claude Code would: on receipt, over a separate request. */
  autoAnswer?: boolean;
}

function harness(options: HarnessOptions) {
  const written: string[] = [];
  const logs: string[] = [];
  const asked: string[] = [];
  const tokens = options.tokens ?? ['token-one'];
  let tokenIndex = 0;
  let bridge!: Bridge;

  bridge = new Bridge({
    url: URL_UNDER_TEST,
    token: async () => tokens[Math.min(tokenIndex++, tokens.length - 1)]!,
    invalidateToken: () => undefined,
    agentCoreSessionId: options.agentCoreSessionId,
    standaloneStream: options.standaloneStream ?? false,
    fetchImpl: options.fetchImpl,
    write: line => {
      written.push(line);
      if (!options.autoAnswer) return;
      const message = JSON.parse(line) as { id?: number; method?: string; params?: { message?: string } };
      if (message.method !== 'elicitation/create' || typeof message.id !== 'number') return;
      asked.push(message.params?.message ?? '');
      // Exactly what a real client does: a new outbound request, sent while the
      // request that asked the question is still open.
      void bridge.handleClientMessage(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { action: 'accept', content: {} } }));
    },
    log: message => logs.push(message)
  });

  const initialize = () =>
    bridge.handleClientMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }));
  return { bridge, written, logs, asked, initialize };
}

describe('requestIdsOf', () => {
  it('returns the id of a request', () => {
    expect(requestIdsOf({ jsonrpc: '2.0', id: 4, method: 'tools/call' })).toEqual([4]);
  });

  it('returns nothing for a notification, which has no id to answer', () => {
    expect(requestIdsOf({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual([]);
  });

  it('returns nothing for a response, which is not awaiting an answer', () => {
    expect(requestIdsOf({ jsonrpc: '2.0', id: 100, result: { action: 'accept' } })).toEqual([]);
  });

  it('returns every request id in a batch', () => {
    expect(requestIdsOf([{ id: 1, method: 'a' }, { method: 'b' }, { id: 'two', method: 'c' }])).toEqual([1, 'two']);
  });
});

describe('protocolVersionOf', () => {
  it('reads the negotiated version out of an initialize result', () => {
    expect(protocolVersionOf({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25' } })).toBe('2025-11-25');
  });

  it('is undefined for any other message', () => {
    expect(protocolVersionOf({ jsonrpc: '2.0', id: 1, result: { tools: [] } })).toBeUndefined();
    expect(protocolVersionOf({ jsonrpc: '2.0', method: 'notifications/progress' })).toBeUndefined();
  });
});

describe('createLineReader', () => {
  it('emits one message per newline and holds a partial line back', () => {
    const lines: string[] = [];
    const feed = createLineReader(line => lines.push(line));
    feed('{"a":1}\n{"b":');
    expect(lines).toEqual(['{"a":1}']);
    feed('2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('drops blank lines and trims a CR before the newline', () => {
    const lines: string[] = [];
    const feed = createLineReader(line => lines.push(line));
    feed('{"a":1}\r\n\n  \n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe('Bridge, over the elicitation flow', () => {
  it('relays all three questions and the booking result, answering each while the call is still open', async () => {
    const { fetchImpl, seen } = fakeUpstream();
    const h = harness({ fetchImpl, autoAnswer: true });
    await h.initialize();

    // This await cannot resolve unless the questions reached the client and the
    // answers were sent on separate requests while this one was still open. A
    // bridge that buffered the response, or that serialised requests, hangs
    // here rather than failing an assertion.
    await h.bridge.handleClientMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'book_service', arguments: { applianceId: 'appl_x', issue: 'leak' } } })
    );

    expect(h.asked).toEqual(['Which provider?', 'Which window?', 'Which confirm?']);

    const relayed = h.written.map(line => JSON.parse(line) as { id?: number; method?: string; result?: { structuredContent?: { visitId?: string } } });
    expect(relayed.filter(m => m.method === 'elicitation/create')).toHaveLength(3);
    expect(relayed.filter(m => m.method === 'notifications/progress')).toHaveLength(3);
    expect(relayed.at(-1)?.result?.structuredContent?.visitId).toBe('visit_abcdefgh12345678');

    // The three answers are separate POSTs, which is the shape that proves they
    // did not ride back on the response of the call that asked.
    const answerPosts = seen.filter(
      s => s.method === 'POST' && (s.body as { method?: string; id?: number }).method === undefined && typeof (s.body as { id?: number }).id === 'number'
    );
    expect(answerPosts).toHaveLength(3);
  });

  it('carries the session id from the initialize response onto every later request', async () => {
    const { fetchImpl, seen } = fakeUpstream();
    const h = harness({ fetchImpl, autoAnswer: true });
    await h.initialize();
    expect(h.bridge.sessionId).toBe(SESSION_ID);
    await h.bridge.handleClientMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'book_service' } }));
    const later = seen.slice(1);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every(s => s.headers.get('mcp-session-id') === SESSION_ID)).toBe(true);
    // The initialize request itself cannot carry one; there is no session yet.
    expect(seen[0]?.headers.get('mcp-session-id')).toBeNull();
  });

  it('adds the negotiated protocol version header that stdio has no way to send', async () => {
    const { fetchImpl, seen } = fakeUpstream({ elicitFields: [] });
    const h = harness({ fetchImpl });
    await h.initialize();
    await h.bridge.handleClientMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    expect(seen[0]?.headers.get('mcp-protocol-version')).toBeNull();
    expect(seen[1]?.headers.get('mcp-protocol-version')).toBe('2025-11-25');
  });

  it('pins the AgentCore runtime session when configured', async () => {
    const { fetchImpl, seen } = fakeUpstream({ elicitFields: [] });
    const h = harness({ fetchImpl, agentCoreSessionId: 'homeledger-bridge-pinned-session-identifier' });
    await h.initialize();
    expect(seen[0]?.headers.get('x-amzn-bedrock-agentcore-runtime-session-id')).toBe('homeledger-bridge-pinned-session-identifier');
  });

  it('sends no runtime session header when pinning is off', async () => {
    const { fetchImpl, seen } = fakeUpstream({ elicitFields: [] });
    const h = harness({ fetchImpl, agentCoreSessionId: undefined });
    await h.initialize();
    expect(seen[0]?.headers.get('x-amzn-bedrock-agentcore-runtime-session-id')).toBeNull();
  });

  it('writes nothing to the protocol channel for a 202', async () => {
    const { fetchImpl } = fakeUpstream({ elicitFields: [] });
    const h = harness({ fetchImpl });
    await h.initialize();
    const before = h.written.length;
    await h.bridge.handleClientMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect(h.written).toHaveLength(before);
  });
});

describe('Bridge, when the endpoint refuses', () => {
  function refusing(statuses: number[], body = '{"message":"Forbidden"}') {
    const seen: Seen[] = [];
    let index = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push({ method: init?.method ?? 'GET', headers: new Headers(init?.headers as HeadersInit), body: undefined });
      const status = statuses[Math.min(index++, statuses.length - 1)]!;
      if (status === 200)
        return new Response(sse({ jsonrpc: '2.0', id: 1, result: { ok: true } }), { status, headers: { 'content-type': 'text/event-stream' } });
      return new Response(body, { status });
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  }

  it('refreshes the token and retries exactly once on a 401', async () => {
    const { fetchImpl, seen } = refusing([401, 200]);
    const h = harness({ fetchImpl, tokens: ['stale-token', 'fresh-token'] });
    await h.bridge.handleClientMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(seen).toHaveLength(2);
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer stale-token');
    expect(seen[1]?.headers.get('authorization')).toBe('Bearer fresh-token');
    expect(JSON.parse(h.written[0]!)).toMatchObject({ result: { ok: true } });
  });

  it('gives up after one retry rather than looping on a configuration problem', async () => {
    const { fetchImpl, seen } = refusing([401, 401]);
    const h = harness({ fetchImpl, tokens: ['stale-token', 'fresh-token'] });
    await h.bridge.handleClientMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(seen).toHaveLength(2);
  });

  it('answers the pending request id with an error instead of leaving the client waiting forever', async () => {
    const { fetchImpl } = refusing([500, 500], '{"message":"internal"}');
    const h = harness({ fetchImpl });
    await h.bridge.handleClientMessage(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list' }));
    const message = JSON.parse(h.written[0]!) as { id: number; error: { code: number; message: string } };
    expect(message.id).toBe(42);
    expect(message.error.code).toBe(-32603);
    expect(message.error.message).toContain('AgentCore or the runtime returned 500');
  });

  it('never puts a registered secret into the error it hands back to the client', async () => {
    // The endpoint reflects the bearer token into its own error body. Without
    // redaction at this boundary the token would be written to stdout, where
    // the client logs it.
    protectSecret('bearer-token-that-must-never-be-printed');
    const { fetchImpl } = refusing([500, 500], '{"message":"upstream saw bearer-token-that-must-never-be-printed"}');
    const h = harness({ fetchImpl, tokens: ['bearer-token-that-must-never-be-printed'] });
    await h.bridge.handleClientMessage(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list' }));
    expect(h.written[0]).not.toContain('bearer-token-that-must-never-be-printed');
    expect(h.written[0]).toContain(REDACTION);
  });

  it('explains a lost session in terms of what to do about it', async () => {
    const { fetchImpl } = refusing([404, 404], '{"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"}}');
    const h = harness({ fetchImpl });
    await h.bridge.handleClientMessage(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }));
    expect(h.logs[0]).toContain('Restart the MCP connection');
  });

  it('drops a line from the client that is not JSON, rather than crashing the relay', async () => {
    const { fetchImpl, seen } = refusing([200]);
    const h = harness({ fetchImpl });
    await h.bridge.handleClientMessage('not json at all');
    expect(seen).toHaveLength(0);
    expect(h.written).toEqual([]);
    expect(h.logs[0]).toContain('not JSON');
  });
});

describe('Bridge shutdown', () => {
  it('terminates the session with a DELETE carrying the session id', async () => {
    const { fetchImpl, seen } = fakeUpstream({ elicitFields: [] });
    const h = harness({ fetchImpl });
    await h.initialize();
    await h.bridge.close();
    const del = seen.find(s => s.method === 'DELETE');
    expect(del?.headers.get('mcp-session-id')).toBe(SESSION_ID);
  });

  it('sends no DELETE when no session was ever established', async () => {
    const { fetchImpl, seen } = fakeUpstream();
    const h = harness({ fetchImpl });
    await h.bridge.close();
    expect(seen.filter(s => s.method === 'DELETE')).toEqual([]);
  });

  it('survives a DELETE the endpoint refuses, which AgentCore has been observed to do', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.method ?? 'GET');
      if (init?.method === 'DELETE') return new Response('{"error":{"code":-32001}}', { status: 404 });
      return new Response(sse({ jsonrpc: '2.0', id: 1, result: {} }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'mcp-session-id': SESSION_ID }
      });
    }) as unknown as typeof fetch;
    const h = harness({ fetchImpl });
    await h.initialize();
    await expect(h.bridge.close()).resolves.toBeUndefined();
  });
});

describe('Bridge standalone stream', () => {
  it('stops trying when the endpoint answers 405, and says so once', async () => {
    const { fetchImpl, seen } = fakeUpstream({ elicitFields: [] });
    const h = harness({ fetchImpl, standaloneStream: true });
    await h.initialize();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(seen.filter(s => s.method === 'GET')).toHaveLength(1);
    expect(h.logs.filter(line => line.includes('does not offer a standalone event stream'))).toHaveLength(1);
    await h.bridge.close();
  });

  it('opens no stream at all when disabled', async () => {
    const { fetchImpl, seen } = fakeUpstream({ elicitFields: [] });
    const h = harness({ fetchImpl, standaloneStream: false });
    await h.initialize();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(seen.filter(s => s.method === 'GET')).toEqual([]);
    await h.bridge.close();
  });
});
