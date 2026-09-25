import type Anthropic from '@anthropic-ai/sdk';
import type { ModelPort } from './model.js';

function toolUse(id: string, name: string, input: Record<string, unknown>): Anthropic.ContentBlock {
  return { type: 'tool_use', id, name, input } as unknown as Anthropic.ContentBlock;
}

function text(value: string): Anthropic.ContentBlock {
  return { type: 'text', text: value } as unknown as Anthropic.ContentBlock;
}

function lastUserText(messages: Anthropic.MessageParam[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.content === 'string') return message.content.toLowerCase();
  }
  return '';
}

/**
 * `request.messages` from the boundary of the person's own last typed message
 * onward, dropping every earlier turn.
 *
 * `conversation.history` (`src/server/session.ts`) is one process-wide array
 * that every turn appends to and the NEXT turn is handed in full — which is
 * correct for the real model (Claude reads its own past tool calls as
 * context) and wrong for this stand-in, which uses "has this tool already run"
 * as its only state machine. Scoped to the whole array, that check answers a
 * different question than the one each branch below means to ask: once ANY
 * earlier turn in the process has called `list_appliances` — as the Playwright
 * suite's own "asking about appliances" spec does before the booking spec
 * runs — every later turn sees `calls.includes('list_appliances')` as true
 * from a call that has nothing to do with it, so the booking turn skips
 * straight to reading an appliance id out of the FIRST match anywhere in the
 * accumulated JSON. Seeded appliance order puts the furnace first, so a
 * request that asked to book service for the water heater booked the furnace
 * instead — silently, because `book_service` cannot tell a scripted mistake
 * from a real request; four furnace providers rendered where the test
 * expected the water heater's three is what actually surfaced this, in the
 * one place jsdom cannot run this file's counterpart: a live multi-turn
 * browser session. `lastUserText` above already needed the same boundary for
 * text; this is that boundary applied to the tool-call state machine too.
 */
function currentTurnMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.content === 'string') return messages.slice(index);
  }
  return messages;
}

function applianceIdIn(messages: Anthropic.MessageParam[]): string | undefined {
  return /appl_[a-z0-9]{16}/.exec(JSON.stringify(messages))?.[0];
}

/**
 * A stand-in that follows the same three demo paths the video does.
 *
 * It is not a model and does not pretend to be: it looks at the last thing the
 * person typed and at whether a tool has already run, and picks the next call.
 * That is enough to drive every wire in this application — tool calls,
 * elicitation, progress, widgets, failures — deterministically and for free,
 * which is what an end-to-end suite needs and what a model cannot give it.
 *
 * Each intent below is its OWN self-contained branch, checked once by keyword
 * and then settled entirely on its own tool having run — never a flat chain of
 * independent conditions. A flat chain was the first shape this took and it
 * has a real bug: once a specific intent's own tool has been called, ITS OWN
 * condition (`... && !calls.includes(...)`) goes false and control falls
 * through to whichever unrelated condition is next, rather than stopping. For
 * "what does the manual say about F21", round two falls out of the (now-false)
 * manual branch into the generic "haven't called list_appliances yet" catch-all
 * and fires an unrelated `list_appliances` call the person never asked for.
 * Nesting each intent's follow-up under its own `if` — matched by keyword once
 * and answered with text on every later round of the SAME turn — keeps a
 * satisfied intent satisfied instead of leaking into the next unclaimed branch.
 */
export function createScriptedModel(): ModelPort {
  return {
    async respond(request, onText) {
      const asked = lastUserText(request.messages);
      const turnMessages = currentTurnMessages(request.messages);
      const applianceId = applianceIdIn(turnMessages);
      const calls = JSON.stringify(turnMessages);
      let content: Anthropic.ContentBlock[];

      if (asked.includes('book')) {
        if (!calls.includes('list_appliances')) content = [toolUse('c1', 'list_appliances', { category: 'water_heater' })];
        else if (applianceId && !calls.includes('book_service'))
          content = [toolUse('c2', 'book_service', { applianceId, issue: 'water heater leaking at the base' })];
        else content = [text('Here is what I found.')];
      } else if (asked.includes('manual')) {
        content = calls.includes('ask_manual') ? [text('Here is what I found.')] : [toolUse('c3', 'ask_manual', { question: 'what does F21 mean' })];
      } else if (asked.includes('due')) {
        content = calls.includes('maintenance_due') ? [text('Here is what I found.')] : [toolUse('c4', 'maintenance_due', { horizonDays: 30 })];
      } else {
        content = calls.includes('list_appliances') ? [text('Here is what I found.')] : [toolUse('c5', 'list_appliances', {})];
      }

      for (const block of content) if (block.type === 'text') onText(block.text);
      return {
        id: 'scripted',
        type: 'message',
        role: 'assistant',
        model: 'scripted',
        content,
        stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      } as unknown as Anthropic.Message;
    }
  };
}
