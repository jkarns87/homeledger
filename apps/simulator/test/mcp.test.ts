import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@homeledger/mcp-server/app';
import { seededDeps } from '@homeledger/mcp-server/test-harness';
import { HomeLedgerMcp, isLostSessionError, isUnauthorizedError, toDescriptors } from '../src/server/mcp.js';

let server: Server | undefined;
let closeApp: () => Promise<void> = async () => {};
let closeClient: () => Promise<void> = async () => {};

afterEach(async () => {
  await closeClient();
  await closeApp();
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  closeApp = async () => {};
  closeClient = async () => {};
});

async function listen(): Promise<string> {
  const deps = await seededDeps();
  const app = createApp(deps);
  closeApp = app.close;
  server = app.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  return `http://127.0.0.1:${(server!.address() as { port: number }).port}/mcp`;
}

describe('isLostSessionError', () => {
  it('recognises the one 404 this container produces, and nothing else', () => {
    expect(isLostSessionError({ code: -32001, message: 'Session not found' })).toBe(true);
    expect(isLostSessionError(new Error('HTTP 404: Session not found'))).toBe(true);
    expect(isLostSessionError({ code: 404, message: 'Not Found' })).toBe(true);
    expect(isLostSessionError(new Error('HTTP 401: Unauthorized'))).toBe(false);
    expect(isLostSessionError(new Error('ECONNREFUSED'))).toBe(false);
    expect(isLostSessionError(undefined)).toBe(false);
  });

  it('needs every arm it has: each of the three is the only one that answers for its own input', () => {
    // Written because mutation check 3 asked whether the `-32001` arm is
    // decorative. It is not reachable from THIS server through the SDK - the
    // transport raises `StreamableHTTPError` carrying the HTTP status, so the
    // socket tests below all travel the `code === 404` arm - but AgentCore
    // relays a container status as a JSON-RPC envelope of its own, and a
    // -32001 arriving without a 404 beside it is the shape that produces. Each
    // assertion here is the ONLY input its arm answers for, so deleting any one
    // arm fails exactly one line and no other.
    expect(isLostSessionError({ code: -32001, message: '' })).toBe(true); // only the -32001 arm
    expect(isLostSessionError({ code: 404, message: '' })).toBe(true); // only the status arm
    expect(isLostSessionError(new Error('Session not found (404)'))).toBe(true); // only the sentence arm
    // The sentence arm needs BOTH halves, so neither half alone widens it into
    // a 404 that is about the address rather than the session.
    expect(isLostSessionError(new Error('HTTP 404: no such runtime'))).toBe(false);
    expect(isLostSessionError(new Error('Session not found, but no status here'))).toBe(false);
  });
});

describe('isUnauthorizedError', () => {
  it('recognises a refused bearer, and does not confuse it with a lost session', () => {
    // A rotated Cognito client secret produces this and a rebuilt session
    // fixes none of it; a recycled instance produces the 404 above and a fresh
    // token fixes none of that. The two repairs are different, so the two
    // predicates must not overlap on any input either of them sees.
    expect(isUnauthorizedError(new Error('HTTP 401: Unauthorized'))).toBe(true);
    expect(isUnauthorizedError(new Error('HTTP 403: Forbidden'))).toBe(true);
    expect(isUnauthorizedError({ code: 401, message: 'Unauthorized' })).toBe(true);
    expect(isUnauthorizedError({ code: 403, message: 'Forbidden' })).toBe(true);
    expect(isUnauthorizedError(new Error('HTTP 404: Session not found'))).toBe(false);
    expect(isUnauthorizedError({ code: -32001, message: 'Session not found' })).toBe(false);
    expect(isUnauthorizedError(new Error('ECONNREFUSED'))).toBe(false);
    expect(isUnauthorizedError(undefined)).toBe(false);
  });
});

describe('toDescriptors', () => {
  it('keeps the order it was given, adding and dropping nothing', () => {
    // The property this wrapper owns. The SERVER owns which tools there are
    // and what order they come in - `apps/mcp-server/test/tools.test.ts`
    // asserts that, there - and Global Constraint 30 forbids restating its
    // list here. What can go wrong on this side is a sort, a filter or a
    // dropped field on the way through, and that is what this pins, against
    // an input written for the purpose rather than against the real nine.
    const input = [
      { name: 'zebra', description: 'z', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://homeledger/appliances' } } },
      { name: 'alpha', description: undefined, inputSchema: { type: 'object' } },
      { name: 'middle', description: 'm', inputSchema: { type: 'object' } }
    ];
    expect(toDescriptors(input).map(t => t.name)).toEqual(['zebra', 'alpha', 'middle']);
    expect(toDescriptors(input)[0]?._meta).toEqual({ ui: { resourceUri: 'ui://homeledger/appliances' } });
    expect(toDescriptors(input)[1]?.description).toBeUndefined();
  });
});

describe('HomeLedgerMcp against a real socket', () => {
  it('passes the server tool list through exactly as the wire delivered it', async () => {
    const url = await listen();
    const mcp = new HomeLedgerMcp({ url, token: async () => 'unused-locally', onElicit: async () => ({ action: 'cancel' }) });
    closeClient = () => mcp.close();
    await mcp.connect();
    expect(mcp.sessionId).toBeDefined();
    const names = (await mcp.listTools()).map(t => t.name);

    // Compared against a second, unwrapped SDK client reading the same
    // `tools/list` - not against a list written here. That keeps Global
    // Constraint 30 ("assert on tools/list's own order, not on a literal of
    // your own") while still being able to fail: a sort, a filter or a
    // truncation inside HomeLedgerMcp shows up as a difference, and a change
    // to the server's own order moves both sides together, which is correct
    // because the server's order is the server's test's business.
    const bare = new Client({ name: 'order-control', version: '0.0.0' }, { capabilities: {} });
    await bare.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      expect(names).toEqual((await bare.listTools()).tools.map(t => t.name));
    } finally {
      await bare.close();
    }
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes the negotiated protocol version, not a version of its own', async () => {
    const url = await listen();
    const mcp = new HomeLedgerMcp({ url, token: async () => 'unused-locally', onElicit: async () => ({ action: 'cancel' }) });
    closeClient = () => mcp.close();
    expect(mcp.protocolVersion).toBeUndefined();
    await mcp.connect();
    // Whatever the two ends settled on, read back off the transport that
    // settled it. Spec section 7 asks the debug drawer to show this, and the
    // only honest source for it is the handshake.
    expect(mcp.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('logs every JSON-RPC method it sends, with a status and a duration, and no payload', async () => {
    const url = await listen();
    const mcp = new HomeLedgerMcp({ url, token: async () => 'unused-locally', onElicit: async () => ({ action: 'cancel' }) });
    closeClient = () => mcp.close();
    await mcp.connect();
    await mcp.callTool('list_appliances', {});
    const methods = mcp.jsonRpcLog.map(entry => entry.method);
    expect(methods).toContain('initialize');
    expect(methods).toContain('tools/call');
    const call = mcp.jsonRpcLog.find(entry => entry.method === 'tools/call');
    expect(call?.direction).toBe('out');
    expect(call?.status).toBe(200);
    expect(call?.ms).toBeGreaterThanOrEqual(0);
    // Methods and timings, never bodies. The drawer that renders this is
    // served by /api/debug, which asserts that nothing it returns contains
    // 'token' - and every progress notification on this server carries a
    // `progressToken`. Logging payloads would put household data and that
    // word on a diagnostic endpoint at once.
    expect(JSON.stringify(mcp.jsonRpcLog)).not.toContain('appliances');
  });

  it('drives the three-round booking, answering each question through onElicit', async () => {
    const url = await listen();
    const asked: string[] = [];
    const mcp = new HomeLedgerMcp({
      url,
      token: async () => 'unused-locally',
      onElicit: async prompt => {
        const properties = (prompt.requestedSchema as { properties: Record<string, unknown> }).properties;
        const field = Object.keys(properties)[0] ?? '';
        asked.push(field);
        if (field === 'provider') return { action: 'accept', content: { provider: 'prov_kettle_water' } };
        if (field === 'window') return { action: 'accept', content: { window: 'win_1' } };
        return { action: 'accept', content: { confirm: true } };
      }
    });
    closeClient = () => mcp.close();
    await mcp.connect();
    const list = (await mcp.callTool('list_appliances', { category: 'water_heater' })) as { structuredContent: { appliances: Array<{ id: string }> } };
    const applianceId = list.structuredContent.appliances[0]!.id;

    const progress: number[] = [];
    const result = (await mcp.callTool('book_service', { applianceId, issue: 'water heater leaking at the base' }, p => progress.push(p.progress))) as {
      structuredContent: { provider: string; status: string };
    };

    expect(asked).toEqual(['provider', 'window', 'confirm']);
    expect(result.structuredContent.provider).toBe('Kettle Creek Water Heaters');
    expect(result.structuredContent.status).toBe('scheduled');
    expect(progress).toEqual([0, 1, 2, 3]);
  });

  it('runs a second call to completion while the booking stream is still open, rather than deadlocking', async () => {
    // The overlap, asserted rather than assumed. `book_service`'s POST answers
    // with an SSE stream the server holds open across all three questions, and
    // each ANSWER is a separate POST against that still-open stream. A client
    // that buffers the response, or that serialises requests behind a lock so
    // the second POST waits for the first to finish, hangs here instead of
    // failing - which is why this test asserts a value computed INSIDE the open
    // stream, and why a mutation that serialises shows up as a timeout.
    //
    // `list_appliances` is issued from inside `onElicit`, i.e. while
    // `tools/call book_service` is unresolved, and its result is awaited before
    // the answer goes back. Nothing completes unless two requests are genuinely
    // in flight at once.
    const url = await listen();
    let overlapped: string[] = [];
    let bookingOpenWhileNested = false;
    let bookingSettled = false;
    const mcp = new HomeLedgerMcp({
      url,
      token: async () => 'unused-locally',
      onElicit: async prompt => {
        const properties = (prompt.requestedSchema as { properties: Record<string, unknown> }).properties;
        const field = Object.keys(properties)[0] ?? '';
        if (field === 'provider') {
          const nested = (await mcp.callTool('list_appliances', {})) as { structuredContent: { appliances: Array<{ id: string }> } };
          overlapped = nested.structuredContent.appliances.map(a => a.id);
          bookingOpenWhileNested = !bookingSettled;
          return { action: 'accept', content: { provider: 'prov_kettle_water' } };
        }
        if (field === 'window') return { action: 'accept', content: { window: 'win_1' } };
        return { action: 'accept', content: { confirm: true } };
      }
    });
    closeClient = () => mcp.close();
    await mcp.connect();
    const list = (await mcp.callTool('list_appliances', { category: 'water_heater' })) as { structuredContent: { appliances: Array<{ id: string }> } };
    const applianceId = list.structuredContent.appliances[0]!.id;

    const booking = mcp.callTool('book_service', { applianceId, issue: 'water heater leaking at the base' }).then(value => {
      bookingSettled = true;
      return value as { structuredContent: { status: string } };
    });
    const result = await booking;

    expect(overlapped.length).toBeGreaterThan(0);
    expect(bookingOpenWhileNested).toBe(true);
    expect(result.structuredContent.status).toBe('scheduled');
  });

  it('reads a ui:// widget resource as HTML', async () => {
    const url = await listen();
    const mcp = new HomeLedgerMcp({ url, token: async () => 'unused-locally', onElicit: async () => ({ action: 'cancel' }) });
    closeClient = () => mcp.close();
    await mcp.connect();
    const html = await mcp.readResource('ui://homeledger/appliances');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('homeledger-appliances');
  });

  it('re-resolves the address, rebuilds the session, and replays the call exactly once when the session is gone', async () => {
    const url = await listen();
    let stolen = 0;
    const resolveUrl = vi.fn(async () => url);
    const mcp = new HomeLedgerMcp({
      url,
      token: async () => 'unused-locally',
      onElicit: async () => ({ action: 'cancel' }),
      resolveUrl,
      // Forges the failure mode FL-039 describes: a request carrying a session
      // id the instance does not hold. Rewriting the header is the only way to
      // reproduce it without waiting out a 30-minute idle timeout.
      fetchImpl: (input, init) => {
        const headers = new Headers(init?.headers);
        if (headers.get('mcp-session-id') && stolen === 0 && init?.method === 'POST' && String(init.body).includes('list_appliances')) {
          stolen += 1;
          headers.set('mcp-session-id', '00000000-0000-4000-8000-000000000000');
        }
        return fetch(input, { ...init, headers });
      }
    });
    closeClient = () => mcp.close();
    await mcp.connect();
    const before = mcp.sessionId;
    const result = (await mcp.callTool('list_appliances', {})) as { structuredContent: { appliances: unknown[] } };
    expect(result.structuredContent.appliances.length).toBeGreaterThan(0);
    expect(mcp.rebuilds).toBe(1);
    expect(mcp.sessionId).not.toBe(before);
    // Looked up again before reconnecting, not reused from startup. A runtime
    // recreated between two turns keeps its name and loses its id (FL-038), so
    // a rebuild against the remembered URL is the one repair that cannot fix
    // the one failure a redeploy causes. Exactly once: per rebuild, not per
    // attempt.
    expect(resolveUrl).toHaveBeenCalledTimes(1);
  });

  it('follows the runtime to a new address when the name now resolves somewhere else', async () => {
    const dead = await listen();
    const live = `${dead}?moved=1`;
    let stolen = 0;
    const mcp = new HomeLedgerMcp({
      url: dead,
      token: async () => 'unused-locally',
      onElicit: async () => ({ action: 'cancel' }),
      resolveUrl: async () => live,
      fetchImpl: (input, init) => {
        const headers = new Headers(init?.headers);
        if (headers.get('mcp-session-id') && stolen === 0 && init?.method === 'POST' && String(init.body).includes('list_appliances')) {
          stolen += 1;
          headers.set('mcp-session-id', '00000000-0000-4000-8000-000000000000');
        }
        return fetch(input, { ...init, headers });
      }
    });
    closeClient = () => mcp.close();
    await mcp.connect();
    expect(mcp.endpointUrl).toBe(dead);
    await mcp.callTool('list_appliances', {});
    // The query string is a stand-in for the generated id that changes when a
    // runtime is recreated: same server, different URL. What is under test is
    // that the client moved to the address the lookup returned rather than
    // reconnecting to the one it started with.
    expect(mcp.endpointUrl).toBe(live);
  });

  it('mints a fresh bearer and retries once when the endpoint refuses the one it had', async () => {
    const url = await listen();
    let refused = 0;
    const invalidateToken = vi.fn();
    const mcp = new HomeLedgerMcp({
      url,
      token: async () => 'unused-locally',
      onElicit: async () => ({ action: 'cancel' }),
      invalidateToken,
      resolveUrl: async () => url,
      // A rotated Cognito client secret, forged: the first tools/call comes
      // back 401 and every later request is passed through untouched, which is
      // what a token source that has just been invalidated produces.
      fetchImpl: async (input, init) => {
        if (refused === 0 && init?.method === 'POST' && String(init.body).includes('list_appliances')) {
          refused += 1;
          return new Response('{"error":"invalid_token"}', { status: 401, headers: { 'content-type': 'application/json' } });
        }
        return fetch(input, init);
      }
    });
    closeClient = () => mcp.close();
    await mcp.connect();
    const result = (await mcp.callTool('list_appliances', {})) as { structuredContent: { appliances: unknown[] } };
    expect(result.structuredContent.appliances.length).toBeGreaterThan(0);
    expect(invalidateToken).toHaveBeenCalledTimes(1);
    // A refused credential is not a lost session, and rebuilding one would
    // hide the other. The session is untouched.
    expect(mcp.rebuilds).toBe(0);
  });

  it('gives up rather than replaying twice when the rebuild does not help', async () => {
    const url = await listen();
    const mcp = new HomeLedgerMcp({
      url,
      token: async () => 'unused-locally',
      onElicit: async () => ({ action: 'cancel' }),
      fetchImpl: (input, init) => {
        const headers = new Headers(init?.headers);
        if (headers.get('mcp-session-id') && init?.method === 'POST' && String(init.body).includes('list_appliances')) {
          headers.set('mcp-session-id', '00000000-0000-4000-8000-000000000000');
        }
        return fetch(input, { ...init, headers });
      }
    });
    closeClient = () => mcp.close();
    await mcp.connect();
    // Matched, not bare. `rejects.toThrow()` with no argument passes on ANY
    // rejection, including a TypeError from this test's own fetch shim, so it
    // would stay green while proving nothing about the failure under test.
    await expect(mcp.callTool('list_appliances', {})).rejects.toThrow(/session not found/i);
    expect(mcp.rebuilds).toBe(1);
  });

  it('reports a runtime that is not there rather than rebuilding a session it never had', async () => {
    // The FL-038 half of the table, at the one moment the two 404s are
    // genuinely distinguishable: a 404 to the very FIRST request, before any
    // session exists. Nothing to rebuild, so `connect()` must surface the
    // address problem rather than looping a handshake that has nowhere to land.
    const url = await listen();
    const resolveUrl = vi.fn(async () => url);
    const mcp = new HomeLedgerMcp({
      url,
      token: async () => 'unused-locally',
      onElicit: async () => ({ action: 'cancel' }),
      resolveUrl,
      fetchImpl: async () => new Response('{"message":"Runtime not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
    });
    closeClient = () => mcp.close();
    await expect(mcp.connect()).rejects.toThrow(/404|not found/i);
    // Not one rebuild, not one re-resolution: a handshake that 404s is the
    // address being wrong, and repairing it here would turn "I cannot find the
    // runtime" into an unbounded reconnect that never says so.
    expect(mcp.rebuilds).toBe(0);
    expect(resolveUrl).not.toHaveBeenCalled();
    expect(mcp.sessionId).toBeUndefined();
  });

  it('surfaces a tool the server does not have as a rejection, not as an empty result', async () => {
    const url = await listen();
    const mcp = new HomeLedgerMcp({ url, token: async () => 'unused-locally', onElicit: async () => ({ action: 'cancel' }) });
    closeClient = () => mcp.close();
    await mcp.connect();
    await expect(mcp.callTool('no_such_tool', {})).rejects.toThrow(/no_such_tool/);
    expect(mcp.rebuilds).toBe(0);
  });
});
