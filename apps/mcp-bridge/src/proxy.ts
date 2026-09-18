import { explainUpstreamFailure } from './errors.js';
import { redact } from './redact.js';
import { sseEvents } from './sse.js';

export interface ProxyOptions {
  /** AgentCore invocation URL, complete with its `?qualifier=` query. */
  url: string;
  /** Yields the current bearer token. Called per request so a refresh mid-session is picked up with no plumbing here. */
  token: () => Promise<string>;
  /** Drops the cached token, so the retry after a 401 mints a fresh one. */
  invalidateToken: () => void;
  agentCoreSessionId: string | undefined;
  standaloneStream: boolean;
  fetchImpl?: typeof fetch;
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
 */
export class Bridge {
  private readonly options: ProxyOptions;
  private readonly doFetch: typeof fetch;
  private readonly aborts = new Set<AbortController>();
  private mcpSessionId: string | undefined;
  private protocolVersion: string | undefined;
  private standaloneStarted = false;
  private closed = false;

  constructor(options: ProxyOptions) {
    this.options = options;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  /** The session id captured from the upstream `initialize` response, for tests and for shutdown. */
  get sessionId(): string | undefined {
    return this.mcpSessionId;
  }

  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = { accept };
    if (this.mcpSessionId) headers['mcp-session-id'] = this.mcpSessionId;
    // Required of clients from 2025-06-18 onward once a version is negotiated.
    // Claude Code speaks this over stdio, where the header does not exist, so
    // the bridge is what puts it on the wire.
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
    if (this.options.agentCoreSessionId) headers['x-amzn-bedrock-agentcore-runtime-session-id'] = this.options.agentCoreSessionId;
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
      this.doFetch(this.options.url, {
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
    const ids = requestIdsOf(payload);
    const controller = new AbortController();
    this.aborts.add(controller);
    try {
      const res = await this.send(JSON.stringify(payload), controller.signal);
      const sessionId = res.headers.get('mcp-session-id');
      if (sessionId) this.mcpSessionId = sessionId;

      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, MAX_ERROR_BODY);
        const message = explainUpstreamFailure(res.status, body);
        this.options.log(message);
        this.writeError(ids, message);
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
        if (text.trim() !== '') this.relay(text);
      }
      this.maybeStartStandaloneStream();
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      this.options.log(`request failed: ${message}`);
      this.writeError(ids, message);
    } finally {
      this.aborts.delete(controller);
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
        const res = await this.doFetch(this.options.url, {
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
      const res = await this.doFetch(this.options.url, {
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
