import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ElicitationAnswer } from './elicitation.js';
import type { McpToolDescriptor } from './tools.js';

export interface ElicitPrompt {
  message: string;
  requestedSchema: unknown;
}

export interface HomeLedgerMcpOptions {
  /** The AgentCore invocation URL, or a plain http://127.0.0.1:PORT/mcp in tests. */
  url: string;
  /** Yields the current bearer. Called per HTTP request, so a refresh mid-conversation needs no plumbing here. */
  token: () => Promise<string>;
  /**
   * Asks the person. Resolving is the answer; rejecting aborts the tool call.
   *
   * This client neither opens nor closes an `ElicitationRegistry` turn, and
   * deliberately: it has no turn id, and the lifetime it would have to pair
   * with is the caller's, not one `callTool` can see. Whoever builds this
   * callback out of the registry — the agent loop and the route that streams
   * it, Tasks 8 and 9 — is the thing that called `open()` and therefore owns
   * `close()` on every exit path, including the ones that never reach here:
   * a rejected `onElicit`, a thrown tool call, a request the browser
   * disconnected from, a turn nobody ever answers. See the class comment on
   * `ElicitationRegistry` for why the registry cannot defend itself.
   */
  onElicit: (prompt: ElicitPrompt) => Promise<ElicitationAnswer>;
  /** Drops the cached bearer so the next request mints a new one. Called once on a 401 or 403, before the single retry. */
  invalidateToken?: () => void;
  /** Re-resolves the runtime by name. Called before every rebuild; absent in tests that pin a URL. */
  resolveUrl?: () => Promise<string>;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

/** One line of the wire, for the debug drawer. Methods and timings only — never a payload; see `record`. */
export interface JsonRpcLogEntry {
  at: number;
  direction: 'out' | 'in';
  method: string;
  id: string | number | null;
  ms: number | null;
  status: number | null;
}

/** How many lines the drawer keeps. A conversation is minutes long and the drawer shows the tail; unbounded, this would grow with the session. */
export const JSON_RPC_LOG_LIMIT = 100;

/**
 * Maps `tools/list` onto the descriptor the rest of this application reads.
 *
 * Extracted from the class so the one property this side owns — that nothing
 * is reordered, filtered or flattened on the way through — can be pinned
 * without a socket. What tools exist and in what order is the server's
 * contract, asserted in the server's own suite; restating its list here is
 * what Global Constraint 30 forbids.
 */
export function toDescriptors(
  tools: ReadonlyArray<{ name: string; description?: string | undefined; inputSchema: unknown; _meta?: unknown }>
): McpToolDescriptor[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
    _meta: tool._meta
  }));
}

const CLIENT_INFO = { name: 'homeledger-simulator', version: '0.1.0' } as const;

/**
 * Whether a failure means "the instance serving this request does not hold my session".
 *
 * The container answers 404 in exactly one place — `apps/mcp-server/src/legacy.ts`
 * line 50, a request carrying an `Mcp-Session-Id` its in-memory map does not
 * have — and AgentCore recycles an instance after 30 minutes idle, so this is
 * the failure an ordinary pause produces (FL-039). Matched on the JSON-RPC code
 * the server sends, on the HTTP status, or on the sentence, because which of
 * those reaches the caller depends on which layer noticed. Deliberately narrow:
 * a 401 is a credential problem and a connection refusal is an address problem,
 * and rebuilding a session fixes neither.
 *
 * Reachability, measured rather than assumed (mutation check 3): through the
 * installed SDK, the transport raises `StreamableHTTPError` carrying the HTTP
 * status, so every socket test in this repository travels the `code === 404`
 * arm. The `-32001` arm is kept because AgentCore relays the container's
 * JSON-RPC envelope rather than its status — a -32001 arriving with no 404
 * beside it is what that produces — and the sentence arm is kept because a
 * layer that stringifies before rethrowing leaves only the sentence. Each arm
 * has its own assertion in `mcp.test.ts` so none of the three is decorative.
 */
export function isLostSessionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === -32001 || code === 404) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /\b404\b/.test(message) && /session not found/i.test(message);
}

/**
 * Whether a failure means "the bearer I sent was refused".
 *
 * A different repair from the one above, which is the whole reason it is a
 * different predicate: a rotated Cognito client secret is fixed by minting a
 * new token and sending the same call again, and rebuilding the MCP session
 * against the same credential fixes nothing while looking like it tried.
 * `apps/mcp-bridge/src/proxy.ts:160-185` is the rule being reused —
 * invalidate, retry exactly once, and let the second refusal through.
 */
export function isUnauthorizedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 401 || code === 403) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /\b(401|403)\b/.test(message);
}

/**
 * One MCP conversation with the deployed server, kept alive across a chat.
 *
 * A 2025-era client on purpose. The 2026-07-28 multi round-trip path exists and
 * the server serves it, but every client a person actually has — Claude Code,
 * the documented smart-display assistant, the Strands client the spec named —
 * negotiates 2025 and answers elicitation with `elicitation/create` over the
 * call's own event stream (FL-033). Using the same path the demo will be judged
 * on is worth more than using the newest one.
 *
 * "the documented smart-display assistant" rather than its product name, and
 * not as a stylistic choice: Task 7's wordmark guard walks every `.ts` under
 * `src/` except `server/prompt.ts`, lowercases both sides, and fails on the
 * mark wherever it appears — a comment included. The draft of this plan named
 * the product here, one task before it shipped the guard that forbids it.
 *
 * Two properties carried over from `apps/mcp-bridge/src/proxy.ts`, both easy to
 * lose and neither of which fails loudly when lost:
 *
 * 1. The tool-call response is STREAMED, never buffered. `book_service` answers
 *    with an SSE stream that stays open carrying all three `elicitation/create`
 *    requests before it carries the result.
 * 2. Requests OVERLAP. Each elicitation answer is a separate POST sent while
 *    that stream is still open, so nothing here may serialise requests behind a
 *    lock. Both are the SDK transport's behaviour and this class does nothing to
 *    undo them — which is the point: a mutex added around `callTool` for
 *    tidiness deadlocks the booking flow, and it deadlocks it silently, as a
 *    timeout rather than a failure.
 */
export class HomeLedgerMcp {
  private readonly options: HomeLedgerMcpOptions;
  private readonly log: (message: string) => void;
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private rebuildCount = 0;
  private url: string;
  private readonly wire: JsonRpcLogEntry[] = [];

  constructor(options: HomeLedgerMcpOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
    this.url = options.url;
  }

  /** The address currently in use. Not `options.url`: a heal moves it, and the drawer must show where the traffic actually goes. */
  get endpointUrl(): string {
    return this.url;
  }

  /** The version the two ends negotiated at `initialize`, read off the transport that negotiated it. Undefined before `connect()`. */
  get protocolVersion(): string | undefined {
    return this.transport?.protocolVersion;
  }

  /** The tail of the wire, newest last. Read by the debug drawer (spec section 7). */
  get jsonRpcLog(): readonly JsonRpcLogEntry[] {
    return this.wire;
  }

  /**
   * Appends one line, and never a payload.
   *
   * Method, id, status and duration are enough to read a conversation — which
   * call went out, whether it came back, how long it took, how many
   * notifications arrived between them — and they are the parts that carry
   * nothing private. Bodies carry the household's own data, and every progress
   * notification on this server carries a `progressToken`, which would put
   * that word on `/api/debug` and trip the credential assertion that guards
   * it. The one thing this deliberately cannot show is a request's arguments;
   * that is the price, and it is named here rather than discovered by whoever
   * goes looking for them.
   */
  private record(entry: JsonRpcLogEntry): void {
    this.wire.push(entry);
    if (this.wire.length > JSON_RPC_LOG_LIMIT) this.wire.splice(0, this.wire.length - JSON_RPC_LOG_LIMIT);
  }

  private recordOutbound(body: unknown, started: number, status: number | null): void {
    let parsed: unknown;
    try {
      parsed = typeof body === 'string' ? JSON.parse(body) : undefined;
    } catch {
      return;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (typeof message !== 'object' || message === null) continue;
      const method = (message as { method?: unknown }).method;
      if (typeof method !== 'string') continue;
      const id = (message as { id?: unknown }).id;
      this.record({
        at: Date.now(),
        direction: 'out',
        method,
        id: typeof id === 'string' || typeof id === 'number' ? id : null,
        ms: Date.now() - started,
        status
      });
    }
  }

  get sessionId(): string | undefined {
    return this.transport?.sessionId;
  }

  /** How many times the session has been rebuilt this conversation. Read by the debug drawer and by the tests. */
  get rebuilds(): number {
    return this.rebuildCount;
  }

  /**
   * Opens a session: `initialize`, then `notifications/initialized`.
   *
   * No repair of its own, on purpose. A failure here — a 404 above all — is the
   * runtime not being at this address, which is a different thing from the
   * session being gone (there is no session yet to lose), and the two must not
   * be conflated: reconnecting in a loop against an address that answers 404
   * would turn "I cannot find the runtime" into a hang. So this rejects, and
   * only `attempt` below, which by construction runs after a handshake
   * succeeded, treats a 404 as repairable.
   */
  async connect(): Promise<void> {
    await this.close();
    const client = new Client(CLIENT_INFO, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async request => {
      // A server-initiated request, so it never passes through the fetch tap
      // below. Logged here for the same reason spec section 7 asks for a
      // transport tap at all: a drawer that showed only outbound calls would
      // show `tools/call` sitting for two minutes with nothing in between,
      // which is exactly the moment somebody needs to see three questions.
      this.record({ at: Date.now(), direction: 'in', method: 'elicitation/create', id: null, ms: null, status: null });
      // `ElicitRequestParams` is a UNION at SDK 1.30.0: the schema form this
      // server sends, and a `mode: 'url'` form that asks the client to open a
      // browser instead. This client declares no URL-mode capability, so the
      // branch is unreachable against a conforming server and no test in this
      // repository exercises it — it is here because the type demands a
      // narrowing and the honest narrowing rejects. Returning `decline` would
      // type-check and would tell the server a person said no, which is a
      // sentence nobody said.
      if (!('requestedSchema' in request.params)) throw new Error('the server asked for URL-mode elicitation, which this client does not offer');
      return this.options.onElicit({ message: request.params.message, requestedSchema: request.params.requestedSchema });
    });
    const base = this.options.fetchImpl ?? fetch;
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      // Per-request, not per-connection and not per call. A Cognito token lives
      // about an hour and a booking conversation can outlast one; minting here
      // means the refresh happens inside the token source and nothing above it
      // notices. Pinned by "mints a bearer for every HTTP request" in
      // `mcp.test.ts`, which counts calls to the token source with a spy — the
      // count is decided entirely on this side of the socket, so it needs no
      // live endpoint. What a deployed run still has to add is that a real
      // rotation is honoured end to end, not that this is re-read per request.
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('authorization', `Bearer ${await this.options.token()}`);
        const started = Date.now();
        try {
          const response = await base(input, { ...init, headers });
          this.recordOutbound(init?.body, started, response.status);
          return response;
        } catch (error) {
          this.recordOutbound(init?.body, started, null);
          throw error;
        }
      }
    });
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
  }

  /**
   * Looks the runtime up by name and moves to wherever it is now.
   *
   * The bridge's `healAddress()`, reused for the same reason: AgentCore
   * generates a runtime's id at create time and offers no alias layer, so the
   * URL held since startup is correct only until the runtime is next recreated
   * and nothing announces when that happened (FL-038). Run before every
   * rebuild rather than only on a 404 that carried no session, because the
   * lookup is idempotent and a branch that fires only on the rarer of two
   * 404s is a branch no test in this repository can reach.
   */
  private async healAddress(): Promise<void> {
    if (!this.options.resolveUrl) return;
    const next = await this.options.resolveUrl();
    if (next === this.url) return;
    this.log(`the runtime moved: it now answers at ${next} rather than at ${this.url}`);
    this.url = next;
  }

  private require(): Client {
    if (!this.client) throw new Error('the MCP client is not connected; call connect() first');
    return this.client;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = await this.require().listTools();
    return toDescriptors(result.tools as ReadonlyArray<{ name: string; description?: string | undefined; inputSchema: unknown; _meta?: unknown }>);
  }

  /**
   * Calls one tool, repairing at most once.
   *
   * The replay is safe for the calls that can hit it, and the reason is the
   * failure itself: a 404 from the session lookup and a 401 from the
   * authoriser both mean the request was rejected before any handler ran, so
   * nothing was written and re-sending cannot double-apply. `mayRetry` is the
   * entire loop guard and it is cleared on the replay, so one call makes at
   * most one repair and at most two attempts — a runtime that is genuinely
   * gone, or a credential that is genuinely wrong, is never papered over by a
   * retry that keeps trying.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (p: { progress: number; total?: number; message?: string }) => void
  ): Promise<unknown> {
    return this.attempt(name, args, onProgress, true);
  }

  private async attempt(
    name: string,
    args: Record<string, unknown>,
    onProgress: ((p: { progress: number; total?: number; message?: string }) => void) | undefined,
    mayRetry: boolean
  ): Promise<unknown> {
    try {
      return await this.require().callTool(
        { name, arguments: args },
        undefined,
        onProgress
          ? {
              onprogress: progress => {
                this.record({ at: Date.now(), direction: 'in', method: 'notifications/progress', id: null, ms: null, status: null });
                onProgress(progress);
              }
            }
          : undefined
      );
    } catch (error) {
      if (!mayRetry) throw error;
      // Order matters. A refused bearer is fixed by a fresh bearer and NOT by
      // a new session, so it is tested first and repaired without touching the
      // session — rebuilding here would burn the conversation's history for a
      // problem that has nothing to do with it.
      if (isUnauthorizedError(error)) {
        this.options.invalidateToken?.();
        this.log('the endpoint refused the bearer; dropped the cached token and replaying the call once');
        return this.attempt(name, args, onProgress, false);
      }
      if (!isLostSessionError(error)) throw error;
      this.rebuildCount += 1;
      this.log('the runtime instance holding the MCP session was gone; re-resolved the runtime, re-established a session and replaying the call once');
      await this.healAddress();
      await this.connect();
      return this.attempt(name, args, onProgress, false);
    }
  }

  /** Reads a `ui://` widget, or any other resource, as text. Rejects rather than returning '' when there is no text part. */
  async readResource(uri: string): Promise<string> {
    const result = await this.require().readResource({ uri });
    for (const entry of result.contents) {
      const text = (entry as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
    throw new Error(`resource ${uri} carries no text content`);
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    if (!client) return;
    try {
      await client.close();
    } catch {
      /* a transport that is already gone is exactly the state close() wanted */
    }
  }
}
