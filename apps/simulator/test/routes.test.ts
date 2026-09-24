import type { Server } from 'node:http';
import type Anthropic from '@anthropic-ai/sdk';
import { SEED_TIMEZONE } from '@homeledger/core';
import { createApp } from '@homeledger/mcp-server/app';
import { seededDeps } from '@homeledger/mcp-server/test-harness';
import { afterEach, describe, expect, it } from 'vitest';
import { createElicitRouter } from '../src/server/agent.js';
import { ElicitationRegistry } from '../src/server/elicitation.js';
import { createSseDecoder, type TurnEvent } from '../src/shared/events.js';
import { handleAnswer, handleTurn, UNKNOWN_TURN_MESSAGE } from '../src/server/http.js';
import { HomeLedgerMcp } from '../src/server/mcp.js';
import type { ModelPort } from '../src/server/model.js';
import { householdTimeZone, type Conversation } from '../src/server/session.js';

let server: Server | undefined;
let closeApp: () => Promise<void> = async () => {};
let closeClient: () => Promise<void> = async () => {};

afterEach(async () => {
  await closeClient();
  await closeApp();
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

function toolUse(id: string, name: string, input: Record<string, unknown>): Anthropic.ContentBlock {
  return { type: 'tool_use', id, name, input } as unknown as Anthropic.ContentBlock;
}

function scriptedModel(script: Array<(messages: Anthropic.MessageParam[]) => Anthropic.ContentBlock[]>): ModelPort {
  let round = 0;
  return {
    async respond(request, onText) {
      const content = script[round++]?.(request.messages) ?? [{ type: 'text', text: 'Done.' } as Anthropic.ContentBlock];
      for (const block of content) if (block.type === 'text') onText(block.text);
      return {
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'fake',
        content,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {}
      } as unknown as Anthropic.Message;
    }
  };
}

async function conversation(model: ModelPort): Promise<Conversation> {
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
  return {
    mcp,
    registry: new ElicitationRegistry(),
    router,
    model,
    tools: await mcp.listTools(),
    env: { anthropicApiKey: 'unused', model: 'fake', maxRounds: 6, elicitationTimeoutMs: 3000, allowOrigin: undefined },
    endpoint: { arn: undefined, origin: 'url' },
    timeZone: await householdTimeZone(mcp),
    now: () => Date.now(),
    history: []
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/agent/turn', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers }
  });
}

/** Reads the stream and calls `onEvent` for each event AS IT ARRIVES, never after. */
async function drain(response: Response, onEvent: (event: TurnEvent) => void): Promise<TurnEvent[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const decode = createSseDecoder();
  const all: TurnEvent[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const event of decode(decoder.decode(value, { stream: true }))) {
      all.push(event);
      onEvent(event);
    }
  }
  return all;
}

describe('POST /api/agent/turn', () => {
  it('streams the turn and tells every proxy not to buffer it', async () => {
    const convo = await conversation(scriptedModel([() => [{ type: 'text', text: 'Hello.' } as Anthropic.ContentBlock]]));
    const response = await handleTurn(convo, post({ text: 'hello' }));
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const events = await drain(response, () => {});
    expect(events.map(e => e.type)).toEqual(['turn-started', 'assistant-text', 'turn-finished']);
  });

  it(
    'completes a three-question booking with each answer POSTed while the turn stream is still open',
    async () => {
      // THE deadlock guard. If handleTurn buffered the response, `drain` would
      // yield nothing until the turn ended, the turn would wait for answers
      // that can only be sent from inside `drain`, and this test would time
      // out rather than fail — which is exactly how FL-033's naive proxy
      // failed. The timeout below is the assertion that it does not.
      const convo = await conversation(
        scriptedModel([
          () => [toolUse('c1', 'list_appliances', { category: 'water_heater' })],
          messages => [
            toolUse('c2', 'book_service', { applianceId: /appl_[a-z0-9]{16}/.exec(JSON.stringify(messages))?.[0] ?? 'appl_missing', issue: 'leak' })
          ],
          () => [{ type: 'text', text: 'Booked.' } as Anthropic.ContentBlock]
        ])
      );
      const response = await handleTurn(convo, post({ text: 'book a plumber for the water heater' }));
      let turnId = '';
      const answers: Array<Promise<Response>> = [];
      const events = await drain(response, event => {
        if (event.type === 'turn-started') turnId = event.turnId;
        if (event.type !== 'elicitation-opened') return;
        const content = event.field === 'provider' ? { provider: 'prov_kettle_water' } : event.field === 'window' ? { window: 'win_1' } : { confirm: true };
        answers.push(handleAnswer(convo, post({ turnId, elicitationId: event.elicitationId, action: 'accept', content })));
      });

      expect(events.filter(e => e.type === 'elicitation-opened').map(e => (e.type === 'elicitation-opened' ? e.field : ''))).toEqual([
        'provider',
        'window',
        'confirm'
      ]);
      for (const answer of answers) expect((await answer).status).toBe(202);
      const booked = events.find(e => e.type === 'tool-succeeded' && e.tool === 'book_service');
      expect(booked && booked.type === 'tool-succeeded' && (booked.structured as { status: string }).status).toBe('scheduled');
      expect(events.filter(e => e.type === 'progress').map(e => (e.type === 'progress' ? e.progress : -1))).toEqual([0, 1, 2, 3]);
    },
    { timeout: 15000 }
  );

  it('keeps the history so a second turn sees the first', async () => {
    const convo = await conversation(scriptedModel([() => [{ type: 'text', text: 'One.' } as Anthropic.ContentBlock]]));
    await drain(await handleTurn(convo, post({ text: 'first question' })), () => {});
    expect(convo.history.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(convo.history)).toContain('first question');
  });

  it('refuses a body with no text, without opening a stream', async () => {
    const convo = await conversation(scriptedModel([]));
    for (const body of [{}, { text: '' }, { text: '   ' }, { text: 42 }]) {
      const response = await handleTurn(convo, post(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
    }
  });

  it("tells the model the household's day, which at this instant is not the UTC one", async () => {
    // 02:00Z on the 14th is still the 13th in Chicago, and the assistant SAYS
    // this date out loud. `new Date().toISOString().slice(0, 10)` - the
    // construct spec section 4.2 names as wrong, and the one that flipped
    // maintenance items to overdue at 7 PM Central three days before this plan
    // was written - yields 2026-09-14 here. The expected value is written by
    // hand rather than computed with todayInZone, so the test cannot agree
    // with the code by construction (FL-028).
    const systems: string[] = [];
    const convo = await conversation({
      async respond(request) {
        systems.push(request.system);
        return {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'fake',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {}
        } as unknown as Anthropic.Message;
      }
    });
    convo.timeZone = 'America/Chicago';
    convo.now = () => Date.parse('2026-09-14T02:00:00.000Z');
    await drain(await handleTurn(convo, post({ text: 'what is due' })), () => {});
    expect(systems[0]).toContain('Today is 2026-09-13.');
    expect(systems[0]).not.toContain('2026-09-14');
  });

  it('reports a thrown model as a failure on the stream, closes it, and leaves the history and registry clean', async () => {
    // The honest-failure global constraint, pointed at the route itself rather
    // than at a tool call: `runTurn` rejects when the model throws, and
    // `handleTurn`'s `.catch` is the only thing standing between that
    // rejection and a stream that just quietly ends. `runTurn`'s own `finally`
    // emits `turn-finished` before it rethrows (see the module doc on event
    // order), so the honest ['turn-started', 'turn-finished', 'turn-failed']
    // order is itself part of what this pins, not incidental.
    const convo = await conversation({
      async respond() {
        throw new Error('boom-from-fake-model');
      }
    });
    const response = await handleTurn(convo, post({ text: 'hello' }));
    const events = await drain(response, () => {});
    expect(events.map(e => e.type)).toEqual(['turn-started', 'turn-finished', 'turn-failed']);
    const failed = events.find(e => e.type === 'turn-failed');
    expect(failed && failed.type === 'turn-failed' && failed.message).toBe('boom-from-fake-model');
    expect(convo.history).toEqual([]);
    expect(convo.registry.size).toBe(0);
  });

  it(
    'closes the registry entry when the browser cancels the stream, well under the elicitation timeout',
    async () => {
      // The controller ruling: `cancel() -> registry.close(turnId)` is the
      // ONLY external close in production, and it exists so a disconnected
      // browser does not leave an open question waiting out the full
      // elicitation timeout. Waiting the full timeout would let this pass
      // even with `cancel()` gutted, because the question's own timeout
      // would eventually remove the entry anyway - so this polls for well
      // under it (200 ms against a 3000 ms elicitationTimeoutMs) and fails
      // rather than waits if the entry is still there.
      const convo = await conversation(
        scriptedModel([
          () => [toolUse('c1', 'list_appliances', { category: 'water_heater' })],
          messages => [
            toolUse('c2', 'book_service', { applianceId: /appl_[a-z0-9]{16}/.exec(JSON.stringify(messages))?.[0] ?? 'appl_missing', issue: 'leak' })
          ],
          () => [{ type: 'text', text: 'Booked.' } as Anthropic.ContentBlock]
        ])
      );
      const response = await handleTurn(convo, post({ text: 'book a plumber for the water heater' }));
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const decode = createSseDecoder();
      let turnId = '';
      readLoop: for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of decode(decoder.decode(value, { stream: true }))) {
          if (event.type === 'turn-started') turnId = event.turnId;
          if (event.type === 'elicitation-opened') break readLoop;
        }
      }
      expect(turnId).not.toBe('');
      expect(convo.registry.has(turnId)).toBe(true);

      await reader.cancel();

      const deadline = Date.now() + 200;
      while (convo.registry.has(turnId) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(convo.registry.has(turnId)).toBe(false);
    },
    { timeout: 15000 }
  );
});

describe('POST /api/agent/answer', () => {
  it('reports an answer for a turn this process is not running, and says what that means', async () => {
    const convo = await conversation(scriptedModel([]));
    const response = await handleAnswer(convo, post({ turnId: 'not-a-turn', elicitationId: 'x', action: 'accept', content: {} }));
    expect(response.status).toBe(409);
    const body = (await response.json()) as { reason: string; message: string };
    expect(body.reason).toBe('unknown-turn');
    expect(body.message).toBe(UNKNOWN_TURN_MESSAGE);
    expect(UNKNOWN_TURN_MESSAGE).toContain('was not delivered');
  });

  it('rejects an action it does not know rather than guessing one', async () => {
    const convo = await conversation(scriptedModel([]));
    const response = await handleAnswer(convo, post({ turnId: 't', elicitationId: 'e', action: 'maybe', content: {} }));
    expect(response.status).toBe(400);
  });

  it('requires an object for content when the action is accept', async () => {
    const convo = await conversation(scriptedModel([]));
    const response = await handleAnswer(convo, post({ turnId: 't', elicitationId: 'e', action: 'accept', content: 'prov_kettle_water' }));
    expect(response.status).toBe(400);
  });
});

describe('checkOrigin', () => {
  it('lets everything through when no origin is configured', async () => {
    const convo = await conversation(scriptedModel([() => [{ type: 'text', text: 'ok' } as Anthropic.ContentBlock]]));
    const response = await handleTurn(convo, post({ text: 'hi' }, { origin: 'https://elsewhere.invalid' }));
    expect(response.status).toBe(200);
    await drain(response, () => {});
  });

  it('refuses a foreign origin when one is configured', async () => {
    const convo = await conversation(scriptedModel([]));
    convo.env = { ...convo.env, allowOrigin: 'http://127.0.0.1:3000' };
    const response = await handleTurn(convo, post({ text: 'hi' }, { origin: 'https://elsewhere.invalid' }));
    expect(response.status).toBe(403);
  });

  it('accepts the configured origin', async () => {
    const convo = await conversation(scriptedModel([() => [{ type: 'text', text: 'ok' } as Anthropic.ContentBlock]]));
    convo.env = { ...convo.env, allowOrigin: 'http://127.0.0.1:3000' };
    await drain(await handleTurn(convo, post({ text: 'hi' }, { origin: 'http://127.0.0.1:3000' })), () => {});
    expect(convo.history).toHaveLength(2);
  });

  it('accepts a request that sends no Origin header at all', async () => {
    // Its own test, because this is a different branch and the version that
    // promised both cases in one title ran only the first: every test in this
    // file that set an allow-origin also sent an explicit Origin, so
    // `origin === null` was never once evaluated and the mutation that refuses
    // it survived the whole suite. curl, the runbook's own diagnostics, and
    // these tests send none; a browser always sends one, which is exactly why
    // a missing Origin is not the cross-site case this check exists for.
    const convo = await conversation(scriptedModel([() => [{ type: 'text', text: 'ok' } as Anthropic.ContentBlock]]));
    convo.env = { ...convo.env, allowOrigin: 'http://127.0.0.1:3000' };
    const response = await handleTurn(convo, post({ text: 'hi' }));
    expect(response.status).toBe(200);
    await drain(response, () => {});
    expect(convo.history).toHaveLength(2);
  });
});

describe('householdTimeZone', () => {
  it('reads the zone the household record names', async () => {
    const convo = await conversation(scriptedModel([]));
    // The seeded household is in America/Chicago, and it is read off
    // `homeledger://household` rather than assumed: the server renders every
    // human-facing time in this zone and the simulator speaks the date, so the
    // two have to be reading the same record.
    expect(await householdTimeZone(convo.mcp)).toBe('America/Chicago');
    expect(await householdTimeZone(convo.mcp)).toBe(SEED_TIMEZONE);
  });

  it('falls back to the seeded zone, and says so, when the record cannot be read', async () => {
    const said: string[] = [];
    const zone = await householdTimeZone(
      {
        readResource: async () => {
          throw new Error('resource homeledger://household carries no text content');
        }
      },
      message => said.push(message)
    );
    expect(zone).toBe(SEED_TIMEZONE);
    expect(said.join(' ')).toContain(SEED_TIMEZONE);
    // Not UTC. A fallback to UTC would put the simulator back on exactly the
    // day boundary this whole mechanism exists to move off.
    expect(zone).not.toBe('UTC');
  });

  it('falls back when the record names no zone, rather than speaking an empty one', async () => {
    const zone = await householdTimeZone({ readResource: async () => JSON.stringify({ id: 'hh_test', name: 'The Harlow household' }) });
    expect(zone).toBe(SEED_TIMEZONE);
  });
});

describe('GET /api/debug', () => {
  it('describes the connection without carrying a credential', async () => {
    const convo = await conversation(scriptedModel([]));
    const body = (await (await import('../src/server/http.js')).handleDebug(convo).json()) as Record<string, unknown>;
    expect(body.addressing).toBe('url');
    expect(typeof body.sessionId).toBe('string');
    expect(body.rebuilds).toBe(0);
    expect(Array.isArray(body.tools)).toBe(true);
    const serialised = JSON.stringify(body).toLowerCase();
    for (const forbidden of ['bearer', 'authorization', 'secret', 'anthropic', 'password', 'token']) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });

  it('carries the two spec section 7 fields the drawer cannot get anywhere else', async () => {
    const convo = await conversation(scriptedModel([]));
    await convo.mcp.callTool('list_appliances', {});
    const body = (await (await import('../src/server/http.js')).handleDebug(convo).json()) as { protocolVersion: unknown; log: Array<{ method: string }> };
    expect(body.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.log.map(entry => entry.method)).toContain('tools/call');
    // `token` is on the forbidden list above and `progressToken` is on every
    // progress notification this server sends, so the log has to be methods
    // and timings rather than payloads. This asserts that the credential test
    // above is passing because the log holds no bodies, not because this
    // particular call happened to send nothing interesting.
    expect(JSON.stringify(body.log)).not.toContain('appliances');
  });
});
