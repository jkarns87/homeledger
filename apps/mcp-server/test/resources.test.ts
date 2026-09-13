import { afterEach, describe, expect, it } from 'vitest';
import { modernClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
});

describe('resources', () => {
  it('lists the three household resources and reads them as JSON', async () => {
    const h = await modernClient();
    close = h.close;
    const { resources } = await h.client.listResources();
    expect(resources.map(r => r.uri).sort()).toEqual(['homeledger://appliances', 'homeledger://household', 'homeledger://maintenance/schedule']);
    const hh = await h.client.readResource({ uri: 'homeledger://household' });
    const body = JSON.parse((hh.contents[0] as { text: string }).text) as { name: string };
    expect(body.name).toBe('The Harlow household');
    const sched = await h.client.readResource({ uri: 'homeledger://maintenance/schedule' });
    const items = JSON.parse((sched.contents[0] as { text: string }).text) as Array<{ applianceName: string; nextDueAt: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.nextDueAt <= items[items.length - 1]!.nextDueAt).toBe(true);
  });
});

describe('prompts', () => {
  it('builds a seasonal checklist from the seeded appliances', async () => {
    const h = await modernClient();
    close = h.close;
    const { prompts } = await h.client.listPrompts();
    expect(prompts.map(p => p.name)).toEqual(['seasonal-checklist']);
    const p = await h.client.getPrompt({ name: 'seasonal-checklist', arguments: { season: 'fall' } });
    const text = (p.messages[0]!.content as { text: string }).text;
    expect(text).toContain('fall');
    expect(text).toContain('Furnace');
  });
});
