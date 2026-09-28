import { createDynamoRepository, type Repository } from '@homeledger/core';
import { requireEnv } from '../env.js';

/** API Gateway ends every WebSocket at two hours. */
export const CONNECTION_TTL_SECONDS = 7200;

export async function handleConnection(
  deps: { repo: Pick<Repository, 'putConnection' | 'deleteConnection'>; nowMs: () => number },
  event: { requestContext: { routeKey?: string; connectionId?: string } }
): Promise<{ statusCode: number }> {
  const { routeKey, connectionId } = event.requestContext;
  if (!connectionId) return { statusCode: 400 };
  switch (routeKey) {
    // $default is the five-minute keepalive. API Gateway routes it only for a
    // socket that passed $connect's authorizer and is still open, so re-putting
    // the row is correct, and it heals a row a smoke reseed wiped (RUNBOOK §4.7).
    case '$connect':
    case '$default': {
      const now = deps.nowMs();
      await deps.repo.putConnection({ connectionId, connectedAt: new Date(now).toISOString(), expiresAt: Math.floor(now / 1000) + CONNECTION_TTL_SECONDS });
      return { statusCode: 200 };
    }
    case '$disconnect':
      await deps.repo.deleteConnection(connectionId);
      return { statusCode: 200 };
    default:
      return { statusCode: 400 };
  }
}

export const handler = async (event: { requestContext: { routeKey?: string; connectionId?: string } }): Promise<{ statusCode: number }> =>
  handleConnection(
    { repo: createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') }), nowMs: () => Date.now() },
    event
  );
