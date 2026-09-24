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
}

function isToolUse(block: Anthropic.ContentBlock): block is Anthropic.ToolUseBlock {
  return block.type === 'tool_use';
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
  deps.router.handler = prompt => askThePerson(deps, turnId, call.id, prompt);

  let outcome: ReturnType<typeof readToolResult>;
  try {
    const raw = await deps.mcp.callTool(call.name, args, progress =>
      deps.emit({
        type: 'progress',
        callId: call.id,
        progress: progress.progress,
        total: progress.total ?? PROGRESS_TOTAL,
        message: progress.message ?? ''
      })
    );
    outcome = readToolResult(raw);
  } catch (error) {
    outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    deps.router.handler = undefined;
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
  deps.registry.open(turnId);
  try {
    // Inside the try, not before it. `open()` has already happened by the time
    // anything is emitted, and an emit is a write onto a stream the browser can
    // have dropped between the POST and the first frame — it throws when it
    // has. Emitted outside the try, that one exit path skips the `finally` and
    // leaks the turn's entry for the life of the process, which is the failure
    // `ElicitationRegistry` documents that it cannot defend itself against.
    deps.emit({ type: 'turn-started', turnId });
    for (let round = 0; round < deps.maxRounds; round++) {
      const reply = await deps.model.respond({ system, messages, tools }, text => deps.emit({ type: 'assistant-text', text }));
      // The whole content array, unedited — thinking blocks included. They are
      // bound to the model that produced them and have to be echoed back
      // unchanged for the next round to continue the same reasoning.
      messages.push({ role: 'assistant', content: reply.content });
      const calls = reply.content.filter(isToolUse);
      if (calls.length === 0) return messages;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) results.push(await runOneCall(deps, turnId, call));
      messages.push({ role: 'user', content: results });
    }
    deps.emit({ type: 'turn-failed', message: `The assistant used its ${deps.maxRounds} tool rounds without finishing, so the turn was stopped.` });
    return messages;
  } finally {
    // A `finally` rather than a `close()` at each return site, and `close()` as
    // its first statement so nothing can run — or throw — between the turn
    // ending and the entry going away. Returned, threw, timed out, the model
    // errored, the stream aborted, the browser disconnected: `apps/simulator/test/agent.test.ts`
    // has one test per way out and each asserts the registry is empty after it.
    deps.registry.close(turnId, 'the turn ended');
    deps.emit({ type: 'turn-finished', turnId });
  }
}
