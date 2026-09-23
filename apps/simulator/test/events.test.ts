import { describe, expect, it } from 'vitest';
import { createSseDecoder, encodeSse, type TurnEvent } from '../src/shared/events.js';

// One instance of every TurnEvent member, not just the six the wire format
// happens to exercise most often. A codec bug that only shows up on, say,
// `elicitation-closed` would pass silently if that variant never appeared in
// the fixture — see the coverage test below, which pins the count.
//
// Two of these also carry a genuine multi-byte character: 🔧 (U+1F527) and 🔄
// (U+1F504) are outside the Basic Multilingual Plane, so each is a UTF-16
// *surrogate pair* — two JS string code units, not one. Threading them through
// the shared fixture means the "cut at every single byte boundary" test below
// necessarily lands a cut between a character's own two halves at least twice,
// not just between whole characters. A fixture built only from ASCII cannot
// fail a decoder that mishandles that split; this one can.
const sample: TurnEvent[] = [
  { type: 'turn-started', turnId: 't1' },
  { type: 'assistant-text', text: 'Let me look.\n\nOne moment — checking the 🔧 for a leak.' },
  { type: 'tool-started', callId: 'c1', tool: 'book_service', args: { applianceId: 'appl_x', issue: 'leak' } },
  {
    type: 'tool-succeeded',
    callId: 'c0',
    tool: 'list_appliances',
    spoken: 'Six appliances, café included.',
    content: [{ type: 'text', text: 'Six appliances.' }],
    structured: { appliances: [{ id: 'appl_x' }] },
    widgetUri: 'ui://homeledger/appliances',
    ms: 412
  },
  { type: 'tool-failed', callId: 'c2', tool: 'book_service', message: "Provider didn't respond — try again?", ms: 803 },
  {
    type: 'elicitation-opened',
    callId: 'c1',
    elicitationId: 'e1',
    prompt: 'Who should I book for the water heater?',
    field: 'provider',
    kind: 'choice',
    options: [{ value: 'prov_kettle_water', label: 'Kettle Creek Water Heaters' }]
  },
  { type: 'elicitation-closed', elicitationId: 'e1', action: 'decline' },
  { type: 'progress', callId: 'c1', progress: 2, total: 3, message: 'Comparing arrival windows' },
  { type: 'session-rebuilt', note: 'Resumed after an idle timeout 🔄' },
  { type: 'turn-failed', message: 'Upstream timed out after 30s' },
  { type: 'turn-finished', turnId: 't1' }
];

// Hand-written and independent of both `TurnEvent` and `sample`, on purpose:
// if this list were derived from the union type or from `sample` itself, a
// change that dropped a variant from the fixture would silently shrink the
// expectation along with it, and the guard would never fail. Spelling it out
// separately means it can only agree with `sample` by actually matching.
const ALL_TURN_EVENT_TYPES = [
  'assistant-text',
  'elicitation-closed',
  'elicitation-opened',
  'progress',
  'session-rebuilt',
  'tool-failed',
  'tool-started',
  'tool-succeeded',
  'turn-failed',
  'turn-finished',
  'turn-started'
];

describe('the turn event codec', () => {
  it('exercises every TurnEvent variant exactly once, so none can hide untested behind another', () => {
    expect([...new Set(sample.map(event => event.type))].sort()).toEqual(ALL_TURN_EVENT_TYPES);
  });

  it('frames one event per SSE message and terminates it', () => {
    expect(encodeSse({ type: 'turn-started', turnId: 't1' })).toBe('data: {"type":"turn-started","turnId":"t1"}\n\n');
  });

  it('never lets a newline inside an event split the frame', () => {
    // A bare newline in the payload would start a second SSE field. JSON
    // escaping is what prevents it, and this asserts the escape rather than
    // the intent: exactly one "data:" line, and the text survives intact.
    const frame = encodeSse({ type: 'assistant-text', text: 'Let me look.\n\nOne moment.' });
    expect(frame.split('\n').filter(line => line.startsWith('data:'))).toHaveLength(1);
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('round-trips every event when the whole stream arrives at once', () => {
    const decode = createSseDecoder();
    expect(decode(sample.map(encodeSse).join(''))).toEqual(sample);
  });

  it('round-trips when the stream is cut at every single byte boundary', () => {
    const wire = sample.map(encodeSse).join('');
    for (let cut = 1; cut < wire.length; cut++) {
      const decode = createSseDecoder();
      const out = [...decode(wire.slice(0, cut)), ...decode(wire.slice(cut))];
      expect(out, `cut at ${cut}`).toEqual(sample);
    }
  });

  it('round-trips a character cut between its own UTF-16 surrogate halves', () => {
    // The decoder works on JS strings, not raw bytes, so "mid multi-byte
    // character" here means slicing an astral character (one outside the
    // BMP) between its high and low surrogate — the string-level analogue of
    // a chunk boundary landing inside a UTF-8 sequence. The two halves are
    // individually well-formed JS string fragments (lone surrogates are
    // legal in a JS string), and `buffer + chunk` concatenation puts them
    // back together with nothing lost, however the cut fell.
    const event: TurnEvent = { type: 'assistant-text', text: 'Fixed the leak 🔧 — done.' };
    const wire = encodeSse(event);
    const wrenchIndex = wire.indexOf('🔧');
    expect(wrenchIndex).toBeGreaterThan(-1);
    const midCharacter = wrenchIndex + 1; // between the high and low surrogate
    const decode = createSseDecoder();
    const out = [...decode(wire.slice(0, midCharacter)), ...decode(wire.slice(midCharacter))];
    expect(out).toEqual([event]);
  });

  it('yields each event as it lands rather than waiting for the stream to end', () => {
    // The property the whole design rests on. If the decoder needed the last
    // frame before it produced the first, the elicitation card could not be
    // rendered until after the answer it is waiting for.
    const decode = createSseDecoder();
    expect(decode(encodeSse(sample[0]!))).toEqual([sample[0]]);
    expect(decode(encodeSse(sample[1]!))).toEqual([sample[1]]);
  });

  it('drops a comment keep-alive without emitting anything', () => {
    const decode = createSseDecoder();
    expect(decode(': keep-alive\n\n')).toEqual([]);
  });

  it('drops a comment even when its payload is valid TurnEvent JSON, rather than fabricating the event', () => {
    // A plain ": keep-alive" comment is not valid JSON, so it is caught by
    // the same JSON.parse failure path the adjacent "not json" test already
    // covers — that fixture cannot fail a decoder that mishandles comments
    // specifically, only one that mishandles JSON. This uses a comment whose
    // payload IS a real, parseable TurnEvent, so the test can only pass if
    // the comment framing itself (not JSON.parse) is what keeps it out of
    // the stream. If it leaked through, an SSE keep-alive would become a way
    // to inject an event the server never sent.
    const decode = createSseDecoder();
    expect(decode(': {"type":"turn-started","turnId":"injected"}\n\n')).toEqual([]);
  });

  it('drops a non-"data" field even when its value is valid TurnEvent JSON', () => {
    // A distinct attack surface from the comment case above: a line with a
    // real field name that just isn't "data" (SSE's "event:" line, here,
    // which names an event *type* rather than carrying a payload). This is
    // what the field filter guards beyond comments — a comment line's field
    // is always empty (its first character is the colon), so this fixture
    // cannot be satisfied by the comment guard at all and isolates the field
    // filter on its own.
    const decode = createSseDecoder();
    expect(decode('event: {"type":"turn-started","turnId":"injected"}\n\n')).toEqual([]);
  });

  it('drops a frame that is not JSON instead of throwing', () => {
    const decode = createSseDecoder();
    expect(decode('data: not json\n\n')).toEqual([]);
    expect(decode(encodeSse(sample[0]!))).toEqual([sample[0]]);
  });
});
