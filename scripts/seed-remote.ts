import { createDynamoRepository, seedRepository } from '@homeledger/core';
const tableName = process.env.TABLE_NAME ?? 'homeledger';
const householdId = process.env.HOUSEHOLD_ID ?? 'hh_harlow';
const repo = createDynamoRepository({ tableName, householdId, region: process.env.AWS_REGION });
console.log(await seedRepository(repo, householdId, new Date().toISOString().slice(0, 10)));
