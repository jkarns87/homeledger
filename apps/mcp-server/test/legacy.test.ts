import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { seededDeps } from './harness.js';

let server: Server | undefined;
let closeApp: () => Promise<void> = async () => {};
afterEach(async () => {
  await closeApp();
  await new Promise<void>(r => (server ? server.close(() => r()) : r()));
});

async function listen() {
  const deps = await seededDeps();
  const { app, close } = createApp(deps);
  closeApp = close;
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server!.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return `http://127.0.0.1:${port}/mcp`;
}

describe('legacy (2025-era) client', () => {
  it('initializes, receives a session id, and calls tools on that session', async () => {
    const url = await listen();
    const client = new Client({ name: 'Alexa+ MCP Client', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    expect(transport.sessionId).toBeDefined();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(['list_appliances', 'get_appliance', 'maintenance_due', 'log_maintenance', 'recent_events']);
    const r = await client.callTool({ name: 'list_appliances', arguments: { room: 'Basement' } });
    expect((r.structuredContent as { appliances: unknown[] }).appliances.length).toBe(3);
    await transport.terminateSession();
    await client.close();
  });
  it('gives two clients two sessions', async () => {
    const url = await listen();
    const a = new StreamableHTTPClientTransport(new URL(url));
    const b = new StreamableHTTPClientTransport(new URL(url));
    const ca = new Client({ name: 'a', version: '1' });
    const cb = new Client({ name: 'b', version: '1' });
    await ca.connect(a);
    await cb.connect(b);
    expect(a.sessionId).not.toBe(b.sessionId);
    await ca.close();
    await cb.close();
  });
  it('returns 404 for an unknown session id', async () => {
    const url = await listen();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    expect(res.status).toBe(404);
  });
});
