import { describe, expect, it } from 'vitest';
import type { AwsIdentityContext } from '../src/aws-errors.js';
import { ConfigError } from '../src/config.js';
import type { AgentRuntimeRow, RuntimeLister } from '../src/discover.js';
import { DiscoveryError } from '../src/discover.js';
import type { ResolveRuntimeOptions } from '../src/runtime.js';
import { regionOfArn, resolveByNameNote, resolveRuntime, stalePinnedArnMessage, validatePinnedArn } from '../src/runtime.js';

/** The two ids either side of the teardown recorded in FL-038, with the account replaced. */
const OLD_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/demo_homeledger_mcp-093ImbCPE3';
const NEW_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/demo_homeledger_mcp-Rgb4ruHdu7';

const IDENTITY: AwsIdentityContext = { region: 'us-east-1', profile: 'homeledger-admin', profileFromEnvironment: true };

function lister(rows: AgentRuntimeRow[] | Error): { api: () => Promise<RuntimeLister>; calls: () => number } {
  let calls = 0;
  return {
    api: async () => ({
      listAgentRuntimes: async () => {
        calls += 1;
        if (rows instanceof Error) throw rows;
        return rows;
      }
    }),
    calls: () => calls
  };
}

function options(overrides: Partial<ResolveRuntimeOptions> & Pick<ResolveRuntimeOptions, 'target' | 'lister'>): ResolveRuntimeOptions {
  return {
    qualifier: 'DEFAULT',
    identity: IDENTITY,
    log: () => undefined,
    readProfiles: async () => new Set(['homeledger-admin']),
    ...overrides
  };
}

describe('regionOfArn', () => {
  it('reads the region out of a runtime ARN', () => {
    expect(regionOfArn(NEW_ARN)).toBe('us-east-1');
    expect(regionOfArn('arn:aws:bedrock-agentcore:eu-west-2:111122223333:runtime/x-AbC123xyZ')).toBe('eu-west-2');
  });

  it('is undefined for a string that is not an ARN, so a typo is not read as a region', () => {
    expect(regionOfArn('demo_homeledger_mcp-Rgb4ruHdu7')).toBeUndefined();
    expect(regionOfArn('arn:aws:bedrock-agentcore')).toBeUndefined();
  });

  it('is undefined for the partition-less ARN shapes that carry no region', () => {
    expect(regionOfArn('arn:aws:s3:::bucket/key')).toBeUndefined();
  });
});

describe('resolveRuntime, given a URL', () => {
  it('uses it verbatim and makes no AWS call at all', async () => {
    const list = lister([]);
    const resolved = await resolveRuntime(options({ target: { kind: 'url', url: 'https://example.invalid/mcp' }, lister: list.api }));
    expect(resolved.url).toBe('https://example.invalid/mcp');
    expect(list.calls()).toBe(0);
  });

  it('offers no re-resolution, because there is no name behind a URL to re-resolve to', async () => {
    const resolved = await resolveRuntime(options({ target: { kind: 'url', url: 'https://example.invalid/mcp' }, lister: lister([]).api }));
    expect(resolved.reresolve).toBeUndefined();
  });
});

describe('resolveRuntime, by name', () => {
  it('finds the runtime whose name matches exactly and builds the invocation URL from it', async () => {
    const list = lister([
      { agentRuntimeName: 'some_other_runtime', agentRuntimeArn: OLD_ARN },
      { agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: NEW_ARN }
    ]);
    const resolved = await resolveRuntime(options({ target: { kind: 'name', name: 'demo_homeledger_mcp' }, lister: list.api }));
    expect(resolved.arn).toBe(NEW_ARN);
    expect(resolved.url).toBe(
      'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A111122223333%3Aruntime%2Fdemo_homeledger_mcp-Rgb4ruHdu7/invocations?qualifier=DEFAULT'
    );
  });

  it('never takes the first row, which is the mistake the whole mechanism exists to avoid', async () => {
    // demo_homeledger_mcp is second. A resolver that reached for rows[0] would
    // return OLD_ARN here and this assertion is what stops that being silent.
    const list = lister([
      { agentRuntimeName: 'unrelated_runtime', agentRuntimeArn: OLD_ARN },
      { agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: NEW_ARN }
    ]);
    const resolved = await resolveRuntime(options({ target: { kind: 'name', name: 'demo_homeledger_mcp' }, lister: list.api }));
    expect(resolved.arn).toBe(NEW_ARN);
  });

  it('refuses when two runtimes share the name with different ARNs', async () => {
    const list = lister([
      { agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: OLD_ARN },
      { agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: NEW_ARN }
    ]);
    await expect(resolveRuntime(options({ target: { kind: 'name', name: 'demo_homeledger_mcp' }, lister: list.api }))).rejects.toThrow(
      /will not guess between them/
    );
  });

  it('accepts one runtime listed twice under one ARN, which is a shape the API produces', async () => {
    const list = lister([
      { agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: NEW_ARN },
      { agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: NEW_ARN }
    ]);
    const resolved = await resolveRuntime(options({ target: { kind: 'name', name: 'demo_homeledger_mcp' }, lister: list.api }));
    expect(resolved.arn).toBe(NEW_ARN);
  });

  it('says what it looked for and what it saw when the name matches nothing', async () => {
    const list = lister([{ agentRuntimeName: 'something_else', agentRuntimeArn: OLD_ARN }]);
    await expect(resolveRuntime(options({ target: { kind: 'name', name: 'demo_homeledger_mcp' }, lister: list.api }))).rejects.toThrow(
      /No AgentCore runtime named demo_homeledger_mcp in us-east-1 \(profile homeledger-admin\).*something_else/s
    );
  });

  it('tells an owner how to pin past a resolution failure that is not about credentials', async () => {
    const list = lister(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }));
    await expect(resolveRuntime(options({ target: { kind: 'name', name: 'demo_homeledger_mcp' }, lister: list.api }))).rejects.toThrow(
      /HOMELEDGER_RUNTIME_ARN to pin one ARN/
    );
  });

  it('says only "your session expired" when that is what happened, without the pinning paragraph', async () => {
    // The README quotes that one line verbatim and it is the likeliest failure
    // in the program; burying it under advice about ARNs would be a regression.
    const list = lister(Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' }));
    const failure = await resolveRuntime(options({ target: { kind: 'name', name: 'demo_homeledger_mcp' }, lister: list.api })).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(DiscoveryError);
    expect((failure as Error).message).toBe('Your AWS SSO session expired, run `aws login --profile homeledger-admin`');
    expect((failure as Error).message).not.toContain('HOMELEDGER_RUNTIME_ARN');
  });

  it('hands back a re-resolver that looks the name up again and reflects a rotation', async () => {
    let rows: AgentRuntimeRow[] = [{ agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: OLD_ARN }];
    const api = async (): Promise<RuntimeLister> => ({ listAgentRuntimes: async () => rows });
    const resolved = await resolveRuntime(options({ target: { kind: 'name', name: 'demo_homeledger_mcp' }, lister: api }));
    expect(resolved.url).toContain('093ImbCPE3');
    rows = [{ agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: NEW_ARN }];
    expect(await resolved.reresolve!()).toContain('Rgb4ruHdu7');
  });
});

describe('resolveRuntime, given an ARN', () => {
  it('validates it against the runtimes that exist rather than trusting it', async () => {
    const list = lister([{ agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: NEW_ARN }]);
    await resolveRuntime(options({ target: { kind: 'arn', arn: NEW_ARN, name: 'demo_homeledger_mcp' }, lister: list.api }));
    expect(list.calls()).toBe(1);
  });

  it('refuses to start on the stale ARN that caused this, and names the one that replaced it', async () => {
    const list = lister([{ agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: NEW_ARN }]);
    const failure = await resolveRuntime(options({ target: { kind: 'arn', arn: OLD_ARN, name: 'demo_homeledger_mcp' }, lister: list.api })).catch(
      (e: Error) => e
    );
    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as Error).message).toContain(OLD_ARN);
    expect((failure as Error).message).toContain(`The runtime named demo_homeledger_mcp is now ${NEW_ARN}`);
  });

  it('does not substitute the runtime it found for the one it was asked for', async () => {
    // Refusing and repointing are both "handling" a stale ARN. Repointing
    // would silently talk to a runtime the owner never named, which is the
    // same class of mistake as taking rows[0].
    const list = lister([{ agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: NEW_ARN }]);
    await expect(resolveRuntime(options({ target: { kind: 'arn', arn: OLD_ARN, name: 'demo_homeledger_mcp' }, lister: list.api }))).rejects.toThrow(
      ConfigError
    );
  });

  it('offers no re-resolution for a pinned ARN, for the same reason', async () => {
    const list = lister([{ agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: NEW_ARN }]);
    const resolved = await resolveRuntime(options({ target: { kind: 'arn', arn: NEW_ARN, name: 'demo_homeledger_mcp' }, lister: list.api }));
    expect(resolved.reresolve).toBeUndefined();
    expect(resolved.origin).toBe('arn');
  });

  it('keeps going, with a diagnostic, when the check itself cannot be made', async () => {
    // A throttle or a missing ListAgentRuntimes permission teaches nothing
    // about whether the runtime exists, so it must not fail the start.
    const logs: string[] = [];
    const list = lister(Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' }));
    const resolved = await resolveRuntime(
      options({ target: { kind: 'arn', arn: NEW_ARN, name: 'demo_homeledger_mcp' }, lister: list.api, log: m => logs.push(m) })
    );
    expect(resolved.url).toContain('Rgb4ruHdu7');
    expect(logs.join('\n')).toContain('could not check HOMELEDGER_RUNTIME_ARN');
  });

  it('does not check an ARN in another region against this region’s list, and says so', async () => {
    const logs: string[] = [];
    const elsewhere = 'arn:aws:bedrock-agentcore:eu-west-2:111122223333:runtime/demo_homeledger_mcp-Rgb4ruHdu7';
    const list = lister([]);
    await resolveRuntime(options({ target: { kind: 'arn', arn: elsewhere, name: 'demo_homeledger_mcp' }, lister: list.api, log: m => logs.push(m) }));
    expect(list.calls()).toBe(0);
    expect(logs.join('\n')).toContain('names a runtime in eu-west-2 but AWS_REGION is us-east-1');
  });
});

describe('validatePinnedArn', () => {
  it('passes an ARN that is present even when its name is not the one this project expects', async () => {
    // Pinning is how an owner addresses a runtime on purpose, including one
    // named something else. Validation asks "does it exist", not "is it ours".
    const list = lister([{ agentRuntimeName: 'a_completely_different_name', agentRuntimeArn: NEW_ARN }]);
    await expect(
      validatePinnedArn(NEW_ARN, 'demo_homeledger_mcp', options({ target: { kind: 'arn', arn: NEW_ARN, name: 'demo_homeledger_mcp' }, lister: list.api }))
    ).resolves.toBeUndefined();
  });
});

describe('stalePinnedArnMessage', () => {
  it('names the rotation mechanism and both ways out', () => {
    const message = stalePinnedArnMessage(OLD_ARN, [{ agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: NEW_ARN }], IDENTITY, 'demo_homeledger_mcp');
    expect(message).toContain('FL-038');
    expect(message).toContain('pnpm --filter @homeledger/mcp-bridge run print-setup');
    expect(message).toContain('remove `-e HOMELEDGER_RUNTIME_ARN`');
  });

  it('says the stack may be down when nothing of that name is there at all', () => {
    expect(stalePinnedArnMessage(OLD_ARN, [], IDENTITY, 'demo_homeledger_mcp')).toContain('no runtime named demo_homeledger_mcp there either');
  });

  it('refuses to pick when several runtimes share the name', () => {
    const rows = [
      { agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: NEW_ARN },
      { agentRuntimeName: 'demo_homeledger_mcp', agentRuntimeArn: `${OLD_ARN}x` }
    ];
    expect(stalePinnedArnMessage(OLD_ARN, rows, IDENTITY, 'demo_homeledger_mcp')).toContain('will not pick between them');
  });
});

describe('resolveByNameNote', () => {
  it('names the runtime it looks for and both overrides', () => {
    const note = resolveByNameNote('demo_homeledger_mcp');
    expect(note).toContain('demo_homeledger_mcp');
    expect(note).toContain('HOMELEDGER_RUNTIME_ARN');
    expect(note).toContain('HOMELEDGER_MCP_URL');
  });
});
