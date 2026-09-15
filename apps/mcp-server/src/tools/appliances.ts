import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ApplianceCategory, TaskType, isOverdue } from '@homeledger/core';
import type { ServerDeps } from '../server.js';
import { speakDate, speakList, taskWords } from '../voice.js';

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
      annotations: { readOnlyHint: true }
    },
    async ({ room, category }) => {
      const today = deps.now().slice(0, 10);
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
        )
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ applianceId }) => {
      const today = deps.now().slice(0, 10);
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
          maintenance
        }
      };
    }
  );
}
