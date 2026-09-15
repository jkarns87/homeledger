# HomeLedger — Devpost "Additional info" answers

Same rule as the story: text above each field's `PENDING` note is true today and can be pasted. Pending additions are listed under the field with what verifies them.

Last verified: 2026-09-14 (branch `worktree-plan-1-foundation` at Plan 1 Task 10)

---

## Simple fields

| Field | Answer |
|---|---|
| Submitter Type | Individual |
| Organization Name | N/A |
| Submitter Country of Residence | United States |
| Canada province | N/A |
| Primary Track(s) | Alexa+, Ring |
| Public code repository | https://github.com/jkarns87/homeledger |
| New or existing prior to August 31, 2026 | New |
| Existing-project explanation | (leave blank) |
| Submitting for AWS Builder Mini Challenge | Yes |
| Submitting for Open Source Mini Challenge | Yes (a new MIT repo created inside the window qualifies; a project can enter both minis and win one) |
| Open Source: Contribution URL | https://github.com/jkarns87/homeledger |
| Open Source: Project Repository URL | https://github.com/jkarns87/homeledger |
| Open Source: GitHub Username | jkarns87 |
| Friction Log (URL field) | https://github.com/jkarns87/homeledger/blob/main/FRICTION-LOG.md |
| Project Testing Link | PENDING: simulator URL after Amplify deploy (Plan 2) |
| Upload a File | (none) |
| Three eligibility checkboxes | Check all three |

---

## AWS Builder Mini Challenge: Which AWS services did you incorporate and how?

HomeLedger is a self-hosted MCP server whose home is Amazon Bedrock AgentCore Runtime. AWS services in the repository today, with where each integration lives:

**Amazon DynamoDB.** The household record is one table: partition key per household, sort keys per entity (`APPL#`, `MAINT#`, `LOG#`, `VISIT#`, `EVENT#`, `ALERT#`, `DEVICE#`), GSI1 for "what maintenance is due" ordered by due date, GSI2 for "what visits are scheduled" ordered by window start. Access is through the AWS SDK for JavaScript v3 (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`) behind a repository interface. The implementation is `packages/core/src/repo/dynamo.ts`, the table definition with both GSIs is `packages/core/src/repo/table.ts`, and a seed script populates a household. The same contract test suite runs against the in-memory twin and against DynamoDB Local (`docker-compose.yml`), so every tool handler is exercised against real DynamoDB query semantics.

**Amazon Bedrock AgentCore Runtime.** The server runs on AgentCore Runtime in stateful mode (`server_protocol = "MCP"`, `idle_runtime_session_timeout = 1800`) as a `linux/arm64` image (`apps/mcp-server/Dockerfile`) listening on `0.0.0.0:8000/mcp` as a non-root user, behind AgentCore's custom JWT authorizer. Legacy 2025-era clients get an `Mcp-Session-Id` and a per-session transport, which is safe because AgentCore pins a session to one microVM. `scripts/smoke.ts`, run by `.github/workflows/smoke.yml`, drives the invocation URL with both a 2026-07-28 client and a 2025-era client and completes a server-initiated elicitation through the shim on the deployed runtime. Two findings from that work are in `FRICTION-LOG.md`: AgentCore forwards an internal cell-specific `Host` header rather than the invocation host (FL-020), and legacy `DELETE` session termination routes to a fresh microVM (FL-022).

**Amazon Cognito and AWS Secrets Manager.** A Cognito user pool is the JWT issuer: resource server `homeledger` with scope `homeledger/mcp` and one client-credentials app client (`infra/modules/cognito-m2m`). The client secret is written to Secrets Manager through Terraform's write-only argument so it never round-trips through the secret resource's state.

**Amazon ECR, Terraform, and GitHub Actions.** ECR holds the image by commit SHA. Everything is Terraform: a root for the demo environment (`infra/live/demo/platform`) and reusable modules for the runtime and the issuer, with plan-time tests against a mocked provider. GitHub Actions assumes an OIDC role (no long-lived keys), plans on pull requests, and on merge builds the ARM64 image, pushes it, and applies (`.github/workflows/deploy.yml`).

PENDING (each verified by the named plan task; move up when done):
- Plan 2: "Amazon Bedrock Knowledge Bases on S3 Vectors with Titan Text Embeddings v2 indexes appliance manuals from S3; `ask_manual` calls `Retrieve` with a metadata filter on the appliance." "Strands Agents SDK (TypeScript) on Amazon Bedrock (Claude Sonnet 4.6) is the simulator's agent and the MCP client to the server; it exercises the legacy branch and elicitation through `elicitationCallback`." "AWS Amplify Hosting serves the Next.js simulator."
- Plan 3: "AWS Lambda (Node 22, arm64) receives Ring webhooks behind an API Gateway HTTP API, verifies HMAC, and publishes to an Amazon EventBridge bus; rule-targeted Lambdas correlate visits, fetch snapshots to S3, describe them with Amazon Nova, and push cards over an API Gateway WebSocket API. AWS Secrets Manager holds Ring tokens, the webhook secret, and the Cognito client secret. CloudWatch Logs with retention for every function and the runtime."
- Load smoke: "Measured p95 under [N] s through AgentCore cold across 20 sequential calls."

---

## Open Source Mini Challenge: what you did, how it works, why it matters

**What.** HomeLedger is a new public repository, MIT licensed, created on 2026-09-13 inside the hackathon window. It is a Streamable HTTP MCP server in TypeScript with a pnpm monorepo: `packages/core` (domain schemas, DynamoDB single-table repository with an in-memory twin and a shared contract suite) and `apps/mcp-server` (the server, tools, resources, prompt, container).

**How it works.** One server factory registers every tool, resource, and prompt. Two transport branches share it behind a single `/mcp` route: current 2026-07-28 clients are served statelessly with multi round-trip `input_required` results; 2025-era clients (the handshake the Alexa+ MCP Toolkit documents) are detected by their `initialize` call or `Mcp-Session-Id` header and routed to per-session transports, where the SDK's legacy shim delivers real `elicitation/create` requests. Handlers are written once. Contract tests drive both branches with the v2 client and the v1.x client over a real socket.

**Why it matters.** The hackathon's linked MCP revision (2025-11-25) and the current revision (2026-07-28) disagree on sessions, `initialize`, and elicitation, and the Alexa+ docs sit on the older side. Anyone targeting Alexa+ with the current TypeScript SDK hits this. The repo is a worked, tested example of serving both generations from one codebase, with a friction log that records every place the documentation disagreed with itself and what was done about it.

---

## [Optional] Feature Requests

Each drawn from an entry in FRICTION-LOG.md.

1. **Alexa+ MCP Toolkit: self-serve developer-stage access.** The toolkit is "available to select partners only" with no request form; an established skill developer reported a rejected request. Without it a hackathon entrant cannot test against the real client. Priority: Critical. (FL-001)
2. **Alexa+ authentication: align with MCP authorization discovery.** The quickstart and account-linking pages name different well-known paths, and the auth page says 401s carry no `WWW-Authenticate` header, the opposite of the 2025-11-25 guidance the hackathon links. Publish one discovery contract or document the divergence in one place. Priority: Important. (FL-002)
3. **Alexa+ client: negotiate 2025-06-18 or later.** The lifecycle example sends `protocolVersion: 2025-03-26`, which predates elicitation, while the overview claims 2025-11-25 features. State which revision certified add-ons receive. Priority: Important. (FL-003)
4. **AgentCore CLI: TypeScript MCP scaffold or a documented bring-your-own-container path.** The CLI is an npm package but restricts TypeScript to two agent frameworks and every MCP example is Python. Priority: Important. (FL-008)
5. **AgentCore MCP contract: reference the current MCP revision.** The contract page centers on `Mcp-Session-Id`, which 2026-07-28 removed; the stateful versus stateless decision took three documents to reconcile. Priority: Important. (FL-009)
6. **Strands TypeScript: progress notifications in `McpClient`.** Long-running tools cannot report progress to the agent. Priority: Important. (FL-010)
7. **Ring: documented request path for early-access programs.** Sensor events and dynamic scopes are announced as early access with no form, email, or console toggle. Priority: Important. (FL-011)
8. **Ring: self-serve staging Protect trial.** Motion webhooks and history return nothing on a staging test account until support provisions a trial by ticket. Priority: Important. (FL-012)
9. **Ring: on-demand snapshot.** Snapshots come only from recordings, so "who is at the door" lags the event by seconds. Priority: Important. (FL-013)
10. **Ring: document what end-to-end encryption removes from the Partner API.** The announcement says it "limits what integrations can access" without naming endpoints. Priority: Nice-to-have. (FL-014)
11. **Ring developer docs: distinguish the Alarm and Ring Sensors product lines.** Both have a "2nd Gen" contact and flood/freeze sensor; only the Sidewalk line is in the Partner API's sensor family. Priority: Nice-to-have.
12. **MCP tasks extension: a TypeScript runtime.** Specified in July 2026 with no SDK implementation. Priority: Nice-to-have. (FL-007)

---

## Feedback Question 1: Which developer tools, APIs, and SDKs did you use and for what?

- **MCP TypeScript SDK v2** (`@modelcontextprotocol/server`, `/node`, `/express`, `/client` 2.0.0): the server, both transport branches, and the modern-client contract tests.
- **MCP TypeScript SDK v1.x** (`@modelcontextprotocol/sdk` 1.30.0): the legacy-client contract tests that stand in for the Alexa+ client and for Strands.
- **Alexa+ MCP Toolkit documentation**: the client contract the server is built to (handshake, session header, functional requirements for voice output). No toolkit access; it is a private preview.
- **Amazon Bedrock AgentCore Runtime documentation and CLI**: the MCP protocol contract the container is built to; the CLI was evaluated for TypeScript MCP scaffolding.
- **AWS SDK for JavaScript v3 and DynamoDB Local**: the household repository and its tests.
- **Ring Partner API documentation and developer community**: event model, snapshot semantics, the sensor device family; developer registration and the staging trial ticket.
- **Devpost**: registration, forum clarification with the organizer.

PENDING: Strands Agents SDK, Amazon Bedrock models, Bedrock Knowledge Bases, AgentCore Runtime (deployed), Ring Partner API (live), Terraform AWS provider, Amplify Hosting.

## Feedback Question 2: What worked well?

- **MCP SDK v2**: the legacy shim delivered `elicitation/create` over a `NodeStreamableHTTPServerTransport` session to the v1.30.0 client with zero changes from the documented code. Every option and signature we relied on (`createMcpExpressApp` host validation, `toNodeHandler`, `createMcpHandler` with `legacy: 'reject'`, `acceptedContent` with a Zod schema, `inputRequired.elicit`) matched the shipped type definitions. In-process testing through `handler.fetch` made contract tests fast.
- **AgentCore MCP contract**: precise enough to build a conformant container without an account: port, path, ARM64, session affinity, idle timeout range.
- **DynamoDB Local**: the contract suite ran unchanged against it; single-table design with two GSIs covered every query.
- **Ring documentation**: per-device capability discovery instead of a model list, HMAC-signed webhooks, dated release notes, and staff who answer on the community forum.

PENDING: deployment, Strands, Knowledge Bases, live Ring events.

## Feedback Question 3: What needs work?

- **Alexa+ docs**: three pages disagree on whether a developer can start (FL-001); two pages name different OAuth metadata paths and the auth page contradicts the linked MCP revision (FL-002); the lifecycle example negotiates 2025-03-26 while the overview claims 2025-11-25 (FL-003).
- **MCP spec and SDK**: the hackathon's minimum revision and the current revision disagree on sessions, `initialize`, and elicitation (FL-005); the only SDK configuration that delivers elicitation to a v1 client is documented as "legacy preservation" and the two relevant pages do not reference each other (FL-006); the tasks extension has no runtime (FL-007).
- **AgentCore**: the CLI has no TypeScript MCP path (FL-008); the protocol contract cites a superseded MCP revision (FL-009).
- **Strands TypeScript**: v1 MCP client, no progress notifications (FL-010).
- **Ring**: early access with no request path (FL-011); staging webhooks need a support-provisioned trial (FL-012); no on-demand snapshot and Playground event types do not match the documented ones (FL-013); end-to-end encryption's effect on the API is undocumented (FL-014); two product lines share "2nd Gen" names and only one is in the API.
- **Devpost**: the prizes page 404s and office hours are not posted where the landing page says (FL-015).
- **Terraform**: S3 Vectors support for Knowledge Bases landed recently and is unverified in the pinned provider (FL-016).

## Feedback Question 4: How was your onboarding experience?

- **MCP SDK v2**: hello world to a tested five-tool server in a day; the input-required and legacy-clients pages are the ones to read first, in that order.
- **Alexa+**: no onboarding possible; the request path does not exist for an individual developer.
- **AgentCore**: documentation-only until deploy. Building to the contract from docs alone worked; the CLI would not have.
- **Ring**: developer registration with government ID [verification in progress on 2026-09-14]; the staging trial ticket adds an unknown wait before webhooks fire.
- **DynamoDB Local**: one compose file, zero friction.

PENDING: update Ring with the actual verification and ticket turnaround; add AgentCore first-deploy experience; add Strands.

## Feedback Question 5: Would you build with these devices and services again?

Yes, with conditions. The MCP TypeScript SDK v2 and DynamoDB, without reservation. AgentCore Runtime, yes, on the strength of the contract; the deployment experience will decide the rest. Ring, yes for doorbell events, which are generally available and well documented; sensors only once early access has a request path. Alexa+, yes the day the MCP Toolkit opens to individual developers, because the server built to its published contract already exists and passes the documented handshake.

PENDING: revise after deploy, Strands, and live Ring events.
