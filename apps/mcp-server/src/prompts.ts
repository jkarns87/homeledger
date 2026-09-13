import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServerDeps } from './server.js';

const SEASON_TASKS: Record<string, string[]> = {
  spring: ['test the sump pump', 'clean refrigerator coils', 'inspect the water heater for corrosion'],
  summer: ['replace the furnace filter before AC season', 'clean the dishwasher filter'],
  fall: ['schedule the furnace inspection', 'flush the water heater', 'replace the furnace filter'],
  winter: ['check the furnace filter monthly', 'test the sump pump before the thaw']
};

export function registerPrompts(server: McpServer, deps: ServerDeps): void {
  server.registerPrompt(
    'seasonal-checklist',
    {
      title: 'Seasonal checklist',
      description: 'A seasonal home-maintenance checklist built from this household’s appliances.',
      argsSchema: z.object({ season: z.enum(['spring', 'summer', 'fall', 'winter']) })
    },
    async ({ season }) => {
      const appliances = await deps.repo.listAppliances();
      const lines = [
        `Build a ${season} maintenance checklist for this household.`,
        `Appliances: ${appliances.map(a => `${a.name} (${a.brand} ${a.model})`).join('; ')}.`,
        `Typical ${season} tasks: ${SEASON_TASKS[season]!.join('; ')}.`,
        'Return a short numbered list. Skip tasks for appliances the household does not have.'
      ];
      return { messages: [{ role: 'user', content: { type: 'text', text: lines.join('\n') } }] };
    }
  );
}
