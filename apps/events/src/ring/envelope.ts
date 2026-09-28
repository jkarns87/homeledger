/**
 * A Ring webhook, reduced to what HomeLedger routes on. Total: whatever the
 * body is, the answer is a decoded event or a named reason, never a throw.
 */
export interface RingWebhook {
  requestId: string;
  accountId: string | null;
  eventId: string | null;
  type: string;
  subType: string | null;
  deviceId: string | null;
  at: string;
}

export type DecodeResult = { ok: true; event: RingWebhook } | { ok: false; reason: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

function instant(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === 'string' && v.trim() !== '') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

export function decodeWebhook(body: unknown, receivedAtIso: string): DecodeResult {
  if (!isObj(body)) return { ok: false, reason: 'body is not a JSON object' };
  const meta = isObj(body.meta) ? body.meta : {};
  const requestId = str(meta.request_id);
  if (!requestId) return { ok: false, reason: 'no meta.request_id' };
  const data = isObj(body.data) ? body.data : {};
  const attributes = isObj(data.attributes) ? data.attributes : {};

  // v1.1 names first (amendment §12.3); the research's names as a fallback.
  const dataType = str(data.type);
  const type = (dataType && dataType !== 'event' ? dataType : null) ?? str(attributes.event_type) ?? 'unknown';
  const subType = str(data.subType) ?? str(attributes.sub_type);
  const sourceType = str(attributes.source_type);
  const deviceId = (sourceType === null || sourceType === 'devices' ? str(attributes.source) : null) ?? str(attributes.device_id);
  const at = instant(attributes.timestamp) ?? instant(meta.time) ?? receivedAtIso;

  return { ok: true, event: { requestId, accountId: str(meta.account_id), eventId: str(data.id), type, subType, deviceId, at } };
}
