/** Longest slice of an upstream error body repeated back to the operator. */
const MAX_BODY = 400;

/**
 * Turns an HTTP failure from the AgentCore invocation endpoint into a sentence
 * that names the likely cause and what to do about it.
 *
 * Every branch here corresponds to a failure this project has actually seen or
 * that its architecture makes reachable; the default branch is deliberately
 * plain rather than speculative. The status is always included because it is
 * the one fact that is never a guess.
 */
export function explainUpstreamFailure(status: number, body: string): string {
  const snippet = body.slice(0, MAX_BODY).trim();
  const tail = snippet ? ` Endpoint said: ${snippet}` : '';
  if (status === 401)
    return `AgentCore rejected the bearer token (401). The Cognito client-credentials grant succeeded, so the token exists but the runtime's JWT authorizer refused it — check that HOMELEDGER_COGNITO_CLIENT_ID is the client id in the runtime's allowed list and that HOMELEDGER_COGNITO_SCOPE matches the resource server scope.${tail}`;
  if (status === 403 && (snippet.includes('-32010') || snippet.toLowerCase().includes('from runtime')))
    return `The runtime itself answered 403 and AgentCore wrapped it as -32010 (403). That is the container rejecting the request, not the authorizer — historically the Host-header allowlist (FRICTION-LOG.md FL-020). Check the runtime's CloudWatch logs for a request-rejected line.${tail}`;
  if (status === 403)
    return `AgentCore returned 403 for this invocation. The token was accepted but the caller is not permitted to invoke this runtime qualifier.${tail}`;
  if (status === 404 && (snippet.includes('-32001') || snippet.toLowerCase().includes('session not found')))
    return `The runtime no longer holds this MCP session (404 / -32001). AgentCore routed the request to a different runtime instance than the one that created the session; the 2025-era session map lives in that instance's memory (FRICTION-LOG.md FL-022). Restart the MCP connection — in Claude Code, \`/mcp\` then reconnect homeledger.${tail}`;
  if (status === 404)
    return `AgentCore returned 404 for the invocation URL. Confirm HOMELEDGER_RUNTIME_ARN (or HOMELEDGER_MCP_URL) names a runtime that still exists.${tail}`;
  if (status === 424)
    return `AgentCore reported the runtime failed to handle the request (424). This is usually a container crash or a cold start that timed out; check the runtime's CloudWatch logs.${tail}`;
  if (status === 429) return `AgentCore throttled this request (429). Slow down and retry.${tail}`;
  if (status >= 500)
    return `AgentCore or the runtime returned ${status}. This is upstream of the bridge; retry, then check the runtime's CloudWatch logs.${tail}`;
  return `The AgentCore invocation endpoint returned HTTP ${status}.${tail}`;
}
