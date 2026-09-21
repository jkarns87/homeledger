import { describe, expect, it } from 'vitest';
import {
  NO_DATA_NOTICE,
  classifyUpstreamFailure,
  explainUpstreamFailure,
  lostSessionMessage,
  missingRuntimeMessage,
  wrappedRuntimeStatus
} from '../src/errors.js';

/** The envelope AgentCore wrapped the owner's failure in, quoted from the client transcript in FL-039. */
const WRAPPED_404 = JSON.stringify({
  jsonrpc: '2.0',
  id: 3,
  error: { code: -32010, message: 'Received error (404) from runtime. Please check your CloudWatch logs for more information.' }
});

/** What `apps/mcp-server/src/legacy.ts` line 50 writes, byte for byte. */
const LOST_SESSION_BODY = JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });

describe('wrappedRuntimeStatus', () => {
  it('reads the container status out of an AgentCore -32010 envelope', () => {
    expect(wrappedRuntimeStatus(WRAPPED_404)).toBe(404);
  });

  it('reads a status other than 404, so the envelope is not special-cased to one number', () => {
    expect(wrappedRuntimeStatus('{"error":{"code":-32010,"message":"Received error (500) from runtime."}}')).toBe(500);
  });

  it('is undefined for a body that is not that envelope, so an ordinary error keeps its own status', () => {
    expect(wrappedRuntimeStatus(LOST_SESSION_BODY)).toBeUndefined();
    expect(wrappedRuntimeStatus('{"message":"Forbidden"}')).toBeUndefined();
  });

  it('is undefined when -32010 appears without a runtime status to read, rather than guessing one', () => {
    expect(wrappedRuntimeStatus('{"error":{"code":-32010,"message":"something else entirely"}}')).toBeUndefined();
  });
});

describe('classifyUpstreamFailure', () => {
  it('calls a 404 after a session was established a lost session', () => {
    expect(classifyUpstreamFailure(404, LOST_SESSION_BODY, true)).toBe('lost-session');
  });

  it('calls a 404 before any session exists a missing runtime', () => {
    // The bridge has not sent an Mcp-Session-Id to anything yet, so the
    // container's one 404 branch is unreachable and this has to be AgentCore.
    expect(classifyUpstreamFailure(404, '', false)).toBe('missing-runtime');
  });

  it('sees through a 2xx carrying AgentCore’s wrapper, which is how this failure actually arrived', () => {
    expect(classifyUpstreamFailure(200, WRAPPED_404, true)).toBe('lost-session');
    expect(classifyUpstreamFailure(200, WRAPPED_404, false)).toBe('missing-runtime');
  });

  it('leaves every other status alone', () => {
    expect(classifyUpstreamFailure(403, '', true)).toBe('other');
    expect(classifyUpstreamFailure(500, '', true)).toBe('other');
    expect(classifyUpstreamFailure(200, '{"result":{}}', true)).toBe('other');
  });
});

describe('the notice every empty-handed error carries', () => {
  it('tells the reader no data was retrieved, in those words', () => {
    expect(NO_DATA_NOTICE).toContain('NO DATA WAS RETRIEVED');
  });

  it('names the two sources a model reached for when this failed for real', () => {
    // Both times, the client answered the owner's question anyway: once from
    // an invented cause, once from the repository's own seed fixtures. Naming
    // them is the point — "be careful" would not have stopped either.
    expect(NO_DATA_NOTICE).toContain('repository fixtures');
    expect(NO_DATA_NOTICE).toContain('memory');
  });

  it('forbids treating the failure as a result, rather than merely describing it', () => {
    expect(NO_DATA_NOTICE).toContain('no result — empty or otherwise — is implied');
  });

  it('rides on both 404 messages, so neither can be read as an empty household', () => {
    expect(lostSessionMessage({ retried: false })).toContain(NO_DATA_NOTICE);
    expect(missingRuntimeMessage(false)).toContain(NO_DATA_NOTICE);
  });
});

describe('lostSessionMessage', () => {
  it('says what broke, why an idle conversation breaks it, and what to do', () => {
    const message = lostSessionMessage({ retried: false });
    expect(message).toContain('The HomeLedger MCP session no longer exists');
    expect(message).toContain('idle');
    expect(message).toContain('/mcp');
  });

  it('distinguishes a failure the bridge already tried to repair from one it did not', () => {
    expect(lostSessionMessage({ retried: true })).toContain('replayed this call once');
    expect(lostSessionMessage({ retried: false })).toContain('could not re-establish an MCP session automatically');
    expect(lostSessionMessage({ retried: false })).not.toContain('replayed this call once');
  });
});

describe('missingRuntimeMessage', () => {
  it('names the rotation, the friction-log entry, and the command that fixes it', () => {
    const message = missingRuntimeMessage(false);
    expect(message).toContain('does not exist (404)');
    expect(message).toContain('FL-038');
    expect(message).toContain('pnpm --filter @homeledger/mcp-bridge run print-setup');
  });

  it('tells the owner that dropping the pinned ARN is the durable fix', () => {
    expect(missingRuntimeMessage(false)).toContain('Removing `-e HOMELEDGER_RUNTIME_ARN`');
  });

  it('says whether the bridge already looked for a replacement', () => {
    expect(missingRuntimeMessage(true)).toContain('re-resolved the runtime by name and retried once');
    expect(missingRuntimeMessage(false)).toContain('did not look for a replacement');
  });
});

describe('explainUpstreamFailure', () => {
  it('never hands back the raw -32010 the owner’s client printed', () => {
    const message = explainUpstreamFailure(200, WRAPPED_404, { hasSession: true });
    expect(message).toContain('The HomeLedger MCP session no longer exists');
    expect(message).toContain('NO DATA WAS RETRIEVED');
  });

  it('explains a 404 after a session as a lost session and a 404 before one as a lost runtime', () => {
    expect(explainUpstreamFailure(404, LOST_SESSION_BODY, { hasSession: true })).toContain('MCP session no longer exists');
    expect(explainUpstreamFailure(404, '', { hasSession: false })).toContain('runtime this bridge is addressing does not exist');
  });

  it('treats the status AgentCore relayed as the real one, rather than the 200 that carried it', () => {
    const message = explainUpstreamFailure(200, '{"error":{"code":-32010,"message":"Received error (500) from runtime."}}', { hasSession: true });
    expect(message).toContain('AgentCore or the runtime returned 500');
    expect(message).not.toContain('HTTP 200');
  });

  it('still explains the failures that have nothing to do with sessions or addresses', () => {
    expect(explainUpstreamFailure(401, '')).toContain('rejected the bearer token (401)');
    expect(explainUpstreamFailure(429, '')).toContain('throttled');
    expect(explainUpstreamFailure(424, '')).toContain('(424)');
    expect(explainUpstreamFailure(418, '')).toContain('HTTP 418');
  });

  it('quotes the endpoint’s own words back, capped, so a surprise is visible without being a wall', () => {
    const long = 'x'.repeat(900);
    const message = explainUpstreamFailure(500, long);
    expect(message).toContain('Endpoint said: ');
    expect(message.length).toBeLessThan(900);
  });
});
