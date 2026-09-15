import { describe, expect, it } from 'vitest';
import { depsFromEnv } from '../src/deps.js';

const VALID_KEY = 'a'.repeat(32);

function baseEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { HOUSEHOLD_ID: 'hh_test', MEMORY_REPO: '1', ...overrides } as NodeJS.ProcessEnv;
}

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
