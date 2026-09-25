# HomeLedger runbook

From a fresh clone to a working deployed system you can talk to, and back down to zero cost.

Two readers. The **owner** wants a sequence that does not have to be rediscovered, and does not want AWS
resources running between test windows. A **judge** has never seen this repository, is reading it during
2026-11-09 to 2026-11-20, and needs to reach something demonstrable fast and to know honestly what is
blocked. Both get the same document; nothing below is written for one and hidden from the other.

Every command in this file was run against this repository before it was written, except the ones that need
live AWS credentials or would change deployed state. Those are marked **NOT EXECUTED** at the point of use,
and listed again in [section 13](#13-what-in-this-document-is-verified-and-what-is-not). That distinction is
not decoration: three setup failures in a row here (`FRICTION-LOG.md` FL-034, FL-035, FL-036) were all
documented paths that were written, reviewed and merged without ever being executed from a clean checkout.

---

## 1. How to read this

| If you are | Start at | Time | Needs an AWS account |
| --- | --- | --- | --- |
| A judge with fifteen minutes | [4. Fifteen minutes, no AWS account](#4-fifteen-minutes-no-aws-account) | ~10 min | No |
| A judge who wants to know what is real | [2. Status at a glance](#2-status-at-a-glance), then [5. What is blocked](#5-what-is-blocked-bedrock-model-access) | ~5 min | No |
| A contributor | [6. Local development](#6-local-development), then [8. Deploying](#8-deploying) | — | No |
| The owner, re-deploying for a demo | [8. Deploying](#8-deploying), [9. Verifying](#9-verifying-a-deployment), [10. Claude Code](#10-talking-to-homeledger-from-claude-code) | ~10 min | Yes |
| The owner, deciding whether to shut down after one | [11. Cost and teardown](#11-cost-and-teardown) — the short answer, through 2026-11-20, is don't | ~5 min | Yes |
| Anyone hitting an error | [12. Troubleshooting](#12-troubleshooting) | — | — |

Reference material this runbook does not duplicate: `README.md` (what the server exposes, tool by tool),
`docs/superpowers/specs/2026-09-13-homeledger-design.md` (the design), `FRICTION-LOG.md` (every thing that did
not work as documented, and what it cost).

---

## 2. Status at a glance

| Capability | Runs locally with no AWS | Runs on the deployed stack | Notes |
| --- | --- | --- | --- |
| Eight of the nine MCP tools | Yes | Yes | `list_appliances`, `get_appliance`, `maintenance_due`, `log_maintenance`, `recent_events`, `book_service`, `get_visit`, `echo_confirm`. Run 35478596365 invoked five of them against the live runtime; `get_appliance`, `log_maintenance` and `recent_events` are registered and listed there but are exercised in-process rather than by the smoke |
| `ask_manual` | Yes, from an in-memory fixture set | **No** | Returns a spoken error. See [section 5](#5-what-is-blocked-bedrock-model-access) |
| Elicitation (`book_service`, `echo_confirm`) | Yes | Yes | Both drive real `elicitation/create` round trips in smoke run 35478596365 against the live runtime |
| MCP Apps widgets (four `ui://` resources) | Yes | Yes, wiring only | The five widget-backed tools carry their `ui://` reference — asserted in-process by `apps/mcp-server/test/widgets.test.ts` and over the wire by the smoke. **Rendering** them now has an MCP Apps host: `apps/simulator`'s `WidgetFrame` renders all four in a sandboxed iframe, exercised end to end by the Playwright suite against a local server. Rendering against the deployed server specifically has not been exercised — see §4.6 and §13 |
| DynamoDB persistence | Yes, via DynamoDB Local | Yes | |
| Bedrock Knowledge Base | n/a | Provisioned, unusable | Exists, addressable, cannot be ingested into or queried |
| Ring events | No | No | No Ring integration exists in this repository. `recent_events` reads rows nothing writes |
| Alexa+ | No | No | The Alexa+ MCP Toolkit is private preview; entrants cannot call Alexa+ (FL-001) |
| Echo Show simulator | Yes (against a local server) | Yes, wiring only — **not yet run with the real model** | `apps/simulator` exists and drives the deployed MCP server through an agent on the Anthropic API, not Bedrock (FL-019, FL-032; see §4.6 and `README.md`). Six Playwright specs verify it end to end against a local, scripted server. The run against the deployed runtime with the real model (§13) has not been executed by anyone yet |

`recent_events` answers correctly and answers nothing. Verified locally against the shipped container:

```
Nothing happened in the last 24 hours.
```

That is the honest output, not a failure. Nothing writes door or sensor rows yet.

---

## 3. Prerequisites

Pinned in the repository, not guessed. Each row names the file the version comes from.

| Tool | Version | Pinned in | Needed for |
| --- | --- | --- | --- |
| Node | 22 | `.nvmrc`, `engines.node: ">=22.0.0"` in `package.json`, `node-version: 22` in `.github/workflows/ci.yml` | Everything |
| pnpm | 10.15.0 | `packageManager` in `package.json`, `pnpm/action-setup` in every workflow | Everything |
| Docker | any current release | not pinned | DynamoDB Local (§6.3), the container build (§6.4). **Not** needed for §4 |
| AWS CLI | v2 | not pinned | §7, §10.2, §11 only |
| `gh` | any current release | not pinned | §8, §9, §11 only |
| Terraform | >= 1.10.0 locally, 1.16.1 in CI | `infra/live/demo/platform/versions.tf`, `terraform_version: '1.16.1'` in `ci.yml`/`deploy.yml`/`smoke.yml` | Nothing you have to run. See the note below |
| An AWS account | — | — | §7 through §11 only |

**Terraform is not a prerequisite for running, testing, or connecting to anything here.** Every apply happens
in GitHub Actions. `infra/live/demo/platform/backend.tf` declares `backend "s3" {}` with an empty body and
`deploy.yml` supplies the bucket and region as `-backend-config` flags, so a local `terraform init` in that
root does not work and is not meant to. Install it only if you want to run `terraform fmt` / `validate` /
`test` while editing `infra/` (§6.5).

Node 22 is the pinned and CI-tested version and is what the container image uses
(`FROM --platform=linux/arm64 node:22-bookworm-slim`). The suite also passed on Node v24.13.1 while this
document was written; 22 is still what to install.

---

## 4. Fifteen minutes, no AWS account

This is the fastest path to a running HomeLedger you can drive from Claude Code. It needs Node 22 and pnpm
10 and nothing else. No AWS account, no credentials, no Docker, no Terraform.

### 4.1 Install and build

```bash
git clone https://github.com/jkarns87/homeledger.git
cd homeledger
pnpm install
pnpm --filter @homeledger/core build
```

`pnpm --filter @homeledger/core build` is not optional and is the step a fresh checkout most often skips.
`apps/mcp-server` consumes `@homeledger/core` through its published `dist/` entry point (`main`/`types` in
`packages/core/package.json`), not through TypeScript source, so nothing downstream resolves until `core` has
been built once. `ci.yml` carries the same step for the same reason.

### 4.2 Start the server with in-memory data

```bash
HOUSEHOLD_ID=hh_harlow MEMORY_REPO=1 HOMELEDGER_DEV_TOOLS=1 PORT=8010 pnpm --filter @homeledger/mcp-server dev
```

`MEMORY_REPO=1` builds an in-memory repository and seeds the household into it at startup, so this needs
neither DynamoDB nor credentials. Leave it running. After pnpm's own two-line banner, a healthy start prints
exactly these three JSON lines and nothing else:

```
{"msg":"retriever","kind":"fixture","reason":"KNOWLEDGE_BASE_ID unset"}
{"msg":"request-state-key-generated","reason":"REQUEST_STATE_KEY unset","scope":"process"}
{"msg":"listening","port":8010,"path":"/mcp","devTools":true}
```

The first line is the one to read: with no `KNOWLEDGE_BASE_ID`, `ask_manual` serves a small in-memory fixture
set instead of Bedrock, which is why it works here and not on the deployed stack.

### 4.3 Point Claude Code at it

The server speaks Streamable HTTP, which Claude Code connects to directly. No bridge, no token, no AWS.

```bash
claude mcp add --transport http homeledger-local http://127.0.0.1:8010/mcp
```

Then, in Claude Code:

- "What maintenance is overdue?" — calls `maintenance_due`.
- "Tell me about the washer." — calls `get_appliance`.
- "What does error code F21 mean on the washer?" — calls `ask_manual`, which answers from the fixture
  passages and cites the document title and page.
- "Book a service visit for the water heater." — calls `book_service`, which asks three questions through
  MCP elicitation (provider, arrival window, confirmation) and emits progress 0 to 3 while it checks
  availability. See §12 if it refuses instead of asking.

Remove it again with `claude mcp remove homeledger-local`.

### 4.4 Or drive it without Claude Code

If you would rather see the protocol, the MCP Inspector connects to the same URL:

```bash
npx @modelcontextprotocol/inspector     # connect to http://127.0.0.1:8010/mcp
```

Nine tools should be listed, in this exact order — the order is frozen after the first deploy and both
`apps/mcp-server/test/tools.test.ts` and `scripts/smoke.ts` assert it:

```
list_appliances, get_appliance, maintenance_due, log_maintenance,
recent_events, ask_manual, book_service, get_visit, echo_confirm
```

`echo_confirm` is a development-only elicitation probe and appears only because `HOMELEDGER_DEV_TOOLS=1` is
set. The deployed runtime sets it too, deliberately — see `README.md` for why.

### 4.5 What you have just proved, and what you have not

Proved: the MCP surface and its frozen tool order, the widget references, the voice-first response shape,
the whole domain model, and — if your client can prompt, see §12 — the elicitation round trip on the
2025-era client path. Not proved: anything about AWS, AgentCore, Cognito, DynamoDB or Bedrock. §9 is where
the deployed stack is exercised; §5 is what is broken there.

### 4.6 Talk to it from the simulator

Everything in section 4 gets you a server. This gets you a display in front of it, and it still needs no AWS account — only an Anthropic API key, because the agent runs on the Anthropic API rather than on Bedrock (section 5, and `FRICTION-LOG.md` FL-019).

```bash
# terminal 1 - the server, in memory
HOUSEHOLD_ID=hh_harlow MEMORY_REPO=1 HOMELEDGER_DEV_TOOLS=1 PORT=8010 pnpm --filter @homeledger/mcp-server run dev

# terminal 2 - the display
HOMELEDGER_MCP_URL=http://127.0.0.1:8010/mcp ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @homeledger/simulator run dev
```

Open `http://127.0.0.1:3000`. Ask "what appliances do we have", then "book a plumber for the water heater". The booking asks three questions as cards; answering the third writes a visit and renders the visit widget.

What this proves: the tool surface, the widget host, and the whole elicitation path, against a real MCP server over a real socket. What it does not: anything about AgentCore, Cognito, or the deployed runtime. For that, see the deployed instructions in the README's simulator section — and note that `ask_manual` fails there, deliberately and visibly, until Bedrock model access is restored.

To run the end-to-end suite instead of driving it by hand, with no API key at all:

```bash
pnpm --filter @homeledger/simulator exec playwright install chromium
pnpm --filter @homeledger/simulator run test:e2e
```

It starts both servers itself and answers from a fixed script rather than from the model, which is why it is deterministic and free. `HOMELEDGER_SIMULATOR_SCRIPTED_MODEL=1` is what selects that, it is accepted only as the exact string `1`, and the process logs which mode it is in at startup.

**Security defaults, if you open this to anything other than yourself.** With `HOMELEDGER_SIMULATOR_ALLOW_ORIGIN` unset — the default — every simulator route (`/api/agent/turn`, `/api/agent/answer`, `/api/widget`, `/api/widget/tool`, `/api/debug`) accepts a request only when its `Host` header names a loopback address (`localhost`, `127.0.0.1`, or bracketed IPv6 `[::1]`) and, if the request carries an `Origin` header at all, that `Origin` matches `Host`. Every `POST` route additionally requires `content-type: application/json`, which forces a cross-site browser through a preflight this application never grants. Opening the simulator from another machine, or putting it behind a proxy, means setting `HOMELEDGER_SIMULATOR_ALLOW_ORIGIN` to the origin you expect requests from — the refusal message names the variable. An earlier version of this check let a cross-site request through and a reviewer's probe confirmed it could reach `/api/widget/tool` and run `log_maintenance`; `apps/simulator/src/server/http.ts`'s `checkOrigin` carries the full history of that fix in its own comment, including why `Host` alone was not enough and why comparing against Next's `request.url` was not either.

**The scripted model is gated to the local, unauthenticated upstream and marks itself on screen.** `HOMELEDGER_SIMULATOR_SCRIPTED_MODEL=1` is refused at startup (`SimulatorConfigError`, `assertScriptedModeAllowed` in `session.ts`) unless `HOMELEDGER_MCP_URL` is also a loopback address with no Cognito token URL configured — it cannot be pointed at the deployed runtime. When it is on, the on-screen disclosure gains a second line ("Scripted replies — no model is answering; this run follows a fixed script.") so scripted output is never mistaken for the real model.

**The Playwright suite runs in that scripted mode, and its CI status.** `pnpm --filter @homeledger/simulator run test:e2e` is what Step 4's `pnpm test:e2e` above invokes. `.github/workflows/ci.yml` has an `e2e` job that runs the same suite headless on every pull request and push to `main` — it is **not** one of `main`'s required checks (§8.3 is the authoritative list) and it has **not yet run on a GitHub Actions runner**; it was validated by running the equivalent command sequence locally (fresh `core`/`mcp-bridge` builds, `playwright install chromium`, `test:e2e`), which passed 6/6.

**Verifying it against the deployed runtime, with the real model — not yet executed by anyone.** Everything above proves the wiring against a local, scripted server. This is the run the whole plan is building toward, and it has not happened: it needs a real `ANTHROPIC_API_KEY`, which has not been provisioned on any machine that has worked on this plan, and it makes live Cognito, AgentCore and Anthropic calls. From `apps/simulator`, once a key exists:

```bash
aws login --profile homeledger-admin
export AWS_PROFILE=homeledger-admin
pnpm --filter @homeledger/mcp-bridge run print-setup    # prints the two Cognito values below

cat > apps/simulator/.env.local <<'ENV'
ANTHROPIC_API_KEY=sk-ant-...
HOMELEDGER_COGNITO_TOKEN_URL=https://<domain>.auth.us-east-1.amazoncognito.com/oauth2/token
HOMELEDGER_COGNITO_CLIENT_ID=<client id>
AWS_REGION=us-east-1
ENV

pnpm --filter @homeledger/simulator run dev
# open http://127.0.0.1:3000
```

Drive it and check, in order — recording what actually happens by updating `FRICTION-LOG.md` FL-055, whose status is currently **pending — not yet run**:

1. **Connection drawer**: endpoint host, "resolved by name", session id, tool count. Expect **nine** tools (the deployed runtime sets `HOMELEDGER_DEV_TOOLS=1`).
2. **"what appliances do we have"** — the appliances widget renders; the spoken line names at most five; the drawer shows the call under 3000 ms.
3. **"when did we last change the furnace filter"** — the calendar widget renders; the spoken answer carries no ids.
4. **"what does F21 mean on the washer"** — **must fail, visibly**: a failed `ask_manual` card titled "The manuals could not be searched," carrying the server's own sentence, and the assistant's reply saying it could not look it up. If it answers anyway, stop — that is FL-039 recurring and needs its own entry, not a tick on this list.
5. **"book a plumber for the water heater Tuesday"** — three cards in order, progress 3 of 3, the visit widget, a `VISIT#` row.
6. **Idle 35 minutes, then ask anything** — expect exactly one `session-rebuilt` notice and a correct answer.
7. **The startup log must not contain `answering from a fixed script`, and no element with `data-testid="scripted-marker"` may appear on the page.** Both are guaranteed by `assertScriptedModeAllowed` (`session.ts`) refusing to start at all if `HOMELEDGER_SIMULATOR_SCRIPTED_MODEL=1` is ever left set against a non-loopback upstream — this is the one point where that refusal fires against the real thing rather than a unit fixture.

Nothing above is a result — it is the checklist `FRICTION-LOG.md` FL-055 is waiting on. The entry there, once this runs, is the log of record; this document does not restate or anticipate an outcome.

---

## 5. What is blocked: Bedrock model access

**Read this before you conclude you did something wrong.**

Bedrock **model invocation** is blocked account-wide on the AWS account this project deploys to, and has
been continuously since 2026-09-14 (`FRICTION-LOG.md` FL-019). Every model call, from every principal,
returns the same string:

```
ValidationException ... Error 002: Access to Bedrock models is not allowed for this account
```

AWS Support case 178941623300459 was closed on 2026-09-18 without resolving it. The stated reason was that
hackathon projects should fit within the beginner quota, which conflates two different things: a quota
throttles a permitted call (`ThrottlingException`, `ServiceQuotaExceededException`), while this account
returns zero access on a call that is otherwise valid. Three observations separate them, and all three are
reproducible from the repository: two unrelated principals (the GitHub OIDC deploy role and the Bedrock
Knowledge Base service role) fail with a byte-identical string; access worked on 2026-09-14 and stopped after
a handful of requests, which quotas do not do retroactively; and only model invocation is affected, with
AgentCore, DynamoDB, Cognito, ECR, S3, S3 Vectors and IAM all working in the same workflow runs that record
the Bedrock failures.

### 5.1 What this does and does not break

| | |
| --- | --- |
| **Blocked** | Manual ingestion (`pnpm manuals`, `seed:manual`), `ask_manual` against the deployed runtime, anything that would need Nova vision or a Strands agent |
| **Not blocked** | The other eight tools, on the deployed runtime and locally; the entire local development path; all Terraform authoring, validation and apply; the Bedrock adapter's unit tests, which run against a stubbed sender |

The Knowledge Base itself is **provisioned and unusable in both directions.** The manuals bucket, the S3
Vectors bucket and index, the Knowledge Base, its data source and its IAM role all exist — nothing in the
apply path invokes a model, so Terraform applied cleanly (FL-032). What cannot happen is embedding.
Ingestion needs it, and so does retrieval: `Retrieve` embeds the *question* as well as the documents, so the
same block refuses the read path. There is no degraded-but-working mode.

### 5.2 Exactly what you will see

Against the **deployed** runtime, `ask_manual` returns an error result whose spoken text is:

> I can't look anything up in the manuals right now. Searching them needs a model to read your question
> first, and model access is blocked on this AWS account, so the search is refused before it starts. Nothing
> is wrong with the question you asked. Manual search will work again once model access is restored on the
> account.

That wording is in `apps/mcp-server/src/tools/manual.ts` as `MANUALS_MODEL_ACCESS_BLOCKED_MESSAGE`. It
replaced the raw AWS sentence ("Invalid input or configuration provided. Check the input and Knowledge Base
configuration and try your request again"), which is AWS's wording for its own API and reads as a HomeLedger
bug.

In the smoke workflow you will see a loud skip rather than a failure, and every other assertion still runs —
see the verbatim output in §9.2.

Against a **local** server with `KNOWLEDGE_BASE_ID` unset, `ask_manual` works, from fixtures. That is the
documented local behaviour, and it is why §4 puts it in the demo list.

---

## 6. Local development

§4 is the subset of this that needs nothing. This is the whole thing.

### 6.1 The workspace

Five pnpm workspace packages (`pnpm-workspace.yaml`: `packages/*`, `apps/*`, `scripts`):

| Package | Path | What it is |
| --- | --- | --- |
| `@homeledger/core` | `packages/core` | Domain, DynamoDB and in-memory repositories, retrieval adapters, seed data |
| `@homeledger/mcp-server` | `apps/mcp-server` | The MCP server. The only containerised package |
| `@homeledger/mcp-bridge` | `apps/mcp-bridge` | stdio-to-AgentCore relay for Claude Code. Never containerised |
| `@homeledger/scripts` | `scripts` | `smoke`, `seed:remote`, `seed:manual`, `manuals` |
| (root) | `.` | `build`, `typecheck`, `test`, `format`, `smoke`, `manuals` |

The workspace graph is three edges and is acyclic: `mcp-server -> core` (production),
`mcp-bridge -> mcp-server` (dev only), `scripts -> core`. No edge crosses out of the two directories the
container build context holds. Adding a `workspace:*` edge to `apps/mcp-server` or `packages/core` that
points anywhere else breaks the image build — that is FL-036, and `ci.yml`'s `image` job exists to catch it
on the pull request rather than after the merge.

### 6.2 The checks CI runs, in the order CI runs them

```bash
pnpm install --frozen-lockfile
pnpm --filter @homeledger/core build
pnpm format          # prettier --check .
pnpm typecheck       # tsc --noEmit across four packages
pnpm test            # pnpm -r test
pnpm --filter @homeledger/core test:dynamo   # needs DynamoDB Local; see 6.3
pnpm build           # tsc across four packages (scripts has no build script)
```

Observed results on a clean tree at `1851301`:

| Command | Result |
| --- | --- |
| `pnpm format` | `All matched files use Prettier code style!` |
| `pnpm typecheck` | clean, four packages |
| `pnpm test` | 43 files, 466 passed, 1 skipped (`core` 64+1, `scripts` 135, `mcp-server` 80, `mcp-bridge` 187) |
| `pnpm --filter @homeledger/core test:dynamo` | 11 files, 74 passed |
| `pnpm build` | clean, 4 of 5 workspace projects |

The one skip is `packages/core/test/dynamo.test.ts`'s repository contract, which is gated on
`DYNAMO_ENDPOINT` being set. It reports "skipped" rather than failing, so a green `pnpm test` does **not**
mean the DynamoDB path was exercised. `test:dynamo` is what exercises it.

**`pnpm format` does not check Markdown.** `.prettierignore` lists both `docs/` and `*.md`, so every Markdown
file in this repository — this one included — is excluded. Verified by putting a deliberately misformatted
Markdown file at the repository root and inside `docs/`: `prettier --check` passed both. Do not expect
`pnpm format` to catch a Markdown formatting problem, and do not "fix" a Markdown file to satisfy it.

### 6.3 DynamoDB Local

```bash
docker compose up -d                          # amazon/dynamodb-local on 127.0.0.1:8000
pnpm --filter @homeledger/core test:dynamo    # sets DYNAMO_ENDPOINT itself
pnpm --filter @homeledger/core seed:local     # creates the table and seeds the household
docker compose down
```

`test:dynamo` and `seed:local` both set `DYNAMO_ENDPOINT`, `AWS_ACCESS_KEY_ID=local`,
`AWS_SECRET_ACCESS_KEY=local` and `AWS_REGION=us-east-1` themselves — the placeholder credentials are
required by the SDK and mean nothing to DynamoDB Local. `seed:local` prints the six fixed appliance ids:

```
{
  applianceIds: [
    'appl_furnace222222222',
    'appl_waterheater22222',
    'appl_washer2222222222',
    'appl_dishwasher222222',
    'appl_refrigerator2222',
    'appl_sumppump22222222'
  ]
}
```

The ids are fixed rather than generated so that re-seeding overwrites rather than accumulates — FL-023, where
four smoke runs left roughly 24 appliances in the live table where six were intended.

Run the server against it:

```bash
cd apps/mcp-server
PORT=8010 HOUSEHOLD_ID=hh_harlow TABLE_NAME=homeledger DYNAMO_ENDPOINT=http://127.0.0.1:8000 \
AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_REGION=us-east-1 HOMELEDGER_DEV_TOOLS=1 pnpm dev
```

`TABLE_NAME=homeledger` must match what `seed:local` created, which is `TABLE_NAME` or `homeledger` by
default (`packages/core/scripts/seed-local.ts`). Verified: `list_appliances` against this returns the six
seeded rows.

### 6.4 The container, which is what AgentCore runs

```bash
docker build --platform linux/arm64 -f apps/mcp-server/Dockerfile -t homeledger-mcp:dev .
docker run --rm -p 8010:8000 -e HOUSEHOLD_ID=hh_harlow -e MEMORY_REPO=1 -e HOMELEDGER_DEV_TOOLS=1 homeledger-mcp:dev
```

Both verified. The Dockerfile pins `FROM --platform=linux/arm64` (AgentCore runs arm64), so on an x86 host
every `RUN` layer runs under emulation; on Apple silicon it is native. Docker prints two
`FromPlatformFlagConstDisallowed` lint warnings about that pin — expected, not a problem. The container
listens on 8000 internally (`ENV PORT=8000`), which is why the port mapping is `8010:8000`.

This build is the thing that was broken for three consecutive merges while CI stayed green (FL-036): the
`test` job installs the whole workspace, the image copies only `packages/core` and `apps/mcp-server`, and the
two therefore disagree about what the workspace contains. If you change any `package.json` dependency, run
this build before opening the pull request even though `ci.yml`'s `image` job will also run it.

### 6.5 Terraform, offline only

```bash
cd infra
terraform fmt -check -recursive
cd live/demo/platform
terraform init -backend=false     # provider download only; no backend, no credentials
terraform validate
terraform test
```

`terraform fmt -check -recursive` was run while writing this and is clean. The `init -backend=false` /
`validate` / `test` trio is what `ci.yml`'s `terraform` job runs, in four directories —
`infra/live/demo/platform` and the three modules under `infra/modules/` — followed by `tflint --recursive`
and four separate `trivy config` scans, one per directory. The scans are deliberately per-directory: a
tree-wide scan follows the `cognito-m2m` module reference but not the `agentcore-runtime` one, so the
execution role's inline IAM policy would silently never be evaluated.

Do **not** run `terraform init` with backend config, `plan`, or `apply` from a local machine; see §8.

One known trap, from FL-027: `terraform providers schema -json` will not run in
`infra/live/demo/platform` even after a clean `terraform init -backend=false`, because the root's empty
`backend "s3" {}` block makes that one command demand backend initialisation while `validate` and `test`
work fine. Run it from `infra/modules/agentcore-runtime` instead — the schema dump covers the whole provider
regardless of which directory asks.

### 6.6 Environment variables

`.env.example` documents the server's. Nothing in the repository reads a `.env` file automatically; these
are set on the command line, by `docker run -e`, or by Terraform's `environment_variables` map on the
deployed runtime.

**Server** (`apps/mcp-server/src/deps.ts`, `src/index.ts`):

| Variable | Default | Effect |
| --- | --- | --- |
| `HOUSEHOLD_ID` | none, **required** | Throws `HOUSEHOLD_ID is required` if unset |
| `MEMORY_REPO` | unset | `1` uses a seeded in-memory repository and needs no AWS |
| `TABLE_NAME` | none | Required unless `MEMORY_REPO=1`; else throws `TABLE_NAME is required unless MEMORY_REPO=1` |
| `DYNAMO_ENDPOINT` | unset | Point at DynamoDB Local |
| `AWS_REGION` | unset | Passed to the DynamoDB and Bedrock clients |
| `PORT` | `8000` | |
| `ALLOWED_HOSTS` | unset | Unset keeps the SDK default list (`localhost,127.0.0.1,0.0.0.0`). `*` disables Host validation entirely, which is what the deployed runtime uses — see FL-020 |
| `HOMELEDGER_DEV_TOOLS` | unset | `1` registers `echo_confirm` |
| `KNOWLEDGE_BASE_ID` | unset | Unset serves fixture passages. Set points `ask_manual` at Bedrock |
| `REQUEST_STATE_KEY` | unset | Unset mints a per-process key and logs that it did. Set-but-under-32-bytes **throws**; set-but-empty also throws |
| `AVAILABILITY_DELAY_MS` | `600` | Budget for the simulated availability check |

**Bridge** (`apps/mcp-bridge/src/config.ts`): see §10.2.

---

## 7. First-time AWS bootstrap

**One-time, per AWS account. Already done on the owner's account — you do not need to do any of this to
deploy, verify, or run anything.** It is written down so the stack can be stood up on a new account, and
because it is the part that is nowhere in this repository's Terraform.

Three things must exist before the first deploy, and none of them is managed by
`infra/live/demo/platform` (`infra/live/demo/platform/README.md` says so under "Blast radius": "It does not
touch the OIDC provider or GitHub deploy role used to run it — those are managed outside Terraform").

> **NOT EXECUTED, with the trust policy's scope now excepted.** Everything in this section needs credentials
> on a real AWS account. The shapes below are reconstructed from `.github/workflows/*.yml`, the repository
> variables (read through the GitHub API), and
> `docs/superpowers/plans/2026-09-13-homeledger-plan-1-foundation.md` Task 13. The policy **document** has
> still not been read back from IAM. What has been settled empirically is **which subjects it admits** — see
> the confirmation at the end of §7.1.

### 7.1 The GitHub OIDC provider and the deploy role

```
Provider URL: https://token.actions.githubusercontent.com
Audience:     sts.amazonaws.com
Role name:    homeledger-github-deploy
```

**The subject-claim trap, and it fails silently.** GitHub's OIDC token now carries the owner ID and the
repository ID inside the `sub` claim, so the classic pattern

```
repo:OWNER/REPO:ref:refs/heads/main
```

no longer matches the token that is actually presented, and `AssumeRoleWithWebIdentity` is refused with
nothing in the workflow log that points at the trust policy. `docs/submission/devpost-story.md` records this
as one of the "small things that cost a deploy each". The subject to match is of the form

```
repo:OWNER@OWNERID/REPO@REPOID:ref:refs/heads/main
```

Get the two IDs from GitHub rather than guessing them:

```bash
gh api repos/OWNER/REPO --jq '{owner_id: .owner.id, repo_id: .id}'
```

For this repository that returns `owner_id 6717478`, `repo_id 1369914589`, which gives
`repo:jkarns87@6717478/homeledger@1369914589:ref:refs/heads/main`.

Match that with `StringEquals` on the full literal, **not** with a wildcard. The IDs are immutable, so the
ID-bearing subject survives a rename or a transfer — which is the whole point of the form — while a
loosening pattern such as `repo:jkarns87*/homeledger*:ref:refs/heads/main` would also admit
`repo:jkarns87anything/homeledger-anything:...`, i.e. a repository somebody else can create.

Confirm the subject against the token rather than against this paragraph before writing the policy. A
throwaway workflow step prints it, and `sub` is not a secret (the token is, and this never prints it):

```yaml
# permissions: { id-token: write }
- uses: actions/github-script@v7
  with:
    script: |
      const t = await core.getIDToken('sts.amazonaws.com');
      core.info(JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).sub);
```

The trust policy must admit **two** subjects, not one, because `deploy.yml` assumes the role from pull
request runs as well as from pushes to `main`:

- `...:ref:refs/heads/main` — for the `apply` job.
- `...:pull_request` — for the `plan` job. A pull_request run uses the synthetic `refs/pull/N/merge` ref,
  which no deployment branch policy can match, which is why `plan` carries no `environment:` and why the
  trust policy has to allow the `pull_request` subject directly. `deploy.yml` lines 19-23 say exactly this.

**That the policy admits those two subjects and nothing else is now confirmed empirically, and this
paragraph replaces the caveat that used to sit here.** On 2026-09-21 a read-only probe was pushed to a
scratch branch and `aws-oidc-check.yml` was dispatched against it (run **35628816957**). The role assumption
failed before the workflow could do anything:

```
##[error]Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity
```

A branch that is neither `main` nor a pull request cannot assume the role — which is the property the
policy was written to have. The other half is confirmed by every green run on this repository: dispatches on
`main` assume it (runs 35623151468, 35629345017, 35615354202, 35616472515) and pull-request `plan` jobs
assume it (pull request #11). The scratch branch was deleted and its absence verified.

What is still **not** verified: the literal policy document — the exact `Condition` block, the audience, and
the ID-bearing subject strings quoted above — because reading it needs a live IAM call. The *scope* is
settled; the *text* is still reconstructed.

Permissions the role needs: enough to plan and apply the whole platform root, plus IAM for the roles the
stack creates. The demo account uses `PowerUserAccess` plus an inline IAM policy scoped to
`arn:aws:iam::<account>:role/homeledger-*` and the OIDC provider ARN. That is demo-grade and should be
tightened per resource before any non-demo use.

### 7.2 The Terraform state bucket

An S3 bucket, created outside Terraform, whose name goes into the `TF_STATE_BUCKET` repository variable.
`backend.tf` fixes the key and the locking mode and leaves bucket and region to the workflow:

```hcl
terraform {
  backend "s3" {
    key          = "homeledger/demo/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}
```

`use_lockfile = true` is S3-native locking, so there is no DynamoDB lock table to create.

### 7.3 Repository variables and the demo environment

Three **variables** (not secrets — none of these is sensitive), at repository scope. Current values, read
through the GitHub API:

| Variable | Value shape | Used by |
| --- | --- | --- |
| `AWS_REGION` | `us-east-1` | all three AWS workflows |
| `AWS_ROLE_ARN` | `arn:aws:iam::<account-id>:role/homeledger-github-deploy` | all three AWS workflows |
| `TF_STATE_BUCKET` | `homeledger-tfstate-<account-id>` | `deploy.yml`, `smoke.yml`, `aws-oidc-check.yml` |

```bash
gh variable set AWS_REGION      --body us-east-1
gh variable set AWS_ROLE_ARN    --body arn:aws:iam::<account-id>:role/homeledger-github-deploy
gh variable set TF_STATE_BUCKET --body homeledger-tfstate-<account-id>
```

And one GitHub **environment** named `demo`, referenced by `deploy.yml`'s `apply` job and by the whole
`smoke` job. It carries a deployment branch policy admitting `main`, `plan-*` and `worktree-*`, and no
required reviewers and no wait timer — so dispatching either workflow from one of those branches runs
without a human approval step.

### 7.4 Prove the bootstrap worked before deploying anything

```bash
gh workflow run aws-oidc-check.yml --ref main
gh run watch --repo jkarns87/homeledger
```

`aws-oidc-check.yml` assumes the deploy role, prints `aws sts get-caller-identity`, confirms the state bucket
is reachable with `head-bucket`, and then — informationally, never failing the job — tries
`bedrock-runtime converse` against two models and lists the AgentCore runtimes. On this account the two
`converse` calls fail with the `Error 002` string from §5 while `list-agent-runtimes` succeeds in the same
run; that pairing is the cheapest single check of whether the Bedrock block has lifted.

### 7.5 The first deploy on a new account is a two-pass apply

Nothing extra to run: `deploy.yml`'s `apply` job handles it. `var.image_uri` defaults to `""` and the
runtime resource is `count = var.image_uri == "" ? 0 : 1`, so the runtime cannot be created before an image
exists in ECR, and ECR cannot exist before the first apply. The workflow resolves that with a narrowly
`-target`ed bootstrap step that runs only when `aws_ecr_repository.mcp` is absent from state:

```yaml
- name: Bootstrap ECR repository if absent
  run: |
    if ! terraform state list 2>/dev/null | grep -qx 'aws_ecr_repository.mcp'; then
      terraform apply -auto-approve -input=false -target=aws_ecr_repository.mcp -target=aws_ecr_lifecycle_policy.mcp -var image_uri=""
    fi
```

It then builds and pushes the image and applies with the real `image_uri`.

---

## 8. Deploying

### 8.1 Terraform runs in GitHub Actions, never from a laptop

There are no local AWS credentials for Terraform in this project, by design. No contributor has ever run
`terraform init` with backend config against `infra/live/demo/platform`, and it would not work if they tried:
the backend block is empty and the bucket and region arrive as `-backend-config` flags from the workflow.

Reading AWS from a terminal is a different thing and is fine — the bridge's setup helper does exactly that,
read-only, with an SSO session (§10.2).

### 8.2 What triggers what

| Workflow | Trigger | Jobs | AWS credentials |
| --- | --- | --- | --- |
| `ci.yml` | every pull request; push to `main` | `test`, `image` (pull requests only), `terraform` | **None.** `permissions: contents: read`, no `id-token: write` |
| `deploy.yml` | pull requests touching `infra/**`, `apps/**`, `packages/**`, `scripts/**`, `.github/workflows/deploy.yml`; push to `main`; `workflow_dispatch` | `plan` (pull requests), `apply` (push / dispatch) | OIDC role |
| `smoke.yml` | `workflow_dispatch` only | `smoke` | OIDC role, `demo` environment |
| `teardown.yml` | `workflow_dispatch` only | `teardown` or `bring-up`, whichever the `mode` input selects | OIDC role, `demo` environment |
| `aws-oidc-check.yml` | `workflow_dispatch`; push to `main` touching that file | `whoami` | OIDC role |

`teardown.yml` is the only workflow that can remove a deployed resource, and the only one it can remove is
the AgentCore runtime. It needs a typed confirmation and refuses a plan wider than that runtime. §11.2.

**Merging a pull request into `main` deploys.** `deploy.yml`'s `apply` job runs on the push, builds and
pushes a `linux/arm64` image tagged with the 7-character commit SHA, and applies Terraform with that
`image_uri`. `concurrency: deploy-demo` serialises applies. There is no separate "release" step.

The `apply` job's steps, in order: checkout, configure AWS credentials, setup Terraform, QEMU, buildx,
`Terraform init`, `Bootstrap ECR repository if absent`, `Build and push image`, `Terraform apply`,
`Publish outputs summary`. A healthy run on an already-deployed stack takes about three and a half minutes
(run 35478430481: 198 s wall).

### 8.3 Branch protection on `main`

**This subsection is the single source of truth for the required-check list. Nothing else in the repository
restates it — other documents point here — because the list has already gone stale once by being written
down in more than one place and updated in one.**

**Three required status checks: `test`, `terraform`, `image`.** All three live in `ci.yml`, which has no
`paths:` filter, so all three report on every pull request. Force pushes and deletions are blocked; admin
enforcement is off.

Read it back rather than trusting this paragraph — it is a repository setting, not a file in this tree, so
nothing in CI can keep it honest:

```bash
gh api repos/jkarns87/homeledger/branches/main/protection --jq '.required_status_checks.contexts'
```

> Last read back on **2026-09-21**, returning `["test","terraform","image"]`. Needs a token with admin on the
> repository; a non-admin token gets a `404`, which is a permissions answer and **not** evidence that no
> protection exists.

**`plan` is deliberately *not* required, and this is the part to read before "helpfully" adding it back.**
`plan` lives in `deploy.yml`, whose `pull_request` trigger carries a `paths:` filter covering `infra/**`,
`apps/**`, `packages/**`, `scripts/**` and `.github/workflows/deploy.yml`. A pull request outside those paths
— any documentation-only change, and any change to `.github/workflows/teardown.yml`, which is not in the
list — does not trigger `deploy.yml` at all. The check therefore never reports, and **a required check that
never reports blocks the pull request rather than passing it.** Not "fails": never arrives, permanently.
Requiring `plan` means requiring a check that a whole class of legitimate pull requests can never satisfy.

That was not theoretical. Pull request #5 (`FRICTION-LOG.md` plus `docs/submission/*`) reported only
`terraform` and `test` and sat stuck; pull request #9, which touched `apps/` and `.github/`, reported
everything because its paths happened to match. Three ways out were on the table — merge with admin
privileges every time, widen `deploy.yml`'s `paths` to include `docs/**` and `*.md`, or stop requiring
`plan` — and the third was taken on 2026-09-21. `plan` still runs, and still has to pass, whenever
`deploy.yml` is triggered at all; it simply is not a gate that a docs-only change has to satisfy.

**A second reason the check list cannot be inferred from a passing run.** A check appearing green on some
pull request proves the job *ran*, not that it is *required*. Those are different states, and the failure
mode here — a required check that never reports — is invisible in exactly the runs where the job does
report. `gh pr view --json statusCheckRollup` answers "what ran"; only the protection API answers "what is
required". The command above is the only one that settles it.

### 8.4 Dispatching a deploy by hand

```bash
gh workflow run deploy.yml --ref main
gh run watch --repo jkarns87/homeledger
```

> **NOT EXECUTED.** Dispatching this builds and pushes an image and applies Terraform against the live
> account. The command shape is verified (`gh workflow list` shows `deploy` active with `workflow_dispatch`);
> the effect is described from the workflow file and from run 35478430481's logs.

`--ref` must name a branch the `demo` environment's deployment branch policy admits: `main`, `plan-*`, or
`worktree-*`. Anything else is rejected by the environment gate before the job starts.

### 8.5 What a healthy apply prints

From run 35478430481 (push to `main`, merge of pull request #9), with the account id masked, the
hidden-attribute markers trimmed, and the long `container_uri` line re-wrapped. This is the steady-state
shape: one resource changed, because only the image tag moved.

```
  # module.agentcore_runtime.aws_bedrockagentcore_agent_runtime.this[0] will be updated in-place
  ~ resource "aws_bedrockagentcore_agent_runtime" "this" {
      ~ agent_runtime_version     = "12" -> (known after apply)
      ~ agent_runtime_artifact {
          ~ container_configuration {
              ~ container_uri = "<account>.dkr.ecr.us-east-1.amazonaws.com/demo-homeledger-mcp:3c8cb86"
                             -> "<account>.dkr.ecr.us-east-1.amazonaws.com/demo-homeledger-mcp:1851301"
            }
        }
    }

Plan: 0 to add, 1 to change, 0 to destroy.
...
Apply complete! Resources: 0 added, 1 changed, 0 destroyed.
```

A `Warning: Argument is deprecated ... hash_key is deprecated. Use key_schema instead. (and 7 more similar
warnings elsewhere)` appears on every apply. Expected noise from the pinned AWS provider; not a failure.

The `Publish outputs summary` step writes the full `terraform output` into the run summary. The values that
matter downstream are `agent_runtime_invocation_url`, `cognito_token_url`, `cognito_client_id`,
`table_name`, `knowledge_base_id`, `data_source_id`, `manuals_bucket` and `deployed_image_uri`.
`cognito_client_secret` is marked `sensitive` and renders as `<sensitive>`.

---

## 9. Verifying a deployment

### 9.1 Dispatch the smoke

```bash
gh workflow run smoke.yml --ref main
gh run watch --repo jkarns87/homeledger
```

> **NOT EXECUTED.** This resets and re-seeds the live DynamoDB table and drives the deployed runtime. The
> command shape is verified; the output below is the real output of run 35478596365.

The `smoke` job reads every value it needs from Terraform outputs, re-seeds the table
(`seed:remote` calls `resetHousehold` first, which is FL-023's fix), uploads the smoke manual, then runs
`pnpm smoke` — which drives the deployed endpoint with **two** MCP client generations: a modern
`@modelcontextprotocol/client` 2.0.0 and a 2025-era `@modelcontextprotocol/sdk` 1.30.0 client standing in for
the Alexa+ client generation. It finishes with a shell-level `grep -q '^SMOKE OK$'` on the captured log,
which is a second, independent gate: a symlinked workspace can make the script's entrypoint guard skip every
assertion and still exit 0.

### 9.2 What a healthy run looks like

Run **35478596365**, dispatched against `main`, job `smoke`, **48 s** wall, conclusion success. Verbatim,
except that the `ask_manual` skip banner is a single long line in the log and is wrapped here:

```
token: ok
modern connect (cold): 787 ms
modern tools/list: 876 ms
modern list_appliances: 807 ms
seeded appliance count: 6
modern maintenance_due: 712 ms
modern ask_manual (knowledge base): 920 ms

!! ask_manual: SKIPPED - a Knowledge Base IS provisioned, but RETRIEVAL ITSELF is impossible: Bedrock has to
embed the QUERY, not just the documents, so Retrieve is refused server-side under the account-wide model
block even against a Knowledge Base that exists (FRICTION-LOG.md FL-019, FL-032). ask_manual returned an
error result instead of passages, which is expected in this state and is why it is tolerated HERE and
nowhere else. The tool was still reached, invoked and answered in budget. Server said: isError result: I
can't look anything up in the manuals right now. Searching them needs a model to read your question first,
and model access is blocked on this AWS account, so the search is refused before it starts. Nothing is wrong
with the question you asked. Manual search will work again once model access is restored on the account.

legacy initialize (cold): 1158 ms
legacy session: ccda35ba-9024-4d4b-97ba-5aa2a1fba28e
legacy echo_confirm (elicitation): 796 ms
legacy list_appliances: 386 ms
legacy book_service (three elicitations plus progress): 1892 ms
legacy book_service: Kettle Creek Water Heaters visit_n7lqegu3dg4u2kbg, progress 0,1,2,3
legacy get_visit: 308 ms
legacy terminateSession: non-fatal - Streamable HTTP error: Failed to terminate session: Not Found
SMOKE OK
```

And, earlier in the same run, from the `Seed the smoke manual` step:

```
uploaded s3://demo-homeledger-manuals-<account>/manuals/hh_harlow/doc_swumttwejl5sdxeg.pdf

!! seed:manual: SKIPPED ingestion - the Knowledge Base role cannot call the embedding model because Bedrock
model invocation is blocked account-wide (FRICTION-LOG.md FL-019, FL-032). The PDF and its metadata sidecar
ARE uploaded and the DOC# row is recorded with kbSync.status "pending"; re-running seed:manual once the
block clears ingests them with no re-upload. Nothing about real retrieval is proved by this run.

MANUAL_INGESTION_SKIPPED
uploaded (not ingested) doc_swumttwejl5sdxeg for Washer (appl_washer2222222222)
```

### 9.3 Reading it

| Line | What it proves |
| --- | --- |
| `token: ok` | Cognito client-credentials flow works; the client id, secret and `homeledger/mcp` scope all line up |
| `modern connect (cold)` / `legacy initialize (cold)` | The AgentCore JWT authorizer accepted the token and a cold microVM started. **Not budget-enforced** — these are the two cold starts |
| `modern tools/list` | All nine tools present, in the frozen order, with the five `ui://` widget references intact |
| `seeded appliance count: 6` | FL-023's regression guard. An exact match, not a floor: the failure mode was too *many* rows |
| `modern ask_manual` | The tool is registered, reachable, accepts its schema and answers in budget. It is still called in every state, deliberately — it is also the signal that will say when the Bedrock block lifts |
| `legacy session: <uuid>` | The request went to the 2025-era shim (`src/legacy.ts`), not the modern handler |
| `legacy echo_confirm (elicitation)` | A real server-initiated `elicitation/create` round trip through AgentCore |
| `legacy book_service ... progress 0,1,2,3` | Three elicitation rounds in one `tools/call`, plus four progress notifications, over a real socket to a 2025-era client |
| `legacy get_visit` | The booking was written and reads back with a matching id and provider |
| `SMOKE OK` | The script reached its last line. The workflow's `grep` requires it |

Every warm call sits under 1000 ms against a 3000 ms per-tool budget the script enforces
(`BUDGET_MS = 3000`). The two cold connects and `book_service` are deliberately exempt from the budget —
`book_service` because it contains three round trips and a simulated availability check.

**`legacy terminateSession: non-fatal ... Not Found` is expected and is not a failure.** AgentCore does not
reliably route a bare-body `DELETE` back to the microVM holding the session, even though every `POST` and the
SSE `GET` in the same session routed correctly. It is FL-022, it is open, and it is not blocking: AgentCore
expires sessions on its own idle timeout, so explicit termination is best-effort cleanup that is not part of
the smoke contract. `scripts/smoke.ts` catches it, logs it and continues.

### 9.4 When the smoke should fail, and does

The `ask_manual` tolerance is narrow on purpose. It is reachable only when the seed step positively signalled
`MANUAL_INGESTION_SKIPPED` (exact values `1`, `true` or `yes` — anything else, including `false` or a typo,
leaves the assertion enforced). With a Knowledge Base configured and content actually ingested, a mismatched
document title, an empty passage list, an absent `structuredContent` or an error result all fail the run with
no way to opt out. That assertion exists because the smoke once printed `SMOKE OK` against a system with no
Knowledge Base at all.

### 9.5 If the smoke fails before `Run smoke`

The `Export Terraform outputs` step reads `agent_runtime_invocation_url`, `cognito_token_url`,
`cognito_client_id`, `cognito_client_secret`, `table_name` and `agent_runtime_arn` **strictly** — a missing
one is a broken deploy and fails the job there. Only `manuals_bucket`, `knowledge_base_id` and
`data_source_id` are read tolerantly, because destroying just the knowledge-base module would otherwise fail
the workflow for a reason unrelated to what the smoke exists to check.

The final `Tail runtime logs` step runs `if: always()` and dumps the last 30 minutes of
`/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT`. Read it before anything else when a call failed
server-side.

---

## 10. Talking to HomeLedger from Claude Code

Claude Code runs on the Anthropic API rather than Bedrock, so it drives this server regardless of the
account-wide Bedrock block. It is the only way a person, rather than a smoke script, has used the system.

Two ways in. The local one needs no AWS at all; the deployed one exercises the real runtime.

### 10.1 Local, no auth — verified

Covered in §4.3. Repeated here so this section is self-contained:

```bash
HOUSEHOLD_ID=hh_harlow MEMORY_REPO=1 HOMELEDGER_DEV_TOOLS=1 PORT=8010 pnpm --filter @homeledger/mcp-server dev
claude mcp add --transport http homeledger-local http://127.0.0.1:8010/mcp
```

### 10.2 Deployed, through the bridge

The deployed runtime sits behind AgentCore with a Cognito JWT authorizer, and the token it wants expires in
about an hour, so a static header in a config file breaks an hour in. `apps/mcp-bridge` is a stdio MCP server
that Claude Code spawns: it mints the token, refreshes it before expiry, and relays MCP traffic both ways.

**Everything you need, and this is the whole list: Node 22, pnpm 10, the AWS CLI, and an AWS SSO session on
the `homeledger-admin` profile.** No Terraform, no local state, no `terraform init`. That is FL-035 — the
entry about the version of this instruction that said otherwise.

The profile needs five read-only permissions: `bedrock-agentcore:ListAgentRuntimes`,
`cognito-idp:ListUserPools`, `cognito-idp:ListUserPoolClients`, `cognito-idp:DescribeUserPool`, and
`secretsmanager:GetSecretValue` on `demo-homeledger/cognito/client-secret`. The first four are how the setup
helper finds the runtime ARN, token URL and client id; the fifth is the one call the running bridge makes.

From a clean checkout, in order:

```bash
pnpm install
pnpm build                                     # the bridge runs from dist/, so this is not optional

aws login --profile homeledger-admin           # AWS CLI older than v2.31: aws sso login --profile homeledger-admin
export AWS_PROFILE=homeledger-admin            # both the helper and the bridge read this

pnpm --filter @homeledger/mcp-bridge run print-setup
```

> `pnpm install`, `pnpm build` and the `run print-setup` invocation form are verified. **NOT EXECUTED:** the
> four AWS discovery calls `print-setup` makes, and therefore the command it prints. FL-035 records that this
> path is unproven against the live account in three specific respects: that `ListAgentRuntimes` reports
> `agentRuntimeName` as exactly `demo_homeledger_mcp`, that a human SSO principal on `homeledger-admin` is
> permitted all four reads, and that `DescribeUserPool` returns the prefix in `Domain` for this pool.

Two things about that last command that are not stylistic:

- **`run` is not optional and the script is not called `setup`.** `setup` is one of pnpm's own subcommands,
  so `pnpm --filter <pkg> setup` never reaches a package script of that name and dies at argument parsing
  with `ERROR Unknown option: 'recursive'` — an option nobody typed, pointing at the filter flag rather than
  at the collision. Reproduced while writing this. FL-034.
- **`export AWS_PROFILE` is optional only if your session already lives on `homeledger-admin`.** The helper
  defaults to that profile, writes it into the command it prints, and says in its own output that it
  defaulted. If your session is on any other profile, exporting it is required.

`print-setup` makes four read-only AWS calls and matches resources **by the names Terraform assigned**, never
by position in a list: `demo_homeledger_mcp` for the AgentCore runtime, `demo-homeledger-mcp` for the Cognito
user pool, `homeledger-simulator` for its app client (`apps/mcp-bridge/src/discover.ts`). If a name matches
nothing, or matches two resources with different ids, it names the candidates and stops. It reads no secret:
the app client is found with `ListUserPoolClients`, whose response shape (`UserPoolClientDescription`) has no
room for a client secret, and never with `DescribeUserPoolClient`, whose response (`UserPoolClientType`) has
one.

It prints a block of this shape. **Run what it prints, not this:**

```bash
claude mcp add homeledger \
  --scope user \
  -e HOMELEDGER_COGNITO_TOKEN_URL='https://<domain>.auth.us-east-1.amazoncognito.com/oauth2/token' \
  -e HOMELEDGER_COGNITO_CLIENT_ID='<client id>' \
  -e AWS_REGION='us-east-1' \
  -e AWS_PROFILE='homeledger-admin' \
  -- node /absolute/path/to/homeledger/apps/mcp-bridge/dist/index.js
```

**The runtime ARN is printed below that block and deliberately not inside it.** The bridge resolves `demo_homeledger_mcp` by name at every start, through the same `ListAgentRuntimes` call this helper makes and with the same profile, so a generated entry survives the runtime being destroyed and recreated under a new id (§11.3, FL-038). An entry that pins the ARN does not, and nothing announces the breakage — the old address stops resolving without redirecting. FL-039. `HOMELEDGER_RUNTIME_ARN` is still read when you set it on purpose, and is checked against `ListAgentRuntimes` at startup so a stale pin refuses to start with a sentence instead of failing inside a tool call.

No client secret appears on that command line and none should: `--scope user` writes these values into
`~/.claude.json`, and at project scope it would write them into a tracked `.mcp.json`. The secret is read
from Secrets Manager (`demo-homeledger/cognito/client-secret`) with the local profile.
`HOMELEDGER_COGNITO_CLIENT_SECRET` exists for CI and containers, where there is no SSO session.

On a successful start the bridge writes one line to stderr, which Claude Code shows under `/mcp`. Composed
from `apps/mcp-bridge/src/index.ts`'s `logDiagnostic` call; not observed against the live endpoint:

```
[homeledger-bridge] ready: endpoint bedrock-agentcore.us-east-1.amazonaws.com, runtime resolved by name (demo_homeledger_mcp), client <id>, region us-east-1, secret from Secrets Manager (demo-homeledger/cognito/client-secret), runtime session left to AgentCore
```

`runtime resolved by name` is the form that survives a recreate; `runtime pinned by arn` or `pinned by url` means this entry is addressing one specific runtime and will stop working when that runtime is replaced.

Every diagnostic goes to stderr; stdout carries JSON-RPC only.

**Bridge environment variables**, all optional except the three the setup command fills in:

| Variable | Default | Effect |
| --- | --- | --- |
| `HOMELEDGER_RUNTIME_ARN` | none | Pins one ARN instead of resolving by name. Validated against `ListAgentRuntimes` at startup; a stale pin refuses to start |
| `HOMELEDGER_RUNTIME_NAME` | `demo_homeledger_mcp` | The `agent_runtime_name` the bridge resolves by when nothing is pinned |
| `HOMELEDGER_MCP_URL` | none | The full invocation URL. Overrides both of the above and makes no AWS call to resolve an address |
| `HOMELEDGER_COGNITO_TOKEN_URL` | none, required | |
| `HOMELEDGER_COGNITO_CLIENT_ID` | none, required | |
| `HOMELEDGER_COGNITO_SCOPE` | `homeledger/mcp` | |
| `HOMELEDGER_COGNITO_SECRET_ID` | `demo-homeledger/cognito/client-secret` | |
| `HOMELEDGER_COGNITO_CLIENT_SECRET` | unset | Escape hatch for CI/containers. Set-but-empty throws rather than falling back |
| `AWS_PROFILE` / `HOMELEDGER_AWS_PROFILE` | `homeledger-admin` | A profile already in the environment always wins |
| `AWS_REGION` | `us-east-1` | |
| `HOMELEDGER_RUNTIME_QUALIFIER` | `DEFAULT` | |
| `HOMELEDGER_AGENTCORE_SESSION_ID` | **unset — no header sent** | Reversed in FL-039. `on` mints one per bridge process; an explicit value pins it and must be at least 33 characters; unset or `off` sends no header and leaves instance routing to AgentCore's own `Mcp-Session-Id` pinning, which is what `pnpm smoke` does |
| `HOMELEDGER_BRIDGE_SSE` | on | `off` stops the bridge holding open the spec's standalone `GET` stream. Nothing this server sends arrives on it |
| `HOMELEDGER_SETUP_SOURCE` | `aws` | `terraform` (or `--from-terraform`) reads the platform root's Terraform outputs instead. It needs an initialised S3 backend, which a laptop does not have — see §12 |

### 10.3 What the bridge does not do

It does not translate between protocol revisions. Claude Code — 2.1.56, read out of its own bundle for
FL-033, and not re-checked against a later build — negotiates `2025-11-25` and answers elicitation with
session-based `elicitation/create` over the call's own event stream, not the 2026-07-28 multi round-trip
requests, so it lands on the server's legacy shim, the same path the smoke's legacy block
exercises. FL-033 records what that means for a proxy: the response stream must be relayed as it arrives and
requests must be allowed to overlap, or `book_service` deadlocks on its first question rather than failing.
The tidy-looking implementations (`await res.text()`, a read loop that awaits each message) both hang.

### 10.4 What you will hit, and it is not the bridge

`ask_manual` through the bridge returns the spoken message in §5. That is the Bedrock block, on the deployed
runtime, and it is the one tool of nine that does not work there.

---

## 11. Cost and teardown

The hackathon expects resources to be live only during test windows and judging (2026-11-09 to 2026-11-20).
This section is what to do between them.

### 11.1 What costs money while idle

Derived from the Terraform, by billing shape. **Dollar figures are AWS list-price estimates and were not read
from a bill — no AWS call was made while writing this.** Check the pricing pages before relying on them.

| Resource | Billing shape | Idle cost |
| --- | --- | --- |
| AgentCore runtime | **Consumption, per second, on actual CPU and memory** — not per session, not per invocation, and not on provisioned capacity | Effectively zero when nobody invokes it. It is **not** a provisioned always-on container. See the two paragraphs under this table |
| Cognito user pool + M2M app client | **Time-based.** Cognito's published pricing bills machine-to-machine app clients on a per-client monthly basis rather than by monthly active users, so this one accrues whether or not a token is ever minted | Probably the largest idle line item here, and the one worth checking first. **Confirm the current model and rate on the Cognito pricing page** — this was not read from a bill |
| Secrets Manager, two secrets (`.../cognito/client-secret`, `.../mcp/request-state-key`) | **Time-based**, per secret per month, plus per-API-call | Roughly $0.80/month at the long-standing $0.40 per secret. Both are now created with `recovery_window_in_days = 0` (§11.4), so a destroy stops the meter at once instead of leaving them scheduled — and billable — for another 30 days |
| DynamoDB table | `PAY_PER_REQUEST` plus storage, plus point-in-time-recovery backup storage (PITR is **enabled**) | Cents. The table holds one household |
| ECR repository | Storage per GB-month; lifecycle policy keeps the last 20 images | Tens of cents, rising with image count. A Node 22 arm64 image is a few hundred MB |
| S3 manuals bucket | Storage; **versioning is enabled**, so deleted objects keep costing until the versions go | Cents |
| S3 Vectors bucket and index | Storage and requests; the index is empty and can never be filled while §5 holds | Effectively zero |
| CloudWatch Logs from the runtime | Ingestion and storage per GB | Cents |
| IAM roles and policies, the OIDC provider | Free | Zero |
| The Terraform state bucket | S3 storage | Negligible |

The shape to take away: **nothing here is an always-on compute bill.** The recurring floor is the Cognito M2M
app client plus two Secrets Manager secrets plus a few cents of storage. Leaving the whole stack up between
test windows is a small, bounded cost.

**The runtime row is verified against the provider source, and it is stronger than "probably cheap."**
`infra/modules/agentcore-runtime/main.tf` declares no CPU and no memory — not as an omission, but because
**the Terraform resource has no such attribute to set.** Grepping `hashicorp/aws`
`internal/service/bedrockagentcore/agent_runtime.go` for `cpu`, `memory`, `vcpu`, `capacity_provider` or
`platform_version` returns nothing. A resource that cannot express a size cannot hold a reservation, so
allocation is the service's decision per session and the bill follows consumption. The published pricing
page agrees: billing is per second on actual CPU and memory with a one-second minimum, CPU scales to zero
during I/O wait, and Runtime v2 reclaims idle memory after 120 seconds.

**The one non-zero idle line, and it is tiny.** CPU scales to zero during I/O wait; memory does not. Memory
is billable for the life of an *open session*, not merely during an invocation, so a session somebody opens
and abandons keeps billing until `idle_session_timeout_seconds` expires. This project sets that to **1800**
(`infra/live/demo/platform/variables.tf` line 48). At the 128 MB billing floor that is
`0.128 GB × 0.5 h × $0.00945/GB-h` ≈ **$0.0006** per abandoned session. A judge who opens a session and walks
away costs six hundredths of a cent. With no sessions open, the runtime bills nothing.

> **Scope correction, because "no always-on compute" is true of this stack and not of the service.** AgentCore
> Runtime also has a second compute model — **instances**, reached through capacity providers
> (`create-capacity-provider`), billed at EC2 On-Demand rates plus a management fee **per instance-hour from
> provisioning until termination**. That is a genuine always-on bill. HomeLedger uses none of it:
> `update-agent-runtime` exposes `--capacity-provider-configuration`, but the Terraform resource does not
> surface it and the module sets nothing, so this runtime is on the default serverless microVM path. Read
> every "costs nothing while idle" sentence in this section as scoped to that path.

**Real dollar spend: not determined.** No Cost Explorer or Pricing API call has been made from here, and the
figures above are list prices rather than a bill. The GitHub OIDC trust policy admits only `main` and
`pull_request` (§7.1), so a scratch-branch probe cannot read the account; getting the numbers needs a
credentialed human, or a `ce get-cost-and-usage` step merged into `aws-oidc-check.yml` on `main`. The
unverified line still worth checking against a real bill is the recurring floor — the Cognito M2M app client
plus the two secrets — not the runtime.

### 11.2 Leave the runtime up. Teardown rotates the ARN, and nothing gives the old one back

**Earlier revisions of this section framed teardown as routine cost control and called it "the cheap lever."
That framing was wrong, and this is the correction.** The lever is cheap in dollars and expensive in
addresses. The default recommendation between now and the end of judging on **2026-11-20** is to **leave the
runtime running**.

**Why: teardown is the only thing that rotates the runtime ARN, and there is nothing to rotate it behind.**

1. **The id is generated at create time.** The ARN is
   `arn:aws:bedrock-agentcore:us-east-1:<account>:runtime/demo_homeledger_mcp-<10 random chars>`, and a
   destroy/create cycle draws a new suffix. The 2026-09-21 round trip turned `…-093ImbCPE3` into
   `…-Rgb4ruHdu7` (runs 35615354202 and 35616472515) — observed, not predicted.
2. **No alias, qualifier or custom domain survives it.** Named endpoints are real
   (`create/update/list-agent-runtime-endpoints`, and `?qualifier=DEFAULT` in the invocation URL is an
   endpoint name rather than a version number), and a named endpoint can even be pinned to a version and
   repointed later. But the endpoint ARN pattern is
   `…/runtime/<name>-[a-zA-Z0-9]{10}/runtime-endpoint/<name>` and `create-agent-runtime-endpoint` requires
   `--agent-runtime-id`: the endpoint is a **child** of the runtime, so it inherits the rotating suffix and
   is a different resource once the parent is recreated. A review of the whole `bedrock-agentcore-control`
   command surface (170+ commands) found no alias command, no custom-domain command, and no DNS or ACM
   binding. AgentCore Gateway is the one native indirection, and it is not a transparent reverse proxy — it
   re-exposes targets as MCP tools, which is very likely to break `book_service`'s multi-round elicitation
   and its client-echoed `requestState`. That has not been tested and should not be adopted untested.
3. **Routine deploys do not rotate anything.** The provider has exactly two replacement triggers on this
   resource: `agent_runtime_name` (unconditional `RequiresReplace()`) and `agent_runtime_artifact` **only**
   when the artifact type flips between `container_configuration` and `code_configuration`. Image URI,
   environment variables, execution role, description, lifecycle, network, protocol, authorizer and request
   header configuration all update in place. Observed on run 35623151468: `Plan: 0 to add, 1 to change, 0 to
   destroy`, container URI moved, ARN unchanged at `…-Rgb4ruHdu7`. The historical record agrees — run
   35613845065 shows `agent_runtime_version = "14" -> (known after apply)` on one ARN, i.e. fourteen in-place
   updates without a rotation.

Put together: **a URL issued today survives every merge to `main` between here and judging, and survives
nothing else.** So there is no CloudFront proxy and no DNS layer in this repository, and none is needed.
§10.2's `print-setup` discovery — which finds the runtime by *name* through `ListAgentRuntimes` — stays the
supported path precisely because it is the only thing that does survive a rotation; the pasted URL is a
fallback for someone who wants an address.

**The teardown lever still exists, and it is still correctly scoped.** `infra/modules/agentcore-runtime/main.tf`
line 110:

```hcl
resource "aws_bedrockagentcore_agent_runtime" "this" {
  count = var.image_uri == "" ? 0 : 1
```

That `count` is on the runtime resource **and on nothing else**. Every other resource in the module (the
execution role and its inline policy) and in the platform root (ECR, DynamoDB, Cognito, the two Secrets
Manager secrets, the whole knowledge-base module) is unconditional. So an apply with `image_uri=""` destroys
exactly one resource: the AgentCore runtime. **Verified against the code, and then observed** — run
35615354202 planned and applied `0 added, 0 changed, 1 destroyed`, and the Cognito client id
(`3hhkt2a5j155d960s4uircaoqh`), the Knowledge Base id (`EKF93YIKCK`), the table and the seeded data were all
still there afterwards.

**Which is exactly the point worth carrying away from this section: a one-resource blast radius is not a
one-resource consequence.** The destroy touched a single resource and broke every consumer downstream of an
identifier that resource owned. Blast radius counts resources; consequence radius counts addresses.

`.github/workflows/teardown.yml`, `workflow_dispatch` only. Dispatch it from `main`:

```bash
gh workflow run teardown.yml --ref main \
  -f mode=teardown-runtime \
  -f confirm='destroy demo runtime'
gh run watch --repo jkarns87/homeledger
```

> **EXECUTED, in both modes, on 2026-09-21.** Teardown run **35615354202** (4 m 48 s to destroy the runtime,
> `Apply complete! Resources: 0 added, 0 changed, 1 destroyed`) and bring-up run **35616472515**
> (`Creation complete after 5s`, `1 added, 0 changed, 0 destroyed`), followed by smoke run **35616643237**
> printing `SMOKE OK`. Earlier revisions of this section carried a **NOT EXECUTED** caveat here; it no longer
> applies to §11.2 or §11.3. What is still unexecuted is §11.4's full destroy and the Secrets Manager
> re-apply, which are marked at the point of use.

**If you dispatch it anyway, say so first.** Anyone holding a URL or a `claude mcp add` entry has to be told
to re-run `print-setup`, because nothing will tell them: the old URL does not redirect, it simply stops
resolving to a runtime.

Four things about the workflow are worth knowing before you press it.

**It refuses without the typed phrase.** `confirm` must be exactly `destroy demo runtime`. Anything else —
including an empty string, which is what a dispatch from the GitHub UI gives you if you skip the field —
fails the first step of the job with a red X. That is deliberately a *failing step* rather than a job-level
`if:` condition: a skipped job reports green, and green is the wrong answer to "you did not confirm".

**It cannot destroy anything but the runtime, and that is structural rather than policed.** The job runs
`terraform apply -var image_uri=""`. It never runs `terraform destroy`, passes no `-target`, and has no
input that widens it. Given the `count` above is the only conditional in the whole configuration, an apply
is *incapable* of removing ECR, the table, Cognito, the secrets or the Knowledge Base, whatever it is asked
for. On top of that the job plans first, reads the plan back as JSON, and **refuses to apply** if the plan
would create anything at all, or would delete anything other than
`module.agentcore_runtime.aws_bedrockagentcore_agent_runtime.this`. In-place updates are printed and
tolerated — they cannot rotate an identifier.

**Destroying the rest is deliberately not offered here, at any confirmation strength.** Cognito rotates the
client id and secret; the Knowledge Base rotates its id; ECR takes every image with it, which leaves
bring-up nothing to redeploy; DynamoDB takes the household data. A full destroy is an out-of-band act with a
human holding credentials — §11.4. Putting it behind a scarier string in the same dispatch menu would make
the dangerous operation exactly as easy to reach as the routine one.

**Both jobs share `concurrency: deploy-demo` with `deploy.yml`'s `apply`,** so a teardown can never
interleave with a deploy against the same state file.

The job prints, to the run summary: the image URI the runtime is currently running (recorded *before* the
destroy, because afterwards the `deployed_image_uri` output is `""` and the tag is no longer in state), the
full plan, and a closing line confirming `agent_runtime_arn` is empty. That summary is the record of what
happened, and it is where the tag for §11.3 comes from.

### 11.3 Bringing it back

**A plain `deploy.yml` re-run does work, and is the fallback.** After a runtime-only teardown the ECR
repository is still in Terraform state, so `deploy.yml`'s bootstrap step (`if ! terraform state list | grep
-qx 'aws_ecr_repository.mcp'`) is skipped, its build-and-push step succeeds, and the final apply recreates
the runtime. Nothing about the teardown breaks it.

```bash
gh workflow run deploy.yml --ref main
gh run watch --repo jkarns87/homeledger
gh workflow run smoke.yml --ref main
```

About three and a half minutes for the deploy, about fifty seconds for the smoke.

**`teardown.yml`'s `bring-up` mode is the faster, more faithful path**, and it exists for one reason:
`deploy.yml` rebuilds the image from whatever `main` holds today, which is a different artifact from the one
that was torn down. `bring-up` builds nothing and pushes nothing. It redeploys an image **already in ECR**:

```bash
gh workflow run teardown.yml --ref main -f mode=bring-up -f image_tag=abc1234
```

Leave `image_tag` empty to take the most recently pushed image. The job refuses, with an instruction rather
than a stack trace, in the two cases where there is nothing honest to do: no `aws_ecr_repository.mcp` in
state (a brand-new account — `deploy.yml` owns the bootstrap, and `bring-up` deliberately does not
reimplement it), and a repository with no tagged images. Note that the ECR lifecycle policy keeps only the
last 20 images, so a tag from a long-ago teardown may have expired; the empty-tag form or a `deploy.yml` run
is the answer then.

It finishes by reading `agent_runtime_arn` and `agent_runtime_invocation_url` back and failing if either is
empty, so a half-applied stack is a red run rather than a quiet one.

**Observed, run 35616472515:** dispatched with an empty `image_tag`, the whole job took **49 s** wall and
Terraform reported `Creation complete after 5s` / `1 added, 0 changed, 0 destroyed`. One detail the empty-tag
path exposes and this file should not gloss: `describe-images` sorted by push time and took
`imageTags[0]`, which was **`:latest`**, not the `:ee3517d` the teardown had recorded. Same digest here, so
the artifact that came back was the one that went away — but if you want the recorded tag specifically, pass
it, rather than relying on the empty form to pick it.

**One thing does change across the round trip, either way, and it is the expensive one:** the runtime is a
new resource, so its **ARN is new** — `…-093ImbCPE3` became `…-Rgb4ruHdu7` in this round trip. That
invalidates every invocation URL already issued, and AgentCore offers no alias or qualifier that survives it
(§11.2). **`claude mcp add` entries generated after FL-039 are the exception and need nothing done to them:**
they carry no `HOMELEDGER_RUNTIME_ARN`, and the bridge resolves `demo_homeledger_mcp` by name at every start,
so the next launch picks up the new ARN by itself. An entry that pins one — generated before FL-039, or
pinned on purpose — refuses to start with a sentence naming the ARN that replaced it; re-run
`pnpm --filter @homeledger/mcp-bridge run print-setup` and reissue the command, and tell anyone else holding
a raw URL to do the same. **Nothing else moves** — verified across this round trip: the Cognito client id
(`3hhkt2a5j155d960s4uircaoqh`), the token URL, the table with its seeded data and the Knowledge Base id
(`EKF93YIKCK`) were byte-identical before and after.

### 11.4 Full teardown, and why it is still not a round trip

There is deliberately no full-destroy workflow. Doing it needs a human with credentials running
`terraform destroy` against the demo state, and before doing it, know what does not come back the same.

> **NOT EXECUTED, with one row excepted.** Everything in this subsection is reasoned from the Terraform and
> the AWS provider's documented behaviour, not observed — treat it as a pre-flight checklist, not a
> transcript. The exception is the **AgentCore runtime** row, which the 2026-09-21 round trip executed for
> real (§11.2); it is a transcript.

| Resource | Destroys cleanly? | The catch |
| --- | --- | --- |
| AgentCore runtime | Yes — **observed**, run 35615354202 | Recreated with a **new ARN** (`…-093ImbCPE3` → `…-Rgb4ruHdu7`), so every `claude mcp add` config and every issued invocation URL goes stale, and no AgentCore alias, qualifier or domain can prevent it |
| DynamoDB table | Yes | All household data goes. Re-seedable in seconds with `seed:remote`, so this is the least painful loss |
| ECR repository | Yes, `force_delete = true` | Every image tag goes with it. `teardown.yml`'s `bring-up` then has nothing to redeploy and refuses; the next `deploy.yml` run rebuilds and repushes |
| Manuals S3 bucket | Yes, `force_destroy = true` (module default) | Uploaded PDFs and every object version go. S3 bucket names are global; reusing the same name immediately can hit propagation delay |
| S3 Vectors bucket and index | Unknown | Deletion semantics for `aws_s3vectors_*` were not exercised. Assume nothing |
| Cognito user pool, domain, resource server, app client | Yes | **The client id and the client secret both change.** `print-setup` must be re-run and the Claude Code entry reissued. A just-released domain prefix can take time to become available again |
| Bedrock Knowledge Base and data source | Yes | The `knowledge_base_id` changes, so the runtime's `KNOWLEDGE_BASE_ID` changes with it |
| IAM execution roles and inline policies | Yes | |
| **The two Secrets Manager secrets** | **Yes — now.** Was: scheduled, not deleted | See below |

**The Secrets Manager 30-day window was the trap, and it is closed in the configuration.** Neither
`aws_secretsmanager_secret.request_state` (platform root) nor `aws_secretsmanager_secret.this` (the
`cognito-m2m` module) used to set `recovery_window_in_days`, so the provider's default of 30 applied. A
destroy *scheduled* both secrets rather than deleting them, and a scheduled secret keeps its **name**
reserved for the whole window — so re-applying the stack with the same names inside it failed with
`InvalidRequestException: You can't create this secret because a secret with this name is already scheduled
for deletion`. Tear the demo down in October and it could not come back for judging in November without
renaming or a manual `restore-secret`.

Both are now created with `recovery_window_in_days = 0`, which the AWS provider translates into
`DeleteSecret` with `ForceDeleteWithoutRecovery=true` rather than `RecoveryWindowInDays`. The secrets are
deleted outright, the names free up, and a re-apply works. The cost is that **there is no restore** — the
DeleteSecret API reference is blunt about it: "you have no opportunity to recover the secret. You lose the
secret permanently." That is correct here and only here: the `requestState` key is a `random_password`
regenerated on every apply, and the Cognito client secret is regenerated with the app client. Both are
warned about in a comment at the resource itself, because a future reader copying `cognito-m2m` into
something real has to see it at the line rather than in this file.

The module keeps the safe behaviour by default. `infra/modules/cognito-m2m` declares
`var.recovery_window_in_days` with a **default of 30**; `infra/live/demo/platform` is the thing that opts in,
through its own `var.secret_recovery_window_in_days` (default `0`), which it passes to both secrets. A
non-demo copy of the root sets 7–30 in one place and gets production semantics back.

> **NOT EXECUTED, and this is the honest limit of the fix.** No destroy and no re-apply has been run against
> AWS. What is proven offline: the plan sets `recovery_window_in_days` to 0 on both secrets and to 30 when
> the variable says so (`terraform test`, `mock_provider`, six assertions and two validation runs across
> `infra/live/demo/platform/tests/platform.tftest.hcl` and
> `infra/modules/cognito-m2m/tests/cognito-m2m.tftest.hcl`, each checked to fail under a mutation); and the
> AWS provider source maps `recovery_window_in_days == 0` to `ForceDeleteWithoutRecovery = true`. What is
> **not** proven: that a real destroy followed by a real re-apply of the same names succeeds. AWS performs a
> forced deletion asynchronously and its own documentation says to "use appropriate back off and retry
> logic" if you recreate the same name immediately — so a re-apply within seconds of a destroy may still
> need one retry. A plan diff is not a destroy. The first real round trip settles it.

### 11.5 The safe minimal state, and a judging-window plan

**Safe minimal state, defined:** everything applied except the AgentCore runtime. Nothing is on the critical
path of a request, the recurring cost is the Cognito M2M client plus two secrets plus cents of storage, and
recovery is one dispatch of `teardown.yml` in `bring-up` mode. Reaching it is one dispatch as well.

**It is available, and between now and 2026-11-20 it is the wrong state to be in.** Two of its claimed
properties do not both hold. "Every identifier is stable" is true of Cognito, the Knowledge Base, the table
and ECR — and false of the runtime ARN, which is the one identifier a caller actually addresses. The saving
is a fraction of a cent (§11.1); the cost is every URL already handed out (§11.2). Reserve the safe minimal
state for a gap long enough that nobody is holding an address — after judging, not during it.

**Judging runs 2026-11-09 to 2026-11-20, and the stack should be up for it.** A judge who follows §10.2 and
finds no runtime gets

```
No AgentCore runtime named demo_homeledger_mcp in us-east-1 (profile homeledger-admin). The demo stack may
not be deployed — .github/workflows/deploy.yml applies it on a push to main, and it creates the runtime only
once an image has been pushed. Names present: ...
```

which is a clear message about a system that looks broken. §4 stays available regardless and is the path a
judge without AWS credentials takes anyway.

The window plan, in full:

| When | Do |
| --- | --- |
| ~~Well before 2026-11-09~~ | **Done, 2026-09-21.** The round trip was run once with time to spare — teardown 35615354202, bring-up 35616472515, smoke 35616643237 green. It worked, and it taught the thing this section now turns on: the ARN rotated |
| Between now and the window | **Leave the runtime up.** Every merge to `main` updates it in place and keeps the ARN (§11.2), so the URL issued today stays valid. Do not dispatch `teardown-runtime` again before 2026-11-20 |
| Before the window | `gh workflow run deploy.yml --ref main`, then `gh workflow run smoke.yml --ref main`, confirm `SMOKE OK`. `print-setup` and `claude mcp add` only need reissuing if the runtime was recreated in between — an ordinary deploy does not recreate it |
| During the window | Leave it up. §11.1 is why on cost; §11.2 is the larger why — a teardown mid-judging breaks every address a judge already has |
| After 2026-11-20 | `gh workflow run teardown.yml --ref main -f mode=teardown-runtime -f confirm='destroy demo runtime'`, once nobody is holding an address that has to keep working |

**One dispatch prerequisite that is a repository setting rather than a file in this tree.** Both jobs in
`teardown.yml` declare `environment: demo`, whose deployment branch policy admits `main`, `plan-*` and
`worktree-*` (§7.3). Dispatching it from any other branch will sit waiting or be rejected by that policy.
Dispatch from `main`.

---

## 12. Troubleshooting

Failures actually hit on this project, with their exact text and a one-line fix. Ordered roughly by where in
this runbook you meet them.

### `pnpm test` is green but the DynamoDB tests did not run

They are gated on `DYNAMO_ENDPOINT` being set and report as skipped, not failed, so a green `pnpm test`
proves nothing about the DynamoDB path. Run `docker compose up -d`, then
`pnpm --filter @homeledger/core test:dynamo`. §6.3.

### A pnpm script named after a pnpm subcommand is never reached

```
 ERROR  Unknown option: 'recursive'
For help, run: pnpm help setup
```

You ran `pnpm --filter @homeledger/mcp-bridge setup`. `setup` is one of pnpm's own subcommands, so the
builtin wins, the builtin takes no `--recursive`, and the whole command dies at argument parsing. The script
is called `print-setup`:

```bash
pnpm --filter @homeledger/mcp-bridge run print-setup
```

The error misdirects twice — it names an option nobody typed, and it points at help for a command you did
not mean to invoke. Nothing in it contains the word "script". FL-034; reproduced while writing this.

### The image build cannot resolve a workspace package

```
 ERR_PNPM_WORKSPACE_PKG_NOT_FOUND  In apps/mcp-server: "<pkg>@workspace:*"
is in the dependencies but no package named "<pkg>" is present in the workspace
```

A `workspace:*` edge on `apps/mcp-server` or `packages/core` points at a package the image's build context
does not copy. `--prod` prunes dev dependencies from the *output*; it does not stop the resolver reading
them, so a dev-only edge breaks the build exactly as a production one would. **Remove the edge, do not widen
the build context** — widening couples the server image to a package it does not need and breaks again on
the next workspace change. The message misdirects twice: it says "is in the dependencies" for a
`devDependencies` entry, and prints `Packages found in the workspace:` followed by nothing at all, which
reads like a broken workspace rather than a deliberate subset. FL-036.

### The server rejects a request on the Host header

Locally:

```
403 {"code":-32000,"message":"Invalid Host: <host>"}
```

Through AgentCore, the same rejection arrives as a JSON-RPC error with nothing useful in it:

```
-32010 Received error (403) from runtime. Please check your CloudWatch logs
```

and CloudWatch shows only a clean `listening` line, because the SDK rejects before any middleware logs.
Locally, `ALLOWED_HOSTS` is unset and defaults to `localhost,127.0.0.1,0.0.0.0` — connect on one of those,
not a LAN IP or a hostname. The deployed runtime sets `ALLOWED_HOSTS="*"` and disables the check entirely,
because AgentCore forwards an internal, undocumented, cell-specific Host (observed:
`cell01.us-east-1.prod.arp.kepler-analytics.aws.dev`) that cannot be pinned in advance, and the JWT
authorizer is the real access control there. FL-020.

### `book_service` refuses instead of asking three questions

You will hear:

> I can't book a service visit from this app. Booking has to ask you three things first, which provider to
> send, which arrival window to take, and whether to go ahead, and this app can't show me those questions.
> Everything else still works. To book, come back from an app that can prompt you for answers.

That is a client that declared no elicitation capability, answered with a deliberate spoken refusal — not a
protocol error, and not a booking made without asking. Claude Code 2.1.56 gates elicitation behind the
GrowthBook feature `tengu_mcp_elicitation`, which **defaults to false** with no settings or environment
override, so this is the common case rather than the rare one, and it is remote config that can flip off
without warning. Read out of the client bundle for FL-033 and not re-checked against a later build.

### The bridge says your AWS SSO session expired

```
[homeledger-bridge] Your AWS SSO session expired, run `aws login --profile homeledger-admin`
```

Exactly what it says, and the most likely failure in the whole bridge path. On an AWS CLI older than v2.31
the command is `aws sso login --profile homeledger-admin`.

### The bridge or the setup helper defaulted to a profile you did not choose

```
AWS_PROFILE is not set, so this used the default profile homeledger-admin. If your session lives on a
different profile, set AWS_PROFILE to it and run this again.
```

`export AWS_PROFILE=homeledger-admin`, or whichever profile actually holds your session. It defaults rather
than failing, and says so, because the values it discovers come from whichever account that profile points
at — and reading "expired session" for a profile you never named is a dead end.

### The profile named does not exist

```
AWS_PROFILE is set to <name>, and no profile of that name exists in ~/.aws/config. Set AWS_PROFILE to one
that does — `aws configure list-profiles` lists them — or create it with `aws configure sso`.
```

This check runs *before* the expired-session check on purpose: the AWS SDK raises both as
`CredentialsProviderError`, and the unordered version tells someone with a typo'd profile to sign in to a
profile that does not exist.

### The identity is signed in but not permitted

```
The AWS identity from profile <p> is not allowed to call <action> in <region>. Grant it that permission, or
fill the values into the `claude mcp add` command by hand.
```

A permissions problem, not a session problem — signing in again cannot fix it. The five read-only
permissions the bridge path needs are listed in §10.2.

### `--from-terraform` fails on backend initialisation

```
[homeledger-bridge] `terraform output` failed in infra/live/demo/platform: Command failed: terraform output
-raw cognito_token_url
Error: Backend initialization required, please run "terraform init"
Reason: Initial configuration of the requested backend "s3"
```

You used `--from-terraform` or `HOMELEDGER_SETUP_SOURCE=terraform`. Drop it — the default AWS path needs no
Terraform at all. **Running `terraform init` as the error suggests does not help:** `backend.tf` declares
`backend "s3" {}` with an empty body and `deploy.yml` supplies the bucket and region as `-backend-config`
flags, so this root is not initialisable from a laptop by design and you would get a second error rather
than a working directory. FL-035; reproduced while writing this.

### No AgentCore runtime is found

```
No AgentCore runtime named demo_homeledger_mcp in us-east-1 (profile homeledger-admin). The demo stack may
not be deployed — .github/workflows/deploy.yml applies it on a push to main, and it creates the runtime only
once an image has been pushed. Names present: ...
```

Either the stack is torn down between test windows (§11.5) or your profile is pointed at a different
account. `gh workflow run deploy.yml --ref main` brings it back in about three and a half minutes.

### `ask_manual` answers that it cannot look anything up

> I can't look anything up in the manuals right now. Searching them needs a model to read your question
> first, and model access is blocked on this AWS account ...

The Bedrock block, on the deployed runtime. Nothing you did, and not fixable from this repository. §5.
Locally, with `KNOWLEDGE_BASE_ID` unset, the same tool works from fixtures.

### `!! ask_manual: SKIPPED` in a smoke run

The same block, recognised. The run is still green and still meaningful — the tool was reached, invoked and
answered in budget, and every other assertion ran. §9.2.

### `Error 002` from a Bedrock call

```
ValidationException ... Error 002: Access to Bedrock models is not allowed for this account
```

The raw form of the same block, from `aws-oidc-check.yml`'s probe or from `seed:manual`'s
`StartIngestionJob`. §5.

### `legacy terminateSession: non-fatal ... Not Found`

```
legacy terminateSession: non-fatal - Streamable HTTP error: Failed to terminate session: Not Found
```

Expected, non-fatal, and present in every green smoke run including 35478596365. AgentCore does not reliably
route the bare-body `DELETE` back to the microVM holding the session, even though every `POST` and the SSE
`GET` in the same session routed correctly. Sessions expire on the idle timeout regardless, so on-demand
termination is best-effort cleanup rather than part of the smoke contract. FL-022, open, not blocking.

### A pull request is blocked on a `plan` check that never appears

**Fixed at the source on 2026-09-21; kept here because the symptom is worth recognising.** The pull request
did not touch `infra/**`, `apps/**`, `packages/**`, `scripts/**` or `.github/workflows/deploy.yml`, so
`deploy.yml` never triggered, so its `plan` check never reported — and a required check that never reports
blocks rather than passes. `plan` was dropped from `main`'s required set, so this no longer happens: the
three required checks all live in `ci.yml`, which has no path filter (§8.3).

If you see it again, the cause is `plan` having been added back to the required set. §8.3 says why it should
not be.

### `hash_key is deprecated` warnings in a Terraform apply

```
Warning: Argument is deprecated
  with aws_dynamodb_table.homeledger,
  hash_key is deprecated. Use key_schema instead.
  (and 7 more similar warnings elsewhere)
```

Eight in total, on every apply. Expected noise from the pinned AWS provider against
`aws_dynamodb_table.homeledger`. Not a failure.

---

## 13. What in this document is verified, and what is not

### Executed against this repository at commit `1851301`

`pnpm install --frozen-lockfile` · `pnpm install` · `pnpm --filter @homeledger/core build` · `pnpm format` ·
`pnpm typecheck` · `pnpm build` · `pnpm test` (`pnpm -r test`) · `pnpm --filter @homeledger/core test:dynamo` ·
`pnpm --filter @homeledger/core seed:local` · `docker compose up -d` / `down` ·
`pnpm --filter @homeledger/mcp-server dev` in both `MEMORY_REPO=1` and `DYNAMO_ENDPOINT` modes, and driven
through a real MCP session (initialize, `tools/list`, `list_appliances`, `get_appliance`, `maintenance_due`,
`recent_events`, `ask_manual`) · `docker build` and `docker run` of `apps/mcp-server/Dockerfile` ·
`pnpm --filter @homeledger/mcp-bridge setup` (to reproduce FL-034's error) ·
`pnpm --filter @homeledger/mcp-bridge run print-setup -- --from-terraform` (to reproduce FL-035's error) ·
`terraform fmt -check -recursive` in `infra/` · `aws login help`, `aws configure list-profiles`,
`aws bedrock-agentcore-control list-agent-runtimes help`,
`aws bedrock-agentcore-control delete-agent-runtime help`, `aws secretsmanager restore-secret help` (local
help output only, no API calls) · `claude mcp add --help`, `claude mcp remove --help` ·
`npm view @modelcontextprotocol/inspector version` · `gh workflow list`, `gh variable set --help`,
`gh run watch --help`, `gh run view 35478596365`, `gh run view 35478430481`, and `gh api` for repository
variables, branch protection, environments, and owner/repo IDs.

Script names were checked against the `scripts` block of each `package.json` rather than copied from
`README.md`. Flags were checked against each tool's own `--help`. Paths were checked to exist. The local
server was driven over HTTP with `curl` rather than only started, so the tool list, its order, and four tool
results in this document are observed output rather than transcribed from source.

Added for §11's rewrite, run at commit `1973cf0` plus the teardown branch: `terraform init -backend=false`,
`terraform validate`, `terraform fmt -check -recursive` and `terraform test` in `infra/live/demo/platform`
and in all three modules under `infra/modules/` (30 runs, green, up from 21) · `terraform test -verbose` to print the
teardown plan diff against the mocked provider, which reports `Plan: 0 to add, 1 to change, 1 to destroy`
with the destroy being `module.agentcore_runtime.aws_bedrockagentcore_agent_runtime.this[0]` (the one change
is a mock artifact: the mocked `aws_region` data source fabricates a fresh value per evaluation, so the
knowledge base's embedding model ARN churns) · eight deliberate mutations, each applied to shipped Terraform,
run, and reverted · `actionlint` on `.github/workflows/teardown.yml` · `prettier --check` on it · the plan
guard's shell and `jq` against five hand-built plan-JSON fixtures · `terraform-docs` to regenerate two
READMEs. **No AWS call was made.**

Added for §11's second rewrite, all read back from GitHub Actions run logs rather than from a local AWS
session (**no AWS call was made from here either**): `gh run view` on runs **35615354202** (`teardown.yml`,
mode teardown — `Plan: 0 to add, 0 to change, 1 to destroy`, `Destruction complete after 4m48s`),
**35616472515** (`teardown.yml`, mode bring-up — `Creation complete after 5s`, new ARN `…-Rgb4ruHdu7`,
resolved image `:latest`), **35616643237** (`smoke.yml` — `SMOKE OK`, `legacy book_service (three
elicitations plus progress): 1807 ms`, `progress 0,1,2,3`), **35623151468** (`deploy.yml` dispatch —
`Plan: 0 to add, 1 to change, 0 to destroy`, ARN unchanged), **35629345017** (`aws-oidc-check.yml` —
`demo_homeledger_mcp READY`), **35628816957** (`aws-oidc-check.yml` on a scratch branch — role assumption
refused), and **35478596365** (the pre-teardown smoke, for the identifier comparison). Provider replacement
behaviour was read from `hashicorp/aws` `internal/service/bedrockagentcore/agent_runtime.go`; the endpoint
ARN pattern and the absence of any alias or custom-domain command from the installed AWS CLI's own
`bedrock-agentcore-control` model (`aws-cli/2.36.48`).

Added for Plan 3 (`apps/simulator`): `pnpm --filter @homeledger/simulator run test:e2e` — the six-spec
Playwright suite (§4.6), run against a local `mcp-server` (`MEMORY_REPO=1`) and the simulator itself in
scripted-model mode, 6/6 passing, no AWS call and no Anthropic call · `pnpm --filter @homeledger/simulator
run build` (`next build`) with no `ANTHROPIC_API_KEY` or AWS credential of any kind set · `pnpm -r test` and
`pnpm -r typecheck` across all five workspace packages including `apps/simulator` · the equivalent of the new
`e2e` job in `.github/workflows/ci.yml` (fresh `core`/`mcp-bridge` builds, `playwright install chromium`,
`test:e2e`), run locally rather than on a GitHub Actions runner — see "Not executed" below for what that
does not prove.

Also re-read on 2026-09-21: `gh api repos/jkarns87/homeledger/branches/main/protection`, returning
`["test","terraform","image"]` — which corrected §8.3's four-check figure, stale since `plan` was dropped
from the required set. Run by a token holding admin on the repository; the token used for the run-log reads
above does not, and gets a `404` on that endpoint.

### Not executed, and marked as such where it appears

- **Most of §7 (first-time AWS bootstrap).** No IAM or S3 call was made, and the trust policy **document** is
  reconstructed from the workflows and the Plan 1 task brief rather than read back from IAM. Its **scope** is
  no longer unverified: run 35628816957 proves a non-`main`, non-pull-request branch cannot assume the role,
  and the green runs on `main` and on pull requests prove the two admitted subjects. §7.1 records both.
- **`gh workflow run deploy.yml` and `gh workflow run smoke.yml`.** Command shapes verified; effects
  described from the workflow files and from the logs of runs 35478430481 and 35478596365.
- **The four AWS discovery calls behind `print-setup`,** and therefore the exact `claude mcp add` command it
  emits. FL-035 lists the three specific assumptions the first live run will settle.
- **The bridge against the deployed runtime.** Its unit and end-to-end tests (187 passing, including a
  spawned-process run against a real local server) all pass; the AgentCore session pinning in particular is
  reasoned, not measured.
- ~~**`.github/workflows/teardown.yml`, in either mode.**~~ **No longer unverified.** Both modes were
  dispatched on 2026-09-21 and both succeeded — teardown 35615354202, bring-up 35616472515 — followed by a
  green smoke, 35616643237. §11.2 and §11.3 are now written from those logs rather than from the file. The
  offline work still stands behind them: the plan guard's shell and `jq` against five hand-built
  `terraform show -json` fixtures (runtime-only delete, an extra delete, a replace, an empty plan, a
  create-everything plan — it accepts the first and refuses the rest), `actionlint` on the file, and the
  round trip as a `mock_provider` test (`infra/live/demo/platform/tests/teardown.tftest.hcl`). The plan
  guard's *real-provider* behaviour is now observed too: the live teardown plan was exactly the
  runtime-only delete the guard accepts.
- **The Secrets Manager fix in §11.4, at the only level that would settle it: a real destroy followed by a
  real re-apply.** What is proven is the plan (`terraform test` with `mock_provider` shows
  `recovery_window_in_days = 0` on both secrets, and 30 when the variable says so; each assertion was
  checked to fail under a deliberate mutation) and the provider's translation of 0 into
  `ForceDeleteWithoutRecovery = true` (read from `internal/service/secretsmanager/secret.go`). A plan diff
  is not a destroy. AWS's own `DeleteSecret` reference also notes that a forced deletion is asynchronous, so
  an immediate same-name re-apply may need a retry — which no offline check can rule in or out.
- **`aws ecr describe-images` as `teardown.yml`'s `bring-up` job calls it — the empty-tag branch only.** The
  `sort_by(imageDetails,&imagePushedAt)[-1].imageTags[0]` query has now run against the real repository
  (run 35616472515) and returned `latest`, so the branch works and its tag-selection quirk is recorded in
  §11.3. The **explicit** `--image-ids imageTag=…` branch, and the two refusal paths, have still not run.
- **Every dollar figure in §11.1.** AWS list-price estimates, not a bill. No Cost Explorer or Pricing API
  call was made — and the OIDC trust policy's scope (§7.1) means a scratch-branch workflow cannot make one
  either. The billing *shape* for the runtime is verified from the provider source and the pricing page; the
  *amounts* are not.
- **S3 Vectors deletion semantics.** Listed as unknown rather than guessed.
- **`npx @modelcontextprotocol/inspector` (§4.4).** The package was confirmed to exist and resolve
  (`npm view` returns 2.7.0); the Inspector UI itself was not launched. It downloads on first run.
- **§6.5's `terraform init -backend=false`, `validate` and `test`.** Only `terraform fmt -check -recursive`
  was run here; the other three are what `ci.yml`'s `terraform` job runs on every pull request, and they are
  green on run 35477139811.
- **`claude mcp add --transport http ...` (§4.3, §10.1).** The flags are verified against
  `claude mcp add --help` and the server was driven over the same URL with a real MCP client handshake, but
  the entry was not added to this machine's Claude Code configuration.
- **The simulator against the deployed runtime, with the real model (§4.6, README "The simulator").** Needs a
  real `ANTHROPIC_API_KEY` — not on the implementer's machine — and makes a live Cognito call, a live
  AgentCore call, and a live Anthropic call, none of which an implementer may make. `FRICTION-LOG.md` FL-055
  and `task-15-report.md`'s "Step 7 — owner checklist" carry the exact sequence and the seven checks a run has
  to satisfy; nothing in this document states or implies a result for it. Everything upstream — the six
  Playwright specs above — is real coverage of the wiring against a local, scripted server, not a substitute
  for this.
- **The new `e2e` job in `.github/workflows/ci.yml`, on an actual GitHub Actions runner.** The YAML was
  validated to parse and the job graph checked (`[test, e2e, image, terraform]`); the equivalent command
  sequence was run locally and passed 6/6 (see "Executed" above). `--with-deps`'s apt-based browser install
  and a genuinely from-scratch `pnpm install --frozen-lockfile` on a hosted runner were not exercised from
  here. The job is not one of `main`'s required checks (§8.3) — adding it there is a repository setting, the
  owner's call.

### Corrections to things stated elsewhere

- **Prettier does not cover Markdown in this repository.** `.prettierignore` lists both `docs/` and `*.md`.
  Verified by putting a deliberately misformatted Markdown file at the repository root and under `docs/` and
  watching `prettier --check` pass both. `pnpm format` will never flag a Markdown file here.
- ~~**`README.md` says `apps/` contains `mcp-server` only**~~ **No longer applicable.** That bullet (under
  "Not yet built," about the Echo Show simulator) is gone: `apps/simulator` now exists, so the claim it made
  — that `apps/` held `mcp-server` only — is moot rather than corrected. `apps/` holds `mcp-server`,
  `mcp-bridge` and `simulator`.
- **§8.3 recorded four required checks until 2026-09-21, and that was stale rather than wrong-when-written.**
  `plan` was required when the paragraph was authored and was removed later the same week, for the reason
  §8.3 had itself predicted: it is path-filtered, so a docs-only pull request could never satisfy it. The
  list is now `test`, `terraform`, `image`, read back from the protection API. **The staleness is the lesson,
  not the number.** Branch protection is a repository setting that no check in this tree can validate, and
  the list had been transcribed into more than one document, so updating the setting silently falsified the
  docs. §8.3 is now the only place that states it; everywhere else points there. If you are tempted to
  restate the list somewhere convenient, this bullet is what that costs.
- **A check appearing green on a pull request does not mean it is required.** It means the job ran. The two
  states are indistinguishable from a passing rollup, and the failure mode that matters — a required check
  that never reports — only shows up on the pull requests where the job does *not* run. `gh pr view --json
  statusCheckRollup` cannot answer "what is required"; only the protection API can (§8.3). This was the
  reasoning error that let the stale four-check figure survive a review.
