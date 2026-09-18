import { createServer, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { seededDeps } from './harness.js';

/**
 * End-to-end cover for the stdio bridge in `apps/mcp-bridge`, exercised the way
 * Claude Code exercises it: a child process spawned over stdio pipes, in front
 * of the real HomeLedger server over real HTTP.
 *
 * It lives in this workspace rather than the bridge's because it needs the real
 * `createApp`, and because the bridge is spawned by path rather than imported —
 * which is exactly the coupling Claude Code has to it, and which no amount of
 * in-process wiring would reproduce.
 *
 * Fake here: the Cognito token endpoint (a local HTTP server issuing a known
 * token) and AgentCore itself (absent; the bridge posts straight at the local
 * server). Real here: the bridge's own entrypoint, its config parsing, its
 * token flow, its stdio framing, its SSE streaming, the server, and a
 * 2025-era client carrying Claude Code's own name and capability set.
 */

const here = dirname(fileURLToPath(import.meta.url));
const TSX_CLI = resolve(here, '../node_modules/tsx/dist/cli.mjs');
const BRIDGE_ENTRY = resolve(here, '../node_modules/@homeledger/mcp-bridge/src/index.ts');

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-cognito-client-secret-value';
const BEARER = 'test-bearer-token-issued-by-the-fake-cognito';

let cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>(r => server.close(() => r())));
  return (server.address() as { port: number }).port;
}

async function startHomeLedger(): Promise<string> {
  const deps = await seededDeps();
  const { app, close } = createApp(deps);
  cleanup.push(close);
  const port = await listen(createServer(app));
  return `http://127.0.0.1:${port}/mcp`;
}

async function startFakeCognito(): Promise<{ url: string; authorizations: string[] }> {
  const authorizations: string[] = [];
  const port = await listen(
    createServer((req, res) => {
      authorizations.push(String(req.headers.authorization ?? ''));
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: BEARER, expires_in: 3600 }));
      });
    })
  );
  return { url: `http://127.0.0.1:${port}/oauth2/token`, authorizations };
}

interface BridgeSession {
  client: LegacyClient;
  stderr: () => string;
  asked: Array<{ field: string; message: string }>;
}

type SpawnedBridge = BridgeSession & { transport: StdioClientTransport; connect: () => Promise<void> };

function spawnBridge(mcpUrl: string, tokenUrl: string, extraEnv: Record<string, string> = {}) {
  let stderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, BRIDGE_ENTRY],
    env: {
      ...(process.env as Record<string, string>),
      HOMELEDGER_MCP_URL: mcpUrl,
      HOMELEDGER_COGNITO_TOKEN_URL: tokenUrl,
      HOMELEDGER_COGNITO_CLIENT_ID: CLIENT_ID,
      // The environment path, so this test makes no AWS call of any kind.
      HOMELEDGER_COGNITO_CLIENT_SECRET: CLIENT_SECRET,
      ...extraEnv
    },
    stderr: 'pipe'
  });

  // Claude Code 2.1.56's own client identity and capability set, read out of
  // its bundle: `new Client({ name: 'claude-code', version }, { capabilities:
  // { roots: {}, ...(gate ? { elicitation: { form: {}, url: {} } } : {}) } })`.
  const client = new LegacyClient({ name: 'claude-code', version: '2.1.56' }, { capabilities: { roots: {}, elicitation: { form: {}, url: {} } } });
  const asked: Array<{ field: string; message: string }> = [];
  client.setRequestHandler(ElicitRequestSchema, async request => {
    if (request.params.mode === 'url') throw new Error('unexpected url-mode elicitation');
    const schema = request.params.requestedSchema as { properties: Record<string, { enum?: string[] }> };
    const field = Object.keys(schema.properties)[0] ?? '';
    asked.push({ field, message: request.params.message });
    if (field === 'confirm') return { action: 'accept' as const, content: { confirm: true } };
    return { action: 'accept' as const, content: { [field]: schema.properties[field]?.enum?.[0] } };
  });
  cleanup.push(async () => {
    await client.close().catch(() => undefined);
  });

  /**
   * Connects, attaching to the child's stderr the moment `start()` has spawned
   * it. A piped stdio stream stays paused until something reads it, so nothing
   * emitted before this attaches is lost — but the attach still has to happen
   * before a failing connect tears the process down and drops the handle.
   */
  const connect = async (): Promise<void> => {
    const connecting = client.connect(transport);
    void connecting.catch(() => undefined);
    for (let i = 0; i < 100 && !transport.stderr; i += 1) await new Promise(r => setImmediate(r));
    transport.stderr?.on('data', chunk => {
      stderr += String(chunk);
    });
    await connecting;
  };

  return { client, transport, connect, stderr: () => stderr, asked };
}

async function connectThroughBridge(mcpUrl: string, tokenUrl: string, extraEnv: Record<string, string> = {}): Promise<BridgeSession> {
  const spawned = spawnBridge(mcpUrl, tokenUrl, extraEnv);
  await spawned.connect();
  return spawned;
}

describe('the stdio bridge, driven the way Claude Code drives it', () => {
  it('negotiates 2025-11-25 and exposes the server’s tools unchanged', async () => {
    const mcpUrl = await startHomeLedger();
    const cognito = await startFakeCognito();
    const session = await connectThroughBridge(mcpUrl, cognito.url);

    // The bridge relays the negotiation rather than participating in it: this
    // is the same version the same client negotiates against the server with
    // no bridge in between.
    expect(session.client.getServerVersion()).toEqual({ name: 'homeledger', version: '0.1.0' });
    const { tools } = await session.client.listTools();
    expect(tools.map(t => t.name)).toEqual([
      'list_appliances',
      'get_appliance',
      'maintenance_due',
      'log_maintenance',
      'recent_events',
      'ask_manual',
      'book_service',
      'get_visit',
      'echo_confirm'
    ]);
  }, 30_000);

  it('authenticates every request with a bearer token minted from the client secret', async () => {
    const mcpUrl = await startHomeLedger();
    const cognito = await startFakeCognito();
    await connectThroughBridge(mcpUrl, cognito.url);
    expect(cognito.authorizations).toEqual([`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`]);
  }, 30_000);

  it('carries book_service’s three elicitations and its progress through to the client', async () => {
    const mcpUrl = await startHomeLedger();
    const cognito = await startFakeCognito();
    const session = await connectThroughBridge(mcpUrl, cognito.url);

    const list = await session.client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;

    const progress: number[] = [];
    const booked = await session.client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'no hot water' } }, undefined, {
      onprogress: p => progress.push(p.progress)
    });

    expect(session.asked.map(a => a.field)).toEqual(['provider', 'window', 'confirm']);
    expect(session.asked[0]?.message).toBe('Who should I book for the water heater?');
    expect(session.asked[2]?.message).toBe('Book Kettle Creek Water Heaters for Tuesday, September 15, 1 to 3 PM?');
    expect(progress).toEqual([0, 1, 2, 3]);

    const sc = booked.structuredContent as { provider: string; status: string; visitId: string };
    expect(sc.provider).toBe('Kettle Creek Water Heaters');
    expect(sc.status).toBe('scheduled');
    expect(/^visit_[a-z2-7]{16}$/.test(sc.visitId)).toBe(true);
  }, 30_000);

  it('writes neither the client secret nor the bearer token to stderr across a whole booking', async () => {
    // stdout needs no assertion here and could not carry either value anyway:
    // the client's own framing rejects a line that is not a JSON-RPC message,
    // so a diagnostic written to stdout would fail every test in this file.
    const mcpUrl = await startHomeLedger();
    const cognito = await startFakeCognito();
    const session = await connectThroughBridge(mcpUrl, cognito.url);

    const list = await session.client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    await session.client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'no hot water' } });
    await session.client.callTool({ name: 'get_visit', arguments: { visitId: 'visit_doesnotexist12' } });
    await new Promise(r => setTimeout(r, 200));

    const out = session.stderr();
    expect(out).not.toContain(CLIENT_SECRET);
    expect(out).not.toContain(BEARER);
    expect(out).not.toContain(Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'));
  }, 30_000);

  it('scrubs the bearer token out of an endpoint error that quotes it straight back', async () => {
    // The assertion above ("no secret across a booking") can only catch a
    // future edit that logs a credential on a path this suite already walks;
    // nothing on the happy path quotes one today, so on its own it is a guard
    // rather than a proof. This one is the proof: the endpoint reflects the
    // Authorization header into its own 500 body, so the live bearer token is
    // genuinely inside the string the bridge is about to print, and only the
    // redaction stops it reaching stderr and the JSON-RPC error.
    const cognito = await startFakeCognito();
    const echoPort = await listen(
      createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: `runtime rejected: ${req.headers.authorization ?? ''}` }));
        });
      })
    );

    const spawned = spawnBridge(`http://127.0.0.1:${echoPort}/mcp`, cognito.url);
    await expect(spawned.connect()).rejects.toThrow();
    await new Promise(r => setTimeout(r, 200));

    const out = spawned.stderr();
    expect(out).toContain('AgentCore or the runtime returned 500');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain(BEARER);
  }, 30_000);

  it('refuses to start, with one sentence, when it is told nothing about the runtime', async () => {
    const cognito = await startFakeCognito();
    const spawned = spawnBridge('', cognito.url, { HOMELEDGER_MCP_URL: '', HOMELEDGER_RUNTIME_ARN: '' });
    await expect(spawned.connect()).rejects.toThrow();
    expect(spawned.stderr()).toContain('Neither HOMELEDGER_MCP_URL nor HOMELEDGER_RUNTIME_ARN is set');
    expect(spawned.stderr()).not.toContain('at Object.');
  }, 30_000);
});
