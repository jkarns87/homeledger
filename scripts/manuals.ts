import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  BedrockAgentClient,
  GetIngestionJobCommand,
  StartIngestionJobCommand,
  type GetIngestionJobCommandOutput,
  type StartIngestionJobCommandOutput
} from '@aws-sdk/client-bedrock-agent';
import { PutObjectCommand, S3Client, type PutObjectCommandOutput } from '@aws-sdk/client-s3';
import { APPLIANCE_ID_METADATA_KEY, createDynamoRepository, derivedId, type Repository } from '@homeledger/core';

const need = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** The single S3 method uploadManual needs. Narrowing keeps tests free of the SDK's overloaded generic send() signature. */
export interface ManualsBucketSender {
  send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
}

/** The two BedrockAgent (control-plane) methods uploadManual needs. */
export interface IngestionSender {
  send(command: StartIngestionJobCommand): Promise<StartIngestionJobCommandOutput>;
  send(command: GetIngestionJobCommand): Promise<GetIngestionJobCommandOutput>;
}

export interface ManualMetadataSidecar {
  metadataAttributes: Record<string, string>;
}

/**
 * Builds the `<key>.metadata.json` sidecar Bedrock reads beside the PDF
 * object; it attaches every `metadataAttributes` entry to each chunk it
 * derives from that document.
 *
 * `APPLIANCE_ID_METADATA_KEY` is imported from `@homeledger/core` rather
 * than retyped here because it is the exact key
 * `createKnowledgeBaseRetriever`'s equals-filter matches on (see
 * `packages/core/src/retrieval/bedrock.ts`) — importing the constant means
 * a rename on either side breaks a test instead of silently drifting apart
 * in production.
 *
 * `title` is a plain author-supplied attribute, not one of the reserved
 * `x-amz-bedrock-kb-*` keys the service populates automatically (see
 * `PAGE_METADATA_KEY`/`SOURCE_URI_METADATA_KEY` in bedrock.ts and the AWS
 * docs cited there). It must be written here because
 * `createKnowledgeBaseRetriever`'s `titleOf()` reads `metadata.title` first
 * and only falls back to deriving a title from the source URI's filename
 * (e.g. `doc_xxxxxxxxxxxxxxxx.pdf`) when it is absent.
 */
export function buildManualMetadata(applianceId: string, title: string): ManualMetadataSidecar {
  return { metadataAttributes: { [APPLIANCE_ID_METADATA_KEY]: applianceId, title } };
}

export interface UploadManualOptions {
  applianceId: string;
  title: string;
  pdf: Uint8Array;
  pages: number | null;
  region: string;
  householdId: string;
  tableName: string;
  bucket: string;
  knowledgeBaseId: string;
  dataSourceId: string;
  /** Ingestion polling budget. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Overridable for tests; default to real AWS SDK clients / the Dynamo repository. */
  s3?: ManualsBucketSender;
  agent?: IngestionSender;
  repo?: Pick<Repository, 'getAppliance' | 'putAppliance' | 'putDoc'>;
}

const TERMINAL_STATUSES = new Set(['COMPLETE', 'FAILED', 'STOPPED']);

export async function uploadManual(options: UploadManualOptions): Promise<{ docId: string; s3Key: string; ingestionJobId: string; status: string }> {
  // Deterministic, not random: the domain model gives each appliance a
  // single manualDocId, so re-running this script for the same appliance
  // (a retry after a mid-run failure, or a deliberate re-upload of a
  // corrected manual) should replace that appliance's one manual in place
  // rather than accumulate orphaned S3 objects, stuck-pending DOC# rows, and
  // duplicate chunks the applianceId filter would then return alongside the
  // current manual.
  const docId = derivedId('doc', options.applianceId);
  const s3Key = `manuals/${options.householdId}/${docId}.pdf`;
  const s3: ManualsBucketSender = options.s3 ?? new S3Client({ region: options.region });
  const agent: IngestionSender = options.agent ?? new BedrockAgentClient({ region: options.region });
  const repo = options.repo ?? createDynamoRepository({ tableName: options.tableName, householdId: options.householdId, region: options.region });

  const metadata = buildManualMetadata(options.applianceId, options.title);

  await s3.send(new PutObjectCommand({ Bucket: options.bucket, Key: s3Key, Body: options.pdf, ContentType: 'application/pdf' }));
  await s3.send(
    new PutObjectCommand({
      Bucket: options.bucket,
      Key: `${s3Key}.metadata.json`,
      Body: JSON.stringify(metadata),
      ContentType: 'application/json'
    })
  );
  console.log(`uploaded s3://${options.bucket}/${s3Key}`);

  await repo.putDoc({
    id: docId,
    applianceId: options.applianceId,
    title: options.title,
    s3Key,
    pages: options.pages,
    kbSync: { status: 'pending', at: null }
  });

  const appliance = await repo.getAppliance(options.applianceId);
  if (!appliance) throw new Error(`appliance ${options.applianceId} not found in ${options.tableName}`);
  await repo.putAppliance({ ...appliance, manualDocId: docId });

  const started = await agent.send(
    new StartIngestionJobCommand({
      knowledgeBaseId: options.knowledgeBaseId,
      dataSourceId: options.dataSourceId,
      description: `HomeLedger manual ${docId}`
    })
  );
  const ingestionJobId = started.ingestionJob?.ingestionJobId;
  if (!ingestionJobId) throw new Error('StartIngestionJob returned no ingestionJobId');
  console.log(`ingestion job ${ingestionJobId} started`);

  const timeoutMs = options.timeoutMs ?? 600_000;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let status = started.ingestionJob?.status ?? 'STARTING';
  let failureReasons: string[] = [];
  while (!TERMINAL_STATUSES.has(status)) {
    if (Date.now() > deadline) throw new Error(`ingestion job ${ingestionJobId} still ${status} after ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    const polled = await agent.send(
      new GetIngestionJobCommand({ knowledgeBaseId: options.knowledgeBaseId, dataSourceId: options.dataSourceId, ingestionJobId })
    );
    status = polled.ingestionJob?.status ?? status;
    failureReasons = polled.ingestionJob?.failureReasons ?? [];
    console.log(`ingestion job ${ingestionJobId}: ${status}`);
  }

  // Written unconditionally, synced or failed, so the DOC# row never sits at
  // kbSync.status 'pending' forever once a terminal status is known — and a
  // failed job is recorded as failed, not silently left looking unfinished.
  await repo.putDoc({
    id: docId,
    applianceId: options.applianceId,
    title: options.title,
    s3Key,
    pages: options.pages,
    kbSync: { status: status === 'COMPLETE' ? 'synced' : 'failed', at: new Date().toISOString() }
  });

  if (status !== 'COMPLETE') throw new Error(`ingestion ${status}: ${failureReasons.join('; ') || 'no reason reported'}`);
  return { docId, s3Key, ingestionJobId, status };
}

// ESM's canonical "am I the entrypoint" check: compare the running module's
// own URL to the URL form of the path Node was invoked with. Works
// identically under `tsx manuals.ts` and `node --import tsx manuals.ts`, and
// is immune to the relative-vs-absolute or separator mismatches a plain
// string/basename comparison of process.argv[1] can fall into.
const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const applianceId = flag('appliance');
  const title = flag('title');
  const file = flag('file');
  if (!applianceId || !title || !file) {
    throw new Error('usage: manuals.ts --appliance <appl_id> --title "<title>" --file <path.pdf> [--pages <n>]');
  }
  const pagesFlag = flag('pages');
  const result = await uploadManual({
    applianceId,
    title,
    pdf: await readFile(file),
    pages: pagesFlag ? Number.parseInt(pagesFlag, 10) : null,
    region: need('AWS_REGION'),
    householdId: need('HOUSEHOLD_ID'),
    tableName: need('TABLE_NAME'),
    bucket: need('MANUALS_BUCKET'),
    knowledgeBaseId: need('KNOWLEDGE_BASE_ID'),
    dataSourceId: need('DATA_SOURCE_ID')
  });
  console.log(result.docId);
}
