import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * Unmounts and removes every tree a `.tsx` test rendered, between tests in
 * the same file.
 *
 * `@testing-library/react`'s own automatic cleanup only registers itself when
 * it finds a global `afterEach` (`typeof afterEach === 'function'` against
 * `globalThis`), which is the Jest shape. This project does not set
 * `test.globals: true` — every test file imports `afterEach` from `'vitest'`
 * explicitly instead — so that automatic registration never fires, and a
 * second `render()` in the same file lands its tree next to the first one's
 * instead of in place of it. Two renders of the same `data-testid` then both
 * sit in `document.body`, and `screen.getByTestId(...)` fails with "multiple
 * elements found" on a component that is otherwise correct. This file exists
 * so every `.tsx` test gets that cleanup without writing it out by hand;
 * it is loaded only for the `ui` vitest project (see `vitest.config.ts`),
 * because `cleanup()` touches `document`, which does not exist in the `node`
 * project that runs the `.ts` tests.
 */
afterEach(() => {
  cleanup();
});
