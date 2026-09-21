import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_RUNTIME_NAME,
  MIN_AGENTCORE_SESSION_ID_LENGTH,
  invocationUrlFromArn,
  loadConfig,
  resolveAgentCoreSessionId,
  resolveRuntimeTarget
} from '../src/config.js';

/** The shape `infra/modules/agentcore-runtime` produces, with the account id replaced. */
const ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/homeledger_mcp-AbC123xyZ';

const BASE_ENV = {
  HOMELEDGER_RUNTIME_ARN: ARN,
  HOMELEDGER_COGNITO_TOKEN_URL: 'https://demo-homeledger.auth.us-east-1.amazoncognito.com/oauth2/token',
  HOMELEDGER_COGNITO_CLIENT_ID: '1example23clientid45'
} satisfies NodeJS.ProcessEnv;

describe('invocationUrlFromArn', () => {
  it('produces the URL Terraform’s invocation_url output produces', () => {
    // Written out in full rather than rebuilt with encodeURIComponent, which
    // would only assert that the function calls the function it calls. This is
    // the byte-for-byte result of the `urlencode(...)` expression in
    // infra/modules/agentcore-runtime/outputs.tf for the ARN above.
    expect(invocationUrlFromArn(ARN, 'us-east-1', 'DEFAULT')).toBe(
      'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A111122223333%3Aruntime%2Fhomeledger_mcp-AbC123xyZ/invocations?qualifier=DEFAULT'
    );
  });

  it('puts the region in the host, so a mismatched AWS_REGION is visible in the URL', () => {
    expect(invocationUrlFromArn(ARN, 'eu-west-2', 'DEFAULT')).toContain('https://bedrock-agentcore.eu-west-2.amazonaws.com/');
  });
});

describe('resolveAgentCoreSessionId', () => {
  it('sends no header at all when unset, which is exactly what the smoke does', () => {
    // The reversal FL-039 argued for. AgentCore pins an MCP session to one
    // instance by Mcp-Session-Id on its own, so the default configuration adds
    // no second session of its own for AgentCore to age out independently.
    expect(resolveAgentCoreSessionId(undefined)).toBeUndefined();
    expect(resolveAgentCoreSessionId('')).toBeUndefined();
  });

  it('still sends no header when set to off, so a config written against the old default keeps working', () => {
    expect(resolveAgentCoreSessionId('off')).toBeUndefined();
  });

  it('generates one per process only when asked for by name', () => {
    expect(resolveAgentCoreSessionId('on', () => 'generated-value-long-enough-for-agentcore-x')).toBe('generated-value-long-enough-for-agentcore-x');
  });

  it('keeps a pinned value the owner supplied', () => {
    const pinned = 'homeledger-bridge-pinned-session-identifier';
    expect(resolveAgentCoreSessionId(pinned)).toBe(pinned);
  });

  it('rejects a pinned value AgentCore would reject, at startup rather than on the first tool call', () => {
    expect(() => resolveAgentCoreSessionId('too-short')).toThrow(/at least 33 characters/);
  });

  it('accepts a value of exactly the minimum length', () => {
    const exact = 'a'.repeat(MIN_AGENTCORE_SESSION_ID_LENGTH);
    expect(resolveAgentCoreSessionId(exact)).toBe(exact);
  });

  it('generates a different value per call, so two bridges that opt in do not share one runtime instance', () => {
    const first = resolveAgentCoreSessionId('on');
    const second = resolveAgentCoreSessionId('on');
    expect(first).not.toBe(second);
    expect(first!.length).toBeGreaterThanOrEqual(MIN_AGENTCORE_SESSION_ID_LENGTH);
  });
});

describe('resolveRuntimeTarget', () => {
  it('resolves by name when nothing pins an address, which is the form that survives a recreate', () => {
    expect(resolveRuntimeTarget({})).toEqual({ kind: 'name', name: 'demo_homeledger_mcp' });
  });

  it('takes a supplied ARN over the name, and carries the name along for the refusal message', () => {
    expect(resolveRuntimeTarget({ HOMELEDGER_RUNTIME_ARN: ARN })).toEqual({ kind: 'arn', arn: ARN, name: DEFAULT_RUNTIME_NAME });
  });

  it('takes a supplied URL over everything, because it is the only form that need not be an AWS address at all', () => {
    expect(resolveRuntimeTarget({ HOMELEDGER_MCP_URL: 'https://example.invalid/mcp', HOMELEDGER_RUNTIME_ARN: ARN })).toEqual({
      kind: 'url',
      url: 'https://example.invalid/mcp'
    });
  });

  it('lets a fork point the by-name lookup at its own runtime', () => {
    expect(resolveRuntimeTarget({ HOMELEDGER_RUNTIME_NAME: 'other_homeledger_mcp' })).toEqual({ kind: 'name', name: 'other_homeledger_mcp' });
  });

  it('treats a whitespace-only pin as unset, which is what an unexpanded shell variable leaves behind', () => {
    expect(resolveRuntimeTarget({ HOMELEDGER_RUNTIME_ARN: '   ', HOMELEDGER_MCP_URL: '  ' })).toEqual({ kind: 'name', name: DEFAULT_RUNTIME_NAME });
  });
});

describe('loadConfig', () => {
  it('carries the supplied ARN through as a pin rather than composing a URL there and then', () => {
    expect(loadConfig({ ...BASE_ENV }).target).toEqual({ kind: 'arn', arn: ARN, name: DEFAULT_RUNTIME_NAME });
  });

  it('starts perfectly happily with no runtime pinned at all, and resolves by name instead', () => {
    // The old build threw a ConfigError here. That refusal was the bug in
    // miniature: it insisted on being handed an address it was entirely
    // capable of looking up.
    expect(loadConfig({ ...BASE_ENV, HOMELEDGER_RUNTIME_ARN: undefined }).target).toEqual({ kind: 'name', name: DEFAULT_RUNTIME_NAME });
  });

  it('carries the qualifier the invocation URL will be built with', () => {
    expect(loadConfig({ ...BASE_ENV }).qualifier).toBe('DEFAULT');
    expect(loadConfig({ ...BASE_ENV, HOMELEDGER_RUNTIME_QUALIFIER: 'canary' }).qualifier).toBe('canary');
  });

  it('records that it minted the runtime session id only when it actually did', () => {
    expect(loadConfig({ ...BASE_ENV }).agentCoreSessionGenerated).toBe(false);
    expect(loadConfig({ ...BASE_ENV, HOMELEDGER_AGENTCORE_SESSION_ID: 'on' }).agentCoreSessionGenerated).toBe(true);
    expect(loadConfig({ ...BASE_ENV, HOMELEDGER_AGENTCORE_SESSION_ID: 'a'.repeat(40) }).agentCoreSessionGenerated).toBe(false);
  });

  it('sends no AgentCore runtime session header by default', () => {
    expect(loadConfig({ ...BASE_ENV }).agentCoreSessionId).toBeUndefined();
  });

  it('names the missing variable and the Terraform output that supplies it', () => {
    expect(() => loadConfig({ ...BASE_ENV, HOMELEDGER_COGNITO_CLIENT_ID: undefined })).toThrow(/HOMELEDGER_COGNITO_CLIENT_ID is not set.*cognito_client_id/s);
  });

  it('defaults the scope and the secret id to the values the deployed stack uses', () => {
    const config = loadConfig({ ...BASE_ENV });
    expect(config.scope).toBe('homeledger/mcp');
    expect(config.secretId).toBe('demo-homeledger/cognito/client-secret');
  });

  it('treats an explicitly empty client secret as a mistake rather than as a request to use Secrets Manager', () => {
    expect(() => loadConfig({ ...BASE_ENV, HOMELEDGER_COGNITO_CLIENT_SECRET: '' })).toThrow(/set but empty/);
  });

  it('carries a real client secret through and leaves Secrets Manager unused', () => {
    expect(loadConfig({ ...BASE_ENV, HOMELEDGER_COGNITO_CLIENT_SECRET: 'from-the-environment' }).clientSecretFromEnv).toBe('from-the-environment');
  });

  it('lets an AWS_PROFILE already in the environment win over the project default', () => {
    expect(loadConfig({ ...BASE_ENV, AWS_PROFILE: 'some-other-profile' }).awsProfile).toBe('some-other-profile');
  });

  it('falls back to the project profile when nothing in the environment names one', () => {
    expect(loadConfig({ ...BASE_ENV }).awsProfile).toBe('homeledger-admin');
  });

  it('holds the standalone stream open by default and closes it on request', () => {
    expect(loadConfig({ ...BASE_ENV }).standaloneStream).toBe(true);
    expect(loadConfig({ ...BASE_ENV, HOMELEDGER_BRIDGE_SSE: 'off' }).standaloneStream).toBe(false);
  });
});
