import { type ManualRetriever, type Passage, type RetrieveOptions, clampPassages } from './retriever.js';

export interface FixturePassage extends Passage {
  applianceId: string | null;
  keywords: string[];
}

/** Stable appliance ids used only by fixtures and tests; the seeded household mints real ones. */
export const FIXTURE_APPLIANCE_IDS = {
  washer: 'appl_washer2222222222',
  furnace: 'appl_furnace222222222',
  waterHeater: 'appl_waterheater22222'
} as const;

export const SAMPLE_MANUAL_PASSAGES: FixturePassage[] = [
  {
    text: 'Error code F21 indicates a long drain time. The washer could not pump the water out within eight minutes. Check the drain hose for kinks, clean the drain pump filter behind the lower access panel, and restart the cycle.',
    docTitle: 'LG WM4000HWA washer owner manual',
    page: 42,
    score: 0.94,
    applianceId: FIXTURE_APPLIANCE_IDS.washer,
    keywords: ['f21', 'drain', 'hose', 'pump', 'washer', 'code', 'error']
  },
  {
    text: 'Clean the drain pump filter every month. Turn off the water supply, open the lower access panel, place a shallow pan under the filter cap, and turn the cap counter-clockwise to drain the residual water before removing the filter.',
    docTitle: 'LG WM4000HWA washer owner manual',
    page: 43,
    score: 0.81,
    applianceId: FIXTURE_APPLIANCE_IDS.washer,
    keywords: ['drain', 'filter', 'clean', 'pump', 'washer', 'monthly']
  },
  {
    text: 'Replace the air filter every 90 days under normal use, or every 30 days when pets are in the home. Use a 16 by 25 by 1 inch filter with a MERV rating of 8 to 11. Turn the system off at the thermostat before opening the filter door.',
    docTitle: 'Carrier 59SC5A furnace installation and service manual',
    page: 17,
    score: 0.9,
    applianceId: FIXTURE_APPLIANCE_IDS.furnace,
    keywords: ['filter', 'merv', 'furnace', 'replace', 'air', '90']
  },
  {
    text: 'Annual inspection covers the heat exchanger, the inducer motor, the flame sensor, and the condensate trap. A flashing status light of three short pulses indicates a pressure switch fault, most often a blocked condensate drain.',
    docTitle: 'Carrier 59SC5A furnace installation and service manual',
    page: 61,
    score: 0.77,
    applianceId: FIXTURE_APPLIANCE_IDS.furnace,
    keywords: ['inspection', 'furnace', 'pressure', 'switch', 'condensate', 'flame']
  },
  {
    text: 'Flush the tank once a year to remove sediment. Shut off the gas control to the pilot setting, close the cold water inlet, attach a hose to the drain valve, and run the water to a floor drain until it runs clear.',
    docTitle: 'Rheem XG50T12HE40U0 water heater use and care guide',
    page: 23,
    score: 0.88,
    applianceId: FIXTURE_APPLIANCE_IDS.waterHeater,
    keywords: ['flush', 'tank', 'sediment', 'water', 'heater', 'drain', 'annual']
  },
  {
    text: 'Inspect the anode rod every three years. A rod worn to less than three eighths of an inch or coated in calcium should be replaced to keep the tank warranty in force.',
    docTitle: 'Rheem XG50T12HE40U0 water heater use and care guide',
    page: 25,
    score: 0.72,
    applianceId: FIXTURE_APPLIANCE_IDS.waterHeater,
    keywords: ['anode', 'rod', 'inspect', 'water', 'heater', 'warranty']
  }
];

function hits(passage: FixturePassage, question: string): number {
  const haystack = question.toLowerCase();
  return passage.keywords.reduce((n, keyword) => (haystack.includes(keyword) ? n + 1 : n), 0);
}

/**
 * Keyword retriever over a fixed passage set. Deterministic on purpose: unit
 * and contract tests assert exact passages, and the local server uses it when
 * KNOWLEDGE_BASE_ID is unset so `pnpm dev` works with no AWS account.
 */
export function createFixtureRetriever(passages: FixturePassage[]): ManualRetriever {
  return {
    async retrieve(options: RetrieveOptions): Promise<Passage[]> {
      const limit = clampPassages(options.maxPassages);
      return passages
        .filter(p => (options.applianceId ? p.applianceId === options.applianceId : true))
        .map(p => ({ passage: p, matched: hits(p, options.question) }))
        .filter(entry => entry.matched > 0)
        .sort((a, b) => b.matched - a.matched || b.passage.score - a.passage.score)
        .slice(0, limit)
        .map(entry => ({ text: entry.passage.text, docTitle: entry.passage.docTitle, page: entry.passage.page, score: entry.passage.score }));
    }
  };
}
