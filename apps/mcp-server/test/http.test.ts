import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/app.js';
import { seededDeps } from './harness.js';

let server: Server | undefined;
let closeApp: () => Promise<void> = async () => {};
afterEach(async () => {
  await closeApp();
  await new Promise<void>(r => (server ? server.close(() => r()) : r()));
});

export async function listen() {
  const deps = await seededDeps();
  const { app, close } = createApp(deps);
  closeApp = close;
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server!.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, deps };
}

describe('modern client over HTTP', () => {
  it('lists and calls tools statelessly', async () => {
    const { url } = await listen();
    const client = new Client({ name: 'modern', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    expect(client.getDiscoverResult()).toBeDefined();
    const { tools } = await client.listTools();
    expect(tools[0]?.name).toBe('list_appliances');
    const r = await client.callTool({ name: 'maintenance_due', arguments: {} });
    expect((r.structuredContent as { items: unknown[] }).items.length).toBeGreaterThan(0);
    await client.close();
  });
  it('answers /healthz', async () => {
    const { url } = await listen();
    const res = await fetch(url.replace('/mcp', '/healthz'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: 'homeledger' });
  });
});
