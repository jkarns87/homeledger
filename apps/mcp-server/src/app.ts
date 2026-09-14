import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { RequestHandler } from 'express';
import { createLegacyRouter, isLegacyBody } from './legacy.js';
import { buildServer, SERVER_INFO, type ServerDeps } from './server.js';

export function createApp(deps: ServerDeps, opts: { allowedHosts?: string[] } = {}) {
  const build = () => buildServer(deps);
  const modern = createMcpHandler(build, { legacy: 'reject' });
  const modernNode = toNodeHandler(modern);
  const legacy = createLegacyRouter(build);

  const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: opts.allowedHosts ?? ['localhost', '127.0.0.1', '0.0.0.0'], jsonLimit: '1mb' });

  const route: RequestHandler = async (req, res, next) => {
    try {
      if (req.method !== 'POST' || isLegacyBody(req.body, req.headers)) {
        await legacy.route(req, res, next);
        return;
      }
      await modernNode(req, res, req.body);
    } catch (err) {
      next(err);
    }
  };

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, name: SERVER_INFO.name });
  });
  app.all('/mcp', route);

  return {
    app,
    close: async () => {
      await legacy.closeAll();
      await modern.close();
    }
  };
}
