import Anthropic from '@anthropic-ai/sdk';

/** Enough for a spoken answer plus a few tool calls; this surface never writes an essay. */
export const DEFAULT_MAX_TOKENS = 8192;

export interface ModelRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

export interface ModelPort {
  /** Streams text deltas to `onText` as they arrive and resolves with the completed message. */
  respond(request: ModelRequest, onText: (delta: string) => void): Promise<Anthropic.Message>;
}

/**
 * The slice of the SDK this port uses.
 *
 * Narrow on purpose: the agent tests drive a scripted model through several
 * tool rounds, and a fake that has to satisfy the whole `Anthropic` type would
 * be a fake nobody writes.
 */
export interface MessagesLike {
  stream(params: Anthropic.MessageStreamParams): {
    on(event: 'text', listener: (delta: string) => void): unknown;
    finalMessage(): Promise<Anthropic.Message>;
  };
}

export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

export function createModelPort(options: { messages: MessagesLike; model: string; maxTokens?: number }): ModelPort {
  return {
    async respond(request, onText) {
      const stream = options.messages.stream({
        model: options.model,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        thinking: { type: 'adaptive' },
        // Low, deliberately. This is a voice-first surface with a three-second
        // budget, the tools do the work, and the answers are one or two
        // sentences — the depth that higher effort buys has nothing to be
        // spent on here, and it is paid for in the pause before the display
        // says anything.
        output_config: { effort: 'low' }
      });
      stream.on('text', onText);
      return stream.finalMessage();
    }
  };
}
