import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServerDeps } from '../server.js';
import { speakList } from '../voice.js';

const EventRow = z.object({
  kind: z.enum(['visit', 'door', 'alert']),
  at: z.string(),
  deviceName: z.string().nullable(),
  summary: z.string(),
  visitId: z.string().nullable()
});

export function registerEventTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'recent_events',
    {
      title: 'Recent events',
      description: 'Service visits, front-door events, and sensor alerts from the last N hours (default 24), newest first.',
      inputSchema: z.object({ sinceHours: z.number().int().min(1).max(720).optional() }),
      outputSchema: z.object({ events: z.array(EventRow) }),
      annotations: { readOnlyHint: true }
    },
    async ({ sinceHours }) => {
      const hours = sinceHours ?? 24;
      const since = new Date(new Date(deps.now()).getTime() - hours * 3_600_000).toISOString();
      const [visits, doors, alerts] = await Promise.all([deps.repo.listVisitsSince(since), deps.repo.listEvents(since), deps.repo.listAlerts(since)]);
      const events: z.infer<typeof EventRow>[] = [
        ...visits.map(v => ({
          kind: 'visit' as const,
          at: v.windowStart,
          deviceName: null,
          summary: `${v.providerName} ${v.status === 'scheduled' ? 'is scheduled' : v.status} for the ${v.issue}`,
          visitId: v.id
        })),
        ...doors.map(e => ({
          kind: 'door' as const,
          at: e.at,
          deviceName: e.deviceName,
          summary:
            e.type === 'button_press'
              ? `Someone rang the ${e.deviceName}`
              : `${e.subType === 'human' ? 'A person' : e.subType === 'vehicle' ? 'A vehicle' : 'Motion'} at the ${e.deviceName}`,
          visitId: null
        })),
        ...alerts.map(a => ({
          kind: 'alert' as const,
          at: a.at,
          deviceName: a.deviceName,
          summary: `${a.sensorType} alert from the ${a.deviceName}`,
          visitId: null
        }))
      ].sort((x, y) => y.at.localeCompare(x.at));
      const text =
        events.length === 0
          ? `Nothing happened in the last ${hours} hours.`
          : speakList(
              events.map(e => e.summary),
              'event'
            );
      return { content: [{ type: 'text', text }], structuredContent: { events } };
    }
  );
}
