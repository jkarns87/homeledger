import type { RetrieveCommand, RetrieveCommandOutput } from '@aws-sdk/client-bedrock-agent-runtime';
import { describe, expect, it } from 'vitest';
import {
  BEDROCK_ACCOUNT_BLOCK_MESSAGE,
  CACHE_TTL_MS,
  PAGE_METADATA_KEY,
  RETRIEVE_INVALID_CONFIGURATION_MESSAGE,
  SOURCE_URI_METADATA_KEY,
  classifyRetrievalFailure,
  createKnowledgeBaseRetriever,
  type RetrieveSender
} from '../src/retrieval/bedrock.js';

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
    // The refetch's entry takes the stale one's place rather than sitting
    // alongside it: a further call inside the new TTL window is served from
    // cache again, not refetched a third time.
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

/**
 * The full sentence pair a person saw through Claude Code when `Retrieve` was
 * refused under the account-wide Bedrock model block. Written out here rather
 * than composed from the constant, so the constant has to be a real substring
 * of the real message and not merely a string the matcher happens to read.
 */
const REAL_RETRIEVE_REFUSAL = 'Invalid input or configuration provided. Check the input and Knowledge Base configuration and try your request again.';

/** What AWS sends instead when a request parameter genuinely fails shape validation. */
const REAL_CONSTRAINT_VIOLATION =
  "1 validation error detected: Value 'not a kb id' at 'knowledgeBaseId' failed to satisfy constraint: Member must satisfy regular expression pattern: ^[0-9a-zA-Z]{1,10}$";

/** An AWS SDK v3 service exception, shaped as the Retrieve call actually throws one. */
function retrieveError(over: { name?: string; message?: string; httpStatusCode?: number | undefined } = {}) {
  const error = new Error(over.message ?? REAL_RETRIEVE_REFUSAL);
  error.name = over.name ?? 'ValidationException';
  return Object.assign(error, { $metadata: { httpStatusCode: 'httpStatusCode' in over ? over.httpStatusCode : 400 } });
}

// The same detection question isBedrockAccountBlock turns on, asked of the READ
// path: too loose and an unrecognised failure is confidently explained to a
// person as something it is not; too tight and the explanation stops appearing
// the moment anything incidental about the message moves. Each case below
// removes exactly one condition classifyRetrievalFailure requires, so no
// condition can be deleted without a test going red.
describe('classifyRetrievalFailure', () => {
  it('recognises the Retrieve refusal a person actually saw through Claude Code', () => {
    expect(classifyRetrievalFailure(retrieveError())).toBe('bedrock-model-access-blocked');
  });

  it('also recognises the control-plane wording, in case Retrieve ever passes the downstream error through', () => {
    const passedThrough = `Knowledge base role arn:aws:iam::123456789012:role/demo-homeledger-knowledge-base is not able to call specified bedrock embedding model: Error 002: ${BEDROCK_ACCOUNT_BLOCK_MESSAGE}`;
    expect(classifyRetrievalFailure(retrieveError({ message: passedThrough }))).toBe('bedrock-model-access-blocked');
  });

  // Pins both literals' values, not just that they are wired: every other case
  // here feeds the matcher a message built from the same source it reads, which
  // proves wiring and not value. If either sentence is edited the matcher
  // silently stops matching the real error, and nothing else here would notice.
  it('pins the exact sentences it keys on, and one is a real substring of the real AWS message', () => {
    expect(RETRIEVE_INVALID_CONFIGURATION_MESSAGE).toBe('Invalid input or configuration provided');
    expect(BEDROCK_ACCOUNT_BLOCK_MESSAGE).toBe('Access to Bedrock models is not allowed for this account');
    expect(REAL_RETRIEVE_REFUSAL).toContain(RETRIEVE_INVALID_CONFIGURATION_MESSAGE);
  });

  // Not too tight: the remediation half of AWS's sentence pair is advice AWS
  // may reword, and it must not be load-bearing.
  it('still recognises the refusal when the remediation half of the message is reworded', () => {
    expect(classifyRetrievalFailure(retrieveError({ message: 'Invalid input or configuration provided. Contact AWS Support.' }))).toBe(
      'bedrock-model-access-blocked'
    );
  });

  // Not too loose, case 1: the message alone is not enough. A differently
  // classed error carrying the same text - a wrapped copy, a re-throw, or an
  // IAM denial that quotes it - is not the condition this explanation names.
  // The status stays 400 so ONLY the class check can be doing the work.
  it('does not explain the failure when the message is right but the error class is not ValidationException', () => {
    expect(classifyRetrievalFailure(retrieveError({ name: 'AccessDeniedException' }))).toBe('unclassified');
  });

  // Not too loose, case 2: a 5xx is a service fault, not a deterministic
  // refusal. Telling a person "model access is blocked on this account" for a
  // transient Bedrock outage sends them to open a support case for something
  // that would have cleared on its own.
  it('does not explain the failure when the class and message are right but the status is not 400', () => {
    expect(classifyRetrievalFailure(retrieveError({ httpStatusCode: 500 }))).toBe('unclassified');
    expect(classifyRetrievalFailure(retrieveError({ httpStatusCode: undefined }))).toBe('unclassified');
  });

  // Not too loose, case 3, and the one this whole split exists for: Retrieve
  // raises ValidationException with a 400 for a genuinely malformed request too.
  // That is a bug in this repository, it must NOT be reported as the Bedrock
  // block, and AWS's own wording already separates the two - a constraint
  // violation names the offending field and never carries the pinned sentence.
  it('does not explain a genuine constraint violation as the model block, even though it is a 400 ValidationException too', () => {
    expect(classifyRetrievalFailure(retrieveError({ message: REAL_CONSTRAINT_VIOLATION }))).toBe('unclassified');
  });

  it('recognises a Knowledge Base that does not resolve, separately from the model block', () => {
    expect(
      classifyRetrievalFailure(retrieveError({ name: 'ResourceNotFoundException', message: 'Could not find knowledge base KBGONE', httpStatusCode: 404 }))
    ).toBe('knowledge-base-missing');
  });

  it('does not read any other 404 as a missing Knowledge Base', () => {
    expect(classifyRetrievalFailure(retrieveError({ name: 'ThrottlingException', message: 'Too many requests', httpStatusCode: 404 }))).toBe('unclassified');
  });

  it('does not read a ResourceNotFoundException the service did not answer 404 to as a missing Knowledge Base', () => {
    expect(
      classifyRetrievalFailure(retrieveError({ name: 'ResourceNotFoundException', message: 'Could not find knowledge base KBGONE', httpStatusCode: 500 }))
    ).toBe('unclassified');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a bare string carrying the text', `ValidationException: ${REAL_RETRIEVE_REFUSAL}`],
    ['a plain Error with the text but no AWS metadata', new Error(REAL_RETRIEVE_REFUSAL)]
  ])('does not explain %s', (_label, value) => {
    expect(classifyRetrievalFailure(value)).toBe('unclassified');
  });
});
