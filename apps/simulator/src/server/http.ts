import { randomUUID } from 'node:crypto';
import { todayInZone } from '@homeledger/core';
import { runTurn } from './agent.js';
import type { ElicitationAnswer } from './elicitation.js';
import { encodeSse, type TurnEvent } from '../shared/events.js';
import type { Conversation } from './session.js';

export const UNKNOWN_TURN_MESSAGE =
  'That answer was not delivered: this server is not running the turn it names. Nothing was booked and nothing was changed. The turn may have ended, or this request may have reached a different instance than the one holding the conversation. Ask again to start a fresh turn.';

export const TURN_RUNNING_MESSAGE =
  'Another turn is still running in this conversation, so this one was not started. Wait for it to finish, or reload the page to start over.';

/** What a turn's abort carries when the browser closed its stream. Surfaces only in logs: the stream it would be written to is gone. */
const BROWSER_CLOSED_REASON = 'the browser closed the turn before it finished';
const RESET_REASON = 'the conversation was reset';

export const UNKNOWN_QUESTION_MESSAGE =
  'That answer was not delivered: the question it names has already been answered or has timed out. Nothing was changed by this click.';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/**
 * Loopback hostnames this server treats as "the demo's own machine" when no
 * explicit allowlist is configured.
 *
 * Fix round 3: `new URL('http://' + host).hostname` does NOT strip brackets
 * from an IPv6 literal — `new URL('http://[::1]:3000').hostname` is the
 * string `"[::1]"`, brackets included. A round-2 version of this comment and
 * this set claimed otherwise (`'::1'`, unbracketed) and every `Host:
 * [::1]:<port>` request was refused as a result, confirmed by a second
 * review's mutation. Both forms are kept here rather than only the correct
 * one: `[::1]` is what `.hostname` actually returns for every path through
 * this file (`loopbackHostnameOf` below and the `request.url` fallback
 * alike), and the bare `::1` costs nothing to also accept in case a future
 * caller normalises it before this set ever sees it.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The hostname a `Host` header names, with its port stripped and its IPv6 brackets — if it had any — left exactly as `.hostname` returns them. `undefined` if the header cannot be parsed as one. */
function loopbackHostnameOf(hostHeader: string): string | undefined {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Same-origin check. Off only for a request whose `Host` names this machine's
 * own loopback address and carries no `Origin` header at all.
 *
 * Fix round 1, Critical (plan-mandated): the original version returned
 * "allowed" the instant `allowOrigin` was unset — which is the default, since
 * `HOMELEDGER_SIMULATOR_ALLOW_ORIGIN` is not set for a localhost demo — so an
 * unconfigured deployment compared the incoming `Origin` against nothing and
 * let every cross-site request through. A reviewer's probe confirmed this
 * reaches `handleWidgetTool` and runs `log_maintenance`.
 *
 * Fix round 1's own repair compared `Origin` against `new URL(request.url).origin`,
 * and a second review caught that this is wrong for a real browser: Next
 * 15.5 synthesises `request.url` from its own listen options
 * (`resolve-routes.js`'s `initURL` uses `opts.hostname || 'localhost'`), NOT
 * from the `Host` header the browser actually sent, unless
 * `experimental.trustHostHeader` is on (it is not, anywhere in this
 * application). A live probe with `next dev` confirmed a request that
 * arrived as `Host: 127.0.0.1:3199` still reports `request.url` as
 * `http://localhost:3199/...` — so comparing against `request.url` refused
 * every POST from a browser that opened the page at `127.0.0.1`, including
 * Task 15's own Playwright `baseURL`.
 *
 * Fix round 2: the expected origin is built from the **`Host` header**
 * instead (protocol still comes from `request.url`, which Next does report
 * correctly — only the hostname/port half was wrong). `Host` cannot be set by
 * a cross-site page the way `Origin` sometimes can be spoofed by non-browser
 * senders, but a DNS-rebinding page's `Host` and `Origin` would both name the
 * attacker's own domain and agree with each other — deriving the expected
 * value from `Host` ALONE, with no further check, would wave that straight
 * through. The extra condition that closes it: when `allowOrigin` is unset,
 * `Host`'s hostname must ALSO be a loopback name (`localhost`, `127.0.0.1`,
 * `::1`) — this application's whole reason for trusting an unconfigured
 * `Host` at all is that "the demo runs on localhost", and a `Host` that
 * claims to be `evil.example` is refused regardless of what `Origin` says,
 * because nothing on this machine is actually reachable at that name. LAN or
 * proxied access past loopback requires setting
 * `HOMELEDGER_SIMULATOR_ALLOW_ORIGIN` explicitly, which the refusal message
 * says.
 *
 * A request with no `Host` header at all can only be a hand-built `Request`
 * in a test — real HTTP always carries one — and is treated as loopback only
 * when `request.url`'s own hostname already is, which is the origin check
 * this file ran before fix round 2 and is a reasonable fallback for exactly
 * the callers who cannot supply a `Host`.
 */
export function checkOrigin(request: Request, allowOrigin: string | undefined): Response | undefined {
  const origin = request.headers.get('origin');
  if (allowOrigin) {
    if (origin === null || origin === allowOrigin) return undefined;
    return json(
      { ok: false, reason: 'forbidden-origin', message: `This server accepts requests from ${allowOrigin} only; this one came from ${origin}.` },
      403
    );
  }

  const hostHeader = request.headers.get('host');
  const hostname = hostHeader !== null ? loopbackHostnameOf(hostHeader) : new URL(request.url).hostname;
  if (hostname === undefined || !LOOPBACK_HOSTNAMES.has(hostname))
    return json(
      {
        ok: false,
        reason: 'forbidden-origin',
        message: `This server only accepts loopback requests by default (got Host ${JSON.stringify(hostHeader)}); set HOMELEDGER_SIMULATOR_ALLOW_ORIGIN to allow requests from a specific origin.`
      },
      403
    );

  if (origin === null) return undefined;
  const expected = `${new URL(request.url).protocol}//${hostHeader ?? new URL(request.url).host}`;
  if (origin === expected) return undefined;
  return json({ ok: false, reason: 'forbidden-origin', message: `This server accepts requests from ${expected} only; this one came from ${origin}.` }, 403);
}

/**
 * Requires `content-type: application/json` on every route that reads a JSON body.
 *
 * Fix round 1, Critical (plan-mandated), the other half of the fix above.
 * `checkOrigin` closes the hole for a cross-site request that carries an
 * `Origin` header that does not match. A browser DOES send a truthful
 * cross-site `Origin` on a `no-cors` POST — a second review corrected an
 * earlier version of this comment that claimed otherwise — so `checkOrigin`
 * alone already stops that shape. This check is the independent layer for a
 * sender that omits `Origin` altogether (a non-browser HTTP client, or a
 * future browser behaviour this application should not have to predict): a
 * simple CORS request (`Content-Type` of `text/plain`,
 * `multipart/form-data` or `application/x-www-form-urlencoded`) needs no
 * preflight and reaches this server whether or not it carried a useful
 * `Origin`. `application/json` is not on that list: a same-origin browser
 * request that sends it goes through unchanged, but a cross-site one must
 * first send an OPTIONS preflight, which this application answers with no
 * `Access-Control-Allow-Origin` header — so the browser blocks the real
 * request before it ever reaches this function.
 */
function requireJsonContentType(request: Request): Response | undefined {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().startsWith('application/json')) return undefined;
  return json(
    {
      ok: false,
      reason: 'unsupported-media-type',
      message: `This endpoint requires "content-type: application/json"; got ${JSON.stringify(contentType)}.`
    },
    415
  );
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
  const wrongMediaType = requireJsonContentType(request);
  if (wrongMediaType) return wrongMediaType;
  const body = await readJson(request);
  const text = body?.text;
  if (typeof text !== 'string' || text.trim() === '')
    return json({ ok: false, reason: 'bad-request', message: 'The body needs a non-empty "text" field.' }, 400);

  // One turn at a time, checked and claimed with no `await` in between, so two
  // POSTs racing each other cannot both see the slot empty.
  if (conversation.activeTurn) return json({ ok: false, reason: 'turn-running', message: TURN_RUNNING_MESSAGE }, 409);
  const turnId = randomUUID();
  const abort = new AbortController();
  let settle!: () => void;
  const active = { turnId, controller: abort, settled: new Promise<void>(resolve => (settle = resolve)) };
  conversation.activeTurn = active;
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
          elicitationTimeoutMs: conversation.env.elicitationTimeoutMs,
          signal: abort.signal
        },
        turnId,
        conversation.history,
        text
      )
        .then(next => {
          // An aborted turn writes nothing: the page that asked is gone, or a
          // reset has already cleared the history this would overwrite.
          if (!abort.signal.aborted) conversation.history = next;
        })
        .catch((error: unknown) => {
          emit({ type: 'turn-failed', message: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          if (conversation.activeTurn === active) conversation.activeTurn = undefined;
          settle();
          open = false;
          try {
            controller.close();
          } catch {
            /* already closed by a cancel */
          }
        });
    },
    cancel() {
      // Both, and the abort first: closing the registry settles an open
      // question, and the abort stops the model call and every later round,
      // which would otherwise keep running — and keep being paid for — for a
      // page that is gone.
      abort.abort(new Error(BROWSER_CLOSED_REASON));
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

/**
 * Starts the conversation over: the history the model is handed is emptied.
 *
 * The page calls this once when it loads. The transcript a person sees lives
 * in the browser and is gone after a reload, but the history lived here, so a
 * retake used to carry an earlier take's turns — including data the person can
 * no longer see — into the model's context (final review I3).
 *
 * A running turn is aborted first and waited for, rather than refused with a
 * 409: a reload mid-turn is exactly when this is called, and the old turn's
 * own unwinding is what must not land after the reset. Every await inside a
 * turn honours the abort — the model call through the SDK's signal, a tool
 * call through the MCP client's, an open question through the registry close
 * below — so the wait is short.
 */
export async function handleReset(conversation: Conversation, request: Request): Promise<Response> {
  const forbidden = checkOrigin(request, conversation.env.allowOrigin);
  if (forbidden) return forbidden;
  const wrongMediaType = requireJsonContentType(request);
  if (wrongMediaType) return wrongMediaType;
  const running = conversation.activeTurn;
  if (running) {
    running.controller.abort(new Error(RESET_REASON));
    conversation.registry.close(running.turnId, RESET_REASON);
    await running.settled;
  }
  conversation.history = [];
  return json({ ok: true, abortedTurn: running !== undefined }, 200);
}

/** Delivers one elicitation answer. 202 mirrors what the MCP wire itself answers to an elicitation response. */
export async function handleAnswer(conversation: Conversation, request: Request): Promise<Response> {
  const forbidden = checkOrigin(request, conversation.env.allowOrigin);
  if (forbidden) return forbidden;
  const wrongMediaType = requireJsonContentType(request);
  if (wrongMediaType) return wrongMediaType;
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
 *
 * Takes the request and runs `checkOrigin` first, the same as `turn` and
 * `answer` (fix round 1, review Minor 4 promoted to a ruling): this payload
 * holds no credential, but it does hold the runtime ARN, which carries the
 * AWS account id, and a cross-site GET with no origin check still runs
 * `getConversation()` - a token mint and a connect - on every request a
 * stranger's browser cares to send. `next dev` binds all interfaces, so
 * "small blast radius" is not "no blast radius".
 */
/**
 * The only tools a widget may run, and the reason the list is short.
 *
 * The calendar widget's "log as done" button is the one interaction the
 * widgets have (`apps/mcp-server/src/widgets/calendar.ts`). A general
 * tool-calling endpoint reachable from a sandboxed frame would let anything
 * running in that frame book a service visit, which is a write nobody asked
 * for. An allowlist checked server-side is the boundary; the widget's own good
 * behaviour is not.
 */
export const WIDGET_TOOLS: readonly string[] = ['log_maintenance'];

export async function handleWidget(conversation: Conversation, request: Request): Promise<Response> {
  // Checked here too, and not only on the tool route. This endpoint is fetched
  // by the browser like every other one, and an Origin check that covers four
  // routes out of five is a check somebody will reasonably believe covers all
  // five.
  const forbidden = checkOrigin(request, conversation.env.allowOrigin);
  if (forbidden) return forbidden;
  const uri = new URL(request.url).searchParams.get('uri') ?? '';
  // Prefix-checked, not merely scheme-checked: this endpoint exists to serve
  // this server's widgets and must not become a way to read any resource the
  // MCP server exposes.
  if (!uri.startsWith('ui://homeledger/'))
    return json({ ok: false, reason: 'bad-request', message: `Only ui://homeledger/ resources are served here; got ${JSON.stringify(uri)}.` }, 400);
  try {
    const html = await conversation.mcp.readResource(uri);
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  } catch (error) {
    return json({ ok: false, reason: 'unavailable', message: error instanceof Error ? error.message : String(error) }, 502);
  }
}

/** True when an MCP tool result is `isError`, the shape a call answers with when it did not do what it names — an unknown appliance, a task the appliance doesn't have. */
function isErrorResult(result: unknown): result is { isError: true; content?: unknown } {
  return typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true;
}

/** The result's own first text block, so the widget's failure card quotes the server rather than a generic sentence. */
function toolResultText(result: { content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  for (const block of content) {
    const text = (block as { text?: unknown } | null)?.text;
    if (typeof text === 'string') return text;
  }
  return 'The tool call did not succeed.';
}

export async function handleWidgetTool(conversation: Conversation, request: Request): Promise<Response> {
  const forbidden = checkOrigin(request, conversation.env.allowOrigin);
  if (forbidden) return forbidden;
  const wrongMediaType = requireJsonContentType(request);
  if (wrongMediaType) return wrongMediaType;
  const body = await readJson(request);
  const name = body?.name;
  if (typeof name !== 'string') return json({ ok: false, reason: 'bad-request', message: 'The body needs a string "name".' }, 400);
  if (!WIDGET_TOOLS.includes(name))
    return json({ ok: false, reason: 'forbidden-tool', message: `A widget may not call ${name}. Allowed here: ${WIDGET_TOOLS.join(', ')}.` }, 403);
  const args = (typeof body?.arguments === 'object' && body.arguments !== null ? body.arguments : {}) as Record<string, unknown>;
  try {
    const result = await conversation.mcp.callTool(name, args);
    // FL-039, the write-tool half: `callTool` does not throw for `isError` -
    // that is MCP's flag for "the call did not execute", set by the tool
    // itself rather than by a transport failure - so answering 200 here would
    // tell `WidgetFrame.callTool` (which only throws on `!response.ok`) and
    // the widget's own bridge (which resolves a JSON-RPC result, not an
    // error) that a write succeeded when it did not. The calendar widget then
    // shows "Logged" for a task that is still overdue.
    if (isErrorResult(result)) return json({ ok: false, reason: 'tool-failed', message: toolResultText(result) }, 422);
    return json(result, 200);
  } catch (error) {
    return json({ ok: false, reason: 'tool-failed', message: error instanceof Error ? error.message : String(error) }, 502);
  }
}

export function handleDebug(conversation: Conversation, request: Request): Response {
  const forbidden = checkOrigin(request, conversation.env.allowOrigin);
  if (forbidden) return forbidden;
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
      // The visible-marker half of the scripted-mode gate in session.ts:
      // `assertScriptedModeAllowed` keeps this from ever being true against
      // the deployed runtime, and this field is what lets the page say so
      // rather than only logging it where nobody watching a demo would see.
      scripted: conversation.scripted,
      // Methods and timings. `HomeLedgerMcp.record` keeps payloads out at the
      // source; this endpoint spreads the entries it is given and adds
      // nothing, so there is one place to read to know what can appear here.
      log: conversation.mcp.jsonRpcLog.map(entry => ({ ...entry }))
    }),
    { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }
  );
}
