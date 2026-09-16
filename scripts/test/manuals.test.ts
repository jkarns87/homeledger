import {
  GetIngestionJobCommand,
  StartIngestionJobCommand,
  type GetIngestionJobCommandOutput,
  type IngestionJobStatus,
  type StartIngestionJobCommandOutput
} from '@aws-sdk/client-bedrock-agent';
import type { PutObjectCommand, PutObjectCommandOutput } from '@aws-sdk/client-s3';
import { APPLIANCE_ID_METADATA_KEY, type Appliance, createMemoryRepository, derivedId } from '@homeledger/core';
import { describe, expect, it } from 'vitest';
import { buildManualMetadata, type IngestionSender, type ManualsBucketSender, uploadManual } from '../manuals.js';

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
  // THE load-bearing test: createKnowledgeBaseRetriever (packages/core/src/retrieval/bedrock.ts)
  // filters with `{ filter: { equals: { key: APPLIANCE_ID_METADATA_KEY, value: applianceId } } }`.
  // Importing the constant here, rather than retyping 'applianceId', means a
  // rename on either side of the contract breaks this test instead of
  // silently shipping a retriever that returns unfiltered results.
  it('writes the exact metadata attribute name the retriever filters on', () => {
    const sidecar = buildManualMetadata(appliance.id, 'LG WM4000HWA washer owner manual');
    expect(sidecar.metadataAttributes[APPLIANCE_ID_METADATA_KEY]).toBe(appliance.id);
  });

  it('also writes title, since the retriever falls back to metadata.title for docTitle', () => {
    const sidecar = buildManualMetadata(appliance.id, 'LG WM4000HWA washer owner manual');
    expect(sidecar.metadataAttributes.title).toBe('LG WM4000HWA washer owner manual');
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

  it('throws before starting ingestion when the appliance does not exist in the table', async () => {
    const repo = createMemoryRepository('hh_test'); // no appliance seeded
    const agent = fakeAgent(['COMPLETE']);

    await expect(uploadManual({ ...baseOptions(), applianceId: 'appl_missingmissingmi', s3: fakeS3().sender, agent: agent.sender, repo })).rejects.toThrow(
      /not found/
    );

    expect(agent.startCalls()).toBe(0);
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
