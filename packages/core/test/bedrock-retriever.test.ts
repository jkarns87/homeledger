import type { RetrieveCommand, RetrieveCommandOutput } from '@aws-sdk/client-bedrock-agent-runtime';
import { describe, expect, it } from 'vitest';
import { CACHE_TTL_MS, PAGE_METADATA_KEY, SOURCE_URI_METADATA_KEY, createKnowledgeBaseRetriever, type RetrieveSender } from '../src/retrieval/bedrock.js';

function stub(output: RetrieveCommandOutput): { sender: RetrieveSender; calls: Array<RetrieveCommand['input']> } {
  const calls: Array<RetrieveCommand['input']> = [];
  return {
    calls,
    sender: {
      async send(command: RetrieveCommand) {
        calls.push(command.input);
        return output;
      }
    }
  };
}

const twoResults: RetrieveCommandOutput = {
  $metadata: {},
  retrievalResults: [
    {
      content: { text: 'Error code F21 indicates a long drain time.' },
      score: 0.91,
      metadata: { title: 'LG WM4000HWA washer owner manual', [PAGE_METADATA_KEY]: 42, applianceId: 'appl_wwwwwwwwwwwwwwww' }
    },
    {
      content: { text: 'Clean the drain pump filter every month.' },
      score: 0.77,
      metadata: { [SOURCE_URI_METADATA_KEY]: 's3://homeledger-manuals/manuals/hh_harlow/doc_abcdefghijklmnop.pdf' }
    }
  ]
};

describe('knowledge base retriever', () => {
  it('asks for three results and maps content, title, page, and score', async () => {
    const { sender, calls } = stub(twoResults);
    const retriever = createKnowledgeBaseRetriever({ knowledgeBaseId: 'KB123', client: sender });
    const passages = await retriever.retrieve({ question: 'What does F21 mean?' });
    expect(calls[0]?.knowledgeBaseId).toBe('KB123');
    expect(calls[0]?.retrievalQuery?.text).toBe('What does F21 mean?');
    expect(calls[0]?.retrievalConfiguration?.vectorSearchConfiguration?.numberOfResults).toBe(3);
    expect(calls[0]?.retrievalConfiguration?.vectorSearchConfiguration?.filter).toBeUndefined();
    expect(passages).toEqual([
      { text: 'Error code F21 indicates a long drain time.', docTitle: 'LG WM4000HWA washer owner manual', page: 42, score: 0.91 },
      { text: 'Clean the drain pump filter every month.', docTitle: 'doc_abcdefghijklmnop.pdf', page: null, score: 0.77 }
    ]);
  });

  it('adds an equals filter on applianceId when one is supplied', async () => {
    const { sender, calls } = stub(twoResults);
    const retriever = createKnowledgeBaseRetriever({ knowledgeBaseId: 'KB123', client: sender });
    await retriever.retrieve({ question: 'drain', applianceId: 'appl_wwwwwwwwwwwwwwww' });
    expect(calls[0]?.retrievalConfiguration?.vectorSearchConfiguration?.filter).toEqual({
      equals: { key: 'applianceId', value: 'appl_wwwwwwwwwwwwwwww' }
    });
  });

  it('serves a repeated question from cache for ten minutes, then refetches', async () => {
    const { sender, calls } = stub(twoResults);
    let clock = 1_000_000;
    const retriever = createKnowledgeBaseRetriever({ knowledgeBaseId: 'KB123', client: sender, now: () => clock });
    await retriever.retrieve({ question: 'What does F21 mean?' });
    await retriever.retrieve({ question: '  what DOES f21 mean?  ' });
    expect(calls.length).toBe(1);
    clock += CACHE_TTL_MS + 1;
    await retriever.retrieve({ question: 'What does F21 mean?' });
    expect(calls.length).toBe(2);
  });

  it('caches per appliance filter, not just per question', async () => {
    const { sender, calls } = stub(twoResults);
    const retriever = createKnowledgeBaseRetriever({ knowledgeBaseId: 'KB123', client: sender });
    await retriever.retrieve({ question: 'drain' });
    await retriever.retrieve({ question: 'drain', applianceId: 'appl_wwwwwwwwwwwwwwww' });
    expect(calls.length).toBe(2);
  });

  it('returns an empty list when the knowledge base has no results', async () => {
    const { sender } = stub({ $metadata: {}, retrievalResults: [] });
    const retriever = createKnowledgeBaseRetriever({ knowledgeBaseId: 'KB123', client: sender });
    expect(await retriever.retrieve({ question: 'anything' })).toEqual([]);
  });
});
