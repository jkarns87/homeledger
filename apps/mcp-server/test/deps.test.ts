import { describe, expect, it } from 'vitest';
import { depsFromEnv } from '../src/deps.js';

const VALID_KEY = 'a'.repeat(32);

function baseEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { HOUSEHOLD_ID: 'hh_test', MEMORY_REPO: '1', ...overrides } as NodeJS.ProcessEnv;
}

describe('the ICU guard (via depsFromEnv)', () => {
  it('refuses to start on a Node whose Intl ignores the timeZone option', async () => {
    // A slim base image without IANA data would not throw anywhere - it would
    // serve UTC times labelled with the household's zone abbreviation, which
    // reads as correct and is not. Refusing to boot is the only failure mode
    // an operator can see. See packages/core/test/time.test.ts for the same
    // probe under unit test, and the deployed image was checked directly.
    const real = globalThis.Intl;
    globalThis.Intl = {
      DateTimeFormat: class {
        format(value: number | Date) {
          return new Date(value).toISOString();
        }
        formatToParts() {
          return [];
        }
      }
    } as unknown as typeof Intl;
    try {
      await expect(depsFromEnv(baseEnv())).rejects.toThrow(/no IANA time-zone data/);
    } finally {
      globalThis.Intl = real;
    }
  });

  it('resolves the seeded household zone once the runtime is sound', async () => {
    const deps = await depsFromEnv(baseEnv());
    expect(await deps.householdTimeZone()).toBe('America/Chicago');
  });
});

describe('resolveRequestStateKey (via depsFromEnv)', () => {
  it('mints a per-process key when REQUEST_STATE_KEY is unset', async () => {
    const deps = await depsFromEnv(baseEnv());
    expect(typeof deps.requestStateKey).toBe('string');
    expect(Buffer.byteLength(deps.requestStateKey, 'utf8')).toBeGreaterThanOrEqual(32);
  });

  it('uses the configured key when it meets the length floor', async () => {
    const deps = await depsFromEnv(baseEnv({ REQUEST_STATE_KEY: VALID_KEY }));
    expect(deps.requestStateKey).toBe(VALID_KEY);
  });

  it('throws when REQUEST_STATE_KEY is set but too short', async () => {
    await expect(depsFromEnv(baseEnv({ REQUEST_STATE_KEY: 'too-short' }))).rejects.toThrow(/at least 32 bytes/);
  });

  it('throws when REQUEST_STATE_KEY is explicitly set to an empty string, rather than silently generating one', async () => {
    await expect(depsFromEnv(baseEnv({ REQUEST_STATE_KEY: '' }))).rejects.toThrow(/at least 32 bytes/);
  });
});
