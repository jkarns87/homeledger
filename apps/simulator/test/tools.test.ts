import { describe, expect, it } from 'vitest';
import { NOT_BOOKED, NotBooked } from '@homeledger/core';
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
    // `typeof null === 'object'`, so without the explicit null checks both of
    // these dereference null and throw. `_meta` is optional on an MCP tool
    // descriptor and a server that sends it as null is not exotic.
    expect(widgetUriOf({ name: 'x', inputSchema: {}, _meta: null })).toBeNull();
    expect(widgetUriOf({ name: 'x', inputSchema: {}, _meta: { ui: null } })).toBeNull();
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
    // A person pressing "Not now" is a working call with a negative answer, and
    // the whole downstream chain - tool-failed, is_error, NO_DATA_NOTICE,
    // explainFailure - keys off this one classification.
    //
    // The fixture's payload is NOT_BOOKED imported from @homeledger/core, which
    // is the SAME value apps/mcp-server/src/tools/service.ts emits - not a copy
    // of it typed out here to match. That was FL-046: a consumer fixture
    // hand-written to agree with a producer looks like a pin and is not one,
    // because changing the producer leaves the copy sitting there agreeing with
    // nothing. Deriving from the server itself is not available (both schemas
    // are module-private and @homeledger/mcp-server declares no exports), so
    // the shared constant is the seam.
    const content = [{ type: 'text', text: "Okay, I haven't booked anything." }];
    expect(readToolResult({ content, structuredContent: NOT_BOOKED })).toEqual({
      ok: true,
      spoken: "Okay, I haven't booked anything.",
      content,
      structured: NOT_BOOKED
    });
  });

  it('is pinned to the decline shape the server actually emits', () => {
    // The independent anchor, written out by hand HERE so the pin has something
    // to fail against: change `booked` in @homeledger/core and this line fails
    // in apps/simulator while the four decline assertions fail in
    // apps/mcp-server. Both packages break, which is the whole point of moving
    // the constant. Without this literal the test above would happily agree
    // with any shape core happened to hold.
    expect(NOT_BOOKED).toEqual({ booked: false });
    // And the value is one the server's own advertised branch accepts, so the
    // two halves of the contract cannot drift apart either.
    expect(NotBooked.safeParse(NOT_BOOKED).success).toBe(true);
    // A completed booking must NOT validate as a decline - the union in
    // book_service's outputSchema depends on that, and it is asserted from the
    // consumer side too because the consumer is what renders the difference.
    expect(NotBooked.safeParse({ visitId: 'visit_aaaaaaaaaaaaaaaa', provider: 'Kettle Creek', status: 'scheduled' }).success).toBe(false);
  });

  it('skips content blocks that carry no usable text rather than throwing on them or speaking an empty string', () => {
    // A relay can put junk in the array, and a tool can emit an empty text
    // block ahead of the real one. Both have to be stepped over: without the
    // object guard the null throws a TypeError, and without the length check
    // `spoken` becomes '' and a working call speaks nothing at all.
    const content = [null, 'not a block', { type: 'text', text: '' }, { type: 'image' }, { type: 'text', text: 'Six appliances.' }];
    expect(readToolResult({ content, structuredContent: { appliances: [] } })).toEqual({
      ok: true,
      spoken: 'Six appliances.',
      content,
      structured: { appliances: [] }
    });
  });

  it('reports structured content as null when a tool returned none, rather than as undefined', () => {
    // All nine HomeLedger tools declare an outputSchema, so this shape does not
    // arrive from THIS server - but the reader is generic over whatever it is
    // pointed at, and `null` is the value toToolResultBlock branches on below.
    const content = [{ type: 'text', text: 'Done.' }];
    expect(readToolResult({ content })).toEqual({ ok: true, spoken: 'Done.', content, structured: null });
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

  it('sends the spoken text alone when the tool returned no structured content', () => {
    const block = toToolResultBlock('c1', { ok: true, spoken: 'Done.', content: [{ type: 'text', text: 'Done.' }], structured: null });
    expect(block.content).toEqual([{ type: 'text', text: 'Done.' }]);
    // The mutation this stands against appends the JSON unconditionally, which
    // hands the model the four characters `null` as the tool's payload.
    expect((block.content as Array<{ text: string }>)[0]?.text).not.toContain('null');
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
  });

  /**
   * Its own test on purpose.
   *
   * A third line used to sit in the test above - `expect(good.is_error).not.toBe(bad.is_error)`
   * - and it could never be the assertion that failed: the two lines before it
   * pin both values concretely, so either one of those fails first and this one
   * never runs, or both hold and `undefined !== true` is already settled. An
   * assertion that can only run once its own conclusion is guaranteed proves
   * nothing. Separated out, this makes a DIFFERENT claim that can fail on its
   * own: take the prose away from both blocks entirely and what is left is
   * still different, so a reader that never looks at the text can still tell a
   * failure from an answer.
   */
  it('separates the two blocks with the prose stripped off entirely', () => {
    const withoutProse = (block: ReturnType<typeof toToolResultBlock>) => ({ ...block, content: undefined });
    expect(withoutProse(toToolResultBlock('c1', succeeded))).not.toEqual(withoutProse(toToolResultBlock('c1', failed)));
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
    // One clause at a time rather than one blob, so an edit that drops any
    // single clause fails here and names which.
    //
    // FL-039 produced TWO moves and they are different failures. Incident 2
    // answered from the repository's seed fixtures and presented them as live
    // household data - claim 3 forbids that. Incident 1 invented a CAUSE, "no
    // appliances have been registered yet": it claimed no data and read no
    // fixture, so every word of claim 3 was satisfied and the fabrication went
    // to the owner anyway. Only claim 4 stops that one, and this test asserted
    // its own comment's word "inferring a cause" without asserting any clause
    // that delivered it until the notice grew one.
    expect(NO_DATA_NOTICE).toContain('NO DATA WAS RETRIEVED');
    expect(NO_DATA_NOTICE).toContain('did not execute');
    expect(NO_DATA_NOTICE).toContain('no result — empty or otherwise — is implied');
    expect(NO_DATA_NOTICE).toContain('from memory');
    expect(NO_DATA_NOTICE).toContain('repository fixtures or seed data');
    // The bridge's catch-all, kept ALONGSIDE the enumeration rather than
    // replaced by it. An enumeration that stands in for a catch-all is weaker
    // than the catch-all, because anything not enumerated reads as permitted.
    expect(NO_DATA_NOTICE).toContain('or from any other source');
    // Claim 4 - the clause incident 1 needed and no earlier version of this
    // notice had. Both halves asserted: the prohibition, and the named example
    // that keeps it from being edited down into a generic apology.
    expect(NO_DATA_NOTICE).toContain('Do not explain why the call failed');
    expect(NO_DATA_NOTICE).toContain('do not offer a likely cause');
    expect(NO_DATA_NOTICE).toContain('nothing has been registered yet');
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

  it('refuses an enum carrying a non-string member rather than offering it as a choice', () => {
    // Without the per-member type check the card renders 42 as a selectable
    // value and the person answers something the server will reject.
    expect(elicitationShape({ type: 'object', properties: { window: { type: 'string', enum: ['win_1', 42] } }, required: ['window'] })).toBeUndefined();
  });

  it('falls back to the value when a display name is present but empty', () => {
    // Distinct from both "absent" and "shorter": the name IS there at that
    // index and is unusable. Without the length check the option renders with a
    // blank label, which on a kitchen display is an unclickable-looking choice.
    expect(
      elicitationShape({
        type: 'object',
        properties: { window: { type: 'string', enum: ['win_1', 'win_2'], enumNames: ['', 'Wednesday'] } },
        required: ['window']
      })?.options
    ).toEqual([
      { value: 'win_1', label: 'win_1' },
      { value: 'win_2', label: 'Wednesday' }
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
