import { createMemoryRepository, pushPayload } from '@homeledger/core';
import type { ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';
import { describe, expect, it, vi } from 'vitest';
import { createPoster, pushToDisplays } from '../src/handlers/push.js';
import { authorize, bearerFrom } from '../src/handlers/ws-authorizer.js';
import { CONNECTION_TTL_SECONDS, handleConnection } from '../src/handlers/ws-connections.js';

const ARN = 'arn:aws:execute-api:us-east-1:123456789012:abc123/demo/$connect';

describe('push (spec §7: a pointer to every live display)', () => {
  it('sends the pointer to each live connection, forgets a gone one, and skips an expired one', async () => {
    const repo = createMemoryRepository('hh_test');
    await repo.putConnection({ connectionId: 'live=', connectedAt: '2026-10-06T13:00:00.000Z', expiresAt: 2_000 });
    await repo.putConnection({ connectionId: 'gone=', connectedAt: '2026-10-06T13:00:00.000Z', expiresAt: 2_000 });
    await repo.putConnection({ connectionId: 'old=', connectedAt: '2026-10-06T11:00:00.000Z', expiresAt: 1_000 });
    const posted: Array<[string, string]> = [];
    const post = async (id: string, data: string) => {
      posted.push([id, data]);
      return id === 'gone=' ? ('gone' as const) : ('sent' as const);
    };
    const out = await pushToDisplays({ repo, post, nowEpochSeconds: () => 1_500 }, pushPayload('visit.arrived', 'visit_abcdefghijklmnop'));
    expect(out).toEqual({ sent: 1, gone: 1 });
    expect(posted.sort()).toEqual([
      ['gone=', '{"cardType":"visit.arrived","id":"visit_abcdefghijklmnop"}'],
      ['live=', '{"cardType":"visit.arrived","id":"visit_abcdefghijklmnop"}']
    ]);
    expect((await repo.listConnections(1_500)).map(c => c.connectionId)).toEqual(['live=']);
  });

  it('reads API Gateway’s 410 as gone, and anything else as a failure', async () => {
    const gone = {
      send: vi.fn(async () => Promise.reject(Object.assign(new Error('Gone'), { name: 'GoneException' })))
    } as unknown as ApiGatewayManagementApiClient;
    expect(await createPoster(gone)('c1', '{}')).toBe('gone');
    const broken = {
      send: vi.fn(async () => Promise.reject(Object.assign(new Error('Throttled'), { name: 'LimitExceededException' })))
    } as unknown as ApiGatewayManagementApiClient;
    await expect(createPoster(broken)('c1', '{}')).rejects.toThrow('Throttled');
    const ok = { send: vi.fn(async () => ({})) } as unknown as ApiGatewayManagementApiClient & { send: ReturnType<typeof vi.fn> };
    expect(await createPoster(ok)('c1', '{"a":1}')).toBe('sent');
    expect(ok.send.mock.calls[0]![0].input).toEqual({ ConnectionId: 'c1', Data: Buffer.from('{"a":1}', 'utf8') });
  });
});

describe('WebSocket authorizer (spec §7: the Cognito client-credentials JWT)', () => {
  const allowOrDeny = async (headers: Record<string, string | undefined> | undefined, verify: (t: string) => Promise<void> = async () => {}) =>
    (await authorize({ verify }, { headers, methodArn: ARN })).policyDocument.Statement[0]!.Effect;

  it('reads a bearer from the Authorization header, whatever its case', () => {
    expect(bearerFrom({ Authorization: 'Bearer abc.def.ghi' })).toBe('abc.def.ghi');
    expect(bearerFrom({ authorization: 'bearer abc.def.ghi' })).toBe('abc.def.ghi');
    expect(bearerFrom({ authorization: 'Basic abc' })).toBeNull();
    expect(bearerFrom({})).toBeNull();
    expect(bearerFrom(undefined)).toBeNull();
  });

  it('denies a connection with no token or a bad one, and allows exactly this route with a good one', async () => {
    expect(await allowOrDeny(undefined)).toBe('Deny');
    expect(await allowOrDeny({ authorization: 'Bearer bad' }, async () => Promise.reject(new Error('Token expired')))).toBe('Deny');
    const verify = vi.fn(async () => {});
    const result = await authorize({ verify }, { headers: { Authorization: 'Bearer good.jwt.token' }, methodArn: ARN });
    expect(verify).toHaveBeenCalledWith('good.jwt.token');
    expect(result).toEqual({
      principalId: 'homeledger-display',
      policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: ARN }] }
    });
  });
});

describe('connections', () => {
  const at = Date.parse('2026-10-06T13:00:00.000Z');

  it('records a connection with a two-hour expiry and forgets it on disconnect', async () => {
    const repo = createMemoryRepository('hh_test');
    expect(CONNECTION_TTL_SECONDS).toBe(7_200);
    expect(await handleConnection({ repo, nowMs: () => at }, { requestContext: { routeKey: '$connect', connectionId: 'Ab1=' } })).toEqual({ statusCode: 200 });
    expect(await repo.listConnections(at / 1000)).toEqual([{ connectionId: 'Ab1=', connectedAt: '2026-10-06T13:00:00.000Z', expiresAt: at / 1000 + 7_200 }]);
    expect(await handleConnection({ repo, nowMs: () => at }, { requestContext: { routeKey: '$disconnect', connectionId: 'Ab1=' } })).toEqual({
      statusCode: 200
    });
    expect(await repo.listConnections(at / 1000)).toEqual([]);
  });

  it('re-records the connection on every keepalive, so a row a smoke reseed wiped heals within five minutes', async () => {
    // API Gateway routes $default only for a socket that passed $connect's
    // authorizer and is still open, so any id that arrives here is live.
    const repo = createMemoryRepository('hh_test');
    const later = at + 300_000;
    await handleConnection({ repo, nowMs: () => at }, { requestContext: { routeKey: '$connect', connectionId: 'Ab1=' } });
    await repo.resetHousehold();
    expect(await repo.listConnections(at / 1000)).toEqual([]);
    expect(await handleConnection({ repo, nowMs: () => later }, { requestContext: { routeKey: '$default', connectionId: 'Ab1=' } })).toEqual({
      statusCode: 200
    });
    expect(await repo.listConnections(later / 1000)).toEqual([
      { connectionId: 'Ab1=', connectedAt: '2026-10-06T13:05:00.000Z', expiresAt: later / 1000 + 7_200 }
    ]);
  });

  it('refuses a route it does not know', async () => {
    const repo = createMemoryRepository('hh_test');
    expect(await handleConnection({ repo, nowMs: () => at }, { requestContext: { routeKey: 'sendmessage', connectionId: 'Ab1=' } })).toEqual({
      statusCode: 400
    });
  });
});
