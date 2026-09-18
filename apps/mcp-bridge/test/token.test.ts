import { afterEach, describe, expect, it } from 'vitest';
import { REDACTION, logDiagnostic, redact, resetProtectedSecrets, setDiagnosticWriter } from '../src/redact.js';
import { TokenError, createTokenSource, refreshAfterMs } from '../src/token.js';

afterEach(() => {
  resetProtectedSecrets();
});

const CLIENT_SECRET = 'cognito-client-secret-do-not-print';
const CLIENT_ID = 'client-id-123';

interface StubOptions {
  tokens?: string[];
  expiresIn?: number;
  status?: number;
  body?: string;
  /** Echoes the request's Authorization header into the error body, modelling a proxy that reflects what it received. */
  echoAuthorization?: boolean;
}

function stubTokenEndpoint(options: StubOptions = {}) {
  const calls: Array<{ authorization: string; body: string }> = [];
  const tokens = options.tokens ?? ['access-token-1', 'access-token-2', 'access-token-3'];
  let index = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');
    calls.push({ authorization, body: String(init?.body ?? '') });
    if (options.status && options.status >= 400) {
      const body = options.echoAuthorization ? `{"error":"invalid_client","seen":"${authorization}"}` : (options.body ?? '{"error":"invalid_client"}');
      return new Response(body, { status: options.status });
    }
    const token = tokens[Math.min(index++, tokens.length - 1)]!;
    return new Response(JSON.stringify({ access_token: token, expires_in: options.expiresIn ?? 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('refreshAfterMs', () => {
  it('refreshes a one-hour token after 45 minutes, not 55', () => {
    // The proportional rule binds here: three quarters of 3600s is earlier than
    // five minutes before expiry, and the earlier of the two is what is used.
    expect(refreshAfterMs(3600)).toBe(2_700_000);
  });

  it('refreshes a ten-minute token five minutes early, where the proportional rule would cut it too fine', () => {
    expect(refreshAfterMs(600)).toBe(300_000);
  });

  it('falls back to the proportional rule for a token too short to hold a five-minute margin', () => {
    expect(refreshAfterMs(60)).toBe(45_000);
  });

  it('treats a missing or nonsensical lifetime as already stale rather than as forever', () => {
    expect(refreshAfterMs(0)).toBe(0);
    expect(refreshAfterMs(-1)).toBe(0);
    expect(refreshAfterMs(Number.NaN)).toBe(0);
  });
});

describe('createTokenSource', () => {
  it('mints once and reuses the token until its refresh deadline', async () => {
    const { fetchImpl, calls } = stubTokenEndpoint({ expiresIn: 3600 });
    let clock = 1_000_000;
    const source = createTokenSource({
      tokenUrl: 'https://token.invalid/oauth2/token',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scope: 'homeledger/mcp',
      fetchImpl,
      now: () => clock
    });

    expect(await source.get()).toBe('access-token-1');
    clock += 2_699_999;
    expect(await source.get()).toBe('access-token-1');
    expect(calls).toHaveLength(1);
  });

  it('mints a new token once the deadline passes, before the old one expires', async () => {
    const { fetchImpl, calls } = stubTokenEndpoint({ expiresIn: 3600 });
    let clock = 1_000_000;
    const source = createTokenSource({
      tokenUrl: 'https://token.invalid/oauth2/token',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scope: 'homeledger/mcp',
      fetchImpl,
      now: () => clock
    });

    expect(await source.get()).toBe('access-token-1');
    clock += 2_700_000;
    expect(await source.get()).toBe('access-token-2');
    expect(calls).toHaveLength(2);
  });

  it('collapses a burst of concurrent callers into one grant request', async () => {
    const { fetchImpl, calls } = stubTokenEndpoint();
    const source = createTokenSource({
      tokenUrl: 'https://token.invalid/oauth2/token',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scope: 'homeledger/mcp',
      fetchImpl
    });
    const results = await Promise.all([source.get(), source.get(), source.get(), source.get()]);
    expect(results).toEqual(['access-token-1', 'access-token-1', 'access-token-1', 'access-token-1']);
    expect(calls).toHaveLength(1);
  });

  it('mints again after invalidate(), which is what the 401 fallback relies on', async () => {
    const { fetchImpl, calls } = stubTokenEndpoint();
    const source = createTokenSource({
      tokenUrl: 'https://token.invalid/oauth2/token',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scope: 'homeledger/mcp',
      fetchImpl
    });
    expect(await source.get()).toBe('access-token-1');
    source.invalidate();
    expect(await source.get()).toBe('access-token-2');
    expect(calls).toHaveLength(2);
  });

  it('recovers from a failed grant instead of caching the rejection forever', async () => {
    let fail = true;
    const fetchImpl = (async () => {
      if (fail) return new Response('{"error":"temporarily_unavailable"}', { status: 503 });
      return new Response(JSON.stringify({ access_token: 'after-recovery', expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const source = createTokenSource({
      tokenUrl: 'https://token.invalid/oauth2/token',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scope: 'homeledger/mcp',
      fetchImpl
    });
    await expect(source.get()).rejects.toBeInstanceOf(TokenError);
    fail = false;
    expect(await source.get()).toBe('after-recovery');
  });

  it('sends the client-credentials grant with the configured scope', async () => {
    const { fetchImpl, calls } = stubTokenEndpoint();
    const source = createTokenSource({
      tokenUrl: 'https://token.invalid/oauth2/token',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scope: 'homeledger/mcp',
      fetchImpl
    });
    await source.get();
    expect(calls[0]?.body).toBe('grant_type=client_credentials&scope=homeledger%2Fmcp');
  });

  it('authenticates with HTTP Basic over the client id and secret', async () => {
    const { fetchImpl, calls } = stubTokenEndpoint();
    const source = createTokenSource({
      tokenUrl: 'https://token.invalid/oauth2/token',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scope: 'homeledger/mcp',
      fetchImpl
    });
    await source.get();
    expect(calls[0]?.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
  });

  it('never lets the secret or the Basic credential reach a diagnostic, even when the endpoint echoes them back', async () => {
    // The strongest form of the "no secret in output" rule this can be tested
    // against offline: a token endpoint that reflects the Authorization header
    // into its error body, so the credential really is inside the error string
    // the bridge is about to print. Registration happens in createTokenSource,
    // redaction at the writer; both have to hold for this to pass.
    const { fetchImpl } = stubTokenEndpoint({ status: 401, echoAuthorization: true });
    const source = createTokenSource({
      tokenUrl: 'https://token.invalid/oauth2/token',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scope: 'homeledger/mcp',
      fetchImpl
    });
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    const lines: string[] = [];
    const previous = setDiagnosticWriter(line => lines.push(line));
    try {
      await source.get().catch((err: unknown) => {
        logDiagnostic(err instanceof Error ? err.message : String(err));
      });
    } finally {
      setDiagnosticWriter(previous);
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(CLIENT_SECRET);
    expect(lines[0]).not.toContain(basic);
    expect(lines[0]).toContain(REDACTION);
    expect(lines[0]).toContain('Cognito refused the client-credentials grant (HTTP 401)');
  });

  it('registers the minted bearer token for redaction too', async () => {
    const { fetchImpl } = stubTokenEndpoint({ tokens: ['bearer-value-that-must-never-be-printed'] });
    const source = createTokenSource({
      tokenUrl: 'https://token.invalid/oauth2/token',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scope: 'homeledger/mcp',
      fetchImpl
    });
    await source.get();
    expect(redact('Authorization: Bearer bearer-value-that-must-never-be-printed')).toBe(`Authorization: Bearer ${REDACTION}`);
  });

  it('says nothing about the response body when a 200 carries no access_token, since that body is where a token would be', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ id_token: 'a-token-under-the-wrong-key' }), { status: 200 })) as unknown as typeof fetch;
    const source = createTokenSource({
      tokenUrl: 'https://token.invalid/oauth2/token',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scope: 'homeledger/mcp',
      fetchImpl
    });
    await expect(source.get()).rejects.toThrow('the Cognito token endpoint returned a 200 with no access_token');
  });

  it('names the endpoint when it cannot be reached at all', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND token.invalid');
    }) as unknown as typeof fetch;
    const source = createTokenSource({
      tokenUrl: 'https://token.invalid/oauth2/token',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scope: 'homeledger/mcp',
      fetchImpl
    });
    await expect(source.get()).rejects.toThrow(/could not reach the Cognito token endpoint at https:\/\/token\.invalid\/oauth2\/token/);
  });
});
