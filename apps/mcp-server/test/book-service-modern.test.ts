import { afterEach, describe, expect, it } from 'vitest';
import { hasJson } from '../src/voice.js';
import { modernElicitClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
});

async function waterHeaterId(client: Awaited<ReturnType<typeof modernElicitClient>>['client']) {
  const list = await client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
  return (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
}

type ManualResult =
  | { resultType: 'input_required'; inputRequests: Record<string, unknown>; requestState?: string }
  | { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

/**
 * Drives one round of `tools/call` without the SDK's auto-fulfilling MRTR
 * driver, so a test can inspect (and, for the idempotency test, replay) the
 * raw `input_required` result of an individual round — `client.callTool()`
 * always runs the whole flow to completion and never hands back the
 * intermediate `requestState`.
 */
async function callManual(client: Awaited<ReturnType<typeof modernElicitClient>>['client'], params: Record<string, unknown>): Promise<ManualResult> {
  return client.request({ method: 'tools/call', params }, { allowInputRequired: true }) as Promise<ManualResult>;
}

describe('book_service over multi round-trip requests (2026-07-28)', () => {
  it('asks for provider, window, and confirmation, then writes the visit', async () => {
    const h = await modernElicitClient(field => {
      if (field === 'provider') return { action: 'accept', content: { provider: 'prov_kettle_water' } };
      if (field === 'window') return { action: 'accept', content: { window: 'win_1' } };
      return { action: 'accept', content: { confirm: true } };
    });
    close = h.close;
    const applianceId = await waterHeaterId(h.client);
    const r = await h.client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'water heater leaking at the base' } });

    expect(h.asked.map(a => a.field)).toEqual(['provider', 'window', 'confirm']);
    expect(h.asked[0]?.message).toBe('Who should I book for the water heater?');
    expect(h.asked[1]?.message).toBe('Kettle Creek Water Heaters has three windows. Which one works?');
    expect(h.asked[2]?.message).toBe('Book Kettle Creek Water Heaters for Tuesday, September 15, 1 to 3 PM?');

    const sc = r.structuredContent as { visitId: string; provider: string; windowStart: string; windowEnd: string; status: string };
    expect(sc.provider).toBe('Kettle Creek Water Heaters');
    expect(sc.status).toBe('scheduled');
    expect(sc.windowStart).toBe('2026-09-15T13:00:00.000Z');
    expect(sc.windowEnd).toBe('2026-09-15T15:00:00.000Z');
    expect(/^visit_[a-z2-7]{16}$/.test(sc.visitId)).toBe(true);

    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(hasJson(text)).toBe(false);
    expect(text).toBe('Booked Kettle Creek Water Heaters for Tuesday, September 15, 1 to 3 PM.');

    const stored = await h.deps.repo.getVisit(sc.visitId);
    expect(stored?.providerId).toBe('prov_kettle_water');
    expect(stored?.applianceId).toBe(applianceId);
    expect(stored?.issue).toBe('water heater leaking at the base');
    expect(stored?.status).toBe('scheduled');
  });

  it('never offers more than five providers or more than three windows', async () => {
    const schemas: Array<Record<string, unknown>> = [];
    const h = await modernElicitClient(
      field => {
        if (field === 'provider') return { action: 'accept', content: { provider: 'prov_harbor_line' } };
        if (field === 'window') return { action: 'accept', content: { window: 'win_2' } };
        return { action: 'accept', content: { confirm: true } };
      },
      undefined,
      schemas
    );
    close = h.close;
    const list = await h.client.callTool({ name: 'list_appliances', arguments: { category: 'plumbing' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    await h.client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'sump pump runs constantly' } });
    const providerEnum = (schemas[0]!.properties as { provider: { enum: string[] } }).provider.enum;
    const windowEnum = (schemas[1]!.properties as { window: { enum: string[] } }).window.enum;
    expect(providerEnum.length).toBeLessThanOrEqual(5);
    expect(windowEnum.length).toBe(3);
  });

  it('stops without writing anything when the user declines', async () => {
    const h = await modernElicitClient(() => ({ action: 'decline' }));
    close = h.close;
    const applianceId = await waterHeaterId(h.client);
    const r = await h.client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'no hot water' } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("Okay, I haven't booked anything.");
    expect(h.asked.map(a => a.field)).toEqual(['provider']);
    expect(await h.deps.repo.listVisitsSince('2026-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('stops when the user answers the confirmation with no', async () => {
    const h = await modernElicitClient(field => {
      if (field === 'provider') return { action: 'accept', content: { provider: 'prov_kettle_water' } };
      if (field === 'window') return { action: 'accept', content: { window: 'win_3' } };
      return { action: 'accept', content: { confirm: false } };
    });
    close = h.close;
    const applianceId = await waterHeaterId(h.client);
    const r = await h.client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'no hot water' } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("Okay, I haven't booked anything.");
    expect(await h.deps.repo.listVisitsSince('2026-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('answers an unknown appliance without asking anything', async () => {
    const h = await modernElicitClient(() => ({ action: 'accept', content: {} }));
    close = h.close;
    const r = await h.client.callTool({ name: 'book_service', arguments: { applianceId: 'appl_zzzzzzzzzzzzzzzz', issue: 'leak' } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("I couldn't find that appliance.");
    expect(h.asked).toEqual([]);
  });

  it('stops without writing anything when the user declines at the window step', async () => {
    const h = await modernElicitClient(field => {
      if (field === 'provider') return { action: 'accept', content: { provider: 'prov_kettle_water' } };
      return { action: 'decline' };
    });
    close = h.close;
    const applianceId = await waterHeaterId(h.client);
    const r = await h.client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'no hot water' } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("Okay, I haven't booked anything.");
    expect(h.asked.map(a => a.field)).toEqual(['provider', 'window']);
    expect(await h.deps.repo.listVisitsSince('2026-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('is idempotent: replaying the confirm round overwrites the same visit instead of duplicating it', async () => {
    // Drives the flow manually (bypassing the SDK's auto-fulfilling driver)
    // so the round-3 requestState token can be captured and resubmitted —
    // an ordinary network retry of the confirm round, not just a hostile
    // replay. answer() is never invoked since callManual() drives directly.
    const h = await modernElicitClient(() => ({ action: 'decline' }));
    close = h.close;
    const applianceId = await waterHeaterId(h.client);
    const args = { applianceId, issue: 'no hot water' };

    const r1 = await callManual(h.client, { name: 'book_service', arguments: args });
    if (r1.resultType !== 'input_required') throw new Error('expected input_required for the provider round');
    const providerKey = Object.keys(r1.inputRequests)[0]!;

    const r2 = await callManual(h.client, {
      name: 'book_service',
      arguments: args,
      inputResponses: { [providerKey]: { action: 'accept', content: { provider: 'prov_kettle_water' } } },
      requestState: r1.requestState
    });
    if (r2.resultType !== 'input_required') throw new Error('expected input_required for the window round');
    const windowKey = Object.keys(r2.inputRequests)[0]!;

    const r3 = await callManual(h.client, {
      name: 'book_service',
      arguments: args,
      inputResponses: { [windowKey]: { action: 'accept', content: { window: 'win_1' } } },
      requestState: r2.requestState
    });
    if (r3.resultType !== 'input_required') throw new Error('expected input_required for the confirm round');
    const confirmKey = Object.keys(r3.inputRequests)[0]!;

    const confirmParams = {
      name: 'book_service',
      arguments: args,
      inputResponses: { [confirmKey]: { action: 'accept', content: { confirm: true } } },
      requestState: r3.requestState
    };

    const first = await callManual(h.client, confirmParams);
    const replay = await callManual(h.client, confirmParams); // same requestState + inputResponses, resubmitted verbatim

    if (first.resultType === 'input_required' || replay.resultType === 'input_required') {
      throw new Error('expected both confirm submissions to complete the booking');
    }
    expect(first.isError).toBeFalsy();
    expect(replay.isError).toBeFalsy();
    const firstVisitId = (first.structuredContent as { visitId: string }).visitId;
    const replayVisitId = (replay.structuredContent as { visitId: string }).visitId;
    expect(replayVisitId).toBe(firstVisitId);

    const visits = await h.deps.repo.listVisitsSince('2026-01-01T00:00:00.000Z');
    expect(visits).toHaveLength(1);
    expect(visits[0]?.id).toBe(firstVisitId);
  });
});
