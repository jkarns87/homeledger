/** Longest slice of an upstream error body repeated back to the operator. */
const MAX_BODY = 400;

/** Quoted in every remedy so the command is never paraphrased. */
export const PRINT_SETUP_COMMAND = 'pnpm --filter @homeledger/mcp-bridge run print-setup';

/**
 * The paragraph every "this call returned nothing" error carries, addressed to
 * the model that will read it rather than to the person.
 *
 * This is not decoration and it is not defensive writing for its own sake. The
 * failure that produced FL-039 was reported to the owner twice, and on both
 * occasions the client did not report a failure at all: it inferred a plausible
 * cause from a terse transport error, then answered the owner's question from
 * the seed fixtures in the repository and presented that as live household
 * data. A misleading error does not stay misleading — it is laundered into a
 * confident wrong answer, which is strictly worse than a crash, because a crash
 * cannot be mistaken for a result.
 *
 * So the error says the one thing a model cannot safely infer from `-32010`:
 * that the absence of data is the absence of a read, not the result of one.
 */
export const NO_DATA_NOTICE =
  'NO DATA WAS RETRIEVED. This call did not execute, so nothing was read from the household and no result — empty or otherwise — is implied. Do not answer the question from memory, from repository fixtures or seed data, or from any other source: you do not know what this household contains. Report this failure to the user rather than working around it.';

/**
 * The status a runtime returned, when AgentCore is relaying it rather than producing it.
 *
 * AgentCore wraps a non-2xx from the container as a JSON-RPC error with the
 * implementation-defined code -32010 and the literal sentence "Received error
 * (404) from runtime. Please check your CloudWatch logs for more information."
 * Two things follow from that wording and both matter. The status in the
 * parentheses is the *container's*, so it says the request was routed and
 * served — 404 there is the runtime's 404, not AgentCore failing to find the
 * runtime. And AgentCore has been observed delivering this envelope on a 2xx
 * HTTP response as well as on a matching status, which is how the owner's
 * client came to print the raw `-32010` with no bridge diagnostic anywhere near
 * it: `res.ok` was true and the bridge relayed the envelope verbatim.
 */
export function wrappedRuntimeStatus(body: string): number | undefined {
  if (!body.includes('-32010')) return undefined;
  const match = /\((\d{3})\)\s*from runtime/i.exec(body);
  return match ? Number(match[1]) : undefined;
}

/** What a 404 — direct, or wrapped by AgentCore — is actually about. */
export type UpstreamFault = 'lost-session' | 'missing-runtime' | 'other';

/**
 * Sorts a failing response into the two 404s this project can produce, which
 * have nothing in common but their status.
 *
 * `hasSession` is the discriminator and it is the whole of the diagnosis. The
 * HomeLedger container answers 404 in exactly one place — a request carrying an
 * `Mcp-Session-Id` its in-memory map does not hold — so a 404 arriving *after*
 * this process established a session is that, and the address is fine. A 404
 * arriving before any session exists cannot be that, because the bridge has not
 * sent a session id yet; it is AgentCore failing to find the runtime, which is
 * the address being wrong.
 */
export function classifyUpstreamFailure(status: number, body: string, hasSession: boolean): UpstreamFault {
  const effective = wrappedRuntimeStatus(body) ?? status;
  if (effective !== 404) return 'other';
  return hasSession ? 'lost-session' : 'missing-runtime';
}

export interface LostSessionOptions {
  /** True when the bridge re-established a session and the replayed request failed the same way. */
  retried: boolean;
}

/**
 * What the owner and their client read when the runtime instance holding the MCP session is gone.
 *
 * The mechanism is FL-022's, promoted from a best-effort `DELETE` to the
 * critical path: the 2025-era session map lives in one microVM's memory, a
 * Claude Code session is idle for minutes at a time, and AgentCore recycles an
 * idle runtime instance on this stack's 1800-second timeout. Come back after
 * the gap and the request is served by an instance that never saw the session.
 */
export function lostSessionMessage(options: LostSessionOptions): string {
  const recovery = options.retried
    ? 'The bridge re-established an MCP session and replayed this call once; the replay failed the same way, so the problem is not simply a recycled instance.'
    : 'The bridge could not re-establish an MCP session automatically.';
  return [
    'The HomeLedger MCP session no longer exists (404 / -32001 "Session not found"). The request reached an AgentCore runtime instance that does not hold this session: the 2025-era session map lives in one instance\'s memory, and AgentCore recycles an instance that has been idle — this stack\'s idle timeout is 30 minutes — so a conversation that paused between tool calls comes back to an instance that never saw it (FRICTION-LOG.md FL-022, FL-039).',
    recovery,
    NO_DATA_NOTICE,
    'Reconnect the server — `/mcp` in Claude Code, then reconnect homeledger — and run the call again.'
  ].join('\n');
}

/**
 * What the owner and their client read when the address itself names nothing.
 *
 * Reached only when no MCP session was ever established in this process, which
 * is what rules out the far commoner lost-session 404 above.
 */
export function missingRuntimeMessage(healed: boolean): string {
  const resolution = healed
    ? 'The bridge re-resolved the runtime by name and retried once; the retry failed too, so the runtime is missing rather than merely renamed.'
    : 'The bridge is addressing a runtime ARN it was given rather than one it resolved, so it did not look for a replacement.';
  return [
    "The AgentCore runtime this bridge is addressing does not exist (404), and no MCP session had been established, so this is the address and not the session. AgentCore generates a runtime's id when the runtime is created and offers no alias layer, so a runtime that was destroyed and recreated comes back under a different ARN and every address issued before that silently stops resolving (FRICTION-LOG.md FL-038).",
    resolution,
    NO_DATA_NOTICE,
    `Re-run \`${PRINT_SETUP_COMMAND}\` and the \`claude mcp add\` command it prints. Removing \`-e HOMELEDGER_RUNTIME_ARN\` from the entry lets the bridge resolve the runtime by name at every start, which is the form that survives a recreate.`
  ].join('\n');
}

/**
 * Turns an HTTP failure from the AgentCore invocation endpoint into a sentence
 * that names the likely cause and what to do about it.
 *
 * Every branch here corresponds to a failure this project has actually seen or
 * that its architecture makes reachable; the default branch is deliberately
 * plain rather than speculative. The status is always included because it is
 * the one fact that is never a guess.
 */
export interface UpstreamContext {
  /** True when this process holds an MCP session id, which is the whole of what separates a lost session from a missing runtime. */
  hasSession?: boolean;
  /** True when the bridge already made its one repair attempt for this failure and the replayed request failed too. */
  retried?: boolean;
}

export function explainUpstreamFailure(status: number, body: string, context: UpstreamContext = {}): string {
  const snippet = body.slice(0, MAX_BODY).trim();
  const tail = snippet ? ` Endpoint said: ${snippet}` : '';
  const retried = context.retried ?? false;
  const fault = classifyUpstreamFailure(status, snippet, context.hasSession ?? false);
  if (fault === 'lost-session') return `${lostSessionMessage({ retried })}${tail}`;
  if (fault === 'missing-runtime') return `${missingRuntimeMessage(retried)}${tail}`;
  // Below here the status AgentCore relayed from the container, when there is
  // one, stands in for the HTTP status of the envelope that carried it: a 200
  // wrapping "(500) from runtime" is a 500, and saying "HTTP 200" would be true
  // about the transport and useless about the failure.
  const effective = wrappedRuntimeStatus(snippet) ?? status;
  if (effective === 401)
    return `AgentCore rejected the bearer token (401). The Cognito client-credentials grant succeeded, so the token exists but the runtime's JWT authorizer refused it — check that HOMELEDGER_COGNITO_CLIENT_ID is the client id in the runtime's allowed list and that HOMELEDGER_COGNITO_SCOPE matches the resource server scope.${tail}`;
  if (effective === 403 && (snippet.includes('-32010') || snippet.toLowerCase().includes('from runtime')))
    return `The runtime itself answered 403 and AgentCore wrapped it as -32010 (403). That is the container rejecting the request, not the authorizer — historically the Host-header allowlist (FRICTION-LOG.md FL-020). Check the runtime's CloudWatch logs for a request-rejected line.${tail}`;
  if (effective === 403)
    return `AgentCore returned 403 for this invocation. The token was accepted but the caller is not permitted to invoke this runtime qualifier.${tail}`;
  if (effective === 424)
    return `AgentCore reported the runtime failed to handle the request (424). This is usually a container crash or a cold start that timed out; check the runtime's CloudWatch logs.${tail}`;
  if (effective === 429) return `AgentCore throttled this request (429). Slow down and retry.${tail}`;
  if (effective >= 500)
    return `AgentCore or the runtime returned ${effective}. This is upstream of the bridge; retry, then check the runtime's CloudWatch logs.${tail}`;
  return `The AgentCore invocation endpoint returned HTTP ${effective}.${tail}`;
}
