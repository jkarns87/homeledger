export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
/** The description gives up after this, well inside the correlator's own timeout. */
export const DESCRIBE_TIMEOUT_MS = 20_000;

/**
 * Spec §5 and §7's content rule. The sentence describes the scene; who the
 * visitor is comes from HomeLedger's booking match, and the card says so.
 */
export const DESCRIBE_INSTRUCTION =
  'Describe what is visible in this doorbell photo in one plain sentence of at most twenty-five words: clothing, objects, vehicles, and the scene. Never identify, name, or guess who anyone is, and do not guess anyone’s age, gender, ethnicity, or job. If the picture is too dark or blurred to describe, say that in one sentence.';

export type Describer = (image: Buffer, mediaType: 'image/jpeg' | 'image/png') => Promise<string>;

export function oneSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  return (end === -1 ? flat : flat.slice(0, end + 1)).slice(0, 240);
}

export function createAnthropicDescriber(opts: { apiKey: () => Promise<string>; model: string; fetch?: typeof fetch }): Describer {
  const f = opts.fetch ?? fetch;
  return async (image, mediaType) => {
    const res = await f(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-api-key': await opts.apiKey(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 120,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: image.toString('base64') } },
              { type: 'text', text: DESCRIBE_INSTRUCTION }
            ]
          }
        ]
      }),
      signal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS)
    });
    if (!res.ok) {
      let kind = '';
      try {
        const body = (await res.json()) as { error?: { type?: unknown } };
        if (typeof body.error?.type === 'string') kind = ` ${body.error.type}`;
      } catch {
        /* no body */
      }
      throw new Error(`The photo description failed with ${res.status}${kind}`);
    }
    const body = (await res.json()) as { content?: Array<{ type?: unknown; text?: unknown }> };
    const text = (body.content ?? [])
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
      .join(' ');
    const sentence = oneSentence(text);
    if (!sentence) throw new Error('The photo description came back empty');
    return sentence;
  };
}
