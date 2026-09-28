import { GetSecretValueCommand, PutSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { PutEventsCommand, type EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { raiseSystemAlert } from '../src/aws/alerts.js';
import { HOMELEDGER_SOURCE, createEventPublisher } from '../src/aws/bus.js';
import { ANTHROPIC_MESSAGES_URL, DESCRIBE_INSTRUCTION, DESCRIBE_TIMEOUT_MS, createAnthropicDescriber, oneSentence } from '../src/aws/describe.js';
import { createSnapshotWriter, snapshotKeyFor } from '../src/aws/objects.js';
import { SecretMissingError, createSecretsPort } from '../src/aws/secrets.js';
import { RingNotLinkedError, createTokenStore, linkedAccessToken, type TokenRecord } from '../src/aws/tokens.js';
import { JPEG_BYTES, fakeFetch, jsonResponse } from './fakes.js';

const stub = <T>(send: (command: unknown) => Promise<unknown>) => ({ send: vi.fn(send) }) as unknown as T & { send: ReturnType<typeof vi.fn> };

describe('secrets port', () => {
  it('reads once per five minutes per secret, and a write is visible without another read', async () => {
    let t = 0;
    const client = stub<SecretsManagerClient>(async cmd => {
      if (cmd instanceof GetSecretValueCommand) return { SecretString: `value-of-${cmd.input.SecretId}` };
      if (cmd instanceof PutSecretValueCommand) return {};
      throw new Error('unexpected');
    });
    const port = createSecretsPort(client, { now: () => t });
    expect(await port.read('a')).toBe('value-of-a');
    t = 299_999;
    expect(await port.read('a')).toBe('value-of-a');
    expect(client.send).toHaveBeenCalledTimes(1);
    t = 300_000;
    await port.read('a');
    expect(client.send).toHaveBeenCalledTimes(2);
    await port.write('a', 'new-value');
    expect((client.send.mock.calls[2]![0] as PutSecretValueCommand).input).toEqual({ SecretId: 'a', SecretString: 'new-value' });
    expect(await port.read('a')).toBe('new-value');
    expect(client.send).toHaveBeenCalledTimes(3);
  });

  it('with ttlMs 0, reads through on every call, so another Lambda’s token write is seen at once', async () => {
    let version = 0;
    const client = stub<SecretsManagerClient>(async cmd => {
      if (cmd instanceof GetSecretValueCommand) return { SecretString: `tokens-v${++version}` };
      throw new Error('unexpected');
    });
    const port = createSecretsPort(client, { now: () => 1_000, ttlMs: 0 });
    expect(await port.read('tokens')).toBe('tokens-v1');
    expect(await port.read('tokens')).toBe('tokens-v2');
    expect(await port.read('tokens')).toBe('tokens-v3');
    expect(client.send).toHaveBeenCalledTimes(3);
  });

  it('reports a secret with no value as missing, naming the secret and nothing else', async () => {
    const client = stub<SecretsManagerClient>(async () => {
      throw Object.assign(new Error("Secrets Manager can't find the specified secret value for staging label: AWSCURRENT"), {
        name: 'ResourceNotFoundException'
      });
    });
    const err = await createSecretsPort(client)
      .read('demo-homeledger/ring/tokens')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretMissingError);
    expect((err as Error).message).toBe('Secret demo-homeledger/ring/tokens has no value.');
  });
});

describe('token store', () => {
  const record: TokenRecord = {
    accountId: 'acct-123',
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: '2026-10-06T17:00:00.000Z',
    status: 'linked',
    updatedAt: '2026-10-06T13:00:00.000Z'
  };
  const memorySecrets = (initial: string | null) => {
    let value = initial;
    return {
      read: async () => {
        if (value === null) throw new SecretMissingError('Secret x has no value.');
        return value;
      },
      write: async (_: string, v: string) => {
        value = v;
      }
    };
  };

  it('round-trips a record as JSON', async () => {
    const store = createTokenStore(memorySecrets(null), 'x');
    expect(await store.read()).toBeNull();
    await store.write(record);
    expect(await store.read()).toEqual(record);
  });

  it('treats an unreadable record as no record rather than a crash', async () => {
    expect(await createTokenStore(memorySecrets('not json'), 'x').read()).toBeNull();
    expect(await createTokenStore(memorySecrets('{"accessToken":"at-1"}'), 'x').read()).toBeNull();
  });

  it('hands out the access token only once the account is linked', async () => {
    await expect(linkedAccessToken(createTokenStore(memorySecrets(null), 'x'))()).rejects.toBeInstanceOf(RingNotLinkedError);
    await expect(linkedAccessToken(createTokenStore(memorySecrets(JSON.stringify({ ...record, status: 'unclaimed' })), 'x'))()).rejects.toBeInstanceOf(
      RingNotLinkedError
    );
    expect(await linkedAccessToken(createTokenStore(memorySecrets(JSON.stringify(record)), 'x'))()).toBe('at-1');
  });
});

describe('event publisher', () => {
  it('puts entries on the named bus and throws if EventBridge refuses any', async () => {
    const ok = stub<EventBridgeClient>(async () => ({ FailedEntryCount: 0, Entries: [{ EventId: 'e1' }] }));
    await createEventPublisher(
      'homeledger',
      ok
    )([{ source: HOMELEDGER_SOURCE, detailType: 'visit.arrived', detail: { cardType: 'visit.arrived', id: 'visit_abcdefghijklmnop' } }]);
    expect((ok.send.mock.calls[0]![0] as PutEventsCommand).input).toEqual({
      Entries: [
        {
          EventBusName: 'homeledger',
          Source: 'homeledger.events',
          DetailType: 'visit.arrived',
          Detail: '{"cardType":"visit.arrived","id":"visit_abcdefghijklmnop"}'
        }
      ]
    });
    const refused = stub<EventBridgeClient>(async () => ({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'InternalFailure' }] }));
    await expect(createEventPublisher('homeledger', refused)([{ source: HOMELEDGER_SOURCE, detailType: 'x', detail: {} }])).rejects.toThrow(
      'EventBridge refused 1 of 1 entries: InternalFailure'
    );
  });
});

describe('snapshot writer', () => {
  it('stores the bytes exactly as received, under the visit’s key', async () => {
    const s3 = stub<S3Client>(async () => ({}));
    await createSnapshotWriter('demo-homeledger-snapshots-123', s3)(snapshotKeyFor('hh_harlow', 'visit_abcdefghijklmnop', 'jpeg'), JPEG_BYTES, 'image/jpeg');
    const input = (s3.send.mock.calls[0]![0] as PutObjectCommand).input;
    expect([input.Bucket, input.Key, input.ContentType]).toEqual([
      'demo-homeledger-snapshots-123',
      'snapshots/hh_harlow/visit_abcdefghijklmnop.jpg',
      'image/jpeg'
    ]);
    expect(input.Body).toBe(JPEG_BYTES);
    expect(snapshotKeyFor('hh_harlow', 'visit_abcdefghijklmnop', 'png')).toBe('snapshots/hh_harlow/visit_abcdefghijklmnop.png');
  });
});

describe('describer (spec §5: Claude vision, one sentence, nobody identified)', () => {
  it('sends the image and the constrained instruction to the Messages API', async () => {
    const f = fakeFetch(() => jsonResponse(200, { content: [{ type: 'text', text: 'A person holding a toolbox stands at the front door.' }] }));
    const describe = createAnthropicDescriber({ apiKey: async () => 'sk-test', model: 'claude-sonnet-5', fetch: f.fetch });
    expect(await describe(JPEG_BYTES, 'image/jpeg')).toBe('A person holding a toolbox stands at the front door.');
    const req = f.calls[0]!;
    expect([req.url, req.method, req.headers['x-api-key'], req.headers['anthropic-version']]).toEqual([
      ANTHROPIC_MESSAGES_URL,
      'POST',
      'sk-test',
      '2023-06-01'
    ]);
    expect(DESCRIBE_TIMEOUT_MS).toBe(20_000);
    expect(req.signal instanceof AbortSignal).toBe(true);
    expect(JSON.parse(req.body!)).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 120,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG_BYTES.toString('base64') } },
            { type: 'text', text: DESCRIBE_INSTRUCTION }
          ]
        }
      ]
    });
  });

  it('forbids identifying anyone, in the instruction itself', () => {
    expect(DESCRIBE_INSTRUCTION).toMatch(/Never identify, name, or guess who anyone is/);
  });

  it('keeps one sentence of whatever comes back', () => {
    expect(oneSentence('  A van is parked at the curb.   A second sentence.')).toBe('A van is parked at the curb.');
    expect(oneSentence('No full stop at all')).toBe('No full stop at all');
  });

  it('fails with the status and never the key', async () => {
    const f = fakeFetch(() => jsonResponse(529, { type: 'error', error: { type: 'overloaded_error' } }));
    const err = await createAnthropicDescriber({ apiKey: async () => 'sk-test', model: 'claude-sonnet-5', fetch: f.fetch })(JPEG_BYTES, 'image/jpeg').catch(
      (e: unknown) => e
    );
    expect((err as Error).message).toBe('The photo description failed with 529 overloaded_error');
  });

  it('fails when the reply holds no text', async () => {
    const f = fakeFetch(() => jsonResponse(200, { content: [] }));
    await expect(createAnthropicDescriber({ apiKey: async () => 'k', model: 'm', fetch: f.fetch })(JPEG_BYTES, 'image/jpeg')).rejects.toThrow(
      'The photo description came back empty'
    );
  });
});

describe('system alerts', () => {
  it('writes an open, high, deviceless alert carrying its own message', async () => {
    const putAlert = vi.fn(async () => {});
    const a = await raiseSystemAlert(
      { repo: { putAlert }, newId: () => 'alert_abcdefghijklmnop', now: () => '2026-10-06T13:00:00.000Z' },
      'Ring access lapsed.'
    );
    expect(a).toEqual({
      id: 'alert_abcdefghijklmnop',
      sensorType: 'system',
      severity: 'high',
      ringDeviceId: null,
      message: 'Ring access lapsed.',
      deviceName: 'HomeLedger',
      at: '2026-10-06T13:00:00.000Z',
      maintenanceRef: null,
      status: 'open'
    });
    expect(putAlert).toHaveBeenCalledWith(a);
  });
});
