import * as z from 'zod/v4';
import { ApplianceCategory, type ApplianceCategoryValue } from '../domain/schemas.js';

export const ServiceProviderSchema = z.object({
  id: z.string().regex(/^prov_[a-z0-9_]+$/),
  name: z.string().min(1),
  category: ApplianceCategory,
  rating: z.number().min(0).max(5),
  leadTimeDays: z.number().int().nonnegative(),
  phone: z.string().min(1),
  sample: z.literal(true)
});

export type ServiceProvider = z.infer<typeof ServiceProviderSchema>;

/** Elicitation enums may never exceed five options (Alexa+ functional requirements). */
export const MAX_PROVIDER_OPTIONS = 5;

export const SAMPLE_MARKETPLACE_NOTICE =
  'The service-provider marketplace is sample data. These companies, ratings, and phone numbers are invented for the HomeLedger demo and no booking leaves this system.';

/**
 * Invented providers. Names, ratings, and 555 phone numbers are fictional on
 * purpose: this is the one simulated data source in HomeLedger and the README
 * says so. Three to five per appliance category so every elicitation stays
 * inside MAX_PROVIDER_OPTIONS without truncating a real list.
 */
export const SAMPLE_PROVIDERS: ServiceProvider[] = [
  { id: 'prov_northwind_hvac', name: 'Northwind Heating and Air', category: 'hvac', rating: 4.8, leadTimeDays: 2, phone: '555-0101', sample: true },
  { id: 'prov_cedar_climate', name: 'Cedar Climate Services', category: 'hvac', rating: 4.6, leadTimeDays: 3, phone: '555-0102', sample: true },
  { id: 'prov_lakeshore_mech', name: 'Lakeshore Mechanical', category: 'hvac', rating: 4.3, leadTimeDays: 1, phone: '555-0103', sample: true },
  { id: 'prov_fulton_furnace', name: 'Fulton Furnace Co', category: 'hvac', rating: 4.1, leadTimeDays: 4, phone: '555-0104', sample: true },

  { id: 'prov_harbor_line', name: 'Harbor Line Plumbing', category: 'plumbing', rating: 4.9, leadTimeDays: 2, phone: '555-0111', sample: true },
  { id: 'prov_reliable_pipe', name: 'Reliable Pipe and Drain', category: 'plumbing', rating: 4.5, leadTimeDays: 1, phone: '555-0112', sample: true },
  { id: 'prov_two_rivers', name: 'Two Rivers Plumbing', category: 'plumbing', rating: 4.2, leadTimeDays: 3, phone: '555-0113', sample: true },
  { id: 'prov_basin_works', name: 'Basin Works', category: 'plumbing', rating: 3.9, leadTimeDays: 2, phone: '555-0114', sample: true },

  { id: 'prov_kettle_water', name: 'Kettle Creek Water Heaters', category: 'water_heater', rating: 4.7, leadTimeDays: 2, phone: '555-0121', sample: true },
  { id: 'prov_anode_and_co', name: 'Anode and Company', category: 'water_heater', rating: 4.4, leadTimeDays: 3, phone: '555-0122', sample: true },
  { id: 'prov_hotline_tank', name: 'Hotline Tank Service', category: 'water_heater', rating: 4.0, leadTimeDays: 1, phone: '555-0123', sample: true },

  { id: 'prov_spin_cycle', name: 'Spin Cycle Appliance Repair', category: 'laundry', rating: 4.6, leadTimeDays: 3, phone: '555-0131', sample: true },
  { id: 'prov_drumline', name: 'Drumline Laundry Service', category: 'laundry', rating: 4.3, leadTimeDays: 2, phone: '555-0132', sample: true },
  { id: 'prov_westfold', name: 'Westfold Appliance', category: 'laundry', rating: 4.0, leadTimeDays: 4, phone: '555-0133', sample: true },

  { id: 'prov_galley_appl', name: 'Galley Appliance Care', category: 'kitchen', rating: 4.8, leadTimeDays: 2, phone: '555-0141', sample: true },
  { id: 'prov_hearth_home', name: 'Hearth and Home Repair', category: 'kitchen', rating: 4.5, leadTimeDays: 3, phone: '555-0143', sample: true },
  { id: 'prov_coldpoint', name: 'Coldpoint Refrigeration', category: 'kitchen', rating: 4.5, leadTimeDays: 1, phone: '555-0142', sample: true },
  { id: 'prov_pantry_pro', name: 'Pantry Pro Service', category: 'kitchen', rating: 3.8, leadTimeDays: 5, phone: '555-0144', sample: true },

  { id: 'prov_bright_wire', name: 'Bright Wire Electric', category: 'electrical', rating: 4.9, leadTimeDays: 2, phone: '555-0151', sample: true },
  { id: 'prov_conduit_co', name: 'Conduit Company', category: 'electrical', rating: 4.4, leadTimeDays: 3, phone: '555-0152', sample: true },
  { id: 'prov_meridian_amp', name: 'Meridian Amperage', category: 'electrical', rating: 4.0, leadTimeDays: 1, phone: '555-0153', sample: true },

  { id: 'prov_gable_roof', name: 'Gable and Gutter', category: 'exterior', rating: 4.7, leadTimeDays: 4, phone: '555-0161', sample: true },
  { id: 'prov_stonewall', name: 'Stonewall Exteriors', category: 'exterior', rating: 4.3, leadTimeDays: 5, phone: '555-0162', sample: true },
  { id: 'prov_eaves_end', name: 'Eaves End Siding', category: 'exterior', rating: 3.9, leadTimeDays: 3, phone: '555-0163', sample: true },

  { id: 'prov_allworks', name: 'Allworks Home Services', category: 'other', rating: 4.5, leadTimeDays: 3, phone: '555-0171', sample: true },
  { id: 'prov_handy_harbor', name: 'Handy Harbor', category: 'other', rating: 4.2, leadTimeDays: 2, phone: '555-0172', sample: true },
  { id: 'prov_oddjob_crew', name: 'Oddjob Crew', category: 'other', rating: 3.8, leadTimeDays: 1, phone: '555-0173', sample: true }
];

/**
 * Fetch at most MAX_PROVIDER_OPTIONS providers for a given appliance category,
 * sorted by rating (highest first), with ties broken alphabetically by name.
 * This function is total: SAMPLE_PROVIDERS guarantees three to five providers
 * for every ApplianceCategoryValue, so it will never return an empty array.
 */
export function providersForCategory(category: ApplianceCategoryValue): ServiceProvider[] {
  const own = SAMPLE_PROVIDERS.filter(p => p.category === category);
  return [...own].sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name)).slice(0, MAX_PROVIDER_OPTIONS);
}
