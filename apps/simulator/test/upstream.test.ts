import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Covers `resolveUpstream`'s wiring, which the task brief left to Task 6.
 *
 * The brief declined to test `resolveUrl` here on the grounds that a test would
 * "only assert that a closure was called". That is avoidable: a stale address
 * and a fresh one are distinguishable as long as the fixture can change its
 * answer between calls. So the lister below returns one ARN, is then pointed at
 * a different one — exactly what a destroy-and-recreate does to an AgentCore
 * runtime (FL-038) — and `resolveUrl()` has to come back with the second while
 * the `url` captured at resolve time still holds the first. Returning the
 * cached `runtime.url` fails that, which is Step 8's mutation 6, proven here
 * rather than deferred.
 *
 * Only the AWS boundary is faked. `loadConfig`, `resolveRuntime`,
 * `selectUniqueValue`, `resolveClientSecret` and `createTokenSource` all run
 * for real, so what is asserted is the chain this module actually composes and
 * not a restatement of the fixture. `HOMELEDGER_COGNITO_CLIENT_SECRET` in the
 * fixture environment is the bridge's documented CI escape hatch (`secret.ts`),
 * and it keeps Secrets Manager out of the test without mocking it.
 */

const lister = vi.hoisted(() => ({ arn: '', calls: 0, throws: undefined as Error | undefined }));

vi.mock('@homeledger/mcp-bridge/runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@homeledger/mcp-bridge/runtime')>();
  return {
    ...actual,
    createAwsRuntimeLister: async () => ({
      listAgentRuntimes: async () => {
        lister.calls += 1;
        if (lister.throws) throw lister.throws;
        return [
          // A decoy sharing the account but not the name. `selectUniqueValue`
          // matches on the exact name, so a rule that reached for `rows[0]`
          // would pick this one and every URL assertion below would fail.
          { agentRuntimeName: 'some_other_runtime', agentRuntimeArn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/some_other_runtime-ZZZZ9999' },
          { agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: lister.arn }
        ];
      }
    })
  };
});

const { resolveUpstream } = await import('../src/server/credentials.js');

const FIRST_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/demo_homeledger_mcp-AAAA1111';
const RECREATED_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/demo_homeledger_mcp-BBBB2222';

// Written out rather than rebuilt with `invocationUrlFromArn`, so the assertion
// cannot agree with the code by sharing its implementation.
const FIRST_URL =
  'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A111122223333%3Aruntime%2Fdemo_homeledger_mcp-AAAA1111/invocations?qualifier=DEFAULT';
const RECREATED_URL =
  'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A111122223333%3Aruntime%2Fdemo_homeledger_mcp-BBBB2222/invocations?qualifier=DEFAULT';

function env(): NodeJS.ProcessEnv {
  const source: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  return Object.assign(source, {
    AWS_REGION: 'us-east-1',
    HOMELEDGER_COGNITO_TOKEN_URL: 'https://example.invalid/oauth2/token',
    HOMELEDGER_COGNITO_CLIENT_ID: 'client-id-for-the-test',
    HOMELEDGER_COGNITO_CLIENT_SECRET: 'not-a-real-secret-value'
  });
}

let minted = 0;

beforeEach(() => {
  lister.arn = FIRST_ARN;
  lister.calls = 0;
  lister.throws = undefined;
  minted = 0;
  vi.stubGlobal('fetch', async () => {
    minted += 1;
    // Long enough to clear `redact.ts`'s 8-character floor, below which a value
    // is treated as a fragment and deliberately not registered. A real Cognito
    // bearer is hundreds of characters; a 7-character fixture would have made
    // the redaction assertion below unprovable for a reason with no bearing on
    // the code under test.
    return new Response(JSON.stringify({ access_token: `fake-access-token-${minted}`, expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveUpstream', () => {
  it('resolves the runtime by name and builds its invocation URL', async () => {
    const upstream = await resolveUpstream(env());
    expect(upstream.origin).toBe('name');
    expect(upstream.arn).toBe(FIRST_ARN);
    expect(upstream.url).toBe(FIRST_URL);
    expect(lister.calls).toBe(1);
  });

  it('re-resolves by name rather than replaying the address it started with', async () => {
    const upstream = await resolveUpstream(env());
    // The runtime is destroyed and recreated; AgentCore issues a new id and
    // says nothing, so the only way to notice is to look again.
    lister.arn = RECREATED_ARN;
    await expect(upstream.resolveUrl()).resolves.toBe(RECREATED_URL);
    expect(lister.calls).toBe(2);
    // The address captured at resolve time is deliberately left alone: callers
    // decide when to move, and the stale value is what a 404 is diagnosed from.
    expect(upstream.url).toBe(FIRST_URL);
  });

  it('caches a bearer and mints a new one only after invalidateToken', async () => {
    const upstream = await resolveUpstream(env());
    expect(await upstream.token()).toBe('fake-access-token-1');
    expect(await upstream.token()).toBe('fake-access-token-1');
    expect(minted).toBe(1);
    upstream.invalidateToken();
    expect(await upstream.token()).toBe('fake-access-token-2');
    expect(minted).toBe(2);
  });

  it('scrubs the client secret and the bearer out of what it logs on a failure path', async () => {
    // The happy path logs nothing at all, so asserting "no secret in the log"
    // there passes on an empty string and proves nothing — the first draft of
    // this test did exactly that. This drives a path that really does log: a
    // pinned ARN makes `validatePinnedArn` check it against ListAgentRuntimes,
    // and when that check fails the bridge keeps the pin and writes one
    // diagnostic composed from `err.message` verbatim. An SDK that echoed a
    // credential into that message is the leak this is defending against.
    const source = env();
    source.HOMELEDGER_RUNTIME_ARN = FIRST_ARN;
    const lines: string[] = [];
    const upstream = await resolveUpstream(source, m => lines.push(m));
    const bearer = await upstream.token();
    expect(bearer).toBe('fake-access-token-1');

    lister.throws = new Error(`Throttling: retry with client_secret=not-a-real-secret-value and authorization=Bearer ${bearer}`);
    await upstream.resolveUrl();

    const written = lines.join('\n');
    expect(lines, 'nothing was logged, so this test would prove nothing').not.toEqual([]);
    expect(written).toContain('[redacted]');
    expect(written).not.toContain('not-a-real-secret-value');
    expect(written).not.toContain('fake-access-token-1');
  });
});
