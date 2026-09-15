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
});
