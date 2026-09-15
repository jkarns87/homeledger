import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { buildServer } from '../src/server.js';
import { seededDeps } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
});

async function connect(answer: { action: 'accept'; content: { confirm: boolean } } | { action: 'decline' }) {
  const deps = await seededDeps();
  const handler = createMcpHandler(() => buildServer(deps));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) });
  const client = new Client(
    { name: 'modern', version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } }, inputRequired: { maxRounds: 3 }, versionNegotiation: { mode: 'auto' } }
  );
  const seen: string[] = [];
  client.setRequestHandler('elicitation/create', async request => {
    seen.push(request.params.message);
    return answer;
  });
  await client.connect(transport);
  close = async () => {
    await client.close();
    await handler.close();
  };
  return { client, seen };
}

describe('echo_confirm over multi round-trip requests (2026-07-28)', () => {
  it('asks once, then completes with the accepted answer', async () => {
    const { client, seen } = await connect({ action: 'accept', content: { confirm: true } });
    const r = await client.callTool({ name: 'echo_confirm', arguments: { message: 'book the plumber' } });
    expect(seen).toEqual(['Confirm: book the plumber?']);
    expect(r.structuredContent).toEqual({ confirmed: true, message: 'book the plumber' });
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe('Confirmed: book the plumber');
  });
  it('treats a decline as cancelled without asking again', async () => {
    const { client, seen } = await connect({ action: 'decline' });
    const r = await client.callTool({ name: 'echo_confirm', arguments: { message: 'book the plumber' } });
    expect(seen.length).toBe(1);
    expect(r.structuredContent).toEqual({ confirmed: false, message: 'book the plumber' });
  });
  it('is absent when dev tools are off', async () => {
    const deps = { ...(await seededDeps()), devTools: false };
    const handler = createMcpHandler(() => buildServer(deps));
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) });
    const client = new Client({ name: 'modern', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);
    close = async () => {
      await client.close();
      await handler.close();
    };
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).not.toContain('echo_confirm');
  });
});
