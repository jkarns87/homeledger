import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import type { EventBridgeEvent } from 'aws-lambda';
import { PushPayloadSchema, createDynamoRepository, type PushPayload, type Repository } from '@homeledger/core';
import { requireEnv } from '../env.js';

export type PostToConnection = (connectionId: string, data: string) => Promise<'sent' | 'gone'>;

export function createPoster(client: ApiGatewayManagementApiClient): PostToConnection {
  return async (connectionId, data) => {
    try {
      await client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(data, 'utf8') }));
      return 'sent';
    } catch (err) {
      if ((err as { name?: string }).name === 'GoneException') return 'gone';
      throw err;
    }
  };
}

export async function pushToDisplays(
  deps: { repo: Pick<Repository, 'listConnections' | 'deleteConnection'>; post: PostToConnection; nowEpochSeconds: () => number },
  payload: PushPayload
): Promise<{ sent: number; gone: number }> {
  const data = JSON.stringify(payload);
  const out = { sent: 0, gone: 0 };
  for (const c of await deps.repo.listConnections(deps.nowEpochSeconds())) {
    if ((await deps.post(c.connectionId, data)) === 'gone') {
      await deps.repo.deleteConnection(c.connectionId);
      out.gone += 1;
    } else out.sent += 1;
  }
  return out;
}

/** Target of the rule matching `visit.arrived` and `alert.raised` from `homeledger.events`. A malformed detail throws, so it dead-letters and becomes an alert. */
export const handler = async (event: EventBridgeEvent<string, unknown>): Promise<void> => {
  const payload = PushPayloadSchema.parse(event.detail);
  const repo = createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') });
  const post = createPoster(new ApiGatewayManagementApiClient({ endpoint: requireEnv('PUSH_ENDPOINT') }));
  const out = await pushToDisplays({ repo, post, nowEpochSeconds: () => Math.floor(Date.now() / 1000) }, payload);
  console.log(JSON.stringify({ msg: 'push', cardType: payload.cardType, ...out }));
};
