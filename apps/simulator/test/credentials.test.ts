import { describe, expect, it } from 'vitest';
import { DEFAULT_ELICITATION_TIMEOUT_MS, DEFAULT_MAX_ROUNDS, DEFAULT_MODEL, SimulatorConfigError, readSimulatorEnv } from '../src/server/env.js';

/**
 * Builds a `NodeJS.ProcessEnv` fixture.
 *
 * A bare object literal will not do, and the reason is local to this package:
 * `next-env.d.ts` pulls in `next/types/global.d.ts`, which augments
 * `NodeJS.ProcessEnv` with a *required* `readonly NODE_ENV` (Next's own comment
 * there calls that a TODO). So a literal is not assignable to the type, and
 * `as NodeJS.ProcessEnv` is rejected outright as TS2352 rather than waved
 * through. `apps/mcp-bridge/test/config.test.ts` hands `loadConfig` plain
 * literals because no Next augmentation reaches that package; here the field is
 * supplied once, in one place, instead of being copied into six fixtures.
 * Nothing under test reads it.
 */
function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const source: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  return Object.assign(source, values);
}

const minimal = env({ ANTHROPIC_API_KEY: 'sk-ant-test' });

describe('readSimulatorEnv', () => {
  it('reads the key and fills every other value from a default', () => {
    expect(readSimulatorEnv(minimal)).toEqual({
      anthropicApiKey: 'sk-ant-test',
      model: DEFAULT_MODEL,
      maxRounds: DEFAULT_MAX_ROUNDS,
      elicitationTimeoutMs: DEFAULT_ELICITATION_TIMEOUT_MS,
      allowOrigin: undefined
    });
  });

  it('pins the default model, round budget and elicitation timeout to literal values', () => {
    // The test above compares `readSimulatorEnv`'s output against the same
    // symbols the function fills it from, so it is `x === x` and all three
    // constants can be changed to anything at all without failing it —
    // confirmed by setting them to 'totally-wrong-model-id', 9999 and 1
    // simultaneously and watching the suite stay green. These are not cosmetic
    // values: DEFAULT_MODEL is posted to the Anthropic API, and an elicitation
    // timeout of 1ms expires every prompt before a person can read it. Written
    // out as literals here, which is the only form that can disagree.
    expect({ DEFAULT_MODEL, DEFAULT_MAX_ROUNDS, DEFAULT_ELICITATION_TIMEOUT_MS }).toEqual({
      DEFAULT_MODEL: 'claude-opus-5',
      DEFAULT_MAX_ROUNDS: 8,
      DEFAULT_ELICITATION_TIMEOUT_MS: 120_000
    });
  });

  it('names the variable, and the file it belongs in, when the key is missing', () => {
    expect(() => readSimulatorEnv(env({}))).toThrow(SimulatorConfigError);
    expect(() => readSimulatorEnv(env({}))).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(() => readSimulatorEnv(env({}))).toThrow(/apps\/simulator\/\.env\.local/);
  });

  it('treats set-but-empty as a misconfiguration rather than as unset', () => {
    expect(() => readSimulatorEnv(env({ ANTHROPIC_API_KEY: '   ' }))).toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it('overrides every default from the environment', () => {
    expect(
      readSimulatorEnv(
        env({
          ANTHROPIC_API_KEY: 'sk-ant-test',
          HOMELEDGER_SIMULATOR_MODEL: 'claude-sonnet-5',
          HOMELEDGER_SIMULATOR_MAX_ROUNDS: '3',
          HOMELEDGER_SIMULATOR_ELICITATION_TIMEOUT_MS: '5000',
          HOMELEDGER_SIMULATOR_ALLOW_ORIGIN: 'http://127.0.0.1:3000'
        })
      )
    ).toEqual({
      anthropicApiKey: 'sk-ant-test',
      model: 'claude-sonnet-5',
      maxRounds: 3,
      elicitationTimeoutMs: 5000,
      allowOrigin: 'http://127.0.0.1:3000'
    });
  });

  it('refuses a round budget that is not a positive integer rather than silently using the default', () => {
    for (const value of ['0', '-1', '2.5', 'many', '']) {
      expect(() => readSimulatorEnv(env({ ...minimal, HOMELEDGER_SIMULATOR_MAX_ROUNDS: value })), value).toThrow(/HOMELEDGER_SIMULATOR_MAX_ROUNDS/);
    }
  });

  it('reads process.env when given no source', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-process';
    try {
      expect(readSimulatorEnv().anthropicApiKey).toBe('sk-ant-from-process');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
