import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ApplianceCategory, TaskType, isOverdue, todayInZone } from '@homeledger/core';
import type { ServerDeps } from '../server.js';
import { speakDate, speakList, taskWords } from '../voice.js';
import { WIDGET_URIS, uiMeta } from '../widgets/index.js';

const WarrantyStatus = z.enum(['active', 'expired', 'unknown']);

export const ApplianceSummary = z.object({
  id: z.string(),
  name: z.string(),
  brand: z.string(),
  model: z.string(),
  room: z.string(),
  category: ApplianceCategory,
  warrantyStatus: WarrantyStatus
});

export function warrantyStatus(warrantyUntil: string | null, today: string): z.infer<typeof WarrantyStatus> {
  if (!warrantyUntil) return 'unknown';
  return warrantyUntil >= today ? 'active' : 'expired';
}

export function registerApplianceTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'list_appliances',
    {
      title: 'List appliances',
      description: 'List the household appliances, optionally filtered by room or category. Use this to find an appliance id before calling other tools.',
      inputSchema: z.object({ room: z.string().optional(), category: ApplianceCategory.optional() }),
      outputSchema: z.object({ appliances: z.array(ApplianceSummary) }),
      annotations: { readOnlyHint: true },
      _meta: uiMeta(WIDGET_URIS.appliances)
    },
    async ({ room, category }) => {
      // The household's today, not UTC's - a warranty does not expire eight
      // hours early because UTC has already rolled over. See maintenance_due.
      const today = todayInZone(deps.now(), await deps.householdTimeZone());
      const rows = await deps.repo.listAppliances({ room, category });
      const appliances = rows.map(a => ({
        id: a.id,
        name: a.name,
        brand: a.brand,
        model: a.model,
        room: a.room,
        category: a.category,
        warrantyStatus: warrantyStatus(a.warrantyUntil, today)
      }));
      return {
        content: [
          {
            type: 'text',
            text: speakList(
              appliances.map(a => a.name),
              'appliance'
            )
          }
        ],
        structuredContent: { appliances }
      };
    }
  );

  server.registerTool(
    'get_appliance',
    {
      title: 'Get appliance',
      description: 'Details for one appliance: warranty state and every maintenance task with its last-done and next-due dates.',
      inputSchema: z.object({ applianceId: z.string() }),
      outputSchema: z.object({
        appliance: ApplianceSummary.extend({ serial: z.string().nullable(), purchasedAt: z.string().nullable(), warrantyUntil: z.string().nullable() }),
        maintenance: z.array(
          z.object({ taskType: TaskType, intervalDays: z.number(), lastDoneAt: z.string().nullable(), nextDueAt: z.string(), overdue: z.boolean() })
        ),
        // Spec 4.2's `manual {docId, title}` row. Nullable-but-always-present
        // rather than optional, the convention get_visit's snapshotUrl and
        // description already set: the appliance widget reads `data.manual`
        // unconditionally, so a missing key and a present-null key must not
        // be two different shapes for "this appliance has no manual".
        //
        // This is also the only reader of the DOC# row scripts/manuals.ts
        // writes (and of appliance.manualDocId, which it points at that row),
        // so without it the whole manuals ingestion path is write-only and
        // nothing in the running system can show whether it wrote a sane row.
        manual: z.object({ docId: z.string(), title: z.string() }).nullable()
      }),
      annotations: { readOnlyHint: true },
      _meta: uiMeta(WIDGET_URIS.appliance)
    },
    async ({ applianceId }) => {
      const today = todayInZone(deps.now(), await deps.householdTimeZone());
      const a = await deps.repo.getAppliance(applianceId);
      if (!a) return { content: [{ type: 'text', text: "I couldn't find that appliance." }], isError: true };
      const maintenance = [];
      for (const t of a.templates) {
        const m = await deps.repo.getMaintenance(a.id, t.taskType);
        if (m)
          maintenance.push({
            taskType: m.taskType,
            intervalDays: m.intervalDays,
            lastDoneAt: m.lastDoneAt,
            nextDueAt: m.nextDueAt,
            overdue: isOverdue(m.nextDueAt, today)
          });
      }
      // Null when the appliance carries no manualDocId, and also when it
      // carries one whose DOC# row has since gone: a dangling pointer is
      // "no manual I can name", not a reason to fail the whole lookup.
      const doc = a.manualDocId ? await deps.repo.getDoc(a.manualDocId) : null;
      const status = warrantyStatus(a.warrantyUntil, today);
      const warrantyText =
        status === 'active' ? `under warranty until ${speakDate(a.warrantyUntil!)}` : status === 'expired' ? 'out of warranty' : 'warranty unknown';
      const dueText =
        maintenance.length === 0
          ? 'No maintenance scheduled.'
          : speakList(
              maintenance.map(m => `${taskWords(m.taskType)} ${m.overdue ? 'overdue since' : 'due'} ${speakDate(m.nextDueAt)}`),
              'task'
            );
      return {
        content: [{ type: 'text', text: `${a.name}, ${a.brand} ${a.model} in the ${a.room}, ${warrantyText}. ${dueText}` }],
        structuredContent: {
          appliance: {
            id: a.id,
            name: a.name,
            brand: a.brand,
            model: a.model,
            room: a.room,
            category: a.category,
            warrantyStatus: status,
            serial: a.serial,
            purchasedAt: a.purchasedAt,
            warrantyUntil: a.warrantyUntil
          },
          maintenance,
          manual: doc ? { docId: doc.id, title: doc.title } : null
        }
      };
    }
  );
}
