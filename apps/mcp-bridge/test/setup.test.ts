import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_TERRAFORM_OUTPUTS,
  READABLE_TERRAFORM_OUTPUTS,
  readSetupValues,
  renderSetup,
  resolveSetupIdentity,
  resolveSetupSource,
  terraformFailureMessage
} from '../src/setup.js';

describe('the outputs the --from-terraform path reads', () => {
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

describe('resolveSetupSource', () => {
  it('reads AWS unless asked otherwise, so a clean checkout never meets Terraform', () => {
    expect(resolveSetupSource(['node', 'index.js', '--print-setup'], {})).toBe('aws');
  });

  it('switches to Terraform only on an explicit flag', () => {
    expect(resolveSetupSource(['node', 'index.js', '--print-setup', '--from-terraform'], {})).toBe('terraform');
  });

  it('accepts the environment form for a CI caller that cannot add a flag', () => {
    expect(resolveSetupSource([], { HOMELEDGER_SETUP_SOURCE: 'terraform' })).toBe('terraform');
  });

  it('does not treat some other value, or the mere presence of the variable, as a request for Terraform', () => {
    expect(resolveSetupSource([], { HOMELEDGER_SETUP_SOURCE: '' })).toBe('aws');
    expect(resolveSetupSource([], { HOMELEDGER_SETUP_SOURCE: 'tf' })).toBe('aws');
  });
});

describe('terraformFailureMessage', () => {
  it('explains that terraform init would fail too, rather than repeating Terraform’s advice', () => {
    const message = terraformFailureMessage(new Error('Error: Backend initialization required, please run "terraform init"'));
    expect(message).toContain('Backend initialization required');
    expect(message).toContain('-backend-config=bucket=');
    expect(message).toContain('Drop --from-terraform to read the same values from AWS instead.');
  });

  it('says so plainly when terraform is not installed at all', () => {
    const err = Object.assign(new Error('spawn terraform ENOENT'), { code: 'ENOENT' });
    expect(terraformFailureMessage(err)).toContain('needs the terraform binary on PATH and it is not there');
  });
});

describe('resolveSetupIdentity', () => {
  it('uses AWS_PROFILE and records that the owner chose it', () => {
    expect(resolveSetupIdentity({ AWS_PROFILE: 'homeledger-admin' })).toEqual({
      region: 'us-east-1',
      profile: 'homeledger-admin',
      profileFromEnvironment: true
    });
  });

  it('accepts the bridge’s own override with the same precedence loadConfig uses', () => {
    expect(resolveSetupIdentity({ HOMELEDGER_AWS_PROFILE: 'other' })).toEqual({ region: 'us-east-1', profile: 'other', profileFromEnvironment: true });
    expect(resolveSetupIdentity({ AWS_PROFILE: 'wins', HOMELEDGER_AWS_PROFILE: 'loses' }).profile).toBe('wins');
  });

  it('falls back to the stack owner’s profile and records that nobody chose it', () => {
    expect(resolveSetupIdentity({})).toEqual({ region: 'us-east-1', profile: 'homeledger-admin', profileFromEnvironment: false });
  });

  it('treats a whitespace-only AWS_PROFILE as unset, which is what an unexpanded shell variable leaves behind', () => {
    expect(resolveSetupIdentity({ AWS_PROFILE: '   ' })).toEqual({ region: 'us-east-1', profile: 'homeledger-admin', profileFromEnvironment: false });
  });

  it('carries AWS_REGION through', () => {
    expect(resolveSetupIdentity({ AWS_REGION: 'eu-west-2' }).region).toBe('eu-west-2');
  });
});

describe('renderSetup', () => {
  const values = {
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/homeledger_mcp-AbC123xyZ',
    tokenUrl: 'https://demo-homeledger.auth.us-east-1.amazoncognito.com/oauth2/token',
    clientId: '1example23clientid45'
  };

  it('prints a claude mcp add command carrying the Cognito identifiers and the entrypoint', () => {
    const text = renderSetup({ values, entrypoint: '/repo/apps/mcp-bridge/dist/index.js' });
    expect(text).toContain('claude mcp add homeledger');
    expect(text).toContain("-e HOMELEDGER_COGNITO_TOKEN_URL='https://demo-homeledger.auth.us-east-1.amazoncognito.com/oauth2/token'");
    expect(text).toContain("-e HOMELEDGER_COGNITO_CLIENT_ID='1example23clientid45'");
    expect(text).toContain('-- node /repo/apps/mcp-bridge/dist/index.js');
  });

  it('pins no runtime ARN into the generated command, which is what makes the entry survive a recreate', () => {
    // FL-039. The generated config is the only config most owners will ever
    // have, so an `-e HOMELEDGER_RUNTIME_ARN=` here is an expiry date on every
    // one of them. Asserted on the `-e ` form specifically, not on the ARN
    // string, because the ARN itself is still printed — just not passed.
    expect(renderSetup({ values, entrypoint: '/repo/x.js' })).not.toContain('-e HOMELEDGER_RUNTIME_ARN=');
  });

  it('still shows which runtime it found, and says why that is not in the command', () => {
    const text = renderSetup({ values, entrypoint: '/repo/x.js' });
    expect(text).toContain('The runtime is arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/homeledger_mcp-AbC123xyZ.');
    expect(text).toContain('the bridge finds the runtime by name every time it starts');
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

  it('pins the profile into the command so the spawned bridge cannot resolve a different one', () => {
    expect(renderSetup({ values, entrypoint: '/repo/x.js', profile: 'homeledger-admin' })).toContain("-e AWS_PROFILE='homeledger-admin'");
  });

  it('says which profile the values came from when AWS_PROFILE was not set', () => {
    const text = renderSetup({ values, entrypoint: '/repo/x.js', profile: 'homeledger-admin', profileFromEnvironment: false });
    expect(text).toContain('AWS_PROFILE was not set, so homeledger-admin was used to look these up and is written into the command above.');
  });

  it('stays quiet about the profile when the owner chose it', () => {
    expect(renderSetup({ values, entrypoint: '/repo/x.js', profile: 'homeledger-admin', profileFromEnvironment: true })).not.toContain(
      'AWS_PROFILE was not set'
    );
  });
});
