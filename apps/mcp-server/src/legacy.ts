import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { McpServer } from '@modelcontextprotocol/server';

const PROTOCOL_META = 'io.modelcontextprotocol/protocolVersion';

type Rpc = { method?: unknown; params?: { _meta?: Record<string, unknown> } };

export function isInitializeBody(body: unknown): boolean {
  const list = Array.isArray(body) ? body : [body];
  return list.some(m => (m as Rpc)?.method === 'initialize');
}

export function isLegacyBody(body: unknown, headers: Record<string, string | string[] | undefined>): boolean {
  if (headers['mcp-session-id']) return true;
  const list = Array.isArray(body) ? body : [body];
  return list.some(m => {
    const rpc = m as Rpc;
    if (rpc?.method === 'initialize') return true;
    if (typeof rpc?.method !== 'string') return false;
    return !(rpc.params?._meta && PROTOCOL_META in rpc.params._meta);
  });
}

export function createLegacyRouter(build: () => McpServer): { route: RequestHandler; sessionCount: () => number; closeAll: () => Promise<void> } {
  const sessions = new Map<string, NodeStreamableHTTPServerTransport>();

  const route: RequestHandler = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }
    if (!sessionId && req.method === 'POST' && isInitializeBody(req.body)) {
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => {
          sessions.set(id, transport);
        }
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await build().connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    if (sessionId) {
      res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
      return;
    }
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Session ID required' }, id: null });
  };

  return {
    route,
    sessionCount: () => sessions.size,
    closeAll: async () => {
      await Promise.all([...sessions.values()].map(t => t.close()));
      sessions.clear();
    }
  };
}
