import { describe, expect, it } from 'vitest';
import { AlertSchema, ApplianceSchema, ConnectionSchema, DeviceSchema, SnapshotStatus, VisitSchema } from '../src/domain/schemas.js';

describe('schemas', () => {
  it('accepts a complete appliance', () => {
    const parsed = ApplianceSchema.parse({
      id: 'appl_abcdefghijklmnop',
      name: 'Furnace',
      brand: 'Carrier',
      model: '59SC5A',
      serial: 'X1',
      room: 'Basement',
      category: 'hvac',
      purchasedAt: '2019-10-01',
      warrantyUntil: '2029-10-01',
      manualDocId: null,
      templates: [{ taskType: 'filter_change', intervalDays: 90 }]
    });
    expect(parsed.templates[0]?.intervalDays).toBe(90);
  });
  it('rejects an appliance id with the wrong prefix', () => {
    expect(() =>
      ApplianceSchema.parse({
        id: 'visit_abcdefghijklmnop',
        name: 'x',
        brand: 'x',
        model: 'x',
        serial: null,
        room: 'x',
        category: 'other',
        purchasedAt: null,
        warrantyUntil: null,
        manualDocId: null,
        templates: []
      })
    ).toThrow();
  });
  it('rejects a visit with an unknown status', () => {
    expect(() =>
      VisitSchema.parse({
        id: 'visit_abcdefghijklmnop',
        providerId: 'p1',
        providerName: 'A',
        category: 'plumbing',
        applianceId: 'appl_abcdefghijklmnop',
        issue: 'leak',
        windowStart: '2026-09-20T13:00:00Z',
        windowEnd: '2026-09-20T15:00:00Z',
        status: 'lost',
        ringEventIds: [],
        snapshotKey: null,
        description: null,
        snapshotStatus: null,
        snapshotLatencyMs: null,
        arrivedAt: null,
        createdAt: '2026-09-13T00:00:00Z'
      })
    ).toThrow();
  });
});

describe('Plan 4 schema additions', () => {
  const baseVisit = {
    id: 'visit_abcdefghijklmnop',
    providerId: 'p1',
    providerName: 'A',
    category: 'plumbing',
    applianceId: 'appl_abcdefghijklmnop',
    issue: 'leak',
    windowStart: '2026-09-20T13:00:00Z',
    windowEnd: '2026-09-20T15:00:00Z',
    status: 'arrived',
    ringEventIds: ['req-bp-0001'],
    snapshotKey: 'snapshots/hh_test/visit_abcdefghijklmnop.jpg',
    description: 'A person holding a toolbox stands at the front door.',
    snapshotStatus: 'ok',
    snapshotLatencyMs: 4200,
    arrivedAt: '2026-09-20T13:20:00Z',
    createdAt: '2026-09-13T00:00:00Z'
  };

  it('accepts every snapshot status the spec names, and nothing else', () => {
    expect(SnapshotStatus.options).toEqual(['ok', 'encrypted', 'none-in-window', 'forbidden', 'error']);
    expect(VisitSchema.parse(baseVisit).snapshotStatus).toBe('ok');
    expect(() => VisitSchema.parse({ ...baseVisit, snapshotStatus: 'blurry' })).toThrow();
  });

  it('refuses a negative or fractional snapshot latency', () => {
    expect(() => VisitSchema.parse({ ...baseVisit, snapshotLatencyMs: -1 })).toThrow();
    expect(() => VisitSchema.parse({ ...baseVisit, snapshotLatencyMs: 1.5 })).toThrow();
    expect(VisitSchema.parse({ ...baseVisit, snapshotStatus: null, snapshotLatencyMs: null }).snapshotLatencyMs).toBeNull();
  });

  it('holds a system alert with its own message and no device', () => {
    const parsed = AlertSchema.parse({
      id: 'alert_abcdefghijklmnop',
      sensorType: 'system',
      severity: 'high',
      ringDeviceId: null,
      message: 'Ring access lapsed. Link the Ring account again from the Ring app.',
      deviceName: 'HomeLedger',
      at: '2026-10-06T21:15:00Z',
      maintenanceRef: null,
      status: 'open'
    });
    expect(parsed.sensorType).toBe('system');
    expect(() => AlertSchema.parse({ ...parsed, severity: 'critical' })).toThrow();
  });

  it('keeps a sensor device’s last known flood and freeze state', () => {
    const device = {
      id: 'dev_abcdefghijklmnop',
      ringDeviceId: 'dev-flood-1',
      name: 'Water Heater',
      kind: 'sensor',
      online: true,
      lastSeenAt: null,
      sensorState: { flood: true, freeze: false }
    };
    expect(DeviceSchema.parse(device).sensorState).toEqual({ flood: true, freeze: false });
    expect(() => DeviceSchema.parse({ ...device, sensorState: { flood: 'yes', freeze: false } })).toThrow();
  });

  it('keys a push connection’s expiry in epoch seconds, the unit DynamoDB TTL reads', () => {
    expect(ConnectionSchema.parse({ connectionId: 'Ab1=', connectedAt: '2026-10-06T13:00:00Z', expiresAt: 1791299200 }).expiresAt).toBe(1791299200);
    expect(() => ConnectionSchema.parse({ connectionId: 'Ab1=', connectedAt: '2026-10-06T13:00:00Z', expiresAt: 1.5 })).toThrow();
  });
});
