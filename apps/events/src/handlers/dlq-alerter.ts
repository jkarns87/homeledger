import type { SQSEvent } from 'aws-lambda';
import { createDynamoRepository, newId } from '@homeledger/core';
import { raiseSystemAlert } from '../aws/alerts.js';
import { requireEnv } from '../env.js';

const WHAT: Record<string, string> = {
  button_press: 'A doorbell press could not be processed.',
  motion_detected: 'A doorbell motion event could not be processed.',
  flood_detected: 'A flood or freeze sensor event could not be processed.',
  flood_cleared: 'A flood or freeze sensor event could not be processed.',
  freeze_detected: 'A flood or freeze sensor event could not be processed.',
  freeze_cleared: 'A flood or freeze sensor event could not be processed.',
  'visit.arrived': 'A display update could not be delivered.',
  'alert.raised': 'A display update could not be delivered.'
};

/**
 * Spec §4: a dead-lettered event becomes an ALERT# row. It deliberately does
 * NOT publish alert.raised: a dead letter from the push Lambda would otherwise
 * feed itself.
 */
export function describeDeadLetter(body: string): string {
  let type: unknown;
  try {
    type = (JSON.parse(body) as { 'detail-type'?: unknown })['detail-type'];
  } catch {
    type = undefined;
  }
  const first =
    typeof type === 'string' ? (WHAT[type] ?? `A home event (${type}) could not be processed.`) : 'An unrecognised home event could not be processed.';
  return `${first} It is kept for review.`;
}

export async function handleDeadLetters(deps: { alert: (message: string) => Promise<void> }, bodies: string[]): Promise<number> {
  for (const body of bodies) await deps.alert(describeDeadLetter(body));
  return bodies.length;
}

export const handler = async (event: SQSEvent): Promise<void> => {
  const repo = createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') });
  const n = await handleDeadLetters(
    { alert: async message => void (await raiseSystemAlert({ repo, newId: () => newId('alert'), now: () => new Date().toISOString() }, message)) },
    event.Records.map(r => r.body)
  );
  console.log(JSON.stringify({ msg: 'dlq-alerter', alerts: n }));
};
