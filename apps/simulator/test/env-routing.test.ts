import { describe, expect, it } from 'vitest';

// Pins vitest.config.ts's environment routing rather than testing app
// behaviour: a `.ts` file must land in the 'server' project, where
// `environment: 'node'` means no DOM exists. If someone edits that value,
// this fails immediately instead of thirteen tasks later as ten
// simultaneous `ReferenceError: window is not defined` in Task 14's widget
// tests. Retire only once Task 14's own `.tsx` widget tests are landed and
// green — they exercise the same routing by needing `window` for real.
describe('vitest environment routing (.ts files run in node)', () => {
  it('has no window', () => {
    expect(typeof window).toBe('undefined');
  });
});
