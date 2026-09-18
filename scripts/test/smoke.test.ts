import { SAMPLE_MANUAL_PASSAGES, SEED_APPLIANCE_COUNT } from '@homeledger/core';
import { describe, expect, it } from 'vitest';
import { SMOKE_MANUAL_TITLE } from '../seed-manual.js';
import {
  ASK_MANUAL_SKIP_INGESTION_BLOCKED,
  ASK_MANUAL_SKIP_NO_KNOWLEDGE_BASE,
  assertApplianceCount,
  assertManualPassages,
  assertSpokenProse,
  assertToolOrder,
  assertWidgetWiring,
  askManualRetrievalUnavailableLine,
  buildElicitResponse,
  checkManualPassages,
  EXPECTED_TOOLS,
  firstTextBlock,
  manualIngestionSkipped,
  need,
  readManualResult,
  timedWithBudget,
  widgetUriOf,
  WIDGET_EXPECTATIONS,
  type ManualPassage,
  type ManualResult,
  type SmokeTool
} from '../smoke.js';

// Most of scripts/smoke.ts only runs meaningfully against the deployed
// AgentCore runtime, the deployed Knowledge Base, and a live Cognito token
// endpoint - none of which are reachable from this test run. The Knowledge
// Base itself DOES now exist (it applied cleanly on the first post-merge
// deploy; an earlier version of this comment wrongly said it was never
// applied - see FL-032), but it can neither be ingested into nor queried,
// because Bedrock model invocation is blocked account-wide and BOTH halves
// need the embedding model - ingestion to embed the documents, Retrieve to
// embed the question (FL-019, FL-032). What IS pure, offline logic -
// need(), the tool-order and widget-wiring assertions, the total
// result-classification in readManualResult/firstTextBlock, the five-state
// Knowledge Base decision, the budget enforcement in timedWithBudget, and
// the legacy elicitation auto-fulfilment in buildElicitResponse - is
// exercised here.

describe('need', () => {
  it('returns the env var when set', () => {
    process.env.SMOKE_TEST_VAR = 'value';
    expect(need('SMOKE_TEST_VAR')).toBe('value');
    delete process.env.SMOKE_TEST_VAR;
  });

  it('throws naming the missing key', () => {
    delete process.env.SMOKE_TEST_MISSING;
    expect(() => need('SMOKE_TEST_MISSING')).toThrow('SMOKE_TEST_MISSING is required');
  });
});

describe('EXPECTED_TOOLS', () => {
  // Pinned to the literal list, not just "has 9 entries": this is the same
  // list apps/mcp-server/test/tools.test.ts asserts in-process against the
  // real buildServer() output (registration order frozen per server.ts's
  // own comment), so a divergence here would mean the smoke script and the
  // server's own test disagree about what "correct" looks like.
  it('names all nine tools in server.ts registration order', () => {
    expect(EXPECTED_TOOLS).toEqual([
      'list_appliances',
      'get_appliance',
      'maintenance_due',
      'log_maintenance',
      'recent_events',
      'ask_manual',
      'book_service',
      'get_visit',
      'echo_confirm'
    ]);
  });
});

describe('assertToolOrder', () => {
  it('does not throw for the exact expected order', () => {
    expect(() => assertToolOrder([...EXPECTED_TOOLS])).not.toThrow();
  });

  it('throws when two tools are swapped', () => {
    const reordered = [...EXPECTED_TOOLS];
    [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
    expect(() => assertToolOrder(reordered)).toThrow(/tool order/);
  });

  it('throws when a tool is missing', () => {
    expect(() => assertToolOrder(EXPECTED_TOOLS.slice(0, -1))).toThrow(/tool order/);
  });

  it('throws when an extra tool is present', () => {
    expect(() => assertToolOrder([...EXPECTED_TOOLS, 'extra_tool'])).toThrow(/tool order/);
  });
});

function toolWithWidget(name: string, resourceUri?: string): SmokeTool {
  return resourceUri === undefined ? { name } : { name, _meta: { ui: { resourceUri } } };
}

describe('widgetUriOf', () => {
  it('reads _meta.ui.resourceUri for a matching tool', () => {
    const tools = [toolWithWidget('maintenance_due', 'ui://homeledger/calendar')];
    expect(widgetUriOf(tools, 'maintenance_due')).toBe('ui://homeledger/calendar');
  });

  it('returns undefined when the tool is not in the list', () => {
    expect(widgetUriOf([toolWithWidget('maintenance_due', 'ui://homeledger/calendar')], 'get_visit')).toBeUndefined();
  });

  it('returns undefined when _meta is absent', () => {
    expect(widgetUriOf([toolWithWidget('maintenance_due')], 'maintenance_due')).toBeUndefined();
  });

  it('returns undefined when _meta carries no ui.resourceUri (e.g. only the deprecated flat key)', () => {
    const tools: SmokeTool[] = [{ name: 'maintenance_due', _meta: { 'ui/resourceUri': 'ui://homeledger/calendar' } }];
    expect(widgetUriOf(tools, 'maintenance_due')).toBeUndefined();
  });
});

describe('WIDGET_EXPECTATIONS', () => {
  // Controller ruling: extend the brief's two-tool widget check (only
  // maintenance_due and get_visit) to all five tools spec 4.2 wires to a
  // widget. Pinned to the exact five pairs, not just "has 5 entries", since
  // a swapped URI on any one of them would still leave the count right.
  it('covers exactly the five widget-backed tools with the correct URI each', () => {
    expect(WIDGET_EXPECTATIONS).toEqual([
      ['list_appliances', 'ui://homeledger/appliances'],
      ['get_appliance', 'ui://homeledger/appliance'],
      ['maintenance_due', 'ui://homeledger/calendar'],
      ['book_service', 'ui://homeledger/visit'],
      ['get_visit', 'ui://homeledger/visit']
    ]);
  });
});

// Independent of the imported WIDGET_EXPECTATIONS on purpose: the per-tool
// loop below must keep generating all five cases even if a future edit
// shrinks the real WIDGET_EXPECTATIONS back toward the brief's original
// two-tool version. A first version of this file derived the loop from the
// imported constant itself, which made the "missing" cases for
// list_appliances/get_appliance/book_service silently vanish (fewer
// generated tests, none of them failing) under exactly that mutation instead
// of catching it - confirmed by mutation-testing that version, see the task
// report. This hardcoded list is what makes the coverage claim real.
const FIVE_WIDGET_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ['list_appliances', 'ui://homeledger/appliances'],
  ['get_appliance', 'ui://homeledger/appliance'],
  ['maintenance_due', 'ui://homeledger/calendar'],
  ['book_service', 'ui://homeledger/visit'],
  ['get_visit', 'ui://homeledger/visit']
];

describe('assertWidgetWiring', () => {
  const allWired: SmokeTool[] = FIVE_WIDGET_TOOLS.map(([name, uri]) => toolWithWidget(name, uri));

  it('does not throw when every one of the five tools carries its expected widget uri', () => {
    expect(() => assertWidgetWiring(allWired)).not.toThrow();
  });

  // One case per tool, not just one: this is what actually proves the loop
  // checks all five and not just the first (or only the two the brief
  // named). Dropping _meta on list_appliances, get_appliance, or
  // book_service specifically - the three the brief's own two-tool version
  // would NOT have caught - must fail here.
  for (const [name] of FIVE_WIDGET_TOOLS) {
    it(`throws naming ${name} when its widget reference is missing`, () => {
      const withOneDropped = FIVE_WIDGET_TOOLS.map(([n, uri]) => (n === name ? toolWithWidget(n) : toolWithWidget(n, uri)));
      expect(() => assertWidgetWiring(withOneDropped)).toThrow(`${name} lost its widget reference`);
    });
  }

  it('throws naming the tool when its uri points at the wrong widget', () => {
    const wrong = FIVE_WIDGET_TOOLS.map(([n, uri]) => (n === 'get_visit' ? toolWithWidget(n, 'ui://homeledger/calendar') : toolWithWidget(n, uri)));
    expect(() => assertWidgetWiring(wrong)).toThrow('get_visit lost its widget reference');
  });
});

// FL-023 regression guard, restored per controller ruling: the seed was
// genuinely non-idempotent on this project (re-seeding without a reset added
// SEED_APPLIANCE_COUNT more rows every run; the live table reached roughly
// 4x its intended size before anyone noticed), and this is the assertion
// that proves the fixed-seed-id + resetHousehold() fix still holds.
describe('assertApplianceCount', () => {
  it('does not throw at exactly SEED_APPLIANCE_COUNT', () => {
    expect(() => assertApplianceCount(SEED_APPLIANCE_COUNT)).not.toThrow();
  });

  // Models the actual historical failure mode: re-seeding without a reset
  // did not add an arbitrary wrong number, it added the seed set again,
  // landing on a whole multiple of SEED_APPLIANCE_COUNT (2x after one
  // extra re-seed, and the live incident reached roughly 4x). A guard
  // written as `count < SEED_APPLIANCE_COUNT` (a floor only) would let
  // every one of these through, since a duplicated count is always >=
  // the expected count, never below it - this exact-match form is what
  // actually catches the bug that motivated the guard.
  it.each([2, 3, 4])('throws when the count is a %ix duplicate of SEED_APPLIANCE_COUNT', multiple => {
    expect(() => assertApplianceCount(SEED_APPLIANCE_COUNT * multiple)).toThrow(
      `expected ${SEED_APPLIANCE_COUNT} seeded appliances, got ${SEED_APPLIANCE_COUNT * multiple}`
    );
  });

  it('throws when the count is short of SEED_APPLIANCE_COUNT too (not just a floor)', () => {
    expect(() => assertApplianceCount(SEED_APPLIANCE_COUNT - 1)).toThrow(`expected ${SEED_APPLIANCE_COUNT} seeded appliances, got ${SEED_APPLIANCE_COUNT - 1}`);
  });
});

// task-13-review.md Finding 1, CRITICAL: a bare F21-substring check cannot
// tell the deployed Knowledge Base apart from apps/mcp-server/src/deps.ts's
// own createFixtureRetriever fallback, because SAMPLE_MANUAL_PASSAGES[0]
// (the fixture data) matches this smoke's exact question and contains
// "F21". These tests feed the guard fixture-shaped content directly - the
// actual shape a KB-less runtime would return - rather than a synthetic
// mutation, since the trap here lives in the DATA, not in a code path this
// task could mutate.
describe('assertManualPassages', () => {
  it('throws when there are no passages at all', () => {
    expect(() => assertManualPassages([])).toThrow('ask_manual returned no passages');
  });

  it('throws when the only match is fixture-shaped content (the actual Finding 1 scenario)', () => {
    const fixturePassages: ManualPassage[] = SAMPLE_MANUAL_PASSAGES.map(p => ({ text: p.text, docTitle: p.docTitle, page: p.page }));
    // Sanity check that the trap is real, not a stale assumption: if this
    // ever stops being true, the test above it is not exercising Finding 1
    // anymore and needs to be revisited.
    expect(fixturePassages.some(p => p.text.includes('F21'))).toBe(true);
    expect(() => assertManualPassages(fixturePassages)).toThrow(/did not return the seeded KB document/);
  });

  it('does not throw when a passage carries the seeded title and the F21 text', () => {
    const passages: ManualPassage[] = [{ text: 'Error code F21 indicates a long drain time.', docTitle: SMOKE_MANUAL_TITLE, page: 1 }];
    expect(() => assertManualPassages(passages)).not.toThrow();
  });

  it('throws when the title matches but the text does not mention F21', () => {
    const passages: ManualPassage[] = [{ text: 'Unrelated maintenance content.', docTitle: SMOKE_MANUAL_TITLE, page: 1 }];
    expect(() => assertManualPassages(passages)).toThrow(/did not return the seeded KB document/);
  });

  // The `===` in assertManualPassages is load-bearing, and until these two
  // cases existed nothing guarded it: every other case above feeds the guard
  // SMOKE_MANUAL_TITLE exactly as the guard reads it, so they prove the
  // comparison is WIRED, never that it is EXACT - relaxing `===` to
  // `.includes()` in either direction was caught by nothing. The standing
  // rule from Task 11 applies verbatim: a test that reads the same symbol
  // the code reads verifies wiring, not value.
  //
  // One case per direction, because `.includes()` can be written either way
  // round and only one of these catches each:
  //   p.docTitle.includes(SMOKE_MANUAL_TITLE) -> the superstring passes
  //   SMOKE_MANUAL_TITLE.includes(p.docTitle) -> the prefix passes
  it('throws on a title that merely CONTAINS the seeded title (a superstring, not an equal)', () => {
    const passages: ManualPassage[] = [{ text: 'Error code F21 indicates a long drain time.', docTitle: `${SMOKE_MANUAL_TITLE} (archived copy)`, page: 1 }];
    expect(() => assertManualPassages(passages)).toThrow(/did not return the seeded KB document/);
  });

  it('throws on a title the seeded title merely contains (a prefix, not an equal)', () => {
    const prefix = SMOKE_MANUAL_TITLE.slice(0, -' manual'.length);
    expect(prefix).not.toBe(SMOKE_MANUAL_TITLE);
    const passages: ManualPassage[] = [{ text: 'Error code F21 indicates a long drain time.', docTitle: prefix, page: 1 }];
    expect(() => assertManualPassages(passages)).toThrow(/did not return the seeded KB document/);
  });

  // Same class of bug as the run-35290491286 crash, one level deeper: a
  // malformed passage must make the MATCH fail, not make the comparison
  // throw a TypeError. Each of these has to reach the "did not return the
  // seeded KB document" message, which is only possible if both the `.some`
  // predicate and the message's own `.map` survive the bad entry.
  it.each([
    ['a passage with no text field', [{ docTitle: SMOKE_MANUAL_TITLE, page: 1 }]],
    ['a passage whose text is not a string', [{ text: 42, docTitle: SMOKE_MANUAL_TITLE, page: 1 }]],
    ['a passage with no docTitle', [{ text: 'Error code F21 indicates a long drain time.', page: 1 }]],
    ['a null entry', [null]],
    ['an undefined entry', [undefined]]
  ])('fails the match rather than throwing a TypeError on %s', (_label, passages) => {
    expect(() => assertManualPassages(passages as unknown as ManualPassage[])).toThrow(/did not return the seeded KB document/);
  });
});

// Fails closed by design: only an explicit affirmative disables the
// assertion. If this ever became "any non-empty string is truthy", a stray
// MANUAL_INGESTION_SKIPPED=false in a workflow edit would silently and
// permanently switch off the one guard in this file that exists to stop a
// false green - and nothing would go red to say so.
describe('manualIngestionSkipped', () => {
  it.each([['1'], ['true'], ['TRUE'], ['  yes  '], ['Yes']])('treats %j as skipped', raw => {
    expect(manualIngestionSkipped(raw)).toBe(true);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
    ['the string zero', '0'],
    ['the string false', 'false'],
    ['the string no', 'no'],
    ['an unrecognised value', 'maybe'],
    ['a value that merely contains an affirmative', 'not-true']
  ])('does NOT treat %s as skipped, so the assertion stays enforced', (_label, raw) => {
    expect(manualIngestionSkipped(raw)).toBe(false);
  });
});

// readManualResult must be TOTAL: every one of these inputs is something a
// real tool call has returned or could return, and not one of them may throw.
// Run 35290491286 died on `(manual.structuredContent as {...}).passages`
// against the very first case below, taking every later assertion in the
// script with it.
describe('readManualResult', () => {
  it('reads passages out of a well-formed result', () => {
    const result = readManualResult({
      content: [{ type: 'text', text: 'one passage' }],
      structuredContent: { passages: [{ text: 'F21', docTitle: 'T', page: 1 }] }
    });
    expect(result.kind).toBe('passages');
    expect(result.kind === 'passages' && result.passages).toHaveLength(1);
  });

  it('reads an empty passage list as passages, not as an error', () => {
    const result = readManualResult({ content: [{ type: 'text', text: "I couldn't find anything." }], structuredContent: { passages: [] } });
    expect(result.kind).toBe('passages');
    expect(result.kind === 'passages' && result.passages).toEqual([]);
  });

  // The exact shape the MCP SDK produces when a tool handler throws, which
  // is what ask_manual does today when Retrieve is refused: isError with a
  // text block and NO structuredContent at all.
  it('classifies the isError result a thrown handler produces, and keeps the server text in the detail', () => {
    const result = readManualResult({
      isError: true,
      content: [{ type: 'text', text: 'Error: ValidationException: Access to Bedrock models is not allowed for this account' }]
    });
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.detail).toContain('Access to Bedrock models is not allowed for this account');
    // Names the branch it took, not just that it errored: without this, a
    // result with isError and no structuredContent reaches the SAME verdict
    // through the next branch down, so deleting the isError check entirely
    // would go unnoticed. Confirmed by mutation - see the task report's N6.
    expect(result.kind === 'error' && result.detail).toContain('isError result:');
  });

  // The case that makes the isError branch load-bearing on its own. A tool
  // may return isError alongside a well-formed structuredContent, and the
  // server is free to start doing exactly that for ask_manual (see the
  // report's note on a typed error shape). `isError` is the authoritative
  // signal; a readable payload underneath it does not make the call a
  // success, and reading it as one would report 'skipped-ingestion-blocked'
  // for a run where retrieval actually failed.
  it('classifies an isError result as an error even when it also carries a well-formed structuredContent', () => {
    const result = readManualResult({ isError: true, content: [{ type: 'text', text: 'Error: Retrieve refused' }], structuredContent: { passages: [] } });
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.detail).toContain('Retrieve refused');
  });

  it.each([
    ['structuredContent missing entirely', { content: [{ type: 'text', text: 'hi' }] }],
    ['structuredContent undefined', { content: [], structuredContent: undefined }],
    ['structuredContent null', { structuredContent: null }],
    ['structuredContent a string', { structuredContent: 'passages' }],
    ['passages missing', { structuredContent: {} }],
    ['passages not an array', { structuredContent: { passages: 'none' } }],
    ['passages null', { structuredContent: { passages: null } }],
    ['the whole result undefined', undefined],
    ['the whole result null', null],
    ['the whole result a string', 'boom']
  ])('classifies %s as an error rather than throwing', (_label, input) => {
    const result = readManualResult(input);
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.detail.length).toBeGreaterThan(0);
  });

  it('does not treat isError: false as an error when the payload is well formed', () => {
    expect(readManualResult({ isError: false, structuredContent: { passages: [] } }).kind).toBe('passages');
  });
});

describe('firstTextBlock', () => {
  it('returns the first block text', () => {
    expect(
      firstTextBlock([
        { type: 'text', text: 'spoken' },
        { type: 'text', text: 'second' }
      ])
    ).toBe('spoken');
  });

  // `(undefined as unknown[])[0]` throws, which is why the old call site's
  // `?.` was reassurance one level too late.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty array', []],
    ['a non-array', { text: 'nope' }],
    ['an array of nulls', [null]],
    ['a block with no text', [{ type: 'image' }]],
    ['a block whose text is not a string', [{ type: 'text', text: 42 }]]
  ])('returns an empty string for %s instead of throwing', (_label, input) => {
    expect(firstTextBlock(input)).toBe('');
  });
});

function passageResult(passages: ManualPassage[]): ManualResult {
  return { kind: 'passages', passages };
}

const BEDROCK_ERROR_RESULT: ManualResult = {
  kind: 'error',
  detail: 'isError result: Error: ValidationException: Access to Bedrock models is not allowed for this account'
};

// The five states. States 3 and 4 are the point of the whole function: once a
// Knowledge Base is configured AND ingestion actually happened, anything that
// is not a real passage set with a matching title must fail hard. The skips
// exist for "there is no Knowledge Base", "there is one but nothing could be
// put into it", and "there is one but retrieval itself is refused" - never
// for "the Knowledge Base returned the wrong thing", and never for an error
// result outside the one state that positively explains it.
describe('checkManualPassages', () => {
  const fixtureShaped: ManualPassage[] = SAMPLE_MANUAL_PASSAGES.map(p => ({ text: p.text, docTitle: p.docTitle, page: p.page }));
  const seeded: ManualPassage[] = [{ text: 'Error code F21 indicates a long drain time.', docTitle: SMOKE_MANUAL_TITLE, page: 1 }];

  // State 1: no Knowledge Base at all.
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   ']
  ])('skips, without throwing, when KNOWLEDGE_BASE_ID is %s', (_label, kbId) => {
    expect(checkManualPassages(kbId, false, passageResult(fixtureShaped))).toBe('skipped-no-knowledge-base');
    // Also with no passages at all: a runtime with no Knowledge Base can
    // legitimately return nothing, and the skip must not trip over that.
    expect(checkManualPassages(kbId, false, passageResult([]))).toBe('skipped-no-knowledge-base');
    // And the absent Knowledge Base is reported as such even if the seed
    // step somehow also signalled a skip - the more fundamental state wins,
    // so the log names the real reason rather than the downstream symptom.
    expect(checkManualPassages(kbId, true, passageResult([]))).toBe('skipped-no-knowledge-base');
  });

  // State 2: a Knowledge Base exists, but seed:manual could not ingest into
  // it. This is the state that did not exist before FL-032 and whose absence
  // failed smoke run 35238251562 outright. Note the content here is exactly
  // the content state 4 must reject - identical input, opposite outcome,
  // decided solely by the signal from the seed step.
  it('skips when a Knowledge Base is configured but ingestion was skipped', () => {
    expect(checkManualPassages('kb-1234567890', true, passageResult(fixtureShaped))).toBe('skipped-ingestion-blocked');
    expect(checkManualPassages('kb-1234567890', true, passageResult([]))).toBe('skipped-ingestion-blocked');
    // Even content that WOULD have passed: the run still proved nothing,
    // because nothing was ingested for it to have come from.
    expect(checkManualPassages('kb-1234567890', true, passageResult(seeded))).toBe('skipped-ingestion-blocked');
  });

  // State 2b, found by live run 35290491286: retrieval embeds the query too,
  // so under the account block Retrieve is refused and the tool returns an
  // error result rather than an empty passage list. Tolerated ONLY here.
  it('skips when a Knowledge Base is configured, ingestion was skipped, and retrieval itself returned an error result', () => {
    expect(checkManualPassages('kb-1234567890', true, BEDROCK_ERROR_RESULT)).toBe('skipped-retrieval-unavailable');
  });

  // State 3: configured, ingested, title matches.
  it('asserts and passes when a Knowledge Base is configured, ingestion happened, and the seeded document came back', () => {
    expect(checkManualPassages('kb-1234567890', false, passageResult(seeded))).toBe('asserted');
  });

  // State 4, THE INVARIANT. The false green this whole assertion exists to
  // prevent: Terraform's output is populated, ingestion ran, but the running
  // revision still has the variable unset and is quietly serving
  // @homeledger/core's SAMPLE_MANUAL_PASSAGES (which match this smoke's
  // exact question and contain "F21"). Not skippable, at any
  // KNOWLEDGE_BASE_ID, and specifically not made skippable by either new
  // skip state - which is why each of these passes ingestionSkipped=false
  // explicitly rather than relying on a default.
  it('STILL THROWS when a Knowledge Base is configured, ingestion happened, and the content is fixture-shaped', () => {
    expect(() => checkManualPassages('kb-1234567890', false, passageResult(fixtureShaped))).toThrow(/did not return the seeded KB document/);
  });

  it('still throws when ingestion happened and the title merely resembles the seeded one', () => {
    const nearMiss: ManualPassage[] = [{ text: 'Error code F21 indicates a long drain time.', docTitle: `${SMOKE_MANUAL_TITLE} (archived copy)`, page: 1 }];
    expect(() => checkManualPassages('kb-1234567890', false, passageResult(nearMiss))).toThrow(/did not return the seeded KB document/);
  });

  it('still throws when a Knowledge Base is configured, ingestion happened, and no passages came back at all', () => {
    expect(() => checkManualPassages('kb-1234567890', false, passageResult([]))).toThrow('ask_manual returned no passages');
  });

  // THE INVARIANT, error-result half - the leak the new tolerance must not
  // spring. An error result is exactly as damning as fixture content when
  // nothing signalled that ingestion was skipped: retrieval is broken, or the
  // runtime cannot reach the Knowledge Base, and neither is a pass.
  it('STILL THROWS on an error result when ingestion was NOT skipped', () => {
    expect(() => checkManualPassages('kb-1234567890', false, BEDROCK_ERROR_RESULT)).toThrow(/returned an error result instead of passages/);
  });

  // Same, with no Knowledge Base configured: the runtime serves in-memory
  // fixtures in that state and has nothing that can legitimately error, so
  // an error result there is unexplained and must not be swallowed by the
  // no-Knowledge-Base skip.
  it.each([
    ['unset', undefined],
    ['empty', '']
  ])('STILL THROWS on an error result when KNOWLEDGE_BASE_ID is %s and nothing signalled a skip', (_label, kbId) => {
    expect(() => checkManualPassages(kbId, false, BEDROCK_ERROR_RESULT)).toThrow(/returned an error result instead of passages/);
  });

  it('names the server detail in the thrown message, so the log says what actually came back', () => {
    expect(() => checkManualPassages('kb-1234567890', false, BEDROCK_ERROR_RESULT)).toThrow(/Access to Bedrock models is not allowed for this account/);
  });

  it('names KNOWLEDGE_BASE_ID in the no-Knowledge-Base skip line so the log says why nothing was proved', () => {
    expect(ASK_MANUAL_SKIP_NO_KNOWLEDGE_BASE).toContain('SKIPPED');
    expect(ASK_MANUAL_SKIP_NO_KNOWLEDGE_BASE).toContain('KNOWLEDGE_BASE_ID');
  });

  // Three skips, three different causes, three different lines: reusing one
  // line would leave the log unable to distinguish "no Knowledge Base was
  // ever built" from "one was built and could not be filled" from "one was
  // built and cannot even be queried", which are very different things to
  // read on a Monday morning.
  it('says something different, and names the Bedrock block, in the ingestion-skipped line', () => {
    expect(ASK_MANUAL_SKIP_INGESTION_BLOCKED).toContain('SKIPPED');
    expect(ASK_MANUAL_SKIP_INGESTION_BLOCKED).toContain('Bedrock');
    expect(ASK_MANUAL_SKIP_INGESTION_BLOCKED).toContain('FL-032');
    expect(ASK_MANUAL_SKIP_INGESTION_BLOCKED).not.toBe(ASK_MANUAL_SKIP_NO_KNOWLEDGE_BASE);
  });

  it('explains the query-embedding cause, and quotes the server, in the retrieval-unavailable line', () => {
    const line = askManualRetrievalUnavailableLine('isError result: Error: ValidationException: Access to Bedrock models is not allowed for this account');
    expect(line).toContain('SKIPPED');
    expect(line).toContain('FL-032');
    // The sharper finding, and the reason this state exists at all: it is
    // the QUERY that has to be embedded, not only the documents.
    expect(line).toContain('QUERY');
    expect(line).toContain('Access to Bedrock models is not allowed for this account');
    expect(line).not.toBe(ASK_MANUAL_SKIP_INGESTION_BLOCKED);
    expect(line).not.toBe(ASK_MANUAL_SKIP_NO_KNOWLEDGE_BASE);
  });
});

// task-13-review.md Finding 3, IMPORTANT: `(content[0]?.text ?? '')` made
// the old JSON-shape check vacuous on an empty/missing content block.
describe('assertSpokenProse', () => {
  it('does not throw for plain prose', () => {
    expect(() => assertSpokenProse('3 passages, first from the washer manual.')).not.toThrow();
  });

  it('throws when the text is empty (the vacuous-check scenario)', () => {
    expect(() => assertSpokenProse('')).toThrow('ask_manual returned no spoken text');
  });

  it('throws when the text looks like JSON', () => {
    expect(() => assertSpokenProse('{"passages":[]}')).toThrow(/spoke JSON/);
  });
});

describe('timedWithBudget', () => {
  it('resolves with the wrapped function result', async () => {
    await expect(timedWithBudget('label', async () => 'ok', 3000)).resolves.toBe('ok');
  });

  it('throws when the call exceeds the budget and enforcement is on', async () => {
    await expect(timedWithBudget('slow', () => new Promise(resolve => setTimeout(() => resolve(undefined), 30)), 5)).rejects.toThrow(/slow exceeded 5 ms/);
  });

  it('does not throw over budget when enforcement is off', async () => {
    await expect(timedWithBudget('slow', () => new Promise(resolve => setTimeout(() => resolve(undefined), 30)), 5, false)).resolves.toBeUndefined();
  });
});

describe('buildElicitResponse', () => {
  it('accepts confirm: true for a confirm field, regardless of schema shape', () => {
    const asked: string[] = [];
    const res = buildElicitResponse({ properties: { confirm: {} } }, asked);
    expect(res).toEqual({ action: 'accept', content: { confirm: true } });
    expect(asked).toEqual(['confirm']);
  });

  it('accepts the first enum option for a non-confirm field', () => {
    const asked: string[] = [];
    const res = buildElicitResponse({ properties: { provider: { enum: ['prov_a', 'prov_b'] } } }, asked);
    expect(res).toEqual({ action: 'accept', content: { provider: 'prov_a' } });
    expect(asked).toEqual(['provider']);
  });

  it('throws when the field offers zero options', () => {
    const asked: string[] = [];
    expect(() => buildElicitResponse({ properties: { provider: { enum: [] } } }, asked)).toThrow('elicitation for provider offered no options');
  });

  it('does not throw at exactly five options (the boundary)', () => {
    const asked: string[] = [];
    expect(() => buildElicitResponse({ properties: { window: { enum: ['w1', 'w2', 'w3', 'w4', 'w5'] } } }, asked)).not.toThrow();
  });

  it('throws at six options, one past the boundary', () => {
    const asked: string[] = [];
    expect(() => buildElicitResponse({ properties: { window: { enum: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'] } } }, asked)).toThrow(
      'elicitation for window offered 6 options'
    );
  });
});
