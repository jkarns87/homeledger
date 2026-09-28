/**
 * Ring's OAuth and Partner API, over an injected fetch. Hosts, paths and
 * bodies are from Ring's documentation (amendment §12). Nothing here logs,
 * and no error carries a token, a code, or the client secret.
 */
export const RING_API_BASE = 'https://api.amazonvision.com';
export const RING_OAUTH_TOKEN_URL = 'https://oauth.ring.com/oauth/token';
/** Every Ring request, OAuth and API, gives up after this; a hung call must not hold a Lambda to its timeout. */
export const RING_HTTP_TIMEOUT_MS = 10_000;

export interface RingTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export class RingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string
  ) {
    super(message);
    this.name = 'RingApiError';
  }
}

async function refusalCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { errors?: Array<{ code?: unknown }> };
    const code = body.errors?.[0]?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

async function failure(res: Response, what: string): Promise<RingApiError> {
  const code = await refusalCode(res);
  return new RingApiError(res.status, code, `${what} failed with ${res.status}${code ? ` ${code}` : ''}`);
}

export interface RingOAuth {
  exchangeCode(code: string): Promise<RingTokens>;
  refresh(refreshToken: string): Promise<RingTokens>;
}

export function createRingOAuth(opts: { clientId: string; clientSecret: string; fetch?: typeof fetch; now?: () => number }): RingOAuth {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const grant = async (params: Record<string, string>, what: string): Promise<RingTokens> => {
    const res = await f(RING_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: opts.clientId, client_secret: opts.clientSecret }),
      signal: AbortSignal.timeout(RING_HTTP_TIMEOUT_MS)
    });
    if (!res.ok) throw await failure(res, what);
    const body = (await res.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' || typeof body.expires_in !== 'number')
      throw new RingApiError(res.status, null, `${what} returned an unexpected body`);
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: new Date(now() + body.expires_in * 1000).toISOString() };
  };
  return {
    exchangeCode: code => grant({ grant_type: 'authorization_code', code }, 'The Ring code exchange'),
    refresh: refreshToken => grant({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'The Ring token refresh')
  };
}

export interface RingDeviceSummary {
  id: string;
  name: string;
}

export interface RingDeviceStatus {
  online: boolean;
  flood: boolean | null;
  freeze: boolean | null;
}

export type ImageAnswer = { kind: 'image'; bytes: Buffer; contentType: string | null } | { kind: 'refused'; status: number; code: string | null };

export interface RingApi {
  accountId(): Promise<string>;
  listDevices(): Promise<RingDeviceSummary[]>;
  deviceStatus(deviceId: string): Promise<RingDeviceStatus>;
  confirmLink(nonce: string, accountIdentifier: string): Promise<void>;
  completeLink(accountIdentifier: string): Promise<void>;
  requestImage(deviceId: string, window: { startMs: number; endMs: number }): Promise<ImageAnswer>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const faulted = (v: unknown): boolean | null => (isObj(v) && typeof v.faulted === 'boolean' ? v.faulted : null);

export function createRingApi(opts: { accessToken: () => Promise<string>; fetch?: typeof fetch }): RingApi {
  const f = opts.fetch ?? fetch;
  const call = async (method: string, path: string, what: string, body?: unknown): Promise<Response> => {
    const headers: Record<string, string> = { authorization: `Bearer ${await opts.accessToken()}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await f(`${RING_API_BASE}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(RING_HTTP_TIMEOUT_MS)
    });
    if (!res.ok) throw await failure(res, what);
    return res;
  };
  const device = (id: string) => `/v1/devices/${encodeURIComponent(id)}`;

  return {
    async accountId() {
      const body = (await (await call('GET', '/v1/users/me', 'Reading the Ring account')).json()) as { data?: { id?: unknown } };
      if (typeof body.data?.id !== 'string') throw new RingApiError(200, null, 'Reading the Ring account returned no account id');
      return body.data.id;
    },
    async listDevices() {
      const body = (await (await call('GET', '/v1/devices', 'Listing Ring devices')).json()) as { data?: unknown };
      const rows = Array.isArray(body.data) ? body.data : [];
      return rows
        .filter((d): d is Obj => isObj(d) && typeof d.id === 'string')
        .map(d => ({ id: d.id as string, name: isObj(d.attributes) && typeof d.attributes.name === 'string' ? d.attributes.name : 'Ring device' }));
    },
    async deviceStatus(deviceId) {
      const body = (await (await call('GET', `${device(deviceId)}/status`, 'Reading a Ring device status')).json()) as { data?: { attributes?: unknown } };
      const a = isObj(body.data?.attributes) ? body.data.attributes : {};
      return { online: a.online === true, flood: faulted(a.flood_detection), freeze: faulted(a.freeze_detection) };
    },
    async confirmLink(nonce, accountIdentifier) {
      await call('POST', '/v1/accounts/me/app-integrations', 'Confirming the Ring link', { account_identifier: accountIdentifier, nonce });
    },
    async completeLink(accountIdentifier) {
      await call('PATCH', '/v1/accounts/me/app-integrations', 'Completing the Ring link', { account_identifier: accountIdentifier, status: 'completed' });
    },
    async requestImage(deviceId, window) {
      const res = await f(`${RING_API_BASE}${device(deviceId)}/media/image/download`, {
        method: 'POST',
        redirect: 'manual',
        headers: { authorization: `Bearer ${await opts.accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'latest_in_range', start_timestamp: window.startMs, end_timestamp: window.endMs, image_options: { format: 'jpeg' } }),
        signal: AbortSignal.timeout(RING_HTTP_TIMEOUT_MS)
      });
      let image = res;
      if (res.status === 303) {
        const location = res.headers.get('location');
        if (!location) return { kind: 'refused', status: 303, code: 'NO_LOCATION' };
        // Presigned: no bearer on this leg (amendment §12.5).
        image = await f(location, { method: 'GET', signal: AbortSignal.timeout(RING_HTTP_TIMEOUT_MS) });
      }
      if (image.status !== 200) return { kind: 'refused', status: image.status, code: await refusalCode(image) };
      return { kind: 'image', bytes: Buffer.from(await image.arrayBuffer()), contentType: image.headers.get('content-type') };
    }
  };
}
