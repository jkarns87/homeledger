import { McpServer, createRequestStateCodec } from '@modelcontextprotocol/server';
import type { ManualRetriever, Repository } from '@homeledger/core';
import { registerApplianceTools } from './tools/appliances.js';
import { registerMaintenanceTools } from './tools/maintenance.js';
import { registerEventTools } from './tools/events.js';
import { registerManualTools } from './tools/manual.js';
import { registerServiceTools, type BookingState } from './tools/service.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { registerDevTools } from './tools/dev.js';

export interface ServerDeps {
  repo: Repository;
  now: () => string; // ISO datetime
  /**
   * The household's IANA zone. EVERY human-facing time renders in it - not in
   * the viewer's local zone, because a shared household assistant must not have
   * the kitchen display and a phone abroad disagreeing about when the plumber
   * arrives. The household is the authority on its own clock. Async because it
   * comes from the household record; see `resolveHouseholdTimeZone` in deps.ts
   * for what happens when that record is missing or carries a bad zone.
   */
  householdTimeZone: () => Promise<string>;
  devTools: boolean;
  retriever: ManualRetriever;
  /** HMAC key for the multi round-trip requestState codec. At least 32 bytes. */
  requestStateKey: string;
  /** Total budget for book_service's simulated availability check, in milliseconds. */
  availabilityDelayMs: number;
}

export const SERVER_INFO = { name: 'homeledger', version: '0.1.0' } as const;

/** Ten minutes: long enough for a human to answer three cards, short enough to expire. */
const REQUEST_STATE_TTL_SECONDS = 600;

export function buildServer(deps: ServerDeps): McpServer {
  const codec = createRequestStateCodec<BookingState>({
    key: deps.requestStateKey,
    ttlSeconds: REQUEST_STATE_TTL_SECONDS,
    bind: ctx => `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? ''}`
  });

  const server = new McpServer(SERVER_INFO, {
    instructions:
      'HomeLedger is the household operating record: appliances, warranties, manuals, maintenance, service visits, and door and sensor events. Speak results plainly; never read identifiers aloud.',
    requestState: { verify: (state, ctx) => codec.verify(state, ctx) }
  });

  // Tool order is frozen after the first deploy. Do not reorder these calls.
  registerApplianceTools(server, deps); // list_appliances, get_appliance
  registerMaintenanceTools(server, deps); // maintenance_due, log_maintenance
  registerEventTools(server, deps); // recent_events
  registerManualTools(server, deps); // ask_manual
  registerServiceTools(server, deps, codec); // book_service
  registerResources(server, deps);
  registerPrompts(server, deps);
  registerDevTools(server, deps); // echo_confirm, always last, devTools only
  return server;
}
