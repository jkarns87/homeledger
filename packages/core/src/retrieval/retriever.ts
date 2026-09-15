/** One retrieved manual passage. Matches design spec 4.2's ask_manual output row. */
export interface Passage {
  text: string;
  docTitle: string;
  /** 1-based PDF page, or null when the source carried no page metadata. */
  page: number | null;
  score: number;
}

export interface RetrieveOptions {
  question: string;
  /** When supplied, restrict retrieval to this appliance's manual. */
  applianceId?: string;
  /** Defaults to MAX_PASSAGES; never exceeds it. */
  maxPassages?: number;
}

/**
 * The port ask_manual talks to. Two adapters implement it: an in-memory
 * fixture for unit and contract tests, and a Bedrock Knowledge Base client
 * for the deployed runtime.
 */
export interface ManualRetriever {
  retrieve(options: RetrieveOptions): Promise<Passage[]>;
}

/** Spec 4.2: ask_manual returns at most three passages. */
export const MAX_PASSAGES = 3;

export function clampPassages(requested: number | undefined): number {
  if (requested === undefined) return MAX_PASSAGES;
  return Math.max(1, Math.min(MAX_PASSAGES, Math.trunc(requested)));
}
