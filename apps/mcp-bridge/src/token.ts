import { protectSecret } from './redact.js';

/**
 * How long a freshly minted token may be reused, in milliseconds.
 *
 * Refresh is time-driven rather than 401-driven on purpose: a 401 arrives in
 * the middle of somebody's booking conversation, and even though the bridge
 * recovers from one (see `proxy.ts`), the recovery costs a round trip at the
 * worst possible moment. Three quarters of the lifetime is the normal answer;
 * the five-minute floor takes over for the long tokens Cognito actually issues
 * (3600s -> 45 minutes here, not 55), which leaves a wide margin for a laptop
 * that was asleep. Both branches matter: a short-lived token (<= 400s) has no
 * room for a five-minute margin at all, so the proportional rule is the only
 * one that can produce a usable window, and a zero or negative `expires_in`
 * (a malformed response) yields 0 — meaning "already stale", so every call
 * re-mints rather than reusing a token of unknown life forever.
 */
export function refreshAfterMs(expiresInSeconds: number): number {
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return 0;
  const threeQuarters = expiresInSeconds * 0.75;
  const fiveMinutesEarly = expiresInSeconds - 300;
  const seconds = fiveMinutesEarly > 0 ? Math.min(threeQuarters, fiveMinutesEarly) : threeQuarters;
  return Math.floor(seconds * 1000);
}

export interface TokenSourceOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface TokenSource {
  /** The current access token, minting or refreshing one if the cached token is at or past its refresh deadline. */
  get(): Promise<string>;
  /** Drops the cached token so the next `get()` mints a fresh one. The 401 fallback path. */
  invalidate(): void;
}

/** Longest error body echoed back to the operator. Cognito's failures are a two-field JSON object; anything longer is not a Cognito failure. */
const MAX_ERROR_BODY = 300;

export class TokenError extends Error {}

export function createTokenSource(options: TokenSourceOptions): TokenSource {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  // Built once, held in a closure, and passed straight into the header. It is
  // never interpolated into a message anywhere in this module — and it is
  // registered for redaction so that a future edit which does interpolate it
  // still cannot put it on the wire to the operator.
  const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64');
  protectSecret(options.clientSecret);
  protectSecret(basic);

  let cached: { token: string; refreshAtMs: number } | undefined;
  let inFlight: Promise<string> | undefined;

  const mint = async (): Promise<string> => {
    const requestedAt = now();
    let res: Response;
    try {
      res = await doFetch(options.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: options.scope })
      });
    } catch (err) {
      throw new TokenError(`could not reach the Cognito token endpoint at ${options.tokenUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, MAX_ERROR_BODY);
      throw new TokenError(`Cognito refused the client-credentials grant (HTTP ${res.status})${body ? `: ${body}` : ''}`);
    }
    // Deliberately no body in this branch's messages. A 200 body holds the
    // access token itself, so quoting it is the one place a "helpful" error
    // string would print the very value this file exists to keep out of output.
    let payload: { access_token?: unknown; expires_in?: unknown };
    try {
      payload = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    } catch {
      throw new TokenError('the Cognito token endpoint returned a 200 that was not JSON');
    }
    const token = payload.access_token;
    if (typeof token !== 'string' || token === '') throw new TokenError('the Cognito token endpoint returned a 200 with no access_token');
    protectSecret(token);
    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 0;
    cached = { token, refreshAtMs: requestedAt + refreshAfterMs(expiresIn) };
    return token;
  };

  return {
    async get(): Promise<string> {
      const current = cached;
      if (current && now() < current.refreshAtMs) return current.token;
      // Single-flight. The bridge has several requests in the air at once by
      // design (see proxy.ts), and without this a burst at startup would mint
      // one token per concurrent request.
      if (!inFlight) {
        const pending = mint();
        inFlight = pending;
        void pending
          .catch(() => undefined)
          .finally(() => {
            if (inFlight === pending) inFlight = undefined;
          });
      }
      return inFlight;
    },
    invalidate(): void {
      cached = undefined;
    }
  };
}
