export interface Explanation {
  title: string;
  detail: string;
}

/**
 * Every explanation ends with this, and none of them is allowed to imply an answer.
 *
 * The rule in one line: a failed call is not an empty result. The failure this
 * repository has actually produced twice was not a wrong error message, it was
 * a correct error message that a reader — a model, once, and a person the next
 * time — rounded off into "there is nothing there" (FL-039).
 *
 * Exported so the test can assert the property across every branch rather than
 * spot-checking three of them with three copies of the sentence, and so a
 * fourth branch added later cannot quietly omit it.
 */
export const NOTHING_RETRIEVED = 'Nothing was retrieved, so this is not an answer and not an empty one either.';

const BEDROCK_BLOCK = /access to bedrock models is not allowed for this account/i;
const LOST_SESSION = /session not found/i;

/**
 * Turns the server's own sentence into something a person can act on, without losing it.
 *
 * The server's message is always carried through as well as explained. An
 * explanation that replaced it would be this application asserting a cause it
 * inferred — which is the move that produced FL-039's first, wrong diagnosis.
 */
export function explainFailure(tool: string, message: string): Explanation {
  if (BEDROCK_BLOCK.test(message))
    return {
      title: 'The manuals could not be searched',
      detail: `The question was fine; model access is blocked on this AWS account, and searching a manual needs a model to turn the question into a vector before it can look anything up. ${NOTHING_RETRIEVED} The server said: ${message}`
    };
  if (LOST_SESSION.test(message))
    return {
      title: 'The connection to the household server expired',
      detail: `The server instance holding this conversation was recycled. The connection was rebuilt and the call retried once, and it failed again. ${NOTHING_RETRIEVED} The server said: ${message}`
    };
  return { title: `${tool} failed`, detail: `${NOTHING_RETRIEVED} The server said: ${message}` };
}
