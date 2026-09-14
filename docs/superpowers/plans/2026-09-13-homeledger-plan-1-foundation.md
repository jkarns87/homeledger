# HomeLedger Plan 1: Foundation and MCP Server Core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed, authenticated HomeLedger MCP server on AgentCore Runtime that serves the five read/write tools, three resources, and one prompt to both modern (2026-07-28) and legacy (2025-era) clients, with the legacy elicitation path proven end to end.

**Architecture:** pnpm monorepo. `packages/core` holds the domain, Zod schemas, and a DynamoDB single-table repository with an in-memory twin for tests. `apps/mcp-server` builds one `McpServer` factory and serves it through two branches behind a single `/mcp` route: modern requests go to the stateless `createMcpHandler`, legacy requests (detected with `isLegacyRequest`) go to per-session `NodeStreamableHTTPServerTransport` instances. Terraform provisions ECR, the execution role, Cognito, DynamoDB, and the AgentCore runtime; a smoke script proves the deployed endpoint with both client generations.

**Tech Stack:** Node 22, pnpm 10, TypeScript 5.x (ESM, NodeNext), Zod 4.2+, `@modelcontextprotocol/server` v2, `@modelcontextprotocol/node` v2, `@modelcontextprotocol/express` v2, `@modelcontextprotocol/client` v2 (tests), `@modelcontextprotocol/sdk` 1.x (legacy-client tests), `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` v3, Vitest, Docker (ARM64), Terraform >= 1.10 with `hashicorp/aws >= 6.21, < 7.0`.

**Spec:** `docs/superpowers/specs/2026-09-13-homeledger-design.md` (sections 3, 4.1, 4.2 rows 1–5 and 7, 4.3, 4.5, 4.6, 5, 8, 9, 12)

## Global Constraints

- Node `>=22.0.0`; pnpm `10.x`; every package `"type": "module"`.
- Zod `^4.2.0`, imported as `import * as z from 'zod/v4'`.
- MCP server listens on `0.0.0.0:8000`, route `/mcp`; container is `linux/arm64`.
- Every tool declares `outputSchema`; `content[0].text` is spoken text with no JSON; `structuredContent` validates against the schema; tool order in `tools/list` is fixed.
- Voice text lists at most five items; elicitation enums never exceed five options.
- IDs are prefixed and stable: `appl_`, `visit_`, `doc_`, `alert_`, `evt_`, `log_`, `dev_`.
- Household ID comes from `HOUSEHOLD_ID` env; no request may override it.
- Secrets never live in the repo. `.env` is gitignored; `.env.example` is committed.
- AgentCore runtime: `server_protocol = "MCP"`, stateful, `idle_runtime_session_timeout = 1800`.
- Commit after every task with a conventional-commit message. No co-author trailers.
- Any deviation from documented behavior gets an entry in `FRICTION-LOG.md` before the workaround is committed.

---

## File structure

```
homeledger/
├── package.json                      # workspace root scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .npmrc
├── .nvmrc
├── .gitignore
├── .env.example
├── LICENSE                           # MIT
├── README.md
├── docker-compose.yml                # DynamoDB Local
├── packages/core/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   └── src/
│       ├── index.ts                  # public exports
│       ├── ids.ts                    # newId(prefix)
│       ├── domain/schemas.ts         # Zod schemas + types for every entity
│       ├── domain/maintenance.ts     # computeNextDue, isOverdue
│       ├── repo/keys.ts              # PK/SK/GSI key builders
│       ├── repo/repository.ts        # Repository interface
│       ├── repo/memory.ts            # in-memory Repository (tests)
│       ├── repo/dynamo.ts            # DynamoDB Repository
│       ├── repo/table.ts             # ensureTable for DynamoDB Local
│       └── seed/household.ts         # seed data + seedRepository()
├── apps/mcp-server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── Dockerfile
│   └── src/
│       ├── index.ts                  # HTTP entrypoint (two branches)
│       ├── server.ts                 # buildServer(deps) → McpServer
│       ├── deps.ts                   # resolve Repository from env
│       ├── voice.ts                  # spoken-text helpers (≤5 items, no JSON)
│       ├── tools/appliances.ts       # list_appliances, get_appliance
│       ├── tools/maintenance.ts      # maintenance_due, log_maintenance
│       ├── tools/events.ts           # recent_events
│       ├── tools/dev.ts              # echo_confirm (elicitation spike, flag-gated)
│       ├── resources.ts              # household, appliances, schedule
│       └── prompts.ts                # seasonal-checklist
├── apps/mcp-server/test/
│   ├── harness.ts                    # in-process modern client + legacy HTTP server
│   ├── tools.test.ts
│   ├── resources.test.ts
│   ├── legacy.test.ts                # v1 client: initialize, session, elicitation
│   └── modern.test.ts                # v2 client: MRTR elicitation
├── scripts/
│   ├── build-image.sh                # buildx arm64 → ECR
│   └── smoke.ts                      # token → AgentCore → both clients
├── infra/
│   ├── versions.tf
│   ├── backend.tf
│   ├── variables.tf
│   ├── main.tf                       # ECR, IAM, Cognito, DynamoDB, AgentCore
│   ├── outputs.tf
│   └── demo.tfvars.example
└── .github/workflows/
    ├── ci.yml
    └── deploy.yml
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.npmrc`, `.nvmrc`, `.gitignore`, `.env.example`, `LICENSE`, `README.md`, `docker-compose.yml`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`, `packages/core/src/index.ts`, `packages/core/test/index.test.ts`

**Interfaces:**
- Produces: workspace commands `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`; package `@homeledger/core` importable by `apps/*`.

- [ ] **Step 1: Write the root workspace files**

`package.json`:
```json
{
  "name": "homeledger",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.15.0",
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "format": "prettier --check .",
    "format:write": "prettier --write ."
  },
  "devDependencies": {
    "prettier": "^3.7.4",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true
  }
}
```

`.npmrc`:
```
auto-install-peers=true
strict-peer-dependencies=false
```

`.nvmrc`:
```
22
```

`.gitignore`:
```
node_modules/
dist/
.env
*.tfstate
*.tfstate.backup
.terraform/
.terraform.lock.hcl
infra/demo.tfvars
coverage/
.DS_Store
```

`.env.example`:
```
AWS_REGION=us-east-1
HOUSEHOLD_ID=hh_harlow
TABLE_NAME=homeledger
DYNAMO_ENDPOINT=http://127.0.0.1:8000
HOMELEDGER_DEV_TOOLS=1
```

`docker-compose.yml`:
```yaml
services:
  dynamodb:
    image: amazon/dynamodb-local:latest
    command: ["-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb"]
    ports:
      - "8000:8000"
```

Note: DynamoDB Local and the MCP server both default to port 8000. Locally the server runs on `PORT=8010` (Task 7 reads `PORT`); in the container it is 8000 because AgentCore requires it.

`LICENSE`: the MIT license text with `Copyright (c) 2026 Joseph Karns`.

`README.md`:
```markdown
# HomeLedger

The household's operating record, exposed to an assistant through an MCP server.
Built for the Build, Ship, Shape: Amazon Developer Hackathon (Alexa+ and Ring tracks, AWS Builder mini-challenge).

- Design: `docs/superpowers/specs/2026-09-13-homeledger-design.md`
- Friction log: `FRICTION-LOG.md`

## Prerequisites

Node 22, pnpm 10, Docker, Terraform >= 1.10, AWS CLI v2.

## Local development

```bash
pnpm install
docker compose up -d           # DynamoDB Local on :8000
cp .env.example .env
pnpm -r test
```
```

- [ ] **Step 2: Write the core package skeleton and its first test**

`packages/core/package.json`:
```json
{
  "name": "@homeledger/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@aws-sdk/client-dynamodb": "^3.900.0",
    "@aws-sdk/lib-dynamodb": "^3.900.0",
    "zod": "^4.2.0"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`packages/core/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } });
```

`packages/core/src/index.ts`:
```ts
export const CORE_VERSION = '0.1.0';
```

`packages/core/test/index.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CORE_VERSION } from '../src/index.js';

describe('core package', () => {
  it('exports a version', () => {
    expect(CORE_VERSION).toBe('0.1.0');
  });
});
```

- [ ] **Step 3: Install and run**

Run: `pnpm install && pnpm typecheck && pnpm test`
Expected: install succeeds; typecheck prints nothing; Vitest reports `1 passed`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo with core package"
```

---

### Task 2: Domain schemas, IDs, and maintenance math

**Files:**
- Create: `packages/core/src/ids.ts`, `packages/core/src/domain/schemas.ts`, `packages/core/src/domain/maintenance.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/ids.test.ts`, `packages/core/test/schemas.test.ts`, `packages/core/test/maintenance.test.ts`

**Interfaces:**
- Produces: `newId(prefix: IdPrefix): string`; Zod schemas `ApplianceSchema`, `MaintenanceItemSchema`, `LogEntrySchema`, `DocSchema`, `VisitSchema`, `EventSchema`, `AlertSchema`, `DeviceSchema`, `HouseholdSchema` and their inferred types (`Appliance`, `MaintenanceItem`, `LogEntry`, `Doc`, `Visit`, `Event`, `Alert`, `Device`, `Household`); `computeNextDue(lastDoneAt: string, intervalDays: number): string`; `isOverdue(nextDueAt: string, now: string): boolean`.

- [ ] **Step 1: Write the failing ID test**

`packages/core/test/ids.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { newId } from '../src/ids.js';

describe('newId', () => {
  it('prefixes and produces 16 lowercase base32 characters', () => {
    const id = newId('appl');
    expect(id).toMatch(/^appl_[a-z2-7]{16}$/);
  });
  it('is unique across 1000 draws', () => {
    const set = new Set(Array.from({ length: 1000 }, () => newId('visit')));
    expect(set.size).toBe(1000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @homeledger/core test -- ids`
Expected: FAIL, cannot find module `../src/ids.js`.

- [ ] **Step 3: Implement IDs**

`packages/core/src/ids.ts`:
```ts
import { randomBytes } from 'node:crypto';

export type IdPrefix = 'appl' | 'visit' | 'doc' | 'alert' | 'evt' | 'log' | 'dev' | 'hh';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function newId(prefix: IdPrefix): string {
  const bytes = randomBytes(10); // 80 bits → 16 base32 chars
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `${prefix}_${out}`;
}
```

- [ ] **Step 4: Run the ID test**

Run: `pnpm --filter @homeledger/core test -- ids`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing schema and maintenance tests**

`packages/core/test/schemas.test.ts`:
```ts
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
    expect(() => ApplianceSchema.parse({ id: 'visit_abcdefghijklmnop', name: 'x', brand: 'x', model: 'x', serial: null, room: 'x', category: 'other', purchasedAt: null, warrantyUntil: null, manualDocId: null, templates: [] })).toThrow();
  });
  it('rejects a visit with an unknown status', () => {
    expect(() => VisitSchema.parse({ id: 'visit_abcdefghijklmnop', providerId: 'p1', providerName: 'A', category: 'plumbing', applianceId: 'appl_abcdefghijklmnop', issue: 'leak', windowStart: '2026-09-20T13:00:00Z', windowEnd: '2026-09-20T15:00:00Z', status: 'lost', ringEventIds: [], snapshotKey: null, description: null, arrivedAt: null, createdAt: '2026-09-13T00:00:00Z' })).toThrow();
  });
});
```

`packages/core/test/maintenance.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { computeNextDue, isOverdue } from '../src/domain/maintenance.js';

describe('maintenance math', () => {
  it('adds interval days to the last-done date', () => {
    expect(computeNextDue('2026-06-01', 90)).toBe('2026-08-30');
  });
  it('flags overdue when nextDue is before now', () => {
    expect(isOverdue('2026-08-30', '2026-09-13')).toBe(true);
    expect(isOverdue('2026-09-30', '2026-09-13')).toBe(false);
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm --filter @homeledger/core test`
Expected: FAIL on missing modules `../src/domain/schemas.js` and `../src/domain/maintenance.js`.

- [ ] **Step 7: Implement schemas and maintenance math**

`packages/core/src/domain/schemas.ts`:
```ts
import * as z from 'zod/v4';

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

export const HouseholdSchema = z.object({
  id: z.string().regex(/^hh_[a-z0-9_]+$/),
  name: z.string().min(1),
  timezone: z.string().min(1)
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
```

`packages/core/src/domain/maintenance.ts`:
```ts
const DAY_MS = 86_400_000;

function toDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function computeNextDue(lastDoneAt: string, intervalDays: number): string {
  return toIso(new Date(toDate(lastDoneAt).getTime() + intervalDays * DAY_MS));
}

export function isOverdue(nextDueAt: string, now: string): boolean {
  return toDate(nextDueAt).getTime() < toDate(now.slice(0, 10)).getTime();
}
```

Update `packages/core/src/index.ts`:
```ts
export const CORE_VERSION = '0.1.0';
export * from './ids.js';
export * from './domain/schemas.js';
export * from './domain/maintenance.js';
```

- [ ] **Step 8: Run all core tests**

Run: `pnpm --filter @homeledger/core test && pnpm --filter @homeledger/core typecheck`
Expected: PASS (7 tests); typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add packages/core
git commit -m "feat(core): domain schemas, prefixed ids, maintenance math"
```

---

### Task 3: Repository interface, key builders, and in-memory implementation

**Files:**
- Create: `packages/core/src/repo/keys.ts`, `packages/core/src/repo/repository.ts`, `packages/core/src/repo/memory.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/keys.test.ts`, `packages/core/test/repository.contract.ts`, `packages/core/test/memory.test.ts`

**Interfaces:**
- Consumes: schemas and types from Task 2.
- Produces:
  ```ts
  export interface Repository {
    getHousehold(): Promise<Household | null>;
    putHousehold(h: Household): Promise<void>;
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
  export function createMemoryRepository(householdId: string): Repository;
  ```
  Key builders: `pk(householdId)`, `sk.appliance(id)`, `sk.maintenance(applianceId, taskType)`, `sk.log(createdAt, id)`, `sk.doc(id)`, `sk.visit(id)`, `sk.event(at, id)`, `sk.alert(id)`, `sk.device(ringDeviceId)`, `sk.household()`, `gsi1.due(householdId)`, `gsi2.visit(householdId)`.
  The contract test file exports `runRepositoryContract(name: string, make: () => Promise<Repository>)` so Task 4 reuses every assertion against DynamoDB.

- [ ] **Step 1: Write the failing key-builder test**

`packages/core/test/keys.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { gsi1, gsi2, pk, sk } from '../src/repo/keys.js';

describe('keys', () => {
  it('builds partition and sort keys', () => {
    expect(pk('hh_harlow')).toBe('HH#hh_harlow');
    expect(sk.appliance('appl_a')).toBe('APPL#appl_a');
    expect(sk.maintenance('appl_a', 'filter_change')).toBe('MAINT#appl_a#filter_change');
    expect(sk.log('2026-09-13T10:00:00.000Z', 'log_1')).toBe('LOG#2026-09-13T10:00:00.000Z#log_1');
    expect(sk.event('2026-09-13T10:00:00.000Z', 'evt_1')).toBe('EVENT#2026-09-13T10:00:00.000Z#evt_1');
    expect(sk.household()).toBe('HOUSEHOLD');
    expect(gsi1.due('hh_harlow')).toBe('HH#hh_harlow#DUE');
    expect(gsi2.visit('hh_harlow')).toBe('HH#hh_harlow#VISIT');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @homeledger/core test -- keys`
Expected: FAIL, cannot find module `../src/repo/keys.js`.

- [ ] **Step 3: Implement key builders**

`packages/core/src/repo/keys.ts`:
```ts
export const pk = (householdId: string) => `HH#${householdId}`;

export const sk = {
  household: () => 'HOUSEHOLD',
  appliance: (id: string) => `APPL#${id}`,
  maintenance: (applianceId: string, taskType: string) => `MAINT#${applianceId}#${taskType}`,
  log: (createdAt: string, id: string) => `LOG#${createdAt}#${id}`,
  doc: (id: string) => `DOC#${id}`,
  visit: (id: string) => `VISIT#${id}`,
  event: (at: string, id: string) => `EVENT#${at}#${id}`,
  alert: (id: string) => `ALERT#${id}`,
  device: (ringDeviceId: string) => `DEVICE#${ringDeviceId}`
};

export const gsi1 = { due: (householdId: string) => `HH#${householdId}#DUE` };
export const gsi2 = { visit: (householdId: string) => `HH#${householdId}#VISIT` };
```

- [ ] **Step 4: Run the key test**

Run: `pnpm --filter @homeledger/core test -- keys`
Expected: PASS.

- [ ] **Step 5: Write the repository interface and the shared contract test**

`packages/core/src/repo/repository.ts`:
```ts
import type { Alert, Appliance, ApplianceCategoryValue, Device, Doc, Event, Household, LogEntry, MaintenanceItem, TaskTypeValue, Visit } from '../domain/schemas.js';

export interface Repository {
  getHousehold(): Promise<Household | null>;
  putHousehold(h: Household): Promise<void>;
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
```

`packages/core/test/repository.contract.ts` (imported by memory and dynamo tests; not itself a test file):
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Repository } from '../src/repo/repository.js';
import type { Appliance, Event, MaintenanceItem, Visit } from '../src/domain/schemas.js';

export const appliance = (over: Partial<Appliance> = {}): Appliance => ({
  id: 'appl_aaaaaaaaaaaaaaaa',
  name: 'Furnace',
  brand: 'Carrier',
  model: '59SC5A',
  serial: null,
  room: 'Basement',
  category: 'hvac',
  purchasedAt: '2019-10-01',
  warrantyUntil: '2029-10-01',
  manualDocId: null,
  templates: [{ taskType: 'filter_change', intervalDays: 90 }],
  ...over
});

export const maintenance = (over: Partial<MaintenanceItem> = {}): MaintenanceItem => ({
  applianceId: 'appl_aaaaaaaaaaaaaaaa',
  taskType: 'filter_change',
  intervalDays: 90,
  lastDoneAt: '2026-06-01',
  nextDueAt: '2026-08-30',
  notes: null,
  ...over
});

export const visit = (over: Partial<Visit> = {}): Visit => ({
  id: 'visit_aaaaaaaaaaaaaaaa',
  providerId: 'p_reliable',
  providerName: 'Reliable Plumbing',
  category: 'plumbing',
  applianceId: 'appl_aaaaaaaaaaaaaaaa',
  issue: 'Water heater leaking at the base',
  windowStart: '2026-09-22T13:00:00.000Z',
  windowEnd: '2026-09-22T15:00:00.000Z',
  status: 'scheduled',
  ringEventIds: [],
  snapshotKey: null,
  description: null,
  arrivedAt: null,
  createdAt: '2026-09-13T10:00:00.000Z',
  ...over
});

export const event = (over: Partial<Event> = {}): Event => ({
  id: 'evt_aaaaaaaaaaaaaaaa',
  ringEventId: 'ring-evt-1',
  type: 'button_press',
  subType: null,
  deviceId: 'ava1.ring.device.1',
  deviceName: 'Front Door',
  at: '2026-09-22T13:20:00.000Z',
  rawS3Key: null,
  ...over
});

export function runRepositoryContract(name: string, make: () => Promise<Repository>) {
  describe(`Repository contract: ${name}`, () => {
    let repo: Repository;
    beforeEach(async () => {
      repo = await make();
    });

    it('stores and lists appliances with filters', async () => {
      await repo.putAppliance(appliance());
      await repo.putAppliance(appliance({ id: 'appl_bbbbbbbbbbbbbbbb', name: 'Washer', room: 'Laundry', category: 'laundry' }));
      expect((await repo.listAppliances()).map(a => a.name).sort()).toEqual(['Furnace', 'Washer']);
      expect((await repo.listAppliances({ room: 'Laundry' })).map(a => a.name)).toEqual(['Washer']);
      expect((await repo.listAppliances({ category: 'hvac' })).map(a => a.name)).toEqual(['Furnace']);
      expect(await repo.getAppliance('appl_zzzzzzzzzzzzzzzz')).toBeNull();
    });

    it('lists maintenance due within a horizon, overdue first', async () => {
      await repo.putMaintenance(maintenance());
      await repo.putMaintenance(maintenance({ taskType: 'inspection', intervalDays: 365, lastDoneAt: '2025-10-01', nextDueAt: '2026-10-01' }));
      await repo.putMaintenance(maintenance({ applianceId: 'appl_bbbbbbbbbbbbbbbb', taskType: 'clean', intervalDays: 30, lastDoneAt: '2026-09-10', nextDueAt: '2026-12-10' }));
      const due = await repo.listMaintenanceDue(30, '2026-09-13');
      expect(due.map(m => m.taskType)).toEqual(['filter_change', 'inspection']);
    });

    it('deduplicates events by ring event id', async () => {
      expect(await repo.putEvent(event())).toBe('created');
      expect(await repo.putEvent(event({ id: 'evt_bbbbbbbbbbbbbbbb' }))).toBe('duplicate');
      expect((await repo.listEvents('2026-09-22T00:00:00.000Z')).length).toBe(1);
      expect((await repo.listEvents('2026-09-23T00:00:00.000Z')).length).toBe(0);
    });

    it('finds visits by window and since', async () => {
      await repo.putVisit(visit());
      await repo.putVisit(visit({ id: 'visit_bbbbbbbbbbbbbbbb', windowStart: '2026-09-25T13:00:00.000Z', windowEnd: '2026-09-25T15:00:00.000Z' }));
      const inWindow = await repo.listVisitsInWindow('2026-09-22T12:30:00.000Z', '2026-09-22T15:30:00.000Z');
      expect(inWindow.map(v => v.id)).toEqual(['visit_aaaaaaaaaaaaaaaa']);
      expect((await repo.listVisitsSince('2026-09-24T00:00:00.000Z')).map(v => v.id)).toEqual(['visit_bbbbbbbbbbbbbbbb']);
      const fetched = await repo.getVisit('visit_aaaaaaaaaaaaaaaa');
      expect(fetched?.providerName).toBe('Reliable Plumbing');
    });

    it('appends and lists logs newest first', async () => {
      await repo.appendLog({ id: 'log_aaaaaaaaaaaaaaaa', applianceId: 'appl_aaaaaaaaaaaaaaaa', taskType: 'filter_change', doneAt: '2026-06-01', notes: null, createdAt: '2026-06-01T12:00:00.000Z' });
      await repo.appendLog({ id: 'log_bbbbbbbbbbbbbbbb', applianceId: 'appl_aaaaaaaaaaaaaaaa', taskType: 'filter_change', doneAt: '2026-09-13', notes: 'MERV 11', createdAt: '2026-09-13T12:00:00.000Z' });
      const logs = await repo.listLogs('appl_aaaaaaaaaaaaaaaa', 10);
      expect(logs.map(l => l.doneAt)).toEqual(['2026-09-13', '2026-06-01']);
    });
  });
}
```

- [ ] **Step 6: Write the memory repository test**

`packages/core/test/memory.test.ts`:
```ts
import { createMemoryRepository } from '../src/repo/memory.js';
import { runRepositoryContract } from './repository.contract.js';

runRepositoryContract('memory', async () => createMemoryRepository('hh_test'));
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @homeledger/core test -- memory`
Expected: FAIL, cannot find module `../src/repo/memory.js`.

- [ ] **Step 8: Implement the in-memory repository**

`packages/core/src/repo/memory.ts`:
```ts
import type { Alert, Appliance, ApplianceCategoryValue, Device, Doc, Event, Household, LogEntry, MaintenanceItem, TaskTypeValue, Visit } from '../domain/schemas.js';
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
    async getHousehold() { return household; },
    async putHousehold(h) { household = h; },
    async putAppliance(a) { appliances.set(a.id, a); },
    async getAppliance(id) { return appliances.get(id) ?? null; },
    async listAppliances(filter) {
      return [...appliances.values()]
        .filter(a => (filter?.room ? a.room === filter.room : true))
        .filter(a => (filter?.category ? a.category === filter.category : true))
        .sort((x, y) => x.name.localeCompare(y.name));
    },
    async putMaintenance(m) { maintenance.set(`${m.applianceId}#${m.taskType}`, m); },
    async getMaintenance(applianceId: string, taskType: TaskTypeValue) { return maintenance.get(`${applianceId}#${taskType}`) ?? null; },
    async listMaintenanceDue(horizonDays, now) {
      const limit = addDays(now.slice(0, 10), horizonDays);
      return [...maintenance.values()]
        .filter(m => m.nextDueAt <= limit)
        .sort((x, y) => x.nextDueAt.localeCompare(y.nextDueAt));
    },
    async appendLog(e) { logs.push(e); },
    async listLogs(applianceId, limit) {
      return logs.filter(l => l.applianceId === applianceId).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, limit);
    },
    async putDoc(d) { docs.set(d.id, d); },
    async getDoc(id) { return docs.get(id) ?? null; },
    async putEvent(e) {
      if (events.has(e.ringEventId)) return 'duplicate';
      events.set(e.ringEventId, e);
      return 'created';
    },
    async listEvents(sinceIso) {
      return [...events.values()].filter(e => e.at >= sinceIso).sort((x, y) => y.at.localeCompare(x.at));
    },
    async putVisit(v) { visits.set(v.id, v); },
    async getVisit(id) { return visits.get(id) ?? null; },
    async listVisitsInWindow(fromIso, toIso) {
      return [...visits.values()].filter(v => v.windowStart <= toIso && v.windowEnd >= fromIso).sort((x, y) => x.windowStart.localeCompare(y.windowStart));
    },
    async listVisitsSince(sinceIso) {
      return [...visits.values()].filter(v => v.windowStart >= sinceIso).sort((x, y) => x.windowStart.localeCompare(y.windowStart));
    },
    async putAlert(a) { alerts.push(a); },
    async listAlerts(sinceIso) { return alerts.filter(a => a.at >= sinceIso).sort((x, y) => y.at.localeCompare(x.at)); },
    async putDevice(d) { devices.set(d.ringDeviceId, d); },
    async listDevices() { return [...devices.values()].sort((x, y) => x.name.localeCompare(y.name)); }
  };
}

export { isOverdue };
```

Note: `filter((a: Appliance) => ...)` type annotations are unnecessary because `Repository` types the returns; the `category` filter compares to `ApplianceCategoryValue`.

Update `packages/core/src/index.ts`:
```ts
export const CORE_VERSION = '0.1.0';
export * from './ids.js';
export * from './domain/schemas.js';
export * from './domain/maintenance.js';
export * from './repo/keys.js';
export type { Repository } from './repo/repository.js';
export { createMemoryRepository } from './repo/memory.js';
```

- [ ] **Step 9: Run the core tests**

Run: `pnpm --filter @homeledger/core test && pnpm --filter @homeledger/core typecheck`
Expected: PASS (13 tests); typecheck clean.

- [ ] **Step 10: Commit**

```bash
git add packages/core
git commit -m "feat(core): repository interface, key builders, in-memory repository with shared contract tests"
```

---

### Task 4: DynamoDB repository, table helper, and seed data

**Files:**
- Create: `packages/core/src/repo/dynamo.ts`, `packages/core/src/repo/table.ts`, `packages/core/src/seed/household.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/dynamo.test.ts`, `packages/core/test/seed.test.ts`

**Interfaces:**
- Consumes: `Repository`, key builders, schemas, `runRepositoryContract`.
- Produces:
  ```ts
  export function createDynamoRepository(opts: { tableName: string; householdId: string; client?: DynamoDBDocumentClient; endpoint?: string; region?: string }): Repository;
  export async function ensureTable(opts: { tableName: string; endpoint: string; region?: string }): Promise<void>; // test/local only
  export async function seedRepository(repo: Repository, householdId: string, today: string): Promise<{ applianceIds: string[] }>;
  export const SEED_APPLIANCES: Array<Omit<Appliance, 'id' | 'manualDocId'> & { lastDone: Partial<Record<TaskTypeValue, string>> }>;
  ```
  Table shape (must match Terraform in Task 11): `PK` (S, hash), `SK` (S, range); GSI1 `GSI1PK` (S) / `GSI1SK` (S); GSI2 `GSI2PK` (S) / `GSI2SK` (S); all attributes projected.

- [ ] **Step 1: Start DynamoDB Local**

Run: `docker compose up -d && curl -s http://127.0.0.1:8000 -o /dev/null -w '%{http_code}\n'`
Expected: `400` (DynamoDB Local answers with 400 to a bare GET, which proves it is listening).

- [ ] **Step 2: Write the failing DynamoDB contract test**

`packages/core/test/dynamo.test.ts`:
```ts
import { describe, it } from 'vitest';
import { createDynamoRepository } from '../src/repo/dynamo.js';
import { ensureTable } from '../src/repo/table.js';
import { runRepositoryContract } from './repository.contract.js';

const endpoint = process.env.DYNAMO_ENDPOINT;

if (!endpoint) {
  describe.skip('Repository contract: dynamo (set DYNAMO_ENDPOINT to run)', () => { it('skipped', () => {}); });
} else {
  let n = 0;
  runRepositoryContract('dynamo', async () => {
    const tableName = `homeledger-test-${Date.now()}-${n++}`;
    await ensureTable({ tableName, endpoint, region: 'us-east-1' });
    return createDynamoRepository({ tableName, householdId: 'hh_test', endpoint, region: 'us-east-1' });
  });
}
```

Add to `packages/core/package.json` scripts: `"test:dynamo": "DYNAMO_ENDPOINT=http://127.0.0.1:8000 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local vitest run"`.

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @homeledger/core test:dynamo -- dynamo`
Expected: FAIL, cannot find module `../src/repo/dynamo.js`.

- [ ] **Step 4: Implement the table helper**

`packages/core/src/repo/table.ts`:
```ts
import { CreateTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';

export async function ensureTable(opts: { tableName: string; endpoint: string; region?: string }): Promise<void> {
  const client = new DynamoDBClient({ endpoint: opts.endpoint, region: opts.region ?? 'us-east-1' });
  await client.send(
    new CreateTableCommand({
      TableName: opts.tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
        { AttributeName: 'GSI2PK', AttributeType: 'S' },
        { AttributeName: 'GSI2SK', AttributeType: 'S' }
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' }
      ],
      GlobalSecondaryIndexes: [
        { IndexName: 'GSI1', KeySchema: [{ AttributeName: 'GSI1PK', KeyType: 'HASH' }, { AttributeName: 'GSI1SK', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
        { IndexName: 'GSI2', KeySchema: [{ AttributeName: 'GSI2PK', KeyType: 'HASH' }, { AttributeName: 'GSI2SK', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } }
      ]
    })
  );
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: opts.tableName });
}
```

- [ ] **Step 5: Implement the DynamoDB repository**

`packages/core/src/repo/dynamo.ts`:
```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Alert, Appliance, Device, Doc, Event, Household, LogEntry, MaintenanceItem, TaskTypeValue, Visit } from '../domain/schemas.js';
import { gsi1, gsi2, pk, sk } from './keys.js';
import type { Repository } from './repository.js';

type Item = Record<string, unknown>;

function addDays(isoDate: string, days: number): string {
  return new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function strip<T>(item: Item | undefined): T | null {
  if (!item) return null;
  const { PK: _pk, SK: _sk, GSI1PK: _g1p, GSI1SK: _g1s, GSI2PK: _g2p, GSI2SK: _g2s, entity: _e, ...rest } = item;
  return rest as T;
}

export function createDynamoRepository(opts: {
  tableName: string;
  householdId: string;
  client?: DynamoDBDocumentClient;
  endpoint?: string;
  region?: string;
}): Repository {
  const doc =
    opts.client ??
    DynamoDBDocumentClient.from(new DynamoDBClient({ region: opts.region ?? process.env.AWS_REGION ?? 'us-east-1', ...(opts.endpoint ? { endpoint: opts.endpoint } : {}) }), {
      marshallOptions: { removeUndefinedValues: true }
    });
  const T = opts.tableName;
  const P = pk(opts.householdId);

  const put = (SK: string, entity: string, body: Item, extra: Item = {}) =>
    doc.send(new PutCommand({ TableName: T, Item: { PK: P, SK, entity, ...body, ...extra } }));

  const get = async <R>(SK: string): Promise<R | null> => {
    const out = await doc.send(new GetCommand({ TableName: T, Key: { PK: P, SK } }));
    return strip<R>(out.Item);
  };

  const queryPrefix = async <R>(prefix: string, opts2: { forward?: boolean; limit?: number } = {}): Promise<R[]> => {
    const out = await doc.send(
      new QueryCommand({
        TableName: T,
        KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
        ExpressionAttributeValues: { ':p': P, ':s': prefix },
        ScanIndexForward: opts2.forward ?? true,
        ...(opts2.limit ? { Limit: opts2.limit } : {})
      })
    );
    return (out.Items ?? []).map(i => strip<R>(i) as R);
  };

  return {
    async getHousehold() { return get<Household>(sk.household()); },
    async putHousehold(h) { await put(sk.household(), 'household', h); },

    async putAppliance(a) { await put(sk.appliance(a.id), 'appliance', a); },
    async getAppliance(id) { return get<Appliance>(sk.appliance(id)); },
    async listAppliances(filter) {
      const all = await queryPrefix<Appliance>('APPL#');
      return all
        .filter(a => (filter?.room ? a.room === filter.room : true))
        .filter(a => (filter?.category ? a.category === filter.category : true))
        .sort((x, y) => x.name.localeCompare(y.name));
    },

    async putMaintenance(m) {
      await put(sk.maintenance(m.applianceId, m.taskType), 'maintenance', m, { GSI1PK: gsi1.due(opts.householdId), GSI1SK: m.nextDueAt });
    },
    async getMaintenance(applianceId: string, taskType: TaskTypeValue) { return get<MaintenanceItem>(sk.maintenance(applianceId, taskType)); },
    async listMaintenanceDue(horizonDays, now) {
      const limit = addDays(now.slice(0, 10), horizonDays);
      const out = await doc.send(
        new QueryCommand({
          TableName: T,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :p AND GSI1SK <= :d',
          ExpressionAttributeValues: { ':p': gsi1.due(opts.householdId), ':d': limit },
          ScanIndexForward: true
        })
      );
      return (out.Items ?? []).map(i => strip<MaintenanceItem>(i) as MaintenanceItem);
    },

    async appendLog(e) { await put(sk.log(e.createdAt, e.id), 'log', e); },
    async listLogs(applianceId, limit) {
      const all = await queryPrefix<LogEntry>('LOG#', { forward: false });
      return all.filter(l => l.applianceId === applianceId).slice(0, limit);
    },

    async putDoc(d) { await put(sk.doc(d.id), 'doc', d); },
    async getDoc(id) { return get<Doc>(sk.doc(id)); },

    async putEvent(e) {
      try {
        await doc.send(
          new PutCommand({
            TableName: T,
            Item: { PK: P, SK: `EVENTID#${e.ringEventId}`, entity: 'event_marker', eventId: e.id },
            ConditionExpression: 'attribute_not_exists(PK)'
          })
        );
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return 'duplicate';
        throw err;
      }
      await put(sk.event(e.at, e.id), 'event', e);
      return 'created';
    },
    async listEvents(sinceIso) {
      const out = await doc.send(
        new QueryCommand({
          TableName: T,
          KeyConditionExpression: 'PK = :p AND SK BETWEEN :from AND :to',
          ExpressionAttributeValues: { ':p': P, ':from': `EVENT#${sinceIso}`, ':to': 'EVENT#9999' },
          ScanIndexForward: false
        })
      );
      return (out.Items ?? []).map(i => strip<Event>(i) as Event);
    },

    async putVisit(v) {
      await put(sk.visit(v.id), 'visit', v, { GSI2PK: gsi2.visit(opts.householdId), GSI2SK: v.windowStart });
    },
    async getVisit(id) { return get<Visit>(sk.visit(id)); },
    async listVisitsInWindow(fromIso, toIso) {
      const out = await doc.send(
        new QueryCommand({
          TableName: T,
          IndexName: 'GSI2',
          KeyConditionExpression: 'GSI2PK = :p AND GSI2SK <= :to',
          FilterExpression: 'windowEnd >= :from',
          ExpressionAttributeValues: { ':p': gsi2.visit(opts.householdId), ':to': toIso, ':from': fromIso },
          ScanIndexForward: true
        })
      );
      return (out.Items ?? []).map(i => strip<Visit>(i) as Visit);
    },
    async listVisitsSince(sinceIso) {
      const out = await doc.send(
        new QueryCommand({
          TableName: T,
          IndexName: 'GSI2',
          KeyConditionExpression: 'GSI2PK = :p AND GSI2SK >= :s',
          ExpressionAttributeValues: { ':p': gsi2.visit(opts.householdId), ':s': sinceIso },
          ScanIndexForward: true
        })
      );
      return (out.Items ?? []).map(i => strip<Visit>(i) as Visit);
    },

    async putAlert(a) { await put(sk.alert(a.id), 'alert', a); },
    async listAlerts(sinceIso) {
      const all = await queryPrefix<Alert>('ALERT#');
      return all.filter(a => a.at >= sinceIso).sort((x, y) => y.at.localeCompare(x.at));
    },

    async putDevice(d) { await put(sk.device(d.ringDeviceId), 'device', d); },
    async listDevices() {
      const all = await queryPrefix<Device>('DEVICE#');
      return all.sort((x, y) => x.name.localeCompare(y.name));
    }
  };
}
```

- [ ] **Step 6: Run the DynamoDB contract**

Run: `pnpm --filter @homeledger/core test:dynamo -- dynamo`
Expected: PASS (5 contract tests against DynamoDB Local).

- [ ] **Step 7: Write the failing seed test**

`packages/core/test/seed.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createMemoryRepository } from '../src/repo/memory.js';
import { SEED_APPLIANCES, seedRepository } from '../src/seed/household.js';

describe('seed', () => {
  it('writes the household, every appliance, and one maintenance item per template', async () => {
    const repo = createMemoryRepository('hh_harlow');
    const { applianceIds } = await seedRepository(repo, 'hh_harlow', '2026-09-13');
    expect(applianceIds.length).toBe(SEED_APPLIANCES.length);
    expect((await repo.getHousehold())?.name).toBe('The Harlow household');
    const due = await repo.listMaintenanceDue(3650, '2026-09-13');
    const templateCount = SEED_APPLIANCES.reduce((n, a) => n + a.templates.length, 0);
    expect(due.length).toBe(templateCount);
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `pnpm --filter @homeledger/core test -- seed`
Expected: FAIL, cannot find module `../src/seed/household.js`.

- [ ] **Step 9: Implement the seed**

`packages/core/src/seed/household.ts`. Replace brand, model, and dates with the real appliances before recording the video; the household and people names stay fictional.
```ts
import type { Appliance, TaskTypeValue } from '../domain/schemas.js';
import { computeNextDue } from '../domain/maintenance.js';
import { newId } from '../ids.js';
import type { Repository } from '../repo/repository.js';

type SeedAppliance = Omit<Appliance, 'id' | 'manualDocId'> & { lastDone: Partial<Record<TaskTypeValue, string>> };

export const SEED_APPLIANCES: SeedAppliance[] = [
  {
    name: 'Furnace', brand: 'Carrier', model: '59SC5A060E17', serial: null, room: 'Basement', category: 'hvac',
    purchasedAt: '2019-10-01', warrantyUntil: '2029-10-01',
    templates: [{ taskType: 'filter_change', intervalDays: 90 }, { taskType: 'inspection', intervalDays: 365 }],
    lastDone: { filter_change: '2026-06-01', inspection: '2025-10-15' }
  },
  {
    name: 'Water heater', brand: 'Rheem', model: 'XG50T12HE40U0', serial: null, room: 'Basement', category: 'water_heater',
    purchasedAt: '2021-03-12', warrantyUntil: '2033-03-12',
    templates: [{ taskType: 'flush', intervalDays: 365 }, { taskType: 'inspection', intervalDays: 180 }],
    lastDone: { flush: '2025-09-01', inspection: '2026-03-01' }
  },
  {
    name: 'Washer', brand: 'LG', model: 'WM4000HWA', serial: null, room: 'Laundry', category: 'laundry',
    purchasedAt: '2022-05-20', warrantyUntil: '2023-05-20',
    templates: [{ taskType: 'clean', intervalDays: 30 }],
    lastDone: { clean: '2026-08-20' }
  },
  {
    name: 'Dishwasher', brand: 'Bosch', model: 'SHPM88Z75N', serial: null, room: 'Kitchen', category: 'kitchen',
    purchasedAt: '2020-11-02', warrantyUntil: '2021-11-02',
    templates: [{ taskType: 'clean', intervalDays: 30 }],
    lastDone: { clean: '2026-09-01' }
  },
  {
    name: 'Refrigerator', brand: 'Samsung', model: 'RF28R7351SG', serial: null, room: 'Kitchen', category: 'kitchen',
    purchasedAt: '2020-11-02', warrantyUntil: '2021-11-02',
    templates: [{ taskType: 'replace_part', intervalDays: 180 }],
    lastDone: { replace_part: '2026-04-10' }
  },
  {
    name: 'Sump pump', brand: 'Zoeller', model: 'M53', serial: null, room: 'Basement', category: 'plumbing',
    purchasedAt: '2018-04-01', warrantyUntil: '2021-04-01',
    templates: [{ taskType: 'test', intervalDays: 90 }],
    lastDone: { test: '2026-07-01' }
  }
];

export async function seedRepository(repo: Repository, householdId: string, today: string): Promise<{ applianceIds: string[] }> {
  await repo.putHousehold({ id: householdId, name: 'The Harlow household', timezone: 'America/Chicago' });
  const applianceIds: string[] = [];
  for (const seed of SEED_APPLIANCES) {
    const id = newId('appl');
    const { lastDone, ...rest } = seed;
    await repo.putAppliance({ ...rest, id, manualDocId: null });
    for (const t of seed.templates) {
      const last = lastDone[t.taskType] ?? today;
      await repo.putMaintenance({ applianceId: id, taskType: t.taskType, intervalDays: t.intervalDays, lastDoneAt: last, nextDueAt: computeNextDue(last, t.intervalDays), notes: null });
    }
    applianceIds.push(id);
  }
  return { applianceIds };
}
```

Update `packages/core/src/index.ts` to add:
```ts
export { createDynamoRepository } from './repo/dynamo.js';
export { ensureTable } from './repo/table.js';
export { SEED_APPLIANCES, seedRepository } from './seed/household.js';
```

- [ ] **Step 10: Run all core tests, both modes**

Run: `pnpm --filter @homeledger/core test && pnpm --filter @homeledger/core test:dynamo && pnpm --filter @homeledger/core typecheck`
Expected: PASS in both runs; typecheck clean.

- [ ] **Step 11: Commit**

```bash
git add packages/core
git commit -m "feat(core): DynamoDB repository, table helper, and household seed"
```

---

### Task 5: MCP server package, server factory, voice helpers, appliance tools

**Files:**
- Create: `apps/mcp-server/package.json`, `apps/mcp-server/tsconfig.json`, `apps/mcp-server/vitest.config.ts`, `apps/mcp-server/src/server.ts`, `apps/mcp-server/src/voice.ts`, `apps/mcp-server/src/tools/appliances.ts`
- Test: `apps/mcp-server/test/harness.ts`, `apps/mcp-server/test/voice.test.ts`, `apps/mcp-server/test/tools.test.ts`

**Interfaces:**
- Consumes: `Repository`, `createMemoryRepository`, `seedRepository`, schemas from `@homeledger/core`.
- Produces:
  ```ts
  export interface ServerDeps { repo: Repository; now: () => string; devTools: boolean }
  export function buildServer(deps: ServerDeps): McpServer;          // src/server.ts
  export function speakList(items: string[], noun: string): string;   // src/voice.ts
  export function hasJson(text: string): boolean;                     // src/voice.ts
  export function registerApplianceTools(server: McpServer, deps: ServerDeps): void;
  // test/harness.ts
  export async function modernClient(deps?: Partial<ServerDeps>): Promise<{ client: Client; deps: ServerDeps; close: () => Promise<void> }>;
  export async function seededDeps(): Promise<ServerDeps>;
  ```
  Tool registration order, fixed for the life of the project: `list_appliances`, `get_appliance`, `ask_manual` (Plan 2), `maintenance_due`, `log_maintenance`, `book_service` (Plan 2), `recent_events`, `get_visit` (Plan 4), then dev tools when `devTools` is true.

- [ ] **Step 1: Write the package files**

`apps/mcp-server/package.json`:
```json
{
  "name": "@homeledger/mcp-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@homeledger/core": "workspace:*",
    "@modelcontextprotocol/express": "^2.0.0",
    "@modelcontextprotocol/node": "^2.0.0",
    "@modelcontextprotocol/server": "^2.0.0",
    "express": "^5.1.0",
    "zod": "^4.2.0"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "^2.0.0",
    "@modelcontextprotocol/sdk": "^1.25.2",
    "@types/express": "^5.0.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`apps/mcp-server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "types": ["node"] },
  "include": ["src"]
}
```

`apps/mcp-server/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 15000 } });
```

Run: `pnpm install`
Expected: resolves the four `@modelcontextprotocol/*` v2 packages and the v1 `@modelcontextprotocol/sdk` side by side. If `pnpm install` reports a peer conflict between zod versions, add `zod` to `pnpm.overrides` in the root `package.json` as `"zod": "^4.2.0"` and log it in `FRICTION-LOG.md`.

- [ ] **Step 2: Write the failing voice tests**

`apps/mcp-server/test/voice.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { hasJson, speakList } from '../src/voice.js';

describe('speakList', () => {
  it('reads up to five items and counts the rest', () => {
    expect(speakList(['Furnace', 'Washer'], 'appliance')).toBe('2 appliances: Furnace and Washer.');
    expect(speakList(['A', 'B', 'C', 'D', 'E', 'F', 'G'], 'appliance')).toBe('7 appliances: A, B, C, D, E, and 2 more.');
    expect(speakList(['Furnace'], 'appliance')).toBe('1 appliance: Furnace.');
    expect(speakList([], 'appliance')).toBe('No appliances.');
  });
});

describe('hasJson', () => {
  it('detects braces and brackets that look like JSON', () => {
    expect(hasJson('{"a":1}')).toBe(true);
    expect(hasJson('items: ["a"]')).toBe(true);
    expect(hasJson('Two appliances: Furnace and Washer.')).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @homeledger/mcp-server test -- voice`
Expected: FAIL, cannot find module `../src/voice.js`.

- [ ] **Step 4: Implement voice helpers**

`apps/mcp-server/src/voice.ts`:
```ts
export const VOICE_MAX_ITEMS = 5;

export function speakList(items: string[], noun: string): string {
  const plural = (n: number) => (n === 1 ? noun : `${noun}s`);
  if (items.length === 0) return `No ${plural(0)}.`;
  const shown = items.slice(0, VOICE_MAX_ITEMS);
  const rest = items.length - shown.length;
  let joined: string;
  if (shown.length === 1) joined = shown[0]!;
  else if (shown.length === 2 && rest === 0) joined = `${shown[0]} and ${shown[1]}`;
  else joined = `${shown.slice(0, -1).join(', ')}, and ${rest > 0 ? `${rest} more` : shown[shown.length - 1]}`;
  if (rest > 0 && shown.length > 1) joined = `${shown.join(', ')}, and ${rest} more`;
  return `${items.length} ${plural(items.length)}: ${joined}.`;
}

export function hasJson(text: string): boolean {
  return /[{}[\]]/.test(text);
}

export function speakDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}
```

- [ ] **Step 5: Run voice tests**

Run: `pnpm --filter @homeledger/mcp-server test -- voice`
Expected: PASS (2 tests). If the seven-item case fails on wording, fix `speakList` until the expected strings match exactly; the strings are the contract.

- [ ] **Step 6: Write the harness and the failing appliance-tool tests**

`apps/mcp-server/test/harness.ts`:
```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMemoryRepository, seedRepository } from '@homeledger/core';
import { buildServer, type ServerDeps } from '../src/server.js';

export const TODAY = '2026-09-13';

export async function seededDeps(): Promise<ServerDeps> {
  const repo = createMemoryRepository('hh_test');
  await seedRepository(repo, 'hh_test', TODAY);
  return { repo, now: () => `${TODAY}T12:00:00.000Z`, devTools: true };
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

`apps/mcp-server/test/tools.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { hasJson } from '../src/voice.js';
import { modernClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => { await close(); });

describe('tools/list', () => {
  it('lists tools in the fixed order with output schemas', async () => {
    const h = await modernClient();
    close = h.close;
    const { tools } = await h.client.listTools();
    expect(tools.map(t => t.name)).toEqual(['list_appliances', 'get_appliance']);
    for (const t of tools) expect(t.outputSchema).toBeDefined();
  });
});

describe('list_appliances', () => {
  it('speaks at most five names and returns the full list structured', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'list_appliances', arguments: {} });
    const text = (r.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    expect(hasJson(text)).toBe(false);
    expect(text.startsWith('6 appliances:')).toBe(true);
    expect(text).toContain('and 1 more');
    const sc = r.structuredContent as { appliances: Array<{ id: string; name: string; warrantyStatus: string }> };
    expect(sc.appliances.length).toBe(6);
    expect(sc.appliances.every(a => /^appl_/.test(a.id))).toBe(true);
    expect(sc.appliances.find(a => a.name === 'Furnace')?.warrantyStatus).toBe('active');
    expect(sc.appliances.find(a => a.name === 'Washer')?.warrantyStatus).toBe('expired');
  });
  it('filters by room', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'list_appliances', arguments: { room: 'Kitchen' } });
    const sc = r.structuredContent as { appliances: Array<{ name: string }> };
    expect(sc.appliances.map(a => a.name).sort()).toEqual(['Dishwasher', 'Refrigerator']);
  });
});

describe('get_appliance', () => {
  it('returns maintenance state for a known appliance', async () => {
    const h = await modernClient();
    close = h.close;
    const list = await h.client.callTool({ name: 'list_appliances', arguments: { category: 'hvac' } });
    const id = (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
    const r = await h.client.callTool({ name: 'get_appliance', arguments: { applianceId: id } });
    const sc = r.structuredContent as { appliance: { name: string }; maintenance: Array<{ taskType: string; nextDueAt: string; overdue: boolean }> };
    expect(sc.appliance.name).toBe('Furnace');
    const filter = sc.maintenance.find(m => m.taskType === 'filter_change');
    expect(filter?.nextDueAt).toBe('2026-08-30');
    expect(filter?.overdue).toBe(true);
    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(text).toContain('Furnace');
    expect(hasJson(text)).toBe(false);
  });
  it('answers an unknown id with a friendly error', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'get_appliance', arguments: { applianceId: 'appl_zzzzzzzzzzzzzzzz' } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("I couldn't find that appliance.");
  });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `pnpm --filter @homeledger/mcp-server test -- tools`
Expected: FAIL, cannot find module `../src/server.js`.

- [ ] **Step 8: Implement the server factory and appliance tools**

`apps/mcp-server/src/server.ts`:
```ts
import { McpServer } from '@modelcontextprotocol/server';
import type { Repository } from '@homeledger/core';
import { registerApplianceTools } from './tools/appliances.js';

export interface ServerDeps {
  repo: Repository;
  now: () => string; // ISO datetime
  devTools: boolean;
}

export const SERVER_INFO = { name: 'homeledger', version: '0.1.0' } as const;

export function buildServer(deps: ServerDeps): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'HomeLedger is the household operating record: appliances, warranties, manuals, maintenance, service visits, and door and sensor events. Speak results plainly; never read identifiers aloud.'
  });
  registerApplianceTools(server, deps);
  return server;
}
```

`apps/mcp-server/src/tools/appliances.ts`:
```ts
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ApplianceCategory, TaskType, isOverdue } from '@homeledger/core';
import type { ServerDeps } from '../server.js';
import { speakDate, speakList } from '../voice.js';

const WarrantyStatus = z.enum(['active', 'expired', 'unknown']);

export const ApplianceSummary = z.object({
  id: z.string(),
  name: z.string(),
  brand: z.string(),
  model: z.string(),
  room: z.string(),
  category: ApplianceCategory,
  warrantyStatus: WarrantyStatus
});

export function warrantyStatus(warrantyUntil: string | null, today: string): z.infer<typeof WarrantyStatus> {
  if (!warrantyUntil) return 'unknown';
  return warrantyUntil >= today ? 'active' : 'expired';
}

export function registerApplianceTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'list_appliances',
    {
      title: 'List appliances',
      description: 'List the household appliances, optionally filtered by room or category. Use this to find an appliance id before calling other tools.',
      inputSchema: z.object({ room: z.string().optional(), category: ApplianceCategory.optional() }),
      outputSchema: z.object({ appliances: z.array(ApplianceSummary) }),
      annotations: { readOnlyHint: true }
    },
    async ({ room, category }) => {
      const today = deps.now().slice(0, 10);
      const rows = await deps.repo.listAppliances({ room, category });
      const appliances = rows.map(a => ({ id: a.id, name: a.name, brand: a.brand, model: a.model, room: a.room, category: a.category, warrantyStatus: warrantyStatus(a.warrantyUntil, today) }));
      return {
        content: [{ type: 'text', text: speakList(appliances.map(a => a.name), 'appliance') }],
        structuredContent: { appliances }
      };
    }
  );

  server.registerTool(
    'get_appliance',
    {
      title: 'Get appliance',
      description: 'Details for one appliance: warranty state and every maintenance task with its last-done and next-due dates.',
      inputSchema: z.object({ applianceId: z.string() }),
      outputSchema: z.object({
        appliance: ApplianceSummary.extend({ serial: z.string().nullable(), purchasedAt: z.string().nullable(), warrantyUntil: z.string().nullable() }),
        maintenance: z.array(z.object({ taskType: TaskType, intervalDays: z.number(), lastDoneAt: z.string().nullable(), nextDueAt: z.string(), overdue: z.boolean() }))
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ applianceId }) => {
      const today = deps.now().slice(0, 10);
      const a = await deps.repo.getAppliance(applianceId);
      if (!a) return { content: [{ type: 'text', text: "I couldn't find that appliance." }], isError: true };
      const maintenance = [];
      for (const t of a.templates) {
        const m = await deps.repo.getMaintenance(a.id, t.taskType);
        if (m) maintenance.push({ taskType: m.taskType, intervalDays: m.intervalDays, lastDoneAt: m.lastDoneAt, nextDueAt: m.nextDueAt, overdue: isOverdue(m.nextDueAt, today) });
      }
      const status = warrantyStatus(a.warrantyUntil, today);
      const warrantyText = status === 'active' ? `under warranty until ${speakDate(a.warrantyUntil!)}` : status === 'expired' ? 'out of warranty' : 'warranty unknown';
      const dueText = maintenance.length === 0 ? 'No maintenance scheduled.' : speakList(maintenance.map(m => `${m.taskType.replace('_', ' ')} ${m.overdue ? 'overdue since' : 'due'} ${speakDate(m.nextDueAt)}`), 'task');
      return {
        content: [{ type: 'text', text: `${a.name}, ${a.brand} ${a.model} in the ${a.room}, ${warrantyText}. ${dueText}` }],
        structuredContent: {
          appliance: { id: a.id, name: a.name, brand: a.brand, model: a.model, room: a.room, category: a.category, warrantyStatus: status, serial: a.serial, purchasedAt: a.purchasedAt, warrantyUntil: a.warrantyUntil },
          maintenance
        }
      };
    }
  );
}
```

- [ ] **Step 9: Run the tests**

Run: `pnpm --filter @homeledger/mcp-server test && pnpm --filter @homeledger/mcp-server typecheck`
Expected: PASS (7 tests); typecheck clean. If `registerTool`'s handler type rejects `isError` on the return, check the v2 `CallToolResult` type from `@modelcontextprotocol/server` and match its shape; log any mismatch with the docs in `FRICTION-LOG.md`.

- [ ] **Step 10: Commit**

```bash
git add apps/mcp-server pnpm-lock.yaml
git commit -m "feat(mcp-server): server factory, voice helpers, list_appliances and get_appliance"
```

---

### Task 6: Maintenance tools

**Files:**
- Create: `apps/mcp-server/src/tools/maintenance.ts`
- Modify: `apps/mcp-server/src/server.ts`
- Test: `apps/mcp-server/test/maintenance.test.ts`, `apps/mcp-server/test/tools.test.ts` (tool order assertion)

**Interfaces:**
- Consumes: `ServerDeps`, `speakList`, `speakDate`, `isOverdue`, `computeNextDue`, `newId`.
- Produces: `registerMaintenanceTools(server, deps)`; tools `maintenance_due` (`{ horizonDays?: number }` → `{ items: Array<{ applianceId, applianceName, taskType, nextDueAt, overdue }> }`) and `log_maintenance` (`{ applianceId, taskType, date?, notes? }` → `{ logged: boolean; nextDueAt: string }`).

- [ ] **Step 1: Write the failing tests**

`apps/mcp-server/test/maintenance.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { hasJson } from '../src/voice.js';
import { modernClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => { await close(); });

async function furnaceId(client: Awaited<ReturnType<typeof modernClient>>['client']) {
  const list = await client.callTool({ name: 'list_appliances', arguments: { category: 'hvac' } });
  return (list.structuredContent as { appliances: Array<{ id: string }> }).appliances[0]!.id;
}

describe('maintenance_due', () => {
  it('returns overdue and upcoming items within the horizon, overdue first', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'maintenance_due', arguments: { horizonDays: 30 } });
    const sc = r.structuredContent as { items: Array<{ applianceName: string; taskType: string; nextDueAt: string; overdue: boolean }> };
    // Seeded order by nextDueAt: water heater inspection 2026-08-28, furnace filter 2026-08-30, water heater flush 2026-09-01, ...
    expect(sc.items[0]).toMatchObject({ applianceName: 'Water heater', taskType: 'inspection', nextDueAt: '2026-08-28', overdue: true });
    expect(sc.items[1]).toMatchObject({ applianceName: 'Furnace', taskType: 'filter_change', nextDueAt: '2026-08-30', overdue: true });
    expect(sc.items.some(i => i.applianceName === 'Water heater' && i.taskType === 'flush')).toBe(true);
    expect(sc.items.some(i => i.applianceName === 'Furnace' && i.taskType === 'inspection')).toBe(false); // 2026-10-15 is outside 30 days
    expect(sc.items.every(i => i.nextDueAt <= '2026-10-13')).toBe(true);
    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(hasJson(text)).toBe(false);
    expect(text).toContain('Furnace filter change');
  });
  it('defaults the horizon to 30 days', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'maintenance_due', arguments: {} });
    const sc = r.structuredContent as { items: Array<{ nextDueAt: string }> };
    expect(sc.items.every(i => i.nextDueAt <= '2026-10-13')).toBe(true);
  });
});

describe('log_maintenance', () => {
  it('records the task and advances the next due date', async () => {
    const h = await modernClient();
    close = h.close;
    const id = await furnaceId(h.client);
    const r = await h.client.callTool({ name: 'log_maintenance', arguments: { applianceId: id, taskType: 'filter_change', date: '2026-09-13', notes: 'MERV 11' } });
    expect(r.structuredContent).toEqual({ logged: true, nextDueAt: '2026-12-12' });
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe('Logged the furnace filter change for September 13. Next one is due December 12.');
    const after = await h.client.callTool({ name: 'get_appliance', arguments: { applianceId: id } });
    const m = (after.structuredContent as { maintenance: Array<{ taskType: string; nextDueAt: string; lastDoneAt: string | null }> }).maintenance.find(x => x.taskType === 'filter_change');
    expect(m).toMatchObject({ lastDoneAt: '2026-09-13', nextDueAt: '2026-12-12' });
    const logs = await h.deps.repo.listLogs(id, 5);
    expect(logs[0]?.notes).toBe('MERV 11');
  });
  it('rejects a task type the appliance does not have', async () => {
    const h = await modernClient();
    close = h.close;
    const id = await furnaceId(h.client);
    const r = await h.client.callTool({ name: 'log_maintenance', arguments: { applianceId: id, taskType: 'flush' } });
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe("The furnace doesn't have a flush task.");
  });
});
```

Update the order assertion in `apps/mcp-server/test/tools.test.ts`:
```ts
expect(tools.map(t => t.name)).toEqual(['list_appliances', 'get_appliance', 'maintenance_due', 'log_maintenance']);
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @homeledger/mcp-server test`
Expected: FAIL on `maintenance_due` not found and on the tool-order assertion.

- [ ] **Step 3: Implement maintenance tools**

`apps/mcp-server/src/tools/maintenance.ts`:
```ts
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { TaskType, computeNextDue, isOverdue, newId } from '@homeledger/core';
import type { ServerDeps } from '../server.js';
import { speakDate, speakList } from '../voice.js';

const taskWords = (t: string) => t.replace('_', ' ');

export function registerMaintenanceTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'maintenance_due',
    {
      title: 'Maintenance due',
      description: 'Maintenance tasks that are overdue or due within a horizon (default 30 days), overdue first.',
      inputSchema: z.object({ horizonDays: z.number().int().min(1).max(365).optional() }),
      outputSchema: z.object({
        items: z.array(z.object({ applianceId: z.string(), applianceName: z.string(), taskType: TaskType, nextDueAt: z.string(), overdue: z.boolean() }))
      }),
      annotations: { readOnlyHint: true }
    },
    async ({ horizonDays }) => {
      const today = deps.now().slice(0, 10);
      const rows = await deps.repo.listMaintenanceDue(horizonDays ?? 30, today);
      const names = new Map((await deps.repo.listAppliances()).map(a => [a.id, a.name] as const));
      const items = rows.map(m => ({ applianceId: m.applianceId, applianceName: names.get(m.applianceId) ?? 'Unknown appliance', taskType: m.taskType, nextDueAt: m.nextDueAt, overdue: isOverdue(m.nextDueAt, today) }));
      const spoken = speakList(items.map(i => `${i.applianceName} ${taskWords(i.taskType)}${i.overdue ? ', overdue since ' : ', due '}${speakDate(i.nextDueAt)}`), 'task');
      return { content: [{ type: 'text', text: spoken }], structuredContent: { items } };
    }
  );

  server.registerTool(
    'log_maintenance',
    {
      title: 'Log maintenance',
      description: 'Record that a maintenance task was completed today or on a given date. Advances the next due date.',
      inputSchema: z.object({ applianceId: z.string(), taskType: TaskType, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), notes: z.string().max(500).optional() }),
      outputSchema: z.object({ logged: z.boolean(), nextDueAt: z.string() }),
      annotations: { idempotentHint: false }
    },
    async ({ applianceId, taskType, date, notes }) => {
      const a = await deps.repo.getAppliance(applianceId);
      if (!a) return { content: [{ type: 'text', text: "I couldn't find that appliance." }], isError: true };
      const template = a.templates.find(t => t.taskType === taskType);
      if (!template) return { content: [{ type: 'text', text: `The ${a.name.toLowerCase()} doesn't have a ${taskWords(taskType)} task.` }], isError: true };
      const doneAt = date ?? deps.now().slice(0, 10);
      const nextDueAt = computeNextDue(doneAt, template.intervalDays);
      await deps.repo.appendLog({ id: newId('log'), applianceId, taskType, doneAt, notes: notes ?? null, createdAt: deps.now() });
      await deps.repo.putMaintenance({ applianceId, taskType, intervalDays: template.intervalDays, lastDoneAt: doneAt, nextDueAt, notes: notes ?? null });
      return {
        content: [{ type: 'text', text: `Logged the ${a.name.toLowerCase()} ${taskWords(taskType)} for ${speakDate(doneAt)}. Next one is due ${speakDate(nextDueAt)}.` }],
        structuredContent: { logged: true, nextDueAt }
      };
    }
  );
}
```

Update `apps/mcp-server/src/server.ts` to register in order:
```ts
import { registerApplianceTools } from './tools/appliances.js';
import { registerMaintenanceTools } from './tools/maintenance.js';
// inside buildServer, after registerApplianceTools(server, deps):
registerMaintenanceTools(server, deps);
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @homeledger/mcp-server test && pnpm --filter @homeledger/mcp-server typecheck`
Expected: PASS (11 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp-server
git commit -m "feat(mcp-server): maintenance_due and log_maintenance tools"
```

---

### Task 7: recent_events tool, resources, and the seasonal prompt

**Files:**
- Create: `apps/mcp-server/src/tools/events.ts`, `apps/mcp-server/src/resources.ts`, `apps/mcp-server/src/prompts.ts`
- Modify: `apps/mcp-server/src/server.ts`
- Test: `apps/mcp-server/test/events.test.ts`, `apps/mcp-server/test/resources.test.ts`, `apps/mcp-server/test/tools.test.ts` (order)

**Interfaces:**
- Consumes: `ServerDeps`, `Repository.listVisitsSince`, `listEvents`, `listAlerts`, `listAppliances`.
- Produces: `registerEventTools(server, deps)` with tool `recent_events` (`{ sinceHours?: number }` → `{ events: Array<{ kind: 'visit'|'door'|'alert', at, deviceName, summary, visitId: string|null }> }`); `registerResources(server, deps)` exposing `homeledger://household`, `homeledger://appliances`, `homeledger://maintenance/schedule` (JSON, `application/json`); `registerPrompts(server, deps)` exposing `seasonal-checklist` with argument `season` (enum spring, summer, fall, winter).

- [ ] **Step 1: Write the failing tests**

`apps/mcp-server/test/events.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { hasJson } from '../src/voice.js';
import { modernClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => { await close(); });

describe('recent_events', () => {
  it('merges visits, door events, and alerts newest first within the window', async () => {
    const h = await modernClient();
    close = h.close;
    const applianceId = (await h.deps.repo.listAppliances({ category: 'water_heater' }))[0]!.id;
    await h.deps.repo.putVisit({ id: 'visit_aaaaaaaaaaaaaaaa', providerId: 'p1', providerName: 'Reliable Plumbing', category: 'plumbing', applianceId, issue: 'leak', windowStart: '2026-09-13T13:00:00.000Z', windowEnd: '2026-09-13T15:00:00.000Z', status: 'scheduled', ringEventIds: [], snapshotKey: null, description: null, arrivedAt: null, createdAt: '2026-09-12T10:00:00.000Z' });
    await h.deps.repo.putEvent({ id: 'evt_aaaaaaaaaaaaaaaa', ringEventId: 'r1', type: 'button_press', subType: null, deviceId: 'd1', deviceName: 'Front Door', at: '2026-09-13T09:30:00.000Z', rawS3Key: null });
    await h.deps.repo.putAlert({ id: 'alert_aaaaaaaaaaaaaaaa', sensorType: 'freeze', deviceName: 'Garage sensor', at: '2026-09-13T03:00:00.000Z', maintenanceRef: null, status: 'open' });
    await h.deps.repo.putEvent({ id: 'evt_bbbbbbbbbbbbbbbb', ringEventId: 'r0', type: 'motion_detected', subType: 'human', deviceId: 'd1', deviceName: 'Front Door', at: '2026-09-11T09:30:00.000Z', rawS3Key: null });
    const r = await h.client.callTool({ name: 'recent_events', arguments: { sinceHours: 24 } });
    const sc = r.structuredContent as { events: Array<{ kind: string; at: string; summary: string; visitId: string | null }> };
    expect(sc.events.map(e => e.kind)).toEqual(['visit', 'door', 'alert']);
    expect(sc.events[0]?.visitId).toBe('visit_aaaaaaaaaaaaaaaa');
    const text = (r.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(hasJson(text)).toBe(false);
    expect(text).toContain('Reliable Plumbing');
  });
  it('speaks a quiet day', async () => {
    const h = await modernClient();
    close = h.close;
    const r = await h.client.callTool({ name: 'recent_events', arguments: {} });
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe('Nothing happened in the last 24 hours.');
  });
});
```

`apps/mcp-server/test/resources.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { modernClient } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => { await close(); });

describe('resources', () => {
  it('lists the three household resources and reads them as JSON', async () => {
    const h = await modernClient();
    close = h.close;
    const { resources } = await h.client.listResources();
    expect(resources.map(r => r.uri).sort()).toEqual(['homeledger://appliances', 'homeledger://household', 'homeledger://maintenance/schedule']);
    const hh = await h.client.readResource({ uri: 'homeledger://household' });
    const body = JSON.parse((hh.contents[0] as { text: string }).text) as { name: string };
    expect(body.name).toBe('The Harlow household');
    const sched = await h.client.readResource({ uri: 'homeledger://maintenance/schedule' });
    const items = JSON.parse((sched.contents[0] as { text: string }).text) as Array<{ applianceName: string; nextDueAt: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.nextDueAt <= items[items.length - 1]!.nextDueAt).toBe(true);
  });
});

describe('prompts', () => {
  it('builds a seasonal checklist from the seeded appliances', async () => {
    const h = await modernClient();
    close = h.close;
    const { prompts } = await h.client.listPrompts();
    expect(prompts.map(p => p.name)).toEqual(['seasonal-checklist']);
    const p = await h.client.getPrompt({ name: 'seasonal-checklist', arguments: { season: 'fall' } });
    const text = (p.messages[0]!.content as { text: string }).text;
    expect(text).toContain('fall');
    expect(text).toContain('Furnace');
  });
});
```

Update the order assertion in `apps/mcp-server/test/tools.test.ts`:
```ts
expect(tools.map(t => t.name)).toEqual(['list_appliances', 'get_appliance', 'maintenance_due', 'log_maintenance', 'recent_events']);
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @homeledger/mcp-server test`
Expected: FAIL on `recent_events`, resources, prompts, and order.

- [ ] **Step 3: Implement events tool**

`apps/mcp-server/src/tools/events.ts`:
```ts
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServerDeps } from '../server.js';
import { speakList } from '../voice.js';

const EventRow = z.object({
  kind: z.enum(['visit', 'door', 'alert']),
  at: z.string(),
  deviceName: z.string().nullable(),
  summary: z.string(),
  visitId: z.string().nullable()
});

export function registerEventTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'recent_events',
    {
      title: 'Recent events',
      description: 'Service visits, front-door events, and sensor alerts from the last N hours (default 24), newest first.',
      inputSchema: z.object({ sinceHours: z.number().int().min(1).max(720).optional() }),
      outputSchema: z.object({ events: z.array(EventRow) }),
      annotations: { readOnlyHint: true }
    },
    async ({ sinceHours }) => {
      const hours = sinceHours ?? 24;
      const since = new Date(new Date(deps.now()).getTime() - hours * 3_600_000).toISOString();
      const [visits, doors, alerts] = await Promise.all([deps.repo.listVisitsSince(since), deps.repo.listEvents(since), deps.repo.listAlerts(since)]);
      const events: z.infer<typeof EventRow>[] = [
        ...visits.map(v => ({ kind: 'visit' as const, at: v.windowStart, deviceName: null, summary: `${v.providerName} ${v.status === 'scheduled' ? 'is scheduled' : v.status} for the ${v.issue}`, visitId: v.id })),
        ...doors.map(e => ({ kind: 'door' as const, at: e.at, deviceName: e.deviceName, summary: e.type === 'button_press' ? `Someone rang the ${e.deviceName}` : `${e.subType === 'human' ? 'A person' : e.subType === 'vehicle' ? 'A vehicle' : 'Motion'} at the ${e.deviceName}`, visitId: null })),
        ...alerts.map(a => ({ kind: 'alert' as const, at: a.at, deviceName: a.deviceName, summary: `${a.sensorType} alert from the ${a.deviceName}`, visitId: null }))
      ].sort((x, y) => y.at.localeCompare(x.at));
      const text = events.length === 0 ? `Nothing happened in the last ${hours} hours.` : speakList(events.map(e => e.summary), 'event');
      return { content: [{ type: 'text', text }], structuredContent: { events } };
    }
  );
}
```

- [ ] **Step 4: Implement resources and prompts**

`apps/mcp-server/src/resources.ts`:
```ts
import type { McpServer } from '@modelcontextprotocol/server';
import { isOverdue } from '@homeledger/core';
import type { ServerDeps } from './server.js';

const json = (uri: string, value: unknown) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] });

export function registerResources(server: McpServer, deps: ServerDeps): void {
  server.registerResource('household', 'homeledger://household', { title: 'Household', description: 'Household name and timezone', mimeType: 'application/json' }, async uri =>
    json(uri.href, (await deps.repo.getHousehold()) ?? {})
  );
  server.registerResource('appliances', 'homeledger://appliances', { title: 'Appliances', description: 'Every appliance with warranty dates and maintenance templates', mimeType: 'application/json' }, async uri =>
    json(uri.href, await deps.repo.listAppliances())
  );
  server.registerResource('maintenance-schedule', 'homeledger://maintenance/schedule', { title: 'Maintenance schedule', description: 'All maintenance items ordered by next due date', mimeType: 'application/json' }, async uri => {
    const today = deps.now().slice(0, 10);
    const names = new Map((await deps.repo.listAppliances()).map(a => [a.id, a.name] as const));
    const items = (await deps.repo.listMaintenanceDue(3650, today)).map(m => ({ ...m, applianceName: names.get(m.applianceId) ?? 'Unknown', overdue: isOverdue(m.nextDueAt, today) }));
    return json(uri.href, items);
  });
}
```

`apps/mcp-server/src/prompts.ts`:
```ts
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ServerDeps } from './server.js';

const SEASON_TASKS: Record<string, string[]> = {
  spring: ['test the sump pump', 'clean refrigerator coils', 'inspect the water heater for corrosion'],
  summer: ['replace the furnace filter before AC season', 'clean the dishwasher filter'],
  fall: ['schedule the furnace inspection', 'flush the water heater', 'replace the furnace filter'],
  winter: ['check the furnace filter monthly', 'test the sump pump before the thaw']
};

export function registerPrompts(server: McpServer, deps: ServerDeps): void {
  server.registerPrompt(
    'seasonal-checklist',
    {
      title: 'Seasonal checklist',
      description: 'A seasonal home-maintenance checklist built from this household’s appliances.',
      argsSchema: z.object({ season: z.enum(['spring', 'summer', 'fall', 'winter']) })
    },
    async ({ season }) => {
      const appliances = await deps.repo.listAppliances();
      const lines = [
        `Build a ${season} maintenance checklist for this household.`,
        `Appliances: ${appliances.map(a => `${a.name} (${a.brand} ${a.model})`).join('; ')}.`,
        `Typical ${season} tasks: ${SEASON_TASKS[season]!.join('; ')}.`,
        'Return a short numbered list. Skip tasks for appliances the household does not have.'
      ];
      return { messages: [{ role: 'user', content: { type: 'text', text: lines.join('\n') } }] };
    }
  );
}
```

If `registerPrompt`'s `argsSchema` type rejects a `z.object`, pass the raw shape `{ season: z.enum([...]) }` instead and log the doc mismatch in `FRICTION-LOG.md`.

Update `apps/mcp-server/src/server.ts`:
```ts
import { registerApplianceTools } from './tools/appliances.js';
import { registerMaintenanceTools } from './tools/maintenance.js';
import { registerEventTools } from './tools/events.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
// inside buildServer, in this order:
registerApplianceTools(server, deps);
registerMaintenanceTools(server, deps);
registerEventTools(server, deps);
registerResources(server, deps);
registerPrompts(server, deps);
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @homeledger/mcp-server test && pnpm --filter @homeledger/mcp-server typecheck`
Expected: PASS (15 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/mcp-server
git commit -m "feat(mcp-server): recent_events tool, household resources, seasonal prompt"
```

---

### Task 8: HTTP entrypoint with modern and legacy branches

**Files:**
- Create: `apps/mcp-server/src/app.ts`, `apps/mcp-server/src/legacy.ts`, `apps/mcp-server/src/deps.ts`, `apps/mcp-server/src/index.ts`
- Test: `apps/mcp-server/test/legacy.test.ts`, `apps/mcp-server/test/http.test.ts`, `apps/mcp-server/test/legacy-detect.test.ts`

**Interfaces:**
- Consumes: `buildServer`, `ServerDeps`, `createMemoryRepository`, `createDynamoRepository`, `seedRepository`.
- Produces:
  ```ts
  // src/legacy.ts
  export function isLegacyBody(body: unknown, headers: Record<string, string | string[] | undefined>): boolean;
  export function isInitializeBody(body: unknown): boolean;
  export function createLegacyRouter(build: () => McpServer): { route: express.RequestHandler; sessionCount: () => number; closeAll: () => Promise<void> };
  // src/app.ts
  export function createApp(deps: ServerDeps, opts?: { allowedHosts?: string[] }): { app: express.Express; close: () => Promise<void> };
  // src/deps.ts
  export async function depsFromEnv(env: NodeJS.ProcessEnv): Promise<ServerDeps>;
  ```
  Env contract: `PORT` (default 8000), `HOUSEHOLD_ID` (required), `TABLE_NAME` (DynamoDB when set), `DYNAMO_ENDPOINT` (optional, local), `MEMORY_REPO=1` (seeded in-memory store), `HOMELEDGER_DEV_TOOLS=1`, `ALLOWED_HOSTS` (comma-separated; default `localhost,127.0.0.1,0.0.0.0`).

- [ ] **Step 1: Write the failing legacy-detection test**

`apps/mcp-server/test/legacy-detect.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isInitializeBody, isLegacyBody } from '../src/legacy.js';

const modernCall = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } };
const legacyInit = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Alexa+ MCP Client', version: '1.0.0' } } };
const legacyCall = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_appliances', arguments: {} } };

describe('legacy detection', () => {
  it('treats initialize as legacy', () => {
    expect(isInitializeBody(legacyInit)).toBe(true);
    expect(isLegacyBody(legacyInit, {})).toBe(true);
  });
  it('treats a session header as legacy', () => {
    expect(isLegacyBody(modernCall, { 'mcp-session-id': 'abc' })).toBe(true);
  });
  it('treats a request without the protocol-version meta as legacy', () => {
    expect(isLegacyBody(legacyCall, {})).toBe(true);
  });
  it('treats a request carrying the protocol-version meta as modern', () => {
    expect(isLegacyBody(modernCall, {})).toBe(false);
  });
  it('treats a batch as legacy if any element is legacy', () => {
    expect(isLegacyBody([modernCall, legacyCall], {})).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @homeledger/mcp-server test -- legacy-detect`
Expected: FAIL, cannot find module `../src/legacy.js`.

- [ ] **Step 3: Implement legacy detection and the sessionful router**

`apps/mcp-server/src/legacy.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { McpServer } from '@modelcontextprotocol/server';

const PROTOCOL_META = 'io.modelcontextprotocol/protocolVersion';

type Rpc = { method?: unknown; params?: { _meta?: Record<string, unknown> } };

export function isInitializeBody(body: unknown): boolean {
  const list = Array.isArray(body) ? body : [body];
  return list.some(m => (m as Rpc)?.method === 'initialize');
}

export function isLegacyBody(body: unknown, headers: Record<string, string | string[] | undefined>): boolean {
  if (headers['mcp-session-id']) return true;
  const list = Array.isArray(body) ? body : [body];
  return list.some(m => {
    const rpc = m as Rpc;
    if (rpc?.method === 'initialize') return true;
    if (typeof rpc?.method !== 'string') return false;
    return !(rpc.params?._meta && PROTOCOL_META in rpc.params._meta);
  });
}

export function createLegacyRouter(build: () => McpServer) {
  const sessions = new Map<string, NodeStreamableHTTPServerTransport>();

  const route: RequestHandler = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }
    if (!sessionId && req.method === 'POST' && isInitializeBody(req.body)) {
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => {
          sessions.set(id, transport);
        }
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await build().connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    if (sessionId) {
      res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
      return;
    }
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Session ID required' }, id: null });
  };

  return {
    route,
    sessionCount: () => sessions.size,
    closeAll: async () => {
      await Promise.all([...sessions.values()].map(t => t.close()));
      sessions.clear();
    }
  };
}
```

The SDK ships `isLegacyRequest` and `isInitializeRequest` for the same purpose, but they take a web-standard `Request` and the Express body has already been parsed. The predicate above is the documented rule (legacy clients send `initialize` and never carry the per-request protocol-version meta) applied to the parsed body. If a later SDK release exposes a body-level predicate, swap it in and delete `isLegacyBody`.

- [ ] **Step 4: Run the detection test**

Run: `pnpm --filter @homeledger/mcp-server test -- legacy-detect`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing HTTP tests (legacy v1 client and modern v2 client over a real socket)**

`apps/mcp-server/test/http.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../src/app.js';
import { seededDeps } from './harness.js';

let server: Server | undefined;
let closeApp: () => Promise<void> = async () => {};
afterEach(async () => {
  await closeApp();
  await new Promise<void>(r => (server ? server.close(() => r()) : r()));
});

export async function listen() {
  const deps = await seededDeps();
  const { app, close } = createApp(deps);
  closeApp = close;
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server!.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, deps };
}

describe('modern client over HTTP', () => {
  it('lists and calls tools statelessly', async () => {
    const { url } = await listen();
    const client = new Client({ name: 'modern', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    expect(client.getDiscoverResult()).toBeDefined();
    const { tools } = await client.listTools();
    expect(tools[0]?.name).toBe('list_appliances');
    const r = await client.callTool({ name: 'maintenance_due', arguments: {} });
    expect((r.structuredContent as { items: unknown[] }).items.length).toBeGreaterThan(0);
    await client.close();
  });
  it('answers /healthz', async () => {
    const { url } = await listen();
    const res = await fetch(url.replace('/mcp', '/healthz'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: 'homeledger' });
  });
});
```

`apps/mcp-server/test/legacy.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
  const port = (server.address() as { port: number }).port;
  return `http://127.0.0.1:${port}/mcp`;
}

describe('legacy (2025-era) client', () => {
  it('initializes, receives a session id, and calls tools on that session', async () => {
    const url = await listen();
    const client = new Client({ name: 'Alexa+ MCP Client', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    expect(transport.sessionId).toBeDefined();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(['list_appliances', 'get_appliance', 'maintenance_due', 'log_maintenance', 'recent_events']);
    const r = await client.callTool({ name: 'list_appliances', arguments: { room: 'Basement' } });
    expect((r.structuredContent as { appliances: unknown[] }).appliances.length).toBe(3);
    await transport.terminateSession();
    await client.close();
  });
  it('gives two clients two sessions', async () => {
    const url = await listen();
    const a = new StreamableHTTPClientTransport(new URL(url));
    const b = new StreamableHTTPClientTransport(new URL(url));
    const ca = new Client({ name: 'a', version: '1' });
    const cb = new Client({ name: 'b', version: '1' });
    await ca.connect(a);
    await cb.connect(b);
    expect(a.sessionId).not.toBe(b.sessionId);
    await ca.close();
    await cb.close();
  });
  it('returns 404 for an unknown session id', async () => {
    const url = await listen();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `pnpm --filter @homeledger/mcp-server test -- http legacy`
Expected: FAIL, cannot find module `../src/app.js`.

- [ ] **Step 7: Implement the app, deps, and entrypoint**

`apps/mcp-server/src/app.ts`:
```ts
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { RequestHandler } from 'express';
import { createLegacyRouter, isLegacyBody } from './legacy.js';
import { buildServer, SERVER_INFO, type ServerDeps } from './server.js';

export function createApp(deps: ServerDeps, opts: { allowedHosts?: string[] } = {}) {
  const build = () => buildServer(deps);
  const modern = createMcpHandler(build, { legacy: 'reject' });
  const modernNode = toNodeHandler(modern);
  const legacy = createLegacyRouter(build);

  const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: opts.allowedHosts ?? ['localhost', '127.0.0.1', '0.0.0.0'], jsonLimit: '1mb' });

  const route: RequestHandler = async (req, res, next) => {
    try {
      if (req.method !== 'POST' || isLegacyBody(req.body, req.headers)) {
        await legacy.route(req, res, next);
        return;
      }
      await modernNode(req, res, req.body);
    } catch (err) {
      next(err);
    }
  };

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, name: SERVER_INFO.name });
  });
  app.all('/mcp', route);

  return {
    app,
    close: async () => {
      await legacy.closeAll();
      await modern.close();
    }
  };
}
```

Why `legacy: 'reject'` on the modern handler: legacy detection already routes every 2025-era request to the sessionful branch, so anything reaching the modern handler that still looks legacy is a bug, and a loud 400 is better than a silent stateless fallback. `GET` and `DELETE` always go to the legacy branch because only sessionful transports use them.

`apps/mcp-server/src/deps.ts`:
```ts
import { createDynamoRepository, createMemoryRepository, seedRepository } from '@homeledger/core';
import type { ServerDeps } from './server.js';

export async function depsFromEnv(env: NodeJS.ProcessEnv): Promise<ServerDeps> {
  const householdId = env.HOUSEHOLD_ID;
  if (!householdId) throw new Error('HOUSEHOLD_ID is required');
  const devTools = env.HOMELEDGER_DEV_TOOLS === '1';
  const now = () => new Date().toISOString();
  if (env.MEMORY_REPO === '1') {
    const repo = createMemoryRepository(householdId);
    await seedRepository(repo, householdId, now().slice(0, 10));
    return { repo, now, devTools };
  }
  const tableName = env.TABLE_NAME;
  if (!tableName) throw new Error('TABLE_NAME is required unless MEMORY_REPO=1');
  const repo = createDynamoRepository({ tableName, householdId, endpoint: env.DYNAMO_ENDPOINT, region: env.AWS_REGION });
  return { repo, now, devTools };
}
```

`apps/mcp-server/src/index.ts`:
```ts
import { createApp } from './app.js';
import { depsFromEnv } from './deps.js';

const port = Number(process.env.PORT ?? 8000);
const allowedHosts = (process.env.ALLOWED_HOSTS ?? 'localhost,127.0.0.1,0.0.0.0').split(',').map(s => s.trim()).filter(Boolean);

const deps = await depsFromEnv(process.env);
const { app, close } = createApp(deps, { allowedHosts });
const server = app.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ msg: 'listening', port, path: '/mcp', devTools: deps.devTools }));
});

const shutdown = async (signal: string) => {
  console.log(JSON.stringify({ msg: 'shutdown', signal }));
  await close();
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
```

- [ ] **Step 8: Run all server tests**

Run: `pnpm --filter @homeledger/mcp-server test && pnpm --filter @homeledger/mcp-server typecheck`
Expected: PASS (23 tests); typecheck clean. Known places this can bite, each a friction-log entry if hit: `createMcpExpressApp` rejecting the `jsonLimit` option name; `toNodeHandler` signature not accepting a pre-parsed body; the v1 client's `terminateSession` returning 405 if `DELETE` is not routed to the legacy branch.

- [ ] **Step 9: Run it for real against DynamoDB Local**

```bash
docker compose up -d
cd apps/mcp-server
DYNAMO_ENDPOINT=http://127.0.0.1:8000 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_REGION=us-east-1 \
  node --import tsx -e "import('@homeledger/core').then(async c => { await c.ensureTable({ tableName: 'homeledger', endpoint: 'http://127.0.0.1:8000' }); const r = c.createDynamoRepository({ tableName: 'homeledger', householdId: 'hh_harlow', endpoint: 'http://127.0.0.1:8000' }); console.log(await c.seedRepository(r, 'hh_harlow', new Date().toISOString().slice(0,10))); })"
PORT=8010 HOUSEHOLD_ID=hh_harlow TABLE_NAME=homeledger DYNAMO_ENDPOINT=http://127.0.0.1:8000 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_REGION=us-east-1 HOMELEDGER_DEV_TOOLS=1 pnpm dev
```

In a second terminal: `npx @modelcontextprotocol/inspector`, connect Streamable HTTP to `http://127.0.0.1:8010/mcp`, call `maintenance_due`.
Expected: the seeded overdue furnace filter appears. Add the seed one-liner as `pnpm --filter @homeledger/core seed:local` script (`packages/core/package.json`) so nobody types it twice:
```json
"seed:local": "DYNAMO_ENDPOINT=http://127.0.0.1:8000 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_REGION=us-east-1 tsx scripts/seed-local.ts"
```
with `packages/core/scripts/seed-local.ts`:
```ts
import { createDynamoRepository, ensureTable, seedRepository } from '../src/index.js';
const endpoint = process.env.DYNAMO_ENDPOINT!;
const tableName = process.env.TABLE_NAME ?? 'homeledger';
const householdId = process.env.HOUSEHOLD_ID ?? 'hh_harlow';
try { await ensureTable({ tableName, endpoint }); } catch (e) { if ((e as { name?: string }).name !== 'ResourceInUseException') throw e; }
const repo = createDynamoRepository({ tableName, householdId, endpoint });
console.log(await seedRepository(repo, householdId, new Date().toISOString().slice(0, 10)));
```
Add `tsx` to `packages/core` devDependencies.

- [ ] **Step 10: Commit**

```bash
git add apps/mcp-server packages/core
git commit -m "feat(mcp-server): HTTP entrypoint with modern stateless and legacy sessionful branches"
```

---

### Task 9: Elicitation spike on both client generations (the architecture A gate)

**Files:**
- Create: `apps/mcp-server/src/tools/dev.ts`
- Modify: `apps/mcp-server/src/server.ts`
- Test: `apps/mcp-server/test/elicit-modern.test.ts`, `apps/mcp-server/test/elicit-legacy.test.ts`
- Modify: `FRICTION-LOG.md` (spike outcome, whichever way it goes)

**Interfaces:**
- Consumes: `ServerDeps.devTools`, `createApp`, `seededDeps`.
- Produces: `registerDevTools(server, deps)` with tool `echo_confirm` (`{ message: string }` → `{ confirmed: boolean; message: string }`), registered only when `deps.devTools` is true, always last in the tool list. This is the pattern `book_service` reuses in Plan 2: read answers first, ask only for what is missing.

- [ ] **Step 1: Write the failing modern-client test**

`apps/mcp-server/test/elicit-modern.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { buildServer } from '../src/server.js';
import { seededDeps } from './harness.js';

let close: () => Promise<void> = async () => {};
afterEach(async () => { await close(); });

async function connect(answer: { action: 'accept'; content: { confirm: boolean } } | { action: 'decline' }) {
  const deps = await seededDeps();
  const handler = createMcpHandler(() => buildServer(deps));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) });
  const client = new Client({ name: 'modern', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } }, inputRequired: { maxRounds: 3 }, versionNegotiation: { mode: 'auto' } });
  const seen: string[] = [];
  client.setRequestHandler('elicitation/create', async request => {
    seen.push(request.params.message);
    return answer;
  });
  await client.connect(transport);
  close = async () => { await client.close(); await handler.close(); };
  return { client, seen };
}

describe('echo_confirm over multi round-trip requests (2026-07-28)', () => {
  it('asks once, then completes with the accepted answer', async () => {
    const { client, seen } = await connect({ action: 'accept', content: { confirm: true } });
    const r = await client.callTool({ name: 'echo_confirm', arguments: { message: 'book the plumber' } });
    expect(seen).toEqual(['Confirm: book the plumber?']);
    expect(r.structuredContent).toEqual({ confirmed: true, message: 'book the plumber' });
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe('Confirmed: book the plumber');
  });
  it('treats a decline as cancelled without asking again', async () => {
    const { client, seen } = await connect({ action: 'decline' });
    const r = await client.callTool({ name: 'echo_confirm', arguments: { message: 'book the plumber' } });
    expect(seen.length).toBe(1);
    expect(r.structuredContent).toEqual({ confirmed: false, message: 'book the plumber' });
  });
  it('is absent when dev tools are off', async () => {
    const deps = { ...(await seededDeps()), devTools: false };
    const handler = createMcpHandler(() => buildServer(deps));
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) });
    const client = new Client({ name: 'modern', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);
    close = async () => { await client.close(); await handler.close(); };
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).not.toContain('echo_confirm');
  });
});
```

- [ ] **Step 2: Write the failing legacy-client test**

`apps/mcp-server/test/elicit-legacy.test.ts`:
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
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
}

describe('echo_confirm over a 2025-era session (legacy shim)', () => {
  it('receives a server-initiated elicitation and completes with the answer', async () => {
    const url = await listen();
    const client = new Client({ name: 'legacy', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    const seen: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async request => {
      seen.push(request.params.message);
      return { action: 'accept', content: { confirm: true } };
    });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    const r = await client.callTool({ name: 'echo_confirm', arguments: { message: 'book the plumber' } });
    expect(seen).toEqual(['Confirm: book the plumber?']);
    expect(r.structuredContent).toEqual({ confirmed: true, message: 'book the plumber' });
    await transport.terminateSession();
    await client.close();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @homeledger/mcp-server test -- elicit`
Expected: FAIL, tool `echo_confirm` not found.

- [ ] **Step 4: Implement the dev tool**

`apps/mcp-server/src/tools/dev.ts`:
```ts
import { acceptedContent, inputRequired, type McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
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
      const responses = ctx.mcpReq.inputResponses as Record<string, { action?: string }> | undefined;
      if (responses?.confirm?.action === 'decline' || responses?.confirm?.action === 'cancel') {
        return { content: [{ type: 'text', text: `Cancelled: ${message}` }], structuredContent: { confirmed: false, message } };
      }
      const answer = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', ConfirmSchema);
      if (!answer) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({ message: `Confirm: ${message}?`, requestedSchema: ConfirmSchema })
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

Register it last in `apps/mcp-server/src/server.ts`:
```ts
import { registerDevTools } from './tools/dev.js';
// after registerPrompts(server, deps):
registerDevTools(server, deps);
```

If `inputRequired.elicit` rejects a Zod `requestedSchema`, pass the equivalent JSON Schema object `{ type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }` and keep `ConfirmSchema` for `acceptedContent`. If the exact names of the `ctx.mcpReq` fields differ from `inputResponses`, read the v2 `RequestContext` type in `@modelcontextprotocol/server` and use its names; log the doc mismatch.

- [ ] **Step 5: Update the tool-order assertions now that a dev tool exists**

The harness and the legacy test both run with `devTools: true`, so `echo_confirm` now appears last. Change the order assertion in `apps/mcp-server/test/tools.test.ts` and in `apps/mcp-server/test/legacy.test.ts` to:
```ts
['list_appliances', 'get_appliance', 'maintenance_due', 'log_maintenance', 'recent_events', 'echo_confirm']
```

- [ ] **Step 6: Run the spike**

Run: `pnpm --filter @homeledger/mcp-server test`
Expected: PASS (27 tests). The legacy elicitation test is the architecture A gate.

- [ ] **Step 7: Record the outcome**

Append to `FRICTION-LOG.md` under "Build phase" as `FL-017`, whichever way it went:
- If both pass: state that the v2 legacy shim delivered `elicitation/create` over a `NodeStreamableHTTPServerTransport` session to a v1.x client, name the SDK versions from `pnpm ls @modelcontextprotocol/server @modelcontextprotocol/sdk`, and note anything that had to change from the documented code.
- If the legacy test fails and cannot be made to pass within two hours: state the failing behavior verbatim, mark architecture A as fallen back to C for the legacy branch, and open a Plan 1 addendum task that swaps `apps/mcp-server/src/legacy.ts` to build its `McpServer` from `@modelcontextprotocol/sdk` 1.x (`McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`) with the same tool registrations copied into a v1-flavoured `server-v1.ts`. The modern branch stays on v2 either way.

- [ ] **Step 8: Commit**

```bash
git add apps/mcp-server FRICTION-LOG.md
git commit -m "feat(mcp-server): echo_confirm dev tool proves elicitation on modern and legacy clients"
```

---

### Task 10: ARM64 container and local run

**Files:**
- Create: `apps/mcp-server/Dockerfile`, `apps/mcp-server/.dockerignore`, `scripts/build-image.sh`
- Modify: `README.md`

**Interfaces:**
- Produces: image `homeledger-mcp` listening on `0.0.0.0:8000/mcp`; `scripts/build-image.sh <ecr-repo-url> [tag]` builds `linux/arm64` and pushes; prints the pushed image URI on its last line.

- [ ] **Step 1: Write the Dockerfile**

`apps/mcp-server/Dockerfile` (build context is the repo root):
```dockerfile
FROM --platform=linux/arm64 node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/mcp-server/package.json apps/mcp-server/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY apps/mcp-server apps/mcp-server
RUN pnpm --filter @homeledger/core build && pnpm --filter @homeledger/mcp-server build
RUN pnpm --filter @homeledger/mcp-server --prod deploy --legacy /out

FROM --platform=linux/arm64 node:22-bookworm-slim
ENV NODE_ENV=production PORT=8000
WORKDIR /app
COPY --from=build /out /app
USER node
EXPOSE 8000
CMD ["node", "dist/index.js"]
```

`apps/mcp-server/.dockerignore` (placed at the repo root as `.dockerignore` since the context is the root):
```
node_modules
**/node_modules
**/dist
.git
infra
docs
*.md
```

If `pnpm deploy --legacy` refuses because the lockfile was generated with `inject-workspace-packages` unset, add `inject-workspace-packages=true` to `.npmrc`, re-run `pnpm install`, drop `--legacy`, and log it.

- [ ] **Step 2: Build and run locally with the in-memory store**

```bash
docker build --platform linux/arm64 -f apps/mcp-server/Dockerfile -t homeledger-mcp:dev .
docker run --rm -p 8010:8000 -e HOUSEHOLD_ID=hh_harlow -e MEMORY_REPO=1 -e HOMELEDGER_DEV_TOOLS=1 homeledger-mcp:dev
```
In another terminal:
```bash
curl -s http://127.0.0.1:8010/healthz
curl -s -X POST http://127.0.0.1:8010/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' -i | grep -i mcp-session-id
```
Expected: `{"ok":true,"name":"homeledger"}` and an `Mcp-Session-Id` header on the initialize response. The second command is the exact handshake Alexa+'s docs show.

- [ ] **Step 3: Write the image build-and-push script**

`scripts/build-image.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
REPO_URL="${1:?usage: build-image.sh <ecr-repo-url> [tag]}"
TAG="${2:-$(git rev-parse --short HEAD)}"
REGION="${AWS_REGION:-us-east-1}"
REGISTRY="${REPO_URL%%/*}"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker buildx build --platform linux/arm64 -f apps/mcp-server/Dockerfile -t "$REPO_URL:$TAG" -t "$REPO_URL:latest" --push .
echo "$REPO_URL:$TAG"
```
Run: `chmod +x scripts/build-image.sh`

- [ ] **Step 4: Document local run in the README**

Append to `README.md`:
```markdown
## Run the MCP server locally

```bash
docker compose up -d                                  # DynamoDB Local on :8000
pnpm --filter @homeledger/core seed:local             # table + seed household
cd apps/mcp-server
PORT=8010 HOUSEHOLD_ID=hh_harlow TABLE_NAME=homeledger DYNAMO_ENDPOINT=http://127.0.0.1:8000 \
AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_REGION=us-east-1 HOMELEDGER_DEV_TOOLS=1 pnpm dev
npx @modelcontextprotocol/inspector                   # connect to http://127.0.0.1:8010/mcp
```

Container (what AgentCore runs):

```bash
docker build --platform linux/arm64 -f apps/mcp-server/Dockerfile -t homeledger-mcp:dev .
docker run --rm -p 8010:8000 -e HOUSEHOLD_ID=hh_harlow -e MEMORY_REPO=1 homeledger-mcp:dev
```
```

- [ ] **Step 5: Commit**

```bash
git add apps/mcp-server/Dockerfile .dockerignore scripts/build-image.sh README.md .npmrc
git commit -m "build: ARM64 container for the MCP server and ECR push script"
```

---

### Task 11: Terraform for ECR, execution role, Cognito, DynamoDB, and the AgentCore runtime

**Files:**
- Create: `infra/versions.tf`, `infra/backend.tf`, `infra/variables.tf`, `infra/main.tf`, `infra/outputs.tf`, `infra/demo.tfvars.example`, `infra/README.md`

**Interfaces:**
- Consumes: the image URI from `scripts/build-image.sh` (Task 10) as `var.image_uri`.
- Produces outputs: `ecr_repository_url`, `agent_runtime_arn`, `agent_runtime_invocation_url`, `cognito_token_url`, `cognito_client_id`, `cognito_client_secret` (sensitive), `cognito_discovery_url`, `table_name`.
- Table shape must equal `ensureTable` in Task 4: `PK`/`SK`, `GSI1` on `GSI1PK`/`GSI1SK`, `GSI2` on `GSI2PK`/`GSI2SK`, all projected.

- [ ] **Step 1: Create the state bucket once, by hand**

```bash
export AWS_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws s3api create-bucket --bucket "homeledger-tfstate-$ACCOUNT_ID" --region $AWS_REGION
aws s3api put-bucket-versioning --bucket "homeledger-tfstate-$ACCOUNT_ID" --versioning-configuration Status=Enabled
aws s3api put-public-access-block --bucket "homeledger-tfstate-$ACCOUNT_ID" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```
If the chosen region is `us-west-2`, add `--create-bucket-configuration LocationConstraint=us-west-2` to the first command. Terraform 1.10+ uses the S3 native lockfile (`use_lockfile = true`), so no DynamoDB lock table.

- [ ] **Step 2: Write versions, backend, variables**

`infra/versions.tf`:
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

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "homeledger", env = var.env }
  }
}
```

`infra/backend.tf` (bucket name is passed at init time so the account id never lives in the repo):
```hcl
terraform {
  backend "s3" {
    key          = "homeledger/demo/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}
```

`infra/variables.tf`:
```hcl
variable "region" {
  type    = string
  default = "us-east-1"
}

variable "env" {
  type    = string
  default = "demo"
}

variable "household_id" {
  type    = string
  default = "hh_harlow"
}

variable "image_uri" {
  type        = string
  description = "Full ECR image URI with tag, from scripts/build-image.sh. Empty on the first apply, which then creates only ECR."
  default     = ""
}

variable "idle_session_timeout_seconds" {
  type    = number
  default = 1800
}

variable "allowed_hosts" {
  type        = string
  description = "Comma-separated Host header allowlist passed to the server as ALLOWED_HOSTS."
  default     = "localhost,127.0.0.1,0.0.0.0"
}
```

`infra/demo.tfvars.example`:
```hcl
region       = "us-east-1"
household_id = "hh_harlow"
image_uri    = "123456789012.dkr.ecr.us-east-1.amazonaws.com/homeledger-mcp:abc1234"
```

- [ ] **Step 3: Write main.tf**

`infra/main.tf`:
```hcl
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  region       = data.aws_region.current.region
  runtime_name = "homeledger_mcp"
}

# ---------- ECR ----------
resource "aws_ecr_repository" "mcp" {
  name                 = "homeledger-mcp"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecr_lifecycle_policy" "mcp" {
  repository = aws_ecr_repository.mcp.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 20 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }
      action       = { type = "expire" }
    }]
  })
}

# ---------- DynamoDB ----------
resource "aws_dynamodb_table" "homeledger" {
  name         = "homeledger"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute { name = "PK"     type = "S" }
  attribute { name = "SK"     type = "S" }
  attribute { name = "GSI1PK" type = "S" }
  attribute { name = "GSI1SK" type = "S" }
  attribute { name = "GSI2PK" type = "S" }
  attribute { name = "GSI2SK" type = "S" }

  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }
  global_secondary_index {
    name            = "GSI2"
    hash_key        = "GSI2PK"
    range_key       = "GSI2SK"
    projection_type = "ALL"
  }

  point_in_time_recovery { enabled = true }
}

# ---------- Cognito (JWT issuer for the AgentCore authorizer) ----------
resource "aws_cognito_user_pool" "mcp" {
  name = "homeledger-mcp"
}

resource "aws_cognito_user_pool_domain" "mcp" {
  domain       = "homeledger-${local.account_id}"
  user_pool_id = aws_cognito_user_pool.mcp.id
}

resource "aws_cognito_resource_server" "mcp" {
  identifier   = "homeledger"
  name         = "HomeLedger MCP"
  user_pool_id = aws_cognito_user_pool.mcp.id
  scope {
    scope_name        = "mcp"
    scope_description = "Call the HomeLedger MCP server"
  }
}

resource "aws_cognito_user_pool_client" "simulator" {
  name                                 = "homeledger-simulator"
  user_pool_id                         = aws_cognito_user_pool.mcp.id
  generate_secret                      = true
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["client_credentials"]
  allowed_oauth_scopes                 = ["homeledger/mcp"]
  supported_identity_providers         = ["COGNITO"]
  access_token_validity                = 60
  token_validity_units { access_token = "minutes" }
  depends_on = [aws_cognito_resource_server.mcp]
}

# ---------- Execution role (from the AgentCore Runtime permissions doc) ----------
data "aws_iam_policy_document" "runtime_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:bedrock-agentcore:${local.region}:${local.account_id}:*"]
    }
  }
}

data "aws_iam_policy_document" "runtime" {
  statement {
    sid       = "ECRImageAccess"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [aws_ecr_repository.mcp.arn]
  }
  statement {
    sid       = "ECRTokenAccess"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["logs:DescribeLogStreams", "logs:CreateLogGroup"]
    resources = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*"]
  }
  statement {
    actions   = ["logs:PutResourcePolicy"]
    resources = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/${local.runtime_name}-*"]
  }
  statement {
    actions   = ["logs:DescribeLogGroups"]
    resources = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:*"]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*"]
  }
  statement {
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"]
    resources = ["*"]
  }
  statement {
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["bedrock-agentcore"]
    }
  }
  statement {
    sid     = "GetAgentAccessToken"
    actions = ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT"]
    resources = [
      "arn:aws:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/default",
      "arn:aws:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/default/workload-identity/${local.runtime_name}-*"
    ]
  }
  statement {
    sid       = "HomeLedgerTable"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem", "dynamodb:BatchWriteItem"]
    resources = [aws_dynamodb_table.homeledger.arn, "${aws_dynamodb_table.homeledger.arn}/index/*"]
  }
}

resource "aws_iam_role" "runtime" {
  name               = "homeledger-agentcore-runtime"
  assume_role_policy = data.aws_iam_policy_document.runtime_trust.json
}

resource "aws_iam_role_policy" "runtime" {
  role   = aws_iam_role.runtime.id
  policy = data.aws_iam_policy_document.runtime.json
}

# ---------- AgentCore Runtime ----------
resource "aws_bedrockagentcore_agent_runtime" "mcp" {
  count              = var.image_uri == "" ? 0 : 1
  agent_runtime_name = local.runtime_name
  description        = "HomeLedger MCP server (stateful Streamable HTTP)"
  role_arn           = aws_iam_role.runtime.arn

  agent_runtime_artifact {
    container_configuration {
      container_uri = var.image_uri
    }
  }

  environment_variables = {
    HOUSEHOLD_ID         = var.household_id
    TABLE_NAME           = aws_dynamodb_table.homeledger.name
    AWS_REGION           = local.region
    HOMELEDGER_DEV_TOOLS = "1"
    ALLOWED_HOSTS        = var.allowed_hosts
    PORT                 = "8000"
  }

  authorizer_configuration {
    custom_jwt_authorizer {
      discovery_url   = "https://cognito-idp.${local.region}.amazonaws.com/${aws_cognito_user_pool.mcp.id}/.well-known/openid-configuration"
      allowed_clients = [aws_cognito_user_pool_client.simulator.id]
    }
  }

  network_configuration {
    network_mode = "PUBLIC"
  }

  protocol_configuration {
    server_protocol = "MCP"
  }

  lifecycle_configuration {
    idle_runtime_session_timeout = var.idle_session_timeout_seconds
    max_lifetime                 = 28800
  }

  depends_on = [aws_iam_role_policy.runtime]
}
```

`infra/outputs.tf`:
```hcl
output "ecr_repository_url" { value = aws_ecr_repository.mcp.repository_url }
output "table_name"         { value = aws_dynamodb_table.homeledger.name }
output "cognito_discovery_url" {
  value = "https://cognito-idp.${local.region}.amazonaws.com/${aws_cognito_user_pool.mcp.id}/.well-known/openid-configuration"
}
output "cognito_token_url" {
  value = "https://${aws_cognito_user_pool_domain.mcp.domain}.auth.${local.region}.amazoncognito.com/oauth2/token"
}
output "cognito_client_id"     { value = aws_cognito_user_pool_client.simulator.id }
output "cognito_client_secret" { value = aws_cognito_user_pool_client.simulator.client_secret, sensitive = true }
output "agent_runtime_arn"     { value = try(aws_bedrockagentcore_agent_runtime.mcp[0].agent_runtime_arn, "") }
output "agent_runtime_invocation_url" {
  value = try("https://bedrock-agentcore.${local.region}.amazonaws.com/runtimes/${urlencode(aws_bedrockagentcore_agent_runtime.mcp[0].agent_runtime_arn)}/invocations?qualifier=DEFAULT", "")
}
```

`infra/README.md`:
```markdown
# infra

```bash
cd infra
terraform init -backend-config="bucket=homeledger-tfstate-$ACCOUNT_ID" -backend-config="region=$AWS_REGION"
terraform apply                                   # first pass: ECR, table, Cognito, role (no runtime yet)
IMAGE=$(../scripts/build-image.sh "$(terraform output -raw ecr_repository_url)")
terraform apply -var "image_uri=$IMAGE"           # second pass: creates the AgentCore runtime
```
Runtime updates: rebuild, then `terraform apply -var "image_uri=<new uri>"`.
```

- [ ] **Step 4: Validate and apply the first pass**

```bash
cd infra
terraform init -backend-config="bucket=homeledger-tfstate-$ACCOUNT_ID" -backend-config="region=$AWS_REGION"
terraform fmt -check && terraform validate
terraform plan -out first.plan && terraform apply first.plan
terraform output
```
Expected: ECR, DynamoDB, Cognito pool/domain/resource server/client, and the IAM role exist; `agent_runtime_arn` is empty. If `validate` rejects an argument name on `aws_bedrockagentcore_agent_runtime` (for example `lifecycle_configuration`), open the provider doc in the registry for the installed version, rename to match, and log the delta in `FRICTION-LOG.md`.

- [ ] **Step 5: Commit**

```bash
git add infra
git commit -m "infra: Terraform for ECR, DynamoDB, Cognito, execution role, and AgentCore runtime"
```

---

### Task 12: Deploy to AgentCore and smoke-test both client generations

**Files:**
- Create: `scripts/smoke.ts`, `scripts/package.json`, `scripts/seed-remote.ts`
- Modify: `FRICTION-LOG.md`, `README.md`

**Interfaces:**
- Consumes: Terraform outputs; the Cognito client-credentials flow; the invocation URL format `https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<urlencoded-arn>/invocations?qualifier=DEFAULT`.
- Produces: `pnpm smoke` exits 0 only when: a token is minted, a modern client lists five tools through AgentCore, a legacy client initializes with a session and completes `echo_confirm` through the shim, and every call finished under 3 seconds after the first.

- [ ] **Step 1: Build, push, and create the runtime**

```bash
IMAGE=$(./scripts/build-image.sh "$(cd infra && terraform output -raw ecr_repository_url)")
(cd infra && terraform apply -var "image_uri=$IMAGE")
cd infra && terraform output agent_runtime_invocation_url && cd ..
```
Expected: the runtime reaches READY (`aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id <id>` shows `"status": "READY"`). If the container fails health checks, read `aws logs tail /aws/bedrock-agentcore/runtimes/homeledger_mcp-<id>-DEFAULT --follow` and fix `ALLOWED_HOSTS` first, since a Host-header rejection is the likeliest failure; log it.

- [ ] **Step 2: Seed the real table**

`scripts/package.json`:
```json
{
  "name": "@homeledger/scripts",
  "private": true,
  "type": "module",
  "scripts": { "smoke": "tsx smoke.ts", "seed:remote": "tsx seed-remote.ts" },
  "dependencies": { "@homeledger/core": "workspace:*", "@modelcontextprotocol/client": "^2.0.0", "@modelcontextprotocol/sdk": "^1.25.2" },
  "devDependencies": { "tsx": "^4.20.0", "typescript": "^5.9.0" }
}
```

`scripts/seed-remote.ts`:
```ts
import { createDynamoRepository, seedRepository } from '@homeledger/core';
const tableName = process.env.TABLE_NAME ?? 'homeledger';
const householdId = process.env.HOUSEHOLD_ID ?? 'hh_harlow';
const repo = createDynamoRepository({ tableName, householdId, region: process.env.AWS_REGION });
console.log(await seedRepository(repo, householdId, new Date().toISOString().slice(0, 10)));
```
Run: `pnpm install && AWS_REGION=us-east-1 pnpm --filter @homeledger/scripts seed:remote`
Expected: prints six appliance ids.

- [ ] **Step 3: Write the smoke script**

`scripts/smoke.ts`:
```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };
const url = need('MCP_URL');
const tokenUrl = need('COGNITO_TOKEN_URL');
const clientId = need('COGNITO_CLIENT_ID');
const clientSecret = need('COGNITO_CLIENT_SECRET');
const BUDGET_MS = 3000;

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

// Modern client (2026-07-28)
{
  const client = new Client({ name: 'smoke-modern', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } });
  await timed('modern connect (cold)', () => client.connect(transport), false);
  const { tools } = await timed('modern tools/list', () => client.listTools());
  const names = tools.map(t => t.name);
  const expected = ['list_appliances', 'get_appliance', 'maintenance_due', 'log_maintenance', 'recent_events', 'echo_confirm'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`tool order ${names.join(',')}`);
  const due = await timed('modern maintenance_due', () => client.callTool({ name: 'maintenance_due', arguments: {} }));
  if (!(due.structuredContent as { items: unknown[] }).items.length) throw new Error('no maintenance items; run seed:remote');
  await client.close();
}

// Legacy client (2025-era) with elicitation through the shim
{
  const client = new LegacyClient({ name: 'Alexa+ MCP Client', version: '1.0.0' }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { confirm: true } }));
  const transport = new LegacyTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } });
  await timed('legacy initialize (cold)', () => client.connect(transport), false);
  if (!transport.sessionId) throw new Error('legacy: no Mcp-Session-Id');
  console.log(`legacy session: ${transport.sessionId}`);
  const r = await timed('legacy echo_confirm (elicitation)', () => client.callTool({ name: 'echo_confirm', arguments: { message: 'smoke' } }));
  if (JSON.stringify(r.structuredContent) !== JSON.stringify({ confirmed: true, message: 'smoke' })) throw new Error(`legacy elicitation result ${JSON.stringify(r.structuredContent)}`);
  await transport.terminateSession();
  await client.close();
}

console.log('SMOKE OK');
```

Add to the root `package.json` scripts: `"smoke": "pnpm --filter @homeledger/scripts smoke"`.

- [ ] **Step 4: Run the smoke**

```bash
cd infra
export MCP_URL=$(terraform output -raw agent_runtime_invocation_url)
export COGNITO_TOKEN_URL=$(terraform output -raw cognito_token_url)
export COGNITO_CLIENT_ID=$(terraform output -raw cognito_client_id)
export COGNITO_CLIENT_SECRET=$(terraform output -raw cognito_client_secret)
cd .. && pnpm smoke
```
Expected: `SMOKE OK` with every timed call after the two cold connects under 3000 ms. Three failure modes and what they mean:
- `401` on connect: the JWT authorizer's `allowed_clients` does not match; check the token's `client_id` claim with `jwt.io` and the Terraform value.
- `-32011` Accept header error: the client did not send `application/json, text/event-stream`; the SDK clients do, so this means a proxy stripped it.
- `404 Session not found` on the legacy branch: AgentCore did not route the second request to the same microVM. Confirm the transport echoes `Mcp-Session-Id` (it does by default) and that the runtime is not in stateless mode; if AgentCore rewrites the header, the legacy session map cannot work and architecture C's fallback applies (see Task 9 Step 7).

- [ ] **Step 5: Record results**

Append `FL-018` to `FRICTION-LOG.md` with the measured cold and warm timings, the `ALLOWED_HOSTS` value that worked (and the Host header AgentCore actually sends, from the server log), and any authorizer surprises. Add the invocation URL format and the smoke command to `README.md` under "Deployed endpoint".

- [ ] **Step 6: Commit**

```bash
git add scripts pnpm-lock.yaml package.json README.md FRICTION-LOG.md
git commit -m "ops: remote seed and AgentCore smoke test for modern and legacy clients"
```

---

### Task 13: CI and deploy workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `infra/github-oidc.tf`

**Interfaces:**
- Consumes: Terraform state and outputs; the ECR repository.
- Produces: pull requests run typecheck and tests; pushes to `main` build the ARM64 image, push it, and apply Terraform with the new `image_uri`. AWS access is through GitHub OIDC; no static keys.

- [ ] **Step 1: Add the OIDC provider and deploy role to Terraform**

`infra/github-oidc.tf` (replace `OWNER/REPO` with the GitHub path of this repository):
```hcl
variable "github_repo" {
  type    = string
  default = "OWNER/REPO"
}

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "homeledger-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.deploy_trust.json
}

# Demo-scoped: broad enough to run this stack's plan/apply. Tighten per resource before any non-demo use.
resource "aws_iam_role_policy_attachment" "deploy_power" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

data "aws_iam_policy_document" "deploy_iam" {
  statement {
    actions   = ["iam:GetRole", "iam:PassRole", "iam:CreateRole", "iam:DeleteRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:TagRole", "iam:UpdateAssumeRolePolicy", "iam:GetOpenIDConnectProvider"]
    resources = ["arn:aws:iam::${local.account_id}:role/homeledger-*", "arn:aws:iam::${local.account_id}:oidc-provider/token.actions.githubusercontent.com"]
  }
}

resource "aws_iam_role_policy" "deploy_iam" {
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy_iam.json
}

output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
```
Run: `cd infra && terraform apply -var "image_uri=$IMAGE"` and note `deploy_role_arn`. Store it as the GitHub Actions repository variable `AWS_DEPLOY_ROLE_ARN`, plus variables `AWS_REGION` and `TFSTATE_BUCKET`.

- [ ] **Step 2: Write the CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-24.04
    services:
      dynamodb:
        image: amazon/dynamodb-local:latest
        ports: ["8000:8000"]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10.15.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm format
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm --filter @homeledger/core test:dynamo
      - run: pnpm build
```

- [ ] **Step 3: Write the deploy workflow**

`.github/workflows/deploy.yml`:
```yaml
name: deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
concurrency: deploy-demo
permissions:
  id-token: write
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-24.04
    env:
      AWS_REGION: ${{ vars.AWS_REGION }}
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: hashicorp/setup-terraform@v3
        with: { terraform_version: "1.10.5" }
      - name: Terraform init
        working-directory: infra
        run: terraform init -backend-config="bucket=${{ vars.TFSTATE_BUCKET }}" -backend-config="region=${{ vars.AWS_REGION }}"
      - name: Build and push image
        id: image
        run: |
          REPO=$(cd infra && terraform output -raw ecr_repository_url)
          IMAGE=$(./scripts/build-image.sh "$REPO" "${GITHUB_SHA::7}")
          echo "uri=$IMAGE" >> "$GITHUB_OUTPUT"
      - name: Terraform apply
        working-directory: infra
        run: terraform apply -auto-approve -var "image_uri=${{ steps.image.outputs.uri }}"
```

- [ ] **Step 4: Push and watch both workflows**

```bash
git add .github infra/github-oidc.tf
git commit -m "ci: test workflow with DynamoDB Local and OIDC deploy workflow to AgentCore"
git push -u origin main
gh run watch
```
Expected: `ci` green; `deploy` green with a new image tag on the runtime. Then re-run `pnpm smoke` locally against the updated runtime and expect `SMOKE OK`.

---

## Self-review

**Spec coverage (Plan 1 scope):** section 3 packages `core`, `mcp-server`, `infra` (Tasks 1, 5, 11); section 4.1 protocol posture (Task 8, gate in Task 9); section 4.2 rows `list_appliances`, `get_appliance` (Task 5), `maintenance_due`, `log_maintenance` (Task 6), `recent_events` (Task 7); section 4.3 resources and prompt (Task 7); section 4.5 auth and tenancy (Tasks 8, 11); section 4.6 timing budget (Task 12 smoke); section 5 data model (Tasks 3, 4, 11); section 8 infrastructure and CI (Tasks 10, 11, 13); section 9 unit and contract tests on both clients (Tasks 3 to 9), DynamoDB Local integration (Task 4, CI in Task 13), load smoke (Task 12); section 12 architecture fallback (Task 9 Step 6, Task 12 Step 4). Deferred by design to later plans: `ask_manual`, `book_service`, `get_visit`, widgets, Knowledge Base, Ring, simulator, Agent Skill, README architecture diagram.

**Placeholder scan:** none. Every code step carries code; the two "if the API differs" notes give the exact alternative and route the difference to the friction log.

**Type consistency:** `Repository` method names match between Task 3 (interface, memory), Task 4 (dynamo), and Tasks 5 to 9 (callers). `ServerDeps` fields `repo`, `now`, `devTools` are identical in `server.ts`, `harness.ts`, `deps.ts`, and `app.ts`. Table attributes `PK`, `SK`, `GSI1PK`, `GSI1SK`, `GSI2PK`, `GSI2SK` are identical in `table.ts`, `dynamo.ts`, and `main.tf`. The tool order string is identical in Tasks 6, 7, 8, and 12. Environment variable names are identical in `deps.ts`, `index.ts`, `.env.example`, `Dockerfile`, and `main.tf`.

## What Plan 2 starts from

A public repo with: five tools, three resources, one prompt; a proven elicitation path on both client generations; a container on AgentCore behind Cognito; DynamoDB seeded with the household; CI and OIDC deploy. Plan 2 adds `book_service` (built on the `echo_confirm` pattern with progress notifications), `ask_manual` on a Bedrock Knowledge Base over S3 Vectors, and the `ui://` widgets.
