import { describe, expect, it } from 'vitest';
import { ConfigError, MIN_AGENTCORE_SESSION_ID_LENGTH, invocationUrlFromArn, loadConfig, resolveAgentCoreSessionId } from '../src/config.js';

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
  it('generates one when unset, so a Claude Code session pins to a single runtime instance', () => {
    expect(resolveAgentCoreSessionId(undefined, () => 'generated-value-long-enough-for-agentcore-x')).toBe('generated-value-long-enough-for-agentcore-x');
  });

  it('sends no header at all when set to off', () => {
    expect(resolveAgentCoreSessionId('off')).toBeUndefined();
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

  it('generates a different value per call, so two bridges do not share one runtime instance', () => {
    const first = resolveAgentCoreSessionId(undefined);
    const second = resolveAgentCoreSessionId(undefined);
    expect(first).not.toBe(second);
    expect(first!.length).toBeGreaterThanOrEqual(MIN_AGENTCORE_SESSION_ID_LENGTH);
  });
});

describe('loadConfig', () => {
  it('builds the invocation URL from the runtime ARN when no explicit URL is given', () => {
    expect(loadConfig({ ...BASE_ENV }).mcpUrl).toBe(
      'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A111122223333%3Aruntime%2Fhomeledger_mcp-AbC123xyZ/invocations?qualifier=DEFAULT'
    );
  });

  it('prefers an explicit HOMELEDGER_MCP_URL over the ARN', () => {
    expect(loadConfig({ ...BASE_ENV, HOMELEDGER_MCP_URL: 'https://example.invalid/mcp' }).mcpUrl).toBe('https://example.invalid/mcp');
  });

  it('refuses to start when neither the URL nor the ARN is set', () => {
    expect(() => loadConfig({ ...BASE_ENV, HOMELEDGER_RUNTIME_ARN: undefined })).toThrow(ConfigError);
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
