import { createDynamoRepository, ensureTable, seedRepository } from '../src/index.js';

const endpoint = process.env.DYNAMO_ENDPOINT!;
const tableName = process.env.TABLE_NAME ?? 'homeledger';
const householdId = process.env.HOUSEHOLD_ID ?? 'hh_harlow';

try {
  await ensureTable({ tableName, endpoint });
} catch (e) {
  if ((e as { name?: string }).name !== 'ResourceInUseException') throw e;
}

const repo = createDynamoRepository({ tableName, householdId, endpoint });
console.log(await seedRepository(repo, householdId, new Date().toISOString().slice(0, 10)));
