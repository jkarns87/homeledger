import { SAMPLE_MANUAL_PASSAGES, SEED_TIMEZONE, createFixtureRetriever, createMemoryRepository, seedRepository } from '@homeledger/core';
import type { ServerDeps } from '../src/server.js';
import { resolveHouseholdTimeZone } from '../src/deps.js';

/**
 * The seeded in-memory deps, split out of `harness.ts` so they can be exported
 * to another package.
 *
 * `package.json` publishes this file as `@homeledger/mcp-server/test-harness`,
 * and `apps/simulator/test/mcp.test.ts` drives the real server through the real
 * seed rather than a copy of it. It is TypeScript source on purpose: it is a
 * test fixture, it is not compiled into `dist/`, it is reachable only from a
 * dev dependency, and Vitest transpiles it — so nothing ships it.
 *
 * Why it is its own file rather than the whole harness: `apps/mcp-server`'s own
 * `tsconfig.json` includes `src` only, so nothing in `test/` has ever been
 * type-checked. Importing `harness.ts` from the simulator pulled it into the
 * simulator's program and surfaced two latent errors in `modernElicitClient`,
 * which the simulator does not use. Exporting the fixture through a module that
 * carries only the fixture keeps the cross-package surface small and type-clean;
 * `harness.ts` re-exports these four names, so every existing test is unchanged.
 */
export const TODAY = '2026-09-13';

/**
 * Pinned, never read from the runner's clock. A test that took the machine's
 * zone would assert "1:00 PM" and pass in UTC CI while failing on a laptop in
 * Chicago - and, worse, would pass here while the rendering ignored the
 * household zone entirely. Every expected string in this suite is the
 * America/Chicago rendering of a UTC instant, which is a DIFFERENT string from
 * the UTC one; that difference is what proves the zone is honoured.
 */
export const TEST_TIMEZONE = SEED_TIMEZONE;

/** 39 bytes, comfortably over createRequestStateCodec's 32-byte floor. */
export const TEST_REQUEST_STATE_KEY = 'test-request-state-key-0123456789abcdef';

export async function seededDeps(): Promise<ServerDeps> {
  const repo = createMemoryRepository('hh_test');
  await seedRepository(repo, 'hh_test', TODAY);
  return {
    repo,
    now: () => `${TODAY}T12:00:00.000Z`,
    // Read from the seeded household record through the same resolver the
    // deployed server uses, rather than hard-coded here: a test that injected
    // the zone directly would still pass if `seedRepository` stopped writing
    // one, which is half of what this feature is.
    householdTimeZone: () => resolveHouseholdTimeZone(repo),
    devTools: true,
    retriever: createFixtureRetriever(SAMPLE_MANUAL_PASSAGES),
    requestStateKey: TEST_REQUEST_STATE_KEY,
    availabilityDelayMs: 0
  };
}
