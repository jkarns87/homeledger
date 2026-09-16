import { BedrockAgentRuntimeClient, RetrieveCommand, type RetrieveCommandOutput } from '@aws-sdk/client-bedrock-agent-runtime';
import { type ManualRetriever, type Passage, type RetrieveOptions, clampPassages } from './retriever.js';

/**
 * The single method this adapter needs from the AWS client. Narrowing it here
 * keeps tests free of the SDK's overloaded generic send() signature.
 */
export interface RetrieveSender {
  send(command: RetrieveCommand): Promise<RetrieveCommandOutput>;
}

/** Spec 4.6: retrieval results are cached per question for ten minutes. */
export const CACHE_TTL_MS = 600_000;

/** Metadata keys Bedrock attaches to every chunk from an S3 data source. */
export const PAGE_METADATA_KEY = 'x-amz-bedrock-kb-document-page-number';
export const SOURCE_URI_METADATA_KEY = 'x-amz-bedrock-kb-source-uri';

export interface KnowledgeBaseRetrieverOptions {
  knowledgeBaseId: string;
  client?: RetrieveSender;
  region?: string;
  cacheTtlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  expiresAt: number;
  passages: Passage[];
}

function pageOf(metadata: Record<string, unknown> | undefined): number | null {
  const raw = metadata?.[PAGE_METADATA_KEY];
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return null;
}

function titleOf(metadata: Record<string, unknown> | undefined): string {
  const title = metadata?.title;
  if (typeof title === 'string' && title.length > 0) return title;
  const uri = metadata?.[SOURCE_URI_METADATA_KEY];
  if (typeof uri === 'string' && uri.length > 0) return uri.slice(uri.lastIndexOf('/') + 1);
  return 'Appliance manual';
}

function cacheKey(question: string, applianceId: string | undefined, limit: number): string {
  return `${applianceId ?? ''}\0${question.trim().toLowerCase().replace(/\s+/g, ' ')}\0${limit}`;
}

export function createKnowledgeBaseRetriever(options: KnowledgeBaseRetrieverOptions): ManualRetriever {
  const sender: RetrieveSender = options.client ?? new BedrockAgentRuntimeClient({ region: options.region ?? process.env.AWS_REGION ?? 'us-east-1' });
  const ttl = options.cacheTtlMs ?? CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  return {
    async retrieve(request: RetrieveOptions): Promise<Passage[]> {
      const limit = clampPassages(request.maxPassages);
      const key = cacheKey(request.question, request.applianceId, limit);
      const hit = cache.get(key);
      if (hit) {
        if (hit.expiresAt > now()) return hit.passages;
        cache.delete(key);
      }

      const command = new RetrieveCommand({
        knowledgeBaseId: options.knowledgeBaseId,
        retrievalQuery: { text: request.question },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: limit,
            ...(request.applianceId ? { filter: { equals: { key: 'applianceId', value: request.applianceId } } } : {})
          }
        }
      });
      const response = await sender.send(command);
      const passages: Passage[] = (response.retrievalResults ?? [])
        .filter(result => typeof result.content?.text === 'string' && result.content.text.length > 0)
        .slice(0, limit)
        .map(result => ({
          text: result.content!.text!,
          docTitle: titleOf(result.metadata),
          page: pageOf(result.metadata),
          score: result.score ?? 0
        }));

      cache.set(key, { expiresAt: now() + ttl, passages });
      return passages;
    }
  };
}
