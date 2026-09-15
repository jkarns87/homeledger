import { createDynamoRepository, seedRepository } from '@homeledger/core';
const tableName = process.env.TABLE_NAME ?? 'homeledger';
const householdId = process.env.HOUSEHOLD_ID ?? 'hh_harlow';
const repo = createDynamoRepository({ tableName, householdId, region: process.env.AWS_REGION });
// Reset the household partition before seeding so repeated runs (e.g. every
// smoke.yml dispatch) are idempotent rather than additive. Appliance ids are
// fixed in packages/core/src/seed/household.ts, so a re-seed alone would now
// overwrite the same items - but this table already accumulated duplicates
// from runs before that fix (FL-023), and resetting also clears any other
// stray data under the partition, so reset unconditionally rather than rely
// on id stability alone.
await repo.resetHousehold();
console.log(await seedRepository(repo, householdId, new Date().toISOString().slice(0, 10)));
