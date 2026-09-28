// One bundle per handler, so each Lambda ships only what it imports. The AWS
// SDK v3 is provided by the nodejs22.x runtime and stays external; everything
// else, @homeledger/core included, is bundled. The banner gives bundled
// CommonJS dependencies a `require` inside an ES module.
import { build } from 'esbuild';
import { existsSync, readdirSync, rmSync } from 'node:fs';

const dir = 'src/handlers';
const handlers = existsSync(dir)
  ? readdirSync(dir)
      .filter(f => f.endsWith('.ts'))
      .map(f => f.slice(0, -3))
  : [];
rmSync('dist', { recursive: true, force: true });
for (const name of handlers) {
  await build({
    entryPoints: [`${dir}/${name}.ts`],
    outfile: `dist/${name}/index.mjs`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    external: ['@aws-sdk/*'],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    logLevel: 'warning'
  });
}
console.log(`built ${handlers.length} handler(s): ${handlers.join(', ') || '(none yet)'}`);
