import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { TaskType, computeNextDue, isOverdue, newId } from '@homeledger/core';
import type { ServerDeps } from '../server.js';
import { speakDate, speakList, taskWords } from '../voice.js';

export function registerMaintenanceTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'maintenance_due',
    {
      title: 'Maintenance due',
      description: 'Maintenance tasks that are overdue or due within a horizon (default 30 days), overdue first.',
      inputSchema: z.object({ horizonDays: z.number().int().min(1).max(365).optional() }),
      outputSchema: z.object({
        items: z.array(z.object({ applianceId: z.string(), applianceName: z.string(), taskType: TaskType, nextDueAt: z.string(), overdue: z.boolean() }))
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ horizonDays }) => {
      const today = deps.now().slice(0, 10);
      const rows = await deps.repo.listMaintenanceDue(horizonDays ?? 30, today);
      const names = new Map((await deps.repo.listAppliances()).map(a => [a.id, a.name] as const));
      const items = rows.map(m => ({
        applianceId: m.applianceId,
        applianceName: names.get(m.applianceId) ?? 'Unknown appliance',
        taskType: m.taskType,
        nextDueAt: m.nextDueAt,
        overdue: isOverdue(m.nextDueAt, today)
      }));
      const spoken = speakList(
        items.map(i => `${i.applianceName} ${taskWords(i.taskType)}${i.overdue ? ', overdue since ' : ', due '}${speakDate(i.nextDueAt)}`),
        'task'
      );
      return { content: [{ type: 'text', text: spoken }], structuredContent: { items } };
    }
  );

  server.registerTool(
    'log_maintenance',
    {
      title: 'Log maintenance',
      description: 'Record that a maintenance task was completed today or on a given date. Advances the next due date.',
      inputSchema: z.object({
        applianceId: z.string(),
        taskType: TaskType,
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        notes: z.string().max(500).optional()
      }),
      outputSchema: z.object({ logged: z.boolean(), nextDueAt: z.string() }),
      annotations: { idempotentHint: false }
    },
    async ({ applianceId, taskType, date, notes }) => {
      const a = await deps.repo.getAppliance(applianceId);
      if (!a) return { content: [{ type: 'text', text: "I couldn't find that appliance." }], isError: true };
      const template = a.templates.find(t => t.taskType === taskType);
      if (!template) return { content: [{ type: 'text', text: `The ${a.name.toLowerCase()} doesn't have a ${taskWords(taskType)} task.` }], isError: true };
      const doneAt = date ?? deps.now().slice(0, 10);
      const nextDueAt = computeNextDue(doneAt, template.intervalDays);
      await deps.repo.appendLog({ id: newId('log'), applianceId, taskType, doneAt, notes: notes ?? null, createdAt: deps.now() });
      await deps.repo.putMaintenance({ applianceId, taskType, intervalDays: template.intervalDays, lastDoneAt: doneAt, nextDueAt, notes: notes ?? null });
      return {
        content: [
          { type: 'text', text: `Logged the ${a.name.toLowerCase()} ${taskWords(taskType)} for ${speakDate(doneAt)}. Next one is due ${speakDate(nextDueAt)}.` }
        ],
        structuredContent: { logged: true, nextDueAt }
      };
    }
  );
}
