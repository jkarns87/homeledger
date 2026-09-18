import { inputResponse, type ClientCapabilities, type ElicitRequestFormParams, type InputResponses, type McpServer } from '@modelcontextprotocol/server';

export type ElicitOutcome = 'missing' | 'accepted' | 'declined';

/**
 * Whether this client declared the capability a FORM-mode elicitation needs.
 *
 * Mirrors the SDK's own gate rather than inventing a second rule. That gate is
 * `missingClientCapabilities(required, declared)` against
 * `{ elicitation: { form: {} } }`, which BOTH eras run before any elicitation
 * leaves the server — the modern path before returning an `input_required`
 * result, the legacy shim before dispatching a leg — so a rule that disagreed
 * with it would either refuse clients the SDK would have served or promise
 * questions the SDK will then decline to ask.
 *
 * The condition below is `isImpliedCapabilityMember`'s, spelled out: form
 * counts as declared when `form` is present, OR when NO mode is named at all.
 * The second half is the pre-mode (2025) reading of a bare `elicitation: {}` —
 * mode sub-capabilities did not exist when that shape was defined — and it also
 * covers a declaration carrying only members that are not modes. Naming any
 * mode explicitly removes the implication, so a client that declares only
 * `elicitation: { url: {} }` is NOT form-capable and is refused here exactly as
 * the SDK would refuse it.
 *
 * Both halves are reachable, which is why both are here. Verified against the
 * real SDK rather than reasoned about: on a 2025-era `initialize` a bare `{}`
 * never survives to be seen — `ElicitationCapabilitySchema` carries a zod
 * `preprocess` that rewrites it to `{ form: {} }` at the decode seam — but on a
 * 2026-07-28 request the per-request `_meta` envelope is NOT preprocessed and
 * the bare `{}` arrives intact. A first version of this function had the same
 * leniency written as an emptiness test and a legacy-only test for it, and the
 * mutation that deleted the branch SURVIVED, because the legacy path had
 * already normalised the shape away. `book-service-no-elicitation.test.ts`
 * covers both eras for exactly that reason.
 *
 * Read through `server.server.getClientCapabilities()` and not from the handler
 * context because that one accessor answers on both paths: on a 2025-era
 * connection it holds what `initialize` declared, and on a 2026-07-28 request
 * `createMcpHandler` backfills it per request from the validated envelope
 * before dispatch (the SDK documents the backfill on the accessor itself, and a
 * throwaway probe against the real handler confirmed the accessor and the
 * envelope agree on every shape above). The envelope is the non-deprecated
 * route, but `RequestMetaEnvelope` is typed as `{}` in this build, so reading it
 * would need an unchecked cast for no behavioural gain.
 *
 * Deliberately not "is the client Claude Code" or "is this the legacy era":
 * `tengu_mcp_elicitation` is a remote feature flag that defaults to false and
 * flips without a client release (FL-033), so the only trustworthy signal is
 * what this particular connection actually declared.
 */
export function supportsFormElicitation(server: McpServer): boolean {
  const declared: ClientCapabilities['elicitation'] = server.server.getClientCapabilities()?.elicitation;
  if (declared === undefined) return false;
  return declared.form !== undefined || declared.url === undefined;
}

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
