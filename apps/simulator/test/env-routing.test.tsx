import { describe, expect, it } from 'vitest';

// Pins vitest.config.ts's environment routing rather than testing app
// behaviour: a `.tsx` file must land in the 'ui' project, where
// `environment: 'jsdom'` means a real DOM exists and can be queried. If
// someone edits that value, this fails immediately instead of thirteen
// tasks later as ten simultaneous `ReferenceError: window is not defined`
// in Task 14's widget tests. Retire only once Task 14's own `.tsx` widget
// tests are landed and green — they exercise the same routing by needing
// `window` for real.
describe('vitest environment routing (.tsx files run in jsdom)', () => {
  it('has a reachable document', () => {
    expect(typeof document).toBe('object');
    document.body.innerHTML = '<span data-probe></span>';
    expect(document.querySelector('[data-probe]')).not.toBeNull();
  });
});
