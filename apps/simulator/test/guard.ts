import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * The machinery behind `no-client-secrets.test.ts`, lifted out of the `it`
 * bodies so it can be tested against file trees of its own.
 *
 * The first version of that guard walked `src/` with an include-list of three
 * extensions and skipped `src/server` with a substring match. Seven ordinary
 * code shapes went straight through it, three of them demonstrably putting a
 * credential in the browser: a `.js` file under `src/` (Next compiles it, the
 * filter did not list it), a `src/server-helpers.ts` (the substring skip
 * exempted it, and its value reached `index.html` and `index.rsc`), and a root
 * `instrumentation-client.ts` (which Next 15.3+ executes *in the browser* and
 * which lives outside `src/` entirely).
 *
 * The shape was the defect, not the rules. A guard rooted at two paths with an
 * include-list answers "what files did we think to look at"; the question worth
 * answering is "what can reach the client bundle". So this walks the package
 * root and excludes, by name and with a reason, only what provably cannot be
 * compiled into anything a browser receives.
 */

/** A file the guard has read, identified by absolute path. */
export interface SourceFile {
  path: string;
  text: string;
}

/**
 * Directories Next never compiles into a browser artifact.
 *
 * `test` and `e2e` are the only two that hold a judgement call: test code names
 * credentials legitimately — `credentials.test.ts` names `ANTHROPIC_API_KEY` on
 * nearly every line — and a guard stretched over them would have to be relaxed
 * until it proved nothing. The rest are build output or dependencies.
 */
export const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.next',
  '.git',
  '.turbo',
  'dist',
  'coverage',
  'test',
  'e2e',
  'playwright-report',
  'test-results'
]);

/**
 * Root files excluded by name.
 *
 * `playwright.config.ts` drives the end-to-end run and may legitimately hand a
 * key to a `webServer` block; Next does not compile it. Nothing else is
 * exempt — in particular `next.config.ts` is deliberately *in* scope, because
 * an `env` block there is inlined into the client bundle at build time and is
 * the single most effective way to leak a key from this package.
 */
export const EXCLUDED_FILES: ReadonlySet<string> = new Set(['playwright.config.ts']);

/**
 * Extensions read.
 *
 * Wider than the bundler's `pageExtensions` on purpose: the question is not
 * "what can be a route" but "what can hold a credential and be reached". Next's
 * default `pageExtensions` is `['tsx','ts','jsx','js']` and this package sets
 * `allowJs: true`, so every JavaScript spelling compiles exactly as TypeScript
 * does. `.json` is included because an imported JSON module is inlined into
 * whatever imports it.
 */
const SCANNED_EXTENSIONS = /\.(?:[mc]?[jt]sx?|css|scss|sass|json)$/;

/** Names that must never be read anywhere the bundler could follow into the browser. */
export const CREDENTIAL_NAMES = ['ANTHROPIC_API_KEY', 'HOMELEDGER_COGNITO_CLIENT_SECRET', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

/** Every file in the package the bundler could compile, minus the places it provably cannot reach. */
export async function collectPackageFiles(packageRoot: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        await walk(full);
      } else if (!EXCLUDED_FILES.has(entry.name) && SCANNED_EXTENSIONS.test(entry.name)) {
        files.push({ path: full, text: await readFile(full, 'utf8') });
      }
    }
  };
  await walk(packageRoot);
  return files;
}

/** True when the file sits inside `src/server/`, matched on a real directory boundary rather than a substring. */
export function isServerOnlyFile(path: string, packageRoot: string): boolean {
  return path.startsWith(join(packageRoot, 'src', 'server') + sep);
}

export function credentialNamesIn(text: string): string[] {
  return CREDENTIAL_NAMES.filter(name => text.includes(name));
}

export function publicPrefixedNamesIn(text: string): string[] {
  return [...text.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)].map(match => match[0]);
}

/**
 * Computed reads of `process.env`, which no name-based rule can see.
 *
 * This exists because the obvious reasoning about it is wrong. A name built at
 * runtime — `process.env['ANTHROPIC' + '_API_' + 'KEY']` — cannot be inlined by
 * Next's `DefinePlugin`, which substitutes literal member expressions only, so
 * it is tempting to file the whole shape as harmless on the grounds that the
 * value resolves to `undefined` in the browser. It does resolve to `undefined`
 * in the browser. It is still a leak, by a different road: a `'use client'`
 * component is *prerendered on the server* at build time, where `process.env`
 * is the real environment, and the rendered value is baked into the HTML that
 * is then served. Verified — a computed read in a client route put
 * `sk-ant-SENTINELKILO999` into `.next/server/app/built.html` as literal text,
 * with nothing in `.next/static` at all.
 *
 * So the rule is a class rule, not a name rule: outside `src/server/`, do not
 * read the environment by a key the reader cannot see. The residual limit is
 * one more level of indirection (`const e = process.env; e[name]`), which is
 * recorded rather than chased.
 */
export function dynamicEnvAccessIn(text: string): string[] {
  return [...text.matchAll(/process\s*\.\s*env\s*\[[^\]\n]{0,80}\]/g)].map(match => match[0].replace(/\s+/g, ' '));
}

export function isClientModule(text: string): boolean {
  return /^\s*(['"])use client\1/m.test(text);
}

/**
 * Every module specifier in a file, by whichever syntax reaches it.
 *
 * Four patterns rather than one, because the first version matched only
 * `from '…'`: a dynamic `import('@/server/env')` has no `from` keyword and went
 * through untouched, and so did a bare side-effect import.
 */
export function importSpecifiersIn(text: string): string[] {
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  const found: string[] = [];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) if (match[1]) found.push(match[1]);
  return found;
}

/**
 * True for a specifier that names server-only code.
 *
 * Anchored on a path boundary, so `@/server/env`, `../server/env` and
 * `src/server/env` match while `../server-helpers` does not — the latter is not
 * server-only code, it is an ordinary module, and it is the credential-name
 * rule rather than this one that governs it. `@homeledger/mcp-bridge` is here
 * because it *is* the credential stack: a client component reaching it has
 * reached `resolveClientSecret`.
 */
export function isServerSpecifier(specifier: string): boolean {
  return /(^|\/)server(\/|$)/.test(specifier) || /^@\/server(\/|$)/.test(specifier) || /^@homeledger\/mcp-bridge(\/|$)/.test(specifier);
}

const RESOLUTION_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

/**
 * Resolves a specifier to a file in this package, or undefined for a bare
 * package name.
 *
 * Enough of Node/bundler resolution to follow a re-export one hop at a time:
 * the `@/*` alias from `tsconfig.json`, relative paths, implicit extensions,
 * directory `index` files, and the TypeScript-ESM habit of writing `.js` for a
 * file that is `.ts` on disk.
 */
export function resolveSpecifier(importer: string, specifier: string, packageRoot: string, known: ReadonlySet<string>): string | undefined {
  let base: string;
  if (specifier.startsWith('@/')) base = join(packageRoot, 'src', specifier.slice(2));
  else if (specifier.startsWith('./') || specifier.startsWith('../')) base = resolve(dirname(importer), specifier);
  else return undefined;

  const bases = [base];
  const rewritten = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
  if (rewritten !== base) bases.push(rewritten);
  for (const candidate of bases) for (const suffix of RESOLUTION_SUFFIXES) if (known.has(candidate + suffix)) return candidate + suffix;
  return undefined;
}

/** Assertion 1: a credential name anywhere the bundler can follow, outside `src/server/`. */
export function credentialOffenders(files: readonly SourceFile[], packageRoot: string): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    if (isServerOnlyFile(file.path, packageRoot)) continue;
    for (const name of credentialNamesIn(file.text)) offenders.push(`${file.path}: ${name}`);
  }
  return offenders;
}

/** Assertion 5: a computed environment read anywhere outside `src/server/`. */
export function dynamicEnvOffenders(files: readonly SourceFile[], packageRoot: string): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    if (isServerOnlyFile(file.path, packageRoot)) continue;
    for (const access of dynamicEnvAccessIn(file.text)) offenders.push(`${file.path}: ${access}`);
  }
  return offenders;
}

/** Assertion 2: a `NEXT_PUBLIC_` name anywhere at all, `src/server/` included. */
export function publicPrefixOffenders(files: readonly SourceFile[]): string[] {
  const offenders: string[] = [];
  for (const file of files) for (const name of publicPrefixedNamesIn(file.text)) offenders.push(`${file.path}: ${name}`);
  return offenders;
}

/**
 * Assertion 4: server-only code reachable from a `'use client'` module.
 *
 * Transitive rather than one hop, because a barrel defeats a one-hop check
 * completely: a client component importing `@/lib-barrel`, which re-exports
 * `@/server/env`, shows nothing server-shaped at the client component's own
 * import site, and the barrel itself carries no `'use client'` so a per-file
 * scan skips it. The walk is over resolved files, so it follows the same edges
 * the bundler follows.
 */
export function clientServerImportOffenders(files: readonly SourceFile[], packageRoot: string): string[] {
  const byPath = new Map(files.map(file => [file.path, file]));
  const known = new Set(byPath.keys());
  const offenders: string[] = [];

  for (const file of files) {
    if (!isClientModule(file.text)) continue;
    const seen = new Set<string>([file.path]);
    const queue: { path: string; trail: string[] }[] = [{ path: file.path, trail: [] }];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      const text = byPath.get(current.path)?.text;
      if (text === undefined) continue;
      for (const specifier of importSpecifiersIn(text)) {
        const trail = [...current.trail, specifier];
        if (isServerSpecifier(specifier)) {
          offenders.push(`${file.path}: ${trail.join(' -> ')}`);
          continue;
        }
        const resolved = resolveSpecifier(current.path, specifier, packageRoot, known);
        if (resolved === undefined || seen.has(resolved)) continue;
        if (isServerOnlyFile(resolved, packageRoot)) {
          offenders.push(`${file.path}: ${trail.join(' -> ')}`);
          continue;
        }
        seen.add(resolved);
        queue.push({ path: resolved, trail });
      }
    }
  }
  return offenders;
}
