# HomeLedger — Devpost project story

Maintenance notes (do not paste this block):

- Paste only from `## Inspiration` down to the end of `## Disclosures`. The PENDING section below the rule stays out of Devpost.
- Everything above the `PENDING` line is true as of the date below. Nothing unverified goes above the line. When a pending item is verified, move its text up into the section named and delete it from the list.
- Story body synced from the Devpost draft on 2026-09-14 so Joey's wording edits are the source of truth.
- Plan 2 moved up on 2026-09-18: tools, widgets, booking, and the Knowledge Base infrastructure. Real manual retrieval did not move up and must not, until Bedrock clears — see the PENDING list.

Last verified: 2026-09-18 (branch `docs-devpost-plan-2`, Plan 2 merged as `f258d46`; deployed runtime smoke green, run 35292750115)

---

## Inspiration

Every house has an operating record. Mine was spread across a drawer of manuals, a warranty email I could never find, a calendar reminder I kept snoozing, and a plumber's business card on the fridge. When the furnace filter was overdue, I didn't know it. When the plumber rang the doorbell, I was on a call and did not know who it was.

An assistant that lives in the kitchen should be able to answer "when did we last change the furnace filter," "what does F21 mean on the washer," and "book someone for the water heater," and it should be able to tell me that the person at the door is the plumber I booked. HomeLedger is that record, exposed to an assistant through an MCP server, with the front door and the home's sensors feeding it.

## What it does

HomeLedger is a self-hosted MCP server that gives an assistant read and write access to a household's appliances, warranties, manuals, maintenance schedule, service visits, and door and sensor events.

Nine tools, in an order frozen after the first deploy: `list_appliances`, `get_appliance`, `maintenance_due`, `log_maintenance`, `recent_events`, `ask_manual`, `book_service`, `get_visit`, and `echo_confirm`. Eight register unconditionally; `echo_confirm` is a developer-only elicitation probe that the demo runtime deliberately leaves enabled, because it is the smallest thing that proves an elicitation round trip works against the live endpoint. Three read-only JSON resources — the household, the appliance list, the maintenance schedule — plus four `ui://` MCP Apps widgets, and one prompt, `seasonal-checklist`, that builds a checklist from the household's own appliances.

Two flows are live:

1. **Ask.** "When is the furnace filter due?" is answered by `maintenance_due`: a spoken sentence naming the overdue filter, with the full list of due items in structured content beside it.
2. **Book.** "Book a plumber for the water heater Tuesday." `book_service` pauses the conversation through MCP elicitation to pick a provider and an arrival window, reports progress while it checks availability, asks for a final confirmation, and writes the visit. `get_visit` reads it back.

MCP Apps widgets render the appliance list, a single appliance, the maintenance calendar, and a service visit inside the assistant's frame. Five tools carry a `_meta.ui.resourceUri` pointing at one of them.

Every tool returns spoken text with no JSON in it and typed structured content that validates against a declared output schema. Spoken lists stop at five items. Those are Alexa+'s published functional requirements for add-ons, and the contract tests enforce them.

`ask_manual` is the exception worth stating plainly: the tool is deployed, reachable, and answers inside its budget, but it has never returned a real manual passage. The Knowledge Base behind it is provisioned and cannot be queried. Challenges explains why, and Disclosures lists it with everything else that is not yet real.

## How I built it

**MCP server.** TypeScript, `@modelcontextprotocol/server` v2, one Express route at `/mcp`. One server factory registers every tool, resource, and prompt, and two transport branches share it. Requests from current clients (spec revision 2026-07-28) go to the stateless handler and natively get multi-round-trip `input_required` results. Requests from 2025-era clients, which is what the Alexa+ MCP Toolkit documents (`initialize` with `protocolVersion: 2025-03-26`, then `Mcp-Session-Id`), are detected and routed to a per-session `NodeStreamableHTTPServerTransport`, where the SDK's legacy shim turns the same handler's input requests into real `elicitation/create` calls over the session. Handlers are written once.

**Booking.** `book_service` is one handler that asks three questions — provider, arrival window, confirmation — and emits progress `0` through `3` while it checks availability. Between rounds it carries its own state in the SDK's signed `requestState`, HMAC'd with a ten-minute TTL and bound to the method and the calling client, so nothing about a half-finished booking lives in server memory. The visit id is derived by SHA-256 from the household, the appliance, the provider, and the window start rather than generated randomly, so an ordinary client retry of the confirm round overwrites the same row instead of double-booking.

**Widgets.** Four MCP Apps widgets, each a single `ui://` HTML resource with no external assets. The view side of the host handshake is hand-written against the wire protocol published by `@modelcontextprotocol/ext-apps` — `ui/initialize`, then `ui/notifications/initialized`, then the host's tool-result, tool-input and host-context notifications, with `tools/call` proxied back over the same `postMessage` channel. The package's own view SDK is not self-contained, and its dependency-inclusive bundle is 418 KB; inlining that into four single-file widgets would have cost a bundler step per widget or four copies of a 400-KB payload, for a wire contract that is small, stable, and documented. The server keeps the package as a dependency for its 561-byte `./server` export, and a test pins the hand-written side to the SDK's own mime type and meta key.

**Data.** DynamoDB single table keyed by household, with GSIs for "what is due" and "what visits are scheduled," behind a repository interface. An in-memory implementation shares a contract test suite with the DynamoDB one, and the DynamoDB one runs against DynamoDB Local in Docker. Seed data uses fixed ids, and the deployed smoke resets the household before seeding, because a random-id seed silently quadrupled the demo appliances during the first four smoke runs.

**Manuals.** Manuals live in S3 at `manuals/<householdId>/<docId>.pdf`, each beside a `.metadata.json` sidecar carrying the appliance id and the title, which is what makes a metadata filter possible at retrieval time. A Bedrock Knowledge Base on an S3 Vectors index ingests that prefix with Titan Text Embeddings v2; `ask_manual` calls `Retrieve` with an `equals` filter on the appliance, asks for three passages, caches each question for ten minutes, and returns the passages with their page numbers without composing anything — the client model writes the answer, the way Alexa+ would. All of that infrastructure is applied and real. None of it has ever ingested or returned a document, for the reason in Challenges.

**Container.** A `linux/arm64` image built from a multi-stage Dockerfile with `pnpm deploy`, listening on `0.0.0.0:8000/mcp` as a non-root user. It answers the exact `initialize` handshake the Alexa+ documentation shows and returns an `Mcp-Session-Id`.

**Runtime.** Amazon Bedrock AgentCore Runtime in stateful mode, fronted by AgentCore's JWT authorizer with a Cognito user pool as issuer (client-credentials flow, scope `homeledger/mcp`, the client secret held in Secrets Manager). Stateful mode matters: AgentCore pins a session to one microVM, which is what makes an in-process session map safe. The first thing the deployed runtime taught me is that AgentCore does not forward the public invocation host as the `Host` header; it forwards an internal, cell-specific name, so the SDK's DNS-rebinding allowlist has to be off behind the authorizer.

**Infrastructure.** Terraform, split into a root for the demo environment and reusable modules for the AgentCore runtime (execution role and permissions), the Cognito machine-to-machine issuer, and the manuals Knowledge Base (S3 bucket, S3 Vectors bucket and index, Bedrock Knowledge Base, data source, IAM role), each with typed and validated inputs, terraform-docs READMEs, and plan-time tests that run offline against a mocked provider. Nothing is applied from a laptop: GitHub Actions assumes an OIDC role, plans on pull requests, and on merge builds the ARM64 image, pushes it to ECR by commit SHA, and applies. A second workflow seeds the live table and runs the smoke test against the deployed endpoint with both client generations.

**Tests.** Vitest unit tests for every handler. Contract tests drive the server with both client generations, `@modelcontextprotocol/client` v2 in-process and `@modelcontextprotocol/sdk` 1.x over a real socket, and assert tool order, structured content against the output schemas, spoken text, session creation, and elicitation on both branches.

## Challenges

**The spec moved under the hackathon.** The rules link the 2025-11-25 MCP revision. The 2026-07-28 revision removed sessions, removed `initialize`, and replaced server-initiated elicitation with multi round-trip requests. The Alexa+ docs still show the 2025 handshake. A server written to the linked pages would be a legacy server on day one, and a server written only to the current revision could never serve the documented Alexa+ client. Serving both from one handler was the central design problem, and the SDK documents the sessionful path as "legacy preservation," not as a recommended configuration. I built an `echo_confirm` spike before anything else to prove the shim delivers elicitation to a 2025-era client over a session. It did, with no changes to the documented code.

**A provisioned Knowledge Base is not a usable one.** Terraform created the manuals bucket, the S3 Vectors bucket and index, the Bedrock Knowledge Base, its data source, and its IAM role cleanly, on the first apply. Bedrock model invocation is blocked account-wide on this account, so the first ingestion job failed: starting one makes the Knowledge Base role call Titan to embed the documents. That much I expected. The sharper finding came next. Retrieval embeds the *query*, not only the documents — the question has to become a vector before it can be compared against the index — so `Retrieve` is refused server-side as well, against a Knowledge Base that exists, holds a valid index, has a working role and data source, and is wired into the runtime. There is no degraded mode. It cannot be written to and it cannot be read from, and every control-plane API reports it healthy. Terraform reports success for a resource that cannot do its job, which means a binary "is it provisioned" check is the wrong abstraction: provisioned-but-unusable is a distinct state and tooling has to model it. The generalisation I would carry anywhere: ask how far a capability dependency *reaches*, not merely which operation obviously needs it. Twice now I modelled that reach and twice it went one step further than the model. (A support case on the account block was closed on the grounds that hackathon projects should fit inside the beginner quota. That is a quota answer to an access problem. A quota throttles — the call succeeds, just not as often, and it says `ThrottlingException`. This account returns `Error 002: Access to Bedrock models is not allowed for this account` to every principal that asks, including the Knowledge Base's own service role. A probe today returns it still.)

**A smoke test that passes against a broken system is worse than none, because it manufactures confidence.** The `ask_manual` check used to look for `F21` in the returned passage. The server's own fixture retriever, which it falls back to whenever no Knowledge Base is configured, returns canned text that matches the smoke's exact question on four keywords and contains `F21`. So the run could have printed `SMOKE OK` against a system with no Knowledge Base, no index, no ingestion job, and no Bedrock call at all. It now pins a document title that no fixture carries, so only real ingested content can pass. The check models five states rather than two, and in each blocked one it skips loudly — naming exactly what was not proven and quoting the server's own error — instead of passing silently or dying on a property access that tells an operator nothing about the system under test. It still makes the call in every state, because `tools/list` proves registration and never invocation, and because the day the block lifts an error result becomes passages and the run says so. One blocked embedding call had already taken down the coverage of the eight tools that do work; that is what this rewrite was really fixing.

**Gated access everywhere.** The MCP Toolkit is available to "select partners." Ring's sensor support and dynamic scopes are in an early-access program with no documented request path. Staging webhooks need a support-provisioned trial. Each of these is a friction-log entry, with a workaround that lets the build continue.

**Ring has no live snapshot.** Snapshots come from recordings only, so a "who is at the door" flow has to wait a few seconds after the event and request the latest frame in range. Worth knowing before you design around it.

**Two product lines share a name.** Ring's "Contact Sensor (2nd Gen)" is a Z-Wave device that needs an Alarm base station. Ring's "Flood and Freeze Sensor (2nd Gen)" is an Amazon Sidewalk device that needs no base station. The Partner API's sensor family is the Sidewalk line. The first shopping list had the wrong one.

**Small things that cost a deploy each.** On a brand-new Terraform state, `terraform output -raw` exits 0 with a warning instead of failing, so a "create the ECR repo if the output is missing" guard never fired. GitHub's OIDC token now carries owner and repo IDs in its subject claim, so the classic trust-policy pattern silently fails role assumption. AgentCore routes a legacy client's `DELETE` session termination to a fresh microVM even though every `POST` in the same session routed correctly. Each one is a friction-log entry with the exact fix.

## Accomplishments

The booking flow is the one I would show first, and it runs on both protocol generations against the deployed runtime. In smoke run 35292750115, on merge commit `f258d46`, a 2025-era client initializes a session through AgentCore, and `book_service` completes three elicitation rounds — provider, arrival window, confirmation — emits progress `0` through `3`, and writes a real visit (`Kettle Creek Water Heaters`, `visit_tbtoaw46tla4ztez`) in 2027 ms. `get_visit` reads the same visit back in 344 ms. A 2026-07-28 client lists and calls tools statelessly on the same endpoint in the same run, and the same handler serves both — no transport-specific branch in any tool.

The numbers from that run: cold connect 779 ms modern, 1066 ms legacy. `tools/list` 790 ms, `list_appliances` 852 ms, `maintenance_due` 750 ms, `ask_manual` 899 ms, `echo_confirm` with its elicitation round trip 765 ms, `get_visit` 344 ms — every single-round call under a second against a 3-second budget. `book_service` is the one call not held to that budget, and deliberately so: it spans three human round trips and a deliberate availability delay.

Every tool responds in spoken text a person could read aloud, with the full data in typed structured content beside it, and the smoke asserts the frozen tool order and the widget wiring on all five widget-backed tools on every run.

## What I learned

Write handlers for the newest protocol and let the SDK shim the past; the reverse doesn't work. Treat every "coming soon" in a platform's docs as a feature flag with a fixture behind it. Ask how far a capability dependency reaches, not merely which operation needs it — the honest answer is usually further than the first failing call suggests. Put the friction log in the repo on day one, because the decisions it drove are the architecture.

## What's next

Ingest the manuals and let `ask_manual` answer from real passages, the moment the account's Bedrock block clears. The Ring pipeline: webhooks, visit correlation, snapshot and description, proactive cards. A simulated Echo Show driven by a Strands agent. Sensor rules for the Ring Sensors line.

## Disclosures

The demo household is my real home, with appliances given fictional names.

The service-provider marketplace that `book_service` offers is a static, clearly labeled sample in the repo; it is the one simulated data source. Every provider row carries a required `sample: true` field, and no booking leaves the system.

Nothing here talks to Alexa+. The MCP Toolkit is a private preview and entrants cannot call it, so the Alexa+ client generation is stood in for by a real 2025-era MCP client, in the contract tests and in the deployed smoke run.

`ask_manual` has never retrieved a real passage: the Knowledge Base is provisioned but unqueryable under the account's Bedrock block, and where no Knowledge Base is configured the tool serves a small in-memory fixture set. No Ring integration exists in the repository — `recent_events` returns door and sensor rows only if something writes them, and nothing does yet. `get_visit`'s `snapshotUrl` is always null. There is no simulator; `apps/` contains the MCP server only.

---

## Built with (tags, current)

TypeScript, Node.js, Model Context Protocol, MCP Apps, Express, Amazon Bedrock AgentCore, Amazon Bedrock Knowledge Bases, Amazon S3 Vectors, Amazon S3, Amazon Cognito, Amazon DynamoDB, AWS Secrets Manager, Amazon ECR, Terraform, GitHub Actions, Docker, pnpm, Zod, Vitest

## Try it out links

- https://github.com/jkarns87/homeledger

---

# PENDING — add above the line only when verified

Each entry: where it goes, the text to add, and what verifies it.

**Load smoke p95** (Accomplishments; verified by the spec's 20-sequential-cold-call load smoke, not yet run; single-call timings are already in the story)
> Across 20 sequential cold calls through AgentCore, p95 is [N] s against the 3 s budget.

**Real manual retrieval** (What it does, and the `ask_manual` sentence at the end of that section; the Manuals paragraph in How I built it; and the Disclosures paragraph, all of which currently say the opposite; verified only when the account's Bedrock block clears, an ingestion job completes, and the smoke's `assertManualPassages` enforces instead of skipping — i.e. a run that prints a passage count and a document title rather than `ask_manual: SKIPPED`)
> `ask_manual` answers from the manuals themselves: `Retrieve` with a metadata filter on the appliance, three passages with page numbers, and the client model composes the reply.
Nothing about real retrieval moves up before that run exists. The infrastructure being applied is already stated above the line and is not the same claim.

**Simulator** (How I built it, new paragraph; not built in Plan 2, deferred to a later plan)
> **Simulated Alexa+ client.** The MCP Toolkit is a private preview and the organizers confirmed entrants cannot call Alexa+ itself, so the interaction layer is a Next.js simulation of an Echo Show 8 (768×480 canvas at 1.667 scale, Alexa+'s published card colors) driven by a Strands agent on Bedrock. Strands is a 2025-era MCP client, so it exercises the legacy branch exactly as the Alexa+ documentation describes, including elicitation through its `elicitationCallback`. A debug drawer shows every JSON-RPC message, the negotiated protocol version, the session ID, and per-call timing.
Replaces the "Nothing here talks to Alexa+" disclosure paragraph with:
> The Alexa+ client is a simulation, as the organizers permitted; the server is built to the published Alexa+ MCP Toolkit contract and is exercised by a real 2025-era MCP client.
Tags: Strands Agents, Anthropic Claude, Next.js, React, AWS Amplify. Try-it-out link: simulator URL. Note the Strands agent also needs Bedrock model access, so this is blocked on the same thing `ask_manual` is.

**Ring pipeline** (How I built it, new paragraph, and a third flow in What it does; verified by Plan 3 with a real doorbell press)
> **Ring.** Official Partner API only. Webhooks are HMAC-verified in a Lambda that answers within five seconds and publishes to EventBridge. Handlers correlate doorbell presses with scheduled visits, request a snapshot from the recording, describe it with Amazon Nova, and push a card over an API Gateway WebSocket.
> 3. **Arrive.** The plumber presses the Ring doorbell. A webhook lands, the visit correlator matches it to the booked window, pulls a snapshot from the recording, asks a vision model for one plain sentence, and the assistant surfaces "your plumber is at the door" with the image, without being asked.
Removes the "No Ring integration exists" and "`snapshotUrl` is always null" sentences from Disclosures. Tags: Ring Partner API, AWS Lambda, Amazon EventBridge, Amazon API Gateway, Amazon Nova.

**Sensors** (Ring paragraph addendum; verified only if early access is granted and a real sensor event lands)
> Sensor events from the Ring Sensors line (flood, freeze, contact) create alerts and advance maintenance items through a rule table.
Tag: Amazon Sidewalk.

**Required-tech-at-runtime paragraph** (How I built it; verified when both the AgentCore deploy and the simulator exist; the rules require this statement)
> **How the required tech is called at runtime.** Every conversational turn is a real Streamable HTTP request from the simulator's agent to the AgentCore invocation URL with a Cognito bearer token. Every proactive card starts as a real Ring webhook. Nothing in the demo is a recorded response.

**What's next, final form** (replace the current section once the above have moved up)
> Real Alexa+ once the MCP Toolkit opens. Multi-household account linking, which the partition keys already allow. The MCP tasks extension for the availability check once a TypeScript runtime exists.
