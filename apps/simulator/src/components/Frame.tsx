'use client';

import type { ReactNode } from 'react';
import { BASE_CANVAS, CANVAS_SCALE, DEVICE } from '../shared/canvas.js';
import { Disclosure } from './Disclosure.js';

export type Theme = 'dark' | 'light';

export function Frame({
  theme,
  onToggleTheme,
  scripted = false,
  children
}: {
  theme: Theme;
  onToggleTheme: () => void;
  /** Passed straight through to `Disclosure` — see its own doc comment. */
  scripted?: boolean;
  children: ReactNode;
}) {
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <div className="device" data-testid="device" data-theme={theme} style={{ width: DEVICE.width, height: DEVICE.height }}>
      {/* Rendered at 768x480 and scaled up, rather than laid out at 1280x800.
          Anything else would let the layout reflow at the larger size, which
          is exactly what a fixed base canvas exists to prevent: a widget
          authored for 768 wide would sit in a column it never expected. */}
      <div
        className="canvas"
        data-testid="canvas"
        style={{ width: BASE_CANVAS.width, height: BASE_CANVAS.height, transform: `scale(${CANVAS_SCALE})`, transformOrigin: 'top left' }}
      >
        <div className="surface">{children}</div>
        <Disclosure scripted={scripted} />
      </div>
      <button type="button" className="theme-toggle" onClick={onToggleTheme} aria-label={`Switch to the ${next} theme`}>
        {next === 'light' ? 'Light' : 'Dark'}
      </button>
    </div>
  );
}
