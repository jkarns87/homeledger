import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_APPLIANCE_IDS, type ManualRetriever } from '@homeledger/core';
import { MANUALS_KNOWLEDGE_BASE_MISSING_MESSAGE, MANUALS_MODEL_ACCESS_BLOCKED_MESSAGE, MANUALS_UNAVAILABLE_MESSAGE } from '../src/tools/manual.js';
import { hasJson } from '../src/voice.js';
import { modernClient } from './harness.js';

/** A retriever that fails the way the deployed Bedrock one does. */
function failingRetriever(error: unknown): ManualRetriever {
  return {
    retrieve: async () => {
      throw error;
    }
  };
}

function awsError(name: string, message: string, httpStatusCode: number): Error {
  const error = new Error(message);
  error.name = name;
  return Object.assign(error, { $metadata: { httpStatusCode } });
}

/**
 * The real refusal, byte for byte, as `Retrieve` returned it to a person
 * through the Claude Code bridge under the account-wide Bedrock model block.
 * This is the string the tool used to hand straight to the user.
 */
const REAL_RETRIEVE_REFUSAL = awsError(
  'ValidationException',
  'Invalid input or configuration provided. Check the input and Knowledge Base configuration and try your request again.',
  400
);

let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
});

describe('ask_manual', () => {
  it('returns passages with page numbers and speaks a citation without JSON', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'ask_manual', arguments: { question: 'What does F21 mean on the washer?' } });
    const sc = r.structuredContent as { passages: Array<{ text: string; docTitle: string; page: number | null; score: number }> };
    expect(sc.passages.length).toBeGreaterThan(0);
    expect(sc.passages.length).toBeLessThanOrEqual(3);
    expect(sc.passages[0]?.page).toBe(42);
    expect(sc.passages[0]?.docTitle).toBe('LG WM4000HWA washer owner manual');
    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(hasJson(text)).toBe(false);
    expect(text).toContain('LG WM4000HWA washer owner manual page 42');
  });

  it('passes applianceId through as a filter', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'ask_manual', arguments: { question: 'filter', applianceId: FIXTURE_APPLIANCE_IDS.furnace } });
    const sc = r.structuredContent as { passages: Array<{ docTitle: string }> };
    expect(sc.passages.length).toBeGreaterThan(0);
    expect(sc.passages.every(p => p.docTitle.includes('furnace'))).toBe(true);
  });

  it('caps at three passages even when every fixture passage matches', async () => {
    const h = await modernClient();
    close = h.close;
    // Every keyword from every SAMPLE_MANUAL_PASSAGES entry appears here, so all six
    // fixture passages match (matched > 0) and MAX_PASSAGES is the only thing that
    // can keep the result at 3. Without the cap this returns 6.
    const question =
      'f21 drain hose pump washer code error filter clean monthly merv furnace replace air 90 inspection pressure switch condensate flame flush tank sediment water heater annual anode rod inspect warranty';
    const r = await h.client.callTool({ name: 'ask_manual', arguments: { question } });
    const sc = r.structuredContent as { passages: Array<{ docTitle: string; page: number | null }> };
    expect(sc.passages.length).toBe(3);
    expect(sc.passages[0]?.page).toBe(42);
    expect(sc.passages[0]?.docTitle).toBe('LG WM4000HWA washer owner manual');
  });

  it('says so plainly when the manuals have nothing', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'ask_manual', arguments: { question: 'how do I repaint the garage door' } });
    expect((r.structuredContent as { passages: unknown[] }).passages).toEqual([]);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("I couldn't find anything about that in the manuals.");
  });
});

// The whole point of the change: what a PERSON reads when retrieval fails.
// Before this, nothing caught the throw, the SDK rendered it as isError with no
// structuredContent, and the owner read AWS's own sentence about AWS's own API.
describe('ask_manual when retrieval fails', () => {
  it('explains the Bedrock model block in prose instead of handing over AWS’s sentence', async () => {
    const h = await modernClient({ retriever: failingRetriever(REAL_RETRIEVE_REFUSAL) });
    close = h.close;
    const r = await h.client.callTool({ name: 'ask_manual', arguments: { question: 'What does F21 mean on the washer?' } });

    const spoken = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(spoken).toBe(MANUALS_MODEL_ACCESS_BLOCKED_MESSAGE);
    // Named separately from the equality above so a reworded constant still has
    // to keep the two properties that make this message a fix rather than a
    // different string: AWS's wording is gone, and the person is told the
    // question was not the problem.
    expect(spoken).not.toContain('Invalid input or configuration provided');
    expect(spoken).not.toContain('Check the input and Knowledge Base configuration');
    expect(spoken.toLowerCase()).toContain('nothing is wrong with the question');
    expect(hasJson(spoken)).toBe(false);

    // isError stays true: it is the MCP spec's convention for a tool execution
    // failure, scripts/smoke.ts's five-state logic classifies on it, and the
    // Claude Code bridge relays it. Only the message changed.
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
  });

  it('says something different and accurate when the Knowledge Base itself is gone', async () => {
    const h = await modernClient({
      retriever: failingRetriever(awsError('ResourceNotFoundException', 'Could not find knowledge base with ID KBGONE', 404))
    });
    close = h.close;
    const r = await h.client.callTool({ name: 'ask_manual', arguments: { question: 'What does F21 mean on the washer?' } });
    const spoken = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(spoken).toBe(MANUALS_KNOWLEDGE_BASE_MISSING_MESSAGE);
    expect(spoken).not.toBe(MANUALS_MODEL_ACCESS_BLOCKED_MESSAGE);
    expect(spoken.toLowerCase()).not.toContain('model access');
    expect(r.isError).toBe(true);
  });

  // The case that keeps the fix honest. A malformed request is a bug in this
  // repository, it reaches Retrieve as a 400 ValidationException exactly like
  // the block does, and it must NOT borrow the block's explanation - a person
  // told "model access is blocked on this account" would go and wait for AWS
  // while the actual cause sat in our own code.
  it('does not attribute a genuine constraint violation to the model block', async () => {
    const constraintViolation = awsError(
      'ValidationException',
      "1 validation error detected: Value 'oops' at 'knowledgeBaseId' failed to satisfy constraint: Member must satisfy regular expression pattern: ^[0-9a-zA-Z]{1,10}$",
      400
    );
    const h = await modernClient({ retriever: failingRetriever(constraintViolation) });
    close = h.close;
    const r = await h.client.callTool({ name: 'ask_manual', arguments: { question: 'What does F21 mean on the washer?' } });
    const spoken = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(spoken).toBe(MANUALS_UNAVAILABLE_MESSAGE);
    expect(spoken).not.toBe(MANUALS_MODEL_ACCESS_BLOCKED_MESSAGE);
    expect(spoken.toLowerCase()).not.toContain('model access');
    expect(hasJson(spoken)).toBe(false);
    expect(r.isError).toBe(true);
  });

  // Not only AWS errors: anything the retriever throws must still reach the
  // person as a sentence rather than as a stack trace the SDK stringified.
  it('answers a plain thrown Error in prose too, rather than letting it render as one', async () => {
    const h = await modernClient({ retriever: failingRetriever(new Error('socket hang up')) });
    close = h.close;
    const r = await h.client.callTool({ name: 'ask_manual', arguments: { question: 'What does F21 mean on the washer?' } });
    const spoken = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(spoken).toBe(MANUALS_UNAVAILABLE_MESSAGE);
    expect(spoken).not.toContain('socket hang up');
    expect(r.isError).toBe(true);
  });

  it('keeps every failure message free of identifiers and JSON punctuation, since they are read aloud', () => {
    for (const message of [MANUALS_MODEL_ACCESS_BLOCKED_MESSAGE, MANUALS_KNOWLEDGE_BASE_MISSING_MESSAGE, MANUALS_UNAVAILABLE_MESSAGE]) {
      expect(hasJson(message)).toBe(false);
      expect(message).not.toMatch(/ValidationException|ResourceNotFoundException|knowledgeBaseId|\b\d{3}\b/);
    }
  });
});
