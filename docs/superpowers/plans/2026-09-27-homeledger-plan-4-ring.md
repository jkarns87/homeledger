# HomeLedger Plan 4: The Ring Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A service visit booked through `book_service` becomes something the house notices: when the booked provider presses the doorbell the visit is marked arrived and the simulator shows a card with the doorbell photo and one sentence describing it; when the Flood & Freeze sensor trips, HomeLedger raises an alert and opens or advances a maintenance item.

**Architecture:** A new workspace package, `apps/events`, holds twelve small Lambda handlers (Node 22, ARM64, one esbuild bundle each). Every handler is a thin AWS adapter around a plain function that takes its collaborators as arguments, so every rule is tested against fakes with no AWS and no Ring. Ring reaches HomeLedger through an API Gateway HTTP API (token exchange, account link, webhook); the webhook Lambda verifies, decodes, deduplicates and publishes onto a custom EventBridge bus; rules fan out to the visit correlator, the sensor rules, and device sync; the correlator and the sensor rules publish `visit.arrived` / `alert.raised` back onto the bus, where a push Lambda sends a pointer over an API Gateway WebSocket API to the simulator's **Next.js server**, which runs an agent turn and relays it to the browser over a new SSE route. The domain rules that decide anything — which visit a doorbell press belongs to, what a sensor transition means, which sentence a snapshot outcome gets — live in `packages/core` as pure functions, because the MCP server reads the same records the Lambdas write.

**Tech Stack:** Node 22, pnpm 10.15.0, TypeScript 5.9, Vitest 3, esbuild 0.28 (bundling), AWS SDK v3 `^3.900.0` (DynamoDB via `@homeledger/core`, EventBridge, S3 + `s3-request-presigner`, Secrets Manager, API Gateway Management API — all provided by the `nodejs22.x` runtime and marked external), `aws-jwt-verify` 5.2 (WebSocket authorizer), `ws` 8.18 (simulator's server-side socket — Node's global `WebSocket` cannot set an `Authorization` header), the Anthropic Messages API over `fetch` (model `claude-sonnet-5`, image input), Terraform 1.16.1 with `hashicorp/aws ~> 6.21` and `hashicorp/archive`.

**Spec:** `docs/superpowers/specs/2026-09-26-homeledger-ring-design.md` (all of it), **as amended by Task 1** from Ring's own documentation. It supersedes §6 of `docs/superpowers/specs/2026-09-13-homeledger-design.md`; every other section of that spec stays in force.

**Predecessor:** `docs/superpowers/plans/2026-09-21-homeledger-plan-3-simulator.md` — read its "What Plan 4 starts from" section. Plans 1–3 and PR #17 (FL-057) are merged and deployed.

## Why this plan amends its own spec before it starts

The spec was written from `docs/superpowers/research/2026-09-21-ring-partner-api.md`, which could not read several sections of Ring's documentation (they did not render). Ring's documentation is now readable in full through Ring's public knowledge MCP server (`https://knowledge.appstore-mcp.ring.amazon.dev/mcp`, tools `ring___search_docs` / `ring___get_doc`), and four of the spec's assumptions are contradicted by it. Building to the spec as written would produce a webhook receiver that rejects every genuine Ring delivery and a link endpoint Ring never calls. Each correction below cites the Ring document it comes from; Task 1 writes them into the spec as a dated amendment so the spec stays the single authority.

| # | Spec said | Ring's documentation says | Source (Ring knowledge base path) |
|---|---|---|---|
| A1 | Ring POSTs an auth code to `POST /ring/link`; the link Lambda verifies an HMAC and exchanges the code | **Two** partner URLs. The **Token Exchange URL** receives `code` as `application/x-www-form-urlencoded`; the partner exchanges it at `https://oauth.ring.com/oauth/token` **within 60 s**, calls `GET /v1/users/me` for the Account ID, and holds the tokens *unclaimed*. The **Account Link URL** is a *browser redirect* with `?nonce=<b64url>&time=<ms>`; the partner must show a **sign-in form** (mandatory), recompute `HMAC-SHA256(key, "<time>:<account_id>")` as URL-safe Base64 without padding, compare in constant time, then `POST /v1/accounts/me/app-integrations {nonce, account_identifier}` and `PATCH … {status: "completed"}` (mandatory — without it no webhooks are delivered) | `amazon_vision_api/authentication/account_linking.md`, `amazon_vision_api/app_integrations.md`, `architecture/end-to-end-integration-example.md` |
| A2 | `X-Signature: sha256=<base64>` | `X-Signature: sha256=<lowercase hex>`, HMAC-SHA256 keyed by the HMAC key's **UTF-8 bytes** (not Base64-decoded) over the raw body bytes. Nonces use URL-safe Base64; webhooks use hex; "do not mix the two" | `amazon_vision_api/notifications.md` |
| A3 | Envelope: `data.attributes.event_type`, `attributes.device_id`, ISO `attributes.timestamp`, `attributes.sub_type` | v1.1 envelope: event type in **`data.type`**, device in **`data.attributes.source`**, **`data.attributes.timestamp` in epoch milliseconds**, `data.subType` (camelCase, on `data`, values `motion` / `human` / `vehicle` / `other_motion`), `meta.request_id` (idempotency key), `meta.account_id`. 2xx = delivered; **4xx is never retried**; 5xx or no answer inside 5 s is retried at 1 s, 5 s, 30 s, 2 min, 10 min, 1 h | `amazon_vision_api/notifications.md`, `amazon_vision_api/notifications/motion_detection.md` |
| A4 | No sensor webhook events are documented; a live test must choose between webhook and polling before any sensor code is written | Sensor events **are** documented, in the same envelope: `flood_detected` / `flood_cleared`, `freeze_detected` / `freeze_cleared`, `contact_sensor_faulted` / `contact_sensor_cleared`, `tamper_*`. Ring also says: *treat `GET /v1/devices/{id}/status` as the authority for current state and reconcile against it*; status carries `flood_detection.faulted` and `freeze_detection.faulted` (independent booleans). Sensor events are not in Event History — *persist every event on receipt* | `amazon_vision_api/sensors/overview.md`, `amazon_vision_api/sensors/flood_freeze_sensor.md` |
| A5 | Image download body fields and redirect handling Unverified | `POST /v1/devices/{id}/media/image/download` `{type: "latest_in_range", start_timestamp, end_timestamp?}` (epoch ms, window ≤ 24 h) → **303** with `Location` (presigned, no auth) → `GET` → `200 image/jpeg` with `X-Media-Timestamp`, `X-Media-Origin`. Errors: `403 TIME_RANGE_NOT_AUTHORIZED` (before consent) / `REQUEST_FORBIDDEN`, `416 MEDIA_NOT_FOUND`, `425 RECORDING_NOT_READY`, `422 CORRUPT_RECORDING`, `503 SERVER_BUSY`. Download never triggers capture | `amazon_vision_api/image_download.md` |
| A6 | Device class (doorbell / sensor kind) comes from `GET /v1/devices` | `GET /v1/devices` returns only `id` and `attributes.name`. "Do not infer device type from capabilities … Store your own device-type mapping" | `amazon_vision_api/device_discovery.md`, `amazon_vision_api/sensors/overview.md` |

**What does not change:** the pipeline shape (§2), the secrets principle (§3, values never in Terraform state), the correlation rule (§5), the five snapshot statuses (§5), the rule table (§6), push (§7), testing (§8), fallbacks (§11). The deciding sensor test (§6) survives as a **confirmation** test rather than a fork in the design: A4 answers the question the test was going to ask, and the live run records whether the webhook or the reconciliation poll noticed the trip first.

## Rulings made while writing this plan

Each is `what — why — cost if wrong`, in the ledger format the executor will use.

- **R1. Account linking is Ring's one-way flow with a passphrase sign-in page.** `POST /ring/token` is the Token Exchange URL; `GET /ring/link` serves a sign-in form and `POST /ring/link` completes the link. The "sign-in" is a household passphrase held in an owner-created secret `demo-homeledger/ring/link-passphrase`, compared in constant time. — Ring makes a partner sign-in mandatory (A1) and HomeLedger has no user accounts; a passphrase is the smallest honest identity for a single-household demo. — If Ring's certification later demands a real account system, the link page changes and nothing else does.
- **R2. The spec's "deciding test" becomes a confirmation test, and both adapters ship.** The webhook adapter routes `flood_*` / `freeze_*` (A4); the reconciliation poller reads `/status` every `sensor_poll_minutes` (default 2). Both feed one transition detector keyed on the device's last-known state, so the same trip never alerts twice. — Ring documents the events *and* tells partners to reconcile against status. — If live webhooks never arrive for the sensor, the poller is already the path; nothing is rebuilt.
- **R3. Device kind is learned, not fetched.** Device sync writes `kind: 'sensor'` when a device's `/status` carries `flood_detection` or `freeze_detection` (documented sensor attributes), otherwise keeps any kind already learned, otherwise `'other'`. A `button_press` from a device marks it `'doorbell'`. A `button_press` always qualifies for correlation (only doorbells emit it); `motion_detected` with `subType: human` qualifies only from a device already learned as a doorbell. — A6: Ring provides no type. — If the doorbell's first event is a human-motion event, that one is not correlated; the press that follows is.
- **R4. `encrypted` is detected by content, and is Unverified.** Ring documents that a TAKE device returns "encrypted content" but not how it is marked. A 200 download whose first bytes are neither JPEG (`FF D8 FF`) nor PNG (`89 50 4E 47`) is classed `encrypted`. — The only observable difference available. — If TAKE surfaces as an error code instead, that code lands in `error`, the card still says the photo could not be fetched, and the live checklist records the code for a one-line mapping.
- **R5. The visit keeps its existing `description` field** rather than gaining `snapshotDescription` (spec §5). `description` is already in `VisitSchema`, `book_service`, `get_visit`, the widget and four test files, and it is only ever the snapshot sentence. The new fields are `snapshotStatus` and `snapshotLatencyMs`. — A rename touches four packages to change no behaviour. — Cosmetic.
- **R6. One Terraform root.** The Ring infrastructure is a new module, `infra/modules/ring-events`, called from `infra/live/demo/platform`, not a sibling root. — The MCP runtime's role and environment need the snapshot bucket, and the table needs a TTL; two roots would need cross-state reads and a second deploy job. — The platform README's "sibling roots" note is updated.
- **R7. Terraform creates the `ring/tokens` secret container (no version); the owner creates the four value secrets.** `client-secret` and `hmac-key` exist (stored 2026-09-27). `anthropic/api-key` and `ring/link-passphrase` must exist **before the PR that adds the module is opened**, because the PR's `plan` job reads them as `data` sources. — Values never enter state (spec §3). — A plan fails loudly if one is missing; Task 14's brief says so.
- **R8. The snapshot image reaches the widget by declaring its origin, not by a proxy.** FL-051 leaned towards proxying through the simulator because a declared origin "has to be edited per environment". Terraform knows the bucket's regional domain, so `SNAPSHOT_ORIGIN` is set on the runtime and the visit widget's resource declares it in `_meta.ui.csp.resourceDomains` — correct for any MCP Apps host, including a real one, which a simulator proxy would never be. — Closes FL-030 and FL-051. — If a host ignores `resourceDomains`, the card shows the snapshot note without the photo.
- **R9. One push, after the snapshot attempt settles.** The correlator marks the visit arrived first (idempotent), then spends up to ~60 s on the snapshot, then publishes `visit.arrived` once. — A card that appears and then changes is two turns of narration for one event. — The card lags the press by the snapshot latency, which is measured and reported (`snapshotLatencyMs`).
- **R10. Documented Ring examples are acceptable fixtures; a live capture is added on top.** Spec §8 refuses *invented* fixtures as the only evidence for a decoder. The payloads in `apps/events/test/fixtures/ring/` are copied verbatim from Ring's own documentation, with the source path in each file. The Playground cannot deliver webhooks (research §9), so live captures come from the deployed webhook in Task 18 and are added then. — Ring-authored examples are not invented. — If a live payload differs, Task 18 adds it as a fixture and the decoder test that fails on it is the fix's test.
- **R11. The smoke check stays dispatch-only.** Spec §8 says the signed synthetic webhook "runs on every deploy"; the existing smoke workflow is `workflow_dispatch` and runs the whole MCP smoke, which needs a seeded table. The synthetic webhook is added to that smoke and uses an event type (`homeledger_smoke`) no rule routes, so it never touches a visit. — Keeps one smoke. — A broken ingest is noticed at the next smoke run, not at deploy.
- **R12. The sensor's appliance and location come from configuration.** Ring carries no location on a sensor event (A4). `sensor_appliance_id` (default `appl_waterheater22222`, the seeded water heater) names the appliance whose `inspection` item the rule advances; the device's own Ring name ("Water Heater", say) is the location in the sentence. — One sensor, one household. — Moving the sensor means changing one Terraform variable.

## Global Constraints

- Node `>=22.0.0`; pnpm `10.15.0`; every package `"type": "module"`.
- **Mutation-check discipline, standing requirement.** An assertion is proven only when a reasonable mutation to the guarded code makes it fail. Never hunt for a mutation the existing assertion happens to catch — pick the mutation an ordinary wrong edit would make, apply it, run the suite, and record how many tests failed and which. The four recurring shapes that produced unfailable assertions in Plans 1–3: **self-referential assertions** (the test computes the expected value the same way the code does — an HMAC test that calls the same helper to build its expected signature is this, which is why this plan's HMAC tests pin literal digests computed once, independently, with `openssl`); **symmetric contract reads** (a writer and a reader in the same module agreeing with each other and nothing else); **loose matchers** (`toContain`, `toBeTruthy`, `expect.anything()` where an exact value is knowable); **branches made unreachable by preprocessing**. Every task below names its mutations.
- Every task ends with a commit. **Commit messages carry no trailer of any kind** — no `Co-Authored-By`, no generated-by line, nothing after the body.
- Prettier config is `{ "singleQuote": true, "printWidth": 160, "trailingComma": "none", "arrowParens": "avoid" }`. `pnpm format` runs in CI.
- TypeScript is `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`, `module`/`moduleResolution` `NodeNext` — inherited from `tsconfig.base.json`. Type-only imports say `import type`; relative imports carry `.js`.
- `@homeledger/core` is consumed through its built `dist/`. Run `pnpm --filter @homeledger/core build` after changing core and before typechecking anything that imports it.
- Zod is imported as `import * as z from 'zod/v4'` (core's existing form).
- **The simulator must never become a dependency of `@homeledger/mcp-server`, and neither may `@homeledger/events`.** `apps/mcp-server/Dockerfile` copies only `packages/core` and `apps/mcp-server`; any new edge into it breaks the `image` check (FL-036).
- `main` requires `test`, `terraform`, and `image`. `test` runs `pnpm format`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @homeledger/core test:dynamo`, `pnpm build`; all five must pass with the new package in the workspace.
- **No test makes a live AWS, Ring, or Anthropic call.** Every AWS client is behind a port the tests fake; every `fetch` is injected. The live work is Task 18, run deliberately by the controller with the owner.
- **Terraform plan and apply run only in GitHub Actions** (`deploy.yml`, OIDC). Locally: `terraform fmt`, `init -backend=false`, `validate`, `test` — nothing else.
- **Secrets.** No value of any secret is printed, logged, committed, or written into Terraform state. Agents never call `secretsmanager get-secret-value`; they may call `describe-secret`. Lambda code reads secrets at runtime through the SDK, cached per container.
- **Ring's watermark is preserved.** Snapshot bytes are stored exactly as downloaded — never cropped, resized, or re-encoded (spec §5; research §7).
- **Content rules (spec §7).** The description prompt forbids identifying, naming, or guessing who anyone is. Sensor cards describe property and maintenance; they make no life-safety claim and never reassure anyone that they are safe. The link to the booked provider comes from HomeLedger's matching, never from the image, and the card says so.
- **Never claim to be Alexa+.** Push is the simulator's channel, not an MCP or Alexa+ capability; the on-screen disclosure names it (spec §7). The simulator's `FORBIDDEN_WORDMARKS` guard applies to every new file under `apps/simulator/src`.
- **"Today" is the household's day.** Anything that computes a calendar date uses `todayInZone(instant, zone)` from `@homeledger/core`. No `.toISOString().slice(0, 10)` for a date a person reads.
- Any deviation from documented behaviour gets a `FRICTION-LOG.md` entry in the existing format (`### FL-NNN · <Area> · <summary>` then Expected / Actual / Impact / Workaround / decision / Source / Status). **The last entry is FL-057, so the next free number is FL-058.** Re-check with `grep -n '^### FL-' FRICTION-LOG.md | tail -3` immediately before writing a heading, take the lowest free number, and say so in the commit body.

## Out of scope

Contact sensors on live hardware (the owner's are Ring Alarm Z-Wave; the rule exists and is tested on fixtures). Clips and live view. Multi-household linking (one account, mapped to `hh_harlow`). Hosting the simulator. Temperature, humidity, air-quality and tamper events (decoded and stored, routed nowhere). Partner-initiated OAuth (invitation only). Unlinking from HomeLedger's side (`DELETE` returns 403 for one-way apps; the owner removes the app in Ring).

## Owner prerequisites that gate specific tasks

| Before | The owner (or the controller with the owner's go-ahead) must | Checked by |
|---|---|---|
| The branch's PR (Task 14 adds the `data` sources) | Create `demo-homeledger/anthropic/api-key` and `demo-homeledger/ring/link-passphrase` (plain strings, tags `env=demo project=homeledger managed_by=owner`) | `aws secretsmanager describe-secret --secret-id <name>` returns a current version |
| The branch's PR | Set repository variable `RING_CLIENT_ID` (`gh variable set RING_CLIENT_ID`) — the Client ID is not a secret (spec §3) | `gh variable list` |
| Task 18 | In the Ring Developer Portal: set the Token Exchange URL, Account Link URL and Webhook URL to Terraform's outputs, and select the Cameras & Doorbells and Sensors (Flood/Freeze) scopes | Screenshot in the FL entry |
| Task 18, sensor step | Put Ring's professional monitoring in **test mode** before tripping the sensor | Owner confirms aloud |

---
## File structure

Every file below is created or modified by exactly the tasks named. The final whole-branch review checks this block against `git diff --stat main...HEAD`: a file implemented but not declared, or declared but folded into another, is drift.

```
docs/superpowers/specs/2026-09-26-homeledger-ring-design.md   # MOD  T1   §12 amendment (A1–A6, R1–R12)

packages/core/
├── src/domain/schemas.ts           # MOD  T2   SnapshotStatus; Visit +snapshotStatus +snapshotLatencyMs; Alert +system +severity +ringDeviceId +message;
│                                   #           Device +sensorState; ConnectionSchema
├── src/domain/push.ts              # NEW  T2   PushPayload, PUSH_CARD_TYPES, parsePushPayload — the contract the push Lambda and the simulator share
├── src/domain/arrival.ts           # NEW  T4   ARRIVAL_SLACK_MS, arrivalWindowFor, pickArrivalVisit, snapshotSentence, arrivalMatchNote
├── src/domain/sensors.ts           # NEW  T4   SENSOR_EVENT_TYPES, sensorTransitions, decideSensorChange, advanceMaintenanceForSensor
├── src/repo/keys.ts                # MOD  T2   sk.eventMarker, sk.connection
├── src/repo/repository.ts          # MOD  T3   nine new port methods and VisitSnapshot
├── src/repo/memory.ts              # MOD  T3
├── src/repo/dynamo.ts              # MOD  T3
├── src/index.ts                    # MOD  T2 T4
├── test/repository.contract.ts     # MOD  T2 (fixtures) T3 (cases)
├── test/keys.test.ts               # MOD  T2
├── test/schemas.test.ts            # MOD  T2
├── test/push.test.ts               # NEW  T2
├── test/arrival.test.ts            # NEW  T4
└── test/sensors.test.ts            # NEW  T4

apps/events/                        # NEW package @homeledger/events
├── package.json                    # NEW  T5
├── tsconfig.json                   # NEW  T5
├── vitest.config.ts                # NEW  T5
├── build.mjs                       # NEW  T5   one esbuild bundle per src/handlers/*.ts -> dist/<name>/index.mjs
├── src/
│   ├── env.ts                      # NEW  T5   requireEnv / optionalEnv, read per invocation, never at import
│   ├── ring/hmac.ts                # NEW  T5   webhook signature (hex) and link nonce (b64url) — never mixed (A2)
│   ├── ring/envelope.ts            # NEW  T5   decodeWebhook: total over the v1.1 envelope (A3)
│   ├── ring/client.ts              # NEW  T6   RingOAuth (code + refresh), RingApi (users/me, devices, status, app-integrations, image)
│   ├── ring/snapshot.ts            # NEW  T6   fetchDoorbellSnapshot: 303 -> GET, backoff to ~60 s, five outcomes
│   ├── aws/secrets.ts              # NEW  T7   cached secret reader, secret writer
│   ├── aws/tokens.ts               # NEW  T7   TokenStore over the ring/tokens secret; currentAccessToken
│   ├── aws/bus.ts                  # NEW  T7   EventPublisher over PutEvents; throws on any failed entry
│   ├── aws/objects.ts              # NEW  T7   putSnapshot over S3 PutObject
│   ├── aws/describe.ts             # NEW  T7   Describer over the Anthropic Messages API (fetch), DESCRIBE_INSTRUCTION
│   ├── aws/alerts.ts               # NEW  T7   raiseSystemAlert — the one way a system failure becomes an ALERT# row
│   └── handlers/
│       ├── webhook.ts              # NEW  T8   POST /ring/webhook
│       ├── token-exchange.ts       # NEW  T9   POST /ring/token (Token Exchange URL)
│       ├── link.ts                 # NEW  T9   GET + POST /ring/link (Account Link URL, sign-in form)
│       ├── device-sync.ts          # NEW  T9   device_* / app_integration_* events, nightly schedule, and syncDevices
│       ├── visit-correlator.ts     # NEW  T10  button_press / motion_detected(human)
│       ├── sensor-rules.ts         # NEW  T11  flood_* / freeze_* / contact_* events, and applySensorObservation
│       ├── sensor-poller.ts        # NEW  T11  schedule: reconcile against /status
│       ├── token-refresh.ts        # NEW  T11  schedule: refresh inside the 1-hour margin
│       ├── dlq-alerter.ts          # NEW  T11  SQS dead-letter -> ALERT#
│       ├── push.ts                 # NEW  T12  visit.arrived / alert.raised -> every live connection
│       ├── ws-authorizer.ts        # NEW  T12  $connect: Cognito client-credentials JWT
│       └── ws-connections.ts       # NEW  T12  $connect / $disconnect / $default (keepalive)
└── test/
    ├── fixtures/ring/*.json        # NEW  T1   Ring-documented payloads, source path in each (R10)
    ├── fakes.ts                    # NEW  T5   fakeFetch, fixed clocks, recording publisher (grown T6–T12)
    ├── hmac.test.ts                # NEW  T5
    ├── envelope.test.ts            # NEW  T5
    ├── client.test.ts              # NEW  T6
    ├── snapshot.test.ts            # NEW  T6
    ├── aws.test.ts                 # NEW  T7
    ├── webhook.test.ts             # NEW  T8
    ├── linking.test.ts             # NEW  T9
    ├── device-sync.test.ts         # NEW  T9
    ├── visit-correlator.test.ts    # NEW  T10
    ├── sensors.test.ts             # NEW  T11
    ├── maintenance-jobs.test.ts    # NEW  T11  token refresh + DLQ alerter
    └── push.test.ts                # NEW  T12  push, authorizer, connections

infra/
├── modules/ring-events/            # NEW  T13  versions.tf variables.tf main.tf lambdas.tf http.tf websocket.tf events.tf outputs.tf README.md tests/ring-events.tftest.hcl; T14 .terraform.lock.hcl
├── modules/agentcore-runtime/      # MOD  T14  variables.tf main.tf: snapshot_bucket_arn -> s3:GetObject on snapshots/* only; tests/agentcore-runtime.tftest.hcl
└── live/demo/platform/             # MOD  T14  versions.tf (archive), variables.tf, main.tf (TTL, secrets data, module, runtime env), outputs.tf, README.md, tests/*.tftest.hcl

.github/workflows/ci.yml            # MOD  T14  ring-events validate/test + trivy
.github/workflows/deploy.yml        # MOD  T14  build @homeledger/events before plan and apply; -var ring_client_id
.github/workflows/teardown.yml      # MOD  T14  the same, in both jobs
.github/workflows/smoke.yml         # MOD  T17  ring outputs + HMAC key for the signed synthetic webhook

apps/mcp-server/
├── package.json                    # MOD  T15  @aws-sdk/client-s3, @aws-sdk/s3-request-presigner
├── src/server.ts                   # MOD  T15  ServerDeps.snapshotUrl?, ServerDeps.snapshotOrigin?
├── src/deps.ts                     # MOD  T15  presigner from SNAPSHOT_BUCKET; origin from SNAPSHOT_ORIGIN
├── src/snapshots.ts                # NEW  T15  createSnapshotPresigner (10-minute URLs)
├── src/tools/service.ts            # MOD  T2 (book_service writes the two new nulls), T15 (get_visit returns the snapshot fields)
├── src/tools/events.ts             # MOD  T15  an alert's own message wins over the generic sentence
├── src/resources.ts                # MOD  T15  visit widget declares the snapshot origin (closes FL-030)
├── src/widgets/visit.ts            # MOD  T15  note, match line, photo, reportSize after load
└── test/visits.test.ts, test/events.test.ts, test/timezone.test.ts (T2 fixtures), test/widgets.test.ts, test/snapshots.test.ts (NEW)   # MOD T2 T15

apps/simulator/
├── package.json                    # MOD  T16  ws, @types/ws
├── src/shared/events.ts            # MOD  T16  TurnEvent + 'push-received' + 'push-status'
├── src/server/env.ts               # MOD  T16  pushUrl
├── src/server/push.ts              # NEW  T16  PushClient: server-held socket, bearer header, keepalive, backoff
├── src/server/hub.ts               # NEW  T16  EventHub: fan-out to /api/agent/events subscribers
├── src/server/injector.ts          # NEW  T16  one injected turn per push burst; waits for the running turn; coalesces
├── src/server/http.ts              # MOD  T16  startTurn extracted from handleTurn; handleEvents (SSE)
├── src/server/session.ts           # MOD  T16  Conversation.hub, .push; build() starts the push client
├── src/server/prompt.ts            # MOD  T16  the [Home event] rule
├── src/app/api/agent/events/route.ts   # NEW T16
├── src/lib/transcript.ts           # MOD  T16  reduce push-received / push-status
├── src/lib/useAgentTurn.ts         # MOD  T16  expose apply
├── src/lib/useHomeEvents.ts        # NEW  T16  EventSource over /api/agent/events
├── src/app/page.tsx                # MOD  T16
├── src/components/Disclosure.tsx   # MOD  T16  names the push channel
├── src/components/DebugDrawer.tsx  # MOD  T16  push status
├── test/frame.test.tsx, test/prompt.test.ts  # MOD T16
└── test/push.test.ts, test/injector.test.ts, test/events-route.test.ts, test/home-events.test.tsx, test/routes.test.ts (fixture), test/transcript.test.ts  # T16

scripts/smoke.ts, scripts/test/smoke.test.ts   # MOD T17  signed synthetic webhook
docs/RUNBOOK.md                     # MOD  T17  new §4.7 Ring: owner setup, linking, live checklist
README.md                           # MOD  T17
.env.example                        # MOD  T16  HOMELEDGER_PUSH_URL
FRICTION-LOG.md                     # MOD  T1 (FL-058), T18 (live results)
docs/submission/devpost-story.md    # MOD  T18  only what the live run verified moves above PENDING
```

## Task overview

| # | Task | Depends on | Model tier |
|---|---|---|---|
| 1 | Amend the spec from Ring's documentation; Ring fixtures; FL-058 | — | cheap (transcription) |
| 2 | Core schema, keys and the push contract | 1 | cheap |
| 3 | Core repository: nine methods, both implementations, one contract | 2 | standard |
| 4 | Core rules: arrival matching, snapshot sentences, sensor transitions and decisions | 2 | cheap |
| 5 | `apps/events` scaffold, HMAC, the envelope decoder | 1, 2 | standard |
| 6 | Ring client and the snapshot fetch | 5 | standard |
| 7 | AWS ports and the describer | 5 | standard |
| 8 | Webhook ingest | 3, 5, 7 | standard |
| 9 | Linking and device sync | 3, 6, 7 | standard |
| 10 | Visit correlator | 3, 4, 6, 7 | standard |
| 11 | Sensor rules, poller, token refresh, DLQ alerter | 3, 4, 6, 7 | standard |
| 12 | Push, WebSocket authorizer, connections | 3, 7 | standard |
| 13 | Terraform module `ring-events` | 5 | most capable |
| 14 | Platform wiring, runtime role, CI and deploy | 13 | standard |
| 15 | MCP server: snapshot fields, widget, origin | 2, 3, 4 | standard |
| 16 | Simulator: push client, injected turns, events route | 2, 12 | most capable |
| 17 | Smoke, runbook, README | 8, 14 | standard |
| 18 | Live verification with the owner (controller-run) | all | controller |

---
### Task 1: Amend the spec from Ring's documentation; Ring fixtures; FL-058

This task writes no code. It makes the spec true before anything is built on it, and it puts Ring's own example payloads in the repository so every decoder test downstream has a Ring-authored input.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-26-homeledger-ring-design.md` (append §12)
- Create: `apps/events/test/fixtures/ring/button-press.json`, `motion-human.json`, `flood-detected.json`, `flood-cleared.json`, `freeze-detected.json`, `device-added.json`, `app-integration-added.json`, `users-me.json`, `devices.json`, `status-flood-freeze.json`, `status-doorbell.json`
- Modify: `FRICTION-LOG.md` (FL-058)

**Interfaces:**
- Consumes: nothing.
- Produces: every fixture has the shape `{ "source": string, "substitutions": string, "payload": <Ring JSON> }`. Tests read `.payload`. The ids and timestamps below are the values later tasks assert on — `acct-123`, `dev-doorbell-1`, `dev-flood-1`, request ids `req-bp-0001` etc., and `1791292800000` = `2026-10-06T13:20:00.000Z`.

- [ ] **Step 1: Append the amendment to the spec**

Append this section verbatim to the end of `docs/superpowers/specs/2026-09-26-homeledger-ring-design.md`:

```markdown
## 12. Amendment, 2026-09-27: what Ring's own documentation says

Ring's documentation became readable in full through Ring's public knowledge server (`https://knowledge.appstore-mcp.ring.amazon.dev/mcp`). Where it disagrees with sections 3–6 above, **this section wins**. Paths are Ring knowledge-base paths.

**12.1 Linking is two URLs, and the second is a sign-in page** (`amazon_vision_api/authentication/account_linking.md`, `amazon_vision_api/app_integrations.md`). Replaces §3 "Linking".

1. The owner authorises the account on the app's Test page.
2. Ring POSTs `code` (form-encoded) to the **Token Exchange URL**, `POST /ring/token`. The Lambda exchanges it at `https://oauth.ring.com/oauth/token` within 60 s (`grant_type=authorization_code`, `client_id`, `client_secret`), reads the Account ID from `GET /v1/users/me` → `data.id`, and writes the tokens to `demo-homeledger/ring/tokens` marked **unclaimed**.
3. Ring redirects the owner's browser to the **Account Link URL**, `GET /ring/link?nonce=…&time=…`. The page refuses a `time` older than 600 s and shows a sign-in form: one field, the household passphrase (`demo-homeledger/ring/link-passphrase`, owner-created). Ring makes a partner sign-in mandatory.
4. `POST /ring/link` checks the passphrase in constant time, recomputes the nonce as URL-safe Base64 (no padding) of `HMAC-SHA256(hmac_key_utf8, "<time>:<account_id>")` and compares in constant time, then calls `POST /v1/accounts/me/app-integrations {nonce, account_identifier}` and `PATCH … {status: "completed"}`. The PATCH is mandatory: without it Ring delivers no webhooks.
5. It marks the tokens **linked** and runs device sync.

Token lifetimes: access ~4 h (`expires_in: 14400`), refresh ~30 days; a refresh returns a new refresh token, which replaces the old one.

**12.2 Webhook signature is hex** (`amazon_vision_api/notifications.md`). Replaces §4 step 1's format: `X-Signature: sha256=<lowercase hex of HMAC-SHA256(hmac_key_utf8, raw body bytes)>`.

**12.3 The envelope** (`amazon_vision_api/notifications.md`, `…/notifications/motion_detection.md`). Replaces §4's field names: `meta.request_id` (idempotency), `meta.account_id`, `data.type` (the event type), `data.subType` (on motion: `motion`, `human`, `vehicle`, `other_motion`), `data.attributes.source` (device id when `source_type` is `devices`), `data.attributes.timestamp` (epoch **milliseconds**). Ring retries 5xx and timeouts at 1 s, 5 s, 30 s, 2 min, 10 min and 1 h, and **never retries a 4xx**. So verification failure answers 401 and a body with no `request_id` answers 400; everything transient answers 500.

**12.4 Sensor events are documented** (`amazon_vision_api/sensors/overview.md`, `…/sensors/flood_freeze_sensor.md`). Replaces §6's "deciding test". Flood & Freeze emits `flood_detected`, `flood_cleared`, `freeze_detected`, `freeze_cleared` (and `tamper_*`) in the same envelope. `GET /v1/devices/{id}/status` carries `flood_detection.faulted` and `freeze_detection.faulted`, independent booleans, and Ring says to treat status as the authority and reconcile against it. Both adapters therefore ship: the webhook adapter, and a reconciliation poll every `sensor_poll_minutes` (default 2). Both feed one transition detector keyed on the device's last-known state, so a trip alerts once. The live test becomes a confirmation test: it records which path saw the trip first.

**12.5 Snapshots** (`amazon_vision_api/image_download.md`). `POST /v1/devices/{id}/media/image/download` with `{type: "latest_in_range", start_timestamp, end_timestamp, image_options: {format: "jpeg"}}` (epoch ms) returns **303** with a presigned `Location`; a `GET` (no auth) returns the image. Outcome mapping:

| Ring answer | `snapshotStatus` | Retried? |
|---|---|---|
| 303, then 200 with JPEG or PNG bytes | `ok` | — |
| 303, then 200 with any other bytes | `encrypted` (Unverified: Ring does not document how TAKE content is marked) | no |
| 416 `MEDIA_NOT_FOUND`, 425 `RECORDING_NOT_READY` | `none-in-window` once the ~60 s budget is spent | yes |
| 403 (`TIME_RANGE_NOT_AUTHORIZED`, `REQUEST_FORBIDDEN`) | `forbidden` | no |
| 5xx, 503 `SERVER_BUSY`, network failure | `error` once the budget is spent | yes |
| anything else | `error` | no |

**12.6 Device kind is ours to record** (`amazon_vision_api/device_discovery.md`). `GET /v1/devices` returns only an id and the owner's name for it. A device whose status carries `flood_detection` or `freeze_detection` is recorded as a `sensor`; a device that sends `button_press` is recorded as a `doorbell`; otherwise `other`. A `button_press` always qualifies for correlation; `motion_detected` with `subType: human` qualifies only from a recorded doorbell.

**12.7 Unchanged:** the pipeline shape, the secrets principle, the ±30 min correlation rule, the five snapshot statuses, the rule table, push, testing, and fallbacks. The visit keeps its existing `description` field for the snapshot sentence rather than a new `snapshotDescription`, and gains `snapshotStatus` and `snapshotLatencyMs`.
```

- [ ] **Step 2: Write the fixtures**

Each file is Ring's documented example with placeholders replaced by the concrete values named in `substitutions`. Create the directory `apps/events/test/fixtures/ring/` and these eleven files exactly.

`button-press.json`:

```json
{
  "source": "Ring knowledge base: amazon_vision_api/notifications/button_press.md (Webhook Payload)",
  "substitutions": "<request_id>=req-bp-0001, <account_id>=acct-123, <event_id>=evt-bp-0001, <device_id>=dev-doorbell-1, meta.time and data.attributes.timestamp set to 2026-10-06T13:20Z",
  "payload": {
    "meta": { "version": "1.1", "time": "2026-10-06T13:20:01Z", "request_id": "req-bp-0001", "account_id": "acct-123" },
    "data": {
      "id": "evt-bp-0001",
      "type": "button_press",
      "attributes": { "source": "dev-doorbell-1", "source_type": "devices", "timestamp": 1791292800000 },
      "relationships": { "devices": { "links": { "self": "/v1/devices/dev-doorbell-1" } } }
    }
  }
}
```

`motion-human.json`:

```json
{
  "source": "Ring knowledge base: amazon_vision_api/notifications/motion_detection.md (Webhook Payload)",
  "substitutions": "<request_id>=req-mo-0001, <account_id>=acct-123, <event_id>=evt-mo-0001, <device_id>=dev-doorbell-1, timestamp 2026-10-06T13:20:05Z",
  "payload": {
    "meta": { "version": "1.1", "time": "2026-10-06T13:20:06Z", "request_id": "req-mo-0001", "account_id": "acct-123" },
    "data": {
      "id": "evt-mo-0001",
      "type": "motion_detected",
      "subType": "human",
      "attributes": { "source": "dev-doorbell-1", "source_type": "devices", "timestamp": 1791292805000 },
      "relationships": { "devices": { "links": { "self": "/v1/devices/dev-doorbell-1" } } }
    }
  }
}
```

`flood-detected.json`:

```json
{
  "source": "Ring knowledge base: amazon_vision_api/sensors/overview.md (Sensor Events) with data.type from amazon_vision_api/sensors/flood_freeze_sensor.md",
  "substitutions": "<request_id>=req-fl-0001, <account_id>=acct-123, <device_id>=dev-flood-1, data.id per the documented <device_id>_<event_type>_<timestamp> form, timestamp 2026-10-06T21:15Z",
  "payload": {
    "meta": { "version": "1.1", "time": "2026-10-06T21:15:01.279Z", "request_id": "req-fl-0001", "account_id": "acct-123" },
    "data": {
      "id": "dev-flood-1_flood_detected_1791321300000",
      "type": "flood_detected",
      "attributes": { "source": "dev-flood-1", "source_type": "devices", "timestamp": 1791321300000 },
      "relationships": { "devices": { "links": { "self": "/v1/devices/dev-flood-1" } } }
    }
  }
}
```

`flood-cleared.json`:

```json
{
  "source": "Ring knowledge base: amazon_vision_api/sensors/overview.md (Sensor Events) with data.type from amazon_vision_api/sensors/flood_freeze_sensor.md",
  "substitutions": "<request_id>=req-fl-0002, <account_id>=acct-123, <device_id>=dev-flood-1, timestamp 2026-10-06T21:40Z",
  "payload": {
    "meta": { "version": "1.1", "time": "2026-10-06T21:40:01.100Z", "request_id": "req-fl-0002", "account_id": "acct-123" },
    "data": {
      "id": "dev-flood-1_flood_cleared_1791322800000",
      "type": "flood_cleared",
      "attributes": { "source": "dev-flood-1", "source_type": "devices", "timestamp": 1791322800000 },
      "relationships": { "devices": { "links": { "self": "/v1/devices/dev-flood-1" } } }
    }
  }
}
```

`freeze-detected.json`:

```json
{
  "source": "Ring knowledge base: amazon_vision_api/sensors/overview.md (Sensor Events) with data.type from amazon_vision_api/sensors/flood_freeze_sensor.md",
  "substitutions": "<request_id>=req-fz-0001, <account_id>=acct-123, <device_id>=dev-flood-1, timestamp 2026-10-07T09:02Z",
  "payload": {
    "meta": { "version": "1.1", "time": "2026-10-07T09:02:01.000Z", "request_id": "req-fz-0001", "account_id": "acct-123" },
    "data": {
      "id": "dev-flood-1_freeze_detected_1791363720000",
      "type": "freeze_detected",
      "attributes": { "source": "dev-flood-1", "source_type": "devices", "timestamp": 1791363720000 },
      "relationships": { "devices": { "links": { "self": "/v1/devices/dev-flood-1" } } }
    }
  }
}
```

`device-added.json`:

```json
{
  "source": "Ring knowledge base: amazon_vision_api/notifications/device_addition.md (Webhook Payload)",
  "substitutions": "<request_id>=req-da-0001, <account_id>=acct-123, <event_id>=evt-da-0001, <device_id>=dev-flood-1",
  "payload": {
    "meta": { "version": "1.1", "time": "2026-10-06T12:00:00Z", "request_id": "req-da-0001", "account_id": "acct-123" },
    "data": {
      "id": "evt-da-0001",
      "type": "device_added",
      "attributes": { "source": "dev-flood-1", "source_type": "devices", "timestamp": 1699457230000 },
      "relationships": { "devices": { "links": { "self": "/v1/devices/dev-flood-1" } } }
    }
  }
}
```

`app-integration-added.json` (note `source_type: users` — the source is an account, not a device):

```json
{
  "source": "Ring knowledge base: amazon_vision_api/notifications/app_integration_added.md (Webhook Payload)",
  "substitutions": "<request_id>=req-ai-0001, <account_id>=acct-123, <event_id>=evt-ai-0001",
  "payload": {
    "meta": { "version": "1.1", "time": "2026-10-06T11:59:00Z", "request_id": "req-ai-0001", "account_id": "acct-123" },
    "data": {
      "id": "evt-ai-0001",
      "type": "app_integration_added",
      "attributes": { "source": "acct-123", "source_type": "users", "timestamp": 1699457230000 }
    }
  }
}
```

`users-me.json`:

```json
{
  "source": "Ring knowledge base: amazon_vision_api/users.md (GET /v1/users/me response)",
  "substitutions": "<account_id>=acct-123; name and email are Ring's own example values",
  "payload": { "data": { "type": "users", "id": "acct-123", "attributes": { "first_name": "John", "last_name": "Doe", "email": "johndoe@example.com" } } }
}
```

`devices.json`:

```json
{
  "source": "Ring knowledge base: amazon_vision_api/device_discovery.md (Response Structure), relationships trimmed to status only",
  "substitutions": "<device_id>=dev-doorbell-1 named Front Door; <device_id_2>=dev-flood-1 named Water Heater",
  "payload": {
    "meta": { "time": "2026-10-06T12:00:00Z" },
    "data": [
      {
        "type": "devices",
        "id": "dev-doorbell-1",
        "attributes": { "name": "Front Door" },
        "relationships": { "status": { "data": { "type": "device-status", "id": "st-1" }, "links": { "related": "/v1/devices/dev-doorbell-1/status" } } }
      },
      {
        "type": "devices",
        "id": "dev-flood-1",
        "attributes": { "name": "Water Heater" },
        "relationships": { "status": { "data": { "type": "device-status", "id": "st-2" }, "links": { "related": "/v1/devices/dev-flood-1/status" } } }
      }
    ]
  }
}
```

`status-flood-freeze.json`:

```json
{
  "source": "Ring knowledge base: amazon_vision_api/sensors/flood_freeze_sensor.md (Flood/Freeze State)",
  "substitutions": "<device_status_id>=st-2; values exactly as documented",
  "payload": {
    "data": {
      "type": "device-status",
      "id": "st-2",
      "attributes": {
        "flood_detection": { "faulted": false },
        "freeze_detection": { "faulted": false },
        "tamper_detection": { "detected": false },
        "sensor_reporting_state": { "value": "active" },
        "battery_status": { "percentage": 90 },
        "signal_strength": { "value": "good" },
        "online": true,
        "reported_at": "2026-01-15T21:58:08.213Z",
        "audio": { "snooze": { "active": null, "until": null } },
        "state": null
      }
    }
  }
}
```

`status-doorbell.json`:

```json
{
  "source": "Ring knowledge base: amazon_vision_api/device_discovery.md (included device-status: key attribute online)",
  "substitutions": "<device_status_id>=st-1",
  "payload": { "data": { "type": "device-status", "id": "st-1", "attributes": { "online": true } } }
}
```

- [ ] **Step 3: Confirm Prettier leaves the fixtures alone or formats them stably**

Run: `pnpm prettier --write apps/events/test/fixtures/ring && pnpm prettier --check apps/events/test/fixtures/ring`
Expected: `All matched files use Prettier code style!` Nothing in this plan hashes a fixture file's bytes (HMAC tests use inline literals, Task 5), so reformatting is harmless; the check is only that `pnpm format` in CI stays green.

- [ ] **Step 4: File FL-058**

Run `grep -n '^### FL-' FRICTION-LOG.md | tail -3` and confirm FL-057 is last. Append:

```markdown
### FL-058 · Ring Partner API documentation · Four of the Ring design's assumptions were wrong, and the fixes were in documentation the research could not render

- **Expected:** The Ring design (spec 2026-09-26, built on research 2026-09-21) describes the link, the webhook signature, the envelope and the sensor events well enough to code against.
- **Actual:** Read through Ring's public knowledge server on 2026-09-27, the documentation contradicts it in four places: linking is a Token Exchange URL plus an Account Link URL with a mandatory partner sign-in and a URL-safe-Base64 nonce, not one POST; the webhook signature is `sha256=<hex>`, not Base64; the event type, device and timestamp live in `data.type`, `data.attributes.source` and epoch milliseconds, not the field names assumed; and sensor webhooks (`flood_detected` and the rest) are documented after all. The research had marked most of these "Unverified" because those sections of the web page did not render — the gap was real, and it was closed by a different reader of the same documentation.
- **Impact:** Built to the spec as written, the webhook receiver would have rejected every genuine Ring delivery with a 401 (which Ring never retries), and the link endpoint would have waited for a POST Ring never sends.
- **Workaround / decision:** Spec §12 amendment (A1–A6) and Plan 4's rulings R1–R12. Fixtures under `apps/events/test/fixtures/ring/` are Ring's own examples with the placeholders substituted, source path in every file.
- **The generalisable form.** "Unverified" in research is a debt with a due date: the day code is written against it. Pay it by reading the primary source, not by building an adapter flexible enough to not need to know.
- **Source:** Ring knowledge base paths listed in the spec's §12 · `docs/superpowers/research/2026-09-21-ring-partner-api.md` §10 (the unverified list) · Plan 4 header.
- **Status:** Resolved in the design. The live run (Plan 4 Task 18) is what verifies it against Ring rather than against Ring's documentation.
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-26-homeledger-ring-design.md apps/events/test/fixtures/ring FRICTION-LOG.md
git commit -m "docs(ring): amend the Ring design from Ring's own documentation, and add Ring's example payloads as fixtures (FL-058)"
```

No mutation step: this task changes no behaviour. Its fixtures are proven load-bearing by the decoder tests in Task 5, whose mutations fail against them.

---
### Task 2: Core schema, keys, and the push contract

**Files:**
- Modify: `packages/core/src/domain/schemas.ts`
- Create: `packages/core/src/domain/push.ts`
- Modify: `packages/core/src/repo/keys.ts`, `packages/core/src/index.ts`
- Modify (fixtures only — every literal that builds a `Visit`, `Alert` or `Device`): `packages/core/test/repository.contract.ts`, `packages/core/test/schemas.test.ts`, `apps/mcp-server/src/tools/service.ts` (the `putVisit` in `book_service`), `apps/mcp-server/test/events.test.ts`, `apps/mcp-server/test/visits.test.ts`, `apps/mcp-server/test/timezone.test.ts`
- Test: `packages/core/test/schemas.test.ts`, `packages/core/test/keys.test.ts`, `packages/core/test/push.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (exact names later tasks import from `@homeledger/core`):
  - `SnapshotStatus` (zod enum `'ok' | 'encrypted' | 'none-in-window' | 'forbidden' | 'error'`), `type SnapshotStatusValue`
  - `Visit` gains `snapshotStatus: SnapshotStatusValue | null` and `snapshotLatencyMs: number | null`
  - `AlertSensorType` (zod enum adding `'system'`), `type AlertSensorTypeValue`; `Alert` gains `severity: 'high' | 'info'`, `ringDeviceId: string | null`, `message: string | null`
  - `type SensorState = { flood: boolean; freeze: boolean }`; `Device` gains `sensorState: SensorState | null`
  - `ConnectionSchema`, `type Connection = { connectionId: string; connectedAt: string; expiresAt: number }` (`expiresAt` is epoch **seconds** — DynamoDB TTL's unit)
  - `sk.eventMarker(ringEventId)` → `EVENTID#<id>`; `sk.connection(connectionId)` → `CONN#<id>`
  - `PUSH_CARD_TYPES`, `PushPayloadSchema`, `type PushPayload = { cardType: 'visit.arrived' | 'alert.raised'; id: string }`, `parsePushPayload(raw: string): PushPayload | null`, `pushPayload(cardType, id): PushPayload` (throws on a mismatched pair)

**Why the push payload lives in core.** It is a contract between two packages that never import each other — the push Lambda writes it and the simulator's server reads it. FL-046 is why a hand-typed copy on each side is not acceptable: a consumer fixture written to match a producer looks like a pin and is not one. `NOT_BOOKED` in this same file set the precedent.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/schemas.test.ts` (keep the existing tests; the imports line gains `AlertSchema, ConnectionSchema, DeviceSchema, SnapshotStatus`):

```ts
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
```

Also update the existing `'rejects an unknown visit status'` test in the same file (the one whose object has `status: 'lost'`): add `snapshotStatus: null, snapshotLatencyMs: null,` after `description: null,`. **Why this matters:** without the two new fields that object would fail to parse *because of the missing fields*, so the test would pass whatever `VisitStatus` said — the "unreachable branch" shape. After the edit it can only throw because of `'lost'`.

Append to `packages/core/test/keys.test.ts`, inside the existing `describe`:

```ts
  it('builds the event marker and connection keys', () => {
    expect(sk.eventMarker('req-bp-0001')).toBe('EVENTID#req-bp-0001');
    expect(sk.connection('Ab1=')).toBe('CONN#Ab1=');
  });
```

Create `packages/core/test/push.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PUSH_CARD_TYPES, parsePushPayload, pushPayload } from '../src/index.js';

describe('the push payload contract', () => {
  it('names exactly the two card types the spec names', () => {
    expect([...PUSH_CARD_TYPES]).toEqual(['visit.arrived', 'alert.raised']);
  });

  it('parses a pointer to a visit and a pointer to an alert', () => {
    expect(parsePushPayload('{"cardType":"visit.arrived","id":"visit_abcdefghijklmnop"}')).toEqual({ cardType: 'visit.arrived', id: 'visit_abcdefghijklmnop' });
    expect(parsePushPayload('{"cardType":"alert.raised","id":"alert_abcdefghijklmnop"}')).toEqual({ cardType: 'alert.raised', id: 'alert_abcdefghijklmnop' });
  });

  it('refuses a card type that does not match the record it points at', () => {
    expect(parsePushPayload('{"cardType":"visit.arrived","id":"alert_abcdefghijklmnop"}')).toBeNull();
    expect(() => pushPayload('alert.raised', 'visit_abcdefghijklmnop')).toThrow(/alert\.raised.*visit_abcdefghijklmnop/);
  });

  it('refuses anything carrying more than a pointer', () => {
    // The spec's push is "a pointer only": the agent reads the record over MCP.
    // A payload that carries the description would let the display show text
    // the MCP server never returned.
    expect(parsePushPayload('{"cardType":"visit.arrived","id":"visit_abcdefghijklmnop","description":"A plumber"}')).toBeNull();
  });

  it('refuses text that is not JSON, and JSON that is not an object', () => {
    expect(parsePushPayload('visit.arrived visit_abcdefghijklmnop')).toBeNull();
    expect(parsePushPayload('null')).toBeNull();
    expect(parsePushPayload('"visit.arrived"')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @homeledger/core test -- schemas keys push`
Expected: FAIL — `SnapshotStatus`, `ConnectionSchema`, `sk.eventMarker`, `parsePushPayload` are not exported.

- [ ] **Step 3: Implement**

In `packages/core/src/domain/schemas.ts`:

Add after `VisitStatus`:

```ts
/**
 * What happened when HomeLedger asked Ring for the doorbell photo at an
 * arrival (spec §5, amendment §12.5). Every value maps to a plain sentence on
 * the card (`snapshotSentence`); none may render as a blank.
 */
export const SnapshotStatus = z.enum(['ok', 'encrypted', 'none-in-window', 'forbidden', 'error']);
```

In `VisitSchema`, after `description: z.string().nullable(),` add:

```ts
  snapshotStatus: SnapshotStatus.nullable(),
  snapshotLatencyMs: z.number().int().nonnegative().nullable(),
```

Replace the `AlertSchema` block with:

```ts
/**
 * `system` alerts are HomeLedger's own failures made visible — Ring access
 * lapsed, a home event that could not be processed. They carry their own
 * `message` because there is no sensor to name. A sensor alert's `message` is
 * null and its sentence is built from the sensor type and device name.
 */
export const AlertSensorType = z.enum(['flood', 'freeze', 'contact', 'temperature', 'air_quality', 'system']);
export const AlertSchema = z.object({
  id: prefixed('alert'),
  sensorType: AlertSensorType,
  severity: z.enum(['high', 'info']),
  ringDeviceId: z.string().min(1).nullable(),
  message: z.string().min(1).nullable(),
  deviceName: z.string().min(1),
  at: isoDateTime,
  maintenanceRef: z.object({ applianceId: prefixed('appl'), taskType: TaskType }).nullable(),
  status: z.enum(['open', 'acknowledged', 'resolved'])
});
```

In `DeviceSchema`, after `lastSeenAt: isoDateTime.nullable()` add a comma and:

```ts
  /** Last known detector state for a Flood & Freeze sensor; null for anything else. Transitions are computed against this, so a trip alerts once however many paths report it (amendment §12.4). */
  sensorState: z.object({ flood: z.boolean(), freeze: z.boolean() }).nullable()
```

After `DeviceSchema` add:

```ts
/** One display's live WebSocket connection. `expiresAt` is epoch seconds because DynamoDB TTL reads seconds; API Gateway closes a WebSocket at two hours regardless. */
export const ConnectionSchema = z.object({
  connectionId: z.string().min(1),
  connectedAt: isoDateTime,
  expiresAt: z.number().int().positive()
});
```

At the end of the type exports add:

```ts
export type SnapshotStatusValue = z.infer<typeof SnapshotStatus>;
export type AlertSensorTypeValue = z.infer<typeof AlertSensorType>;
export type SensorState = NonNullable<Device['sensorState']>;
export type Connection = z.infer<typeof ConnectionSchema>;
```

Create `packages/core/src/domain/push.ts`:

```ts
import * as z from 'zod/v4';

/**
 * What the push Lambda sends a display and what the simulator's server reads:
 * a pointer, never the record. The display runs an agent turn that reads the
 * record over MCP, so everything a person sees came back from the MCP server
 * (spec §7, FL-039). Shared here rather than typed twice for the reason
 * `NOT_BOOKED` is (FL-046).
 */
export const PUSH_CARD_TYPES = ['visit.arrived', 'alert.raised'] as const;

const PREFIX_FOR: Record<(typeof PUSH_CARD_TYPES)[number], string> = { 'visit.arrived': 'visit_', 'alert.raised': 'alert_' };

export const PushPayloadSchema = z
  .object({ cardType: z.enum(PUSH_CARD_TYPES), id: z.string().regex(/^(visit|alert)_[a-z2-7]{16}$/) })
  .strict()
  .refine(p => p.id.startsWith(PREFIX_FOR[p.cardType]), { error: 'cardType does not match the record id' });

export type PushPayload = z.infer<typeof PushPayloadSchema>;

export function parsePushPayload(raw: string): PushPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = PushPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function pushPayload(cardType: PushPayload['cardType'], id: string): PushPayload {
  const parsed = PushPayloadSchema.safeParse({ cardType, id });
  if (!parsed.success) throw new Error(`Not a valid push: ${cardType} ${id}`);
  return parsed.data;
}
```

In `packages/core/src/repo/keys.ts`, add two entries to `sk` after `device`:

```ts
  device: (ringDeviceId: string) => `DEVICE#${ringDeviceId}`,
  eventMarker: (ringEventId: string) => `EVENTID#${ringEventId}`,
  connection: (connectionId: string) => `CONN#${connectionId}`
```

In `packages/core/src/index.ts`, after `export * from './domain/time.js';` add:

```ts
export * from './domain/push.js';
```

- [ ] **Step 4: Update every fixture that builds these records**

The types now require the new fields, so the tree does not typecheck until every literal carries them. Each edit below adds fields with their "nothing happened yet" value and changes nothing else.

- `packages/core/test/repository.contract.ts`: in `visit()`, after `description: null,` add `snapshotStatus: null,` and `snapshotLatencyMs: null,`. In `alert()`, after `sensorType: 'freeze',` add `severity: 'high',`, `ringDeviceId: 'ava1.ring.device.9',`, `message: null,`. In `device()`, after `lastSeenAt: …,` add `sensorState: null,`.
- `apps/mcp-server/src/tools/service.ts`: in `book_service`'s `putVisit({...})`, after `description: null,` add `snapshotStatus: null,` and `snapshotLatencyMs: null,`.
- `apps/mcp-server/test/events.test.ts`: both `putVisit` literals gain `snapshotStatus: null, snapshotLatencyMs: null,` after `description: null,`; the `putAlert` literal gains `severity: 'high', ringDeviceId: null, message: null,` after `sensorType: 'freeze',`.
- `apps/mcp-server/test/visits.test.ts`: all three `putVisit` literals gain `snapshotStatus: null, snapshotLatencyMs: null,` after `description: null,`. (Task 15 changes the arrived one's values.)
- `apps/mcp-server/test/timezone.test.ts`: the visit literal gains `snapshotStatus: null, snapshotLatencyMs: null,` after `description: null,`.

Find any literal this list missed:

Run: `grep -rn --include='*.ts' -E "description: null,$" apps packages scripts | grep -v node_modules | grep -v /dist/`
Expected: every hit is followed on the next line by `snapshotStatus:` (check with `grep -A1`).

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm --filter @homeledger/core build && pnpm --filter @homeledger/core test && pnpm --filter @homeledger/mcp-server typecheck && pnpm --filter @homeledger/mcp-server test`
Expected: PASS everywhere.

- [ ] **Step 6: Mutation check**

Apply each, run `pnpm --filter @homeledger/core test`, record the failing count and names, revert:
1. Remove `'forbidden'` from `SnapshotStatus` → the "every snapshot status" test fails.
2. Remove `.int()` from `snapshotLatencyMs` → "refuses a negative or fractional" fails.
3. Remove the `.refine(...)` from `PushPayloadSchema` → "refuses a card type that does not match" fails (both assertions).
4. Remove `.strict()` → "refuses anything carrying more than a pointer" fails.
5. Change `eventMarker` to `` `EVENT#${ringEventId}` `` → the keys test fails.
6. Revert only the Step 1 edit to the `'lost'` visit test (drop the two new fields again) and change `VisitStatus` to include `'lost'` → the old test still passes. That is the unfailable shape the edit exists to remove; with the edit in place and `'lost'` added, it fails. Record both runs.

- [ ] **Step 7: Commit**

```bash
git add packages/core apps/mcp-server/src/tools/service.ts apps/mcp-server/test
git commit -m "feat(core): snapshot status, system alerts, sensor state, push connections, and the push payload contract"
```

---
### Task 3: Core repository — nine methods, both implementations, one contract

**Files:**
- Modify: `packages/core/src/repo/repository.ts`, `packages/core/src/repo/memory.ts`, `packages/core/src/repo/dynamo.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/repository.contract.ts` (new cases run against memory always, and against DynamoDB Local in CI's `test:dynamo`)

**Interfaces:**
- Consumes: Task 2's types and `sk.eventMarker`, `sk.connection`.
- Produces — added to `Repository` (exact signatures):

```ts
export interface VisitSnapshot {
  snapshotKey: string | null;
  snapshotStatus: SnapshotStatusValue;
  description: string | null;
  snapshotLatencyMs: number;
}

getDevice(ringDeviceId: string): Promise<Device | null>;
claimEvent(e: Event): Promise<'new' | 'retry' | 'published'>;
markEventPublished(ringEventId: string): Promise<void>;
markVisitArrived(visitId: string, arrivedAt: string, ringEventId: string): Promise<'arrived' | 'not-scheduled'>;
recordVisitSnapshot(visitId: string, snapshot: VisitSnapshot): Promise<void>;
findOpenAlert(ringDeviceId: string, sensorType: AlertSensorTypeValue): Promise<Alert | null>;
putConnection(c: Connection): Promise<void>;
deleteConnection(connectionId: string): Promise<void>;
listConnections(nowEpochSeconds: number): Promise<Connection[]>;
```

`VisitSnapshot` is exported from `@homeledger/core` as a type.

**The two properties that matter, and why they are conditional writes rather than read-then-write:**

- `claimEvent` implements spec §4 step 3 exactly: a redelivery of an event already on the bus answers `'published'` (the webhook returns 200 and drops it); a redelivery of an event recorded but never published answers `'retry'` (the webhook publishes again). The marker and the event row are written in **one transaction**, which closes the gap the survey found in `putEvent` — a crash between its two writes left a marker with no row, and the retry then reported `'duplicate'` and the event was lost.
- `markVisitArrived` is conditional on `status = scheduled`, so a `button_press` and a `motion_detected` for the same arrival, delivered concurrently to two Lambda instances, produce exactly one `'arrived'` (spec §5 "Arrive").

- [ ] **Step 1: Write the failing contract cases**

In `packages/core/test/repository.contract.ts`, extend the type import to `import type { Alert, Appliance, Connection, Device, Event, MaintenanceItem, Visit } from '../src/domain/schemas.js';` and append these cases inside `runRepositoryContract`'s `describe`, after the last existing `it`:

```ts
    it('claims a webhook event once, lets an unpublished one through again, and drops a published one', async () => {
      const e = event({ ringEventId: 'req-bp-0001' });
      expect(await repo.claimEvent(e)).toBe('new');
      expect(await repo.claimEvent(e)).toBe('retry');
      expect((await repo.listEvents('2026-09-22T00:00:00.000Z')).map(x => x.id)).toEqual([e.id]);
      await repo.markEventPublished('req-bp-0001');
      expect(await repo.claimEvent(e)).toBe('published');
      expect(await repo.claimEvent(event({ id: 'evt_bbbbbbbbbbbbbbbb', ringEventId: 'req-bp-0002' }))).toBe('new');
    });

    it('marks a scheduled visit arrived exactly once, and never a visit that is not scheduled', async () => {
      await repo.putVisit(visit());
      expect(await repo.markVisitArrived('visit_aaaaaaaaaaaaaaaa', '2026-09-22T13:20:00.000Z', 'req-bp-0001')).toBe('arrived');
      expect(await repo.markVisitArrived('visit_aaaaaaaaaaaaaaaa', '2026-09-22T13:20:05.000Z', 'req-mo-0001')).toBe('not-scheduled');
      const after = await repo.getVisit('visit_aaaaaaaaaaaaaaaa');
      expect(after?.status).toBe('arrived');
      expect(after?.arrivedAt).toBe('2026-09-22T13:20:00.000Z');
      expect(after?.ringEventIds).toEqual(['req-bp-0001']);
      // Still findable by window: the arrival must not knock it out of the visit index.
      expect((await repo.listVisitsInWindow('2026-09-22T12:30:00.000Z', '2026-09-22T15:30:00.000Z')).map(v => v.status)).toEqual(['arrived']);
      expect(await repo.markVisitArrived('visit_zzzzzzzzzzzzzzzz', '2026-09-22T13:20:00.000Z', 'req-bp-0003')).toBe('not-scheduled');
      await repo.putVisit(visit({ id: 'visit_bbbbbbbbbbbbbbbb', status: 'completed' }));
      expect(await repo.markVisitArrived('visit_bbbbbbbbbbbbbbbb', '2026-09-22T13:20:00.000Z', 'req-bp-0004')).toBe('not-scheduled');
    });

    it('records a snapshot outcome on a visit, and refuses a visit that does not exist', async () => {
      await repo.putVisit(visit({ status: 'arrived', arrivedAt: '2026-09-22T13:20:00.000Z' }));
      await repo.recordVisitSnapshot('visit_aaaaaaaaaaaaaaaa', {
        snapshotKey: 'snapshots/hh_test/visit_aaaaaaaaaaaaaaaa.jpg',
        snapshotStatus: 'ok',
        description: 'A person holding a toolbox stands at the front door.',
        snapshotLatencyMs: 4200
      });
      const after = await repo.getVisit('visit_aaaaaaaaaaaaaaaa');
      expect(after?.snapshotKey).toBe('snapshots/hh_test/visit_aaaaaaaaaaaaaaaa.jpg');
      expect(after?.snapshotStatus).toBe('ok');
      expect(after?.description).toBe('A person holding a toolbox stands at the front door.');
      expect(after?.snapshotLatencyMs).toBe(4200);
      expect(after?.status).toBe('arrived');
      await expect(
        repo.recordVisitSnapshot('visit_zzzzzzzzzzzzzzzz', { snapshotKey: null, snapshotStatus: 'error', description: null, snapshotLatencyMs: 10 })
      ).rejects.toThrow('No visit visit_zzzzzzzzzzzzzzzz');
    });

    it('reads one device by its Ring id', async () => {
      await repo.putDevice(device({ ringDeviceId: 'dev-flood-1', name: 'Water Heater', kind: 'sensor', sensorState: { flood: false, freeze: false } }));
      expect((await repo.getDevice('dev-flood-1'))?.sensorState).toEqual({ flood: false, freeze: false });
      expect(await repo.getDevice('dev-missing')).toBeNull();
    });

    it('finds the newest open alert for one device and sensor type, and nothing else', async () => {
      await repo.putAlert(alert({ id: 'alert_aaaaaaaaaaaaaaaa', sensorType: 'flood', ringDeviceId: 'dev-flood-1', at: '2026-10-06T21:15:00.000Z' }));
      await repo.putAlert(alert({ id: 'alert_bbbbbbbbbbbbbbbb', sensorType: 'flood', ringDeviceId: 'dev-flood-1', at: '2026-10-06T22:00:00.000Z' }));
      await repo.putAlert(alert({ id: 'alert_cccccccccccccccc', sensorType: 'flood', ringDeviceId: 'dev-flood-1', at: '2026-10-06T23:00:00.000Z', status: 'resolved' }));
      await repo.putAlert(alert({ id: 'alert_dddddddddddddddd', sensorType: 'freeze', ringDeviceId: 'dev-flood-1', at: '2026-10-07T00:00:00.000Z' }));
      await repo.putAlert(alert({ id: 'alert_eeeeeeeeeeeeeeee', sensorType: 'flood', ringDeviceId: 'dev-flood-2', at: '2026-10-07T01:00:00.000Z' }));
      expect((await repo.findOpenAlert('dev-flood-1', 'flood'))?.id).toBe('alert_bbbbbbbbbbbbbbbb');
      expect(await repo.findOpenAlert('dev-flood-3', 'flood')).toBeNull();
    });

    it('keeps live display connections, hides expired ones, and forgets a closed one', async () => {
      const live: Connection = { connectionId: 'Ab1=', connectedAt: '2026-10-06T13:00:00.000Z', expiresAt: 2_000 };
      await repo.putConnection(live);
      await repo.putConnection({ connectionId: 'Cd2=', connectedAt: '2026-10-06T11:00:00.000Z', expiresAt: 1_000 });
      // Exactly the stored shape: no TTL attribute or key leaking back out.
      expect(await repo.listConnections(1_500)).toEqual([live]);
      await repo.deleteConnection('Ab1=');
      expect(await repo.listConnections(1_500)).toEqual([]);
    });

    it('resetHousehold also forgets connections and event markers', async () => {
      await repo.putConnection({ connectionId: 'Ab1=', connectedAt: '2026-10-06T13:00:00.000Z', expiresAt: 2_000 });
      await repo.claimEvent(event({ ringEventId: 'req-bp-0001' }));
      await repo.resetHousehold();
      expect(await repo.listConnections(0)).toEqual([]);
      expect(await repo.claimEvent(event({ ringEventId: 'req-bp-0001' }))).toBe('new');
    });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @homeledger/core test -- memory`
Expected: FAIL — `repo.claimEvent is not a function` (and the rest).

- [ ] **Step 3: Extend the port**

In `packages/core/src/repo/repository.ts`, extend the import to include `AlertSensorTypeValue, Connection, SnapshotStatusValue`, add before the interface:

```ts
/** What the visit correlator writes back once the snapshot attempt settles (spec §5). */
export interface VisitSnapshot {
  snapshotKey: string | null;
  snapshotStatus: SnapshotStatusValue;
  description: string | null;
  snapshotLatencyMs: number;
}
```

and append to the interface, after `listDevices()`:

```ts
  getDevice(ringDeviceId: string): Promise<Device | null>;
  /**
   * Records one webhook delivery (spec §4 step 3). 'new': first sight; marker
   * and row written together. 'retry': seen before but never published; the
   * row is rewritten and the caller publishes again. 'published': already on
   * the bus; the caller answers 200 and stops.
   */
  claimEvent(e: Event): Promise<'new' | 'retry' | 'published'>;
  markEventPublished(ringEventId: string): Promise<void>;
  /** scheduled -> arrived, conditionally: a press and a motion event for the same arrival produce one 'arrived'. */
  markVisitArrived(visitId: string, arrivedAt: string, ringEventId: string): Promise<'arrived' | 'not-scheduled'>;
  /** Throws `No visit <id>` when the visit does not exist. */
  recordVisitSnapshot(visitId: string, snapshot: VisitSnapshot): Promise<void>;
  findOpenAlert(ringDeviceId: string, sensorType: AlertSensorTypeValue): Promise<Alert | null>;
  putConnection(c: Connection): Promise<void>;
  deleteConnection(connectionId: string): Promise<void>;
  /** Connections whose expiresAt is after `nowEpochSeconds`. TTL deletion lags by up to two days, so expiry is enforced on read. */
  listConnections(nowEpochSeconds: number): Promise<Connection[]>;
```

In `packages/core/src/index.ts`, change `export type { Repository } from './repo/repository.js';` to `export type { Repository, VisitSnapshot } from './repo/repository.js';`.

- [ ] **Step 4: Implement the memory repository**

In `packages/core/src/repo/memory.ts`, extend the type import with `Connection`, and add beside the other maps:

```ts
  const published = new Set<string>(); // ringEventIds already on the bus
  const connections = new Map<string, Connection>();
```

In `resetHousehold`, add `published.clear();` and `connections.clear();`. Append these methods to the returned object, after `listDevices`:

```ts
    async getDevice(ringDeviceId) {
      return devices.get(ringDeviceId) ?? null;
    },
    async claimEvent(e) {
      if (!events.has(e.ringEventId)) {
        events.set(e.ringEventId, e);
        return 'new';
      }
      if (published.has(e.ringEventId)) return 'published';
      events.set(e.ringEventId, e);
      return 'retry';
    },
    async markEventPublished(ringEventId) {
      published.add(ringEventId);
    },
    async markVisitArrived(visitId, arrivedAt, ringEventId) {
      const v = visits.get(visitId);
      if (!v || v.status !== 'scheduled') return 'not-scheduled';
      visits.set(visitId, { ...v, status: 'arrived', arrivedAt, ringEventIds: [...v.ringEventIds, ringEventId] });
      return 'arrived';
    },
    async recordVisitSnapshot(visitId, snapshot) {
      const v = visits.get(visitId);
      if (!v) throw new Error(`No visit ${visitId}`);
      visits.set(visitId, { ...v, ...snapshot });
    },
    async findOpenAlert(ringDeviceId, sensorType) {
      return (
        [...alerts.values()]
          .filter(a => a.ringDeviceId === ringDeviceId && a.sensorType === sensorType && a.status === 'open')
          .sort((x, y) => y.at.localeCompare(x.at))[0] ?? null
      );
    },
    async putConnection(c) {
      connections.set(c.connectionId, c);
    },
    async deleteConnection(connectionId) {
      connections.delete(connectionId);
    },
    async listConnections(nowEpochSeconds) {
      return [...connections.values()].filter(c => c.expiresAt > nowEpochSeconds);
    }
```

- [ ] **Step 5: Run the memory contract**

Run: `pnpm --filter @homeledger/core test -- memory`
Expected: PASS.

- [ ] **Step 6: Implement the DynamoDB repository**

In `packages/core/src/repo/dynamo.ts`:

Change the lib-dynamodb import to:

```ts
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
```

and the schema import to add `Connection`. In `strip`, add `ttl: _ttl` to the destructured names (a connection row carries the TTL attribute, and it must not leak back out as a field — the contract test's `toEqual([live])` pins this):

```ts
  const { PK: _pk, SK: _sk, GSI1PK: _g1p, GSI1SK: _g1s, GSI2PK: _g2p, GSI2SK: _g2s, entity: _e, ttl: _ttl, ...rest } = item;
```

Add a helper inside `createDynamoRepository`, after `queryPrefix`:

```ts
  const isConditionFailure = (err: unknown): boolean => (err as { name?: string }).name === 'ConditionalCheckFailedException';
```

In the existing `putEvent`, replace the literal `` `EVENTID#${e.ringEventId}` `` with `sk.eventMarker(e.ringEventId)` (same string; one definition).

Append these methods after `listDevices`:

```ts
    async getDevice(ringDeviceId) {
      return get<Device>(sk.device(ringDeviceId));
    },
    async claimEvent(e) {
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: T,
                  Item: { PK: P, SK: sk.eventMarker(e.ringEventId), entity: 'event_marker', eventId: e.id, published: false },
                  ConditionExpression: 'attribute_not_exists(PK)'
                }
              },
              { Put: { TableName: T, Item: { PK: P, SK: sk.event(e.at, e.id), entity: 'event', ...e } } }
            ]
          })
        );
        return 'new';
      } catch (err) {
        // A transaction whose condition fails is cancelled as a whole and
        // reports TransactionCanceledException, not ConditionalCheckFailedException.
        if ((err as { name?: string }).name !== 'TransactionCanceledException') throw err;
      }
      const marker = await doc.send(new GetCommand({ TableName: T, Key: { PK: P, SK: sk.eventMarker(e.ringEventId) } }));
      if (marker.Item?.published === true) return 'published';
      await put(sk.event(e.at, e.id), 'event', e);
      return 'retry';
    },
    async markEventPublished(ringEventId) {
      await doc.send(
        new UpdateCommand({
          TableName: T,
          Key: { PK: P, SK: sk.eventMarker(ringEventId) },
          UpdateExpression: 'SET published = :t',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':t': true }
        })
      );
    },
    async markVisitArrived(visitId, arrivedAt, ringEventId) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: T,
            Key: { PK: P, SK: sk.visit(visitId) },
            UpdateExpression: 'SET #status = :arrived, arrivedAt = :at, ringEventIds = list_append(if_not_exists(ringEventIds, :empty), :ev)',
            ConditionExpression: 'attribute_exists(PK) AND #status = :scheduled',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':arrived': 'arrived', ':scheduled': 'scheduled', ':at': arrivedAt, ':empty': [], ':ev': [ringEventId] }
          })
        );
        return 'arrived';
      } catch (err) {
        if (isConditionFailure(err)) return 'not-scheduled';
        throw err;
      }
    },
    async recordVisitSnapshot(visitId, snapshot) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: T,
            Key: { PK: P, SK: sk.visit(visitId) },
            UpdateExpression: 'SET snapshotKey = :k, snapshotStatus = :s, description = :d, snapshotLatencyMs = :l',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeValues: { ':k': snapshot.snapshotKey, ':s': snapshot.snapshotStatus, ':d': snapshot.description, ':l': snapshot.snapshotLatencyMs }
          })
        );
      } catch (err) {
        if (isConditionFailure(err)) throw new Error(`No visit ${visitId}`);
        throw err;
      }
    },
    async findOpenAlert(ringDeviceId, sensorType) {
      const all = await queryPrefix<Alert>('ALERT#');
      return all.filter(a => a.ringDeviceId === ringDeviceId && a.sensorType === sensorType && a.status === 'open').sort((x, y) => y.at.localeCompare(x.at))[0] ?? null;
    },
    async putConnection(c) {
      await put(sk.connection(c.connectionId), 'connection', c, { ttl: c.expiresAt });
    },
    async deleteConnection(connectionId) {
      await doc.send(new DeleteCommand({ TableName: T, Key: { PK: P, SK: sk.connection(connectionId) } }));
    },
    async listConnections(nowEpochSeconds) {
      const all = await queryPrefix<Connection>('CONN#');
      return all.filter(c => c.expiresAt > nowEpochSeconds);
    }
```

- [ ] **Step 7: Run both contracts**

Run: `docker compose up -d dynamodb && pnpm --filter @homeledger/core build && pnpm --filter @homeledger/core test && pnpm --filter @homeledger/core test:dynamo`
Expected: PASS for memory and dynamo. (If Docker is unavailable locally, `test:dynamo` runs in CI's `test` job against its `dynamodb` service; say so in the report rather than skipping silently.)

- [ ] **Step 8: Mutation check**

Apply each to **both** implementations where it applies, run memory (and dynamo where available), record, revert:
1. `markVisitArrived`: drop the `status === 'scheduled'` guard (memory) / `AND #status = :scheduled` (dynamo) → "marks a scheduled visit arrived exactly once" fails on the second call and on the completed visit.
2. `claimEvent`: return `'retry'` where it returns `'published'` → the claim test fails at `toBe('published')`.
3. Dynamo `claimEvent`: drop the event-row `Put` from the transaction → the claim test's `listEvents` assertion fails (dynamo run).
4. Dynamo `strip`: remove `ttl: _ttl` → the connections test's `toEqual([live])` fails (dynamo run).
5. `listConnections`: drop the expiry filter → the connections test fails.
6. `findOpenAlert`: sort ascending → returns `alert_aaaa…` and fails.
7. `recordVisitSnapshot`: in dynamo, drop the `ConditionExpression` → the missing-visit assertion fails (an update without a condition creates an item).

- [ ] **Step 9: Commit**

```bash
git add packages/core
git commit -m "feat(core): claim webhook events once, mark visits arrived conditionally, snapshot outcomes, open alerts, and display connections"
```

---
### Task 4: Core rules — arrival matching, snapshot sentences, sensor transitions and decisions

Pure functions only. Everything that decides something lives here, so the Lambdas in Tasks 10 and 11 are wiring and the MCP server in Task 15 speaks the same sentences the correlator stored.

**Files:**
- Create: `packages/core/src/domain/arrival.ts`, `packages/core/src/domain/sensors.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/arrival.test.ts`, `packages/core/test/sensors.test.ts`

**Interfaces:**
- Consumes: `Visit`, `SnapshotStatus`, `SnapshotStatusValue`, `SensorState`, `MaintenanceItem` (Task 2).
- Produces:

```ts
// arrival.ts
export const ARRIVAL_SLACK_MS: number; // 1_800_000
export function arrivalWindowFor(eventAtIso: string): { fromIso: string; toIso: string };
export function pickArrivalVisit(candidates: readonly Visit[], eventAtIso: string): Visit | null;
export function snapshotSentence(status: SnapshotStatusValue | null): string | null;
export function arrivalMatchNote(input: { windowLabel: string; providerName: string }): string;

// sensors.ts
export type SensorChangeKind = 'flood' | 'freeze' | 'contact';
export interface SensorChanged { ringDeviceId: string; kind: SensorChangeKind; state: 'triggered' | 'cleared'; at: string; source: 'webhook' | 'poll' }
export const SENSOR_EVENT_TYPES: Readonly<Record<string, { kind: SensorChangeKind; state: 'triggered' | 'cleared' }>>;
export const NO_SENSOR_STATE: SensorState; // { flood: false, freeze: false }
export const SENSOR_TASK_TYPE: 'inspection';
export function sensorTransitions(input: { ringDeviceId: string; previous: SensorState | null; observed: Partial<SensorState>; at: string; source: 'webhook' | 'poll' }): { changes: SensorChanged[]; next: SensorState };
export type SensorDecision =
  | { action: 'raise'; sensorType: SensorChangeKind; severity: 'high' | 'info'; maintenanceNote: string | null }
  | { action: 'resolve'; sensorType: SensorChangeKind };
export function decideSensorChange(change: SensorChanged, location: string): SensorDecision;
export function advanceMaintenanceForSensor(existing: MaintenanceItem | null, input: { applianceId: string; today: string; note: string; intervalDays: number }): MaintenanceItem;
```

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/arrival.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ARRIVAL_SLACK_MS, SnapshotStatus, arrivalMatchNote, arrivalWindowFor, pickArrivalVisit, snapshotSentence } from '../src/index.js';
import { visit } from './repository.contract.js';

// 8–10 AM US Central on a day in daylight time: 13:00Z–15:00Z.
const booked = visit({ id: 'visit_aaaaaaaaaaaaaaaa', windowStart: '2026-10-06T13:00:00.000Z', windowEnd: '2026-10-06T15:00:00.000Z' });

describe('arrival matching (spec §5: a scheduled visit whose window covers the event ±30 min)', () => {
  it('uses a thirty-minute slack', () => {
    expect(ARRIVAL_SLACK_MS).toBe(1_800_000);
    expect(arrivalWindowFor('2026-10-06T13:20:00.000Z')).toEqual({ fromIso: '2026-10-06T12:50:00.000Z', toIso: '2026-10-06T13:50:00.000Z' });
  });

  it('matches exactly at both edges and not one millisecond past either', () => {
    expect(pickArrivalVisit([booked], '2026-10-06T12:30:00.000Z')?.id).toBe('visit_aaaaaaaaaaaaaaaa');
    expect(pickArrivalVisit([booked], '2026-10-06T12:29:59.999Z')).toBeNull();
    expect(pickArrivalVisit([booked], '2026-10-06T15:30:00.000Z')?.id).toBe('visit_aaaaaaaaaaaaaaaa');
    expect(pickArrivalVisit([booked], '2026-10-06T15:30:00.001Z')).toBeNull();
  });

  it('compares instants, so a window booked across the end of daylight time still matches correctly', () => {
    // 2026-11-01 is the US fall-back day. 8–10 AM Central that morning is
    // 14:00Z–16:00Z (standard time), an hour later in UTC than in October.
    const fallBack = visit({ id: 'visit_bbbbbbbbbbbbbbbb', windowStart: '2026-11-01T14:00:00.000Z', windowEnd: '2026-11-01T16:00:00.000Z' });
    expect(pickArrivalVisit([fallBack], '2026-11-01T13:30:00.000Z')?.id).toBe('visit_bbbbbbbbbbbbbbbb'); // 7:30 AM CST
    expect(pickArrivalVisit([fallBack], '2026-11-01T13:29:00.000Z')).toBeNull(); // 7:29 AM CST
  });

  it('takes the visit whose window starts nearest the ring when windows overlap', () => {
    const early = visit({ id: 'visit_cccccccccccccccc', windowStart: '2026-10-06T12:00:00.000Z', windowEnd: '2026-10-06T16:00:00.000Z' });
    const near = visit({ id: 'visit_dddddddddddddddd', windowStart: '2026-10-06T13:30:00.000Z', windowEnd: '2026-10-06T15:30:00.000Z' });
    expect(pickArrivalVisit([early, near], '2026-10-06T13:20:00.000Z')?.id).toBe('visit_dddddddddddddddd');
    expect(pickArrivalVisit([near, early], '2026-10-06T13:20:00.000Z')?.id).toBe('visit_dddddddddddddddd');
  });

  it('breaks an exact tie by the earlier window start', () => {
    const before = visit({ id: 'visit_eeeeeeeeeeeeeeee', windowStart: '2026-10-06T13:10:00.000Z', windowEnd: '2026-10-06T14:00:00.000Z' });
    const after = visit({ id: 'visit_ffffffffffffffff', windowStart: '2026-10-06T13:30:00.000Z', windowEnd: '2026-10-06T14:00:00.000Z' });
    expect(pickArrivalVisit([after, before], '2026-10-06T13:20:00.000Z')?.id).toBe('visit_eeeeeeeeeeeeeeee');
  });

  it('ignores a visit that has already arrived or is not scheduled', () => {
    expect(pickArrivalVisit([{ ...booked, status: 'arrived' }], '2026-10-06T13:20:00.000Z')).toBeNull();
    expect(pickArrivalVisit([{ ...booked, status: 'missed' }], '2026-10-06T13:20:00.000Z')).toBeNull();
  });
});

describe('snapshot sentences (spec §5: every status is a plain sentence; none renders as a blank)', () => {
  it('gives every status its own non-empty sentence', () => {
    const sentences = SnapshotStatus.options.map(snapshotSentence);
    for (const s of sentences) expect(typeof s === 'string' && s.length > 0).toBe(true);
    expect(new Set(sentences).size).toBe(SnapshotStatus.options.length);
  });

  it('says what each outcome means, in words a household reads', () => {
    expect(snapshotSentence('ok')).toBe('Photo from the doorbell at the moment of the ring.');
    expect(snapshotSentence('encrypted')).toBe("The doorbell's video encryption kept the photo private, so there is no picture. The arrival was still recorded.");
    expect(snapshotSentence('none-in-window')).toBe('The doorbell had no picture from that moment.');
    expect(snapshotSentence('forbidden')).toBe('Ring did not allow HomeLedger to fetch a photo from that moment.');
    expect(snapshotSentence('error')).toBe('The doorbell photo could not be fetched.');
  });

  it('says nothing before an arrival', () => {
    expect(snapshotSentence(null)).toBeNull();
  });

  it('says the match came from the booking, not from the photo', () => {
    expect(arrivalMatchNote({ windowLabel: 'Tuesday, October 6, 8:00 to 10:00 AM CDT', providerName: 'Kettle Creek Water Heaters' })).toBe(
      'Matches your Tuesday, October 6, 8:00 to 10:00 AM CDT visit from Kettle Creek Water Heaters. HomeLedger matched it by the time of the ring, not by the photo.'
    );
  });
});
```

Create `packages/core/test/sensors.test.ts`:

```ts
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
    const r = sensorTransitions({ ringDeviceId: 'dev-flood-1', previous: { flood: true, freeze: false }, observed: { flood: true, freeze: false }, at, source: 'poll' });
    expect(r.changes).toEqual([]);
    expect(r.next).toEqual({ flood: true, freeze: false });
  });

  it('treats flood and freeze independently, both ways at once', () => {
    const r = sensorTransitions({ ringDeviceId: 'dev-flood-1', previous: { flood: true, freeze: false }, observed: { flood: false, freeze: true }, at, source: 'poll' });
    expect(r.changes).toEqual([
      { ringDeviceId: 'dev-flood-1', kind: 'flood', state: 'cleared', at, source: 'poll' },
      { ringDeviceId: 'dev-flood-1', kind: 'freeze', state: 'triggered', at, source: 'poll' }
    ]);
  });

  it('assumes all-clear for a device seen for the first time, so a first dry reading raises nothing', () => {
    expect(sensorTransitions({ ringDeviceId: 'dev-flood-1', previous: null, observed: { flood: false, freeze: false }, at, source: 'poll' }).changes).toEqual([]);
    expect(sensorTransitions({ ringDeviceId: 'dev-flood-1', previous: null, observed: { flood: true }, at, source: 'poll' }).changes).toHaveLength(1);
  });
});

describe('the rule table (spec §6)', () => {
  const change = (kind: SensorChanged['kind'], state: SensorChanged['state']): SensorChanged => ({ ringDeviceId: 'dev-flood-1', kind, state, at, source: 'webhook' });

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
    expect(decideSensorChange(change('contact', 'triggered'), 'Back Door')).toEqual({ action: 'raise', sensorType: 'contact', severity: 'info', maintenanceNote: null });
  });

  it('resolves the open alert on any clear', () => {
    for (const kind of ['flood', 'freeze', 'contact'] as const) expect(decideSensorChange(change(kind, 'cleared'), 'Water Heater')).toEqual({ action: 'resolve', sensorType: kind });
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
    expect(advanceMaintenanceForSensor(null, { applianceId: 'appl_waterheater22222', today: '2026-10-06', note: 'Check for a leak near the Water Heater.', intervalDays: 180 })).toEqual({
      applianceId: 'appl_waterheater22222',
      taskType: 'inspection',
      intervalDays: 180,
      lastDoneAt: null,
      nextDueAt: '2026-10-06',
      notes: 'Check for a leak near the Water Heater.'
    });
  });

  it('pulls a later due date forward to today and keeps its history', () => {
    const existing = maintenance({ applianceId: 'appl_waterheater22222', taskType: 'inspection', intervalDays: 180, lastDoneAt: '2026-03-01', nextDueAt: '2026-08-28' });
    const later = { ...existing, nextDueAt: '2026-12-01' };
    expect(advanceMaintenanceForSensor(later, { applianceId: 'appl_waterheater22222', today: '2026-10-06', note: 'n', intervalDays: 180 })).toEqual({ ...later, nextDueAt: '2026-10-06', notes: 'n' });
  });

  it('leaves an already-overdue date alone rather than making it look newer', () => {
    const overdue = maintenance({ applianceId: 'appl_waterheater22222', taskType: 'inspection', nextDueAt: '2026-08-28' });
    expect(advanceMaintenanceForSensor(overdue, { applianceId: 'appl_waterheater22222', today: '2026-10-06', note: 'n', intervalDays: 180 }).nextDueAt).toBe('2026-08-28');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @homeledger/core test -- arrival sensors`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Implement `arrival.ts`**

Create `packages/core/src/domain/arrival.ts`:

```ts
import type { SnapshotStatusValue, Visit } from './schemas.js';

/** Spec §5: the visit's window, widened by thirty minutes on each side. */
export const ARRIVAL_SLACK_MS = 30 * 60_000;

/**
 * The query range for `listVisitsInWindow`. That query returns every visit
 * whose window overlaps [from, to]; with from/to = event ± slack, "overlaps"
 * is exactly "the event falls inside the window ± slack", so the repository
 * returns the candidates and `pickArrivalVisit` chooses among them.
 */
export function arrivalWindowFor(eventAtIso: string): { fromIso: string; toIso: string } {
  const at = Date.parse(eventAtIso);
  return { fromIso: new Date(at - ARRIVAL_SLACK_MS).toISOString(), toIso: new Date(at + ARRIVAL_SLACK_MS).toISOString() };
}

/**
 * The scheduled visit a doorbell event belongs to, or null. Compares instants,
 * never calendar dates, so the household's zone and daylight time cannot move a
 * match. Several candidates: the one whose window starts nearest the event;
 * an exact tie goes to the earlier start.
 */
export function pickArrivalVisit(candidates: readonly Visit[], eventAtIso: string): Visit | null {
  const at = Date.parse(eventAtIso);
  const eligible = candidates.filter(
    v => v.status === 'scheduled' && Date.parse(v.windowStart) - ARRIVAL_SLACK_MS <= at && at <= Date.parse(v.windowEnd) + ARRIVAL_SLACK_MS
  );
  eligible.sort((x, y) => Math.abs(Date.parse(x.windowStart) - at) - Math.abs(Date.parse(y.windowStart) - at) || x.windowStart.localeCompare(y.windowStart));
  return eligible[0] ?? null;
}

const SENTENCES: Record<SnapshotStatusValue, string> = {
  ok: 'Photo from the doorbell at the moment of the ring.',
  encrypted: "The doorbell's video encryption kept the photo private, so there is no picture. The arrival was still recorded.",
  'none-in-window': 'The doorbell had no picture from that moment.',
  forbidden: 'Ring did not allow HomeLedger to fetch a photo from that moment.',
  error: 'The doorbell photo could not be fetched.'
};

/** The card's line for a snapshot outcome. Null only before an arrival. */
export function snapshotSentence(status: SnapshotStatusValue | null): string | null {
  return status === null ? null : SENTENCES[status];
}

/** Spec §5: the link to the booked provider comes from HomeLedger's matching, never from the image — and the card says so. */
export function arrivalMatchNote(input: { windowLabel: string; providerName: string }): string {
  return `Matches your ${input.windowLabel} visit from ${input.providerName}. HomeLedger matched it by the time of the ring, not by the photo.`;
}
```

- [ ] **Step 4: Implement `sensors.ts`**

Create `packages/core/src/domain/sensors.ts`:

```ts
import type { MaintenanceItem, SensorState } from './schemas.js';

export type SensorChangeKind = 'flood' | 'freeze' | 'contact';

/** Spec §6's normalised input. Emitted on transitions only. */
export interface SensorChanged {
  ringDeviceId: string;
  kind: SensorChangeKind;
  state: 'triggered' | 'cleared';
  at: string;
  source: 'webhook' | 'poll';
}

/** Ring's documented sensor event types (amendment §12.4). Tamper and threshold events are stored but not routed. */
export const SENSOR_EVENT_TYPES: Readonly<Record<string, { kind: SensorChangeKind; state: 'triggered' | 'cleared' }>> = {
  flood_detected: { kind: 'flood', state: 'triggered' },
  flood_cleared: { kind: 'flood', state: 'cleared' },
  freeze_detected: { kind: 'freeze', state: 'triggered' },
  freeze_cleared: { kind: 'freeze', state: 'cleared' },
  contact_sensor_faulted: { kind: 'contact', state: 'triggered' },
  contact_sensor_cleared: { kind: 'contact', state: 'cleared' }
};

export const NO_SENSOR_STATE: SensorState = { flood: false, freeze: false };

/** The maintenance task a flood or freeze opens (spec §6: "create or advance"). */
export const SENSOR_TASK_TYPE = 'inspection' as const;

/**
 * Compares one observation — a webhook's single detector, or a poll's two —
 * with the device's last known state. Only differences become changes, which
 * is what lets the webhook adapter and the reconciliation poll share one
 * device row without alerting twice for one trip. A device never seen before
 * is assumed dry and above freezing, so its first all-clear reading is silent.
 */
export function sensorTransitions(input: {
  ringDeviceId: string;
  previous: SensorState | null;
  observed: Partial<SensorState>;
  at: string;
  source: 'webhook' | 'poll';
}): { changes: SensorChanged[]; next: SensorState } {
  const base = input.previous ?? NO_SENSOR_STATE;
  const next: SensorState = { ...base };
  const changes: SensorChanged[] = [];
  for (const kind of ['flood', 'freeze'] as const) {
    const seen = input.observed[kind];
    if (seen === undefined) continue;
    next[kind] = seen;
    if (seen !== base[kind]) changes.push({ ringDeviceId: input.ringDeviceId, kind, state: seen ? 'triggered' : 'cleared', at: input.at, source: input.source });
  }
  return { changes, next };
}

export type SensorDecision =
  | { action: 'raise'; sensorType: SensorChangeKind; severity: 'high' | 'info'; maintenanceNote: string | null }
  | { action: 'resolve'; sensorType: SensorChangeKind };

/**
 * Spec §6's rule table. The notes describe property and maintenance only —
 * never safety, never reassurance (spec §7 content rule).
 */
export function decideSensorChange(change: SensorChanged, location: string): SensorDecision {
  if (change.state === 'cleared') return { action: 'resolve', sensorType: change.kind };
  switch (change.kind) {
    case 'flood':
      return { action: 'raise', sensorType: 'flood', severity: 'high', maintenanceNote: `Check for a leak near the ${location}.` };
    case 'freeze':
      return { action: 'raise', sensorType: 'freeze', severity: 'high', maintenanceNote: `Check pipe insulation near the ${location}.` };
    case 'contact':
      return { action: 'raise', sensorType: 'contact', severity: 'info', maintenanceNote: null };
  }
}

/**
 * Opens the appliance's inspection, or pulls it forward to today. An item that
 * is already overdue keeps its older date: moving it to today would make an
 * overdue task look newly due.
 */
export function advanceMaintenanceForSensor(
  existing: MaintenanceItem | null,
  input: { applianceId: string; today: string; note: string; intervalDays: number }
): MaintenanceItem {
  if (existing) return { ...existing, nextDueAt: existing.nextDueAt < input.today ? existing.nextDueAt : input.today, notes: input.note };
  return { applianceId: input.applianceId, taskType: SENSOR_TASK_TYPE, intervalDays: input.intervalDays, lastDoneAt: null, nextDueAt: input.today, notes: input.note };
}
```

In `packages/core/src/index.ts`, after the `push.js` export add:

```ts
export * from './domain/arrival.js';
export * from './domain/sensors.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @homeledger/core test`
Expected: PASS.

- [ ] **Step 6: Mutation check**

Apply each, run `pnpm --filter @homeledger/core test`, record, revert:
1. `<=` to `<` on the lower edge in `pickArrivalVisit` → the "exactly at both edges" test fails on `12:30:00.000Z`.
2. Replace `Date.parse` comparisons with string comparisons of `windowStart.slice(0, 10)` against the event date → the edge and daylight tests fail.
3. Remove the `status === 'scheduled'` filter → "ignores a visit that has already arrived" fails.
4. Delete the `|| x.windowStart.localeCompare(...)` tiebreak → the tie test fails (the input order puts the later start first).
5. Delete the `'forbidden'` entry from `SENTENCES` → typecheck fails (the `Record` is exhaustive) — record that the compiler is the guard here, and that the runtime "own non-empty sentence" test also fails under `// @ts-expect-error`.
6. In `sensorTransitions`, push a change whenever `seen` is defined (drop `seen !== base[kind]`) → "emits nothing when the observation repeats" fails.
7. In `advanceMaintenanceForSensor`, always set `nextDueAt: input.today` → "leaves an already-overdue date alone" fails.
8. Change the flood note to "Check for a leak near the Water Heater — make sure everyone is safe." → the content-rule test fails.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): arrival matching, snapshot sentences, and the sensor rule table as pure functions"
```

---
### Task 5: `apps/events` scaffold, HMAC, and the envelope decoder

**Files:**
- Create: `apps/events/package.json`, `apps/events/tsconfig.json`, `apps/events/vitest.config.ts`, `apps/events/build.mjs`
- Create: `apps/events/src/env.ts`, `apps/events/src/ring/hmac.ts`, `apps/events/src/ring/envelope.ts`
- Create: `apps/events/src/handlers/.gitkeep` (removed by Task 8 when the first handler lands; `build.mjs` must tolerate an empty directory until then)
- Create: `apps/events/test/fakes.ts`, `apps/events/test/hmac.test.ts`, `apps/events/test/envelope.test.ts`
- Modify: `.gitignore` (add `apps/events/dist/`) — check first with `git check-ignore apps/events/dist/x`; if `dist` is already ignored globally, skip.

**Interfaces:**
- Consumes: Task 1's fixtures.
- Produces:

```ts
// env.ts
export class EventsConfigError extends Error {}
export function requireEnv(name: string, source?: NodeJS.ProcessEnv): string;
export function optionalEnv(name: string, source?: NodeJS.ProcessEnv): string | undefined;
export function flagEnv(name: string, source?: NodeJS.ProcessEnv): boolean; // true only for '1' or 'true'

// ring/hmac.ts
export function webhookSignature(rawBody: Buffer, hmacKey: string): string; // 'sha256=<lowercase hex>'
export function verifyWebhookSignature(rawBody: Buffer, header: string | undefined, hmacKey: string): boolean;
export function linkNonce(timeMs: string, accountId: string, hmacKey: string): string; // URL-safe base64, no padding
export function verifyLinkNonce(nonce: string, timeMs: string, accountId: string, hmacKey: string): boolean;
export const LINK_WINDOW_MS: number; // 600_000
export function isFreshLinkTime(timeMs: string, nowMs: number): boolean;

// ring/envelope.ts
export interface RingWebhook { requestId: string; accountId: string | null; eventId: string | null; type: string; subType: string | null; deviceId: string | null; at: string }
export type DecodeResult = { ok: true; event: RingWebhook } | { ok: false; reason: string };
export function decodeWebhook(body: unknown, receivedAtIso: string): DecodeResult;

// test/fakes.ts
export function fixture<T = unknown>(name: string): T; // the file's .payload
```

**Why the HMAC tests pin literals.** A test that builds its expected signature by calling `webhookSignature` is self-referential: change the encoding in the helper and the expectation changes with it. Every digest below was computed once with `openssl` (the commands are in the test's comments) and is written in as a literal.

- [ ] **Step 1: Scaffold the package**

Create `apps/events/package.json`:

```json
{
  "name": "@homeledger/events",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit && node build.mjs",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@aws-sdk/client-apigatewaymanagementapi": "^3.900.0",
    "@aws-sdk/client-eventbridge": "^3.900.0",
    "@aws-sdk/client-s3": "^3.900.0",
    "@aws-sdk/client-secrets-manager": "^3.900.0",
    "@homeledger/core": "workspace:*",
    "aws-jwt-verify": "^5.2.1"
  },
  "devDependencies": {
    "@types/aws-lambda": "^8.10.163",
    "@types/node": "^22.0.0",
    "esbuild": "^0.28.2",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

Create `apps/events/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist-types", "types": ["node"] },
  "include": ["src"]
}
```

Create `apps/events/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 15000 } });
```

Create `apps/events/build.mjs`:

```js
// One bundle per handler, so each Lambda ships only what it imports. The AWS
// SDK v3 is provided by the nodejs22.x runtime and stays external; everything
// else, @homeledger/core included, is bundled. The banner gives bundled
// CommonJS dependencies a `require` inside an ES module.
import { build } from 'esbuild';
import { existsSync, readdirSync, rmSync } from 'node:fs';

const dir = 'src/handlers';
const handlers = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => f.slice(0, -3)) : [];
rmSync('dist', { recursive: true, force: true });
for (const name of handlers) {
  await build({
    entryPoints: [`${dir}/${name}.ts`],
    outfile: `dist/${name}/index.mjs`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    external: ['@aws-sdk/*'],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    logLevel: 'warning'
  });
}
console.log(`built ${handlers.length} handler(s): ${handlers.join(', ') || '(none yet)'}`);
```

Create an empty `apps/events/src/handlers/.gitkeep`.

Run: `pnpm install && pnpm --filter @homeledger/events build`
Expected: `built 0 handler(s): (none yet)`. (If `tsc` complains that `include` matched no inputs, that is because `src/` has no `.ts` yet — create Step 3's files first, then run this.)

- [ ] **Step 2: Write the failing tests**

Create `apps/events/test/fakes.ts`:

```ts
import { readFileSync } from 'node:fs';

/** A Ring fixture's `payload` (Task 1). The wrapper's `source` names the Ring document it came from. */
export function fixture<T = unknown>(name: string): T {
  return (JSON.parse(readFileSync(new URL(`./fixtures/ring/${name}.json`, import.meta.url), 'utf8')) as { payload: T }).payload;
}
```

Create `apps/events/test/hmac.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LINK_WINDOW_MS, isFreshLinkTime, linkNonce, verifyLinkNonce, verifyWebhookSignature, webhookSignature } from '../src/ring/hmac.js';

const KEY = 'test-hmac-signing-key';
const BODY = '{"meta":{"request_id":"req-1"},"data":{"type":"button_press"}}';
// The same JSON, re-serialised with spaces: what a parse-then-stringify would hand the verifier.
const RESERIALISED = '{"meta": {"request_id": "req-1"}, "data": {"type": "button_press"}}';

// Computed independently:
//   printf '%s' "$BODY" | openssl dgst -sha256 -hmac test-hmac-signing-key -hex
const BODY_SIG = 'sha256=c35d7d8c23cdcfc8758c7ad20d4af807220957d80140ee8bedee54226d19f9a5';
//   printf '%s' "$RESERIALISED" | openssl dgst -sha256 -hmac test-hmac-signing-key -hex
const RESERIALISED_SIG = 'sha256=1115782492492990a5513acb599f22d1e149f7789ff0c77e733a92705bf774d5';
//   printf '%s' "$BODY" | openssl dgst -sha256 -hmac other-key -hex
const OTHER_KEY_SIG = 'sha256=9495cc7004b1f8c44971a2866e9283ae6b5b3b652140aa57403bed3966fd7ab8';
//   printf '%s' "$BODY" | openssl dgst -sha256 -hmac test-hmac-signing-key -binary | base64
const BODY_SIG_AS_BASE64 = 'sha256=w119jCPNz8h1jHrSDUr4ByIJV9gBQO6L7e5UIm0Z+aU=';

describe('webhook signature (amendment §12.2: sha256=<hex> over the raw body)', () => {
  it('produces the lowercase hex digest Ring sends', () => {
    expect(webhookSignature(Buffer.from(BODY, 'utf8'), KEY)).toBe(BODY_SIG);
  });

  it('accepts Ring’s signature over the exact bytes received', () => {
    expect(verifyWebhookSignature(Buffer.from(BODY, 'utf8'), BODY_SIG, KEY)).toBe(true);
  });

  it('rejects a signature over the same JSON re-serialised — verification must use raw bytes', () => {
    expect(verifyWebhookSignature(Buffer.from(RESERIALISED, 'utf8'), BODY_SIG, KEY)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(RESERIALISED, 'utf8'), RESERIALISED_SIG, KEY)).toBe(true);
  });

  it('rejects a tampered body, the wrong key, a truncated signature, a missing header, and the Base64 form', () => {
    expect(verifyWebhookSignature(Buffer.from(BODY.replace('button_press', 'motion_detected'), 'utf8'), BODY_SIG, KEY)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(BODY, 'utf8'), OTHER_KEY_SIG, KEY)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(BODY, 'utf8'), BODY_SIG.slice(0, -1), KEY)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(BODY, 'utf8'), undefined, KEY)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(BODY, 'utf8'), BODY_SIG_AS_BASE64, KEY)).toBe(false);
  });
});

describe('link nonce (amendment §12.1: URL-safe Base64, no padding, over "<time>:<account_id>")', () => {
  // printf '%s' "1771130906289:acct-123" | openssl dgst -sha256 -hmac test-hmac-signing-key -binary | base64 | tr '+/' '-_' | tr -d '='
  const NONCE = 'IEV-fda_gDgbfFvtVJ1Bbi10n29TIGJ6e2v0ZmJ8N1c';
  // the same for acct-456
  const OTHER_ACCOUNT_NONCE = '8Rg0MLWO0qWod8Zz1Akoe-xtflZ5A3lPOvPVZtaPagc';

  it('computes the nonce Ring puts on the redirect — the literal contains - and _, so plain Base64 would not match', () => {
    expect(linkNonce('1771130906289', 'acct-123', KEY)).toBe(NONCE);
  });

  it('matches only the account whose tokens are held', () => {
    expect(verifyLinkNonce(NONCE, '1771130906289', 'acct-123', KEY)).toBe(true);
    expect(verifyLinkNonce(OTHER_ACCOUNT_NONCE, '1771130906289', 'acct-123', KEY)).toBe(false);
    expect(verifyLinkNonce(NONCE, '1771130906290', 'acct-123', KEY)).toBe(false);
    expect(verifyLinkNonce(`${NONCE}=`, '1771130906289', 'acct-123', KEY)).toBe(false);
  });

  it('refuses a link older than ten minutes, from the future, or with a malformed time', () => {
    expect(LINK_WINDOW_MS).toBe(600_000);
    const t = 1771130906289;
    expect(isFreshLinkTime(String(t), t)).toBe(true);
    expect(isFreshLinkTime(String(t), t + 600_000)).toBe(true);
    expect(isFreshLinkTime(String(t), t + 600_001)).toBe(false);
    expect(isFreshLinkTime(String(t), t - 1)).toBe(false);
    expect(isFreshLinkTime('17711309062', t)).toBe(false);
    expect(isFreshLinkTime('1771130906289abc', t)).toBe(false);
  });
});
```

Create `apps/events/test/envelope.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decodeWebhook } from '../src/ring/envelope.js';
import { fixture } from './fakes.js';

const RECEIVED = '2026-10-06T13:20:02.000Z';

describe('decodeWebhook over Ring’s documented payloads (amendment §12.3)', () => {
  it('decodes a button press', () => {
    expect(decodeWebhook(fixture('button-press'), RECEIVED)).toEqual({
      ok: true,
      event: {
        requestId: 'req-bp-0001',
        accountId: 'acct-123',
        eventId: 'evt-bp-0001',
        type: 'button_press',
        subType: null,
        deviceId: 'dev-doorbell-1',
        at: '2026-10-06T13:20:00.000Z'
      }
    });
  });

  it('reads the motion classification from data.subType', () => {
    const r = decodeWebhook(fixture('motion-human'), RECEIVED);
    expect(r.ok && r.event.subType).toBe('human');
    expect(r.ok && r.event.at).toBe('2026-10-06T13:20:05.000Z');
  });

  it('decodes a sensor event with the device from attributes.source', () => {
    const r = decodeWebhook(fixture('flood-detected'), RECEIVED);
    expect(r.ok && [r.event.type, r.event.deviceId, r.event.at]).toEqual(['flood_detected', 'dev-flood-1', '2026-10-06T21:15:00.000Z']);
  });

  it('gives no device for an event whose source is the account', () => {
    const r = decodeWebhook(fixture('app-integration-added'), RECEIVED);
    expect(r.ok && [r.event.type, r.event.deviceId]).toEqual(['app_integration_added', null]);
  });
});

describe('decodeWebhook is total: odd input is data, never a crash (spec §4 step 2)', () => {
  const base = fixture<{ meta: Record<string, unknown>; data: Record<string, unknown> }>('button-press');

  it('keeps an unknown event type as it came', () => {
    const r = decodeWebhook({ ...base, data: { ...base.data, type: 'tamper_detected' } }, RECEIVED);
    expect(r.ok && r.event.type).toBe('tamper_detected');
  });

  it('records a missing type as unknown', () => {
    const { type: _t, ...data } = base.data;
    const r = decodeWebhook({ ...base, data }, RECEIVED);
    expect(r.ok && r.event.type).toBe('unknown');
  });

  it('falls back to meta.time, then to the receive time, when the event carries no timestamp', () => {
    const noStamp = { ...base, data: { ...base.data, attributes: { source: 'dev-doorbell-1', source_type: 'devices' } } };
    expect((decodeWebhook(noStamp, RECEIVED) as { event: { at: string } }).event.at).toBe('2026-10-06T13:20:01.000Z');
    const noTimes = { ...noStamp, meta: { request_id: 'req-bp-0001' } };
    expect((decodeWebhook(noTimes, RECEIVED) as { event: { at: string } }).event.at).toBe(RECEIVED);
  });

  it('also reads the older field names the research recorded, should the Playground or staging send them', () => {
    const legacy = {
      meta: { request_id: 'req-legacy-1', time: '2026-10-06T13:20:01Z' },
      data: { type: 'event', id: 'req-legacy-1', attributes: { event_type: 'motion_detected', sub_type: 'human', device_id: 'dev-doorbell-1', timestamp: '2026-10-06T13:20:00Z', component_ids: [] } }
    };
    const r = decodeWebhook(legacy, RECEIVED);
    expect(r.ok && [r.event.type, r.event.subType, r.event.deviceId, r.event.at]).toEqual(['motion_detected', 'human', 'dev-doorbell-1', '2026-10-06T13:20:00.000Z']);
  });

  it('refuses a body with no request id — dedupe is impossible without it', () => {
    expect(decodeWebhook({ ...base, meta: { account_id: 'acct-123' } }, RECEIVED)).toEqual({ ok: false, reason: 'no meta.request_id' });
  });

  it('refuses a body that is not a JSON object', () => {
    for (const body of [null, [], 'button_press', 42]) expect(decodeWebhook(body, RECEIVED).ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @homeledger/events test`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

Create `apps/events/src/env.ts`:

```ts
/**
 * Read per invocation, never at import: a handler module is loaded before its
 * environment is known in tests, and a missing variable must fail the one
 * invocation with a message naming it, not the cold start with a stack trace.
 */
export class EventsConfigError extends Error {}

export function requireEnv(name: string, source: NodeJS.ProcessEnv = process.env): string {
  const value = source[name]?.trim();
  if (!value) throw new EventsConfigError(`${name} is not set.`);
  return value;
}

export function optionalEnv(name: string, source: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = source[name]?.trim();
  return value ? value : undefined;
}

export function flagEnv(name: string, source: NodeJS.ProcessEnv = process.env): boolean {
  const value = source[name]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}
```

Create `apps/events/src/ring/hmac.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Ring signs two things with the one HMAC key, and encodes them differently
 * (amendment §12.1, §12.2). Webhooks: lowercase hex, prefixed `sha256=`.
 * Link nonces: URL-safe Base64 with no padding. The key is used as its UTF-8
 * bytes — never Base64-decoded.
 */
const mac = (hmacKey: string) => createHmac('sha256', Buffer.from(hmacKey, 'utf8'));

function equalInConstantTime(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function webhookSignature(rawBody: Buffer, hmacKey: string): string {
  return `sha256=${mac(hmacKey).update(rawBody).digest('hex')}`;
}

/** Over the bytes exactly as received — a parsed-and-restringified body has different whitespace and a different HMAC. */
export function verifyWebhookSignature(rawBody: Buffer, header: string | undefined, hmacKey: string): boolean {
  if (!header) return false;
  return equalInConstantTime(webhookSignature(rawBody, hmacKey), header.trim());
}

export function linkNonce(timeMs: string, accountId: string, hmacKey: string): string {
  return mac(hmacKey).update(`${timeMs}:${accountId}`, 'utf8').digest('base64url');
}

export function verifyLinkNonce(nonce: string, timeMs: string, accountId: string, hmacKey: string): boolean {
  return equalInConstantTime(linkNonce(timeMs, accountId, hmacKey), nonce);
}

/** Ring's validation window for a link redirect. */
export const LINK_WINDOW_MS = 600_000;

export function isFreshLinkTime(timeMs: string, nowMs: number): boolean {
  if (!/^\d{13}$/.test(timeMs)) return false;
  const age = nowMs - Number(timeMs);
  return age >= 0 && age <= LINK_WINDOW_MS;
}
```

Create `apps/events/src/ring/envelope.ts`:

```ts
/**
 * A Ring webhook, reduced to what HomeLedger routes on. Total: whatever the
 * body is, the answer is a decoded event or a named reason, never a throw.
 */
export interface RingWebhook {
  requestId: string;
  accountId: string | null;
  eventId: string | null;
  type: string;
  subType: string | null;
  deviceId: string | null;
  at: string;
}

export type DecodeResult = { ok: true; event: RingWebhook } | { ok: false; reason: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

function instant(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === 'string' && v.trim() !== '') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

export function decodeWebhook(body: unknown, receivedAtIso: string): DecodeResult {
  if (!isObj(body)) return { ok: false, reason: 'body is not a JSON object' };
  const meta = isObj(body.meta) ? body.meta : {};
  const requestId = str(meta.request_id);
  if (!requestId) return { ok: false, reason: 'no meta.request_id' };
  const data = isObj(body.data) ? body.data : {};
  const attributes = isObj(data.attributes) ? data.attributes : {};

  // v1.1 names first (amendment §12.3); the research's names as a fallback.
  const dataType = str(data.type);
  const type = (dataType && dataType !== 'event' ? dataType : null) ?? str(attributes.event_type) ?? 'unknown';
  const subType = str(data.subType) ?? str(attributes.sub_type);
  const sourceType = str(attributes.source_type);
  const deviceId = (sourceType === null || sourceType === 'devices' ? str(attributes.source) : null) ?? str(attributes.device_id);
  const at = instant(attributes.timestamp) ?? instant(meta.time) ?? receivedAtIso;

  return { ok: true, event: { requestId, accountId: str(meta.account_id), eventId: str(data.id), type, subType, deviceId, at } };
}
```

- [ ] **Step 5: Run the tests and the build**

Run: `pnpm --filter @homeledger/events test && pnpm --filter @homeledger/events build`
Expected: PASS; `built 0 handler(s): (none yet)`.

- [ ] **Step 6: Mutation check**

Apply each, run `pnpm --filter @homeledger/events test`, record, revert:
1. `digest('hex')` → `digest('base64')` in `webhookSignature` → the literal-digest and acceptance tests fail.
2. `Buffer.from(hmacKey, 'utf8')` → `Buffer.from(hmacKey, 'base64')` → every literal test fails.
3. `digest('base64url')` → `digest('base64')` in `linkNonce` → the nonce literal test fails (the literal contains `-` and `_`).
4. `age <= LINK_WINDOW_MS` → `age < LINK_WINDOW_MS` → the exact-edge freshness assertion fails.
5. Drop `age >= 0` → the from-the-future assertion fails.
6. In `decodeWebhook`, drop the `sourceType === 'devices'` guard → the app-integration test fails (the account id would become a device).
7. In `decodeWebhook`, read `attributes.timestamp` as ISO only (delete the `number` branch of `instant`) → the button-press test fails (`at` falls back to `meta.time`, `13:20:01`).
8. Replace `str(data.subType) ?? str(attributes.sub_type)` with `str(attributes.sub_type)` → the motion test fails.

- [ ] **Step 7: Commit**

```bash
git add apps/events pnpm-lock.yaml .gitignore
git commit -m "feat(events): scaffold @homeledger/events with Ring's webhook signature, link nonce, and a total envelope decoder"
```

---
### Task 6: The Ring client and the snapshot fetch

**Files:**
- Create: `apps/events/src/ring/client.ts`, `apps/events/src/ring/snapshot.ts`
- Modify: `apps/events/test/fakes.ts` (add `fakeFetch`, `jsonResponse`, `clock`)
- Test: `apps/events/test/client.test.ts`, `apps/events/test/snapshot.test.ts`

**Interfaces:**
- Consumes: `SnapshotStatusValue` (core); Task 1 fixtures `users-me`, `devices`, `status-flood-freeze`, `status-doorbell`.
- Produces:

```ts
// ring/client.ts
export const RING_API_BASE = 'https://api.amazonvision.com';
export const RING_OAUTH_TOKEN_URL = 'https://oauth.ring.com/oauth/token';
export interface RingTokens { accessToken: string; refreshToken: string; expiresAt: string }
export class RingApiError extends Error { readonly status: number; readonly code: string | null }
export interface RingOAuth { exchangeCode(code: string): Promise<RingTokens>; refresh(refreshToken: string): Promise<RingTokens> }
export function createRingOAuth(opts: { clientId: string; clientSecret: string; fetch?: typeof fetch; now?: () => number }): RingOAuth;
export interface RingDeviceSummary { id: string; name: string }
export interface RingDeviceStatus { online: boolean; flood: boolean | null; freeze: boolean | null }
export type ImageAnswer = { kind: 'image'; bytes: Buffer; contentType: string | null } | { kind: 'refused'; status: number; code: string | null };
export interface RingApi {
  accountId(): Promise<string>;
  listDevices(): Promise<RingDeviceSummary[]>;
  deviceStatus(deviceId: string): Promise<RingDeviceStatus>;
  confirmLink(nonce: string, accountIdentifier: string): Promise<void>;
  completeLink(accountIdentifier: string): Promise<void>;
  requestImage(deviceId: string, window: { startMs: number; endMs: number }): Promise<ImageAnswer>;
}
export function createRingApi(opts: { accessToken: () => Promise<string>; fetch?: typeof fetch }): RingApi;

// ring/snapshot.ts
export const SNAPSHOT_BUDGET_MS = 60_000;
export const SNAPSHOT_BACKOFF_MS: readonly number[]; // [1000, 2000, 4000, 8000, 15000]; the last repeats
export function imageKind(bytes: Buffer): 'jpeg' | 'png' | null;
export interface SnapshotResult { status: SnapshotStatusValue; bytes: Buffer | null; contentType: string | null; latencyMs: number; attempts: number; lastRefusal: string | null }
export function fetchDoorbellSnapshot(
  deps: { requestImage: RingApi['requestImage']; now: () => number; sleep: (ms: number) => Promise<void> },
  input: { deviceId: string; eventAtMs: number },
  budgetMs?: number
): Promise<SnapshotResult>;
```

**Two rules this task pins.** No error message ever contains a token or the client secret — `RingApiError` carries a status and Ring's error `code`, nothing from the request. And the image download's second leg is sent **without** the bearer token: the `Location` is presigned, and Ring's docs say not to send the token there (amendment §12.5).

- [ ] **Step 1: Grow the fakes**

Append to `apps/events/test/fakes.ts`:

```ts
export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  redirect: RequestRedirect | undefined;
}

/** A fetch that records every request and answers from `respond`. Nothing leaves the process. */
export function fakeFetch(respond: (req: RecordedRequest) => Response | Promise<Response>): { fetch: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    const body = init?.body === undefined || init.body === null ? null : init.body instanceof URLSearchParams ? init.body.toString() : String(init.body);
    const req: RecordedRequest = { url: String(input), method: init?.method ?? 'GET', headers, body, redirect: init?.redirect };
    calls.push(req);
    return respond(req);
  };
  return { fetch: impl as typeof fetch, calls };
}

export const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A clock that only moves when told to. `sleep` advances it and records the delay. */
export function clock(startMs: number): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[]; advance: (ms: number) => void } {
  let t = startMs;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async ms => {
      slept.push(ms);
      t += ms;
    },
    slept,
    advance: ms => {
      t += ms;
    }
  };
}

/** Three bytes of JPEG magic plus filler; four of PNG; and bytes that are neither. */
export const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const OPAQUE_BYTES = Buffer.from('ENCRYPTED-CONTENT-v1', 'utf8');
```

- [ ] **Step 2: Write the failing client tests**

Create `apps/events/test/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RING_API_BASE, RING_OAUTH_TOKEN_URL, RingApiError, createRingApi, createRingOAuth } from '../src/ring/client.js';
import { JPEG_BYTES, fakeFetch, fixture, jsonResponse } from './fakes.js';

const NOW = Date.parse('2026-10-06T13:00:00.000Z');
const tokenBody = { access_token: 'at-1', refresh_token: 'rt-1', scope: 'ava', expires_in: 14400, token_type: 'Bearer' };

describe('Ring OAuth (amendment §12.1)', () => {
  it('exchanges a code with a form post and dates the access token from expires_in', async () => {
    const f = fakeFetch(() => jsonResponse(200, tokenBody));
    const oauth = createRingOAuth({ clientId: 'client-1', clientSecret: 's3cret-value', fetch: f.fetch, now: () => NOW });
    expect(await oauth.exchangeCode('code-abc')).toEqual({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: '2026-10-06T17:00:00.000Z' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(RING_OAUTH_TOKEN_URL);
    expect(f.calls[0]!.method).toBe('POST');
    expect(f.calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(f.calls[0]!.body!))).toEqual({
      grant_type: 'authorization_code',
      code: 'code-abc',
      client_id: 'client-1',
      client_secret: 's3cret-value'
    });
  });

  it('refreshes with the refresh token and keeps the new refresh token Ring returns', async () => {
    const f = fakeFetch(() => jsonResponse(200, { ...tokenBody, access_token: 'at-2', refresh_token: 'rt-2' }));
    const oauth = createRingOAuth({ clientId: 'client-1', clientSecret: 's3cret-value', fetch: f.fetch, now: () => NOW });
    expect(await oauth.refresh('rt-1')).toEqual({ accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: '2026-10-06T17:00:00.000Z' });
    expect(Object.fromEntries(new URLSearchParams(f.calls[0]!.body!))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
      client_id: 'client-1',
      client_secret: 's3cret-value'
    });
  });

  it('fails with the status and Ring’s code, and never with the secret or the code in the message', async () => {
    const f = fakeFetch(() => jsonResponse(400, { errors: [{ status: '400', code: 'invalid_grant' }] }));
    const oauth = createRingOAuth({ clientId: 'client-1', clientSecret: 's3cret-value', fetch: f.fetch, now: () => NOW });
    const err = await oauth.exchangeCode('code-abc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RingApiError);
    expect((err as RingApiError).status).toBe(400);
    expect((err as RingApiError).code).toBe('invalid_grant');
    expect((err as Error).message).toBe('The Ring code exchange failed with 400 invalid_grant');
  });

  it('refuses a 200 whose body is not a token response', async () => {
    const f = fakeFetch(() => jsonResponse(200, { access_token: 'at-1' }));
    const oauth = createRingOAuth({ clientId: 'client-1', clientSecret: 's3cret-value', fetch: f.fetch, now: () => NOW });
    await expect(oauth.exchangeCode('code-abc')).rejects.toThrow('The Ring code exchange returned an unexpected body');
  });
});

describe('Ring API', () => {
  const api = (respond: Parameters<typeof fakeFetch>[0]) => {
    const f = fakeFetch(respond);
    let n = 0;
    return { api: createRingApi({ accessToken: async () => `tok-${++n}`, fetch: f.fetch }), calls: f.calls };
  };

  it('reads the Account ID from users/me with a fresh bearer per call', async () => {
    const { api: ring, calls } = api(() => jsonResponse(200, fixture('users-me')));
    expect(await ring.accountId()).toBe('acct-123');
    await ring.accountId();
    expect(calls.map(c => [c.url, c.headers.authorization])).toEqual([
      [`${RING_API_BASE}/v1/users/me`, 'Bearer tok-1'],
      [`${RING_API_BASE}/v1/users/me`, 'Bearer tok-2']
    ]);
  });

  it('lists devices as id and name only — Ring gives no type (amendment §12.6)', async () => {
    const { api: ring } = api(() => jsonResponse(200, fixture('devices')));
    expect(await ring.listDevices()).toEqual([
      { id: 'dev-doorbell-1', name: 'Front Door' },
      { id: 'dev-flood-1', name: 'Water Heater' }
    ]);
  });

  it('reads both flood and freeze from a sensor’s status, and null from a doorbell’s', async () => {
    const { api: ring, calls } = api(req => jsonResponse(200, fixture(req.url.includes('dev-flood-1') ? 'status-flood-freeze' : 'status-doorbell')));
    expect(await ring.deviceStatus('dev-flood-1')).toEqual({ online: true, flood: false, freeze: false });
    expect(await ring.deviceStatus('dev-doorbell-1')).toEqual({ online: true, flood: null, freeze: null });
    expect(calls[0]!.url).toBe(`${RING_API_BASE}/v1/devices/dev-flood-1/status`);
  });

  it('confirms the link with the nonce, then completes it — both calls are required', async () => {
    const { api: ring, calls } = api(req => jsonResponse(200, req.method === 'POST' ? { status: 'awaiting' } : { status: 'completed' }));
    await ring.confirmLink('IEV-fda_gDgbfFvtVJ1Bbi10n29TIGJ6e2v0ZmJ8N1c', 'hh_h***w');
    await ring.completeLink('hh_h***w');
    expect(calls.map(c => [c.method, c.url, c.body])).toEqual([
      ['POST', `${RING_API_BASE}/v1/accounts/me/app-integrations`, JSON.stringify({ account_identifier: 'hh_h***w', nonce: 'IEV-fda_gDgbfFvtVJ1Bbi10n29TIGJ6e2v0ZmJ8N1c' })],
      ['PATCH', `${RING_API_BASE}/v1/accounts/me/app-integrations`, JSON.stringify({ account_identifier: 'hh_h***w', status: 'completed' })]
    ]);
  });

  it('surfaces Ring’s error code when the nonce is refused', async () => {
    const { api: ring } = api(() => jsonResponse(400, { errors: [{ status: '400', code: 'INVALID_NONCE', title: 'Invalid Nonce' }] }));
    const err = await ring.confirmLink('bad', 'hh_h***w').catch((e: unknown) => e);
    expect([(err as RingApiError).status, (err as RingApiError).code]).toEqual([400, 'INVALID_NONCE']);
  });

  it('requests an image without following the redirect, then fetches the presigned Location without the bearer', async () => {
    const { api: ring, calls } = api(req =>
      req.method === 'POST'
        ? new Response(null, { status: 303, headers: { location: 'https://media.api.amazonvision.com/v1/download?security_token=x' } })
        : new Response(JPEG_BYTES, { status: 200, headers: { 'content-type': 'image/jpeg', 'x-media-origin': 'recording' } })
    );
    const answer = await ring.requestImage('dev-doorbell-1', { startMs: 1791292795000, endMs: 1791292830000 });
    expect(answer).toEqual({ kind: 'image', bytes: JPEG_BYTES, contentType: 'image/jpeg' });
    expect(calls[0]!.url).toBe(`${RING_API_BASE}/v1/devices/dev-doorbell-1/media/image/download`);
    expect(calls[0]!.redirect).toBe('manual');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ type: 'latest_in_range', start_timestamp: 1791292795000, end_timestamp: 1791292830000, image_options: { format: 'jpeg' } });
    expect(calls[1]!.url).toBe('https://media.api.amazonvision.com/v1/download?security_token=x');
    expect(calls[1]!.headers.authorization).toBeUndefined();
  });

  it('reports a refusal on either leg with its status and code', async () => {
    const onPost = api(() => jsonResponse(403, { errors: [{ status: '403', code: 'TIME_RANGE_NOT_AUTHORIZED' }] }));
    expect(await onPost.api.requestImage('dev-doorbell-1', { startMs: 1, endMs: 2 })).toEqual({ kind: 'refused', status: 403, code: 'TIME_RANGE_NOT_AUTHORIZED' });
    const onGet = api(req =>
      req.method === 'POST'
        ? new Response(null, { status: 303, headers: { location: 'https://media.api.amazonvision.com/x' } })
        : jsonResponse(416, { errors: [{ status: '416', code: 'MEDIA_NOT_FOUND' }] })
    );
    expect(await onGet.api.requestImage('dev-doorbell-1', { startMs: 1, endMs: 2 })).toEqual({ kind: 'refused', status: 416, code: 'MEDIA_NOT_FOUND' });
  });
});
```

- [ ] **Step 3: Write the failing snapshot tests**

Create `apps/events/test/snapshot.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ImageAnswer } from '../src/ring/client.js';
import { SNAPSHOT_BACKOFF_MS, SNAPSHOT_BUDGET_MS, fetchDoorbellSnapshot, imageKind } from '../src/ring/snapshot.js';
import { JPEG_BYTES, OPAQUE_BYTES, PNG_BYTES, clock } from './fakes.js';

const EVENT = 1791292800000; // 2026-10-06T13:20:00Z

function scripted(answers: Array<ImageAnswer | Error>) {
  const windows: Array<{ startMs: number; endMs: number }> = [];
  let i = 0;
  const requestImage = async (_id: string, window: { startMs: number; endMs: number }): Promise<ImageAnswer> => {
    windows.push(window);
    const next = answers[Math.min(i++, answers.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return { requestImage, windows };
}
const image = (bytes: Buffer, contentType = 'image/jpeg'): ImageAnswer => ({ kind: 'image', bytes, contentType });
const refused = (status: number, code: string | null = null): ImageAnswer => ({ kind: 'refused', status, code });

describe('imageKind', () => {
  it('recognises JPEG and PNG by their magic bytes and nothing else', () => {
    expect([imageKind(JPEG_BYTES), imageKind(PNG_BYTES), imageKind(OPAQUE_BYTES), imageKind(Buffer.alloc(0))]).toEqual(['jpeg', 'png', null, null]);
  });
});

describe('fetchDoorbellSnapshot (spec §5 and amendment §12.5)', () => {
  it('stores the first image, and measures latency from the ring to the moment the image was in hand', async () => {
    const c = clock(EVENT + 2_000);
    const s = scripted([image(JPEG_BYTES)]);
    const r = await fetchDoorbellSnapshot({ requestImage: s.requestImage, now: c.now, sleep: c.sleep }, { deviceId: 'dev-doorbell-1', eventAtMs: EVENT });
    expect(r).toEqual({ status: 'ok', bytes: JPEG_BYTES, contentType: 'image/jpeg', latencyMs: 2_000, attempts: 1, lastRefusal: null });
    expect(s.windows[0]).toEqual({ startMs: EVENT - 5_000, endMs: EVENT + 2_000 });
  });

  it('waits out "recording not ready" with growing gaps, and widens the window up to thirty seconds after the ring', async () => {
    const c = clock(EVENT + 2_000);
    const s = scripted([refused(425, 'RECORDING_NOT_READY'), refused(416, 'MEDIA_NOT_FOUND'), image(PNG_BYTES, 'image/png')]);
    const r = await fetchDoorbellSnapshot({ requestImage: s.requestImage, now: c.now, sleep: c.sleep }, { deviceId: 'dev-doorbell-1', eventAtMs: EVENT });
    expect([r.status, r.attempts, r.latencyMs, r.contentType]).toEqual(['ok', 3, 5_000, 'image/png']);
    expect(c.slept).toEqual([1_000, 2_000]);
    expect(s.windows.map(w => w.endMs)).toEqual([EVENT + 2_000, EVENT + 3_000, EVENT + 5_000]);
  });

  it('never asks for a window ending more than thirty seconds after the ring', async () => {
    const c = clock(EVENT + 45_000);
    const s = scripted([image(JPEG_BYTES)]);
    await fetchDoorbellSnapshot({ requestImage: s.requestImage, now: c.now, sleep: c.sleep }, { deviceId: 'dev-doorbell-1', eventAtMs: EVENT });
    expect(s.windows[0]).toEqual({ startMs: EVENT - 5_000, endMs: EVENT + 30_000 });
  });

  it('calls bytes that are not an image encrypted (R4: Unverified), without retrying', async () => {
    const c = clock(EVENT);
    const r = await fetchDoorbellSnapshot({ ...scripted([image(OPAQUE_BYTES, 'application/octet-stream')]), now: c.now, sleep: c.sleep }, { deviceId: 'd', eventAtMs: EVENT });
    expect([r.status, r.bytes, r.attempts]).toEqual(['encrypted', null, 1]);
  });

  it('stops at once on 403, which no amount of waiting fixes', async () => {
    const c = clock(EVENT);
    const r = await fetchDoorbellSnapshot({ ...scripted([refused(403, 'TIME_RANGE_NOT_AUTHORIZED')]), now: c.now, sleep: c.sleep }, { deviceId: 'd', eventAtMs: EVENT });
    expect([r.status, r.attempts, r.lastRefusal]).toEqual(['forbidden', 1, '403 TIME_RANGE_NOT_AUTHORIZED']);
    expect(c.slept).toEqual([]);
  });

  it('gives up with none-in-window after spending the whole budget on "no media"', async () => {
    expect(SNAPSHOT_BUDGET_MS).toBe(60_000);
    expect([...SNAPSHOT_BACKOFF_MS]).toEqual([1_000, 2_000, 4_000, 8_000, 15_000]);
    const c = clock(EVENT);
    const r = await fetchDoorbellSnapshot({ ...scripted([refused(416, 'MEDIA_NOT_FOUND')]), now: c.now, sleep: c.sleep }, { deviceId: 'd', eventAtMs: EVENT });
    expect([r.status, r.attempts, r.latencyMs]).toEqual(['none-in-window', 8, 60_000]);
    expect(c.slept).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
  });

  it('reports error when the budget runs out on server or network failures', async () => {
    const c = clock(EVENT);
    const r = await fetchDoorbellSnapshot({ ...scripted([refused(503, 'SERVER_BUSY'), new Error('socket hang up')]), now: c.now, sleep: c.sleep }, { deviceId: 'd', eventAtMs: EVENT });
    expect([r.status, r.lastRefusal]).toEqual(['error', 'network: socket hang up']);
  });

  it('lets the last transient answer decide: server trouble that ends in "no media" is none-in-window', async () => {
    const c = clock(EVENT);
    const r = await fetchDoorbellSnapshot({ ...scripted([refused(503), refused(416)]), now: c.now, sleep: c.sleep }, { deviceId: 'd', eventAtMs: EVENT });
    expect(r.status).toBe('none-in-window');
  });

  it('does not retry a request Ring called malformed', async () => {
    const c = clock(EVENT);
    const r = await fetchDoorbellSnapshot({ ...scripted([refused(400, 'INVALID_PAYLOAD')]), now: c.now, sleep: c.sleep }, { deviceId: 'd', eventAtMs: EVENT });
    expect([r.status, r.attempts]).toEqual(['error', 1]);
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `pnpm --filter @homeledger/events test -- client snapshot`
Expected: FAIL — modules not found.

- [ ] **Step 5: Implement the client**

Create `apps/events/src/ring/client.ts`:

```ts
/**
 * Ring's OAuth and Partner API, over an injected fetch. Hosts, paths and
 * bodies are from Ring's documentation (amendment §12). Nothing here logs,
 * and no error carries a token, a code, or the client secret.
 */
export const RING_API_BASE = 'https://api.amazonvision.com';
export const RING_OAUTH_TOKEN_URL = 'https://oauth.ring.com/oauth/token';

export interface RingTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export class RingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string
  ) {
    super(message);
    this.name = 'RingApiError';
  }
}

async function refusalCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { errors?: Array<{ code?: unknown }> };
    const code = body.errors?.[0]?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

async function failure(res: Response, what: string): Promise<RingApiError> {
  const code = await refusalCode(res);
  return new RingApiError(res.status, code, `${what} failed with ${res.status}${code ? ` ${code}` : ''}`);
}

export interface RingOAuth {
  exchangeCode(code: string): Promise<RingTokens>;
  refresh(refreshToken: string): Promise<RingTokens>;
}

export function createRingOAuth(opts: { clientId: string; clientSecret: string; fetch?: typeof fetch; now?: () => number }): RingOAuth {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const grant = async (params: Record<string, string>, what: string): Promise<RingTokens> => {
    const res = await f(RING_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: opts.clientId, client_secret: opts.clientSecret })
    });
    if (!res.ok) throw await failure(res, what);
    const body = (await res.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' || typeof body.expires_in !== 'number')
      throw new RingApiError(res.status, null, `${what} returned an unexpected body`);
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: new Date(now() + body.expires_in * 1000).toISOString() };
  };
  return {
    exchangeCode: code => grant({ grant_type: 'authorization_code', code }, 'The Ring code exchange'),
    refresh: refreshToken => grant({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'The Ring token refresh')
  };
}

export interface RingDeviceSummary {
  id: string;
  name: string;
}

export interface RingDeviceStatus {
  online: boolean;
  flood: boolean | null;
  freeze: boolean | null;
}

export type ImageAnswer = { kind: 'image'; bytes: Buffer; contentType: string | null } | { kind: 'refused'; status: number; code: string | null };

export interface RingApi {
  accountId(): Promise<string>;
  listDevices(): Promise<RingDeviceSummary[]>;
  deviceStatus(deviceId: string): Promise<RingDeviceStatus>;
  confirmLink(nonce: string, accountIdentifier: string): Promise<void>;
  completeLink(accountIdentifier: string): Promise<void>;
  requestImage(deviceId: string, window: { startMs: number; endMs: number }): Promise<ImageAnswer>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const faulted = (v: unknown): boolean | null => (isObj(v) && typeof v.faulted === 'boolean' ? v.faulted : null);

export function createRingApi(opts: { accessToken: () => Promise<string>; fetch?: typeof fetch }): RingApi {
  const f = opts.fetch ?? fetch;
  const call = async (method: string, path: string, what: string, body?: unknown): Promise<Response> => {
    const headers: Record<string, string> = { authorization: `Bearer ${await opts.accessToken()}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await f(`${RING_API_BASE}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw await failure(res, what);
    return res;
  };
  const device = (id: string) => `/v1/devices/${encodeURIComponent(id)}`;

  return {
    async accountId() {
      const body = (await (await call('GET', '/v1/users/me', 'Reading the Ring account')).json()) as { data?: { id?: unknown } };
      if (typeof body.data?.id !== 'string') throw new RingApiError(200, null, 'Reading the Ring account returned no account id');
      return body.data.id;
    },
    async listDevices() {
      const body = (await (await call('GET', '/v1/devices', 'Listing Ring devices')).json()) as { data?: unknown };
      const rows = Array.isArray(body.data) ? body.data : [];
      return rows
        .filter((d): d is Obj => isObj(d) && typeof d.id === 'string')
        .map(d => ({ id: d.id as string, name: isObj(d.attributes) && typeof d.attributes.name === 'string' ? d.attributes.name : 'Ring device' }));
    },
    async deviceStatus(deviceId) {
      const body = (await (await call('GET', `${device(deviceId)}/status`, 'Reading a Ring device status')).json()) as { data?: { attributes?: unknown } };
      const a = isObj(body.data?.attributes) ? body.data.attributes : {};
      return { online: a.online === true, flood: faulted(a.flood_detection), freeze: faulted(a.freeze_detection) };
    },
    async confirmLink(nonce, accountIdentifier) {
      await call('POST', '/v1/accounts/me/app-integrations', 'Confirming the Ring link', { account_identifier: accountIdentifier, nonce });
    },
    async completeLink(accountIdentifier) {
      await call('PATCH', '/v1/accounts/me/app-integrations', 'Completing the Ring link', { account_identifier: accountIdentifier, status: 'completed' });
    },
    async requestImage(deviceId, window) {
      const res = await f(`${RING_API_BASE}${device(deviceId)}/media/image/download`, {
        method: 'POST',
        redirect: 'manual',
        headers: { authorization: `Bearer ${await opts.accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'latest_in_range', start_timestamp: window.startMs, end_timestamp: window.endMs, image_options: { format: 'jpeg' } })
      });
      let image = res;
      if (res.status === 303) {
        const location = res.headers.get('location');
        if (!location) return { kind: 'refused', status: 303, code: 'NO_LOCATION' };
        // Presigned: no bearer on this leg (amendment §12.5).
        image = await f(location, { method: 'GET' });
      }
      if (image.status !== 200) return { kind: 'refused', status: image.status, code: await refusalCode(image) };
      return { kind: 'image', bytes: Buffer.from(await image.arrayBuffer()), contentType: image.headers.get('content-type') };
    }
  };
}
```

- [ ] **Step 6: Implement the snapshot fetch**

Create `apps/events/src/ring/snapshot.ts`:

```ts
import type { SnapshotStatusValue } from '@homeledger/core';
import type { RingApi } from './client.js';

/** Spec §5: retry for up to about a minute. The actual press-to-image delay is undocumented, so it is measured, not assumed. */
export const SNAPSHOT_BUDGET_MS = 60_000;
export const SNAPSHOT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000];
const LOOK_BACK_MS = 5_000;
const LOOK_AHEAD_MS = 30_000;

export function imageKind(bytes: Buffer): 'jpeg' | 'png' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return null;
}

export interface SnapshotResult {
  status: SnapshotStatusValue;
  bytes: Buffer | null;
  contentType: string | null;
  latencyMs: number;
  attempts: number;
  lastRefusal: string | null;
}

/**
 * Asks Ring for the latest image between five seconds before the ring and
 * thirty after it (never past now), until an image arrives or the budget is
 * spent. 416/425 mean "not yet" and 5xx/network mean "try again"; 403 and
 * other 4xx are final. `latencyMs` runs from the ring itself, so it is the
 * figure the spec asks to report: how long a real press takes to become a
 * retrievable picture.
 */
export async function fetchDoorbellSnapshot(
  deps: { requestImage: RingApi['requestImage']; now: () => number; sleep: (ms: number) => Promise<void> },
  input: { deviceId: string; eventAtMs: number },
  budgetMs: number = SNAPSHOT_BUDGET_MS
): Promise<SnapshotResult> {
  const started = deps.now();
  let attempts = 0;
  let lastRefusal: string | null = null;
  let lastTransient: 'none-in-window' | 'error' = 'error';
  const done = (status: SnapshotStatusValue, bytes: Buffer | null = null, contentType: string | null = null): SnapshotResult => ({
    status,
    bytes,
    contentType,
    latencyMs: Math.max(0, deps.now() - input.eventAtMs),
    attempts,
    lastRefusal
  });

  for (;;) {
    attempts += 1;
    const window = { startMs: input.eventAtMs - LOOK_BACK_MS, endMs: Math.min(input.eventAtMs + LOOK_AHEAD_MS, deps.now()) };
    let answer;
    try {
      answer = await deps.requestImage(input.deviceId, window);
    } catch (err) {
      answer = null;
      lastRefusal = `network: ${err instanceof Error ? err.message : String(err)}`;
      lastTransient = 'error';
    }
    if (answer?.kind === 'image') {
      return imageKind(answer.bytes) ? done('ok', answer.bytes, answer.contentType) : done('encrypted');
    }
    if (answer?.kind === 'refused') {
      lastRefusal = `${answer.status}${answer.code ? ` ${answer.code}` : ''}`;
      if (answer.status === 403) return done('forbidden');
      if (answer.status === 416 || answer.status === 425) lastTransient = 'none-in-window';
      else if (answer.status >= 500) lastTransient = 'error';
      else return done('error');
    }
    const delay = SNAPSHOT_BACKOFF_MS[Math.min(attempts - 1, SNAPSHOT_BACKOFF_MS.length - 1)]!;
    if (deps.now() - started + delay > budgetMs) return done(lastTransient);
    await deps.sleep(delay);
  }
}
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @homeledger/events test`
Expected: PASS.

- [ ] **Step 8: Mutation check**

Apply each, run, record, revert:
1. In `requestImage`, drop `redirect: 'manual'` → the client test's `calls[0].redirect` assertion fails.
2. Send the bearer on the `Location` GET → `calls[1].headers.authorization` assertion fails.
3. `expires_in * 1000` → `expires_in` → the `expiresAt` literal fails.
4. Put `${params.code}` into the failure message → the exact-message test fails.
5. In `fetchDoorbellSnapshot`, treat 403 like 416 → "stops at once on 403" fails.
6. Change `> budgetMs` to `>= budgetMs` → the budget test fails (7 attempts, not 8).
7. Use `started` instead of `input.eventAtMs` in `latencyMs` → the first test's `latencyMs: 2_000` fails (0).
8. Drop the `Math.min(..., deps.now())` → the window test fails (end would be `EVENT + 30_000` on the first attempt).
9. Return `done('ok', …)` for any image regardless of `imageKind` → the encrypted test fails.

- [ ] **Step 9: Commit**

```bash
git add apps/events
git commit -m "feat(events): Ring OAuth and Partner API client, and a snapshot fetch with a measured, bounded wait"
```

---
### Task 7: AWS ports and the describer

Every AWS call the handlers make goes through one of these small ports, each constructed from an injectable SDK client. Tests hand in a stub `send`; nothing here constructs a real client at import time.

**Files:**
- Create: `apps/events/src/aws/secrets.ts`, `apps/events/src/aws/tokens.ts`, `apps/events/src/aws/bus.ts`, `apps/events/src/aws/objects.ts`, `apps/events/src/aws/describe.ts`, `apps/events/src/aws/alerts.ts`
- Test: `apps/events/test/aws.test.ts`

**Interfaces:**
- Consumes: `Repository`, `Alert`, `newId` (core); `RingApiError` is not used here.
- Produces:

```ts
// aws/secrets.ts
export class SecretMissingError extends Error {}
export interface SecretsPort { read(secretId: string): Promise<string>; write(secretId: string, value: string): Promise<void> }
export function createSecretsPort(client?: SecretsManagerClient, opts?: { now?: () => number; ttlMs?: number }): SecretsPort; // ttl default 300_000

// aws/tokens.ts
export interface TokenRecord { accountId: string; accessToken: string; refreshToken: string; expiresAt: string; status: 'unclaimed' | 'linked' | 'lapsed'; updatedAt: string }
export interface TokenStore { read(): Promise<TokenRecord | null>; write(record: TokenRecord): Promise<void> }
export class RingNotLinkedError extends Error {}
export function createTokenStore(secrets: SecretsPort, secretId: string): TokenStore;
export function linkedAccessToken(store: TokenStore): () => Promise<string>; // throws RingNotLinkedError

// aws/bus.ts
export const RING_SOURCE = 'ring.webhook';
export const HOMELEDGER_SOURCE = 'homeledger.events';
export interface BusEntry { source: typeof RING_SOURCE | typeof HOMELEDGER_SOURCE; detailType: string; detail: Record<string, unknown> }
export type EventPublisher = (entries: BusEntry[]) => Promise<void>;
export function createEventPublisher(busName: string, client?: EventBridgeClient): EventPublisher;

// aws/objects.ts
export type PutSnapshot = (key: string, bytes: Buffer, contentType: string) => Promise<void>;
export function createSnapshotWriter(bucket: string, client?: S3Client): PutSnapshot;
export function snapshotKeyFor(householdId: string, visitId: string, kind: 'jpeg' | 'png'): string; // snapshots/<hh>/<visit>.jpg|.png

// aws/describe.ts
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const DESCRIBE_INSTRUCTION: string;
export type Describer = (image: Buffer, mediaType: 'image/jpeg' | 'image/png') => Promise<string>;
export function createAnthropicDescriber(opts: { apiKey: () => Promise<string>; model: string; fetch?: typeof fetch }): Describer;
export function oneSentence(text: string): string;

// aws/alerts.ts
export async function raiseSystemAlert(deps: { repo: Pick<Repository, 'putAlert'>; newId: () => string; now: () => string }, message: string): Promise<Alert>;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/events/test/aws.test.ts`:

```ts
import { GetSecretValueCommand, PutSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { PutEventsCommand, type EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { raiseSystemAlert } from '../src/aws/alerts.js';
import { HOMELEDGER_SOURCE, createEventPublisher } from '../src/aws/bus.js';
import { ANTHROPIC_MESSAGES_URL, DESCRIBE_INSTRUCTION, createAnthropicDescriber, oneSentence } from '../src/aws/describe.js';
import { createSnapshotWriter, snapshotKeyFor } from '../src/aws/objects.js';
import { SecretMissingError, createSecretsPort } from '../src/aws/secrets.js';
import { RingNotLinkedError, createTokenStore, linkedAccessToken, type TokenRecord } from '../src/aws/tokens.js';
import { JPEG_BYTES, fakeFetch, jsonResponse } from './fakes.js';

const stub = <T>(send: (command: unknown) => Promise<unknown>) => ({ send: vi.fn(send) }) as unknown as T & { send: ReturnType<typeof vi.fn> };

describe('secrets port', () => {
  it('reads once per five minutes per secret, and a write is visible without another read', async () => {
    let t = 0;
    const client = stub<SecretsManagerClient>(async cmd => {
      if (cmd instanceof GetSecretValueCommand) return { SecretString: `value-of-${cmd.input.SecretId}` };
      if (cmd instanceof PutSecretValueCommand) return {};
      throw new Error('unexpected');
    });
    const port = createSecretsPort(client, { now: () => t });
    expect(await port.read('a')).toBe('value-of-a');
    t = 299_999;
    expect(await port.read('a')).toBe('value-of-a');
    expect(client.send).toHaveBeenCalledTimes(1);
    t = 300_000;
    await port.read('a');
    expect(client.send).toHaveBeenCalledTimes(2);
    await port.write('a', 'new-value');
    expect((client.send.mock.calls[2]![0] as PutSecretValueCommand).input).toEqual({ SecretId: 'a', SecretString: 'new-value' });
    expect(await port.read('a')).toBe('new-value');
    expect(client.send).toHaveBeenCalledTimes(3);
  });

  it('reports a secret with no value as missing, naming the secret and nothing else', async () => {
    const client = stub<SecretsManagerClient>(async () => {
      throw Object.assign(new Error("Secrets Manager can't find the specified secret value for staging label: AWSCURRENT"), { name: 'ResourceNotFoundException' });
    });
    const err = await createSecretsPort(client).read('demo-homeledger/ring/tokens').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretMissingError);
    expect((err as Error).message).toBe('Secret demo-homeledger/ring/tokens has no value.');
  });
});

describe('token store', () => {
  const record: TokenRecord = {
    accountId: 'acct-123',
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: '2026-10-06T17:00:00.000Z',
    status: 'linked',
    updatedAt: '2026-10-06T13:00:00.000Z'
  };
  const memorySecrets = (initial: string | null) => {
    let value = initial;
    return {
      read: async () => {
        if (value === null) throw new SecretMissingError('Secret x has no value.');
        return value;
      },
      write: async (_: string, v: string) => {
        value = v;
      }
    };
  };

  it('round-trips a record as JSON', async () => {
    const store = createTokenStore(memorySecrets(null), 'x');
    expect(await store.read()).toBeNull();
    await store.write(record);
    expect(await store.read()).toEqual(record);
  });

  it('treats an unreadable record as no record rather than a crash', async () => {
    expect(await createTokenStore(memorySecrets('not json'), 'x').read()).toBeNull();
    expect(await createTokenStore(memorySecrets('{"accessToken":"at-1"}'), 'x').read()).toBeNull();
  });

  it('hands out the access token only once the account is linked', async () => {
    await expect(linkedAccessToken(createTokenStore(memorySecrets(null), 'x'))()).rejects.toBeInstanceOf(RingNotLinkedError);
    await expect(linkedAccessToken(createTokenStore(memorySecrets(JSON.stringify({ ...record, status: 'unclaimed' })), 'x'))()).rejects.toBeInstanceOf(RingNotLinkedError);
    expect(await linkedAccessToken(createTokenStore(memorySecrets(JSON.stringify(record)), 'x'))()).toBe('at-1');
  });
});

describe('event publisher', () => {
  it('puts entries on the named bus and throws if EventBridge refuses any', async () => {
    const ok = stub<EventBridgeClient>(async () => ({ FailedEntryCount: 0, Entries: [{ EventId: 'e1' }] }));
    await createEventPublisher('homeledger', ok)([{ source: HOMELEDGER_SOURCE, detailType: 'visit.arrived', detail: { cardType: 'visit.arrived', id: 'visit_abcdefghijklmnop' } }]);
    expect((ok.send.mock.calls[0]![0] as PutEventsCommand).input).toEqual({
      Entries: [{ EventBusName: 'homeledger', Source: 'homeledger.events', DetailType: 'visit.arrived', Detail: '{"cardType":"visit.arrived","id":"visit_abcdefghijklmnop"}' }]
    });
    const refused = stub<EventBridgeClient>(async () => ({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'InternalFailure' }] }));
    await expect(createEventPublisher('homeledger', refused)([{ source: HOMELEDGER_SOURCE, detailType: 'x', detail: {} }])).rejects.toThrow(
      'EventBridge refused 1 of 1 entries: InternalFailure'
    );
  });
});

describe('snapshot writer', () => {
  it('stores the bytes exactly as received, under the visit’s key', async () => {
    const s3 = stub<S3Client>(async () => ({}));
    await createSnapshotWriter('demo-homeledger-snapshots-123', s3)(snapshotKeyFor('hh_harlow', 'visit_abcdefghijklmnop', 'jpeg'), JPEG_BYTES, 'image/jpeg');
    const input = (s3.send.mock.calls[0]![0] as PutObjectCommand).input;
    expect([input.Bucket, input.Key, input.ContentType]).toEqual(['demo-homeledger-snapshots-123', 'snapshots/hh_harlow/visit_abcdefghijklmnop.jpg', 'image/jpeg']);
    expect(input.Body).toBe(JPEG_BYTES);
    expect(snapshotKeyFor('hh_harlow', 'visit_abcdefghijklmnop', 'png')).toBe('snapshots/hh_harlow/visit_abcdefghijklmnop.png');
  });
});

describe('describer (spec §5: Claude vision, one sentence, nobody identified)', () => {
  it('sends the image and the constrained instruction to the Messages API', async () => {
    const f = fakeFetch(() => jsonResponse(200, { content: [{ type: 'text', text: 'A person holding a toolbox stands at the front door.' }] }));
    const describe = createAnthropicDescriber({ apiKey: async () => 'sk-test', model: 'claude-sonnet-5', fetch: f.fetch });
    expect(await describe(JPEG_BYTES, 'image/jpeg')).toBe('A person holding a toolbox stands at the front door.');
    const req = f.calls[0]!;
    expect([req.url, req.method, req.headers['x-api-key'], req.headers['anthropic-version']]).toEqual([ANTHROPIC_MESSAGES_URL, 'POST', 'sk-test', '2023-06-01']);
    expect(JSON.parse(req.body!)).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 120,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG_BYTES.toString('base64') } },
            { type: 'text', text: DESCRIBE_INSTRUCTION }
          ]
        }
      ]
    });
  });

  it('forbids identifying anyone, in the instruction itself', () => {
    expect(DESCRIBE_INSTRUCTION).toMatch(/Never identify, name, or guess who anyone is/);
  });

  it('keeps one sentence of whatever comes back', () => {
    expect(oneSentence('  A van is parked at the curb.   A second sentence.')).toBe('A van is parked at the curb.');
    expect(oneSentence('No full stop at all')).toBe('No full stop at all');
  });

  it('fails with the status and never the key', async () => {
    const f = fakeFetch(() => jsonResponse(529, { type: 'error', error: { type: 'overloaded_error' } }));
    const err = await createAnthropicDescriber({ apiKey: async () => 'sk-test', model: 'claude-sonnet-5', fetch: f.fetch })(JPEG_BYTES, 'image/jpeg').catch((e: unknown) => e);
    expect((err as Error).message).toBe('The photo description failed with 529 overloaded_error');
  });

  it('fails when the reply holds no text', async () => {
    const f = fakeFetch(() => jsonResponse(200, { content: [] }));
    await expect(createAnthropicDescriber({ apiKey: async () => 'k', model: 'm', fetch: f.fetch })(JPEG_BYTES, 'image/jpeg')).rejects.toThrow('The photo description came back empty');
  });
});

describe('system alerts', () => {
  it('writes an open, high, deviceless alert carrying its own message', async () => {
    const putAlert = vi.fn(async () => {});
    const a = await raiseSystemAlert({ repo: { putAlert }, newId: () => 'alert_abcdefghijklmnop', now: () => '2026-10-06T13:00:00.000Z' }, 'Ring access lapsed.');
    expect(a).toEqual({
      id: 'alert_abcdefghijklmnop',
      sensorType: 'system',
      severity: 'high',
      ringDeviceId: null,
      message: 'Ring access lapsed.',
      deviceName: 'HomeLedger',
      at: '2026-10-06T13:00:00.000Z',
      maintenanceRef: null,
      status: 'open'
    });
    expect(putAlert).toHaveBeenCalledWith(a);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm install && pnpm --filter @homeledger/events test -- aws`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Create `apps/events/src/aws/secrets.ts`:

```ts
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export class SecretMissingError extends Error {}

export interface SecretsPort {
  read(secretId: string): Promise<string>;
  write(secretId: string, value: string): Promise<void>;
}

/**
 * Cached per container for five minutes: a warm Lambda serving a burst of
 * webhooks should not pay a Secrets Manager call per delivery. A write
 * replaces the cached value, so the token refresh and the link see their own
 * writes. Errors name the secret, never its value.
 */
export function createSecretsPort(client: SecretsManagerClient = new SecretsManagerClient({}), opts: { now?: () => number; ttlMs?: number } = {}): SecretsPort {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 300_000;
  const cache = new Map<string, { value: string; at: number }>();
  return {
    async read(secretId) {
      const hit = cache.get(secretId);
      if (hit && now() - hit.at < ttl) return hit.value;
      let value: string | undefined;
      try {
        value = (await client.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString;
      } catch (err) {
        if ((err as { name?: string }).name === 'ResourceNotFoundException') throw new SecretMissingError(`Secret ${secretId} has no value.`);
        throw err;
      }
      if (!value) throw new SecretMissingError(`Secret ${secretId} has no value.`);
      cache.set(secretId, { value, at: now() });
      return value;
    },
    async write(secretId, value) {
      await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: value }));
      cache.set(secretId, { value, at: now() });
    }
  };
}
```

Create `apps/events/src/aws/tokens.ts`:

```ts
import { SecretMissingError, type SecretsPort } from './secrets.js';

/**
 * The one linked Ring account's tokens, as JSON in `demo-homeledger/ring/tokens`.
 * `unclaimed` between the Token Exchange URL and the sign-in at the Account
 * Link URL (amendment §12.1); `linked` after the PATCH succeeds; `lapsed`
 * once Ring refuses the refresh token, so the refresh job raises its alert
 * once rather than every half hour (Task 11).
 */
export interface TokenRecord {
  accountId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  status: 'unclaimed' | 'linked' | 'lapsed';
  updatedAt: string;
}

export interface TokenStore {
  read(): Promise<TokenRecord | null>;
  write(record: TokenRecord): Promise<void>;
}

export class RingNotLinkedError extends Error {}

function isRecord(v: unknown): v is TokenRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    ['accountId', 'accessToken', 'refreshToken', 'expiresAt', 'updatedAt'].every(k => typeof r[k] === 'string') && (r.status === 'unclaimed' || r.status === 'linked' || r.status === 'lapsed')
  );
}

export function createTokenStore(secrets: SecretsPort, secretId: string): TokenStore {
  return {
    async read() {
      let raw: string;
      try {
        raw = await secrets.read(secretId);
      } catch (err) {
        if (err instanceof SecretMissingError) return null;
        throw err;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        return isRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    async write(record) {
      await secrets.write(secretId, JSON.stringify(record));
    }
  };
}

export function linkedAccessToken(store: TokenStore): () => Promise<string> {
  return async () => {
    const record = await store.read();
    if (!record || record.status !== 'linked') throw new RingNotLinkedError('Ring is not linked to HomeLedger yet.');
    return record.accessToken;
  };
}
```

Create `apps/events/src/aws/bus.ts`:

```ts
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

/** Raw Ring events arrive from the webhook as `ring.webhook`; HomeLedger's own outcomes (visit.arrived, alert.raised) as `homeledger.events`. */
export const RING_SOURCE = 'ring.webhook';
export const HOMELEDGER_SOURCE = 'homeledger.events';

export interface BusEntry {
  source: typeof RING_SOURCE | typeof HOMELEDGER_SOURCE;
  detailType: string;
  detail: Record<string, unknown>;
}

export type EventPublisher = (entries: BusEntry[]) => Promise<void>;

/** PutEvents answers 200 even when entries fail; any failed entry is a failure here, so the webhook answers 500 and Ring retries. */
export function createEventPublisher(busName: string, client: EventBridgeClient = new EventBridgeClient({})): EventPublisher {
  return async entries => {
    const out = await client.send(
      new PutEventsCommand({ Entries: entries.map(e => ({ EventBusName: busName, Source: e.source, DetailType: e.detailType, Detail: JSON.stringify(e.detail) })) })
    );
    const failed = out.FailedEntryCount ?? 0;
    if (failed > 0) {
      const codes = (out.Entries ?? []).map(e => e.ErrorCode).filter((c): c is string => Boolean(c));
      throw new Error(`EventBridge refused ${failed} of ${entries.length} entries: ${codes.join(', ') || 'no error code'}`);
    }
  };
}
```

Create `apps/events/src/aws/objects.ts`:

```ts
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export type PutSnapshot = (key: string, bytes: Buffer, contentType: string) => Promise<void>;

/** Byte-for-byte: Ring's watermark is mandatory, so the image is never re-encoded (spec §5). */
export function createSnapshotWriter(bucket: string, client: S3Client = new S3Client({})): PutSnapshot {
  return async (key, bytes, contentType) => {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }));
  };
}

export function snapshotKeyFor(householdId: string, visitId: string, kind: 'jpeg' | 'png'): string {
  return `snapshots/${householdId}/${visitId}.${kind === 'png' ? 'png' : 'jpg'}`;
}
```

Create `apps/events/src/aws/describe.ts`:

```ts
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Spec §5 and §7's content rule. The sentence describes the scene; who the
 * visitor is comes from HomeLedger's booking match, and the card says so.
 */
export const DESCRIBE_INSTRUCTION =
  'Describe what is visible in this doorbell photo in one plain sentence of at most twenty-five words: clothing, objects, vehicles, and the scene. Never identify, name, or guess who anyone is, and do not guess anyone’s age, gender, ethnicity, or job. If the picture is too dark or blurred to describe, say that in one sentence.';

export type Describer = (image: Buffer, mediaType: 'image/jpeg' | 'image/png') => Promise<string>;

export function oneSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  return (end === -1 ? flat : flat.slice(0, end + 1)).slice(0, 240);
}

export function createAnthropicDescriber(opts: { apiKey: () => Promise<string>; model: string; fetch?: typeof fetch }): Describer {
  const f = opts.fetch ?? fetch;
  return async (image, mediaType) => {
    const res = await f(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-api-key': await opts.apiKey(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 120,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: image.toString('base64') } },
              { type: 'text', text: DESCRIBE_INSTRUCTION }
            ]
          }
        ]
      })
    });
    if (!res.ok) {
      let kind = '';
      try {
        const body = (await res.json()) as { error?: { type?: unknown } };
        if (typeof body.error?.type === 'string') kind = ` ${body.error.type}`;
      } catch {
        /* no body */
      }
      throw new Error(`The photo description failed with ${res.status}${kind}`);
    }
    const body = (await res.json()) as { content?: Array<{ type?: unknown; text?: unknown }> };
    const text = (body.content ?? [])
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text as string)
      .join(' ');
    const sentence = oneSentence(text);
    if (!sentence) throw new Error('The photo description came back empty');
    return sentence;
  };
}
```

Create `apps/events/src/aws/alerts.ts`:

```ts
import type { Alert, Repository } from '@homeledger/core';

/**
 * The one way HomeLedger's own failures become visible: an open, high,
 * deviceless ALERT# row that `recent_events` reads out (spec §3 "never
 * silent", §4 dead letters). Callers publish `alert.raised` if a display
 * should hear it now.
 */
export async function raiseSystemAlert(deps: { repo: Pick<Repository, 'putAlert'>; newId: () => string; now: () => string }, message: string): Promise<Alert> {
  const alert: Alert = {
    id: deps.newId(),
    sensorType: 'system',
    severity: 'high',
    ringDeviceId: null,
    message,
    deviceName: 'HomeLedger',
    at: deps.now(),
    maintenanceRef: null,
    status: 'open'
  };
  await deps.repo.putAlert(alert);
  return alert;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @homeledger/core build && pnpm --filter @homeledger/events test && pnpm --filter @homeledger/events typecheck`
Expected: PASS.

- [ ] **Step 5: Mutation check**

Apply each, run, record, revert:
1. `now() - hit.at < ttl` → `<=` → the cache test fails at `t = 300_000`.
2. Drop `cache.set` in `write` → the "write is visible" call count fails (4 sends, not 3).
3. In the token store, accept any object (return `parsed` unchecked) → the unreadable-record test fails on the partial record.
4. In `linkedAccessToken`, drop `record.status !== 'linked'` → the unclaimed assertion fails.
5. In the publisher, ignore `FailedEntryCount` → the refusal test fails.
6. In the describer, send `media_type: 'image/png'` always → the request-body test fails.
7. Put `await opts.apiKey()` into the failure message → the exact-message test fails.

- [ ] **Step 6: Commit**

```bash
git add apps/events pnpm-lock.yaml
git commit -m "feat(events): secrets, token store, event bus, snapshot writer, system alerts, and the Claude vision describer as ports"
```

---
### Task 8: Webhook ingest (`POST /ring/webhook`)

**Files:**
- Create: `apps/events/src/handlers/webhook.ts`
- Delete: `apps/events/src/handlers/.gitkeep`
- Modify: `apps/events/test/fakes.ts` (add `recordingPublisher`, `signedRequest`)
- Test: `apps/events/test/webhook.test.ts`

**Interfaces:**
- Consumes: `verifyWebhookSignature`, `decodeWebhook` (T5); `EventPublisher`, `RING_SOURCE`, `createSecretsPort`, `createEventPublisher` (T7); `Repository.claimEvent`, `markEventPublished`, `getDevice` (T3); `derivedId` (core).
- Produces:

```ts
export interface WebhookDeps {
  hmacKey: () => Promise<string>;
  repo: Pick<Repository, 'claimEvent' | 'markEventPublished' | 'getDevice'>;
  publish: EventPublisher;
  now: () => string;
}
export interface HttpRequest { body: string | undefined; isBase64Encoded: boolean; headers: Record<string, string | undefined> }
export interface HttpReply { statusCode: number; headers?: Record<string, string>; body: string }
export function handleWebhook(deps: WebhookDeps, req: HttpRequest): Promise<HttpReply>;
export const handler: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;
```

`HttpRequest` and `HttpReply` are exported from `webhook.ts` and reused by Task 9's handlers.

**The detail every rule receives.** Each Ring delivery goes onto the bus as `source: 'ring.webhook'`, `detail-type: <Ring event type>`, and this `detail` — the EventBridge rules in Task 13 match on `detail-type` and on `detail.subType`:

```ts
{ requestId, accountId, eventId, type, subType, deviceId, deviceName, at }
```

**The environment contract.** Every handler reads only these names, through `requireEnv` / `optionalEnv` / `flagEnv`, per invocation. Task 13 sets exactly these on the Lambdas; nothing else may be invented downstream.

| Name | Meaning | Read by |
|---|---|---|
| `TABLE_NAME`, `HOUSEHOLD_ID` | the HomeLedger table and the one household | every handler that touches the repository |
| `EVENT_BUS_NAME` | the custom bus | webhook, visit-correlator, sensor-rules, sensor-poller, token-refresh, dlq-alerter, link |
| `RING_CLIENT_ID` | not a secret (spec §3) | token-exchange, token-refresh |
| `RING_CLIENT_SECRET_ID`, `RING_HMAC_SECRET_ID`, `RING_TOKENS_SECRET_ID`, `RING_LINK_PASSPHRASE_SECRET_ID`, `ANTHROPIC_KEY_SECRET_ID` | secret **names**, never values | as the spec §3 table grants |
| `ANTHROPIC_MODEL` | default `claude-sonnet-5` | visit-correlator |
| `SNAPSHOT_BUCKET` | snapshot bucket name | visit-correlator |
| `SENSORS_ENABLED` | `'1'` enables the sensor path (spec §6 flag) | sensor-rules, sensor-poller |
| `SENSOR_APPLIANCE_ID` | R12 | sensor-rules, sensor-poller |
| `PUSH_ENDPOINT` | `https://<api>.execute-api.<region>.amazonaws.com/<stage>` | push |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | the simulator's client-credentials issuer | ws-authorizer |

**Status codes, from amendment §12.3.** Ring never retries a 4xx and retries 5xx. So: bad signature → **401**; unparseable body or no `request_id` → **400**; anything transient (the HMAC key cannot be read, the table or the bus is unavailable) → **500**; accepted or already published → **200**.

- [ ] **Step 1: Grow the fakes**

Append to `apps/events/test/fakes.ts`:

```ts
import type { BusEntry, EventPublisher } from '../src/aws/bus.js';
import { webhookSignature } from '../src/ring/hmac.js';

export const TEST_HMAC_KEY = 'test-hmac-signing-key';

export function recordingPublisher(): { publish: EventPublisher; entries: BusEntry[]; failNext: (n: number) => void } {
  const entries: BusEntry[] = [];
  let failures = 0;
  return {
    entries,
    failNext: n => {
      failures = n;
    },
    publish: async batch => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('EventBridge refused 1 of 1 entries: InternalFailure');
      }
      entries.push(...batch);
    }
  };
}

/** A webhook request as API Gateway (HTTP API, payload v2) hands it over: lower-case headers, body as a string. */
export function signedRequest(payload: unknown, opts: { key?: string; base64?: boolean; signature?: string | null } = {}) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = opts.signature === undefined ? webhookSignature(raw, opts.key ?? TEST_HMAC_KEY) : opts.signature;
  return {
    body: opts.base64 ? raw.toString('base64') : raw.toString('utf8'),
    isBase64Encoded: opts.base64 === true,
    headers: { 'content-type': 'application/json', ...(signature === null ? {} : { 'x-signature': signature }) } as Record<string, string | undefined>
  };
}
```

(Move the two new `import` lines to the top of the file with the existing import.)

- [ ] **Step 2: Write the failing tests**

Create `apps/events/test/webhook.test.ts`:

```ts
import { createMemoryRepository, type Repository } from '@homeledger/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleWebhook, type WebhookDeps } from '../src/handlers/webhook.js';
import { webhookSignature } from '../src/ring/hmac.js';
import { TEST_HMAC_KEY, fixture, recordingPublisher, signedRequest } from './fakes.js';

let repo: Repository;
let bus: ReturnType<typeof recordingPublisher>;
let deps: WebhookDeps;

beforeEach(async () => {
  repo = createMemoryRepository('hh_test');
  bus = recordingPublisher();
  deps = { hmacKey: async () => TEST_HMAC_KEY, repo, publish: bus.publish, now: () => '2026-10-06T13:20:02.000Z' };
  await repo.putDevice({ id: 'dev_aaaaaaaaaaaaaaaa', ringDeviceId: 'dev-doorbell-1', name: 'Front Door', kind: 'doorbell', online: true, lastSeenAt: null, sensorState: null });
});

describe('webhook ingest (spec §4, amendment §12.3)', () => {
  it('verifies, records, and publishes a button press with the device’s name', async () => {
    const reply = await handleWebhook(deps, signedRequest(fixture('button-press')));
    expect([reply.statusCode, JSON.parse(reply.body)]).toEqual([200, { status: 'accepted' }]);
    expect(bus.entries).toEqual([
      {
        source: 'ring.webhook',
        detailType: 'button_press',
        detail: {
          requestId: 'req-bp-0001',
          accountId: 'acct-123',
          eventId: 'evt-bp-0001',
          type: 'button_press',
          subType: null,
          deviceId: 'dev-doorbell-1',
          deviceName: 'Front Door',
          at: '2026-10-06T13:20:00.000Z'
        }
      }
    ]);
    const rows = await repo.listEvents('2026-10-06T00:00:00.000Z');
    expect(rows.map(r => [r.ringEventId, r.type, r.deviceName, r.at])).toEqual([['req-bp-0001', 'button_press', 'Front Door', '2026-10-06T13:20:00.000Z']]);
  });

  it('verifies a body API Gateway delivered as Base64 against its decoded bytes', async () => {
    expect((await handleWebhook(deps, signedRequest(fixture('button-press'), { base64: true }))).statusCode).toBe(200);
  });

  it('answers 401 and does nothing for a bad or missing signature — Ring does not retry a 4xx', async () => {
    expect((await handleWebhook(deps, signedRequest(fixture('button-press'), { key: 'other-key' }))).statusCode).toBe(401);
    expect((await handleWebhook(deps, signedRequest(fixture('button-press'), { signature: null }))).statusCode).toBe(401);
    expect(bus.entries).toEqual([]);
    expect(await repo.listEvents('2026-10-06T00:00:00.000Z')).toEqual([]);
  });

  it('answers 200 and publishes nothing for a redelivery of an event already on the bus', async () => {
    await handleWebhook(deps, signedRequest(fixture('button-press')));
    const again = await handleWebhook(deps, signedRequest(fixture('button-press')));
    expect([again.statusCode, JSON.parse(again.body)]).toEqual([200, { status: 'duplicate' }]);
    expect(bus.entries).toHaveLength(1);
  });

  it('answers 500 when publishing fails, and lets Ring’s retry through to publish it once', async () => {
    bus.failNext(1);
    const first = await handleWebhook(deps, signedRequest(fixture('button-press')));
    expect(first.statusCode).toBe(500);
    expect(bus.entries).toEqual([]);
    const retry = await handleWebhook(deps, signedRequest(fixture('button-press')));
    expect(retry.statusCode).toBe(200);
    expect(bus.entries).toHaveLength(1);
    expect(await repo.listEvents('2026-10-06T00:00:00.000Z')).toHaveLength(1);
  });

  it('answers 500 when the signing key cannot be read, so Ring retries', async () => {
    const reply = await handleWebhook({ ...deps, hmacKey: async () => Promise.reject(new Error('throttled')) }, signedRequest(fixture('button-press')));
    expect(reply.statusCode).toBe(500);
  });

  it('answers 400 for a body with no request id, and for a body that is not JSON', async () => {
    const payload = fixture<{ meta: object; data: object }>('button-press');
    expect((await handleWebhook(deps, signedRequest({ ...payload, meta: {} }))).statusCode).toBe(400);
    const raw = Buffer.from('{not json', 'utf8');
    expect((await handleWebhook(deps, { body: raw.toString('utf8'), isBase64Encoded: false, headers: { 'x-signature': webhookSignature(raw, TEST_HMAC_KEY) } })).statusCode).toBe(400);
  });

  it('stores and publishes an event type nothing routes, and names an unknown device plainly', async () => {
    const reply = await handleWebhook(deps, signedRequest(fixture('flood-detected')));
    expect(reply.statusCode).toBe(200);
    expect(bus.entries[0]!.detailType).toBe('flood_detected');
    expect(bus.entries[0]!.detail.deviceName).toBe('Ring device');
  });

  it('records an account-level event against the account, not a device', async () => {
    await handleWebhook(deps, signedRequest(fixture('app-integration-added')));
    expect(bus.entries[0]!.detail).toMatchObject({ type: 'app_integration_added', deviceId: null, deviceName: 'Ring account' });
    expect((await repo.listEvents('1970-01-01T00:00:00.000Z'))[0]!.deviceId).toBe('account:acct-123');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @homeledger/events test -- webhook`
Expected: FAIL — `../src/handlers/webhook.js` not found.

- [ ] **Step 4: Implement**

Delete `apps/events/src/handlers/.gitkeep`. Create `apps/events/src/handlers/webhook.ts`:

```ts
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createDynamoRepository, derivedId, type Event, type Repository } from '@homeledger/core';
import { RING_SOURCE, createEventPublisher, type EventPublisher } from '../aws/bus.js';
import { createSecretsPort } from '../aws/secrets.js';
import { requireEnv } from '../env.js';
import { decodeWebhook } from '../ring/envelope.js';
import { verifyWebhookSignature } from '../ring/hmac.js';

export interface WebhookDeps {
  hmacKey: () => Promise<string>;
  repo: Pick<Repository, 'claimEvent' | 'markEventPublished' | 'getDevice'>;
  publish: EventPublisher;
  now: () => string;
}

export interface HttpRequest {
  body: string | undefined;
  isBase64Encoded: boolean;
  headers: Record<string, string | undefined>;
}

export interface HttpReply {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

const reply = (statusCode: number, body: Record<string, unknown>): HttpReply => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ msg: 'webhook', ...fields }));

/**
 * Spec §4 in order: verify, decode, dedupe, publish. Inside Ring's 5-second
 * budget because it does nothing slow — the work happens behind the bus.
 */
export async function handleWebhook(deps: WebhookDeps, req: HttpRequest): Promise<HttpReply> {
  const raw = Buffer.from(req.body ?? '', req.isBase64Encoded ? 'base64' : 'utf8');
  let key: string;
  try {
    key = await deps.hmacKey();
  } catch (err) {
    log({ outcome: 'key-unavailable', error: err instanceof Error ? err.message : String(err) });
    return reply(500, { error: 'temporarily unavailable' });
  }
  if (!verifyWebhookSignature(raw, req.headers['x-signature'], key)) {
    log({ outcome: 'bad-signature' });
    return reply(401, { error: 'signature' });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return reply(400, { error: 'body is not JSON' });
  }
  const decoded = decodeWebhook(body, deps.now());
  if (!decoded.ok) return reply(400, { error: decoded.reason });
  const e = decoded.event;

  try {
    const device = e.deviceId ? await deps.repo.getDevice(e.deviceId) : null;
    const deviceName = device?.name ?? (e.deviceId ? 'Ring device' : 'Ring account');
    const row: Event = {
      id: derivedId('evt', e.requestId),
      ringEventId: e.requestId,
      type: e.type,
      subType: e.subType,
      deviceId: e.deviceId ?? `account:${e.accountId ?? 'unknown'}`,
      deviceName,
      at: e.at,
      rawS3Key: null
    };
    const claim = await deps.repo.claimEvent(row);
    if (claim === 'published') {
      log({ outcome: 'duplicate', type: e.type, requestId: e.requestId });
      return reply(200, { status: 'duplicate' });
    }
    await deps.publish([
      {
        source: RING_SOURCE,
        detailType: e.type,
        detail: { requestId: e.requestId, accountId: e.accountId, eventId: e.eventId, type: e.type, subType: e.subType, deviceId: e.deviceId, deviceName, at: e.at }
      }
    ]);
    try {
      await deps.repo.markEventPublished(e.requestId);
    } catch (err) {
      // Published but not marked: a retry would publish again. Every rule
      // downstream is idempotent (conditional arrival, state transitions), so
      // a 200 here is safer than a 500 that guarantees the duplicate.
      log({ outcome: 'published-unmarked', requestId: e.requestId, error: err instanceof Error ? err.message : String(err) });
    }
    // The raw body is logged so the live run can turn real deliveries into
    // fixtures (Plan 4 R10, Task 18). It carries Ring identifiers and a
    // timestamp, never a credential; the signature header is not logged.
    log({ outcome: claim === 'retry' ? 'republished' : 'accepted', type: e.type, requestId: e.requestId, body: raw.toString('utf8').slice(0, 4096) });
    return reply(200, { status: 'accepted' });
  } catch (err) {
    log({ outcome: 'transient-failure', type: e.type, requestId: e.requestId, error: err instanceof Error ? err.message : String(err) });
    return reply(500, { error: 'temporarily unavailable' });
  }
}

let live: WebhookDeps | undefined;
function liveDeps(): WebhookDeps {
  if (live) return live;
  const secrets = createSecretsPort();
  live = {
    hmacKey: () => secrets.read(requireEnv('RING_HMAC_SECRET_ID')),
    repo: createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') }),
    publish: createEventPublisher(requireEnv('EVENT_BUS_NAME')),
    now: () => new Date().toISOString()
  };
  return live;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> =>
  handleWebhook(liveDeps(), { body: event.body, isBase64Encoded: event.isBase64Encoded, headers: event.headers });
```

- [ ] **Step 5: Run the tests and the build**

Run: `pnpm --filter @homeledger/core build && pnpm --filter @homeledger/events test && pnpm --filter @homeledger/events build`
Expected: PASS; `built 1 handler(s): webhook`, and `apps/events/dist/webhook/index.mjs` exists.

- [ ] **Step 6: Mutation check**

Apply each, run, record, revert:
1. Verify against `Buffer.from(req.body ?? '', 'utf8')` regardless of `isBase64Encoded` → the Base64 test fails.
2. Return 200 on a bad signature → the 401 test fails (and its "nothing stored" assertions).
3. Answer 200 when `claim === 'retry'` without publishing → the publish-failure test fails at the retry.
4. Return 400 (not 500) when publishing throws → the publish-failure test's first assertion fails.
5. Drop the `deviceName` lookup (always `'Ring device'`) → the first test fails.

- [ ] **Step 7: Commit**

```bash
git add apps/events
git commit -m "feat(events): webhook ingest - verify, decode, claim once, publish, with Ring's retry semantics"
```

---
### Task 9: Linking (Token Exchange URL, Account Link URL) and device sync

Amendment §12.1 end to end, plus the device sync that follows a link and every `device_*` event.

**Files:**
- Create: `apps/events/src/handlers/token-exchange.ts`, `apps/events/src/handlers/link.ts`, `apps/events/src/handlers/device-sync.ts`
- Modify: `apps/events/test/fakes.ts` (add `fakeRingApi`, `memoryTokenStore`)
- Test: `apps/events/test/linking.test.ts`, `apps/events/test/device-sync.test.ts`

**Interfaces:**
- Consumes: `RingOAuth`, `RingApi`, `createRingOAuth`, `createRingApi` (T6); `TokenStore`, `TokenRecord`, `createTokenStore`, `createSecretsPort`, `raiseSystemAlert`, `createEventPublisher`, `HOMELEDGER_SOURCE` (T7); `verifyLinkNonce`, `isFreshLinkTime` (T5); `HttpRequest`, `HttpReply` (T8); `derivedId`, `newId`, `pushPayload`, `Repository`, `Device` (core).
- Produces:

```ts
// token-exchange.ts
export interface TokenExchangeDeps { oauth: () => Promise<RingOAuth>; accountIdFor: (accessToken: string) => Promise<string>; store: TokenStore; now: () => string }
export function handleTokenExchange(deps: TokenExchangeDeps, req: HttpRequest): Promise<HttpReply>;

// link.ts
export function accountIdentifierFor(householdId: string): string; // 'hh_harlow' -> 'hh_h***w'
export interface LinkDeps {
  hmacKey: () => Promise<string>;
  passphrase: () => Promise<string>;
  store: TokenStore;
  apiFor: (accessToken: string) => Pick<RingApi, 'confirmLink' | 'completeLink' | 'listDevices' | 'deviceStatus'>;
  sync: (api: Pick<RingApi, 'listDevices' | 'deviceStatus'>) => Promise<Device[]>;
  householdId: string;
  nowMs: () => number;
}
export function handleLink(deps: LinkDeps, req: HttpRequest & { method: string; query: Record<string, string | undefined> }): Promise<HttpReply>;

// device-sync.ts
export interface SyncDeps { repo: Pick<Repository, 'listDevices' | 'getDevice' | 'putDevice'>; now: () => string }
export function syncDevices(deps: SyncDeps, api: Pick<RingApi, 'listDevices' | 'deviceStatus'>): Promise<Device[]>;
export const RING_UNLINKED_MESSAGE: string;
export interface DeviceEventDeps { sync: () => Promise<Device[]>; raiseUnlinked: () => Promise<void> }
export function handleDeviceEvent(deps: DeviceEventDeps, detailType: string): Promise<'synced' | 'unlinked' | 'ignored'>;
```

**Sign-in (R1).** Ring requires the Account Link URL to present a sign-in (amendment §12.1). HomeLedger has no user accounts, so the sign-in is one field — the household passphrase from `demo-homeledger/ring/link-passphrase` — compared in constant time over SHA-256 digests (equal lengths, so `timingSafeEqual` cannot throw and the comparison cannot leak the length). The page is served with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'`, `X-Frame-Options: DENY` and `Cache-Control: no-store`. The `nonce` and `time` are validated against `^[A-Za-z0-9_-]{43}$` and `^\d{13}$` before they are echoed into the page, so nothing unvalidated reaches the HTML.

**Device sync never sets sensor state (R3).** It records a device as a `sensor` when its status carries a flood or freeze detector, keeps any kind already learned (a `doorbell` learned from a press), and otherwise records `other`. It leaves `sensorState` alone: if sync wrote the detector values it read, a flood already in progress at sync time would become the "known" state and never raise an alert. Transitions belong to the sensor rules (Task 11).

- [ ] **Step 1: Grow the fakes**

Append to `apps/events/test/fakes.ts`:

```ts
import type { RingApi, RingDeviceStatus } from '../src/ring/client.js';
import type { TokenRecord, TokenStore } from '../src/aws/tokens.js';

export function memoryTokenStore(initial: TokenRecord | null = null): TokenStore & { current: () => TokenRecord | null } {
  let record = initial;
  return {
    read: async () => record,
    write: async r => {
      record = r;
    },
    current: () => record
  };
}

/** A Ring API that answers from tables and records the order of calls. */
export function fakeRingApi(opts: {
  devices?: Array<{ id: string; name: string }>;
  statuses?: Record<string, RingDeviceStatus | Error>;
  refuse?: Partial<Record<'confirmLink' | 'completeLink', Error>>;
}): RingApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    accountId: async () => 'acct-123',
    listDevices: async () => {
      calls.push('listDevices');
      return opts.devices ?? [];
    },
    deviceStatus: async id => {
      calls.push(`deviceStatus:${id}`);
      const s = opts.statuses?.[id];
      if (s instanceof Error) throw s;
      return s ?? { online: true, flood: null, freeze: null };
    },
    confirmLink: async (nonce, who) => {
      calls.push(`confirmLink:${nonce}:${who}`);
      if (opts.refuse?.confirmLink) throw opts.refuse.confirmLink;
    },
    completeLink: async who => {
      calls.push(`completeLink:${who}`);
      if (opts.refuse?.completeLink) throw opts.refuse.completeLink;
    },
    requestImage: async () => ({ kind: 'refused', status: 416, code: 'MEDIA_NOT_FOUND' })
  };
}
```

(Move the new imports to the top of the file.)

- [ ] **Step 2: Write the failing linking tests**

Create `apps/events/test/linking.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Device } from '@homeledger/core';
import { handleLink, accountIdentifierFor, type LinkDeps } from '../src/handlers/link.js';
import { handleTokenExchange } from '../src/handlers/token-exchange.js';
import { RingApiError, type RingOAuth } from '../src/ring/client.js';
import type { TokenRecord } from '../src/aws/tokens.js';
import { TEST_HMAC_KEY, fakeRingApi, memoryTokenStore } from './fakes.js';

const T = 1771130906289; // the link's time parameter, ms
const NONCE = 'IEV-fda_gDgbfFvtVJ1Bbi10n29TIGJ6e2v0ZmJ8N1c'; // for acct-123 at T under TEST_HMAC_KEY (Task 5)
const form = (fields: Record<string, string>) => ({ body: new URLSearchParams(fields).toString(), isBase64Encoded: false, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
const unclaimed: TokenRecord = { accountId: 'acct-123', accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: '2026-10-06T17:00:00.000Z', status: 'unclaimed', updatedAt: '2026-10-06T13:00:00.000Z' };

describe('Token Exchange URL (amendment §12.1 step 2)', () => {
  const oauth = (answer: 'ok' | 'fail'): RingOAuth => ({
    exchangeCode: vi.fn(async (code: string) => {
      if (answer === 'fail') throw new RingApiError(400, 'invalid_grant', 'The Ring code exchange failed with 400 invalid_grant');
      expect(code).toBe('code-abc');
      return { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: '2026-10-06T17:00:00.000Z' };
    }),
    refresh: vi.fn()
  });

  it('exchanges the code, reads the account, and holds the tokens unclaimed until the owner signs in', async () => {
    const store = memoryTokenStore();
    const reply = await handleTokenExchange({ oauth: async () => oauth('ok'), accountIdFor: async t => (t === 'at-1' ? 'acct-123' : 'wrong'), store, now: () => '2026-10-06T13:00:00.000Z' }, form({ code: 'code-abc' }));
    expect(reply.statusCode).toBe(200);
    expect(store.current()).toEqual(unclaimed);
  });

  it('answers 400 with no code, and 502 without writing anything when Ring refuses the exchange', async () => {
    const store = memoryTokenStore();
    const deps = { oauth: async () => oauth('fail'), accountIdFor: async () => 'acct-123', store, now: () => '2026-10-06T13:00:00.000Z' };
    expect((await handleTokenExchange(deps, form({}))).statusCode).toBe(400);
    expect((await handleTokenExchange(deps, form({ code: 'code-abc' }))).statusCode).toBe(502);
    expect(store.current()).toBeNull();
  });

  it('refuses a second Ring account while one is linked — v1 is one household, one account', async () => {
    const store = memoryTokenStore({ ...unclaimed, accountId: 'acct-999', status: 'linked' });
    const reply = await handleTokenExchange({ oauth: async () => oauth('ok'), accountIdFor: async () => 'acct-123', store, now: () => 'x' }, form({ code: 'code-abc' }));
    expect(reply.statusCode).toBe(409);
    expect(store.current()?.accountId).toBe('acct-999');
  });
});

describe('Account Link URL (amendment §12.1 steps 3–5)', () => {
  const devices: Device[] = [];
  const deps = (over: Partial<LinkDeps> = {}): LinkDeps & { api: ReturnType<typeof fakeRingApi>; store: ReturnType<typeof memoryTokenStore> } => {
    const api = fakeRingApi({ devices: [{ id: 'dev-doorbell-1', name: 'Front Door' }] });
    const store = memoryTokenStore(unclaimed);
    return {
      hmacKey: async () => TEST_HMAC_KEY,
      passphrase: async () => 'correct horse battery staple',
      store,
      apiFor: token => {
        expect(token).toBe('at-1');
        return api;
      },
      sync: async () => [
        { id: 'dev_aaaaaaaaaaaaaaaa', ringDeviceId: 'dev-doorbell-1', name: 'Front Door', kind: 'other', online: true, lastSeenAt: null, sensorState: null },
        ...devices
      ],
      householdId: 'hh_harlow',
      nowMs: () => T + 60_000,
      api,
      ...over
    } as LinkDeps & { api: ReturnType<typeof fakeRingApi>; store: ReturnType<typeof memoryTokenStore> };
  };
  const get = (query: Record<string, string>) => ({ method: 'GET', query, body: undefined, isBase64Encoded: false, headers: {} });
  const post = (fields: Record<string, string>) => ({ method: 'POST', query: {}, ...form(fields) });

  it('masks the household as the account identifier Ring shows the owner', () => {
    expect(accountIdentifierFor('hh_harlow')).toBe('hh_h***w');
  });

  it('shows a sign-in form carrying the nonce and time, locked down against framing and scripts', async () => {
    const reply = await handleLink(deps(), get({ nonce: NONCE, time: String(T) }));
    expect(reply.statusCode).toBe(200);
    expect(reply.headers).toEqual({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"
    });
    expect(reply.body).toContain(`<input type="hidden" name="nonce" value="${NONCE}">`);
    expect(reply.body).toContain(`<input type="hidden" name="time" value="${T}">`);
    expect(reply.body).toContain('<input type="password" name="passphrase"');
  });

  it('refuses a stale or malformed link before showing any form', async () => {
    expect((await handleLink(deps({ nowMs: () => T + 600_001 }), get({ nonce: NONCE, time: String(T) }))).statusCode).toBe(400);
    expect((await handleLink(deps(), get({ nonce: '<script>', time: String(T) }))).statusCode).toBe(400);
    expect((await handleLink(deps(), get({ nonce: NONCE }))).statusCode).toBe(400);
  });

  it('with the right passphrase and a matching nonce, confirms then completes the link, marks it linked, and syncs devices', async () => {
    const d = deps();
    const reply = await handleLink(d, post({ nonce: NONCE, time: String(T), passphrase: 'correct horse battery staple' }));
    expect(reply.statusCode).toBe(200);
    expect(d.api.calls).toEqual([`confirmLink:${NONCE}:hh_h***w`, 'completeLink:hh_h***w']);
    expect(d.store.current()?.status).toBe('linked');
    expect(reply.body).toContain('Ring is linked to HomeLedger. Found 1 device: Front Door.');
  });

  it('answers 401 for the wrong passphrase and calls Ring for nothing', async () => {
    const d = deps();
    expect((await handleLink(d, post({ nonce: NONCE, time: String(T), passphrase: 'wrong' }))).statusCode).toBe(401);
    expect(d.api.calls).toEqual([]);
    expect(d.store.current()?.status).toBe('unclaimed');
  });

  it('answers 400 when the nonce belongs to another account or another moment', async () => {
    const d = deps();
    expect((await handleLink(d, post({ nonce: NONCE, time: String(T + 1), passphrase: 'correct horse battery staple' }))).statusCode).toBe(400);
    expect(d.api.calls).toEqual([]);
  });

  it('answers 409 when Ring has not sent the tokens yet', async () => {
    const d = deps({ store: memoryTokenStore(null) });
    expect((await handleLink(d, post({ nonce: NONCE, time: String(T), passphrase: 'correct horse battery staple' }))).statusCode).toBe(409);
  });

  it('answers 502 and leaves the tokens unclaimed when Ring refuses to complete the link', async () => {
    const api = fakeRingApi({ refuse: { completeLink: new RingApiError(400, 'INVALID_STATUS_TRANSITION', 'x') } });
    const d = deps({ apiFor: () => api });
    const reply = await handleLink(d, post({ nonce: NONCE, time: String(T), passphrase: 'correct horse battery staple' }));
    expect(reply.statusCode).toBe(502);
    expect(reply.body).toContain('Ring refused the link (400 INVALID_STATUS_TRANSITION).');
    expect(d.store.current()?.status).toBe('unclaimed');
  });

  it('still reports the link as done when only the device sync fails — the nightly sync recovers it', async () => {
    const d = deps({ sync: async () => Promise.reject(new Error('throttled')) });
    const reply = await handleLink(d, post({ nonce: NONCE, time: String(T), passphrase: 'correct horse battery staple' }));
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toContain('Ring is linked to HomeLedger. The device list will appear within a day.');
  });
});
```

- [ ] **Step 3: Write the failing device-sync tests**

Create `apps/events/test/device-sync.test.ts`:

```ts
import { createMemoryRepository, derivedId } from '@homeledger/core';
import { describe, expect, it, vi } from 'vitest';
import { RING_UNLINKED_MESSAGE, handleDeviceEvent, syncDevices } from '../src/handlers/device-sync.js';
import { fakeRingApi } from './fakes.js';

const now = () => '2026-10-06T12:00:00.000Z';

describe('syncDevices (amendment §12.6, R3)', () => {
  it('records a device with a flood or freeze detector as a sensor, anything else as other, with stable ids', async () => {
    const repo = createMemoryRepository('hh_test');
    const api = fakeRingApi({
      devices: [
        { id: 'dev-doorbell-1', name: 'Front Door' },
        { id: 'dev-flood-1', name: 'Water Heater' }
      ],
      statuses: { 'dev-flood-1': { online: true, flood: false, freeze: false } }
    });
    await syncDevices({ repo, now }, api);
    expect(await repo.listDevices()).toEqual([
      { id: derivedId('dev', 'dev-doorbell-1'), ringDeviceId: 'dev-doorbell-1', name: 'Front Door', kind: 'other', online: true, lastSeenAt: '2026-10-06T12:00:00.000Z', sensorState: null },
      { id: derivedId('dev', 'dev-flood-1'), ringDeviceId: 'dev-flood-1', name: 'Water Heater', kind: 'sensor', online: true, lastSeenAt: '2026-10-06T12:00:00.000Z', sensorState: null }
    ]);
  });

  it('keeps a learned doorbell kind and the last known sensor state, and takes the new name', async () => {
    const repo = createMemoryRepository('hh_test');
    await repo.putDevice({ id: 'dev_aaaaaaaaaaaaaaaa', ringDeviceId: 'dev-doorbell-1', name: 'Porch', kind: 'doorbell', online: true, lastSeenAt: null, sensorState: null });
    await repo.putDevice({ id: 'dev_bbbbbbbbbbbbbbbb', ringDeviceId: 'dev-flood-1', name: 'Water Heater', kind: 'sensor', online: true, lastSeenAt: null, sensorState: { flood: true, freeze: false } });
    const api = fakeRingApi({
      devices: [
        { id: 'dev-doorbell-1', name: 'Front Door' },
        { id: 'dev-flood-1', name: 'Water Heater' }
      ],
      // The flood is dry now; sync must NOT write that - the sensor rules own transitions.
      statuses: { 'dev-flood-1': { online: true, flood: false, freeze: false } }
    });
    await syncDevices({ repo, now }, api);
    expect((await repo.getDevice('dev-doorbell-1'))).toMatchObject({ id: 'dev_aaaaaaaaaaaaaaaa', name: 'Front Door', kind: 'doorbell' });
    expect((await repo.getDevice('dev-flood-1'))?.sensorState).toEqual({ flood: true, freeze: false });
  });

  it('marks a device Ring no longer lists as offline, and keeps going when one status call fails', async () => {
    const repo = createMemoryRepository('hh_test');
    await repo.putDevice({ id: 'dev_cccccccccccccccc', ringDeviceId: 'dev-gone', name: 'Garage', kind: 'other', online: true, lastSeenAt: null, sensorState: null });
    const api = fakeRingApi({ devices: [{ id: 'dev-flood-1', name: 'Water Heater' }], statuses: { 'dev-flood-1': new Error('503') } });
    await syncDevices({ repo, now }, api);
    expect((await repo.getDevice('dev-gone'))?.online).toBe(false);
    expect((await repo.getDevice('dev-flood-1'))).toMatchObject({ kind: 'other', online: false, lastSeenAt: null });
  });
});

describe('device and integration events', () => {
  it('syncs on every device event and on the link notice, and says so', async () => {
    const sync = vi.fn(async () => []);
    const raiseUnlinked = vi.fn(async () => {});
    for (const t of ['device_added', 'device_removed', 'device_online', 'device_offline', 'app_integration_added', 'Scheduled Event'])
      expect(await handleDeviceEvent({ sync, raiseUnlinked }, t)).toBe('synced');
    expect(sync).toHaveBeenCalledTimes(6);
    expect(raiseUnlinked).not.toHaveBeenCalled();
  });

  it('raises an alert, and does not call Ring, when the owner removes the app', async () => {
    const sync = vi.fn(async () => []);
    const raiseUnlinked = vi.fn(async () => {});
    expect(await handleDeviceEvent({ sync, raiseUnlinked }, 'app_integration_removed')).toBe('unlinked');
    expect(sync).not.toHaveBeenCalled();
    expect(raiseUnlinked).toHaveBeenCalledTimes(1);
    expect(RING_UNLINKED_MESSAGE).toBe('Ring was disconnected from HomeLedger in the Ring app. Doorbell and sensor events will stop until it is linked again.');
  });

  it('ignores anything else', async () => {
    expect(await handleDeviceEvent({ sync: vi.fn(), raiseUnlinked: vi.fn() }, 'subscription_activated')).toBe('ignored');
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `pnpm --filter @homeledger/events test -- linking device-sync`
Expected: FAIL — modules not found.

- [ ] **Step 5: Implement token exchange**

Create `apps/events/src/handlers/token-exchange.ts`:

```ts
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createSecretsPort } from '../aws/secrets.js';
import { createTokenStore, type TokenStore } from '../aws/tokens.js';
import { requireEnv } from '../env.js';
import { createRingApi, createRingOAuth, type RingOAuth } from '../ring/client.js';
import type { HttpReply, HttpRequest } from './webhook.js';

export interface TokenExchangeDeps {
  oauth: () => Promise<RingOAuth>;
  accountIdFor: (accessToken: string) => Promise<string>;
  store: TokenStore;
  now: () => string;
}

const reply = (statusCode: number, body: Record<string, unknown>): HttpReply => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ msg: 'token-exchange', ...fields }));

/**
 * The Token Exchange URL (amendment §12.1 step 2). Ring posts the code here
 * and allows sixty seconds to exchange it; the tokens are held unclaimed until
 * the owner signs in at the Account Link URL.
 */
export async function handleTokenExchange(deps: TokenExchangeDeps, req: HttpRequest): Promise<HttpReply> {
  const raw = Buffer.from(req.body ?? '', req.isBase64Encoded ? 'base64' : 'utf8').toString('utf8');
  const code = new URLSearchParams(raw).get('code');
  if (!code) return reply(400, { error: 'missing code' });
  try {
    const tokens = await (await deps.oauth()).exchangeCode(code);
    const accountId = await deps.accountIdFor(tokens.accessToken);
    const existing = await deps.store.read();
    if (existing?.status === 'linked' && existing.accountId !== accountId) {
      log({ outcome: 'second-account-refused' });
      return reply(409, { error: 'another Ring account is already linked' });
    }
    await deps.store.write({ accountId, ...tokens, status: 'unclaimed', updatedAt: deps.now() });
    // expiresAt is a time, not a credential: logged so the live run can record the token lifetime Ring actually grants (spec §3).
    log({ outcome: 'held-unclaimed', expiresAt: tokens.expiresAt });
    return reply(200, { status: 'ok' });
  } catch (err) {
    log({ outcome: 'exchange-failed', error: err instanceof Error ? err.message : String(err) });
    return reply(502, { error: 'token exchange failed' });
  }
}

let live: TokenExchangeDeps | undefined;
function liveDeps(): TokenExchangeDeps {
  if (live) return live;
  const secrets = createSecretsPort();
  live = {
    oauth: async () => createRingOAuth({ clientId: requireEnv('RING_CLIENT_ID'), clientSecret: await secrets.read(requireEnv('RING_CLIENT_SECRET_ID')) }),
    accountIdFor: token => createRingApi({ accessToken: async () => token }).accountId(),
    store: createTokenStore(secrets, requireEnv('RING_TOKENS_SECRET_ID')),
    now: () => new Date().toISOString()
  };
  return live;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> =>
  handleTokenExchange(liveDeps(), { body: event.body, isBase64Encoded: event.isBase64Encoded, headers: event.headers });
```

- [ ] **Step 6: Implement the link page**

Create `apps/events/src/handlers/link.ts`:

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createDynamoRepository, type Device } from '@homeledger/core';
import { createSecretsPort } from '../aws/secrets.js';
import { createTokenStore, type TokenStore } from '../aws/tokens.js';
import { requireEnv } from '../env.js';
import { createRingApi, RingApiError, type RingApi } from '../ring/client.js';
import { isFreshLinkTime, verifyLinkNonce } from '../ring/hmac.js';
import { syncDevices } from './device-sync.js';
import type { HttpReply, HttpRequest } from './webhook.js';

export interface LinkDeps {
  hmacKey: () => Promise<string>;
  passphrase: () => Promise<string>;
  store: TokenStore;
  apiFor: (accessToken: string) => Pick<RingApi, 'confirmLink' | 'completeLink' | 'listDevices' | 'deviceStatus'>;
  sync: (api: Pick<RingApi, 'listDevices' | 'deviceStatus'>) => Promise<Device[]>;
  householdId: string;
  nowMs: () => number;
}

const NONCE_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const TIME_SHAPE = /^\d{13}$/;
const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"
};
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ msg: 'link', ...fields }));

/** What Ring shows the owner as the partner account (amendment §12.1): the household, masked. */
export function accountIdentifierFor(householdId: string): string {
  return `${householdId.slice(0, 4)}***${householdId.slice(-1)}`;
}

function page(statusCode: number, title: string, inner: string): HttpReply {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;background:#14181e;color:#f4f5f7}input,button{font:inherit;padding:.5rem;margin:.25rem 0;width:100%}button{cursor:pointer}</style></head><body><h1>${title}</h1>${inner}</body></html>`;
  return { statusCode, headers: HEADERS, body };
}

/** Device names come from the owner's own Ring app, but they are still text from elsewhere going into HTML. */
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => HTML_ESCAPES[c] ?? c);

function samePassphrase(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function fields(req: HttpRequest & { query: Record<string, string | undefined> }): Record<string, string | undefined> {
  if (req.body === undefined) return req.query;
  const raw = Buffer.from(req.body, req.isBase64Encoded ? 'base64' : 'utf8').toString('utf8');
  return Object.fromEntries(new URLSearchParams(raw));
}

/**
 * The Account Link URL (amendment §12.1 steps 3–5). GET shows the sign-in;
 * POST checks it, matches the nonce to the held tokens, and confirms then
 * completes the link with Ring.
 */
export async function handleLink(deps: LinkDeps, req: HttpRequest & { method: string; query: Record<string, string | undefined> }): Promise<HttpReply> {
  const f = fields(req);
  const nonce = f.nonce ?? '';
  const time = f.time ?? '';
  if (!NONCE_SHAPE.test(nonce) || !TIME_SHAPE.test(time) || !isFreshLinkTime(time, deps.nowMs()))
    return page(400, 'This link has expired', '<p>Start the link again from the Ring app.</p>');

  if (req.method === 'GET') {
    return page(
      200,
      'Link Ring to HomeLedger',
      `<p>Enter the household passphrase to finish linking.</p><form method="post"><input type="hidden" name="nonce" value="${nonce}"><input type="hidden" name="time" value="${time}"><input type="password" name="passphrase" autocomplete="current-password" required><button type="submit">Link</button></form>`
    );
  }

  if (!samePassphrase(f.passphrase ?? '', await deps.passphrase())) {
    log({ outcome: 'wrong-passphrase' });
    return page(401, 'That passphrase is not right', '<p>Go back and try again.</p>');
  }
  const record = await deps.store.read();
  if (!record) return page(409, 'Ring has not finished its part yet', '<p>HomeLedger has not received Ring’s authorisation. Start again from the Ring app.</p>');
  if (!verifyLinkNonce(nonce, time, record.accountId, await deps.hmacKey())) {
    log({ outcome: 'nonce-mismatch' });
    return page(400, 'This link does not match', '<p>This link does not belong to the Ring account HomeLedger was given. Start again from the Ring app.</p>');
  }

  const api = deps.apiFor(record.accessToken);
  const who = accountIdentifierFor(deps.householdId);
  try {
    await api.confirmLink(nonce, who);
    await api.completeLink(who);
  } catch (err) {
    const detail = err instanceof RingApiError ? `${err.status}${err.code ? ` ${err.code}` : ''}` : 'no answer';
    log({ outcome: 'ring-refused', detail });
    return page(502, 'Ring refused the link', `<p>Ring refused the link (${detail}). Start again from the Ring app.</p>`);
  }
  await deps.store.write({ ...record, status: 'linked', updatedAt: new Date(deps.nowMs()).toISOString() });
  log({ outcome: 'linked' });

  try {
    const devices = await deps.sync(api);
    const names = escapeHtml(devices.map(d => d.name).join(', '));
    return page(200, 'Linked', `<p>Ring is linked to HomeLedger. Found ${devices.length} device${devices.length === 1 ? '' : 's'}: ${names}.</p>`);
  } catch (err) {
    log({ outcome: 'sync-failed-after-link', error: err instanceof Error ? err.message : String(err) });
    return page(200, 'Linked', '<p>Ring is linked to HomeLedger. The device list will appear within a day.</p>');
  }
}

let live: LinkDeps | undefined;
function liveDeps(): LinkDeps {
  if (live) return live;
  const secrets = createSecretsPort();
  const repo = createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') });
  live = {
    hmacKey: () => secrets.read(requireEnv('RING_HMAC_SECRET_ID')),
    passphrase: () => secrets.read(requireEnv('RING_LINK_PASSPHRASE_SECRET_ID')),
    store: createTokenStore(secrets, requireEnv('RING_TOKENS_SECRET_ID')),
    apiFor: token => createRingApi({ accessToken: async () => token }),
    sync: api => syncDevices({ repo, now: () => new Date().toISOString() }, api),
    householdId: requireEnv('HOUSEHOLD_ID'),
    nowMs: () => Date.now()
  };
  return live;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> =>
  handleLink(liveDeps(), {
    method: event.requestContext.http.method,
    query: event.queryStringParameters ?? {},
    body: event.requestContext.http.method === 'POST' ? event.body : undefined,
    isBase64Encoded: event.isBase64Encoded,
    headers: event.headers
  });
```

- [ ] **Step 7: Implement device sync**

Create `apps/events/src/handlers/device-sync.ts`:

```ts
import type { EventBridgeEvent } from 'aws-lambda';
import { createDynamoRepository, derivedId, newId, pushPayload, type Device, type Repository } from '@homeledger/core';
import { raiseSystemAlert } from '../aws/alerts.js';
import { HOMELEDGER_SOURCE, createEventPublisher } from '../aws/bus.js';
import { createSecretsPort } from '../aws/secrets.js';
import { createTokenStore, linkedAccessToken } from '../aws/tokens.js';
import { requireEnv } from '../env.js';
import { createRingApi, type RingApi, type RingDeviceStatus } from '../ring/client.js';

export interface SyncDeps {
  repo: Pick<Repository, 'listDevices' | 'getDevice' | 'putDevice'>;
  now: () => string;
}

/** R3: the kind is ours to record; sensor state belongs to the sensor rules. */
export async function syncDevices(deps: SyncDeps, api: Pick<RingApi, 'listDevices' | 'deviceStatus'>): Promise<Device[]> {
  const listed = await api.listDevices();
  const seen = new Set<string>();
  const written: Device[] = [];
  for (const summary of listed) {
    seen.add(summary.id);
    const existing = await deps.repo.getDevice(summary.id);
    let status: RingDeviceStatus | null = null;
    try {
      status = await api.deviceStatus(summary.id);
    } catch (err) {
      console.log(JSON.stringify({ msg: 'device-sync', outcome: 'status-failed', error: err instanceof Error ? err.message : String(err) }));
    }
    const isSensor = status !== null && (status.flood !== null || status.freeze !== null);
    const device: Device = {
      id: existing?.id ?? derivedId('dev', summary.id),
      ringDeviceId: summary.id,
      name: summary.name,
      kind: isSensor ? 'sensor' : (existing?.kind ?? 'other'),
      online: status?.online ?? false,
      lastSeenAt: status?.online ? deps.now() : (existing?.lastSeenAt ?? null),
      sensorState: existing?.sensorState ?? null
    };
    await deps.repo.putDevice(device);
    written.push(device);
  }
  for (const gone of (await deps.repo.listDevices()).filter(d => !seen.has(d.ringDeviceId) && d.online)) await deps.repo.putDevice({ ...gone, online: false });
  return written;
}

export const RING_UNLINKED_MESSAGE = 'Ring was disconnected from HomeLedger in the Ring app. Doorbell and sensor events will stop until it is linked again.';

export interface DeviceEventDeps {
  sync: () => Promise<Device[]>;
  raiseUnlinked: () => Promise<void>;
}

const SYNC_ON = new Set(['device_added', 'device_removed', 'device_online', 'device_offline', 'app_integration_added', 'Scheduled Event']);

export async function handleDeviceEvent(deps: DeviceEventDeps, detailType: string): Promise<'synced' | 'unlinked' | 'ignored'> {
  if (detailType === 'app_integration_removed') {
    await deps.raiseUnlinked();
    return 'unlinked';
  }
  if (!SYNC_ON.has(detailType)) return 'ignored';
  await deps.sync();
  return 'synced';
}

let live: DeviceEventDeps | undefined;
function liveDeps(): DeviceEventDeps {
  if (live) return live;
  const repo = createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') });
  const store = createTokenStore(createSecretsPort(), requireEnv('RING_TOKENS_SECRET_ID'));
  const publish = createEventPublisher(requireEnv('EVENT_BUS_NAME'));
  const now = () => new Date().toISOString();
  live = {
    sync: () => syncDevices({ repo, now }, createRingApi({ accessToken: linkedAccessToken(store) })),
    raiseUnlinked: async () => {
      const alert = await raiseSystemAlert({ repo, newId: () => newId('alert'), now }, RING_UNLINKED_MESSAGE);
      await publish([{ source: HOMELEDGER_SOURCE, detailType: 'alert.raised', detail: pushPayload('alert.raised', alert.id) }]);
    }
  };
  return live;
}

/** EventBridge rule targets (device_* and app_integration_* from the webhook) and the nightly schedule, whose detail-type is 'Scheduled Event'. */
export const handler = async (event: EventBridgeEvent<string, unknown>): Promise<void> => {
  const outcome = await handleDeviceEvent(liveDeps(), event['detail-type']);
  console.log(JSON.stringify({ msg: 'device-sync', trigger: event['detail-type'], outcome }));
};
```

- [ ] **Step 8: Run the tests and the build**

Run: `pnpm --filter @homeledger/events test && pnpm --filter @homeledger/events build`
Expected: PASS; `built 4 handler(s): device-sync, link, token-exchange, webhook`.

- [ ] **Step 9: Mutation check**

Apply each, run, record, revert:
1. In `handleLink`, skip the passphrase check → the 401 test fails (Ring gets called).
2. Swap the order of `confirmLink` and `completeLink` → the call-order assertion fails.
3. Write `status: 'linked'` before calling Ring → the 502 test's "leaves the tokens unclaimed" fails.
4. Drop `isFreshLinkTime` from the guard → the stale-link test fails.
5. Remove `NONCE_SHAPE` → the `<script>` test fails (the malformed nonce would be echoed into the page).
6. In `handleTokenExchange`, write before the second-account check → the 409 test's `acct-999` assertion fails.
7. In `syncDevices`, set `sensorState` from `status` → "keeps … the last known sensor state" fails.
8. In `syncDevices`, drop the offline sweep → "marks a device Ring no longer lists as offline" fails.
9. In `handleDeviceEvent`, call `sync` for `app_integration_removed` too → the "does not call Ring" assertion fails.

- [ ] **Step 10: Commit**

```bash
git add apps/events
git commit -m "feat(events): Ring's one-way account link with a household sign-in, token exchange, and device sync"
```

---
### Task 10: The visit correlator

Spec §5, with amendment §12.5–12.6 and rulings R3, R4, R9.

**Files:**
- Create: `apps/events/src/handlers/visit-correlator.ts`
- Test: `apps/events/test/visit-correlator.test.ts`

**Interfaces:**
- Consumes: `arrivalWindowFor`, `pickArrivalVisit`, `pushPayload`, `derivedId`, `Repository` (core, T3/T4); `fetchDoorbellSnapshot`, `imageKind` (T6); `PutSnapshot`, `snapshotKeyFor`, `Describer`, `EventPublisher`, `HOMELEDGER_SOURCE` (T7); `RingApi['requestImage']` (T6); the bus `detail` shape (T8).
- Produces:

```ts
export interface RingEventDetail { requestId: string; accountId: string | null; eventId: string | null; type: string; subType: string | null; deviceId: string | null; deviceName: string; at: string }
export interface CorrelatorDeps {
  repo: Pick<Repository, 'getDevice' | 'putDevice' | 'listVisitsInWindow' | 'markVisitArrived' | 'recordVisitSnapshot'>;
  requestImage: RingApi['requestImage'];
  putSnapshot: PutSnapshot;
  describe: Describer | null;
  publish: EventPublisher;
  householdId: string;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
}
export type CorrelationOutcome =
  | { outcome: 'not-a-doorbell-arrival' }
  | { outcome: 'no-visit' }
  | { outcome: 'already-arrived'; visitId: string }
  | { outcome: 'arrived'; visitId: string; snapshotStatus: SnapshotStatusValue; snapshotLatencyMs: number };
export function correlateArrival(deps: CorrelatorDeps, detail: RingEventDetail): Promise<CorrelationOutcome>;
```

`RingEventDetail` is exported from this file and reused by Task 11.

**Retries must resume, not restart.** The Lambda runs asynchronously behind EventBridge, which retries a failed invocation (Task 13 sets two retries, then the dead-letter queue). The arrival is written first (R9), so a retry finds the visit already `arrived` and `pickArrivalVisit` — which only considers `scheduled` visits — would find nothing: the snapshot and the push would be lost silently. So before matching, the correlator looks for a visit in the same window that this very `requestId` already marked arrived and that has no snapshot outcome yet, and resumes from the snapshot step. A *different* event for the same arrival (the motion after the press) does not carry the press's `requestId`, so it gets `already-arrived` and no second push.

- [ ] **Step 1: Write the failing tests**

Create `apps/events/test/visit-correlator.test.ts`:

```ts
import { createMemoryRepository, type Repository, type Visit } from '@homeledger/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { correlateArrival, type CorrelatorDeps, type RingEventDetail } from '../src/handlers/visit-correlator.js';
import type { ImageAnswer } from '../src/ring/client.js';
import { JPEG_BYTES, clock, recordingPublisher } from './fakes.js';

const PRESS_AT = '2026-10-06T13:20:00.000Z';
const press: RingEventDetail = { requestId: 'req-bp-0001', accountId: 'acct-123', eventId: 'evt-bp-0001', type: 'button_press', subType: null, deviceId: 'dev-doorbell-1', deviceName: 'Front Door', at: PRESS_AT };
const humanMotion: RingEventDetail = { ...press, requestId: 'req-mo-0001', eventId: 'evt-mo-0001', type: 'motion_detected', subType: 'human', at: '2026-10-06T13:20:05.000Z' };
const booked: Visit = {
  id: 'visit_aaaaaaaaaaaaaaaa',
  providerId: 'prov_kettle_water',
  providerName: 'Kettle Creek Water Heaters',
  category: 'water_heater',
  applianceId: 'appl_waterheater22222',
  issue: 'no hot water',
  windowStart: '2026-10-06T13:00:00.000Z',
  windowEnd: '2026-10-06T15:00:00.000Z',
  status: 'scheduled',
  ringEventIds: [],
  snapshotKey: null,
  description: null,
  snapshotStatus: null,
  snapshotLatencyMs: null,
  arrivedAt: null,
  createdAt: '2026-10-04T12:00:00.000Z'
};

let repo: Repository;
let bus: ReturnType<typeof recordingPublisher>;
let stored: Array<{ key: string; bytes: Buffer; contentType: string }>;

function deps(answers: ImageAnswer[] = [{ kind: 'image', bytes: JPEG_BYTES, contentType: 'image/jpeg' }], over: Partial<CorrelatorDeps> = {}): CorrelatorDeps {
  const c = clock(Date.parse(PRESS_AT) + 3_000);
  let i = 0;
  return {
    repo,
    requestImage: async () => answers[Math.min(i++, answers.length - 1)]!,
    putSnapshot: async (key, bytes, contentType) => {
      stored.push({ key, bytes, contentType });
    },
    describe: async () => 'A person holding a toolbox stands at the front door.',
    publish: bus.publish,
    householdId: 'hh_harlow',
    nowMs: c.now,
    sleep: c.sleep,
    ...over
  };
}

beforeEach(async () => {
  repo = createMemoryRepository('hh_harlow');
  bus = recordingPublisher();
  stored = [];
  await repo.putVisit(booked);
});

describe('correlateArrival (spec §5)', () => {
  it('marks the booked visit arrived on a press, stores the photo byte-for-byte, describes it, and pushes once', async () => {
    const outcome = await correlateArrival(deps(), press);
    expect(outcome).toEqual({ outcome: 'arrived', visitId: 'visit_aaaaaaaaaaaaaaaa', snapshotStatus: 'ok', snapshotLatencyMs: 3_000 });
    const v = await repo.getVisit('visit_aaaaaaaaaaaaaaaa');
    expect(v).toMatchObject({
      status: 'arrived',
      arrivedAt: PRESS_AT,
      ringEventIds: ['req-bp-0001'],
      snapshotKey: 'snapshots/hh_harlow/visit_aaaaaaaaaaaaaaaa.jpg',
      snapshotStatus: 'ok',
      description: 'A person holding a toolbox stands at the front door.',
      snapshotLatencyMs: 3_000
    });
    expect(stored).toEqual([{ key: 'snapshots/hh_harlow/visit_aaaaaaaaaaaaaaaa.jpg', bytes: JPEG_BYTES, contentType: 'image/jpeg' }]);
    expect(bus.entries).toEqual([{ source: 'homeledger.events', detailType: 'visit.arrived', detail: { cardType: 'visit.arrived', id: 'visit_aaaaaaaaaaaaaaaa' } }]);
  });

  it('learns that the pressing device is a doorbell (R3)', async () => {
    await correlateArrival(deps(), press);
    expect(await repo.getDevice('dev-doorbell-1')).toMatchObject({ name: 'Front Door', kind: 'doorbell' });
  });

  it('accepts human motion only from a device already known to be a doorbell', async () => {
    expect(await correlateArrival(deps(), humanMotion)).toEqual({ outcome: 'not-a-doorbell-arrival' });
    expect((await repo.getVisit('visit_aaaaaaaaaaaaaaaa'))?.status).toBe('scheduled');
    await repo.putDevice({ id: 'dev_aaaaaaaaaaaaaaaa', ringDeviceId: 'dev-doorbell-1', name: 'Front Door', kind: 'doorbell', online: true, lastSeenAt: null, sensorState: null });
    expect((await correlateArrival(deps(), humanMotion)).outcome).toBe('arrived');
  });

  it('ignores motion that is not a person, and anything without a device', async () => {
    await repo.putDevice({ id: 'dev_aaaaaaaaaaaaaaaa', ringDeviceId: 'dev-doorbell-1', name: 'Front Door', kind: 'doorbell', online: true, lastSeenAt: null, sensorState: null });
    expect(await correlateArrival(deps(), { ...humanMotion, subType: 'vehicle' })).toEqual({ outcome: 'not-a-doorbell-arrival' });
    expect(await correlateArrival(deps(), { ...press, deviceId: null })).toEqual({ outcome: 'not-a-doorbell-arrival' });
    expect(bus.entries).toEqual([]);
  });

  it('pushes nothing and changes nothing when no visit is booked around the press', async () => {
    expect(await correlateArrival(deps(), { ...press, at: '2026-10-06T18:00:00.000Z' })).toEqual({ outcome: 'no-visit' });
    expect((await repo.getVisit('visit_aaaaaaaaaaaaaaaa'))?.status).toBe('scheduled');
    expect(bus.entries).toEqual([]);
    expect(stored).toEqual([]);
  });

  it('turns a press and the motion that follows it into one arrival and one push', async () => {
    await correlateArrival(deps(), press);
    expect(await correlateArrival(deps(), humanMotion)).toEqual({ outcome: 'already-arrived', visitId: 'visit_aaaaaaaaaaaaaaaa' });
    expect(bus.entries).toHaveLength(1);
  });

  it('does not take over an arrival another delivery is still photographing', async () => {
    // The press's Lambda has marked the visit arrived and is still waiting on
    // Ring for the picture; the motion event lands on a second instance now.
    await repo.putDevice({ id: 'dev_aaaaaaaaaaaaaaaa', ringDeviceId: 'dev-doorbell-1', name: 'Front Door', kind: 'doorbell', online: true, lastSeenAt: null, sensorState: null });
    await repo.putVisit({ ...booked, status: 'arrived', arrivedAt: PRESS_AT, ringEventIds: ['req-bp-0001'] });
    expect(await correlateArrival(deps(), humanMotion)).toEqual({ outcome: 'already-arrived', visitId: 'visit_aaaaaaaaaaaaaaaa' });
    expect(bus.entries).toEqual([]);
    expect(stored).toEqual([]);
  });

  it('still records the arrival and pushes when Ring refuses the photo, with no image stored', async () => {
    const outcome = await correlateArrival(deps([{ kind: 'refused', status: 403, code: 'TIME_RANGE_NOT_AUTHORIZED' }]), press);
    expect(outcome).toMatchObject({ outcome: 'arrived', snapshotStatus: 'forbidden' });
    expect(await repo.getVisit('visit_aaaaaaaaaaaaaaaa')).toMatchObject({ status: 'arrived', snapshotKey: null, snapshotStatus: 'forbidden', description: null });
    expect(stored).toEqual([]);
    expect(bus.entries).toHaveLength(1);
  });

  it('keeps the photo without a sentence when the description fails, or when there is no describer', async () => {
    await correlateArrival(deps(undefined, { describe: async () => Promise.reject(new Error('529')) }), press);
    expect(await repo.getVisit('visit_aaaaaaaaaaaaaaaa')).toMatchObject({ snapshotStatus: 'ok', description: null });
    await repo.putVisit(booked);
    stored = [];
    await correlateArrival(deps(undefined, { describe: null }), { ...press, requestId: 'req-bp-0002' });
    expect(await repo.getVisit('visit_aaaaaaaaaaaaaaaa')).toMatchObject({ snapshotStatus: 'ok', description: null });
  });

  it('calls a photo that could not be stored an error, with no key pointing at nothing', async () => {
    await correlateArrival(deps(undefined, { putSnapshot: async () => Promise.reject(new Error('AccessDenied')) }), press);
    expect(await repo.getVisit('visit_aaaaaaaaaaaaaaaa')).toMatchObject({ snapshotKey: null, snapshotStatus: 'error', description: null });
  });

  it('resumes after a failed invocation instead of losing the snapshot and the push', async () => {
    const recordOnceFails = vi.fn().mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded')).mockImplementation((id: string, s: Parameters<Repository['recordVisitSnapshot']>[1]) => repo.recordVisitSnapshot(id, s));
    const flaky = { ...repo, recordVisitSnapshot: recordOnceFails } as Repository;
    await expect(correlateArrival(deps(undefined, { repo: flaky }), press)).rejects.toThrow('ProvisionedThroughputExceeded');
    expect(bus.entries).toEqual([]);
    const retry = await correlateArrival(deps(undefined, { repo: flaky }), press);
    expect(retry).toMatchObject({ outcome: 'arrived', snapshotStatus: 'ok' });
    expect(bus.entries).toHaveLength(1);
    expect((await repo.getVisit('visit_aaaaaaaaaaaaaaaa'))?.ringEventIds).toEqual(['req-bp-0001']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @homeledger/events test -- visit-correlator`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/events/src/handlers/visit-correlator.ts`:

```ts
import type { EventBridgeEvent } from 'aws-lambda';
import {
  arrivalWindowFor,
  createDynamoRepository,
  derivedId,
  pickArrivalVisit,
  pushPayload,
  type Repository,
  type SnapshotStatusValue,
  type Visit
} from '@homeledger/core';
import { HOMELEDGER_SOURCE, createEventPublisher, type EventPublisher } from '../aws/bus.js';
import { createAnthropicDescriber, type Describer } from '../aws/describe.js';
import { createSnapshotWriter, snapshotKeyFor, type PutSnapshot } from '../aws/objects.js';
import { createSecretsPort } from '../aws/secrets.js';
import { createTokenStore, linkedAccessToken } from '../aws/tokens.js';
import { optionalEnv, requireEnv } from '../env.js';
import { createRingApi, type RingApi } from '../ring/client.js';
import { fetchDoorbellSnapshot, imageKind } from '../ring/snapshot.js';

export interface RingEventDetail {
  requestId: string;
  accountId: string | null;
  eventId: string | null;
  type: string;
  subType: string | null;
  deviceId: string | null;
  deviceName: string;
  at: string;
}

export interface CorrelatorDeps {
  repo: Pick<Repository, 'getDevice' | 'putDevice' | 'listVisitsInWindow' | 'markVisitArrived' | 'recordVisitSnapshot'>;
  requestImage: RingApi['requestImage'];
  putSnapshot: PutSnapshot;
  describe: Describer | null;
  publish: EventPublisher;
  householdId: string;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
}

export type CorrelationOutcome =
  | { outcome: 'not-a-doorbell-arrival' }
  | { outcome: 'no-visit' }
  | { outcome: 'already-arrived'; visitId: string }
  | { outcome: 'arrived'; visitId: string; snapshotStatus: SnapshotStatusValue; snapshotLatencyMs: number };

/** R3: a press always qualifies and teaches us the device is a doorbell; human motion qualifies only from a known doorbell. */
async function qualifies(deps: CorrelatorDeps, detail: RingEventDetail): Promise<boolean> {
  if (!detail.deviceId) return false;
  const device = await deps.repo.getDevice(detail.deviceId);
  if (detail.type === 'button_press') {
    if (device?.kind !== 'doorbell') {
      await deps.repo.putDevice(
        device
          ? { ...device, kind: 'doorbell' }
          : { id: derivedId('dev', detail.deviceId), ringDeviceId: detail.deviceId, name: detail.deviceName, kind: 'doorbell', online: true, lastSeenAt: detail.at, sensorState: null }
      );
    }
    return true;
  }
  return detail.type === 'motion_detected' && detail.subType === 'human' && device?.kind === 'doorbell';
}

async function snapshotAndPush(deps: CorrelatorDeps, visit: Visit, detail: RingEventDetail): Promise<CorrelationOutcome> {
  const snap = await fetchDoorbellSnapshot({ requestImage: deps.requestImage, now: deps.nowMs, sleep: deps.sleep }, { deviceId: detail.deviceId!, eventAtMs: Date.parse(detail.at) });
  let status = snap.status;
  let snapshotKey: string | null = null;
  let description: string | null = null;
  const kind = snap.bytes ? imageKind(snap.bytes) : null;
  if (status === 'ok' && snap.bytes && kind) {
    const mediaType = kind === 'png' ? 'image/png' : 'image/jpeg';
    try {
      snapshotKey = snapshotKeyFor(deps.householdId, visit.id, kind);
      await deps.putSnapshot(snapshotKey, snap.bytes, mediaType);
    } catch (err) {
      console.log(JSON.stringify({ msg: 'visit-correlator', outcome: 'snapshot-store-failed', error: err instanceof Error ? err.message : String(err) }));
      snapshotKey = null;
      status = 'error';
    }
    if (snapshotKey && deps.describe) {
      description = await deps.describe(snap.bytes, mediaType).catch(err => {
        console.log(JSON.stringify({ msg: 'visit-correlator', outcome: 'describe-failed', error: err instanceof Error ? err.message : String(err) }));
        return null;
      });
    }
  }
  await deps.repo.recordVisitSnapshot(visit.id, { snapshotKey, snapshotStatus: status, description, snapshotLatencyMs: snap.latencyMs });
  await deps.publish([{ source: HOMELEDGER_SOURCE, detailType: 'visit.arrived', detail: pushPayload('visit.arrived', visit.id) }]);
  console.log(JSON.stringify({ msg: 'visit-correlator', outcome: 'arrived', snapshotStatus: status, snapshotLatencyMs: snap.latencyMs, attempts: snap.attempts, lastRefusal: snap.lastRefusal }));
  return { outcome: 'arrived', visitId: visit.id, snapshotStatus: status, snapshotLatencyMs: snap.latencyMs };
}

export async function correlateArrival(deps: CorrelatorDeps, detail: RingEventDetail): Promise<CorrelationOutcome> {
  if (!(await qualifies(deps, detail))) return { outcome: 'not-a-doorbell-arrival' };
  const { fromIso, toIso } = arrivalWindowFor(detail.at);
  const candidates = await deps.repo.listVisitsInWindow(fromIso, toIso);

  // A retry of this very delivery after it marked the visit arrived: resume.
  const unfinished = candidates.find(v => v.status === 'arrived' && v.ringEventIds.includes(detail.requestId) && (v.snapshotStatus ?? null) === null);
  if (unfinished) return snapshotAndPush(deps, unfinished, detail);

  const visit = pickArrivalVisit(candidates, detail.at);
  if (!visit) {
    const arrivedAlready = candidates.find(v => v.status === 'arrived');
    return arrivedAlready ? { outcome: 'already-arrived', visitId: arrivedAlready.id } : { outcome: 'no-visit' };
  }
  if ((await deps.repo.markVisitArrived(visit.id, detail.at, detail.requestId)) === 'not-scheduled') return { outcome: 'already-arrived', visitId: visit.id };
  return snapshotAndPush(deps, visit, detail);
}

let live: CorrelatorDeps | undefined;
function liveDeps(): CorrelatorDeps {
  if (live) return live;
  const secrets = createSecretsPort();
  const api = createRingApi({ accessToken: linkedAccessToken(createTokenStore(secrets, requireEnv('RING_TOKENS_SECRET_ID'))) });
  live = {
    repo: createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') }),
    requestImage: (id, window) => api.requestImage(id, window),
    putSnapshot: createSnapshotWriter(requireEnv('SNAPSHOT_BUCKET')),
    describe: createAnthropicDescriber({ apiKey: () => secrets.read(requireEnv('ANTHROPIC_KEY_SECRET_ID')), model: optionalEnv('ANTHROPIC_MODEL') ?? 'claude-sonnet-5' }),
    publish: createEventPublisher(requireEnv('EVENT_BUS_NAME')),
    householdId: requireEnv('HOUSEHOLD_ID'),
    nowMs: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
  };
  return live;
}

/** Target of the rule matching `button_press`, and `motion_detected` with `detail.subType = human`. Throws on failure so EventBridge retries and then dead-letters. */
export const handler = async (event: EventBridgeEvent<string, RingEventDetail>): Promise<void> => {
  const outcome = await correlateArrival(liveDeps(), event.detail);
  console.log(JSON.stringify({ msg: 'visit-correlator', trigger: event['detail-type'], requestId: event.detail.requestId, ...outcome }));
};
```

- [ ] **Step 4: Run the tests and the build**

Run: `pnpm --filter @homeledger/events test && pnpm --filter @homeledger/events build`
Expected: PASS; five handlers built.

- [ ] **Step 5: Mutation check**

Apply each, run, record, revert:
1. Delete the `unfinished` resume branch → "resumes after a failed invocation" fails (the retry returns `already-arrived` and nothing is pushed).
2. Publish before `recordVisitSnapshot` → the resume test fails (two pushes, one per invocation).
3. Accept human motion from any device → "accepts human motion only from a device already known to be a doorbell" fails.
4. Store `snapshotKey` even when `putSnapshot` throws → "calls a photo that could not be stored an error" fails.
5. Let the description failure propagate → the describe test fails with a rejection.
6. Drop the doorbell-learning write → "learns that the pressing device is a doorbell" fails.
7. Remove `v.ringEventIds.includes(detail.requestId)` from the resume check → "does not take over an arrival another delivery is still photographing" fails (the motion would resume the press's arrival, fetch a photo and push).

- [ ] **Step 6: Commit**

```bash
git add apps/events
git commit -m "feat(events): visit correlator - match a doorbell arrival to its booking, keep Ring's photo byte-for-byte, describe it, push once"
```

---
### Task 11: Sensor rules, the reconciliation poller, token refresh, and the dead-letter alerter

**Files:**
- Create: `apps/events/src/handlers/sensor-rules.ts`, `apps/events/src/handlers/sensor-poller.ts`, `apps/events/src/handlers/token-refresh.ts`, `apps/events/src/handlers/dlq-alerter.ts`
- Test: `apps/events/test/sensors.test.ts`, `apps/events/test/maintenance-jobs.test.ts`

**Interfaces:**
- Consumes: `sensorTransitions`, `decideSensorChange`, `advanceMaintenanceForSensor`, `SENSOR_EVENT_TYPES`, `SENSOR_TASK_TYPE`, `todayInZone`, `SEED_TIMEZONE`, `pushPayload`, `derivedId`, `newId` (core); `RingEventDetail` (T10); `RingApi`, `RingApiError`, `RingOAuth` (T6); `TokenStore`, `raiseSystemAlert`, `EventPublisher` (T7).
- Produces:

```ts
// sensor-rules.ts
export interface SensorDeps {
  repo: Pick<Repository, 'getDevice' | 'putDevice' | 'putAlert' | 'findOpenAlert' | 'getMaintenance' | 'putMaintenance' | 'getAppliance'>;
  publish: EventPublisher;
  newAlertId: () => string;
  today: () => Promise<string>;
  sensorApplianceId: string;
}
export interface SensorObservation { ringDeviceId: string; deviceName: string; observed: Partial<SensorState>; at: string; source: 'webhook' | 'poll' }
export interface SensorOutcome { raised: string[]; resolved: string[] }
export function applySensorObservation(deps: SensorDeps, obs: SensorObservation): Promise<SensorOutcome>;
export function handleSensorEvent(deps: SensorDeps & { enabled: boolean }, detail: RingEventDetail): Promise<SensorOutcome | 'disabled' | 'not-a-sensor-event'>;
export function householdToday(repo: Pick<Repository, 'getHousehold'>, now: () => string): () => Promise<string>;

// sensor-poller.ts
export function pollSensors(deps: SensorDeps & { enabled: boolean; listDevices: () => Promise<Device[]>; status: RingApi['deviceStatus']; now: () => string }): Promise<{ polled: number; raised: number; failed: number; backedOff: boolean } | 'disabled'>;

// token-refresh.ts
export const REFRESH_MARGIN_MS = 3_600_000;
export const RING_ACCESS_LAPSED_MESSAGE: string;
export function refreshIfDue(deps: { store: TokenStore; oauth: () => Promise<RingOAuth>; nowMs: () => number; alert: (message: string) => Promise<void> }): Promise<'not-linked' | 'fresh' | 'refreshed' | 'lapsed'>;

// dlq-alerter.ts
export function describeDeadLetter(body: string): string;
export function handleDeadLetters(deps: { alert: (message: string) => Promise<void> }, bodies: string[]): Promise<number>;
```

**One alert per trip, however many paths report it.** The webhook adapter and the reconciliation poll both call `applySensorObservation`, which computes transitions against the device's stored `sensorState` (Task 4). Two further guards make a raise idempotent: a raise is skipped when an open alert of the same type already exists for the device (a retried Lambda, or a webhook and a poll racing), and the device's new state is written **last**, so a crash part-way through repeats the transition on retry rather than losing it.

**The household's day.** The maintenance item's due date is today in the household's zone — a flood at 10 PM Central is due that evening, not "tomorrow" in UTC. `householdToday` reads the household record's zone (falling back to `SEED_TIMEZONE`, the seeded household's) and uses `todayInZone`.

- [ ] **Step 1: Write the failing sensor tests**

Create `apps/events/test/sensors.test.ts`:

```ts
import { createMemoryRepository, seedRepository, type Repository } from '@homeledger/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { applySensorObservation, handleSensorEvent, householdToday, type SensorDeps } from '../src/handlers/sensor-rules.js';
import { pollSensors } from '../src/handlers/sensor-poller.js';
import type { RingEventDetail } from '../src/handlers/visit-correlator.js';
import { RingApiError } from '../src/ring/client.js';
import { recordingPublisher } from './fakes.js';

const AT = '2026-10-06T21:15:00.000Z'; // 4:15 PM Central
let repo: Repository;
let bus: ReturnType<typeof recordingPublisher>;
let ids: number;

function deps(over: Partial<SensorDeps> = {}): SensorDeps {
  return {
    repo,
    publish: bus.publish,
    newAlertId: () => `alert_${'abcdefghijklmnop'.slice(0, 15)}${'abcdefgh'[ids++]}`,
    today: householdToday(repo, () => AT),
    sensorApplianceId: 'appl_waterheater22222',
    ...over
  };
}
const flood = (type: string, at = AT): RingEventDetail => ({ requestId: `req-${type}-${at}`, accountId: 'acct-123', eventId: null, type, subType: null, deviceId: 'dev-flood-1', deviceName: 'Water Heater', at });

beforeEach(async () => {
  repo = createMemoryRepository('hh_harlow');
  await seedRepository(repo, 'hh_harlow', '2026-10-06');
  await repo.putDevice({ id: 'dev_aaaaaaaaaaaaaaaa', ringDeviceId: 'dev-flood-1', name: 'Water Heater', kind: 'sensor', online: true, lastSeenAt: null, sensorState: null });
  bus = recordingPublisher();
  ids = 0;
});

describe('flood and freeze (spec §6 rule table, amendment §12.4)', () => {
  it('raises a high flood alert, advances the water heater’s inspection, remembers the state, and pushes', async () => {
    const out = await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected'));
    expect(out).toEqual({ raised: ['alert_abcdefghijklmnoa'], resolved: [] });
    expect(await repo.listAlerts('2026-10-06T00:00:00.000Z')).toEqual([
      {
        id: 'alert_abcdefghijklmnoa',
        sensorType: 'flood',
        severity: 'high',
        ringDeviceId: 'dev-flood-1',
        message: null,
        deviceName: 'Water Heater',
        at: AT,
        maintenanceRef: { applianceId: 'appl_waterheater22222', taskType: 'inspection' },
        status: 'open'
      }
    ]);
    // The seeded inspection was already overdue (2026-08-28): it keeps that date and gains the note.
    expect(await repo.getMaintenance('appl_waterheater22222', 'inspection')).toMatchObject({ nextDueAt: '2026-08-28', notes: 'Check for a leak near the Water Heater.' });
    expect((await repo.getDevice('dev-flood-1'))?.sensorState).toEqual({ flood: true, freeze: false });
    expect(bus.entries).toEqual([{ source: 'homeledger.events', detailType: 'alert.raised', detail: { cardType: 'alert.raised', id: 'alert_abcdefghijklmnoa' } }]);
  });

  it('does not alert twice for one trip — a redelivery, or the poll that follows the webhook', async () => {
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected'));
    await handleSensorEvent({ ...deps(), enabled: true }, { ...flood('flood_detected'), requestId: 'req-other' });
    await applySensorObservation(deps(), { ringDeviceId: 'dev-flood-1', deviceName: 'Water Heater', observed: { flood: true, freeze: false }, at: AT, source: 'poll' });
    expect(await repo.listAlerts('2026-10-06T00:00:00.000Z')).toHaveLength(1);
    expect(bus.entries).toHaveLength(1);
  });

  it('does not raise a second open alert even when the remembered state was lost', async () => {
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected'));
    await repo.putDevice({ id: 'dev_aaaaaaaaaaaaaaaa', ringDeviceId: 'dev-flood-1', name: 'Water Heater', kind: 'sensor', online: true, lastSeenAt: null, sensorState: null });
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected'));
    expect(await repo.listAlerts('2026-10-06T00:00:00.000Z')).toHaveLength(1);
  });

  it('resolves the open alert when the water clears, and leaves the maintenance item for a person to close', async () => {
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected'));
    const out = await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_cleared', '2026-10-06T21:40:00.000Z'));
    expect(out).toEqual({ raised: [], resolved: ['alert_abcdefghijklmnoa'] });
    expect((await repo.listAlerts('2026-10-06T00:00:00.000Z'))[0]?.status).toBe('resolved');
    expect((await repo.getMaintenance('appl_waterheater22222', 'inspection'))?.notes).toBe('Check for a leak near the Water Heater.');
    expect(bus.entries).toHaveLength(1);
  });

  it('treats freeze independently of flood', async () => {
    await handleSensorEvent({ ...deps(), enabled: true }, flood('flood_detected'));
    const out = await handleSensorEvent({ ...deps(), enabled: true }, flood('freeze_detected'));
    expect(out).toEqual({ raised: ['alert_abcdefghijklmnob'], resolved: [] });
    expect((await repo.getDevice('dev-flood-1'))?.sensorState).toEqual({ flood: true, freeze: true });
    expect((await repo.getMaintenance('appl_waterheater22222', 'inspection'))?.notes).toBe('Check pipe insulation near the Water Heater.');
  });

  it('opens an inspection due on the household’s day, not the UTC one', async () => {
    // 03:00Z on the 7th is 10 PM on the 6th in Chicago. The washer has no inspection item yet.
    const late = '2026-10-07T03:00:00.000Z';
    await handleSensorEvent({ ...deps({ sensorApplianceId: 'appl_washer2222222222', today: householdToday(repo, () => late) }), enabled: true }, flood('flood_detected', late));
    expect(await repo.getMaintenance('appl_washer2222222222', 'inspection')).toEqual({
      applianceId: 'appl_washer2222222222',
      taskType: 'inspection',
      intervalDays: 180,
      lastDoneAt: null,
      nextDueAt: '2026-10-06',
      notes: 'Check for a leak near the Water Heater.'
    });
  });

  it('raises an informational contact alert with no maintenance, and resolves it on close', async () => {
    const door: RingEventDetail = { ...flood('contact_sensor_faulted'), deviceId: 'dev-contact-1', deviceName: 'Back Door' };
    const out = await handleSensorEvent({ ...deps(), enabled: true }, door);
    expect(out).toEqual({ raised: ['alert_abcdefghijklmnoa'], resolved: [] });
    expect((await repo.listAlerts('2026-10-06T00:00:00.000Z'))[0]).toMatchObject({ sensorType: 'contact', severity: 'info', maintenanceRef: null });
    const closed = await handleSensorEvent({ ...deps(), enabled: true }, { ...door, type: 'contact_sensor_cleared' });
    expect(closed).toEqual({ raised: [], resolved: ['alert_abcdefghijklmnoa'] });
  });

  it('does nothing while the sensor path is switched off (spec §6 flag), and ignores other types', async () => {
    expect(await handleSensorEvent({ ...deps(), enabled: false }, flood('flood_detected'))).toBe('disabled');
    expect(await handleSensorEvent({ ...deps(), enabled: true }, flood('tamper_detected'))).toBe('not-a-sensor-event');
    expect(await repo.listAlerts('2026-10-06T00:00:00.000Z')).toEqual([]);
  });
});

describe('reconciliation poll (R2)', () => {
  it('reads only sensors, raises from a status the webhook never delivered, and is silent on a repeat', async () => {
    await repo.putDevice({ id: 'dev_bbbbbbbbbbbbbbbb', ringDeviceId: 'dev-doorbell-1', name: 'Front Door', kind: 'doorbell', online: true, lastSeenAt: null, sensorState: null });
    const asked: string[] = [];
    const status = async (id: string) => {
      asked.push(id);
      return { online: true, flood: true, freeze: false };
    };
    const run = () => pollSensors({ ...deps(), enabled: true, listDevices: () => repo.listDevices(), status, now: () => AT });
    expect(await run()).toEqual({ polled: 1, raised: 1, failed: 0, backedOff: false });
    expect(await run()).toEqual({ polled: 1, raised: 0, failed: 0, backedOff: false });
    expect(asked).toEqual(['dev-flood-1', 'dev-flood-1']);
  });

  it('stops the round on a 429 and says it backed off', async () => {
    await repo.putDevice({ id: 'dev_cccccccccccccccc', ringDeviceId: 'dev-flood-2', name: 'Sink', kind: 'sensor', online: true, lastSeenAt: null, sensorState: null });
    let calls = 0;
    const status = async () => {
      calls += 1;
      throw new RingApiError(429, null, 'Reading a Ring device status failed with 429');
    };
    expect(await pollSensors({ ...deps(), enabled: true, listDevices: () => repo.listDevices(), status, now: () => AT })).toEqual({ polled: 0, raised: 0, failed: 1, backedOff: true });
    expect(calls).toBe(1);
  });

  it('keeps polling past a device whose status fails for another reason', async () => {
    await repo.putDevice({ id: 'dev_cccccccccccccccc', ringDeviceId: 'dev-flood-2', name: 'Sink', kind: 'sensor', online: true, lastSeenAt: null, sensorState: null });
    const status = async (id: string) => {
      if (id === 'dev-flood-2') throw new RingApiError(503, 'SERVER_BUSY', 'x');
      return { online: true, flood: false, freeze: false };
    };
    expect(await pollSensors({ ...deps(), enabled: true, listDevices: () => repo.listDevices(), status, now: () => AT })).toEqual({ polled: 1, raised: 0, failed: 1, backedOff: false });
  });

  it('does nothing while switched off', async () => {
    expect(await pollSensors({ ...deps(), enabled: false, listDevices: () => repo.listDevices(), status: async () => ({ online: true, flood: true, freeze: true }), now: () => AT })).toBe('disabled');
  });
});
```

- [ ] **Step 2: Write the failing job tests**

Create `apps/events/test/maintenance-jobs.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { describeDeadLetter, handleDeadLetters } from '../src/handlers/dlq-alerter.js';
import { REFRESH_MARGIN_MS, RING_ACCESS_LAPSED_MESSAGE, refreshIfDue } from '../src/handlers/token-refresh.js';
import { RingApiError, type RingOAuth } from '../src/ring/client.js';
import type { TokenRecord } from '../src/aws/tokens.js';
import { memoryTokenStore } from './fakes.js';

const NOW = Date.parse('2026-10-06T13:00:00.000Z');
const linked = (expiresInMs: number): TokenRecord => ({
  accountId: 'acct-123',
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: new Date(NOW + expiresInMs).toISOString(),
  status: 'linked',
  updatedAt: '2026-10-06T09:00:00.000Z'
});
const oauth = (refresh: RingOAuth['refresh']): (() => Promise<RingOAuth>) => async () => ({ exchangeCode: vi.fn(), refresh });

describe('token refresh (spec §3: ahead of expiry with a one-hour margin; never silent)', () => {
  it('does nothing before a link', async () => {
    const refresh = vi.fn();
    expect(await refreshIfDue({ store: memoryTokenStore(), oauth: oauth(refresh), nowMs: () => NOW, alert: vi.fn() })).toBe('not-linked');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('leaves a token with more than an hour left alone', async () => {
    expect(REFRESH_MARGIN_MS).toBe(3_600_000);
    const refresh = vi.fn();
    expect(await refreshIfDue({ store: memoryTokenStore(linked(REFRESH_MARGIN_MS + 1)), oauth: oauth(refresh), nowMs: () => NOW, alert: vi.fn() })).toBe('fresh');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes inside the margin and keeps the new refresh token Ring hands back', async () => {
    const store = memoryTokenStore(linked(REFRESH_MARGIN_MS));
    const refresh = vi.fn(async () => ({ accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: '2026-10-06T17:00:00.000Z' }));
    expect(await refreshIfDue({ store, oauth: oauth(refresh), nowMs: () => NOW, alert: vi.fn() })).toBe('refreshed');
    expect(refresh).toHaveBeenCalledWith('rt-1');
    expect(store.current()).toEqual({ ...linked(0), accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: '2026-10-06T17:00:00.000Z', updatedAt: '2026-10-06T13:00:00.000Z' });
  });

  it('raises one alert when Ring refuses the refresh token, then stays quiet', async () => {
    const store = memoryTokenStore(linked(60_000));
    const alert = vi.fn(async () => {});
    const refresh = vi.fn(async () => Promise.reject(new RingApiError(400, 'invalid_grant', 'x')));
    expect(await refreshIfDue({ store, oauth: oauth(refresh), nowMs: () => NOW, alert })).toBe('lapsed');
    expect(alert).toHaveBeenCalledWith(RING_ACCESS_LAPSED_MESSAGE);
    expect(store.current()?.status).toBe('lapsed');
    expect(await refreshIfDue({ store, oauth: oauth(refresh), nowMs: () => NOW, alert })).toBe('not-linked');
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('throws on a transient failure so the schedule retries, without an alert', async () => {
    const alert = vi.fn();
    const refresh = vi.fn(async () => Promise.reject(new RingApiError(503, 'SERVER_BUSY', 'x')));
    await expect(refreshIfDue({ store: memoryTokenStore(linked(60_000)), oauth: oauth(refresh), nowMs: () => NOW, alert })).rejects.toThrow();
    expect(alert).not.toHaveBeenCalled();
  });

  it('says what lapsed and what to do, without reassurance', () => {
    expect(RING_ACCESS_LAPSED_MESSAGE).toBe('Ring access lapsed, so doorbell and sensor events have stopped. Link the Ring account again from the Ring app.');
  });
});

describe('dead-letter alerter (spec §4: a dead-lettered event becomes an ALERT# row)', () => {
  it('names the kind of event that could not be processed', () => {
    const body = JSON.stringify({ 'detail-type': 'button_press', source: 'ring.webhook', detail: { requestId: 'req-bp-0001' } });
    expect(describeDeadLetter(body)).toBe('A doorbell press could not be processed. It is kept for review.');
    expect(describeDeadLetter(JSON.stringify({ 'detail-type': 'flood_detected' }))).toBe('A flood or freeze sensor event could not be processed. It is kept for review.');
    expect(describeDeadLetter(JSON.stringify({ 'detail-type': 'visit.arrived' }))).toBe('A display update could not be delivered. It is kept for review.');
    expect(describeDeadLetter('not json')).toBe('An unrecognised home event could not be processed. It is kept for review.');
  });

  it('raises one alert per dead letter', async () => {
    const alert = vi.fn(async () => {});
    expect(await handleDeadLetters({ alert }, ['{"detail-type":"button_press"}', 'x'])).toBe(2);
    expect(alert).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @homeledger/events test -- sensors maintenance-jobs`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the sensor rules**

Create `apps/events/src/handlers/sensor-rules.ts`:

```ts
import type { EventBridgeEvent } from 'aws-lambda';
import {
  SEED_TIMEZONE,
  SENSOR_EVENT_TYPES,
  SENSOR_TASK_TYPE,
  advanceMaintenanceForSensor,
  createDynamoRepository,
  decideSensorChange,
  derivedId,
  newId,
  pushPayload,
  sensorTransitions,
  todayInZone,
  type Alert,
  type Repository,
  type SensorChanged,
  type SensorState
} from '@homeledger/core';
import { HOMELEDGER_SOURCE, createEventPublisher, type EventPublisher } from '../aws/bus.js';
import { flagEnv, requireEnv } from '../env.js';
import type { RingEventDetail } from './visit-correlator.js';

export interface SensorDeps {
  repo: Pick<Repository, 'getDevice' | 'putDevice' | 'putAlert' | 'findOpenAlert' | 'getMaintenance' | 'putMaintenance' | 'getAppliance'>;
  publish: EventPublisher;
  newAlertId: () => string;
  today: () => Promise<string>;
  sensorApplianceId: string;
}

export interface SensorObservation {
  ringDeviceId: string;
  deviceName: string;
  observed: Partial<SensorState>;
  at: string;
  source: 'webhook' | 'poll';
}

export interface SensorOutcome {
  raised: string[];
  resolved: string[];
}

const DEFAULT_INSPECTION_DAYS = 180;

export function householdToday(repo: Pick<Repository, 'getHousehold'>, now: () => string): () => Promise<string> {
  return async () => todayInZone(now(), (await repo.getHousehold())?.timezone ?? SEED_TIMEZONE);
}

async function applyChange(deps: SensorDeps, change: SensorChanged, location: string, out: SensorOutcome): Promise<void> {
  const decision = decideSensorChange(change, location);
  if (decision.action === 'resolve') {
    const open = await deps.repo.findOpenAlert(change.ringDeviceId, decision.sensorType);
    if (open) {
      await deps.repo.putAlert({ ...open, status: 'resolved' });
      out.resolved.push(open.id);
    }
    return;
  }
  // Idempotent raise: an open alert of this type for this device already covers it.
  if (await deps.repo.findOpenAlert(change.ringDeviceId, decision.sensorType)) return;
  let maintenanceRef: Alert['maintenanceRef'] = null;
  if (decision.maintenanceNote) {
    const appliance = await deps.repo.getAppliance(deps.sensorApplianceId);
    const intervalDays = appliance?.templates.find(t => t.taskType === SENSOR_TASK_TYPE)?.intervalDays ?? DEFAULT_INSPECTION_DAYS;
    const existing = await deps.repo.getMaintenance(deps.sensorApplianceId, SENSOR_TASK_TYPE);
    await deps.repo.putMaintenance(
      advanceMaintenanceForSensor(existing, { applianceId: deps.sensorApplianceId, today: await deps.today(), note: decision.maintenanceNote, intervalDays })
    );
    maintenanceRef = { applianceId: deps.sensorApplianceId, taskType: SENSOR_TASK_TYPE };
  }
  const alert: Alert = {
    id: deps.newAlertId(),
    sensorType: decision.sensorType,
    severity: decision.severity,
    ringDeviceId: change.ringDeviceId,
    message: null,
    deviceName: location,
    at: change.at,
    maintenanceRef,
    status: 'open'
  };
  await deps.repo.putAlert(alert);
  await deps.publish([{ source: HOMELEDGER_SOURCE, detailType: 'alert.raised', detail: pushPayload('alert.raised', alert.id) }]);
  out.raised.push(alert.id);
}

/** Both adapters end here (R2). The device's new state is written last, so a failure part-way repeats the transition on retry rather than losing it. */
export async function applySensorObservation(deps: SensorDeps, obs: SensorObservation): Promise<SensorOutcome> {
  const device = await deps.repo.getDevice(obs.ringDeviceId);
  const { changes, next } = sensorTransitions({ ringDeviceId: obs.ringDeviceId, previous: device?.sensorState ?? null, observed: obs.observed, at: obs.at, source: obs.source });
  const location = device?.name ?? obs.deviceName;
  const out: SensorOutcome = { raised: [], resolved: [] };
  for (const change of changes) await applyChange(deps, change, location, out);
  await deps.repo.putDevice({
    ...(device ?? { id: derivedId('dev', obs.ringDeviceId), ringDeviceId: obs.ringDeviceId, name: obs.deviceName, online: true, lastSeenAt: null }),
    kind: 'sensor',
    sensorState: next,
    lastSeenAt: obs.at
  });
  return out;
}

/** The webhook adapter: one Ring sensor event. Contact sensors carry no stored state (fixtures only in v1), so their change is applied directly. */
export async function handleSensorEvent(deps: SensorDeps & { enabled: boolean }, detail: RingEventDetail): Promise<SensorOutcome | 'disabled' | 'not-a-sensor-event'> {
  if (!deps.enabled) return 'disabled';
  const mapped = SENSOR_EVENT_TYPES[detail.type];
  if (!mapped || !detail.deviceId) return 'not-a-sensor-event';
  if (mapped.kind === 'contact') {
    const out: SensorOutcome = { raised: [], resolved: [] };
    await applyChange(deps, { ringDeviceId: detail.deviceId, kind: 'contact', state: mapped.state, at: detail.at, source: 'webhook' }, detail.deviceName, out);
    return out;
  }
  return applySensorObservation(deps, {
    ringDeviceId: detail.deviceId,
    deviceName: detail.deviceName,
    observed: { [mapped.kind]: mapped.state === 'triggered' },
    at: detail.at,
    source: 'webhook'
  });
}

export function liveSensorDeps(): SensorDeps & { enabled: boolean } {
  const repo = createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') });
  return {
    repo,
    publish: createEventPublisher(requireEnv('EVENT_BUS_NAME')),
    newAlertId: () => newId('alert'),
    today: householdToday(repo, () => new Date().toISOString()),
    sensorApplianceId: requireEnv('SENSOR_APPLIANCE_ID'),
    enabled: flagEnv('SENSORS_ENABLED')
  };
}

let live: (SensorDeps & { enabled: boolean }) | undefined;

export const handler = async (event: EventBridgeEvent<string, RingEventDetail>): Promise<void> => {
  live ??= liveSensorDeps();
  const outcome = await handleSensorEvent(live, event.detail);
  console.log(JSON.stringify({ msg: 'sensor-rules', trigger: event['detail-type'], requestId: event.detail.requestId, outcome }));
};
```

- [ ] **Step 5: Implement the poller**

Create `apps/events/src/handlers/sensor-poller.ts`:

```ts
import type { Device } from '@homeledger/core';
import { createDynamoRepository } from '@homeledger/core';
import { createSecretsPort } from '../aws/secrets.js';
import { createTokenStore, linkedAccessToken } from '../aws/tokens.js';
import { requireEnv } from '../env.js';
import { RingApiError, createRingApi, type RingApi } from '../ring/client.js';
import { applySensorObservation, liveSensorDeps, type SensorDeps } from './sensor-rules.js';

/**
 * The reconciliation adapter (R2, amendment §12.4): Ring says to treat
 * /status as the authority. A 429 ends this round — the schedule's next tick
 * is the backoff — and is logged, as spec §6 requires.
 */
export async function pollSensors(
  deps: SensorDeps & { enabled: boolean; listDevices: () => Promise<Device[]>; status: RingApi['deviceStatus']; now: () => string }
): Promise<{ polled: number; raised: number; failed: number; backedOff: boolean } | 'disabled'> {
  if (!deps.enabled) return 'disabled';
  const result = { polled: 0, raised: 0, failed: 0, backedOff: false };
  for (const device of (await deps.listDevices()).filter(d => d.kind === 'sensor')) {
    let status: Awaited<ReturnType<RingApi['deviceStatus']>>;
    try {
      status = await deps.status(device.ringDeviceId);
    } catch (err) {
      result.failed += 1;
      if (err instanceof RingApiError && err.status === 429) {
        result.backedOff = true;
        console.log(JSON.stringify({ msg: 'sensor-poller', outcome: 'rate-limited' }));
        break;
      }
      console.log(JSON.stringify({ msg: 'sensor-poller', outcome: 'status-failed', error: err instanceof Error ? err.message : String(err) }));
      continue;
    }
    result.polled += 1;
    const observed = { ...(status.flood === null ? {} : { flood: status.flood }), ...(status.freeze === null ? {} : { freeze: status.freeze }) };
    const out = await applySensorObservation(deps, { ringDeviceId: device.ringDeviceId, deviceName: device.name, observed, at: deps.now(), source: 'poll' });
    result.raised += out.raised.length;
  }
  return result;
}

export const handler = async (): Promise<void> => {
  const base = liveSensorDeps();
  const repo = createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') });
  const api = createRingApi({ accessToken: linkedAccessToken(createTokenStore(createSecretsPort(), requireEnv('RING_TOKENS_SECRET_ID'))) });
  const outcome = await pollSensors({ ...base, listDevices: () => repo.listDevices(), status: id => api.deviceStatus(id), now: () => new Date().toISOString() });
  console.log(JSON.stringify({ msg: 'sensor-poller', outcome }));
};
```

- [ ] **Step 6: Implement token refresh**

Create `apps/events/src/handlers/token-refresh.ts`:

```ts
import { createDynamoRepository, newId, pushPayload } from '@homeledger/core';
import { raiseSystemAlert } from '../aws/alerts.js';
import { HOMELEDGER_SOURCE, createEventPublisher } from '../aws/bus.js';
import { createSecretsPort } from '../aws/secrets.js';
import { createTokenStore, type TokenStore } from '../aws/tokens.js';
import { requireEnv } from '../env.js';
import { RingApiError, createRingOAuth, type RingOAuth } from '../ring/client.js';

export const REFRESH_MARGIN_MS = 3_600_000;
export const RING_ACCESS_LAPSED_MESSAGE = 'Ring access lapsed, so doorbell and sensor events have stopped. Link the Ring account again from the Ring app.';

/**
 * Spec §3: refresh ahead of expiry with a one-hour margin; a failed refresh is
 * never silent. Ring refusing the refresh token (4xx) means only a re-link
 * helps: alert once and mark the record lapsed. Anything else is transient:
 * throw, and the schedule's next run tries again.
 */
export async function refreshIfDue(deps: {
  store: TokenStore;
  oauth: () => Promise<RingOAuth>;
  nowMs: () => number;
  alert: (message: string) => Promise<void>;
}): Promise<'not-linked' | 'fresh' | 'refreshed' | 'lapsed'> {
  const record = await deps.store.read();
  if (!record || record.status !== 'linked') return 'not-linked';
  if (Date.parse(record.expiresAt) - deps.nowMs() > REFRESH_MARGIN_MS) return 'fresh';
  try {
    const tokens = await (await deps.oauth()).refresh(record.refreshToken);
    await deps.store.write({ ...record, ...tokens, updatedAt: new Date(deps.nowMs()).toISOString() });
    return 'refreshed';
  } catch (err) {
    if (err instanceof RingApiError && err.status >= 400 && err.status < 500) {
      await deps.store.write({ ...record, status: 'lapsed', updatedAt: new Date(deps.nowMs()).toISOString() });
      await deps.alert(RING_ACCESS_LAPSED_MESSAGE);
      return 'lapsed';
    }
    throw err;
  }
}

export const handler = async (): Promise<void> => {
  const secrets = createSecretsPort();
  const repo = createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') });
  const publish = createEventPublisher(requireEnv('EVENT_BUS_NAME'));
  const outcome = await refreshIfDue({
    store: createTokenStore(secrets, requireEnv('RING_TOKENS_SECRET_ID')),
    oauth: async () => createRingOAuth({ clientId: requireEnv('RING_CLIENT_ID'), clientSecret: await secrets.read(requireEnv('RING_CLIENT_SECRET_ID')) }),
    nowMs: () => Date.now(),
    alert: async message => {
      const alert = await raiseSystemAlert({ repo, newId: () => newId('alert'), now: () => new Date().toISOString() }, message);
      await publish([{ source: HOMELEDGER_SOURCE, detailType: 'alert.raised', detail: pushPayload('alert.raised', alert.id) }]);
    }
  });
  console.log(JSON.stringify({ msg: 'token-refresh', outcome }));
};
```

- [ ] **Step 7: Implement the dead-letter alerter**

Create `apps/events/src/handlers/dlq-alerter.ts`:

```ts
import type { SQSEvent } from 'aws-lambda';
import { createDynamoRepository, newId } from '@homeledger/core';
import { raiseSystemAlert } from '../aws/alerts.js';
import { requireEnv } from '../env.js';

const WHAT: Record<string, string> = {
  button_press: 'A doorbell press could not be processed.',
  motion_detected: 'A doorbell motion event could not be processed.',
  flood_detected: 'A flood or freeze sensor event could not be processed.',
  flood_cleared: 'A flood or freeze sensor event could not be processed.',
  freeze_detected: 'A flood or freeze sensor event could not be processed.',
  freeze_cleared: 'A flood or freeze sensor event could not be processed.',
  'visit.arrived': 'A display update could not be delivered.',
  'alert.raised': 'A display update could not be delivered.'
};

/**
 * Spec §4: a dead-lettered event becomes an ALERT# row. It deliberately does
 * NOT publish alert.raised: a dead letter from the push Lambda would otherwise
 * feed itself.
 */
export function describeDeadLetter(body: string): string {
  let type: unknown;
  try {
    type = (JSON.parse(body) as { 'detail-type'?: unknown })['detail-type'];
  } catch {
    type = undefined;
  }
  const first = typeof type === 'string' ? (WHAT[type] ?? `A home event (${type}) could not be processed.`) : 'An unrecognised home event could not be processed.';
  return `${first} It is kept for review.`;
}

export async function handleDeadLetters(deps: { alert: (message: string) => Promise<void> }, bodies: string[]): Promise<number> {
  for (const body of bodies) await deps.alert(describeDeadLetter(body));
  return bodies.length;
}

export const handler = async (event: SQSEvent): Promise<void> => {
  const repo = createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') });
  const n = await handleDeadLetters(
    { alert: async message => void (await raiseSystemAlert({ repo, newId: () => newId('alert'), now: () => new Date().toISOString() }, message)) },
    event.Records.map(r => r.body)
  );
  console.log(JSON.stringify({ msg: 'dlq-alerter', alerts: n }));
};
```

- [ ] **Step 8: Run the tests and the build**

Run: `pnpm --filter @homeledger/events test && pnpm --filter @homeledger/events build`
Expected: PASS; nine handlers built.

- [ ] **Step 9: Mutation check**

Apply each, run, record, revert:
1. Remove the "open alert already covers it" guard → "does not raise a second open alert even when the remembered state was lost" fails.
2. Write the device state before applying changes → still passes the suite; record it as surviving, and explain in the report why no unit test reaches it (it only matters for a crash between writes). This is the one intentional survivor in this task; the ordering is kept and justified by reading, like Plan 3's recorded precedence survivor.
3. In `householdToday`, use `now().slice(0, 10)` → "opens an inspection due on the household’s day" fails (`2026-10-07`).
4. Poller: `continue` on 429 instead of `break` → the 429 test fails (two calls).
5. Poller: pass `{ flood: status.flood, freeze: status.freeze }` unfiltered (nulls through) → typecheck fails; record that the compiler is the guard.
6. Token refresh: `>` to `>=` on the margin → "refreshes inside the margin" fails (`fresh`).
7. Token refresh: don't write `lapsed` → "then stays quiet" fails (two alerts).
8. Token refresh: alert on 5xx too → the transient test fails.
9. DLQ: publish `alert.raised` — not reachable by these tests (no publisher is injected); record that the absence of a publisher dependency is the guard.

- [ ] **Step 10: Commit**

```bash
git add apps/events
git commit -m "feat(events): sensor rules with one alert per trip, the status reconciliation poll, token refresh, and dead-letter alerts"
```

---
### Task 12: Push, the WebSocket authorizer, and connections

Spec §7's server side: a pointer (`{cardType, id}`) to every live display connection, over an API Gateway WebSocket API whose `$connect` is authorised by the same Cognito client-credentials JWT the simulator already fetches for MCP.

**Files:**
- Create: `apps/events/src/handlers/push.ts`, `apps/events/src/handlers/ws-authorizer.ts`, `apps/events/src/handlers/ws-connections.ts`
- Test: `apps/events/test/push.test.ts`

**Interfaces:**
- Consumes: `PushPayload`, `PushPayloadSchema`, `Repository.listConnections`, `putConnection`, `deleteConnection` (core).
- Produces:

```ts
// push.ts
export type PostToConnection = (connectionId: string, data: string) => Promise<'sent' | 'gone'>;
export function createPoster(client: ApiGatewayManagementApiClient): PostToConnection;
export function pushToDisplays(deps: { repo: Pick<Repository, 'listConnections' | 'deleteConnection'>; post: PostToConnection; nowEpochSeconds: () => number }, payload: PushPayload): Promise<{ sent: number; gone: number }>;

// ws-authorizer.ts
export function bearerFrom(headers: Record<string, string | undefined> | undefined): string | null;
export interface AuthorizerResult { principalId: string; policyDocument: { Version: '2012-10-17'; Statement: Array<{ Action: 'execute-api:Invoke'; Effect: 'Allow' | 'Deny'; Resource: string }> } }
export function authorize(deps: { verify: (token: string) => Promise<void> }, event: { headers?: Record<string, string | undefined>; methodArn: string }): Promise<AuthorizerResult>;

// ws-connections.ts
export const CONNECTION_TTL_SECONDS = 7200;
export function handleConnection(deps: { repo: Pick<Repository, 'putConnection' | 'deleteConnection'>; nowMs: () => number }, event: { requestContext: { routeKey?: string; connectionId?: string } }): Promise<{ statusCode: number }>;
```

**The token travels in a header.** The simulator's server holds the socket (spec §7) and sends `Authorization: Bearer <token>` on the upgrade. A token in the query string would be written to API Gateway's access logs and any proxy's; a header is not. This is why Task 16 uses `ws` rather than Node's global `WebSocket`, which cannot set headers.

**Keepalive.** API Gateway closes an idle WebSocket after ten minutes and any WebSocket after two hours. The simulator sends `{"action":"ping"}` every five minutes, which API Gateway routes to `$default`; the connections handler answers 200 and stores nothing. The two-hour cut is handled by the simulator's reconnect (Task 16); `CONNECTION_TTL_SECONDS` matches it so a row never outlives its socket by more than DynamoDB's TTL lag, and `listConnections` filters expired rows on read anyway (Task 3).

- [ ] **Step 1: Write the failing tests**

Create `apps/events/test/push.test.ts`:

```ts
import { createMemoryRepository, pushPayload } from '@homeledger/core';
import type { ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';
import { describe, expect, it, vi } from 'vitest';
import { createPoster, pushToDisplays } from '../src/handlers/push.js';
import { authorize, bearerFrom } from '../src/handlers/ws-authorizer.js';
import { CONNECTION_TTL_SECONDS, handleConnection } from '../src/handlers/ws-connections.js';

const ARN = 'arn:aws:execute-api:us-east-1:123456789012:abc123/demo/$connect';

describe('push (spec §7: a pointer to every live display)', () => {
  it('sends the pointer to each live connection, forgets a gone one, and skips an expired one', async () => {
    const repo = createMemoryRepository('hh_test');
    await repo.putConnection({ connectionId: 'live=', connectedAt: '2026-10-06T13:00:00.000Z', expiresAt: 2_000 });
    await repo.putConnection({ connectionId: 'gone=', connectedAt: '2026-10-06T13:00:00.000Z', expiresAt: 2_000 });
    await repo.putConnection({ connectionId: 'old=', connectedAt: '2026-10-06T11:00:00.000Z', expiresAt: 1_000 });
    const posted: Array<[string, string]> = [];
    const post = async (id: string, data: string) => {
      posted.push([id, data]);
      return id === 'gone=' ? ('gone' as const) : ('sent' as const);
    };
    const out = await pushToDisplays({ repo, post, nowEpochSeconds: () => 1_500 }, pushPayload('visit.arrived', 'visit_abcdefghijklmnop'));
    expect(out).toEqual({ sent: 1, gone: 1 });
    expect(posted.sort()).toEqual([
      ['gone=', '{"cardType":"visit.arrived","id":"visit_abcdefghijklmnop"}'],
      ['live=', '{"cardType":"visit.arrived","id":"visit_abcdefghijklmnop"}']
    ]);
    expect((await repo.listConnections(1_500)).map(c => c.connectionId)).toEqual(['live=']);
  });

  it('reads API Gateway’s 410 as gone, and anything else as a failure', async () => {
    const gone = { send: vi.fn(async () => Promise.reject(Object.assign(new Error('Gone'), { name: 'GoneException' }))) } as unknown as ApiGatewayManagementApiClient;
    expect(await createPoster(gone)('c1', '{}')).toBe('gone');
    const broken = { send: vi.fn(async () => Promise.reject(Object.assign(new Error('Throttled'), { name: 'LimitExceededException' }))) } as unknown as ApiGatewayManagementApiClient;
    await expect(createPoster(broken)('c1', '{}')).rejects.toThrow('Throttled');
    const ok = { send: vi.fn(async () => ({})) } as unknown as ApiGatewayManagementApiClient & { send: ReturnType<typeof vi.fn> };
    expect(await createPoster(ok)('c1', '{"a":1}')).toBe('sent');
    expect(ok.send.mock.calls[0]![0].input).toEqual({ ConnectionId: 'c1', Data: Buffer.from('{"a":1}', 'utf8') });
  });
});

describe('WebSocket authorizer (spec §7: the Cognito client-credentials JWT)', () => {
  const allowOrDeny = async (headers: Record<string, string | undefined> | undefined, verify: (t: string) => Promise<void> = async () => {}) =>
    (await authorize({ verify }, { headers, methodArn: ARN })).policyDocument.Statement[0]!.Effect;

  it('reads a bearer from the Authorization header, whatever its case', () => {
    expect(bearerFrom({ Authorization: 'Bearer abc.def.ghi' })).toBe('abc.def.ghi');
    expect(bearerFrom({ authorization: 'bearer abc.def.ghi' })).toBe('abc.def.ghi');
    expect(bearerFrom({ authorization: 'Basic abc' })).toBeNull();
    expect(bearerFrom({})).toBeNull();
    expect(bearerFrom(undefined)).toBeNull();
  });

  it('denies a connection with no token or a bad one, and allows exactly this route with a good one', async () => {
    expect(await allowOrDeny(undefined)).toBe('Deny');
    expect(await allowOrDeny({ authorization: 'Bearer bad' }, async () => Promise.reject(new Error('Token expired')))).toBe('Deny');
    const verify = vi.fn(async () => {});
    const result = await authorize({ verify }, { headers: { Authorization: 'Bearer good.jwt.token' }, methodArn: ARN });
    expect(verify).toHaveBeenCalledWith('good.jwt.token');
    expect(result).toEqual({
      principalId: 'homeledger-display',
      policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: ARN }] }
    });
  });
});

describe('connections', () => {
  const at = Date.parse('2026-10-06T13:00:00.000Z');

  it('records a connection with a two-hour expiry, forgets it on disconnect, and stores nothing for a keepalive', async () => {
    const repo = createMemoryRepository('hh_test');
    expect(CONNECTION_TTL_SECONDS).toBe(7_200);
    expect(await handleConnection({ repo, nowMs: () => at }, { requestContext: { routeKey: '$connect', connectionId: 'Ab1=' } })).toEqual({ statusCode: 200 });
    // A keepalive from another socket id must not become a connection row.
    expect(await handleConnection({ repo, nowMs: () => at }, { requestContext: { routeKey: '$default', connectionId: 'Zz9=' } })).toEqual({ statusCode: 200 });
    expect(await repo.listConnections(at / 1000)).toEqual([{ connectionId: 'Ab1=', connectedAt: '2026-10-06T13:00:00.000Z', expiresAt: at / 1000 + 7_200 }]);
    expect(await handleConnection({ repo, nowMs: () => at }, { requestContext: { routeKey: '$disconnect', connectionId: 'Ab1=' } })).toEqual({ statusCode: 200 });
    expect(await repo.listConnections(at / 1000)).toEqual([]);
  });

  it('refuses a route it does not know', async () => {
    const repo = createMemoryRepository('hh_test');
    expect(await handleConnection({ repo, nowMs: () => at }, { requestContext: { routeKey: 'sendmessage', connectionId: 'Ab1=' } })).toEqual({ statusCode: 400 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @homeledger/events test -- push`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Create `apps/events/src/handlers/push.ts`:

```ts
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import type { EventBridgeEvent } from 'aws-lambda';
import { PushPayloadSchema, createDynamoRepository, type PushPayload, type Repository } from '@homeledger/core';
import { requireEnv } from '../env.js';

export type PostToConnection = (connectionId: string, data: string) => Promise<'sent' | 'gone'>;

export function createPoster(client: ApiGatewayManagementApiClient): PostToConnection {
  return async (connectionId, data) => {
    try {
      await client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(data, 'utf8') }));
      return 'sent';
    } catch (err) {
      if ((err as { name?: string }).name === 'GoneException') return 'gone';
      throw err;
    }
  };
}

export async function pushToDisplays(
  deps: { repo: Pick<Repository, 'listConnections' | 'deleteConnection'>; post: PostToConnection; nowEpochSeconds: () => number },
  payload: PushPayload
): Promise<{ sent: number; gone: number }> {
  const data = JSON.stringify(payload);
  const out = { sent: 0, gone: 0 };
  for (const c of await deps.repo.listConnections(deps.nowEpochSeconds())) {
    if ((await deps.post(c.connectionId, data)) === 'gone') {
      await deps.repo.deleteConnection(c.connectionId);
      out.gone += 1;
    } else out.sent += 1;
  }
  return out;
}

/** Target of the rule matching `visit.arrived` and `alert.raised` from `homeledger.events`. A malformed detail throws, so it dead-letters and becomes an alert. */
export const handler = async (event: EventBridgeEvent<string, unknown>): Promise<void> => {
  const payload = PushPayloadSchema.parse(event.detail);
  const repo = createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') });
  const post = createPoster(new ApiGatewayManagementApiClient({ endpoint: requireEnv('PUSH_ENDPOINT') }));
  const out = await pushToDisplays({ repo, post, nowEpochSeconds: () => Math.floor(Date.now() / 1000) }, payload);
  console.log(JSON.stringify({ msg: 'push', cardType: payload.cardType, ...out }));
};
```

Create `apps/events/src/handlers/ws-authorizer.ts`:

```ts
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { requireEnv } from '../env.js';

export interface AuthorizerResult {
  principalId: string;
  policyDocument: { Version: '2012-10-17'; Statement: Array<{ Action: 'execute-api:Invoke'; Effect: 'Allow' | 'Deny'; Resource: string }> };
}

export function bearerFrom(headers: Record<string, string | undefined> | undefined): string | null {
  const value = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  const match = value?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

const policy = (effect: 'Allow' | 'Deny', resource: string): AuthorizerResult => ({
  principalId: 'homeledger-display',
  policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }] }
});

export async function authorize(deps: { verify: (token: string) => Promise<void> }, event: { headers?: Record<string, string | undefined>; methodArn: string }): Promise<AuthorizerResult> {
  const token = bearerFrom(event.headers);
  if (!token) return policy('Deny', event.methodArn);
  try {
    await deps.verify(token);
    return policy('Allow', event.methodArn);
  } catch (err) {
    console.log(JSON.stringify({ msg: 'ws-authorizer', outcome: 'denied', reason: err instanceof Error ? err.name : 'unknown' }));
    return policy('Deny', event.methodArn);
  }
}

let verifier: { verify: (token: string) => Promise<unknown> } | undefined;

/** The simulator's client-credentials access token: this user pool, this client, the homeledger/mcp scope. */
export const handler = async (event: { headers?: Record<string, string | undefined>; methodArn: string }): Promise<AuthorizerResult> => {
  verifier ??= CognitoJwtVerifier.create({ userPoolId: requireEnv('COGNITO_USER_POOL_ID'), tokenUse: 'access', clientId: requireEnv('COGNITO_CLIENT_ID'), scope: 'homeledger/mcp' });
  return authorize({ verify: async token => void (await verifier!.verify(token)) }, event);
};
```

Create `apps/events/src/handlers/ws-connections.ts`:

```ts
import { createDynamoRepository, type Repository } from '@homeledger/core';
import { requireEnv } from '../env.js';

/** API Gateway ends every WebSocket at two hours. */
export const CONNECTION_TTL_SECONDS = 7200;

export async function handleConnection(
  deps: { repo: Pick<Repository, 'putConnection' | 'deleteConnection'>; nowMs: () => number },
  event: { requestContext: { routeKey?: string; connectionId?: string } }
): Promise<{ statusCode: number }> {
  const { routeKey, connectionId } = event.requestContext;
  if (!connectionId) return { statusCode: 400 };
  switch (routeKey) {
    case '$connect': {
      const now = deps.nowMs();
      await deps.repo.putConnection({ connectionId, connectedAt: new Date(now).toISOString(), expiresAt: Math.floor(now / 1000) + CONNECTION_TTL_SECONDS });
      return { statusCode: 200 };
    }
    case '$disconnect':
      await deps.repo.deleteConnection(connectionId);
      return { statusCode: 200 };
    case '$default':
      return { statusCode: 200 };
    default:
      return { statusCode: 400 };
  }
}

export const handler = async (event: { requestContext: { routeKey?: string; connectionId?: string } }): Promise<{ statusCode: number }> =>
  handleConnection({ repo: createDynamoRepository({ tableName: requireEnv('TABLE_NAME'), householdId: requireEnv('HOUSEHOLD_ID') }), nowMs: () => Date.now() }, event);
```

- [ ] **Step 4: Run the tests and the build**

Run: `pnpm --filter @homeledger/events test && pnpm --filter @homeledger/events typecheck && pnpm --filter @homeledger/events build`
Expected: PASS; `built 12 handler(s): device-sync, dlq-alerter, link, push, sensor-poller, sensor-rules, token-exchange, token-refresh, visit-correlator, webhook, ws-authorizer, ws-connections`.

- [ ] **Step 5: Mutation check**

Apply each, run, record, revert:
1. In `pushToDisplays`, don't delete gone connections → the first test's final `listConnections` assertion fails.
2. In `createPoster`, treat every error as gone → the `Throttled` assertion fails.
3. In `bearerFrom`, match only `authorization` exactly → the capitalised-header assertion fails.
4. In `authorize`, return Allow when `verify` throws → the bad-token assertion fails.
5. Use `Resource: '*'` in the Allow policy → the exact-policy assertion fails.
6. `CONNECTION_TTL_SECONDS` → `3600` → the TTL literal and the stored `expiresAt` both fail.
7. Store a row for `$default` → the keepalive assertion (`Zz9=` must not appear) fails.

- [ ] **Step 6: Commit**

```bash
git add apps/events
git commit -m "feat(events): push a pointer to every live display, a Cognito-authorised WebSocket connect, and a keepalive route"
```

---
### Task 13: Terraform module `ring-events`

Everything Ring needs in AWS, as one module with native tests. No apply happens here or anywhere outside GitHub Actions; this task runs `fmt`, `init -backend=false`, `validate`, `test`, and nothing else.

**Files:**
- Create: `infra/modules/ring-events/versions.tf`, `variables.tf`, `main.tf`, `lambdas.tf`, `http.tf`, `websocket.tf`, `events.tf`, `outputs.tf`, `README.md`, `tests/ring-events.tftest.hcl`
- Modify: `.gitignore` (add `infra/modules/ring-events/.build/`)

**Interfaces:**
- Consumes: the built bundles at `<artifacts_dir>/<handler>/index.mjs` (Task 5's `build.mjs`); the environment contract (Task 8).
- Produces (outputs Task 14 wires and Task 17/18 read):

| Output | Value |
|---|---|
| `token_exchange_url` | `<http api endpoint>/ring/token` |
| `account_link_url` | `<http api endpoint>/ring/link` |
| `webhook_url` | `<http api endpoint>/ring/webhook` |
| `push_websocket_url` | the WebSocket stage's `wss://…/demo` invoke URL |
| `push_endpoint` | `https://<ws api id>.execute-api.<region>.amazonaws.com/demo` |
| `snapshot_bucket`, `snapshot_bucket_arn`, `snapshot_origin` | the bucket, its ARN, `https://<bucket regional domain>` |
| `event_bus_name`, `tokens_secret_arn` | |
| `secret_grants` | map function → list of secret ARNs it may read (for tests and the README) |

**Three design points the tests pin:**
- **Least privilege per function** (spec §3): each function gets its own role; `GetSecretValue` only on the ARNs in its row of the spec's secrets table; `s3:PutObject` only on `snapshots/*` and only for the correlator; `execute-api:ManageConnections` only for push.
- **A dead-letter queue per asynchronous function** (spec §2): the correlator, sensor rules, device sync, push, poller and token refresh each have an SQS queue that receives the original event after Lambda's two retries; the DLQ alerter reads all six (Task 11).
- **`push` is its own resource.** Its environment needs the WebSocket API's endpoint, and the WebSocket API's integration needs the connections function. With every function in one `for_each` block that is a dependency cycle, because Terraform treats the whole block as one node.

- [ ] **Step 1: Write the module**

Create `infra/modules/ring-events/versions.tf`:

```hcl
terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.21.0, < 7.0.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.7.0, < 3.0.0"
    }
  }
}
```

Create `infra/modules/ring-events/variables.tf`:

```hcl
variable "name_prefix" {
  type        = string
  description = "Prefix for every resource name, e.g. demo-homeledger."
}

variable "household_id" {
  type        = string
  description = "The one household the linked Ring account maps to (spec §3)."
}

variable "table_name" {
  type        = string
  description = "HomeLedger DynamoDB table name."
}

variable "table_arn" {
  type        = string
  description = "HomeLedger DynamoDB table ARN."
}

variable "artifacts_dir" {
  type        = string
  description = "Directory holding apps/events' built bundles, one sub-directory per handler with an index.mjs."
}

variable "ring_client_id" {
  type        = string
  description = "Ring app Client ID. Not a secret (spec §3). Empty until the repository variable is set; the token-exchange and token-refresh functions fail loudly without it."
  default     = ""
}

variable "ring_client_secret_arn" {
  type        = string
  description = "ARN of the owner-created secret holding the Ring client secret."
}

variable "ring_hmac_key_arn" {
  type        = string
  description = "ARN of the owner-created secret holding the Ring HMAC signature key."
}

variable "anthropic_key_arn" {
  type        = string
  description = "ARN of the owner-created secret holding the Anthropic API key used to describe snapshots."
}

variable "link_passphrase_arn" {
  type        = string
  description = "ARN of the owner-created secret holding the household passphrase the Account Link page asks for (R1)."
}

variable "cognito_user_pool_id" {
  type        = string
  description = "User pool that issues the simulator's client-credentials token; the WebSocket authorizer verifies against it."
}

variable "cognito_client_id" {
  type        = string
  description = "App client whose tokens may open a push connection."
}

variable "sensors_enabled" {
  type        = bool
  description = "Spec §6 flag: gates the live sensor path, independently of the doorbell path."
  default     = true
}

variable "sensor_appliance_id" {
  type        = string
  description = "Appliance whose inspection a flood or freeze opens or advances (R12)."
  default     = "appl_waterheater22222"
  validation {
    condition     = can(regex("^appl_[a-z2-7]{16}$", var.sensor_appliance_id))
    error_message = "sensor_appliance_id must be an appliance id, appl_ followed by 16 base32 characters."
  }
}

variable "sensor_poll_minutes" {
  type        = number
  description = "Minutes between reconciliation polls of sensor status (spec §6, default 2)."
  default     = 2
  validation {
    condition     = var.sensor_poll_minutes >= 1 && var.sensor_poll_minutes <= 60 && floor(var.sensor_poll_minutes) == var.sensor_poll_minutes
    error_message = "sensor_poll_minutes must be a whole number from 1 to 60."
  }
}

variable "anthropic_model" {
  type        = string
  description = "Model that describes a snapshot (spec §5)."
  default     = "claude-sonnet-5"
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch retention for every function's log group."
  default     = 14
}

variable "secret_recovery_window_in_days" {
  type        = number
  description = "Recovery window for the tokens secret this module creates. 0 deletes immediately (demo); otherwise 7-30."
  default     = 0
  validation {
    condition     = var.secret_recovery_window_in_days == 0 || (var.secret_recovery_window_in_days >= 7 && var.secret_recovery_window_in_days <= 30)
    error_message = "secret_recovery_window_in_days must be 0 or between 7 and 30."
  }
}

variable "snapshot_bucket_force_destroy" {
  type        = bool
  description = "Whether terraform destroy may delete a snapshot bucket that still holds images."
  default     = true
}
```

Create `infra/modules/ring-events/main.tf`:

```hcl
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id      = data.aws_caller_identity.current.account_id
  region          = data.aws_region.current.region
  snapshot_bucket = "${var.name_prefix}-snapshots-${local.account_id}"
  ws_stage        = "demo"

  # Spec §3's secrets table. Values are ARNs; handlers receive them as secret ids.
  secret_arns = {
    client_secret = var.ring_client_secret_arn
    hmac          = var.ring_hmac_key_arn
    tokens        = aws_secretsmanager_secret.tokens.arn
    anthropic     = var.anthropic_key_arn
    passphrase    = var.link_passphrase_arn
  }
}

# ---------- Snapshot bucket (spec §5): images stored byte-for-byte, private ----------
# trivy:ignore:AVD-AWS-0132 SSE-S3 is sufficient for demo snapshots; a CMK adds cost and a key policy without changing who can read them.
resource "aws_s3_bucket" "snapshots" {
  bucket        = local.snapshot_bucket
  force_destroy = var.snapshot_bucket_force_destroy
}

resource "aws_s3_bucket_public_access_block" "snapshots" {
  bucket                  = aws_s3_bucket.snapshots.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "snapshots" {
  bucket = aws_s3_bucket.snapshots.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "snapshots" {
  bucket = aws_s3_bucket.snapshots.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_policy" "snapshots" {
  bucket = aws_s3_bucket.snapshots.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.snapshots.arn, "${aws_s3_bucket.snapshots.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# ---------- The tokens secret: a container only. Values are written by the link and refresh functions and never enter state (R7). ----------
resource "aws_secretsmanager_secret" "tokens" {
  name                    = "${var.name_prefix}/ring/tokens"
  description             = "Ring access and refresh tokens for the linked account - written by the link and token-refresh functions"
  recovery_window_in_days = var.secret_recovery_window_in_days
}

# ---------- The bus ----------
resource "aws_cloudwatch_event_bus" "this" {
  name = var.name_prefix
}
```

Create `infra/modules/ring-events/lambdas.tf`:

```hcl
locals {
  # One row per handler in apps/events/src/handlers. `table`, `bus`, `snapshots`
  # and the two secret lists are what the role may do; `async` functions get a
  # dead-letter queue and two retries. Spec §3 fixes the secret columns.
  functions = {
    "webhook"          = { timeout = 10, memory = 256, table = true, bus = true, snapshots = false, async = false, secrets_read = ["hmac"], secrets_write = [] }
    "token-exchange"   = { timeout = 15, memory = 256, table = false, bus = false, snapshots = false, async = false, secrets_read = ["client_secret", "tokens"], secrets_write = ["tokens"] }
    "link"             = { timeout = 30, memory = 256, table = true, bus = false, snapshots = false, async = false, secrets_read = ["hmac", "passphrase", "tokens"], secrets_write = ["tokens"] }
    "device-sync"      = { timeout = 60, memory = 256, table = true, bus = true, snapshots = false, async = true, secrets_read = ["tokens"], secrets_write = [] }
    "visit-correlator" = { timeout = 120, memory = 512, table = true, bus = true, snapshots = true, async = true, secrets_read = ["tokens", "anthropic"], secrets_write = [] }
    "sensor-rules"     = { timeout = 30, memory = 256, table = true, bus = true, snapshots = false, async = true, secrets_read = [], secrets_write = [] }
    "sensor-poller"    = { timeout = 60, memory = 256, table = true, bus = true, snapshots = false, async = true, secrets_read = ["tokens"], secrets_write = [] }
    "token-refresh"    = { timeout = 30, memory = 256, table = true, bus = true, snapshots = false, async = true, secrets_read = ["client_secret", "tokens"], secrets_write = ["tokens"] }
    "dlq-alerter"      = { timeout = 30, memory = 256, table = true, bus = false, snapshots = false, async = false, secrets_read = [], secrets_write = [] }
    "push"             = { timeout = 30, memory = 256, table = true, bus = false, snapshots = false, async = true, secrets_read = [], secrets_write = [] }
    "ws-authorizer"    = { timeout = 10, memory = 256, table = false, bus = false, snapshots = false, async = false, secrets_read = [], secrets_write = [] }
    "ws-connections"   = { timeout = 10, memory = 256, table = true, bus = false, snapshots = false, async = false, secrets_read = [], secrets_write = [] }
  }
  async_functions = { for k, f in local.functions : k => f if f.async }

  common_env = { TABLE_NAME = var.table_name, HOUSEHOLD_ID = var.household_id }

  # The environment contract (Plan 4 Task 8). push's is set on its own resource.
  function_env = {
    "webhook"          = { EVENT_BUS_NAME = aws_cloudwatch_event_bus.this.name, RING_HMAC_SECRET_ID = local.secret_arns.hmac }
    "token-exchange"   = { RING_CLIENT_ID = var.ring_client_id, RING_CLIENT_SECRET_ID = local.secret_arns.client_secret, RING_TOKENS_SECRET_ID = local.secret_arns.tokens }
    "link"             = { RING_HMAC_SECRET_ID = local.secret_arns.hmac, RING_LINK_PASSPHRASE_SECRET_ID = local.secret_arns.passphrase, RING_TOKENS_SECRET_ID = local.secret_arns.tokens }
    "device-sync"      = { EVENT_BUS_NAME = aws_cloudwatch_event_bus.this.name, RING_TOKENS_SECRET_ID = local.secret_arns.tokens }
    "visit-correlator" = { EVENT_BUS_NAME = aws_cloudwatch_event_bus.this.name, RING_TOKENS_SECRET_ID = local.secret_arns.tokens, ANTHROPIC_KEY_SECRET_ID = local.secret_arns.anthropic, ANTHROPIC_MODEL = var.anthropic_model, SNAPSHOT_BUCKET = aws_s3_bucket.snapshots.bucket }
    "sensor-rules"     = { EVENT_BUS_NAME = aws_cloudwatch_event_bus.this.name, SENSORS_ENABLED = var.sensors_enabled ? "1" : "0", SENSOR_APPLIANCE_ID = var.sensor_appliance_id }
    "sensor-poller"    = { EVENT_BUS_NAME = aws_cloudwatch_event_bus.this.name, SENSORS_ENABLED = var.sensors_enabled ? "1" : "0", SENSOR_APPLIANCE_ID = var.sensor_appliance_id, RING_TOKENS_SECRET_ID = local.secret_arns.tokens }
    "token-refresh"    = { EVENT_BUS_NAME = aws_cloudwatch_event_bus.this.name, RING_CLIENT_ID = var.ring_client_id, RING_CLIENT_SECRET_ID = local.secret_arns.client_secret, RING_TOKENS_SECRET_ID = local.secret_arns.tokens }
    "dlq-alerter"      = {}
    "ws-authorizer"    = { COGNITO_USER_POOL_ID = var.cognito_user_pool_id, COGNITO_CLIENT_ID = var.cognito_client_id }
    "ws-connections"   = {}
  }

  statements = {
    for k, f in local.functions : k => concat(
      [{ Sid = "Logs", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = ["${aws_cloudwatch_log_group.fn[k].arn}:*"] }],
      f.table ? [{ Sid = "Table", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"], Resource = [var.table_arn, "${var.table_arn}/index/*"] }] : [],
      length(f.secrets_read) > 0 ? [{ Sid = "ReadSecrets", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [for s in f.secrets_read : local.secret_arns[s]] }] : [],
      length(f.secrets_write) > 0 ? [{ Sid = "WriteSecrets", Effect = "Allow", Action = ["secretsmanager:PutSecretValue"], Resource = [for s in f.secrets_write : local.secret_arns[s]] }] : [],
      f.bus ? [{ Sid = "PutEvents", Effect = "Allow", Action = ["events:PutEvents"], Resource = [aws_cloudwatch_event_bus.this.arn] }] : [],
      f.snapshots ? [{ Sid = "WriteSnapshots", Effect = "Allow", Action = ["s3:PutObject"], Resource = ["${aws_s3_bucket.snapshots.arn}/snapshots/*"] }] : [],
      f.async ? [{ Sid = "DeadLetter", Effect = "Allow", Action = ["sqs:SendMessage"], Resource = [aws_sqs_queue.dlq[k].arn] }] : [],
      k == "push" ? [{ Sid = "ManageConnections", Effect = "Allow", Action = ["execute-api:ManageConnections"], Resource = ["${aws_apigatewayv2_api.ws.execution_arn}/${local.ws_stage}/POST/@connections/*"] }] : [],
      k == "dlq-alerter" ? [{ Sid = "ReadDeadLetters", Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = [for q in aws_sqs_queue.dlq : q.arn] }] : []
    )
  }
}

data "archive_file" "fn" {
  for_each    = local.functions
  type        = "zip"
  source_dir  = "${var.artifacts_dir}/${each.key}"
  output_path = "${path.module}/.build/${each.key}.zip"
}

resource "aws_cloudwatch_log_group" "fn" {
  for_each          = local.functions
  name              = "/aws/lambda/${var.name_prefix}-${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "fn" {
  for_each = local.functions
  name     = "${var.name_prefix}-${each.key}"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "fn" {
  for_each = local.functions
  role     = aws_iam_role.fn[each.key].id
  policy   = jsonencode({ Version = "2012-10-17", Statement = local.statements[each.key] })
}

# trivy:ignore:AVD-AWS-0135 SQS-managed SSE encrypts at rest; a CMK would add a key policy for no change in who can read a dead letter.
resource "aws_sqs_queue" "dlq" {
  for_each                  = local.async_functions
  name                      = "${var.name_prefix}-${each.key}-dead-letters"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_lambda_function" "fn" {
  for_each         = { for k, f in local.functions : k => f if k != "push" }
  function_name    = "${var.name_prefix}-${each.key}"
  role             = aws_iam_role.fn[each.key].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.fn[each.key].output_path
  source_code_hash = data.archive_file.fn[each.key].output_base64sha256
  timeout          = each.value.timeout
  memory_size      = each.value.memory

  environment {
    variables = merge(local.common_env, local.function_env[each.key])
  }

  dynamic "dead_letter_config" {
    for_each = each.value.async ? [aws_sqs_queue.dlq[each.key].arn] : []
    content {
      target_arn = dead_letter_config.value
    }
  }

  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy.fn]
}

# Separate from the for_each above: its environment names the WebSocket API,
# whose integration names ws-connections - one block would be a cycle.
resource "aws_lambda_function" "push" {
  function_name    = "${var.name_prefix}-push"
  role             = aws_iam_role.fn["push"].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.fn["push"].output_path
  source_code_hash = data.archive_file.fn["push"].output_base64sha256
  timeout          = local.functions["push"].timeout
  memory_size      = local.functions["push"].memory

  environment {
    variables = merge(local.common_env, { PUSH_ENDPOINT = local.push_endpoint })
  }

  dead_letter_config {
    target_arn = aws_sqs_queue.dlq["push"].arn
  }

  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy.fn]
}

locals {
  function_arns = merge({ for k, f in aws_lambda_function.fn : k => f.arn }, { push = aws_lambda_function.push.arn })
}

resource "aws_lambda_function_event_invoke_config" "async" {
  for_each                     = local.async_functions
  function_name                = each.key == "push" ? aws_lambda_function.push.function_name : aws_lambda_function.fn[each.key].function_name
  maximum_retry_attempts       = 2
  maximum_event_age_in_seconds = 3600
}

resource "aws_lambda_event_source_mapping" "dead_letters" {
  for_each         = aws_sqs_queue.dlq
  event_source_arn = each.value.arn
  function_name    = aws_lambda_function.fn["dlq-alerter"].arn
  batch_size       = 10
}
```

Create `infra/modules/ring-events/http.tf`:

```hcl
# Ring -> HomeLedger: the Token Exchange URL, the Account Link URL, the webhook (amendment §12.1–12.3).
resource "aws_apigatewayv2_api" "http" {
  name          = "${var.name_prefix}-ring"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_stage" "http" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}

locals {
  http_routes = {
    "POST /ring/token"   = "token-exchange"
    "GET /ring/link"     = "link"
    "POST /ring/link"    = "link"
    "POST /ring/webhook" = "webhook"
  }
  http_functions = toset(values(local.http_routes))
}

resource "aws_apigatewayv2_integration" "http" {
  for_each               = local.http_functions
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.fn[each.key].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "http" {
  for_each  = local.http_routes
  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.http[each.value].id}"
}

resource "aws_lambda_permission" "http" {
  for_each      = local.http_functions
  statement_id  = "AllowRingHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
```

Create `infra/modules/ring-events/websocket.tf`:

```hcl
# HomeLedger -> the simulator's server (spec §7). $connect is authorised by the
# Cognito client-credentials JWT, carried in the Authorization header.
resource "aws_apigatewayv2_api" "ws" {
  name                       = "${var.name_prefix}-push"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

resource "aws_apigatewayv2_authorizer" "ws" {
  api_id           = aws_apigatewayv2_api.ws.id
  name             = "${var.name_prefix}-push-jwt"
  authorizer_type  = "REQUEST"
  authorizer_uri   = aws_lambda_function.fn["ws-authorizer"].invoke_arn
  identity_sources = ["route.request.header.Authorization"]
}

resource "aws_apigatewayv2_integration" "ws" {
  api_id           = aws_apigatewayv2_api.ws.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.fn["ws-connections"].invoke_arn
}

resource "aws_apigatewayv2_route" "ws" {
  for_each           = toset(["$connect", "$disconnect", "$default"])
  api_id             = aws_apigatewayv2_api.ws.id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.ws.id}"
  authorization_type = each.key == "$connect" ? "CUSTOM" : "NONE"
  authorizer_id      = each.key == "$connect" ? aws_apigatewayv2_authorizer.ws.id : null
}

resource "aws_apigatewayv2_stage" "ws" {
  api_id      = aws_apigatewayv2_api.ws.id
  name        = local.ws_stage
  auto_deploy = true
}

resource "aws_lambda_permission" "ws" {
  for_each      = toset(["ws-authorizer", "ws-connections"])
  statement_id  = "AllowPushWebSocketApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*"
}

locals {
  push_endpoint = "https://${aws_apigatewayv2_api.ws.id}.execute-api.${local.region}.amazonaws.com/${local.ws_stage}"
}
```

Create `infra/modules/ring-events/events.tf`:

```hcl
# Rules on the bus: raw Ring events (source ring.webhook) fan out to the three
# consumers; HomeLedger's own outcomes (source homeledger.events) go to push.
locals {
  rules = {
    "doorbell" = {
      function = "visit-correlator"
      pattern = {
        source = ["ring.webhook"]
        "$or" = [
          { "detail-type" = ["button_press"] },
          { "detail-type" = ["motion_detected"], detail = { subType = ["human"] } }
        ]
      }
    }
    "sensors" = {
      function = "sensor-rules"
      pattern  = { source = ["ring.webhook"], "detail-type" = ["flood_detected", "flood_cleared", "freeze_detected", "freeze_cleared", "contact_sensor_faulted", "contact_sensor_cleared"] }
    }
    "devices" = {
      function = "device-sync"
      pattern  = { source = ["ring.webhook"], "detail-type" = ["device_added", "device_removed", "device_online", "device_offline", "app_integration_added", "app_integration_removed"] }
    }
    "push" = {
      function = "push"
      pattern  = { source = ["homeledger.events"], "detail-type" = ["visit.arrived", "alert.raised"] }
    }
  }
}

resource "aws_cloudwatch_event_rule" "this" {
  for_each       = local.rules
  name           = "${var.name_prefix}-${each.key}"
  event_bus_name = aws_cloudwatch_event_bus.this.name
  event_pattern  = jsonencode(each.value.pattern)
}

resource "aws_cloudwatch_event_target" "this" {
  for_each       = local.rules
  rule           = aws_cloudwatch_event_rule.this[each.key].name
  event_bus_name = aws_cloudwatch_event_bus.this.name
  arn            = local.function_arns[each.value.function]
  retry_policy {
    maximum_retry_attempts       = 2
    maximum_event_age_in_seconds = 3600
  }
  dead_letter_config {
    arn = aws_sqs_queue.dlq[each.value.function].arn
  }
}

resource "aws_lambda_permission" "events" {
  for_each      = local.rules
  statement_id  = "AllowBusRule-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = local.function_arns[each.value.function]
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.this[each.key].arn
}

# EventBridge delivers to a target's DLQ under a queue policy, not a role.
resource "aws_sqs_queue_policy" "dlq" {
  for_each  = local.rules
  queue_url = aws_sqs_queue.dlq[each.value.function].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.dlq[each.value.function].arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.this[each.key].arn } }
    }]
  })
}

# ---------- Schedules: the reconciliation poll, the token refresh, the nightly device sync ----------
locals {
  schedules = {
    "sensor-poll"   = { function = "sensor-poller", expression = var.sensor_poll_minutes == 1 ? "rate(1 minute)" : "rate(${var.sensor_poll_minutes} minutes)", state = var.sensors_enabled ? "ENABLED" : "DISABLED", detail_type = "sensor-poll" }
    "token-refresh" = { function = "token-refresh", expression = "rate(30 minutes)", state = "ENABLED", detail_type = "token-refresh" }
    "device-sync"   = { function = "device-sync", expression = "cron(0 3 * * ? *)", state = "ENABLED", detail_type = "Scheduled Event" }
  }
}

resource "aws_iam_role" "scheduler" {
  name = "${var.name_prefix}-ring-scheduler"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "scheduler.amazonaws.com" }, Action = "sts:AssumeRole", Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } } }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Invoke", Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = [for s in local.schedules : local.function_arns[s.function]] },
      { Sid = "DeadLetter", Effect = "Allow", Action = ["sqs:SendMessage"], Resource = [for s in local.schedules : aws_sqs_queue.dlq[s.function].arn] }
    ]
  })
}

resource "aws_scheduler_schedule" "this" {
  for_each                     = local.schedules
  name                         = "${var.name_prefix}-${each.key}"
  schedule_expression          = each.value.expression
  schedule_expression_timezone = "America/Chicago"
  state                        = each.value.state
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = local.function_arns[each.value.function]
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ "detail-type" = each.value.detail_type, source = "homeledger.schedule", detail = {} })
    retry_policy {
      maximum_retry_attempts = 0
    }
    dead_letter_config {
      arn = aws_sqs_queue.dlq[each.value.function].arn
    }
  }
}
```

Create `infra/modules/ring-events/outputs.tf`:

```hcl
output "token_exchange_url" {
  description = "Ring Developer Portal: Token Exchange URL."
  value       = "${aws_apigatewayv2_api.http.api_endpoint}/ring/token"
}

output "account_link_url" {
  description = "Ring Developer Portal: Account Link URL."
  value       = "${aws_apigatewayv2_api.http.api_endpoint}/ring/link"
}

output "webhook_url" {
  description = "Ring Developer Portal: Webhook URL."
  value       = "${aws_apigatewayv2_api.http.api_endpoint}/ring/webhook"
}

output "push_websocket_url" {
  description = "WebSocket URL the simulator's server connects to (HOMELEDGER_PUSH_URL)."
  value       = aws_apigatewayv2_stage.ws.invoke_url
}

output "push_endpoint" {
  description = "Management endpoint the push function posts through."
  value       = local.push_endpoint
}

output "snapshot_bucket" {
  description = "Bucket holding doorbell snapshots under snapshots/."
  value       = aws_s3_bucket.snapshots.bucket
}

output "snapshot_bucket_arn" {
  description = "ARN of the snapshot bucket; the MCP runtime may read snapshots/* only."
  value       = aws_s3_bucket.snapshots.arn
}

output "snapshot_origin" {
  description = "Origin of presigned snapshot URLs; the visit widget declares it as a resource domain (R8)."
  value       = "https://${aws_s3_bucket.snapshots.bucket_regional_domain_name}"
}

output "event_bus_name" {
  description = "The custom event bus."
  value       = aws_cloudwatch_event_bus.this.name
}

output "tokens_secret_arn" {
  description = "Secret the link and token-refresh functions write the Ring tokens to."
  value       = aws_secretsmanager_secret.tokens.arn
}

output "secret_grants" {
  description = "Per function, the secret ARNs it may read - spec §3's table, as applied."
  value       = { for k, f in local.functions : k => [for s in f.secrets_read : local.secret_arns[s]] }
}
```

Create `infra/modules/ring-events/README.md` with: a one-paragraph purpose, the outputs table from this task's Interfaces block, the spec §3 secrets table, a line saying `artifacts_dir` must hold `pnpm --filter @homeledger/events build`'s output before any plan, and a line saying this module is never applied locally.

Append `infra/modules/ring-events/.build/` to `.gitignore`.

- [ ] **Step 2: Write the tests**

Create `infra/modules/ring-events/tests/ring-events.tftest.hcl`:

```hcl
# Native tests with mocked providers: no AWS call, no built bundles needed
# (archive_file is mocked too). Every ARN-typed attribute that another
# resource consumes is pinned, because the AWS provider validates ARN shape on
# arguments and a mock's random string is not an ARN.
mock_provider "archive" {}

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "123456789012" }
  }
  override_data {
    target = data.aws_region.current
    values = { region = "us-east-1" }
  }
  override_resource {
    target = aws_iam_role.fn
    values = { arn = "arn:aws:iam::123456789012:role/demo-homeledger-fn" }
  }
  override_resource {
    target = aws_iam_role.scheduler
    values = { arn = "arn:aws:iam::123456789012:role/demo-homeledger-ring-scheduler" }
  }
  override_resource {
    target = aws_sqs_queue.dlq
    values = { arn = "arn:aws:sqs:us-east-1:123456789012:dlq", id = "https://sqs.us-east-1.amazonaws.com/123456789012/dlq" }
  }
  override_resource {
    target = aws_cloudwatch_log_group.fn
    values = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/fn" }
  }
  override_resource {
    target = aws_cloudwatch_event_bus.this
    values = { arn = "arn:aws:events:us-east-1:123456789012:event-bus/demo-homeledger" }
  }
  override_resource {
    target = aws_cloudwatch_event_rule.this
    values = { arn = "arn:aws:events:us-east-1:123456789012:rule/demo-homeledger/rule" }
  }
  override_resource {
    target = aws_lambda_function.fn
    values = { arn = "arn:aws:lambda:us-east-1:123456789012:function:fn", invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:fn/invocations" }
  }
  override_resource {
    target = aws_lambda_function.push
    values = { arn = "arn:aws:lambda:us-east-1:123456789012:function:push", invoke_arn = "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:push/invocations" }
  }
  override_resource {
    target = aws_apigatewayv2_api.http
    values = { id = "httpapi01", api_endpoint = "https://httpapi01.execute-api.us-east-1.amazonaws.com", execution_arn = "arn:aws:execute-api:us-east-1:123456789012:httpapi01" }
  }
  override_resource {
    target = aws_apigatewayv2_api.ws
    values = { id = "wsapi01", execution_arn = "arn:aws:execute-api:us-east-1:123456789012:wsapi01" }
  }
  override_resource {
    target = aws_apigatewayv2_stage.ws
    values = { invoke_url = "wss://wsapi01.execute-api.us-east-1.amazonaws.com/demo" }
  }
  override_resource {
    target = aws_s3_bucket.snapshots
    values = { arn = "arn:aws:s3:::demo-homeledger-snapshots-123456789012", bucket = "demo-homeledger-snapshots-123456789012", bucket_regional_domain_name = "demo-homeledger-snapshots-123456789012.s3.us-east-1.amazonaws.com" }
  }
  override_resource {
    target = aws_secretsmanager_secret.tokens
    values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/ring/tokens-AbCdEf" }
  }
}

variables {
  name_prefix            = "demo-homeledger"
  household_id           = "hh_harlow"
  table_name             = "demo-homeledger"
  table_arn              = "arn:aws:dynamodb:us-east-1:123456789012:table/demo-homeledger"
  artifacts_dir          = "../../../apps/events/dist"
  ring_client_id         = "client-1"
  ring_client_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/ring/client-secret-l29t29"
  ring_hmac_key_arn      = "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/ring/hmac-key-k7NhwE"
  anthropic_key_arn      = "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/anthropic/api-key-Zz0000"
  link_passphrase_arn    = "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/ring/link-passphrase-Yy0000"
  cognito_user_pool_id   = "us-east-1_Example1"
  cognito_client_id      = "cognito-client-1"
}

run "every_handler_is_a_node22_arm64_function" {
  command = apply
  assert {
    condition     = length(aws_lambda_function.fn) == 11 && alltrue([for f in values(aws_lambda_function.fn) : f.runtime == "nodejs22.x" && f.architectures[0] == "arm64" && f.handler == "index.handler"])
    error_message = "eleven for_each functions plus push, all nodejs22.x on arm64 with index.handler"
  }
  assert {
    condition     = aws_lambda_function.push.runtime == "nodejs22.x" && aws_lambda_function.push.environment[0].variables.PUSH_ENDPOINT == "https://wsapi01.execute-api.us-east-1.amazonaws.com/demo"
    error_message = "push posts through the WebSocket management endpoint"
  }
}

run "secrets_are_granted_exactly_as_spec_section_3_says" {
  command = apply
  assert {
    condition     = output.secret_grants["webhook"] == [var.ring_hmac_key_arn]
    error_message = "the webhook reads the HMAC key and nothing else"
  }
  assert {
    condition     = output.secret_grants["visit-correlator"] == ["arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/ring/tokens-AbCdEf", var.anthropic_key_arn]
    error_message = "the correlator reads the tokens and the Anthropic key"
  }
  assert {
    condition     = output.secret_grants["link"] == [var.ring_hmac_key_arn, var.link_passphrase_arn, "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/ring/tokens-AbCdEf"]
    error_message = "the link reads the HMAC key, the passphrase and the tokens"
  }
  assert {
    condition     = output.secret_grants["ws-authorizer"] == [] && output.secret_grants["push"] == [] && output.secret_grants["sensor-rules"] == []
    error_message = "functions outside the table read no secret"
  }
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.fn["webhook"].policy).Statement : s.Resource if s.Sid == "ReadSecrets"]) == [var.ring_hmac_key_arn]
    error_message = "the webhook role's policy must carry the same single grant"
  }
}

run "only_the_correlator_writes_snapshots_and_only_under_snapshots" {
  command = apply
  assert {
    condition     = one([for s in jsondecode(aws_iam_role_policy.fn["visit-correlator"].policy).Statement : s.Resource if s.Sid == "WriteSnapshots"]) == ["arn:aws:s3:::demo-homeledger-snapshots-123456789012/snapshots/*"]
    error_message = "the correlator may put objects under snapshots/ only"
  }
  assert {
    condition     = alltrue([for k, p in aws_iam_role_policy.fn : k == "visit-correlator" || length([for s in jsondecode(p.policy).Statement : s if s.Sid == "WriteSnapshots"]) == 0])
    error_message = "no other function may write snapshots"
  }
}

run "ring_routes_are_exactly_the_three_urls" {
  command = plan
  assert {
    condition     = toset(keys(aws_apigatewayv2_route.http)) == toset(["POST /ring/token", "GET /ring/link", "POST /ring/link", "POST /ring/webhook"])
    error_message = "token exchange, account link (GET and POST) and webhook"
  }
}

run "connect_is_authorised_by_the_authorization_header" {
  command = apply
  assert {
    condition     = aws_apigatewayv2_route.ws["$connect"].authorization_type == "CUSTOM" && aws_apigatewayv2_route.ws["$default"].authorization_type == "NONE"
    error_message = "$connect is authorised; the keepalive route is not"
  }
  assert {
    condition     = toset(aws_apigatewayv2_authorizer.ws.identity_sources) == toset(["route.request.header.Authorization"])
    error_message = "the token must come from the Authorization header, never the query string"
  }
}

run "the_doorbell_rule_routes_presses_and_human_motion_only" {
  command = plan
  assert {
    condition = jsondecode(aws_cloudwatch_event_rule.this["doorbell"].event_pattern) == {
      source = ["ring.webhook"]
      "$or"  = [{ "detail-type" = ["button_press"] }, { "detail-type" = ["motion_detected"], detail = { subType = ["human"] } }]
    }
    error_message = "doorbell rule pattern"
  }
  assert {
    condition     = jsondecode(aws_cloudwatch_event_rule.this["push"].event_pattern).source == ["homeledger.events"]
    error_message = "push listens only to HomeLedger's own outcomes"
  }
}

run "every_async_function_has_a_dead_letter_queue_and_two_retries" {
  command = apply
  assert {
    condition     = toset(keys(aws_sqs_queue.dlq)) == toset(["device-sync", "visit-correlator", "sensor-rules", "sensor-poller", "token-refresh", "push"])
    error_message = "six dead-letter queues"
  }
  assert {
    condition     = alltrue([for c in values(aws_lambda_function_event_invoke_config.async) : c.maximum_retry_attempts == 2])
    error_message = "two retries before dead-lettering"
  }
  assert {
    condition     = length(aws_lambda_event_source_mapping.dead_letters) == 6
    error_message = "the alerter reads every dead-letter queue"
  }
}

run "the_poll_interval_is_configurable_and_the_flag_pauses_it" {
  command = plan
  variables {
    sensor_poll_minutes = 1
    sensors_enabled     = false
  }
  assert {
    condition     = aws_scheduler_schedule.this["sensor-poll"].schedule_expression == "rate(1 minute)" && aws_scheduler_schedule.this["sensor-poll"].state == "DISABLED"
    error_message = "one minute is singular, and the sensor flag disables the poll"
  }
  assert {
    condition     = aws_lambda_function.fn["sensor-rules"].environment[0].variables.SENSORS_ENABLED == "0"
    error_message = "the flag reaches the rules function too"
  }
}

run "the_default_poll_is_every_two_minutes" {
  command = plan
  assert {
    condition     = aws_scheduler_schedule.this["sensor-poll"].schedule_expression == "rate(2 minutes)" && aws_scheduler_schedule.this["sensor-poll"].state == "ENABLED"
    error_message = "spec §6 default"
  }
}

run "rejects_a_fractional_or_zero_poll_interval" {
  command = plan
  variables {
    sensor_poll_minutes = 0
  }
  expect_failures = [var.sensor_poll_minutes]
}
```

- [ ] **Step 3: Run the checks CI runs**

Run:

```bash
cd infra && terraform fmt -recursive && terraform fmt -check -recursive
cd modules/ring-events && terraform init -backend=false && terraform validate && terraform test
```

Expected: `fmt` clean; `Success! The configuration is valid.`; `10 passed, 0 failed.` — one per `run` block.

If a mocked apply fails on an ARN-shaped argument this file does not pin, add an `override_resource` for that resource with a well-formed ARN — never loosen an assertion to get past it — and say so in the report.

- [ ] **Step 4: Mutation check**

Apply each, run `terraform test`, record, revert:
1. Add `"anthropic"` to the webhook's `secrets_read` → `secrets_are_granted_exactly_as_spec_section_3_says` fails.
2. Change the correlator's snapshot resource to `"${aws_s3_bucket.snapshots.arn}/*"` → `only_the_correlator_writes_snapshots…` fails.
3. Set `snapshots = true` on `webhook` → the "no other function" assertion fails.
4. Change the authorizer identity source to `route.request.querystring.token` → `connect_is_authorised_by_the_authorization_header` fails.
5. Drop the `$or` branch for motion → the doorbell-rule test fails.
6. Set `async = false` on `push` → the dead-letter test fails (five queues).
7. Remove the singular-minute special case → `the_poll_interval_is_configurable…` fails (`rate(1 minutes)`).

- [ ] **Step 5: Commit**

```bash
git add infra/modules/ring-events .gitignore
git commit -m "feat(infra): ring-events module - HTTP and WebSocket APIs, the bus, twelve functions with least-privilege roles, dead letters, and schedules"
```

---
### Task 14: Platform wiring, the runtime's snapshot read, CI, deploy and teardown

**Files:**
- Modify: `infra/modules/agentcore-runtime/variables.tf`, `main.tf`, `outputs.tf`, `tests/agentcore-runtime.tftest.hcl`
- Modify: `infra/live/demo/platform/versions.tf`, `variables.tf`, `main.tf`, `outputs.tf`, `README.md`, `.terraform.lock.hcl`, `tests/platform.tftest.hcl`, `tests/teardown.tftest.hcl`
- Create: `infra/modules/ring-events/.terraform.lock.hcl` (generated)
- Modify: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `.github/workflows/teardown.yml`

**Interfaces:**
- Consumes: Task 13's module and outputs.
- Produces: root outputs `ring_token_exchange_url`, `ring_account_link_url`, `ring_webhook_url`, `push_websocket_url`, `snapshot_bucket`, `ring_event_bus_name` (read by Task 17's smoke and Task 18's owner setup); the MCP runtime gains `SNAPSHOT_BUCKET` and `SNAPSHOT_ORIGIN` in its environment (read by Task 15) and `s3:GetObject` on `snapshots/*` only (spec §5).

**Before this task's PR can plan (R7).** The PR's `plan` job reads four secrets as `data` sources. `client-secret` and `hmac-key` exist. The controller confirms, with the owner's go-ahead, that `demo-homeledger/anthropic/api-key` and `demo-homeledger/ring/link-passphrase` exist (`aws secretsmanager describe-secret --secret-id <name> --profile homeledger-admin --region us-east-1` shows an `AWSCURRENT` version) and that the repository variable `RING_CLIENT_ID` is set (`gh variable list`). If either is missing, the plan fails with "couldn't find resource", which is the intended loud failure — not something to work around with a conditional.

- [ ] **Step 1: The runtime may read snapshots, and nothing else in S3**

In `infra/modules/agentcore-runtime/variables.tf`, after `knowledge_base_arn`:

```hcl
variable "snapshot_bucket_arn" {
  type        = string
  description = "ARN of the doorbell snapshot bucket. The runtime may s3:GetObject under snapshots/ only, to presign the image get_visit returns (spec §5). Empty grants no S3 access."
  default     = ""
}
```

In `infra/modules/agentcore-runtime/main.tf`, add a local at the top of the file's existing `locals` block (or create one):

```hcl
locals {
  snapshot_read_resources = var.snapshot_bucket_arn == "" ? [] : ["${var.snapshot_bucket_arn}/snapshots/*"]
}
```

and, after the `RetrieveFromKnowledgeBase` dynamic statement inside `data "aws_iam_policy_document" "this"`:

```hcl
  dynamic "statement" {
    for_each = length(local.snapshot_read_resources) == 0 ? [] : [local.snapshot_read_resources]
    content {
      sid       = "ReadSnapshots"
      actions   = ["s3:GetObject"]
      resources = statement.value
    }
  }
```

In `infra/modules/agentcore-runtime/outputs.tf`:

```hcl
output "snapshot_read_resources" {
  description = "Object ARNs the runtime may read - exactly snapshots/* of the snapshot bucket, or nothing. Exposed because tests can read outputs, not a mocked policy document."
  value       = local.snapshot_read_resources
}
```

Append to `infra/modules/agentcore-runtime/tests/agentcore-runtime.tftest.hcl`:

```hcl
run "reads_snapshots_under_the_snapshots_prefix_only" {
  command = plan
  variables {
    snapshot_bucket_arn = "arn:aws:s3:::demo-homeledger-snapshots-123456789012"
  }
  assert {
    condition     = output.snapshot_read_resources == ["arn:aws:s3:::demo-homeledger-snapshots-123456789012/snapshots/*"]
    error_message = "the runtime may read snapshots/* and nothing else in the bucket"
  }
}

run "no_snapshot_bucket_no_s3_access" {
  command = plan
  assert {
    condition     = output.snapshot_read_resources == []
    error_message = "with no bucket the runtime gets no S3 statement"
  }
}
```

Run: `cd infra/modules/agentcore-runtime && terraform init -backend=false && terraform validate && terraform test`
Expected: every run passes, including the two new ones.

- [ ] **Step 2: Wire the platform root**

In `infra/live/demo/platform/versions.tf`, add inside `required_providers`:

```hcl
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.7.0, < 3.0.0"
    }
```

Append to `infra/live/demo/platform/variables.tf`:

```hcl
variable "ring_client_id" {
  type        = string
  description = "Ring app Client ID - not a secret (spec §3). Passed from the RING_CLIENT_ID repository variable by deploy.yml and teardown.yml."
  default     = ""
}

variable "sensors_enabled" {
  type        = bool
  description = "Spec §6 flag for the live sensor path."
  default     = true
}

variable "sensor_appliance_id" {
  type        = string
  description = "Appliance whose inspection a flood or freeze advances (Plan 4 R12)."
  default     = "appl_waterheater22222"
}

variable "events_artifacts_dir" {
  type        = string
  description = "apps/events build output, relative to this root. deploy.yml builds it before every plan and apply."
  default     = "../../../../apps/events/dist"
}
```

In `infra/live/demo/platform/main.tf`:

Inside `resource "aws_dynamodb_table" "homeledger"`, before `point_in_time_recovery`, add:

```hcl
  # Push connection rows (CONN#) expire on their own (Plan 4 Task 3).
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
```

After the Secrets Manager section, add:

```hcl
# ---------- Ring (Plan 4) ----------
# Owner-created secrets, read by reference so a destroy can never delete them
# and their values never enter state (spec §3, Plan 4 R7).
data "aws_secretsmanager_secret" "ring_client_secret" {
  name = "${local.name_prefix}/ring/client-secret"
}

data "aws_secretsmanager_secret" "ring_hmac_key" {
  name = "${local.name_prefix}/ring/hmac-key"
}

data "aws_secretsmanager_secret" "anthropic_key" {
  name = "${local.name_prefix}/anthropic/api-key"
}

data "aws_secretsmanager_secret" "link_passphrase" {
  name = "${local.name_prefix}/ring/link-passphrase"
}

module "ring_events" {
  source = "../../../modules/ring-events"

  name_prefix            = local.name_prefix
  household_id           = var.household_id
  table_name             = aws_dynamodb_table.homeledger.name
  table_arn              = aws_dynamodb_table.homeledger.arn
  artifacts_dir          = var.events_artifacts_dir
  ring_client_id         = var.ring_client_id
  ring_client_secret_arn = data.aws_secretsmanager_secret.ring_client_secret.arn
  ring_hmac_key_arn      = data.aws_secretsmanager_secret.ring_hmac_key.arn
  anthropic_key_arn      = data.aws_secretsmanager_secret.anthropic_key.arn
  link_passphrase_arn    = data.aws_secretsmanager_secret.link_passphrase.arn
  cognito_user_pool_id   = module.cognito.user_pool_id
  cognito_client_id      = module.cognito.client_id
  sensors_enabled        = var.sensors_enabled
  sensor_appliance_id    = var.sensor_appliance_id

  secret_recovery_window_in_days = var.secret_recovery_window_in_days
}
```

In `module "agentcore_runtime"`, add to `environment_variables`:

```hcl
    SNAPSHOT_BUCKET       = module.ring_events.snapshot_bucket
    SNAPSHOT_ORIGIN       = module.ring_events.snapshot_origin
```

and, after `knowledge_base_arn`:

```hcl
  snapshot_bucket_arn = module.ring_events.snapshot_bucket_arn
```

Append to `infra/live/demo/platform/outputs.tf`:

```hcl
output "ring_token_exchange_url" {
  description = "Ring Developer Portal: Token Exchange URL."
  value       = module.ring_events.token_exchange_url
}

output "ring_account_link_url" {
  description = "Ring Developer Portal: Account Link URL."
  value       = module.ring_events.account_link_url
}

output "ring_webhook_url" {
  description = "Ring Developer Portal: Webhook URL."
  value       = module.ring_events.webhook_url
}

output "push_websocket_url" {
  description = "HOMELEDGER_PUSH_URL for the simulator."
  value       = module.ring_events.push_websocket_url
}

output "snapshot_bucket" {
  description = "Doorbell snapshot bucket."
  value       = module.ring_events.snapshot_bucket
}

output "ring_event_bus_name" {
  description = "The Ring pipeline's event bus."
  value       = module.ring_events.event_bus_name
}
```

In `infra/live/demo/platform/README.md`, replace the sentence about later layers becoming sibling roots with: "Plan 4 put the Ring pipeline in this root as `module.ring_events`, not a sibling root: the MCP runtime's role and environment need its snapshot bucket, and the table needed a TTL (Plan 4 R6). `apps/events` must be built before any plan (`pnpm --filter @homeledger/events build`); deploy.yml and teardown.yml do it."

- [ ] **Step 3: Keep the platform tests offline**

Both `infra/live/demo/platform/tests/platform.tftest.hcl` and `tests/teardown.tftest.hcl` get the same three additions (mocks are per file, as teardown.tftest.hcl's header explains):

At the top, next to `mock_provider "random" {}`:

```hcl
mock_provider "archive" {}
```

Inside `mock_provider "aws" { … }`, four more `override_data` blocks:

```hcl
  override_data {
    target = data.aws_secretsmanager_secret.ring_client_secret
    values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/ring/client-secret-AAAAAA" }
  }
  override_data {
    target = data.aws_secretsmanager_secret.ring_hmac_key
    values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/ring/hmac-key-BBBBBB" }
  }
  override_data {
    target = data.aws_secretsmanager_secret.anthropic_key
    values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/anthropic/api-key-CCCCCC" }
  }
  override_data {
    target = data.aws_secretsmanager_secret.link_passphrase
    values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/ring/link-passphrase-DDDDDD" }
  }
```

And, after the `mock_provider "aws"` block, the whole module replaced by fixed outputs — the module has its own tests (Task 13), and this file tests the root's wiring:

```hcl
override_module {
  target = module.ring_events
  outputs = {
    token_exchange_url  = "https://httpapi01.execute-api.us-east-1.amazonaws.com/ring/token"
    account_link_url    = "https://httpapi01.execute-api.us-east-1.amazonaws.com/ring/link"
    webhook_url         = "https://httpapi01.execute-api.us-east-1.amazonaws.com/ring/webhook"
    push_websocket_url  = "wss://wsapi01.execute-api.us-east-1.amazonaws.com/demo"
    push_endpoint       = "https://wsapi01.execute-api.us-east-1.amazonaws.com/demo"
    snapshot_bucket     = "demo-homeledger-snapshots-123456789012"
    snapshot_bucket_arn = "arn:aws:s3:::demo-homeledger-snapshots-123456789012"
    snapshot_origin     = "https://demo-homeledger-snapshots-123456789012.s3.us-east-1.amazonaws.com"
    event_bus_name      = "demo-homeledger"
    tokens_secret_arn   = "arn:aws:secretsmanager:us-east-1:123456789012:secret:demo-homeledger/ring/tokens-EEEEEE"
    secret_grants       = {}
  }
}
```

Append to `tests/platform.tftest.hcl` only:

```hcl
run "push_connections_expire_on_the_ttl_attribute" {
  command = plan
  assert {
    condition     = one(aws_dynamodb_table.homeledger.ttl).attribute_name == "ttl" && one(aws_dynamodb_table.homeledger.ttl).enabled
    error_message = "CONN# rows carry `ttl` in epoch seconds (Plan 4 Task 3); the table must expire on it"
  }
}

run "ring_urls_reach_the_root_outputs" {
  command = plan
  assert {
    condition     = output.ring_webhook_url == "https://httpapi01.execute-api.us-east-1.amazonaws.com/ring/webhook" && output.push_websocket_url == "wss://wsapi01.execute-api.us-east-1.amazonaws.com/demo"
    error_message = "the owner copies these into the Ring Developer Portal and the simulator"
  }
}
```

The runtime's two new environment variables are checked by reading, not by a test: `module.agentcore_runtime`'s `environment_variables` is an input, and root tests can read a module's outputs but not its inputs or resources. Say so in the report.

Lock the new provider for both roots:

```bash
cd infra/live/demo/platform && terraform init -backend=false -upgrade && terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_arm64
cd ../../../modules/ring-events && terraform init -backend=false && terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_arm64
```

Run: `cd infra && terraform fmt -check -recursive && cd live/demo/platform && terraform validate && terraform test`
Expected: all runs pass, including the two new ones and every existing one.

- [ ] **Step 4: CI checks the new module**

In `.github/workflows/ci.yml`'s `terraform` job, after the `knowledge-base validate and test` step:

```yaml
      - name: ring-events validate and test
        working-directory: infra/modules/ring-events
        run: |
          terraform init -backend=false
          terraform validate
          terraform test
```

and after the `trivy (knowledge-base)` step:

```yaml
      - name: trivy (ring-events)
        uses: aquasecurity/trivy-action@v0.36.0
        with:
          scan-type: config
          scan-ref: infra/modules/ring-events
          severity: HIGH,CRITICAL
          exit-code: '1'
```

If trivy reports a HIGH or CRITICAL finding, fix it; where the finding is a deliberate demo trade-off, add a `# trivy:ignore:<ID> <reason>` line above the resource in the same style as the knowledge-base module's, and name every one in the report. Do not lower the severity threshold.

- [ ] **Step 5: Deploy and teardown build the bundles and pass the Client ID**

In `.github/workflows/deploy.yml`, in **both** the `plan` and `apply` jobs:

Add to the job's `env:` block:

```yaml
      RING_CLIENT_ID: ${{ vars.RING_CLIENT_ID }}
```

Insert these steps immediately after `- uses: actions/checkout@v4`:

```yaml
      # module.ring_events zips apps/events' bundles at plan time (archive_file),
      # so they must exist before Terraform reads the configuration.
      - uses: pnpm/action-setup@v4
        with: { version: 10.15.0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @homeledger/core build && pnpm --filter @homeledger/events build
```

Change the plan command to:

```yaml
          terraform plan -no-color -input=false -var "image_uri=$IMAGE" -var "ring_client_id=$RING_CLIENT_ID" -out=tfplan
```

the ECR bootstrap apply to add `-var "ring_client_id=$RING_CLIENT_ID"`, and the final apply to:

```yaml
        run: terraform apply -auto-approve -input=false -var "image_uri=$IMAGE_URI" -var "ring_client_id=$RING_CLIENT_ID"
```

In `.github/workflows/teardown.yml`, make the same three changes to **both** jobs (`teardown` and the bring-up job): `RING_CLIENT_ID` in `env:`, the four setup/build steps after checkout, and `-var "ring_client_id=$RING_CLIENT_ID"` on the teardown job's `terraform plan` and the bring-up job's `terraform apply`. Without them, a teardown's plan would change every function's environment (tolerated as an update by that workflow's guard, but it would blank the Client ID), and without the bundles the plan cannot be read at all.

Run: `actionlint .github/workflows/deploy.yml .github/workflows/teardown.yml .github/workflows/ci.yml` if `actionlint` is installed; otherwise `python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/*.yml` to at least prove the YAML parses.
Expected: no errors.

- [ ] **Step 6: Mutation check**

Apply each, run the relevant `terraform test`, record, revert:
1. `snapshot_read_resources` → `["${var.snapshot_bucket_arn}/*"]` → `reads_snapshots_under_the_snapshots_prefix_only` fails.
2. Remove the `ttl` block → `push_connections_expire_on_the_ttl_attribute` fails.
3. Point `ring_webhook_url` at `module.ring_events.account_link_url` → `ring_urls_reach_the_root_outputs` fails.
4. Delete `mock_provider "archive" {}` from `teardown.tftest.hcl` → that file fails to run (record the message): proof that both files needed the addition, not just one.

- [ ] **Step 7: Commit**

```bash
git add infra .github/workflows
git commit -m "feat(infra): wire ring-events into the platform, give the runtime read-only snapshots, and build the Lambda bundles in CI, deploy and teardown"
```

---
### Task 15: MCP server — snapshot fields, the widget, the declared origin

Spec §5 "Changes to existing code", R5 and R8. Closes FL-030 and FL-051.

**Files:**
- Modify: `apps/mcp-server/package.json` (add `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, both `^3.900.0`, as dependencies)
- Create: `apps/mcp-server/src/snapshots.ts`
- Modify: `apps/mcp-server/src/server.ts` (`ServerDeps`), `apps/mcp-server/src/deps.ts`, `apps/mcp-server/src/tools/service.ts` (`get_visit`), `apps/mcp-server/src/tools/events.ts`, `apps/mcp-server/src/resources.ts`, `apps/mcp-server/src/widgets/visit.ts`
- Modify: `FRICTION-LOG.md` (status lines of FL-030 and FL-051)
- Test: `apps/mcp-server/test/visits.test.ts`, `apps/mcp-server/test/events.test.ts`, `apps/mcp-server/test/widgets.test.ts`, `apps/mcp-server/test/snapshots.test.ts` (new)

**Interfaces:**
- Consumes: `snapshotSentence`, `arrivalMatchNote`, `SnapshotStatus` (core, T2/T4); the runtime's `SNAPSHOT_BUCKET`, `SNAPSHOT_ORIGIN` (T14).
- Produces:
  - `ServerDeps` gains two **optional** fields, so `@homeledger/mcp-server/test-harness` (which the simulator imports) keeps compiling unchanged: `snapshotUrl?: (key: string) => Promise<string>` and `snapshotOrigin?: string`.
  - `export const SNAPSHOT_URL_TTL_SECONDS = 600;` and `export function createSnapshotPresigner(opts: { bucket: string; region?: string; client?: S3Client; sign?: typeof getSignedUrl }): (key: string) => Promise<string>` in `src/snapshots.ts`.
  - `get_visit`'s `structuredContent` gains, beside the existing `snapshotUrl` and `description`: `snapshotStatus` (`SnapshotStatus | null`), `snapshotNote` (`string | null`), `matchNote` (`string | null`), `snapshotLatencyMs` (`number | null`). Task 16's agent reads these through MCP; nothing reads them any other way.

**What the person hears versus what the card shows.** The spoken text stays short: the existing arrival sentence, then either `From the doorbell: <description>` or the snapshot note when there is no picture. The match note ("…matched it by the time of the ring, not by the photo") is on the card, which is where the spec puts it.

- [ ] **Step 1: Write the failing tests**

Create `apps/mcp-server/test/snapshots.test.ts`:

```ts
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { SNAPSHOT_URL_TTL_SECONDS, createSnapshotPresigner } from '../src/snapshots.js';

describe('snapshot presigner (spec §5: a presigned URL valid for ten minutes)', () => {
  it('signs a GET of exactly the stored key for six hundred seconds', async () => {
    const sign = vi.fn(async () => 'https://signed.example/x');
    const client = new S3Client({ region: 'us-east-1' });
    const presign = createSnapshotPresigner({ bucket: 'demo-homeledger-snapshots-123456789012', client, sign: sign as never });
    expect(await presign('snapshots/hh_harlow/visit_abcdefghijklmnop.jpg')).toBe('https://signed.example/x');
    expect(SNAPSHOT_URL_TTL_SECONDS).toBe(600);
    const [usedClient, command, options] = sign.mock.calls[0] as unknown as [S3Client, GetObjectCommand, { expiresIn: number }];
    expect(usedClient).toBe(client);
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: 'demo-homeledger-snapshots-123456789012', Key: 'snapshots/hh_harlow/visit_abcdefghijklmnop.jpg' });
    expect(options).toEqual({ expiresIn: 600 });
  });

  it('produces URLs on the bucket’s regional origin — the one Terraform declares for the widget (R8)', async () => {
    // Offline: presigning is local computation over static credentials.
    const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'AKIAEXAMPLEEXAMPLE00', secretAccessKey: 'example-secret-not-real' } });
    const url = new URL(await createSnapshotPresigner({ bucket: 'demo-homeledger-snapshots-123456789012', client })('snapshots/hh_harlow/visit_abcdefghijklmnop.jpg'));
    expect(url.origin).toBe('https://demo-homeledger-snapshots-123456789012.s3.us-east-1.amazonaws.com');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
  });
});
```

In `apps/mcp-server/test/visits.test.ts`, replace the body of `'speaks an arrived visit differently'` from the `putVisit` call to the end of the test with:

```ts
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
      ringEventIds: ['req-bp-0001'],
      snapshotKey: 'snapshots/hh_test/visit_bbbbbbbbbbbbbbbb.jpg',
      description: 'A person holding a toolbox stands at the front door.',
      snapshotStatus: 'ok',
      snapshotLatencyMs: 4200,
      arrivedAt: '2026-09-15T13:07:00.000Z',
      createdAt: '2026-09-13T12:00:00.000Z'
    });
    const r = await h.client.callTool({ name: 'get_visit', arguments: { visitId: 'visit_bbbbbbbbbbbbbbbb' } });
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe(
      'Kettle Creek Water Heaters arrived for the water heater on Tuesday, September 15. From the doorbell: A person holding a toolbox stands at the front door.'
    );
    const sc = r.structuredContent as Record<string, unknown> & { visit: { arrivedAt: string | null; arrivedAtLabel: string | null } };
    expect(sc.snapshotUrl).toBe('https://demo-homeledger-snapshots-123456789012.s3.us-east-1.amazonaws.com/snapshots/hh_test/visit_bbbbbbbbbbbbbbbb.jpg?X-Amz-Expires=600');
    expect(sc.snapshotStatus).toBe('ok');
    expect(sc.snapshotNote).toBe('Photo from the doorbell at the moment of the ring.');
    expect(sc.matchNote).toBe(
      'Matches your Tuesday, September 15, 8:00 AM to 10:00 AM CDT visit from Kettle Creek Water Heaters. HomeLedger matched it by the time of the ring, not by the photo.'
    );
    expect(sc.snapshotLatencyMs).toBe(4200);
    expect(sc.description).toBe('A person holding a toolbox stands at the front door.');
    expect(sc.visit.arrivedAt).toBe('2026-09-15T13:07:00.000Z');
    expect(sc.visit.arrivedAtLabel).toBe('Tuesday, September 15, 8:07 AM CDT');
```

and change that test's `modernClient()` call to:

```ts
    const h = await modernClient({ snapshotUrl: async key => `https://demo-homeledger-snapshots-123456789012.s3.us-east-1.amazonaws.com/${key}?X-Amz-Expires=600` });
```

Add, in the same `describe('get_visit', …)`:

```ts
  it('says why there is no photo, and never presigns a key that does not exist', async () => {
    const presign = vi.fn(async (key: string) => `https://x/${key}`);
    const h = await modernClient({ snapshotUrl: presign });
    close = h.close;
    const appliance = (await h.deps.repo.listAppliances({ category: 'water_heater' }))[0]!;
    await h.deps.repo.putVisit({
      id: 'visit_cccccccccccccccc',
      providerId: 'prov_kettle_water',
      providerName: 'Kettle Creek Water Heaters',
      category: 'water_heater',
      applianceId: appliance.id,
      issue: 'no hot water',
      windowStart: '2026-09-15T13:00:00.000Z',
      windowEnd: '2026-09-15T15:00:00.000Z',
      status: 'arrived',
      ringEventIds: ['req-bp-0002'],
      snapshotKey: null,
      description: null,
      snapshotStatus: 'forbidden',
      snapshotLatencyMs: 900,
      arrivedAt: '2026-09-15T13:07:00.000Z',
      createdAt: '2026-09-13T12:00:00.000Z'
    });
    const r = await h.client.callTool({ name: 'get_visit', arguments: { visitId: 'visit_cccccccccccccccc' } });
    expect((r.content as Array<{ text?: string }>)[0]?.text).toBe(
      'Kettle Creek Water Heaters arrived for the water heater on Tuesday, September 15. Ring did not allow HomeLedger to fetch a photo from that moment.'
    );
    expect((r.structuredContent as { snapshotUrl: unknown }).snapshotUrl).toBeNull();
    expect(presign).not.toHaveBeenCalled();
  });

  it('shows the visit without a link when presigning fails, rather than failing the call', async () => {
    const h = await modernClient({ snapshotUrl: async () => Promise.reject(new Error('ExpiredToken')) });
    close = h.close;
    const appliance = (await h.deps.repo.listAppliances({ category: 'water_heater' }))[0]!;
    await h.deps.repo.putVisit({
      id: 'visit_dddddddddddddddd',
      providerId: 'prov_kettle_water',
      providerName: 'Kettle Creek Water Heaters',
      category: 'water_heater',
      applianceId: appliance.id,
      issue: 'no hot water',
      windowStart: '2026-09-15T13:00:00.000Z',
      windowEnd: '2026-09-15T15:00:00.000Z',
      status: 'arrived',
      ringEventIds: ['req-bp-0003'],
      snapshotKey: 'snapshots/hh_test/visit_dddddddddddddddd.jpg',
      description: 'A van is parked at the curb.',
      snapshotStatus: 'ok',
      snapshotLatencyMs: 3000,
      arrivedAt: '2026-09-15T13:07:00.000Z',
      createdAt: '2026-09-13T12:00:00.000Z'
    });
    const r = await h.client.callTool({ name: 'get_visit', arguments: { visitId: 'visit_dddddddddddddddd' } });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { snapshotUrl: unknown; description: unknown }).snapshotUrl).toBeNull();
    expect((r.structuredContent as { description: unknown }).description).toBe('A van is parked at the curb.');
  });

  it('reads a visit stored before Plan 4 — no snapshot fields at all — as having none', async () => {
    const h = await modernClient();
    close = h.close;
    const appliance = (await h.deps.repo.listAppliances({ category: 'water_heater' }))[0]!;
    const legacy = {
      id: 'visit_eeeeeeeeeeeeeeee',
      providerId: 'prov_kettle_water',
      providerName: 'Kettle Creek Water Heaters',
      category: 'water_heater',
      applianceId: appliance.id,
      issue: 'no hot water',
      windowStart: '2026-09-15T13:00:00.000Z',
      windowEnd: '2026-09-15T15:00:00.000Z',
      status: 'scheduled',
      ringEventIds: [],
      snapshotKey: null,
      description: null,
      arrivedAt: null,
      createdAt: '2026-09-13T12:00:00.000Z'
    };
    await h.deps.repo.putVisit(legacy as unknown as Parameters<typeof h.deps.repo.putVisit>[0]);
    const sc = (await h.client.callTool({ name: 'get_visit', arguments: { visitId: 'visit_eeeeeeeeeeeeeeee' } })).structuredContent as Record<string, unknown>;
    expect([sc.snapshotStatus, sc.snapshotNote, sc.matchNote, sc.snapshotLatencyMs]).toEqual([null, null, null, null]);
  });
```

(Add `vi` to the file's `vitest` import.)

In `apps/mcp-server/test/events.test.ts`, add inside `describe('recent_events', …)`:

```ts
  it('lists only door events as door rows, and speaks a system alert in its own words', async () => {
    const h = await modernClient();
    close = h.close;
    await h.deps.repo.putEvent({ id: 'evt_aaaaaaaaaaaaaaaa', ringEventId: 'req-fl-0001', type: 'flood_detected', subType: null, deviceId: 'dev-flood-1', deviceName: 'Water Heater', at: '2026-09-13T11:10:00.000Z', rawS3Key: null });
    await h.deps.repo.putEvent({ id: 'evt_bbbbbbbbbbbbbbbb', ringEventId: 'req-bp-0001', type: 'button_press', subType: null, deviceId: 'dev-doorbell-1', deviceName: 'Front Door', at: '2026-09-13T11:20:00.000Z', rawS3Key: null });
    await h.deps.repo.putAlert({
      id: 'alert_aaaaaaaaaaaaaaaa',
      sensorType: 'system',
      severity: 'high',
      ringDeviceId: null,
      message: 'Ring access lapsed, so doorbell and sensor events have stopped. Link the Ring account again from the Ring app.',
      deviceName: 'HomeLedger',
      at: '2026-09-13T11:30:00.000Z',
      maintenanceRef: null,
      status: 'open'
    });
    const sc = (await h.client.callTool({ name: 'recent_events', arguments: {} })).structuredContent as { events: Array<{ kind: string; summary: string }> };
    expect(sc.events.map(e => [e.kind, e.summary])).toEqual([
      ['alert', 'Ring access lapsed, so doorbell and sensor events have stopped. Link the Ring account again from the Ring app.'],
      ['door', 'Someone rang the Front Door']
    ]);
  });
```

In `apps/mcp-server/test/widgets.test.ts`, add inside `describe('widget resources', …)`:

```ts
  it('declares the snapshot origin on the visit widget only, so a compliant host lets the photo load (R8, FL-030)', async () => {
    const h = await modernClient({ snapshotOrigin: 'https://demo-homeledger-snapshots-123456789012.s3.us-east-1.amazonaws.com' });
    close = h.close;
    const visit = (await h.client.readResource({ uri: WIDGET_URIS.visit })).contents[0] as { _meta?: unknown };
    expect(visit._meta).toEqual({ ui: { csp: { resourceDomains: ['https://demo-homeledger-snapshots-123456789012.s3.us-east-1.amazonaws.com'] } } });
    const calendar = (await h.client.readResource({ uri: WIDGET_URIS.calendar })).contents[0] as { _meta?: unknown };
    expect(calendar._meta).toBeUndefined();
  });

  it('declares nothing when no snapshot bucket is configured', async () => {
    const h = await modernClient();
    close = h.close;
    expect(((await h.client.readResource({ uri: WIDGET_URIS.visit })).contents[0] as { _meta?: unknown })._meta).toBeUndefined();
  });

  it('draws the match note, the snapshot note, and re-measures once the photo has loaded', async () => {
    const h = await modernClient();
    close = h.close;
    const html = ((await h.client.readResource({ uri: WIDGET_URIS.visit })).contents[0] as { text: string }).text;
    expect(html).toContain('if (data.matchNote) textRow(detail, \'muted\', data.matchNote);');
    expect(html).toContain('if (data.snapshotNote && !data.snapshotUrl) textRow(detail, \'muted\', data.snapshotNote);');
    expect(html).toContain('shot.onload = function () { window.homeledger.reportSize(); };');
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm install && pnpm --filter @homeledger/core build && pnpm --filter @homeledger/mcp-server test -- visits events widgets snapshots`
Expected: FAIL — the new fields, the presigner module, and the widget lines do not exist; `ServerDeps` has no `snapshotUrl`.

- [ ] **Step 3: Implement**

Create `apps/mcp-server/src/snapshots.ts`:

```ts
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Spec §5: `get_visit` returns a presigned image URL valid for ten minutes. */
export const SNAPSHOT_URL_TTL_SECONDS = 600;

export function createSnapshotPresigner(opts: { bucket: string; region?: string; client?: S3Client; sign?: typeof getSignedUrl }): (key: string) => Promise<string> {
  const client = opts.client ?? new S3Client({ region: opts.region ?? process.env.AWS_REGION ?? 'us-east-1' });
  const sign = opts.sign ?? getSignedUrl;
  return key => sign(client, new GetObjectCommand({ Bucket: opts.bucket, Key: key }), { expiresIn: SNAPSHOT_URL_TTL_SECONDS });
}
```

In `apps/mcp-server/src/server.ts`, add to `ServerDeps` after `availabilityDelayMs`:

```ts
  /** Presigns a snapshot key for get_visit (spec §5). Absent locally and in tests that do not need it; get_visit then returns snapshotUrl null. */
  snapshotUrl?: (key: string) => Promise<string>;
  /** The origin presigned snapshot URLs live on; the visit widget declares it for the host's CSP (Plan 4 R8). */
  snapshotOrigin?: string;
```

In `apps/mcp-server/src/deps.ts`, import `createSnapshotPresigner` from `./snapshots.js`, and in `depsFromEnv` change the `common` line to:

```ts
  const snapshotBucket = env.SNAPSHOT_BUCKET?.trim();
  const snapshotOrigin = env.SNAPSHOT_ORIGIN?.trim() || undefined;
  const common = {
    now,
    devTools,
    retriever,
    requestStateKey,
    availabilityDelayMs,
    ...(snapshotBucket ? { snapshotUrl: createSnapshotPresigner({ bucket: snapshotBucket, region: env.AWS_REGION }) } : {}),
    ...(snapshotOrigin ? { snapshotOrigin } : {})
  };
```

In `apps/mcp-server/src/tools/service.ts`, extend the core import with `SnapshotStatus, arrivalMatchNote, snapshotSentence`. In `get_visit`'s `outputSchema`, after `description: z.string().nullable()` add:

```ts
        snapshotStatus: SnapshotStatus.nullable(),
        snapshotNote: z.string().nullable(),
        matchNote: z.string().nullable(),
        snapshotLatencyMs: z.number().nullable()
```

Replace the handler's body from `const spoken =` to the end of the returned object with:

```ts
      // `?? null`: a visit written before Plan 4 has no snapshot fields at
      // all in DynamoDB, whatever the Visit type claims.
      const snapshotStatus = visit.snapshotStatus ?? null;
      const snapshotNote = snapshotSentence(snapshotStatus);
      const description = visit.description ?? null;
      let snapshotUrl: string | null = null;
      if (visit.snapshotKey && deps.snapshotUrl) {
        snapshotUrl = await deps.snapshotUrl(visit.snapshotKey).catch(err => {
          console.log(JSON.stringify({ msg: 'get_visit', outcome: 'presign-failed', error: err instanceof Error ? err.message : String(err) }));
          return null;
        });
      }
      const matchNote = visit.status !== 'scheduled' && visit.arrivedAt ? arrivalMatchNote({ windowLabel, providerName: visit.providerName }) : null;
      const base =
        visit.status === 'scheduled'
          ? `${visit.providerName} is scheduled for the ${applianceWords} on ${windowLabel}.`
          : `${visit.providerName} ${visit.status} for the ${applianceWords} on ${speakZonedDay(visit.windowStart, zone)}.`;
      const spoken = description ? `${base} From the doorbell: ${description}` : snapshotNote && snapshotStatus !== 'ok' ? `${base} ${snapshotNote}` : base;
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
            windowLabel,
            status: visit.status,
            arrivedAt: visit.arrivedAt,
            arrivedAtLabel
          },
          snapshotUrl,
          description,
          snapshotStatus,
          snapshotNote,
          matchNote,
          snapshotLatencyMs: visit.snapshotLatencyMs ?? null
        }
      };
```

(Remove the old "Both filled in by the Ring plan … Nova vision" comment; it is now false twice over.)

In `apps/mcp-server/src/tools/events.ts`, change the door rows to door events only, and let an alert's own message win:

```ts
const DOOR_TYPES = new Set(['button_press', 'motion_detected']);
```

(at module scope) and in the handler: `...doors.filter(e => DOOR_TYPES.has(e.type)).map(e => ({ … }))` in place of `...doors.map(…)`, and the alert summary becomes `` a.message ?? `${a.sensorType} alert from the ${a.deviceName}` ``. Add a comment above `DOOR_TYPES`: "Since Plan 4 the webhook stores every Ring event it receives (spec §4); sensor events reach the household as alerts, and device or account events as nothing, so only these two types are door rows."

In `apps/mcp-server/src/resources.ts`, delete the `KNOWN OPEN GAP (FL-030)` comment block and replace the widget loop with:

```ts
  // The visit widget's <img> loads a presigned S3 URL. A spec-compliant host
  // serves `img-src 'none'` unless the resource declares the origin
  // (`_meta.ui.csp.resourceDomains`, FL-030). Terraform knows the bucket's
  // regional domain and sets SNAPSHOT_ORIGIN, so the declaration is right in
  // every environment without editing (Plan 4 R8, closing FL-051).
  for (const widget of WIDGETS) {
    const meta = widget.uri === WIDGET_URIS.visit && deps.snapshotOrigin ? { _meta: { ui: { csp: { resourceDomains: [deps.snapshotOrigin] } } } } : {};
    server.registerResource(widget.name, widget.uri, { title: widget.title, description: widget.description, mimeType: RESOURCE_MIME_TYPE }, async uri => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: widget.html, ...meta }]
    }));
  }
```

(import `WIDGET_URIS` alongside `WIDGETS`). Check that `_meta.ui.csp` is where the installed `@modelcontextprotocol/ext-apps` expects it: `grep -n "McpUiResourceMeta" -r node_modules/@modelcontextprotocol/ext-apps/dist/src/*.d.ts` and read which object carries it (resource contents item vs. resource listing). If it is the listing, put the same `_meta` on the `registerResource` metadata argument as well, and change the test to read it from `listResources()`. Say which in the report.

In `apps/mcp-server/src/widgets/visit.ts`, replace everything from `if (data.description) {` to `window.homeledger.reportSize();` (inclusive) with:

```js
    if (data.matchNote) textRow(detail, 'muted', data.matchNote);
    if (data.description) {
      var described = document.createElement('div');
      described.className = 'card';
      textRow(described, 'muted', data.description);
      detail.appendChild(described);
    }
    if (data.snapshotNote && !data.snapshotUrl) textRow(detail, 'muted', data.snapshotNote);
    if (data.snapshotUrl) {
      var shot = document.createElement('img');
      shot.alt = 'Doorbell photo from the moment of the ring';
      shot.style.maxWidth = '100%';
      shot.style.borderRadius = '12px';
      // The frame is measured before a remote image arrives; measure again once it has.
      shot.onload = function () { window.homeledger.reportSize(); };
      shot.src = data.snapshotUrl;
      detail.appendChild(shot);
    }
    window.homeledger.reportSize();
```

In `FRICTION-LOG.md`, change FL-030's and FL-051's **Status** lines to: `Closed by Plan 4 Task 15: the visit widget's resource declares SNAPSHOT_ORIGIN in _meta.ui.csp.resourceDomains, set by Terraform from the bucket's regional domain (Plan 4 R8). No simulator proxy.`

- [ ] **Step 4: Run the tests, the typecheck, and the image build's dependency rule**

Run: `pnpm --filter @homeledger/mcp-server typecheck && pnpm --filter @homeledger/mcp-server test && pnpm --filter @homeledger/simulator typecheck`
Expected: PASS. The simulator typecheck proves the optional `ServerDeps` fields left the test harness it imports intact.

Run: `grep -n '"@homeledger/' apps/mcp-server/package.json`
Expected: only `@homeledger/core` — no edge to `events` or `simulator` (FL-036).

- [ ] **Step 5: Mutation check**

Apply each, run `pnpm --filter @homeledger/mcp-server test`, record, revert:
1. `expiresIn: SNAPSHOT_URL_TTL_SECONDS` → `expiresIn: 3600` → the presigner test fails (both the options literal and `X-Amz-Expires`).
2. Presign whenever `deps.snapshotUrl` exists, key or not → "never presigns a key that does not exist" fails.
3. Let the presign rejection propagate → "shows the visit without a link when presigning fails" fails.
4. Drop `?? null` on `snapshotStatus` → the legacy-visit test fails (`undefined` is not `null`, and the output schema rejects it — record which).
5. Put the CSP `_meta` on every widget → the calendar assertion fails.
6. Remove the `DOOR_TYPES` filter → the recent-events test fails (a flood event appears as "Motion at the Water Heater").
7. Remove `shot.onload` → the widget test fails.

- [ ] **Step 6: Commit**

```bash
git add apps/mcp-server FRICTION-LOG.md pnpm-lock.yaml
git commit -m "feat(mcp-server): get_visit returns the doorbell photo, its sentence and the match note; the visit widget declares the snapshot origin (closes FL-030, FL-051)"
```

---
### Task 16: The simulator — a server-held push socket, injected turns, and the events route

Spec §7 on the display side. The Next.js **server** holds the WebSocket, authorised with the Cognito token it already fetches for MCP; the browser sees pushes only through a new SSE route on the same origin, behind the same checks as every other route; a push becomes an agent turn with a note naming the record, and the model narrates only what the MCP server returns.

**Files:**
- Modify: `apps/simulator/package.json` (dependency `ws` `^8.18.0`; devDependency `@types/ws` `^8.18.1`), `.env.example` (root; the simulator section)
- Modify: `apps/simulator/src/shared/events.ts`, `src/server/env.ts`, `src/server/http.ts`, `src/server/session.ts`, `src/server/prompt.ts`, `src/lib/transcript.ts`, `src/lib/useAgentTurn.ts`, `src/app/page.tsx`, `src/components/Disclosure.tsx`, `src/components/DebugDrawer.tsx`
- Create: `apps/simulator/src/server/push.ts`, `src/server/hub.ts`, `src/server/injector.ts`, `src/lib/useHomeEvents.ts`, `src/app/api/agent/events/route.ts`
- Test: create `apps/simulator/test/push.test.ts`, `test/injector.test.ts`, `test/events-route.test.ts`, `test/home-events.test.tsx`; modify `test/routes.test.ts` (fixture + two cases), `test/transcript.test.ts`, `test/prompt.test.ts`, `test/frame.test.tsx`

**Interfaces:**
- Consumes: `PushPayload`, `parsePushPayload` (core, Task 2); the WebSocket `$connect` contract and keepalive (Task 12); `upstream.token` / `upstream.invalidateToken` (`src/server/credentials.ts`, unchanged).
- Produces:

```ts
// src/shared/events.ts
export type PushStatus = 'off' | 'connecting' | 'connected' | 'reconnecting';
// TurnEvent gains:
//   | { type: 'push-received'; cardType: 'visit.arrived' | 'alert.raised'; id: string }
//   | { type: 'push-status'; status: PushStatus }

// src/server/env.ts — SimulatorEnv gains: pushUrl: string | undefined   (HOMELEDGER_PUSH_URL)

// src/server/push.ts
export const PUSH_BACKOFF_MS: readonly number[]; // [1000, 2000, 5000, 10000, 30000]
export const PUSH_KEEPALIVE_MS = 300_000;
export const KEEPALIVE_MESSAGE = '{"action":"ping"}';
export interface SocketLike { on(...): unknown; send(data: string): void; close(): void }
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;
export interface Timers { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; setInterval(fn: () => void, ms: number): unknown; clearInterval(handle: unknown): void }
export interface PushClient { start(): void; stop(): void; status(): PushStatus }
export function createPushClient(opts: { url: string; token: () => Promise<string>; invalidateToken?: () => void; onPush: (p: PushPayload) => void; onStatus: (s: PushStatus) => void; connect?: SocketFactory; timers?: Timers; log?: (message: string) => void }): PushClient;

// src/server/hub.ts
export interface EventHub { subscribe(listener: (event: TurnEvent) => void): () => void; publish(event: TurnEvent): void; size(): number }
export function createEventHub(): EventHub;

// src/server/injector.ts
export function homeEventNote(pushes: readonly PushPayload[]): string;
export type TurnStarter = (text: string, emit: (event: TurnEvent) => void) => { done: Promise<void> } | 'busy';
export interface Injector { enqueue(p: PushPayload): void; idle(): Promise<void>; pending(): number }
export function createInjector(deps: { activeTurn: () => { settled: Promise<void> } | undefined; startTurn: TurnStarter; publish: (e: TurnEvent) => void; log?: (m: string) => void }): Injector;

// src/server/http.ts
export interface StartedTurn { turnId: string; done: Promise<void>; abort: AbortController }
export function startTurn(conversation: Conversation, text: string, emit: (event: TurnEvent) => void): StartedTurn | 'busy';
export const EVENTS_KEEPALIVE_MS = 25_000;
export function handleEvents(conversation: Conversation, request: Request, opts?: { keepaliveMs?: number }): Response;
// handleDebug's body gains: push: PushStatus

// src/server/session.ts — Conversation gains: hub: EventHub; push: { status: () => PushStatus }

// src/server/prompt.ts
export const HOME_EVENT_PREFIX = '[Home event]';

// src/lib/transcript.ts — AgentState gains pushStatus: PushStatus (INITIAL 'off'); export const PUSH_NOTICE_TEXT
// src/lib/useAgentTurn.ts — AgentTurn gains apply(next: (previous: AgentState) => AgentState): void
// src/lib/useHomeEvents.ts
export function useHomeEvents(apply: AgentTurn['apply'], EventSourceImpl?: typeof EventSource): void;
```

**Turn discipline (spec §7).** A push that arrives mid-turn waits for the running turn to settle; pushes that arrive while waiting are coalesced into **one** injected turn whose note names every record. A push that repeats an id already queued is dropped. The injected turn goes through the same `startTurn` that `POST /api/agent/turn` uses, so the one-turn-at-a-time lock (`Conversation.activeTurn`, final review I3) covers both: while an injected turn runs, a typed question gets the existing 409, and the composer is already disabled because the hub delivered `turn-started`.

**What reaches the browser.** Only the injected turns' events and the push notices/status go through the hub — a turn the browser itself asked for keeps streaming on its own POST response, as today, so nothing is delivered twice.

**Why `ws`.** Node's global `WebSocket` takes a URL and protocols only; it cannot send `Authorization`. Putting the bearer in the query string would log it (Task 12). `ws` is imported only under `src/server/`, which the no-client-secrets guard already confines (Plan 3 Task 2).

- [ ] **Step 1: Write the failing server tests**

Create `apps/simulator/test/push.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { KEEPALIVE_MESSAGE, PUSH_BACKOFF_MS, PUSH_KEEPALIVE_MS, createPushClient, type SocketLike, type Timers } from '../src/server/push.js';
import { readSimulatorEnv, SimulatorConfigError } from '../src/server/env.js';
import type { PushStatus } from '../src/shared/events.js';

class FakeSocket extends EventEmitter implements SocketLike {
  sent: string[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>
  ) {
    super();
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.emit('close');
  }
}

function manualTimers() {
  const timeouts: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const intervals: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const t = { fn, ms, live: true };
      timeouts.push(t);
      return t;
    },
    clearTimeout: h => void ((h as { live: boolean }).live = false),
    setInterval: (fn, ms) => {
      const t = { fn, ms, live: true };
      intervals.push(t);
      return t;
    },
    clearInterval: h => void ((h as { live: boolean }).live = false)
  };
  return { timers, timeouts, intervals };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(tokens: string[] = ['tok-1', 'tok-2', 'tok-3']) {
  const sockets: FakeSocket[] = [];
  const statuses: PushStatus[] = [];
  const pushes: unknown[] = [];
  const t = manualTimers();
  const invalidateToken = vi.fn();
  let n = 0;
  const client = createPushClient({
    url: 'wss://wsapi01.execute-api.us-east-1.amazonaws.com/demo',
    token: async () => tokens[Math.min(n++, tokens.length - 1)]!,
    invalidateToken,
    onPush: p => pushes.push(p),
    onStatus: s => statuses.push(s),
    connect: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
    timers: t.timers
  });
  return { client, sockets, statuses, pushes, invalidateToken, ...t };
}

describe('push client (spec §7: the server holds the socket)', () => {
  it('connects with the bearer in the Authorization header and hands on valid pushes only', async () => {
    const x = setup();
    x.client.start();
    await flush();
    expect(x.sockets[0]!.headers).toEqual({ authorization: 'Bearer tok-1' });
    x.sockets[0]!.emit('open');
    expect(x.statuses).toEqual(['connecting', 'connected']);
    x.sockets[0]!.emit('message', Buffer.from('{"cardType":"visit.arrived","id":"visit_abcdefghijklmnop"}'));
    x.sockets[0]!.emit('message', Buffer.from('{"cardType":"visit.arrived","id":"visit_abcdefghijklmnop","description":"x"}'));
    x.sockets[0]!.emit('message', Buffer.from('not json'));
    expect(x.pushes).toEqual([{ cardType: 'visit.arrived', id: 'visit_abcdefghijklmnop' }]);
  });

  it('pings every five minutes so API Gateway does not close it as idle', async () => {
    const x = setup();
    x.client.start();
    await flush();
    x.sockets[0]!.emit('open');
    expect(PUSH_KEEPALIVE_MS).toBe(300_000);
    expect(x.intervals.map(i => i.ms)).toEqual([300_000]);
    x.intervals[0]!.fn();
    expect(x.sockets[0]!.sent).toEqual([KEEPALIVE_MESSAGE]);
    expect(KEEPALIVE_MESSAGE).toBe('{"action":"ping"}');
  });

  it('reconnects with backoff and a fresh token when the socket closes, and resets the backoff once connected', async () => {
    const x = setup();
    x.client.start();
    await flush();
    x.sockets[0]!.emit('open');
    x.sockets[0]!.emit('close');
    expect(x.statuses.at(-1)).toBe('reconnecting');
    expect(x.intervals[0]!.live).toBe(false);
    expect(x.timeouts.map(t => t.ms)).toEqual([PUSH_BACKOFF_MS[0]]);
    x.timeouts[0]!.fn();
    await flush();
    expect(x.sockets[1]!.headers).toEqual({ authorization: 'Bearer tok-2' });
    x.sockets[1]!.emit('open');
    x.sockets[1]!.emit('close');
    expect(x.timeouts.map(t => t.ms)).toEqual([1_000, 1_000]);
    expect([...PUSH_BACKOFF_MS]).toEqual([1_000, 2_000, 5_000, 10_000, 30_000]);
  });

  it('grows the backoff while the connection keeps failing, and invalidates the token when a handshake is refused', async () => {
    const x = setup();
    x.client.start();
    await flush();
    x.sockets[0]!.emit('close'); // refused before open, e.g. 403 from the authorizer
    x.timeouts[0]!.fn();
    await flush();
    x.sockets[1]!.emit('close');
    expect(x.timeouts.map(t => t.ms)).toEqual([1_000, 2_000]);
    expect(x.invalidateToken).toHaveBeenCalledTimes(2);
  });

  it('stops for good: closes the socket, cancels the retry, and reports off', async () => {
    const x = setup();
    x.client.start();
    await flush();
    x.sockets[0]!.emit('open');
    x.client.stop();
    expect(x.sockets[0]!.closed).toBe(true);
    expect(x.client.status()).toBe('off');
    expect(x.timeouts.filter(t => t.live)).toEqual([]);
    expect(x.sockets).toHaveLength(1);
  });
});

describe('HOMELEDGER_PUSH_URL', () => {
  const base = { ANTHROPIC_API_KEY: 'k' };
  it('is optional, accepts wss://, and refuses anything that is not a WebSocket URL', () => {
    expect(readSimulatorEnv(base).pushUrl).toBeUndefined();
    expect(readSimulatorEnv({ ...base, HOMELEDGER_PUSH_URL: 'wss://wsapi01.execute-api.us-east-1.amazonaws.com/demo' }).pushUrl).toBe('wss://wsapi01.execute-api.us-east-1.amazonaws.com/demo');
    expect(readSimulatorEnv({ ...base, HOMELEDGER_PUSH_URL: 'ws://127.0.0.1:3900' }).pushUrl).toBe('ws://127.0.0.1:3900');
    expect(() => readSimulatorEnv({ ...base, HOMELEDGER_PUSH_URL: 'https://wsapi01.execute-api.us-east-1.amazonaws.com/demo' })).toThrow(SimulatorConfigError);
    expect(() => readSimulatorEnv({ ...base, HOMELEDGER_PUSH_URL: 'ws://example.com/demo' })).toThrow(SimulatorConfigError);
  });
});
```

Create `apps/simulator/test/injector.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createInjector, homeEventNote } from '../src/server/injector.js';
import type { TurnEvent } from '../src/shared/events.js';

const visit = { cardType: 'visit.arrived' as const, id: 'visit_abcdefghijklmnop' };
const alert = { cardType: 'alert.raised' as const, id: 'alert_abcdefghijklmnop' };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => (resolve = r));
  return { promise, resolve };
}

function harness() {
  let active: { settled: Promise<void> } | undefined;
  const texts: string[] = [];
  const published: TurnEvent[] = [];
  const injector = createInjector({
    activeTurn: () => active,
    startTurn: (text, emit) => {
      if (active) return 'busy';
      texts.push(text);
      emit({ type: 'turn-started', turnId: `t${texts.length}` });
      emit({ type: 'turn-finished', turnId: `t${texts.length}` });
      return { done: Promise.resolve() };
    },
    publish: e => published.push(e)
  });
  return {
    injector,
    texts,
    published,
    setActive: (a: { settled: Promise<void> } | undefined) => {
      active = a;
    }
  };
}

describe('homeEventNote', () => {
  it('names each record and the tool that reads it, one line per push', () => {
    expect(homeEventNote([visit, alert])).toBe(
      '[Home event] The doorbell matched a booked visit, visit_abcdefghijklmnop. Call get_visit with that id and tell the household what it returned.\n' +
        '[Home event] An alert was raised, alert_abcdefghijklmnop. Call recent_events and tell the household what it returned about that alert.'
    );
  });
});

describe('injected turns (spec §7 turn discipline)', () => {
  it('runs one turn for a push when nothing is running, after announcing the push', async () => {
    const h = harness();
    h.injector.enqueue(visit);
    await h.injector.idle();
    expect(h.texts).toEqual([homeEventNote([visit])]);
    expect(h.published.map(e => e.type)).toEqual(['push-received', 'turn-started', 'turn-finished']);
    expect(h.published[0]).toEqual({ type: 'push-received', cardType: 'visit.arrived', id: 'visit_abcdefghijklmnop' });
  });

  it('waits for a running turn to settle, then coalesces everything that arrived into one turn', async () => {
    const h = harness();
    const running = deferred();
    h.setActive({ settled: running.promise });
    h.injector.enqueue(visit);
    h.injector.enqueue(alert);
    h.injector.enqueue(visit); // a repeat while queued
    await new Promise(r => setImmediate(r));
    expect(h.texts).toEqual([]);
    expect(h.injector.pending()).toBe(2);
    h.setActive(undefined);
    running.resolve();
    await h.injector.idle();
    expect(h.texts).toEqual([homeEventNote([visit, alert])]);
  });

  it('keeps going when a push lands just as the drain finishes', async () => {
    const h = harness();
    h.injector.enqueue(visit);
    const first = h.injector.idle();
    h.injector.enqueue(alert);
    await first;
    await h.injector.idle();
    expect(h.texts.join('\n')).toContain('alert_abcdefghijklmnop');
  });
});
```

Create `apps/simulator/test/events-route.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { handleEvents } from '../src/server/http.js';
import { createEventHub } from '../src/server/hub.js';
import type { Conversation } from '../src/server/session.js';
import { createSseDecoder, type TurnEvent } from '../src/shared/events.js';

function convo(allowOrigin?: string) {
  const hub = createEventHub();
  return { hub, conversation: { env: { allowOrigin }, hub, push: { status: () => 'connected' as const } } as unknown as Conversation };
}

async function readEvents(response: Response, count: number): Promise<TurnEvent[]> {
  const reader = response.body!.getReader();
  const decode = createSseDecoder();
  const out: TurnEvent[] = [];
  while (out.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(...decode(new TextDecoder().decode(value)));
  }
  await reader.cancel();
  return out;
}

describe('GET /api/agent/events', () => {
  it('refuses a foreign origin, like every other route', () => {
    const { conversation } = convo();
    const r = handleEvents(conversation, new Request('http://127.0.0.1:3000/api/agent/events', { headers: { host: '127.0.0.1:3000', origin: 'https://evil.example' } }));
    expect(r.status).toBe(403);
  });

  it('streams the push status first, then whatever the hub publishes, as unbuffered SSE', async () => {
    const { conversation, hub } = convo();
    const r = handleEvents(conversation, new Request('http://127.0.0.1:3000/api/agent/events', { headers: { host: '127.0.0.1:3000' } }));
    expect(r.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(r.headers.get('x-accel-buffering')).toBe('no');
    const reading = readEvents(r, 2);
    await new Promise(resolve => setImmediate(resolve));
    hub.publish({ type: 'push-received', cardType: 'visit.arrived', id: 'visit_abcdefghijklmnop' });
    expect(await reading).toEqual([
      { type: 'push-status', status: 'connected' },
      { type: 'push-received', cardType: 'visit.arrived', id: 'visit_abcdefghijklmnop' }
    ]);
  });

  it('unsubscribes when the browser goes away', async () => {
    const { conversation, hub } = convo();
    const r = handleEvents(conversation, new Request('http://127.0.0.1:3000/api/agent/events', { headers: { host: '127.0.0.1:3000' } }));
    await readEvents(r, 1);
    expect(hub.size()).toBe(0);
  });
});
```

In `apps/simulator/test/routes.test.ts`:
- Import `createEventHub` from `../src/server/hub.js` and `startTurn` alongside the other `http.js` imports.
- In `conversation()`, add `pushUrl: undefined` to the `env` literal, and `hub: createEventHub(), push: { status: () => 'off' as const },` to the returned object.
- Add, inside `describe('GET /api/debug', …)`:

```ts
  it('reports the push channel’s status', async () => {
    const convo = await conversation(scriptedModel([]));
    const body = (await (await import('../src/server/http.js')).handleDebug(convo, debugRequest()).json()) as { push: unknown };
    expect(body.push).toBe('off');
  });
```

- Add a new `describe`:

```ts
describe('an injected turn shares the one-turn lock', () => {
  it('runs through startTurn, streams to the given sink, and turns a typed question away with 409 until it settles', async () => {
    let release!: () => void;
    const convo = await conversation(heldModel(new Promise<void>(r => (release = r))));
    const seen: string[] = [];
    const started = startTurn(convo, '[Home event] The doorbell matched a booked visit, visit_abcdefghijklmnop.', e => seen.push(e.type));
    expect(started).not.toBe('busy');
    expect(startTurn(convo, 'again', () => {})).toBe('busy');
    expect((await handleTurn(convo, post({ text: 'hello' }))).status).toBe(409);
    release();
    await (started as { done: Promise<void> }).done;
    expect(seen[0]).toBe('turn-started');
    expect(seen.at(-1)).toBe('turn-finished');
    expect(convo.activeTurn).toBeUndefined();
  });
});
```

(`heldModel` is the file's existing helper for a model whose reply waits on a promise; if its signature differs, adapt the call — the property under test is that the lock is held while the model is waiting.)

- [ ] **Step 2: Write the failing client tests**

In `apps/simulator/test/transcript.test.ts`, add:

```ts
describe('home events', () => {
  it('shows a pushed record as an informational notice, in words that claim nothing about safety', () => {
    const state = run([{ type: 'push-received', cardType: 'alert.raised', id: 'alert_abcdefghijklmnop' }]);
    expect(state.entries).toEqual([{ kind: 'notice', id: expect.stringMatching(/^notice_\d+$/), text: 'Home event: an alert was raised.', tone: 'info' }]);
    expect(PUSH_NOTICE_TEXT).toEqual({ 'visit.arrived': 'Home event: the doorbell matched a booked visit.', 'alert.raised': 'Home event: an alert was raised.' });
  });

  it('tracks the push channel’s status without touching the transcript', () => {
    const state = run([{ type: 'push-status', status: 'reconnecting' }]);
    expect(state.pushStatus).toBe('reconnecting');
    expect(state.entries).toEqual([]);
    expect(INITIAL_STATE.pushStatus).toBe('off');
  });
});
```

(`run` is the file's existing fold-events-from-INITIAL_STATE helper; import `PUSH_NOTICE_TEXT` and `INITIAL_STATE` from `../src/lib/transcript.js`.)

Create `apps/simulator/test/home-events.test.tsx`:

```tsx
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { INITIAL_STATE, type AgentState } from '../src/lib/transcript.js';
import { useHomeEvents } from '../src/lib/useHomeEvents.js';

class FakeEventSource {
  static last: FakeEventSource | undefined;
  onmessage: ((m: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  close() {
    this.closed = true;
  }
}

function Probe({ onState }: { onState: (s: AgentState) => void }) {
  const [state, setState] = useState<AgentState>(INITIAL_STATE);
  useHomeEvents(next => setState(next), FakeEventSource as unknown as typeof EventSource);
  onState(state);
  return null;
}

describe('useHomeEvents', () => {
  it('listens on /api/agent/events and folds what arrives into the transcript state', () => {
    let latest = INITIAL_STATE;
    const view = render(<Probe onState={s => (latest = s)} />);
    expect(FakeEventSource.last!.url).toBe('/api/agent/events');
    act(() => FakeEventSource.last!.onmessage!({ data: JSON.stringify({ type: 'push-status', status: 'connected' }) }));
    act(() => FakeEventSource.last!.onmessage!({ data: '{not json' }));
    expect(latest.pushStatus).toBe('connected');
    view.unmount();
    expect(FakeEventSource.last!.closed).toBe(true);
  });
});
```

In `apps/simulator/test/prompt.test.ts`, add:

```ts
  it('tells the model a home event comes from the house, and to say only what the tool returned', () => {
    expect(buildSystemPrompt({ today: '2026-10-06', toolNames: ['get_visit'] })).toContain(
      '- A message that starts with "[Home event]" comes from the house, not from the person. Call the tool it names, then say in one or two sentences what that tool returned and nothing it did not return. Speak about the visit, the property and maintenance only; never tell anyone they are safe.'
    );
  });
```

In `apps/simulator/test/frame.test.tsx`, add beside the existing `DISCLOSURE_TEXT` assertions:

```ts
    expect(DISCLOSURE_TEXT).toContain('Home events arrive over this simulation’s own push channel');
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm install && pnpm --filter @homeledger/core build && pnpm --filter @homeledger/simulator test`
Expected: FAIL on every new file and case; the pre-existing cases may also fail to compile until `Conversation` and `SimulatorEnv` gain their fields.

- [ ] **Step 4: Implement the shared vocabulary and the server pieces**

In `apps/simulator/src/shared/events.ts`, add above `TurnEvent`:

```ts
/** The push channel's state, shown in the debug drawer (spec §7 "Reconnect"). */
export type PushStatus = 'off' | 'connecting' | 'connected' | 'reconnecting';
```

and two members at the end of the `TurnEvent` union:

```ts
  | { type: 'push-received'; cardType: 'visit.arrived' | 'alert.raised'; id: string }
  | { type: 'push-status'; status: PushStatus };
```

In `apps/simulator/src/server/env.ts`, add `pushUrl: string | undefined;` to `SimulatorEnv`, this function above `readSimulatorEnv`:

```ts
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Optional: unset means no push channel. wss:// always; ws:// only to loopback, for a local stand-in. */
function pushUrlFrom(source: NodeJS.ProcessEnv): string | undefined {
  const raw = source.HOMELEDGER_PUSH_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SimulatorConfigError(`HOMELEDGER_PUSH_URL must be a wss:// URL; got ${JSON.stringify(raw)}.`);
  }
  if (url.protocol === 'wss:' || (url.protocol === 'ws:' && LOOPBACK.has(url.hostname))) return raw;
  throw new SimulatorConfigError(`HOMELEDGER_PUSH_URL must be a wss:// URL (ws:// is accepted only for localhost); got ${JSON.stringify(raw)}.`);
}
```

and `pushUrl: pushUrlFrom(source)` in the returned object.

Create `apps/simulator/src/server/hub.ts`:

```ts
import type { TurnEvent } from '../shared/events.js';

/** Fan-out from the process that holds the conversation to every open /api/agent/events stream. */
export interface EventHub {
  subscribe(listener: (event: TurnEvent) => void): () => void;
  publish(event: TurnEvent): void;
  size(): number;
}

export function createEventHub(): EventHub {
  const listeners = new Set<(event: TurnEvent) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    publish(event) {
      for (const listener of [...listeners]) listener(event);
    },
    size: () => listeners.size
  };
}
```

Create `apps/simulator/src/server/push.ts`:

```ts
import WebSocket from 'ws';
import { parsePushPayload, type PushPayload } from '@homeledger/core';
import type { PushStatus } from '../shared/events.js';

export const PUSH_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];
/** API Gateway closes a WebSocket idle for ten minutes; a ping every five keeps it (Plan 4 Task 12). */
export const PUSH_KEEPALIVE_MS = 300_000;
export const KEEPALIVE_MESSAGE = '{"action":"ping"}';

export interface SocketLike {
  on(event: 'open' | 'close', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const REAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>)
};

export interface PushClient {
  start(): void;
  stop(): void;
  status(): PushStatus;
}

/**
 * The simulator server's end of spec §7's push channel. The bearer travels in
 * the Authorization header of the upgrade (Node's global WebSocket cannot set
 * one; a query-string token would be logged). A connection refused before it
 * opens invalidates the cached token, so an expired token is not retried
 * forever. Missed pushes stay readable through recent_events (spec §7).
 */
export function createPushClient(opts: {
  url: string;
  token: () => Promise<string>;
  invalidateToken?: () => void;
  onPush: (p: PushPayload) => void;
  onStatus: (s: PushStatus) => void;
  connect?: SocketFactory;
  timers?: Timers;
  log?: (message: string) => void;
}): PushClient {
  const connect: SocketFactory = opts.connect ?? ((url, headers) => new WebSocket(url, { headers }) as unknown as SocketLike);
  const timers = opts.timers ?? REAL_TIMERS;
  const log = opts.log ?? (() => {});
  let state: PushStatus = 'off';
  let stopped = true;
  let attempt = 0;
  let socket: SocketLike | null = null;
  let keepalive: unknown = null;
  let retry: unknown = null;

  const setStatus = (next: PushStatus) => {
    if (state === next) return;
    state = next;
    opts.onStatus(next);
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    setStatus('reconnecting');
    const delay = PUSH_BACKOFF_MS[Math.min(attempt, PUSH_BACKOFF_MS.length - 1)]!;
    attempt += 1;
    retry = timers.setTimeout(() => {
      retry = null;
      void open();
    }, delay);
  };

  const open = async (): Promise<void> => {
    if (stopped) return;
    let token: string;
    try {
      token = await opts.token();
    } catch (err) {
      log(`push: no token (${err instanceof Error ? err.message : String(err)})`);
      scheduleReconnect();
      return;
    }
    if (stopped) return;
    let opened = false;
    const s = connect(opts.url, { authorization: `Bearer ${token}` });
    socket = s;
    s.on('open', () => {
      opened = true;
      attempt = 0;
      setStatus('connected');
      keepalive = timers.setInterval(() => s.send(KEEPALIVE_MESSAGE), PUSH_KEEPALIVE_MS);
    });
    s.on('message', data => {
      const payload = parsePushPayload(String(data));
      if (payload) opts.onPush(payload);
      else log('push: ignored a message that is not a push pointer');
    });
    s.on('error', err => log(`push: ${err.message}`));
    s.on('close', () => {
      if (keepalive !== null) {
        timers.clearInterval(keepalive);
        keepalive = null;
      }
      if (socket === s) socket = null;
      if (!opened) opts.invalidateToken?.();
      scheduleReconnect();
    });
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      setStatus('connecting');
      void open();
    },
    stop() {
      stopped = true;
      if (retry !== null) timers.clearTimeout(retry);
      retry = null;
      if (keepalive !== null) timers.clearInterval(keepalive);
      keepalive = null;
      const s = socket;
      socket = null;
      s?.close();
      setStatus('off');
    },
    status: () => state
  };
}
```

In `apps/simulator/src/server/prompt.ts`, export the prefix and add the rule. Above `buildSystemPrompt`:

```ts
/** What an injected turn's note starts with (spec §7). The injector writes it; the prompt tells the model what it means. */
export const HOME_EVENT_PREFIX = '[Home event]';
```

and, as the last line of the "Rules you do not bend" group (before the tool-gated entries):

```ts
    `- A message that starts with "${HOME_EVENT_PREFIX}" comes from the house, not from the person. Call the tool it names, then say in one or two sentences what that tool returned and nothing it did not return. Speak about the visit, the property and maintenance only; never tell anyone they are safe.`,
```

Create `apps/simulator/src/server/injector.ts`:

```ts
import type { PushPayload } from '@homeledger/core';
import type { TurnEvent } from '../shared/events.js';
import { HOME_EVENT_PREFIX } from './prompt.js';

/** The injected turn's text: which record, and which tool reads it. The model reads the record over MCP; the push never carries it (spec §7, FL-039). */
export function homeEventNote(pushes: readonly PushPayload[]): string {
  return pushes
    .map(p =>
      p.cardType === 'visit.arrived'
        ? `${HOME_EVENT_PREFIX} The doorbell matched a booked visit, ${p.id}. Call get_visit with that id and tell the household what it returned.`
        : `${HOME_EVENT_PREFIX} An alert was raised, ${p.id}. Call recent_events and tell the household what it returned about that alert.`
    )
    .join('\n');
}

export type TurnStarter = (text: string, emit: (event: TurnEvent) => void) => { done: Promise<void> } | 'busy';

export interface Injector {
  enqueue(p: PushPayload): void;
  idle(): Promise<void>;
  pending(): number;
}

/**
 * Spec §7 turn discipline: a push waits for the running turn; pushes that
 * arrive while waiting are coalesced into one turn; a repeat of a queued id is
 * dropped. Every push is announced on the hub at once, so the display shows
 * it even while it waits.
 */
export function createInjector(deps: {
  activeTurn: () => { settled: Promise<void> } | undefined;
  startTurn: TurnStarter;
  publish: (e: TurnEvent) => void;
  log?: (m: string) => void;
}): Injector {
  const queue: PushPayload[] = [];
  let draining: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const running = deps.activeTurn();
      if (running) {
        await running.settled;
        continue;
      }
      const batch = queue.splice(0);
      const started = deps.startTurn(homeEventNote(batch), deps.publish);
      if (started === 'busy') {
        queue.unshift(...batch);
        await (deps.activeTurn()?.settled ?? new Promise(resolve => setTimeout(resolve, 50)));
        continue;
      }
      await started.done;
    }
  };

  const kick = () => {
    if (draining) return;
    draining = drain()
      .catch(err => deps.log?.(`push: injected turn failed (${err instanceof Error ? err.message : String(err)})`))
      .finally(() => {
        draining = null;
        if (queue.length > 0) kick();
      });
  };

  return {
    enqueue(p) {
      deps.publish({ type: 'push-received', cardType: p.cardType, id: p.id });
      if (!queue.some(q => q.id === p.id)) queue.push(p);
      kick();
    },
    idle: async () => {
      while (draining) await draining;
    },
    pending: () => queue.length
  };
}
```

- [ ] **Step 5: Extract `startTurn`, add `handleEvents`, extend the debug body**

In `apps/simulator/src/server/http.ts`:

Add `StartedTurn` and `startTurn` above `handleTurn`, lifting the body that today sits between the `activeTurn` claim and the `finally` — keep its comments:

```ts
export interface StartedTurn {
  turnId: string;
  done: Promise<void>;
  abort: AbortController;
}

/**
 * Claims the one turn slot and runs a turn, emitting into `emit`. Used by the
 * POST route (emit = the response stream) and by the push injector (emit =
 * the event hub), so both are held to one turn at a time (final review I3).
 * Checked and claimed with no `await` in between.
 */
export function startTurn(conversation: Conversation, text: string, emit: (event: TurnEvent) => void): StartedTurn | 'busy' {
  if (conversation.activeTurn) return 'busy';
  const turnId = randomUUID();
  const abort = new AbortController();
  let settle!: () => void;
  const active = { turnId, controller: abort, settled: new Promise<void>(resolve => (settle = resolve)) };
  conversation.activeTurn = active;
  const done = runTurn(
    {
      model: conversation.model,
      mcp: conversation.mcp,
      registry: conversation.registry,
      router: conversation.router,
      tools: conversation.tools,
      emit,
      now: conversation.now,
      today: todayInZone(new Date(conversation.now()).toISOString(), conversation.timeZone),
      maxRounds: conversation.env.maxRounds,
      elicitationTimeoutMs: conversation.env.elicitationTimeoutMs,
      signal: abort.signal
    },
    turnId,
    conversation.history,
    text
  )
    .then(next => {
      if (!abort.signal.aborted) conversation.history = next;
    })
    .catch((error: unknown) => {
      emit({ type: 'turn-failed', message: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      if (conversation.activeTurn === active) conversation.activeTurn = undefined;
      settle();
    });
  return { turnId, done, abort };
}
```

Replace `handleTurn`'s body from `// One turn at a time …` to the returned `Response` with:

```ts
  // One turn at a time, checked here and claimed inside the stream's start(),
  // which the ReadableStream constructor runs synchronously - so there is
  // still no await between the check and the claim.
  if (conversation.activeTurn) return json({ ok: false, reason: 'turn-running', message: TURN_RUNNING_MESSAGE }, 409);
  const encoder = new TextEncoder();
  let started!: StartedTurn;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const emit = (event: TurnEvent): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(encodeSse(event)));
        } catch {
          open = false;
        }
      };
      const claimed = startTurn(conversation, text, emit);
      if (claimed === 'busy') throw new Error('unreachable: the slot was checked free with no await since');
      started = claimed;
      void claimed.done.finally(() => {
        open = false;
        try {
          controller.close();
        } catch {
          /* already closed by a cancel */
        }
      });
    },
    cancel() {
      started.abort.abort(new Error(BROWSER_CLOSED_REASON));
      conversation.registry.close(started.turnId, 'the browser closed the turn before answering');
    }
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-homeledger-turn-id': started.turnId
    }
  });
```

Add after `handleDebug`:

```ts
export const EVENTS_KEEPALIVE_MS = 25_000;

/**
 * GET /api/agent/events: the browser's only view of pushes (spec §7). Same
 * origin and loopback checks as every route; no credential crosses it. The
 * first event is the push channel's current status, so a page that opens
 * late still shows the right state.
 */
export function handleEvents(conversation: Conversation, request: Request, opts: { keepaliveMs?: number } = {}): Response {
  const forbidden = checkOrigin(request, conversation.env.allowOrigin);
  if (forbidden) return forbidden;
  const encoder = new TextEncoder();
  let unsubscribe = (): void => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: TurnEvent): void => {
        try {
          controller.enqueue(encoder.encode(encodeSse(event)));
        } catch {
          unsubscribe();
        }
      };
      send({ type: 'push-status', status: conversation.push.status() });
      unsubscribe = conversation.hub.subscribe(send);
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          /* closed */
        }
      }, opts.keepaliveMs ?? EVENTS_KEEPALIVE_MS);
    },
    cancel() {
      unsubscribe();
      if (timer) clearInterval(timer);
    }
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' }
  });
}
```

In `handleDebug`'s JSON, after `scripted: conversation.scripted,` add `push: conversation.push.status(),`.

Create `apps/simulator/src/app/api/agent/events/route.ts`:

```ts
import { handleEvents } from '@/server/http';
import { getConversation } from '@/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    return handleEvents(await getConversation(), request);
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, reason: 'unavailable', message: error instanceof Error ? error.message : String(error) }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
}
```

- [ ] **Step 6: Start the push client with the conversation**

In `apps/simulator/src/server/session.ts`:
- Import `createEventHub, type EventHub` from `./hub.js`, `createInjector` from `./injector.js`, `createPushClient` from `./push.js`, `startTurn` from `./http.js`, and `type PushStatus` from `../shared/events.js`.
- Add to `Conversation`:

```ts
  /** Fan-out to /api/agent/events (spec §7). */
  hub: EventHub;
  /** The push channel's state for the debug drawer; 'off' when HOMELEDGER_PUSH_URL is unset. */
  push: { status: () => PushStatus };
```

- In `build()`, replace the final `return { … }` with a `const conversation: Conversation = { …same fields…, hub: createEventHub(), push: { status: () => 'off' } };`, then:

```ts
  if (env.pushUrl) {
    const injector = createInjector({
      activeTurn: () => conversation.activeTurn,
      startTurn: (text, emit) => startTurn(conversation, text, emit),
      publish: event => conversation.hub.publish(event),
      log: say
    });
    const client = createPushClient({
      url: env.pushUrl,
      token: upstream.token,
      invalidateToken: upstream.invalidateToken,
      onPush: payload => injector.enqueue(payload),
      onStatus: status => conversation.hub.publish({ type: 'push-status', status }),
      log: say
    });
    conversation.push = { status: () => client.status() };
    client.start();
  }
  return conversation;
```

`session.ts` now imports a value from `http.ts`, which imports only the `Conversation` **type** from `session.ts`; with `verbatimModuleSyntax` that type import is erased, so there is no runtime cycle. Confirm with `grep -n "from './session" src/server/http.ts` that it reads `import type`.

- [ ] **Step 7: The client side**

In `apps/simulator/src/lib/transcript.ts`:
- Import `type PushStatus` from `../shared/events.js`.
- Add `pushStatus: PushStatus;` to `AgentState`, and `pushStatus: 'off'` to `INITIAL_STATE`.
- Add:

```ts
/** What a pushed record looks like in the transcript before the agent speaks. Property and appointments only - no safety claim (spec §7). */
export const PUSH_NOTICE_TEXT: Record<'visit.arrived' | 'alert.raised', string> = {
  'visit.arrived': 'Home event: the doorbell matched a booked visit.',
  'alert.raised': 'Home event: an alert was raised.'
};
```

- Add two cases to `reduceTurn` before `default`:

```ts
    case 'push-received':
      return { ...state, entries: [...state.entries, { kind: 'notice', id: nextId('notice'), text: PUSH_NOTICE_TEXT[event.cardType], tone: 'info' }] };

    case 'push-status':
      return { ...state, pushStatus: event.status };
```

- Any test or component that builds an `AgentState` literal rather than spreading `INITIAL_STATE` needs `pushStatus: 'off'`; find them with `grep -rn "turnId: null" apps/simulator/src apps/simulator/test`.

In `apps/simulator/src/lib/useAgentTurn.ts`, add to `AgentTurn`:

```ts
  /** Folds events that did not come from this page's own POST - the home-event stream - into the same state. */
  apply(next: (previous: AgentState) => AgentState): void;
```

and include `apply` in the returned object.

Create `apps/simulator/src/lib/useHomeEvents.ts`:

```ts
'use client';

import { useEffect } from 'react';
import type { TurnEvent } from '../shared/events.js';
import { reduceTurn, type AgentState } from './transcript.js';

/** Subscribes to /api/agent/events for the life of the page. EventSource reconnects on its own; the server resends the push status on every open. */
export function useHomeEvents(
  apply: (next: (previous: AgentState) => AgentState) => void,
  EventSourceImpl: typeof EventSource | undefined = typeof EventSource === 'undefined' ? undefined : EventSource
): void {
  useEffect(() => {
    if (!EventSourceImpl) return;
    const source = new EventSourceImpl('/api/agent/events');
    source.onmessage = message => {
      let event: TurnEvent;
      try {
        event = JSON.parse(String(message.data)) as TurnEvent;
      } catch {
        return;
      }
      apply(previous => reduceTurn(previous, event));
    };
    return () => source.close();
  }, [apply, EventSourceImpl]);
}
```

In `apps/simulator/src/app/page.tsx`, import `useHomeEvents` and call `useHomeEvents(turn.apply);` directly after `const turn = useAgentTurn();`.

In `apps/simulator/src/components/Disclosure.tsx`, change `DISCLOSURE_TEXT` to:

```ts
export const DISCLOSURE_TEXT =
  'Simulation — a smart-display surface built from published design guidance. It drives HomeLedger’s own MCP server for real; the service-provider marketplace is sample data and no booking leaves this system. Home events arrive over this simulation’s own push channel.';
```

In `apps/simulator/src/components/DebugDrawer.tsx`, add `push: PushStatus;` to `DebugSnapshot` (import the type from `../shared/events.js`) and render one more row beside the rebuild count: `<dt>Push channel</dt><dd data-testid="debug-push">{snapshot.push}</dd>` — follow the drawer's existing markup for its other rows exactly (element names and classes), which this snippet only sketches.

Add to the root `.env.example`, in the `# --- apps/simulator ---` section:

```bash
# WebSocket URL of the push channel (Terraform output push_websocket_url).
# Unset: no push; the display still works, it just never hears the house.
HOMELEDGER_PUSH_URL=
```

- [ ] **Step 8: Run everything the simulator's CI runs**

Run: `pnpm --filter @homeledger/simulator typecheck && pnpm --filter @homeledger/simulator test && pnpm --filter @homeledger/simulator build`
Expected: PASS. The no-client-secrets guard passes unchanged (nothing under `src/lib` or `src/app` imports `src/server`, and `ws` is server-only). The wordmark guard passes (no new file names a product).

- [ ] **Step 9: Mutation check**

Apply each, run `pnpm --filter @homeledger/simulator test`, record, revert:
1. Put the bearer in the URL (`${opts.url}?token=${token}`) and pass empty headers → the header assertion fails.
2. Skip `invalidateToken` on a refused handshake → the backoff/invalidate test fails.
3. Reset `attempt` on every close rather than on open → "grows the backoff" fails (`[1000, 1000]`).
4. In the injector, start a turn per push instead of coalescing → the coalesce test fails (two texts).
5. In the injector, drop the id de-duplication → `pending()` is 3 and the note repeats the visit; the test fails.
6. Remove `kick()` from the `finally` → "keeps going when a push lands just as the drain finishes" fails.
7. In `handleEvents`, skip the initial `push-status` → the events-route test fails.
8. In `handleEvents`, drop `unsubscribe()` from `cancel` → the unsubscribe test fails (`size()` is 1).
9. In `startTurn`, clear `activeTurn` before `runTurn` settles → the shared-lock test's 409 assertion fails.
10. Remove the `[Home event]` rule from the prompt → the prompt test fails.

- [ ] **Step 10: Commit**

```bash
git add apps/simulator .env.example pnpm-lock.yaml
git commit -m "feat(simulator): a server-held push socket, injected turns under the one-turn lock, and /api/agent/events for the browser"
```

---
### Task 17: The signed synthetic webhook, the runbook, the README

Spec §8 "Smoke" and "Live checklist", under R11.

**Files:**
- Modify: `scripts/smoke.ts`, `scripts/test/smoke.test.ts`, `.github/workflows/smoke.yml`
- Modify: `docs/RUNBOOK.md` (new §4.7, and one row in §2 "Status at a glance" if that table lists subsystems), `README.md` (new "Ring" section after "The simulator")

**Interfaces:**
- Consumes: root outputs `ring_webhook_url` (Task 14); the secret `demo-homeledger/ring/hmac-key`.
- Produces: `export const SMOKE_EVENT_TYPE = 'homeledger_smoke'`, `export function buildSmokeWebhook(requestId: string, nowMs: number): string`, `export function signSmokeBody(body: string, hmacKey: string): string`, `export async function ringWebhookSmoke(opts: { url: string; hmacKey: string; fetch?: typeof fetch; now?: () => number }): Promise<void>` in `scripts/smoke.ts`; the smoke prints `RING SMOKE OK` or `RING_SMOKE_SKIPPED (no RING_WEBHOOK_URL)` before `SMOKE OK`.

**What the three requests prove, with no Ring access and no DynamoDB read.** A signed delivery answering `{status: "accepted"}` means the signature verified against the real key, the event was claimed in the table, and EventBridge accepted it — the handler only says `accepted` after `PutEvents` reported zero failed entries (Task 8). The same delivery again answering `{status: "duplicate"}` means the claim was marked published. A tampered signature answering 401 means verification is on. `homeledger_smoke` matches no rule, so nothing downstream acts on it.

**Why the smoke signs with its own four lines, not `@homeledger/events`.** `scripts` would otherwise depend on a package with no `exports` map, built for Lambda. The duplication is pinned by the same independently computed literal Task 5 uses, so the two cannot drift apart unnoticed.

- [ ] **Step 1: Write the failing unit tests**

Append to `scripts/test/smoke.test.ts` (add the four names to its import from `../smoke.js`):

```ts
describe('the signed synthetic webhook (spec §8 smoke, Plan 4 R11)', () => {
  it('signs exactly as Ring does: sha256=<hex> over the body bytes', () => {
    // Same body, key and digest as apps/events/test/hmac.test.ts (computed with openssl).
    expect(signSmokeBody('{"meta":{"request_id":"req-1"},"data":{"type":"button_press"}}', 'test-hmac-signing-key')).toBe(
      'sha256=c35d7d8c23cdcfc8758c7ad20d4af807220957d80140ee8bedee54226d19f9a5'
    );
  });

  it('builds a v1.1 envelope of a type no rule routes', () => {
    expect(SMOKE_EVENT_TYPE).toBe('homeledger_smoke');
    expect(JSON.parse(buildSmokeWebhook('smoke-1', 1791292800000))).toEqual({
      meta: { version: '1.1', time: '2026-10-06T13:20:00.000Z', request_id: 'smoke-1', account_id: 'homeledger-smoke' },
      data: { id: 'smoke-1', type: 'homeledger_smoke', attributes: { source: 'homeledger-smoke', source_type: 'devices', timestamp: 1791292800000 } }
    });
  });

  it('expects accepted, then duplicate, then 401 for a tampered signature', async () => {
    const answers = [
      new Response('{"status":"accepted"}', { status: 200 }),
      new Response('{"status":"duplicate"}', { status: 200 }),
      new Response('{"error":"signature"}', { status: 401 })
    ];
    const seen: Array<{ signature: string | null; body: string }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push({ signature: new Headers(init.headers).get('x-signature'), body: String(init.body) });
      return answers.shift()!;
    }) as typeof fetch;
    await ringWebhookSmoke({ url: 'https://x/ring/webhook', hmacKey: 'k', fetch: fetchImpl, now: () => 1791292800000 });
    expect(seen[0]!.body).toBe(seen[1]!.body);
    expect(seen[0]!.signature).toBe(signSmokeBody(seen[0]!.body, 'k'));
    expect(seen[2]!.signature).not.toBe(seen[0]!.signature);
  });

  it('fails loudly when the ingest does not answer as it must', async () => {
    const fetchImpl = (async () => new Response('{"status":"accepted"}', { status: 200 })) as unknown as typeof fetch;
    await expect(ringWebhookSmoke({ url: 'https://x/ring/webhook', hmacKey: 'k', fetch: fetchImpl, now: () => 1 })).rejects.toThrow(
      'Ring webhook smoke: a redelivery answered 200 {"status":"accepted"}, expected 200 {"status":"duplicate"}'
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @homeledger/scripts test`
Expected: FAIL — the four names are not exported.

- [ ] **Step 3: Implement**

In `scripts/smoke.ts`, add `import { createHmac } from 'node:crypto';` to the imports and, above the `isEntrypoint` line:

```ts
/** No EventBridge rule matches this type, so a smoke delivery is stored and published and then acted on by nothing (Plan 4 R11). */
export const SMOKE_EVENT_TYPE = 'homeledger_smoke';

export function buildSmokeWebhook(requestId: string, nowMs: number): string {
  return JSON.stringify({
    meta: { version: '1.1', time: new Date(nowMs).toISOString(), request_id: requestId, account_id: 'homeledger-smoke' },
    data: { id: requestId, type: SMOKE_EVENT_TYPE, attributes: { source: 'homeledger-smoke', source_type: 'devices', timestamp: nowMs } }
  });
}

/** Ring's webhook signature (spec §12.2): lowercase hex of HMAC-SHA256 keyed by the key's UTF-8 bytes. */
export function signSmokeBody(body: string, hmacKey: string): string {
  return `sha256=${createHmac('sha256', Buffer.from(hmacKey, 'utf8')).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

export async function ringWebhookSmoke(opts: { url: string; hmacKey: string; fetch?: typeof fetch; now?: () => number }): Promise<void> {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const body = buildSmokeWebhook(`smoke-${now()}`, now());
  const send = async (signature: string) => {
    const res = await f(opts.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': signature }, body });
    return { status: res.status, text: (await res.text()).trim() };
  };
  const check = (label: string, got: { status: number; text: string }, status: number, text: string | null) => {
    if (got.status !== status || (text !== null && got.text !== text))
      throw new Error(`Ring webhook smoke: ${label} answered ${got.status} ${got.text}, expected ${status}${text === null ? '' : ` ${text}`}`);
  };
  const signature = signSmokeBody(body, opts.hmacKey);
  check('a signed delivery', await send(signature), 200, '{"status":"accepted"}');
  check('a redelivery', await send(signature), 200, '{"status":"duplicate"}');
  check('a tampered signature', await send(`${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`), 401, null);
}
```

Inside the `if (isEntrypoint) { … }` block, immediately before `console.log('SMOKE OK');`:

```ts
  const ringWebhookUrl = process.env.RING_WEBHOOK_URL?.trim();
  if (ringWebhookUrl) {
    await ringWebhookSmoke({ url: ringWebhookUrl, hmacKey: need('RING_HMAC_KEY') });
    console.log('RING SMOKE OK');
  } else {
    console.log('RING_SMOKE_SKIPPED (no RING_WEBHOOK_URL)');
  }
```

In `.github/workflows/smoke.yml`'s "Export Terraform outputs" step, read the webhook URL tolerantly (like the knowledge-base outputs, and for the same reason) and add it to the `$GITHUB_ENV` block:

```bash
          RING_WEBHOOK_URL=$(terraform output -raw ring_webhook_url 2>/dev/null || true)
```

```bash
            echo "RING_WEBHOOK_URL=$RING_WEBHOOK_URL"
```

Add a step after it that reads the HMAC key into a step output only — never `$GITHUB_ENV` — and masks it:

```yaml
      - name: Read the Ring HMAC key for the signed synthetic webhook
        id: ring-key
        if: env.RING_WEBHOOK_URL != ''
        run: |
          KEY=$(aws secretsmanager get-secret-value --secret-id demo-homeledger/ring/hmac-key --query SecretString --output text)
          echo "::add-mask::$KEY"
          echo "hmac_key=$KEY" >> "$GITHUB_OUTPUT"
```

and give the "Run smoke" step `RING_HMAC_KEY: ${{ steps.ring-key.outputs.hmac_key }}` in its `env:`, plus `&& grep -Eq '^(RING SMOKE OK|RING_SMOKE_SKIPPED)' smoke.log` at the end of its `run:` line.

- [ ] **Step 4: Write the runbook section**

Add to `docs/RUNBOOK.md`, after §4.6, a section `### 4.7 Ring: link the account, then check the pipeline`, containing, in this order:

1. **What it needs:** the deployed stack (Plan 4 merged and applied), the owner's Ring account with the doorbell and the Flood & Freeze sensor set up (steps below), and the four owner secrets. No local AWS work beyond `describe-secret` checks.
2. **Owner set-up in the Ring app** (from the owner walkthrough of 2026-09-27): doorbell added to the location that holds the Ring plan; Control Center → Video Encryption shows no TAKE or end-to-end encryption (re-check before recording and before judging opens on 2026-11-09 — TAKE is rolling out as a default; **never** "Reset Account Encryption"); Sidewalk on; the Flood & Freeze sensor added as a Sidewalk device and named for where it sits.
3. **Ring Developer Portal:** paste `terraform output -raw ring_token_exchange_url`, `ring_account_link_url` and `ring_webhook_url` (read from the latest deploy's summary) into the app's Token Exchange URL, Account Link URL and Webhook URL; select the Cameras & Doorbells scope and the Sensors → Flood/Freeze scope.
4. **Link:** on the app's Test page, authorise the Ring account; the browser lands on HomeLedger's sign-in page; enter the household passphrase; the page answers "Ring is linked to HomeLedger. Found N devices: …". Then `aws dynamodb query --table-name demo-homeledger --key-condition-expression "PK = :p AND begins_with(SK, :s)" --expression-attribute-values '{":p":{"S":"HH#hh_harlow"},":s":{"S":"DEVICE#"}}' --profile homeledger-admin --region us-east-1` shows the doorbell and the sensor (`kind: sensor` for the latter).
5. **The simulator:** add `HOMELEDGER_PUSH_URL=$(terraform output -raw push_websocket_url)` to `apps/simulator/.env.local`; the debug drawer's "Push channel" reads `connected`.
6. **The live checklist** (spec §8), each with its expected result — record what actually happens in the FRICTION-LOG entry Task 18 files:
   1. Link and check the `DEVICE#` rows (step 4).
   2. With a visit booked in a window around now: press the doorbell. Expect, within about a minute, the notice "Home event: the doorbell matched a booked visit.", then the agent's sentence, the visit card with the photo and one sentence, and `snapshotLatencyMs` on the visit row.
   3. With no visit booked around now: press the doorbell. Expect nothing on the display, and an `EVENT#` row for the press.
   4. **Put Ring professional monitoring in test mode first.** Trip the Flood & Freeze sensor (a damp cloth across its probes). Expect the notice "Home event: an alert was raised.", the agent reading the alert from `recent_events`, and the water heater's inspection due today in `maintenance_due`. Note which arrived first, the webhook or the reconciliation poll (the function logs say `source`).
   5. Check again that Video Encryption shows no TAKE, before recording and before judging opens.
7. **Troubleshooting**, three lines: a 401 in the webhook logs means the HMAC key secret does not match the portal's key; "Ring has not finished its part yet" on the sign-in page means the Token Exchange URL was not called — check the portal URL and the token-exchange logs; a card that says the photo could not be fetched, with `lastRefusal` in the correlator's log, names Ring's refusal code.

Close the section with: "Nothing above is a result until Task 18 of Plan 4 records it."

- [ ] **Step 5: Write the README section**

Add to `README.md`, after "The simulator", a section `## Ring` of at most twelve lines: what happens on a doorbell press and a sensor trip (one sentence each); that photos are stored byte-for-byte with Ring's watermark and described without identifying anyone; that push is the simulator's own channel, not an assistant capability; that one Ring account links to one household; a pointer to RUNBOOK §4.7. In "The simulator" section's list of browser-facing routes, add `/api/agent/events`.

- [ ] **Step 6: Run the checks**

Run: `pnpm --filter @homeledger/scripts test && pnpm --filter @homeledger/scripts typecheck && pnpm format`
Expected: PASS.

- [ ] **Step 7: Mutation check**

Apply each, run `pnpm --filter @homeledger/scripts test`, record, revert:
1. `digest('hex')` → `digest('base64')` in `signSmokeBody` → the literal test fails.
2. Send a freshly built body (new request id) for the redelivery → the `seen[0].body === seen[1].body` assertion fails.
3. Skip the duplicate check → "fails loudly when the ingest does not answer as it must" fails.

- [ ] **Step 8: Commit**

```bash
git add scripts .github/workflows/smoke.yml docs/RUNBOOK.md README.md
git commit -m "feat(smoke): a signed synthetic Ring webhook; docs: the Ring runbook and README sections"
```

---

### Task 18: Live verification with the owner (controller-run, not dispatched)

This task is run by the controller, with the owner present for the Ring steps. It writes no product code. It is the only place in Plan 4 where anything talks to Ring, and the only evidence for the rows marked Unverified in the spec amendment. It follows the finishing step: the branch is merged and deployed before it starts.

**Files:**
- Modify: `FRICTION-LOG.md` (FL-059: the live run, in the manner of FL-055)
- Create: `apps/events/test/fixtures/ring/live-*.json` (captured payloads) and, for any that differs from Ring's documented shape, a failing decoder test first, then the fix
- Modify: `docs/submission/devpost-story.md` (only what the run verified moves above PENDING)

- [ ] **Step 1: Deploy and read the outputs.** After the merge, `deploy.yml` applies. From the run's summary, record the four URLs. Run the smoke workflow (`gh workflow run smoke.yml`) and confirm `RING SMOKE OK` in its log.
- [ ] **Step 2: Owner portal set-up.** The owner pastes the three URLs into the Ring Developer Portal and selects the scopes (RUNBOOK §4.7 step 3). Screenshot for the FL entry.
- [ ] **Step 3: Link.** The owner authorises on the Test page and signs in with the passphrase. The controller checks the `DEVICE#` rows (RUNBOOK §4.7 step 4) and the token-exchange and link logs (`aws logs tail /aws/lambda/demo-homeledger-link --since 15m --profile homeledger-admin --region us-east-1`). **Record the token lifetime** Ring granted (spec §3 "confirmed on the first link"): the token-exchange log line `held-unclaimed` carries `expiresAt`; subtract the line's own timestamp. Never read the secret's value.
- [ ] **Step 4: Doorbell, with and without a visit.** RUNBOOK §4.7 checklist items 2 and 3. Record `snapshotStatus`, `snapshotLatencyMs`, `attempts` and `lastRefusal` from the correlator's log line, and whether the description followed the content rule. If the status is `encrypted` or `error`, record the refusal code: it settles R4.
- [ ] **Step 5: Sensor.** Owner confirms monitoring test mode. Checklist item 4. Record which path saw the trip first (`source` in the sensor-rules and sensor-poller logs) — the spec's "deciding test", now a confirmation (R2).
- [ ] **Step 6: Capture.** From CloudWatch Logs Insights on `/aws/lambda/demo-homeledger-webhook`, `fields @timestamp, type, body | filter outcome = "accepted"`, save one real body per event type seen as `apps/events/test/fixtures/ring/live-<type>.json` in the Task 1 wrapper shape (`source: "live capture, <date>"`). Add a decoder test per file. Any that fails is a real difference from Ring's documentation: fix the decoder under that failing test and file it in FL-059.
- [ ] **Step 7: TAKE check.** Checklist item 5, with a screenshot.
- [ ] **Step 8: Record.** File FL-059 with Expected / Actual per checklist item, in FL-055's manner — results, not intentions. Move up in `docs/submission/devpost-story.md` only the sentences this run verified; anything that did not happen stays below PENDING with the reason. Commit on a branch and open a PR.

---
## Self-review

**1. Spec coverage.** Spec sections as amended (§12).

| Spec | Requirement | Task |
|---|---|---|
| §1 | Linking and token refresh | 9 (link, token exchange), 11 (refresh) |
| §1 | Signed webhook receiver | 5 (signature, decoder), 8 (ingest) |
| §1 | Device sync | 9 |
| §1 | Doorbell-to-visit correlation with snapshot and description | 4 (matching, sentences), 6 (snapshot fetch), 7 (describer), 10 (correlator) |
| §1 | Live sensor rules for Flood & Freeze | 4 (rule table), 11 (both adapters) |
| §1 | Push to the simulator | 12 (server side), 16 (display side) |
| §1 out of scope | Contact sensors on fixtures only | 4 and 11 test contact through the rule table; no live contact path is claimed |
| §2 | `apps/events`, Node 22 ARM64, bundled per function | 5 (`build.mjs`), 13 (`nodejs22.x`, `arm64`) |
| §2 | HTTP API, WebSocket API, custom bus with rules, a DLQ per Lambda, Scheduler, S3 prefix, per-function IAM | 13; "per Lambda" is per **asynchronous** Lambda — the three HTTP-invoked functions answer their caller synchronously and have nothing to dead-letter |
| §2 | Terraform through GitHub Actions only | 13, 14 (validate/test locally; plan/apply in `deploy.yml`) |
| §3 | Owner-created secrets referenced by data sources; per-function `GetSecretValue` on exactly its row | 13 (`secret_grants` test), 14 (data sources) |
| §3 / §12.1 | Ring-driven linking: Token Exchange URL, Account Link URL with sign-in, nonce, POST then PATCH | 9 |
| §3 | Map the one account to `hh_harlow` | 13/14 (`HOUSEHOLD_ID`), 9 (`accountIdentifierFor`) |
| §3 | Refresh with a one-hour margin; failed refresh writes an alert, never silent | 11 |
| §3 | Token lifetime confirmed on first link | 18 Step 3 |
| §4 / §12.2–12.3 | Verify (hex, raw bytes, constant time) → 401; decode totally; dedupe with the published flag; publish; 500 for Ring to retry; DLQ → ALERT# | 5, 3 (`claimEvent`), 8, 11 (DLQ alerter), 13 |
| §4 | Unknown types stored and routed nowhere | 8 (stored and published), 13 (no rule matches) |
| §5 | Trigger: press, or human motion from a doorbell | 10, 13 (rule pattern) |
| §5 | Match ±30 min, nearest start; none → keep EVENT#, push nothing | 4, 10 |
| §5 | Conditional arrive, idempotent across press and motion | 3, 10 |
| §5 / §12.5 | Snapshot around the webhook timestamp, retry ~60 s, record latency, store byte-for-byte | 6, 7, 10 |
| §5 | Five statuses, each a plain sentence | 2, 4, 15 |
| §5 | Claude vision via the Anthropic API, one sentence, nobody identified; failure → photo without sentence | 7, 10 |
| §5 | The card says the match came from HomeLedger, not the image | 4 (`arrivalMatchNote`), 15 (widget) |
| §5 | Visit gains the new fields; `get_visit` returns them plus a 10-minute presigned URL; widget renders; runtime gains `s3:GetObject` on `snapshots/*` only | 2 (R5), 15, 14 |
| §5 | Push `visit.arrived` | 10 (R9: once, after the snapshot) |
| §6 / §12.4 | `SensorChanged` on transitions only; webhook and polling adapters; 429 backs off and is logged | 4, 11 |
| §6 | The deciding test | 18 Step 5, as a confirmation (R2) |
| §6 | Rule table, pure, exhaustive; `SENSORS_ENABLED` flag; push `alert.raised`; alerts via `recent_events` and `maintenance_due` | 4, 11, 13, 15 |
| §7 | WebSocket with `$connect`/`$disconnect`, `CONN#` rows with TTL | 12, 13, 14 (TTL), 3 |
| §7 | Authorizer validates the Cognito client-credentials JWT | 12 |
| §7 | The Next.js server holds the socket; browser via SSE `/api/agent/events` behind the same checks; no credential in client code | 16 |
| §7 | Pointer payload; agent reads over MCP and narrates only what the server returned | 2 (contract), 16 (injector, prompt rule) |
| §7 | Mid-turn push waits; coalesced | 16 |
| §7 | Reconnect with backoff; status in the drawer; missed pushes via `recent_events` | 16 |
| §7 | Disclosure names the push channel | 16 |
| §7 | Sensor cards make no life-safety claim | 4 (content-rule test), 11 (message test), 16 (notice text, prompt rule) |
| §8 | Mutation-check rule | every task's mutation step |
| §8 | HMAC, decoder, dedupe, correlation window (edges, zone, overlap, already arrived), five snapshot outcomes, rule table, both adapters with no-change and 429, authorizer, push waits, push → turn → card | 5, 5, 3/8, 4, 6/10, 4, 11, 12, 16, 16 |
| §8 | Real payloads captured before handlers are written | R10: Ring's documented payloads (1) before any handler; live captures in 18 |
| §8 | Native `terraform test` for the new modules | 13, 14 |
| §8 | Signed synthetic webhook smoke | 17 (R11: dispatch-only) |
| §8 | Live checklist, RUNBOOK section, FL entry | 17 (§4.7), 18 (FL-059) |
| §9 | Owner prerequisites | Header table; RUNBOOK §4.7 |
| §11 | Fallbacks disclosed | `encrypted` sentence (4), description failure (10), sensor never appearing → the poller finds nothing and the FL entry says so (18) |

**Deliberately not covered:** the Playground as a fixture source (it cannot deliver webhooks; R10), partner-initiated OAuth (invitation only), unlinking from HomeLedger's side (`DELETE` is refused for one-way apps).

**2. Placeholder scan.** No "TBD", "implement later", "add appropriate error handling" or "similar to Task N" (checked with `grep -nE 'TBD|TODO|implement later|appropriate error|similar to Task'` over this file). Four places depend on an installed API the plan could not read and say so, each with the exact thing to check and what not to do: the MCP Apps `_meta.ui.csp` placement (Task 15, Step 3), ARN-shaped arguments the Terraform mocks may still reject (Task 13, Step 3 — add an override, never loosen an assertion), the drawer's row markup (Task 16, Step 7), and `heldModel`'s signature in the simulator's routes test (Task 16, Step 1).

**3. Type and name consistency.**
- `PushPayload` is defined once (core, Task 2) and used by the push Lambda (Task 12) and the simulator (Task 16); the `detail` the correlator and sensor rules publish is `pushPayload(...)` itself, so the push handler's `PushPayloadSchema.parse(event.detail)` reads exactly what they wrote.
- `RingEventDetail` (Task 10) is the webhook's `detail` (Task 8), field for field: `requestId, accountId, eventId, type, subType, deviceId, deviceName, at`.
- `VisitSnapshot` (Task 3) is what `recordVisitSnapshot` takes and what the correlator (Task 10) builds.
- `TokenRecord.status` is `'unclaimed' | 'linked' | 'lapsed'` in Task 7, written `unclaimed` by Task 9's token exchange, `linked` by Task 9's link, `lapsed` by Task 11's refresh.
- The environment names are one table (Task 8) and one Terraform map (Task 13, `function_env`); every `requireEnv` call in Tasks 8–12 names an entry in both.
- The EventBridge `source` strings `ring.webhook` / `homeledger.events` are `RING_SOURCE` / `HOMELEDGER_SOURCE` in code (Task 7) and literals in the rule patterns (Task 13), pinned on the Terraform side by the doorbell- and push-rule tests.
- Snapshot keys are built only by `snapshotKeyFor` (Task 7); the runtime's read grant (`snapshots/*`, Task 14) and the correlator's write grant (Task 13) both name the same prefix.

**4. Where this plan knows it is thin.**
- **Reachable only live (Task 18):** Ring actually delivering webhooks to a staging app; the token lifetime; the press-to-image latency; how TAKE content really presents (R4); whether the sensor's first report comes by webhook or by poll.
- **Surviving mutations, recorded rather than hidden:** Task 11 mutation 2 (the order of the device-state write — correct by reading, unreachable by a unit test because it matters only for a crash between writes); Task 11 mutation 9 (the DLQ alerter must not publish — guarded by having no publisher dependency at all).
- **Checked by reading, not by test:** the MCP runtime's two new environment variables (Task 14 — root tests cannot read a module's inputs), and `session.ts` starting the push client (Task 16 — like Plan 3's `build()` wiring, the only test that could reach it would need the deployed stack).
- **Terraform mocks** prove wiring and policy shape, not that AWS accepts the configuration. The PR's `plan` job is the first real check; the first `apply` is the second.

## What comes after Plan 4

The ambient home screen Plan 3 deferred now has its reason to exist: pushes arrive, so a screen that shows the next visit and any open alert is a view over data that changes. The deciding sensor evidence from Task 18 may retire one adapter; retiring it is a one-line schedule change, not a rebuild. Hosting the simulator remains its own security decision.
