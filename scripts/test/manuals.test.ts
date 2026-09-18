import {
  GetIngestionJobCommand,
  StartIngestionJobCommand,
  type GetIngestionJobCommandOutput,
  type IngestionJobStatus,
  type StartIngestionJobCommandOutput
} from '@aws-sdk/client-bedrock-agent';
import type { PutObjectCommand, PutObjectCommandOutput } from '@aws-sdk/client-s3';
import { APPLIANCE_ID_METADATA_KEY, type Appliance, createMemoryRepository, derivedId } from '@homeledger/core';
import { describe, expect, it, vi } from 'vitest';
import {
  BEDROCK_ACCOUNT_BLOCK_MESSAGE,
  buildManualMetadata,
  type IngestionSender,
  isBedrockAccountBlock,
  MANUAL_INGESTION_SKIP_LINE,
  MANUAL_INGESTION_SKIPPED_SENTINEL,
  type ManualsBucketSender,
  reportIngestionSkipped,
  uploadManual
} from '../manuals.js';

const appliance: Appliance = {
  id: 'appl_wwwwwwwwwwwwwwww',
  name: 'LG Washer',
  brand: 'LG',
  model: 'WM4000HWA',
  serial: null,
  room: 'Laundry',
  category: 'laundry',
  purchasedAt: null,
  warrantyUntil: null,
  manualDocId: null,
  templates: []
};

function fakeS3(): { sender: ManualsBucketSender; calls: PutObjectCommand[] } {
  const calls: PutObjectCommand[] = [];
  return {
    calls,
    sender: {
      async send(command: PutObjectCommand): Promise<PutObjectCommandOutput> {
        calls.push(command);
        return { $metadata: {} };
      }
    }
  };
}

/**
 * Returns statuses[0] for the StartIngestionJob call, then statuses[1],
 * statuses[2], ... for each successive GetIngestionJob poll, holding on the
 * last entry once exhausted (so a single-element array models a job that
 * never leaves that status, for the timeout test).
 */
function fakeAgent(
  statuses: IngestionJobStatus[],
  failureReasons: string[] = []
): { sender: IngestionSender; startCalls: () => number; getCalls: () => number } {
  let call = 0;
  let startCalls = 0;
  let getCalls = 0;
  const send = (async (command: StartIngestionJobCommand | GetIngestionJobCommand) => {
    const status = statuses[Math.min(call, statuses.length - 1)];
    call += 1;
    if (command instanceof StartIngestionJobCommand) {
      startCalls += 1;
      return { ingestionJob: { ingestionJobId: 'job-1', status } } as StartIngestionJobCommandOutput;
    }
    getCalls += 1;
    return { ingestionJob: { ingestionJobId: 'job-1', status, failureReasons } } as GetIngestionJobCommandOutput;
  }) as IngestionSender['send'];
  return { sender: { send }, startCalls: () => startCalls, getCalls: () => getCalls };
}

/**
 * The message AWS actually returned on smoke run 35238251562, reproduced
 * verbatim (only the account id is redacted). Tests that need "the real
 * error" use this rather than a hand-trimmed approximation, so the matcher
 * is proven against the string it will genuinely meet - including the
 * account-specific role ARN, the model ARN, the `Error 002` code, and the
 * Java-style `(Service: ..., Status Code: ...)` suffix it must all ignore.
 */
const REAL_BLOCK_MESSAGE =
  'Knowledge base role arn:aws:iam::123456789012:role/demo-homeledger-knowledge-base is not able to call specified bedrock embedding model arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0: Error 002: Access to Bedrock models is not allowed for this account (Service: BedrockRuntime, Status Code: 400)';

/** Builds an error shaped like one the AWS SDK v3 throws: a `name`, a `message`, and `$metadata.httpStatusCode`. */
function awsError(overrides: { name?: string; message?: string; httpStatusCode?: number | undefined } = {}): Error {
  const error = new Error(overrides.message ?? REAL_BLOCK_MESSAGE) as Error & { $metadata?: { httpStatusCode?: number } };
  error.name = overrides.name ?? 'ValidationException';
  error.$metadata = { httpStatusCode: 'httpStatusCode' in overrides ? overrides.httpStatusCode : 400 };
  return error;
}

/** An agent whose StartIngestionJob throws; GetIngestionJob would succeed, so a poll count of 0 proves the start never returned. */
function throwingStartAgent(error: unknown): { sender: IngestionSender; getCalls: () => number } {
  let getCalls = 0;
  const send = (async (command: StartIngestionJobCommand | GetIngestionJobCommand) => {
    if (command instanceof StartIngestionJobCommand) throw error;
    getCalls += 1;
    return { ingestionJob: { ingestionJobId: 'job-1', status: 'COMPLETE' } } as GetIngestionJobCommandOutput;
  }) as IngestionSender['send'];
  return { sender: { send }, getCalls: () => getCalls };
}

function baseOptions() {
  return {
    applianceId: appliance.id,
    title: 'LG WM4000HWA washer owner manual',
    pdf: new Uint8Array([1, 2, 3]),
    pages: 4,
    region: 'us-east-1',
    householdId: 'hh_test',
    tableName: 'homeledger-test',
    bucket: 'homeledger-manuals-test',
    knowledgeBaseId: 'KB123',
    dataSourceId: 'DS123',
    pollIntervalMs: 0
  };
}

describe('buildManualMetadata — cross-task contract with the Bedrock retriever (Task 9)', () => {
  // createKnowledgeBaseRetriever (packages/core/src/retrieval/bedrock.ts)
  // filters with `{ filter: { equals: { key: APPLIANCE_ID_METADATA_KEY, value: applianceId } } }`.
  // buildManualMetadata imports and writes the SAME symbol, so the two call
  // sites cannot silently diverge, and a producer-side literal typed here
  // instead of the import (e.g. 'appliance_id') fails the next test.
  //
  // What this describe block does NOT by itself catch is a rename of the
  // constant's *value*: both sides read one symbol, so they move together
  // and a rename alone leaves every test in this file green. The value is
  // independently anchored by the literal assertion in
  // packages/core/test/bedrock-retriever.test.ts ("adds an equals filter on
  // applianceId when one is supplied"), which asserts the bare string
  // 'applianceId' against the retriever's real filter build — that is the
  // test that actually catches a rename. Do not delete that literal
  // assertion on the theory that this describe block already covers it.
  // The test below closes part of that gap by pinning the value here too.
  it("pins the constant's literal value, so a rename is caught on this side as well", () => {
    expect(APPLIANCE_ID_METADATA_KEY).toBe('applianceId');
  });

  it('writes the exact metadata attribute name the retriever filters on', () => {
    const sidecar = buildManualMetadata(appliance.id, 'LG WM4000HWA washer owner manual');
    expect(sidecar.metadataAttributes[APPLIANCE_ID_METADATA_KEY]).toBe(appliance.id);
  });

  it('also writes title, since the retriever falls back to metadata.title for docTitle', () => {
    const sidecar = buildManualMetadata(appliance.id, 'LG WM4000HWA washer owner manual');
    expect(sidecar.metadataAttributes.title).toBe('LG WM4000HWA washer owner manual');
  });
});

// The detection question the whole fix turns on: too loose and a real
// ingestion bug is swallowed forever and silently; too tight and the skip
// stops working the moment anything incidental about the message moves.
// Each case below removes exactly one of the three conditions
// isBedrockAccountBlock requires, so no condition can be deleted without a
// test going red - the mutation check, expressed as tests rather than left
// to a one-off experiment.
describe('isBedrockAccountBlock', () => {
  it('matches the real error AWS returned on smoke run 35238251562', () => {
    expect(isBedrockAccountBlock(awsError())).toBe(true);
  });

  // Pins the constant's literal value, not just that it is wired: every other
  // case here feeds the matcher a message built from the same source it
  // reads, which proves wiring and not value. If this sentence is ever
  // edited, the matcher silently stops matching the real error.
  it('pins the exact sentence it keys on', () => {
    expect(BEDROCK_ACCOUNT_BLOCK_MESSAGE).toBe('Access to Bedrock models is not allowed for this account');
    expect(REAL_BLOCK_MESSAGE).toContain(BEDROCK_ACCOUNT_BLOCK_MESSAGE);
  });

  // Not too tight: none of the account id, the model ARN, the `Error 002`
  // code, or the `(Service: ...)` suffix may be load-bearing. Re-point the
  // Knowledge Base at a different embedding model in a different region, in
  // a different account, and drop the wrapper AWS is free to reword - the
  // same condition must still be recognised.
  it('still matches when the account, model, region, error code and service suffix all differ', () => {
    const rephrased =
      'Knowledge base role arn:aws:iam::999999999999:role/other-kb is not able to call specified bedrock embedding model arn:aws:bedrock:eu-west-1::foundation-model/cohere.embed-english-v3: Access to Bedrock models is not allowed for this account';
    expect(isBedrockAccountBlock(awsError({ message: rephrased }))).toBe(true);
  });

  // Not too loose, case 1: the message alone is not enough. A differently
  // classed error carrying the same text - a wrapped or re-thrown copy, or a
  // genuine IAM denial that quotes it - is not the account block this skip
  // is scoped to.
  it('does not match when the message is right but the error class is not ValidationException', () => {
    expect(isBedrockAccountBlock(awsError({ name: 'AccessDeniedException' }))).toBe(false);
  });

  // Not too loose, case 2: a 5xx is a service fault, not the deterministic
  // client-side refusal this condition is. Skipping on one would turn a
  // transient Bedrock outage into a silently green smoke.
  it('does not match when the class and message are right but the status is not 400', () => {
    expect(isBedrockAccountBlock(awsError({ httpStatusCode: 500 }))).toBe(false);
    expect(isBedrockAccountBlock(awsError({ httpStatusCode: undefined }))).toBe(false);
  });

  // Not too loose, case 3, and the one the brief calls out by name: these
  // are all real bugs in this repo that StartIngestionJob reports as
  // ValidationException with a 400, and every one of them must keep failing
  // the run. This is what "do not blanket-catch ValidationException" means
  // in practice.
  it.each([
    ['a malformed metadata sidecar', 'The metadata file for s3://bucket/manuals/hh_harlow/doc_x.pdf.metadata.json is not valid JSON'],
    ['an S3 key outside the data source prefix', 'The specified inclusion prefix does not cover the object key manuals/hh_harlow/doc_x.pdf'],
    ['a data source that is not part of the knowledge base', 'Data source DS999 was not found in knowledge base KB123'],
    [
      'an unrelated permissions failure',
      'Knowledge base role arn:aws:iam::123456789012:role/demo-homeledger-knowledge-base is not authorized to perform s3:GetObject'
    ]
  ])('does not match %s, even though it is a 400 ValidationException too', (_label, message) => {
    expect(isBedrockAccountBlock(awsError({ message }))).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a bare string carrying the text', `ValidationException: ${REAL_BLOCK_MESSAGE}`],
    ['a plain Error with the text but no AWS metadata', new Error(REAL_BLOCK_MESSAGE)]
  ])('does not match %s', (_label, value) => {
    expect(isBedrockAccountBlock(value)).toBe(false);
  });
});

describe('the seed:manual skip banner', () => {
  it('is a bare, line-anchored token the workflow can grep for', () => {
    expect(MANUAL_INGESTION_SKIPPED_SENTINEL).toBe('MANUAL_INGESTION_SKIPPED');
    // The prose banner must not itself contain the token, or the workflow's
    // `grep -q '^MANUAL_INGESTION_SKIPPED$'` would start matching prose the
    // moment the banner is reflowed.
    expect(MANUAL_INGESTION_SKIP_LINE).not.toContain(MANUAL_INGESTION_SKIPPED_SENTINEL);
  });

  it('says what was skipped, why, and what was nonetheless left behind', () => {
    expect(MANUAL_INGESTION_SKIP_LINE).toContain('SKIPPED');
    expect(MANUAL_INGESTION_SKIP_LINE).toContain('Bedrock');
    expect(MANUAL_INGESTION_SKIP_LINE).toContain('FL-032');
  });

  // The actual contract with .github/workflows/smoke.yml, which runs
  // `grep -q '^MANUAL_INGESTION_SKIPPED$' seed-manual.log`. Asserting the
  // constant's value is not enough - the anchors mean the token has to land
  // on a line of its very own in real stdout, which a banner change or a
  // stray prefix would break without touching the constant at all.
  it('prints the sentinel on a line of its own, exactly as the workflow greps for it', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      reportIngestionSkipped();
      const lines = spy.mock.calls
        .map(call => String(call[0]))
        .join('\n')
        .split('\n');
      expect(lines.filter(line => new RegExp(`^${MANUAL_INGESTION_SKIPPED_SENTINEL}$`).test(line))).toHaveLength(1);
      // And the loud human-readable banner went out too, not just the token.
      expect(lines.some(line => line.includes('SKIPPED ingestion'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('uploadManual', () => {
  it('uploads the PDF and metadata sidecar, marks the doc synced, and points the appliance at it', async () => {
    const repo = createMemoryRepository('hh_test');
    await repo.putAppliance(appliance);
    const s3 = fakeS3();
    const agent = fakeAgent(['STARTING', 'IN_PROGRESS', 'COMPLETE']);

    const result = await uploadManual({ ...baseOptions(), s3: s3.sender, agent: agent.sender, repo });

    expect(result.status).toBe('COMPLETE');
    // Pinned independently of result.s3Key (not just self-consistency between
    // the two): the household-scoped prefix is what keeps one household's
    // manuals namespaced apart from another's in the shared bucket.
    expect(result.s3Key).toBe(`manuals/hh_test/${result.docId}.pdf`);
    expect(s3.calls).toHaveLength(2);
    // Consistency check only, not a shape guard (the line above already
    // pins the shape independently): confirms the PDF was actually
    // uploaded under the same key uploadManual reports back, not a
    // different one computed some other way internally.
    expect(s3.calls[0]?.input.Key).toBe(result.s3Key);
    expect(s3.calls[0]?.input.ContentType).toBe('application/pdf');
    expect(s3.calls[1]?.input.Key).toBe(`${result.s3Key}.metadata.json`);
    expect(s3.calls[1]?.input.ContentType).toBe('application/json');
    expect(JSON.parse(s3.calls[1]?.input.Body as string)).toEqual({
      metadataAttributes: { [APPLIANCE_ID_METADATA_KEY]: appliance.id, title: baseOptions().title }
    });

    const doc = await repo.getDoc(result.docId);
    expect(doc?.kbSync.status).toBe('synced');
    expect(doc?.kbSync.at).not.toBeNull();

    const updatedAppliance = await repo.getAppliance(appliance.id);
    expect(updatedAppliance?.manualDocId).toBe(result.docId);
  });

  it('derives the same docId and s3Key for repeated uploads to the same appliance, so a retry replaces instead of duplicating', async () => {
    const repo = createMemoryRepository('hh_test');
    await repo.putAppliance(appliance);

    const first = await uploadManual({ ...baseOptions(), s3: fakeS3().sender, agent: fakeAgent(['COMPLETE']).sender, repo });
    const second = await uploadManual({ ...baseOptions(), title: 'Corrected owner manual', s3: fakeS3().sender, agent: fakeAgent(['COMPLETE']).sender, repo });

    expect(second.docId).toBe(first.docId);
    expect(second.s3Key).toBe(first.s3Key);
  });

  it('reports a failed ingestion job honestly: rejects, and records kbSync.status "failed" rather than "synced"', async () => {
    const repo = createMemoryRepository('hh_test');
    await repo.putAppliance(appliance);
    const agent = fakeAgent(['STARTING', 'FAILED'], ['embedding model access denied']);
    const docId = derivedId('doc', appliance.id);

    await expect(uploadManual({ ...baseOptions(), s3: fakeS3().sender, agent: agent.sender, repo })).rejects.toThrow(/FAILED: embedding model access denied/);

    const doc = await repo.getDoc(docId);
    expect(doc?.kbSync.status).toBe('failed');
  });

  it('throws before any write when the appliance does not exist, leaving no S3 objects and no orphaned DOC# row', async () => {
    // A typo'd --appliance is the likeliest operator mistake, and
    // derivedId's retry-idempotency cannot heal it: nobody re-runs the
    // command with the same typo, so whatever this leaves behind is
    // permanent. Asserts the full "no residue" property, not just that the
    // promise rejects.
    const repo = createMemoryRepository('hh_test'); // no appliance seeded
    const s3 = fakeS3();
    const agent = fakeAgent(['COMPLETE']);
    const missingApplianceId = 'appl_missingmissingmi';

    await expect(uploadManual({ ...baseOptions(), applianceId: missingApplianceId, s3: s3.sender, agent: agent.sender, repo })).rejects.toThrow(/not found/);

    expect(s3.calls).toHaveLength(0);
    expect(agent.startCalls()).toBe(0);
    expect(await repo.getDoc(derivedId('doc', missingApplianceId))).toBeNull();
  });

  // State 2 of the four: the Knowledge Base is provisioned, StartIngestionJob
  // is refused by the account-wide Bedrock block, and the run must survive it.
  it('returns a skipped result instead of throwing when StartIngestionJob hits the account-wide Bedrock block', async () => {
    const repo = createMemoryRepository('hh_test');
    await repo.putAppliance(appliance);
    const agent = throwingStartAgent(awsError());

    const result = await uploadManual({ ...baseOptions(), s3: fakeS3().sender, agent: agent.sender, repo });

    expect(result.ingestion).toBe('skipped-bedrock-blocked');
    expect(result.ingestionJobId).toBeNull();
    expect(result.status).toBeNull();
    // No job id was ever issued, so nothing may have been polled. Proves the
    // skip returns at the start call rather than falling through into the
    // polling loop with a bogus id.
    expect(agent.getCalls()).toBe(0);
  });

  // The explicit "keep, do not clean up" decision, asserted rather than left
  // to a comment. The uploaded PDF and its sidecar are what a later ingestion
  // job consumes once the block clears, so a re-run needs no re-upload; the
  // DOC# row is what get_appliance reads and what appliance.manualDocId
  // points at. The row stays honest - kbSync.status 'pending', at null -
  // which is the accurate description of uploaded-but-not-ingested, and is
  // what makes this kept state rather than orphaned residue.
  it('keeps the uploaded objects and the DOC# row after a skip, with kbSync still "pending" rather than "synced" or "failed"', async () => {
    const repo = createMemoryRepository('hh_test');
    await repo.putAppliance(appliance);
    const s3 = fakeS3();

    const result = await uploadManual({ ...baseOptions(), s3: s3.sender, agent: throwingStartAgent(awsError()).sender, repo });

    expect(s3.calls).toHaveLength(2);
    expect(s3.calls[0]?.input.Key).toBe(result.s3Key);
    expect(s3.calls[1]?.input.Key).toBe(`${result.s3Key}.metadata.json`);

    const doc = await repo.getDoc(result.docId);
    expect(doc).not.toBeNull();
    expect(doc?.kbSync.status).toBe('pending');
    expect(doc?.kbSync.at).toBeNull();
    expect((await repo.getAppliance(appliance.id))?.manualDocId).toBe(result.docId);
  });

  // Deterministic ids mean a re-run after the block clears replaces in place,
  // so keeping the residue cannot accumulate duplicates - the property that
  // makes "keep" safe rather than merely convenient.
  it('re-running after the block clears ingests the same docId and s3Key, so the kept objects are replaced, not duplicated', async () => {
    const repo = createMemoryRepository('hh_test');
    await repo.putAppliance(appliance);

    const blocked = await uploadManual({ ...baseOptions(), s3: fakeS3().sender, agent: throwingStartAgent(awsError()).sender, repo });
    const retried = await uploadManual({ ...baseOptions(), s3: fakeS3().sender, agent: fakeAgent(['COMPLETE']).sender, repo });

    expect(retried.docId).toBe(blocked.docId);
    expect(retried.s3Key).toBe(blocked.s3Key);
    expect(retried.ingestion).toBe('complete');
    expect((await repo.getDoc(blocked.docId))?.kbSync.status).toBe('synced');
  });

  // The other half of the contract, and the half that must not be weakened:
  // every ingestion failure that is NOT the account block still rejects.
  it.each([
    ['a ValidationException for a malformed metadata sidecar', awsError({ message: 'The metadata file for doc_x.pdf.metadata.json is not valid JSON' })],
    ['a ValidationException for a data source outside the knowledge base', awsError({ message: 'Data source DS999 was not found in knowledge base KB123' })],
    [
      'an AccessDeniedException unrelated to Bedrock',
      awsError({ name: 'AccessDeniedException', message: 'User is not authorized to perform bedrock:StartIngestionJob' })
    ],
    ['the Bedrock block text arriving as a 500 rather than a 400', awsError({ httpStatusCode: 500 })],
    ['the Bedrock block text on a non-ValidationException', awsError({ name: 'ThrottlingException' })],
    ['a plain Error with no AWS metadata at all', new Error('socket hang up')]
  ])('still rejects on %s', async (_label, error) => {
    const repo = createMemoryRepository('hh_test');
    await repo.putAppliance(appliance);

    await expect(uploadManual({ ...baseOptions(), s3: fakeS3().sender, agent: throwingStartAgent(error).sender, repo })).rejects.toThrow(error as Error);
  });

  // Scope pin, deliberate and documented: the skip covers the START call
  // only. A job that starts and then reaches FAILED goes through the same
  // terminal-status path as every genuine ingestion failure, so it keeps
  // failing hard even when it reports this exact reason. If AWS ever moves
  // the refusal to job level the run goes red and someone widens this
  // deliberately - it does not widen itself.
  it('still rejects when a job STARTS and then reports FAILED carrying the Bedrock block text', async () => {
    const repo = createMemoryRepository('hh_test');
    await repo.putAppliance(appliance);
    const agent = fakeAgent(['STARTING', 'FAILED'], [`Error 002: ${BEDROCK_ACCOUNT_BLOCK_MESSAGE}`]);

    await expect(uploadManual({ ...baseOptions(), s3: fakeS3().sender, agent: agent.sender, repo })).rejects.toThrow(/ingestion FAILED/);
    expect((await repo.getDoc(derivedId('doc', appliance.id)))?.kbSync.status).toBe('failed');
  });

  it('throws instead of polling forever when the job never reaches a terminal status inside the timeout budget', async () => {
    const repo = createMemoryRepository('hh_test');
    await repo.putAppliance(appliance);
    const agent = fakeAgent(['STARTING']); // clamps to STARTING on every poll

    await expect(uploadManual({ ...baseOptions(), s3: fakeS3().sender, agent: agent.sender, repo, timeoutMs: 5, pollIntervalMs: 2 })).rejects.toThrow(
      /still STARTING after 5 ms/
    );
  });
});
