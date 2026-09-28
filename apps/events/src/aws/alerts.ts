import type { Alert, Repository } from '@homeledger/core';

/**
 * The one way HomeLedger's own failures become visible: an open, high,
 * deviceless ALERT# row that `recent_events` reads out (spec §3 "never
 * silent", §4 dead letters). Callers publish `alert.raised` if a display
 * should hear it now.
 */
export async function raiseSystemAlert(deps: { repo: Pick<Repository, 'putAlert'>; newId: () => string; now: () => string }, message: string): Promise<Alert> {
  const alert: Alert = {
    id: deps.newId(),
    sensorType: 'system',
    severity: 'high',
    ringDeviceId: null,
    message,
    deviceName: 'HomeLedger',
    at: deps.now(),
    maintenanceRef: null,
    status: 'open'
  };
  await deps.repo.putAlert(alert);
  return alert;
}
