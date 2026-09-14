# Friction Log

Every entry records something that did not work the way the documentation, tooling, or program said it would, what it cost, and how HomeLedger routed around it. Entries are numbered in the order they were hit. Where a friction point drove a design decision, the decision is named so the two can be read together with the [design spec](docs/superpowers/specs/2026-09-13-homeledger-design.md).

Format per entry: **Area** · **Expected** · **Actual** · **Impact** · **Workaround / decision** · **Source** · **Status**.

## Design phase (2026-09-13)

### FL-001 · Alexa+ · MCP Toolkit access is gated, and the request path is not discoverable
- **Expected:** The MCP Toolkit quickstart reads as self-serve: install `@alexa-ai/cli`, run `alexa-ai new mcp`, deploy, test in the web simulator.
- **Actual:** The docs home says the Category SDK and MCP Toolkit are "available to select partners only." The development-stages page says "you request access to the Private Preview" and links no form. The Alexa+ for Builders landing page has no request button. An established skill developer (AnyList) reported a rejected request. The Devpost organizer wrote that entrants "will have no way to actually call Alexa+ anyway."
- **Impact:** A day of reading three pages that disagree about whether a developer can start. No way to test against the real client.
- **Workaround / decision:** Build the MCP server to the published client contract and drive it from a simulated Alexa+ web experience with our own agent, which the organizer confirmed is acceptable. Design section 1 and 7.
- **Source:** https://developer.amazon.com/docs/alexaplus/add-ons/home.html · https://developer.amazon.com/docs/alexaplus/add-ons/alexa-plus-add-on-development-stages.html · https://amazonappdev2026.devpost.com/forum_topics/45058-clarification-on-simulated-alexa-web-experience-requirements
- **Status:** Open. Asked on the Devpost forum whether hackathon entrants can get dev-stage access.

### FL-002 · Alexa+ · Authentication docs contradict each other and the MCP spec
- **Expected:** One documented location for OAuth protected-resource metadata and a spec-conformant 401.
- **Actual:** The quickstart says to host metadata at `/.well-known/oauth-authorization-server`; the account-linking page says `/.well-known/oauth-protected-resource`. The auth page says 401 responses carry no `WWW-Authenticate` header and that Dynamic Client Registration, Client ID Metadata Documents, and OIDC are all unsupported, which is the opposite of the MCP 2025-11-25 authorization guidance the hackathon links.
- **Impact:** Cannot tell which discovery path a real Alexa+ client would follow.
- **Workaround / decision:** Let AgentCore Runtime own the resource-server surface. It serves protected-resource metadata and a spec-conformant 401 with `WWW-Authenticate` on its own invocation URL, so the server code does not have to pick a side. Design section 4.5.
- **Source:** https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html · https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-account-linking.html · https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html
- **Status:** Open. Feature request filed.

### FL-003 · Alexa+ · Client lifecycle example negotiates an older protocol than the docs claim
- **Expected:** The MCP Toolkit overview says the client supports 2025-11-25 features.
- **Actual:** The lifecycle page's `initialize` example sends `protocolVersion: "2025-03-26"` with only `roots.listChanged` as a capability. Elicitation did not exist until 2025-06-18.
- **Impact:** Unclear whether a certified add-on can ever receive an elicitation request from Alexa+.
- **Workaround / decision:** Serve every generation. Modern clients get multi round-trip requests; 2025-06-18+ legacy clients get elicitation over a session; a 2025-03-26 client gets tools, resources, and prompts. Design section 4.1.
- **Source:** https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle.html · https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html
- **Status:** Open.

### FL-004 · Hackathon rules · "Agent Skill" is undefined
- **Expected:** The Alexa+ track definition ("a working Agent Skill or a self-hosted MCP server") would define the term or link a spec.
- **Actual:** The rules never define it. The resources page links the MCP Apps "Build with Agent Skills" page, which contains four `SKILL.md` folders in the agentskills.io format. Amazon's own device and Alexa+ skills use the same format.
- **Impact:** An hour of cross-referencing to decide what artifact would satisfy Stage 1.
- **Workaround / decision:** Ship a `SKILL.md` package in the agentskills.io format alongside the MCP server, and show an agent loading it. Design section 3.
- **Source:** https://amazonappdev2026.devpost.com/rules · https://apps.extensions.modelcontextprotocol.io/api/#build-with-agent-skills · https://agentskills.io/
- **Status:** Resolved by decision.

### FL-005 · MCP spec · The hackathon's minimum version and the current version disagree on fundamentals
- **Expected:** Implementing the linked 2025-11-25 Streamable HTTP page would be current.
- **Actual:** The 2026-07-28 revision removed protocol sessions and the `Mcp-Session-Id` header, removed the `initialize` handshake, replaced server-initiated elicitation with multi round-trip requests, removed SSE resumability, and moved tasks into an extension. The TypeScript SDK v2 (stable line) implements 2026-07-28; v1.x is in maintenance.
- **Impact:** A server written to the hackathon's linked pages is a legacy server on day one.
- **Workaround / decision:** SDK v2 with a modern stateless branch and a sessionful legacy branch from one server factory. Design section 4.1. Week-1 spike validates the legacy branch on AgentCore before building on it.
- **Source:** https://modelcontextprotocol.io/specification/2026-07-28/changelog · https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html
- **Status:** Resolved by decision; spike pending.

### FL-006 · MCP TypeScript SDK · Sessionful legacy support is documented as a compatibility posture, not a path
- **Expected:** A documented way to serve legacy clients with sessions and server-initiated elicitation.
- **Actual:** The legacy-clients page presents `legacy: 'stateless'` (no sessions, `GET` and `DELETE` answer 405) and `legacy: 'reject'`. Keeping sessions means routing with `isLegacyRequest` to a hand-wired `NodeStreamableHTTPServerTransport` with `sessionIdGenerator`, described as a way to "preserve existing sessionful 2025 deployments." The input-required page separately says the legacy shim pushes real elicitation "over the session." The two pages do not reference each other.
- **Impact:** The only configuration in which Strands (a v1 client) receives elicitation is the one the docs treat as legacy-preservation.
- **Workaround / decision:** Use it anyway, with contract tests driving both the v2 and v1 clients. Fallback to SDK v1.x if the spike fails. Design section 9 and 12.
- **Source:** https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html · https://ts.sdk.modelcontextprotocol.io/v2/servers/input-required.html
- **Status:** Open; spike pending.

### FL-007 · MCP tasks extension · Specified, no runtime
- **Expected:** The 2025-11-25 experimental tasks feature, or its extension successor, would be usable for a long-running booking demo.
- **Actual:** Tasks moved to the `io.modelcontextprotocol/tasks` extension in July 2026 and no language SDK provides a runtime yet.
- **Impact:** Dropped the "long-running task" showcase; replaced with elicitation plus progress notifications.
- **Workaround / decision:** Out of scope for v1. Design section 1, non-goals.
- **Source:** https://modelcontextprotocol.io/extensions/tasks/overview · https://github.com/modelcontextprotocol/ext-tasks
- **Status:** Resolved by decision.

### FL-008 · AgentCore CLI · TypeScript scaffolding does not cover the MCP protocol
- **Expected:** `agentcore add agent --language TypeScript --protocol MCP` would scaffold a Node MCP server, since the CLI itself is an npm package.
- **Actual:** The frameworks doc restricts TypeScript to the Strands and VercelAI frameworks, and every MCP example is Python with FastMCP. Bring-your-own-container is not described in the CLI docs.
- **Impact:** No first-party path from a TypeScript MCP server to AgentCore Runtime through the CLI.
- **Workaround / decision:** Deploy through Terraform's `aws_bedrockagentcore_agent_runtime` with an ARM64 image in ECR and `server_protocol = "MCP"`. Design section 8.
- **Source:** https://github.com/aws/agentcore-cli/blob/main/docs/frameworks.md · https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp.html · https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime
- **Status:** Resolved by decision. Feature request filed.

### FL-009 · AgentCore Runtime · Protocol contract references a superseded MCP revision
- **Expected:** The MCP protocol contract page would describe the current wire protocol.
- **Actual:** The contract and the stateful-features guide link the 2025-11-25 and 2025-03-26 spec pages and center on `Mcp-Session-Id`, which the current revision removed. A tip acknowledges MRTR for 2026-07-28 but every example is session-based.
- **Impact:** Had to reconcile three documents to decide stateful versus stateless.
- **Workaround / decision:** Stateful mode, since the legacy branch needs an open session and the platform pins sessions to a microVM. Idle timeout raised to 30 minutes for elicitation waits. Design section 4.1 and 8.
- **Source:** https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp-protocol-contract.html · https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/mcp-stateful-features.html
- **Status:** Resolved by decision.

### FL-010 · Strands TypeScript · MCP client is a v1 client with no progress notifications
- **Expected:** The current Strands TypeScript SDK would consume a current MCP server and surface progress.
- **Actual:** `@strands-agents/sdk` 1.17.0 peer-depends on `@modelcontextprotocol/sdk` ^1.25 (the 2025-era client). Its MCP docs state progress notifications are not yet supported.
- **Impact:** Strands cannot see multi round-trip results; it needs the legacy branch. Progress cannot reach the UI through Strands.
- **Workaround / decision:** Legacy branch serves Strands; a thin transport wrapper taps notifications for the simulator's debug drawer; MCP Inspector demonstrates progress natively. Design section 7.
- **Source:** https://registry.npmjs.org/@strands-agents/sdk/latest · https://strandsagents.com/docs/user-guide/concepts/tools/mcp-tools/
- **Status:** Open. Feature request filed.

### FL-011 · Ring · Early-access programs have no documented request path
- **Expected:** The release notes announcing sensor support and dynamic scopes (Aug 24) would say how to request early access.
- **Actual:** "Available through the Ring Developer Early Access Program" with no form, email, console toggle, or thread. Partner-initiated OAuth is "by invitation only" with no process. The community announcement threads do not mention it either.
- **Impact:** Sensor events, which the Ring track's home-automation priority points at, cannot be planned with confidence.
- **Workaround / decision:** Doorbell events (generally available) carry the critical path; sensors sit behind a feature flag with replayed fixtures. Design section 6.3.
- **Source:** https://developer.amazon.com/docs/ring/release-notes.html · https://community.amazondeveloper.com/t/more-updates-for-ring-developers/28933
- **Status:** Open. Asked on the Ring developer community.

### FL-012 · Ring · Staging webhooks require a support-provisioned trial
- **Expected:** A staging app with a linked test account would receive motion webhooks.
- **Actual:** Community thread confirms `motion_detected` never fires and history returns 403 until a Protect trial is manually provisioned by support ticket; Ring staff call it a known gap.
- **Impact:** Adds a ticket and unknown lead time to the critical path.
- **Workaround / decision:** Ticket filed on day one; develop against the Playground's simulated events meanwhile. Design section 6.1 and 11.
- **Source:** https://community.amazondeveloper.com/t/issue-testing-staging-app-with-motion-events/28731
- **Status:** Open; ticket filed.

### FL-013 · Ring · No on-demand snapshot, and Playground events do not match documented webhook types
- **Expected:** A "who is at the door" flow could request a current frame when an event arrives.
- **Actual:** Snapshots come only from recordings (`at_timestamp` or `latest_in_range`); a forum thread confirms there is no live-snapshot API. The Playground simulates "Package" events, but the documented `motion_detected.sub_type` values are `motion`, `human`, `vehicle`, `other_motion`; no package sub-type is documented.
- **Impact:** A few seconds of lag between event and image; fixtures recorded from the Playground may not match production payloads.
- **Workaround / decision:** Correlator waits 5 s then requests `latest_in_range`; fixtures are re-recorded from staging once the trial is provisioned. Design section 6.3.
- **Source:** https://community.amazondeveloper.com/t/obtaining-a-camera-snapshot/28387 · https://developer.amazon.com/docs/ring/api-documentation.html
- **Status:** Open.

### FL-014 · Ring · TAKE encryption's effect on the Partner API is undocumented
- **Expected:** The end-to-end encryption announcement would state what partner apps lose.
- **Actual:** Amazon's developer news says TAKE "limits what integrations can access" without naming endpoints or behavior.
- **Impact:** Cannot tell in advance whether the demo doorbell will serve snapshots and clips.
- **Workaround / decision:** Verify the setting on the demo device in week 1 and keep TAKE off for the demo account. Design section 6.5 and 12.
- **Source:** https://community.amazondeveloper.com/t/aug-31-2026-hackathon-ring-updates/29048
- **Status:** Open.

### FL-015 · Devpost · Prize details page returns 404; office hours schedule absent
- **Expected:** `/details/prizes` and a posted office-hours schedule, both referenced on the landing page.
- **Actual:** The prizes URL returns 404; prizes are only in the rules. The landing page says office hours are "posted on the hackathon landing page" and none are listed. The Alexa+ Store page returned 503 during research.
- **Impact:** Minor; time spent hunting.
- **Workaround / decision:** Rules page is the source of truth; updates feed and Discord for sessions.
- **Source:** https://amazonappdev2026.devpost.com/rules · https://amazonappdev2026.devpost.com/updates
- **Status:** Reported.

### FL-016 · Terraform · S3 Vectors support for Knowledge Bases is recent and unverified in the pinned provider
- **Expected:** `aws_bedrockagent_knowledge_base` with `storage_configuration.type = "S3_VECTORS"` in the current provider.
- **Actual:** Support arrived through a recent pull request; native S3 Vectors bucket and index resources may lag.
- **Impact:** Possible one-time manual step for the vector index.
- **Workaround / decision:** Pin the provider in week 1; fall back to the AWSCC provider or a documented CLI step. Design section 8.
- **Source:** https://github.com/hashicorp/terraform-provider-aws/pull/45468 · https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-bedrock-kb.html
- **Status:** Open; verify in week 1.

## Build phase (2026-09-13 – 2026-09-14)

### FL-017 · MCP SDK · Elicitation spike confirms architecture A with no code changes from the documented shape
- **Expected:** A multi round-trip tool handler written once against `@modelcontextprotocol/server` (`inputRequired`/`acceptedContent`, keyed off `ctx.mcpReq.inputResponses`) would deliver `elicitation/create` to a 2026-07-28 client directly, and the SDK's documented legacy shim would deliver the same request to a 2025-era client over its `NodeStreamableHTTPServerTransport` session, without any transport- or era-specific handler code.
- **Actual:** Confirmed on both generations on the first run, with the `dev.ts`/`server.ts` code exactly as drafted (no fallback to the JSON-Schema `requestedSchema` form, no `ctx.mcpReq` field-name correction). The modern test drives `echo_confirm` through `StreamableHTTPClientTransport` from `@modelcontextprotocol/client` with `client.setRequestHandler('elicitation/create', ...)` and gets one `elicitation/create` round trip per call, matching `inputRequired.maxRounds: 3`. The legacy test drives the same tool through `createApp`'s session-based route (`src/legacy.ts`, `NodeStreamableHTTPServerTransport`) using `@modelcontextprotocol/sdk` 1.30.0's `Client` and `ElicitRequestSchema`, and the server-side default-on legacy shim (`ServerOptions.inputRequired.legacyShim`, default `true`) converted the same `inputRequired(...)` return into a real server→client `elicitation/create` request over the session, re-entering the handler with the answer on retry — with zero legacy-aware code in `dev.ts`. Versions: `@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/client` 2.0.0, `@modelcontextprotocol/sdk` 1.30.0 (`pnpm ls @modelcontextprotocol/server @modelcontextprotocol/sdk`).
- **Impact:** None — this is the positive result the whole Plan 1 architecture (and Plan 2's `book_service`) is staked on: one handler, one code path, both client generations, including decline handling (no re-ask) and the `devTools` gate.
- **Workaround / decision:** None needed. Architecture A stands as designed; no addendum task to build a v1-flavoured `server-v1.ts` fallback (architecture C) is opened.
- **Source:** `apps/mcp-server/src/tools/dev.ts` · `apps/mcp-server/test/elicit-modern.test.ts` · `apps/mcp-server/test/elicit-legacy.test.ts` · `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts` (`ServerOptions.inputRequired`, `inputRequired`, `acceptedContent`) · `node_modules/@modelcontextprotocol/client/dist/index.d.mts` (`ClientOptions.inputRequired`, `.versionNegotiation`)
- **Status:** Resolved. Spike passed; no further action.

### FL-018 · Terraform CLI · `output -raw` exits 0 with a warning when the state has zero outputs, not just when one output is missing
- **Expected:** The deploy workflow's bootstrap guard, `if ! terraform output -raw ecr_repository_url >/dev/null 2>&1; then <targeted apply>; fi`, would fail (non-zero exit) on a brand-new state that has never been applied, so the guard's `then` branch would run and create the ECR repository the image build depends on.
- **Actual:** On a state with zero outputs defined at all (nothing has ever been applied), `terraform output -raw NAME` prints `Warning: No outputs found` to stderr and exits **0**, the same as a successful lookup — it does not exit non-zero the way it does when the state has *other* outputs but not the named one. Run 34882037117 hit exactly this: the guard's condition was true (`>/dev/null 2>&1` succeeded), so the bootstrap `terraform apply -target=aws_ecr_repository.mcp ...` was skipped entirely. Nothing was created — no ECR repository, no state object, no table. The next step, `REPO=$(terraform -chdir=infra/live/demo/platform output -raw ecr_repository_url)`, then also printed the same warning and captured an empty string, and `scripts/build-image.sh` failed immediately with `line 3: 1: usage` because `REPO_URL="${1:?usage: build-image.sh <ecr-repo-url> [tag]}"` saw an empty positional argument.
- **Impact:** The entire first deploy run failed at "Build and push image" before any AWS resource existed; the apply job never reached `terraform apply` for the full plan.
- **Workaround / decision:** Replaced the exit-code guard with a state-membership check, `if ! terraform state list 2>/dev/null | grep -qx 'aws_ecr_repository.mcp'; then <targeted apply>; fi`, which only depends on whether the resource is actually in state and is unaffected by `output`'s exit-code behavior. Also set `terraform_wrapper: false` on every `hashicorp/setup-terraform@v3` step in `deploy.yml` so later `$(terraform output -raw ...)` captures (image repo URL, invocation URL, Cognito values) are reading Terraform's own stdout directly rather than through the wrapper's JSON-log proxy.
- **Source:** https://github.com/jkarns87/homeledger/actions/runs/34882037117 · https://developer.hashicorp.com/terraform/cli/commands/output
- **Status:** Resolved.

### FL-019 · AWS account · Bedrock reported suspended after new-account verification failed
- **Expected:** After account creation on 2026-09-14 and the morning's verification hold clearing (first invocations of Claude Sonnet 4.6, Nova Lite, and Titan Embeddings v2 all succeeded that afternoon), Bedrock would stay available for the hackathon build.
- **Actual:** AWS notified that new-account verification failed and that Bedrock was suspended on account 941017931824 the same day. Support case 178941623300459 was opened at 2026-09-14T20:03Z as the root user under Account → Other Account Issues; the Basic support plan only allows severity "General question", so no expedited path exists. At about 20:15Z, root-session checks still returned completions from `us.amazon.nova-lite-v1:0` and `us.anthropic.claude-sonnet-4-6`, and the AgentCore control plane listed runtime `demo_homeledger_mcp` as READY, so the scope or timing of the suspension is unclear from the API side. At about 20:35Z the same checks run from GitHub Actions as the OIDC deploy role (run 34894134737) also succeeded for both models and listed the runtime READY, so no principal was observed blocked at that time.
- **Impact:** The Plan 1 deploy-and-smoke loop is paused by decision. Submissions close 2026-10-23 and judging runs 2026-11-09 to 2026-11-20; an unresolved case blocks both the demo video and the judging window.
- **Workaround / decision:** Pause AgentCore and model work; keep DynamoDB, ECR, Cognito, S3, and IAM work moving (all unaffected). Resume when the case resolves and a `bedrock-runtime converse` call succeeds again. If the case stalls past 48 hours, write to aws-verification@amazon.com, the address AWS's own verification error names. The runtime only needs to be live during test windows and the judging period, so it can be torn down between them with `image_uri = ""`.
- **Source:** AWS Support case 178941623300459 · https://github.com/jkarns87/homeledger/actions/runs/34890188789 (smoke run during the report)
- **Status:** Open.

### FL-020 · AgentCore Runtime · The Host header the platform forwards is undocumented, and the server's host allowlist rejects it
- **Expected:** The MCP protocol contract says the container listens on `0.0.0.0:8000/mcp`. Either the platform's requests would carry a Host the SDK's default allowlist accepts (`localhost`, `127.0.0.1`, `0.0.0.0`), or the contract would name the Host value a server must allow.
- **Actual:** With a valid Cognito token, every request through the invocation URL returns JSON-RPC `-32010 Received error (403) from runtime. Please check your CloudWatch logs`, and the runtime log shows only clean `listening` lines because the SDK rejects without logging. Locally, the same server answers `403 {"code":-32000,"message":"Invalid Host: <host>"}` to any Host outside `ALLOWED_HOSTS`, so the platform forwards a Host value the allowlist does not contain. The contract page does not state what Host AgentCore sends.
- **Impact:** Smoke run 34890188789 failed at the first `tools/list`; no tool call has completed through AgentCore yet, although the runtime deployed and reached READY on the first successful apply (run 34883140640).
- **Workaround / decision:** Add the invocation host `bedrock-agentcore.us-east-1.amazonaws.com` to the runtime's `ALLOWED_HOSTS` (the `allowed_hosts` variable in `infra/live/demo/platform`) and re-apply; if still rejected, log `req.headers.host` on rejection once and allow what is observed. The JWT authorizer already gates access, so widening the allowlist for the deployed runtime does not weaken DNS-rebinding protection for local runs, which keep the default. Paused behind FL-019.
- **Source:** https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-mcp-protocol-contract.html · https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html · https://github.com/jkarns87/homeledger/actions/runs/34890188789
- **Status:** Open.
