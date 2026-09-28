import type {
  Alert,
  AlertSensorTypeValue,
  Appliance,
  ApplianceCategoryValue,
  Connection,
  Device,
  Doc,
  Event,
  Household,
  LogEntry,
  MaintenanceItem,
  SnapshotStatusValue,
  TaskTypeValue,
  Visit
} from '../domain/schemas.js';

/** What the visit correlator writes back once the snapshot attempt settles (spec §5). */
export interface VisitSnapshot {
  snapshotKey: string | null;
  snapshotStatus: SnapshotStatusValue;
  description: string | null;
  snapshotLatencyMs: number;
}

export interface Repository {
  getHousehold(): Promise<Household | null>;
  putHousehold(h: Household): Promise<void>;
  /** Deletes every item under this repository's household partition (household, appliances, maintenance, logs, docs, events, visits, alerts, devices). Used to make re-seeding idempotent rather than additive. */
  resetHousehold(): Promise<void>;
  putAppliance(a: Appliance): Promise<void>;
  getAppliance(id: string): Promise<Appliance | null>;
  listAppliances(filter?: { room?: string; category?: ApplianceCategoryValue }): Promise<Appliance[]>;
  putMaintenance(m: MaintenanceItem): Promise<void>;
  getMaintenance(applianceId: string, taskType: TaskTypeValue): Promise<MaintenanceItem | null>;
  listMaintenanceDue(horizonDays: number, now: string): Promise<MaintenanceItem[]>;
  appendLog(e: LogEntry): Promise<void>;
  listLogs(applianceId: string, limit: number): Promise<LogEntry[]>;
  putDoc(d: Doc): Promise<void>;
  getDoc(id: string): Promise<Doc | null>;
  putEvent(e: Event): Promise<'created' | 'duplicate'>;
  listEvents(sinceIso: string): Promise<Event[]>;
  putVisit(v: Visit): Promise<void>;
  getVisit(id: string): Promise<Visit | null>;
  listVisitsInWindow(fromIso: string, toIso: string): Promise<Visit[]>;
  listVisitsSince(sinceIso: string): Promise<Visit[]>;
  putAlert(a: Alert): Promise<void>;
  listAlerts(sinceIso: string): Promise<Alert[]>;
  putDevice(d: Device): Promise<void>;
  listDevices(): Promise<Device[]>;
  getDevice(ringDeviceId: string): Promise<Device | null>;
  /**
   * Records one webhook delivery (spec §4 step 3). 'new': first sight; marker
   * and row written together. 'retry': seen before but never published; the
   * row is rewritten and the caller publishes again. 'published': already on
   * the bus; the caller answers 200 and stops.
   */
  claimEvent(e: Event): Promise<'new' | 'retry' | 'published'>;
  markEventPublished(ringEventId: string): Promise<void>;
  /** scheduled -> arrived, conditionally: a press and a motion event for the same arrival produce one 'arrived'. */
  markVisitArrived(visitId: string, arrivedAt: string, ringEventId: string): Promise<'arrived' | 'not-scheduled'>;
  /** Throws `No visit <id>` when the visit does not exist. */
  recordVisitSnapshot(visitId: string, snapshot: VisitSnapshot): Promise<void>;
  findOpenAlert(ringDeviceId: string, sensorType: AlertSensorTypeValue): Promise<Alert | null>;
  putConnection(c: Connection): Promise<void>;
  deleteConnection(connectionId: string): Promise<void>;
  /** Connections whose expiresAt is after `nowEpochSeconds`. TTL deletion lags by up to two days, so expiry is enforced on read. */
  listConnections(nowEpochSeconds: number): Promise<Connection[]>;
}
