import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createDynamoRepository, derivedId, type Event, type Repository } from '@homeledger/core';
import { RING_SOURCE, createEventPublisher, type EventPublisher } from '../aws/bus.js';
import { createSecretsPort } from '../aws/secrets.js';
import { requireEnv } from '../env.js';
import { decodeWebhook } from '../ring/envelope.js';
import { verifyWebhookSignature } from '../ring/hmac.js';

export interface WebhookDeps {
  hmacKey: () => Promise<string>;
  repo: Pick<Repository, 'claimEvent' | 'markEventPublished' | 'getDevice'>;
  publish: EventPublisher;
  now: () => string;
}

export interface HttpRequest {
  body: string | undefined;
  isBase64Encoded: boolean;
  headers: Record<string, string | undefined>;
}

export interface HttpReply {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

const reply = (statusCode: number, body: Record<string, unknown>): HttpReply => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ msg: 'webhook', ...fields }));

/**
 * Spec §4 in order: verify, decode, dedupe, publish. Inside Ring's 5-second
 * budget because it does nothing slow — the work happens behind the bus.
 */
export async function handleWebhook(deps: WebhookDeps, req: HttpRequest): Promise<HttpReply> {
  const raw = Buffer.from(req.body ?? '', req.isBase64Encoded ? 'base64' : 'utf8');
  let key: string;
  try {
    key = await deps.hmacKey();
  } catch (err) {
    log({ outcome: 'key-unavailable', error: err instanceof Error ? err.message : String(err) });
    return reply(500, { error: 'temporarily unavailable' });
  }
  if (!verifyWebhookSignature(raw, req.headers['x-signature'], key)) {
    log({ outcome: 'bad-signature' });
    return reply(401, { error: 'signature' });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return reply(400, { error: 'body is not JSON' });
  }
  const decoded = decodeWebhook(body, deps.now());
  if (!decoded.ok) return reply(400, { error: decoded.reason });
  const e = decoded.event;

  try {
    const device = e.deviceId ? await deps.repo.getDevice(e.deviceId) : null;
    const deviceName = device?.name ?? (e.deviceId ? 'Ring device' : 'Ring account');
    const row: Event = {
      id: derivedId('evt', e.requestId),
      ringEventId: e.requestId,
      type: e.type,
      subType: e.subType,
      deviceId: e.deviceId ?? `account:${e.accountId ?? 'unknown'}`,
      deviceName,
      at: e.at,
      rawS3Key: null
    };
    const claim = await deps.repo.claimEvent(row);
    if (claim === 'published') {
      log({ outcome: 'duplicate', type: e.type, requestId: e.requestId });
      return reply(200, { status: 'duplicate' });
    }
    await deps.publish([
      {
        source: RING_SOURCE,
        detailType: e.type,
        detail: {
          requestId: e.requestId,
          accountId: e.accountId,
          eventId: e.eventId,
          type: e.type,
          subType: e.subType,
          deviceId: e.deviceId,
          deviceName,
          at: e.at
        }
      }
    ]);
    try {
      await deps.repo.markEventPublished(e.requestId);
    } catch (err) {
      // Published but not marked: a retry would publish again. Every rule
      // downstream is idempotent (conditional arrival, state transitions), so
      // a 200 here is safer than a 500 that guarantees the duplicate.
      log({ outcome: 'published-unmarked', requestId: e.requestId, error: err instanceof Error ? err.message : String(err) });
    }
    // The raw body is logged so the live run can turn real deliveries into
    // fixtures (Plan 4 R10, Task 18). It carries Ring identifiers and a
    // timestamp, never a credential; the signature header is not logged.
    log({ outcome: claim === 'retry' ? 'republished' : 'accepted', type: e.type, requestId: e.requestId, body: raw.toString('utf8').slice(0, 4096) });
    return reply(200, { status: 'accepted' });
  } catch (err) {
    log({ outcome: 'transient-failure', type: e.type, requestId: e.requestId, error: err instanceof Error ? err.message : String(err) });
    return reply(500, { error: 'temporarily unavailable' });
  }
}

let live: WebhookDeps | undefined;
function liveDeps(): WebhookDeps {
  if (live) return live;
  const secrets = createSecretsPort();
  live = {
    hmacKey: () => secrets.read(requireEnv('RING_HMAC_SECRET_ID')),
    repo: createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') }),
    publish: createEventPublisher(requireEnv('EVENT_BUS_NAME')),
    now: () => new Date().toISOString()
  };
  return live;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> =>
  handleWebhook(liveDeps(), { body: event.body, isBase64Encoded: event.isBase64Encoded, headers: event.headers });
