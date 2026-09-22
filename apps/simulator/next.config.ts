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
  poweredByHeader: false
};

export default config;
