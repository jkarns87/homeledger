'use client';

import { explainFailure } from '../lib/failures.js';

/**
 * One failed call, explained and quoted.
 *
 * Two paragraphs, always both. The title and the explanation are this
 * application's reading of what went wrong; the server's own sentence follows
 * it, inside `explainFailure`'s detail, because an explanation that replaced
 * the message would be this surface asserting a cause it inferred — which is
 * the move that produced FL-039's first, wrong diagnosis. A component rather
 * than an expression inside `ToolRow` because this is the surface the project
 * has already rewritten twice, and the next person to change it should be able
 * to find it by its name.
 */
export function FailureCard({ tool, message }: { tool: string; message: string }) {
  const explained = explainFailure(tool, message);
  return (
    <>
      <p className="warn">{explained.title}</p>
      <p className="muted">{explained.detail}</p>
    </>
  );
}
