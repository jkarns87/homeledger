import { describe, expect, it } from 'vitest';
import { NO_SENSOR_STATE, SENSOR_EVENT_TYPES, SENSOR_TASK_TYPE, advanceMaintenanceForSensor, decideSensorChange, sensorTransitions } from '../src/index.js';
import type { SensorChanged } from '../src/index.js';
import { maintenance } from './repository.contract.js';

const at = '2026-10-06T21:15:00.000Z';

describe('sensor event types (amendment §12.4)', () => {
  it('maps exactly the documented flood, freeze and contact events', () => {
    expect(SENSOR_EVENT_TYPES).toEqual({
      flood_detected: { kind: 'flood', state: 'triggered' },
      flood_cleared: { kind: 'flood', state: 'cleared' },
      freeze_detected: { kind: 'freeze', state: 'triggered' },
      freeze_cleared: { kind: 'freeze', state: 'cleared' },
      contact_sensor_faulted: { kind: 'contact', state: 'triggered' },
      contact_sensor_cleared: { kind: 'contact', state: 'cleared' }
    });
  });
});

describe('sensor transitions (spec §6: emitted on transitions only)', () => {
  it('emits a trigger when a detector goes from false to true, and remembers it', () => {
    const r = sensorTransitions({ ringDeviceId: 'dev-flood-1', previous: NO_SENSOR_STATE, observed: { flood: true }, at, source: 'webhook' });
    expect(r.changes).toEqual([{ ringDeviceId: 'dev-flood-1', kind: 'flood', state: 'triggered', at, source: 'webhook' }]);
    expect(r.next).toEqual({ flood: true, freeze: false });
  });

  it('emits nothing when the observation repeats the known state — a poll after the webhook must not alert twice', () => {
    const r = sensorTransitions({
      ringDeviceId: 'dev-flood-1',
      previous: { flood: true, freeze: false },
      observed: { flood: true, freeze: false },
      at,
      source: 'poll'
    });
    expect(r.changes).toEqual([]);
    expect(r.next).toEqual({ flood: true, freeze: false });
  });

  it('treats flood and freeze independently, both ways at once', () => {
    const r = sensorTransitions({
      ringDeviceId: 'dev-flood-1',
      previous: { flood: true, freeze: false },
      observed: { flood: false, freeze: true },
      at,
      source: 'poll'
    });
    expect(r.changes).toEqual([
      { ringDeviceId: 'dev-flood-1', kind: 'flood', state: 'cleared', at, source: 'poll' },
      { ringDeviceId: 'dev-flood-1', kind: 'freeze', state: 'triggered', at, source: 'poll' }
    ]);
  });

  it('assumes all-clear for a device seen for the first time, so a first dry reading raises nothing', () => {
    expect(sensorTransitions({ ringDeviceId: 'dev-flood-1', previous: null, observed: { flood: false, freeze: false }, at, source: 'poll' }).changes).toEqual(
      []
    );
    expect(sensorTransitions({ ringDeviceId: 'dev-flood-1', previous: null, observed: { flood: true }, at, source: 'poll' }).changes).toHaveLength(1);
  });
});

describe('the rule table (spec §6)', () => {
  const change = (kind: SensorChanged['kind'], state: SensorChanged['state']): SensorChanged => ({
    ringDeviceId: 'dev-flood-1',
    kind,
    state,
    at,
    source: 'webhook'
  });

  it('raises a high alert with a leak check for a flood', () => {
    expect(decideSensorChange(change('flood', 'triggered'), 'Water Heater')).toEqual({
      action: 'raise',
      sensorType: 'flood',
      severity: 'high',
      maintenanceNote: 'Check for a leak near the Water Heater.'
    });
  });

  it('raises a high alert with an insulation check for a freeze', () => {
    expect(decideSensorChange(change('freeze', 'triggered'), 'Water Heater')).toEqual({
      action: 'raise',
      sensorType: 'freeze',
      severity: 'high',
      maintenanceNote: 'Check pipe insulation near the Water Heater.'
    });
  });

  it('raises an informational alert and no maintenance for a contact sensor', () => {
    expect(decideSensorChange(change('contact', 'triggered'), 'Back Door')).toEqual({
      action: 'raise',
      sensorType: 'contact',
      severity: 'info',
      maintenanceNote: null
    });
  });

  it('resolves the open alert on any clear', () => {
    for (const kind of ['flood', 'freeze', 'contact'] as const)
      expect(decideSensorChange(change(kind, 'cleared'), 'Water Heater')).toEqual({ action: 'resolve', sensorType: kind });
  });

  it('never makes a safety claim (spec §7 content rule)', () => {
    for (const kind of ['flood', 'freeze', 'contact'] as const) {
      const d = decideSensorChange(change(kind, 'triggered'), 'Water Heater');
      const note = d.action === 'raise' ? (d.maintenanceNote ?? '') : '';
      expect(note).not.toMatch(/\bsafe\b|danger|emergenc|911|evacuat/i);
    }
  });
});

describe('advancing the maintenance item (spec §6: create or advance)', () => {
  it('creates an inspection due today when none exists', () => {
    expect(SENSOR_TASK_TYPE).toBe('inspection');
    expect(
      advanceMaintenanceForSensor(null, {
        applianceId: 'appl_waterheater22222',
        today: '2026-10-06',
        note: 'Check for a leak near the Water Heater.',
        intervalDays: 180
      })
    ).toEqual({
      applianceId: 'appl_waterheater22222',
      taskType: 'inspection',
      intervalDays: 180,
      lastDoneAt: null,
      nextDueAt: '2026-10-06',
      notes: 'Check for a leak near the Water Heater.'
    });
  });

  it('pulls a later due date forward to today and keeps its history', () => {
    const existing = maintenance({
      applianceId: 'appl_waterheater22222',
      taskType: 'inspection',
      intervalDays: 180,
      lastDoneAt: '2026-03-01',
      nextDueAt: '2026-08-28'
    });
    const later = { ...existing, nextDueAt: '2026-12-01' };
    expect(advanceMaintenanceForSensor(later, { applianceId: 'appl_waterheater22222', today: '2026-10-06', note: 'n', intervalDays: 180 })).toEqual({
      ...later,
      nextDueAt: '2026-10-06',
      notes: 'n'
    });
  });

  it('leaves an already-overdue date alone rather than making it look newer', () => {
    const overdue = maintenance({ applianceId: 'appl_waterheater22222', taskType: 'inspection', nextDueAt: '2026-08-28' });
    expect(advanceMaintenanceForSensor(overdue, { applianceId: 'appl_waterheater22222', today: '2026-10-06', note: 'n', intervalDays: 180 }).nextDueAt).toBe(
      '2026-08-28'
    );
  });
});
