import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createSecretsPort } from '../aws/secrets.js';
import { createTokenStore, type TokenStore } from '../aws/tokens.js';
import { requireEnv } from '../env.js';
import { createRingApi, createRingOAuth, type RingOAuth } from '../ring/client.js';
import type { HttpReply, HttpRequest } from './webhook.js';

export interface TokenExchangeDeps {
  oauth: () => Promise<RingOAuth>;
  accountIdFor: (accessToken: string) => Promise<string>;
  store: TokenStore;
  now: () => string;
}

const reply = (statusCode: number, body: Record<string, unknown>): HttpReply => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ msg: 'token-exchange', ...fields }));

/**
 * The Token Exchange URL (amendment §12.1 step 2). Ring posts the code here
 * and allows sixty seconds to exchange it; the tokens are held unclaimed until
 * the owner signs in at the Account Link URL.
 */
export async function handleTokenExchange(deps: TokenExchangeDeps, req: HttpRequest): Promise<HttpReply> {
  const raw = Buffer.from(req.body ?? '', req.isBase64Encoded ? 'base64' : 'utf8').toString('utf8');
  const code = new URLSearchParams(raw).get('code');
  if (!code) return reply(400, { error: 'missing code' });
  try {
    const tokens = await (await deps.oauth()).exchangeCode(code);
    const accountId = await deps.accountIdFor(tokens.accessToken);
    const existing = await deps.store.read();
    if (existing?.status === 'linked' && existing.accountId !== accountId) {
      log({ outcome: 'second-account-refused' });
      return reply(409, { error: 'another Ring account is already linked' });
    }
    await deps.store.write({ accountId, ...tokens, status: 'unclaimed', updatedAt: deps.now() });
    // expiresAt is a time, not a credential: logged so the live run can record the token lifetime Ring actually grants (spec §3).
    log({ outcome: 'held-unclaimed', expiresAt: tokens.expiresAt });
    return reply(200, { status: 'ok' });
  } catch (err) {
    log({ outcome: 'exchange-failed', error: err instanceof Error ? err.message : String(err) });
    return reply(502, { error: 'token exchange failed' });
  }
}

let live: TokenExchangeDeps | undefined;
function liveDeps(): TokenExchangeDeps {
  if (live) return live;
  const secrets = createSecretsPort();
  live = {
    oauth: async () => createRingOAuth({ clientId: requireEnv('RING_CLIENT_ID'), clientSecret: await secrets.read(requireEnv('RING_CLIENT_SECRET_ID')) }),
    accountIdFor: token => createRingApi({ accessToken: async () => token }).accountId(),
    store: createTokenStore(createSecretsPort(undefined, { ttlMs: 0 }), requireEnv('RING_TOKENS_SECRET_ID')),
    now: () => new Date().toISOString()
  };
  return live;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> =>
  handleTokenExchange(liveDeps(), { body: event.body, isBase64Encoded: event.isBase64Encoded, headers: event.headers });
