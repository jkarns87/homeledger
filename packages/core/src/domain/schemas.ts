import * as z from 'zod/v4';
import { TimeZone } from './time.js';

const prefixed = (p: string) => z.string().regex(new RegExp(`^${p}_[a-z2-7]{16}$`));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoDateTime = z.string().datetime();

export const ApplianceCategory = z.enum(['hvac', 'water_heater', 'laundry', 'kitchen', 'plumbing', 'electrical', 'exterior', 'other']);
export const TaskType = z.enum(['filter_change', 'inspection', 'flush', 'clean', 'service', 'replace_part', 'test']);

export const MaintenanceTemplateSchema = z.object({ taskType: TaskType, intervalDays: z.number().int().positive() });

export const ApplianceSchema = z.object({
  id: prefixed('appl'),
  name: z.string().min(1),
  brand: z.string().min(1),
  model: z.string().min(1),
  serial: z.string().nullable(),
  room: z.string().min(1),
  category: ApplianceCategory,
  purchasedAt: isoDate.nullable(),
  warrantyUntil: isoDate.nullable(),
  manualDocId: prefixed('doc').nullable(),
  templates: z.array(MaintenanceTemplateSchema)
});

export const MaintenanceItemSchema = z.object({
  applianceId: prefixed('appl'),
  taskType: TaskType,
  intervalDays: z.number().int().positive(),
  lastDoneAt: isoDate.nullable(),
  nextDueAt: isoDate,
  notes: z.string().nullable()
});

export const LogEntrySchema = z.object({
  id: prefixed('log'),
  applianceId: prefixed('appl'),
  taskType: TaskType,
  doneAt: isoDate,
  notes: z.string().nullable(),
  createdAt: isoDateTime
});

export const DocSchema = z.object({
  id: prefixed('doc'),
  applianceId: prefixed('appl'),
  title: z.string().min(1),
  s3Key: z.string().min(1),
  pages: z.number().int().nonnegative().nullable(),
  kbSync: z.object({ status: z.enum(['pending', 'synced', 'failed']), at: isoDateTime.nullable() })
});

export const VisitStatus = z.enum(['scheduled', 'arrived', 'completed', 'missed']);
export const VisitSchema = z.object({
  id: prefixed('visit'),
  providerId: z.string().min(1),
  providerName: z.string().min(1),
  category: ApplianceCategory,
  applianceId: prefixed('appl'),
  issue: z.string().min(1),
  windowStart: isoDateTime,
  windowEnd: isoDateTime,
  status: VisitStatus,
  ringEventIds: z.array(z.string()),
  snapshotKey: z.string().nullable(),
  description: z.string().nullable(),
  arrivedAt: isoDateTime.nullable(),
  createdAt: isoDateTime
});

export const EventSchema = z.object({
  id: prefixed('evt'),
  ringEventId: z.string().min(1),
  type: z.string().min(1),
  subType: z.string().nullable(),
  deviceId: z.string().min(1),
  deviceName: z.string().min(1),
  at: isoDateTime,
  rawS3Key: z.string().nullable()
});

export const AlertSchema = z.object({
  id: prefixed('alert'),
  sensorType: z.enum(['flood', 'freeze', 'contact', 'temperature', 'air_quality']),
  deviceName: z.string().min(1),
  at: isoDateTime,
  maintenanceRef: z.object({ applianceId: prefixed('appl'), taskType: TaskType }).nullable(),
  status: z.enum(['open', 'acknowledged', 'resolved'])
});

export const DeviceSchema = z.object({
  id: prefixed('dev'),
  ringDeviceId: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['doorbell', 'camera', 'sensor', 'chime', 'other']),
  online: z.boolean(),
  lastSeenAt: isoDateTime.nullable()
});

/**
 * `timezone` is the household's own clock, and every human-facing time in the
 * system renders in it (spec section 4.2). An IANA NAME, never an offset:
 * offsets are frozen, so a window booked in September for a visit in November
 * would read an hour wrong once the zone leaves daylight saving. `TimeZone`
 * refuses offsets and unknown names, and `putHousehold` parses this schema, so
 * a bad zone is rejected at the write rather than discovered as a wrong clock
 * time later. Stored instants stay UTC; only rendering localises.
 */
export const HouseholdSchema = z.object({
  id: z.string().regex(/^hh_[a-z0-9_]+$/),
  name: z.string().min(1),
  timezone: TimeZone
});

export type Appliance = z.infer<typeof ApplianceSchema>;
export type MaintenanceItem = z.infer<typeof MaintenanceItemSchema>;
export type LogEntry = z.infer<typeof LogEntrySchema>;
export type Doc = z.infer<typeof DocSchema>;
export type Visit = z.infer<typeof VisitSchema>;
export type Event = z.infer<typeof EventSchema>;
export type Alert = z.infer<typeof AlertSchema>;
export type Device = z.infer<typeof DeviceSchema>;
export type Household = z.infer<typeof HouseholdSchema>;
export type TaskTypeValue = z.infer<typeof TaskType>;
export type ApplianceCategoryValue = z.infer<typeof ApplianceCategory>;
