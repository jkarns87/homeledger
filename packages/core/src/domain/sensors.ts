import type { MaintenanceItem, SensorState } from './schemas.js';

export type SensorChangeKind = 'flood' | 'freeze' | 'contact';

/** Spec §6's normalised input. Emitted on transitions only. */
export interface SensorChanged {
  ringDeviceId: string;
  kind: SensorChangeKind;
  state: 'triggered' | 'cleared';
  at: string;
  source: 'webhook' | 'poll';
}

/** Ring's documented sensor event types (amendment §12.4). Tamper and threshold events are stored but not routed. */
export const SENSOR_EVENT_TYPES: Readonly<Record<string, { kind: SensorChangeKind; state: 'triggered' | 'cleared' }>> = {
  flood_detected: { kind: 'flood', state: 'triggered' },
  flood_cleared: { kind: 'flood', state: 'cleared' },
  freeze_detected: { kind: 'freeze', state: 'triggered' },
  freeze_cleared: { kind: 'freeze', state: 'cleared' },
  contact_sensor_faulted: { kind: 'contact', state: 'triggered' },
  contact_sensor_cleared: { kind: 'contact', state: 'cleared' }
};

export const NO_SENSOR_STATE: SensorState = { flood: false, freeze: false };

/** The maintenance task a flood or freeze opens (spec §6: "create or advance"). */
export const SENSOR_TASK_TYPE = 'inspection' as const;

/**
 * Compares one observation — a webhook's single detector, or a poll's two —
 * with the device's last known state. Only differences become changes, which
 * is what lets the webhook adapter and the reconciliation poll share one
 * device row without alerting twice for one trip. A device never seen before
 * is assumed dry and above freezing, so its first all-clear reading is silent.
 */
export function sensorTransitions(input: {
  ringDeviceId: string;
  previous: SensorState | null;
  observed: Partial<SensorState>;
  at: string;
  source: 'webhook' | 'poll';
}): { changes: SensorChanged[]; next: SensorState } {
  const base = input.previous ?? NO_SENSOR_STATE;
  const next: SensorState = { ...base };
  const changes: SensorChanged[] = [];
  for (const kind of ['flood', 'freeze'] as const) {
    const seen = input.observed[kind];
    if (seen === undefined) continue;
    next[kind] = seen;
    if (seen !== base[kind])
      changes.push({ ringDeviceId: input.ringDeviceId, kind, state: seen ? 'triggered' : 'cleared', at: input.at, source: input.source });
  }
  return { changes, next };
}

export type SensorDecision =
  | { action: 'raise'; sensorType: SensorChangeKind; severity: 'high' | 'info'; maintenanceNote: string | null }
  | { action: 'resolve'; sensorType: SensorChangeKind };

/**
 * Spec §6's rule table. The notes describe property and maintenance only —
 * never safety, never reassurance (spec §7 content rule).
 */
export function decideSensorChange(change: SensorChanged, location: string): SensorDecision {
  if (change.state === 'cleared') return { action: 'resolve', sensorType: change.kind };
  switch (change.kind) {
    case 'flood':
      return { action: 'raise', sensorType: 'flood', severity: 'high', maintenanceNote: `Check for a leak near the ${location}.` };
    case 'freeze':
      return { action: 'raise', sensorType: 'freeze', severity: 'high', maintenanceNote: `Check pipe insulation near the ${location}.` };
    case 'contact':
      return { action: 'raise', sensorType: 'contact', severity: 'info', maintenanceNote: null };
  }
}

/**
 * Opens the appliance's inspection, or pulls it forward to today. An item that
 * is already overdue keeps its older date: moving it to today would make an
 * overdue task look newly due.
 */
export function advanceMaintenanceForSensor(
  existing: MaintenanceItem | null,
  input: { applianceId: string; today: string; note: string; intervalDays: number }
): MaintenanceItem {
  if (existing) return { ...existing, nextDueAt: existing.nextDueAt < input.today ? existing.nextDueAt : input.today, notes: input.note };
  return {
    applianceId: input.applianceId,
    taskType: SENSOR_TASK_TYPE,
    intervalDays: input.intervalDays,
    lastDoneAt: null,
    nextDueAt: input.today,
    notes: input.note
  };
}
