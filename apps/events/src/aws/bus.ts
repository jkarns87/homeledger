import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

/** Raw Ring events arrive from the webhook as `ring.webhook`; HomeLedger's own outcomes (visit.arrived, alert.raised) as `homeledger.events`. */
export const RING_SOURCE = 'ring.webhook';
export const HOMELEDGER_SOURCE = 'homeledger.events';

export interface BusEntry {
  source: typeof RING_SOURCE | typeof HOMELEDGER_SOURCE;
  detailType: string;
  detail: Record<string, unknown>;
}

export type EventPublisher = (entries: BusEntry[]) => Promise<void>;

/** PutEvents answers 200 even when entries fail; any failed entry is a failure here, so the webhook answers 500 and Ring retries. */
export function createEventPublisher(busName: string, client: EventBridgeClient = new EventBridgeClient({})): EventPublisher {
  return async entries => {
    const out = await client.send(
      new PutEventsCommand({
        Entries: entries.map(e => ({ EventBusName: busName, Source: e.source, DetailType: e.detailType, Detail: JSON.stringify(e.detail) }))
      })
    );
    const failed = out.FailedEntryCount ?? 0;
    if (failed > 0) {
      const codes = (out.Entries ?? []).map(e => e.ErrorCode).filter((c): c is string => Boolean(c));
      throw new Error(`EventBridge refused ${failed} of ${entries.length} entries: ${codes.join(', ') || 'no error code'}`);
    }
  };
}
