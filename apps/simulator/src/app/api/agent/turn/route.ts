import { handleTurn } from '@/server/http';
import { getConversation } from '@/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** No cap: a turn is bounded by the model's round budget and the elicitation timeout, not by a wall clock. */
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleTurn(await getConversation(), request);
  } catch (error) {
    // Reached only when the conversation itself cannot be built — a missing
    // API key, an expired SSO session, a runtime that is not deployed. Those
    // messages are written to be read (`apps/mcp-bridge/src/secret.ts`,
    // `src/runtime.ts`), so they are passed through rather than flattened.
    return new Response(JSON.stringify({ ok: false, reason: 'unavailable', message: error instanceof Error ? error.message : String(error) }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
}
