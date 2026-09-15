# HomeLedger — Devpost project story

Maintenance notes (do not paste this block):

- Paste only from `## Inspiration` down to the end of `## Disclosures`. The PENDING section below the rule stays out of Devpost.
- Everything above the `PENDING` line is true as of the date below. Nothing unverified goes above the line. When a pending item is verified, move its text up into the section named and delete it from the list.
- Story body synced from the Devpost draft on 2026-09-14 so Joey's wording edits are the source of truth.

Last verified: 2026-09-15 (branch `worktree-plan-1-foundation`, all Plan 1 tasks complete; deployed runtime smoke green, run 34968420324)

---

## Inspiration

Every house has an operating record. Mine was spread across a drawer of manuals, a warranty email I could never find, a calendar reminder I kept snoozing, and a plumber's business card on the fridge. When the furnace filter was overdue, I didn't know it. When the plumber rang the doorbell, I was on a call and did not know who it was.

An assistant that lives in the kitchen should be able to answer "when did we last change the furnace filter," "what does F21 mean on the washer," and "book someone for the water heater," and it should be able to tell me that the person at the door is the plumber I booked. HomeLedger is that record, exposed to an assistant through an MCP server, with the front door and the home's sensors feeding it.

## What it does

HomeLedger is a self-hosted MCP server that gives an assistant read and write access to a household's appliances, warranties, maintenance schedule, service visits, and door and sensor events.

Tools today: `list_appliances`, `get_appliance`, `maintenance_due`, `log_maintenance`, and `recent_events`. Resources: the household, the appliance list, and the maintenance schedule as read-only JSON. One prompt, `seasonal-checklist`, builds a checklist from the household's own appliances.

Every tool returns spoken text with no JSON in it and typed structured content that validates against a declared output schema. Spoken lists stop at five items. Those are Alexa+'s published functional requirements for add-ons, and the contract tests enforce them.

"When is the furnace filter due?" is answered by `maintenance_due`: a spoken sentence naming the overdue filter, with the full list of due items in structured content beside it.

## How I built it

**MCP server.** TypeScript, `@modelcontextprotocol/server` v2, one Express route at `/mcp`. One server factory registers every tool, resource, and prompt, and two transport branches share it. Requests from current clients (spec revision 2026-07-28) go to the stateless handler and natively get multi-round-trip `input_required` results. Requests from 2025-era clients, which is what the Alexa+ MCP Toolkit documents (`initialize` with `protocolVersion: 2025-03-26`, then `Mcp-Session-Id`), are detected and routed to a per-session `NodeStreamableHTTPServerTransport`, where the SDK's legacy shim turns the same handler's input requests into real `elicitation/create` calls over the session. Handlers are written once.

**Container.** A `linux/arm64` image built from a multi-stage Dockerfile with `pnpm deploy`, listening on `0.0.0.0:8000/mcp` as a non-root user. It answers the exact `initialize` handshake the Alexa+ documentation shows and returns an `Mcp-Session-Id`.

**Runtime.** Amazon Bedrock AgentCore Runtime in stateful mode, fronted by AgentCore's JWT authorizer with a Cognito user pool as issuer (client-credentials flow, scope `homeledger/mcp`, the client secret held in Secrets Manager). Stateful mode matters: AgentCore pins a session to one microVM, which is what makes an in-process session map safe. The first thing the deployed runtime taught me is that AgentCore does not forward the public invocation host as the `Host` header; it forwards an internal, cell-specific name, so the SDK's DNS-rebinding allowlist has to be off behind the authorizer.

**Data.** DynamoDB single table keyed by household, with GSIs for "what is due" and "what visits are scheduled," behind a repository interface. An in-memory implementation shares a contract test suite with the DynamoDB one, and the DynamoDB one runs against DynamoDB Local in Docker. Seed data uses fixed ids, and the deployed smoke resets the household before seeding, because a random-id seed silently quadrupled the demo appliances during the first four smoke runs.

**Infrastructure.** Terraform, split into a root for the demo environment and reusable modules for the AgentCore runtime (execution role and permissions) and the Cognito machine-to-machine issuer, each with typed and validated inputs, terraform-docs READMEs, and plan-time tests that run offline against a mocked provider. Nothing is applied from a laptop: GitHub Actions assumes an OIDC role, plans on pull requests, and on merge builds the ARM64 image, pushes it to ECR by commit SHA, and applies. A second workflow seeds the live table and runs the smoke test against the deployed endpoint with both client generations.

**Tests.** Vitest unit tests for every handler. Contract tests drive the server with both client generations, `@modelcontextprotocol/client` v2 in-process and `@modelcontextprotocol/sdk` 1.x over a real socket, and assert tool order, structured content against the output schemas, spoken text, session creation, and elicitation on both branches.

## Challenges

**The spec moved under the hackathon.** The rules link the 2025-11-25 MCP revision. The 2026-07-28 revision removed sessions, removed `initialize`, and replaced server-initiated elicitation with multi round-trip requests. The Alexa+ docs still show the 2025 handshake. A server written to the linked pages would be a legacy server on day one, and a server written only to the current revision could never serve the documented Alexa+ client. Serving both from one handler was the central design problem, and the SDK documents the sessionful path as "legacy preservation," not as a recommended configuration. I built an `echo_confirm` spike before anything else to prove the shim delivers elicitation to a 2025-era client over a session. It did, with no changes to the documented code.

**Gated access everywhere.** The MCP Toolkit is available to "select partners." Ring's sensor support and dynamic scopes are in an early-access program with no documented request path. Staging webhooks need a support-provisioned trial. Each of these is a friction-log entry, with a workaround that lets the build continue.

**Ring has no live snapshot.** Snapshots come from recordings only, so a "who is at the door" flow has to wait a few seconds after the event and request the latest frame in range. Worth knowing before you design around it.

**Two product lines share a name.** Ring's "Contact Sensor (2nd Gen)" is a Z-Wave device that needs an Alarm base station. Ring's "Flood and Freeze Sensor (2nd Gen)" is an Amazon Sidewalk device that needs no base station. The Partner API's sensor family is the Sidewalk line. The first shopping list had the wrong one.

**Small things that cost a deploy each.** On a brand-new Terraform state, `terraform output -raw` exits 0 with a warning instead of failing, so a "create the ECR repo if the output is missing" guard never fired. GitHub's OIDC token now carries owner and repo IDs in its subject claim, so the classic trust-policy pattern silently fails role assumption. AgentCore routes a legacy client's `DELETE` session termination to a fresh microVM even though every `POST` in the same session routed correctly. Each one is a friction-log entry with the exact fix.

## Accomplishments

One handler serves elicitation for both protocol generations, proven by contract tests on both clients and recorded in the friction log with the SDK versions, and then proven again on the deployed runtime: the smoke test initializes a 2025-era session through AgentCore, completes a server-initiated elicitation inside one tool call, and a 2026-07-28 client lists and calls tools statelessly on the same endpoint. Cold connects land under 1.5 seconds and warm calls under a second through AgentCore, against a 3-second budget. Every tool responds in spoken text a person could read aloud, with the full data in typed structured content beside it.

## What I learned

Write handlers for the newest protocol and let the SDK shim the past; the reverse doesn't work. Treat every "coming soon" in a platform's docs as a feature flag with a fixture behind it. Put the friction log in the repo on day one, because the decisions it drove are the architecture.

## What's next

`book_service` with elicitation and progress on both client generations. Manuals in a Bedrock Knowledge Base for `ask_manual`. The Ring pipeline: webhooks, visit correlation, snapshot and description, proactive cards. A simulated Echo Show driven by a Strands agent. Sensor rules for the Ring Sensors line.

## Disclosures

The demo household is my real home, with appliances given fictional names.

---

## Built with (tags, current)

TypeScript, Node.js, Model Context Protocol, Express, Amazon Bedrock AgentCore, Amazon Cognito, Amazon DynamoDB, AWS Secrets Manager, Amazon ECR, Terraform, GitHub Actions, Docker, pnpm, Zod, Vitest

## Try it out links

- https://github.com/jkarns87/homeledger

---

# PENDING — add above the line only when verified

Each entry: where it goes, the text to add, and what verifies it.

**Load smoke p95** (Accomplishments; verified by the spec's 20-sequential-cold-call load smoke, not yet run; single-call timings are already in the story)
> Across 20 sequential cold calls through AgentCore, p95 is [N] s against the 3 s budget.

**Booking flow** (What it does, tools list and a second flow; verified by Plan 2)
> 2. **Book.** "Book a plumber for the water heater Tuesday." `book_service` pauses the conversation through MCP elicitation to pick a provider and a window, reports progress while it checks availability, and confirms.
Add `book_service` and `get_visit` to the tools sentence. Add to Disclosures:
> The service-provider marketplace that `book_service` offers is a static, clearly labeled sample in the repo; it is the one simulated data source.

**Manuals and Knowledge Base** (How I built it, Data paragraph; verified by Plan 2)
> Manuals live in S3 and are indexed by a Bedrock Knowledge Base on S3 Vectors; `ask_manual` calls `Retrieve` with a metadata filter on the appliance and returns passages with page numbers, and the client model composes the answer, the way Alexa+ would.
Add `ask_manual` to the tools sentence. Tags: Amazon Bedrock, Bedrock Knowledge Bases, Amazon S3 Vectors.

**Widgets** (What it does; verified by Plan 2)
> MCP Apps widgets render the appliance list, a single appliance, the maintenance calendar, and a service visit inside the assistant's frame.

**Simulator** (How I built it, new paragraph; verified by Plan 2)
> **Simulated Alexa+ client.** The MCP Toolkit is a private preview and the organizers confirmed entrants cannot call Alexa+ itself, so the interaction layer is a Next.js simulation of an Echo Show 8 (768×480 canvas at 1.667 scale, Alexa+'s published card colors) driven by a Strands agent on Bedrock. Strands is a 2025-era MCP client, so it exercises the legacy branch exactly as the Alexa+ documentation describes, including elicitation through its `elicitationCallback`. A debug drawer shows every JSON-RPC message, the negotiated protocol version, the session ID, and per-call timing.
Add to Disclosures:
> The Alexa+ client is a simulation, as the organizers permitted; the server is built to the published Alexa+ MCP Toolkit contract and is exercised by a real 2025-era MCP client.
Tags: Strands Agents, Anthropic Claude, Next.js, React, AWS Amplify. Try-it-out link: simulator URL.

**Ring pipeline** (How I built it, new paragraph, and the third flow in What it does; verified by Plan 3 with a real doorbell press)
> **Ring.** Official Partner API only. Webhooks are HMAC-verified in a Lambda that answers within five seconds and publishes to EventBridge. Handlers correlate doorbell presses with scheduled visits, request a snapshot from the recording, describe it with Amazon Nova, and push a card over an API Gateway WebSocket.
> 3. **Arrive.** The plumber presses the Ring doorbell. A webhook lands, the visit correlator matches it to the booked window, pulls a snapshot from the recording, asks a vision model for one plain sentence, and the assistant surfaces "your plumber is at the door" with the image, without being asked.
Tags: Ring Partner API, AWS Lambda, Amazon EventBridge, Amazon API Gateway, Amazon Nova.

**Sensors** (Ring paragraph addendum; verified only if early access is granted and a real sensor event lands)
> Sensor events from the Ring Sensors line (flood, freeze, contact) create alerts and advance maintenance items through a rule table.
Tag: Amazon Sidewalk.

**Required-tech-at-runtime paragraph** (How I built it; verified when both the AgentCore deploy and the simulator exist; the rules require this statement)
> **How the required tech is called at runtime.** Every conversational turn is a real Streamable HTTP request from the simulator's agent to the AgentCore invocation URL with a Cognito bearer token. Every proactive card starts as a real Ring webhook. Nothing in the demo is a recorded response.

**What's next, final form** (replace the current section once the above have moved up)
> Real Alexa+ once the MCP Toolkit opens. Multi-household account linking, which the partition keys already allow. The MCP tasks extension for the availability check once a TypeScript runtime exists.
