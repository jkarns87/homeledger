import { createDynamoRepository, createMemoryRepository, seedRepository } from '@homeledger/core';
import type { ServerDeps } from './server.js';

export async function depsFromEnv(env: NodeJS.ProcessEnv): Promise<ServerDeps> {
  const householdId = env.HOUSEHOLD_ID;
  if (!householdId) throw new Error('HOUSEHOLD_ID is required');
  const devTools = env.HOMELEDGER_DEV_TOOLS === '1';
  const now = () => new Date().toISOString();
  if (env.MEMORY_REPO === '1') {
    const repo = createMemoryRepository(householdId);
    await seedRepository(repo, householdId, now().slice(0, 10));
    return { repo, now, devTools };
  }
  const tableName = env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME is required unless MEMORY_REPO=1');
  const repo = createDynamoRepository({ tableName, householdId, endpoint: env.DYNAMO_ENDPOINT, region: env.AWS_REGION });
  return { repo, now, devTools };
}
