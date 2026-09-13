import { describe, expect, it } from 'vitest';
import { ApplianceSchema, VisitSchema } from '../src/domain/schemas.js';

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
        arrivedAt: null,
        createdAt: '2026-09-13T00:00:00Z'
      })
    ).toThrow();
  });
});
