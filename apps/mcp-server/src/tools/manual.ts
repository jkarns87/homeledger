import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { MAX_PASSAGES } from '@homeledger/core';
import type { ServerDeps } from '../server.js';
import { speakList } from '../voice.js';

const PassageRow = z.object({
  text: z.string(),
  docTitle: z.string(),
  page: z.number().int().nullable(),
  score: z.number()
});

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
      const passages = await deps.retriever.retrieve({ question, applianceId, maxPassages: MAX_PASSAGES });
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
