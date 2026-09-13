import { McpServer } from '@modelcontextprotocol/server';
import type { Repository } from '@homeledger/core';
import { registerApplianceTools } from './tools/appliances.js';
import { registerMaintenanceTools } from './tools/maintenance.js';
import { registerEventTools } from './tools/events.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

export interface ServerDeps {
  repo: Repository;
  now: () => string; // ISO datetime
  devTools: boolean;
}

export const SERVER_INFO = { name: 'homeledger', version: '0.1.0' } as const;

export function buildServer(deps: ServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'HomeLedger is the household operating record: appliances, warranties, manuals, maintenance, service visits, and door and sensor events. Speak results plainly; never read identifiers aloud.'
  });
  registerApplianceTools(server, deps);
  registerMaintenanceTools(server, deps);
  registerEventTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server, deps);
  return server;
}
