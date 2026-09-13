# HomeLedger — Design Spec

**Date:** 2026-09-13
**Status:** Approved for planning
**Target:** Build, Ship, Shape: Amazon Developer Hackathon (Devpost). Primary track Alexa+, secondary track Ring, mini-challenge AWS Builder. Submission deadline 2026-10-23 12:00 PT.

## 1. Goal

HomeLedger is the household's operating record, exposed to an assistant through an MCP server: appliances, warranties, manuals, maintenance schedule, service visits, and events from the front door and home sensors. The hackathon deliverable is a working Streamable HTTP MCP server on Amazon Bedrock AgentCore Runtime, a simulated Alexa+ web experience that drives it with a Strands agent on Bedrock, and a Ring integration that turns doorbell and sensor events into proactive, contextual moments.

Demo household: the author's real home and appliances, with fictional household names.

### Success criteria

1. Judges can watch a sub-3-minute video in which every exchange is real: tool calls hit the deployed server, the manual answer cites a real PDF page, the booking pauses for user input through MCP elicitation, and a physical Ring doorbell press produces the "your plumber is at the door" card.
2. The server serves both protocol generations: a 2026-07-28 client through multi round-trip requests and a 2025-era client (Strands TypeScript, MCP Inspector, Alexa+'s documented client) through initialize, `Mcp-Session-Id`, and server-initiated elicitation.
3. Every tool responds in under 3 seconds, never exposes JSON in voice text, and never offers more than five options, matching Alexa+'s published functional requirements.
4. The repo is public, MIT-licensed, reproducible from Terraform, and carries a friction log from day one.

### Non-goals (v1)

- Real Alexa+ integration. The MCP Toolkit is a private preview and the organizer confirmed entrants cannot call Alexa+. The simulator is the interaction layer.
- Multi-household or per-user account linking. One household keyed by an environment variable; partition keys already carry the household ID so this extends later.
- The MCP tasks extension. No TypeScript runtime exists for it yet.
- Voice input and output. Optional Web Speech in the simulator, never required.
- Sampling and roots. Deprecated in the 2026-07-28 revision.
- Facial recognition on Ring snapshots. Policy-constrained; not needed for the demo.

## 2. Constraints that shaped the design

| Constraint                                                                                                                                                                                                                | Source                            | Consequence                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Hackathon minimum MCP spec 2025-11-25; must be "imported and actually called at runtime"                                                                                                                                  | Devpost rules                     | Real server, real calls, tests prove it                                                          |
| Alexa+ client speaks the 2025-era handshake (`initialize`, `protocolVersion: 2025-03-26`), Streamable HTTP only, tools refreshed on deploy, <500 ms round trip target                                                     | Alexa+ MCP Toolkit docs           | Session-capable transport; stable tool signatures; fast tools                                    |
| MCP 2026-07-28 removed sessions and `initialize`, replaced server-initiated elicitation with multi round-trip requests (MRTR)                                                                                             | MCP changelog                     | Handlers written once in MRTR style; legacy shim serves old clients                              |
| TypeScript SDK v2 implements 2026-07-28, serves legacy clients, and its input-required legacy shim delivers real elicitation over a session                                                                               | ts.sdk.modelcontextprotocol.io/v2 | SDK v2 with sessions enabled                                                                     |
| AgentCore Runtime: container on `0.0.0.0:8000/mcp`, ARM64, stateful mode required for pre-2026 elicitation, microVM affinity on `Mcp-Session-Id`, idle timeout configurable 60 s to 8 h                                   | AgentCore docs                    | Stateful mode, idle timeout 30 min, Terraform-managed runtime                                    |
| Strands TypeScript SDK peer-depends on `@modelcontextprotocol/sdk` ^1.25 (v1 client) with an `elicitationCallback`; no progress notification support                                                                      | npm registry, Strands docs        | Strands is a legacy client; elicitation works through the shim; progress tapped at the transport |
| Ring Partner API is read-mostly: webhooks for button press and human/vehicle motion, snapshot from recordings only (no on-demand), watermark on media, sensors and dynamic scopes in early access, no community libraries | Ring developer docs, rules        | Event-driven design, snapshot after event, sensors behind a flag                                 |
| Alexa+ visual foundations: 768×480 base canvas, 1.667 scale on Echo Show 8/15, dark card #14181E, light card #FFFFFF, widgets as single HTML files with `hostContext`                                                     | Alexa+ design guide               | Simulator frame and widget format                                                                |

## 3. System overview

One pnpm monorepo. TypeScript everywhere. Node 22.

| Package             | Responsibility                                                                                           | Runtime                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `packages/core`     | Domain types, Zod schemas, DynamoDB repository, Knowledge Base retrieval, Ring API client, ID generation | Library                                           |
| `apps/mcp-server`   | MCP server: tools, resources, prompts, widgets; SDK v2 with sessions; ARM64 container                    | AgentCore Runtime, stateful, Cognito JWT          |
| `apps/events`       | Ring account-link endpoint, webhook receiver, EventBridge handlers, WebSocket push                       | API Gateway HTTP + WebSocket, Lambda, EventBridge |
| `apps/simulator`    | Next.js Echo Show simulation, Strands agent, MCP Apps host, proactive channel, debug drawer              | Amplify Hosting                                   |
| `skills/homeledger` | Agent Skill (`SKILL.md`): seed, run, test, deploy                                                        | Claude Code, Kiro                                 |
| `infra`             | Terraform root and modules; GitHub Actions                                                               | AWS, one account, one region                      |

### Data flows

**Conversational.** Simulator agent → Streamable HTTP with bearer JWT → AgentCore invocation URL → microVM running the server → DynamoDB / Knowledge Base → result with `content[0].text` (spoken text), `structuredContent` (typed), and a `ui://` resource reference → simulator renders text, inline data, or widget.

**Proactive.** Ring webhook → API Gateway → Lambda (HMAC verify, 200 within 5 s, dedupe, publish) → EventBridge → handler (correlate, snapshot, vision description, write) → WebSocket push `{cardType, recordId}` → simulator injects a system turn → agent calls `get_visit` or `recent_events` → server answers → card. Push is the simulator's channel, not MCP. The write-up states this; Alexa+ add-ons have no push today and the organizer confirmed demos are not bound by documented capabilities.

## 4. MCP server

### 4.1 Protocol posture

- `@modelcontextprotocol/server` v2, one Express route at `/mcp`, listening on `0.0.0.0:8000`. One server factory registers tools, resources, prompts, and widgets; two transport branches share it.
- Modern branch: requests carrying per-request `_meta` go to the stateless `createMcpHandler`, which instantiates the factory per request and returns MRTR `input_required` results natively.
- Legacy branch: requests detected by `isLegacyRequest` (an `initialize` call or an `Mcp-Session-Id` header) go to a per-session `NodeStreamableHTTPServerTransport` created with `sessionIdGenerator`, kept in an in-process session map keyed by session ID. Legacy clients therefore get `initialize` → `Mcp-Session-Id` → session-bound requests, and the SDK's input-required legacy shim pushes real `elicitation/create` requests over that session. Elicitation reaches legacy clients at protocol 2025-06-18 or later; a 2025-03-26 client (Alexa+'s documented handshake) gets tools, resources, and prompts without elicitation, which is the correct behavior for that revision.
- The in-process session map is safe because AgentCore pins a session to one microVM; sessions expire with the microVM's idle timeout. The week-1 spike validates this branch end to end on AgentCore before anything else is built on it.
- Origin validation on. Host validation configured for the AgentCore invocation host.
- Handlers use the write-once MRTR pattern: check `inputResponses` first, request only what is missing via `inputRequired.elicit()`, carry cross-round state in a signed `requestState` (`createRequestStateCodec`). The default legacy shim converts these into real `elicitation/create` requests for 2025-era clients.
- Progress notifications during `book_service`'s availability phase.
- No sampling, no roots, no logging feature. Structured logs to stdout → CloudWatch.
- Every tool declares `outputSchema`; `content[0].text` is spoken text; `structuredContent` matches the schema; `_meta.ui.resourceUri` points at a widget where one exists.
- Tools are returned in a fixed order. Tool names and descriptions are treated as frozen after the first deploy, mirroring Alexa+'s certification rule.

### 4.2 Tools

| Tool              | Input                                        | Output (structured)                                                     | Widget                       | Notes                                                                                                                                             |
| ----------------- | -------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_appliances` | `room?`, `category?`                         | `appliances[] {id, name, brand, model, room, category, warrantyStatus}` | `ui://homeledger/appliances` | Text names at most five; full list in structured content                                                                                          |
| `get_appliance`   | `applianceId`                                | appliance + `lastMaintenance[]`, `nextDue[]`, `manual {docId, title}`   | `ui://homeledger/appliance`  |                                                                                                                                                   |
| `ask_manual`      | `question`, `applianceId?`                   | `passages[] {text, docTitle, page, score}` (max 3)                      | none                         | Retrieval only; the client model composes the answer, as Alexa+ would. Metadata filter on `applianceId` when present                              |
| `maintenance_due` | `horizonDays?` (default 30)                  | `items[] {applianceId, applianceName, taskType, dueAt, overdue}`        | `ui://homeledger/calendar`   | GSI query on `nextDueAt`                                                                                                                          |
| `log_maintenance` | `applianceId`, `taskType`, `date?`, `notes?` | `{logged, nextDueAt}`                                                   | none                         | Recomputes `MAINT#` item                                                                                                                          |
| `book_service`    | `applianceId`, `issue`, `preferredWindow?`   | `{visitId, provider, windowStart, windowEnd, status}`                   | `ui://homeledger/visit`      | Elicits provider (≤5 enum), window (enum), confirm (boolean). Progress 0→3 during a simulated availability check (bounded delay). Writes `VISIT#` |
| `recent_events`   | `sinceHours?` (default 24)                   | `events[] {type, deviceName, at, summary, visitId?}`                    | none                         | Visits and alerts                                                                                                                                 |
| `get_visit`       | `visitId`                                    | visit + `snapshotUrl?` (presigned, short TTL) + `description?`          | `ui://homeledger/visit`      |                                                                                                                                                   |

Provider options for `book_service` come from a static, clearly labeled sample marketplace in `packages/core` (per category, three to five providers). This is the one simulated data source and the README says so.

### 4.3 Resources and prompts

- Resources: `homeledger://household`, `homeledger://appliances`, `homeledger://maintenance/schedule` (read-only JSON), plus `ui://homeledger/{appliances,appliance,calendar,visit}` (single-file HTML widgets).
- Prompt: `seasonal-checklist` (`season` argument) returning a checklist template built from the household's appliances.

### 4.4 Widgets (MCP Apps)

Single HTML files with inlined CSS and a small script using the MCP Apps app-bridge to receive `hostContext` and data and to call tools (for example "log as done" from the calendar). Sized for a 768×480 base canvas, theme-aware from `hostContext.theme`, no external assets.

### 4.5 Auth and tenancy

- AgentCore custom JWT authorizer with a Cognito user pool as issuer. Cognito resource server `homeledger` with scope `homeledger/mcp`; one app client using client credentials. The simulator obtains and caches the token server-side.
- Household ID from `HOUSEHOLD_ID` environment variable on the runtime. Every repository call takes the household ID; nothing reads it from the request.
- Ring credentials, webhook secret, and Cognito client secret live in Secrets Manager. No secret is read from the repo or from tool input.

### 4.6 Timing budget

Tool handler p95 under 1.5 s locally, under 3 s through AgentCore cold. Knowledge Base retrieval is the only external call on the hot path; results are cached per question for 10 minutes.

## 5. Data model

DynamoDB table `homeledger`, on-demand capacity, `PK = HH#<householdId>`.

| SK                          | Attributes                                                                                                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APPL#<applId>`             | `name, brand, model, serial, room, category, purchasedAt, warrantyUntil, manualDocId, templates[] {taskType, intervalDays}`                                                                                                             |
| `MAINT#<applId>#<taskType>` | `lastDoneAt, nextDueAt, notes`; `GSI1PK = HH#<hh>#DUE`, `GSI1SK = nextDueAt`                                                                                                                                                            |
| `LOG#<ts>#<id>`             | `applianceId, taskType, doneAt, notes`                                                                                                                                                                                                  |
| `DOC#<docId>`               | `title, s3Key, pages, applianceId, kbSync {status, at}`                                                                                                                                                                                 |
| `VISIT#<visitId>`           | `providerId, providerName, category, applianceId, issue, windowStart, windowEnd, status (scheduled\|arrived\|completed\|missed), ringEventIds[], snapshotKey, description, arrivedAt`; `GSI2PK = HH#<hh>#VISIT`, `GSI2SK = windowStart` |
| `EVENT#<ts>#<eventId>`      | `type, subType, deviceId, deviceName, at, rawS3Key`; conditional put on `eventId` for idempotency                                                                                                                                       |
| `ALERT#<alertId>`           | `sensorType, deviceName, at, maintenanceTaskRef, status`                                                                                                                                                                                |
| `DEVICE#<ringDeviceId>`     | `name, kind, online, lastSeenAt`                                                                                                                                                                                                        |

IDs are prefixed and stable: `appl_`, `visit_`, `doc_`, `alert_`, `evt_`.

Manuals: S3 `manuals/<householdId>/<docId>.pdf` plus `<docId>.pdf.metadata.json` carrying `applianceId` and `title`. Bedrock Knowledge Base with an S3 data source on that prefix, vector store S3 Vectors, embeddings Titan Text Embeddings v2. Retrieval uses `Retrieve` with a metadata filter when `applianceId` is supplied.

## 6. Ring pipeline

### 6.1 Account and app

Private Ring app (up to 10 linked accounts, no certification). Ring-driven account linking: Ring posts an auth code to `/ring/link`; the handler verifies the HMAC-SHA256 nonce, exchanges the code at Ring's token endpoint, stores tokens in Secrets Manager, and calls `GET /v1/devices` to seed `DEVICE#` items. Token refresh runs on a schedule with a 1-hour margin.

Development before approval uses the Developers Playground (30-minute tokens, simulated package, vehicle, and motion events) to fix event shapes and correlation logic.

### 6.2 Ingest

`POST /ring/webhook` → Lambda: verify `X-Signature: sha256=<hmac>` against the webhook secret, respond 200 immediately, conditional put `EVENT#` on `eventId`, publish to EventBridge bus `homeledger` with `detail-type` equal to the Ring event type.

### 6.3 Handlers

- **visit-correlator** on `button_press` and `motion_detected` with `sub_type = human` from doorbell devices: query GSI2 for a `scheduled` visit whose window covers `at ± 30 min`. On match: set `arrived`, wait 5 s, request a snapshot with `latest_in_range` around `at`, store under `snapshots/`, ask Nova (vision) for one plain sentence, update the visit, push `visit.arrived`. On no match: record only.
- **sensor-rules** on `flood_detected`, `freeze_detected`, `contact_sensor_faulted`: create `ALERT#`, create or advance the matching `MAINT#` item (rule table in `packages/core`), push `alert.raised`. Enabled by `SENSORS_ENABLED`. Covered by replayed fixtures regardless of grant status.
- **device-sync** on `device_added`, `device_removed`, `device_online`, `device_offline`, plus a nightly full sync.

### 6.4 Push

API Gateway WebSocket API with `$connect`, `$disconnect`, and a connections table. Payload `{cardType: "visit.arrived" | "alert.raised", id}`. The simulator, on receipt, runs an agent turn with an injected system message naming the record; the agent fetches details through MCP.

### 6.5 Constraints honored

Official Partner API only. Watermark preserved. Privacy zones respected by construction. Snapshot is from recordings, requested after the event. Demo doorbell verified to have TAKE encryption off before week 3. Content policy: no facial recognition, no cross-customer data, no life-safety claims.

## 7. Simulator

- Next.js 15 App Router on Amplify Hosting (fallback: Vercel).
- Frame: Echo Show 8 at 1280×800, base canvas 768×480 scaled 1.667. Dark default (#14181E cards, #1B2028 nested), light toggle (#FFFFFF, #FAF9FB). Ambient home screen, transcript overlay, text input, optional Web Speech mic. No Amazon or Alexa logos or wordmarks.
- Agent: `@strands-agents/sdk` on Bedrock, Claude Sonnet 4.6 by default (Strands' default) with the exact inference profile ID pinned in week 0 after confirming regional access, in a streaming route handler. `McpClient` over `StreamableHTTPClientTransport` with the Cognito bearer. `elicitationCallback` renders a choice card (≤5 options) or a confirm card; the card's answer resolves the callback. A transport wrapper taps notifications for the debug drawer. System prompt carries the Alexa+ persona rules.
- Widgets: MCP Apps host (app-bridge) renders `ui://` resources in a sandboxed iframe inside the frame with an Alexa-shaped `hostContext`.
- Debug drawer: live JSON-RPC log, protocol version, session ID, timing per call.
- Proactive channel: WebSocket client; cards slide in and trigger the injected turn.

## 8. Infrastructure and delivery

Terraform, single root, environment `demo`, remote state in S3 with the native lockfile. Region: `us-east-1` or `us-west-2`, chosen in week 0 as the one where AgentCore Runtime, Bedrock Nova and Claude access, S3 Vectors, and Knowledge Bases are all available in the account; everything deploys to that single region.

Resources: ECR repository; `aws_bedrockagentcore_agent_runtime` (container URI by SHA tag, `server_protocol = MCP`, custom JWT authorizer with the Cognito discovery URL and allowed client, environment variables, lifecycle idle 1800 s); Cognito user pool, resource server, app client; DynamoDB table with GSI1 and GSI2; S3 buckets for manuals and snapshots; S3 Vectors bucket and index; Bedrock Knowledge Base and data source with `S3_VECTORS` storage; Lambdas (Node 22, arm64) for link, webhook, correlator, sensor-rules, device-sync, websocket; HTTP API and WebSocket API; EventBridge bus and rules; Secrets Manager; Amplify app; IAM roles per function; CloudWatch log groups with retention.

Provider items pinned in week 1: `aws_bedrockagent_knowledge_base` S3 Vectors storage block, and S3 Vectors bucket/index resources. Fallback: AWSCC provider or a documented one-time CLI step.

CI: GitHub Actions. Pull requests run lint, typecheck, unit and contract tests. Main builds `linux/arm64` with buildx, pushes to ECR by SHA, runs `terraform plan` then `apply` with OIDC federation. The simulator deploys through Amplify's GitHub connection.

Local: Docker Compose with DynamoDB Local; server on `:8000/mcp`; MCP Inspector; `agentcore logs` for the deployed runtime.

## 9. Testing

- Unit (Vitest): every tool handler against a fake repository; MRTR round trips (no answers → input required; answers → complete; state codec verify); HMAC verification; correlation windows; sensor rule table; ID prefixes.
- Contract: server in-process; drive with `@modelcontextprotocol/client` v2 (MRTR path) and `@modelcontextprotocol/sdk` v1 (legacy shim path). Assert `tools/list` order and schemas, `structuredContent` validates against `outputSchema`, text has no JSON, elicitation options ≤5, handler time budget.
- Integration (env-gated): DynamoDB Local; real Knowledge Base retrieval against a test document set.
- End-to-end (Playwright): simulator ask → card; booking with elicitation; proactive card from a replayed webhook fixture posted to the local events endpoint.
- Fixtures: Ring webhooks recorded from Playground and staging, replayed by a harness.
- Load smoke: 20 sequential cold calls through AgentCore; p95 under 3 s.

## 10. Submission assets

- Repo `homeledger`, public, MIT. README: architecture diagram, run instructions, "how the required tech is called at runtime," simulated-data disclosure (provider marketplace), simulated-Alexa+ disclosure.
- `FRICTION-LOG.md` from day one (timestamp, expected, actual, workaround, link). `FEATURE-REQUESTS.md` with priority ratings. `docs/DEMO_SCRIPT.md`. `docs/FEEDBACK.md` drafting the product feedback form.
- Tracks: Alexa+ primary, Ring secondary. Mini: AWS Builder (Bedrock, AgentCore Runtime, Strands, Terraform documented).
- Video (≤3 min): hook at the door and on the frame; "when did we last change the furnace filter" → calendar; "what does F21 mean on the washer" → manual passage with page; "book a plumber for the water heater Tuesday" → provider card, window card, progress, confirmation; real doorbell press → arrival card with snapshot and description; freeze alert only if sensors are live; 15-second debug drawer pass; close.

## 11. Timeline

| Window       | Milestone                                                                                                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sep 13–15    | Ring developer account + ID verification; staging-trial ticket; order doorbell, two 2nd-gen contact sensors, one 2nd-gen flood/freeze; Alexa developer account; AWS credit form; Bedrock model access; spec and plan                |
| Sep 16–22    | Monorepo; core; server with `list_appliances`, `get_appliance`, `maintenance_due`, `log_maintenance`, `recent_events`; DynamoDB; Inspector; Terraform baseline; first AgentCore deploy; legacy-shim spike (decides A vs fallback C) |
| Sep 23–29    | `book_service` with elicitation and progress on both client generations; Knowledge Base and manuals; `ask_manual`; simulator MVP (frame, agent, transcript, debug drawer)                                                           |
| Sep 30–Oct 6 | Ring link, webhook, correlator, snapshot + vision, WebSocket push, proactive card; widgets; doorbell installed                                                                                                                      |
| Oct 7–13     | Sensors if granted; end-to-end tests; load smoke; Agent Skill; README; friction log consolidation                                                                                                                                   |
| Oct 14–20    | Video script, record, edit; feedback form; feature requests; dry-run submission by Oct 18                                                                                                                                           |
| Oct 22       | Final submission                                                                                                                                                                                                                    |

## 12. Risks and fallbacks

| Risk                                                      | Mitigation                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Ring approval or ID verification lag                      | Start Sep 13; develop on Playground meanwhile                                          |
| Staging webhooks need a support-provisioned trial         | File ticket Sep 13 (documented known gap)                                              |
| TAKE encryption blocks partner media on the demo doorbell | Verify setting in week 1; disable for the demo device                                  |
| SDK v2 sessionful legacy path misbehaves on AgentCore     | Week-1 spike; fallback to SDK v1.x (architecture C) with identical transport semantics |
| Sensors early access not granted                          | Feature flag; fixtures; doorbell-only video                                            |
| Amplify SSR friction with Next 15                         | Vercel                                                                                 |
| Bedrock model access or region gaps                       | Request in week 0; choose a region with Nova, Claude, AgentCore, S3 Vectors            |
| Terraform provider coverage for S3 Vectors or AgentCore   | Pin provider; AWSCC or CLI fallback                                                    |
| Strands lacks progress notifications                      | Transport tap for the drawer; Inspector demonstrates progress natively                 |

## 13. References

- Devpost rules: https://amazonappdev2026.devpost.com/rules
- Organizer clarification (simulated experience): https://amazonappdev2026.devpost.com/forum_topics/45058-clarification-on-simulated-alexa-web-experience-requirements
- Alexa+ MCP Toolkit overview: https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html
- Alexa+ functional requirements: https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements.html
- Alexa+ visual foundations: https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-visual-foundations.html
- MCP 2026-07-28 changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- MCP TypeScript SDK v2: https://ts.sdk.modelcontextprotocol.io/v2/ (serving/http, serving/legacy-clients, serving/sessions-state-scaling, servers/input-required)
- MCP Apps: https://modelcontextprotocol.io/extensions/apps/overview and https://github.com/modelcontextprotocol/ext-apps
- AgentCore MCP contract: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp-protocol-contract.html
- AgentCore stateful MCP: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/mcp-stateful-features.html
- AgentCore lifecycle: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html
- Terraform `aws_bedrockagentcore_agent_runtime`: https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime
- S3 Vectors with Knowledge Bases: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-bedrock-kb.html
- Strands TypeScript: https://strandsagents.com/docs/user-guide/quickstart/typescript/ and https://registry.npmjs.org/@strands-agents/sdk/latest
- Ring API: https://developer.amazon.com/docs/ring/api-documentation.html and release notes https://developer.amazon.com/docs/ring/release-notes.html
- Ring staging trial gap: https://community.amazondeveloper.com/t/issue-testing-staging-app-with-motion-events/28731
