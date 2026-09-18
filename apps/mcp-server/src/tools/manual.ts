import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { MAX_PASSAGES, classifyRetrievalFailure, type Passage, type RetrievalFailure } from '@homeledger/core';
import type { ServerDeps } from '../server.js';
import { speakList } from '../voice.js';

const PassageRow = z.object({
  text: z.string(),
  docTitle: z.string(),
  page: z.number().int().nullable(),
  score: z.number()
});

/**
 * What a person hears when retrieval fails, one sentence-set per recognised
 * cause.
 *
 * All three are prose with no identifiers, no error codes, and no JSON
 * punctuation, because every tool in this server is read aloud (see
 * `voice.ts`'s `hasJson`, and `scripts/smoke.ts`'s `assertSpokenProse`). They
 * replace the raw AWS string the SDK used to render from a thrown handler —
 * "Invalid input or configuration provided. Check the input and Knowledge Base
 * configuration and try your request again." — which is AWS's wording for its
 * own API, is misleading here (nothing about the question or the configuration
 * is wrong), and reads to an owner or a judge as a bug in HomeLedger.
 *
 * Each says what happened, whose fault it is not, and what would change it.
 * The "nothing is wrong with the question" clause is load-bearing: the whole
 * complaint about the old message is that it told the person to go and check
 * their input.
 */
export const MANUALS_MODEL_ACCESS_BLOCKED_MESSAGE =
  "I can't look anything up in the manuals right now. Searching them needs a model to read your question first, and model access is blocked on this AWS account, so the search is refused before it starts. Nothing is wrong with the question you asked. Manual search will work again once model access is restored on the account.";

export const MANUALS_KNOWLEDGE_BASE_MISSING_MESSAGE =
  "I can't look anything up in the manuals right now. This deployment is pointed at a manual library that no longer exists, so there is nothing to search. That is a setup problem on our side, not a problem with your question.";

export const MANUALS_UNAVAILABLE_MESSAGE =
  "I can't look anything up in the manuals right now. The manual search service returned an error I don't recognise. Nothing is wrong with the question you asked; please try again in a moment.";

export function manualFailureMessage(failure: RetrievalFailure): string {
  if (failure === 'bedrock-model-access-blocked') return MANUALS_MODEL_ACCESS_BLOCKED_MESSAGE;
  if (failure === 'knowledge-base-missing') return MANUALS_KNOWLEDGE_BASE_MISSING_MESSAGE;
  return MANUALS_UNAVAILABLE_MESSAGE;
}

export function registerManualTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'ask_manual',
    {
      title: 'Ask the manuals',
      description:
        'Search the household appliance manuals and return the most relevant passages with their page numbers. Returns source text only; compose the answer yourself from the passages and cite the document title and page.',
      inputSchema: z.object({ question: z.string().min(3).max(500), applianceId: z.string().optional() }),
      outputSchema: z.object({ passages: z.array(PassageRow) }),
      annotations: { readOnlyHint: true }
    },
    async ({ question, applianceId }) => {
      let passages: Passage[];
      try {
        passages = await deps.retriever.retrieve({ question, applianceId, maxPassages: MAX_PASSAGES });
      } catch (error) {
        // Every throw is answered, and only the CAUSE is classified.
        //
        // Catching broadly here is not the blanket catch `isBedrockAccountBlock`
        // forbids on the ingestion path, because nothing is swallowed: the
        // result still carries `isError: true`, which is the MCP spec's own
        // convention for a tool execution failure and what the bridge and
        // `scripts/smoke.ts` already classify on. What must never happen is
        // ATTRIBUTING an unrecognised failure to the Bedrock block, and
        // `classifyRetrievalFailure` is what prevents that — anything it has not
        // positively recognised falls to MANUALS_UNAVAILABLE_MESSAGE, which
        // explains nothing it cannot prove.
        //
        // The raw error goes to stdout, which is CloudWatch on the deployed
        // runtime (this server is HTTP; stdout is not a protocol channel here —
        // see `app.ts`). Turning the string a person reads into prose must not
        // also destroy the string an operator needs, and the classification is
        // logged beside it so a future "unclassified" is visible as a matcher
        // gap rather than as silence.
        const failure = classifyRetrievalFailure(error);
        console.log(
          JSON.stringify({ msg: 'ask-manual-retrieval-failed', failure, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
        );
        return { content: [{ type: 'text', text: manualFailureMessage(failure) }], isError: true };
      }
      if (passages.length === 0) {
        return { content: [{ type: 'text', text: "I couldn't find anything about that in the manuals." }], structuredContent: { passages: [] } };
      }
      // Spoken text names the sources only. Passage bodies routinely contain
      // brackets and braces, which hasJson() rejects, and the client model is
      // the thing that composes the answer from structuredContent.
      const cited = speakList(
        passages.map(p => (p.page === null ? p.docTitle : `${p.docTitle} page ${p.page}`)),
        'passage'
      );
      return { content: [{ type: 'text', text: cited }], structuredContent: { passages } };
    }
  );
}
