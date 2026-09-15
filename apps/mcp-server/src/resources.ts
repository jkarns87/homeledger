import type { McpServer } from '@modelcontextprotocol/server';
import { isOverdue } from '@homeledger/core';
import type { ServerDeps } from './server.js';

const json = (uri: string, value: unknown) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] });

export function registerResources(server: McpServer, deps: ServerDeps): void {
  server.registerResource(
    'household',
    'homeledger://household',
    { title: 'Household', description: 'Household name and timezone', mimeType: 'application/json' },
    async uri => json(uri.href, (await deps.repo.getHousehold()) ?? {})
  );
  server.registerResource(
    'appliances',
    'homeledger://appliances',
    { title: 'Appliances', description: 'Every appliance with warranty dates and maintenance templates', mimeType: 'application/json' },
    async uri => json(uri.href, await deps.repo.listAppliances())
  );
  server.registerResource(
    'maintenance-schedule',
    'homeledger://maintenance/schedule',
    { title: 'Maintenance schedule', description: 'All maintenance items ordered by next due date', mimeType: 'application/json' },
    async uri => {
      const today = deps.now().slice(0, 10);
      const names = new Map((await deps.repo.listAppliances()).map(a => [a.id, a.name] as const));
      const items = (await deps.repo.listMaintenanceDue(3650, today)).map(m => ({
        ...m,
        applianceName: names.get(m.applianceId) ?? 'Unknown',
        overdue: isOverdue(m.nextDueAt, today)
      }));
      return json(uri.href, items);
    }
  );
}
