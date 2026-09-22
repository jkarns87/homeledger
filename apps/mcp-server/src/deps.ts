import { randomBytes } from 'node:crypto';
import {
  SAMPLE_MANUAL_PASSAGES,
  createDynamoRepository,
  createFixtureRetriever,
  createKnowledgeBaseRetriever,
  createMemoryRepository,
  isIanaTimeZone,
  seedRepository,
  timeZoneDataProblem,
  type ManualRetriever,
  type Repository
} from '@homeledger/core';
import type { ServerDeps } from './server.js';

const MIN_REQUEST_STATE_KEY_BYTES = 32;

/**
 * What a household with no usable zone renders in.
 *
 * UTC, and SAID OUT LOUD as UTC by every caller, because `speakZonedClock`
 * always prints the zone abbreviation. That is deliberately the one honest
 * fallback: the old bug was not that times were UTC, it was that UTC times
 * were presented as if they were the household's. A misconfigured household
 * hears "1:00 PM UTC" - visibly wrong, and traceable - rather than "1:00 PM"
 * implying a kitchen clock that says something else.
 */
export const FALLBACK_TIME_ZONE = 'UTC';

/**
 * The household's zone, or `FALLBACK_TIME_ZONE` with a structured log line
 * naming why.
 *
 * `putHousehold` parses `HouseholdSchema`, so a zone written through this
 * codebase is already valid. This read-side check covers what that cannot: a
 * partition seeded before the field existed (the deployed demo table is
 * exactly that until `seed:remote` runs again), a row hand-edited in the
 * console, and a household that has not been seeded at all. None of those may
 * take the server down - eight tools that have nothing to do with the clock
 * still have to answer - so the read degrades visibly while the WRITE stays
 * strict.
 */
export async function resolveHouseholdTimeZone(repo: Repository): Promise<string> {
  const household = await repo.getHousehold();
  if (!household) {
    console.log(JSON.stringify({ msg: 'household-timezone', zone: FALLBACK_TIME_ZONE, reason: 'no household record' }));
    return FALLBACK_TIME_ZONE;
  }
  // Read back as unknown: the row came out of DynamoDB, where nothing enforces
  // the type the Repository signature claims, so `timezone` really can be
  // absent on a row written before this field existed.
  const zone: unknown = (household as { timezone?: unknown }).timezone;
  if (typeof zone !== 'string' || !isIanaTimeZone(zone)) {
    console.log(JSON.stringify({ msg: 'household-timezone', zone: FALLBACK_TIME_ZONE, reason: 'household timezone unusable', found: zone ?? null }));
    return FALLBACK_TIME_ZONE;
  }
  return zone;
}

/**
 * Memoised per process: every tool that speaks a time needs the zone, and the
 * household record changes about never, so paying a DynamoDB read per tool
 * call would spend the timing budget (spec 4.6) on a constant. A rejected
 * lookup is NOT cached - a DynamoDB blip must not pin the wrong answer for the
 * life of the microVM.
 */
export function memoiseTimeZone(load: () => Promise<string>): () => Promise<string> {
  let inflight: Promise<string> | undefined;
  return () => {
    inflight ??= load().catch(err => {
      inflight = undefined;
      throw err;
    });
    return inflight;
  };
}

function resolveRequestStateKey(env: NodeJS.ProcessEnv): string {
  const configured = env.REQUEST_STATE_KEY;
  // `configured !== undefined` (rather than the truthiness of `configured`)
  // so an explicitly-set-but-empty REQUEST_STATE_KEY="" is treated as a
  // deployment misconfiguration and throws, the same as a too-short value,
  // instead of silently falling through to a generated per-process key.
  if (configured !== undefined) {
    if (Buffer.byteLength(configured, 'utf8') >= MIN_REQUEST_STATE_KEY_BYTES) return configured;
    throw new Error(`REQUEST_STATE_KEY must be at least ${MIN_REQUEST_STATE_KEY_BYTES} bytes`);
  }
  // No configured key: mint a per-process one. Multi round-trip rounds that
  // land on a different microVM than the one that minted the state are then
  // rejected with -32602 and the client restarts the flow. Acceptable for
  // local runs; Terraform sets REQUEST_STATE_KEY on the deployed runtime.
  const generated = randomBytes(32).toString('base64url');
  console.log(JSON.stringify({ msg: 'request-state-key-generated', reason: 'REQUEST_STATE_KEY unset', scope: 'process' }));
  return generated;
}

function resolveRetriever(env: NodeJS.ProcessEnv): ManualRetriever {
  const knowledgeBaseId = env.KNOWLEDGE_BASE_ID;
  if (!knowledgeBaseId) {
    console.log(JSON.stringify({ msg: 'retriever', kind: 'fixture', reason: 'KNOWLEDGE_BASE_ID unset' }));
    return createFixtureRetriever(SAMPLE_MANUAL_PASSAGES);
  }
  console.log(JSON.stringify({ msg: 'retriever', kind: 'knowledge-base', knowledgeBaseId }));
  return createKnowledgeBaseRetriever({ knowledgeBaseId, region: env.AWS_REGION });
}

export async function depsFromEnv(env: NodeJS.ProcessEnv): Promise<ServerDeps> {
  const householdId = env.HOUSEHOLD_ID;
  if (!householdId) throw new Error('HOUSEHOLD_ID is required');
  // Before anything else, and fatal. A Node without IANA time-zone data does
  // not throw on `{ timeZone }` - it ignores the option - so on such an image
  // every "localised" time in this server would silently be the UTC time
  // wearing the household's zone name, and the zone validator would accept any
  // string at all. Better a container that refuses to start with one sentence
  // saying why than one that serves plausible, wrong clock times. FL-040.
  const icu = timeZoneDataProblem();
  if (icu) throw new Error(`${icu} Rebuild the image on a Node with full ICU (the official node:22 images have it) or install a full-icu data package.`);
  const devTools = env.HOMELEDGER_DEV_TOOLS === '1';
  const now = () => new Date().toISOString();
  const retriever = resolveRetriever(env);
  const requestStateKey = resolveRequestStateKey(env);
  const availabilityDelayMs = Number(env.AVAILABILITY_DELAY_MS ?? 600);
  const common = { now, devTools, retriever, requestStateKey, availabilityDelayMs };
  const withZone = (repo: Repository): ServerDeps => ({ repo, householdTimeZone: memoiseTimeZone(() => resolveHouseholdTimeZone(repo)), ...common });
  if (env.MEMORY_REPO === '1') {
    const repo = createMemoryRepository(householdId);
    await seedRepository(repo, householdId, now().slice(0, 10));
    return withZone(repo);
  }
  const tableName = env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME is required unless MEMORY_REPO=1');
  const repo = createDynamoRepository({ tableName, householdId, endpoint: env.DYNAMO_ENDPOINT, region: env.AWS_REGION });
  return withZone(repo);
}
