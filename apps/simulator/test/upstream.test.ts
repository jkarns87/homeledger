import { protectSecret } from '@homeledger/mcp-bridge/redact';
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

const { resolveUpstream, scrubError } = await import('../src/server/credentials.js');

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

  // The log callback is one of three ways this module produces output. The
  // other two are rejections, and both of them interpolate `err.message`
  // verbatim somewhere in the bridge: `resolveUrl` through `awsFailureMessage`,
  // `token` through the Cognito error body `token.ts` echoes on purpose.
  it('scrubs a rejection from resolveUrl, without wrapping away the error type', async () => {
    const upstream = await resolveUpstream(env());
    const bearer = await upstream.token();
    const planted = new Error(`Throttling: client_secret=not-a-real-secret-value authorization=Bearer ${bearer}`);
    // Materialise the stack while the message is still raw, which is what any
    // logger or inspector that touches the error first would do. V8 caches the
    // formatted string, so scrubbing `message` alone would leave the credential
    // readable through `err.stack`.
    void planted.stack;
    lister.throws = planted;

    const err = await upstream.resolveUrl().then(
      () => undefined,
      (caught: unknown) => caught
    );
    expect(err, 'resolveUrl resolved when it should have rejected').toBeInstanceOf(Error);
    const error = err as Error;
    expect(error.message).toContain('[redacted]');
    expect(error.message).not.toContain('not-a-real-secret-value');
    expect(error.message).not.toContain(bearer);
    expect(error.stack ?? '').not.toContain('not-a-real-secret-value');
    expect(error.stack ?? '').not.toContain(bearer);
    // Repaired in place rather than replaced, so `instanceof` still works for
    // the bridge's own error classes. DiscoveryError does not set `name`, so
    // the constructor is what identifies it.
    expect(error.constructor.name).toBe('DiscoveryError');
  });

  it('scrubs a rejection from token, which echoes the Cognito error body by design', async () => {
    // Stubbed before `resolveUpstream`, because `createTokenSource` captures
    // `fetch` at construction (`token.ts`: `options.fetchImpl ?? fetch`), so a
    // stub installed afterwards would never be reached.
    vi.stubGlobal('fetch', async () => {
      return new Response('{"error":"invalid_client","hint":"sent client_secret=not-a-real-secret-value"}', {
        status: 401,
        headers: { 'content-type': 'application/json' }
      });
    });
    const upstream = await resolveUpstream(env());

    const err = await upstream.token().then(
      () => undefined,
      (caught: unknown) => caught
    );
    expect(err, 'token() resolved when it should have rejected').toBeInstanceOf(Error);
    const error = err as Error;
    expect(error.message).toContain('[redacted]');
    expect(error.message).not.toContain('not-a-real-secret-value');
    expect(error.constructor.name).toBe('TokenError');
  });
});

describe('the AWS identity resolveUpstream builds', () => {
  // `identity` is internal, so it is asserted through the only thing that
  // renders it: `missingProfileMessage`, which `awsFailureMessage` reaches
  // first of all its branches and which words itself differently depending on
  // `profileFromEnvironment`. Chosen over the expired-session branch on
  // purpose — that one consults `knownProfiles`, which means `createAwsCaller`
  // reads the developer's real ~/.aws/config and the assertion stops being
  // deterministic. `validatePinnedArn` composes its diagnostic directly, with
  // no profile lookup at all.
  const missingProfile = () => new Error('Profile homeledger-admin was not found.');

  it('reports a defaulted profile differently from one the environment named', async () => {
    lister.throws = missingProfile();
    const defaulted: string[] = [];
    const source = env();
    source.HOMELEDGER_RUNTIME_ARN = FIRST_ARN;
    await resolveUpstream(source, m => defaulted.push(m));
    expect(defaulted.join('\n')).toContain('AWS_PROFILE is not set, so this used the default profile homeledger-admin');

    lister.throws = missingProfile();
    const named: string[] = [];
    const fromEnvironment = env();
    fromEnvironment.HOMELEDGER_RUNTIME_ARN = FIRST_ARN;
    fromEnvironment.AWS_PROFILE = 'some-other-profile';
    await resolveUpstream(fromEnvironment, m => named.push(m));
    expect(named.join('\n')).toContain('AWS_PROFILE is set to some-other-profile');
  });

  it('names the resolved profile and region in a failure diagnostic', async () => {
    lister.throws = new Error('Throttling: slow down');
    const lines: string[] = [];
    const source = env();
    source.HOMELEDGER_RUNTIME_ARN = FIRST_ARN;
    await resolveUpstream(source, m => lines.push(m));
    expect(lines.join('\n')).toContain('failed in us-east-1 with profile homeledger-admin');
  });
});

describe('scrubError', () => {
  // Tested directly rather than through `resolveUpstream`, because no path in
  // that module reads an error's stack before scrubbing it — so routed through
  // the module, deleting the `stack` assignment passes. V8 memoises the
  // formatted stack on first read, and reading it here while the message is
  // still raw is what makes the assignment load-bearing.
  it('scrubs a stack that was already materialised while the message was raw', () => {
    protectSecret('pre-materialised-secret-value');
    const err = new Error('the endpoint refused pre-materialised-secret-value');
    const materialised = err.stack ?? '';
    expect(materialised, 'the fixture stack does not carry the secret, so this would prove nothing').toContain('pre-materialised-secret-value');

    const scrubbed = scrubError(err) as Error;
    expect(scrubbed.message).not.toContain('pre-materialised-secret-value');
    expect(scrubbed.stack ?? '').not.toContain('pre-materialised-secret-value');
    expect(scrubbed.stack ?? '').toContain('[redacted]');
  });

  it('follows a cause chain, and survives one that is cyclic', () => {
    protectSecret('nested-cause-secret-value');
    const inner: Error & { cause?: unknown } = new Error('inner carried nested-cause-secret-value');
    const outer: Error & { cause?: unknown } = new Error('outer said nothing');
    outer.cause = inner;
    inner.cause = outer; // a cycle: the depth bound is the only thing that ends this

    scrubError(outer);
    expect(inner.message).not.toContain('nested-cause-secret-value');
    expect(inner.message).toContain('[redacted]');
  });

  it('turns a non-Error throw into a scrubbed Error rather than passing it through', () => {
    protectSecret('thrown-string-secret-value');
    const scrubbed = scrubError('raw throw of thrown-string-secret-value') as Error;
    expect(scrubbed).toBeInstanceOf(Error);
    expect(scrubbed.message).not.toContain('thrown-string-secret-value');
    expect(scrubbed.message).toContain('[redacted]');
  });
});
