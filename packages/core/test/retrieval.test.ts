import { describe, expect, it } from 'vitest';
import { FIXTURE_APPLIANCE_IDS, SAMPLE_MANUAL_PASSAGES, createFixtureRetriever } from '../src/retrieval/fixture.js';
import { MAX_PASSAGES } from '../src/retrieval/retriever.js';

const retriever = createFixtureRetriever(SAMPLE_MANUAL_PASSAGES);

describe('fixture retriever', () => {
  it('finds the washer error code by keyword', async () => {
    const passages = await retriever.retrieve({ question: 'What does F21 mean on the washer?' });
    expect(passages.length).toBeGreaterThan(0);
    expect(passages[0]?.text).toContain('F21');
    expect(passages[0]?.docTitle).toBe('LG WM4000HWA washer owner manual');
    expect(passages[0]?.page).toBe(42);
  });

  it('never returns more than three passages', async () => {
    const passages = await retriever.retrieve({ question: 'filter water drain code service manual washer furnace heater' });
    expect(passages.length).toBeLessThanOrEqual(MAX_PASSAGES);
  });

  it('honours an explicit maxPassages below the cap', async () => {
    const passages = await retriever.retrieve({ question: 'filter water drain code service manual washer furnace heater', maxPassages: 1 });
    expect(passages.length).toBe(1);
  });

  it('filters by applianceId when one is supplied', async () => {
    const passages = await retriever.retrieve({ question: 'filter', applianceId: FIXTURE_APPLIANCE_IDS.furnace });
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.every(p => p.docTitle.includes('furnace'))).toBe(true);
  });

  it('returns nothing when no keyword matches', async () => {
    expect(await retriever.retrieve({ question: 'how do I repaint the garage door' })).toEqual([]);
  });

  it('orders by keyword hits then score', async () => {
    const passages = await retriever.retrieve({ question: 'drain hose F21 washer' });
    for (let i = 1; i < passages.length; i++) expect(passages[i - 1]!.score).toBeGreaterThanOrEqual(passages[i]!.score - 1);
  });
});
