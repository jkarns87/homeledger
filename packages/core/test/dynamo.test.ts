import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { createDynamoRepository } from '../src/repo/dynamo.js';
import { ensureTable } from '../src/repo/table.js';
import { runRepositoryContract } from './repository.contract.js';

const endpoint = process.env.DYNAMO_ENDPOINT;

if (!endpoint) {
  describe.skip('Repository contract: dynamo (set DYNAMO_ENDPOINT to run)', () => {
    it('skipped', () => {});
  });
} else {
  let n = 0;
  runRepositoryContract('dynamo', async () => {
    const tableName = `homeledger-test-${Date.now()}-${n++}`;
    await ensureTable({ tableName, endpoint, region: 'us-east-1' });
    return createDynamoRepository({ tableName, householdId: 'hh_test', endpoint, region: 'us-east-1' });
  });
}

// DynamoDB Local does not simulate BatchWriteItem throttling, so
// resetHousehold's UnprocessedItems retry can't be exercised through the
// contract above. These stub the DocumentClient's send() directly and run
// offline, with no DYNAMO_ENDPOINT and no credentials required.
describe('resetHousehold: UnprocessedItems retry (offline, stubbed client)', () => {
  const key = { PK: 'HH#hh_test', SK: 'APPL#appl_offlineoneexample' };

  function stubClient(send: (command: unknown) => Promise<unknown>): DynamoDBDocumentClient {
    return { send } as unknown as DynamoDBDocumentClient;
  }

  it('retries and succeeds once UnprocessedItems clears', async () => {
    const tableName = 'homeledger-test-offline-retry';
    let batchCalls = 0;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof QueryCommand) return { Items: [key], LastEvaluatedKey: undefined };
      if (command instanceof BatchWriteCommand) {
        batchCalls += 1;
        if (batchCalls === 1) return { UnprocessedItems: { [tableName]: [{ DeleteRequest: { Key: key } }] } };
        return { UnprocessedItems: {} };
      }
      throw new Error(`unexpected command in stub: ${command?.constructor?.name}`);
    });
    const repo = createDynamoRepository({ tableName, householdId: 'hh_test', client: stubClient(send) });

    await repo.resetHousehold();

    expect(batchCalls).toBe(2);
  });

  it('throws once UnprocessedItems remain after 5 attempts', async () => {
    const tableName = 'homeledger-test-offline-exhausted';
    let batchCalls = 0;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof QueryCommand) return { Items: [key], LastEvaluatedKey: undefined };
      if (command instanceof BatchWriteCommand) {
        batchCalls += 1;
        return { UnprocessedItems: { [tableName]: [{ DeleteRequest: { Key: key } }] } };
      }
      throw new Error(`unexpected command in stub: ${command?.constructor?.name}`);
    });
    const repo = createDynamoRepository({ tableName, householdId: 'hh_test', client: stubClient(send) });

    await expect(repo.resetHousehold()).rejects.toThrow(/unprocessed/i);
    expect(batchCalls).toBe(5);
  });
});
