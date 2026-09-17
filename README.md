# HomeLedger

The household's operating record, exposed to an assistant through an MCP server.
Built for the Build, Ship, Shape: Amazon Developer Hackathon (Alexa+ and Ring tracks, AWS Builder mini-challenge).

- Design: `docs/superpowers/specs/2026-09-13-homeledger-design.md`
- Friction log: `FRICTION-LOG.md`

## Prerequisites

Node 22, pnpm 10, Docker, Terraform >= 1.10, AWS CLI v2.

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

Eight of the nine register unconditionally; `echo_confirm` registers only under `HOMELEDGER_DEV_TOOLS=1`, which the demo deploy sets (`dev_tools_enabled` defaults to `true`) so the elicitation round trip is provable against the live endpoint.

Three JSON resources (`homeledger://household`, `homeledger://appliances`, `homeledger://maintenance/schedule`), four `ui://` MCP Apps widgets, and one prompt (`seasonal-checklist`).

`ask_manual` returns source passages only and never composes an answer; the client model reads `structuredContent.passages` and writes the reply, citing the document title and page. `book_service` asks three questions through MCP elicitation — provider, arrival window, confirmation — and emits progress `0` to `3` while it checks availability. `book_service` and `echo_confirm` are the two tools that use elicitation, and both work on a 2026-07-28 client through multi round-trip requests and on a 2025-era client through the SDK's legacy shim over a session.

`get_visit` returns `snapshotUrl` and `description` as always-present, always-nullable keys. `snapshotUrl` is hard-coded `null` today and `description` is null on every visit `book_service` writes; both wait on the Ring pipeline described under "Not yet built" below.

## Simulated data disclosure

This section is the complete accounting of what in HomeLedger is not real: two things are simulated by design, and three more are not built yet.

**1. The service-provider marketplace is sample data.** The companies, ratings, and phone numbers in `packages/core/src/marketplace/providers.ts` are invented, the availability windows are generated rather than queried, and no booking leaves this system. `book_service` writes a `VISIT#` row in DynamoDB and nothing else. Every provider row carries a required `sample: true` field so the fixture cannot be mistaken for a live feed.

**2. Nothing here talks to Alexa+.** The Alexa+ MCP Toolkit is in private preview and entrants cannot call Alexa+. The Alexa+ client generation is stood in for by a 2025-era MCP client (`@modelcontextprotocol/sdk` 1.30.0) in the contract tests and in the deployed smoke run, which is what exercises the legacy session branch and the elicitation shim.

Real today: appliances, warranties, and maintenance history are the author's own household (`packages/core/src/seed/household.ts`), stored in DynamoDB and served by the deployed AgentCore runtime behind Cognito.

**Not yet built — do not read these as working features:**

- **Manual retrieval against Bedrock.** The Knowledge Base, S3 Vectors bucket, and index are authored in `infra/modules/knowledge-base` and unit-tested offline, but have never been applied: Bedrock model invocation is blocked account-wide on this AWS account (`FRICTION-LOG.md` FL-019, re-verified 2026-09-16). With `KNOWLEDGE_BASE_ID` unset — the state today — `ask_manual` serves a small in-memory fixture set. The Bedrock adapter in `packages/core/src/retrieval/bedrock.ts` is written and tested against a stubbed sender, never against a live index. The deployed smoke reflects this rather than papering over it: with `KNOWLEDGE_BASE_ID` empty it prints `ask_manual: SKIPPED` and moves on, and it skips the `seed:manual` step for the same reason. Once a Knowledge Base *is* provisioned the check is enforced with no way to opt out — content that does not carry the seeded document's exact title fails the run, which is the point of the assertion.
- **Ring events.** No Ring integration exists in this repository. `recent_events` reads door and sensor rows from DynamoDB and returns only what something else has written there; nothing writes them yet. The webhook, correlation, snapshot, and vision-description pipeline is a later plan.
- **The Echo Show simulator.** Planned as `apps/simulator`: a Strands agent driving the deployed server and rendering the documented Alexa+ visual foundations. It does not exist in this tree — `apps/` contains `mcp-server` only.

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

- `KNOWLEDGE_BASE_ID` — when set, `ask_manual` calls the real Bedrock Knowledge Base; when unset it serves fixtures. Unset everywhere today (see "Not yet built" above).
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

## Deployed endpoint

The MCP server runs as an Amazon Bedrock AgentCore Runtime in `us-east-1` (AWS account `<account-id>`), built and deployed entirely through GitHub Actions — there are no local AWS credentials for this repo. `infra/live/demo/platform` is the Terraform root; its `agent_runtime_invocation_url` output is the runtime's DEFAULT-qualifier invocation endpoint:

```
https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<urlencoded-runtime-arn>/invocations?qualifier=DEFAULT
```

Every request to that URL must carry a Cognito client-credentials bearer token in the `Authorization: Bearer <token>` header — the runtime's `custom_jwt_authorizer` (discovery URL + allowed client id, both from the `cognito-m2m` module) rejects anything else. Mint a token from `cognito_token_url` with `grant_type=client_credentials` and `scope=homeledger/mcp`, using HTTP Basic auth of `cognito_client_id:cognito_client_secret`.

Two workflows drive the deployed stack. `deploy.yml` runs a `terraform plan` on every pull request touching `infra/**`, `apps/**`, `packages/**`, or `scripts/**`, and applies on push to `main` — merging a PR into `main` applies it. The `plan` job runs without the `demo` GitHub environment gate (pull request runs use the synthetic `refs/pull/N/merge` ref, which no deployment branch policy can match; the OIDC role's trust policy admits pull_request tokens directly), while `apply` still requires it. Both workflows can also be dispatched manually:

```bash
gh workflow run deploy.yml --ref <branch>   # infra apply + image build/push, GitHub environment "demo"
gh workflow run smoke.yml --ref <branch>    # seeds the table, then drives a modern and a legacy MCP client through the real endpoint
```

## Manuals and the knowledge base

**Status: authored, never applied.** Everything in this section is written, formatted, and unit-tested offline, but no ingestion job has ever run — Bedrock model invocation is blocked account-wide on this account (FL-019). Treat it as the documented path for when that clears, not as a working pipeline.

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

Without `KNOWLEDGE_BASE_ID`, the server falls back to a small in-memory fixture set so `pnpm dev` and the whole test suite run with no AWS account. That fallback is the only path exercised today.

## License

MIT licensed — see [`LICENSE`](LICENSE).
