/**
 * The published functional requirement for a voice-first smart display: a
 * spoken list never offers more than five things. Named without the product
 * whose requirement this is — see `FORBIDDEN_WORDMARKS` below for why nothing
 * in this file's prose may spell it out, even though its own guard exempts
 * this module from the source walk.
 */
export const VOICE_MAX_ITEMS = 5;

/**
 * Product names this simulator must not wear, checked against its own source.
 *
 * The spec's visual foundations say no logos or wordmarks, and the organiser
 * confirmed entrants cannot call the real assistant at all — so a surface that
 * uses the name is claiming a connection it does not have, whether it means to
 * or not. The disclosure in the frame therefore says what this IS (a simulation
 * driving HomeLedger's own MCP server) rather than naming what it is not, which
 * is both honest and free of the marks. The README, which is documentation
 * about the project rather than the product's own chrome, states the
 * relationship in full.
 */
export const FORBIDDEN_WORDMARKS: readonly string[] = ['Alexa', 'Echo Show', 'Amazon'];

/**
 * The persona and the rules, rebuilt per turn so the date and the live tool
 * list are always the real ones.
 *
 * Two of these rules are not style. "Never read JSON aloud" is a published
 * functional requirement and the server already enforces it on its own spoken
 * text; repeating it here stops the model from reading the structured payload
 * back out. And the failure rule exists because a transport error was twice
 * turned into a confident answer assembled from this repository's own seed
 * fixtures (FL-039) — the tool result already carries that instruction, and
 * this is the standing version of it.
 */
export function buildSystemPrompt(input: { today: string; toolNames: readonly string[] }): string {
  const offers = (name: string): boolean => input.toolNames.includes(name);
  return [
    'You are the household assistant for a smart display in one home. You speak out loud, so answer in short spoken sentences.',
    `Today is ${input.today}.`,
    '',
    'How to talk:',
    `- Name at most ${VOICE_MAX_ITEMS} things in one answer. If there are more, say how many there are and name the ones that matter.`,
    '- Never read JSON, ids, or field names aloud. Say "the washer", not "appl_washer2222222222".',
    '- One or two sentences is usually the whole answer. The screen shows the detail.',
    '',
    'The tools are the only source of truth about this household:',
    ...input.toolNames.map(name => `- ${name}`),
    '',
    'Rules you do not bend:',
    '- Call a tool before answering any question about this household. You have no prior knowledge of it.',
    '- If a tool call fails, say so. Say the call failed and what the error was. Do not answer from memory, from fixtures, from seed data, or from an earlier turn: a failed call tells you nothing, not even that the answer is empty.',
    '- The service-provider marketplace is sample data invented for this demo. If someone asks whether a booking is real, say that the providers are sample data and nothing leaves this system.',
    // Guidance for a tool, emitted only when that tool is on offer. Two rules
    // above are about the model's own conduct and always apply; these two name
    // a tool, and naming a tool the server did not list is an instruction to
    // call something that is not there. `echo_confirm` is gated behind
    // HOMELEDGER_DEV_TOOLS, so "the nine tools" is nine only against a runtime
    // that sets it - which makes "what the server offered this connection" the
    // only list either of these may be keyed on.
    ...(offers('ask_manual')
      ? [
          // "No passages" is a SUCCESSFUL call, not a failed one: `ask_manual`
          // returns `{ passages: [] }` with no `isError`, and its own spoken
          // text is "I couldn't find anything about that in the manuals."
          // (`apps/mcp-server/src/tools/manual.ts`). Telling the model to say
          // the manual "could not be searched" would put a false cause on a
          // true, ordinary outcome — the same mistake `NO_DATA_NOTICE` exists
          // to prevent, arriving from the opposite direction: that notice
          // stops an invented cause for a failure, and the wrong wording here
          // would have invented a failure for a success.
          '- ask_manual returns source passages; you write the answer from them and cite the document title and page. If it returns no passages, say you could not find anything about that in the manuals - that is a normal result, not a failure, so do not say the search failed and do not invent an answer from outside them.'
        ]
      : []),
    ...(offers('book_service')
      ? ['- book_service will ask the person questions through the screen. Call it once and wait; do not ask the questions yourself in text.']
      : [])
  ].join('\n');
}
