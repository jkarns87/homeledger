import { handleWidget } from '@/server/http';
import { getConversation } from '@/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    return await handleWidget(await getConversation(), request);
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, reason: 'unavailable', message: error instanceof Error ? error.message : String(error) }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
}
