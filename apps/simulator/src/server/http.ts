import { randomUUID } from 'node:crypto';
import { todayInZone } from '@homeledger/core';
import { runTurn } from './agent.js';
import type { ElicitationAnswer } from './elicitation.js';
import { encodeSse, type TurnEvent } from '../shared/events.js';
import type { Conversation } from './session.js';

export const UNKNOWN_TURN_MESSAGE =
  'That answer was not delivered: this server is not running the turn it names. Nothing was booked and nothing was changed. The turn may have ended, or this request may have reached a different instance than the one holding the conversation. Ask again to start a fresh turn.';

const UNKNOWN_QUESTION_MESSAGE =
  'That answer was not delivered: the question it names has already been answered or has timed out. Nothing was changed by this click.';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/**
 * Same-origin check, off unless an origin is configured.
 *
 * The MCP spec asks servers to validate `Origin` for exactly this reason: a
 * browser will happily POST cross-site, and these routes spend an API key and
 * write to a household. Off by default because the demo runs on localhost and
 * a check nobody configured that blocks the owner's own browser is worse than
 * no check; on the moment `HOMELEDGER_SIMULATOR_ALLOW_ORIGIN` is set, which is
 * the first thing a hosted deployment must do.
 */
export function checkOrigin(request: Request, allowOrigin: string | undefined): Response | undefined {
  if (!allowOrigin) return undefined;
  const origin = request.headers.get('origin');
  // A request with no Origin is not a cross-site browser request: `fetch` from
  // a page always sets one. curl and the tests do not, and refusing those
  // would block the diagnosis of everything else.
  if (origin === null || origin === allowOrigin) return undefined;
  return json({ ok: false, reason: 'forbidden-origin', message: `This server accepts requests from ${allowOrigin} only; this one came from ${origin}.` }, 403);
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs one turn and streams it.
 *
 * `runTurn` is started inside `start()` and deliberately **not awaited**: the
 * Response is returned the moment the stream exists, so the browser is reading
 * events while the turn is still producing them. That is the property that
 * lets an elicitation answer be POSTed on a second request while this one is
 * open, and it is the property whose absence deadlocks rather than errors
 * (FL-033). Anything that collects the events and returns them at the end —
 * the tidy-looking version — hangs on the first question.
 */
export async function handleTurn(conversation: Conversation, request: Request): Promise<Response> {
  const forbidden = checkOrigin(request, conversation.env.allowOrigin);
  if (forbidden) return forbidden;
  const body = await readJson(request);
  const text = body?.text;
  if (typeof text !== 'string' || text.trim() === '')
    return json({ ok: false, reason: 'bad-request', message: 'The body needs a non-empty "text" field.' }, 400);

  const turnId = randomUUID();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const emit = (event: TurnEvent): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(encodeSse(event)));
        } catch {
          // The browser went away mid-turn. Stop writing; the turn itself is
          // cancelled by `cancel()` below.
          open = false;
        }
      };
      void runTurn(
        {
          model: conversation.model,
          mcp: conversation.mcp,
          registry: conversation.registry,
          router: conversation.router,
          tools: conversation.tools,
          emit,
          now: conversation.now,
          // The household's calendar date, not the UTC one. The model is told
          // `Today is ${today}` and then says it out loud, so this is a date a
          // person hears — and `new Date().toISOString().slice(0,10)`, which
          // this used to be, is the construct spec §4.2 names as wrong and the
          // one that flipped maintenance items to overdue at 7 PM US Central.
          // `todayInZone` is core's, already fixed once and tested there.
          today: todayInZone(new Date(conversation.now()).toISOString(), conversation.timeZone),
          maxRounds: conversation.env.maxRounds,
          elicitationTimeoutMs: conversation.env.elicitationTimeoutMs
        },
        turnId,
        conversation.history,
        text
      )
        .then(next => {
          conversation.history = next;
        })
        .catch((error: unknown) => {
          emit({ type: 'turn-failed', message: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          open = false;
          try {
            controller.close();
          } catch {
            /* already closed by a cancel */
          }
        });
    },
    cancel() {
      conversation.registry.close(turnId, 'the browser closed the turn before answering');
    }
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      // `no-transform` as well as `no-cache`: a compressing proxy that buffers
      // to compress would reintroduce the deadlock from the outside.
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-homeledger-turn-id': turnId
    }
  });
}

function readAnswer(body: Record<string, unknown> | undefined): ElicitationAnswer | undefined {
  const action = body?.action;
  if (action === 'decline') return { action: 'decline' };
  if (action === 'cancel') return { action: 'cancel' };
  if (action !== 'accept') return undefined;
  const content = body?.content;
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return undefined;
  return { action: 'accept', content: content as Record<string, unknown> };
}

/** Delivers one elicitation answer. 202 mirrors what the MCP wire itself answers to an elicitation response. */
export async function handleAnswer(conversation: Conversation, request: Request): Promise<Response> {
  const forbidden = checkOrigin(request, conversation.env.allowOrigin);
  if (forbidden) return forbidden;
  const body = await readJson(request);
  const turnId = body?.turnId;
  const elicitationId = body?.elicitationId;
  if (typeof turnId !== 'string' || typeof elicitationId !== 'string')
    return json({ ok: false, reason: 'bad-request', message: 'The body needs "turnId" and "elicitationId" strings.' }, 400);
  const answer = readAnswer(body);
  if (!answer)
    return json(
      { ok: false, reason: 'bad-request', message: 'The body needs "action" of accept, decline or cancel, and an object "content" when accepting.' },
      400
    );

  const outcome = conversation.registry.answer(turnId, elicitationId, answer);
  if (outcome === 'delivered') return json({ ok: true }, 202);
  if (outcome === 'unknown-turn') return json({ ok: false, reason: 'unknown-turn', message: UNKNOWN_TURN_MESSAGE }, 409);
  return json({ ok: false, reason: 'unknown-question', message: UNKNOWN_QUESTION_MESSAGE }, 409);
}

/**
 * What the drawer shows. Built by hand rather than by serialising the
 * conversation, because the conversation holds a token source and an API key
 * and a spread would put both on the wire the first time somebody adds a field.
 *
 * Four things, and spec section 7 names all four: the JSON-RPC log, the
 * negotiated protocol version, the session id, and the timing per call (that
 * last one is on the client, from the transcript's own entries). The address
 * is read from `mcp.endpointUrl` and not from `conversation.endpoint`, because
 * the client heals the address on a rebuild and a drawer that showed the
 * startup URL would be confidently wrong about the one thing somebody opens it
 * to check.
 */
export function handleDebug(conversation: Conversation): Response {
  const url = new URL(conversation.mcp.endpointUrl);
  return new Response(
    JSON.stringify({
      endpointHost: url.host,
      endpointPath: url.pathname,
      addressing: conversation.endpoint.origin,
      protocolVersion: conversation.mcp.protocolVersion ?? null,
      sessionId: conversation.mcp.sessionId ?? null,
      rebuilds: conversation.mcp.rebuilds,
      tools: conversation.tools.map(tool => tool.name),
      // Methods and timings. `HomeLedgerMcp.record` keeps payloads out at the
      // source; this endpoint spreads the entries it is given and adds
      // nothing, so there is one place to read to know what can appear here.
      log: conversation.mcp.jsonRpcLog.map(entry => ({ ...entry }))
    }),
    { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }
  );
}
