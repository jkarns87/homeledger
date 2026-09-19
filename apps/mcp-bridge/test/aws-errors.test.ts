import { describe, expect, it } from 'vitest';
import type { AwsIdentityContext } from '../src/aws-errors.js';
import { awsFailureMessage, expiredSessionMessage, isExpiredSessionError, isMissingProfileError, missingProfileMessage } from '../src/aws-errors.js';

const NAMED: AwsIdentityContext = { region: 'us-east-1', profile: 'homeledger-admin', profileFromEnvironment: true };
const DEFAULTED: AwsIdentityContext = { region: 'us-east-1', profile: 'homeledger-admin', profileFromEnvironment: false };

function awsError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('isMissingProfileError', () => {
  it('recognises the SSO provider’s wording', () => {
    expect(isMissingProfileError(awsError('CredentialsProviderError', 'Profile typo-admin was not found.'))).toBe(true);
  });

  it('recognises the shared-credentials provider’s wording', () => {
    expect(isMissingProfileError(awsError('CredentialsProviderError', 'Profile typo-admin could not be found or parsed in shared credentials file.'))).toBe(
      true
    );
  });

  it('does NOT claim a stale SSO token is a missing profile', () => {
    // This is the assertion the whole regex shape exists for. The token
    // provider's expiry message contains the words "was not found", and a bare
    // /not found/ match here would send an owner with a perfectly good profile
    // off to create one.
    const expiry = awsError(
      'TokenProviderError',
      "The SSO session token associated with profile=homeledger-admin was not found or is invalid. To refresh this SSO session run 'aws sso login' with the corresponding profile."
    );
    expect(isMissingProfileError(expiry)).toBe(false);
    expect(isExpiredSessionError(expiry)).toBe(true);
  });

  it('does not fire on an unrelated failure that happens to mention a profile', () => {
    expect(isMissingProfileError(awsError('ValidationException', 'The profile parameter is invalid'))).toBe(false);
  });
});

describe('isExpiredSessionError', () => {
  it('recognises the token provider under the name the current SDK raises', () => {
    expect(
      isExpiredSessionError(awsError('TokenProviderError', "Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile."))
    ).toBe(true);
  });

  it('still recognises the name older SDK releases used', () => {
    expect(isExpiredSessionError(awsError('SSOTokenProviderFailure', 'The SSO session has expired or is otherwise invalid'))).toBe(true);
  });

  it('does not treat a permissions failure as a session failure', () => {
    // Telling a signed-in owner without the IAM permission to sign in again is
    // a loop that cannot terminate.
    expect(isExpiredSessionError(awsError('AccessDeniedException', 'User is not authorized to perform cognito-idp:ListUserPools'))).toBe(false);
  });
});

describe('awsFailureMessage', () => {
  const action = 'bedrock-agentcore:ListAgentRuntimes';

  it('checks for a missing profile before checking for an expired session', () => {
    // Both arrive as CredentialsProviderError. Reversing the order inside
    // awsFailureMessage makes this fail, which is what makes the order a
    // decision rather than an accident.
    const message = awsFailureMessage(awsError('CredentialsProviderError', 'Profile typo-admin was not found.'), { ...NAMED, profile: 'typo-admin', action });
    expect(message).toBe(missingProfileMessage({ region: 'us-east-1', profile: 'typo-admin', profileFromEnvironment: true }));
    expect(message).not.toContain('aws login');
  });

  it('gives the expired session exactly the one line the README quotes', () => {
    const message = awsFailureMessage(awsError('CredentialsProviderError', 'Profile homeledger-admin could not be refreshed'), { ...NAMED, action });
    expect(message).toBe('Your AWS SSO session expired, run `aws login --profile homeledger-admin`');
    expect(message.split('\n')).toHaveLength(1);
  });

  it('adds the unset-AWS_PROFILE line only when the profile was defaulted to', () => {
    const defaulted = awsFailureMessage(awsError('CredentialsProviderError', 'Could not load credentials from any providers'), { ...DEFAULTED, action });
    expect(defaulted).toContain(expiredSessionMessage('homeledger-admin'));
    expect(defaulted).toContain('AWS_PROFILE is not set, so this used the default profile homeledger-admin.');
    expect(defaulted).toContain('set AWS_PROFILE to it and run this again');
  });

  it('tells an owner with no AWS_PROFILE and no such profile to set one, naming both', () => {
    const message = awsFailureMessage(
      awsError('CredentialsProviderError', 'Profile homeledger-admin could not be found or parsed in shared credentials file.'),
      { ...DEFAULTED, action }
    );
    expect(message).toContain('AWS_PROFILE is not set');
    expect(message).toContain('homeledger-admin');
    expect(message).toContain('aws configure sso');
  });

  it('reads the flat "any providers" error as a missing profile when the profile list says so', () => {
    // The SDK's real error for a nonexistent profile, measured against 3.1136.0.
    // Nothing in the error itself distinguishes it from a lapsed session.
    const message = awsFailureMessage(awsError('CredentialsProviderError', 'Could not load credentials from any providers'), {
      ...NAMED,
      profile: 'typo-admin',
      action,
      knownProfiles: new Set(['default', 'homeledger-admin'])
    });
    expect(message).toBe(missingProfileMessage({ region: 'us-east-1', profile: 'typo-admin', profileFromEnvironment: true }));
  });

  it('reads the same error as a lapsed session when the profile is in the list', () => {
    // The negative half. Without it, the profile check could swallow every
    // expired-session case and the test above would still pass.
    const message = awsFailureMessage(awsError('CredentialsProviderError', 'Could not load credentials from any providers'), {
      ...NAMED,
      action,
      knownProfiles: new Set(['default', 'homeledger-admin'])
    });
    expect(message).toBe('Your AWS SSO session expired, run `aws login --profile homeledger-admin`');
  });

  it('falls back to the session sentence when nobody could read the profile list', () => {
    const message = awsFailureMessage(awsError('CredentialsProviderError', 'Could not load credentials from any providers'), {
      ...NAMED,
      profile: 'typo-admin',
      action,
      knownProfiles: undefined
    });
    expect(message).toBe('Your AWS SSO session expired, run `aws login --profile typo-admin`');
  });

  it('names the action and the profile on a permissions failure', () => {
    expect(awsFailureMessage(awsError('AccessDeniedException', 'nope'), { ...NAMED, action })).toBe(
      'The AWS identity from profile homeledger-admin is not allowed to call bedrock-agentcore:ListAgentRuntimes in us-east-1. Grant it that permission, or fill the values into the `claude mcp add` command by hand.'
    );
  });

  it('keeps the detail of a failure it has no sentence for', () => {
    expect(awsFailureMessage(awsError('ThrottlingException', 'Rate exceeded'), { ...NAMED, action })).toBe(
      'bedrock-agentcore:ListAgentRuntimes failed in us-east-1 with profile homeledger-admin: Rate exceeded'
    );
  });

  it('survives something thrown that is not an Error at all', () => {
    expect(awsFailureMessage('a string', { ...NAMED, action })).toContain('a string');
  });
});
