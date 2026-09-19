import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AwsIdentityContext } from '../src/aws-errors.js';
import type { AgentRuntimeRow, DiscoveryApi, UserPoolClientRow, UserPoolDomains, UserPoolRow } from '../src/discover.js';
import {
  DiscoveryError,
  FORBIDDEN_DISCOVERY_CALLS,
  MAX_DISCOVERY_PAGES,
  RESOURCE_NAMES,
  collectPages,
  discoverSetupValues,
  selectUniqueValue,
  tokenUrlFromDomains
} from '../src/discover.js';
import type { SetupValues } from '../src/setup.js';
import { renderSetup } from '../src/setup.js';

const IDENTITY: AwsIdentityContext = { region: 'us-east-1', profile: 'homeledger-admin', profileFromEnvironment: true };

const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/demo_homeledger_mcp-AbC123xyZ';
const OTHER_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/demo_homeledger_mcp-ZzZ999aaa';
const USER_POOL_ID = 'us-east-1_Ab1Cd2Ef3';
const CLIENT_ID = '1example23clientid45';
const DOMAIN_PREFIX = 'demo-homeledger-111122223333';

function awsError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

interface ApiOverrides {
  runtimes?: AgentRuntimeRow[];
  pools?: UserPoolRow[];
  clients?: UserPoolClientRow[];
  domains?: UserPoolDomains;
  failOn?: { call: keyof DiscoveryApi; error: unknown };
}

/** Records what was asked for, so a test can prove which calls did and did not happen. */
interface RecordingApi extends DiscoveryApi {
  calls: string[];
}

function fakeApi(overrides: ApiOverrides = {}): RecordingApi {
  const calls: string[] = [];
  const guard = (name: keyof DiscoveryApi): void => {
    calls.push(name);
    if (overrides.failOn?.call === name) throw overrides.failOn.error;
  };
  return {
    calls,
    listAgentRuntimes: async () => {
      guard('listAgentRuntimes');
      return overrides.runtimes ?? [{ agentRuntimeName: RESOURCE_NAMES.runtime, agentRuntimeArn: RUNTIME_ARN }];
    },
    listUserPools: async () => {
      guard('listUserPools');
      return overrides.pools ?? [{ Id: USER_POOL_ID, Name: RESOURCE_NAMES.userPool }];
    },
    listUserPoolClients: async userPoolId => {
      calls.push(`listUserPoolClients:${userPoolId}`);
      if (overrides.failOn?.call === 'listUserPoolClients') throw overrides.failOn.error;
      return overrides.clients ?? [{ ClientId: CLIENT_ID, ClientName: RESOURCE_NAMES.appClient }];
    },
    describeUserPoolDomains: async userPoolId => {
      calls.push(`describeUserPoolDomains:${userPoolId}`);
      if (overrides.failOn?.call === 'describeUserPoolDomains') throw overrides.failOn.error;
      return overrides.domains ?? { Domain: DOMAIN_PREFIX };
    }
  };
}

/**
 * What `~/.aws/config` is taken to hold, injected on every call.
 *
 * Never left to the default, which reads the real machine: a test whose result
 * depends on whether the person running it happens to have a homeledger-admin
 * profile is not a test.
 */
const KNOWN_PROFILES: ReadonlySet<string> = new Set(['default', 'homeledger-admin']);

function discover(api: DiscoveryApi, identity: AwsIdentityContext = IDENTITY, profiles: ReadonlySet<string> = KNOWN_PROFILES): Promise<SetupValues> {
  return discoverSetupValues(api, identity, { readProfiles: async () => profiles });
}

describe('the resource names discovery matches on', () => {
  it('are the ones infra/live/demo/platform/main.tf composes', () => {
    // Written as literals rather than re-derived from a prefix, so that a typo
    // in the composition cannot agree with itself. `demo-homeledger` is
    // `${var.env}-homeledger` with env pinned to "demo" by its own validation;
    // the runtime spelling differs because local.runtime_name replaces hyphens.
    expect(RESOURCE_NAMES).toEqual({ runtime: 'demo_homeledger_mcp', userPool: 'demo-homeledger-mcp', appClient: 'homeledger-simulator' });
  });
});

describe('selectUniqueValue', () => {
  const base = {
    wanted: RESOURCE_NAMES.runtime,
    nameOf: (row: AgentRuntimeRow) => row.agentRuntimeName,
    valueOf: (row: AgentRuntimeRow) => row.agentRuntimeArn,
    resource: 'AgentCore runtime',
    valueLabel: 'ARN',
    scope: 'us-east-1 (profile homeledger-admin)',
    absentHint: 'The demo stack may not be deployed.',
    ambiguousHint: 'Pick one.'
  };

  it('matches by name rather than by position', () => {
    // The decoy is deliberately first. This is the assertion the old `[0]`
    // shape would fail, and it is the whole reason this function exists.
    const rows: AgentRuntimeRow[] = [
      { agentRuntimeName: 'someone_elses_runtime', agentRuntimeArn: OTHER_RUNTIME_ARN },
      { agentRuntimeName: RESOURCE_NAMES.runtime, agentRuntimeArn: RUNTIME_ARN }
    ];
    expect(selectUniqueValue({ ...base, rows })).toBe(RUNTIME_ARN);
  });

  it('matches the name exactly, so a differently-cased near-miss is not the answer', () => {
    const rows: AgentRuntimeRow[] = [{ agentRuntimeName: 'Demo_HomeLedger_MCP', agentRuntimeArn: OTHER_RUNTIME_ARN }];
    expect(() => selectUniqueValue({ ...base, rows })).toThrow(DiscoveryError);
  });

  it('refuses to guess when two resources share the name and differ in value', () => {
    const rows: AgentRuntimeRow[] = [
      { agentRuntimeName: RESOURCE_NAMES.runtime, agentRuntimeArn: RUNTIME_ARN },
      { agentRuntimeName: RESOURCE_NAMES.runtime, agentRuntimeArn: OTHER_RUNTIME_ARN }
    ];
    let thrown: unknown;
    try {
      selectUniqueValue({ ...base, rows });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DiscoveryError);
    const message = (thrown as Error).message;
    expect(message).toContain('Found 2 AgentCore runtimes named demo_homeledger_mcp');
    // Both candidates are named, because the owner has to be able to tell which
    // one they meant without going to the console for the list.
    expect(message).toContain(RUNTIME_ARN);
    expect(message).toContain(OTHER_RUNTIME_ARN);
    expect(message).toContain('Pick one.');
  });

  it('treats one resource listed twice as one answer, not as an ambiguity', () => {
    // ListAgentRuntimes rows carry a version and an AgentCore runtime ARN does
    // not, so the same runtime can legitimately appear twice. Counting rows
    // rather than distinct values would fail a setup with one right answer.
    const rows: AgentRuntimeRow[] = [
      { agentRuntimeName: RESOURCE_NAMES.runtime, agentRuntimeArn: RUNTIME_ARN },
      { agentRuntimeName: RESOURCE_NAMES.runtime, agentRuntimeArn: RUNTIME_ARN }
    ];
    expect(selectUniqueValue({ ...base, rows })).toBe(RUNTIME_ARN);
  });

  it('says what it did see when nothing matched', () => {
    const rows: AgentRuntimeRow[] = [
      { agentRuntimeName: 'zeta_runtime', agentRuntimeArn: 'arn:zeta' },
      { agentRuntimeName: 'alpha_runtime', agentRuntimeArn: 'arn:alpha' }
    ];
    expect(() => selectUniqueValue({ ...base, rows })).toThrow(
      'No AgentCore runtime named demo_homeledger_mcp in us-east-1 (profile homeledger-admin). The demo stack may not be deployed. Names present: alpha_runtime, zeta_runtime.'
    );
  });

  it('says the account holds none at all when the list is empty', () => {
    expect(() => selectUniqueValue({ ...base, rows: [] })).toThrow('No AgentCore runtime of any name is there either.');
  });

  it('separates "matched but has no ARN" from "did not match"', () => {
    const rows: AgentRuntimeRow[] = [{ agentRuntimeName: RESOURCE_NAMES.runtime, agentRuntimeArn: '   ' }];
    expect(() => selectUniqueValue({ ...base, rows })).toThrow(
      'The AgentCore runtime named demo_homeledger_mcp in us-east-1 (profile homeledger-admin) has no ARN.'
    );
  });
});

describe('tokenUrlFromDomains', () => {
  it('composes the prefix form byte for byte as infra/modules/cognito-m2m/outputs.tf does', () => {
    expect(tokenUrlFromDomains({ Domain: DOMAIN_PREFIX }, 'us-east-1', RESOURCE_NAMES.userPool, 'scope')).toBe(
      'https://demo-homeledger-111122223333.auth.us-east-1.amazoncognito.com/oauth2/token'
    );
  });

  it('carries the region through rather than pinning us-east-1', () => {
    expect(tokenUrlFromDomains({ Domain: DOMAIN_PREFIX }, 'eu-west-2', RESOURCE_NAMES.userPool, 'scope')).toBe(
      'https://demo-homeledger-111122223333.auth.eu-west-2.amazoncognito.com/oauth2/token'
    );
  });

  it('uses a custom domain as the host it already is', () => {
    // A Cognito domain prefix cannot contain a dot, so the dot is an exact test
    // for "already fully qualified" and appending .auth.<region>… to one would
    // compose a host that resolves to nothing.
    expect(tokenUrlFromDomains({ CustomDomain: 'auth.homeledger.example' }, 'us-east-1', RESOURCE_NAMES.userPool, 'scope')).toBe(
      'https://auth.homeledger.example/oauth2/token'
    );
  });

  it('prefers the prefix domain when a pool has both', () => {
    expect(tokenUrlFromDomains({ Domain: DOMAIN_PREFIX, CustomDomain: 'auth.homeledger.example' }, 'us-east-1', RESOURCE_NAMES.userPool, 'scope')).toContain(
      'demo-homeledger-111122223333.auth.us-east-1.amazoncognito.com'
    );
  });

  it('fails with a sentence when the pool has no domain at all', () => {
    expect(() => tokenUrlFromDomains({}, 'us-east-1', RESOURCE_NAMES.userPool, 'us-east-1 (profile homeledger-admin)')).toThrow(
      /has no hosted domain.*half applied/s
    );
  });
});

describe('collectPages', () => {
  it('returns a single page as it is', async () => {
    const items = await collectPages(async () => ({ items: [1, 2], nextToken: undefined }), 'List');
    expect(items).toEqual([1, 2]);
  });

  it('forwards the token and concatenates every page in order', async () => {
    const seen: (string | undefined)[] = [];
    const items = await collectPages(async token => {
      seen.push(token);
      if (token === undefined) return { items: ['a'], nextToken: 't1' };
      if (token === 't1') return { items: ['b'], nextToken: 't2' };
      return { items: ['c'], nextToken: undefined };
    }, 'List');
    expect(items).toEqual(['a', 'b', 'c']);
    expect(seen).toEqual([undefined, 't1', 't2']);
  });

  it('stops rather than spinning when a service keeps handing back a token', async () => {
    let pages = 0;
    await expect(
      collectPages(
        async () => {
          pages += 1;
          return { items: ['x'], nextToken: 'always' };
        },
        'ListUserPools',
        3
      )
    ).rejects.toThrow('ListUserPools did not stop paginating after 3 pages');
    expect(pages).toBe(3);
  }, 1000);

  it('defaults to a bound well past anything this account holds', () => {
    expect(MAX_DISCOVERY_PAGES).toBe(20);
  });
});

describe('discoverSetupValues', () => {
  it('returns the three identifiers the claude mcp add command carries', async () => {
    const values = await discover(fakeApi(), IDENTITY);
    expect(values).toEqual({
      runtimeArn: RUNTIME_ARN,
      tokenUrl: 'https://demo-homeledger-111122223333.auth.us-east-1.amazoncognito.com/oauth2/token',
      clientId: CLIENT_ID
    });
  });

  it('feeds the pool it discovered into the client and domain reads rather than re-deriving one', async () => {
    const api = fakeApi();
    await discover(api, IDENTITY);
    expect(api.calls).toEqual(['listAgentRuntimes', 'listUserPools', `listUserPoolClients:${USER_POOL_ID}`, `describeUserPoolDomains:${USER_POOL_ID}`]);
  });

  it('picks the right resources when the account holds decoys of every kind', async () => {
    const api = fakeApi({
      runtimes: [
        { agentRuntimeName: 'unrelated_runtime', agentRuntimeArn: OTHER_RUNTIME_ARN },
        { agentRuntimeName: RESOURCE_NAMES.runtime, agentRuntimeArn: RUNTIME_ARN }
      ],
      pools: [
        { Id: 'us-east-1_Wrong0000', Name: 'some-other-pool' },
        { Id: USER_POOL_ID, Name: RESOURCE_NAMES.userPool }
      ],
      clients: [
        { ClientId: 'wrongclientid0000000', ClientName: 'some-other-client' },
        { ClientId: CLIENT_ID, ClientName: RESOURCE_NAMES.appClient }
      ]
    });
    const values = await discover(api, IDENTITY);
    expect(values.runtimeArn).toBe(RUNTIME_ARN);
    expect(values.clientId).toBe(CLIENT_ID);
    expect(api.calls).toContain(`listUserPoolClients:${USER_POOL_ID}`);
  });

  it('says the stack may not be deployed when the runtime is absent, and asks Cognito nothing', async () => {
    const api = fakeApi({ runtimes: [] });
    await expect(discover(api, IDENTITY)).rejects.toThrow(
      /No AgentCore runtime named demo_homeledger_mcp in us-east-1 \(profile homeledger-admin\)\. The demo stack may not be deployed/
    );
    // Short-circuiting matters: an undeployed stack has no Cognito pool either,
    // and two complaints about two missing things is worse than one about the
    // first.
    expect(api.calls).toEqual(['listAgentRuntimes']);
  });

  it('names the workflow that would have created the runtime', async () => {
    await expect(discover(fakeApi({ runtimes: [] }), IDENTITY)).rejects.toThrow(/deploy\.yml/);
  });

  it('refuses to guess between two runtimes of the same name', async () => {
    const api = fakeApi({
      runtimes: [
        { agentRuntimeName: RESOURCE_NAMES.runtime, agentRuntimeArn: RUNTIME_ARN },
        { agentRuntimeName: RESOURCE_NAMES.runtime, agentRuntimeArn: OTHER_RUNTIME_ARN }
      ]
    });
    await expect(discover(api, IDENTITY)).rejects.toThrow(/Found 2 AgentCore runtimes named demo_homeledger_mcp .* with different ARNs/);
  });

  it('refuses to guess between two app clients of the same name', async () => {
    const api = fakeApi({
      clients: [
        { ClientId: CLIENT_ID, ClientName: RESOURCE_NAMES.appClient },
        { ClientId: 'secondclientid000000', ClientName: RESOURCE_NAMES.appClient }
      ]
    });
    await expect(discover(api, IDENTITY)).rejects.toThrow(/Found 2 Cognito app clients named homeledger-simulator .* with different ids/);
  });

  it('refuses to guess between two user pools of the same name', async () => {
    const api = fakeApi({
      pools: [
        { Id: USER_POOL_ID, Name: RESOURCE_NAMES.userPool },
        { Id: 'us-east-1_Zz9Yy8Xx7', Name: RESOURCE_NAMES.userPool }
      ]
    });
    await expect(discover(api, IDENTITY)).rejects.toThrow(/Found 2 Cognito user pools named demo-homeledger-mcp .* with different ids/);
  });

  it('says the pool is half applied when the app client is missing', async () => {
    await expect(discover(fakeApi({ clients: [] }), IDENTITY)).rejects.toThrow(/only half applied/);
  });

  describe('failures the owner is most likely to hit', () => {
    it('answers an expired SSO session with the one command that fixes it', async () => {
      const api = fakeApi({
        failOn: { call: 'listAgentRuntimes', error: awsError('CredentialsProviderError', 'Profile homeledger-admin could not be refreshed') }
      });
      await expect(discover(api, IDENTITY)).rejects.toThrow('Your AWS SSO session expired, run `aws login --profile homeledger-admin`');
    });

    it('says AWS_PROFILE is unset rather than only that a session expired', async () => {
      const api = fakeApi({
        failOn: { call: 'listAgentRuntimes', error: awsError('CredentialsProviderError', 'Could not load credentials from any providers') }
      });
      const unset: AwsIdentityContext = { ...IDENTITY, profileFromEnvironment: false };
      let message = '';
      await discover(api, unset).catch((err: Error) => {
        message = err.message;
      });
      expect(message).toContain('Your AWS SSO session expired, run `aws login --profile homeledger-admin`');
      expect(message).toContain('AWS_PROFILE is not set, so this used the default profile homeledger-admin.');
    });

    it('sends an owner with a profile that does not exist to their AWS config, not to aws login', async () => {
      const api = fakeApi({ failOn: { call: 'listAgentRuntimes', error: awsError('CredentialsProviderError', 'Profile typo-admin was not found.') } });
      const chosen: AwsIdentityContext = { region: 'us-east-1', profile: 'typo-admin', profileFromEnvironment: true };
      let message = '';
      await discover(api, chosen).catch((err: Error) => {
        message = err.message;
      });
      expect(message).toContain('AWS_PROFILE is set to typo-admin, and no profile of that name exists in ~/.aws/config');
      expect(message).not.toContain('session expired');
    });

    it('recognises a profile that does not exist behind the SDK’s flat "any providers" error', async () => {
      // This is what the SDK really raises for a nonexistent profile, measured
      // against 3.1136.0 with empty shared config files: `CredentialsProviderError:
      // Could not load credentials from any providers`, with the ini provider's
      // specific complaint swallowed by the node chain. Without the profile list
      // this is indistinguishable from a lapsed session, and the owner is sent to
      // `aws login` for a profile that was never defined.
      const api = fakeApi({
        failOn: { call: 'listAgentRuntimes', error: awsError('CredentialsProviderError', 'Could not load credentials from any providers') }
      });
      const chosen: AwsIdentityContext = { region: 'us-east-1', profile: 'typo-admin', profileFromEnvironment: true };
      let message = '';
      await discover(api, chosen).catch((err: Error) => {
        message = err.message;
      });
      expect(message).toContain('AWS_PROFILE is set to typo-admin, and no profile of that name exists in ~/.aws/config');
      expect(message).not.toContain('aws login');
    });

    it('still calls a lapsed session a lapsed session when the profile really is there', async () => {
      // The negative half of the test above, and the one that stops the profile
      // check swallowing the failure it was added alongside.
      const api = fakeApi({
        failOn: { call: 'listAgentRuntimes', error: awsError('CredentialsProviderError', 'Could not load credentials from any providers') }
      });
      await expect(discover(api, IDENTITY)).rejects.toThrow('Your AWS SSO session expired, run `aws login --profile homeledger-admin`');
    });

    it('says nothing about the profile when the profile list could not be read', async () => {
      const api = fakeApi({
        failOn: { call: 'listAgentRuntimes', error: awsError('CredentialsProviderError', 'Could not load credentials from any providers') }
      });
      const chosen: AwsIdentityContext = { region: 'us-east-1', profile: 'typo-admin', profileFromEnvironment: true };
      // Called through discoverSetupValues rather than the `discover` helper on
      // purpose: passing `undefined` to a parameter with a default gets the
      // default, which would have made this assert the opposite of its name.
      await expect(discoverSetupValues(api, chosen, { readProfiles: async () => undefined })).rejects.toThrow(
        'Your AWS SSO session expired, run `aws login --profile typo-admin`'
      );
    });

    it('does not go looking at the filesystem for a failure that is not about credentials', async () => {
      let looked = false;
      const api = fakeApi({ failOn: { call: 'listUserPools', error: awsError('ThrottlingException', 'Rate exceeded') } });
      await discoverSetupValues(api, IDENTITY, {
        readProfiles: async () => {
          looked = true;
          return KNOWN_PROFILES;
        }
      }).catch(() => undefined);
      expect(looked).toBe(false);
    });

    it('names the permission when the identity is signed in but not allowed', async () => {
      const api = fakeApi({
        failOn: { call: 'listUserPools', error: awsError('AccessDeniedException', 'User is not authorized to perform cognito-idp:ListUserPools') }
      });
      await expect(discover(api, IDENTITY)).rejects.toThrow(
        'The AWS identity from profile homeledger-admin is not allowed to call cognito-idp:ListUserPools in us-east-1. Grant it that permission, or fill the values into the `claude mcp add` command by hand.'
      );
    });

    it('names the operation for a failure it does not recognise, instead of swallowing it', async () => {
      const api = fakeApi({ failOn: { call: 'describeUserPoolDomains', error: awsError('ThrottlingException', 'Rate exceeded') } });
      await expect(discover(api, IDENTITY)).rejects.toThrow('cognito-idp:DescribeUserPool failed in us-east-1 with profile homeledger-admin: Rate exceeded');
    });
  });
});

describe('the client secret, which discovery must never touch', () => {
  it('names the Cognito calls that would return one', () => {
    // Literals, not a lookup into the constant, so emptying the list cannot
    // make this pass vacuously.
    expect([...FORBIDDEN_DISCOVERY_CALLS]).toContain('cognito-idp:DescribeUserPoolClient');
    expect([...FORBIDDEN_DISCOVERY_CALLS]).toContain('cognito-idp:ListUserPoolClientSecrets');
  });

  it('does not issue any of them', async () => {
    // Checks the module's own source rather than its behaviour, because the
    // behaviour under test is an absence. DescribeUserPoolClient is the
    // obvious call for a client id — it is one request instead of a list scan —
    // and it answers with UserPoolClientType, which carries ClientSecret. This
    // fails the moment someone reaches for it.
    const source = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../src/discover.ts'), 'utf8');
    expect(source).not.toMatch(/\bnew (DescribeUserPoolClient|ListUserPoolClientSecrets|AddUserPoolClientSecret)Command\b/);
  });

  it('lifts only the three identifiers out of a row, so a secret riding along does not reach the printed command', async () => {
    // A regression guard rather than a proof: nothing on the happy path reads
    // this field today. It fails if a future edit widens what discovery carries
    // out of a Cognito row into the block the owner pastes.
    const api = fakeApi({
      clients: [{ ClientId: CLIENT_ID, ClientName: RESOURCE_NAMES.appClient, ...({ ClientSecret: 'never-print-this-value' } as object) }]
    });
    const values = await discover(api, IDENTITY);
    expect(renderSetup({ values, entrypoint: '/repo/x.js' })).not.toContain('never-print-this-value');
  });
});
