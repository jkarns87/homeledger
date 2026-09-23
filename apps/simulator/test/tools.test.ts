import { describe, expect, it } from 'vitest';
import { NO_DATA_NOTICE, elicitationShape, readToolResult, toAnthropicTools, toToolResultBlock, widgetUriOf } from '../src/server/tools.js';

const listAppliances = {
  name: 'list_appliances',
  description: 'List the household appliances, optionally filtered by room or category.',
  inputSchema: { type: 'object', properties: { room: { type: 'string' } } },
  _meta: { ui: { resourceUri: 'ui://homeledger/appliances' } }
};

describe('toAnthropicTools', () => {
  it('carries name, description and schema across unchanged, in order', () => {
    const second = { name: 'get_appliance', description: 'One appliance.', inputSchema: { type: 'object' } };
    expect(toAnthropicTools([listAppliances, second])).toEqual([
      { name: 'list_appliances', description: listAppliances.description, input_schema: listAppliances.inputSchema },
      { name: 'get_appliance', description: 'One appliance.', input_schema: { type: 'object' } }
    ]);
  });

  it('substitutes an empty description rather than omitting the field', () => {
    expect(toAnthropicTools([{ name: 'x', inputSchema: { type: 'object' } }])[0]?.description).toBe('');
  });
});

describe('widgetUriOf', () => {
  it('reads the nested ui.resourceUri the server sets on the tool definition', () => {
    expect(widgetUriOf(listAppliances)).toBe('ui://homeledger/appliances');
  });

  it('is null for a tool with no widget, and for malformed _meta', () => {
    expect(widgetUriOf({ name: 'ask_manual', inputSchema: {} })).toBeNull();
    expect(widgetUriOf({ name: 'x', inputSchema: {}, _meta: 'nope' })).toBeNull();
    expect(widgetUriOf({ name: 'x', inputSchema: {}, _meta: { ui: { resourceUri: 42 } } })).toBeNull();
    // A well-typed string that is not a widget address. Added because the
    // numeric case above is caught by the `typeof` check on its own, so without
    // this the `startsWith('ui://')` guard could be deleted with the suite
    // still green - confirmed by running exactly that mutation.
    expect(widgetUriOf({ name: 'x', inputSchema: {}, _meta: { ui: { resourceUri: 'https://example.invalid/x' } } })).toBeNull();
  });
});

describe('readToolResult', () => {
  it('reads spoken text, the whole content array, and structured content from a healthy result', () => {
    // `content` is carried through unflattened because the MCP Apps view
    // protocol's tool-result payload is `{content, structuredContent}` and the
    // widget host in Task 14 has nowhere else to get it. `spoken` is the same
    // data flattened for the transcript; both, not one.
    const content = [{ type: 'text', text: 'Six appliances.' }];
    expect(readToolResult({ content, structuredContent: { appliances: [] } })).toEqual({
      ok: true,
      spoken: 'Six appliances.',
      content,
      structured: { appliances: [] }
    });
  });

  it('reads a decline as the ordinary result it is, not as a failure', () => {
    // apps/mcp-server/src/tools/service.ts's notBooked(), after Step 1. A
    // person pressing "Not now" is a working call with a negative answer, and
    // the whole downstream chain - tool-failed, is_error, NO_DATA_NOTICE,
    // explainFailure - keys off this one classification.
    expect(readToolResult({ content: [{ type: 'text', text: "Okay, I haven't booked anything." }], structuredContent: { booked: false } })).toEqual({
      ok: true,
      spoken: "Okay, I haven't booked anything.",
      content: [{ type: 'text', text: "Okay, I haven't booked anything." }],
      structured: { booked: false }
    });
  });

  it('reports an error result as a failure carrying the server sentence', () => {
    // FL-032's shape exactly: isError true, a spoken explanation, and NO
    // structuredContent at all. A reader that goes looking for passages here
    // crashes; a reader that treats it as empty lies.
    expect(
      readToolResult({ isError: true, content: [{ type: 'text', text: "I can't look in the manuals right now: model access is blocked on this account." }] })
    ).toEqual({ ok: false, message: "I can't look in the manuals right now: model access is blocked on this account." });
  });

  it('reports an error result that also carries well-formed structured content as a failure', () => {
    // The branch FL-032's mutation N6 found decorative. If the only error
    // fixture is one that would fail the next check down anyway, dropping the
    // isError check costs nothing and the suite stays green.
    expect(readToolResult({ isError: true, content: [{ type: 'text', text: 'Refused.' }], structuredContent: { passages: [] } })).toEqual({
      ok: false,
      message: 'Refused.'
    });
  });

  it('is total over every malformed shape rather than throwing', () => {
    for (const bad of [undefined, null, 'a string', 42, [], {}, { content: 'not an array' }, { content: [] }, { content: [{ type: 'image' }] }]) {
      const outcome = readToolResult(bad);
      expect(outcome.ok, JSON.stringify(bad)).toBe(false);
      expect((outcome as { message: string }).message.length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });
});

describe('toToolResultBlock', () => {
  it('sends the spoken text and the structured content back on success, unflagged', () => {
    const block = toToolResultBlock('c1', {
      ok: true,
      spoken: 'Six appliances.',
      content: [{ type: 'text', text: 'Six appliances.' }],
      structured: { appliances: [] }
    });
    expect(block.tool_use_id).toBe('c1');
    expect(block.is_error).toBeUndefined();
    expect(block.content).toEqual([{ type: 'text', text: 'Six appliances.\n\n{"appliances":[]}' }]);
  });

  it('flags a failure and tells the model in words that nothing was retrieved', () => {
    const block = toToolResultBlock('c1', { ok: false, message: 'Session not found.' });
    expect(block.is_error).toBe(true);
    const text = (block.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('Session not found.');
    expect(text).toContain(NO_DATA_NOTICE);
  });

  it('states in the notice that repository fixtures are not an answer', () => {
    // The literal thing that happened twice, named so the notice cannot be
    // edited down into a generic apology.
    expect(NO_DATA_NOTICE).toContain('NO DATA WAS RETRIEVED');
    expect(NO_DATA_NOTICE).toContain('fixtures');
  });
});

/**
 * The classification, proved as behaviour rather than as a sentence.
 *
 * An assertion that the notice contains the word "fixtures" says nothing about
 * whether a model would obey it, and nothing at all about whether the two
 * outcomes can be told apart once they are blocks in a message array. What CAN
 * be proved from here is the structural half, and it is the half FL-039 turned
 * on: a failure and a success must not be confusable by anything downstream,
 * and the thing that separates them must not be the wording of the message -
 * because the wording is exactly what a server is free to change.
 */
describe('a failure is structurally distinguishable from a success', () => {
  // Byte-identical spoken text on both sides, so nothing here can be passing
  // because the sentences happen to differ. The ONLY difference between the two
  // server results is the isError flag.
  const SAME_SENTENCE = 'Six appliances.';
  const succeeded = readToolResult({ content: [{ type: 'text', text: SAME_SENTENCE }], structuredContent: { appliances: [] } });
  const failed = readToolResult({ isError: true, content: [{ type: 'text', text: SAME_SENTENCE }], structuredContent: { appliances: [] } });

  it('classifies two results with identical spoken text by the flag alone', () => {
    expect(succeeded.ok).toBe(true);
    expect(failed.ok).toBe(false);
  });

  it('produces blocks a reader can separate without reading the prose', () => {
    const good = toToolResultBlock('c1', succeeded);
    const bad = toToolResultBlock('c1', failed);
    // `is_error` is the discriminator, and it is present on exactly one side.
    expect(bad.is_error).toBe(true);
    expect(good.is_error).toBeUndefined();
    expect(good.is_error).not.toBe(bad.is_error);
  });

  it('never lets a failure block read as an answer, and never puts the notice on a success', () => {
    const textOf = (outcome: Parameters<typeof toToolResultBlock>[1]) => (toToolResultBlock('c1', outcome).content as Array<{ text: string }>)[0]?.text ?? '';
    const failureText = textOf(failed);
    const successText = textOf(succeeded);
    // Asserted against a non-empty string on both sides: the success text is
    // the spoken sentence plus its JSON, so "does not contain the notice" is a
    // claim about real content rather than about an empty value.
    expect(successText.length).toBeGreaterThan(0);
    expect(successText).not.toContain('NO DATA WAS RETRIEVED');
    expect(failureText).toContain('NO DATA WAS RETRIEVED');
    // And the structured payload the model would otherwise answer from is
    // gone: a failure block carries the error and the notice, nothing else.
    expect(successText).toContain('{"appliances":[]}');
    expect(failureText).not.toContain('{"appliances":[]}');
  });

  it('carries the notice on every failure the reader can produce, not only on the flagged one', () => {
    // Every message readToolResult can emit, from every malformed shape the
    // totality test walks, reaches the model with the notice attached. A
    // failure path that forgot it is the FL-039 hole reopened one branch at a
    // time.
    const failures = [undefined, null, 'a string', 42, [], {}, { content: 'not an array' }, { content: [] }, { isError: true, content: [] }].map(
      readToolResult
    );
    expect(failures.every(outcome => !outcome.ok)).toBe(true);
    for (const outcome of failures) {
      const block = toToolResultBlock('c1', outcome);
      expect(block.is_error, JSON.stringify(outcome)).toBe(true);
      expect((block.content as Array<{ text: string }>)[0]?.text ?? '', JSON.stringify(outcome)).toContain(NO_DATA_NOTICE);
    }
  });

  it('says, in the notice itself, every thing a model must not substitute for the missing data', () => {
    // Written out rather than asserted as one blob, so an edit that drops any
    // single clause fails here and names which. These four are the moves that
    // actually happened (FL-039): inferring a cause, answering from the
    // repository's seed data, and presenting either as live household data.
    expect(NO_DATA_NOTICE).toContain('NO DATA WAS RETRIEVED');
    expect(NO_DATA_NOTICE).toContain('did not execute');
    expect(NO_DATA_NOTICE).toContain('no result — empty or otherwise — is implied');
    expect(NO_DATA_NOTICE).toContain('from memory');
    expect(NO_DATA_NOTICE).toContain('repository fixtures or seed data');
    expect(NO_DATA_NOTICE).toContain('Tell the person the call failed');
  });
});

describe('elicitationShape', () => {
  it('reads a single-select enum with its display names', () => {
    expect(
      elicitationShape({
        type: 'object',
        properties: { provider: { type: 'string', title: 'Provider', enum: ['prov_a', 'prov_b'], enumNames: ['Alpha Plumbing', 'Beta Drain'] } },
        required: ['provider']
      })
    ).toEqual({
      field: 'provider',
      kind: 'choice',
      options: [
        { value: 'prov_a', label: 'Alpha Plumbing' },
        { value: 'prov_b', label: 'Beta Drain' }
      ]
    });
  });

  it('falls back to the value as its own label when enumNames is absent', () => {
    expect(elicitationShape({ type: 'object', properties: { window: { type: 'string', enum: ['win_1', 'win_2'] } }, required: ['window'] })?.options).toEqual([
      { value: 'win_1', label: 'win_1' },
      { value: 'win_2', label: 'win_2' }
    ]);
  });

  it('falls back per option when enumNames is shorter than enum, rather than dropping the tail', () => {
    // A separate case from "absent", and the one an off-by-one on the server
    // produces. The previous version of this test named both and exercised
    // only the first, so a reader that returned `options.length === names.length`
    // would have passed it.
    expect(
      elicitationShape({
        type: 'object',
        properties: { window: { type: 'string', enum: ['win_1', 'win_2', 'win_3'], enumNames: ['Tuesday morning'] } },
        required: ['window']
      })?.options
    ).toEqual([
      { value: 'win_1', label: 'Tuesday morning' },
      { value: 'win_2', label: 'win_2' },
      { value: 'win_3', label: 'win_3' }
    ]);
  });

  it('reads a boolean field as a confirmation with no options', () => {
    expect(elicitationShape({ type: 'object', properties: { confirm: { type: 'boolean', title: 'Confirm' } }, required: ['confirm'] })).toEqual({
      field: 'confirm',
      kind: 'confirm',
      options: []
    });
  });

  it('is undefined for a schema this UI cannot render, rather than guessing', () => {
    for (const bad of [undefined, null, {}, { properties: {} }, { properties: { free: { type: 'string' } } }, { properties: { n: { type: 'number' } } }]) {
      expect(elicitationShape(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
