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
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, deps };
}

describe('book_service over a 2025-era session (legacy shim)', () => {
  it('drives three server-initiated elicitations inside one tools/call and writes the visit', async () => {
    const { url, deps } = await listen();
    const client = new Client({ name: 'legacy-booker', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    const asked: Array<{ field: string; message: string; options: string[] }> = [];
    client.setRequestHandler(ElicitRequestSchema, async request => {
      const requestedSchema = request.params.requestedSchema as { properties: Record<string, { enum?: string[] }> };
      const field = Object.keys(requestedSchema.properties)[0] ?? '';
      asked.push({ field, message: request.params.message, options: requestedSchema.properties[field]?.enum ?? [] });
      if (field === 'provider') return { action: 'accept', content: { provider: 'prov_kettle_water' } };
      if (field === 'window') return { action: 'accept', content: { window: 'win_1' } };
      return { action: 'accept', content: { confirm: true } };
    });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    expect(transport.sessionId).toBeDefined();

    const list = await client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;

    const r = await client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'water heater leaking at the base' } });

    expect(asked.map(a => a.field)).toEqual(['provider', 'window', 'confirm']);
    expect(asked[0]?.options.length).toBeLessThanOrEqual(5);
    expect(asked[0]?.options).toContain('prov_kettle_water');
    expect(asked[1]?.options).toEqual(['win_1', 'win_2', 'win_3']);

    const sc = r.structuredContent as { visitId: string; provider: string; windowStart: string; status: string };
    expect(sc.visitId).toMatch(/^visit_/);
    expect(sc.provider).toBe('Kettle Creek Water Heaters');
    expect(sc.windowStart).toBe('2026-09-15T13:00:00.000Z');
    expect(sc.status).toBe('scheduled');
    expect((await deps.repo.getVisit(sc.visitId))?.providerId).toBe('prov_kettle_water');
    expect(await deps.repo.listVisitsSince('2026-01-01T00:00:00.000Z')).toHaveLength(1);

    await transport.terminateSession();
    await client.close();
  });

  it('stops without writing anything when the legacy client declines', async () => {
    const { url, deps } = await listen();
    const client = new Client({ name: 'legacy-decliner', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    let asks = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      asks += 1;
      return { action: 'decline' };
    });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    const list = await client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    const r = await client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'no hot water' } });
    expect(asks).toBe(1);
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("Okay, I haven't booked anything.");
    expect(await deps.repo.listVisitsSince('2026-01-01T00:00:00.000Z')).toEqual([]);
    await client.close();
  });
});
