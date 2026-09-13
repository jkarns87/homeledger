import { describe, it } from 'vitest';
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
