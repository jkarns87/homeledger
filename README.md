# HomeLedger

The household's operating record, exposed to an assistant through an MCP server.
Built for the Build, Ship, Shape: Amazon Developer Hackathon (Alexa+ and Ring tracks, AWS Builder mini-challenge).

- **Runbook: [`docs/RUNBOOK.md`](docs/RUNBOOK.md)** — fresh clone to a deployed system you can talk to, and back down to zero cost. Start there if you want a sequence to follow rather than a description of what exists; its section 4 is the fastest path to a running server and needs no AWS account.
- Design: `docs/superpowers/specs/2026-09-13-homeledger-design.md`
- Friction log: `FRICTION-LOG.md`

## Prerequisites

Node 22 and pnpm 10 for everything. Docker for the local DynamoDB and the container build. AWS CLI v2 to sign in, which you need only for "Deployed, through the bridge" below.

Terraform >= 1.10 is listed for completeness and **you do not need it installed to run, test, or connect to anything here.** Every apply happens in GitHub Actions, and `infra/live/demo/platform` declares an empty `backend "s3" {}` whose bucket and region are supplied as `-backend-config` flags by `.github/workflows/deploy.yml` — so a local `terraform init` in that root does not work and is not meant to.

## What the server exposes

Nine tools, in a fixed order that is frozen after the first deploy:

| Tool | Does | Widget |
|---|---|---|
| `list_appliances` | Every appliance, filterable by room or category | `ui://homeledger/appliances` |
| `get_appliance` | One appliance with its maintenance tasks and the manual on file, if any | `ui://homeledger/appliance` |
| `maintenance_due` | What is overdue or due inside a horizon | `ui://homeledger/calendar` |
| `log_maintenance` | Records a completed task, advances the next due date | none |
| `recent_events` | Visits, door events, and sensor alerts | none |
| `ask_manual` | Up to three manual passages with page numbers | none |
| `book_service` | Books a visit: provider, window, confirmation | `ui://homeledger/visit` |
| `get_visit` | One visit, with snapshot and description fields reserved for the Ring pipeline | `ui://homeledger/visit` |
| `echo_confirm` | Development-only elicitation probe, `HOMELEDGER_DEV_TOOLS=1` | none |

Eight of the nine register unconditionally; `echo_confirm` registers only under `HOMELEDGER_DEV_TOOLS=1`.

**The deployed demo runtime sets `HOMELEDGER_DEV_TOOLS=1` deliberately, so `echo_confirm` is visible to anyone who lists tools against it.** That is a decision, not an oversight, and it was re-examined once a person rather than a smoke script started listing the tools. Three reasons it stays on. The environment is explicitly a demo behind a Cognito JWT authorizer, not production — there is no user data in it to protect and no one reaches it unauthenticated. `scripts/smoke.ts` uses `echo_confirm` as its cheap single-round elicitation probe against the live endpoint, so removing it would cost a real assertion about the 2025-era elicitation path. And the tool order above is frozen after the first deploy, a claim this README makes and the smoke enforces, so dropping the ninth entry post-deploy would contradict it. The tool's own `description` says it is development-only, so a client listing tools sees that without reading this file. If this server is ever deployed anywhere that is not a demo, set `dev_tools_enabled = false` there and re-cut the frozen order at the same time.

Three JSON resources (`homeledger://household`, `homeledger://appliances`, `homeledger://maintenance/schedule`), four `ui://` MCP Apps widgets, and one prompt (`seasonal-checklist`).

`ask_manual` returns source passages only and never composes an answer; the client model reads `structuredContent.passages` and writes the reply, citing the document title and page. `book_service` asks three questions through MCP elicitation — provider, arrival window, confirmation — and emits progress `0` to `3` while it checks availability. `book_service` and `echo_confirm` are the two tools that use elicitation, and both work on a 2026-07-28 client through multi round-trip requests and on a 2025-era client through the SDK's legacy shim over a session. A client that declares no elicitation capability gets a spoken refusal from `book_service` saying booking needs an app that can prompt, not a protocol error and not a booking made without asking — this is the common case, since Claude Code gates elicitation behind a remote feature flag that defaults off (FL-033).

`get_visit` returns `snapshotUrl` and `description` as always-present, always-nullable keys. `snapshotUrl` is hard-coded `null` today and `description` is null on every visit `book_service` writes; both wait on the Ring pipeline described under "Not yet built" below.

## Simulated data disclosure

This section is the complete accounting of what in HomeLedger is not real: two things are simulated by design, and three more are not built yet.

**1. The service-provider marketplace is sample data.** The companies, ratings, and phone numbers in `packages/core/src/marketplace/providers.ts` are invented, the availability windows are generated rather than queried, and no booking leaves this system. `book_service` writes a `VISIT#` row in DynamoDB and nothing else. Every provider row carries a required `sample: true` field so the fixture cannot be mistaken for a live feed.

**2. Nothing here talks to Alexa+.** The Alexa+ MCP Toolkit is in private preview and entrants cannot call Alexa+. The Alexa+ client generation is stood in for by a 2025-era MCP client (`@modelcontextprotocol/sdk` 1.30.0) in the contract tests and in the deployed smoke run, which is what exercises the legacy session branch and the elicitation shim.

Real today: appliances, warranties, and maintenance history are the author's own household (`packages/core/src/seed/household.ts`), stored in DynamoDB and served by the deployed AgentCore runtime behind Cognito.

**Not yet built — do not read these as working features:**

- **Manual retrieval against Bedrock.** The Knowledge Base, S3 Vectors bucket, and index in `infra/modules/knowledge-base` **are applied and exist** — that part works. What does not is putting anything into them: starting an ingestion job makes the Knowledge Base role call the Titan embedding model, and Bedrock model invocation is blocked account-wide on this AWS account (`FRICTION-LOG.md` FL-019, re-verified 2026-09-16; FL-032 for why "provisioned" and "usable" turned out to be different things). So the Knowledge Base is real, addressable, wired into the runtime — and **unusable in both directions**. It cannot be ingested into, and it cannot be queried either: `Retrieve` embeds the *question* as well as the documents, so the same block refuses the read path, and against the deployed Knowledge Base `ask_manual` returns an error result rather than an empty one. That result now carries spoken prose naming the cause — model access is blocked on the account, the question was fine — instead of the raw AWS sentence ("Invalid input or configuration provided. Check the input and Knowledge Base configuration and try your request again."), which is AWS's wording for its own API and reads as a HomeLedger bug. A retrieval failure the server has not positively recognised says so plainly instead of borrowing that explanation. Locally and wherever `KNOWLEDGE_BASE_ID` is unset, `ask_manual` serves a small in-memory fixture set instead. The Bedrock adapter in `packages/core/src/retrieval/bedrock.ts` is written and tested against a stubbed sender, never against a live index. The deployed smoke reflects all of this rather than papering over it: it prints a loud `ask_manual: SKIPPED` naming the specific cause and carries on running every other assertion, in each of the three blocked states (no Knowledge Base; one that could not be ingested into; one that cannot be queried at all). Once a Knowledge Base is provisioned *and* content has actually been ingested, the check is enforced with no way to opt out — a mismatched title, an empty result, or an error result all fail the run, which is the point of the assertion.
- **Ring events.** No Ring integration exists in this repository. `recent_events` reads door and sensor rows from DynamoDB and returns only what something else has written there; nothing writes them yet. The webhook, correlation, snapshot, and vision-description pipeline is a later plan.

## Local development

```bash
pnpm install
pnpm --filter @homeledger/core build         # apps/mcp-server consumes @homeledger/core via dist/, not source
pnpm -r test                                 # dynamo.test.ts skips here - no DynamoDB Local running yet
docker compose up -d                         # DynamoDB Local on :8000
pnpm --filter @homeledger/core test:dynamo   # sets DYNAMO_ENDPOINT itself; runs the DynamoDB contract tests for real
docker compose down
```

Without `docker compose up -d` and `test:dynamo`, `packages/core/test/dynamo.test.ts` silently reports "skipped" rather than failing — it is gated on `DYNAMO_ENDPOINT` being set.

`.env.example` documents every variable. The ones Plan 2 added:

- `KNOWLEDGE_BASE_ID` — when set, `ask_manual` calls the real Bedrock Knowledge Base; when unset it serves fixtures. Set on the deployed runtime today, and the Knowledge Base it names is real but empty (see "Not yet built" above).
- `MANUAL_INGESTION_SKIPPED` — CI only, set by `.github/workflows/smoke.yml` from the seed step's log when ingestion was skipped for the account-wide Bedrock block. It is the only way the smoke can tell "the Knowledge Base is empty because nothing could be ingested" (skip) from "the Knowledge Base returned the wrong document" (fail hard); the two are identical from the retrieval side. Only `1`, `true`, or `yes` count — anything else, including `false` or a typo, leaves the assertion enforced.
- `REQUEST_STATE_KEY` — at least 32 bytes, signs `book_service`'s cross-round state. Unset generates a per-process key and logs that it did; set-but-shorter-than-32-bytes throws rather than falling back.
- `AVAILABILITY_DELAY_MS` — total budget for the simulated availability check, default 600.

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
docker run --rm -p 8010:8000 -e HOUSEHOLD_ID=hh_harlow -e MEMORY_REPO=1 -e HOMELEDGER_DEV_TOOLS=1 homeledger-mcp:dev
```

`HOMELEDGER_DEV_TOOLS=1` registers the developer-only `echo_confirm` tool — it is how the elicitation demo (a real `elicitation/create` round trip) gets reproduced locally.

## Talking to HomeLedger from Claude Code

Claude Code runs on the Anthropic API rather than Bedrock, so it can drive this server today regardless of the account-wide Bedrock model block (FL-019). It is the only way a person, rather than a smoke script, has used the system.

There are two ways in. The local one needs no AWS at all and is the right one for poking at tools; the deployed one exercises the real runtime.

### Local, no auth

The server speaks Streamable HTTP, which Claude Code connects to directly — no bridge.

```bash
HOUSEHOLD_ID=hh_harlow MEMORY_REPO=1 HOMELEDGER_DEV_TOOLS=1 PORT=8010 pnpm --filter @homeledger/mcp-server dev
claude mcp add --transport http homeledger-local http://127.0.0.1:8010/mcp
```

`MEMORY_REPO=1` seeds an in-memory household, so this needs neither DynamoDB nor credentials. Then ask Claude Code to book a service visit for the water heater and answer the three questions it relays.

### Deployed, through the bridge

The deployed runtime sits behind AgentCore with a Cognito JWT authorizer, and the token it wants expires in about an hour — so a static header in a config file breaks an hour in. `apps/mcp-bridge` is a stdio MCP server that Claude Code spawns: it mints the token, refreshes it before it expires, and relays MCP traffic in both directions.

**Everything you need, and this is the whole list: Node 22, pnpm 10, the AWS CLI, and an AWS SSO session on the `homeledger-admin` profile.** No Terraform, no local state, no `terraform init`. Every Terraform apply in this project happens in GitHub Actions and the S3 backend is configured with flags the workflow passes, so there is nothing for a contributor to initialise and nothing to catch up on — FL-035, which is the entry about the version of this section that told you otherwise.

The profile needs to be able to read five things, all of them read-only: `bedrock-agentcore:ListAgentRuntimes`, `cognito-idp:ListUserPools`, `cognito-idp:ListUserPoolClients`, `cognito-idp:DescribeUserPool`, and `secretsmanager:GetSecretValue` on `demo-homeledger/cognito/client-secret`. The first four are how the setup helper finds your runtime ARN, token URL and client id; the fifth is the one call the running bridge makes.

From a clean checkout, in order — these are the commands, not a sketch of them:

```bash
pnpm install
pnpm build                                                    # the bridge runs from dist/, so this is not optional

aws login --profile homeledger-admin                          # on an AWS CLI older than v2.31: aws sso login --profile homeledger-admin
export AWS_PROFILE=homeledger-admin                           # both the helper and the bridge read this

pnpm --filter @homeledger/mcp-bridge run print-setup
```

`export AWS_PROFILE` is optional only if your session is on `homeledger-admin` — the helper defaults to that profile, writes it into the command it prints, and tells you in a line of its output that it defaulted. If your session lives on any other profile, exporting it is required, because the default is what everything else in this section assumes.

The `run` is not optional and the script is not called `setup`: `setup` is one of pnpm's own subcommands, so `pnpm --filter <pkg> setup` never reaches a package script of that name and fails with `Unknown option: 'recursive'`, which points at the filter flag rather than at the collision. FL-034.

`print-setup` makes four read-only AWS calls and matches the resources by the names Terraform assigned them — `demo_homeledger_mcp` for the AgentCore runtime, `demo-homeledger-mcp` for the Cognito user pool, `homeledger-simulator` for its app client — never by position in a list. If a name matches nothing, or matches two resources with different ids, it says which and stops rather than picking one. It reads no secret: the app client is found with `ListUserPoolClients`, whose response shape has no room for a client secret, and never with `DescribeUserPoolClient`, whose response has one.

It prints something of this shape — run what it prints, not this:

```bash
claude mcp add homeledger \
  --scope user \
  -e HOMELEDGER_COGNITO_TOKEN_URL='https://<domain>.auth.us-east-1.amazoncognito.com/oauth2/token' \
  -e HOMELEDGER_COGNITO_CLIENT_ID='<client id>' \
  -e AWS_REGION='us-east-1' \
  -e AWS_PROFILE='homeledger-admin' \
  -- node /absolute/path/to/homeledger/apps/mcp-bridge/dist/index.js
```

**No runtime ARN appears on that command line, and that is the point.** The bridge resolves the runtime by name — `demo_homeledger_mcp`, through the same `ListAgentRuntimes` call `print-setup` makes, with the same profile — every time it starts. AgentCore mints a runtime's id when the runtime is created and offers no alias layer (FL-038), so an ARN baked into a config is only correct until the runtime is next destroyed and recreated, and nothing tells you when that happens: the old address does not redirect, it stops resolving. A config with nothing pinned in it survives that; a config with an ARN in it does not. FL-039.

`print-setup` still prints the ARN it found, below the command, so you can see which runtime you are about to talk to. Put it back as `-e HOMELEDGER_RUNTIME_ARN='…'` only if you mean to pin one specific runtime — the bridge still reads it, and checks at startup that it names a runtime that exists rather than discovering that it does not during a tool call.

No client secret appears there either, and none should: `claude mcp add --scope user` writes these values into `~/.claude.json`, and at project scope it would write them into a tracked `.mcp.json`. The secret is read from Secrets Manager (`demo-homeledger/cognito/client-secret`) with the local profile instead. `HOMELEDGER_COGNITO_CLIENT_SECRET` is supported for CI and containers, where there is no SSO session.

Every diagnostic goes to stderr, which Claude Code shows under `/mcp`; stdout carries JSON-RPC only. The failure you will actually hit is the SSO session, and it says so in one line:

```
[homeledger-bridge] Your AWS SSO session expired, run `aws login --profile homeledger-admin`
```

The three other failures worth knowing the shape of, because they are the ones that look like a broken tool and are not:

```
AWS_PROFILE is not set, so this used the default profile homeledger-admin. If your session lives on a different profile, set AWS_PROFILE to it and run this again.

AWS_PROFILE is set to typo-admin, and no profile of that name exists in ~/.aws/config. Set AWS_PROFILE to one that does — `aws configure list-profiles` lists them — or create it with `aws configure sso`.

No AgentCore runtime named demo_homeledger_mcp in us-east-1 (profile homeledger-admin). The demo stack may not be deployed — `.github/workflows/deploy.yml` applies it on a push to main, and it creates the runtime only once an image has been pushed. Names present: …
```

A fourth failure has its own shape, because it is the one that is hardest to recognise as a failure at all. If the AgentCore runtime instance holding your MCP session has been recycled — which it is, on this stack, after 30 minutes idle — a tool call comes back 404 from the container. The bridge rebuilds the session and replays the call once, so in the ordinary case you see nothing but a line on stderr. When the replay fails too, the error says so in terms a model client cannot round off into an answer:

```
The HomeLedger MCP session no longer exists (404 / -32001 "Session not found"). …
NO DATA WAS RETRIEVED. This call did not execute, so nothing was read from the household and no result — empty or otherwise — is implied. Do not answer the question from memory, from repository fixtures or seed data, or from any other source: you do not know what this household contains. …
Reconnect the server — `/mcp` in Claude Code, then reconnect homeledger — and run the call again.
```

That paragraph is aimed at the model, not at you, and it is there because the untreated version of this failure was twice turned into a confident wrong answer rather than reported. FL-039.

Other variables, none of them required:

- `HOMELEDGER_RUNTIME_ARN` — pins one runtime ARN instead of resolving by name. Checked against `ListAgentRuntimes` at startup, so a stale pin refuses to start with a sentence rather than 404ing mid-conversation.
- `HOMELEDGER_RUNTIME_NAME` — resolves by a different name. Defaults to `demo_homeledger_mcp`.
- `HOMELEDGER_MCP_URL` — the full invocation URL, which overrides both of the above and makes no AWS call to resolve anything.
- `HOMELEDGER_COGNITO_SCOPE` — defaults to `homeledger/mcp`.
- `HOMELEDGER_COGNITO_SECRET_ID` — defaults to `demo-homeledger/cognito/client-secret`.
- `HOMELEDGER_SETUP_SOURCE=terraform`, or `--from-terraform` on the binary — makes `print-setup` read the platform root's Terraform outputs instead of AWS. It is the source of record if a rename lands in `infra/` before the names in `apps/mcp-bridge/src/discover.ts` catch up, and it is deliberately **not** a fallback: it needs an initialised S3 backend, which needs the `-backend-config` flags `.github/workflows/deploy.yml` passes, so on a machine that has not done that it fails. If you have not applied this stack from your own terminal, you do not want this flag.
- `HOMELEDGER_AGENTCORE_SESSION_ID` — **off by default**, which is a reversal of what this bridge used to do. It pinned one `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` per process so that a session's later requests reached the instance holding it; FL-033 recorded that as the one decision no offline test could check, and checking it found no benefit to check. AgentCore already pins an MCP session to one instance by `Mcp-Session-Id` (FL-009), which the bridge forwards in both directions, and `pnpm smoke` — which sends no runtime session header at all — carries multi-request elicitation round trips to one instance on every observed run. What the pin added was a *second* session with its own idle clock, ageing out independently of the MCP session it was meant to protect. `on` mints one per process; an explicit value pins that value and must be at least 33 characters; `off` or unset sends no header.
- `HOMELEDGER_BRIDGE_SSE=off` — stops the bridge holding open the spec's optional standalone `GET` event stream. Nothing this server sends arrives on it.

What the bridge does **not** do is translate between protocol revisions. Claude Code 2.1.56 negotiates `2025-11-25` and answers elicitation with session-based `elicitation/create` over the call's own event stream — not the 2026-07-28 multi round-trip requests the modern client uses — so it lands on the server's legacy shim, which is the same path `pnpm smoke`'s legacy block exercises. FL-033 records what that means for a proxy; the short version is that the response stream must be relayed as it arrives and requests must be allowed to overlap, or `book_service` deadlocks on its first question.

## The simulator

`apps/simulator` is a web client shaped like a smart display: a 768 × 480 base canvas at the published 1.667 scale, dark by default with a light toggle, rendering the documented visual foundations. It drives the **deployed** MCP server — the same nine tools, the same three-round `book_service` elicitation with its `0 → 3` progress, the same four `ui://` widgets — through an agent.

**The agent runs on the Anthropic API, not on Bedrock.** That is a deliberate deviation from the design spec, which called for a Strands agent on Bedrock. Bedrock model invocation is refused account-wide on this account and has been since 2026-09-14 (FL-019, FL-032), so a Bedrock-backed agent could not make one call; the Anthropic API sidesteps the block entirely and is the same path Claude Code already uses to drive this server.

**Nothing here is a real assistant product, and the frame says so on screen.** The disclosure strip is always visible and states both of the things that have to be stated: this is a simulation, and the service-provider marketplace is sample data.

Elicitation is the interesting part. `book_service`'s `tools/call` answers with an event stream that stays open across all three questions, and each answer is a separate request sent while it is open. The simulator has the same shape end to end: `POST /api/agent/turn` returns an SSE stream for the whole turn, and `POST /api/agent/answer` delivers one answer on a sibling request. Buffering either response, or serialising the requests, deadlocks silently rather than failing — FL-033 is the entry that cost.

The questions never appear in the transcript as text. An `elicitation-opened` event puts a card between the transcript and the composer, the composer is disabled while it is up, the buttons carry the `enumNames` labels, and the value posted back is the enum value the server will accept.

**"Not now" is an answer, not an error.** `book_service` returns a normal result with `structuredContent: { booked: false }` when somebody declines, and the transcript shows it as a call that worked and booked nothing. It used to set `isError: true`, which is MCP's flag for *the call did not execute* — so a clean decline reached Claude Code as `Error: Okay, I haven't booked anything` and would have reached this transcript as "book_service failed — Nothing was retrieved". A real failure still renders as a failure, loudly, with the server's own sentence quoted; the two are different things and the wire now says which is which.

Run it against the deployed server:

```bash
aws login --profile homeledger-admin
export AWS_PROFILE=homeledger-admin
pnpm --filter @homeledger/mcp-bridge run print-setup    # prints the two Cognito values below
printf 'ANTHROPIC_API_KEY=%s\nHOMELEDGER_COGNITO_TOKEN_URL=%s\nHOMELEDGER_COGNITO_CLIENT_ID=%s\nAWS_REGION=us-east-1\n' \
  "$ANTHROPIC_API_KEY" "$TOKEN_URL" "$CLIENT_ID" > apps/simulator/.env.local
pnpm --filter @homeledger/simulator run dev             # http://127.0.0.1:3000
```

Or against a local server, with no AWS account and no Cognito at all:

```bash
HOUSEHOLD_ID=hh_harlow MEMORY_REPO=1 HOMELEDGER_DEV_TOOLS=1 PORT=8010 pnpm --filter @homeledger/mcp-server run dev
HOMELEDGER_MCP_URL=http://127.0.0.1:8010/mcp ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @homeledger/simulator run dev
```

A loopback `HOMELEDGER_MCP_URL` with no `HOMELEDGER_COGNITO_TOKEN_URL` is the one configuration that sends no bearer token. It cannot be pointed at the deployed runtime: the check requires a loopback host.

**Where the secrets are.** `ANTHROPIC_API_KEY` is read inside a request handler in `apps/simulator/src/server/`, never at import time and never under a `NEXT_PUBLIC_` name; the Cognito client secret comes from Secrets Manager through the same code path the bridge uses; the AgentCore bearer is minted per HTTP request and never leaves the server. The browser talks only to `/api/agent/*`, `/api/widget*` and `/api/debug`, and `apps/simulator/test/no-client-secrets.test.ts` fails the build if any credential name appears outside `src/server/` or if a `'use client'` module imports from it.

`ask_manual` fails against the deployed server and the simulator shows that as a failure: a card titled "The manuals could not be searched", the server's own sentence quoted underneath, and an explanation that model access is blocked on the account. It never renders a blocked retrieval as an empty one.

## Deployed endpoint

The MCP server runs as an Amazon Bedrock AgentCore Runtime in `us-east-1` (AWS account `<account-id>`), built and deployed entirely through GitHub Actions — nothing in this repository applies Terraform from a developer's terminal, and no contributor has ever run `terraform init` against this root. (Reading AWS from a terminal is a different thing and is fine: the bridge's setup helper does it, read-only, with an SSO session.) `infra/live/demo/platform` is the Terraform root; its `agent_runtime_invocation_url` output is the runtime's DEFAULT-qualifier invocation endpoint:

```
https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<urlencoded-runtime-arn>/invocations?qualifier=DEFAULT
```

Every request to that URL must carry a Cognito client-credentials bearer token in the `Authorization: Bearer <token>` header — the runtime's `custom_jwt_authorizer` (discovery URL + allowed client id, both from the `cognito-m2m` module) rejects anything else. Mint a token from `cognito_token_url` with `grant_type=client_credentials` and `scope=homeledger/mcp`, using HTTP Basic auth of `cognito_client_id:cognito_client_secret`.

`ci.yml` runs on every pull request: `test` (format, typecheck, the whole suite, `pnpm build`), `image`, and `terraform`. The `image` job builds `apps/mcp-server/Dockerfile` and stops there — it never pushes and holds no AWS credentials. It exists because `test` installs the entire workspace while the image copies only `packages/core` and `apps/mcp-server` into its build context, so the two disagree about what the workspace contains, and for three merges `test` was green on a `workspace:*` edge the image could not resolve (FL-036). It runs on `ubuntu-24.04-arm` so the arm64 build the deploy ships is native rather than emulated. All three are required to merge into `main`; `deploy.yml`'s `plan` job deliberately is not, because it is path-filtered and would block any pull request outside those paths forever. [`docs/RUNBOOK.md`](docs/RUNBOOK.md) §8.3 is the single source of truth for that list and carries the command to read it back — it is a repository setting, so nothing in this tree can keep it honest.

Three workflows drive the deployed stack. `deploy.yml` runs a `terraform plan` on every pull request touching `infra/**`, `apps/**`, `packages/**`, or `scripts/**`, and applies on push to `main` — merging a PR into `main` applies it. The `plan` job runs without the `demo` GitHub environment gate (pull request runs use the synthetic `refs/pull/N/merge` ref, which no deployment branch policy can match; the OIDC role's trust policy admits pull_request tokens directly), while `apply` still requires it. All three can be dispatched manually:

```bash
gh workflow run deploy.yml --ref <branch>   # infra apply + image build/push, GitHub environment "demo"
gh workflow run smoke.yml --ref <branch>    # seeds the table, then drives a modern and a legacy MCP client through the real endpoint
gh workflow run teardown.yml --ref main -f mode=teardown-runtime -f confirm='destroy demo runtime'
gh workflow run teardown.yml --ref main -f mode=bring-up   # redeploys an image already in ECR; builds nothing
```

`teardown.yml` is the only workflow that removes a deployed resource, and the only resource it can remove is the AgentCore runtime — the expensive, easily recreated part. It applies with an empty `image_uri` rather than running `terraform destroy`, and since that `count` is the only conditional in the configuration it is structurally unable to reach ECR, DynamoDB, Cognito, the secrets or the Knowledge Base. It also refuses to apply a plan that creates anything or deletes anything else. Destroying the rest is deliberately not offered from a dispatch menu; `docs/RUNBOOK.md` §11 is where that is written down. **Both modes have now been dispatched against the live account** — teardown destroyed one resource, bring-up brought it back in five seconds from an image already in ECR, and the smoke passed afterwards. **Do not dispatch `teardown-runtime` again before 2026-11-20:** it rotates the runtime ARN, and since the invocation URL is that ARN, every address already handed out stops working, with no alias in AgentCore that survives it. FL-037 and FL-038 carry the detail.

[`docs/RUNBOOK.md`](docs/RUNBOOK.md) carries the rest of this end to end: the one-time OIDC and state-bucket bootstrap, the authoritative list of `main`'s required checks and why the Terraform `plan` is deliberately absent from it, a verbatim healthy smoke run with its timings, and the teardown / bring-up round trip between test windows — including why the runtime should stay up through judging, what a full destroy still costs, and why it has no button.

## Manuals and the knowledge base

**Status: applied, never ingested.** The infrastructure in this section is real — the manuals bucket, the S3 Vectors index, the Knowledge Base, its data source, and its IAM role were all created by the first post-merge deploy. What has never run is an ingestion job: starting one makes the Knowledge Base role invoke the Titan embedding model, and Bedrock model invocation is blocked account-wide on this account (FL-019, FL-032). Uploads work and are kept; embedding does not — in either direction, since `Retrieve` has to embed the query too, so the Knowledge Base cannot be read from any more than it can be written to. Treat the retrieval half as the documented path for when that clears, not as a working pipeline.

Manuals live in S3 at `manuals/<householdId>/<docId>.pdf`, each beside a `<docId>.pdf.metadata.json` sidecar carrying `applianceId` and `title`. A Bedrock Knowledge Base is configured to ingest that prefix into an S3 Vectors index using Titan Text Embeddings v2; `ask_manual` calls `Retrieve` with an `equals` filter on `applianceId` when the caller supplies one, asks for three passages, and caches each question for ten minutes.

Add a manual:

```bash
cd infra/live/demo/platform
export AWS_REGION=us-east-1
export HOUSEHOLD_ID=hh_harlow
export TABLE_NAME=$(terraform output -raw table_name)
export MANUALS_BUCKET=$(terraform output -raw manuals_bucket)
export KNOWLEDGE_BASE_ID=$(terraform output -raw knowledge_base_id)
export DATA_SOURCE_ID=$(terraform output -raw data_source_id)
cd -
pnpm manuals -- --appliance appl_washer2222222222 --title "LG WM4000HWA washer owner manual" --file ~/Downloads/wm4000hwa.pdf --pages 88
```

The script uploads both objects, writes the `DOC#` row, points the appliance's `manualDocId` at it, starts one ingestion job, polls until it reaches a terminal status, flips `kbSync` to `synced` on `COMPLETE` (and to `failed` otherwise, then throws), and prints the doc id.

One ingestion failure is tolerated and exactly one: if `StartIngestionJob` is refused because Bedrock model access is blocked account-wide, the script prints a loud skip banner and exits 0, leaving the uploaded PDF, its sidecar, and the `DOC#` row in place at `kbSync.status` `pending` — so re-running once the block clears ingests them with no re-upload, replacing rather than duplicating, because `docId` and the S3 key are derived deterministically from the appliance id. Every other ingestion failure still exits non-zero: a malformed metadata sidecar, an S3 key outside the data source's prefix, a data source that does not belong to the knowledge base, an unrelated permissions error, and a job that starts and then reports `FAILED` all fail the run.

Without `KNOWLEDGE_BASE_ID`, the server falls back to a small in-memory fixture set so `pnpm dev` and the whole test suite run with no AWS account. That fallback is the only retrieval path exercised today, whether or not a Knowledge Base exists, because none has any content in it.

## License

MIT licensed — see [`LICENSE`](LICENSE).
