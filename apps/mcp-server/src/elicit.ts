import { inputResponse, type ElicitRequestFormParams, type InputResponses } from '@modelcontextprotocol/server';

export type ElicitOutcome = 'missing' | 'accepted' | 'declined';

/**
 * Typed narrowing over one entry of ctx.mcpReq.inputResponses.
 *
 * The SDK's inputResponse() returns a discriminated view
 * ({ kind: 'missing' } | { kind: 'elicit', action, content? } | { kind: 'sampling' } | { kind: 'roots' }),
 * so no handler needs the unchecked `as { action?: string }` cast the Plan 1
 * echo_confirm spike used. A response of the wrong kind counts as declined:
 * re-issuing it would loop until the client's maxRounds runs out.
 */
export function elicitOutcome(responses: InputResponses | Record<string, unknown> | undefined, key: string): ElicitOutcome {
  const view = inputResponse(responses, key);
  if (view.kind === 'missing') return 'missing';
  if (view.kind === 'elicit') return view.action === 'accept' ? 'accepted' : 'declined';
  return 'declined';
}

type RequestedSchema = ElicitRequestFormParams['requestedSchema'];

/**
 * Single-select enumeration carrying display names.
 *
 * The `enum` + `enumNames` shape (LegacyTitledEnumSchema in the SDK's schema
 * union) is used deliberately over the newer `oneOf: [{ const, title }]`
 * shape: both @modelcontextprotocol/server 2.0.0 and @modelcontextprotocol/sdk
 * 1.30.0 validate it, so the same request body is understood by the modern
 * client and by a 2025-era client coming through the legacy shim.
 */
export function enumField(field: string, title: string, values: string[], names: string[]): RequestedSchema {
  return {
    type: 'object',
    properties: {
      [field]: { type: 'string', title, enum: values, enumNames: names }
    },
    required: [field]
  };
}

export function booleanField(field: string, title: string): RequestedSchema {
  return {
    type: 'object',
    properties: {
      [field]: { type: 'boolean', title }
    },
    required: [field]
  };
}
