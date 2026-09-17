import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_APPLIANCE_IDS } from '@homeledger/core';
import { hasJson } from '../src/voice.js';
import { modernClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
});

describe('ask_manual', () => {
  it('returns passages with page numbers and speaks a citation without JSON', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'ask_manual', arguments: { question: 'What does F21 mean on the washer?' } });
    const sc = r.structuredContent as { passages: Array<{ text: string; docTitle: string; page: number | null; score: number }> };
    expect(sc.passages.length).toBeGreaterThan(0);
    expect(sc.passages.length).toBeLessThanOrEqual(3);
    expect(sc.passages[0]?.page).toBe(42);
    expect(sc.passages[0]?.docTitle).toBe('LG WM4000HWA washer owner manual');
    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(hasJson(text)).toBe(false);
    expect(text).toContain('LG WM4000HWA washer owner manual page 42');
  });

  it('passes applianceId through as a filter', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'ask_manual', arguments: { question: 'filter', applianceId: FIXTURE_APPLIANCE_IDS.furnace } });
    const sc = r.structuredContent as { passages: Array<{ docTitle: string }> };
    expect(sc.passages.length).toBeGreaterThan(0);
    expect(sc.passages.every(p => p.docTitle.includes('furnace'))).toBe(true);
  });

  it('caps at three passages even when every fixture passage matches', async () => {
    const h = await modernClient();
    close = h.close;
    // Every keyword from every SAMPLE_MANUAL_PASSAGES entry appears here, so all six
    // fixture passages match (matched > 0) and MAX_PASSAGES is the only thing that
    // can keep the result at 3. Without the cap this returns 6.
    const question =
      'f21 drain hose pump washer code error filter clean monthly merv furnace replace air 90 inspection pressure switch condensate flame flush tank sediment water heater annual anode rod inspect warranty';
    const r = await h.client.callTool({ name: 'ask_manual', arguments: { question } });
    const sc = r.structuredContent as { passages: Array<{ docTitle: string; page: number | null }> };
    expect(sc.passages.length).toBe(3);
    expect(sc.passages[0]?.page).toBe(42);
    expect(sc.passages[0]?.docTitle).toBe('LG WM4000HWA washer owner manual');
  });

  it('says so plainly when the manuals have nothing', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'ask_manual', arguments: { question: 'how do I repaint the garage door' } });
    expect((r.structuredContent as { passages: unknown[] }).passages).toEqual([]);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("I couldn't find anything about that in the manuals.");
  });
});
