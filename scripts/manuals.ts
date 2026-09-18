import { realpathSync } from 'node:fs';
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
import { APPLIANCE_ID_METADATA_KEY, BEDROCK_ACCOUNT_BLOCK_MESSAGE, createDynamoRepository, derivedId, type Repository } from '@homeledger/core';

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
 * `packages/core/src/retrieval/bedrock.ts`). Importing the shared symbol
 * means the two call sites cannot silently diverge from each other, and it
 * means a literal typed here instead of the import (e.g. 'appliance_id')
 * fails `scripts/test/manuals.test.ts`'s contract test. It does NOT by
 * itself catch a rename of the constant's value, since both sides would
 * move together — that is caught instead by the literal assertion in
 * `packages/core/test/bedrock-retriever.test.ts`, which the scripts
 * contract test also pins independently (see its own comment).
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

/**
 * The exact sentence AWS returns when Bedrock model invocation is refused at
 * the ACCOUNT level (FRICTION-LOG.md FL-019, support case 178941623300459).
 *
 * Defined in `@homeledger/core` (`packages/core/src/retrieval/bedrock.ts`) and
 * re-exported here rather than retyped, for the same reason
 * `APPLIANCE_ID_METADATA_KEY` is imported above: the INGESTION-side matcher in
 * this file and the RETRIEVAL-side classifier in core key on one condition, and
 * two literals would let them silently diverge. See core for why the sentence
 * is scoped to exactly this much of AWS's message.
 *
 * It is NOT just "denied" or "Bedrock" or the `ValidationException` class,
 * which would be too loose: `StartIngestionJob` raises `ValidationException`
 * for a malformed metadata sidecar, an S3 key the data source's prefix does not
 * cover, and a `dataSourceId` that does not belong to the knowledge base. Every
 * one of those is a real bug in this repo and must keep failing the run.
 *
 * This sentence is the one part of the message that states the actual
 * condition — the account cannot invoke Bedrock models at all — and it is
 * the only part that cannot be true for any of those other causes.
 */
export { BEDROCK_ACCOUNT_BLOCK_MESSAGE };

/**
 * True only for the account-wide Bedrock model block, and false for every
 * other ingestion failure.
 *
 * Three conditions, all required:
 *
 *  1. `name === 'ValidationException'` — the error class the Bedrock Agent
 *     control plane raises for this. Duck-typed on `name` rather than
 *     `instanceof ValidationException` on purpose: each AWS SDK v3 client
 *     bundles its own copy of the class, so `instanceof` is unreliable
 *     across client/version boundaries (and across a pnpm store with two
 *     resolutions of the same package), and the AWS SDK's own documented
 *     guidance for v3 error handling is to branch on `name`.
 *  2. HTTP 400 — pins the error to a client-fault response the service
 *     actually returned, not a locally constructed or re-thrown lookalike,
 *     and rules out a 5xx that happened to echo the text.
 *  3. The message contains `BEDROCK_ACCOUNT_BLOCK_MESSAGE`.
 *
 * None of the three is sufficient alone and each removes a distinct class of
 * false positive, which is exactly what the mutation checks in
 * `scripts/test/manuals.test.ts` verify: dropping any one of them makes a
 * test that must stay red go green.
 *
 * The match is case-sensitive. If AWS ever rewords the sentence this returns
 * false and the run fails hard, which is the correct direction to fail: a
 * missed skip costs one red pipeline that a human reads, whereas a matcher
 * loose enough to survive rewording is a matcher that can swallow a genuine
 * ingestion bug silently and forever.
 */
export function isBedrockAccountBlock(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; message?: unknown; $metadata?: { httpStatusCode?: unknown } | null };
  if (candidate.name !== 'ValidationException') return false;
  if (candidate.$metadata?.httpStatusCode !== 400) return false;
  return typeof candidate.message === 'string' && candidate.message.includes(BEDROCK_ACCOUNT_BLOCK_MESSAGE);
}

/**
 * Printed on its own line when ingestion is skipped, so the caller can detect
 * the skip from the log without parsing prose. `.github/workflows/smoke.yml`
 * greps for it anchored (`^...$`) and turns a hit into the
 * `MANUAL_INGESTION_SKIPPED` environment variable the smoke step reads —
 * the same log-sentinel idiom as `SMOKE OK`, and for the same reason: an
 * exit code cannot carry this, because the whole point of the skip is that
 * the exit code is 0 either way.
 */
export const MANUAL_INGESTION_SKIPPED_SENTINEL = 'MANUAL_INGESTION_SKIPPED';

export const MANUAL_INGESTION_SKIP_LINE =
  '\n!! seed:manual: SKIPPED ingestion - the Knowledge Base role cannot call the embedding model because Bedrock model invocation is blocked account-wide (FRICTION-LOG.md FL-019, FL-032). The PDF and its metadata sidecar ARE uploaded and the DOC# row is recorded with kbSync.status "pending"; re-running seed:manual once the block clears ingests them with no re-upload. Nothing about real retrieval is proved by this run.\n';

/** Prints the skip loudly and emits the machine-readable sentinel the workflow greps for. */
export function reportIngestionSkipped(): void {
  console.log(MANUAL_INGESTION_SKIP_LINE);
  console.log(MANUAL_INGESTION_SKIPPED_SENTINEL);
}

/**
 * Discriminated on `ingestion` rather than carrying a nullable job id a
 * caller might forget to check: `tsc` then forces every caller to handle the
 * skipped case before it can read `ingestionJobId` or `status` at all.
 */
export type UploadManualResult =
  | { docId: string; s3Key: string; ingestion: 'complete'; ingestionJobId: string; status: string }
  | { docId: string; s3Key: string; ingestion: 'skipped-bedrock-blocked'; ingestionJobId: null; status: null };

export async function uploadManual(options: UploadManualOptions): Promise<UploadManualResult> {
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

  // Validated before any write, not after: a typo'd --appliance is the
  // likeliest operator error, and derivedId's retry-idempotency cannot heal
  // it — nobody re-runs the command with the same typo — so it must never
  // leave S3 objects or a DOC# row behind for an appliance that doesn't
  // exist.
  const appliance = await repo.getAppliance(options.applianceId);
  if (!appliance) throw new Error(`appliance ${options.applianceId} not found in ${options.tableName}`);
  if (appliance.manualDocId) console.log(`replacing existing manual ${appliance.manualDocId} for appliance ${options.applianceId}`);

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

  await repo.putAppliance({ ...appliance, manualDocId: docId });

  // Only this one call is wrapped, and only for this one condition.
  //
  // Starting the job is where the account-wide Bedrock block bites: the
  // service synchronously has the Knowledge Base role call the Titan
  // embedding model to validate it can, and that invocation is refused
  // before any job id is issued (FL-019, FL-032). Everything before this
  // point — the appliance lookup, both S3 puts, the DOC# write — has already
  // succeeded, and everything after it (polling, terminal status, failure
  // reasons) keeps its original fail-hard behaviour untouched.
  //
  // Deliberately NOT extended to a job that starts and then reaches FAILED
  // carrying the same text in `failureReasons`. That is not the observed
  // shape, and widening the skip to terminal statuses would put it in the
  // same code path as every genuine ingestion failure — a malformed sidecar,
  // an unreadable object — which is precisely the path that must stay red.
  // If AWS ever moves the refusal to job level, this fails hard and someone
  // revisits it deliberately; see `scripts/test/manuals.test.ts`, which pins
  // that scope with a test rather than leaving it to this comment.
  //
  // The uploaded objects and the DOC# row are deliberately LEFT IN PLACE on
  // a skip, not rolled back. The S3 PDF plus its `.metadata.json` sidecar
  // are exactly the input a later ingestion job consumes, so once the block
  // clears a bare StartIngestionJob picks them up with no re-upload; the
  // DOC# row is what `get_appliance` reads for `{docId, title}` and what
  // `appliance.manualDocId` points at, so deleting it would take working
  // functionality away to react to an unrelated external outage. The row is
  // not orphaned residue either — it still carries kbSync.status 'pending'
  // from the write above, which is the honest description of a document that
  // is uploaded and not yet ingested. Contrast the appliance-not-found guard
  // near the top of this function, which writes nothing precisely because
  // that error is permanent and operator-caused; this one is transient and
  // external. derivedId also makes docId and s3Key deterministic, so a
  // re-run replaces in place rather than accumulating — the duplicate-
  // residue risk that would otherwise argue for cleanup does not exist here.
  let started: StartIngestionJobCommandOutput;
  try {
    started = await agent.send(
      new StartIngestionJobCommand({
        knowledgeBaseId: options.knowledgeBaseId,
        dataSourceId: options.dataSourceId,
        description: `HomeLedger manual ${docId}`
      })
    );
  } catch (error) {
    if (!isBedrockAccountBlock(error)) throw error;
    return { docId, s3Key, ingestion: 'skipped-bedrock-blocked', ingestionJobId: null, status: null };
  }

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
  return { docId, s3Key, ingestion: 'complete', ingestionJobId, status };
}

// ESM's canonical "am I the entrypoint" check: compare the running module's
// own URL to the URL form of the path Node was invoked with. Works
// identically under `tsx manuals.ts` and `node --import tsx manuals.ts`, and
// is immune to the relative-vs-absolute or separator mismatches a plain
// string/basename comparison of process.argv[1] can fall into.
//
// realpathSync on process.argv[1] is required, not cosmetic
// (task-13-review.md Finding 2, IMPORTANT): Node's ESM loader resolves
// import.meta.url through symlinks, but process.argv[1] is the path as
// typed. On a symlinked workspace (a self-hosted runner, a container
// bind-mount, macOS /tmp -> /private/tmp) the two disagree without it, this
// whole block is silently skipped, and the process exits 0 having done
// nothing at all. That is the worst outcome for this file in particular: it
// is the operator-facing CLI the README documents, so a silent no-op reads
// as a successful upload.
const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isEntrypoint) {
  const applianceId = flag('appliance');
  const title = flag('title');
  const file = flag('file');
  if (!applianceId || !title || !file) {
    throw new Error('usage: manuals.ts --appliance <appl_id> --title "<title>" --file <path.pdf> [--pages <n>]');
  }
  const pagesFlag = flag('pages');
  const pages = pagesFlag ? Number.parseInt(pagesFlag, 10) : null;
  if (pages !== null && !Number.isInteger(pages)) throw new Error(`--pages must be an integer, got "${pagesFlag}"`);
  const result = await uploadManual({
    applianceId,
    title,
    pdf: await readFile(file),
    pages,
    region: need('AWS_REGION'),
    householdId: need('HOUSEHOLD_ID'),
    tableName: need('TABLE_NAME'),
    bucket: need('MANUALS_BUCKET'),
    knowledgeBaseId: need('KNOWLEDGE_BASE_ID'),
    dataSourceId: need('DATA_SOURCE_ID')
  });
  // No process.exit(0) here or in seed-manual.ts: returning normally from the
  // top-level await already exits 0, and an explicit exit can truncate stdout
  // that has not flushed - which would eat the very sentinel the workflow
  // greps for.
  if (result.ingestion === 'skipped-bedrock-blocked') reportIngestionSkipped();
  console.log(result.docId);
}
