import { acceptedContent, inputRequired, type McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { booleanField, elicitOutcome } from '../elicit.js';
import type { ServerDeps } from '../server.js';

const ConfirmSchema = z.object({ confirm: z.boolean() });

export function registerDevTools(server: McpServer, deps: ServerDeps): void {
  if (!deps.devTools) return;
  server.registerTool(
    'echo_confirm',
    {
      title: 'Echo confirm (dev)',
      description: 'Development-only tool that asks the user to confirm a message and echoes the answer. Exercises elicitation on every client generation.',
      inputSchema: z.object({ message: z.string().min(1) }),
      outputSchema: z.object({ confirmed: z.boolean(), message: z.string() })
    },
    async ({ message }, ctx) => {
      if (elicitOutcome(ctx.mcpReq.inputResponses, 'confirm') === 'declined') {
        return { content: [{ type: 'text', text: `Cancelled: ${message}` }], structuredContent: { confirmed: false, message } };
      }
      const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', ConfirmSchema);
      if (!answer) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({ message: `Confirm: ${message}?`, requestedSchema: booleanField('confirm', 'Confirm') })
          }
        });
      }
      return {
        content: [{ type: 'text', text: answer.confirm ? `Confirmed: ${message}` : `Cancelled: ${message}` }],
        structuredContent: { confirmed: answer.confirm, message }
      };
    }
  );
}
