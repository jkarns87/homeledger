import { describe, expect, it } from 'vitest';
import { ApplianceCategory } from '../src/domain/schemas.js';
import {
  MAX_PROVIDER_OPTIONS,
  SAMPLE_MARKETPLACE_NOTICE,
  SAMPLE_PROVIDERS,
  ServiceProviderSchema,
  providersForCategory
} from '../src/marketplace/providers.js';

describe('sample provider marketplace', () => {
  it('parses every entry and marks it as sample data', () => {
    for (const p of SAMPLE_PROVIDERS) expect(ServiceProviderSchema.parse(p).sample).toBe(true);
  });

  it('uses unique prov_ ids', () => {
    const ids = SAMPLE_PROVIDERS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => /^prov_[a-z0-9_]+$/.test(id))).toBe(true);
  });

  it('carries three to five providers for every appliance category', () => {
    for (const category of ApplianceCategory.options) {
      const own = SAMPLE_PROVIDERS.filter(p => p.category === category);
      expect(own.length, `category ${category}`).toBeGreaterThanOrEqual(3);
      expect(own.length, `category ${category}`).toBeLessThanOrEqual(5);
    }
  });

  it('offers at most five options, best rating first', () => {
    for (const category of ApplianceCategory.options) {
      const offered = providersForCategory(category);
      expect(offered.length).toBeGreaterThan(0);
      expect(offered.length).toBeLessThanOrEqual(MAX_PROVIDER_OPTIONS);
      for (let i = 1; i < offered.length; i++) expect(offered[i - 1]!.rating).toBeGreaterThanOrEqual(offered[i]!.rating);
    }
  });

  it('offers plumbing providers for a plumbing job', () => {
    expect(providersForCategory('plumbing').every(p => p.category === 'plumbing')).toBe(true);
    expect(providersForCategory('plumbing')[0]?.name).toBe('Harbor Line Plumbing');
  });

  it('states in the notice that the marketplace is simulated', () => {
    expect(SAMPLE_MARKETPLACE_NOTICE).toContain('sample data');
  });
});
