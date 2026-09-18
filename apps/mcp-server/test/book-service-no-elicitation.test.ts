import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../src/app.js';
import { BOOKING_NEEDS_ELICITATION_MESSAGE } from '../src/tools/service.js';
import { hasJson } from '../src/voice.js';
import { modernClient, modernElicitClient, seededDeps } from './harness.js';

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

async function listen() {
  const deps = await seededDeps();
  const { app, close: closeIt } = createApp(deps);
  closeApp = closeIt;
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server!.once('listening', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, deps };
}

/**
 * Claude Code declares `elicitation` only when `tengu_mcp_elicitation` is on,
 * a remote GrowthBook flag whose default is FALSE and which has no environment
 * or settings override (FL-033). So "the client cannot be asked anything" is
 * the DEFAULT for most people who add this server, not an edge case — and
 * before this, the two eras failed differently and neither failed in English.
 *
 * `modernClient()` and the legacy client below both declare no capabilities at
 * all, which is exactly what that flag being off produces.
 */
describe('book_service when the client cannot be asked anything', () => {
  it('declines in prose on a 2026-07-28 client, instead of a protocol error the person never sees as a result', async () => {
    const h = await modernClient();
    close = h.close;
    const list = await h.client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;

    // Awaiting this at all is half the assertion. Without the capability check
    // the handler returns inputRequired(...), the SDK's own gate throws
    // MissingRequiredClientCapabilityError, and this call REJECTS with a
    // JSON-RPC -32021 rather than resolving to a tool result.
    const r = await h.client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'no hot water' } });

    const spoken = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(spoken).toBe(BOOKING_NEEDS_ELICITATION_MESSAGE);
    expect(r.isError).toBe(true);
    expect(hasJson(spoken)).toBe(false);
    // Named separately from the equality above, so a reworded constant still
    // has to keep the properties that make it a fix: no protocol vocabulary,
    // and a remedy the person can act on.
    expect(spoken).not.toMatch(/elicitation|capability|inputRequests|-32021/i);
    expect(spoken.toLowerCase()).toContain('prompt');

    // The requirement this test exists to pin hardest: declining is better than
    // booking without asking. A visit written without confirming the provider
    // and the window is discovered when somebody turns up at the door.
    expect(await h.deps.repo.listVisitsSince('2026-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('declines in the same prose on a 2025-era session, instead of the shim’s protocol jargon', async () => {
    const { url, deps } = await listen();
    const client = new LegacyClient({ name: 'legacy-no-elicitation', version: '1.0.0' }, { capabilities: {} });
    const transport = new LegacyTransport(new URL(url));
    await client.connect(transport);
    close = async () => client.close();

    const list = await client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    const r = await client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'no hot water' } });

    const spoken = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(spoken).toBe(BOOKING_NEEDS_ELICITATION_MESSAGE);
    expect(r.isError).toBe(true);
    // The exact string the legacy shim would otherwise have produced. Both eras
    // now answer identically, which is the point: one situation, one sentence.
    expect(spoken).not.toContain('did not declare the required capability');
    expect(await deps.repo.listVisitsSince('2026-01-01T00:00:00.000Z')).toEqual([]);
  });

  /**
   * The lenient reading the SDK applies and this check has to match: declaring
   * `elicitation` while naming NO mode means form, because modes did not exist
   * when that shape was defined. Reading it as "no form support" would refuse
   * the very client generation this server was built for - the deployed smoke's
   * legacy block and the documented Alexa+ client both send exactly this shape.
   *
   * The next two tests cover the same rule on both eras deliberately, and the
   * MODERN one is the load-bearing half. Deleting the leniency and testing only
   * the legacy era is a mutation that SURVIVES, because a 2025-era `initialize`
   * never delivers a bare `{}` to the handler at all: the SDK's
   * ElicitationCapabilitySchema preprocesses it into `{ form: {} }` at the
   * decode seam. The 2026-07-28 envelope is not preprocessed, so the bare
   * declaration arrives intact and only a modern client can prove the branch.
   */
  it('does not refuse a modern client whose bare elicitation declaration names no mode', async () => {
    const h = await modernElicitClient(
      field => {
        if (field === 'provider') return { action: 'accept', content: { provider: 'prov_kettle_water' } };
        if (field === 'window') return { action: 'accept', content: { window: 'win_1' } };
        return { action: 'accept', content: { confirm: true } };
      },
      {},
      undefined,
      {}
    );
    close = h.close;
    const list = await h.client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    const r = await h.client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'no hot water' } });

    expect(h.asked.map(a => a.field)).toEqual(['provider', 'window', 'confirm']);
    expect((r.content as Array<{ text?: string }>)[0]?.text).not.toBe(BOOKING_NEEDS_ELICITATION_MESSAGE);
    expect((r.structuredContent as { status?: string } | undefined)?.status).toBe('scheduled');
  });

  it('does not refuse a modern client that declares elicitation with a member that is not a mode', async () => {
    const h = await modernElicitClient(
      field => {
        if (field === 'provider') return { action: 'accept', content: { provider: 'prov_kettle_water' } };
        if (field === 'window') return { action: 'accept', content: { window: 'win_1' } };
        return { action: 'accept', content: { confirm: true } };
      },
      {},
      undefined,
      { applyDefaults: true }
    );
    close = h.close;
    const list = await h.client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    const r = await h.client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'no hot water' } });

    expect(h.asked.map(a => a.field)).toEqual(['provider', 'window', 'confirm']);
    expect((r.structuredContent as { status?: string } | undefined)?.status).toBe('scheduled');
  });

  it('does not refuse a 2025-era client whose bare elicitation declaration predates modes', async () => {
    const { url } = await listen();
    const client = new LegacyClient({ name: 'legacy-bare-elicitation', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    const transport = new LegacyTransport(new URL(url));
    let asked = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      asked += 1;
      return { action: 'decline' };
    });
    await client.connect(transport);
    close = async () => client.close();

    const list = await client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    const r = await client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'no hot water' } });

    // It got as far as asking, which is the assertion. It then declined, so the
    // result is the ordinary "haven't booked anything" and NOT the refusal.
    expect(asked).toBe(1);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("Okay, I haven't booked anything.");
  });

  // The other edge of the same rule. A client that declares only URL-mode
  // elicitation has declared `elicitation`, but book_service only ever builds
  // FORM-mode requests (enumField/booleanField), so the SDK would refuse it
  // anyway - and it must be refused HERE, in prose, for the same reason as a
  // client that declared nothing. Reading "elicitation is present" as "form is
  // supported" would send this client back to the opaque failure.
  it('refuses a client that declared only URL-mode elicitation, which cannot answer a form request', async () => {
    const { url, deps } = await listen();
    const client = new LegacyClient({ name: 'legacy-url-only', version: '1.0.0' }, { capabilities: { elicitation: { url: {} } } });
    const transport = new LegacyTransport(new URL(url));
    await client.connect(transport);
    close = async () => client.close();

    const list = await client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    const r = await client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'no hot water' } });

    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe(BOOKING_NEEDS_ELICITATION_MESSAGE);
    expect(r.isError).toBe(true);
    expect(await deps.repo.listVisitsSince('2026-01-01T00:00:00.000Z')).toEqual([]);
  });
});
