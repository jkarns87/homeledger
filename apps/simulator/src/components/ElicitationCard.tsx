'use client';

import { useRef, useState } from 'react';
import type { PendingQuestion } from '../lib/transcript.js';

/** Called with the question the card was showing, so the answer names that question and no other. */
export type AnswerHandler = (question: PendingQuestion, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => void;

/**
 * The server's question, rendered as controls instead of as text.
 *
 * The prompt string is the server's own `message` and appears here and nowhere
 * else: it never enters the transcript, because a question that scrolls away
 * with the conversation is a question somebody will answer into the wrong box.
 * Buttons carry the display names from `enumNames`; the value posted back is
 * the enum value the server will actually accept, so there is no path by which
 * a person answers something that gets rejected.
 *
 * Answers once. The first click disables every button, and a second click that
 * lands before the re-render is dropped by the ref: a double click used to post
 * the same question twice, and the second post came back as a failure notice
 * for a harmless click (final review I2).
 */
export function ElicitationCard({ question, onAnswer }: { question: PendingQuestion; onAnswer: AnswerHandler }) {
  const answered = useRef(false);
  const [sent, setSent] = useState(false);
  const send = (action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => {
    if (answered.current) return;
    answered.current = true;
    setSent(true);
    onAnswer(question, action, content);
  };
  // Booking words only where a booking is what is being confirmed. Any other
  // yes/no question - the deployed runtime also offers the model a generic
  // confirmation tool - gets plain Yes and No, because "book it" on a question
  // that books nothing is a sentence about something that is not happening.
  const booking = question.tool === 'book_service';
  return (
    <section className="card elicitation" data-testid="elicitation" data-field={question.field} aria-live="polite" aria-busy={sent}>
      <p className="prompt">{question.prompt}</p>
      {question.kind === 'confirm' ? (
        <div className="choices">
          <button type="button" disabled={sent} onClick={() => send('accept', { [question.field]: true })}>
            {booking ? 'Yes, book it' : 'Yes'}
          </button>
          <button type="button" className="secondary" disabled={sent} onClick={() => send('accept', { [question.field]: false })}>
            {booking ? 'No, don’t book it' : 'No'}
          </button>
        </div>
      ) : (
        <div className="choices">
          {question.options.map(option => (
            <button
              key={option.value}
              type="button"
              data-testid={`option-${option.value}`}
              disabled={sent}
              onClick={() => send('accept', { [question.field]: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {/* A decline, not a fabricated answer. The server turns it into "Okay, I
          haven't booked anything" and writes nothing, which is the truthful
          outcome of somebody walking away from the question. */}
      <button type="button" className="link" disabled={sent} onClick={() => send('decline')}>
        Not now
      </button>
    </section>
  );
}
