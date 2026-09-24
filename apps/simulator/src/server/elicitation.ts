import { randomUUID } from 'node:crypto';
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'node:timers';

export type ElicitationAnswer = { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' } | { action: 'cancel' };

/**
 * What happened to an answer that arrived on its own HTTP request.
 *
 * Three outcomes rather than a boolean because the route has to say which
 * went wrong. "unknown-turn" means this process is not the one running that
 * turn — the FL-039 class of failure, where a request lands somewhere that has
 * never heard of the state it names — and "unknown-question" means the
 * question is already settled, which is a double click or a late one. Reporting
 * both as "no" would put a person in front of a card that does nothing and
 * says nothing.
 */
export type AnswerOutcome = 'delivered' | 'unknown-turn' | 'unknown-question';

export class TurnClosedError extends Error {}
export class ElicitationTimeoutError extends Error {}

interface Slot {
  resolve: (answer: ElicitationAnswer) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** How many open turns trigger a tripwire log if no caller supplies its own. */
export const DEFAULT_TURN_COUNT_WARNING_THRESHOLD = 500;

export interface ElicitationRegistryOptions {
  /**
   * Called once for every multiple of `turnCountWarningThreshold` a newly
   * opened turn reaches. Defaults to `console.warn` rather than a no-op —
   * this registry has no way to tell a legitimately idle turn from an
   * abandoned one (see the class doc comment), so it does not evict either
   * one; the tripwire exists so a caller that never close()s a turn on some
   * exit path shows up as a signal instead of silent, gradual growth. A
   * caller that already has a structured logger can pass it here instead.
   */
  log?: (message: string) => void;
  turnCountWarningThreshold?: number;
}

/**
 * The join between the MCP client's elicitation callback and a person's click.
 *
 * The callback runs inside `tools/call`, on a response stream the server is
 * holding open; the click arrives minutes later on a different HTTP request.
 * This is the only thing that connects them, and it lives in process memory —
 * which is exactly why `POST /api/agent/answer` must reach the process running
 * the turn. `unknown-turn` is what a person sees when it does not.
 *
 * No `Slot` (a pending `ask()` promise and its timer) ever outlives its own
 * settlement — `answer()`, the per-question timeout, and `close()` are the
 * only three places one is removed, and each clears the native timer and
 * settles the promise before returning. What this registry does *not*
 * guarantee is that `open()` is always followed by a `close()`: the turn-level
 * entry (empty of any Slot once its questions are settled) stays registered
 * until something calls `close(turnId, ...)` for it. That pairing is the
 * caller's obligation — on every exit path, not just the happy one — because
 * the interface gives this registry no activity signal to tell a legitimately
 * idle turn from an abandoned one, and a guessed TTL or sweep would silently
 * kill the former. `size` and the tripwire log below exist so a caller that
 * gets this wrong is observable rather than a slow, unattributed memory leak.
 */
export class ElicitationRegistry {
  private readonly turns = new Map<string, Map<string, Slot>>();
  private readonly log: (message: string) => void;
  private readonly turnCountWarningThreshold: number;

  constructor(options: ElicitationRegistryOptions = {}) {
    this.log = options.log ?? (message => console.warn(message));
    this.turnCountWarningThreshold = options.turnCountWarningThreshold ?? DEFAULT_TURN_COUNT_WARNING_THRESHOLD;
  }

  /** How many turns are currently open. Observability only — see the class doc comment: nothing here evicts on it. */
  get size(): number {
    return this.turns.size;
  }

  /**
   * Registers a turn, and says whether THIS call is the one that registered it.
   *
   * The boolean is the whole point and it is not a convenience. `open()` is
   * idempotent, which used to mean a caller could not tell "I opened this turn"
   * from "somebody else already had it open" — and the caller's `close()` is
   * unconditional, so a second turn admitted on the same id would have the
   * first turn's `finally` reject the second's questions and delete its entry.
   * Returning `false` lets the caller refuse instead of joining. That is a
   * precondition, not the TTL-shaped heuristic this class declines to run: it
   * decides on a fact the registry holds right now rather than on a guess about
   * how long a turn is allowed to be idle.
   */
  open(turnId: string): boolean {
    if (this.turns.has(turnId)) return false;
    this.turns.set(turnId, new Map());
    // Note the ordering, which the caller depends on: the entry is in the map
    // BEFORE the injected log runs. A log that throws therefore leaves an entry
    // this call created and did not return for, so "open() threw" has to count
    // as "the entry is mine" on the caller's side — see `runTurn`'s `mine`.
    if (this.turns.size % this.turnCountWarningThreshold === 0) {
      this.log(
        `ElicitationRegistry has ${this.turns.size} open turns, a multiple of its ${this.turnCountWarningThreshold}-turn tripwire. If every open() is not paired with a close() on every exit path, this grows without bound.`
      );
    }
    return true;
  }

  has(turnId: string): boolean {
    return this.turns.has(turnId);
  }

  ask(turnId: string, timeoutMs: number): { elicitationId: string; answer: Promise<ElicitationAnswer> } {
    const slots = this.turns.get(turnId);
    if (!slots) throw new TurnClosedError(`turn ${turnId} is not open, so it cannot ask anything`);
    const elicitationId = randomUUID();
    let resolve!: (answer: ElicitationAnswer) => void;
    let reject!: (error: Error) => void;
    const answer = new Promise<ElicitationAnswer>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setNodeTimeout(() => {
      slots.delete(elicitationId);
      reject(new ElicitationTimeoutError(`nobody answered question ${elicitationId} within ${timeoutMs} ms`));
    }, timeoutMs);
    // A pending question must never be the reason the process refuses to exit.
    timer.unref();
    slots.set(elicitationId, { resolve, reject, timer });
    return { elicitationId, answer };
  }

  answer(turnId: string, elicitationId: string, value: ElicitationAnswer): AnswerOutcome {
    const slots = this.turns.get(turnId);
    if (!slots) return 'unknown-turn';
    const slot = slots.get(elicitationId);
    if (!slot) return 'unknown-question';
    // Deleted before resolving, so a second delivery cannot reach a settled
    // promise even if the resolver synchronously re-enters this method.
    slots.delete(elicitationId);
    clearNodeTimeout(slot.timer);
    slot.resolve(value);
    return 'delivered';
  }

  close(turnId: string, reason: string): void {
    const slots = this.turns.get(turnId);
    if (!slots) return;
    this.turns.delete(turnId);
    for (const slot of slots.values()) {
      clearNodeTimeout(slot.timer);
      slot.reject(new TurnClosedError(reason));
    }
  }
}
