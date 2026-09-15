import type {
  Alert,
  Appliance,
  ApplianceCategoryValue,
  Device,
  Doc,
  Event,
  Household,
  LogEntry,
  MaintenanceItem,
  TaskTypeValue,
  Visit
} from '../domain/schemas.js';

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
}
