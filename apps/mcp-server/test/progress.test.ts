import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { ServerContext } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../src/app.js';
import { AVAILABILITY_STEPS, AVAILABILITY_TOTAL, reportProgress, runAvailabilityCheck } from '../src/progress.js';
import { modernElicitClient, seededDeps } from './harness.js';

let server: Server | undefined;
let closeApp: () => Promise<void> = async () => {};
let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
  close = async () => {};
  await closeApp();
  closeApp = async () => {};
  await new Promise<void>(r => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** Minimal ServerContext double: reportProgress/runAvailabilityCheck only touch mcpReq._meta and mcpReq.notify. */
function mockCtx(progressToken?: string): { ctx: ServerContext; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn(async () => {});
  const ctx = { mcpReq: { _meta: progressToken === undefined ? undefined : { progressToken }, notify } } as unknown as ServerContext;
  return { ctx, notify };
}

describe('runAvailabilityCheck', () => {
  it('emits exactly four notifications/progress, 0-3 of 3, in order, when a progress token is present', async () => {
    const { ctx, notify } = mockCtx('tok_1');
    await runAvailabilityCheck(ctx, 0, 'Kettle Creek Water Heaters');
    expect(notify).toHaveBeenCalledTimes(4);
    expect(notify.mock.calls.map(call => call[0])).toEqual([
      {
        method: 'notifications/progress',
        params: { progressToken: 'tok_1', progress: 0, total: 3, message: 'Checking Kettle Creek Water Heaters for openings' }
      },
      { method: 'notifications/progress', params: { progressToken: 'tok_1', progress: 1, total: 3, message: AVAILABILITY_STEPS[0] } },
      { method: 'notifications/progress', params: { progressToken: 'tok_1', progress: 2, total: 3, message: AVAILABILITY_STEPS[1] } },
      { method: 'notifications/progress', params: { progressToken: 'tok_1', progress: 3, total: 3, message: AVAILABILITY_STEPS[2] } }
    ]);
  });

  it('emits nothing when the request carried no progress token', async () => {
    const { ctx, notify } = mockCtx(undefined);
    await runAvailabilityCheck(ctx, 0, 'Kettle Creek Water Heaters');
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('reportProgress', () => {
  it('is a no-op without a progress token', async () => {
    const { ctx, notify } = mockCtx(undefined);
    await reportProgress(ctx, 0, AVAILABILITY_TOTAL, 'irrelevant');
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('book_service progress on the modern client', () => {
  it('reports 0, 1, 2, 3 of 3 while checking availability', async () => {
    const h = await modernElicitClient(field => {
      if (field === 'provider') return { action: 'accept', content: { provider: 'prov_kettle_water' } };
      if (field === 'window') return { action: 'accept', content: { window: 'win_1' } };
      return { action: 'accept', content: { confirm: true } };
    });
    close = h.close;
    const list = await h.client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    // The v2 client's own multi-round-trip auto-fulfilment driver emits its
    // own synthetic notifications/progress (one per elicitation round, e.g.
    // "Fulfilling input required by 'tools/call' (round 2)") through this
    // SAME onprogress sink — see FL-026. Those carry no `total`; every
    // notification runAvailabilityCheck sends carries `total: 3`, so filter
    // on that to isolate the sequence this test is about.
    const seen: Array<{ progress: number; total?: number; message?: string }> = [];
    const r = await h.client.callTool(
      { name: 'book_service', arguments: { applianceId, issue: 'water heater leaking at the base' } },
      {
        onprogress: p => {
          if (p.total !== undefined) seen.push({ progress: p.progress, total: p.total, message: p.message });
        }
      }
    );
    expect((r.structuredContent as { status: string }).status).toBe('scheduled');
    expect(seen.map(p => p.progress)).toEqual([0, 1, 2, 3]);
    expect(seen.every(p => p.total === 3)).toBe(true);
    expect(seen[0]?.message).toBe('Checking Kettle Creek Water Heaters for openings');
    expect(seen[3]?.message).toBe('Found three windows');
  });
});

describe('book_service progress on the legacy client', () => {
  it('reports 0, 1, 2, 3 of 3 over the session stream', async () => {
    const deps = await seededDeps();
    const app = createApp(deps);
    closeApp = app.close;
    server = app.app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server!.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;

    const client = new Client({ name: 'legacy-progress', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async request => {
      const requestedSchema = request.params.requestedSchema as { properties: Record<string, unknown> };
      const field = Object.keys(requestedSchema.properties)[0] ?? '';
      if (field === 'provider') return { action: 'accept', content: { provider: 'prov_kettle_water' } };
      if (field === 'window') return { action: 'accept', content: { window: 'win_1' } };
      return { action: 'accept', content: { confirm: true } };
    });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    const list = await client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    const seen: number[] = [];
    const r = await client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'water heater leaking at the base' } }, undefined, {
      onprogress: p => seen.push(p.progress)
    });
    expect((r.structuredContent as { status: string }).status).toBe('scheduled');
    expect(seen).toEqual([0, 1, 2, 3]);
    await client.close();
  });
});
