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
import { isOverdue } from '../domain/maintenance.js';
import type { Repository } from './repository.js';

function addDays(isoDate: string, days: number): string {
  return new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export function createMemoryRepository(_householdId: string): Repository {
  let household: Household | null = null;
  const appliances = new Map<string, Appliance>();
  const maintenance = new Map<string, MaintenanceItem>();
  const logs: LogEntry[] = [];
  const docs = new Map<string, Doc>();
  const events = new Map<string, Event>(); // keyed by ringEventId
  const visits = new Map<string, Visit>();
  const alerts: Alert[] = [];
  const devices = new Map<string, Device>();

  return {
    async getHousehold() {
      return household;
    },
    async putHousehold(h) {
      household = h;
    },
    async resetHousehold() {
      household = null;
      appliances.clear();
      maintenance.clear();
      logs.length = 0;
      docs.clear();
      events.clear();
      visits.clear();
      alerts.length = 0;
      devices.clear();
    },
    async putAppliance(a) {
      appliances.set(a.id, a);
    },
    async getAppliance(id) {
      return appliances.get(id) ?? null;
    },
    async listAppliances(filter) {
      return [...appliances.values()]
        .filter(a => (filter?.room ? a.room === filter.room : true))
        .filter(a => (filter?.category ? a.category === filter.category : true))
        .sort((x, y) => x.name.localeCompare(y.name));
    },
    async putMaintenance(m) {
      maintenance.set(`${m.applianceId}#${m.taskType}`, m);
    },
    async getMaintenance(applianceId: string, taskType: TaskTypeValue) {
      return maintenance.get(`${applianceId}#${taskType}`) ?? null;
    },
    async listMaintenanceDue(horizonDays, now) {
      const limit = addDays(now.slice(0, 10), horizonDays);
      return [...maintenance.values()].filter(m => m.nextDueAt <= limit).sort((x, y) => x.nextDueAt.localeCompare(y.nextDueAt));
    },
    async appendLog(e) {
      logs.push(e);
    },
    async listLogs(applianceId, limit) {
      return logs
        .filter(l => l.applianceId === applianceId)
        .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
        .slice(0, limit);
    },
    async putDoc(d) {
      docs.set(d.id, d);
    },
    async getDoc(id) {
      return docs.get(id) ?? null;
    },
    async putEvent(e) {
      if (events.has(e.ringEventId)) return 'duplicate';
      events.set(e.ringEventId, e);
      return 'created';
    },
    async listEvents(sinceIso) {
      return [...events.values()].filter(e => e.at >= sinceIso).sort((x, y) => y.at.localeCompare(x.at));
    },
    async putVisit(v) {
      visits.set(v.id, v);
    },
    async getVisit(id) {
      return visits.get(id) ?? null;
    },
    async listVisitsInWindow(fromIso, toIso) {
      return [...visits.values()].filter(v => v.windowStart <= toIso && v.windowEnd >= fromIso).sort((x, y) => x.windowStart.localeCompare(y.windowStart));
    },
    async listVisitsSince(sinceIso) {
      return [...visits.values()].filter(v => v.windowStart >= sinceIso).sort((x, y) => x.windowStart.localeCompare(y.windowStart));
    },
    async putAlert(a) {
      alerts.push(a);
    },
    async listAlerts(sinceIso) {
      return alerts.filter(a => a.at >= sinceIso).sort((x, y) => y.at.localeCompare(x.at));
    },
    async putDevice(d) {
      devices.set(d.ringDeviceId, d);
    },
    async listDevices() {
      return [...devices.values()].sort((x, y) => x.name.localeCompare(y.name));
    }
  };
}

export { isOverdue };
