import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import express, { type RequestHandler } from 'express';
import { createLegacyRouter, isLegacyBody } from './legacy.js';
import { buildServer, SERVER_INFO, type ServerDeps } from './server.js';

export function createApp(deps: ServerDeps, opts: { allowedHosts?: string[] | 'any' } = {}) {
  const build = () => buildServer(deps);
  const modern = createMcpHandler(build, { legacy: 'reject' });
  const modernNode = toNodeHandler(modern);
  const legacy = createLegacyRouter(build);

  // 'any' means the caller explicitly asked to disable Host-header validation
  // (AgentCore's invocation proxy forwards an internal, undocumented Host that
  // an allowlist cannot name in advance — FL-020/FL-022 — and the runtime is
  // reachable only through the authenticated invocation endpoint anyway, so
  // the JWT authorizer is the access control there, not this allowlist).
  // `@modelcontextprotocol/express`'s createMcpExpressApp only installs its
  // hostHeaderValidation middleware when `allowedHosts` is truthy, so passing
  // `undefined` here (as opposed to omitting the option or leaving it unset)
  // turns validation off entirely rather than pinning a guessed hostname.
  // No opts / an unset value keeps the local default list, so existing local
  // and test behavior (validation on, localhost-class hosts only) is unchanged.
  const allowedHosts = opts.allowedHosts === 'any' ? undefined : (opts.allowedHosts ?? ['localhost', '127.0.0.1', '0.0.0.0']);
  const mcpApp = createMcpExpressApp({ host: '0.0.0.0', allowedHosts, jsonLimit: '1mb' });

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

  mcpApp.get('/healthz', (_req, res) => {
    res.json({ ok: true, name: SERVER_INFO.name });
  });
  mcpApp.all('/mcp', route);

  // createMcpExpressApp registers its Host-header allowlist check ahead of any
  // middleware added here, so it cannot be observed from inside mcpApp. Wrap it
  // in an outer app whose first middleware logs the Host header of any request
  // the inner app rejects (403, e.g. an unrecognized Host or Origin), so a
  // rejection is diagnosable from the runtime's own logs instead of only the
  // client-side "403 from runtime" error. One line per rejected request; no
  // request or response bodies are logged.
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode === 403) {
        console.log(JSON.stringify({ msg: 'request-rejected', host: req.headers.host, path: req.path, status: res.statusCode }));
      }
    });
    next();
  });
  app.use(mcpApp);

  return {
    app,
    close: async () => {
      await legacy.closeAll();
      await modern.close();
    }
  };
}
