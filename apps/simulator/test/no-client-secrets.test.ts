import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../src', import.meta.url));
/**
 * The other half of the bundler's reach.
 *
 * `next.config.ts` is not under `src/`, is never imported by anything there,
 * and is the one file outside it that can put a value into the client bundle —
 * an `env` block is inlined at build time, by design. A guard that walked only
 * `src` would be blind to the single most effective way to leak a key from this
 * package, so it is read by name. Test files and `playwright.config.ts` are
 * deliberately NOT in scope: Next never compiles them, `credentials.test.ts`
 * legitimately names `ANTHROPIC_API_KEY` on nearly every line, and a guard
 * extended to cover them would have to be relaxed until it proved nothing.
 */
const nextConfig = fileURLToPath(new URL('../next.config.ts', import.meta.url));

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) files.push(full);
  }
  return files;
}

/** Names that must never be read anywhere the bundler could follow into the browser. */
const CREDENTIAL_NAMES = ['ANTHROPIC_API_KEY', 'HOMELEDGER_COGNITO_CLIENT_SECRET', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

describe('client-side secret guard', () => {
  it('mentions a credential name only under src/server', async () => {
    const offenders: string[] = [];
    for (const file of await walk(root)) {
      if (file.includes(`${join('src', 'server')}`)) continue;
      const text = await readFile(file, 'utf8');
      for (const name of CREDENTIAL_NAMES) if (text.includes(name)) offenders.push(`${file}: ${name}`);
    }
    expect(offenders).toEqual([]);
  });

  it('never prefixes a credential with NEXT_PUBLIC_, anywhere at all', async () => {
    const offenders: string[] = [];
    for (const file of [...(await walk(root)), nextConfig]) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) offenders.push(`${file}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps next.config.ts free of credential names and of an env block entirely', async () => {
    // Two separate failures, both fatal, neither visible in `src`. A name here
    // is a name the bundler can reach; an `env` block is the mechanism that
    // reaches it, and it inlines its values into the browser bundle at build
    // time whatever they are called.
    const text = await readFile(nextConfig, 'utf8');
    for (const name of CREDENTIAL_NAMES) expect(text, name).not.toContain(name);
    expect(text).not.toMatch(/\benv\s*:/);
  });

  it("never imports src/server from a 'use client' module", async () => {
    const offenders: string[] = [];
    for (const file of await walk(root)) {
      const text = await readFile(file, 'utf8');
      if (!/^\s*(['"])use client\1/m.test(text)) continue;
      for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1] ?? '';
        if (specifier.includes('/server/') || specifier.startsWith('@/server')) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
