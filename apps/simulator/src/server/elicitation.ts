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

/**
 * The join between the MCP client's elicitation callback and a person's click.
 *
 * The callback runs inside `tools/call`, on a response stream the server is
 * holding open; the click arrives minutes later on a different HTTP request.
 * This is the only thing that connects them, and it lives in process memory —
 * which is exactly why `POST /api/agent/answer` must reach the process running
 * the turn. `unknown-turn` is what a person sees when it does not.
 */
export class ElicitationRegistry {
  private readonly turns = new Map<string, Map<string, Slot>>();

  open(turnId: string): void {
    if (!this.turns.has(turnId)) this.turns.set(turnId, new Map());
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
