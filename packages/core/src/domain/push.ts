import * as z from 'zod/v4';

/**
 * What the push Lambda sends a display and what the simulator's server reads:
 * a pointer, never the record. The display runs an agent turn that reads the
 * record over MCP, so everything a person sees came back from the MCP server
 * (spec §7, FL-039). Shared here rather than typed twice for the reason
 * `NOT_BOOKED` is (FL-046).
 */
export const PUSH_CARD_TYPES = ['visit.arrived', 'alert.raised'] as const;

const PREFIX_FOR: Record<(typeof PUSH_CARD_TYPES)[number], string> = { 'visit.arrived': 'visit_', 'alert.raised': 'alert_' };

export const PushPayloadSchema = z
  .object({ cardType: z.enum(PUSH_CARD_TYPES), id: z.string().regex(/^(visit|alert)_[a-z2-7]{16}$/) })
  .strict()
  .refine(p => p.id.startsWith(PREFIX_FOR[p.cardType]), { error: 'cardType does not match the record id' });

export type PushPayload = z.infer<typeof PushPayloadSchema>;

export function parsePushPayload(raw: string): PushPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = PushPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function pushPayload(cardType: PushPayload['cardType'], id: string): PushPayload {
  const parsed = PushPayloadSchema.safeParse({ cardType, id });
  if (!parsed.success) throw new Error(`Not a valid push: ${cardType} ${id}`);
  return parsed.data;
}
