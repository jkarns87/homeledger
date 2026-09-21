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
  url?: string;
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
  url?: string;
  reresolve?: () => Promise<string>;
  newAgentCoreSessionId?: () => string;
}

function harness(options: HarnessOptions) {
  const written: string[] = [];
  const logs: string[] = [];
  const asked: string[] = [];
  const tokens = options.tokens ?? ['token-one'];
  let tokenIndex = 0;
  let bridge!: Bridge;

  bridge = new Bridge({
    url: options.url ?? URL_UNDER_TEST,
    token: async () => tokens[Math.min(tokenIndex++, tokens.length - 1)]!,
    invalidateToken: () => undefined,
    agentCoreSessionId: options.agentCoreSessionId,
    standaloneStream: options.standaloneStream ?? false,
    fetchImpl: options.fetchImpl,
    reresolve: options.reresolve,
    newAgentCoreSessionId: options.newAgentCoreSessionId,
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

  it('drops a line from the client that is not JSON, rather than crashing the relay', async () => {
    const { fetchImpl, seen } = refusing([200]);
    const h = harness({ fetchImpl });
    await h.bridge.handleClientMessage('not json at all');
    expect(seen).toHaveLength(0);
    expect(h.written).toEqual([]);
    expect(h.logs[0]).toContain('not JSON');
  });
});

/** The body `apps/mcp-server/src/legacy.ts` line 50 writes for a session its microVM does not hold. */
const LOST_SESSION_BODY = JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
/** The envelope AgentCore wrapped it in for the owner's client, quoted from the FL-039 transcript. */
const WRAPPED_404 = JSON.stringify({
  jsonrpc: '2.0',
  id: null,
  error: { code: -32010, message: 'Received error (404) from runtime. Please check your CloudWatch logs for more information.' }
});

/**
 * AgentCore in front of a HomeLedger container whose instance can be recycled
 * out from under a live session, which is the failure FL-039 records.
 *
 * Faithful to `apps/mcp-server/src/legacy.ts` on the three branches that
 * matter: a POST carrying an initialize body and no session header mints a
 * session, a POST carrying a session header the map does not hold answers 404
 * `-32001`, and anything else with a known session is served. `recycle()`
 * empties the map exactly as a restarted microVM would.
 */
function recyclableUpstream(options: { wrap?: boolean; recycleEvery?: boolean; only?: string } = {}) {
  const sessions = new Set<string>();
  const seen: Seen[] = [];
  let minted = 0;

  const lost = (): Response =>
    options.wrap
      ? new Response(WRAPPED_404, { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(LOST_SESSION_BODY, { status: 404 });

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit);
    const raw = typeof init?.body === 'string' ? init.body : '';
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    const address = String(url);
    seen.push({ method: init?.method ?? 'GET', headers, body, url: address });
    // A bridge that retried without a bound would otherwise exhaust the test
    // runner rather than fail an assertion, and "the suite died" is a much
    // worse signal than "the suite said which invariant broke".
    if (seen.length > 24) throw new Error(`the bridge sent ${seen.length} requests for one message; the repair is not bounded`);
    if ((init?.method ?? 'GET') !== 'POST') return new Response(null, { status: 405 });
    // `only` models a recreated runtime: the old address names nothing.
    if (options.only && address !== options.only) return new Response('', { status: 404 });

    const message = body as { id?: number; method?: string } | undefined;
    const sessionId = headers.get('mcp-session-id') ?? undefined;

    if (message?.method === 'initialize' && !sessionId) {
      minted += 1;
      const id = `session-${minted}`;
      sessions.add(id);
      if (options.recycleEvery) sessions.clear();
      return new Response(
        sse({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'homeledger', version: '0.1.0' } }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': id } }
      );
    }
    if (!sessionId)
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Session ID required' } }), { status: 400 });
    if (!sessions.has(sessionId)) return lost();
    if (message?.id === undefined) return new Response(null, { status: 202 });
    return new Response(sse({ jsonrpc: '2.0', id: message.id, result: { servedBy: sessionId } }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, seen, recycle: () => sessions.clear(), posts: () => seen.filter(s => s.method === 'POST') };
}

const toolCall = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_appliances' } });
const parsed = (lines: string[]) =>
  lines.map(line => JSON.parse(line) as { id?: number | null; result?: { servedBy?: string }; error?: { code: number; message: string } });

describe('Bridge, when the runtime instance holding the session is recycled', () => {
  it('rebuilds the session and replays the call, so an idle conversation comes back to a working tool', async () => {
    const up = recyclableUpstream();
    const h = harness({ fetchImpl: up.fetchImpl });
    await h.initialize();
    const original = h.bridge.sessionId;

    up.recycle();
    await h.bridge.handleClientMessage(toolCall(2));

    const messages = parsed(h.written);
    expect(messages.at(-1)).toMatchObject({ id: 2, result: { servedBy: 'session-2' } });
    expect(messages.at(-1)?.error).toBeUndefined();
    expect(h.bridge.sessionId).toBe('session-2');
    expect(h.bridge.sessionId).not.toBe(original);
  });

  it('heals the same way when AgentCore wraps the 404 into a -32010 on a 200, which is the shape that actually reached the owner', async () => {
    const up = recyclableUpstream({ wrap: true });
    const h = harness({ fetchImpl: up.fetchImpl });
    await h.initialize();
    up.recycle();
    await h.bridge.handleClientMessage(toolCall(2));
    expect(parsed(h.written).at(-1)).toMatchObject({ id: 2, result: { servedBy: 'session-2' } });
  });

  it('never lets a raw -32010 through to the client, healed or not', async () => {
    const up = recyclableUpstream({ wrap: true, recycleEvery: true });
    const h = harness({ fetchImpl: up.fetchImpl });
    await h.initialize();
    await h.bridge.handleClientMessage(toolCall(2));
    const failure = parsed(h.written).at(-1)!;
    const message = failure.error!.message;
    expect(failure.error?.code).toBe(-32603);
    // The raw envelope is still quoted — hiding what the endpoint said would
    // be its own kind of lying — but it is quoted at the end, behind the
    // explanation and behind the notice. The owner's client read `-32010` as
    // the whole message because it was the whole message.
    expect(message.startsWith('The HomeLedger MCP session no longer exists')).toBe(true);
    expect(message.indexOf('NO DATA WAS RETRIEVED')).toBeLessThan(message.indexOf('Received error (404) from runtime'));
  });

  it('tells the client in as many words that nothing was read, so the failure cannot be answered around', async () => {
    const up = recyclableUpstream({ recycleEvery: true });
    const h = harness({ fetchImpl: up.fetchImpl });
    await h.initialize();
    await h.bridge.handleClientMessage(toolCall(2));
    const message = parsed(h.written).at(-1)!.error!.message;
    expect(message).toContain('NO DATA WAS RETRIEVED');
    expect(message).toContain('repository fixtures');
    expect(message).toContain('replayed this call once');
  });

  it('does not relay the replayed handshake to the client, which already had its answer', async () => {
    const up = recyclableUpstream();
    const h = harness({ fetchImpl: up.fetchImpl });
    await h.initialize();
    up.recycle();
    await h.bridge.handleClientMessage(toolCall(2));
    // Exactly one response on the initialize's id. A second would be a reply
    // to a request the client considers settled.
    expect(parsed(h.written).filter(m => m.id === 1)).toHaveLength(1);
  });

  it('repairs at most once per message, so an endpoint that always 404s cannot spin', async () => {
    const up = recyclableUpstream({ recycleEvery: true });
    const h = harness({ fetchImpl: up.fetchImpl });
    await h.initialize();
    await h.bridge.handleClientMessage(toolCall(2));
    // initialize, the call, the rebuilt initialize, the one replay. No fifth.
    expect(up.posts()).toHaveLength(4);
  });

  it('replays the client’s own initialize rather than one of its own invention', async () => {
    const up = recyclableUpstream();
    const h = harness({ fetchImpl: up.fetchImpl });
    await h.bridge.handleClientMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'claude-code' } } })
    );
    up.recycle();
    await h.bridge.handleClientMessage(toolCall(2));
    const handshakes = up.posts().filter(p => (p.body as { method?: string }).method === 'initialize');
    expect(handshakes).toHaveLength(2);
    expect(handshakes[1]?.body).toEqual(handshakes[0]?.body);
    expect(handshakes[1]?.headers.get('mcp-session-id')).toBeNull();
  });

  it('replays notifications/initialized too, so the rebuilt session reaches the state the first one did', async () => {
    const up = recyclableUpstream();
    const h = harness({ fetchImpl: up.fetchImpl });
    await h.initialize();
    await h.bridge.handleClientMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    up.recycle();
    await h.bridge.handleClientMessage(toolCall(2));
    const acks = up.posts().filter(p => (p.body as { method?: string }).method === 'notifications/initialized');
    expect(acks).toHaveLength(2);
    expect(acks[1]?.headers.get('mcp-session-id')).toBe('session-2');
  });

  it('rebuilds once for several requests that fail together, not once each', async () => {
    const up = recyclableUpstream();
    const h = harness({ fetchImpl: up.fetchImpl });
    await h.initialize();
    up.recycle();
    await Promise.all([h.bridge.handleClientMessage(toolCall(2)), h.bridge.handleClientMessage(toolCall(3)), h.bridge.handleClientMessage(toolCall(4))]);
    const handshakes = up.posts().filter(p => (p.body as { method?: string }).method === 'initialize');
    expect(handshakes).toHaveLength(2);
    expect(
      parsed(h.written)
        .filter(m => m.error)
        .map(m => m.id)
    ).toEqual([]);
  });

  it('rotates the AgentCore runtime session id it minted, so the replay is not sent back to the dead instance', async () => {
    const up = recyclableUpstream();
    let next = 0;
    const h = harness({
      fetchImpl: up.fetchImpl,
      agentCoreSessionId: 'homeledger-bridge-generated-session-value-one',
      newAgentCoreSessionId: () => `homeledger-bridge-generated-session-value-${++next}`
    });
    await h.initialize();
    up.recycle();
    await h.bridge.handleClientMessage(toolCall(2));
    expect(h.bridge.runtimeSessionId).toBe('homeledger-bridge-generated-session-value-1');
    expect(up.posts().at(-1)?.headers.get('x-amzn-bedrock-agentcore-runtime-session-id')).toBe('homeledger-bridge-generated-session-value-1');
  });

  it('leaves a runtime session id the owner pinned exactly as pinned', async () => {
    const up = recyclableUpstream();
    const pinned = 'homeledger-bridge-pinned-session-identifier';
    const h = harness({ fetchImpl: up.fetchImpl, agentCoreSessionId: pinned });
    await h.initialize();
    up.recycle();
    await h.bridge.handleClientMessage(toolCall(2));
    expect(h.bridge.runtimeSessionId).toBe(pinned);
    expect(up.posts().every(p => (p.headers.get('x-amzn-bedrock-agentcore-runtime-session-id') ?? pinned) === pinned)).toBe(true);
  });
});

describe('Bridge, when the address names no runtime', () => {
  const NEW_URL = 'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/new/invocations?qualifier=DEFAULT';

  it('re-resolves by name and retries, turning a rotated runtime into a working session', async () => {
    const up = recyclableUpstream({ only: NEW_URL });
    const h = harness({ fetchImpl: up.fetchImpl, reresolve: async () => NEW_URL });
    await h.initialize();
    expect(h.bridge.endpoint).toBe(NEW_URL);
    expect(parsed(h.written).at(-1)).toMatchObject({ id: 1 });
    expect(parsed(h.written).at(-1)?.error).toBeUndefined();
  });

  it('reports rather than retrying when the name resolves to the address already in use', async () => {
    // The runtime exists under the name, so the 404 is about something else
    // and a replay at the same URL would only reproduce it.
    const up = recyclableUpstream({ only: NEW_URL });
    const h = harness({ fetchImpl: up.fetchImpl, url: URL_UNDER_TEST, reresolve: async () => URL_UNDER_TEST });
    await h.initialize();
    expect(up.posts()).toHaveLength(1);
    expect(parsed(h.written).at(-1)?.error?.message).toContain('runtime this bridge is addressing does not exist');
    expect(h.logs.join('\n')).toContain('address already in use');
  });

  it('reports the original failure when re-resolution itself fails, rather than the re-resolution’s', async () => {
    const up = recyclableUpstream({ only: NEW_URL });
    const h = harness({ fetchImpl: up.fetchImpl, reresolve: async () => Promise.reject(new Error('Your AWS SSO session expired')) });
    await h.initialize();
    expect(parsed(h.written).at(-1)?.error?.message).toContain('runtime this bridge is addressing does not exist');
    expect(h.logs.join('\n')).toContain('Your AWS SSO session expired');
  });

  it('does not go looking for a replacement when the address was supplied rather than resolved', async () => {
    const up = recyclableUpstream({ only: NEW_URL });
    const h = harness({ fetchImpl: up.fetchImpl });
    await h.initialize();
    expect(up.posts()).toHaveLength(1);
    expect(parsed(h.written).at(-1)?.error?.message).toContain('did not look for a replacement');
  });

  it('says nothing was read here too, because a missing runtime is not an empty household either', async () => {
    const up = recyclableUpstream({ only: NEW_URL });
    const h = harness({ fetchImpl: up.fetchImpl });
    await h.initialize();
    expect(parsed(h.written).at(-1)?.error?.message).toContain('NO DATA WAS RETRIEVED');
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
