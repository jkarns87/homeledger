import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SourceFile } from './guard.js';
import {
  clientServerImportOffenders,
  collectPackageFiles,
  credentialNamesIn,
  credentialOffenders,
  dynamicEnvOffenders,
  importSpecifiersIn,
  isClientModule,
  isServerSpecifier,
  publicPrefixOffenders
} from './guard.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const nextConfig = join(packageRoot, 'next.config.ts');

describe('client-side secret guard', () => {
  let files: SourceFile[];

  beforeEach(async () => {
    files = await collectPackageFiles(packageRoot);
  });

  it('reads the files it claims to read', () => {
    // The guard's own reach, asserted rather than assumed. Every finding
    // against the first version of this file was a file it never opened, so a
    // silently shrinking file list is the failure mode that matters most: all
    // four assertions below pass trivially over an empty list.
    const paths = files.map(file => file.path);
    expect(paths).toContain(join(packageRoot, 'next.config.ts'));
    expect(paths).toContain(join(packageRoot, 'src', 'server', 'env.ts'));
    expect(paths).toContain(join(packageRoot, 'src', 'app', 'page.tsx'));
    expect(paths).toContain(join(packageRoot, 'src', 'app', 'globals.css'));
    expect(files.length).toBeGreaterThan(5);
    // And the places it deliberately does not read, so an exclusion cannot
    // quietly widen: this test file names credentials on purpose.
    expect(paths).not.toContain(join(packageRoot, 'test', 'credentials.test.ts'));
    expect(paths.some(path => path.includes(`${join('node_modules')}`))).toBe(false);
  });

  it('mentions a credential name only under src/server', () => {
    expect(credentialOffenders(files, packageRoot)).toEqual([]);
  });

  it('never prefixes a credential with NEXT_PUBLIC_, anywhere at all', () => {
    expect(publicPrefixOffenders(files)).toEqual([]);
  });

  it('never reaches server-only code from a use client module', () => {
    expect(clientServerImportOffenders(files, packageRoot)).toEqual([]);
  });

  it('never reads the environment by a computed key outside src/server', () => {
    expect(dynamicEnvOffenders(files, packageRoot)).toEqual([]);
  });

  it('keeps next.config.ts free of an env block entirely', async () => {
    // The credential-name half of this is now `credentialOffenders`, which
    // reads next.config.ts along with everything else. What is left is the
    // mechanism: an `env` block inlines its values into the browser bundle at
    // build time whatever they are called, so a differently-named key is just
    // as fatal and the name rule cannot see it.
    //
    // This is a tripwire, not a parse. It matches the bare word `env` followed
    // by a colon anywhere in the file, comments included, and it would miss
    // `['env']: {…}` or a spread of a config built elsewhere. Both directions
    // are accepted deliberately: the false positive is one comment reworded,
    // and the false negative is a shape nobody writes by accident. A real parse
    // here would be a Next config loader, which is not worth owning.
    const text = await readFile(nextConfig, 'utf8');
    expect(text).not.toMatch(/\benv\s*:/);
  });
});

/**
 * The seven ways the first version of this guard could be walked past.
 *
 * Each is built as a real file tree in a temporary directory and scanned by the
 * real `collectPackageFiles`, so what is tested is the guard end to end rather
 * than a predicate in isolation. Three of these were demonstrated putting a
 * credential into a built bundle; the rest evade an assertion without a
 * confirmed leak. All seven are pinned here so the shape cannot regress.
 */
describe('guard probes — the shapes that used to walk past it', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'homeledger-guard-'));
    await mkdir(join(root, 'src', 'app'), { recursive: true });
    await mkdir(join(root, 'src', 'server'), { recursive: true });
    await write('src/server/env.ts', 'export const key = process.env.ANTHROPIC_API_KEY;\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(relative: string, text: string): Promise<void> {
    const full = join(root, relative);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text, 'utf8');
  }

  const scan = async () => collectPackageFiles(root);

  it('1. a .js file under src/, which Next compiles exactly as it compiles .tsx', async () => {
    await write('src/app/leak.js', 'export const k = process.env.NEXT_PUBLIC_ANTHROPIC_API_KEY;\n');
    const found = await scan();
    expect(found.map(file => file.path)).toContain(join(root, 'src', 'app', 'leak.js'));
    expect(publicPrefixOffenders(found)).toHaveLength(1);
  });

  it('2. src/server-helpers.ts, which the old substring skip exempted', async () => {
    await write('src/server-helpers.ts', 'export const k = process.env.ANTHROPIC_API_KEY;\n');
    const offenders = credentialOffenders(await scan(), root);
    expect(offenders).toEqual([`${join(root, 'src', 'server-helpers.ts')}: ANTHROPIC_API_KEY`]);
  });

  it('3. a root instrumentation-client.ts, which Next 15.3+ runs in the browser', async () => {
    await write('instrumentation-client.ts', 'export const k = process.env.NEXT_PUBLIC_ANTHROPIC_API_KEY;\n');
    const found = await scan();
    expect(found.map(file => file.path)).toContain(join(root, 'instrumentation-client.ts'));
    expect(publicPrefixOffenders(found)).toHaveLength(1);
  });

  it('4. a root app/ directory, which Next prefers over src/app when both exist', async () => {
    await write('app/page.tsx', 'export default function P() {\n  return <span>{process.env.ANTHROPIC_API_KEY}</span>;\n}\n');
    const offenders = credentialOffenders(await scan(), root);
    expect(offenders).toEqual([`${join(root, 'app', 'page.tsx')}: ANTHROPIC_API_KEY`]);
  });

  it('5. a dynamic import(), which has no `from` keyword for the old regex to find', async () => {
    await write('src/app/dyn.tsx', "'use client';\nexport async function load() {\n  return await import('@/server/env');\n}\n");
    const offenders = clientServerImportOffenders(await scan(), root);
    expect(offenders).toEqual([`${join(root, 'src', 'app', 'dyn.tsx')}: @/server/env`]);
  });

  it('6. a barrel re-export, which hides the server module one hop away', async () => {
    await write('src/lib-barrel.ts', "export { key } from '@/server/env';\n");
    await write('src/app/tr.tsx', "'use client';\nimport { key } from '@/lib-barrel';\nexport const k = key;\n");
    const offenders = clientServerImportOffenders(await scan(), root);
    // The trail names both hops, so the diagnostic says where to look rather
    // than only that something is wrong.
    expect(offenders).toEqual([`${join(root, 'src', 'app', 'tr.tsx')}: @/lib-barrel -> @/server/env`]);
  });

  it('7. a runtime-built name, which leaks through the prerender even though DefinePlugin ignores it', async () => {
    await write(
      'src/app/built/page.tsx',
      "'use client';\nconst NAME = 'ANTHROPIC' + '_API_' + 'KEY';\nexport default function B() {\n  return <span>{process.env[NAME]}</span>;\n}\n"
    );
    const found = await scan();
    // No name-based rule can see this, and the tempting conclusion is that it
    // does not matter — a computed key is not a literal member expression, so
    // Next's DefinePlugin cannot inline it and the value really is `undefined`
    // in the browser. That reasoning is right and the conclusion is still
    // wrong. A `'use client'` component is prerendered *on the server* at build
    // time, where `process.env` is the real environment, and the rendered value
    // is written into the HTML that is served. Confirmed by building this exact
    // file with a sentinel: nothing in `.next/static`, and
    // `sk-ant-SENTINELKILO999` as literal text in `.next/server/app/built.html`.
    expect(credentialOffenders(found, root)).toEqual([]);
    expect(publicPrefixOffenders(found)).toEqual([]);
    expect(dynamicEnvOffenders(found, root)).toEqual([`${join(root, 'src', 'app', 'built', 'page.tsx')}: process.env[NAME]`]);
  });
});

/**
 * The `'use client'` rule, exercised against modules that exist.
 *
 * Until Task 14 lands real widgets, no file in `src/` begins with
 * `'use client'`, so the whole-package assertion above reads a collection that
 * is empty by construction and passes for the wrong reason. These fixtures are
 * strings rather than files precisely so they cannot themselves become the
 * leak: Next never sees them.
 */
describe('use-client predicates', () => {
  const CLIENT_OK = "'use client';\nimport { fmt } from '@/lib/format';\n";
  const CLIENT_BAD = "'use client';\nimport { readSimulatorEnv } from '@/server/env';\n";
  const SERVER_MODULE = "import { readSimulatorEnv } from '@/server/env';\n";

  it('recognises a client module and ignores one that is not', () => {
    expect(isClientModule(CLIENT_OK)).toBe(true);
    expect(isClientModule(SERVER_MODULE)).toBe(false);
  });

  it('accepts a clean client module and rejects one that imports server code', () => {
    expect(importSpecifiersIn(CLIENT_OK).filter(isServerSpecifier)).toEqual([]);
    expect(importSpecifiersIn(CLIENT_BAD).filter(isServerSpecifier)).toEqual(['@/server/env']);
  });

  it('anchors on a path boundary, so a server-ish name is not mistaken for the server directory', () => {
    expect(['@/server/env', '../server/env', './server/x', '@homeledger/mcp-bridge/secret'].filter(isServerSpecifier)).toEqual([
      '@/server/env',
      '../server/env',
      './server/x',
      '@homeledger/mcp-bridge/secret'
    ]);
    // Not server-only code: an ordinary module that happens to start with the
    // same letters. The credential-name rule governs it, not this one — and
    // the old substring match got this exactly backwards by skipping it.
    expect(['../server-helpers', '@/servers', '@/observer/x'].filter(isServerSpecifier)).toEqual([]);
  });

  it('finds a credential name wherever it appears', () => {
    expect(credentialNamesIn('const a = process.env.AWS_SESSION_TOKEN;')).toEqual(['AWS_SESSION_TOKEN']);
    expect(credentialNamesIn('nothing to see')).toEqual([]);
  });
});
