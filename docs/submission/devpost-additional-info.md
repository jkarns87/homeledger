# HomeLedger — Devpost "Additional info" answers

Same rule as the story: text above each field's `PENDING` note is true today and can be pasted. Pending additions are listed under the field with what verifies them.

Last verified: 2026-09-18 (branch `docs-devpost-plan-2`, Plan 2 merged as `f258d46`; deployed runtime smoke green, run 35292750115)

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
| Project Testing Link | PENDING: simulator URL after Amplify deploy. Not built in Plan 2 and deferred to a later plan; the simulator's Strands agent needs Bedrock model access, which is blocked account-wide (FL-019, FL-032). |
| Upload a File | (none) |
| Three eligibility checkboxes | Check all three |

---

## AWS Builder Mini Challenge: Which AWS services did you incorporate and how?

HomeLedger is a self-hosted MCP server whose home is Amazon Bedrock AgentCore Runtime. AWS services in the repository today, with where each integration lives:

**Amazon DynamoDB.** The household record is one table: partition key per household, sort keys per entity (`APPL#`, `MAINT#`, `LOG#`, `VISIT#`, `EVENT#`, `ALERT#`, `DEVICE#`), GSI1 for "what maintenance is due" ordered by due date, GSI2 for "what visits are scheduled" ordered by window start. Access is through the AWS SDK for JavaScript v3 (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`) behind a repository interface. The implementation is `packages/core/src/repo/dynamo.ts`, the table definition with both GSIs is `packages/core/src/repo/table.ts`, and a seed script populates a household. The same contract test suite runs against the in-memory twin and against DynamoDB Local (`docker-compose.yml`), so every tool handler is exercised against real DynamoDB query semantics.

**Amazon Bedrock AgentCore Runtime.** The server runs on AgentCore Runtime in stateful mode (`server_protocol = "MCP"`, `idle_runtime_session_timeout = 1800`) as a `linux/arm64` image (`apps/mcp-server/Dockerfile`) listening on `0.0.0.0:8000/mcp` as a non-root user, behind AgentCore's custom JWT authorizer. Legacy 2025-era clients get an `Mcp-Session-Id` and a per-session transport, which is safe because AgentCore pins a session to one microVM. `scripts/smoke.ts`, run by `.github/workflows/smoke.yml`, drives the invocation URL with both a 2026-07-28 client and a 2025-era client: it asserts the frozen nine-tool order and the `ui://` widget wiring on all five widget-backed tools, and completes both a single-round elicitation (`echo_confirm`) and a three-round one with progress notifications (`book_service`, which books a real visit) through the shim on the deployed runtime. Two findings from that work are in `FRICTION-LOG.md`: AgentCore forwards an internal cell-specific `Host` header rather than the invocation host (FL-020), and legacy `DELETE` session termination routes to a fresh microVM (FL-022).

**Amazon Cognito and AWS Secrets Manager.** A Cognito user pool is the JWT issuer: resource server `homeledger` with scope `homeledger/mcp` and one client-credentials app client (`infra/modules/cognito-m2m`). The client secret is written to Secrets Manager through Terraform's write-only argument so it never round-trips through the secret resource's state.

**Amazon S3, Amazon S3 Vectors, and Amazon Bedrock Knowledge Bases — provisioned for real, and unusable, and those are not the same thing.** `infra/modules/knowledge-base` creates a versioned, encrypted, public-access-blocked manuals bucket, an S3 Vectors vector bucket and index (cosine, float32), a Bedrock Knowledge Base with `storage_configuration.type = "S3_VECTORS"` and Titan Text Embeddings v2, an S3 data source scoped to `manuals/<householdId>/`, and a least-privilege IAM role. All of it was created cleanly by the first post-merge deploy, and `scripts/manuals.ts` uploads each PDF plus a `.metadata.json` sidecar to real S3 successfully. `packages/core/src/retrieval/bedrock.ts` calls `Retrieve` through `@aws-sdk/client-bedrock-agent-runtime` with an `equals` filter on `applianceId`. What has never happened is embedding: Bedrock model invocation is blocked account-wide on this account, so `StartIngestionJob` is refused, and — the finding worth reading, FL-032 — so is `Retrieve`, because retrieval embeds the query as well as the documents. The Knowledge Base is provisioned, addressable, wired into the runtime, and cannot be used in either direction. `ask_manual` is deployed and reachable and has never returned a real passage.

**Amazon ECR, Terraform, and GitHub Actions.** ECR holds the image by commit SHA. Everything is Terraform: a root for the demo environment (`infra/live/demo/platform`) and reusable modules for the runtime, the issuer, and the Knowledge Base, each with plan-time tests against a mocked provider. GitHub Actions assumes an OIDC role (no long-lived keys), plans on pull requests, and on merge builds the ARM64 image, pushes it, and applies (`.github/workflows/deploy.yml`).

PENDING (each with what verifies it; move up when that happens):
- Bedrock model access: "Titan Text Embeddings v2 indexes appliance manuals from S3 and `ask_manual` returns real passages with page numbers." Verified only by a smoke run where the `ask_manual` check enforces instead of printing `SKIPPED`. The infrastructure claim above is already true and is a different claim.
- A later plan: "Strands Agents SDK (TypeScript) on Amazon Bedrock is the simulator's agent and the MCP client to the server; it exercises the legacy branch and elicitation through `elicitationCallback`." "AWS Amplify Hosting serves the Next.js simulator." Not built in Plan 2; also blocked on Bedrock model access.
- Plan 3: "AWS Lambda (Node 22, arm64) receives Ring webhooks behind an API Gateway HTTP API, verifies HMAC, and publishes to an Amazon EventBridge bus; rule-targeted Lambdas correlate visits, fetch snapshots to S3, describe them with Amazon Nova, and push cards over an API Gateway WebSocket API. AWS Secrets Manager holds Ring tokens, the webhook secret, and the Cognito client secret. CloudWatch Logs with retention for every function and the runtime."
- Load smoke: "Measured p95 under [N] s through AgentCore cold across 20 sequential calls."

---

## Open Source Mini Challenge: what you did, how it works, why it matters

**What.** HomeLedger is a new public repository, MIT licensed, created on 2026-09-13 inside the hackathon window. It is a Streamable HTTP MCP server in TypeScript with a pnpm monorepo: `packages/core` (domain schemas, DynamoDB single-table repository with an in-memory twin and a shared contract suite, the Bedrock retrieval adapter), `apps/mcp-server` (the server, nine tools, resources, four MCP Apps widgets, prompt, container), and `scripts` (deployed smoke, seeding, manuals ingestion).

**How it works.** One server factory registers every tool, resource, and prompt. Two transport branches share it behind a single `/mcp` route: current 2026-07-28 clients are served statelessly with multi round-trip `input_required` results; 2025-era clients (the handshake the Alexa+ MCP Toolkit documents) are detected by their `initialize` call or `Mcp-Session-Id` header and routed to per-session transports, where the SDK's legacy shim delivers real `elicitation/create` requests. Handlers are written once, including `book_service`'s three-round booking with progress notifications, which carries its cross-round state in the SDK's signed `requestState` rather than in server memory. Contract tests drive both branches with the v2 client and the v1.x client over a real socket, and the deployed smoke drives both against AgentCore.

The four `ui://` MCP Apps widgets are single-file HTML resources with a hand-written view-side bridge, written against the wire protocol published by `@modelcontextprotocol/ext-apps` because the package's view SDK is not self-contained and its dependency-inclusive bundle is 418 KB (FL-029). That bridge is a small, reusable worked example of the host/view contract for anyone shipping widgets without a bundler.

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
13. **Bedrock Knowledge Bases: report operational readiness, not just provisioning status.** A Knowledge Base created under an account-level model block is returned as a normal, healthy resource by every control-plane API, and `terraform apply` is green — but it can neither ingest nor be queried, because `Retrieve` embeds the query as well as the documents. There is no way to ask "can this Knowledge Base actually embed?" short of running an ingestion job or a retrieval and reading the error. Expose that as a status, so infrastructure-as-code and health checks can model provisioned-but-unusable instead of inferring it from a 400. Priority: Important. (FL-032)
14. **MCP Apps SDK: publish a dependency-free view bundle for single-file `ui://` resources.** The spec's own model is one self-contained HTML resource per widget, but the view SDK's browser entry imports from two other packages and the package's bundled build is 418 KB, so a single-file widget needs either a per-widget bundler step or a hand-written bridge against the wire protocol. A small standalone build would close the gap between the recommended resource shape and the shipped SDK. Priority: Important. (FL-029)
15. **AWS Support: let an account read its own case status on the Basic plan.** The Support API requires Business or Enterprise, so an account blocked by new-account verification — precisely the population most likely to hit it — can verify the symptom from CI indefinitely but must open the console to learn whether the cause has moved. A read-only `describe-cases` for one's own cases would make the loop automatable. Priority: Nice-to-have. (FL-019)

---

## Feedback Question 1: Which developer tools, APIs, and SDKs did you use and for what?

- **MCP TypeScript SDK v2** (`@modelcontextprotocol/server`, `/node`, `/express`, `/client` 2.0.0): the server, both transport branches, and the modern-client contract tests.
- **MCP TypeScript SDK v1.x** (`@modelcontextprotocol/sdk` 1.30.0): the legacy-client contract tests that stand in for the Alexa+ client and for Strands.
- **Alexa+ MCP Toolkit documentation**: the client contract the server is built to (handshake, session header, functional requirements for voice output). No toolkit access; it is a private preview.
- **Amazon Bedrock AgentCore Runtime documentation and CLI**: the MCP protocol contract the container is built to; the CLI was evaluated for TypeScript MCP scaffolding.
- **MCP Apps extension (`@modelcontextprotocol/ext-apps` 2.0.0)**: the `ui://` resource contract — mime type and `_meta` key on the server side, and the host/view wire protocol the hand-written widget bridge implements.
- **AWS SDK for JavaScript v3 and DynamoDB Local**: the household repository and its tests (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`); `@aws-sdk/client-bedrock-agent-runtime` for `Retrieve`; `@aws-sdk/client-bedrock-agent` and `@aws-sdk/client-s3` for manuals upload and ingestion.
- **Terraform AWS provider 6.64.0**: the AgentCore runtime, the Cognito issuer, and the S3 Vectors + Bedrock Knowledge Base module, with `terraform test` plan-time suites against mocked providers.
- **Ring Partner API documentation and developer community**: event model, snapshot semantics, the sensor device family; developer registration and the staging trial ticket.
- **Devpost**: registration, forum clarification with the organizer.

PENDING: Strands Agents SDK, Amazon Bedrock model invocation (blocked account-wide), real Knowledge Base retrieval, Ring Partner API (live), Amplify Hosting.

## Feedback Question 2: What worked well?

- **MCP SDK v2**: the legacy shim delivered `elicitation/create` over a `NodeStreamableHTTPServerTransport` session to the v1.30.0 client with zero changes from the documented code. Every option and signature we relied on (`createMcpExpressApp` host validation, `toNodeHandler`, `createMcpHandler` with `legacy: 'reject'`, `acceptedContent` with a Zod schema, `inputRequired.elicit`) matched the shipped type definitions. In-process testing through `handler.fetch` made contract tests fast. It held under load: the three-round `book_service` handler and its signed `requestState` codec matched the documented shape with no fallbacks (FL-024), and drove cleanly through a real socket to the v1.x client unchanged (FL-025).
- **AgentCore MCP contract and the deploy itself**: the contract was precise enough to build a conformant container without an account — port, path, ARM64, session affinity, idle timeout range — and the container it produced ran on the first deploy. Everything since has been through GitHub Actions with no local AWS credentials; both elicitation branches, progress notifications, and the widget `_meta` survive the trip through the platform intact.
- **Terraform AWS provider**: S3 Vectors and Bedrock Knowledge Base resources are present natively in 6.64.0 with the block nesting we needed, and applied first try — no `awscc` fallback, no `null_resource` (FL-016, FL-027). Four attribute names differed from what we expected, all caught offline by `terraform test`.
- **DynamoDB Local**: the contract suite ran unchanged against it; single-table design with two GSIs covered every query.
- **Ring documentation**: per-device capability discovery instead of a model list, HMAC-signed webhooks, dated release notes, and staff who answer on the community forum.

PENDING: Strands, real Knowledge Base retrieval, live Ring events.

## Feedback Question 3: What needs work?

- **Alexa+ docs**: three pages disagree on whether a developer can start (FL-001); two pages name different OAuth metadata paths and the auth page contradicts the linked MCP revision (FL-002); the lifecycle example negotiates 2025-03-26 while the overview claims 2025-11-25 (FL-003).
- **MCP spec and SDK**: the hackathon's minimum revision and the current revision disagree on sessions, `initialize`, and elicitation (FL-005); the only SDK configuration that delivers elicitation to a v1 client is documented as "legacy preservation" and the two relevant pages do not reference each other (FL-006); the tasks extension has no runtime (FL-007).
- **AgentCore**: the CLI has no TypeScript MCP path (FL-008); the protocol contract cites a superseded MCP revision (FL-009).
- **Strands TypeScript**: v1 MCP client, no progress notifications (FL-010).
- **Ring**: early access with no request path (FL-011); staging webhooks need a support-provisioned trial (FL-012); no on-demand snapshot and Playground event types do not match the documented ones (FL-013); end-to-end encryption's effect on the API is undocumented (FL-014); two product lines share "2nd Gen" names and only one is in the API.
- **Devpost**: the prizes page 404s and office hours are not posted where the landing page says (FL-015).
- **Bedrock Knowledge Bases**: a Knowledge Base provisioned under an account-level model block cannot ingest *or* be queried — `Retrieve` embeds the query as well as the documents — yet every control-plane API and `terraform apply` report it healthy, so there is no way to distinguish provisioned from usable without triggering the failure (FL-032). Separately, the `applianceId` metadata filter key is never an exported constant and the reserved `x-amz-bedrock-kb-*` fields' behaviour took a documentation hunt to pin down (FL-028).
- **MCP Apps SDK**: the view SDK cannot be inlined into a single-file `ui://` resource without a bundler, which is the resource shape the spec itself recommends (FL-029); and the modern client's own multi-round-trip driver shares the `onprogress` sink with the tool's progress notifications, so a caller has to filter its own scaffolding out of the stream (FL-026).
- **AWS account and Support**: new-account verification failed after Bedrock had already been working, blocking model invocation account-wide, and case status is unreadable via the Support API on a Basic plan. The case was then closed on the grounds that a hackathon project should fit inside the beginner quota — a quota answer to an access problem. The two are distinguishable from the error alone: a quota throttles a permitted call and returns `ThrottlingException` or `ServiceQuotaExceededException`, while this account returns `ValidationException ... Error 002: Access to Bedrock models is not allowed for this account` to every principal that asks, including a Bedrock service role invoking an embedding model on the account's behalf. Triage that reads the error shape would not have routed it to a quota answer (FL-019).
- **Terraform CLI**: `output -raw` exits 0 with a warning against a state with zero outputs rather than failing, so a "create it if the output is missing" guard silently never fires (FL-018). S3 Vectors and Knowledge Base support itself was fine — FL-016's worry did not materialise, and that line has been removed rather than left standing.

## Feedback Question 4: How was your onboarding experience?

- **MCP SDK v2**: hello world to a tested five-tool server in a day; the input-required and legacy-clients pages are the ones to read first, in that order.
- **Alexa+**: no onboarding possible; the request path does not exist for an individual developer.
- **AgentCore**: documentation-only until deploy. Building to the contract from docs alone worked; the CLI would not have. The first deploy then cost three findings the docs do not carry — the forwarded `Host` header is internal and cell-specific (FL-020), legacy `DELETE` session termination does not reliably reach the microVM holding the session (FL-022), and the stateful-versus-stateless decision took three documents to reconcile (FL-009). None was hard to fix; all three were invisible before the first real invocation.
- **MCP Apps**: the server half is two constants and a `_meta` key, and was working in minutes. The view half required reading the package's own schema and transport source, because the shipped SDK does not fit the single-file resource shape the spec recommends (FL-029).
- **Ring**: developer registration with government ID [verification in progress on 2026-09-14]; the staging trial ticket adds an unknown wait before webhooks fire.
- **DynamoDB Local**: one compose file, zero friction.

PENDING: update Ring with the actual verification and ticket turnaround; add Strands.

## Feedback Question 5: Would you build with these devices and services again?

Yes, with conditions. The MCP TypeScript SDK v2 and DynamoDB, without reservation. AgentCore Runtime, yes — it is deployed, it has served both protocol generations including three-round elicitation and progress notifications through a real session, and the whole build has run through CI with no local credentials. Bedrock Knowledge Bases, unproven here and therefore no opinion worth giving: the infrastructure applied first try, and I have never seen it answer a query. Ring, yes for doorbell events, which are generally available and well documented; sensors only once early access has a request path. Alexa+, yes the day the MCP Toolkit opens to individual developers, because the server built to its published contract already exists and passes the documented handshake.

PENDING: revise after Strands, real retrieval, and live Ring events.
