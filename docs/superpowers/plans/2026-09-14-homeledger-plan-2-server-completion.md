# HomeLedger Plan 2: Server Completion — Tools, Retrieval, Widgets

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the HomeLedger MCP server's tool surface — `ask_manual`, `book_service` (multi round-trip elicitation with progress), `get_visit` — behind a real Bedrock Knowledge Base over S3 Vectors, with the four `ui://` MCP Apps widgets, all proven on both client generations and on the deployed AgentCore runtime.

**Architecture:** `packages/core` gains a static sample provider marketplace and a `ManualRetriever` port with two adapters (an in-memory fixture for tests, a Bedrock Knowledge Base `Retrieve` client with a 10-minute per-question cache for production). `apps/mcp-server` gains three tools registered in the frozen order after `recent_events`, a typed elicitation-narrowing helper shared with the existing `echo_confirm` dev tool, a signed `requestState` codec for cross-round booking state, and four single-file HTML widgets served as `ui://` resources and referenced from tools through `_meta.ui.resourceUri`. Terraform gains a `knowledge-base` module (manuals bucket, S3 Vectors bucket and index, Bedrock Knowledge Base with an S3 data source, KB service role) wired into the existing `infra/live/demo/platform` root, and the runtime's execution role gains `bedrock:Retrieve`.

**Tech Stack:** Node 22, pnpm 10, TypeScript 5.9 (ESM, NodeNext), Zod 4.2+ (`import * as z from 'zod/v4'`), `@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/client` 2.0.0, `@modelcontextprotocol/sdk` 1.30.0 (legacy client), `@modelcontextprotocol/ext-apps` 2.0.0 (MCP Apps server helpers and constants), `@aws-sdk/client-bedrock-agent-runtime` 3.x (`Retrieve`), `@aws-sdk/client-bedrock-agent` 3.x (ingestion jobs), `@aws-sdk/client-s3` 3.x, Vitest 3, Terraform >= 1.10 with `hashicorp/aws >= 6.21.0, < 7.0.0` (6.64.0 in the committed lockfile).

**Spec:** `docs/superpowers/specs/2026-09-13-homeledger-design.md` (sections 4.1, 4.2 rows `ask_manual` / `book_service` / `get_visit`, 4.3, 4.4, 4.6, 5, 8, 9)

**Predecessor:** `docs/superpowers/plans/2026-09-13-homeledger-plan-1-foundation.md` — read its "What Plan 2 starts from" section. Everything it lists is on the branch and deployed.

## Global Constraints

- Node `>=22.0.0`; pnpm `10.15.0`; every package `"type": "module"`.
- Zod `^4.2.0`, imported as `import * as z from 'zod/v4'`. Never `from 'zod'`.
- `@modelcontextprotocol/server` v2 patterns already used in the repo: `server.registerTool(name, config, cb)`, `server.registerResource(name, uri, config, cb)`, `inputRequired(...)` / `inputRequired.elicit(...)` / `acceptedContent(...)` from the same package.
- Every tool declares `outputSchema`. `content[0].text` is spoken text with **no JSON** (`hasJson()` must be `false` for it). `structuredContent` validates against the declared `outputSchema`.
- Voice text lists at most five items (`VOICE_MAX_ITEMS = 5`). Elicitation enums never exceed five options (`MAX_PROVIDER_OPTIONS = 5`).
- Tool handlers respond in under 3 s. The only bounded delay in this plan is `book_service`'s simulated availability check, default 600 ms total, `0` in tests.
- **Tool order is frozen after the first deploy.** The deployed order is `list_appliances, get_appliance, maintenance_due, log_maintenance, recent_events, echo_confirm`. Plan 2 appends the three new tools in the order `ask_manual, book_service, get_visit` and keeps `echo_confirm` last, gated by `devTools`. Final order:
  `list_appliances, get_appliance, maintenance_due, log_maintenance, recent_events, ask_manual, book_service, get_visit, echo_confirm`
  Every order assertion in `apps/mcp-server/test/tools.test.ts`, `apps/mcp-server/test/legacy.test.ts`, and `scripts/smoke.ts` is updated in the task that adds a tool.
- IDs are prefixed and stable (`appl_`, `visit_`, `doc_`, `alert_`, `evt_`, `log_`, `dev_`); provider ids use the literal `prov_` prefix and are sample data, not `newId()` output. Household ID comes only from `HOUSEHOLD_ID`; no request may override it.
- Terraform: reusable modules under `infra/modules/<name>/` with `main.tf`, `variables.tf` (typed, described, validated), `outputs.tf` (described), `versions.tf` (`required_providers` only — the module's `versions.tf` carries no `provider` block — pinned `>= 6.21.0, < 7.0.0`), `README.md` generated with terraform-docs, and `tests/*.tftest.hcl` using `mock_provider "aws"` with `command = plan`. The only root is `infra/live/demo/platform/`.
- **Never run `terraform plan` or `terraform apply` locally.** Locally only `terraform fmt`, `terraform init -backend=false`, `terraform validate`, and `terraform test` are permitted. Applies run through `gh workflow run deploy.yml --ref <branch>`; the deployed smoke runs through `gh workflow run smoke.yml --ref <branch>`. The `image_uri` two-pass behavior and the `deployed_image_uri` output stay exactly as they are. `.terraform.lock.hcl` is committed for every root and module.
- Commit after every task with a plain conventional-commit message. **No trailers of any kind** — no `Co-Authored-By`, no generated-by lines.
- Any deviation from documented behavior gets a `FRICTION-LOG.md` entry, in the existing field format (`- **Expected:** / - **Actual:** / - **Impact:** / - **Workaround / decision:** / - **Source:** / - **Status:**`), committed together with the workaround. **The last entry in the file is FL-023 (seed idempotency, filed during Plan 1's final fix round), so the next free number is FL-024.** The numbers named in the tasks below were estimated from FL-023 and are therefore one low; always take the lowest free number at the time you file and say so in the commit body.
- Seed data is deterministic: `SEED_APPLIANCES` in `packages/core/src/seed/household.ts` carries fixed `appl_` ids and `SEED_APPLIANCE_COUNT` exports the count; `Repository.resetHousehold()` clears a household partition; `.github/workflows/smoke.yml` runs reset-then-seed before `pnpm smoke`. Tests, fixtures, and the smoke reference seeded appliances by their fixed ids or by `SEED_APPLIANCES`, never by name lookup. Adding a seed appliance means hand-assigning an id that satisfies `ApplianceSchema`'s id pattern.
- Host-header validation is off on the deployed runtime (`ALLOWED_HOSTS="*"`; Terraform `allowed_hosts` defaults to `*`) because AgentCore forwards an internal, cell-specific Host and the JWT authorizer is the access control; local runs keep the SDK default list. Never add hostnames to the allowlist to make the runtime work.
- Secrets never live in the repo. `sensitive` Terraform outputs still land in state, so prefer Secrets Manager with write-only arguments, as `infra/modules/cognito-m2m` does with `secret_string_wo` / `secret_string_wo_version`.
- Prettier config is `{ "singleQuote": true, "printWidth": 160, "trailingComma": "none", "arrowParens": "avoid" }`. `pnpm format` runs in CI; run `pnpm format:write` before committing if it complains.
- `@homeledger/core` is consumed through its built `dist/`, so run `pnpm --filter @homeledger/core build` after changing core and before typechecking or testing `apps/mcp-server` or `scripts`.

## Out of scope (their own plans)

The Next.js simulator and the Strands agent; the Ring account-link, webhook, correlator, snapshot and push pipeline; the `skills/homeledger` Agent Skill package; video and submission assets. `get_visit` returns `snapshotUrl` and `description` as `null` here; the Ring plan fills them.

---

## File structure

```
packages/core/src/
├── marketplace/providers.ts        # NEW  sample provider marketplace (labelled sample data)
├── retrieval/retriever.ts          # NEW  ManualRetriever port + Passage type
├── retrieval/fixture.ts            # NEW  in-memory retriever + SAMPLE_MANUAL_PASSAGES
├── retrieval/bedrock.ts            # NEW  Bedrock Knowledge Base retriever, 10-minute cache
└── index.ts                        # MOD  re-export the three new modules

packages/core/test/
├── providers.test.ts               # NEW
├── retrieval.test.ts               # NEW  fixture retriever
├── bedrock-retriever.test.ts       # NEW  stubbed Retrieve sender
└── repository.contract.ts          # MOD  visit update, alert, device cases

apps/mcp-server/src/
├── server.ts                       # MOD  ServerDeps gains retriever/requestStateKey/availabilityDelayMs; codec; registration order
├── voice.ts                        # MOD  speakList dead branch removed; taskWords; speakWeekdayDate; speakClockRange
├── elicit.ts                       # NEW  typed narrowing over inputResponse()
├── progress.ts                     # NEW  reportProgress(ctx, n, total, message)
├── deps.ts                         # MOD  retriever selection, REQUEST_STATE_KEY, AVAILABILITY_DELAY_MS
├── resources.ts                    # MOD  register the four ui:// widget resources
├── tools/manual.ts                 # NEW  ask_manual
├── tools/service.ts                # NEW  book_service, get_visit
├── tools/appliances.ts             # MOD  taskWords import, _meta.ui.resourceUri
├── tools/maintenance.ts            # MOD  taskWords import, _meta.ui.resourceUri
├── tools/dev.ts                    # MOD  use the shared elicit helper instead of the unchecked cast
└── widgets/
    ├── index.ts                    # NEW  WIDGET_URIS, WIDGETS, uiMeta()
    ├── shell.ts                    # NEW  WIDGET_CSS + BRIDGE_SCRIPT + page()
    ├── appliances.ts               # NEW  ui://homeledger/appliances
    ├── appliance.ts                # NEW  ui://homeledger/appliance
    ├── calendar.ts                 # NEW  ui://homeledger/calendar
    └── visit.ts                    # NEW  ui://homeledger/visit

apps/mcp-server/test/
├── harness.ts                      # MOD  new ServerDeps fields; modernElicitClient()
├── tools.test.ts                   # MOD  order assertions
├── legacy.test.ts                  # MOD  order assertion
├── manual.test.ts                  # NEW  ask_manual
├── book-service-modern.test.ts     # NEW  MRTR on the v2 in-process client
├── book-service-legacy.test.ts     # NEW  legacy shim over a real socket
├── progress.test.ts                # NEW  progress 0→3 on both generations
├── visits.test.ts                  # NEW  get_visit
└── widgets.test.ts                 # NEW  ui:// resources + _meta.ui.resourceUri

scripts/
├── manuals.ts                      # NEW  upload PDF + metadata, start ingestion, wait
├── seed-manual.ts                  # NEW  generate + upload the smoke test document
├── smoke.ts                        # MOD  tool order, legacy book_service, ask_manual
└── package.json                    # MOD  S3 + bedrock-agent clients, new scripts

infra/
├── modules/knowledge-base/         # NEW  manuals bucket, S3 Vectors, KB, data source, KB role
│   ├── main.tf  variables.tf  outputs.tf  versions.tf  README.md
│   └── tests/knowledge-base.tftest.hcl
├── modules/agentcore-runtime/      # MOD  knowledge_base_arn variable + bedrock:Retrieve statement
└── live/demo/platform/             # MOD  module call, REQUEST_STATE_KEY, KNOWLEDGE_BASE_ID, outputs, tests

.github/workflows/smoke.yml         # MOD  seed the test manual before pnpm smoke
README.md                           # MOD  sample-data disclosure, manuals workflow, widgets
FRICTION-LOG.md                     # MOD  FL-023 onwards
```

---

### Task 1: Sample provider marketplace in `packages/core`

**Files:**
- Create: `packages/core/src/marketplace/providers.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/providers.test.ts`

**Interfaces:**
- Consumes: `ApplianceCategory`, `ApplianceCategoryValue` from `packages/core/src/domain/schemas.ts`.
- Produces:
  ```ts
  export const ServiceProviderSchema: z.ZodObject<...>;
  export type ServiceProvider = { id: string; name: string; category: ApplianceCategoryValue; rating: number; leadTimeDays: number; phone: string; sample: true };
  export const SAMPLE_PROVIDERS: ServiceProvider[];
  export const MAX_PROVIDER_OPTIONS = 5;
  export const SAMPLE_MARKETPLACE_NOTICE: string;
  export function providersForCategory(category: ApplianceCategoryValue): ServiceProvider[];
  ```
  `providersForCategory` returns at most `MAX_PROVIDER_OPTIONS`, highest rating first, ties broken by name, and falls back to the `other` pool when a category has no providers of its own.

- [ ] **Step 1: Write the failing test**

`packages/core/test/providers.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ApplianceCategory } from '../src/domain/schemas.js';
import { MAX_PROVIDER_OPTIONS, SAMPLE_MARKETPLACE_NOTICE, SAMPLE_PROVIDERS, ServiceProviderSchema, providersForCategory } from '../src/marketplace/providers.js';

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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @homeledger/core test -- providers`
Expected: FAIL, cannot find module `../src/marketplace/providers.js`.

- [ ] **Step 3: Implement the marketplace**

`packages/core/src/marketplace/providers.ts`:
```ts
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
  { id: 'prov_coldpoint', name: 'Coldpoint Refrigeration', category: 'kitchen', rating: 4.5, leadTimeDays: 1, phone: '555-0142', sample: true },
  { id: 'prov_hearth_home', name: 'Hearth and Home Repair', category: 'kitchen', rating: 4.1, leadTimeDays: 3, phone: '555-0143', sample: true },
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

export function providersForCategory(category: ApplianceCategoryValue): ServiceProvider[] {
  const own = SAMPLE_PROVIDERS.filter(p => p.category === category);
  const pool = own.length > 0 ? own : SAMPLE_PROVIDERS.filter(p => p.category === 'other');
  return [...pool].sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name)).slice(0, MAX_PROVIDER_OPTIONS);
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from './marketplace/providers.js';
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @homeledger/core test -- providers && pnpm --filter @homeledger/core typecheck`
Expected: PASS (6 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): sample service-provider marketplace"
```

---

### Task 2: Visit, alert, and device cases in the shared repository contract

**Files:**
- Modify: `packages/core/test/repository.contract.ts`

**Interfaces:**
- Consumes: the `Repository` interface as it already stands in `packages/core/src/repo/repository.ts` — no production code changes in this task.
- Produces: three new contract cases that both `packages/core/test/memory.test.ts` and `packages/core/test/dynamo.test.ts` inherit unchanged, plus exported `alert()` and `device()` builders alongside the existing `appliance()`, `maintenance()`, `visit()`, `event()` builders.

This closes the Plan 1 review finding that the contract suite never exercised `listAlerts`, `listDevices`, or `putDevice`, and it pins the `putVisit` / `getVisit` / `listVisitsSince` behaviour `book_service` and `get_visit` depend on before either tool exists.

- [ ] **Step 1: Add the two new builders**

Insert into `packages/core/test/repository.contract.ts`, immediately after the existing `event` builder and before `export function runRepositoryContract`:
```ts
export const alert = (over: Partial<Alert> = {}): Alert => ({
  id: 'alert_aaaaaaaaaaaaaaaa',
  sensorType: 'freeze',
  deviceName: 'Garage sensor',
  at: '2026-09-22T03:00:00.000Z',
  maintenanceRef: null,
  status: 'open',
  ...over
});

export const device = (over: Partial<Device> = {}): Device => ({
  id: 'dev_aaaaaaaaaaaaaaaa',
  ringDeviceId: 'ava1.ring.device.1',
  name: 'Front Door',
  kind: 'doorbell',
  online: true,
  lastSeenAt: '2026-09-22T13:00:00.000Z',
  ...over
});
```

Widen the type import at the top of the same file to:
```ts
import type { Alert, Appliance, Device, Event, MaintenanceItem, Visit } from '../src/domain/schemas.js';
```

- [ ] **Step 2: Write the three failing cases**

Append inside `runRepositoryContract`'s `describe` block, after the existing `'appends and lists logs newest first'` case:
```ts
    it('replaces a visit in place and reads the new state back', async () => {
      await repo.putVisit(visit());
      await repo.putVisit(visit({ status: 'arrived', arrivedAt: '2026-09-22T13:20:00.000Z', snapshotKey: 'snapshots/hh_test/visit_a.jpg', description: 'A person in a blue jacket at the door.', ringEventIds: ['ring-evt-1'] }));
      const after = await repo.getVisit('visit_aaaaaaaaaaaaaaaa');
      expect(after?.status).toBe('arrived');
      expect(after?.arrivedAt).toBe('2026-09-22T13:20:00.000Z');
      expect(after?.snapshotKey).toBe('snapshots/hh_test/visit_a.jpg');
      expect(after?.description).toBe('A person in a blue jacket at the door.');
      expect(after?.ringEventIds).toEqual(['ring-evt-1']);
      expect((await repo.listVisitsSince('2026-09-22T00:00:00.000Z')).length).toBe(1);
      expect(await repo.getVisit('visit_zzzzzzzzzzzzzzzz')).toBeNull();
    });

    it('stores alerts and lists them newest first within a window', async () => {
      await repo.putAlert(alert());
      await repo.putAlert(alert({ id: 'alert_bbbbbbbbbbbbbbbb', sensorType: 'flood', deviceName: 'Basement sensor', at: '2026-09-22T09:00:00.000Z', maintenanceRef: { applianceId: 'appl_aaaaaaaaaaaaaaaa', taskType: 'test' } }));
      const recent = await repo.listAlerts('2026-09-22T00:00:00.000Z');
      expect(recent.map(a => a.id)).toEqual(['alert_bbbbbbbbbbbbbbbb', 'alert_aaaaaaaaaaaaaaaa']);
      expect(recent[0]?.maintenanceRef?.taskType).toBe('test');
      expect((await repo.listAlerts('2026-09-23T00:00:00.000Z')).length).toBe(0);
    });

    it('keys devices by ring device id and lists them by name', async () => {
      await repo.putDevice(device());
      await repo.putDevice(device({ id: 'dev_bbbbbbbbbbbbbbbb', ringDeviceId: 'ava1.ring.device.2', name: 'Back Door', kind: 'camera' }));
      await repo.putDevice(device({ id: 'dev_cccccccccccccccc', name: 'Front Door', online: false, lastSeenAt: null }));
      const devices = await repo.listDevices();
      expect(devices.map(d => d.name)).toEqual(['Back Door', 'Front Door']);
      expect(devices.find(d => d.name === 'Front Door')?.online).toBe(false);
      expect(devices.find(d => d.name === 'Front Door')?.lastSeenAt).toBeNull();
    });
```

- [ ] **Step 3: Run against both repositories**

```bash
docker compose up -d
pnpm --filter @homeledger/core test -- memory
pnpm --filter @homeledger/core test:dynamo -- dynamo
```
Expected: PASS on both. The third device write uses the same `ringDeviceId` as the first, so both implementations must overwrite rather than append — the DynamoDB repository does this through `sk.device(ringDeviceId)` and the memory repository through its `devices` map key. If either implementation fails, fix the implementation, not the test, and record the fix in the commit message.

- [ ] **Step 4: Commit**

```bash
git add packages/core
git commit -m "test(core): contract cases for visit replacement, alerts, and devices"
```

---

### Task 3: `ManualRetriever` port and the in-memory fixture retriever

**Files:**
- Create: `packages/core/src/retrieval/retriever.ts`, `packages/core/src/retrieval/fixture.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/retrieval.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Passage { text: string; docTitle: string; page: number | null; score: number }
  export interface RetrieveOptions { question: string; applianceId?: string; maxPassages?: number }
  export interface ManualRetriever { retrieve(options: RetrieveOptions): Promise<Passage[]> }
  export const MAX_PASSAGES = 3;
  export interface FixturePassage extends Passage { applianceId: string | null; keywords: string[] }
  export function createFixtureRetriever(passages: FixturePassage[]): ManualRetriever;
  export const SAMPLE_MANUAL_PASSAGES: FixturePassage[];
  export const FIXTURE_APPLIANCE_IDS: { washer: string; furnace: string; waterHeater: string };
  ```
  `Passage` matches spec section 4.2's `passages[] {text, docTitle, page, score}` field-for-field; `ask_manual` returns it unchanged.

- [ ] **Step 1: Write the failing test**

`packages/core/test/retrieval.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FIXTURE_APPLIANCE_IDS, SAMPLE_MANUAL_PASSAGES, createFixtureRetriever } from '../src/retrieval/fixture.js';
import { MAX_PASSAGES } from '../src/retrieval/retriever.js';

const retriever = createFixtureRetriever(SAMPLE_MANUAL_PASSAGES);

describe('fixture retriever', () => {
  it('finds the washer error code by keyword', async () => {
    const passages = await retriever.retrieve({ question: 'What does F21 mean on the washer?' });
    expect(passages.length).toBeGreaterThan(0);
    expect(passages[0]?.text).toContain('F21');
    expect(passages[0]?.docTitle).toBe('LG WM4000HWA washer owner manual');
    expect(passages[0]?.page).toBe(42);
  });

  it('never returns more than three passages', async () => {
    const passages = await retriever.retrieve({ question: 'filter water drain code service manual washer furnace heater' });
    expect(passages.length).toBeLessThanOrEqual(MAX_PASSAGES);
  });

  it('honours an explicit maxPassages below the cap', async () => {
    const passages = await retriever.retrieve({ question: 'filter water drain code service manual washer furnace heater', maxPassages: 1 });
    expect(passages.length).toBe(1);
  });

  it('filters by applianceId when one is supplied', async () => {
    const passages = await retriever.retrieve({ question: 'filter', applianceId: FIXTURE_APPLIANCE_IDS.furnace });
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.every(p => p.docTitle.includes('furnace'))).toBe(true);
  });

  it('returns nothing when no keyword matches', async () => {
    expect(await retriever.retrieve({ question: 'how do I repaint the garage door' })).toEqual([]);
  });

  it('orders by keyword hits then score', async () => {
    const passages = await retriever.retrieve({ question: 'drain hose F21 washer' });
    for (let i = 1; i < passages.length; i++) expect(passages[i - 1]!.score).toBeGreaterThanOrEqual(passages[i]!.score - 1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @homeledger/core test -- retrieval`
Expected: FAIL, cannot find module `../src/retrieval/fixture.js`.

- [ ] **Step 3: Implement the port**

`packages/core/src/retrieval/retriever.ts`:
```ts
/** One retrieved manual passage. Matches design spec 4.2's ask_manual output row. */
export interface Passage {
  text: string;
  docTitle: string;
  /** 1-based PDF page, or null when the source carried no page metadata. */
  page: number | null;
  score: number;
}

export interface RetrieveOptions {
  question: string;
  /** When supplied, restrict retrieval to this appliance's manual. */
  applianceId?: string;
  /** Defaults to MAX_PASSAGES; never exceeds it. */
  maxPassages?: number;
}

/**
 * The port ask_manual talks to. Two adapters implement it: an in-memory
 * fixture for unit and contract tests, and a Bedrock Knowledge Base client
 * for the deployed runtime.
 */
export interface ManualRetriever {
  retrieve(options: RetrieveOptions): Promise<Passage[]>;
}

/** Spec 4.2: ask_manual returns at most three passages. */
export const MAX_PASSAGES = 3;

export function clampPassages(requested: number | undefined): number {
  if (requested === undefined) return MAX_PASSAGES;
  return Math.max(1, Math.min(MAX_PASSAGES, Math.trunc(requested)));
}
```

- [ ] **Step 4: Implement the fixture retriever**

`packages/core/src/retrieval/fixture.ts`:
```ts
import { type ManualRetriever, type Passage, type RetrieveOptions, clampPassages } from './retriever.js';

export interface FixturePassage extends Passage {
  applianceId: string | null;
  keywords: string[];
}

/** Stable appliance ids used only by fixtures and tests; the seeded household mints real ones. */
export const FIXTURE_APPLIANCE_IDS = {
  washer: 'appl_wwwwwwwwwwwwwwww',
  furnace: 'appl_ffffffffffffffff',
  waterHeater: 'appl_hhhhhhhhhhhhhhhh'
} as const;

export const SAMPLE_MANUAL_PASSAGES: FixturePassage[] = [
  {
    text: 'Error code F21 indicates a long drain time. The washer could not pump the water out within eight minutes. Check the drain hose for kinks, clean the drain pump filter behind the lower access panel, and restart the cycle.',
    docTitle: 'LG WM4000HWA washer owner manual',
    page: 42,
    score: 0.94,
    applianceId: FIXTURE_APPLIANCE_IDS.washer,
    keywords: ['f21', 'drain', 'hose', 'pump', 'washer', 'code', 'error']
  },
  {
    text: 'Clean the drain pump filter every month. Turn off the water supply, open the lower access panel, place a shallow pan under the filter cap, and turn the cap counter-clockwise to drain the residual water before removing the filter.',
    docTitle: 'LG WM4000HWA washer owner manual',
    page: 43,
    score: 0.81,
    applianceId: FIXTURE_APPLIANCE_IDS.washer,
    keywords: ['drain', 'filter', 'clean', 'pump', 'washer', 'monthly']
  },
  {
    text: 'Replace the air filter every 90 days under normal use, or every 30 days when pets are in the home. Use a 16 by 25 by 1 inch filter with a MERV rating of 8 to 11. Turn the system off at the thermostat before opening the filter door.',
    docTitle: 'Carrier 59SC5A furnace installation and service manual',
    page: 17,
    score: 0.9,
    applianceId: FIXTURE_APPLIANCE_IDS.furnace,
    keywords: ['filter', 'merv', 'furnace', 'replace', 'air', '90']
  },
  {
    text: 'Annual inspection covers the heat exchanger, the inducer motor, the flame sensor, and the condensate trap. A flashing status light of three short pulses indicates a pressure switch fault, most often a blocked condensate drain.',
    docTitle: 'Carrier 59SC5A furnace installation and service manual',
    page: 61,
    score: 0.77,
    applianceId: FIXTURE_APPLIANCE_IDS.furnace,
    keywords: ['inspection', 'furnace', 'pressure', 'switch', 'condensate', 'flame']
  },
  {
    text: 'Flush the tank once a year to remove sediment. Shut off the gas control to the pilot setting, close the cold water inlet, attach a hose to the drain valve, and run the water to a floor drain until it runs clear.',
    docTitle: 'Rheem XG50T12HE40U0 water heater use and care guide',
    page: 23,
    score: 0.88,
    applianceId: FIXTURE_APPLIANCE_IDS.waterHeater,
    keywords: ['flush', 'tank', 'sediment', 'water', 'heater', 'drain', 'annual']
  },
  {
    text: 'Inspect the anode rod every three years. A rod worn to less than three eighths of an inch or coated in calcium should be replaced to keep the tank warranty in force.',
    docTitle: 'Rheem XG50T12HE40U0 water heater use and care guide',
    page: 25,
    score: 0.72,
    applianceId: FIXTURE_APPLIANCE_IDS.waterHeater,
    keywords: ['anode', 'rod', 'inspect', 'water', 'heater', 'warranty']
  }
];

function hits(passage: FixturePassage, question: string): number {
  const haystack = question.toLowerCase();
  return passage.keywords.reduce((n, keyword) => (haystack.includes(keyword) ? n + 1 : n), 0);
}

/**
 * Keyword retriever over a fixed passage set. Deterministic on purpose: unit
 * and contract tests assert exact passages, and the local server uses it when
 * KNOWLEDGE_BASE_ID is unset so `pnpm dev` works with no AWS account.
 */
export function createFixtureRetriever(passages: FixturePassage[]): ManualRetriever {
  return {
    async retrieve(options: RetrieveOptions): Promise<Passage[]> {
      const limit = clampPassages(options.maxPassages);
      return passages
        .filter(p => (options.applianceId ? p.applianceId === options.applianceId : true))
        .map(p => ({ passage: p, matched: hits(p, options.question) }))
        .filter(entry => entry.matched > 0)
        .sort((a, b) => b.matched - a.matched || b.passage.score - a.passage.score)
        .slice(0, limit)
        .map(entry => ({ text: entry.passage.text, docTitle: entry.passage.docTitle, page: entry.passage.page, score: entry.passage.score }));
    }
  };
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from './retrieval/retriever.js';
export * from './retrieval/fixture.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @homeledger/core test && pnpm --filter @homeledger/core typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): manual retriever port with an in-memory fixture adapter"
```

---

### Task 4: `ask_manual`, voice cleanup, and the new `ServerDeps` fields

**Files:**
- Create: `apps/mcp-server/src/tools/manual.ts`
- Modify: `apps/mcp-server/src/server.ts`, `apps/mcp-server/src/voice.ts`, `apps/mcp-server/src/deps.ts`, `apps/mcp-server/src/tools/maintenance.ts`, `apps/mcp-server/src/tools/appliances.ts`, `apps/mcp-server/test/harness.ts`, `apps/mcp-server/test/tools.test.ts`, `apps/mcp-server/test/legacy.test.ts`
- Test: `apps/mcp-server/test/manual.test.ts`

**Interfaces:**
- Consumes: `ManualRetriever`, `MAX_PASSAGES`, `createFixtureRetriever`, `SAMPLE_MANUAL_PASSAGES` from `@homeledger/core`.
- Produces:
  ```ts
  // src/server.ts
  export interface ServerDeps {
    repo: Repository;
    now: () => string;
    devTools: boolean;
    retriever: ManualRetriever;
    requestStateKey: string;      // >= 32 bytes; used from Task 5 on
    availabilityDelayMs: number;  // book_service simulated check budget; 0 in tests
  }
  // src/voice.ts
  export function taskWords(taskType: string): string;              // replaceAll('_', ' ')
  export function speakWeekdayDate(isoDate: string): string;        // "Tuesday, September 15"
  // src/tools/manual.ts
  export function registerManualTools(server: McpServer, deps: ServerDeps): void;
  ```
  Tool `ask_manual`: input `{ question: string; applianceId?: string }`, output `{ passages: Array<{ text: string; docTitle: string; page: number | null; score: number }> }`, `readOnlyHint`. Registered after `recent_events`, before `book_service`.

`ask_manual` is registered before `book_service` even though Plan 2's suggested order builds booking first: the frozen order puts `ask_manual` at position 6, so adding it first means each later task appends rather than inserting, and the order assertion is rewritten once per task instead of twice.

- [ ] **Step 1: Write the failing test**

`apps/mcp-server/test/manual.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { hasJson } from '../src/voice.js';
import { modernClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
});

describe('ask_manual', () => {
  it('returns passages with page numbers and speaks a citation without JSON', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'ask_manual', arguments: { question: 'What does F21 mean on the washer?' } });
    const sc = r.structuredContent as { passages: Array<{ text: string; docTitle: string; page: number | null; score: number }> };
    expect(sc.passages.length).toBeGreaterThan(0);
    expect(sc.passages.length).toBeLessThanOrEqual(3);
    expect(sc.passages[0]?.page).toBe(42);
    expect(sc.passages[0]?.docTitle).toBe('LG WM4000HWA washer owner manual');
    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(hasJson(text)).toBe(false);
    expect(text).toContain('LG WM4000HWA washer owner manual page 42');
  });

  it('passes applianceId through as a filter', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'ask_manual', arguments: { question: 'filter', applianceId: 'appl_ffffffffffffffff' } });
    const sc = r.structuredContent as { passages: Array<{ docTitle: string }> };
    expect(sc.passages.length).toBeGreaterThan(0);
    expect(sc.passages.every(p => p.docTitle.includes('furnace'))).toBe(true);
  });

  it('says so plainly when the manuals have nothing', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'ask_manual', arguments: { question: 'how do I repaint the garage door' } });
    expect((r.structuredContent as { passages: unknown[] }).passages).toEqual([]);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("I couldn't find anything about that in the manuals.");
  });
});
```

Update the order assertion in `apps/mcp-server/test/tools.test.ts`:
```ts
    expect(tools.map(t => t.name)).toEqual(['list_appliances', 'get_appliance', 'maintenance_due', 'log_maintenance', 'recent_events', 'ask_manual', 'echo_confirm']);
```

Update the order assertion in `apps/mcp-server/test/legacy.test.ts`:
```ts
    expect(tools.map(t => t.name)).toEqual(['list_appliances', 'get_appliance', 'maintenance_due', 'log_maintenance', 'recent_events', 'ask_manual', 'echo_confirm']);
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @homeledger/mcp-server test -- manual tools legacy`
Expected: FAIL — tool `ask_manual` not found, and both order assertions mismatch.

- [ ] **Step 3: Clean up `voice.ts`**

Replace the whole of `apps/mcp-server/src/voice.ts` with:
```ts
export const VOICE_MAX_ITEMS = 5;

export function speakList(items: string[], noun: string): string {
  const plural = (n: number) => (n === 1 ? noun : `${noun}s`);
  if (items.length === 0) return `No ${plural(0)}.`;
  const shown = items.slice(0, VOICE_MAX_ITEMS);
  const rest = items.length - shown.length;
  let joined: string;
  if (rest > 0) joined = `${shown.join(', ')}, and ${rest} more`;
  else if (shown.length === 1) joined = shown[0]!;
  else if (shown.length === 2) joined = `${shown[0]} and ${shown[1]}`;
  else joined = `${shown.slice(0, -1).join(', ')}, and ${shown[shown.length - 1]}`;
  return `${items.length} ${plural(items.length)}: ${joined}.`;
}

export function hasJson(text: string): boolean {
  return /[{}[\]]/.test(text);
}

export function speakDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function speakWeekdayDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** Task types are snake_case; every underscore becomes a space, not just the first. */
export function taskWords(taskType: string): string {
  return taskType.replaceAll('_', ' ');
}
```

The rewrite of `speakList` removes the dead sub-branch flagged in the Plan 1 review: the old `rest > 0 ? ... : ...` inside the final `else` was always overwritten by the line below it. Every existing expected string is unchanged — 0 items, 1 item, 2 items with no remainder, 3 to 5 items with no remainder, and 6 or 7 items with a remainder all produce byte-identical output.

In `apps/mcp-server/src/tools/maintenance.ts`, delete the local definition:
```ts
const taskWords = (t: string) => t.replace('_', ' ');
```
and change the import line to:
```ts
import { speakDate, speakList, taskWords } from '../voice.js';
```

In `apps/mcp-server/src/tools/appliances.ts`, change the import line to:
```ts
import { speakDate, speakList, taskWords } from '../voice.js';
```
and replace the inline `m.taskType.replace('_', ' ')` inside `get_appliance`'s `dueText` with `taskWords(m.taskType)`:
```ts
              maintenance.map(m => `${taskWords(m.taskType)} ${m.overdue ? 'overdue since' : 'due'} ${speakDate(m.nextDueAt)}`),
```

- [ ] **Step 4: Widen `ServerDeps` and implement `ask_manual`**

In `apps/mcp-server/src/server.ts`, replace the import block and `ServerDeps` with:
```ts
import { McpServer } from '@modelcontextprotocol/server';
import type { ManualRetriever, Repository } from '@homeledger/core';
import { registerApplianceTools } from './tools/appliances.js';
import { registerMaintenanceTools } from './tools/maintenance.js';
import { registerEventTools } from './tools/events.js';
import { registerManualTools } from './tools/manual.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { registerDevTools } from './tools/dev.js';

export interface ServerDeps {
  repo: Repository;
  now: () => string; // ISO datetime
  devTools: boolean;
  retriever: ManualRetriever;
  /** HMAC key for the multi round-trip requestState codec. At least 32 bytes. */
  requestStateKey: string;
  /** Total budget for book_service's simulated availability check, in milliseconds. */
  availabilityDelayMs: number;
}
```
and add `registerManualTools(server, deps);` immediately after `registerEventTools(server, deps);` inside `buildServer`.

`apps/mcp-server/src/tools/manual.ts`:
```ts
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { MAX_PASSAGES } from '@homeledger/core';
import type { ServerDeps } from '../server.js';
import { speakList } from '../voice.js';

const PassageRow = z.object({
  text: z.string(),
  docTitle: z.string(),
  page: z.number().int().nullable(),
  score: z.number()
});

export function registerManualTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'ask_manual',
    {
      title: 'Ask the manuals',
      description:
        'Search the household appliance manuals and return the most relevant passages with their page numbers. Returns source text only; compose the answer yourself from the passages and cite the document title and page.',
      inputSchema: z.object({ question: z.string().min(3).max(500), applianceId: z.string().optional() }),
      outputSchema: z.object({ passages: z.array(PassageRow) }),
      annotations: { readOnlyHint: true }
    },
    async ({ question, applianceId }) => {
      const passages = await deps.retriever.retrieve({ question, applianceId, maxPassages: MAX_PASSAGES });
      if (passages.length === 0) {
        return { content: [{ type: 'text', text: "I couldn't find anything about that in the manuals." }], structuredContent: { passages: [] } };
      }
      // Spoken text names the sources only. Passage bodies routinely contain
      // brackets and braces, which hasJson() rejects, and the client model is
      // the thing that composes the answer from structuredContent.
      const cited = speakList(
        passages.map(p => (p.page === null ? p.docTitle : `${p.docTitle} page ${p.page}`)),
        'passage'
      );
      return { content: [{ type: 'text', text: cited }], structuredContent: { passages } };
    }
  );
}
```

- [ ] **Step 5: Supply the new deps in the harness and in `deps.ts`**

Replace `apps/mcp-server/test/harness.ts` with:
```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { SAMPLE_MANUAL_PASSAGES, createFixtureRetriever, createMemoryRepository, seedRepository } from '@homeledger/core';
import { buildServer, type ServerDeps } from '../src/server.js';

export const TODAY = '2026-09-13';

/** 39 bytes, comfortably over createRequestStateCodec's 32-byte floor. */
export const TEST_REQUEST_STATE_KEY = 'test-request-state-key-0123456789abcdef';

export async function seededDeps(): Promise<ServerDeps> {
  const repo = createMemoryRepository('hh_test');
  await seedRepository(repo, 'hh_test', TODAY);
  return {
    repo,
    now: () => `${TODAY}T12:00:00.000Z`,
    devTools: true,
    retriever: createFixtureRetriever(SAMPLE_MANUAL_PASSAGES),
    requestStateKey: TEST_REQUEST_STATE_KEY,
    availabilityDelayMs: 0
  };
}

export async function modernClient(over: Partial<ServerDeps> = {}) {
  const deps = { ...(await seededDeps()), ...over };
  const handler = createMcpHandler(() => buildServer(deps));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  });
  const client = new Client({ name: 'test-harness', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return {
    client,
    deps,
    close: async () => {
      await client.close();
      await handler.close();
    }
  };
}
```

Replace `apps/mcp-server/src/deps.ts` with:
```ts
import { randomBytes } from 'node:crypto';
import { SAMPLE_MANUAL_PASSAGES, createDynamoRepository, createFixtureRetriever, createMemoryRepository, seedRepository, type ManualRetriever } from '@homeledger/core';
import type { ServerDeps } from './server.js';

const MIN_REQUEST_STATE_KEY_BYTES = 32;

function resolveRequestStateKey(env: NodeJS.ProcessEnv): string {
  const configured = env.REQUEST_STATE_KEY;
  if (configured && Buffer.byteLength(configured, 'utf8') >= MIN_REQUEST_STATE_KEY_BYTES) return configured;
  if (configured) throw new Error(`REQUEST_STATE_KEY must be at least ${MIN_REQUEST_STATE_KEY_BYTES} bytes`);
  // No configured key: mint a per-process one. Multi round-trip rounds that
  // land on a different microVM than the one that minted the state are then
  // rejected with -32602 and the client restarts the flow. Acceptable for
  // local runs; Terraform sets REQUEST_STATE_KEY on the deployed runtime.
  const generated = randomBytes(32).toString('base64url');
  console.log(JSON.stringify({ msg: 'request-state-key-generated', reason: 'REQUEST_STATE_KEY unset', scope: 'process' }));
  return generated;
}

function resolveRetriever(env: NodeJS.ProcessEnv): ManualRetriever {
  const knowledgeBaseId = env.KNOWLEDGE_BASE_ID;
  if (!knowledgeBaseId) {
    console.log(JSON.stringify({ msg: 'retriever', kind: 'fixture', reason: 'KNOWLEDGE_BASE_ID unset' }));
    return createFixtureRetriever(SAMPLE_MANUAL_PASSAGES);
  }
  console.log(JSON.stringify({ msg: 'retriever', kind: 'knowledge-base', knowledgeBaseId }));
  throw new Error('KNOWLEDGE_BASE_ID is set but the Knowledge Base retriever is not wired yet');
}

export async function depsFromEnv(env: NodeJS.ProcessEnv): Promise<ServerDeps> {
  const householdId = env.HOUSEHOLD_ID;
  if (!householdId) throw new Error('HOUSEHOLD_ID is required');
  const devTools = env.HOMELEDGER_DEV_TOOLS === '1';
  const now = () => new Date().toISOString();
  const retriever = resolveRetriever(env);
  const requestStateKey = resolveRequestStateKey(env);
  const availabilityDelayMs = Number(env.AVAILABILITY_DELAY_MS ?? 600);
  const common = { now, devTools, retriever, requestStateKey, availabilityDelayMs };
  if (env.MEMORY_REPO === '1') {
    const repo = createMemoryRepository(householdId);
    await seedRepository(repo, householdId, now().slice(0, 10));
    return { repo, ...common };
  }
  const tableName = env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME is required unless MEMORY_REPO=1');
  const repo = createDynamoRepository({ tableName, householdId, endpoint: env.DYNAMO_ENDPOINT, region: env.AWS_REGION });
  return { repo, ...common };
}
```

The deliberate `throw` inside `resolveRetriever` is replaced by the real client in Task 9; until then setting `KNOWLEDGE_BASE_ID` fails loudly instead of silently serving fixtures from the deployed runtime.

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @homeledger/core build
pnpm --filter @homeledger/mcp-server test
pnpm --filter @homeledger/mcp-server typecheck
```
Expected: PASS, including the previously green `voice.test.ts`, `maintenance.test.ts`, and `tools.test.ts` strings. If `speakList` output shifted anywhere, the rewrite is wrong — restore the branch ordering `rest > 0` first, then `length === 1`, then `length === 2`, then the general case.

- [ ] **Step 7: Commit**

```bash
git add apps/mcp-server
git commit -m "feat(mcp-server): ask_manual tool over the manual retriever port"
```

---

### Task 5: `book_service` multi round-trip elicitation on the modern client

**Files:**
- Create: `apps/mcp-server/src/elicit.ts`, `apps/mcp-server/src/tools/service.ts`
- Modify: `apps/mcp-server/src/server.ts`, `apps/mcp-server/src/tools/dev.ts`, `apps/mcp-server/test/harness.ts`, `apps/mcp-server/test/tools.test.ts`, `apps/mcp-server/test/legacy.test.ts`, `FRICTION-LOG.md`
- Test: `apps/mcp-server/test/book-service-modern.test.ts`

**Interfaces:**
- Consumes: `providersForCategory`, `MAX_PROVIDER_OPTIONS`, `VisitStatus`, `newId` from `@homeledger/core`; `inputRequired`, `inputResponse`, `acceptedContent`, `createRequestStateCodec`, `type ServerContext`, `type InputResponses`, `type ElicitRequestFormParams`, `type RequestStateCodec` from `@modelcontextprotocol/server`.
- Produces:
  ```ts
  // src/elicit.ts
  export type ElicitOutcome = 'missing' | 'accepted' | 'declined';
  export function elicitOutcome(responses: InputResponses | Record<string, unknown> | undefined, key: string): ElicitOutcome;
  export function enumField(field: string, title: string, values: string[], names: string[]): ElicitRequestFormParams['requestedSchema'];
  export function booleanField(field: string, title: string): ElicitRequestFormParams['requestedSchema'];
  // src/tools/service.ts
  export interface BookingState { applianceId: string; issue: string; providerId?: string; windowStart?: string; windowEnd?: string }
  export interface ServiceWindow { id: string; start: string; end: string; label: string }
  export function availabilityWindows(nowIso: string): ServiceWindow[];
  export function registerServiceTools(server: McpServer, deps: ServerDeps, codec: RequestStateCodec<BookingState>): void;
  // src/server.ts
  export function buildServer(deps: ServerDeps): McpServer;   // now also constructs the codec
  // test/harness.ts
  export type ElicitAnswer = { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' } | { action: 'cancel' };
  export async function modernElicitClient(answer: (field: string, message: string) => ElicitAnswer, over?: Partial<ServerDeps>): Promise<{ client: Client; deps: ServerDeps; asked: Array<{ field: string; message: string }>; close: () => Promise<void> }>;
  ```
  Tool `book_service`: input `{ applianceId: string; issue: string; preferredWindow?: string }`, output `{ visitId: string; provider: string; windowStart: string; windowEnd: string; status: VisitStatus }`. Registered after `ask_manual`.

- [ ] **Step 1: Write the failing test**

`apps/mcp-server/test/book-service-modern.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { hasJson } from '../src/voice.js';
import { modernElicitClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
});

async function waterHeaterId(client: Awaited<ReturnType<typeof modernElicitClient>>['client']) {
  const list = await client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
  return (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
}

describe('book_service over multi round-trip requests (2026-07-28)', () => {
  it('asks for provider, window, and confirmation, then writes the visit', async () => {
    const h = await modernElicitClient(field => {
      if (field === 'provider') return { action: 'accept', content: { provider: 'prov_kettle_water' } };
      if (field === 'window') return { action: 'accept', content: { window: 'win_1' } };
      return { action: 'accept', content: { confirm: true } };
    });
    close = h.close;
    const applianceId = await waterHeaterId(h.client);
    const r = await h.client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'water heater leaking at the base' } });

    expect(h.asked.map(a => a.field)).toEqual(['provider', 'window', 'confirm']);
    expect(h.asked[0]?.message).toBe('Who should I book for the water heater?');
    expect(h.asked[1]?.message).toBe('Kettle Creek Water Heaters has three windows. Which one works?');
    expect(h.asked[2]?.message).toBe('Book Kettle Creek Water Heaters for Tuesday, September 15, 1 to 3 PM?');

    const sc = r.structuredContent as { visitId: string; provider: string; windowStart: string; windowEnd: string; status: string };
    expect(sc.provider).toBe('Kettle Creek Water Heaters');
    expect(sc.status).toBe('scheduled');
    expect(sc.windowStart).toBe('2026-09-15T13:00:00.000Z');
    expect(sc.windowEnd).toBe('2026-09-15T15:00:00.000Z');
    expect(/^visit_[a-z2-7]{16}$/.test(sc.visitId)).toBe(true);

    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(hasJson(text)).toBe(false);
    expect(text).toBe('Booked Kettle Creek Water Heaters for Tuesday, September 15, 1 to 3 PM.');

    const stored = await h.deps.repo.getVisit(sc.visitId);
    expect(stored?.providerId).toBe('prov_kettle_water');
    expect(stored?.applianceId).toBe(applianceId);
    expect(stored?.issue).toBe('water heater leaking at the base');
    expect(stored?.status).toBe('scheduled');
  });

  it('never offers more than five providers or more than three windows', async () => {
    const schemas: Array<Record<string, unknown>> = [];
    const h = await modernElicitClient(
      field => {
        if (field === 'provider') return { action: 'accept', content: { provider: 'prov_harbor_line' } };
        if (field === 'window') return { action: 'accept', content: { window: 'win_2' } };
        return { action: 'accept', content: { confirm: true } };
      },
      undefined,
      schemas
    );
    close = h.close;
    const list = await h.client.callTool({ name: 'list_appliances', arguments: { category: 'plumbing' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    await h.client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'sump pump runs constantly' } });
    const providerEnum = (schemas[0]!.properties as { provider: { enum: string[] } }).provider.enum;
    const windowEnum = (schemas[1]!.properties as { window: { enum: string[] } }).window.enum;
    expect(providerEnum.length).toBeLessThanOrEqual(5);
    expect(windowEnum.length).toBe(3);
  });

  it('stops without writing anything when the user declines', async () => {
    const h = await modernElicitClient(() => ({ action: 'decline' }));
    close = h.close;
    const applianceId = await waterHeaterId(h.client);
    const r = await h.client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'no hot water' } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("Okay, I haven't booked anything.");
    expect(h.asked.map(a => a.field)).toEqual(['provider']);
    expect(await h.deps.repo.listVisitsSince('2026-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('stops when the user answers the confirmation with no', async () => {
    const h = await modernElicitClient(field => {
      if (field === 'provider') return { action: 'accept', content: { provider: 'prov_kettle_water' } };
      if (field === 'window') return { action: 'accept', content: { window: 'win_3' } };
      return { action: 'accept', content: { confirm: false } };
    });
    close = h.close;
    const applianceId = await waterHeaterId(h.client);
    const r = await h.client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'no hot water' } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("Okay, I haven't booked anything.");
    expect(await h.deps.repo.listVisitsSince('2026-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('answers an unknown appliance without asking anything', async () => {
    const h = await modernElicitClient(() => ({ action: 'accept', content: {} }));
    close = h.close;
    const r = await h.client.callTool({ name: 'book_service', arguments: { applianceId: 'appl_zzzzzzzzzzzzzzzz', issue: 'leak' } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("I couldn't find that appliance.");
    expect(h.asked).toEqual([]);
  });
});
```

Update the order assertion in `apps/mcp-server/test/tools.test.ts` and in `apps/mcp-server/test/legacy.test.ts` to:
```ts
    expect(tools.map(t => t.name)).toEqual(['list_appliances', 'get_appliance', 'maintenance_due', 'log_maintenance', 'recent_events', 'ask_manual', 'book_service', 'echo_confirm']);
```

- [ ] **Step 2: Add `modernElicitClient` to the harness**

Append to `apps/mcp-server/test/harness.ts`:
```ts
export type ElicitAnswer = { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' } | { action: 'cancel' };

/**
 * A 2026-07-28 client that answers embedded elicitation requests. The field
 * name is the single key of requestedSchema.properties, which is exactly the
 * key the server used in inputRequests. `schemas`, when supplied, collects
 * every requestedSchema so a test can assert option counts.
 */
export async function modernElicitClient(answer: (field: string, message: string) => ElicitAnswer, over: Partial<ServerDeps> = {}, schemas?: Array<Record<string, unknown>>) {
  const deps = { ...(await seededDeps()), ...over };
  const handler = createMcpHandler(() => buildServer(deps));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  });
  const client = new Client(
    { name: 'modern-elicit', version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } }, inputRequired: { maxRounds: 6 }, versionNegotiation: { mode: 'auto' } }
  );
  const asked: Array<{ field: string; message: string }> = [];
  client.setRequestHandler('elicitation/create', async request => {
    const requestedSchema = (request.params as { requestedSchema: { properties: Record<string, unknown> } }).requestedSchema;
    const field = Object.keys(requestedSchema.properties)[0] ?? '';
    const message = (request.params as { message: string }).message;
    asked.push({ field, message });
    schemas?.push(requestedSchema as unknown as Record<string, unknown>);
    return answer(field, message);
  });
  await client.connect(transport);
  return {
    client,
    deps,
    asked,
    close: async () => {
      await client.close();
      await handler.close();
    }
  };
}
```

Note: `modernElicitClient` takes `over` as its second parameter, so the second test above passes `undefined` there before `schemas`.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @homeledger/mcp-server test -- book-service-modern`
Expected: FAIL, tool `book_service` not found.

- [ ] **Step 4: Implement the typed elicitation helper**

`apps/mcp-server/src/elicit.ts`:
```ts
import { inputResponse, type ElicitRequestFormParams, type InputResponses } from '@modelcontextprotocol/server';

export type ElicitOutcome = 'missing' | 'accepted' | 'declined';

/**
 * Typed narrowing over one entry of ctx.mcpReq.inputResponses.
 *
 * The SDK's inputResponse() returns a discriminated view
 * ({ kind: 'missing' } | { kind: 'elicit', action, content? } | { kind: 'sampling' } | { kind: 'roots' }),
 * so no handler needs the unchecked `as { action?: string }` cast the Plan 1
 * echo_confirm spike used. A response of the wrong kind counts as declined:
 * re-issuing it would loop until the client's maxRounds runs out.
 */
export function elicitOutcome(responses: InputResponses | Record<string, unknown> | undefined, key: string): ElicitOutcome {
  const view = inputResponse(responses, key);
  if (view.kind === 'missing') return 'missing';
  if (view.kind === 'elicit') return view.action === 'accept' ? 'accepted' : 'declined';
  return 'declined';
}

type RequestedSchema = ElicitRequestFormParams['requestedSchema'];

/**
 * Single-select enumeration carrying display names.
 *
 * The `enum` + `enumNames` shape (LegacyTitledEnumSchema in the SDK's schema
 * union) is used deliberately over the newer `oneOf: [{ const, title }]`
 * shape: both @modelcontextprotocol/server 2.0.0 and @modelcontextprotocol/sdk
 * 1.30.0 validate it, so the same request body is understood by the modern
 * client and by a 2025-era client coming through the legacy shim.
 */
export function enumField(field: string, title: string, values: string[], names: string[]): RequestedSchema {
  return {
    type: 'object',
    properties: {
      [field]: { type: 'string', title, enum: values, enumNames: names }
    },
    required: [field]
  };
}

export function booleanField(field: string, title: string): RequestedSchema {
  return {
    type: 'object',
    properties: {
      [field]: { type: 'boolean', title }
    },
    required: [field]
  };
}
```

If TypeScript rejects either literal against `ElicitRequestFormParams['requestedSchema']` — most likely because the computed key `[field]` widens the property type — add `as RequestedSchema` to the returned object literal, keep the declared return type, and record the mismatch in `FRICTION-LOG.md`. Do not loosen the return type to `unknown`.

- [ ] **Step 5: Replace the unchecked cast in `dev.ts`**

Replace the handler body in `apps/mcp-server/src/tools/dev.ts` so the whole file reads:
```ts
import { acceptedContent, inputRequired, type McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { booleanField, elicitOutcome } from '../elicit.js';
import type { ServerDeps } from '../server.js';

const ConfirmSchema = z.object({ confirm: z.boolean() });

export function registerDevTools(server: McpServer, deps: ServerDeps): void {
  if (!deps.devTools) return;
  server.registerTool(
    'echo_confirm',
    {
      title: 'Echo confirm (dev)',
      description: 'Development-only tool that asks the user to confirm a message and echoes the answer. Exercises elicitation on every client generation.',
      inputSchema: z.object({ message: z.string().min(1) }),
      outputSchema: z.object({ confirmed: z.boolean(), message: z.string() })
    },
    async ({ message }, ctx) => {
      if (elicitOutcome(ctx.mcpReq.inputResponses, 'confirm') === 'declined') {
        return { content: [{ type: 'text', text: `Cancelled: ${message}` }], structuredContent: { confirmed: false, message } };
      }
      const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', ConfirmSchema);
      if (!answer) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({ message: `Confirm: ${message}?`, requestedSchema: booleanField('confirm', 'Confirm') })
          }
        });
      }
      return {
        content: [{ type: 'text', text: answer.confirm ? `Confirmed: ${message}` : `Cancelled: ${message}` }],
        structuredContent: { confirmed: answer.confirm, message }
      };
    }
  );
}
```

`echo_confirm`'s wire shape changes only in that `requestedSchema` is now built by `booleanField` — the same `{ type: 'object', properties: { confirm: { type: 'boolean', title: 'Confirm' } }, required: ['confirm'] }` the Zod object converted to, plus a title. The existing `elicit-modern.test.ts` and `elicit-legacy.test.ts` assertions (message text and result) are unchanged and must stay green.

- [ ] **Step 6: Implement `book_service`**

`apps/mcp-server/src/tools/service.ts`:
```ts
import { acceptedContent, inputRequired, type McpServer, type RequestStateCodec, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { VisitStatus, newId, providersForCategory } from '@homeledger/core';
import { booleanField, elicitOutcome, enumField } from '../elicit.js';
import type { ServerDeps } from '../server.js';
import { speakWeekdayDate } from '../voice.js';

/** Cross-round booking state, carried in the signed requestState. */
export interface BookingState {
  applianceId: string;
  issue: string;
  providerId?: string;
  windowStart?: string;
  windowEnd?: string;
}

export interface ServiceWindow {
  id: string;
  start: string;
  end: string;
  label: string;
}

const WINDOW_DAY_OFFSETS = [2, 3, 4];

/**
 * Three 1-to-3 PM UTC windows, two to four days out from the current date.
 * Deterministic so tests can assert exact timestamps. Labels read in UTC;
 * localising to the household timezone is Plan 3's simulator concern.
 */
export function availabilityWindows(nowIso: string): ServiceWindow[] {
  const base = new Date(`${nowIso.slice(0, 10)}T00:00:00Z`).getTime();
  return WINDOW_DAY_OFFSETS.map((offset, index) => {
    const day = new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
    return {
      id: `win_${index + 1}`,
      start: `${day}T13:00:00.000Z`,
      end: `${day}T15:00:00.000Z`,
      label: `${speakWeekdayDate(day)}, 1 to 3 PM`
    };
  });
}

const ProviderAnswer = z.object({ provider: z.string() });
const WindowAnswer = z.object({ window: z.string() });
const ConfirmAnswer = z.object({ confirm: z.boolean() });

const notBooked = () => ({ content: [{ type: 'text' as const, text: "Okay, I haven't booked anything." }], isError: true });

export function registerServiceTools(server: McpServer, deps: ServerDeps, codec: RequestStateCodec<BookingState>): void {
  server.registerTool(
    'book_service',
    {
      title: 'Book a service visit',
      description:
        'Book a service visit for an appliance. Asks which provider to use, which arrival window to take, and for a final confirmation before anything is written. Providers come from a sample marketplace, not a real booking network.',
      inputSchema: z.object({ applianceId: z.string(), issue: z.string().min(3).max(300), preferredWindow: z.string().max(100).optional() }),
      outputSchema: z.object({
        visitId: z.string(),
        provider: z.string(),
        windowStart: z.string(),
        windowEnd: z.string(),
        status: VisitStatus
      })
    },
    async ({ applianceId, issue }, ctx: ServerContext) => {
      const appliance = await deps.repo.getAppliance(applianceId);
      if (!appliance) return { content: [{ type: 'text', text: "I couldn't find that appliance." }], isError: true };

      const carried = ctx.mcpReq.requestState<BookingState>();
      // requestState round-trips through the client. It is integrity-checked
      // by the codec before the handler runs, but a state minted for another
      // appliance is still wrong for this call, so start over rather than mix.
      const state: BookingState = carried && carried.applianceId === applianceId ? { ...carried } : { applianceId, issue };

      const providers = providersForCategory(appliance.category);
      const applianceWords = appliance.name.toLowerCase();

      if (!state.providerId) {
        if (elicitOutcome(ctx.mcpReq.inputResponses, 'provider') === 'declined') return notBooked();
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'provider', ProviderAnswer);
        const chosen = answer ? providers.find(p => p.id === answer.provider) : undefined;
        if (!chosen) {
          return inputRequired({
            inputRequests: {
              provider: inputRequired.elicit({
                message: `Who should I book for the ${applianceWords}?`,
                requestedSchema: enumField(
                  'provider',
                  'Provider',
                  providers.map(p => p.id),
                  providers.map(p => `${p.name}, rated ${p.rating.toFixed(1)}`)
                )
              })
            },
            requestState: await codec.mint({ applianceId, issue }, ctx)
          });
        }
        state.providerId = chosen.id;
      }

      const provider = providers.find(p => p.id === state.providerId);
      if (!provider) return notBooked();

      const windows = availabilityWindows(deps.now());

      if (!state.windowStart) {
        if (elicitOutcome(ctx.mcpReq.inputResponses, 'window') === 'declined') return notBooked();
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'window', WindowAnswer);
        const chosen = answer ? windows.find(w => w.id === answer.window) : undefined;
        if (!chosen) {
          await checkAvailability(ctx, deps, provider.name);
          return inputRequired({
            inputRequests: {
              window: inputRequired.elicit({
                message: `${provider.name} has three windows. Which one works?`,
                requestedSchema: enumField(
                  'window',
                  'Arrival window',
                  windows.map(w => w.id),
                  windows.map(w => w.label)
                )
              })
            },
            requestState: await codec.mint({ applianceId, issue, providerId: provider.id }, ctx)
          });
        }
        state.windowStart = chosen.start;
        state.windowEnd = chosen.end;
      }

      const window = windows.find(w => w.start === state.windowStart);
      if (!window) return notBooked();

      if (elicitOutcome(ctx.mcpReq.inputResponses, 'confirm') === 'declined') return notBooked();
      const confirmed = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', ConfirmAnswer);
      if (!confirmed) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `Book ${provider.name} for ${window.label}?`,
              requestedSchema: booleanField('confirm', 'Confirm booking')
            })
          },
          requestState: await codec.mint({ applianceId, issue, providerId: provider.id, windowStart: window.start, windowEnd: window.end }, ctx)
        });
      }
      if (!confirmed.confirm) return notBooked();

      const visitId = newId('visit');
      await deps.repo.putVisit({
        id: visitId,
        providerId: provider.id,
        providerName: provider.name,
        category: appliance.category,
        applianceId,
        issue: state.issue,
        windowStart: window.start,
        windowEnd: window.end,
        status: 'scheduled',
        ringEventIds: [],
        snapshotKey: null,
        description: null,
        arrivedAt: null,
        createdAt: deps.now()
      });

      return {
        content: [{ type: 'text', text: `Booked ${provider.name} for ${window.label}.` }],
        structuredContent: { visitId, provider: provider.name, windowStart: window.start, windowEnd: window.end, status: 'scheduled' as const }
      };
    }
  );
}

/** Replaced in Task 7 with a progress-reporting implementation. */
async function checkAvailability(_ctx: ServerContext, deps: ServerDeps, _providerName: string): Promise<void> {
  if (deps.availabilityDelayMs > 0) await new Promise(resolve => setTimeout(resolve, deps.availabilityDelayMs));
}
```

- [ ] **Step 7: Build the codec in `buildServer`**

Replace `apps/mcp-server/src/server.ts` with:
```ts
import { McpServer, createRequestStateCodec } from '@modelcontextprotocol/server';
import type { ManualRetriever, Repository } from '@homeledger/core';
import { registerApplianceTools } from './tools/appliances.js';
import { registerMaintenanceTools } from './tools/maintenance.js';
import { registerEventTools } from './tools/events.js';
import { registerManualTools } from './tools/manual.js';
import { registerServiceTools, type BookingState } from './tools/service.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { registerDevTools } from './tools/dev.js';

export interface ServerDeps {
  repo: Repository;
  now: () => string; // ISO datetime
  devTools: boolean;
  retriever: ManualRetriever;
  /** HMAC key for the multi round-trip requestState codec. At least 32 bytes. */
  requestStateKey: string;
  /** Total budget for book_service's simulated availability check, in milliseconds. */
  availabilityDelayMs: number;
}

export const SERVER_INFO = { name: 'homeledger', version: '0.1.0' } as const;

/** Ten minutes: long enough for a human to answer three cards, short enough to expire. */
const REQUEST_STATE_TTL_SECONDS = 600;

export function buildServer(deps: ServerDeps): McpServer {
  const codec = createRequestStateCodec<BookingState>({
    key: deps.requestStateKey,
    ttlSeconds: REQUEST_STATE_TTL_SECONDS,
    bind: ctx => `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? ''}`
  });

  const server = new McpServer(SERVER_INFO, {
    instructions:
      'HomeLedger is the household operating record: appliances, warranties, manuals, maintenance, service visits, and door and sensor events. Speak results plainly; never read identifiers aloud.',
    requestState: { verify: (state, ctx) => codec.verify(state, ctx) }
  });

  // Tool order is frozen after the first deploy. Do not reorder these calls.
  registerApplianceTools(server, deps); // list_appliances, get_appliance
  registerMaintenanceTools(server, deps); // maintenance_due, log_maintenance
  registerEventTools(server, deps); // recent_events
  registerManualTools(server, deps); // ask_manual
  registerServiceTools(server, deps, codec); // book_service
  registerResources(server, deps);
  registerPrompts(server, deps);
  registerDevTools(server, deps); // echo_confirm, always last, devTools only
  return server;
}
```

Two things to verify against the installed types the first time this compiles, both of which were read out of `apps/mcp-server/node_modules/@modelcontextprotocol/server/dist/index.d.mts` and `createMcpHandler-CLhGwQTn.d.mts` while this plan was written:
1. `ServerOptions.requestState.verify` has signature `(state: string, ctx: ServerContext) => unknown | Promise<unknown>` and its resolved value is what `ctx.mcpReq.requestState<T>()` returns. If the option is not accepted by `new McpServer(...)`, do not drop the codec — pass it through the low-level `Server` options instead and log the discrepancy.
2. `createRequestStateCodec` throws `RangeError` when `key` is shorter than 32 bytes, and `mint(payload, ctx)` requires `ctx` because `bind` is configured. If `mint` rejects the `ServerContext` argument, drop the `bind` option (which also drops the binding requirement) and record it.

- [ ] **Step 8: Run the tests**

```bash
pnpm --filter @homeledger/core build
pnpm --filter @homeledger/mcp-server test
pnpm --filter @homeledger/mcp-server typecheck
```
Expected: PASS, including `elicit-modern.test.ts` and `elicit-legacy.test.ts` unchanged.

If the modern MRTR driver stops before the third round, raise `inputRequired: { maxRounds: 6 }` in the harness — three elicitations need at least four rounds — and check the value the client actually enforces in `apps/mcp-server/node_modules/@modelcontextprotocol/client/dist/index-D4xIIEF6.d.mts` under `maxRounds`.

- [ ] **Step 9: Record the MRTR findings**

Append `FL-023` to `FRICTION-LOG.md` under "Build phase", in the existing field format, covering: the enum shape actually accepted by `inputRequired.elicit` (`enum` + `enumNames` versus `oneOf`), whether `ServerOptions.requestState.verify` was accepted on `McpServer` directly, whether `mint` required `ctx`, and the `maxRounds` value needed for a three-elicitation flow. Cite `https://ts.sdk.modelcontextprotocol.io/v2/servers/input-required` and `https://modelcontextprotocol.io/specification/2026-07-28/changelog`. If nothing deviated from the documented shape, still file the entry stating that, the way FL-017 did for the Plan 1 spike, and mark it Resolved.

- [ ] **Step 10: Commit**

```bash
git add apps/mcp-server FRICTION-LOG.md
git commit -m "feat(mcp-server): book_service with multi round-trip elicitation and signed request state"
```

---

### Task 6: `book_service` through the legacy shim over a real socket

**Files:**
- Test: `apps/mcp-server/test/book-service-legacy.test.ts`

**Interfaces:**
- Consumes: `createApp` from `apps/mcp-server/src/app.ts`, `seededDeps` from the harness, `@modelcontextprotocol/sdk` 1.30.0's `Client`, `StreamableHTTPClientTransport`, and `ElicitRequestSchema`.
- Produces: no production code. This is the Plan 1 `echo_confirm` gate repeated for a three-round flow: a 2025-era client, over a real TCP socket, through `NodeStreamableHTTPServerTransport` and the SDK's input-required legacy shim, must receive three server-initiated `elicitation/create` requests inside one `tools/call` and get the completed result back.

- [ ] **Step 1: Write the failing test**

`apps/mcp-server/test/book-service-legacy.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../src/app.js';
import { seededDeps } from './harness.js';

let server: Server | undefined;
let closeApp: () => Promise<void> = async () => {};
afterEach(async () => {
  await closeApp();
  await new Promise<void>(r => (server ? server.close(() => r()) : r()));
});

async function listen() {
  const deps = await seededDeps();
  const { app, close } = createApp(deps);
  closeApp = close;
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server!.once('listening', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, deps };
}

describe('book_service over a 2025-era session (legacy shim)', () => {
  it('drives three server-initiated elicitations inside one tools/call and writes the visit', async () => {
    const { url, deps } = await listen();
    const client = new Client({ name: 'legacy-booker', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    const asked: Array<{ field: string; message: string; options: string[] }> = [];
    client.setRequestHandler(ElicitRequestSchema, async request => {
      const requestedSchema = request.params.requestedSchema as { properties: Record<string, { enum?: string[] }> };
      const field = Object.keys(requestedSchema.properties)[0] ?? '';
      asked.push({ field, message: request.params.message, options: requestedSchema.properties[field]?.enum ?? [] });
      if (field === 'provider') return { action: 'accept', content: { provider: 'prov_kettle_water' } };
      if (field === 'window') return { action: 'accept', content: { window: 'win_1' } };
      return { action: 'accept', content: { confirm: true } };
    });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    expect(transport.sessionId).toBeDefined();

    const list = await client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;

    const r = await client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'water heater leaking at the base' } });

    expect(asked.map(a => a.field)).toEqual(['provider', 'window', 'confirm']);
    expect(asked[0]?.options.length).toBeLessThanOrEqual(5);
    expect(asked[0]?.options).toContain('prov_kettle_water');
    expect(asked[1]?.options).toEqual(['win_1', 'win_2', 'win_3']);

    const sc = r.structuredContent as { visitId: string; provider: string; windowStart: string; status: string };
    expect(sc.provider).toBe('Kettle Creek Water Heaters');
    expect(sc.windowStart).toBe('2026-09-15T13:00:00.000Z');
    expect(sc.status).toBe('scheduled');
    expect((await deps.repo.getVisit(sc.visitId))?.providerId).toBe('prov_kettle_water');

    await client.close();
  });

  it('stops without writing anything when the legacy client declines', async () => {
    const { url, deps } = await listen();
    const client = new Client({ name: 'legacy-decliner', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    let asks = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      asks += 1;
      return { action: 'decline' };
    });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    const list = await client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    const r = await client.callTool({ name: 'book_service', arguments: { applianceId, issue: 'no hot water' } });
    expect(asks).toBe(1);
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("Okay, I haven't booked anything.");
    expect(await deps.repo.listVisitsSince('2026-01-01T00:00:00.000Z')).toEqual([]);
    await client.close();
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @homeledger/mcp-server test -- book-service-legacy`
Expected: PASS on the first run — `book_service` already exists from Task 5 and the shim is the same one `echo_confirm` proved in Plan 1. This test exists to catch the three-round case, which `echo_confirm` never exercised.

Three failure modes and what each means:
- The second elicitation never arrives: the shim is not re-entering the handler with the accumulated `inputResponses`. Check `ServerOptions.inputRequired.legacyShim` and `roundTimeoutMs` in `apps/mcp-server/node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts`; the shim is on by default with a 600 000 ms per-leg timeout.
- The third round fails with `-32602 Invalid or expired requestState`: the shim's in-process rounds still carry `requestState` through the codec, and `bind` includes `ctx.mcpReq.method`, which must be `tools/call` on every round. If the bound method differs between rounds, drop `bind` in `buildServer` and record it.
- The v1 client rejects the elicitation params: the `enum` + `enumNames` shape is not accepted. Switch `enumField` in `apps/mcp-server/src/elicit.ts` to the `oneOf: [{ const, title }]` shape and re-run both the modern and legacy tests.

Each of those gets a `FRICTION-LOG.md` entry before the workaround is committed; the next free number after Task 5's entry is FL-024.

- [ ] **Step 3: Run the whole server suite**

Run: `pnpm --filter @homeledger/mcp-server test && pnpm --filter @homeledger/mcp-server typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp-server
git commit -m "test(mcp-server): book_service elicitation over the legacy shim on a real socket"
```

---

### Task 7: Progress notifications 0→3 during the availability check

**Files:**
- Create: `apps/mcp-server/src/progress.ts`
- Modify: `apps/mcp-server/src/tools/service.ts`, `FRICTION-LOG.md`
- Test: `apps/mcp-server/test/progress.test.ts`

**Interfaces:**
- Consumes: `ctx.mcpReq._meta?.progressToken` and `ctx.mcpReq.notify(notification)` from the v2 `ServerContext`; `Progress` (`{ progress: number; total?: number; message?: string }`) on the client side.
- Produces:
  ```ts
  export const AVAILABILITY_STEPS: readonly string[];  // three step messages
  export async function reportProgress(ctx: ServerContext, progress: number, total: number, message: string): Promise<void>;
  export async function runAvailabilityCheck(ctx: ServerContext, totalDelayMs: number, providerName: string): Promise<void>;
  ```
  `runAvailabilityCheck` emits exactly four `notifications/progress` messages with `progress` 0, 1, 2, 3 and `total` 3, sleeping `totalDelayMs / 3` between them, and emits nothing at all when the request carried no `progressToken`.

- [ ] **Step 1: Write the failing test**

`apps/mcp-server/test/progress.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../src/app.js';
import { modernElicitClient, seededDeps } from './harness.js';

let server: Server | undefined;
let closeApp: () => Promise<void> = async () => {};
let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
  close = async () => {};
  await closeApp();
  closeApp = async () => {};
  await new Promise<void>(r => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe('book_service progress on the modern client', () => {
  it('reports 0, 1, 2, 3 of 3 while checking availability', async () => {
    const h = await modernElicitClient(field => {
      if (field === 'provider') return { action: 'accept', content: { provider: 'prov_kettle_water' } };
      if (field === 'window') return { action: 'accept', content: { window: 'win_1' } };
      return { action: 'accept', content: { confirm: true } };
    });
    close = h.close;
    const list = await h.client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    const seen: Array<{ progress: number; total?: number; message?: string }> = [];
    const r = await h.client.callTool(
      { name: 'book_service', arguments: { applianceId, issue: 'water heater leaking at the base' } },
      { onprogress: p => seen.push({ progress: p.progress, total: p.total, message: p.message }) }
    );
    expect((r.structuredContent as { status: string }).status).toBe('scheduled');
    expect(seen.map(p => p.progress)).toEqual([0, 1, 2, 3]);
    expect(seen.every(p => p.total === 3)).toBe(true);
    expect(seen[0]?.message).toBe('Checking Kettle Creek Water Heaters for openings');
    expect(seen[3]?.message).toBe('Found three windows');
  });
});

describe('book_service progress on the legacy client', () => {
  it('reports 0, 1, 2, 3 of 3 over the session stream', async () => {
    const deps = await seededDeps();
    const app = createApp(deps);
    closeApp = app.close;
    server = app.app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server!.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;

    const client = new Client({ name: 'legacy-progress', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async request => {
      const requestedSchema = request.params.requestedSchema as { properties: Record<string, unknown> };
      const field = Object.keys(requestedSchema.properties)[0] ?? '';
      if (field === 'provider') return { action: 'accept', content: { provider: 'prov_kettle_water' } };
      if (field === 'window') return { action: 'accept', content: { window: 'win_1' } };
      return { action: 'accept', content: { confirm: true } };
    });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    const list = await client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } });
    const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    const seen: number[] = [];
    const r = await client.callTool(
      { name: 'book_service', arguments: { applianceId, issue: 'water heater leaking at the base' } },
      undefined,
      { onprogress: p => seen.push(p.progress) }
    );
    expect((r.structuredContent as { status: string }).status).toBe('scheduled');
    expect(seen).toEqual([0, 1, 2, 3]);
    await client.close();
  });
});
```

The v1 SDK's `callTool(params, resultSchema, options)` takes options as its third argument, hence the `undefined` in the middle; the v2 client takes `callTool(params, options)`. Both signatures were read from the installed packages.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @homeledger/mcp-server test -- progress`
Expected: FAIL — `seen` is empty, because nothing emits progress yet.

- [ ] **Step 3: Implement progress reporting**

`apps/mcp-server/src/progress.ts`:
```ts
import type { ServerContext } from '@modelcontextprotocol/server';

export const AVAILABILITY_TOTAL = 3;

/**
 * Sends one notifications/progress related to the request being handled.
 *
 * A request that did not ask for progress carries no progressToken in
 * ctx.mcpReq._meta, and the spec forbids sending progress in that case, so
 * this is a no-op then. ctx.mcpReq.notify associates the notification with
 * the in-flight request, which is what routes it onto the right stream for
 * both the stateless modern handler and the sessionful legacy transport.
 */
export async function reportProgress(ctx: ServerContext, progress: number, total: number, message: string): Promise<void> {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined) return;
  await ctx.mcpReq.notify({
    method: 'notifications/progress',
    params: { progressToken, progress, total, message }
  });
}

export const AVAILABILITY_STEPS = ['Checking availability', 'Comparing arrival windows', 'Found three windows'] as const;

/**
 * The simulated availability check. Bounded by construction: three equal
 * sleeps summing to totalDelayMs (600 ms on the deployed runtime, 0 in
 * tests), well inside the 3 s per-tool budget.
 */
export async function runAvailabilityCheck(ctx: ServerContext, totalDelayMs: number, providerName: string): Promise<void> {
  const step = Math.max(0, Math.floor(totalDelayMs / AVAILABILITY_TOTAL));
  await reportProgress(ctx, 0, AVAILABILITY_TOTAL, `Checking ${providerName} for openings`);
  for (let i = 0; i < AVAILABILITY_TOTAL; i++) {
    if (step > 0) await new Promise(resolve => setTimeout(resolve, step));
    await reportProgress(ctx, i + 1, AVAILABILITY_TOTAL, AVAILABILITY_STEPS[i]!);
  }
}
```

In `apps/mcp-server/src/tools/service.ts`, delete the placeholder `checkAvailability` function at the bottom of the file, add the import:
```ts
import { runAvailabilityCheck } from '../progress.js';
```
and change the call site inside the window branch from:
```ts
          await checkAvailability(ctx, deps, provider.name);
```
to:
```ts
          await runAvailabilityCheck(ctx, deps.availabilityDelayMs, provider.name);
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @homeledger/mcp-server test -- progress`
Expected: PASS (2 tests).

If `ctx.mcpReq.notify` rejects the notification literal at compile time, the params type is narrower than `Notification` — cast the argument as `ProgressNotification` imported from `@modelcontextprotocol/server` and record the mismatch.

If the **modern** test sees no progress: the modern branch emits these notifications before an `input_required` result, and `createMcpHandler`'s default `responseMode: 'auto'` must upgrade that exchange to SSE for them to be delivered. Two things to check before changing anything: that `apps/mcp-server/src/app.ts` does not pass `responseMode: 'json'` (it does not today), and that the client's MRTR driver carries `onprogress` into the retried rounds. If it does not, move `runAvailabilityCheck` to the final round — immediately before `deps.repo.putVisit` — where the handler returns a normal `CallToolResult`, update the modern test to expect progress there, keep the legacy assertion as it is, and file the finding.

If the **legacy** test sees no progress: confirm the shim preserves `ctx.mcpReq._meta.progressToken` across its in-process rounds. If it does not, emit progress only on the first round (where the token is certainly present) and record the limitation.

- [ ] **Step 5: Run the whole suite and check the budget**

Run: `pnpm --filter @homeledger/mcp-server test && pnpm --filter @homeledger/mcp-server typecheck`
Expected: PASS. `availabilityDelayMs` is 0 in tests, so no test gets slower.

- [ ] **Step 6: Record the progress findings**

Append `FL-024` (or the next free number) to `FRICTION-LOG.md` stating which generations delivered progress alongside which result kind, whether `onprogress` survived the modern MRTR retries, and where the availability check ended up. Cite `https://modelcontextprotocol.io/specification/2026-07-28/changelog` and `https://ts.sdk.modelcontextprotocol.io/v2/serving/http`.

- [ ] **Step 7: Commit**

```bash
git add apps/mcp-server FRICTION-LOG.md
git commit -m "feat(mcp-server): progress notifications during the book_service availability check"
```

---

### Task 8: `get_visit`

**Files:**
- Modify: `apps/mcp-server/src/tools/service.ts`, `apps/mcp-server/test/tools.test.ts`, `apps/mcp-server/test/legacy.test.ts`
- Test: `apps/mcp-server/test/visits.test.ts`

**Interfaces:**
- Consumes: `Repository.getVisit`, `Repository.getAppliance`, `VisitStatus` from `@homeledger/core`.
- Produces: tool `get_visit`, input `{ visitId: string }`, output
  ```ts
  {
    visit: { id: string; providerName: string; applianceId: string; applianceName: string; issue: string; windowStart: string; windowEnd: string; status: VisitStatus; arrivedAt: string | null };
    snapshotUrl: string | null;
    description: string | null;
  }
  ```
  `snapshotUrl` and `description` are always present and always `null` until the Ring plan presigns `visit.snapshotKey` and writes the vision sentence. Registered immediately after `book_service`, making the frozen order complete.

- [ ] **Step 1: Write the failing test**

`apps/mcp-server/test/visits.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { hasJson } from '../src/voice.js';
import { modernClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
});

describe('get_visit', () => {
  it('returns the visit with empty snapshot and description fields', async () => {
    const h = await modernClient();
    close = h.close;
    const appliance = (await h.deps.repo.listAppliances({ category: 'water_heater' }))[0]!;
    await h.deps.repo.putVisit({
      id: 'visit_aaaaaaaaaaaaaaaa',
      providerId: 'prov_kettle_water',
      providerName: 'Kettle Creek Water Heaters',
      category: 'water_heater',
      applianceId: appliance.id,
      issue: 'water heater leaking at the base',
      windowStart: '2026-09-15T13:00:00.000Z',
      windowEnd: '2026-09-15T15:00:00.000Z',
      status: 'scheduled',
      ringEventIds: [],
      snapshotKey: null,
      description: null,
      arrivedAt: null,
      createdAt: '2026-09-13T12:00:00.000Z'
    });
    const r = await h.client.callTool({ name: 'get_visit', arguments: { visitId: 'visit_aaaaaaaaaaaaaaaa' } });
    const sc = r.structuredContent as {
      visit: { providerName: string; applianceName: string; status: string; arrivedAt: string | null };
      snapshotUrl: string | null;
      description: string | null;
    };
    expect(sc.visit.providerName).toBe('Kettle Creek Water Heaters');
    expect(sc.visit.applianceName).toBe('Water heater');
    expect(sc.visit.status).toBe('scheduled');
    expect(sc.visit.arrivedAt).toBeNull();
    expect(sc.snapshotUrl).toBeNull();
    expect(sc.description).toBeNull();
    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(hasJson(text)).toBe(false);
    expect(text).toBe('Kettle Creek Water Heaters is scheduled for the water heater on Tuesday, September 15, 1 to 3 PM.');
  });

  it('speaks an arrived visit differently', async () => {
    const h = await modernClient();
    close = h.close;
    const appliance = (await h.deps.repo.listAppliances({ category: 'water_heater' }))[0]!;
    await h.deps.repo.putVisit({
      id: 'visit_bbbbbbbbbbbbbbbb',
      providerId: 'prov_kettle_water',
      providerName: 'Kettle Creek Water Heaters',
      category: 'water_heater',
      applianceId: appliance.id,
      issue: 'water heater leaking at the base',
      windowStart: '2026-09-15T13:00:00.000Z',
      windowEnd: '2026-09-15T15:00:00.000Z',
      status: 'arrived',
      ringEventIds: ['ring-evt-1'],
      snapshotKey: 'snapshots/hh_test/visit_b.jpg',
      description: null,
      arrivedAt: '2026-09-15T13:07:00.000Z',
      createdAt: '2026-09-13T12:00:00.000Z'
    });
    const r = await h.client.callTool({ name: 'get_visit', arguments: { visitId: 'visit_bbbbbbbbbbbbbbbb' } });
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe('Kettle Creek Water Heaters arrived for the water heater on Tuesday, September 15.');
    expect((r.structuredContent as { snapshotUrl: string | null }).snapshotUrl).toBeNull();
  });

  it('answers an unknown visit id with a friendly error', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'get_visit', arguments: { visitId: 'visit_zzzzzzzzzzzzzzzz' } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("I couldn't find that visit.");
  });
});
```

Update the order assertion in `apps/mcp-server/test/tools.test.ts` and in `apps/mcp-server/test/legacy.test.ts` to the final frozen order:
```ts
    expect(tools.map(t => t.name)).toEqual([
      'list_appliances',
      'get_appliance',
      'maintenance_due',
      'log_maintenance',
      'recent_events',
      'ask_manual',
      'book_service',
      'get_visit',
      'echo_confirm'
    ]);
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @homeledger/mcp-server test -- visits tools legacy`
Expected: FAIL — tool `get_visit` not found and both order assertions mismatch.

- [ ] **Step 3: Implement `get_visit`**

Append inside `registerServiceTools` in `apps/mcp-server/src/tools/service.ts`, after the `book_service` registration:
```ts
  server.registerTool(
    'get_visit',
    {
      title: 'Get a service visit',
      description:
        'Details for one scheduled or past service visit: who is coming, for which appliance, in which window, and whether they have arrived. Includes a doorbell snapshot and a one-line description once the visit has been matched to a door event.',
      inputSchema: z.object({ visitId: z.string() }),
      outputSchema: z.object({
        visit: z.object({
          id: z.string(),
          providerName: z.string(),
          applianceId: z.string(),
          applianceName: z.string(),
          issue: z.string(),
          windowStart: z.string(),
          windowEnd: z.string(),
          status: VisitStatus,
          arrivedAt: z.string().nullable()
        }),
        snapshotUrl: z.string().nullable(),
        description: z.string().nullable()
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ visitId }) => {
      const visit = await deps.repo.getVisit(visitId);
      if (!visit) return { content: [{ type: 'text', text: "I couldn't find that visit." }], isError: true };
      const appliance = await deps.repo.getAppliance(visit.applianceId);
      const applianceName = appliance?.name ?? 'appliance';
      const applianceWords = applianceName.toLowerCase();
      const day = speakWeekdayDate(visit.windowStart.slice(0, 10));
      const spoken =
        visit.status === 'scheduled'
          ? `${visit.providerName} is scheduled for the ${applianceWords} on ${day}, 1 to 3 PM.`
          : `${visit.providerName} ${visit.status} for the ${applianceWords} on ${day}.`;
      return {
        content: [{ type: 'text', text: spoken }],
        structuredContent: {
          visit: {
            id: visit.id,
            providerName: visit.providerName,
            applianceId: visit.applianceId,
            applianceName,
            issue: visit.issue,
            windowStart: visit.windowStart,
            windowEnd: visit.windowEnd,
            status: visit.status,
            arrivedAt: visit.arrivedAt
          },
          // Both filled in by the Ring plan: snapshotUrl from a short-TTL
          // presign of visit.snapshotKey, description from the Nova vision
          // sentence. Always present, always null until then.
          snapshotUrl: null,
          description: visit.description
        }
      };
    }
  );
```

The spoken window text is hard-coded to "1 to 3 PM" because `availabilityWindows` only ever produces that slot; if the window generator gains other slots, derive it from `visit.windowStart` and `visit.windowEnd` instead.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @homeledger/mcp-server test && pnpm --filter @homeledger/mcp-server typecheck`
Expected: PASS. The frozen nine-tool order now holds on both client generations.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp-server
git commit -m "feat(mcp-server): get_visit tool with snapshot and description placeholders"
```

---

### Task 9: Bedrock Knowledge Base retriever with a 10-minute cache

**Files:**
- Create: `packages/core/src/retrieval/bedrock.ts`
- Modify: `packages/core/package.json`, `packages/core/src/index.ts`, `apps/mcp-server/src/deps.ts`
- Test: `packages/core/test/bedrock-retriever.test.ts`

**Interfaces:**
- Consumes: `@aws-sdk/client-bedrock-agent-runtime`'s `BedrockAgentRuntimeClient`, `RetrieveCommand`, `RetrieveCommandInput`, `RetrieveCommandOutput`; `ManualRetriever`, `Passage`, `clampPassages` from `./retriever.js`.
- Produces:
  ```ts
  export interface RetrieveSender { send(command: RetrieveCommand): Promise<RetrieveCommandOutput> }
  export interface KnowledgeBaseRetrieverOptions {
    knowledgeBaseId: string;
    client?: RetrieveSender;
    region?: string;
    cacheTtlMs?: number;     // default CACHE_TTL_MS
    now?: () => number;      // default Date.now
  }
  export const CACHE_TTL_MS = 600_000;
  export const PAGE_METADATA_KEY = 'x-amz-bedrock-kb-document-page-number';
  export const SOURCE_URI_METADATA_KEY = 'x-amz-bedrock-kb-source-uri';
  export function createKnowledgeBaseRetriever(options: KnowledgeBaseRetrieverOptions): ManualRetriever;
  ```
  Spec 4.6: "Knowledge Base retrieval is the only external call on the hot path; results are cached per question for 10 minutes."

- [ ] **Step 1: Add the dependency**

Add to `packages/core/package.json` `dependencies`:
```json
    "@aws-sdk/client-bedrock-agent-runtime": "^3.900.0",
```
Run: `pnpm install`
Expected: the package resolves at 3.11xx or later alongside the existing `@aws-sdk/client-dynamodb`.

- [ ] **Step 2: Write the failing test**

`packages/core/test/bedrock-retriever.test.ts`:
```ts
import type { RetrieveCommand, RetrieveCommandOutput } from '@aws-sdk/client-bedrock-agent-runtime';
import { describe, expect, it } from 'vitest';
import { CACHE_TTL_MS, PAGE_METADATA_KEY, SOURCE_URI_METADATA_KEY, createKnowledgeBaseRetriever, type RetrieveSender } from '../src/retrieval/bedrock.js';

function stub(output: RetrieveCommandOutput): { sender: RetrieveSender; calls: Array<RetrieveCommand['input']> } {
  const calls: Array<RetrieveCommand['input']> = [];
  return {
    calls,
    sender: {
      async send(command: RetrieveCommand) {
        calls.push(command.input);
        return output;
      }
    }
  };
}

const twoResults: RetrieveCommandOutput = {
  $metadata: {},
  retrievalResults: [
    {
      content: { text: 'Error code F21 indicates a long drain time.' },
      score: 0.91,
      metadata: { title: 'LG WM4000HWA washer owner manual', [PAGE_METADATA_KEY]: 42, applianceId: 'appl_wwwwwwwwwwwwwwww' }
    },
    {
      content: { text: 'Clean the drain pump filter every month.' },
      score: 0.77,
      metadata: { [SOURCE_URI_METADATA_KEY]: 's3://homeledger-manuals/manuals/hh_harlow/doc_abcdefghijklmnop.pdf' }
    }
  ]
};

describe('knowledge base retriever', () => {
  it('asks for three results and maps content, title, page, and score', async () => {
    const { sender, calls } = stub(twoResults);
    const retriever = createKnowledgeBaseRetriever({ knowledgeBaseId: 'KB123', client: sender });
    const passages = await retriever.retrieve({ question: 'What does F21 mean?' });
    expect(calls[0]?.knowledgeBaseId).toBe('KB123');
    expect(calls[0]?.retrievalQuery?.text).toBe('What does F21 mean?');
    expect(calls[0]?.retrievalConfiguration?.vectorSearchConfiguration?.numberOfResults).toBe(3);
    expect(calls[0]?.retrievalConfiguration?.vectorSearchConfiguration?.filter).toBeUndefined();
    expect(passages).toEqual([
      { text: 'Error code F21 indicates a long drain time.', docTitle: 'LG WM4000HWA washer owner manual', page: 42, score: 0.91 },
      { text: 'Clean the drain pump filter every month.', docTitle: 'doc_abcdefghijklmnop.pdf', page: null, score: 0.77 }
    ]);
  });

  it('adds an equals filter on applianceId when one is supplied', async () => {
    const { sender, calls } = stub(twoResults);
    const retriever = createKnowledgeBaseRetriever({ knowledgeBaseId: 'KB123', client: sender });
    await retriever.retrieve({ question: 'drain', applianceId: 'appl_wwwwwwwwwwwwwwww' });
    expect(calls[0]?.retrievalConfiguration?.vectorSearchConfiguration?.filter).toEqual({
      equals: { key: 'applianceId', value: 'appl_wwwwwwwwwwwwwwww' }
    });
  });

  it('serves a repeated question from cache for ten minutes, then refetches', async () => {
    const { sender, calls } = stub(twoResults);
    let clock = 1_000_000;
    const retriever = createKnowledgeBaseRetriever({ knowledgeBaseId: 'KB123', client: sender, now: () => clock });
    await retriever.retrieve({ question: 'What does F21 mean?' });
    await retriever.retrieve({ question: '  what DOES f21 mean?  ' });
    expect(calls.length).toBe(1);
    clock += CACHE_TTL_MS + 1;
    await retriever.retrieve({ question: 'What does F21 mean?' });
    expect(calls.length).toBe(2);
  });

  it('caches per appliance filter, not just per question', async () => {
    const { sender, calls } = stub(twoResults);
    const retriever = createKnowledgeBaseRetriever({ knowledgeBaseId: 'KB123', client: sender });
    await retriever.retrieve({ question: 'drain' });
    await retriever.retrieve({ question: 'drain', applianceId: 'appl_wwwwwwwwwwwwwwww' });
    expect(calls.length).toBe(2);
  });

  it('returns an empty list when the knowledge base has no results', async () => {
    const { sender } = stub({ $metadata: {}, retrievalResults: [] });
    const retriever = createKnowledgeBaseRetriever({ knowledgeBaseId: 'KB123', client: sender });
    expect(await retriever.retrieve({ question: 'anything' })).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @homeledger/core test -- bedrock-retriever`
Expected: FAIL, cannot find module `../src/retrieval/bedrock.js`.

- [ ] **Step 4: Implement the retriever**

`packages/core/src/retrieval/bedrock.ts`:
```ts
import { BedrockAgentRuntimeClient, RetrieveCommand, type RetrieveCommandOutput } from '@aws-sdk/client-bedrock-agent-runtime';
import { type ManualRetriever, type Passage, type RetrieveOptions, clampPassages } from './retriever.js';

/**
 * The single method this adapter needs from the AWS client. Narrowing it here
 * keeps tests free of the SDK's overloaded generic send() signature.
 */
export interface RetrieveSender {
  send(command: RetrieveCommand): Promise<RetrieveCommandOutput>;
}

/** Spec 4.6: retrieval results are cached per question for ten minutes. */
export const CACHE_TTL_MS = 600_000;

/** Metadata keys Bedrock attaches to every chunk from an S3 data source. */
export const PAGE_METADATA_KEY = 'x-amz-bedrock-kb-document-page-number';
export const SOURCE_URI_METADATA_KEY = 'x-amz-bedrock-kb-source-uri';

export interface KnowledgeBaseRetrieverOptions {
  knowledgeBaseId: string;
  client?: RetrieveSender;
  region?: string;
  cacheTtlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  expiresAt: number;
  passages: Passage[];
}

function pageOf(metadata: Record<string, unknown> | undefined): number | null {
  const raw = metadata?.[PAGE_METADATA_KEY];
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return null;
}

function titleOf(metadata: Record<string, unknown> | undefined): string {
  const title = metadata?.title;
  if (typeof title === 'string' && title.length > 0) return title;
  const uri = metadata?.[SOURCE_URI_METADATA_KEY];
  if (typeof uri === 'string' && uri.length > 0) return uri.slice(uri.lastIndexOf('/') + 1);
  return 'Appliance manual';
}

function cacheKey(question: string, applianceId: string | undefined, limit: number): string {
  return `${applianceId ?? ''}\0${question.trim().toLowerCase().replace(/\s+/g, ' ')}\0${limit}`;
}

export function createKnowledgeBaseRetriever(options: KnowledgeBaseRetrieverOptions): ManualRetriever {
  const sender: RetrieveSender = options.client ?? new BedrockAgentRuntimeClient({ region: options.region ?? process.env.AWS_REGION ?? 'us-east-1' });
  const ttl = options.cacheTtlMs ?? CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  return {
    async retrieve(request: RetrieveOptions): Promise<Passage[]> {
      const limit = clampPassages(request.maxPassages);
      const key = cacheKey(request.question, request.applianceId, limit);
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) return hit.passages;

      const command = new RetrieveCommand({
        knowledgeBaseId: options.knowledgeBaseId,
        retrievalQuery: { text: request.question },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: limit,
            ...(request.applianceId ? { filter: { equals: { key: 'applianceId', value: request.applianceId } } } : {})
          }
        }
      });
      const response = await sender.send(command);
      const passages: Passage[] = (response.retrievalResults ?? [])
        .filter(result => typeof result.content?.text === 'string' && result.content.text.length > 0)
        .slice(0, limit)
        .map(result => ({
          text: result.content!.text!,
          docTitle: titleOf(result.metadata),
          page: pageOf(result.metadata),
          score: result.score ?? 0
        }));

      cache.set(key, { expiresAt: now() + ttl, passages });
      return passages;
    }
  };
}
```

If TypeScript rejects `options.client ?? new BedrockAgentRuntimeClient(...)` because the real client's overloaded `send` is not assignable to `RetrieveSender`, wrap the concrete client instead of casting the interface away:
```ts
  const aws = new BedrockAgentRuntimeClient({ region: options.region ?? process.env.AWS_REGION ?? 'us-east-1' });
  const sender: RetrieveSender = options.client ?? { send: command => aws.send(command) };
```
and construct `aws` lazily only when `options.client` is absent.

Append to `packages/core/src/index.ts`:
```ts
export * from './retrieval/bedrock.js';
```

- [ ] **Step 5: Wire it into `deps.ts`**

In `apps/mcp-server/src/deps.ts`, add `createKnowledgeBaseRetriever` to the `@homeledger/core` import list and replace the body of `resolveRetriever` with:
```ts
function resolveRetriever(env: NodeJS.ProcessEnv): ManualRetriever {
  const knowledgeBaseId = env.KNOWLEDGE_BASE_ID;
  if (!knowledgeBaseId) {
    console.log(JSON.stringify({ msg: 'retriever', kind: 'fixture', reason: 'KNOWLEDGE_BASE_ID unset' }));
    return createFixtureRetriever(SAMPLE_MANUAL_PASSAGES);
  }
  console.log(JSON.stringify({ msg: 'retriever', kind: 'knowledge-base', knowledgeBaseId }));
  return createKnowledgeBaseRetriever({ knowledgeBaseId, region: env.AWS_REGION });
}
```

Add to `.env.example`:
```
KNOWLEDGE_BASE_ID=
AVAILABILITY_DELAY_MS=600
REQUEST_STATE_KEY=
```

- [ ] **Step 6: Run everything**

```bash
pnpm --filter @homeledger/core test
pnpm --filter @homeledger/core build
pnpm --filter @homeledger/mcp-server test
pnpm typecheck
```
Expected: PASS throughout.

- [ ] **Step 7: Commit**

```bash
git add packages/core apps/mcp-server .env.example pnpm-lock.yaml
git commit -m "feat(core): Bedrock Knowledge Base retriever with a ten-minute per-question cache"
```

---

### Task 10: Terraform knowledge-base module, runtime wiring, and the S3 Vectors verification

**Files:**
- Create: `infra/modules/knowledge-base/versions.tf`, `infra/modules/knowledge-base/variables.tf`, `infra/modules/knowledge-base/main.tf`, `infra/modules/knowledge-base/outputs.tf`, `infra/modules/knowledge-base/README.md`, `infra/modules/knowledge-base/tests/knowledge-base.tftest.hcl`
- Modify: `infra/modules/agentcore-runtime/variables.tf`, `infra/modules/agentcore-runtime/main.tf`, `infra/modules/agentcore-runtime/README.md`, `infra/modules/agentcore-runtime/tests/agentcore-runtime.tftest.hcl`, `infra/live/demo/platform/main.tf`, `infra/live/demo/platform/variables.tf`, `infra/live/demo/platform/outputs.tf`, `infra/live/demo/platform/tests/platform.tftest.hcl`, `.github/workflows/ci.yml`, `FRICTION-LOG.md`

**Interfaces:**
- Consumes: `local.name_prefix` and the existing module wiring in `infra/live/demo/platform/main.tf`.
- Produces module `knowledge-base` with inputs `name_prefix`, `household_id`, `embedding_model_arn`, `vector_dimension`, `force_destroy`, and outputs `manuals_bucket` (name), `manuals_bucket_arn`, `knowledge_base_id`, `knowledge_base_arn`, `data_source_id`, `vector_index_arn`. Produces new root outputs `manuals_bucket`, `knowledge_base_id`, `data_source_id`. Produces a new `agentcore-runtime` input `knowledge_base_arn` (default `""`) that adds a `bedrock:Retrieve` statement when set, and two new runtime environment variables `KNOWLEDGE_BASE_ID` and `REQUEST_STATE_KEY`.

Resource names were verified against the provider binary already in the committed lockfile (`hashicorp/aws` 6.64.0): it contains `aws_s3vectors_vector_bucket`, `aws_s3vectors_index`, `aws_s3vectors_vector_bucket_policy`, `aws_bedrockagent_knowledge_base`, `aws_bedrockagent_data_source`, and the schema strings `s3_vectors_configuration`, `S3_VECTORS`, `vector_bucket_name`, `index_arn`, `embedding_model_arn`. FL-016 predicted these might be missing; Step 1 below confirms the exact attribute names before any HCL is written, and records the outcome either way.

- [ ] **Step 1: Verify the provider schema before writing HCL**

```bash
cd infra/live/demo/platform
terraform init -backend=false
terraform providers schema -json > /tmp/aws-schema.json
jq '.provider_schemas["registry.terraform.io/hashicorp/aws"].resource_schemas.aws_s3vectors_vector_bucket.block.attributes | keys' /tmp/aws-schema.json
jq '.provider_schemas["registry.terraform.io/hashicorp/aws"].resource_schemas.aws_s3vectors_index.block.attributes | keys' /tmp/aws-schema.json
jq '.provider_schemas["registry.terraform.io/hashicorp/aws"].resource_schemas.aws_bedrockagent_knowledge_base.block.block_types.storage_configuration' /tmp/aws-schema.json
jq '.provider_schemas["registry.terraform.io/hashicorp/aws"].resource_schemas.aws_bedrockagent_data_source.block.block_types.data_source_configuration' /tmp/aws-schema.json
```
Expected: `aws_s3vectors_vector_bucket` exposes `vector_bucket_name` and `arn`; `aws_s3vectors_index` exposes `index_name`, `vector_bucket_name`, `data_type`, `dimension`, `distance_metric`, `arn`; `aws_bedrockagent_knowledge_base.storage_configuration` accepts `type` plus a nested `s3_vectors_configuration` carrying `index_arn`; `aws_bedrockagent_data_source.data_source_configuration` accepts `type = "S3"` with `s3_configuration { bucket_arn, inclusion_prefixes }`.

Three outcomes, all of which end in a `FRICTION-LOG.md` entry that also closes out FL-016:
- **Everything present with these names:** write the HCL below unchanged. File the entry stating the provider version that carries them, and change FL-016's `- **Status:**` line to `Resolved. Verified in hashicorp/aws 6.64.0; see FL-025.`
- **Present with different attribute names:** rename to match the schema dump, keep every other line, and record the exact delta.
- **`aws_s3vectors_index` or `s3_vectors_configuration` absent:** take the fallback. Add the AWSCC provider to `infra/modules/knowledge-base/versions.tf`:
  ```hcl
    awscc = {
      source  = "hashicorp/awscc"
      version = ">= 1.60.0, < 2.0.0"
    }
  ```
  and substitute `awscc_s3vectors_index` for `aws_s3vectors_index`, passing its `arn` into the knowledge base exactly as below. If AWSCC does not carry it either, create the vector bucket and index once by hand and adopt them with a `data` source plus an `import` block:
  ```bash
  aws s3vectors create-vector-bucket --vector-bucket-name demo-homeledger-vectors --region "$AWS_REGION"
  aws s3vectors create-index --vector-bucket-name demo-homeledger-vectors --index-name manuals \
    --data-type float32 --dimension 1024 --distance-metric cosine --region "$AWS_REGION"
  ```
  then set `var.vector_index_arn` on the module and skip the two resources with `count = var.vector_index_arn == "" ? 1 : 0`. Record which path was taken, the commands run, and why.

Never run `terraform plan` or `terraform apply` here. `terraform providers schema -json` needs only `init -backend=false` and touches no state.

- [ ] **Step 2: Write the module's versions, variables, and tests**

`infra/modules/knowledge-base/versions.tf`:
```hcl
terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.21.0, < 7.0.0"
    }
  }
}
```

`infra/modules/knowledge-base/variables.tf`:
```hcl
variable "name_prefix" {
  type        = string
  description = "Prefix applied to every resource name in this module, e.g. \"demo-homeledger\"."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,40}$", var.name_prefix))
    error_message = "name_prefix must be lowercase letters, digits, and hyphens, 2 to 41 characters."
  }
}

variable "household_id" {
  type        = string
  description = "Household id. Manuals live under manuals/<household_id>/ in the bucket, and the data source ingests only that prefix."

  validation {
    condition     = can(regex("^hh_[a-z0-9_]+$", var.household_id))
    error_message = "household_id must match ^hh_[a-z0-9_]+$."
  }
}

variable "embedding_model_arn" {
  type        = string
  description = "ARN of the Bedrock embedding model the knowledge base uses. Titan Text Embeddings v2 by default; it must be enabled in this account and region."
  default     = ""
}

variable "vector_dimension" {
  type        = number
  description = "Embedding dimension of the S3 Vectors index. Titan Text Embeddings v2 emits 1024 by default and also supports 512 and 256."
  default     = 1024

  validation {
    condition     = contains([256, 512, 1024], var.vector_dimension)
    error_message = "vector_dimension must be 256, 512, or 1024 to match Titan Text Embeddings v2."
  }
}

variable "force_destroy" {
  type        = bool
  description = "Whether the manuals bucket may be destroyed while it still holds objects. True in the demo environment so teardown is one command."
  default     = true
}
```

`infra/modules/knowledge-base/tests/knowledge-base.tftest.hcl`:
```hcl
mock_provider "aws" {
  override_data {
    target = data.aws_iam_policy_document.kb_trust
    values = {
      json = jsonencode({ Version = "2012-10-17", Statement = [] })
    }
  }

  override_data {
    target = data.aws_iam_policy_document.kb
    values = {
      json = jsonencode({ Version = "2012-10-17", Statement = [] })
    }
  }

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
    }
  }
}

variables {
  name_prefix  = "demo-homeledger"
  household_id = "hh_harlow"
}

run "manuals_bucket_is_private_and_versioned" {
  command = plan

  assert {
    condition     = aws_s3_bucket_public_access_block.manuals.block_public_acls && aws_s3_bucket_public_access_block.manuals.block_public_policy && aws_s3_bucket_public_access_block.manuals.ignore_public_acls && aws_s3_bucket_public_access_block.manuals.restrict_public_buckets
    error_message = "the manuals bucket must block all public access"
  }

  assert {
    condition     = aws_s3_bucket_versioning.manuals.versioning_configuration[0].status == "Enabled"
    error_message = "the manuals bucket must be versioned"
  }
}

run "knowledge_base_uses_s3_vectors_and_titan" {
  command = plan

  assert {
    condition     = aws_bedrockagent_knowledge_base.manuals.storage_configuration[0].type == "S3_VECTORS"
    error_message = "the knowledge base must store vectors in S3 Vectors"
  }

  assert {
    condition     = aws_bedrockagent_knowledge_base.manuals.knowledge_base_configuration[0].type == "VECTOR"
    error_message = "the knowledge base must be a VECTOR knowledge base"
  }

  assert {
    condition     = endswith(local.embedding_model_arn, "amazon.titan-embed-text-v2:0")
    error_message = "the default embedding model must be Titan Text Embeddings v2"
  }
}

run "data_source_ingests_only_this_household" {
  command = plan

  assert {
    condition     = aws_bedrockagent_data_source.manuals.data_source_configuration[0].s3_configuration[0].inclusion_prefixes == tolist(["manuals/hh_harlow/"])
    error_message = "the data source must ingest only this household's manuals prefix"
  }
}

run "index_dimension_matches_the_embedding_model" {
  command = plan

  assert {
    condition     = aws_s3vectors_index.manuals.dimension == 1024
    error_message = "the vector index dimension must match Titan Text Embeddings v2"
  }
}

run "rejects_a_bad_dimension" {
  command = plan

  variables {
    vector_dimension = 768
  }

  expect_failures = [var.vector_dimension]
}

run "rejects_a_bad_household_id" {
  command = plan

  variables {
    household_id = "harlow"
  }

  expect_failures = [var.household_id]
}
```

- [ ] **Step 3: Run the module tests to verify they fail**

```bash
cd infra/modules/knowledge-base
terraform init -backend=false
terraform test
```
Expected: FAIL — no `main.tf` yet, so every referenced resource is undeclared.

- [ ] **Step 4: Write the module**

`infra/modules/knowledge-base/main.tf`:
```hcl
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id          = data.aws_caller_identity.current.account_id
  region              = data.aws_region.current.region
  manuals_bucket      = "${var.name_prefix}-manuals-${local.account_id}"
  vector_bucket       = "${var.name_prefix}-vectors"
  manuals_prefix      = "manuals/${var.household_id}/"
  embedding_model_arn = var.embedding_model_arn != "" ? var.embedding_model_arn : "arn:aws:bedrock:${local.region}::foundation-model/amazon.titan-embed-text-v2:0"
}

# ---------- Manuals bucket ----------
# Layout, from design section 5: manuals/<householdId>/<docId>.pdf plus a
# sidecar <docId>.pdf.metadata.json carrying applianceId and title. The
# sidecar is what makes the applianceId metadata filter possible at retrieval
# time; Bedrock reads it and never embeds it as a chunk.
resource "aws_s3_bucket" "manuals" {
  bucket        = local.manuals_bucket
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "manuals" {
  bucket                  = aws_s3_bucket.manuals.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "manuals" {
  bucket = aws_s3_bucket.manuals.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "manuals" {
  bucket = aws_s3_bucket.manuals.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ---------- S3 Vectors ----------
resource "aws_s3vectors_vector_bucket" "manuals" {
  vector_bucket_name = local.vector_bucket
}

resource "aws_s3vectors_index" "manuals" {
  index_name         = "manuals"
  vector_bucket_name = aws_s3vectors_vector_bucket.manuals.vector_bucket_name
  data_type          = "float32"
  dimension          = var.vector_dimension
  distance_metric    = "cosine"
}

# ---------- Knowledge base service role ----------
data "aws_iam_policy_document" "kb_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:bedrock:${local.region}:${local.account_id}:knowledge-base/*"]
    }
  }
}

data "aws_iam_policy_document" "kb" {
  statement {
    sid       = "InvokeEmbeddingModel"
    actions   = ["bedrock:InvokeModel"]
    resources = [local.embedding_model_arn]
  }
  statement {
    sid       = "ReadManuals"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.manuals.arn, "${aws_s3_bucket.manuals.arn}/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceAccount"
      values   = [local.account_id]
    }
  }
  statement {
    sid = "WriteVectors"
    actions = [
      "s3vectors:GetIndex",
      "s3vectors:ListIndexes",
      "s3vectors:PutVectors",
      "s3vectors:GetVectors",
      "s3vectors:QueryVectors",
      "s3vectors:DeleteVectors",
      "s3vectors:ListVectors"
    ]
    resources = [aws_s3vectors_vector_bucket.manuals.arn, aws_s3vectors_index.manuals.arn]
  }
}

resource "aws_iam_role" "kb" {
  name               = "${var.name_prefix}-knowledge-base"
  assume_role_policy = data.aws_iam_policy_document.kb_trust.json
}

resource "aws_iam_role_policy" "kb" {
  role   = aws_iam_role.kb.id
  policy = data.aws_iam_policy_document.kb.json
}

# ---------- Knowledge base and data source ----------
resource "aws_bedrockagent_knowledge_base" "manuals" {
  name        = "${var.name_prefix}-manuals"
  description = "HomeLedger appliance manuals, chunked and embedded for ask_manual retrieval."
  role_arn    = aws_iam_role.kb.arn

  knowledge_base_configuration {
    type = "VECTOR"
    vector_knowledge_base_configuration {
      embedding_model_arn = local.embedding_model_arn
    }
  }

  storage_configuration {
    type = "S3_VECTORS"
    s3_vectors_configuration {
      index_arn = aws_s3vectors_index.manuals.arn
    }
  }

  depends_on = [aws_iam_role_policy.kb]
}

resource "aws_bedrockagent_data_source" "manuals" {
  name              = "${var.name_prefix}-manuals-s3"
  knowledge_base_id = aws_bedrockagent_knowledge_base.manuals.id

  data_source_configuration {
    type = "S3"
    s3_configuration {
      bucket_arn         = aws_s3_bucket.manuals.arn
      inclusion_prefixes = [local.manuals_prefix]
    }
  }
}
```

`infra/modules/knowledge-base/outputs.tf`:
```hcl
output "manuals_bucket" {
  description = "Name of the S3 bucket holding manual PDFs and their metadata sidecars."
  value       = aws_s3_bucket.manuals.bucket
}

output "manuals_bucket_arn" {
  description = "ARN of the manuals bucket."
  value       = aws_s3_bucket.manuals.arn
}

output "manuals_prefix" {
  description = "Key prefix inside the manuals bucket that the data source ingests."
  value       = local.manuals_prefix
}

output "knowledge_base_id" {
  description = "Bedrock Knowledge Base id, passed to the runtime as KNOWLEDGE_BASE_ID."
  value       = aws_bedrockagent_knowledge_base.manuals.id
}

output "knowledge_base_arn" {
  description = "Bedrock Knowledge Base ARN, granted to the runtime execution role for bedrock:Retrieve."
  value       = aws_bedrockagent_knowledge_base.manuals.arn
}

output "data_source_id" {
  description = "Bedrock data source id, used by the manuals ingestion script to start ingestion jobs."
  value       = aws_bedrockagent_data_source.manuals.data_source_id
}

output "vector_index_arn" {
  description = "ARN of the S3 Vectors index backing the knowledge base."
  value       = aws_s3vectors_index.manuals.arn
}
```

If the schema dump in Step 1 showed `aws_bedrockagent_data_source` exposing the id under a different attribute than `data_source_id`, use the one it showed and note it.

- [ ] **Step 5: Run the module tests**

```bash
cd infra/modules/knowledge-base
terraform fmt
terraform init -backend=false
terraform validate
terraform test
```
Expected: 6 runs pass. Commit `infra/modules/knowledge-base/.terraform.lock.hcl` — `terraform init -backend=false` writes it.

- [ ] **Step 6: Grant the runtime `bedrock:Retrieve`**

Append to `infra/modules/agentcore-runtime/variables.tf`:
```hcl
variable "knowledge_base_arn" {
  type        = string
  description = "ARN of the Bedrock Knowledge Base the runtime may call bedrock:Retrieve on. Empty string grants no retrieval access."
  default     = ""
}
```

Append inside `data "aws_iam_policy_document" "this"` in `infra/modules/agentcore-runtime/main.tf`, after the `HomeLedgerTable` statement:
```hcl
  dynamic "statement" {
    for_each = var.knowledge_base_arn == "" ? [] : [var.knowledge_base_arn]
    content {
      sid       = "RetrieveFromKnowledgeBase"
      actions   = ["bedrock:Retrieve"]
      resources = [statement.value]
    }
  }
```

Append to `infra/modules/agentcore-runtime/tests/agentcore-runtime.tftest.hcl`. The policy document is replaced by `override_data`, so this asserts the variable plumbing rather than the rendered JSON:
```hcl
run "accepts_a_knowledge_base_arn" {
  command = plan

  variables {
    image_uri          = "123456789012.dkr.ecr.us-east-1.amazonaws.com/homeledger-mcp:abc1234"
    knowledge_base_arn = "arn:aws:bedrock:us-east-1:123456789012:knowledge-base/KB1234567"
  }

  assert {
    condition     = var.knowledge_base_arn != "" && length(aws_bedrockagent_agent_runtime.this) == 1
    error_message = "the runtime must still be created when a knowledge base arn is supplied"
  }
}
```

The existing `override_data` block in that test file already replaces `data.aws_iam_policy_document.this` with a fixed JSON document, so the `dynamic "statement"` block is not rendered under test. That is deliberate: the module's IAM shape is covered by `trivy config` in CI, and the real grant is proved end to end by Task 13's deployed `ask_manual` smoke call.

- [ ] **Step 7: Wire the module into the platform root**

Append to `infra/live/demo/platform/variables.tf`:
```hcl
variable "availability_delay_ms" {
  type        = number
  description = "Total budget for book_service's simulated availability check, in milliseconds. Must stay well inside the 3 s per-tool response budget."
  default     = 600

  validation {
    condition     = var.availability_delay_ms >= 0 && var.availability_delay_ms <= 2000
    error_message = "availability_delay_ms must be between 0 and 2000."
  }
}

variable "embedding_model_arn" {
  type        = string
  description = "Override for the knowledge base embedding model ARN. Empty uses Titan Text Embeddings v2 in the deployment region."
  default     = ""
}
```

Append to `infra/live/demo/platform/main.tf`:
```hcl
# ---------- Manuals, S3 Vectors, and the Bedrock Knowledge Base ----------
module "knowledge_base" {
  source = "../../../modules/knowledge-base"

  name_prefix         = local.name_prefix
  household_id        = var.household_id
  embedding_model_arn = var.embedding_model_arn
}

# ---------- Multi round-trip requestState signing key ----------
# book_service carries booking state across elicitation rounds in a signed,
# client-echoed requestState. Every microVM that may serve a later round needs
# the same key, so it is generated once here rather than per process.
#
# random_password keeps its value in Terraform state by construction, so the
# Secrets Manager copy exists for consumers (the Plan 3 simulator) rather than
# to hide it from state; the version is written with the write-only argument so
# it is not duplicated into that resource's own state as well.
resource "random_password" "request_state" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "request_state" {
  name = "${local.name_prefix}/mcp/request-state-key"
}

resource "aws_secretsmanager_secret_version" "request_state" {
  secret_id                = aws_secretsmanager_secret.request_state.id
  secret_string_wo         = random_password.request_state.result
  secret_string_wo_version = 1
}
```

Add `random` to `infra/live/demo/platform/versions.tf`'s `required_providers`:
```hcl
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.0, < 4.0.0"
    }
```

In the existing `module "agentcore_runtime"` block in `infra/live/demo/platform/main.tf`, extend `environment_variables` and add the new input:
```hcl
  environment_variables = {
    HOUSEHOLD_ID          = var.household_id
    TABLE_NAME            = aws_dynamodb_table.homeledger.name
    AWS_REGION            = local.region
    HOMELEDGER_DEV_TOOLS  = "1"
    ALLOWED_HOSTS         = var.allowed_hosts
    PORT                  = "8000"
    KNOWLEDGE_BASE_ID     = module.knowledge_base.knowledge_base_id
    REQUEST_STATE_KEY     = random_password.request_state.result
    AVAILABILITY_DELAY_MS = tostring(var.availability_delay_ms)
  }

  jwt_discovery_url            = module.cognito.discovery_url
  jwt_allowed_client_ids       = [module.cognito.client_id]
  idle_session_timeout_seconds = var.idle_session_timeout_seconds
  knowledge_base_arn           = module.knowledge_base.knowledge_base_arn
```

Append to `infra/live/demo/platform/outputs.tf`:
```hcl
output "manuals_bucket" {
  description = "S3 bucket holding manual PDFs and their metadata sidecars."
  value       = module.knowledge_base.manuals_bucket
}

output "manuals_prefix" {
  description = "Key prefix inside the manuals bucket that the knowledge base ingests."
  value       = module.knowledge_base.manuals_prefix
}

output "knowledge_base_id" {
  description = "Bedrock Knowledge Base id used by ask_manual and by the manuals ingestion script."
  value       = module.knowledge_base.knowledge_base_id
}

output "data_source_id" {
  description = "Bedrock data source id used by the manuals ingestion script to start ingestion jobs."
  value       = module.knowledge_base.data_source_id
}
```

Append to `infra/live/demo/platform/tests/platform.tftest.hcl`:
```hcl
run "knowledge_base_is_wired_into_the_runtime" {
  # apply: knowledge_base_id and the secret arn are provider-computed and
  # unknown at plan time for resources being created.
  command = apply

  variables {
    image_uri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/homeledger-mcp:abc1234"
  }

  assert {
    condition     = output.knowledge_base_id != null && output.knowledge_base_id != ""
    error_message = "knowledge_base_id must be set"
  }

  assert {
    condition     = output.manuals_prefix == "manuals/hh_harlow/"
    error_message = "the manuals prefix must be scoped to the household"
  }

  assert {
    condition     = output.manuals_bucket != null && output.manuals_bucket != ""
    error_message = "manuals_bucket must be set"
  }
}

run "rejects_an_out_of_range_availability_delay" {
  command = plan

  variables {
    availability_delay_ms = 5000
  }

  expect_failures = [var.availability_delay_ms]
}
```

The platform test's `mock_provider "aws"` block needs no new overrides; add a bare `mock_provider "random" {}` line above it so the random provider is mocked too.

- [ ] **Step 8: Add the module to CI and generate its README**

In `.github/workflows/ci.yml`, after the `cognito-m2m validate and test` step, add:
```yaml
      - name: knowledge-base validate and test
        working-directory: infra/modules/knowledge-base
        run: |
          terraform init -backend=false
          terraform validate
          terraform test
```
and after the `trivy (cognito-m2m)` step add:
```yaml
      - name: trivy (knowledge-base)
        uses: aquasecurity/trivy-action@v0.36.0
        with:
          scan-type: config
          scan-ref: infra/modules/knowledge-base
          severity: HIGH,CRITICAL
          exit-code: '1'
```

Generate the module README the same way the other two were produced:
```bash
terraform-docs markdown table --output-file README.md --output-mode inject infra/modules/knowledge-base
```
If `infra/modules/knowledge-base/README.md` does not exist yet, create it first with a one-paragraph description and the terraform-docs injection markers:
```markdown
# knowledge-base

Manuals bucket, S3 Vectors bucket and index, Bedrock Knowledge Base with an S3 data source, and the knowledge base service role. Manuals live at `manuals/<household_id>/<docId>.pdf` with a sidecar `<docId>.pdf.metadata.json` carrying `applianceId` and `title`; `ask_manual` filters on `applianceId` through that metadata.

<!-- BEGIN_TF_DOCS -->
<!-- END_TF_DOCS -->
```

- [ ] **Step 9: Validate everything locally**

```bash
cd infra
terraform fmt -check -recursive
cd modules/knowledge-base && terraform init -backend=false && terraform validate && terraform test && cd ../..
cd modules/agentcore-runtime && terraform init -backend=false && terraform validate && terraform test && cd ../..
cd live/demo/platform && terraform init -backend=false && terraform validate && terraform test && cd ../../../..
```
Expected: `fmt -check` silent, every `validate` clean, every `test` green. Do not run `plan` or `apply`.

- [ ] **Step 10: Record the S3 Vectors verification**

Append `FL-025` (or the next free number) to `FRICTION-LOG.md` with the Step 1 outcome — provider version, which resources and attributes existed, any renames, and whether the AWSCC or CLI fallback was needed — and update FL-016's `- **Status:**` line to point at it.

- [ ] **Step 11: Commit**

```bash
git add infra .github/workflows/ci.yml FRICTION-LOG.md
git commit -m "infra: knowledge-base module with S3 Vectors, KB retrieval grant, and request-state key"
```

---

### Task 11: Manuals upload and ingestion script

**Files:**
- Create: `scripts/manuals.ts`, `scripts/seed-manual.ts`
- Modify: `scripts/package.json`, `package.json`, `FRICTION-LOG.md`

**Interfaces:**
- Consumes: Terraform outputs `manuals_bucket`, `knowledge_base_id`, `data_source_id`, `table_name`; `@homeledger/core`'s `newId`, `createDynamoRepository`, `DocSchema`; `@aws-sdk/client-s3`'s `S3Client` and `PutObjectCommand`; `@aws-sdk/client-bedrock-agent`'s `BedrockAgentClient`, `StartIngestionJobCommand`, `GetIngestionJobCommand`.
- Produces:
  ```bash
  pnpm --filter @homeledger/scripts manuals -- --appliance <appl_id> --title "<title>" --file <path.pdf> [--pages <n>]
  pnpm --filter @homeledger/scripts seed:manual     # generates and ingests the smoke test document
  ```
  `manuals.ts` uploads `manuals/<householdId>/<docId>.pdf` and `manuals/<householdId>/<docId>.pdf.metadata.json`, writes the `DOC#` item with `kbSync.status = 'pending'`, points the appliance's `manualDocId` at it, starts one ingestion job, waits for it, and flips `kbSync` to `synced` or `failed`. It prints the doc id on its last line.

  Required environment: `AWS_REGION`, `HOUSEHOLD_ID`, `TABLE_NAME`, `MANUALS_BUCKET`, `KNOWLEDGE_BASE_ID`, `DATA_SOURCE_ID`.

- [ ] **Step 1: Add the dependencies and scripts**

`scripts/package.json`:
```json
{
  "name": "@homeledger/scripts",
  "private": true,
  "type": "module",
  "scripts": {
    "smoke": "tsx smoke.ts",
    "seed:remote": "tsx seed-remote.ts",
    "seed:manual": "tsx seed-manual.ts",
    "manuals": "tsx manuals.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@aws-sdk/client-bedrock-agent": "^3.900.0",
    "@aws-sdk/client-s3": "^3.900.0",
    "@homeledger/core": "workspace:*",
    "@modelcontextprotocol/client": "^2.0.0",
    "@modelcontextprotocol/sdk": "^1.25.2"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.0"
  }
}
```

Add to the root `package.json` scripts:
```json
    "manuals": "pnpm --filter @homeledger/scripts manuals",
```

Run: `pnpm install`
Expected: both AWS clients resolve.

- [ ] **Step 2: Write the upload and ingestion script**

`scripts/manuals.ts`:
```ts
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { BedrockAgentClient, GetIngestionJobCommand, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createDynamoRepository, newId } from '@homeledger/core';

const need = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

export interface UploadManualOptions {
  applianceId: string;
  title: string;
  pdf: Uint8Array;
  pages: number | null;
  region: string;
  householdId: string;
  tableName: string;
  bucket: string;
  knowledgeBaseId: string;
  dataSourceId: string;
  /** Ingestion polling budget. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

const TERMINAL_STATUSES = new Set(['COMPLETE', 'FAILED', 'STOPPED']);

export async function uploadManual(options: UploadManualOptions): Promise<{ docId: string; s3Key: string; ingestionJobId: string; status: string }> {
  const docId = newId('doc');
  const s3Key = `manuals/${options.householdId}/${docId}.pdf`;
  const s3 = new S3Client({ region: options.region });
  const agent = new BedrockAgentClient({ region: options.region });
  const repo = createDynamoRepository({ tableName: options.tableName, householdId: options.householdId, region: options.region });

  // Bedrock reads <key>.metadata.json beside the object and attaches every
  // entry of metadataAttributes to each chunk, which is what makes the
  // applianceId equals-filter in ask_manual possible.
  const metadata = { metadataAttributes: { applianceId: options.applianceId, title: options.title } };

  await s3.send(new PutObjectCommand({ Bucket: options.bucket, Key: s3Key, Body: options.pdf, ContentType: 'application/pdf' }));
  await s3.send(
    new PutObjectCommand({
      Bucket: options.bucket,
      Key: `${s3Key}.metadata.json`,
      Body: JSON.stringify(metadata),
      ContentType: 'application/json'
    })
  );
  console.log(`uploaded s3://${options.bucket}/${s3Key}`);

  await repo.putDoc({
    id: docId,
    applianceId: options.applianceId,
    title: options.title,
    s3Key,
    pages: options.pages,
    kbSync: { status: 'pending', at: null }
  });

  const appliance = await repo.getAppliance(options.applianceId);
  if (!appliance) throw new Error(`appliance ${options.applianceId} not found in ${options.tableName}`);
  await repo.putAppliance({ ...appliance, manualDocId: docId });

  const started = await agent.send(
    new StartIngestionJobCommand({
      knowledgeBaseId: options.knowledgeBaseId,
      dataSourceId: options.dataSourceId,
      description: `HomeLedger manual ${docId}`
    })
  );
  const ingestionJobId = started.ingestionJob?.ingestionJobId;
  if (!ingestionJobId) throw new Error('StartIngestionJob returned no ingestionJobId');
  console.log(`ingestion job ${ingestionJobId} started`);

  const timeoutMs = options.timeoutMs ?? 600_000;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let status = started.ingestionJob?.status ?? 'STARTING';
  let failureReasons: string[] = [];
  while (!TERMINAL_STATUSES.has(status)) {
    if (Date.now() > deadline) throw new Error(`ingestion job ${ingestionJobId} still ${status} after ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    const polled = await agent.send(new GetIngestionJobCommand({ knowledgeBaseId: options.knowledgeBaseId, dataSourceId: options.dataSourceId, ingestionJobId }));
    status = polled.ingestionJob?.status ?? status;
    failureReasons = polled.ingestionJob?.failureReasons ?? [];
    console.log(`ingestion job ${ingestionJobId}: ${status}`);
  }

  await repo.putDoc({
    id: docId,
    applianceId: options.applianceId,
    title: options.title,
    s3Key,
    pages: options.pages,
    kbSync: { status: status === 'COMPLETE' ? 'synced' : 'failed', at: new Date().toISOString() }
  });

  if (status !== 'COMPLETE') throw new Error(`ingestion ${status}: ${failureReasons.join('; ') || 'no reason reported'}`);
  return { docId, s3Key, ingestionJobId, status };
}

const isEntrypoint = process.argv[1] !== undefined && basename(process.argv[1]).startsWith('manuals');

if (isEntrypoint) {
  const applianceId = flag('appliance');
  const title = flag('title');
  const file = flag('file');
  if (!applianceId || !title || !file) {
    throw new Error('usage: manuals.ts --appliance <appl_id> --title "<title>" --file <path.pdf> [--pages <n>]');
  }
  const pagesFlag = flag('pages');
  const result = await uploadManual({
    applianceId,
    title,
    pdf: await readFile(file),
    pages: pagesFlag ? Number.parseInt(pagesFlag, 10) : null,
    region: need('AWS_REGION'),
    householdId: need('HOUSEHOLD_ID'),
    tableName: need('TABLE_NAME'),
    bucket: need('MANUALS_BUCKET'),
    knowledgeBaseId: need('KNOWLEDGE_BASE_ID'),
    dataSourceId: need('DATA_SOURCE_ID')
  });
  console.log(result.docId);
}
```

If `StartIngestionJob` rejects the simple `{ "metadataAttributes": { "key": "value" } }` sidecar shape, switch to the typed form and re-upload:
```ts
  const metadata = {
    metadataAttributes: {
      applianceId: { value: { type: 'STRING', stringValue: options.applianceId }, includeForEmbedding: false },
      title: { value: { type: 'STRING', stringValue: options.title }, includeForEmbedding: true }
    }
  };
```
Either way, file the friction entry before committing the change, citing `https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-ds.html#kb-ds-metadata`.

- [ ] **Step 3: Write the smoke test document generator**

`scripts/seed-manual.ts`:
```ts
import { uploadManual } from './manuals.js';
import { createDynamoRepository } from '@homeledger/core';

const need = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};

export const SMOKE_MANUAL_TITLE = 'HomeLedger smoke test manual';

const LINES = [
  'HomeLedger smoke test manual',
  '',
  'Error code F21 indicates a long drain time. The washer could not pump',
  'the water out within eight minutes. Check the drain hose for kinks and',
  'clean the drain pump filter behind the lower access panel.',
  '',
  'This document exists only so the deployed smoke test can prove that',
  'ask_manual reaches the real Bedrock Knowledge Base.'
];

/** Escapes the three characters that are special inside a PDF literal string. */
function pdfText(line: string): string {
  return line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * A minimal, single-page PDF 1.4 built by hand so the smoke fixture needs no
 * PDF library. Object offsets are computed as the body is assembled, which is
 * the only part of the format that cannot be written as a constant.
 */
export function buildSmokePdf(lines: string[]): Uint8Array {
  const content = ['BT', '/F1 12 Tf', '72 720 Td', '16 TL', ...lines.map(line => `(${pdfText(line)}) Tj T*`), 'ET'].join('\n');
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    `<</Length ${Buffer.byteLength(content, 'latin1')}>>\nstream\n${content}\nendstream`
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const region = need('AWS_REGION');
const householdId = need('HOUSEHOLD_ID');
const tableName = need('TABLE_NAME');

const repo = createDynamoRepository({ tableName, householdId, region });
const washer = (await repo.listAppliances({ category: 'laundry' }))[0];
if (!washer) throw new Error('no laundry appliance in the table; run seed:remote first');

const result = await uploadManual({
  applianceId: washer.id,
  title: SMOKE_MANUAL_TITLE,
  pdf: buildSmokePdf(LINES),
  pages: 1,
  region,
  householdId,
  tableName,
  bucket: need('MANUALS_BUCKET'),
  knowledgeBaseId: need('KNOWLEDGE_BASE_ID'),
  dataSourceId: need('DATA_SOURCE_ID')
});
console.log(`seeded ${result.docId} for ${washer.name} (${washer.id})`);
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @homeledger/core build
pnpm --filter @homeledger/scripts typecheck
```
Expected: clean. If `basename(process.argv[1]).startsWith('manuals')` reads as too loose an entrypoint guard for the reviewer, replace it with a comparison against `fileURLToPath(import.meta.url)`; both work under `tsx`, and the string form avoids importing `node:url` twice.

- [ ] **Step 5: Verify the generated PDF opens**

```bash
node --import tsx -e "import('./scripts/seed-manual.ts')" 2>/dev/null || true
node --import tsx -e "
import { buildSmokePdf } from './scripts/seed-manual.ts';
import { writeFileSync } from 'node:fs';
writeFileSync('/tmp/homeledger-smoke.pdf', buildSmokePdf(['Error code F21 indicates a long drain time.']));
console.log('wrote /tmp/homeledger-smoke.pdf');
"
open /tmp/homeledger-smoke.pdf
```
Expected: the first command exits without uploading anything because the required environment variables are absent — that is the intended guard. The second writes a file that opens in Preview showing the line. If it does not open, the xref offsets are wrong: check that every offset is measured in `latin1` bytes, not UTF-16 code units, and that the trailing space after each `n` in the xref table is present (the format requires 20-byte rows).

- [ ] **Step 6: Commit**

```bash
git add scripts package.json pnpm-lock.yaml
git commit -m "feat(scripts): manual upload with metadata sidecar and knowledge base ingestion"
```

---

### Task 12: MCP Apps widgets and `_meta.ui.resourceUri` wiring

**Files:**
- Create: `apps/mcp-server/src/widgets/shell.ts`, `apps/mcp-server/src/widgets/appliances.ts`, `apps/mcp-server/src/widgets/appliance.ts`, `apps/mcp-server/src/widgets/calendar.ts`, `apps/mcp-server/src/widgets/visit.ts`, `apps/mcp-server/src/widgets/index.ts`
- Modify: `apps/mcp-server/package.json`, `apps/mcp-server/src/resources.ts`, `apps/mcp-server/src/tools/appliances.ts`, `apps/mcp-server/src/tools/maintenance.ts`, `apps/mcp-server/src/tools/service.ts`, `apps/mcp-server/test/resources.test.ts`, `FRICTION-LOG.md`
- Test: `apps/mcp-server/test/widgets.test.ts`

**Interfaces:**
- Consumes: `RESOURCE_MIME_TYPE` (`'text/html;profile=mcp-app'`) and `RESOURCE_URI_META_KEY` (`'ui/resourceUri'`) from `@modelcontextprotocol/ext-apps/server`.
- Produces:
  ```ts
  // src/widgets/index.ts
  export const WIDGET_URIS: {
    appliances: 'ui://homeledger/appliances';
    appliance: 'ui://homeledger/appliance';
    calendar: 'ui://homeledger/calendar';
    visit: 'ui://homeledger/visit';
  };
  export interface WidgetDefinition { name: string; uri: string; title: string; description: string; html: string }
  export const WIDGETS: WidgetDefinition[];
  export function uiMeta(resourceUri: string): Record<string, unknown>;
  // src/widgets/shell.ts
  export const BRIDGE_SCRIPT: string;
  export const WIDGET_CSS: string;
  export function page(title: string, body: string, script: string): string;
  ```
  Widget-to-tool map, from spec 4.2: `list_appliances` → appliances, `get_appliance` → appliance, `maintenance_due` → calendar, `book_service` → visit, `get_visit` → visit.

The MCP Apps view SDK (`@modelcontextprotocol/ext-apps`, default export `App`) is a module graph over `@modelcontextprotocol/client` and `@modelcontextprotocol/core`; inlining it into a single HTML file with no external assets would need a bundler step and roughly 400 KB per widget. These four widgets therefore carry a hand-written bridge implementing the same view-side wire protocol, with the method names and payload shapes taken verbatim from the package's own `dist/src/generated/schema.json` and `dist/src/spec.types.d.ts`. The package is still added as a dependency because `@modelcontextprotocol/ext-apps/server` is a 561-byte, zero-runtime-dependency module carrying the two constants the server side must agree on, and a test pins our copies to its values.

- [ ] **Step 1: Add the dependency and verify the constants**

Add to `apps/mcp-server/package.json` `dependencies`:
```json
    "@modelcontextprotocol/ext-apps": "^2.0.0",
```
Run:
```bash
pnpm install
node --input-type=module -e "
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY, EXTENSION_ID } from '@modelcontextprotocol/ext-apps/server';
console.log(JSON.stringify({ RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY, EXTENSION_ID }));
" --experimental-default-type=module
```
Expected: `{"RESOURCE_MIME_TYPE":"text/html;profile=mcp-app","RESOURCE_URI_META_KEY":"ui/resourceUri","EXTENSION_ID":"io.modelcontextprotocol/ui"}`. If the subpath export `./server` is not resolvable, or if any of the three values differ, stop and record the mismatch in `FRICTION-LOG.md` before continuing; the widget wire protocol and the `_meta` key both hang off these. Run the command from `apps/mcp-server` so pnpm's isolated store resolves the package.

Also confirm the view-side method names this bridge implements, which must match the package's schema:
```bash
grep -o '"ui/[a-z/-]*"' node_modules/@modelcontextprotocol/ext-apps/dist/src/generated/schema.json | sort -u
```
Expected to include `"ui/initialize"`, `"ui/notifications/initialized"`, `"ui/notifications/tool-result"`, `"ui/notifications/host-context-changed"`, and `"ui/notifications/size-changed"`.

- [ ] **Step 2: Write the failing test**

`apps/mcp-server/test/widgets.test.ts`:
```ts
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from '@modelcontextprotocol/ext-apps/server';
import { afterEach, describe, expect, it } from 'vitest';
import { WIDGETS, WIDGET_URIS } from '../src/widgets/index.js';
import { modernClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => {
  await close();
});

describe('widget constants', () => {
  it('agrees with the MCP Apps SDK on the mime type and the meta key', () => {
    expect(RESOURCE_MIME_TYPE).toBe('text/html;profile=mcp-app');
    expect(RESOURCE_URI_META_KEY).toBe('ui/resourceUri');
  });

  it('declares exactly the four ui:// widgets from the design', () => {
    expect(WIDGETS.map(w => w.uri)).toEqual([WIDGET_URIS.appliances, WIDGET_URIS.appliance, WIDGET_URIS.calendar, WIDGET_URIS.visit]);
    expect(WIDGETS.map(w => w.uri)).toEqual(['ui://homeledger/appliances', 'ui://homeledger/appliance', 'ui://homeledger/calendar', 'ui://homeledger/visit']);
  });
});

describe('widget resources', () => {
  it('lists all four alongside the JSON resources', async () => {
    const h = await modernClient();
    close = h.close;
    const { resources } = await h.client.listResources();
    const uris = resources.map(r => r.uri).sort();
    expect(uris).toEqual([
      'homeledger://appliances',
      'homeledger://household',
      'homeledger://maintenance/schedule',
      'ui://homeledger/appliance',
      'ui://homeledger/appliances',
      'ui://homeledger/calendar',
      'ui://homeledger/visit'
    ]);
    for (const widget of WIDGETS) {
      expect(resources.find(r => r.uri === widget.uri)?.mimeType).toBe(RESOURCE_MIME_TYPE);
    }
  });

  it('serves self-contained, theme-aware HTML sized for a 768 by 480 canvas', async () => {
    const h = await modernClient();
    close = h.close;
    for (const widget of WIDGETS) {
      const read = await h.client.readResource({ uri: widget.uri });
      const contents = read.contents[0] as { mimeType?: string; text: string };
      expect(contents.mimeType).toBe(RESOURCE_MIME_TYPE);
      const html = contents.text;
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).toContain('ui/initialize');
      expect(html).toContain('ui/notifications/tool-result');
      expect(html).toContain('prefers-color-scheme: dark');
      expect(html).toContain('768px');
      // No external assets: nothing may be fetched over the network.
      expect(/(?:src|href)\s*=\s*["']https?:/i.test(html)).toBe(false);
      expect(html).not.toContain('//fonts.googleapis.com');
    }
  });

  it('puts a log as done button on the calendar widget only', async () => {
    const h = await modernClient();
    close = h.close;
    const calendar = await h.client.readResource({ uri: WIDGET_URIS.calendar });
    expect((calendar.contents[0] as { text: string }).text).toContain('log_maintenance');
    const appliances = await h.client.readResource({ uri: WIDGET_URIS.appliances });
    expect((appliances.contents[0] as { text: string }).text).not.toContain('log_maintenance');
  });
});

describe('tool widget metadata', () => {
  it('points the five widget-backed tools at their resources through _meta.ui.resourceUri', async () => {
    const h = await modernClient();
    close = h.close;
    const { tools } = await h.client.listTools();
    const uriOf = (name: string) => {
      const meta = tools.find(t => t.name === name)?._meta as { ui?: { resourceUri?: string } } | undefined;
      return meta?.ui?.resourceUri;
    };
    expect(uriOf('list_appliances')).toBe(WIDGET_URIS.appliances);
    expect(uriOf('get_appliance')).toBe(WIDGET_URIS.appliance);
    expect(uriOf('maintenance_due')).toBe(WIDGET_URIS.calendar);
    expect(uriOf('book_service')).toBe(WIDGET_URIS.visit);
    expect(uriOf('get_visit')).toBe(WIDGET_URIS.visit);
    expect(uriOf('ask_manual')).toBeUndefined();
    expect(uriOf('log_maintenance')).toBeUndefined();
    expect(uriOf('recent_events')).toBeUndefined();
  });

  it('also sets the deprecated flat key so older hosts resolve the widget', async () => {
    const h = await modernClient();
    close = h.close;
    const { tools } = await h.client.listTools();
    const meta = tools.find(t => t.name === 'get_visit')?._meta as Record<string, unknown> | undefined;
    expect(meta?.[RESOURCE_URI_META_KEY]).toBe(WIDGET_URIS.visit);
  });
});
```

Update `apps/mcp-server/test/resources.test.ts`'s existing URI assertion, which currently expects exactly three resources, to filter the JSON ones:
```ts
    expect(resources.map(r => r.uri).filter(uri => uri.startsWith('homeledger://')).sort()).toEqual([
      'homeledger://appliances',
      'homeledger://household',
      'homeledger://maintenance/schedule'
    ]);
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @homeledger/mcp-server test -- widgets resources`
Expected: FAIL, cannot find module `../src/widgets/index.js`.

- [ ] **Step 4: Write the shared shell**

`apps/mcp-server/src/widgets/shell.ts`:
```ts
/**
 * View-side MCP Apps bridge, hand-written so each widget stays one file with
 * no external assets. Wire protocol taken from @modelcontextprotocol/ext-apps
 * 2.0.0: ui/initialize (request, result carries hostContext), then
 * ui/notifications/initialized, then host-to-view notifications
 * ui/notifications/tool-result, ui/notifications/tool-input and
 * ui/notifications/host-context-changed. Tool calls go to the host as plain
 * MCP tools/call requests over the same postMessage channel.
 *
 * Written without template literals on purpose: the widget files embed this
 * with String.raw, so a dollar-brace sequence here would be interpolated.
 */
export const BRIDGE_SCRIPT = String.raw`
(function () {
  var pending = {};
  var nextId = 1;
  var handlers = { toolresult: [], toolinput: [], hostcontext: [] };
  var hostContext = {};

  function post(message) {
    window.parent.postMessage(message, '*');
  }

  function request(method, params) {
    var id = nextId++;
    var promise = new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
    });
    post({ jsonrpc: '2.0', id: id, method: method, params: params });
    return promise;
  }

  function emit(event, payload) {
    for (var i = 0; i < handlers[event].length; i++) handlers[event][i](payload);
  }

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && pending[message.id]) {
      var slot = pending[message.id];
      delete pending[message.id];
      if (message.error) slot.reject(new Error(message.error.message));
      else slot.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result') return emit('toolresult', message.params || {});
    if (message.method === 'ui/notifications/tool-input') return emit('toolinput', (message.params || {}).arguments || {});
    if (message.method === 'ui/notifications/host-context-changed') {
      var changed = message.params || {};
      for (var key in changed) hostContext[key] = changed[key];
      applyTheme();
      return emit('hostcontext', hostContext);
    }
    if (message.id !== undefined) post({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  });

  function applyTheme() {
    if (hostContext.theme === 'dark' || hostContext.theme === 'light') {
      document.documentElement.setAttribute('data-theme', hostContext.theme);
    }
  }

  function reportSize() {
    post({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: document.documentElement.scrollHeight } });
  }

  window.homeledger = {
    on: function (event, handler) {
      handlers[event].push(handler);
    },
    hostContext: function () {
      return hostContext;
    },
    callTool: function (name, args) {
      return request('tools/call', { name: name, arguments: args });
    },
    reportSize: reportSize,
    connect: function (appName) {
      return request('ui/initialize', {
        appInfo: { name: appName, version: '0.1.0' },
        appCapabilities: {},
        protocolVersion: '2026-01-26'
      }).then(function (result) {
        var context = (result && result.hostContext) || {};
        for (var key in context) hostContext[key] = context[key];
        applyTheme();
        post({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
        emit('hostcontext', hostContext);
        reportSize();
        return hostContext;
      });
    }
  };
})();
`;

/** 768 by 480 is the Alexa+ base canvas; cards are #14181E dark, #FFFFFF light. */
export const WIDGET_CSS = String.raw`
:root {
  color-scheme: light;
  --bg: #faf9fb;
  --card: #ffffff;
  --nested: #f2f1f4;
  --text: #16181d;
  --muted: #5b6070;
  --line: #dedbe4;
  --accent: #1f6feb;
  --warn: #b3541e;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;
    --bg: #0d1015;
    --card: #14181e;
    --nested: #1b2028;
    --text: #f4f5f7;
    --muted: #a3a9b8;
    --line: #2a303a;
    --accent: #6ea8fe;
    --warn: #e8a266;
  }
}
:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #0d1015;
  --card: #14181e;
  --nested: #1b2028;
  --text: #f4f5f7;
  --muted: #a3a9b8;
  --line: #2a303a;
  --accent: #6ea8fe;
  --warn: #e8a266;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 16px;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
main { max-width: 768px; margin: 0 auto; }
h1 { margin: 0 0 12px; font-size: 20px; font-weight: 600; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin-bottom: 8px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; justify-content: space-between; }
.name { font-weight: 600; }
.muted { color: var(--muted); font-size: 13px; }
.warn { color: var(--warn); font-weight: 600; }
.pill { background: var(--nested); border-radius: 999px; padding: 2px 10px; font-size: 12px; color: var(--muted); }
button {
  font: inherit;
  font-size: 13px;
  color: var(--card);
  background: var(--accent);
  border: 0;
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
}
button[disabled] { opacity: 0.5; cursor: default; }
.empty { color: var(--muted); padding: 24px 0; text-align: center; }
`;

export function page(title: string, body: string, script: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>${WIDGET_CSS}</style>`,
    '</head>',
    '<body>',
    body,
    `<script>${BRIDGE_SCRIPT}</script>`,
    `<script>${script}</script>`,
    '</body>',
    '</html>'
  ].join('\n');
}
```

- [ ] **Step 5: Write the four widgets**

`apps/mcp-server/src/widgets/appliances.ts`:
```ts
import { page } from './shell.js';

const BODY = String.raw`<main><h1>Appliances</h1><div id="list" class="empty">Waiting for the appliance list.</div></main>`;

const SCRIPT = String.raw`
(function () {
  var list = document.getElementById('list');

  function render(result) {
    var data = (result && result.structuredContent) || {};
    var rows = data.appliances || [];
    if (rows.length === 0) {
      list.className = 'empty';
      list.textContent = 'No appliances on record.';
      window.homeledger.reportSize();
      return;
    }
    list.className = '';
    list.textContent = '';
    for (var i = 0; i < rows.length; i++) {
      var a = rows[i];
      var card = document.createElement('div');
      card.className = 'card';
      var row = document.createElement('div');
      row.className = 'row';
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = a.name;
      var status = document.createElement('span');
      status.className = a.warrantyStatus === 'expired' ? 'pill warn' : 'pill';
      status.textContent = a.warrantyStatus === 'active' ? 'under warranty' : a.warrantyStatus === 'expired' ? 'out of warranty' : 'warranty unknown';
      row.appendChild(name);
      row.appendChild(status);
      var detail = document.createElement('div');
      detail.className = 'muted';
      detail.textContent = a.brand + ' ' + a.model + ' - ' + a.room;
      card.appendChild(row);
      card.appendChild(detail);
      list.appendChild(card);
    }
    window.homeledger.reportSize();
  }

  window.homeledger.on('toolresult', render);
  window.homeledger.connect('homeledger-appliances');
})();
`;

export const APPLIANCES_WIDGET_HTML = page('Appliances', BODY, SCRIPT);
```

`apps/mcp-server/src/widgets/appliance.ts`:
```ts
import { page } from './shell.js';

const BODY = String.raw`<main><h1 id="title">Appliance</h1><div id="detail" class="empty">Waiting for the appliance.</div></main>`;

const SCRIPT = String.raw`
(function () {
  var title = document.getElementById('title');
  var detail = document.getElementById('detail');

  function render(result) {
    var data = (result && result.structuredContent) || {};
    var appliance = data.appliance;
    if (!appliance) {
      detail.className = 'empty';
      detail.textContent = 'No appliance selected.';
      window.homeledger.reportSize();
      return;
    }
    title.textContent = appliance.name;
    detail.className = '';
    detail.textContent = '';

    var head = document.createElement('div');
    head.className = 'card';
    var line = document.createElement('div');
    line.className = 'muted';
    line.textContent = appliance.brand + ' ' + appliance.model + ' - ' + appliance.room;
    var warranty = document.createElement('div');
    warranty.className = appliance.warrantyStatus === 'expired' ? 'warn' : 'muted';
    warranty.textContent =
      appliance.warrantyStatus === 'active'
        ? 'Under warranty until ' + (appliance.warrantyUntil || 'an unknown date')
        : appliance.warrantyStatus === 'expired'
          ? 'Out of warranty since ' + (appliance.warrantyUntil || 'an unknown date')
          : 'Warranty unknown';
    head.appendChild(line);
    head.appendChild(warranty);
    detail.appendChild(head);

    var tasks = data.maintenance || [];
    for (var i = 0; i < tasks.length; i++) {
      var task = tasks[i];
      var card = document.createElement('div');
      card.className = 'card';
      var row = document.createElement('div');
      row.className = 'row';
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = task.taskType.split('_').join(' ');
      var due = document.createElement('span');
      due.className = task.overdue ? 'warn' : 'muted';
      due.textContent = (task.overdue ? 'overdue since ' : 'due ') + task.nextDueAt;
      row.appendChild(name);
      row.appendChild(due);
      var last = document.createElement('div');
      last.className = 'muted';
      last.textContent = task.lastDoneAt ? 'last done ' + task.lastDoneAt : 'never logged';
      card.appendChild(row);
      card.appendChild(last);
      detail.appendChild(card);
    }
    window.homeledger.reportSize();
  }

  window.homeledger.on('toolresult', render);
  window.homeledger.connect('homeledger-appliance');
})();
`;

export const APPLIANCE_WIDGET_HTML = page('Appliance', BODY, SCRIPT);
```

`apps/mcp-server/src/widgets/calendar.ts`:
```ts
import { page } from './shell.js';

const BODY = String.raw`<main><h1>Maintenance due</h1><div id="list" class="empty">Waiting for the schedule.</div></main>`;

const SCRIPT = String.raw`
(function () {
  var list = document.getElementById('list');

  function markDone(item, button) {
    button.disabled = true;
    button.textContent = 'Logging';
    window.homeledger
      .callTool('log_maintenance', { applianceId: item.applianceId, taskType: item.taskType })
      .then(function (result) {
        var data = (result && result.structuredContent) || {};
        button.textContent = data.nextDueAt ? 'Next ' + data.nextDueAt : 'Logged';
      })
      .catch(function (error) {
        button.disabled = false;
        button.textContent = 'Retry';
        console.error('log_maintenance failed', error);
      });
  }

  function render(result) {
    var data = (result && result.structuredContent) || {};
    var items = data.items || [];
    if (items.length === 0) {
      list.className = 'empty';
      list.textContent = 'Nothing due in this window.';
      window.homeledger.reportSize();
      return;
    }
    list.className = '';
    list.textContent = '';
    for (var i = 0; i < items.length; i++) {
      (function (item) {
        var card = document.createElement('div');
        card.className = 'card';
        var row = document.createElement('div');
        row.className = 'row';
        var name = document.createElement('span');
        name.className = 'name';
        name.textContent = item.applianceName + ' - ' + item.taskType.split('_').join(' ');
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Log as done';
        button.addEventListener('click', function () {
          markDone(item, button);
        });
        row.appendChild(name);
        row.appendChild(button);
        var due = document.createElement('div');
        due.className = item.overdue ? 'warn' : 'muted';
        due.textContent = (item.overdue ? 'overdue since ' : 'due ') + item.nextDueAt;
        card.appendChild(row);
        card.appendChild(due);
        list.appendChild(card);
      })(items[i]);
    }
    window.homeledger.reportSize();
  }

  window.homeledger.on('toolresult', render);
  window.homeledger.connect('homeledger-calendar');
})();
`;

export const CALENDAR_WIDGET_HTML = page('Maintenance due', BODY, SCRIPT);
```

`apps/mcp-server/src/widgets/visit.ts`:
```ts
import { page } from './shell.js';

const BODY = String.raw`<main><h1>Service visit</h1><div id="detail" class="empty">Waiting for the visit.</div></main>`;

const SCRIPT = String.raw`
(function () {
  var detail = document.getElementById('detail');

  function textRow(parent, className, value) {
    var node = document.createElement('div');
    node.className = className;
    node.textContent = value;
    parent.appendChild(node);
  }

  function render(result) {
    var data = (result && result.structuredContent) || {};
    // book_service returns a flat booking; get_visit nests it under visit.
    var visit = data.visit || data;
    if (!visit || (!visit.provider && !visit.providerName)) {
      detail.className = 'empty';
      detail.textContent = 'No visit selected.';
      window.homeledger.reportSize();
      return;
    }
    detail.className = '';
    detail.textContent = '';

    var card = document.createElement('div');
    card.className = 'card';
    var row = document.createElement('div');
    row.className = 'row';
    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = visit.providerName || visit.provider;
    var status = document.createElement('span');
    status.className = visit.status === 'missed' ? 'pill warn' : 'pill';
    status.textContent = visit.status;
    row.appendChild(name);
    row.appendChild(status);
    card.appendChild(row);
    textRow(card, 'muted', visit.windowStart + ' to ' + visit.windowEnd);
    if (visit.applianceName) textRow(card, 'muted', visit.applianceName);
    if (visit.issue) textRow(card, 'muted', visit.issue);
    if (visit.arrivedAt) textRow(card, 'muted', 'arrived ' + visit.arrivedAt);
    detail.appendChild(card);

    if (data.description) {
      var described = document.createElement('div');
      described.className = 'card';
      textRow(described, 'muted', data.description);
      detail.appendChild(described);
    }
    if (data.snapshotUrl) {
      var shot = document.createElement('img');
      shot.src = data.snapshotUrl;
      shot.alt = 'Doorbell snapshot taken when the visit was matched';
      shot.style.maxWidth = '100%';
      shot.style.borderRadius = '12px';
      detail.appendChild(shot);
    }
    window.homeledger.reportSize();
  }

  window.homeledger.on('toolresult', render);
  window.homeledger.connect('homeledger-visit');
})();
`;

export const VISIT_WIDGET_HTML = page('Service visit', BODY, SCRIPT);
```

The `img.src` in the visit widget is assigned at runtime from a presigned URL the Ring plan supplies; it is not an external asset baked into the file, which is why the "no external assets" test matches on `src=` / `href=` attributes in the served HTML rather than on runtime assignments.

`apps/mcp-server/src/widgets/index.ts`:
```ts
import { RESOURCE_URI_META_KEY } from '@modelcontextprotocol/ext-apps/server';
import { APPLIANCES_WIDGET_HTML } from './appliances.js';
import { APPLIANCE_WIDGET_HTML } from './appliance.js';
import { CALENDAR_WIDGET_HTML } from './calendar.js';
import { VISIT_WIDGET_HTML } from './visit.js';

export const WIDGET_URIS = {
  appliances: 'ui://homeledger/appliances',
  appliance: 'ui://homeledger/appliance',
  calendar: 'ui://homeledger/calendar',
  visit: 'ui://homeledger/visit'
} as const;

export interface WidgetDefinition {
  name: string;
  uri: string;
  title: string;
  description: string;
  html: string;
}

export const WIDGETS: WidgetDefinition[] = [
  { name: 'appliances-widget', uri: WIDGET_URIS.appliances, title: 'Appliances', description: 'Every household appliance with its warranty state.', html: APPLIANCES_WIDGET_HTML },
  { name: 'appliance-widget', uri: WIDGET_URIS.appliance, title: 'Appliance', description: 'One appliance with its maintenance tasks and due dates.', html: APPLIANCE_WIDGET_HTML },
  { name: 'calendar-widget', uri: WIDGET_URIS.calendar, title: 'Maintenance calendar', description: 'Maintenance due, with a log-as-done action per task.', html: CALENDAR_WIDGET_HTML },
  { name: 'visit-widget', uri: WIDGET_URIS.visit, title: 'Service visit', description: 'A booked service visit, with the arrival snapshot once one exists.', html: VISIT_WIDGET_HTML }
];

/**
 * Tool `_meta` naming a widget. Sets the nested `ui.resourceUri` the MCP Apps
 * spec prefers and the deprecated flat `ui/resourceUri` key older hosts read,
 * exactly as the SDK's registerAppTool helper does.
 */
export function uiMeta(resourceUri: string): Record<string, unknown> {
  return { ui: { resourceUri }, [RESOURCE_URI_META_KEY]: resourceUri };
}
```

- [ ] **Step 6: Serve the widgets and reference them from tools**

Append to `registerResources` in `apps/mcp-server/src/resources.ts`, and add the two imports at the top:
```ts
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { WIDGETS } from './widgets/index.js';
```
```ts
  for (const widget of WIDGETS) {
    server.registerResource(widget.name, widget.uri, { title: widget.title, description: widget.description, mimeType: RESOURCE_MIME_TYPE }, async uri => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: widget.html }]
    }));
  }
```

In `apps/mcp-server/src/tools/appliances.ts`, add `import { WIDGET_URIS, uiMeta } from '../widgets/index.js';` and add `_meta: uiMeta(WIDGET_URIS.appliances)` to the `list_appliances` config and `_meta: uiMeta(WIDGET_URIS.appliance)` to the `get_appliance` config, each as the last key beside `annotations`.

In `apps/mcp-server/src/tools/maintenance.ts`, add the same import and `_meta: uiMeta(WIDGET_URIS.calendar)` to the `maintenance_due` config only. `log_maintenance` gets none — the calendar widget calls it, it does not render one.

In `apps/mcp-server/src/tools/service.ts`, add the same import and `_meta: uiMeta(WIDGET_URIS.visit)` to both the `book_service` and the `get_visit` configs.

- [ ] **Step 7: Run the tests**

```bash
pnpm --filter @homeledger/core build
pnpm --filter @homeledger/mcp-server test
pnpm --filter @homeledger/mcp-server typecheck
pnpm format:write
```
Expected: PASS. If `uri.href` in the widget read callback differs from `widget.uri` — `URL` normalises `ui://homeledger/appliances` to include a trailing slash on some schemes — assert against `widget.uri` in the returned `contents[0].uri` instead of `uri.href`, and record the normalisation in `FRICTION-LOG.md`.

- [ ] **Step 8: Eyeball a widget**

```bash
node --import tsx -e "
import { WIDGETS } from './apps/mcp-server/src/widgets/index.ts';
import { writeFileSync } from 'node:fs';
for (const widget of WIDGETS) writeFileSync('/tmp/' + widget.name + '.html', widget.html);
console.log(WIDGETS.map(w => '/tmp/' + w.name + '.html').join('\n'));
"
open /tmp/calendar-widget.html
```
Expected: the page renders at 768 px wide with "Waiting for the schedule." and follows the system light or dark setting. There is no host, so nothing else happens — that is correct. Resize the window below 400 px and confirm the cards wrap rather than scrolling sideways.

- [ ] **Step 9: Record the app-bridge decision**

Append `FL-026` (or the next free number) to `FRICTION-LOG.md`: expected that `@modelcontextprotocol/ext-apps`'s view SDK could be used directly inside a single-file `ui://` resource; actual that its browser entry is a module graph over `@modelcontextprotocol/client` and `@modelcontextprotocol/core` with an `app-with-deps` bundle around 418 KB, so a no-external-assets single file needs either a bundler step per widget or a hand-written bridge; decision to hand-write a bridge against the package's published `schema.json` method names and keep the package as a dependency for `@modelcontextprotocol/ext-apps/server`'s two constants, pinned by a test. Cite `https://github.com/modelcontextprotocol/ext-apps` and `https://modelcontextprotocol.io/extensions/apps/overview`.

- [ ] **Step 10: Commit**

```bash
git add apps/mcp-server FRICTION-LOG.md pnpm-lock.yaml
git commit -m "feat(mcp-server): MCP Apps widgets as ui:// resources with tool _meta wiring"
```

---

### Task 13: Smoke additions and the deploy

**Files:**
- Modify: `scripts/smoke.ts`, `.github/workflows/smoke.yml`, `FRICTION-LOG.md`

**Interfaces:**
- Consumes: Terraform outputs `agent_runtime_invocation_url`, `cognito_token_url`, `cognito_client_id`, `cognito_client_secret`, `table_name`, `manuals_bucket`, `knowledge_base_id`, `data_source_id`, `agent_runtime_arn`.
- Produces: `pnpm smoke` exits 0 only when, in addition to everything Plan 1 asserted, a modern client gets at least one real passage back from `ask_manual` against the deployed Knowledge Base, and a legacy client completes `book_service`'s three elicitations through the shim on AgentCore and gets a `scheduled` visit.

- [ ] **Step 1: Extend the smoke script**

Replace `scripts/smoke.ts` with:
```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const url = need('MCP_URL');
const tokenUrl = need('COGNITO_TOKEN_URL');
const clientId = need('COGNITO_CLIENT_ID');
const clientSecret = need('COGNITO_CLIENT_SECRET');
const BUDGET_MS = 3000;

const EXPECTED_TOOLS = [
  'list_appliances',
  'get_appliance',
  'maintenance_due',
  'log_maintenance',
  'recent_events',
  'ask_manual',
  'book_service',
  'get_visit',
  'echo_confirm'
];

async function token(): Promise<string> {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'homeledger/mcp' })
  });
  if (!res.ok) throw new Error(`token: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function timed<T>(label: string, fn: () => Promise<T>, enforce = true): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  const ms = Math.round(performance.now() - t0);
  console.log(`${label}: ${ms} ms`);
  if (enforce && ms > BUDGET_MS) throw new Error(`${label} exceeded ${BUDGET_MS} ms`);
  return out;
}

const bearer = await token();
console.log('token: ok');

// Modern client (2026-07-28): tool order, a read tool, and real retrieval.
{
  const client = new Client({ name: 'smoke-modern', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } });
  await timed('modern connect (cold)', () => client.connect(transport), false);
  const { tools } = await timed('modern tools/list', () => client.listTools());
  const names = tools.map(t => t.name);
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) throw new Error(`tool order ${names.join(',')}`);

  const widgetOf = (name: string) => (tools.find(t => t.name === name)?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
  if (widgetOf('maintenance_due') !== 'ui://homeledger/calendar') throw new Error('maintenance_due lost its widget reference');
  if (widgetOf('get_visit') !== 'ui://homeledger/visit') throw new Error('get_visit lost its widget reference');

  const due = await timed('modern maintenance_due', () => client.callTool({ name: 'maintenance_due', arguments: {} }));
  if (!(due.structuredContent as { items: unknown[] }).items.length) throw new Error('no maintenance items; run seed:remote');

  // Real Knowledge Base retrieval against the document seed:manual ingested.
  const manual = await timed('modern ask_manual (knowledge base)', () => client.callTool({ name: 'ask_manual', arguments: { question: 'What does error code F21 mean on the washer?' } }));
  const passages = (manual.structuredContent as { passages: Array<{ text: string; docTitle: string; page: number | null }> }).passages;
  if (passages.length === 0) throw new Error('ask_manual returned no passages; run seed:manual and confirm the ingestion job completed');
  if (!passages.some(p => p.text.includes('F21'))) throw new Error(`ask_manual returned no F21 passage: ${passages.map(p => p.docTitle).join(', ')}`);
  console.log(`ask_manual: ${passages.length} passage(s), first from ${passages[0]!.docTitle} page ${passages[0]!.page}`);

  const manualText = (manual.content as Array<{ text?: string }>)[0]?.text ?? '';
  if (/[{}[\]]/.test(manualText)) throw new Error(`ask_manual spoke JSON: ${manualText}`);

  await client.close();
}

// Legacy client (2025-era): elicitation through the shim, one round and three.
{
  const client = new LegacyClient({ name: 'Alexa+ MCP Client', version: '1.0.0' }, { capabilities: { elicitation: {} } });
  const asked: string[] = [];
  client.setRequestHandler(ElicitRequestSchema, async request => {
    const requestedSchema = request.params.requestedSchema as { properties: Record<string, { enum?: string[] }> };
    const field = Object.keys(requestedSchema.properties)[0] ?? '';
    asked.push(field);
    if (field === 'confirm') return { action: 'accept', content: { confirm: true } };
    const options = requestedSchema.properties[field]?.enum ?? [];
    if (options.length === 0) throw new Error(`elicitation for ${field} offered no options`);
    if (options.length > 5) throw new Error(`elicitation for ${field} offered ${options.length} options`);
    return { action: 'accept', content: { [field]: options[0] } };
  });
  const transport = new LegacyTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } });
  await timed('legacy initialize (cold)', () => client.connect(transport), false);
  if (!transport.sessionId) throw new Error('legacy: no Mcp-Session-Id');
  console.log(`legacy session: ${transport.sessionId}`);

  const echo = await timed('legacy echo_confirm (elicitation)', () => client.callTool({ name: 'echo_confirm', arguments: { message: 'smoke' } }));
  if (JSON.stringify(echo.structuredContent) !== JSON.stringify({ confirmed: true, message: 'smoke' }))
    throw new Error(`legacy elicitation result ${JSON.stringify(echo.structuredContent)}`);

  const list = await timed('legacy list_appliances', () => client.callTool({ name: 'list_appliances', arguments: { category: 'water_heater' } }));
  const applianceId = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]?.id;
  if (!applianceId) throw new Error('no water heater in the table; run seed:remote');

  asked.length = 0;
  const progress: number[] = [];
  const booked = await timed(
    'legacy book_service (three elicitations plus progress)',
    () =>
      client.callTool(
        { name: 'book_service', arguments: { applianceId, issue: 'smoke test booking' } },
        undefined,
        { onprogress: p => progress.push(p.progress) }
      ),
    false
  );
  if (JSON.stringify(asked) !== JSON.stringify(['provider', 'window', 'confirm'])) throw new Error(`legacy book_service asked ${asked.join(',')}`);
  const visit = booked.structuredContent as { visitId: string; provider: string; status: string };
  if (visit.status !== 'scheduled') throw new Error(`legacy book_service status ${visit.status}`);
  if (!/^visit_[a-z2-7]{16}$/.test(visit.visitId)) throw new Error(`legacy book_service visitId ${visit.visitId}`);
  console.log(`legacy book_service: ${visit.provider} ${visit.visitId}, progress ${progress.join(',') || 'none'}`);

  const fetched = await timed('legacy get_visit', () => client.callTool({ name: 'get_visit', arguments: { visitId: visit.visitId } }));
  const fetchedVisit = (fetched.structuredContent as { visit: { providerName: string }; snapshotUrl: string | null }).visit;
  if (fetchedVisit.providerName !== visit.provider) throw new Error(`get_visit returned ${fetchedVisit.providerName}`);

  try {
    await transport.terminateSession();
  } catch (err) {
    // AgentCore Runtime has been observed not to route this explicit DELETE
    // termination call to the same microVM that served the session, even
    // though every prior POST/GET on the session (including the elicitation
    // round trips above) did route correctly — see FL-022. AgentCore manages
    // session lifecycle itself via idle timeout, so an on-demand DELETE is
    // best-effort cleanup, not part of the smoke contract; log and continue.
    console.log(`legacy terminateSession: non-fatal - ${(err as Error).message}`);
  }
  await client.close();
}

console.log('SMOKE OK');
```

`book_service` is timed without budget enforcement because it spans three human round trips through the shim, each gated by the smoke client's own handler; the individual tool phases are what the 3 s budget covers, and the deployed `availabilityDelayMs` of 600 ms is the only server-side delay inside them.

- [ ] **Step 2: Extend the smoke workflow**

In `.github/workflows/smoke.yml`, add the three new Terraform outputs to the "Export Terraform outputs" step, immediately after `TABLE_NAME`:
```yaml
          MANUALS_BUCKET=$(terraform output -raw manuals_bucket)
          KNOWLEDGE_BASE_ID=$(terraform output -raw knowledge_base_id)
          DATA_SOURCE_ID=$(terraform output -raw data_source_id)
```
and to the heredoc that writes `$GITHUB_ENV`:
```yaml
            echo "MANUALS_BUCKET=$MANUALS_BUCKET"
            echo "KNOWLEDGE_BASE_ID=$KNOWLEDGE_BASE_ID"
            echo "DATA_SOURCE_ID=$DATA_SOURCE_ID"
```

Add a seeding step between `seed:remote` and `pnpm smoke`:
```yaml
      - run: pnpm --filter @homeledger/scripts seed:manual
```

The smoke job's role needs `s3:PutObject` on the manuals bucket and `bedrock:StartIngestionJob` / `bedrock:GetIngestionJob` on the knowledge base. The `homeledger-github-deploy` role already carries `PowerUserAccess`, which covers both; if a narrower role is ever substituted, add those actions explicitly and note it.

- [ ] **Step 3: Deploy and smoke**

```bash
git push
gh workflow run deploy.yml --ref "$(git rev-parse --abbrev-ref HEAD)"
gh run watch
gh workflow run smoke.yml --ref "$(git rev-parse --abbrev-ref HEAD)"
gh run watch
```
Expected: `deploy` green, creating the manuals bucket, the S3 Vectors bucket and index, the knowledge base, the data source, and a new runtime revision carrying `KNOWLEDGE_BASE_ID`, `REQUEST_STATE_KEY`, and `AVAILABILITY_DELAY_MS`. Then `smoke` green, ending in `SMOKE OK`.

Failure modes and what each means:
- `ask_manual returned no passages`: either `seed:manual` never completed its ingestion job — check that step's log for `ingestion job <id>: COMPLETE` — or the retriever is filtering on an `applianceId` that is not in the sidecar. The smoke call passes no `applianceId`, so a filter is not the cause; look at the ingestion job's `failureReasons`.
- `AccessDeniedException` on `bedrock:Retrieve` from the runtime: the `knowledge_base_arn` input did not reach the execution role. Confirm `terraform output knowledge_base_id` is non-empty and that the runtime's revision was replaced by the apply.
- `-32602 Invalid or expired requestState` on the second or third legacy round: `REQUEST_STATE_KEY` differs between the microVMs serving the rounds, which for the legacy shim should be impossible because all three rounds run inside one `tools/call`. If it happens anyway, check whether `random_password.request_state` was regenerated between the apply and the smoke run.
- `elicitation for provider offered 0 options`: `providersForCategory` fell through to the `other` pool and that pool is empty, or the appliance category on the seeded water heater is not `water_heater`.

- [ ] **Step 4: Record the deployed results**

Append `FL-027` (or the next free number) to `FRICTION-LOG.md` with the measured timings for `modern ask_manual`, `legacy book_service`, and `legacy get_visit`; whether progress notifications reached the legacy client on AgentCore (the `progress` list printed by the smoke); the ingestion job duration for a one-page document; and anything about S3 Vectors or Knowledge Base cold-start latency that affects the 3 s budget. Cite the workflow run URLs.

- [ ] **Step 5: Commit**

```bash
git add scripts .github/workflows/smoke.yml FRICTION-LOG.md
git commit -m "ops: smoke ask_manual against the knowledge base and book_service through the shim"
```

---

### Task 14: Documentation

**Files:**
- Modify: `README.md`, `FRICTION-LOG.md`

**Interfaces:**
- Consumes: everything Plan 2 built.
- Produces: a README that discloses the simulated marketplace, documents the nine-tool surface and the four widgets, and gives the manuals workflow end to end; a friction log whose Plan 2 entries are all filed and whose FL-016 status points at the S3 Vectors verification.

- [ ] **Step 1: Document the tool surface and the simulated data**

Insert into `README.md`, after the "Prerequisites" section and before "Local development":
```markdown
## What the server exposes

Nine tools, in a fixed order that is frozen after the first deploy:

| Tool | Does | Widget |
|---|---|---|
| `list_appliances` | Every appliance, filterable by room or category | `ui://homeledger/appliances` |
| `get_appliance` | One appliance with its maintenance tasks | `ui://homeledger/appliance` |
| `maintenance_due` | What is overdue or due inside a horizon | `ui://homeledger/calendar` |
| `log_maintenance` | Records a completed task, advances the next due date | none |
| `recent_events` | Visits, door events, and sensor alerts | none |
| `ask_manual` | Up to three manual passages with page numbers | none |
| `book_service` | Books a visit: provider, window, confirmation | `ui://homeledger/visit` |
| `get_visit` | One visit, with the arrival snapshot once one exists | `ui://homeledger/visit` |
| `echo_confirm` | Development-only elicitation probe, `HOMELEDGER_DEV_TOOLS=1` | none |

Three JSON resources (`homeledger://household`, `homeledger://appliances`, `homeledger://maintenance/schedule`), four `ui://` MCP Apps widgets, and one prompt (`seasonal-checklist`).

`ask_manual` returns source passages only and never composes an answer; the client model reads `structuredContent.passages` and writes the reply, citing the document title and page. `book_service` asks three questions through MCP elicitation — provider, arrival window, confirmation — and emits progress `0` to `3` while it checks availability. Both work on a 2026-07-28 client through multi round-trip requests and on a 2025-era client through the SDK's legacy shim over a session.

## Simulated data disclosure

Everything in HomeLedger is real except one thing: **the service-provider marketplace is sample data.** The companies, ratings, and phone numbers in `packages/core/src/marketplace/providers.ts` are invented, the availability windows are generated rather than queried, and no booking leaves this system. `book_service` writes a `VISIT#` row in DynamoDB and nothing else. Every other data path — appliances, warranties, maintenance history, manual retrieval, Ring events — is backed by the author's real household and real AWS services.

The Alexa+ experience is likewise simulated: the MCP Toolkit is in private preview and entrants cannot call Alexa+, so the simulator in `apps/simulator` drives the deployed server with a Strands agent and renders the documented Alexa+ visual foundations.
```

- [ ] **Step 2: Document the manuals workflow**

Insert into `README.md`, after the "Deployed endpoint" section (the block below is fenced with four backticks here because it contains its own fenced shell block; copy the inner content, not the outer fence):

````markdown
## Manuals and the knowledge base

Manuals live in S3 at `manuals/<householdId>/<docId>.pdf`, each beside a `<docId>.pdf.metadata.json` sidecar carrying `applianceId` and `title`. A Bedrock Knowledge Base ingests that prefix into an S3 Vectors index using Titan Text Embeddings v2; `ask_manual` calls `Retrieve` with an `equals` filter on `applianceId` when the caller supplies one, asks for three passages, and caches each question for ten minutes.

Add a manual:

```bash
cd infra/live/demo/platform
export AWS_REGION=$(terraform output -raw region 2>/dev/null || echo us-east-1)
export HOUSEHOLD_ID=hh_harlow
export TABLE_NAME=$(terraform output -raw table_name)
export MANUALS_BUCKET=$(terraform output -raw manuals_bucket)
export KNOWLEDGE_BASE_ID=$(terraform output -raw knowledge_base_id)
export DATA_SOURCE_ID=$(terraform output -raw data_source_id)
cd -
pnpm manuals -- --appliance appl_xxxxxxxxxxxxxxxx --title "LG WM4000HWA washer owner manual" --file ~/Downloads/wm4000hwa.pdf --pages 88
```

The script uploads both objects, writes the `DOC#` row, points the appliance's `manualDocId` at it, starts one ingestion job, waits for it to reach `COMPLETE`, flips `kbSync` to `synced`, and prints the doc id.

Without `KNOWLEDGE_BASE_ID`, the server falls back to a small in-memory fixture set so `pnpm dev` and the whole test suite run with no AWS account.
````

- [ ] **Step 3: Update local development for the new environment**

Replace the `.env.example` block reference in `README.md`'s "Local development" section with a note listing the new variables:
```markdown
`.env.example` documents every variable. The ones Plan 2 added:

- `KNOWLEDGE_BASE_ID` — when set, `ask_manual` calls the real Bedrock Knowledge Base; when unset it serves fixtures.
- `REQUEST_STATE_KEY` — at least 32 bytes, signs `book_service`'s cross-round state. Unset generates a per-process key and logs that it did.
- `AVAILABILITY_DELAY_MS` — total budget for the simulated availability check, default 600.
```

- [ ] **Step 4: Check the friction log is complete**

```bash
grep -n '^### FL-' FRICTION-LOG.md | tail -10
grep -n 'Status:' FRICTION-LOG.md | sed -n '16p'
```
Expected: entries FL-023 through FL-027 exist (or fewer, if some tasks genuinely deviated from nothing), each with all six fields, and FL-016's status line now points at the S3 Vectors verification entry. Any task that hit a documented-behaviour deviation and did not file an entry is a gap — file it now with the same evidence the task's commit carries.

- [ ] **Step 5: Final verification across the repo**

```bash
docker compose up -d
pnpm install --frozen-lockfile
pnpm --filter @homeledger/core build
pnpm format
pnpm typecheck
pnpm test
pnpm --filter @homeledger/core test:dynamo
pnpm build
cd infra && terraform fmt -check -recursive && cd ..
```
Expected: every command exits 0. Do not run `terraform plan` or `terraform apply`.

- [ ] **Step 6: Commit**

```bash
git add README.md FRICTION-LOG.md
git commit -m "docs: tool surface, simulated-data disclosure, and the manuals workflow"
```

---

## Self-review

**1. Spec coverage.**

| Spec section | Requirement | Task |
|---|---|---|
| 4.1 | MRTR write-once handlers: `inputResponses` first, `inputRequired.elicit`, signed `requestState` via `createRequestStateCodec` | 5 |
| 4.1 | Progress notifications during `book_service`'s availability phase | 7 |
| 4.1 | Every tool declares `outputSchema`; `content[0].text` is spoken text; `structuredContent` matches; `_meta.ui.resourceUri` where a widget exists | 4, 5, 8, 12 |
| 4.1 | Fixed tool order, frozen names and descriptions | 4, 5, 8 (order assertions), 13 (deployed assertion) |
| 4.2 `ask_manual` | `question`, `applianceId?` → `passages[] {text, docTitle, page, score}` max 3, metadata filter on `applianceId` | 3, 4, 9 |
| 4.2 `book_service` | `applianceId`, `issue`, `preferredWindow?` → `{visitId, provider, windowStart, windowEnd, status}`; provider enum ≤5, window enum, confirm boolean; progress 0→3; writes `VISIT#` | 1, 5, 6, 7 |
| 4.2 `get_visit` | visit + `snapshotUrl?` + `description?` | 8 |
| 4.2 note | Provider options come from a static, clearly labelled sample marketplace in `packages/core`, three to five per category, and the README says so | 1, 14 |
| 4.3 | `ui://homeledger/{appliances,appliance,calendar,visit}` resources | 12 |
| 4.4 | Single HTML files, inlined CSS, app-bridge for `hostContext` and data, tool calls from the widget, 768×480, theme-aware, no external assets | 12 |
| 4.6 | Tool budget under 3 s; Knowledge Base retrieval cached per question for 10 minutes | 9 (cache), 13 (measured budget) |
| 5 | `VISIT#` with GSI2, `DOC#`, manuals S3 layout with metadata sidecar | 2 (contract), 5 (write), 10 (bucket + KB), 11 (sidecar + `DOC#`) |
| 8 | S3 buckets for manuals, S3 Vectors bucket and index, Bedrock Knowledge Base and data source with `S3_VECTORS`, IAM per role, provider pinning with the AWSCC or CLI fallback | 10 |
| 9 | Unit tests per handler against a fake repository; MRTR round trips both directions; contract tests driving both client generations; integration against a real Knowledge Base; deployed smoke | 2–9, 12, 13 |
| 12 risk row | Terraform provider coverage for S3 Vectors — verify, then AWSCC or CLI fallback | 10 Step 1 |

Deferred Plan 1 review findings, all carried: the unchecked `as { action?: string }` cast in `dev.ts` is replaced by `elicitOutcome()` built on the SDK's `inputResponse()` (Task 5 Step 5); the contract suite gains `listAlerts`, `listDevices`, `putDevice`, and the `putVisit`/`getVisit`/`listVisitsSince` cases `book_service` and `get_visit` rely on (Task 2); `speakList`'s dead sub-branch is removed and `taskWords` becomes a shared `replaceAll` helper used by both `maintenance.ts` and `appliances.ts` (Task 4 Step 3).

No gaps. Out-of-scope items are listed explicitly under "Out of scope" and each belongs to a named later plan.

**2. Placeholder scan.** No "TBD", "implement later", "add error handling", or "similar to Task N" anywhere. Every code step carries complete code. The three places where an installed API could still differ from what was read out of `node_modules` each name the exact file to check and the exact alternative to write: `ServerOptions.requestState.verify` and `mint(payload, ctx)` (Task 5 Step 7), `ctx.mcpReq.notify` accepting a progress notification literal and `onprogress` surviving MRTR retries (Task 7 Step 4), and `RetrieveSender` assignability from the concrete AWS client (Task 9 Step 4). The Terraform schema names are verified before any HCL is written (Task 10 Step 1) with all three outcomes spelled out.

**3. Type consistency.** `ServerDeps` carries `repo`, `now`, `devTools`, `retriever`, `requestStateKey`, `availabilityDelayMs` in `server.ts`, `deps.ts`, and `harness.ts` alike. `Passage` is `{ text, docTitle, page, score }` in `retriever.ts`, in `fixture.ts`, in `bedrock.ts`, in `ask_manual`'s `outputSchema`, and in the smoke assertions. `BookingState` is `{ applianceId, issue, providerId?, windowStart?, windowEnd? }` in `service.ts` and in `buildServer`'s `createRequestStateCodec<BookingState>`. `ServiceWindow` ids are `win_1`, `win_2`, `win_3` in `availabilityWindows`, in the modern test, in the legacy test, and in the smoke script's first-option answer. Provider ids `prov_kettle_water` and `prov_harbor_line` exist in `SAMPLE_PROVIDERS` and are the ones the tests select. `WIDGET_URIS` keys and values are identical in `widgets/index.ts`, in `widgets.test.ts`, in the tool `_meta` wiring, and in the smoke script. Terraform output names `manuals_bucket`, `manuals_prefix`, `knowledge_base_id`, `data_source_id` are identical in the module, in the root, in `smoke.yml`, and in the README. Environment variable names `KNOWLEDGE_BASE_ID`, `REQUEST_STATE_KEY`, `AVAILABILITY_DELAY_MS`, `MANUALS_BUCKET`, `DATA_SOURCE_ID` are identical in `deps.ts`, `.env.example`, `manuals.ts`, `seed-manual.ts`, `smoke.yml`, and `main.tf`. The nine-tool order string is identical in `tools.test.ts`, `legacy.test.ts`, `smoke.ts`, and the README table.

## What Plan 3 starts from

A deployed MCP server with the complete tool surface: nine tools in a frozen order, three JSON resources, four `ui://` MCP Apps widgets, and one prompt, serving both protocol generations through AgentCore behind Cognito. `ask_manual` answers from a real Bedrock Knowledge Base over S3 Vectors with a ten-minute cache, fed by a repeatable manuals upload and ingestion script. `book_service` completes a three-question elicitation with progress notifications on a v2 in-process client, on a v1 client over a real socket, and on the deployed runtime through the legacy shim. `get_visit` returns a visit with `snapshotUrl` and `description` present and null, waiting for the Ring pipeline to fill them.

Plan 3 (simulator and agent) needs: the invocation URL and Cognito client credentials from the platform root's outputs; `WIDGET_URIS` and the `_meta.ui.resourceUri` convention to host the widgets in a sandboxed iframe with an Alexa-shaped `hostContext`; the view-side wire protocol in `apps/mcp-server/src/widgets/shell.ts` as the exact contract its `AppBridge` host must satisfy; and `elicitationCallback` semantics matching what `book_service` sends — a single-select enum with `enum` plus `enumNames` for provider and window, a boolean for confirm, never more than five options.

Plan 4 (Ring) needs: `VISIT#` rows written by `book_service` and queryable through GSI2 by `listVisitsInWindow`; `get_visit`'s `snapshotUrl` and `description` fields already in the output schema and already rendered by the visit widget; and the contract cases in `packages/core/test/repository.contract.ts` covering visit replacement, alerts, and devices, which the correlator, sensor-rules, and device-sync handlers all build on.
