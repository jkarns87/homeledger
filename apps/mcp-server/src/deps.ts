import { randomBytes } from 'node:crypto';
import {
  SAMPLE_MANUAL_PASSAGES,
  createDynamoRepository,
  createFixtureRetriever,
  createKnowledgeBaseRetriever,
  createMemoryRepository,
  seedRepository,
  type ManualRetriever
} from '@homeledger/core';
import type { ServerDeps } from './server.js';

const MIN_REQUEST_STATE_KEY_BYTES = 32;

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
  const devTools = env.HOMELEDGER_DEV_TOOLS === '1';
  const now = () => new Date().toISOString();
  const retriever = resolveRetriever(env);
  const requestStateKey = resolveRequestStateKey(env);
  const availabilityDelayMs = Number(env.AVAILABILITY_DELAY_MS ?? 600);
  const common = { now, devTools, retriever, requestStateKey, availabilityDelayMs };
  if (env.MEMORY_REPO === '1') {
    const repo = createMemoryRepository(householdId);
    await seedRepository(repo, householdId, now().slice(0, 10));
    return { repo, ...common };
  }
  const tableName = env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME is required unless MEMORY_REPO=1');
  const repo = createDynamoRepository({ tableName, householdId, endpoint: env.DYNAMO_ENDPOINT, region: env.AWS_REGION });
  return { repo, ...common };
}
