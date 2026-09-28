import { describe, expect, it } from 'vitest';
import { PUSH_CARD_TYPES, parsePushPayload, pushPayload } from '../src/index.js';

describe('the push payload contract', () => {
  it('names exactly the two card types the spec names', () => {
    expect([...PUSH_CARD_TYPES]).toEqual(['visit.arrived', 'alert.raised']);
  });

  it('parses a pointer to a visit and a pointer to an alert', () => {
    expect(parsePushPayload('{"cardType":"visit.arrived","id":"visit_abcdefghijklmnop"}')).toEqual({ cardType: 'visit.arrived', id: 'visit_abcdefghijklmnop' });
    expect(parsePushPayload('{"cardType":"alert.raised","id":"alert_abcdefghijklmnop"}')).toEqual({ cardType: 'alert.raised', id: 'alert_abcdefghijklmnop' });
  });

  it('refuses a card type that does not match the record it points at', () => {
    expect(parsePushPayload('{"cardType":"visit.arrived","id":"alert_abcdefghijklmnop"}')).toBeNull();
    expect(() => pushPayload('alert.raised', 'visit_abcdefghijklmnop')).toThrow(/alert\.raised.*visit_abcdefghijklmnop/);
  });

  it('refuses anything carrying more than a pointer', () => {
    // The spec's push is "a pointer only": the agent reads the record over MCP.
    // A payload that carries the description would let the display show text
    // the MCP server never returned.
    expect(parsePushPayload('{"cardType":"visit.arrived","id":"visit_abcdefghijklmnop","description":"A plumber"}')).toBeNull();
  });

  it('refuses text that is not JSON, and JSON that is not an object', () => {
    expect(parsePushPayload('visit.arrived visit_abcdefghijklmnop')).toBeNull();
    expect(parsePushPayload('null')).toBeNull();
    expect(parsePushPayload('"visit.arrived"')).toBeNull();
  });
});
