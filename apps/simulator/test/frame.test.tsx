import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Frame } from '../src/components/Frame.js';
import { DISCLOSURE_TEXT, SCRIPTED_MARKER_TEXT } from '../src/components/Disclosure.js';
import { BASE_CANVAS, CANVAS_SCALE, DEVICE } from '../src/shared/canvas.js';
import { FORBIDDEN_WORDMARKS } from '../src/server/prompt.js';

describe('Frame', () => {
  it('is a 1280 by 800 display, which is the base canvas at its published scale', () => {
    // The spec gives 768x480 and 1.667; the device size is derived from them
    // rather than written down separately, so the three can never disagree.
    expect(BASE_CANVAS).toEqual({ width: 768, height: 480 });
    expect(CANVAS_SCALE).toBe(1.667);
    expect(DEVICE).toEqual({ width: 1280, height: 800 });
  });

  it('renders the canvas at its unscaled size and scales it with a transform', () => {
    render(
      <Frame theme="dark" onToggleTheme={() => {}}>
        <p>content</p>
      </Frame>
    );
    const canvas = screen.getByTestId('canvas');
    expect(canvas.style.width).toBe('768px');
    expect(canvas.style.height).toBe('480px');
    expect(canvas.style.transform).toBe('scale(1.667)');
    const device = screen.getByTestId('device');
    expect(device.style.width).toBe('1280px');
    expect(device.style.height).toBe('800px');
  });

  it('shows the disclosure without anyone opening anything', () => {
    render(
      <Frame theme="dark" onToggleTheme={() => {}}>
        <p>content</p>
      </Frame>
    );
    const disclosure = screen.getByTestId('disclosure');
    expect(disclosure.textContent).toBe(DISCLOSURE_TEXT);
    expect(disclosure.hidden).toBe(false);
  });

  it('shows no scripted marker by default, and shows one when told the model is scripted', () => {
    // The ruling this test proves: the flag alone is not a safety property
    // and the console line nobody watches during a demo is not a
    // guarantee either — the marker on screen is. Default (no `scripted`
    // prop, matching page.tsx before the debug snapshot's first response)
    // must show nothing at all, not a false negative that happens to read
    // the same as "not scripted".
    const { rerender } = render(
      <Frame theme="dark" onToggleTheme={() => {}}>
        <p>content</p>
      </Frame>
    );
    expect(screen.queryByTestId('scripted-marker')).toBeNull();

    rerender(
      <Frame theme="dark" onToggleTheme={() => {}} scripted>
        <p>content</p>
      </Frame>
    );
    expect(screen.getByTestId('scripted-marker').textContent).toBe(SCRIPTED_MARKER_TEXT);
  });

  it('says both of the things that have to be said', () => {
    expect(DISCLOSURE_TEXT).toContain('Simulation');
    expect(DISCLOSURE_TEXT).toContain('sample data');
    expect(DISCLOSURE_TEXT).toContain('no booking leaves this system');
  });

  it('wears no product name it has no right to', () => {
    render(
      <Frame theme="dark" onToggleTheme={() => {}}>
        <p>content</p>
      </Frame>
    );
    // Lowercased on both sides, the same way Task 7's source guard does it.
    // The two checks are meant to be the same rule applied at two levels -
    // source text and rendered text - and a case-sensitive one here would let
    // a rendered `alexa` through while the source guard caught it, which makes
    // the pair confusing rather than redundant.
    //
    // `innerHTML`, not `textContent`: the toggle's accessible name is an
    // `aria-label` attribute, not text a screen shows, and `textContent`
    // does not walk into attribute values at all. A mark placed there would
    // pass a `textContent` check while still reaching a screen reader and the
    // accessibility tree - verified by mutation, see Task 10's report.
    const html = document.body.innerHTML.toLowerCase();
    for (const mark of FORBIDDEN_WORDMARKS) expect(html, mark).not.toContain(mark.toLowerCase());
  });

  it('reflects the theme it is given and offers exactly one control to change it', async () => {
    const onToggleTheme = vi.fn();
    const { rerender } = render(
      <Frame theme="dark" onToggleTheme={onToggleTheme}>
        <p>content</p>
      </Frame>
    );
    expect(screen.getByTestId('device').dataset.theme).toBe('dark');
    const toggle = screen.getByRole('button', { name: /switch to the light theme/i });
    toggle.click();
    expect(onToggleTheme).toHaveBeenCalledTimes(1);

    rerender(
      <Frame theme="light" onToggleTheme={onToggleTheme}>
        <p>content</p>
      </Frame>
    );
    expect(screen.getByTestId('device').dataset.theme).toBe('light');
    expect(screen.getByRole('button', { name: /switch to the dark theme/i })).toBeDefined();
  });

  it('puts its children inside the canvas, not beside it', () => {
    render(
      <Frame theme="dark" onToggleTheme={() => {}}>
        <p data-testid="child">content</p>
      </Frame>
    );
    expect(screen.getByTestId('canvas').contains(screen.getByTestId('child'))).toBe(true);
  });
});
