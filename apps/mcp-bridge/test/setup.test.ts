import { describe, expect, it } from 'vitest';
import { FORBIDDEN_TERRAFORM_OUTPUTS, READABLE_TERRAFORM_OUTPUTS, readSetupValues, renderSetup } from '../src/setup.js';

describe('the outputs the setup helper reads', () => {
  it('never includes the client secret', () => {
    // Written as a literal, not as a lookup into FORBIDDEN_TERRAFORM_OUTPUTS,
    // so that emptying that list cannot make this assertion pass vacuously.
    expect([...READABLE_TERRAFORM_OUTPUTS]).not.toContain('cognito_client_secret');
  });

  it('names no output whose name suggests a secret', () => {
    expect(READABLE_TERRAFORM_OUTPUTS.filter(name => /secret|password|token_value|private/i.test(name))).toEqual([]);
  });

  it('reads exactly the three identifiers the bridge needs', () => {
    expect([...READABLE_TERRAFORM_OUTPUTS]).toEqual(['agent_runtime_arn', 'cognito_token_url', 'cognito_client_id']);
  });

  it('keeps the forbidden list and the readable list disjoint', () => {
    expect(READABLE_TERRAFORM_OUTPUTS.some(name => (FORBIDDEN_TERRAFORM_OUTPUTS as readonly string[]).includes(name))).toBe(false);
  });
});

describe('readSetupValues', () => {
  it('asks Terraform only for the readable outputs', async () => {
    const asked: string[] = [];
    await readSetupValues(async name => {
      asked.push(name);
      return `value-for-${name}`;
    });
    expect(asked.sort()).toEqual(['agent_runtime_arn', 'cognito_client_id', 'cognito_token_url']);
  });

  it('fails with a sentence when the runtime has not been applied', async () => {
    await expect(readSetupValues(async name => (name === 'agent_runtime_arn' ? '' : 'x'))).rejects.toThrow(/has not been applied yet/);
  });
});

describe('renderSetup', () => {
  const values = {
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/homeledger_mcp-AbC123xyZ',
    tokenUrl: 'https://demo-homeledger.auth.us-east-1.amazoncognito.com/oauth2/token',
    clientId: '1example23clientid45'
  };

  it('prints a claude mcp add command carrying the three identifiers and the entrypoint', () => {
    const text = renderSetup({ values, entrypoint: '/repo/apps/mcp-bridge/dist/index.js' });
    expect(text).toContain('claude mcp add homeledger');
    expect(text).toContain("-e HOMELEDGER_RUNTIME_ARN='arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/homeledger_mcp-AbC123xyZ'");
    expect(text).toContain("-e HOMELEDGER_COGNITO_TOKEN_URL='https://demo-homeledger.auth.us-east-1.amazoncognito.com/oauth2/token'");
    expect(text).toContain("-e HOMELEDGER_COGNITO_CLIENT_ID='1example23clientid45'");
    expect(text).toContain('-- node /repo/apps/mcp-bridge/dist/index.js');
  });

  it('adds the server at user scope, so the command never lands in the repository’s .mcp.json', () => {
    expect(renderSetup({ values, entrypoint: '/repo/x.js' })).toContain('--scope user');
  });

  it('carries no client secret and says so', () => {
    const text = renderSetup({ values, entrypoint: '/repo/x.js' });
    expect(text).not.toContain('CLIENT_SECRET');
    expect(text).toContain('No client secret appears above');
  });

  it('names the sign-in command the owner needs before the first launch', () => {
    expect(renderSetup({ values, entrypoint: '/repo/x.js', profile: 'homeledger-admin' })).toContain('aws login --profile homeledger-admin');
  });
});
