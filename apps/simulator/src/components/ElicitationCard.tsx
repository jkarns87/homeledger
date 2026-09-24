'use client';

import type { PendingQuestion } from '../lib/transcript.js';

export type AnswerHandler = (action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => void;

/**
 * The server's question, rendered as controls instead of as text.
 *
 * The prompt string is the server's own `message` and appears here and nowhere
 * else: it never enters the transcript, because a question that scrolls away
 * with the conversation is a question somebody will answer into the wrong box.
 * Buttons carry the display names from `enumNames`; the value posted back is
 * the enum value the server will actually accept, so there is no path by which
 * a person answers something that gets rejected.
 */
export function ElicitationCard({ question, onAnswer }: { question: PendingQuestion; onAnswer: AnswerHandler }) {
  return (
    <section className="card elicitation" data-testid="elicitation" data-field={question.field} aria-live="polite">
      <p className="prompt">{question.prompt}</p>
      {question.kind === 'confirm' ? (
        <div className="choices">
          <button type="button" onClick={() => onAnswer('accept', { [question.field]: true })}>
            Yes, book it
          </button>
          <button type="button" className="secondary" onClick={() => onAnswer('accept', { [question.field]: false })}>
            No, don’t book it
          </button>
        </div>
      ) : (
        <div className="choices">
          {question.options.map(option => (
            <button
              key={option.value}
              type="button"
              data-testid={`option-${option.value}`}
              onClick={() => onAnswer('accept', { [question.field]: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {/* A decline, not a fabricated answer. The server turns it into "Okay, I
          haven't booked anything" and writes nothing, which is the truthful
          outcome of somebody walking away from the question. */}
      <button type="button" className="link" onClick={() => onAnswer('decline')}>
        Not now
      </button>
    </section>
  );
}
