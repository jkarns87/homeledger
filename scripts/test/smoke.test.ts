import { SEED_APPLIANCE_COUNT } from '@homeledger/core';
import { describe, expect, it } from 'vitest';
import {
  assertApplianceCount,
  assertToolOrder,
  assertWidgetWiring,
  buildElicitResponse,
  EXPECTED_TOOLS,
  need,
  timedWithBudget,
  widgetUriOf,
  WIDGET_EXPECTATIONS,
  type SmokeTool
} from '../smoke.js';

// Most of scripts/smoke.ts only runs meaningfully against the deployed
// AgentCore runtime, the deployed Knowledge Base, and a live Cognito token
// endpoint - none of which exist in this test run (the Knowledge Base was
// never applied; Bedrock model access is blocked account-wide, FL-019). What
// IS pure, offline logic - need(), the tool-order and widget-wiring
// assertions, the budget enforcement in timedWithBudget, and the legacy
// elicitation auto-fulfilment in buildElicitResponse - is exercised here.

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
