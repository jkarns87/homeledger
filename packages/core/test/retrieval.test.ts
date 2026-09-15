import { describe, expect, it } from 'vitest';
import { FIXTURE_APPLIANCE_IDS, SAMPLE_MANUAL_PASSAGES, createFixtureRetriever } from '../src/retrieval/fixture.js';
import { MAX_PASSAGES, clampPassages } from '../src/retrieval/retriever.js';

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

  it('ranks by keyword hit count first, then by score', async () => {
    const passages = await retriever.retrieve({ question: 'drain filter clean monthly', applianceId: FIXTURE_APPLIANCE_IDS.washer });
    expect(passages.length).toBeGreaterThan(0);
    // Index 1 in SAMPLE_MANUAL_PASSAGES (score 0.81) matches all four keywords: drain, filter, clean, monthly.
    // Index 0 (score 0.94) matches only drain. Correct ranking puts the multi-keyword match first.
    expect(passages[0]?.text).toContain('Clean the drain pump filter every month');
  });
});

describe('clampPassages', () => {
  it('returns MAX_PASSAGES when undefined', () => {
    expect(clampPassages(undefined)).toBe(MAX_PASSAGES);
  });

  it('clamps zero up to 1', () => {
    expect(clampPassages(0)).toBe(1);
  });

  it('clamps negative numbers up to 1', () => {
    expect(clampPassages(-5)).toBe(1);
  });

  it('clamps values above MAX_PASSAGES down to MAX_PASSAGES', () => {
    expect(clampPassages(10)).toBe(MAX_PASSAGES);
  });

  it('passes through in-range values unchanged', () => {
    expect(clampPassages(1)).toBe(1);
    expect(clampPassages(2)).toBe(2);
    expect(clampPassages(3)).toBe(3);
  });
});
