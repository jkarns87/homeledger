import { describe, expect, it } from 'vitest';
import { isInitializeBody, isLegacyBody } from '../src/legacy.js';

const modernCall = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } };
const legacyInit = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Alexa+ MCP Client', version: '1.0.0' } }
};
const legacyCall = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_appliances', arguments: {} } };

describe('legacy detection', () => {
  it('treats initialize as legacy', () => {
    expect(isInitializeBody(legacyInit)).toBe(true);
    expect(isLegacyBody(legacyInit, {})).toBe(true);
  });
  it('treats a session header as legacy', () => {
    expect(isLegacyBody(modernCall, { 'mcp-session-id': 'abc' })).toBe(true);
  });
  it('treats a request without the protocol-version meta as legacy', () => {
    expect(isLegacyBody(legacyCall, {})).toBe(true);
  });
  it('treats a request carrying the protocol-version meta as modern', () => {
    expect(isLegacyBody(modernCall, {})).toBe(false);
  });
  it('treats a batch as legacy if any element is legacy', () => {
    expect(isLegacyBody([modernCall, legacyCall], {})).toBe(true);
  });
});
