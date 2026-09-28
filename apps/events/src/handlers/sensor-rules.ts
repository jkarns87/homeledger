import type { EventBridgeEvent } from 'aws-lambda';
import {
  SEED_TIMEZONE,
  SENSOR_EVENT_TYPES,
  SENSOR_TASK_TYPE,
  advanceMaintenanceForSensor,
  createDynamoRepository,
  decideSensorChange,
  derivedId,
  newId,
  pushPayload,
  sensorTransitions,
  todayInZone,
  type Alert,
  type Repository,
  type SensorChanged,
  type SensorState
} from '@homeledger/core';
import { HOMELEDGER_SOURCE, createEventPublisher, type EventPublisher } from '../aws/bus.js';
import { flagEnv, requireEnv } from '../env.js';
import type { RingEventDetail } from './visit-correlator.js';

export interface SensorDeps {
  repo: Pick<Repository, 'getDevice' | 'putDevice' | 'putAlert' | 'findOpenAlert' | 'getMaintenance' | 'putMaintenance' | 'getAppliance'>;
  publish: EventPublisher;
  newAlertId: () => string;
  today: () => Promise<string>;
  sensorApplianceId: string;
}

export interface SensorObservation {
  ringDeviceId: string;
  deviceName: string;
  observed: Partial<SensorState>;
  at: string;
  source: 'webhook' | 'poll';
}

export interface SensorOutcome {
  raised: string[];
  resolved: string[];
}

const DEFAULT_INSPECTION_DAYS = 180;

export function householdToday(repo: Pick<Repository, 'getHousehold'>, now: () => string): () => Promise<string> {
  return async () => todayInZone(now(), (await repo.getHousehold())?.timezone ?? SEED_TIMEZONE);
}

async function applyChange(deps: SensorDeps, change: SensorChanged, location: string, out: SensorOutcome): Promise<void> {
  const decision = decideSensorChange(change, location);
  if (decision.action === 'resolve') {
    const open = await deps.repo.findOpenAlert(change.ringDeviceId, decision.sensorType);
    if (open) {
      await deps.repo.putAlert({ ...open, status: 'resolved' });
      out.resolved.push(open.id);
    }
    return;
  }
  // Idempotent raise: an open alert of this type for this device already covers it.
  if (await deps.repo.findOpenAlert(change.ringDeviceId, decision.sensorType)) return;
  let maintenanceRef: Alert['maintenanceRef'] = null;
  if (decision.maintenanceNote) {
    const appliance = await deps.repo.getAppliance(deps.sensorApplianceId);
    const intervalDays = appliance?.templates.find(t => t.taskType === SENSOR_TASK_TYPE)?.intervalDays ?? DEFAULT_INSPECTION_DAYS;
    const existing = await deps.repo.getMaintenance(deps.sensorApplianceId, SENSOR_TASK_TYPE);
    await deps.repo.putMaintenance(
      advanceMaintenanceForSensor(existing, { applianceId: deps.sensorApplianceId, today: await deps.today(), note: decision.maintenanceNote, intervalDays })
    );
    maintenanceRef = { applianceId: deps.sensorApplianceId, taskType: SENSOR_TASK_TYPE };
  }
  const alert: Alert = {
    id: deps.newAlertId(),
    sensorType: decision.sensorType,
    severity: decision.severity,
    ringDeviceId: change.ringDeviceId,
    message: null,
    deviceName: location,
    at: change.at,
    maintenanceRef,
    status: 'open'
  };
  await deps.repo.putAlert(alert);
  await deps.publish([{ source: HOMELEDGER_SOURCE, detailType: 'alert.raised', detail: pushPayload('alert.raised', alert.id) }]);
  out.raised.push(alert.id);
}

/** Both adapters end here (R2). The device's new state is written last, so a failure part-way repeats the transition on retry rather than losing it. */
export async function applySensorObservation(deps: SensorDeps, obs: SensorObservation): Promise<SensorOutcome> {
  const device = await deps.repo.getDevice(obs.ringDeviceId);
  const { changes, next } = sensorTransitions({
    ringDeviceId: obs.ringDeviceId,
    previous: device?.sensorState ?? null,
    observed: obs.observed,
    at: obs.at,
    source: obs.source
  });
  const location = device?.name ?? obs.deviceName;
  const out: SensorOutcome = { raised: [], resolved: [] };
  for (const change of changes) await applyChange(deps, change, location, out);
  await deps.repo.putDevice({
    ...(device ?? { id: derivedId('dev', obs.ringDeviceId), ringDeviceId: obs.ringDeviceId, name: obs.deviceName, online: true, lastSeenAt: null }),
    kind: 'sensor',
    sensorState: next,
    lastSeenAt: obs.at
  });
  return out;
}

/** The webhook adapter: one Ring sensor event. Contact sensors carry no stored state (fixtures only in v1), so their change is applied directly. */
export async function handleSensorEvent(
  deps: SensorDeps & { enabled: boolean },
  detail: RingEventDetail
): Promise<SensorOutcome | 'disabled' | 'not-a-sensor-event'> {
  if (!deps.enabled) return 'disabled';
  const mapped = SENSOR_EVENT_TYPES[detail.type];
  if (!mapped || !detail.deviceId) return 'not-a-sensor-event';
  if (mapped.kind === 'contact') {
    const out: SensorOutcome = { raised: [], resolved: [] };
    await applyChange(deps, { ringDeviceId: detail.deviceId, kind: 'contact', state: mapped.state, at: detail.at, source: 'webhook' }, detail.deviceName, out);
    return out;
  }
  return applySensorObservation(deps, {
    ringDeviceId: detail.deviceId,
    deviceName: detail.deviceName,
    observed: { [mapped.kind]: mapped.state === 'triggered' },
    at: detail.at,
    source: 'webhook'
  });
}

export function liveSensorDeps(): SensorDeps & { enabled: boolean } {
  const repo = createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') });
  return {
    repo,
    publish: createEventPublisher(requireEnv('EVENT_BUS_NAME')),
    newAlertId: () => newId('alert'),
    today: householdToday(repo, () => new Date().toISOString()),
    sensorApplianceId: requireEnv('SENSOR_APPLIANCE_ID'),
    enabled: flagEnv('SENSORS_ENABLED')
  };
}

let live: (SensorDeps & { enabled: boolean }) | undefined;

export const handler = async (event: EventBridgeEvent<string, RingEventDetail>): Promise<void> => {
  live ??= liveSensorDeps();
  const outcome = await handleSensorEvent(live, event.detail);
  console.log(JSON.stringify({ msg: 'sensor-rules', trigger: event['detail-type'], requestId: event.detail.requestId, outcome }));
};
