import { classifyUpstreamFailure, explainUpstreamFailure, wrappedRuntimeStatus } from './errors.js';
import { redact } from './redact.js';
import { sseEvents } from './sse.js';

export interface ProxyOptions {
  /** AgentCore invocation URL, complete with its `?qualifier=` query. The starting address; the bridge may re-resolve it. */
  url: string;
  /** Yields the current bearer token. Called per request so a refresh mid-session is picked up with no plumbing here. */
  token: () => Promise<string>;
  /** Drops the cached token, so the retry after a 401 mints a fresh one. */
  invalidateToken: () => void;
  agentCoreSessionId: string | undefined;
  standaloneStream: boolean;
  fetchImpl?: typeof fetch;
  /**
   * Looks the runtime up by name again and returns a fresh invocation URL.
   *
   * Undefined unless the bridge chose this address for itself: an ARN or a URL
   * the owner supplied is an instruction about *which* runtime to talk to, and
   * moving off it silently would be the same class of mistake as taking
   * `rows[0]` out of `ListAgentRuntimes`.
   */
  reresolve?: (() => Promise<string>) | undefined;
  /**
   * Mints a replacement AgentCore runtime session id.
   *
   * Undefined when there is no header to rotate (the default configuration) or
   * when the owner pinned a literal value, which the bridge does not overwrite
   * for the same reason it does not overwrite a supplied ARN.
   */
  newAgentCoreSessionId?: (() => string) | undefined;
  /** Writes one JSON-RPC message to the client. Must emit exactly one line. */
  write: (line: string) => void;
  /** Writes one diagnostic line. Never the protocol channel. */
  log: (message: string) => void;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
  params?: unknown;
}

/** Ids of the members of a stdin payload that are requests, i.e. the ones an error must be answered to. */
export function requestIdsOf(payload: unknown): Array<string | number> {
  const members = Array.isArray(payload) ? payload : [payload];
  const ids: Array<string | number> = [];
  for (const member of members) {
    if (typeof member !== 'object' || member === null) continue;
    const { id, method } = member as JsonRpcMessage;
    if (typeof method !== 'string') continue;
    if (typeof id === 'string' || typeof id === 'number') ids.push(id);
  }
  return ids;
}

/** Reads the negotiated protocol version out of an `initialize` result, or undefined when the message is not one. */
export function protocolVersionOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const result = (payload as JsonRpcMessage).result;
  if (typeof result !== 'object' || result === null) return undefined;
  const version = (result as { protocolVersion?: unknown }).protocolVersion;
  return typeof version === 'string' ? version : undefined;
}

const MAX_ERROR_BODY = 600;
/** Consecutive failed reconnects of the standalone stream before the bridge stops trying. Reset by any successful open. */
const MAX_STREAM_RECONNECTS = 5;

/**
 * Relays MCP traffic between Claude Code's stdio transport and the deployed
 * Streamable HTTP endpoint.
 *
 * The relay is deliberately message-agnostic: it parses each JSON-RPC message
 * only far enough to re-serialise it onto a single line, to learn the
 * negotiated protocol version, and to know which ids need an error answer if
 * the transport itself fails. It never interprets a method, so `tools/call`,
 * `elicitation/create`, `notifications/progress`, and anything a future
 * protocol revision adds all pass through on the same path.
 *
 * Two properties make the elicitation flow work, and both are easy to lose:
 *
 * 1. Responses are *streamed*, never buffered. A `tools/call` for `book_service`
 *    answers with an SSE stream that carries three `elicitation/create`
 *    requests before it carries the tool's result.
 * 2. Requests are *concurrent*. `handleClientMessage` is not awaited by the
 *    read loop, so the three answers can be POSTed while the `tools/call` that
 *    asked the questions is still open. Serialising requests here — the
 *    obvious, tidy-looking thing to do — deadlocks the flow outright.
 *
 * It does keep two messages, and only two: the client's `initialize` request
 * and its `notifications/initialized`. They are the handshake, and holding them
 * is what lets the bridge rebuild a session the platform has thrown away
 * without the client ever learning that it happened. See `reestablishSession`.
 */
export class Bridge {
  private readonly options: ProxyOptions;
  private readonly doFetch: typeof fetch;
  private readonly aborts = new Set<AbortController>();
  /** Mutable: a 404 with no session behind it can move the bridge to a re-resolved address. */
  private url: string;
  /** Mutable: rotated when a session is rebuilt, but only when the bridge minted it in the first place. */
  private agentCoreSessionId: string | undefined;
  private mcpSessionId: string | undefined;
  private protocolVersion: string | undefined;
  private initializeLine: string | undefined;
  private initializedLine: string | undefined;
  private rehandshake: Promise<boolean> | undefined;
  private healing: Promise<boolean> | undefined;
  private standaloneStarted = false;
  private closed = false;

  constructor(options: ProxyOptions) {
    this.options = options;
    this.doFetch = options.fetchImpl ?? fetch;
    this.url = options.url;
    this.agentCoreSessionId = options.agentCoreSessionId;
  }

  /** The session id captured from the upstream `initialize` response, for tests and for shutdown. */
  get sessionId(): string | undefined {
    return this.mcpSessionId;
  }

  /** The address currently being POSTed to. Differs from the configured one only after a re-resolution. */
  get endpoint(): string {
    return this.url;
  }

  /** The AgentCore runtime session id currently on the wire, or undefined when the header is suppressed. */
  get runtimeSessionId(): string | undefined {
    return this.agentCoreSessionId;
  }

  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = { accept };
    if (this.mcpSessionId) headers['mcp-session-id'] = this.mcpSessionId;
    // Required of clients from 2025-06-18 onward once a version is negotiated.
    // Claude Code speaks this over stdio, where the header does not exist, so
    // the bridge is what puts it on the wire.
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
    if (this.agentCoreSessionId) headers['x-amzn-bedrock-agentcore-runtime-session-id'] = this.agentCoreSessionId;
    return headers;
  }

  private writeMessage(payload: unknown): void {
    // Re-serialised rather than forwarded verbatim: stdio framing is one
    // message per line, and an SSE `data:` field may legally be split across
    // several lines that reassemble with embedded newlines.
    this.options.write(JSON.stringify(payload));
  }

  private writeError(ids: Array<string | number>, message: string): void {
    for (const id of ids) this.writeMessage({ jsonrpc: '2.0', id, error: { code: -32603, message: redact(message) } });
  }

  private async send(body: string, signal: AbortSignal): Promise<Response> {
    const attempt = async (): Promise<Response> =>
      this.doFetch(this.url, {
        method: 'POST',
        headers: {
          ...this.headers('application/json, text/event-stream'),
          'content-type': 'application/json',
          authorization: `Bearer ${await this.options.token()}`
        },
        body,
        signal
      });

    const first = await attempt();
    // A 401 or 403 here means the request was refused before the runtime ran
    // it, so nothing was executed and re-sending it cannot double-apply a
    // write. Both statuses are retried because which one AgentCore returns for
    // an expired token is not something this repository has been able to
    // observe. Exactly one retry: a second refusal is a configuration problem,
    // and looping on it would bury the message that says so.
    if (first.status !== 401 && first.status !== 403) return first;
    this.options.log(`upstream returned ${first.status}; refreshing the Cognito token and retrying once`);
    await first.body?.cancel().catch(() => undefined);
    this.options.invalidateToken();
    return attempt();
  }

  /** Handles one line from the client. Returns a promise for tests; the read loop deliberately does not await it. */
  async handleClientMessage(line: string): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      this.options.log('dropped a line from the client that was not JSON');
      return;
    }
    const body = JSON.stringify(payload);
    this.rememberHandshake(payload, body);
    const ids = requestIdsOf(payload);
    const controller = new AbortController();
    this.aborts.add(controller);
    try {
      await this.deliver(body, ids, controller.signal, true);
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      this.options.log(`request failed: ${message}`);
      this.writeError(ids, message);
    } finally {
      this.aborts.delete(controller);
    }
  }

  /**
   * Keeps the two messages that constitute the handshake, and nothing else.
   *
   * Re-sending `initialize` is the only way to get a session id out of the
   * server (`apps/mcp-server/src/legacy.ts` mints one only for a POST that
   * carries an initialize body and no session header), so a bridge that wants
   * to repair a session has to be holding the client's own initialize. Keeping
   * the `notifications/initialized` that follows costs one more string and
   * means the rebuilt session reaches the same state the original did rather
   * than a half-open one.
   */
  private rememberHandshake(payload: unknown, line: string): void {
    const members = Array.isArray(payload) ? payload : [payload];
    for (const member of members) {
      if (typeof member !== 'object' || member === null) continue;
      const { method } = member as JsonRpcMessage;
      if (method === 'initialize') this.initializeLine = line;
      else if (method === 'notifications/initialized') this.initializedLine = line;
    }
  }

  /**
   * Sends one payload, relays the answer, and makes at most one repair attempt.
   *
   * `mayHeal` is the entire loop guard and it is cleared on the replay, so one
   * message from the client causes at most one repair and at most two sends. A
   * repair that does not change anything reports false rather than replaying,
   * so a runtime that is genuinely absent is never papered over by a retry that
   * addresses the same place.
   */
  private async deliver(body: string, ids: Array<string | number>, signal: AbortSignal, mayHeal: boolean): Promise<void> {
    // Captured before the request goes out, not read back afterwards. Whether
    // *this* request carried a session id is what decides which 404 it can
    // have received, and live state is the wrong place to ask: a repair in
    // flight for a sibling request clears `mcpSessionId` while it re-handshakes,
    // so three requests failing together would see the first one's repair and
    // misread their own 404 as a missing runtime.
    const sentWithSession = this.mcpSessionId !== undefined;
    const res = await this.send(body, signal);
    const sessionId = res.headers.get('mcp-session-id');
    if (sessionId) this.mcpSessionId = sessionId;

    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, MAX_ERROR_BODY);
      if (mayHeal && (await this.repair(res.status, text, sentWithSession))) return this.deliver(body, ids, signal, false);
      this.fail(ids, res.status, text, sentWithSession, !mayHeal);
      return;
    }
    // 202 Accepted: the client sent a notification or a response, and there
    // is nothing coming back. This is the path every elicitation ANSWER takes.
    if (res.status === 202) {
      await res.body?.cancel().catch(() => undefined);
      return;
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      if (res.body) await this.pump(res.body);
    } else {
      const text = await res.text();
      // A 2xx carrying AgentCore's -32010 envelope is a failure wearing a
      // success's status code, and it is how the owner's client came to print
      // a raw `-32010 ... check your CloudWatch logs` with no bridge
      // diagnostic anywhere near it: `res.ok` was true, so the old code
      // relayed the envelope verbatim and the only thing that read it was a
      // language model. Nothing has been written to the client yet on this
      // branch, so the request is still replayable.
      if (text.trim() !== '' && wrappedRuntimeStatus(text) !== undefined) {
        const snippet = text.slice(0, MAX_ERROR_BODY);
        if (mayHeal && (await this.repair(res.status, snippet, sentWithSession))) return this.deliver(body, ids, signal, false);
        this.fail(ids, res.status, snippet, sentWithSession, !mayHeal);
        return;
      }
      if (text.trim() !== '') this.relay(text);
    }
    this.maybeStartStandaloneStream();
  }

  /** Writes one upstream failure to both channels, with the sentence chosen by what the bridge already tried. */
  private fail(ids: Array<string | number>, status: number, body: string, hasSession: boolean, retried: boolean): void {
    const message = explainUpstreamFailure(status, body, { hasSession, retried });
    this.options.log(message);
    this.writeError(ids, message);
  }

  /**
   * Works out what a 404 was about and attempts the one repair that fits it.
   *
   * The two 404s this stack produces share nothing but their status, and the
   * discriminator is whether this process holds an MCP session. With one, the
   * request reached a runtime instance whose in-memory session map does not
   * have it — rebuild the session. Without one, the bridge has not yet sent a
   * session id to anything, so the 404 is AgentCore failing to find the runtime
   * — re-resolve the address. Applying either repair to the other's failure
   * would be a retry that cannot work.
   */
  private async repair(status: number, body: string, hasSession: boolean): Promise<boolean> {
    if (this.closed) return false;
    const fault = classifyUpstreamFailure(status, body, hasSession);
    if (fault === 'lost-session') return this.reestablishSession();
    if (fault === 'missing-runtime') return this.healAddress();
    return false;
  }

  /**
   * Rebuilds the MCP session by replaying the client's own handshake, out of band.
   *
   * This is the self-heal, and the reason it has to rebuild the *session* and
   * not merely rotate a header is that both halves are gone together: the
   * runtime instance that held the session map has been recycled, so no value
   * in any header will make a surviving instance remember a session that only
   * ever existed in the dead one's memory. Rotating the AgentCore runtime
   * session id alone would retry against a fresh instance that answers 404 for
   * exactly the same reason.
   *
   * "Out of band" is load-bearing. The replayed `initialize` carries the
   * client's original request id, so its response is drained and discarded
   * rather than relayed — the client was answered the first time round, and a
   * second response on a settled id is a protocol violation the client would be
   * right to reject. What the client sees is its original request succeeding on
   * the replay, with no evidence that the session underneath it was rebuilt.
   *
   * Concurrency: every request that 404s while a rebuild is in flight waits on
   * the same promise, so a stalled conversation with three overlapping requests
   * performs one handshake rather than three.
   */
  private async reestablishSession(): Promise<boolean> {
    if (!this.initializeLine) return false;
    this.rehandshake ??= this.runRehandshake(this.initializeLine);
    return this.rehandshake;
  }

  private async runRehandshake(initializeLine: string): Promise<boolean> {
    const previous = this.mcpSessionId;
    const controller = new AbortController();
    this.aborts.add(controller);
    try {
      // An initialize must carry no session id or the server routes it into the
      // lookup that just failed instead of minting a new session.
      this.mcpSessionId = undefined;
      if (this.options.newAgentCoreSessionId && this.agentCoreSessionId) {
        this.agentCoreSessionId = this.options.newAgentCoreSessionId();
        this.options.log('rotated the AgentCore runtime session id, so the replay is not routed back to the instance that lost the session');
      }
      const res = await this.send(initializeLine, controller.signal);
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        this.mcpSessionId = previous;
        this.options.log(`could not re-establish the MCP session: the endpoint answered ${res.status} to a fresh initialize`);
        return false;
      }
      const sessionId = res.headers.get('mcp-session-id');
      await this.drain(res);
      if (!sessionId) {
        this.mcpSessionId = previous;
        this.options.log('could not re-establish the MCP session: the endpoint accepted a fresh initialize but issued no mcp-session-id');
        return false;
      }
      this.mcpSessionId = sessionId;
      if (this.initializedLine) {
        const ack = await this.send(this.initializedLine, controller.signal);
        await ack.body?.cancel().catch(() => undefined);
      }
      this.options.log('the runtime instance holding the MCP session was gone; re-established a session and replaying the call once');
      return true;
    } catch (err) {
      this.mcpSessionId = previous;
      if (!controller.signal.aborted) this.options.log(`could not re-establish the MCP session: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      this.aborts.delete(controller);
      this.rehandshake = undefined;
    }
  }

  /**
   * Looks the runtime up by name again and moves the bridge to it, once.
   *
   * Reports false in the two cases that matter for not masking a real problem:
   * when re-resolution fails outright, and when it produces the address already
   * in use. The second is the subtle one — the runtime exists under the name,
   * so a 404 from it is about something other than the address, and replaying
   * the request at the same URL would turn a diagnosable failure into a
   * duplicate of itself.
   */
  private async healAddress(): Promise<boolean> {
    if (!this.options.reresolve) return false;
    this.healing ??= this.runHeal();
    return this.healing;
  }

  private async runHeal(): Promise<boolean> {
    try {
      const next = await this.options.reresolve!();
      if (next === this.url) {
        this.options.log('re-resolved the runtime by name and got the address already in use, so the 404 is not a stale ARN');
        return false;
      }
      this.url = next;
      this.options.log(`the runtime was recreated; re-resolved it by name and moved to ${new URL(next).pathname} — retrying once`);
      return true;
    } catch (err) {
      this.options.log(`could not re-resolve the runtime by name: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      this.healing = undefined;
    }
  }

  /** Reads a response to completion for its side effects only — the negotiated version — and writes nothing to the client. */
  private async drain(res: Response): Promise<void> {
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      if (!res.body) return;
      for await (const event of sseEvents(res.body)) {
        if (event.data.trim() !== '') this.noteProtocolVersion(event.data);
      }
      return;
    }
    const text = await res.text();
    if (text.trim() !== '') this.noteProtocolVersion(text);
  }

  private noteProtocolVersion(text: string): void {
    try {
      const version = protocolVersionOf(JSON.parse(text));
      if (version) this.protocolVersion = version;
    } catch {
      /* a non-JSON frame on a drained stream tells the bridge nothing it needs */
    }
  }

  private relay(text: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      this.options.log('dropped a message from the endpoint that was not JSON');
      return;
    }
    const version = protocolVersionOf(payload);
    if (version) this.protocolVersion = version;
    this.writeMessage(payload);
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    for await (const event of sseEvents(body)) {
      if (event.data.trim() === '') continue;
      this.relay(event.data);
    }
  }

  /**
   * Opens the spec's optional standalone server-to-client stream once a session
   * exists. Nothing observed from this server arrives on it — the elicitation
   * requests come back on the `tools/call` POST's own stream — but a server MAY
   * use it for unsolicited notifications, and a stdio client has no way to open
   * one for itself. Failure is never fatal: a server MAY answer 405.
   */
  private maybeStartStandaloneStream(): void {
    if (!this.options.standaloneStream || this.standaloneStarted || !this.mcpSessionId || this.closed) return;
    this.standaloneStarted = true;
    void this.runStandaloneStream();
  }

  private async runStandaloneStream(): Promise<void> {
    let failures = 0;
    while (!this.closed && failures < MAX_STREAM_RECONNECTS) {
      const controller = new AbortController();
      this.aborts.add(controller);
      try {
        const res = await this.doFetch(this.url, {
          method: 'GET',
          headers: { ...this.headers('text/event-stream'), authorization: `Bearer ${await this.options.token()}` },
          signal: controller.signal
        });
        if (res.status === 405 || res.status === 404) {
          await res.body?.cancel().catch(() => undefined);
          this.options.log(
            `the endpoint does not offer a standalone event stream (${res.status}); server-initiated messages will still arrive on tool-call streams`
          );
          return;
        }
        if (!res.ok || !res.body) {
          failures += 1;
          await res.body?.cancel().catch(() => undefined);
        } else {
          failures = 0;
          await this.pump(res.body);
        }
      } catch {
        if (this.closed || controller.signal.aborted) return;
        failures += 1;
      } finally {
        this.aborts.delete(controller);
      }
      if (this.closed) return;
      if (failures > 0) await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** (failures - 1), 16_000)));
    }
    if (failures >= MAX_STREAM_RECONNECTS) this.options.log('gave up reconnecting the standalone event stream; tool calls are unaffected');
  }

  /**
   * Best-effort session termination, then shutdown.
   *
   * The DELETE is allowed to fail silently: FL-022 records AgentCore routing
   * exactly this request to an instance that never held the session, and
   * AgentCore expires sessions on its own idle timeout regardless, so a failure
   * here has no consequence worth a line in the log the owner reads.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const sessionId = this.mcpSessionId;
    for (const controller of this.aborts) controller.abort();
    this.aborts.clear();
    if (!sessionId) return;
    try {
      const res = await this.doFetch(this.url, {
        method: 'DELETE',
        headers: { ...this.headers('application/json, text/event-stream'), authorization: `Bearer ${await this.options.token()}` }
      });
      await res.body?.cancel().catch(() => undefined);
    } catch {
      /* see the comment above: nothing actionable follows from this failing */
    }
  }
}

/**
 * Splits a byte stream into newline-delimited messages and hands each to the
 * bridge without awaiting it, which is what keeps requests concurrent.
 */
export function createLineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buffer = '';
  return chunk => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== '') onLine(line);
    }
  };
}
