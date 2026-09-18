import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeConfig } from '../src/config.js';
import { REDACTION, redact, resetProtectedSecrets } from '../src/redact.js';
import { SecretError, expiredSessionMessage, isExpiredSessionError, resolveClientSecret } from '../src/secret.js';

afterEach(() => {
  resetProtectedSecrets();
});

const CONFIG: BridgeConfig = {
  mcpUrl: 'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/x/invocations?qualifier=DEFAULT',
  tokenUrl: 'https://token.invalid/oauth2/token',
  clientId: 'client-id',
  scope: 'homeledger/mcp',
  secretId: 'demo-homeledger/cognito/client-secret',
  clientSecretFromEnv: undefined,
  region: 'us-east-1',
  awsProfile: 'homeledger-admin',
  agentCoreSessionId: undefined,
  standaloneStream: true
};

function awsError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('isExpiredSessionError', () => {
  it('recognises an SSO session the credential chain could not refresh', () => {
    expect(isExpiredSessionError(awsError('CredentialsProviderError', 'Profile homeledger-admin could not be refreshed'))).toBe(true);
  });

  it('recognises the token provider’s own expiry error', () => {
    expect(isExpiredSessionError(awsError('SSOTokenProviderFailure', 'The SSO session has expired or is otherwise invalid'))).toBe(true);
  });

  it('recognises an STS expiry that arrives under a generic name', () => {
    expect(isExpiredSessionError(awsError('ServiceException', 'The security token included in the request is expired'))).toBe(true);
  });

  it('does not treat a permissions failure as an expired session, which would send the owner round a loop', () => {
    // The owner is signed in; telling them to sign in again cannot help, and
    // would hide the real fix (grant secretsmanager:GetSecretValue).
    expect(
      isExpiredSessionError(
        awsError('AccessDeniedException', 'User: arn:aws:sts::1111:assumed-role/x is not authorized to perform: secretsmanager:GetSecretValue')
      )
    ).toBe(false);
  });

  it('does not treat a missing secret as an expired session', () => {
    expect(isExpiredSessionError(awsError('ResourceNotFoundException', "Secrets Manager can't find the specified secret."))).toBe(false);
  });

  it('is total over non-errors', () => {
    expect(isExpiredSessionError(undefined)).toBe(false);
    expect(isExpiredSessionError('a string')).toBe(false);
    expect(isExpiredSessionError(null)).toBe(false);
  });
});

describe('expiredSessionMessage', () => {
  it('is one sentence carrying the command that fixes it', () => {
    expect(expiredSessionMessage('homeledger-admin')).toBe('Your AWS SSO session expired, run `aws login --profile homeledger-admin`');
  });

  it('omits the flag when no profile is in play', () => {
    expect(expiredSessionMessage(undefined)).toBe('Your AWS SSO session expired, run `aws login`');
  });
});

describe('resolveClientSecret', () => {
  it('uses the environment variable when one is set, without calling Secrets Manager', async () => {
    let called = false;
    const secret = await resolveClientSecret({ ...CONFIG, clientSecretFromEnv: 'secret-from-environment' }, async () => {
      called = true;
      return async () => 'secret-from-secrets-manager';
    });
    expect(secret).toBe('secret-from-environment');
    expect(called).toBe(false);
  });

  it('reads the configured secret id from Secrets Manager by default', async () => {
    const asked: string[] = [];
    const secret = await resolveClientSecret(CONFIG, async () => async (id: string) => {
      asked.push(id);
      return 'secret-from-secrets-manager';
    });
    expect(asked).toEqual(['demo-homeledger/cognito/client-secret']);
    expect(secret).toBe('secret-from-secrets-manager');
  });

  it('registers whatever it resolved for redaction, from either source', async () => {
    await resolveClientSecret(CONFIG, async () => async () => 'secret-from-secrets-manager');
    expect(redact('the value is secret-from-secrets-manager')).toBe(`the value is ${REDACTION}`);
    resetProtectedSecrets();
    await resolveClientSecret({ ...CONFIG, clientSecretFromEnv: 'secret-from-environment' }, async () => async () => 'unused');
    expect(redact('the value is secret-from-environment')).toBe(`the value is ${REDACTION}`);
  });

  it('answers an expired SSO session with the one line that fixes it', async () => {
    const err = await resolveClientSecret(CONFIG, async () => async () => {
      throw awsError('CredentialsProviderError', 'Profile homeledger-admin could not be refreshed');
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretError);
    expect((err as Error).message).toBe('Your AWS SSO session expired, run `aws login --profile homeledger-admin`');
  });

  it('answers a permissions failure by naming the profile, the secret, and the missing action', async () => {
    const err = await resolveClientSecret(CONFIG, async () => async () => {
      throw awsError('AccessDeniedException', 'not authorized');
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('homeledger-admin');
    expect((err as Error).message).toContain('demo-homeledger/cognito/client-secret');
    expect((err as Error).message).toContain('secretsmanager:GetSecretValue');
  });

  it('answers a missing secret by naming the secret and the region rather than the SSO command', async () => {
    const err = await resolveClientSecret(CONFIG, async () => async () => {
      throw awsError('ResourceNotFoundException', "Secrets Manager can't find the specified secret.");
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('No secret named demo-homeledger/cognito/client-secret exists in us-east-1');
    expect((err as Error).message).not.toContain('aws login');
  });

  it('reports an unclassified failure with its own detail rather than swallowing it', async () => {
    const err = await resolveClientSecret(CONFIG, async () => async () => {
      throw awsError('ThrottlingException', 'Rate exceeded');
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('Rate exceeded');
  });

  it('treats a secret with no string value as a failure rather than returning an empty credential', async () => {
    const err = await resolveClientSecret(CONFIG, async () => async () => undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretError);
    expect((err as Error).message).toContain('has no string value');
  });
});
