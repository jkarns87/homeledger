import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { TaskType, computeNextDue, isOverdue, newId, todayInZone } from '@homeledger/core';
import type { ServerDeps } from '../server.js';
import { speakDate, speakList, taskWords } from '../voice.js';
import { WIDGET_URIS, uiMeta } from '../widgets/index.js';

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
      annotations: { readOnlyHint: true },
      _meta: uiMeta(WIDGET_URIS.calendar)
    },
    async ({ horizonDays }) => {
      // The household's today, not UTC's. `deps.now().slice(0, 10)` - what
      // this was - rolls over to tomorrow at 7 PM Central, so between 7 PM and
      // midnight a task due today was already being called "overdue" to
      // someone whose own calendar still said today.
      const today = todayInZone(deps.now(), await deps.householdTimeZone());
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
      // "Today" means the day it is where the filter was actually changed.
      // `doneAt` is a floating calendar date, so writing the household's day
      // is the correct stored value, not a localised instant - `createdAt`
      // below stays a UTC instant, which is what DynamoDB keeps for times.
      const doneAt = date ?? todayInZone(deps.now(), await deps.householdTimeZone());
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
