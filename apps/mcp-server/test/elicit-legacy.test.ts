import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
}

describe('echo_confirm over a 2025-era session (legacy shim)', () => {
  it('receives a server-initiated elicitation and completes with the answer', async () => {
    const url = await listen();
    const client = new Client({ name: 'legacy', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    const seen: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async request => {
      seen.push(request.params.message);
      return { action: 'accept', content: { confirm: true } };
    });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    const r = await client.callTool({ name: 'echo_confirm', arguments: { message: 'book the plumber' } });
    expect(seen).toEqual(['Confirm: book the plumber?']);
    expect(r.structuredContent).toEqual({ confirmed: true, message: 'book the plumber' });
    await transport.terminateSession();
    await client.close();
  });
});
