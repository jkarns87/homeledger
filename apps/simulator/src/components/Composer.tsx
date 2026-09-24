'use client';

import { useState, type FormEvent } from 'react';

export function Composer({ disabled, onAsk }: { disabled: boolean; onAsk: (text: string) => void }) {
  const [text, setText] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed === '' || disabled) return;
    setText('');
    onAsk(trimmed);
  };
  return (
    <form className="composer" onSubmit={submit}>
      <input
        type="text"
        value={text}
        onChange={event => setText(event.target.value)}
        placeholder="Ask about the house"
        aria-label="Ask about the house"
        disabled={disabled}
      />
      <button type="submit" disabled={disabled || text.trim() === ''}>
        Ask
      </button>
    </form>
  );
}
