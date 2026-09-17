import type { ServerContext } from '@modelcontextprotocol/server';

export const AVAILABILITY_TOTAL = 3;

/**
 * Sends one notifications/progress related to the request being handled.
 *
 * A request that did not ask for progress carries no progressToken in
 * ctx.mcpReq._meta, and the spec forbids sending progress in that case, so
 * this is a no-op then. ctx.mcpReq.notify associates the notification with
 * the in-flight request, which is what routes it onto the right stream for
 * both the stateless modern handler and the sessionful legacy transport.
 */
export async function reportProgress(ctx: ServerContext, progress: number, total: number, message: string): Promise<void> {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined) return;
  await ctx.mcpReq.notify({
    method: 'notifications/progress',
    params: { progressToken, progress, total, message }
  });
}

export const AVAILABILITY_STEPS = ['Checking availability', 'Comparing arrival windows', 'Found three windows'] as const;

/**
 * The simulated availability check. Bounded by construction: three equal
 * sleeps summing to totalDelayMs (600 ms on the deployed runtime, 0 in
 * tests), well inside the 3 s per-tool budget.
 */
export async function runAvailabilityCheck(ctx: ServerContext, totalDelayMs: number, providerName: string): Promise<void> {
  const step = Math.max(0, Math.floor(totalDelayMs / AVAILABILITY_TOTAL));
  await reportProgress(ctx, 0, AVAILABILITY_TOTAL, `Checking ${providerName} for openings`);
  for (let i = 0; i < AVAILABILITY_TOTAL; i++) {
    if (step > 0) await new Promise(resolve => setTimeout(resolve, step));
    await reportProgress(ctx, i + 1, AVAILABILITY_TOTAL, AVAILABILITY_STEPS[i]!);
  }
}
