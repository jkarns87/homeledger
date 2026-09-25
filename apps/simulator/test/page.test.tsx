import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Home from '../src/app/page.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the page starts a fresh conversation when it loads (final review I3)', () => {
  it('resets once, even under StrictMode, and keeps the composer shut until the reset has been answered', async () => {
    // The server's history outlives a reload and the transcript does not, so a
    // retake used to hand the model every earlier take unseen. StrictMode runs
    // a mount effect twice in development; a second reset landing after the
    // first question would abort that question's turn, so this pins "once".
    let answerReset!: (response: Response) => void;
    const fetchSpy = vi.fn((url: string) => {
      if (url === '/api/agent/reset') return new Promise<Response>(resolve => (answerReset = resolve));
      // The debug drawer's read: unavailable, which it renders as nothing to show.
      return Promise.resolve(new Response('{}', { status: 503 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <StrictMode>
        <Home />
      </StrictMode>
    );
    await waitFor(() => expect(fetchSpy.mock.calls.filter(([url]) => url === '/api/agent/reset')).toHaveLength(1));
    const input = screen.getByLabelText('Ask about the house') as HTMLInputElement;
    expect(input.disabled).toBe(true);

    await act(async () => {
      answerReset(new Response('{"ok":true}', { status: 200 }));
    });
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(fetchSpy.mock.calls.filter(([url]) => url === '/api/agent/reset')).toHaveLength(1);
  });
});
