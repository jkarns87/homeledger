import type { McpServer } from '@modelcontextprotocol/server';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { isOverdue, todayInZone } from '@homeledger/core';
import type { ServerDeps } from './server.js';
import { WIDGETS } from './widgets/index.js';

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
      // Same household-today rule as maintenance_due: this resource's
      // `overdue` flag must agree with the tool's, or the JSON a client reads
      // and the sentence it hears disagree for five hours every evening.
      const today = todayInZone(deps.now(), await deps.householdTimeZone());
      const names = new Map((await deps.repo.listAppliances()).map(a => [a.id, a.name] as const));
      const items = (await deps.repo.listMaintenanceDue(3650, today)).map(m => ({
        ...m,
        applianceName: names.get(m.applianceId) ?? 'Unknown',
        overdue: isOverdue(m.nextDueAt, today)
      }));
      return json(uri.href, items);
    }
  );

  // KNOWN OPEN GAP (FL-030): the visit widget's <img> loads a Ring snapshot
  // from an S3 presigned URL, which needs `_meta.ui.csp.resourceDomains` set
  // to that bucket's domain or a spec-compliant host serves `img-src 'none'`
  // and the snapshot silently never renders. No snapshot bucket exists yet in
  // infra/ (only the manuals bucket does, named
  // "${name_prefix}-manuals-${account_id}" in infra/modules/knowledge-base) -
  // its domain is account-specific and unknowable before that module is
  // written and applied, which is the Ring plan's job, not this task's. Wire
  // `_meta: { ui: { csp: { resourceDomains: [<snapshot bucket domain>] } } }`
  // onto the visit widget's registerResource call once that bucket exists.
  // snapshotUrl is always null today (service.ts), so this has no present
  // effect - it is a forward pointer, not a regression.
  for (const widget of WIDGETS) {
    server.registerResource(widget.name, widget.uri, { title: widget.title, description: widget.description, mimeType: RESOURCE_MIME_TYPE }, async uri => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: widget.html }]
    }));
  }
}
