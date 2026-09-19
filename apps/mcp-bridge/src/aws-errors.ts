/**
 * The vocabulary for turning an AWS SDK failure into one sentence an owner can act on.
 *
 * Every AWS call this program makes — reading the Cognito client secret at
 * startup, and the four discovery calls behind `--print-setup` — fails in the
 * same small handful of ways, and all of them are the owner's local machine
 * rather than the deployed stack: no session, a session that expired, a profile
 * that does not exist, or an identity without the permission. Each of those has
 * exactly one remedy, so each gets exactly one sentence with the command in it.
 * They live here rather than at the call sites so that the four discovery calls
 * and the secret read cannot drift into saying different things about the same
 * condition.
 */

/** Where the helper's AWS calls are pointed, and how the profile was chosen. Every message below is written from this. */
export interface AwsIdentityContext {
  region: string;
  /** The profile actually handed to the SDK clients. Never undefined here: the bridge always resolves one. */
  profile: string;
  /** True when AWS_PROFILE or HOMELEDGER_AWS_PROFILE named it; false when the built-in default was used because neither was set. */
  profileFromEnvironment: boolean;
}

/**
 * Error names that mean "this machine has no usable AWS credentials right now".
 *
 * `CredentialsProviderError` covers both halves of the single most likely
 * failure the owner will hit — an SSO session that has expired, and one that
 * was never established — because the AWS SDK's credential chain raises the
 * same error name for both and the fix is the same sentence either way.
 * `TokenProviderError` is what the SSO token provider raises today when the
 * cached token in ~/.aws/sso/cache is past its expiry; `SSOTokenProviderFailure`
 * is the name earlier SDK releases used for it and is kept so a pinned older
 * dependency tree still lands on the sentence rather than on a stack trace. The
 * two STS names cover a session that expired between the credential resolve and
 * the API call.
 *
 * Deliberately excludes `AccessDeniedException`: a signed-in principal without
 * the permission is a permissions problem, and telling that owner to sign in
 * again would send them round a loop that cannot terminate.
 */
const EXPIRED_SESSION_ERROR_NAMES = new Set([
  'CredentialsProviderError',
  'TokenProviderError',
  'SSOTokenProviderFailure',
  'ExpiredTokenException',
  'ExpiredToken'
]);

/**
 * Message fragments for the same condition arriving under a generic error name,
 * which is what STS does when the expiry is detected service-side rather than
 * by the local token provider.
 *
 * `token is expired` and `was not found or is invalid` are the two literals
 * `@aws-sdk/token-providers` raises around a stale ~/.aws/sso/cache entry
 * (`Token is expired. ${REFRESH_MESSAGE}` and `The SSO session token associated
 * with profile=… was not found or is invalid. ${REFRESH_MESSAGE}`); both are
 * matched on the message because the name they arrive under has changed once
 * already across SDK releases.
 */
const EXPIRED_SESSION_MESSAGE_MARKERS = [
  'sso session',
  'could not be refreshed',
  'security token included in the request is expired',
  'token has expired',
  'token is expired',
  'was not found or is invalid'
];

/**
 * The profile named does not exist in ~/.aws/config at all.
 *
 * Anchored on the literal shapes the SDK raises — `Profile <name> was not
 * found.` from the SSO provider and `Profile <name> could not be found or
 * parsed in shared credentials file.` from the ini provider — rather than on a
 * bare "not found", because the token provider's expiry message also contains
 * the words "was not found" (`The SSO session token associated with profile=…
 * was not found or is invalid`) and that one is an expired session, not a
 * missing profile. Getting those two the wrong way round sends the owner to
 * create a profile they already have, or to sign in to one that does not exist.
 */
const MISSING_PROFILE_PATTERN = /^profile\s+\S+\s+(was not found|could not be found)/i;

export function isExpiredSessionError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  if (typeof name === 'string' && EXPIRED_SESSION_ERROR_NAMES.has(name)) return true;
  if (typeof message !== 'string') return false;
  const lower = message.toLowerCase();
  return EXPIRED_SESSION_MESSAGE_MARKERS.some(marker => lower.includes(marker));
}

export function isMissingProfileError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { message } = err as { message?: unknown };
  return typeof message === 'string' && MISSING_PROFILE_PATTERN.test(message.trim());
}

/**
 * The one line the owner needs when the thing that broke is the SSO session.
 *
 * This is the single most likely failure in the whole program, and it is the
 * only one whose remedy is one command — so it gets one sentence, with the
 * command in it, and no stack trace. The README quotes it verbatim.
 */
export function expiredSessionMessage(profile: string | undefined): string {
  const flag = profile ? ` --profile ${profile}` : '';
  return `Your AWS SSO session expired, run \`aws login${flag}\``;
}

/**
 * Appended when the profile was not chosen by the owner but defaulted to.
 *
 * Without it, an owner whose session lives on some other profile reads "run
 * `aws login --profile homeledger-admin`", runs it, and is no better off,
 * because the profile the helper picked was never the one they meant. Naming
 * the choice is what makes the next step obvious.
 */
export function defaultedProfileNote(profile: string): string {
  return `AWS_PROFILE is not set, so this used the default profile ${profile}. If your session lives on a different profile, set AWS_PROFILE to it and run this again.`;
}

export function missingProfileMessage(identity: AwsIdentityContext): string {
  const { profile, profileFromEnvironment } = identity;
  if (profileFromEnvironment)
    return `AWS_PROFILE is set to ${profile}, and no profile of that name exists in ~/.aws/config. Set AWS_PROFILE to one that does — \`aws configure list-profiles\` lists them — or create it with \`aws configure sso\`.`;
  return `AWS_PROFILE is not set, so this used the default profile ${profile}, and no profile of that name exists in ~/.aws/config. Set AWS_PROFILE to the profile holding your session, or create ${profile} with \`aws configure sso\`.`;
}

/** True for every failure that is about this machine's credentials rather than about the deployed stack. */
export function isCredentialFailure(err: unknown): boolean {
  return isMissingProfileError(err) || isExpiredSessionError(err);
}

/** What the caller was doing, for the two messages that have to name a permission. */
export interface AwsOperationContext extends AwsIdentityContext {
  /** IAM-style action, e.g. `bedrock-agentcore:ListAgentRuntimes`. Printed verbatim into the permissions message. */
  action: string;
  /**
   * The profile names defined on this machine, when the caller has looked.
   *
   * Needed because the SDK's own error does not distinguish "this profile has
   * no live session" from "there is no such profile": constructing a client
   * with `profile: 'does-not-exist'` and empty shared config files raises the
   * flat `CredentialsProviderError: Could not load credentials from any
   * providers`, with the ini provider's specific complaint swallowed by the
   * node chain. Undefined means nobody looked, or looking failed, and the
   * message then falls back to what it would have said regardless.
   */
  knownProfiles?: ReadonlySet<string> | undefined;
}

const AUTHORIZATION_ERROR_NAMES = new Set([
  'AccessDeniedException',
  'AccessDenied',
  'NotAuthorizedException',
  'UnauthorizedOperation',
  'UnrecognizedClientException'
]);

/**
 * Maps one AWS SDK failure onto the sentence for it.
 *
 * Order is load-bearing, twice over. A missing profile is checked before an
 * expired session because the SDK raises both under `CredentialsProviderError`,
 * and the expired-session branch matches on that name alone — so putting it
 * first would tell an owner with a typo'd AWS_PROFILE to sign in to a profile
 * that does not exist. And inside the expired branch, `knownProfiles` is
 * consulted before the sentence is composed, because the flat "Could not load
 * credentials from any providers" that the node chain actually raises reaches
 * this function looking exactly like a lapsed session and is, for a profile
 * that was never defined, nothing of the sort.
 */
export function awsFailureMessage(err: unknown, context: AwsOperationContext): string {
  if (isMissingProfileError(err)) return missingProfileMessage(context);
  if (isExpiredSessionError(err)) {
    if (context.knownProfiles && !context.knownProfiles.has(context.profile)) return missingProfileMessage(context);
    const sentence = expiredSessionMessage(context.profile);
    return context.profileFromEnvironment ? sentence : `${sentence}\n${defaultedProfileNote(context.profile)}`;
  }
  const name = typeof (err as { name?: unknown })?.name === 'string' ? (err as { name: string }).name : 'Error';
  if (AUTHORIZATION_ERROR_NAMES.has(name))
    return `The AWS identity from profile ${context.profile} is not allowed to call ${context.action} in ${context.region}. Grant it that permission, or fill the values into the \`claude mcp add\` command by hand.`;
  const detail = err instanceof Error ? err.message : String(err);
  return `${context.action} failed in ${context.region} with profile ${context.profile}: ${detail}`;
}
