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

/**
 * The author-written metadata attribute name the applianceId equals-filter
 * below matches on. This is NOT one of the `x-amz-bedrock-kb-*` reserved
 * keys above (which the service itself populates and which the S3 data
 * source connector rejects author metadata for, per
 * https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-config.html#kb-test-config-filters:
 * "metadata fields prefixed with x-amz-bedrock are reserved by the
 * service... You cannot override reserved metadata fields"). The manuals
 * ingestion script (`@homeledger/scripts`) must write this exact key into
 * every document's `.metadata.json` sidecar for this filter to match.
 */
export const APPLIANCE_ID_METADATA_KEY = 'applianceId';

/**
 * The exact sentence AWS returns when Bedrock model invocation is refused at
 * the ACCOUNT level (FRICTION-LOG.md FL-019, support case 178941623300459).
 * Observed byte-identical across three independent probes on two days, from
 * two different principals, for two different models.
 *
 * It lives here rather than in `scripts/manuals.ts` (which owns the
 * INGESTION-side matcher and re-exports this symbol) so the two sides of the
 * same condition cannot silently diverge — the same reason
 * `APPLIANCE_ID_METADATA_KEY` is imported there instead of retyped.
 *
 * Deliberately just this sentence, and deliberately not the rest of the
 * message. The full text AWS sends on the control plane is:
 *
 *   Knowledge base role arn:aws:iam::<account>:role/demo-homeledger-knowledge-base
 *   is not able to call specified bedrock embedding model
 *   arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0:
 *   Error 002: Access to Bedrock models is not allowed for this account
 *   (Service: BedrockRuntime, Status Code: 400)
 *
 * Everything around this sentence is a moving part: the role ARN is
 * account-specific, the model ARN changes the moment the Knowledge Base is
 * re-pointed at a different embedding model or region, `Error 002` is an
 * undocumented internal identifier, and the `(Service: ..., Status Code: ...)`
 * suffix is a Java-SDK-style wrapper this Node client only sees because the
 * control plane passes the downstream error through verbatim.
 */
export const BEDROCK_ACCOUNT_BLOCK_MESSAGE = 'Access to Bedrock models is not allowed for this account';

/**
 * The sentence `bedrock-agent-runtime`'s `Retrieve` returns when the Knowledge
 * Base cannot serve the query — the one a person reading `ask_manual`'s output
 * through Claude Code actually saw, in full:
 *
 *   Invalid input or configuration provided. Check the input and Knowledge
 *   Base configuration and try your request again.
 *
 * Only the first sentence is pinned. The second is remediation advice AWS is
 * free to reword, and pinning it would break this matcher on a change that has
 * nothing to do with the condition.
 *
 * This wording is NOT the shape AWS uses for a caller-side malformed request.
 * A request whose parameters fail shape validation — a `knowledgeBaseId` that
 * does not match the service's pattern, a `numberOfResults` out of range — comes
 * back in the standard Smithy constraint form, `N validation error(s) detected:
 * Value '...' at '<field>' failed to satisfy constraint: ...`, which does not
 * contain this sentence and therefore does NOT match. That is the distinction
 * the two literals below are chosen to draw, and
 * `packages/core/test/bedrock-retriever.test.ts` pins it with the real
 * constraint-violation text as an explicit non-match.
 */
export const RETRIEVE_INVALID_CONFIGURATION_MESSAGE = 'Invalid input or configuration provided';

/**
 * Why a `Retrieve` call failed, to the resolution a caller can act on.
 *
 * Deliberately three outcomes and not two: `unclassified` exists so that
 * anything this module has NOT positively recognised is reported as an
 * unexplained failure rather than attributed to the Bedrock block. Attributing
 * every failure to the block is the same class of mistake as the raw AWS string
 * `ask_manual` used to surface — a confident, wrong explanation — just in the
 * opposite direction.
 */
export type RetrievalFailure = 'bedrock-model-access-blocked' | 'knowledge-base-missing' | 'unclassified';

function awsErrorFields(error: unknown): { name?: unknown; message?: unknown; status?: unknown } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { name?: unknown; message?: unknown; $metadata?: { httpStatusCode?: unknown } | null };
  return { name: candidate.name, message: candidate.message, status: candidate.$metadata?.httpStatusCode };
}

/**
 * Classifies a thrown `Retrieve` failure. Same detection discipline as
 * `scripts/manuals.ts`'s `isBedrockAccountBlock`, applied to the read path:
 * every branch requires the AWS error CLASS, the HTTP STATUS, and (for the
 * model block) a pinned MESSAGE literal. None of the three is sufficient alone,
 * and `packages/core/test/bedrock-retriever.test.ts` removes each one in turn
 * so no condition can be deleted without a test going red.
 *
 *  - Class, duck-typed on `name` rather than `instanceof`: each AWS SDK v3
 *    client bundles its own copy of the exception classes, so `instanceof` is
 *    unreliable across client and version boundaries (and across a pnpm store
 *    holding two resolutions of the same package). Branching on `name` is AWS's
 *    own documented v3 guidance.
 *  - Status: pins the error to a client-fault response the service actually
 *    returned, not a locally constructed or re-thrown lookalike, and rules out
 *    a 5xx that happened to carry the same text. A transient Bedrock outage
 *    that echoed the sentence must NOT be reported to a person as "model access
 *    is blocked on this account" — that sends them to open a support case for a
 *    condition that will clear on its own.
 *  - Message, for the model block only: `ValidationException` + 400 is also what
 *    `Retrieve` returns for a genuinely malformed request, which is a bug in
 *    this repository and must keep reading as an unexplained failure.
 *
 * `ResourceNotFoundException` needs no message literal because the class itself
 * already names the condition exactly: the Knowledge Base id this deployment
 * was configured with does not resolve. There is no second cause behind that
 * class on this API to separate out.
 *
 * Matching is case-sensitive. If AWS rewords either sentence this returns
 * `unclassified` and the caller says "the manual service returned an error"
 * instead of naming a cause — which is the correct direction to fail, since the
 * alternative is a matcher loose enough to explain failures it has not actually
 * recognised.
 */
export function classifyRetrievalFailure(error: unknown): RetrievalFailure {
  const fields = awsErrorFields(error);
  if (fields === undefined) return 'unclassified';
  const message = typeof fields.message === 'string' ? fields.message : '';
  if (fields.name === 'ValidationException' && fields.status === 400) {
    if (message.includes(BEDROCK_ACCOUNT_BLOCK_MESSAGE) || message.includes(RETRIEVE_INVALID_CONFIGURATION_MESSAGE)) return 'bedrock-model-access-blocked';
    return 'unclassified';
  }
  if (fields.name === 'ResourceNotFoundException' && fields.status === 404) return 'knowledge-base-missing';
  return 'unclassified';
}

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
            ...(request.applianceId ? { filter: { equals: { key: APPLIANCE_ID_METADATA_KEY, value: request.applianceId } } } : {})
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
