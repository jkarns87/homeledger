import type { Server } from 'node:http';
import type Anthropic from '@anthropic-ai/sdk';
import { createApp } from '@homeledger/mcp-server/app';
import { seededDeps } from '@homeledger/mcp-server/test-harness';
import { afterEach, describe, expect, it } from 'vitest';
import { createElicitRouter, runTurn, type TurnDeps } from '../src/server/agent.js';
import { ElicitationRegistry } from '../src/server/elicitation.js';
import type { TurnEvent } from '../src/shared/events.js';
import { HomeLedgerMcp } from '../src/server/mcp.js';
import type { ModelPort, ModelRequest } from '../src/server/model.js';
import { NO_DATA_NOTICE } from '../src/server/tools.js';
import { buildSystemPrompt } from '../src/server/prompt.js';

let server: Server | undefined;
let closeApp: () => Promise<void> = async () => {};
let closeClient: () => Promise<void> = async () => {};

afterEach(async () => {
  await closeClient();
  await closeApp();
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  closeApp = async () => {};
  closeClient = async () => {};
});

/**
 * A model that plays a fixed script of turns, one per round.
 *
 * `seen` is not decoration. A fake that reads only `request.messages` cannot
 * express a loop that hands the model an empty system prompt or an empty tool
 * list, and the first of those silently strips every anti-fabrication rule
 * Task 7 wrote — the honest-failure instruction, the no-invented-cause clause,
 * the spoken-text discipline — while every assertion about events and tool
 * results stays green. So every request the loop makes is recorded, and
 * `'hands the model the system prompt, the tools and the history'` reads them.
 */
function scriptedModel(script: Array<(messages: Anthropic.MessageParam[]) => Anthropic.ContentBlock[]>, seen: ModelRequest[] = []): ModelPort {
  let round = 0;
  return {
    async respond(request, onText) {
      // A SNAPSHOT, not the live object. `runTurn` pushes into one `messages`
      // array and hands the same reference to every round, so recording the
      // reference would make each round's assertion read the conversation as it
      // ended rather than as that round received it — and a loop that sent the
      // whole history on round one would be indistinguishable from this one.
      seen.push({ ...request, messages: [...request.messages] });
      const content = script[round++]?.(request.messages) ?? [{ type: 'text', text: 'Done.' } as Anthropic.ContentBlock];
      for (const block of content) if (block.type === 'text') onText(block.text);
      return {
        id: `msg_${round}`,
        type: 'message',
        role: 'assistant',
        model: 'fake',
        content,
        stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
      } as unknown as Anthropic.Message;
    }
  };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): Anthropic.ContentBlock {
  return { type: 'tool_use', id, name, input } as unknown as Anthropic.ContentBlock;
}

function text(value: string): Anthropic.ContentBlock {
  return { type: 'text', text: value } as Anthropic.ContentBlock;
}

/** Pulls the first appliance id out of the tool_result text the previous round produced. */
function applianceIdFrom(messages: Anthropic.MessageParam[]): string {
  const text = JSON.stringify(messages);
  return /appl_[a-z0-9]{16}/.exec(text)?.[0] ?? 'appl_missing';
}

/**
 * Everything `runTurn` needs with no server and no socket.
 *
 * The two guards inside `askThePerson` — an unrenderable schema, and more
 * options than this display shows — cannot be reached through the real server:
 * `apps/mcp-server/src/elicit.ts` only ever builds an enum or a boolean, and
 * `packages/core`'s `providersForCategory` ends in `.slice(0, MAX_PROVIDER_OPTIONS)`
 * with `MAX_PROVIDER_OPTIONS = 5`, so no fixture can offer six. A guard no
 * fixture can reach is the FL-032 N6 shape exactly, and the answer is a fake
 * that produces the shape rather than an assertion that quietly cannot fail.
 */
function fakeDeps(requestedSchema: unknown, over: Partial<TurnDeps> = {}) {
  const router = createElicitRouter();
  const events: TurnEvent[] = [];
  const turnDeps: TurnDeps = {
    model: scriptedModel([
      () => [toolUse('c1', 'book_service', { applianceId: 'appl_x', issue: 'leak' })],
      () => [{ type: 'text', text: 'I could not book that.' } as Anthropic.ContentBlock]
    ]),
    mcp: {
      rebuilds: 0,
      // What book_service does: ask through the connection the caller opened,
      // and let whatever comes back decide the result.
      callTool: async () => {
        const answer = await router.dispatch({ message: 'pick one', requestedSchema });
        return { content: [{ type: 'text', text: `answered ${answer.action}` }], structuredContent: { action: answer.action } };
      }
    },
    registry: new ElicitationRegistry(),
    router,
    tools: [{ name: 'book_service', description: 'Book a service visit.', inputSchema: { type: 'object' } }],
    emit: event => events.push(event),
    now: () => 0,
    today: '2026-09-13',
    maxRounds: 4,
    elicitationTimeoutMs: 2000,
    ...over
  };
  return { turnDeps, events, router };
}

async function harness(model: ModelPort, over: Partial<TurnDeps> = {}) {
  const deps = await seededDeps();
  const app = createApp(deps);
  closeApp = app.close;
  server = app.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const url = `http://127.0.0.1:${(server!.address() as { port: number }).port}/mcp`;
  const router = createElicitRouter();
  const mcp = new HomeLedgerMcp({ url, token: async () => 'unused-locally', onElicit: prompt => router.dispatch(prompt) });
  closeClient = () => mcp.close();
  await mcp.connect();
  const events: TurnEvent[] = [];
  const turnDeps: TurnDeps = {
    model,
    mcp,
    registry: new ElicitationRegistry(),
    router,
    tools: await mcp.listTools(),
    emit: event => events.push(event),
    now: () => 0,
    today: '2026-09-13',
    maxRounds: 6,
    elicitationTimeoutMs: 2000,
    ...over
  };
  return { turnDeps, events };
}

describe('runTurn', () => {
  it('calls a tool, emits its success, and feeds the result back to the model', async () => {
    const { turnDeps, events } = await harness(
      scriptedModel([() => [toolUse('c1', 'list_appliances', {})], () => [{ type: 'text', text: 'Six appliances.' } as Anthropic.ContentBlock]])
    );
    const messages = await runTurn(turnDeps, 't1', [], 'what appliances do we have');

    expect(events.map(e => e.type)).toEqual(['turn-started', 'tool-started', 'tool-succeeded', 'assistant-text', 'turn-finished']);
    const success = events.find(e => e.type === 'tool-succeeded');
    expect(success && success.type === 'tool-succeeded' && success.widgetUri).toBe('ui://homeledger/appliances');

    // The tool result really reached the model, as a tool_result block keyed to the call.
    const fedBack = messages[2];
    expect(fedBack?.role).toBe('user');
    expect(JSON.stringify(fedBack?.content)).toContain('"tool_use_id":"c1"');
    expect(JSON.stringify(fedBack?.content)).not.toContain('is_error');
  });

  it('surfaces a failed call as a failure and tells the model nothing was retrieved', async () => {
    const { turnDeps, events } = await harness(
      scriptedModel([() => [toolUse('c1', 'no_such_tool', {})], () => [{ type: 'text', text: 'That failed.' } as Anthropic.ContentBlock]])
    );
    const messages = await runTurn(turnDeps, 't1', [], 'do the impossible');

    const failure = events.find(e => e.type === 'tool-failed');
    expect(failure).toBeDefined();
    expect(events.some(e => e.type === 'tool-succeeded')).toBe(false);
    const fedBack = JSON.stringify(messages[2]?.content);
    expect(fedBack).toContain('"is_error":true');
    expect(fedBack).toContain('NO DATA WAS RETRIEVED');
  });

  it('drives the three-round booking through the registry and reports progress 0 to 3', async () => {
    const { turnDeps, events } = await harness(
      scriptedModel([
        () => [toolUse('c1', 'list_appliances', { category: 'water_heater' })],
        messages => [toolUse('c2', 'book_service', { applianceId: applianceIdFrom(messages), issue: 'water heater leaking at the base' })],
        () => [{ type: 'text', text: 'Booked.' } as Anthropic.ContentBlock]
      ])
    );

    // Answer each question as it is opened. This runs concurrently with the
    // turn on purpose: the tool call is still open while these land, which is
    // the whole shape the UI has to support.
    const answered: string[] = [];
    const originalEmit = turnDeps.emit;
    turnDeps.emit = event => {
      originalEmit(event);
      if (event.type !== 'elicitation-opened') return;
      answered.push(event.field);
      const content = event.field === 'provider' ? { provider: 'prov_kettle_water' } : event.field === 'window' ? { window: 'win_1' } : { confirm: true };
      setTimeout(() => turnDeps.registry.answer('t1', event.elicitationId, { action: 'accept', content }), 0);
    };

    await runTurn(turnDeps, 't1', [], 'book a plumber for the water heater');

    expect(answered).toEqual(['provider', 'window', 'confirm']);
    const opened = events.filter(e => e.type === 'elicitation-opened');
    expect(opened[0]?.type === 'elicitation-opened' && opened[0].kind).toBe('choice');
    // The three water_heater providers packages/core seeds, by value and in
    // order. The assertion this replaces was `options.length <= 5` against a
    // category that holds three and a server that slices to five: the value
    // was 3, the bound was 5, and no change to anything could have failed it.
    // The ceiling itself is tested where the ceiling is, two tests below.
    expect(opened[0]?.type === 'elicitation-opened' && opened[0].options.map(o => o.value)).toEqual([
      'prov_kettle_water',
      'prov_anode_and_co',
      'prov_hotline_tank'
    ]);
    expect(opened[2]?.type === 'elicitation-opened' && opened[2].kind).toBe('confirm');
    expect(events.filter(e => e.type === 'progress').map(e => (e.type === 'progress' ? e.progress : -1))).toEqual([0, 1, 2, 3]);
    expect(events.filter(e => e.type === 'elicitation-closed')).toHaveLength(3);
    const booked = events.find(e => e.type === 'tool-succeeded' && e.tool === 'book_service');
    expect(booked && booked.type === 'tool-succeeded' && (booked.structured as { status: string }).status).toBe('scheduled');
  });

  it('closes the turn and abandons an unanswered question rather than hanging forever', async () => {
    const { turnDeps, events } = await harness(
      scriptedModel([
        () => [toolUse('c1', 'list_appliances', { category: 'water_heater' })],
        messages => [toolUse('c2', 'book_service', { applianceId: applianceIdFrom(messages), issue: 'no hot water' })],
        () => [{ type: 'text', text: 'I could not book it.' } as Anthropic.ContentBlock]
      ]),
      { elicitationTimeoutMs: 30 }
    );
    await runTurn(turnDeps, 't1', [], 'book a plumber');
    expect(events.some(e => e.type === 'elicitation-closed' && e.action === 'abandoned')).toBe(true);
    expect(turnDeps.registry.has('t1')).toBe(false);
  });

  it('stops after the round budget instead of looping', async () => {
    const { turnDeps, events } = await harness(scriptedModel(Array.from({ length: 10 }, () => () => [toolUse(`c${Math.random()}`, 'list_appliances', {})])), {
      maxRounds: 2
    });
    await runTurn(turnDeps, 't1', [], 'loop please');
    expect(events.filter(e => e.type === 'tool-started')).toHaveLength(2);
    expect(events.some(e => e.type === 'turn-failed')).toBe(true);
  });

  it('refuses a question it cannot render, and reports the call as failed rather than answering for the person', async () => {
    // A free-text field where the card can only offer buttons. The previous
    // version of this test passed `requestedSchema` to a bare `dispatch` with
    // no handler set, which rejects with "no turn is running" whatever the
    // schema is - a renderable enum produced the identical rejection - so the
    // behaviour named in the title was never exercised.
    const { turnDeps, events } = fakeDeps({ type: 'object', properties: { note: { type: 'string' } }, required: ['note'] });
    await runTurn(turnDeps, 't1', [], 'book a plumber');
    const failure = events.find(e => e.type === 'tool-failed');
    expect(failure && failure.type === 'tool-failed' && failure.message).toMatch(/this display cannot render/);
    expect(events.some(e => e.type === 'elicitation-opened')).toBe(false);
  });

  it('refuses a choice wider than the display shows, rather than truncating it', async () => {
    // Six options where the published functional requirement is five. The
    // server cannot produce this - its marketplace slices to five and the
    // water_heater category holds three - so the only way to reach the guard
    // is to hand it the shape directly. Truncating instead would put a
    // provider the person was never shown into a booking they confirmed.
    const { turnDeps, events } = fakeDeps({
      type: 'object',
      properties: { provider: { type: 'string', enum: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] } },
      required: ['provider']
    });
    await runTurn(turnDeps, 't1', [], 'book a plumber');
    const failure = events.find(e => e.type === 'tool-failed');
    expect(failure && failure.type === 'tool-failed' && failure.message).toMatch(/offered 6 options and this display shows at most 5/);
    expect(events.some(e => e.type === 'elicitation-opened')).toBe(false);
  });

  it('hands the model the system prompt, the tools and the history, on every round', async () => {
    // Three things the loop passes and nothing else in this file reads. The
    // system prompt is the dangerous one: blanked, it strips every
    // anti-fabrication rule Task 7 added — the instruction to say a call
    // failed, the ban on inventing a cause, the spoken-text discipline — and
    // every other assertion in this file stays green, because the fakes here
    // do as they are told whatever they are asked.
    const seen: ModelRequest[] = [];
    const history: Anthropic.MessageParam[] = [
      { role: 'user', content: 'what is the boiler' },
      { role: 'assistant', content: 'A water heater in the basement.' }
    ];
    // Two tools, given in descending (non-alphabetical) order, and a `today`
    // that is not `loopDeps`' own default ('2026-09-13'). Every other test in
    // this file runs against that default with `loopDeps`' one tool, so a
    // loop that hardcoded `toolNames: ['list_appliances']` or
    // `today: '2026-09-13'` instead of reading `deps.tools` and `deps.today`
    // would still satisfy every one of them — the fixture and the hardcoded
    // pair would agree by coincidence. Overriding both here is what makes
    // this test the one that disagrees with a hardcoded pair.
    const tools = [
      { name: 'schedule_visit', description: 'Schedule a visit.', inputSchema: { type: 'object' } },
      { name: 'list_appliances', description: 'List the appliances.', inputSchema: { type: 'object' } }
    ];
    const { turnDeps } = loopDeps({
      model: scriptedModel([() => [toolUse('c1', 'list_appliances', {})], () => [text('Six appliances.')]], seen),
      today: '2030-01-01',
      tools
    });
    await runTurn(turnDeps, 't1', history, 'and the washer');

    expect(seen).toHaveLength(2);
    // Equality against the prompt builder pins the wiring — the deps' `today`
    // and the LIVE tool names, read off the fixture above rather than off
    // `loopDeps`' default — and the two fragments beside it are the
    // independent anchor that a prompt quietly emptied of its failure rules
    // would fail even though both sides still agreed.
    expect(seen[0]?.system).toBe(buildSystemPrompt({ today: '2030-01-01', toolNames: ['schedule_visit', 'list_appliances'] }));
    expect(seen[0]?.system).toContain('If a tool call fails, say so.');
    expect(seen[0]?.system).toContain('Today is 2030-01-01.');
    // The tools as the server described them, not a list of bare names, and
    // in the order the fixture gave them.
    expect(seen[0]?.tools).toEqual([
      { name: 'schedule_visit', description: 'Schedule a visit.', input_schema: { type: 'object' } },
      { name: 'list_appliances', description: 'List the appliances.', input_schema: { type: 'object' } }
    ]);
    // The conversation so far, ahead of this turn's own text.
    expect(seen[0]?.messages).toHaveLength(3);
    expect(seen[0]?.messages.slice(0, 2)).toEqual(history);
    expect(seen[0]?.messages[2]).toEqual({ role: 'user', content: 'and the washer' });
    // Round two is not a fresh conversation: the same prompt and tools, and the
    // first round's assistant turn and tool result appended to what it had.
    expect(seen[1]?.system).toBe(seen[0]?.system);
    expect(seen[1]?.tools).toEqual(seen[0]?.tools);
    expect(seen[1]?.messages).toHaveLength(5);
    expect(seen[1]?.messages.slice(0, 3)).toEqual(seen[0]?.messages);
  });

  it('keeps the assistant turn in history exactly as the model wrote it, thinking blocks included', async () => {
    // A thinking block is bound to the model that produced it and has to be
    // echoed back byte-identical for the next round to continue the same
    // reasoning; a tool_use block has to be there for the tool_result that
    // follows it to be addressable at all. Nothing else in this file reads
    // `messages[1]`, so without this a loop that pushed only the text would
    // pass every other assertion here and fail against the real API.
    const thinking = { type: 'thinking', thinking: 'the washer is the one they mean', signature: 'sig_abc' } as unknown as Anthropic.ContentBlock;
    const call = toolUse('c1', 'list_appliances', {});
    const { turnDeps } = await harness(scriptedModel([() => [thinking, call], () => [{ type: 'text', text: 'Six appliances.' } as Anthropic.ContentBlock]]));
    const messages = await runTurn(turnDeps, 't1', [], 'what appliances do we have');
    expect(messages[1]).toEqual({ role: 'assistant', content: [thinking, call] });
  });

  it('rejects a question that arrives when no turn is running, rather than silently cancelling it', async () => {
    // The router's own guard, tested for what it is. A question outside a turn
    // means the client and the loop are out of step, and answering it with a
    // cancel would look downstream exactly like a person who declined.
    const router = createElicitRouter();
    await expect(router.dispatch({ message: 'pick', requestedSchema: { properties: { free: { type: 'string' } } } })).rejects.toThrow(/no turn is running/);
  });
});

/** A renderable single-select, the only other shape `apps/mcp-server/src/elicit.ts` builds besides a boolean. */
const CHOICE_SCHEMA = {
  type: 'object',
  properties: { provider: { type: 'string', title: 'Provider', enum: ['p1', 'p2'], enumNames: ['One', 'Two'] } },
  required: ['provider']
};

/** `runTurn`'s dependencies with no server and no socket, for the exit paths a socket cannot produce. */
function loopDeps(over: Partial<TurnDeps> = {}) {
  const router = createElicitRouter();
  const events: TurnEvent[] = [];
  const turnDeps: TurnDeps = {
    model: scriptedModel([() => [toolUse('c1', 'list_appliances', {})], () => [{ type: 'text', text: 'Six appliances.' } as Anthropic.ContentBlock]]),
    mcp: { rebuilds: 0, callTool: async () => ({ content: [{ type: 'text', text: 'Six appliances.' }], structuredContent: { appliances: [] } }) },
    registry: new ElicitationRegistry(),
    router,
    tools: [{ name: 'list_appliances', description: 'List the appliances.', inputSchema: { type: 'object' } }],
    emit: event => events.push(event),
    now: () => 0,
    today: '2026-09-13',
    maxRounds: 4,
    elicitationTimeoutMs: 2000,
    ...over
  };
  return { turnDeps, events, router };
}

/**
 * Records `registry.size` at the moment one event is emitted.
 *
 * Every test below ends in `expect(registry.size).toBe(0)`, and on its own that
 * assertion is the "absence against an empty value" shape: a registry whose
 * `open()` was deleted is empty at the end of every one of them. Sampling the
 * size mid-turn is what discriminates — the turn has to have been open for the
 * closing assertion to mean it was closed.
 */
function watchSize(turnDeps: TurnDeps, at: TurnEvent['type'], sizes: number[]): void {
  const inner = turnDeps.emit;
  turnDeps.emit = event => {
    if (event.type === at) sizes.push(turnDeps.registry.size);
    inner(event);
  };
}

/**
 * The turn is closed on every way out, proved one way out at a time.
 *
 * `ElicitationRegistry` cannot defend itself: it has no activity signal that
 * separates a turn idling while somebody reads a card from a turn nobody will
 * ever come back to, so a TTL or a sweep there would eventually kill a real
 * slow conversation. It says so on the class, and it names this file as the
 * owner of the pairing. A `finally` is the mechanism rather than a `close()`
 * at each `return`, because the return sites grow and one eventually gets
 * missed — so each test here is an exit path, and the happy one is only the
 * first of eight.
 */
describe('runTurn closes its turn on every exit path', () => {
  it('closes a turn that returned normally', async () => {
    const sizes: number[] = [];
    const { turnDeps, events } = loopDeps();
    watchSize(turnDeps, 'tool-started', sizes);
    await runTurn(turnDeps, 't1', [], 'what appliances do we have');
    expect(events.at(-1)?.type).toBe('turn-finished');
    expect(sizes).toEqual([1]);
    expect(turnDeps.registry.size).toBe(0);
  });

  it('announces a call with the id and the arguments the model actually chose', async () => {
    // The transcript renders these and the debug drawer cannot: `mcp.ts`
    // deliberately logs no payloads, so this event is the only place the
    // arguments of a call are ever visible. An empty object or a missing id
    // reads as a call with no inputs rather than as a bug.
    const { turnDeps, events } = loopDeps({
      model: scriptedModel([() => [toolUse('call_7', 'list_appliances', { category: 'water_heater', limit: 3 })], () => [text('Three.')]])
    });
    await runTurn(turnDeps, 't1', [], 'what water heaters do we have');
    const started = events.find(e => e.type === 'tool-started');
    expect(started && started.type === 'tool-started' && started.callId).toBe('call_7');
    expect(started && started.type === 'tool-started' && started.tool).toBe('list_appliances');
    expect(started && started.type === 'tool-started' && started.args).toEqual({ category: 'water_heater', limit: 3 });
    // The same id ties the result back to the call it belongs to.
    const succeeded = events.find(e => e.type === 'tool-succeeded');
    expect(succeeded && succeeded.type === 'tool-succeeded' && succeeded.callId).toBe('call_7');
  });

  it('carries the question the server asked, word for word, to the card that renders it', async () => {
    // The person reads this sentence and nothing else: `field` and `options`
    // are ids. A card that showed the field name instead would ask "provider"
    // where the server asked who should be sent for the water heater.
    const events: TurnEvent[] = [];
    const { turnDeps } = fakeDeps(CHOICE_SCHEMA, {
      emit: event => {
        events.push(event);
        if (event.type === 'elicitation-opened') setTimeout(() => turnDeps.registry.answer('t1', event.elicitationId, { action: 'decline' }), 0);
      }
    });
    await runTurn(turnDeps, 't1', [], 'book a plumber');
    const opened = events.find(e => e.type === 'elicitation-opened');
    expect(opened && opened.type === 'elicitation-opened' && opened.prompt).toBe('pick one');
    expect(opened && opened.type === 'elicitation-opened' && opened.callId).toBe('c1');
    expect(opened && opened.type === 'elicitation-opened' && opened.options).toEqual([
      { value: 'p1', label: 'One' },
      { value: 'p2', label: 'Two' }
    ]);
    // The card is closed against the same id it was opened with.
    const closed = events.find(e => e.type === 'elicitation-closed');
    expect(closed && closed.type === 'elicitation-closed' && closed.elicitationId).toBe(
      opened && opened.type === 'elicitation-opened' ? opened.elicitationId : 'missing'
    );
  });

  it('closes a turn the model threw out of', async () => {
    const sizes: number[] = [];
    const { turnDeps } = loopDeps({
      model: {
        async respond() {
          throw new Error('the model connection dropped');
        }
      }
    });
    watchSize(turnDeps, 'turn-started', sizes);
    // Rethrown rather than swallowed: the route above this one has to answer
    // the browser differently for "the model is unreachable" than for "the
    // assistant finished", and a turn that resolves normally cannot say so.
    await expect(runTurn(turnDeps, 't1', [], 'hello')).rejects.toThrow(/the model connection dropped/);
    expect(sizes).toEqual([1]);
    expect(turnDeps.registry.size).toBe(0);
  });

  it('closes a turn the model threw out of on a later round, after a tool call succeeded', async () => {
    const sizes: number[] = [];
    let round = 0;
    const { turnDeps } = loopDeps({
      model: {
        async respond() {
          if (round++ === 0) return { content: [toolUse('c1', 'list_appliances', {})], stop_reason: 'tool_use' } as unknown as Anthropic.Message;
          throw new Error('the model connection dropped mid-turn');
        }
      }
    });
    watchSize(turnDeps, 'tool-succeeded', sizes);
    await expect(runTurn(turnDeps, 't1', [], 'hello')).rejects.toThrow(/mid-turn/);
    expect(sizes).toEqual([1]);
    expect(turnDeps.registry.size).toBe(0);
  });

  it('closes a turn a tool call threw out of, and hands the model the failure whole', async () => {
    const { turnDeps, events } = loopDeps({
      mcp: {
        rebuilds: 0,
        callTool: async () => {
          throw new Error('socket hang up');
        }
      }
    });
    const sizes: number[] = [];
    watchSize(turnDeps, 'tool-started', sizes);
    const messages = await runTurn(turnDeps, 't1', [], 'what appliances do we have');

    const failure = events.find(e => e.type === 'tool-failed');
    expect(failure && failure.type === 'tool-failed' && failure.message).toBe('socket hang up');
    // Which call and which tool, so a transcript with two calls in flight can
    // put the failure against the right one.
    expect(failure && failure.type === 'tool-failed' && failure.tool).toBe('list_appliances');
    expect(failure && failure.type === 'tool-failed' && failure.callId).toBe('c1');
    expect(events.some(e => e.type === 'tool-succeeded')).toBe(false);
    // Whole, not summarised: the transport's own sentence and every claim the
    // notice makes reach the model unedited. `toContain` on the imported
    // constant asks whether this loop passed it THROUGH — the wording itself
    // is `tools.ts`'s property and is asserted there — and the length equality
    // is what a `.slice()` or a reworded paraphrase fails.
    const block = (messages[2]?.content as Anthropic.ToolResultBlockParam[])[0];
    expect(block?.is_error).toBe(true);
    // Equality, not two `toContain`s: those two pass just as well with the
    // notice ahead of the error, which buries the one sentence naming what
    // went wrong under five that do not.
    expect((block?.content as Array<{ text: string }>)[0]?.text).toBe(`socket hang up\n\n${NO_DATA_NOTICE}`);
    expect(sizes).toEqual([1]);
    expect(turnDeps.registry.size).toBe(0);
  });

  it('reports the total the server sent, and falls back to three of three only when it sent none', async () => {
    // `notifications/progress` makes `total` optional, and the transcript
    // renders "2 of N". The fallback is written as a literal 3 here rather
    // than as the imported `PROGRESS_TOTAL` on purpose: a test that reads the
    // same constant the producer writes cannot fail when that constant moves,
    // which is half of why this project has an unfalsifiable-assertion list.
    // The 7 is the other half — it is a value the constant could never supply,
    // so a loop that ignored the server's number and always sent its own would
    // fail here rather than agree with itself.
    const { turnDeps, events } = loopDeps({
      mcp: {
        rebuilds: 0,
        callTool: async (_name, _args, onProgress) => {
          onProgress?.({ progress: 1, total: 7, message: 'seven steps' });
          onProgress?.({ progress: 2 });
          return { content: [{ type: 'text', text: 'Six appliances.' }] };
        }
      }
    });
    await runTurn(turnDeps, 't1', [], 'what appliances do we have');
    expect(events.filter(e => e.type === 'progress').map(e => (e.type === 'progress' ? [e.progress, e.total, e.message] : null))).toEqual([
      [1, 7, 'seven steps'],
      [2, 3, '']
    ]);
  });

  it("hands on the result's whole content array beside the structured payload, rather than a reconstruction of it", async () => {
    // `{content, structuredContent}` is the pair the MCP Apps view protocol
    // specifies, and this event is the only route by which a widget host is
    // ever handed it. The second block is deliberately not a text block: it
    // makes the real array distinguishable from `[{type:'text', text: spoken}]`,
    // so a loop that rebuilt the content out of the spoken line — or dropped it
    // for a `null` — fails here instead of agreeing with itself.
    const content = [
      { type: 'text', text: 'Six appliances.' },
      { type: 'resource_link', uri: 'ui://homeledger/appliances', name: 'appliances' }
    ];
    const { turnDeps, events } = loopDeps({
      mcp: { rebuilds: 0, callTool: async () => ({ content, structuredContent: { appliances: ['appl_1'] } }) }
    });
    await runTurn(turnDeps, 't1', [], 'what appliances do we have');
    const success = events.find(e => e.type === 'tool-succeeded');
    expect(success && success.type === 'tool-succeeded' && success.spoken).toBe('Six appliances.');
    expect(success && success.type === 'tool-succeeded' && success.content).toEqual(content);
    expect(success && success.type === 'tool-succeeded' && success.structured).toEqual({ appliances: ['appl_1'] });
  });

  it('reports a session rebuild that happened on the way to a FAILING call, not only on the way to a good one', async () => {
    // The local server cannot lose a session mid-call, so this is the shape
    // handed to the loop directly rather than provoked — the same answer this
    // file gives for the two elicitation guards no fixture can reach. Without
    // it the only coverage of "rebuilt, then failed anyway" is a deployed run,
    // and the branch that reports it sits OUTSIDE the try for exactly this
    // case: a person watching a call fail should be told once that the
    // connection had to be re-established, not have it end up only in a log.
    let rebuilds = 0;
    const { turnDeps, events } = loopDeps({
      mcp: {
        get rebuilds() {
          return rebuilds;
        },
        callTool: async () => {
          rebuilds += 1;
          throw new Error('the runtime instance was gone and the replayed call failed too');
        }
      }
    });
    await runTurn(turnDeps, 't1', [], 'what appliances do we have');
    expect(events.filter(e => e.type === 'session-rebuilt')).toHaveLength(1);
    expect(events.some(e => e.type === 'tool-failed')).toBe(true);
    expect(events.some(e => e.type === 'tool-succeeded')).toBe(false);
  });

  it('reports a session rebuild on a call that was replayed and then SUCCEEDED, which is the ordinary case', async () => {
    // The common production shape and the one a failure-only fixture cannot
    // express: the instance holding the session was recycled, `HomeLedgerMcp`
    // re-established it and replayed the call, and the call then worked. The
    // person still has to be told once that the connection was rebuilt.
    let rebuilds = 0;
    const { turnDeps, events } = loopDeps({
      mcp: {
        get rebuilds() {
          return rebuilds;
        },
        callTool: async () => {
          rebuilds += 1;
          return { content: [{ type: 'text', text: 'Six appliances.' }] };
        }
      }
    });
    await runTurn(turnDeps, 't1', [], 'what appliances do we have');
    expect(events.filter(e => e.type === 'session-rebuilt')).toHaveLength(1);
    expect(events.some(e => e.type === 'tool-succeeded')).toBe(true);
    expect(events.some(e => e.type === 'tool-failed')).toBe(false);
    // Ordered: the rebuild is announced before the result it belongs to.
    expect(events.map(e => e.type).indexOf('session-rebuilt')).toBeLessThan(events.map(e => e.type).indexOf('tool-succeeded'));
  });

  it('does not report a rebuild on a call that needed none', async () => {
    const { turnDeps, events } = loopDeps();
    await runTurn(turnDeps, 't1', [], 'what appliances do we have');
    expect(events.some(e => e.type === 'session-rebuilt')).toBe(false);
  });

  it('closes a turn whose question nobody ever answered, and tells the server cancel rather than decline', async () => {
    const events: TurnEvent[] = [];
    const { turnDeps } = fakeDeps(CHOICE_SCHEMA, { elicitationTimeoutMs: 20, emit: event => events.push(event) });
    const sizes: number[] = [];
    watchSize(turnDeps, 'elicitation-opened', sizes);
    await runTurn(turnDeps, 't1', [], 'book a plumber');
    expect(events.some(e => e.type === 'elicitation-closed' && e.action === 'abandoned')).toBe(true);
    // The value the server actually received, read back out of the fake's own
    // spoken line. `decline` would type-check, would satisfy every other
    // assertion here, and would tell the server a person said no to a question
    // they were never shown — indistinguishable downstream from a real decline,
    // which is the contract `NOT_BOOKED` pins in `packages/core`. The fixture
    // computed this value before and threw it away.
    const answered = events.find(e => e.type === 'tool-succeeded');
    expect(answered && answered.type === 'tool-succeeded' && answered.spoken).toBe('answered cancel');
    expect(sizes).toEqual([1]);
    expect(turnDeps.registry.size).toBe(0);
  });

  it('closes a turn whose question the person declined, and passes the decline through as a decline', async () => {
    // The other half of the pair, so neither action can be hardcoded: a real
    // decline must survive the loop as `decline`, and the loop must not
    // manufacture one.
    const events: TurnEvent[] = [];
    const { turnDeps } = fakeDeps(CHOICE_SCHEMA, {
      emit: event => {
        events.push(event);
        if (event.type === 'elicitation-opened') setTimeout(() => turnDeps.registry.answer('t1', event.elicitationId, { action: 'decline' }), 0);
      }
    });
    await runTurn(turnDeps, 't1', [], 'book a plumber');
    const answered = events.find(e => e.type === 'tool-succeeded');
    expect(answered && answered.type === 'tool-succeeded' && answered.spoken).toBe('answered decline');
    expect(events.some(e => e.type === 'elicitation-closed' && e.action === 'decline')).toBe(true);
    expect(events.some(e => e.type === 'elicitation-closed' && e.action === 'abandoned')).toBe(false);
    expect(turnDeps.registry.size).toBe(0);
  });

  it('closes a turn that ran out of rounds, and says so rather than truncating in silence', async () => {
    let rounds = 0;
    const { turnDeps, events } = loopDeps({
      maxRounds: 3,
      model: {
        async respond() {
          rounds++;
          return { content: [toolUse(`c${rounds}`, 'list_appliances', {})], stop_reason: 'tool_use' } as unknown as Anthropic.Message;
        }
      }
    });
    const sizes: number[] = [];
    watchSize(turnDeps, 'tool-started', sizes);
    const messages = await runTurn(turnDeps, 't1', [], 'loop please');

    // Defined: it resolves with the messages so far rather than hanging or
    // throwing, and the person is told in words why the assistant stopped.
    expect(rounds).toBe(3);
    expect(sizes).toEqual([1, 1, 1]);
    const failed = events.find(e => e.type === 'turn-failed');
    expect(failed && failed.type === 'turn-failed' && failed.message).toBe('The assistant used its 3 tool rounds without finishing, so the turn was stopped.');
    expect(events.at(-1)?.type).toBe('turn-finished');
    expect(messages.filter(m => m.role === 'assistant')).toHaveLength(3);
    expect(turnDeps.registry.size).toBe(0);
  });

  it('closes a turn whose stream was already gone when it opened', async () => {
    // The browser hung up between the POST and the first frame. The `open()`
    // has already happened by the time anything is emitted, so an emit that
    // throws before the loop is entered is the one exit path a `finally`
    // placed around the rounds alone does not cover.
    const sizes: number[] = [];
    const { turnDeps } = loopDeps();
    turnDeps.emit = () => {
      sizes.push(turnDeps.registry.size);
      throw new Error('the browser stopped reading this stream');
    };
    await expect(runTurn(turnDeps, 't1', [], 'hello')).rejects.toThrow(/stopped reading this stream/);
    expect(sizes[0]).toBe(1);
    expect(turnDeps.registry.size).toBe(0);
  });

  it('closes a turn whose stream went away mid-call', async () => {
    const sizes: number[] = [];
    const { turnDeps } = loopDeps();
    const inner = turnDeps.emit;
    turnDeps.emit = event => {
      if (event.type === 'tool-started') {
        sizes.push(turnDeps.registry.size);
        throw new Error('the browser stopped reading this stream');
      }
      inner(event);
    };
    await expect(runTurn(turnDeps, 't1', [], 'hello')).rejects.toThrow(/stopped reading this stream/);
    expect(sizes).toEqual([1]);
    expect(turnDeps.registry.size).toBe(0);
  });

  it('closes a turn whose stream went away while a question was open, leaving no unhandled rejection behind', async () => {
    // The worst of the eight. The question is already REGISTERED when the
    // emit that would have put it on screen throws, so the turn ends with a
    // slot still pending — and `close()` settles a pending slot by rejecting
    // it. Nothing is waiting on that promise by then, so a rejection nobody
    // adopted is an unhandled rejection, which Node's default policy turns
    // into a dead process: a turn abandoned on a disconnected browser would
    // take the whole simulator down with it.
    const events: TurnEvent[] = [];
    const sizes: number[] = [];
    const { turnDeps } = fakeDeps(CHOICE_SCHEMA, {
      emit: event => {
        if (event.type !== 'elicitation-opened') {
          events.push(event);
          return;
        }
        sizes.push(turnDeps.registry.size);
        throw new Error('the browser stopped reading this stream');
      }
    });
    await runTurn(turnDeps, 't1', [], 'book a plumber');
    // The refusal reaches the model as a failed call, exactly as the two
    // unrenderable-question guards do.
    expect(events.some(e => e.type === 'tool-failed')).toBe(true);
    expect(sizes).toEqual([1]);
    expect(turnDeps.registry.size).toBe(0);
    // A rejection settled after this point still has to be adopted, so give
    // the microtask queue a turn before the test ends.
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('closes a turn whose own registration threw on the way in', async () => {
    // `open()` is not throw-free. It sets the map entry and THEN calls the
    // injected tripwire logger — the logger Task 9 wires to a real one — so a
    // logger that throws leaves an entry created by a call that never returned.
    // Registering outside the `try` leaks it permanently, which is the same
    // defect as the `turn-started` emit one line below it and was still here
    // after that one was fixed.
    const registry = new ElicitationRegistry({
      turnCountWarningThreshold: 1,
      log: () => {
        throw new Error('the structured logger rejected the tripwire line');
      }
    });
    const { turnDeps, events } = loopDeps({ registry });
    await expect(runTurn(turnDeps, 't1', [], 'hello')).rejects.toThrow(/tripwire line/);
    // The entry existed — `open()` sets it before it logs — and is gone again.
    expect(registry.has('t1')).toBe(false);
    expect(registry.size).toBe(0);
    // Nothing was announced: the turn never got as far as its first frame.
    expect(events).toHaveLength(0);
  });

  it('refuses a second turn on an id that is already running, and leaves the first turn untouched', async () => {
    // `open()` is idempotent, so before it returned a boolean the loop could
    // not tell "I registered this" from "somebody already had it". Joining is
    // the dangerous reading: the second turn's `finally` would close the FIRST
    // turn's entry and reject its open question, which downstream looks exactly
    // like a person who cancelled a booking they were still deciding on.
    const registry = new ElicitationRegistry();
    const opened = Promise.withResolvers<void>();
    const first = fakeDeps(CHOICE_SCHEMA, {
      registry,
      elicitationTimeoutMs: 2000,
      emit: event => {
        if (event.type === 'elicitation-opened') {
          opened.resolve();
          setTimeout(() => registry.answer('t1', event.elicitationId, { action: 'accept', content: { provider: 'p1' } }), 20);
        }
      }
    });
    const running = runTurn(first.turnDeps, 't1', [], 'book a plumber');
    await opened.promise;

    const second = loopDeps({ registry });
    await expect(runTurn(second.turnDeps, 't1', [], 'hello')).rejects.toThrow(/already running/);
    // Refused before it announced anything, and the first turn is intact.
    expect(second.events).toHaveLength(0);
    expect(registry.has('t1')).toBe(true);
    expect(registry.size).toBe(1);

    // The first turn still answers its own question and closes its own entry.
    await running;
    expect(first.turnDeps.registry.size).toBe(0);
  });

  it('never lets a dead stream stand in for the reason a turn actually failed', async () => {
    // Both failures are real and they are different problems: the model is
    // rate-limited AND the browser is gone. A throw from the `finally`
    // REPLACES whatever was in flight, so the naive version reports only the
    // stream — and no caller can recover the original from the outside,
    // because by the time they see it the original has been destroyed.
    const rateLimited = new Error('the model rejected the request: rate limited');
    const { turnDeps } = loopDeps({
      model: {
        async respond() {
          throw rateLimited;
        }
      }
    });
    const inner = turnDeps.emit;
    turnDeps.emit = event => {
      if (event.type === 'turn-finished') throw new Error('the browser stopped reading this stream');
      inner(event);
    };
    const thrown = await runTurn(turnDeps, 't1', [], 'hello').then(
      () => undefined,
      (error: unknown) => error
    );
    // Both named, and the original object itself — type, stack and all —
    // reachable as the cause rather than flattened into a string.
    expect(String(thrown)).toContain('rate limited');
    expect(String(thrown)).toContain('stopped reading this stream');
    expect((thrown as Error).cause).toBe(rateLimited);
    expect(turnDeps.registry.size).toBe(0);
  });

  it('reports a dead stream on its own when there was no other failure to protect', async () => {
    // The other side of the same branch: with nothing in flight there is
    // nothing to preserve, so the stream's own error propagates untouched
    // rather than being wrapped in a second error that names a failure that
    // never happened.
    const { turnDeps } = loopDeps();
    const inner = turnDeps.emit;
    turnDeps.emit = event => {
      if (event.type === 'turn-finished') throw new Error('the browser stopped reading this stream');
      inner(event);
    };
    await expect(runTurn(turnDeps, 't1', [], 'hello')).rejects.toThrow(/^the browser stopped reading this stream$/);
    expect(turnDeps.registry.size).toBe(0);
  });

  it('leaves no handler behind that a later question could reach', async () => {
    // The router outlives the turn — it is built once per conversation — so a
    // handler still pointing at a finished turn would answer a late question
    // by asking a registry that no longer holds it, instead of saying the
    // thing that is true: no turn is running.
    const { turnDeps, router } = loopDeps();
    await runTurn(turnDeps, 't1', [], 'hello');
    expect(router.handler).toBeUndefined();
    await expect(router.dispatch({ message: 'pick', requestedSchema: CHOICE_SCHEMA })).rejects.toThrow(/no turn is running/);
  });
});
