import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMemoryRepository, seedRepository } from '@homeledger/core';
import { buildServer, type ServerDeps } from '../src/server.js';

export const TODAY = '2026-09-13';

export async function seededDeps(): Promise<ServerDeps> {
  const repo = createMemoryRepository('hh_test');
  await seedRepository(repo, 'hh_test', TODAY);
  return { repo, now: () => `${TODAY}T12:00:00.000Z`, devTools: true };
}

export async function modernClient(over: Partial<ServerDeps> = {}) {
  const deps = { ...(await seededDeps()), ...over };
  const handler = createMcpHandler(() => buildServer(deps));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  });
  const client = new Client({ name: 'test-harness', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return {
    client,
    deps,
    close: async () => {
      await client.close();
      await handler.close();
    }
  };
}
