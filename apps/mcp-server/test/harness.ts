import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { buildServer, type ServerDeps } from '../src/server.js';
import { seededDeps } from './seeded-deps.js';

// Re-exported, not moved away: every test in this suite imports these four from
// `./harness.js` and none of them has to know that the fixture now lives in its
// own module so another package can import it. See `seeded-deps.ts` for why the
// split exists.
export { TODAY, TEST_TIMEZONE, TEST_REQUEST_STATE_KEY, seededDeps } from './seeded-deps.js';

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

export type ElicitAnswer = { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' } | { action: 'cancel' };

/**
 * A 2026-07-28 client that answers embedded elicitation requests. The field
 * name is the single key of requestedSchema.properties, which is exactly the
 * key the server used in inputRequests. `schemas`, when supplied, collects
 * every requestedSchema so a test can assert option counts.
 */
export async function modernElicitClient(
  answer: (field: string, message: string) => ElicitAnswer,
  over: Partial<ServerDeps> = {},
  schemas?: Array<Record<string, unknown>>,
  /**
   * The elicitation capability to declare. Defaults to the explicit form-mode
   * shape a 2026-07-28 client normally sends; a test overrides it to drive the
   * shapes `supportsFormElicitation` has to tell apart. The modern era does NOT
   * normalise this value on the way in, unlike the 2025-era `initialize` decode,
   * so whatever is passed here is what the server reads back.
   */
  elicitation: Record<string, unknown> = { form: {} }
) {
  const deps = { ...(await seededDeps()), ...over };
  const handler = createMcpHandler(() => buildServer(deps));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  });
  const client = new Client(
    { name: 'modern-elicit', version: '1.0.0' },
    { capabilities: { elicitation }, inputRequired: { maxRounds: 6 }, versionNegotiation: { mode: 'auto' } }
  );
  const asked: Array<{ field: string; message: string }> = [];
  client.setRequestHandler('elicitation/create', async request => {
    const requestedSchema = (request.params as { requestedSchema: { properties: Record<string, unknown> } }).requestedSchema;
    const field = Object.keys(requestedSchema.properties)[0] ?? '';
    const message = (request.params as { message: string }).message;
    asked.push({ field, message });
    schemas?.push(requestedSchema as unknown as Record<string, unknown>);
    return answer(field, message);
  });
  await client.connect(transport);
  return {
    client,
    deps,
    asked,
    close: async () => {
      await client.close();
      await handler.close();
    }
  };
}
