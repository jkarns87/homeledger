import type { NextConfig } from 'next';

/**
 * Deliberately minimal, and the absence of an `env` block is the point: any
 * key listed there is inlined into the client bundle at build time. The
 * Anthropic API key, the Cognito client secret and the AgentCore bearer are
 * read at request time under src/server/ and reach the browser through
 * nothing.
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Every relative import under src/server/ writes the NodeNext convention
  // this workspace's tsconfig.base.json standardises on: a `.js` specifier
  // naming a `.ts` file (`tsc --noEmit` and Vite/Vitest both already resolve
  // it, the former because `moduleResolution: "bundler"` is designed for
  // exactly this, the latter because Vite's own resolver falls back to `.ts`
  // natively). Webpack, which is what `next build` runs on these route
  // handlers, does not do that by default — it treats `./agent.js` as a
  // literal filename and fails with "Module not found" the first time a
  // route handler's import chain reaches into src/server/, which Task 9 is.
  // This is the documented escape hatch for that exact gap.
  experimental: { extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } }
};

export default config;
