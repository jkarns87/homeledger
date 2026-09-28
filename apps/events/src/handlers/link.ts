import { createHash, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createDynamoRepository, type Device } from '@homeledger/core';
import { createSecretsPort } from '../aws/secrets.js';
import { createTokenStore, type TokenStore } from '../aws/tokens.js';
import { requireEnv } from '../env.js';
import { createRingApi, RingApiError, type RingApi } from '../ring/client.js';
import { isFreshLinkTime, verifyLinkNonce } from '../ring/hmac.js';
import { syncDevices } from './device-sync.js';
import type { HttpReply, HttpRequest } from './webhook.js';

export interface LinkDeps {
  hmacKey: () => Promise<string>;
  passphrase: () => Promise<string>;
  store: TokenStore;
  apiFor: (accessToken: string) => Pick<RingApi, 'confirmLink' | 'completeLink' | 'listDevices' | 'deviceStatus'>;
  sync: (api: Pick<RingApi, 'listDevices' | 'deviceStatus'>) => Promise<Device[]>;
  householdId: string;
  nowMs: () => number;
}

const NONCE_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const TIME_SHAPE = /^\d{13}$/;
const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"
};
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ msg: 'link', ...fields }));

/** What Ring shows the owner as the partner account (amendment §12.1): the household, masked. */
export function accountIdentifierFor(householdId: string): string {
  return `${householdId.slice(0, 4)}***${householdId.slice(-1)}`;
}

function page(statusCode: number, title: string, inner: string): HttpReply {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;background:#14181e;color:#f4f5f7}input,button{font:inherit;padding:.5rem;margin:.25rem 0;width:100%}button{cursor:pointer}</style></head><body><h1>${title}</h1>${inner}</body></html>`;
  return { statusCode, headers: HEADERS, body };
}

/** Device names and Ring's refusal codes are text from elsewhere going into HTML. */
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => HTML_ESCAPES[c] ?? c);

function samePassphrase(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function fields(req: HttpRequest & { query: Record<string, string | undefined> }): Record<string, string | undefined> {
  if (req.body === undefined) return req.query;
  const raw = Buffer.from(req.body, req.isBase64Encoded ? 'base64' : 'utf8').toString('utf8');
  return Object.fromEntries(new URLSearchParams(raw));
}

/**
 * The Account Link URL (amendment §12.1 steps 3–5). GET shows the sign-in;
 * POST checks it, matches the nonce to the held tokens, and confirms then
 * completes the link with Ring.
 */
export async function handleLink(deps: LinkDeps, req: HttpRequest & { method: string; query: Record<string, string | undefined> }): Promise<HttpReply> {
  const f = fields(req);
  const nonce = f.nonce ?? '';
  const time = f.time ?? '';
  if (!NONCE_SHAPE.test(nonce) || !TIME_SHAPE.test(time) || !isFreshLinkTime(time, deps.nowMs()))
    return page(400, 'This link has expired', '<p>Start the link again from the Ring app.</p>');

  if (req.method === 'GET') {
    return page(
      200,
      'Link Ring to HomeLedger',
      `<p>Enter the household passphrase to finish linking.</p><form method="post"><input type="hidden" name="nonce" value="${nonce}"><input type="hidden" name="time" value="${time}"><input type="password" name="passphrase" autocomplete="current-password" required><button type="submit">Link</button></form>`
    );
  }

  // The nonce first: only a link Ring signed for the held account may try a
  // passphrase, so a forged link cannot be used to test passphrases.
  const record = await deps.store.read();
  if (!record)
    return page(409, 'Ring has not finished its part yet', '<p>HomeLedger has not received Ring’s authorisation. Start again from the Ring app.</p>');
  if (!verifyLinkNonce(nonce, time, record.accountId, await deps.hmacKey())) {
    log({ outcome: 'nonce-mismatch' });
    return page(400, 'This link does not match', '<p>This link does not belong to the Ring account HomeLedger was given. Start again from the Ring app.</p>');
  }
  if (!samePassphrase(f.passphrase ?? '', await deps.passphrase())) {
    log({ outcome: 'wrong-passphrase' });
    return page(401, 'That passphrase is not right', '<p>Go back and try again.</p>');
  }

  const api = deps.apiFor(record.accessToken);
  const who = accountIdentifierFor(deps.householdId);
  try {
    await api.confirmLink(nonce, who);
    await api.completeLink(who);
  } catch (err) {
    const detail = err instanceof RingApiError ? `${err.status}${err.code ? ` ${err.code}` : ''}` : 'no answer';
    log({ outcome: 'ring-refused', detail });
    return page(502, 'Ring refused the link', `<p>Ring refused the link (${escapeHtml(detail)}). Start again from the Ring app.</p>`);
  }
  await deps.store.write({ ...record, status: 'linked', updatedAt: new Date(deps.nowMs()).toISOString() });
  log({ outcome: 'linked' });

  try {
    const devices = await deps.sync(api);
    const names = escapeHtml(devices.map(d => d.name).join(', '));
    return page(200, 'Linked', `<p>Ring is linked to HomeLedger. Found ${devices.length} device${devices.length === 1 ? '' : 's'}: ${names}.</p>`);
  } catch (err) {
    log({ outcome: 'sync-failed-after-link', error: err instanceof Error ? err.message : String(err) });
    return page(200, 'Linked', '<p>Ring is linked to HomeLedger. The device list will appear within a day.</p>');
  }
}

let live: LinkDeps | undefined;
function liveDeps(): LinkDeps {
  if (live) return live;
  const secrets = createSecretsPort();
  const repo = createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') });
  live = {
    hmacKey: () => secrets.read(requireEnv('RING_HMAC_SECRET_ID')),
    passphrase: () => secrets.read(requireEnv('RING_LINK_PASSPHRASE_SECRET_ID')),
    store: createTokenStore(createSecretsPort(undefined, { ttlMs: 0 }), requireEnv('RING_TOKENS_SECRET_ID')),
    apiFor: token => createRingApi({ accessToken: async () => token }),
    sync: api => syncDevices({ repo, now: () => new Date().toISOString() }, api),
    householdId: requireEnv('HOUSEHOLD_ID'),
    nowMs: () => Date.now()
  };
  return live;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> =>
  handleLink(liveDeps(), {
    method: event.requestContext.http.method,
    query: event.queryStringParameters ?? {},
    body: event.requestContext.http.method === 'POST' ? event.body : undefined,
    isBase64Encoded: event.isBase64Encoded,
    headers: event.headers
  });
