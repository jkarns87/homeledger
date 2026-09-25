import { describe, expect, it } from 'vitest';
import { DEFAULT_ELICITATION_TIMEOUT_MS, DEFAULT_MAX_ROUNDS, DEFAULT_MODEL, SimulatorConfigError, readSimulatorEnv } from '../src/server/env.js';
import { isUnauthenticatedLocal } from '../src/server/credentials.js';
import { assertScriptedModeAllowed, SCRIPTED_MODEL_FLAG, scriptedModelRequested } from '../src/server/session.js';

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
      DEFAULT_MODEL: 'claude-sonnet-5',
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
    // The model override is deliberately set to something OTHER than
    // DEFAULT_MODEL. If it matched, a broken override (readSimulatorEnv
    // silently falling back to the default) would still produce the expected
    // value by coincidence, and this assertion would stop proving the
    // override path runs at all.
    expect(
      readSimulatorEnv(
        env({
          ANTHROPIC_API_KEY: 'sk-ant-test',
          HOMELEDGER_SIMULATOR_MODEL: 'claude-opus-5',
          HOMELEDGER_SIMULATOR_MAX_ROUNDS: '3',
          HOMELEDGER_SIMULATOR_ELICITATION_TIMEOUT_MS: '5000',
          HOMELEDGER_SIMULATOR_ALLOW_ORIGIN: 'http://127.0.0.1:3000'
        })
      )
    ).toEqual({
      anthropicApiKey: 'sk-ant-test',
      model: 'claude-opus-5',
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

describe('local, unauthenticated mode', () => {
  it('is on only when a whole URL is pinned and no token endpoint is configured', () => {
    expect(isUnauthenticatedLocal(env({ HOMELEDGER_MCP_URL: 'http://127.0.0.1:8010/mcp' }))).toBe(true);
    expect(isUnauthenticatedLocal(env({ HOMELEDGER_MCP_URL: 'http://127.0.0.1:8010/mcp', HOMELEDGER_COGNITO_TOKEN_URL: 'https://x/oauth2/token' }))).toBe(
      false
    );
    expect(isUnauthenticatedLocal(env({ HOMELEDGER_COGNITO_TOKEN_URL: 'https://x/oauth2/token' }))).toBe(false);
    expect(isUnauthenticatedLocal(env({}))).toBe(false);
  });

  it('refuses to skip authentication for anything that is not a loopback address', () => {
    // The whole safety of this mode is that it cannot be pointed at the
    // deployed runtime. A bearerless request to AgentCore would be refused
    // anyway, but a mode that silently tries is a mode somebody will debug.
    expect(isUnauthenticatedLocal(env({ HOMELEDGER_MCP_URL: 'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/x/invocations' }))).toBe(false);
    expect(isUnauthenticatedLocal(env({ HOMELEDGER_MCP_URL: 'http://localhost:8010/mcp' }))).toBe(true);
    expect(isUnauthenticatedLocal(env({ HOMELEDGER_MCP_URL: 'not a url' }))).toBe(false);
  });

  it('accepts IPv6 loopback in the bracketed form the URL parser actually produces', () => {
    // `new URL('http://[::1]:8010/').hostname` is '[::1]', WITH the brackets:
    // the WHATWG parser keeps them, so a check for '::1' is a branch nothing
    // can ever reach. That is the fourth shape Global Constraint 26 names -
    // a branch made unreachable by a library's own preprocessing - and the
    // draft of this plan prescribed it in the same document that warns about
    // it. This case is the proof that the arm is live.
    expect(isUnauthenticatedLocal(env({ HOMELEDGER_MCP_URL: 'http://[::1]:8010/mcp' }))).toBe(true);
    expect(new URL('http://[::1]:8010/mcp').hostname).toBe('[::1]');
  });
});

describe('the scripted model', () => {
  it('is off unless the flag is exactly 1', () => {
    expect(scriptedModelRequested(env({}))).toBe(false);
    for (const value of ['', '0', 'true', 'yes', 'TRUE', ' 1']) expect(scriptedModelRequested(env({ [SCRIPTED_MODEL_FLAG]: value })), value).toBe(false);
    expect(scriptedModelRequested(env({ [SCRIPTED_MODEL_FLAG]: '1' }))).toBe(true);
  });

  it('names the exact environment variable, not merely a symbol that happens to equal it', () => {
    // A test that only compares SCRIPTED_MODEL_FLAG against itself
    // (`scriptedModelRequested(env({ [SCRIPTED_MODEL_FLAG]: ... }))`, as the
    // case above does) cannot tell the real flag name from a renamed
    // constant that is still internally self-consistent — confirmed by
    // renaming SCRIPTED_MODEL_FLAG to 'HOMELEDGER_SCRIPTED' and re-running:
    // every case above still passed 11/11, because both the flag being set
    // and the flag being read moved together. `playwright.config.ts` and
    // `.env.example` spell out the literal string on their own, with no
    // access to this constant, so a silent rename would orphan them with
    // nothing here to notice.
    expect(SCRIPTED_MODEL_FLAG).toBe('HOMELEDGER_SIMULATOR_SCRIPTED_MODEL');
  });
});

describe('the scripted-mode gate', () => {
  it('refuses scripted mode against anything that is not a loopback, unauthenticated upstream', () => {
    // The exact shape a leftover .env.local would produce: the flag left on
    // from an end-to-end run, HOMELEDGER_MCP_URL unset (or pointed at the
    // deployed runtime), so the normal Cognito path resolves the real
    // AgentCore endpoint by name.
    expect(() => assertScriptedModeAllowed(env({ [SCRIPTED_MODEL_FLAG]: '1' }))).toThrow(SimulatorConfigError);
    expect(() => assertScriptedModeAllowed(env({ [SCRIPTED_MODEL_FLAG]: '1' }))).toThrow(new RegExp(SCRIPTED_MODEL_FLAG));
    expect(() =>
      assertScriptedModeAllowed(
        env({ [SCRIPTED_MODEL_FLAG]: '1', HOMELEDGER_MCP_URL: 'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/x/invocations' })
      )
    ).toThrow(SimulatorConfigError);
  });

  it('allows scripted mode only against a loopback upstream with no Cognito token endpoint configured', () => {
    expect(() => assertScriptedModeAllowed(env({ [SCRIPTED_MODEL_FLAG]: '1', HOMELEDGER_MCP_URL: 'http://127.0.0.1:8010/mcp' }))).not.toThrow();
  });

  it('never refuses when scripted mode was not requested at all, whatever the upstream is', () => {
    expect(() => assertScriptedModeAllowed(env({}))).not.toThrow();
    expect(() =>
      assertScriptedModeAllowed(env({ HOMELEDGER_MCP_URL: 'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/x/invocations' }))
    ).not.toThrow();
  });
});
