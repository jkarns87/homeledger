import type Anthropic from '@anthropic-ai/sdk';
import type { ElicitationAnswer } from './elicitation.js';
import { ElicitationRegistry } from './elicitation.js';
import type { TurnEvent } from '../shared/events.js';
import type { ElicitPrompt, HomeLedgerMcp } from './mcp.js';
import type { ModelPort } from './model.js';
import { VOICE_MAX_ITEMS, buildSystemPrompt } from './prompt.js';
import { elicitationShape, readToolResult, toAnthropicTools, toToolResultBlock, widgetUriOf, type McpToolDescriptor } from './tools.js';

/** `book_service`'s availability check reports 0 of 3 through 3 of 3 (`apps/mcp-server/src/progress.ts`). */
export const PROGRESS_TOTAL = 3;

export interface ElicitRouter {
  handler: ((prompt: ElicitPrompt) => Promise<ElicitationAnswer>) | undefined;
  dispatch(prompt: ElicitPrompt): Promise<ElicitationAnswer>;
}

/**
 * Routes a server-initiated question to whichever turn is running.
 *
 * The MCP client is built once per conversation and holds one elicitation
 * handler for its whole life, but the thing that can answer a question is a
 * turn, which exists for a minute. This is the indirection between them, and
 * it **rejects** rather than defaulting when no turn is running: a question
 * arriving outside a turn means the client and the loop have got out of step,
 * and answering it with a silent cancel would look to everyone downstream like
 * a person who declined.
 */
export function createElicitRouter(): ElicitRouter {
  const router: ElicitRouter = {
    handler: undefined,
    async dispatch(prompt) {
      if (!router.handler) throw new Error('the server asked a question but no turn is running to answer it');
      return router.handler(prompt);
    }
  };
  return router;
}

export interface TurnDeps {
  model: ModelPort;
  mcp: Pick<HomeLedgerMcp, 'callTool' | 'rebuilds'>;
  registry: ElicitationRegistry;
  router: ElicitRouter;
  tools: McpToolDescriptor[];
  emit: (event: TurnEvent) => void;
  now: () => number;
  today: string;
  maxRounds: number;
  elicitationTimeoutMs: number;
  /**
   * Aborted when the turn must stop: the browser closed its stream, or the
   * conversation was reset. Handed to the model call and to every tool call,
   * and checked before each round and each call, so a turn nobody is watching
   * stops spending model rounds (final review I3).
   */
  signal?: AbortSignal;
}

/**
 * The stop reasons that end a turn without an answer, and the sentence each
 * one gets. Without these a refusal or a truncated reply with no text left
 * nothing on screen at all — no answer and no failure (final review I4).
 */
const STOPPED_WITHOUT_AN_ANSWER: Partial<Record<string, string>> = {
  refusal: 'The model declined to answer this request (stop reason: refusal), so the turn was stopped. Nothing further was done.',
  max_tokens:
    'The model ran out of room for its reply before it finished (stop reason: max_tokens), so the turn was stopped. Anything it was about to do was not done.'
};

function isToolUse(block: Anthropic.ContentBlock): block is Anthropic.ToolUseBlock {
  return block.type === 'tool_use';
}

/** A thrown value's own words, for a message that has to name two failures at once. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function askThePerson(deps: TurnDeps, turnId: string, callId: string, prompt: ElicitPrompt): Promise<ElicitationAnswer> {
  const shape = elicitationShape(prompt.requestedSchema);
  // Refuse, loudly, rather than render something else. A free-text box where
  // the server wanted one of five enum values lets a person answer something
  // that will be rejected, and a silent cancel would be indistinguishable from
  // a decline they never made.
  if (!shape) throw new Error(`the server asked a question this display cannot render: ${JSON.stringify(prompt.requestedSchema)}`);
  if (shape.options.length > VOICE_MAX_ITEMS)
    throw new Error(`the server offered ${shape.options.length} options and this display shows at most ${VOICE_MAX_ITEMS}`);

  const { elicitationId, answer } = deps.registry.ask(turnId, deps.elicitationTimeoutMs);
  // The rejection is adopted HERE and not at the `await` below, because the two
  // are not adjacent in every run: the emit between them writes a frame onto a
  // stream the browser may already have dropped, and it throws when it has. The
  // question is registered by then, so it is settled either way — by its own
  // timeout, or by `close()` rejecting it when the turn ends — and a rejection
  // nobody adopted is an unhandled rejection, which under Node's default policy
  // takes the process down. A turn abandoned on a disconnected browser must not
  // be able to kill the simulator.
  const settled: Promise<{ answered: true; value: ElicitationAnswer } | { answered: false }> = answer.then(
    value => ({ answered: true, value }),
    () => ({ answered: false })
  );
  deps.emit({ type: 'elicitation-opened', callId, elicitationId, prompt: prompt.message, field: shape.field, kind: shape.kind, options: shape.options });
  const outcome = await settled;
  if (!outcome.answered) {
    // Timed out, or the browser went away. `cancel` is the honest answer to
    // send the server: the question was never answered, and the server's own
    // handler turns that into "Okay, I haven't booked anything."
    deps.emit({ type: 'elicitation-closed', elicitationId, action: 'abandoned' });
    return { action: 'cancel' };
  }
  deps.emit({ type: 'elicitation-closed', elicitationId, action: outcome.value.action });
  return outcome.value;
}

async function runOneCall(deps: TurnDeps, turnId: string, call: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
  const args = (typeof call.input === 'object' && call.input !== null ? call.input : {}) as Record<string, unknown>;
  deps.emit({ type: 'tool-started', callId: call.id, tool: call.name, args });
  const started = deps.now();
  const rebuildsBefore = deps.mcp.rebuilds;
  const handler = (prompt: ElicitPrompt) => askThePerson(deps, turnId, call.id, prompt);
  deps.router.handler = handler;

  let outcome: ReturnType<typeof readToolResult>;
  try {
    const raw = await deps.mcp.callTool(
      call.name,
      args,
      progress =>
        deps.emit({
          type: 'progress',
          callId: call.id,
          progress: progress.progress,
          total: progress.total ?? PROGRESS_TOTAL,
          message: progress.message ?? ''
        }),
      { signal: deps.signal }
    );
    outcome = readToolResult(raw);
  } catch (error) {
    outcome = { ok: false, message: reasonOf(error) };
  } finally {
    // Only its own. A turn that outlived its welcome must not clear the slot
    // a later turn has since filled.
    if (deps.router.handler === handler) deps.router.handler = undefined;
  }

  // Checked outside the try so a rebuild that happened on the way to a failure
  // is still reported. A session that was silently rebuilt is a thing the
  // person watching should see once, not a thing only the logs know.
  if (deps.mcp.rebuilds > rebuildsBefore)
    deps.emit({ type: 'session-rebuilt', note: 'The connection to the household server had expired. It was re-established and the call was retried once.' });

  const ms = deps.now() - started;
  const tool = deps.tools.find(candidate => candidate.name === call.name);
  if (outcome.ok)
    deps.emit({
      type: 'tool-succeeded',
      callId: call.id,
      tool: call.name,
      spoken: outcome.spoken,
      // Both, and from the result rather than reconstructed: `spoken` is what
      // the transcript reads, `content` is half of the `{content,
      // structuredContent}` payload the MCP Apps view protocol specifies and
      // the only route by which Task 14's widget host can ever be handed it.
      content: outcome.content,
      structured: outcome.structured,
      widgetUri: tool ? widgetUriOf(tool) : null,
      ms
    });
  else deps.emit({ type: 'tool-failed', callId: call.id, tool: call.name, message: outcome.message, ms });
  return toToolResultBlock(call.id, outcome);
}

/**
 * One user turn: model, tools, model, until the model stops asking for tools.
 *
 * Tool calls run one at a time even when the model asks for several, because
 * they share one MCP session and because `book_service` holds its response
 * stream open across three questions — two of those in flight at once would
 * put two cards on one screen with no way to say which is which. That is a
 * sequencing choice inside the turn and it is not the property FL-033 is
 * about: the elicitation ANSWERS arrive on their own HTTP requests, into this
 * same process, while this loop is parked on `await`.
 */
export async function runTurn(deps: TurnDeps, turnId: string, history: Anthropic.MessageParam[], userText: string): Promise<Anthropic.MessageParam[]> {
  const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: userText }];
  const system = buildSystemPrompt({ today: deps.today, toolNames: deps.tools.map(tool => tool.name) });
  const tools = toAnthropicTools(deps.tools);
  // `true` before anything runs, because `open()` is not throw-free and the
  // order inside it decides who owns the entry: it sets the map entry first and
  // then calls the injected tripwire log, so an `open()` that THREW has left an
  // entry that this call created. Initialising to `true` makes the `finally`
  // clean that up; only an `open()` that returns `false` — someone else's turn,
  // already registered — leaves it alone.
  let mine = true;
  // Whether the browser was ever told this turn began. A `turn-finished` with
  // no `turn-started` ahead of it is a frame for a turn nothing downstream has
  // ever seen, and Task 11's reducer pairs the two.
  let announced = false;
  let failure: { error: unknown } | undefined;
  try {
    // Every one of these is inside the try, and each for its own reason.
    // `open()` because its logger can throw. The `turn-started` emit because an
    // emit is a write onto a stream the browser can have dropped between the
    // POST and the first frame. Outside the try, either one skips the `finally`
    // and leaks the turn's entry for the life of the process — the failure
    // `ElicitationRegistry` documents that it cannot defend itself against.
    mine = deps.registry.open(turnId);
    // Refused, not joined. Two turns on one id would have the first one's
    // `finally` reject the second one's open questions and delete its entry,
    // which downstream is indistinguishable from a person who cancelled.
    if (!mine) throw new Error(`turn ${turnId} is already running; a second turn cannot share its id`);
    deps.emit({ type: 'turn-started', turnId });
    announced = true;
    for (let round = 0; round < deps.maxRounds; round++) {
      deps.signal?.throwIfAborted();
      const reply = await deps.model.respond({ system, messages, tools }, text => deps.emit({ type: 'assistant-text', text }), deps.signal);
      const calls = reply.content.filter(isToolUse);
      const stopped = STOPPED_WITHOUT_AN_ANSWER[reply.stop_reason ?? ''];
      if (stopped) {
        // Kept only when it is a complete message the API will accept back: a
        // truncated tool call has no result to pair with, and an empty
        // assistant message is rejected on every later turn.
        if (reply.content.length > 0 && calls.length === 0) messages.push({ role: 'assistant', content: reply.content });
        deps.emit({ type: 'turn-failed', message: stopped });
        return messages;
      }
      // The whole content array, unedited — thinking blocks included. They are
      // bound to the model that produced them and have to be echoed back
      // unchanged for the next round to continue the same reasoning. Never an
      // EMPTY one: the Messages API refuses an empty non-final assistant
      // message, so storing one would fail every turn after this.
      if (reply.content.length > 0) messages.push({ role: 'assistant', content: reply.content });
      if (calls.length === 0) return messages;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        deps.signal?.throwIfAborted();
        results.push(await runOneCall(deps, turnId, call));
      }
      messages.push({ role: 'user', content: results });
    }
    deps.emit({ type: 'turn-failed', message: `The assistant used its ${deps.maxRounds} tool rounds without finishing, so the turn was stopped.` });
    return messages;
  } catch (error) {
    // Held only so the `finally` cannot destroy it. Rethrown unchanged here.
    failure = { error };
    throw error;
  } finally {
    // A `finally` rather than a `close()` at each return site, and `close()` as
    // its first statement so nothing can run — or throw — between the turn
    // ending and the entry going away. Returned, threw, timed out, the model
    // errored, the stream aborted, the browser disconnected: `apps/simulator/test/agent.test.ts`
    // has one test per way out and each asserts the registry is empty after it.
    if (mine) {
      deps.registry.close(turnId, 'the turn ended');
      try {
        if (announced) deps.emit({ type: 'turn-finished', turnId });
      } catch (error) {
        // A throw from a `finally` REPLACES whatever was in flight, and the
        // thing in flight is the reason the turn failed. Letting a dead stream
        // stand in for a rate limit sends whoever reads it after the wrong
        // problem entirely, and no caller can undo it from the outside — by the
        // time they see it the original is gone. So both travel: the message
        // names each, and `cause` carries the original error object with its own
        // type and stack intact. Nothing is swallowed — with no turn failure to
        // protect, this rethrows the stream's own error untouched.
        if (!failure) throw error;
        throw new Error(`the turn failed (${reasonOf(failure.error)}) and its stream could not be told: ${reasonOf(error)}`, { cause: failure.error });
      }
    }
  }
}
