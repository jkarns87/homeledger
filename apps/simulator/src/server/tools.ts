import type Anthropic from '@anthropic-ai/sdk';

export interface McpToolDescriptor {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
  _meta?: unknown;
}

export function toAnthropicTools(tools: readonly McpToolDescriptor[]): Anthropic.Tool[] {
  return tools.map(tool => ({
    name: tool.name,
    // Empty rather than omitted: the field is what the model reads to decide
    // when a tool applies, and an absent one reads as "no guidance" in a way a
    // present-but-empty one does not.
    description: tool.description ?? '',
    input_schema: tool.inputSchema as Anthropic.Tool['input_schema']
  }));
}

/**
 * The `ui://` widget a tool names, read from the TOOL DEFINITION.
 *
 * Not from the call result: `apps/mcp-server/src/widgets/index.ts`'s `uiMeta()`
 * is passed in `registerTool`'s config, so the pairing arrives once on
 * `tools/list` and every later result of that tool inherits it. Reading the
 * result instead would find nothing and quietly render no widget at all.
 *
 * The nested `ui.resourceUri` is the shape the MCP Apps spec prefers; the
 * server also sets the flat deprecated key beside it, which this deliberately
 * ignores so that the two cannot silently disagree.
 */
export function widgetUriOf(tool: McpToolDescriptor): string | null {
  const meta = tool._meta;
  if (typeof meta !== 'object' || meta === null) return null;
  const ui = (meta as { ui?: unknown }).ui;
  if (typeof ui !== 'object' || ui === null) return null;
  const uri = (ui as { resourceUri?: unknown }).resourceUri;
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : null;
}

/**
 * What a failed tool call tells the model, in words.
 *
 * This exists because a transport error is now an input to an inference
 * engine, and a vague one does not stay vague — it gets turned into a fluent
 * answer nobody has reason to doubt. Twice, a 404 was read as "there are no
 * appliances registered" and answered from this repository's own seed
 * fixtures (FL-039). So the notice says what did NOT happen, not only what
 * went wrong, and it names the specific wrong move.
 *
 * Deliberately the same four claims, in the same order, as
 * `apps/mcp-bridge/src/errors.ts`'s notice of the same name: nothing was
 * retrieved, no result is implied, memory and repository fixtures are not a
 * substitute, and the failure is to be reported rather than worked around. The
 * last sentence differs only in who is being addressed — the bridge speaks to a
 * client, this speaks to the agent driving the simulator.
 */
export const NO_DATA_NOTICE = [
  'NO DATA WAS RETRIEVED.',
  'This call did not execute, so nothing was read from the household and no result — empty or otherwise — is implied.',
  'Do not answer from memory, from repository fixtures or seed data, or from anything earlier in this conversation: you do not know what this household contains.',
  'Tell the person the call failed and say what the error above was.'
].join(' ');

/**
 * What one `tools/call` produced, in the only two flavours anything downstream
 * branches on.
 *
 * Two, not three: a person declining a booking is `ok: true` with a spoken
 * sentence that says nothing was booked, because the call ran and answered.
 * `ok: false` means the call did not execute, and that is the only thing it
 * means — every honest-failure surface in this plan is that boolean rendered.
 */
export type ToolOutcome = { ok: true; spoken: string; content: unknown; structured: unknown } | { ok: false; message: string };

function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === 'string' && text.length > 0) return text;
  }
  return undefined;
}

/**
 * Classifies a `tools/call` result without dereferencing anything that may be absent.
 *
 * Total by construction, for the reason `scripts/smoke.ts` learned the hard
 * way: a thrown handler comes back as `{ isError: true, content: [text] }`
 * with no `structuredContent` at all, and a blind `.structuredContent.passages`
 * throws a TypeError that says nothing about the system under test and stops
 * everything after it (FL-032). The `isError` check comes FIRST and on its
 * own, so an error result that happens to carry well-formed structured content
 * — a shape the server is free to adopt — is still a failure.
 */
export function readToolResult(result: unknown): ToolOutcome {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return { ok: false, message: 'the server returned no result object' };
  const record = result as { isError?: unknown; content?: unknown; structuredContent?: unknown };
  const spoken = firstText(record.content);
  if (record.isError === true) return { ok: false, message: spoken ?? 'the server reported an error and gave no message' };
  if (spoken === undefined) return { ok: false, message: 'the server returned a result with no spoken text' };
  return { ok: true, spoken, content: record.content ?? null, structured: record.structuredContent ?? null };
}

export function toToolResultBlock(callId: string, outcome: ToolOutcome): Anthropic.ToolResultBlockParam {
  if (!outcome.ok)
    return {
      type: 'tool_result',
      tool_use_id: callId,
      is_error: true,
      content: [{ type: 'text', text: `${outcome.message}\n\n${NO_DATA_NOTICE}` }]
    };
  // Spoken text first, typed payload second. The spoken line is what the tool
  // said; the JSON is what it returned, and the model needs both — the ids in
  // structuredContent are how it reaches the next tool.
  const text = outcome.structured === null ? outcome.spoken : `${outcome.spoken}\n\n${JSON.stringify(outcome.structured)}`;
  return { type: 'tool_result', tool_use_id: callId, content: [{ type: 'text', text }] };
}

/**
 * Turns an `elicitation/create` requestedSchema into something a card can render.
 *
 * The server builds exactly two shapes (`apps/mcp-server/src/elicit.ts`): a
 * single-select `enum` + `enumNames`, and a boolean. Anything else returns
 * undefined rather than a guessed widget — a free-text box in place of a
 * choice would let a person answer something the server will reject, and a
 * silent default would hide a server change instead of surfacing it.
 */
export function elicitationShape(
  requestedSchema: unknown
): { field: string; kind: 'choice' | 'confirm'; options: Array<{ value: string; label: string }> } | undefined {
  if (typeof requestedSchema !== 'object' || requestedSchema === null) return undefined;
  const properties = (requestedSchema as { properties?: unknown }).properties;
  if (typeof properties !== 'object' || properties === null) return undefined;
  const field = Object.keys(properties as Record<string, unknown>)[0];
  if (field === undefined) return undefined;
  const definition = (properties as Record<string, unknown>)[field];
  if (typeof definition !== 'object' || definition === null) return undefined;
  const type = (definition as { type?: unknown }).type;
  if (type === 'boolean') return { field, kind: 'confirm', options: [] };
  const values = (definition as { enum?: unknown }).enum;
  if (type !== 'string' || !Array.isArray(values) || values.length === 0) return undefined;
  const names = (definition as { enumNames?: unknown }).enumNames;
  const labels = Array.isArray(names) ? names : [];
  const options: Array<{ value: string; label: string }> = [];
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'string') return undefined;
    const label = labels[index];
    options.push({ value, label: typeof label === 'string' && label.length > 0 ? label : value });
  }
  return { field, kind: 'choice', options };
}
