import { defineConfig } from '@playwright/test';

/**
 * Local and deterministic. The MCP server runs in memory on 8010, the model is
 * scripted, and no credential of any kind is needed — which is why this can be
 * a suite rather than a rehearsal.
 */
export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'pnpm --filter @homeledger/mcp-server run dev',
      url: 'http://127.0.0.1:8010/healthz',
      reuseExistingServer: false,
      env: { PORT: '8010', HOUSEHOLD_ID: 'hh_harlow', MEMORY_REPO: '1', HOMELEDGER_DEV_TOOLS: '1' }
    },
    {
      // `dev:e2e`, a script of its own, and NOT `run dev -- -p 3100`: that
      // expands to `next dev -p 3000 -p 3100`, because `dev` already pins
      // 3000. Last-wins is not contractual in Next's CLI parser, and the
      // health check below polls 3100, so the failure mode is a suite that
      // hangs waiting for a server listening on the other port.
      command: 'pnpm --filter @homeledger/simulator run dev:e2e',
      url: 'http://127.0.0.1:3100/api/health',
      reuseExistingServer: false,
      env: {
        HOMELEDGER_MCP_URL: 'http://127.0.0.1:8010/mcp',
        HOMELEDGER_SIMULATOR_SCRIPTED_MODEL: '1',
        // Present because readSimulatorEnv requires it; never used, because the
        // scripted model never constructs an Anthropic client. This file sits
        // outside src/, so Task 2's guard does not walk it - which is correct
        // (Next never compiles it) and is exactly why the placeholder is
        // pinned by an assertion of its own, below.
        ANTHROPIC_API_KEY: 'not-used-by-the-scripted-model'
      }
    }
  ]
});
