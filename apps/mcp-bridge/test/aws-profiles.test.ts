import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseProfileNames, readKnownProfiles, sharedConfigPaths } from '../src/aws-profiles.js';

const CONFIG = `
[default]
region = us-east-1

[profile homeledger-admin]
sso_session = homeledger
region = us-east-1

[sso-session homeledger]
sso_start_url = https://example.awsapps.com/start

[services my-services]
dynamodb =

# [profile commented-out]
; [profile also-commented-out]
`;

const CREDENTIALS = `
[legacy-keys]
aws_access_key_id = AKIAEXAMPLE
`;

describe('parseProfileNames', () => {
  it('reads the config file’s two spellings and nothing else', () => {
    expect([...parseProfileNames(CONFIG, '')].sort()).toEqual(['default', 'homeledger-admin']);
  });

  it('does not mistake an sso-session or a services block for a profile, even one named after the profile', () => {
    // These live in the same file with the same bracket syntax, and an
    // sso-session is very often named after the profile that uses it. Counting
    // them would let AWS_PROFILE=homeledger-admin pass a check whose entire
    // purpose is to catch exactly that, on a machine with no such profile.
    const names = parseProfileNames('[sso-session homeledger-admin]\nsso_start_url = https://example.awsapps.com/start\n\n[services homeledger-admin]\n', '');
    expect([...names]).toEqual([]);
  });

  it('does not count a commented-out profile as one that exists', () => {
    const names = parseProfileNames(CONFIG, '');
    expect(names.has('commented-out')).toBe(false);
    expect(names.has('also-commented-out')).toBe(false);
  });

  it('reads the credentials file’s bare section names', () => {
    expect([...parseProfileNames('', CREDENTIALS)]).toEqual(['legacy-keys']);
  });

  it('tolerates whitespace inside the brackets, which the AWS CLI accepts', () => {
    expect([...parseProfileNames('[ profile  spaced ]\n', '')]).toEqual(['spaced']);
  });

  it('returns an empty set for files that hold nothing', () => {
    expect([...parseProfileNames('', '')]).toEqual([]);
  });
});

describe('sharedConfigPaths', () => {
  it('honours the two overrides the AWS CLI respects', () => {
    expect(sharedConfigPaths({ AWS_CONFIG_FILE: '/x/config', AWS_SHARED_CREDENTIALS_FILE: '/x/creds' })).toEqual({
      config: '/x/config',
      credentials: '/x/creds'
    });
  });

  it('falls back to ~/.aws for each independently', () => {
    const paths = sharedConfigPaths({ HOME: '/home/joey' });
    expect(paths.config).toBe('/home/joey/.aws/config');
    expect(paths.credentials).toBe('/home/joey/.aws/credentials');
  });
});

describe('readKnownProfiles', () => {
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'homeledger-profiles-'));
    await writeFile(join(dir, 'config'), CONFIG, 'utf8');
    await writeFile(join(dir, 'credentials'), CREDENTIALS, 'utf8');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads both files off disk', async () => {
    const names = await readKnownProfiles({ AWS_CONFIG_FILE: join(dir, 'config'), AWS_SHARED_CREDENTIALS_FILE: join(dir, 'credentials') });
    expect([...(names ?? [])].sort()).toEqual(['default', 'homeledger-admin', 'legacy-keys']);
  });

  it('treats a file that is not there as a file with no profiles in it', async () => {
    // A machine that has never run `aws configure` genuinely has no profiles,
    // and saying so is more useful than declining to answer.
    const names = await readKnownProfiles({ AWS_CONFIG_FILE: join(dir, 'nope'), AWS_SHARED_CREDENTIALS_FILE: join(dir, 'also-nope') });
    expect(names).toBeDefined();
    expect([...(names ?? [])]).toEqual([]);
  });

  it('reads one file even when the other is absent', async () => {
    const names = await readKnownProfiles({ AWS_CONFIG_FILE: join(dir, 'config'), AWS_SHARED_CREDENTIALS_FILE: join(dir, 'nope') });
    expect([...(names ?? [])].sort()).toEqual(['default', 'homeledger-admin']);
  });

  it('declines to answer rather than answering wrongly when a path is a directory', async () => {
    // EISDIR is not "no profiles", it is "this override is wrong", and claiming
    // the profile does not exist off the back of it would be a confident lie.
    const names = await readKnownProfiles({ AWS_CONFIG_FILE: dir, AWS_SHARED_CREDENTIALS_FILE: join(dir, 'credentials') });
    expect(names).toBeUndefined();
  });
});
