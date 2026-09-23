import { redact, resetProtectedSecrets } from '@homeledger/mcp-bridge/redact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The window between reading the client secret and registering it for redaction.
 *
 * This lives in its own file, and the file is the point. `redact`'s registry is
 * a module-global array that never forgets, so the *second* `resolveUpstream`
 * in a process is protected by the first one's registration whatever the
 * ordering inside it. A leak that exists only on the first call is therefore
 * invisible to any test that shares a file with another `resolveUpstream` — it
 * is masked by its neighbours. Vitest isolates modules per test file, and
 * `resetProtectedSecrets()` below makes that explicit rather than assumed.
 *
 * The precondition assertion is what stops this passing for the wrong reason.
 * If the registry were not empty when the test starts, `redact` would already
 * scrub the secret and the real assertion would pass without proving anything;
 * asserting the secret is *not* scrubbed first means a dirty registry fails the
 * test instead of silently satisfying it.
 */

const CLIENT_SECRET = 'first-lookup-secret-value';
const PINNED_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/demo_homeledger_mcp-AAAA1111';

const lister = vi.hoisted(() => ({ throws: undefined as Error | undefined }));

vi.mock('@homeledger/mcp-bridge/runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@homeledger/mcp-bridge/runtime')>();
  return {
    ...actual,
    createAwsRuntimeLister: async () => ({
      listAgentRuntimes: async () => {
        if (lister.throws) throw lister.throws;
        return [{ agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: PINNED_ARN }];
      }
    })
  };
});

const { resolveUpstream } = await import('../src/server/credentials.js');

function env(): NodeJS.ProcessEnv {
  const source: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  return Object.assign(source, {
    AWS_REGION: 'us-east-1',
    HOMELEDGER_COGNITO_TOKEN_URL: 'https://example.invalid/oauth2/token',
    HOMELEDGER_COGNITO_CLIENT_ID: 'client-id-for-the-test',
    // The documented CI and container path (`secret.ts`), where there is no SSO
    // session — so this is the normal configuration there, not an exotic one.
    HOMELEDGER_COGNITO_CLIENT_SECRET: CLIENT_SECRET,
    // A pinned ARN is what makes the *first* lookup log: `validatePinnedArn`
    // checks it against ListAgentRuntimes and, when that check itself fails,
    // keeps the pin and writes one diagnostic built from `err.message`.
    HOMELEDGER_RUNTIME_ARN: PINNED_ARN
  });
}

beforeEach(() => {
  resetProtectedSecrets();
  lister.throws = undefined;
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ access_token: 'fake-access-token-x', expires_in: 3600 }), { status: 200 }));
});

describe('client secret registration order', () => {
  it('has an empty redaction registry to begin with, or the real assertion proves nothing', () => {
    expect(redact(`secret=${CLIENT_SECRET}`)).toBe(`secret=${CLIENT_SECRET}`);
  });

  it('registers the env-supplied client secret before the first runtime lookup can log it', async () => {
    lister.throws = new Error(`Throttling: retry with client_secret=${CLIENT_SECRET}`);
    const lines: string[] = [];
    await resolveUpstream(env(), m => lines.push(m));

    const written = lines.join('\n');
    expect(lines, 'the first lookup logged nothing, so this test would prove nothing').not.toEqual([]);
    expect(written).toContain('[redacted]');
    expect(written).not.toContain(CLIENT_SECRET);
  });
});
