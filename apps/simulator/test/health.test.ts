import { describe, expect, it, vi } from 'vitest';
import { GET, dynamic, runtime } from '../src/app/api/health/route.js';

describe('health route', () => {
  it('answers with the application name', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, app: 'homeledger-simulator' });
  });

  it('runs on the Node runtime and is never statically rendered', () => {
    // Both matter. The agent route holds an SSE stream open across several
    // minutes and keeps the MCP session in process memory, neither of which
    // survives the edge runtime or a prerender.
    expect(runtime).toBe('nodejs');
    expect(dynamic).toBe('force-dynamic');
  });

  it('reads no environment variable at import time', async () => {
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) delete process.env[key];
    try {
      vi.resetModules();
      const fresh = await import('../src/app/api/health/route.js');
      expect((fresh as { GET: () => Response }).GET().status).toBe(200);
    } finally {
      Object.assign(process.env, saved);
    }
  });
});
