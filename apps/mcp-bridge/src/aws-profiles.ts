import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Reads which profiles actually exist, because the SDK will not say.
 *
 * Measured against `@aws-sdk/client-bedrock-agentcore-control` 3.1136.0 on a
 * client constructed with `profile: 'does-not-exist'` and both shared config
 * files empty: the failure is `CredentialsProviderError: Could not load
 * credentials from any providers`. The ini provider's own "Profile … was not
 * found." is swallowed by the node chain, which reports only that every link
 * declined. So the one thing the owner most needs to be told apart — "your
 * session lapsed" from "that profile does not exist" — is not in the error at
 * all, and the only way to tell is to look.
 *
 * Consulted lazily, and only after a call has already failed on credentials:
 * nothing here runs on a working setup.
 */

/** Honours the two overrides the AWS CLI and SDKs both respect, so a test (or a container) can point them somewhere else. */
export function sharedConfigPaths(env: NodeJS.ProcessEnv): { config: string; credentials: string } {
  const home = env.HOME?.trim() || homedir();
  return {
    config: env.AWS_CONFIG_FILE?.trim() || join(home, '.aws', 'config'),
    credentials: env.AWS_SHARED_CREDENTIALS_FILE?.trim() || join(home, '.aws', 'credentials')
  };
}

/** Deliberately linear: one greedy run of non-`]` characters, trimmed in code rather than by a second quantifier. */
const SECTION_HEADER = /^\[([^\]]*)\]/;

/**
 * Pulls profile names out of the two shared files.
 *
 * The two spell the same thing differently and that is not a quirk worth
 * abstracting over: `~/.aws/config` writes `[profile foo]` (with a bare
 * `[default]` for the default one) while `~/.aws/credentials` writes `[foo]`.
 * `[sso-session …]` and `[services …]` live in the config file too and are not
 * profiles; counting them would let a typo'd AWS_PROFILE that happens to match
 * an sso-session name pass this check and fail later with the message this
 * check exists to replace.
 */
export function parseProfileNames(configText: string, credentialsText: string): Set<string> {
  const names = new Set<string>();
  for (const raw of configText.split('\n')) {
    const header = sectionOf(raw);
    if (!header) continue;
    if (header === 'default') names.add('default');
    else if (header.startsWith('profile ')) names.add(header.slice('profile '.length).trim());
  }
  for (const raw of credentialsText.split('\n')) {
    const header = sectionOf(raw);
    if (header) names.add(header);
  }
  names.delete('');
  return names;
}

function sectionOf(line: string): string | undefined {
  const trimmed = line.trim();
  // A commented-out section is not a section. Both markers are what the AWS
  // CLI itself accepts, and an owner who has commented a profile out has, for
  // this purpose, no such profile.
  if (trimmed.startsWith('#') || trimmed.startsWith(';')) return undefined;
  return SECTION_HEADER.exec(trimmed)?.[1]?.trim();
}

/**
 * Returns the profile names on this machine, or `undefined` when that cannot be
 * established.
 *
 * A file that is not there is an answer — no profiles are defined in it — and a
 * file that cannot be read for any other reason is not, so the caller is told
 * nothing rather than told something wrong. `undefined` makes every caller fall
 * back to the message it would have printed anyway.
 */
export async function readKnownProfiles(env: NodeJS.ProcessEnv): Promise<ReadonlySet<string> | undefined> {
  const paths = sharedConfigPaths(env);
  const [config, credentials] = await Promise.all([readOptional(paths.config), readOptional(paths.credentials)]);
  if (config === undefined || credentials === undefined) return undefined;
  return parseProfileNames(config, credentials);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    // "Not there" is an answer — it is the ordinary state of a machine that has
    // never run `aws configure`, and it means no profiles are defined. Anything
    // else (EISDIR from a mangled AWS_CONFIG_FILE, EACCES from an unreadable
    // home) is not an answer, and reporting "no such profile" off the back of
    // it would be a confident lie about something never actually read.
    return (err as { code?: unknown }).code === 'ENOENT' ? '' : undefined;
  }
}
