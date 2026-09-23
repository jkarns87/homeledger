import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_TOKENS, createModelPort, type MessagesLike } from '../src/server/model.js';

const finished = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text: 'Six appliances.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 4 }
} as unknown as Anthropic.Message;

function fakeMessages(deltas: string[]) {
  const seen: unknown[] = [];
  const messages: MessagesLike = {
    stream(params) {
      seen.push(params);
      let listener: ((delta: string) => void) | undefined;
      return {
        on(_event, handler) {
          listener = handler;
          return this;
        },
        async finalMessage() {
          for (const delta of deltas) listener?.(delta);
          return finished;
        }
      };
    }
  };
  return { messages, seen };
}

describe('createModelPort', () => {
  it('sends the model, the budget, the system prompt, the messages and the tools', async () => {
    const { messages, seen } = fakeMessages([]);
    const port = createModelPort({ messages, model: 'claude-opus-5' });
    const tools: Anthropic.Tool[] = [{ name: 'list_appliances', description: 'x', input_schema: { type: 'object' } }];
    await port.respond({ system: 'be brief', messages: [{ role: 'user', content: 'hi' }], tools }, () => {});
    expect(seen).toHaveLength(1);
    const params = seen[0] as Record<string, unknown>;
    expect(params.model).toBe('claude-opus-5');
    expect(params.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(params.system).toBe('be brief');
    expect(params.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(params.tools).toEqual(tools);
  });

  it('asks for a low effort, because this surface is answering out loud', async () => {
    const { messages, seen } = fakeMessages([]);
    await createModelPort({ messages, model: 'claude-opus-5' }).respond({ system: 's', messages: [], tools: [] }, () => {});
    expect((seen[0] as { output_config?: unknown }).output_config).toEqual({ effort: 'low' });
  });

  it('forwards every text delta in order and returns the finished message', async () => {
    const { messages } = fakeMessages(['Six ', 'appliances.']);
    const onText = vi.fn();
    const result = await createModelPort({ messages, model: 'claude-opus-5' }).respond({ system: 's', messages: [], tools: [] }, onText);
    expect(onText.mock.calls.map(call => call[0])).toEqual(['Six ', 'appliances.']);
    expect(result).toBe(finished);
  });

  it('honours an explicit token budget', async () => {
    const { messages, seen } = fakeMessages([]);
    await createModelPort({ messages, model: 'claude-opus-5', maxTokens: 1024 }).respond({ system: 's', messages: [], tools: [] }, () => {});
    expect((seen[0] as { max_tokens: number }).max_tokens).toBe(1024);
  });
});
