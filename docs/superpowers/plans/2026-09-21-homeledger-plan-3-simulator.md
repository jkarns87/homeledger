# HomeLedger Plan 3: The Simulated Echo Show Client

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/simulator` — a Next.js web client that renders an Echo Show-shaped surface following Alexa+'s documented visual foundations, drives the **deployed** HomeLedger MCP server through an agent on the Anthropic API, surfaces `book_service`'s three-round elicitation as interface rather than chat text, renders the four `ui://` MCP Apps widgets the server already serves, and never claims to be Alexa+.

**Architecture:** One Next.js 15 App Router application with a hard server/client split. `src/server/` holds everything that touches a credential: the Cognito token source and runtime-by-name resolution (both imported from `@homeledger/mcp-bridge`, which this plan gives an `exports` map), an MCP client wrapper around `@modelcontextprotocol/sdk` 1.30.0 that rebuilds a lost session and replays once, an elicitation registry, and the agent loop over `@anthropic-ai/sdk`. The browser talks only to three route handlers. `POST /api/agent/turn` answers with an SSE stream that stays open for the whole turn; `POST /api/agent/answer` delivers one elicitation answer on a **separate** request while that stream is still open. That is deliberately the same shape as the MCP wire itself — a held-open response carrying questions, answers arriving as sibling POSTs — and it deadlocks under the same two mistakes `apps/mcp-bridge/src/proxy.ts` already paid for: buffering the response, or serialising the requests.

**Tech Stack:** Node 22, pnpm 10.15.0, TypeScript 5.9, Next.js 15.5 (App Router, `runtime = 'nodejs'`), React 19.3, `@anthropic-ai/sdk` 0.127 (model `claude-opus-5`), `@modelcontextprotocol/sdk` 1.30.0 (the 2025-era client — the path every real client takes, FL-033), `@homeledger/mcp-bridge` (token + runtime resolution), `@homeledger/core` (`todayInZone`, `SEED_TIMEZONE` — the household-day rule, never re-derived here), Vitest 3 with `@testing-library/react` 16 and jsdom 30, `@playwright/test` 1.63 for the env-gated end-to-end run.

**Spec:** `docs/superpowers/specs/2026-09-13-homeledger-design.md` (sections 2 row "Alexa+ visual foundations", 3 `apps/simulator`, 4.2 the tool table, 4.4 widgets, 4.5 auth, 7 in full, 9 testing, 10 disclosure)

**Predecessor:** `docs/superpowers/plans/2026-09-14-homeledger-plan-2-server-completion.md` — read its "What Plan 3 starts from" section. Everything it lists is merged and deployed.

## Deviations from the spec, and why

Two, both forced, both recorded here rather than discovered by the implementer.

**1. The agent runs on the Anthropic API, not on Strands over Bedrock.** Spec §7 says `@strands-agents/sdk` on Bedrock with Claude Sonnet 4.6. Bedrock **model invocation is refused account-wide** on this account and has been continuously since 2026-09-14 — `ValidationException ... Error 002: Access to Bedrock models is not allowed for this account`, from two unrelated principals, re-probed four times, support case 178941623300459 closed by AWS without resolving it (FL-019, FL-032). A Strands agent on Bedrock cannot make one call today, so building the primary deliverable on it would produce a simulator that has never run. The owner holds an Anthropic account and API key, which sidesteps the block entirely, and Claude Code already drives this exact server through `apps/mcp-bridge` on the Anthropic API — so the path is not merely available, it is the one already proven end to end against the deployed runtime. Everything else in §7 stands: the same `McpClient`-over-`StreamableHTTPClientTransport` shape, the same Cognito bearer, the same elicitation-callback-renders-a-card design, the same transport tap for the debug drawer. What changes is which model provider answers. The spec's Bedrock choice is superseded on this point and nowhere else; `packages/core`'s `ManualRetriever` and the Nova vision path in the Ring plan are untouched by this and still wait on FL-019.

**2. The simulator is not deployed to Amplify in this plan.** Spec §8 lists an Amplify app in the Terraform root. Hosting is out of scope here for one reason that is not schedule: a public endpoint that holds an Anthropic API key and proxies an unauthenticated agent loop is a separate security decision, not a build step, and this plan is documentation-and-application-code only. The simulator runs locally against the **deployed** server, which is what the video needs. When hosting is taken on it is its own plan with its own Terraform and its own auth in front of `/api/agent/*`.

## Global Constraints

- Node `>=22.0.0`; pnpm `10.15.0`; every package `"type": "module"`.
- **Mutation-check discipline, standing requirement.** An assertion is proven only when a reasonable mutation to the guarded code makes it fail. Never hunt for a mutation the existing assertion happens to catch — pick the mutation an ordinary wrong edit would make, apply it, run the suite, and record how many tests failed and which. Twenty-two assertions across Plans 1 and 2 could not fail under any such mutation. The four recurring shapes, all of which appear naturally in this plan's material, are: **self-referential assertions** (the test computes the expected value the same way the code does — FL-028); **symmetric contract reads** (a writer and a reader in the same module agreeing with each other and with nothing else); **loose matchers** (`toContain`, `toBeTruthy`, `expect.anything()` where an exact value is knowable); and **branches made unreachable by a library's own preprocessing** (the `isError` case in FL-032's N6, which survived because every fixture reached the same verdict one branch lower). Every task below names the mutation to apply; when a mutation survives, fix the test rather than the note, then re-run and record the new count.
- Every task ends with a commit. **Commit messages carry no trailer of any kind** — no `Co-Authored-By`, no generated-by line, nothing after the body.
- **Alexa+ visual foundations, exact values (spec §2 table, §7).** Base canvas `768 × 480`, scaled `1.667` on Echo Show 8/15, so the simulator frame is `1280 × 800`. Dark is the default: card `#14181E`, nested `#1B2028`. Light: card `#FFFFFF`, page `#FAF9FB`. **No Amazon or Alexa logos or wordmarks anywhere in the UI, in an asset, or in a filename.** These are the same tokens `apps/mcp-server/src/widgets/shell.ts` already uses; the frame and the widgets must not drift apart.
- **Alexa+ functional requirements (spec §2 success criterion 3).** Spoken text never contains JSON, a choice never offers more than five options, and a tool call is expected back inside 3 s. The simulator enforces the first two on the surfaces it owns and measures the third in the debug drawer.
- **The nine tools and their frozen order.** `list_appliances, get_appliance, maintenance_due, log_maintenance, recent_events, ask_manual, book_service, get_visit, echo_confirm`. The simulator reads the order from `tools/list` and never hard-codes a subset; the deployed runtime sets `HOMELEDGER_DEV_TOOLS=1`, so nine is the count against the real endpoint and eight against a server started without it. Assert on `tools/list`'s own order, not on a literal of your own.
- **Never claim to be Alexa+.** The frame carries a permanently visible disclosure that this is a simulation driving a real MCP server, and that the service-provider marketplace is sample data. It is in the UI, not only in the README (spec §10). No string in this application says the product name of a voice assistant it is not.
- **A failed tool call is shown as a failure.** Twice a model client turned a transport failure into a confident answer drawn from repository fixtures (FL-039). Every failed call therefore does three things: emits a `tool-failed` event the transcript renders as a failure, returns a `tool_result` block with `is_error: true`, and puts `NO_DATA_NOTICE` in that block so the model is told in words that nothing was retrieved and that answering from memory or fixtures is not available to it.
- **A decline is not a failure, and the honest-failure rule is not allowed to swallow it.** `isError` is MCP's flag for *the call did not execute*; a client is entitled to render it as a crash, and Claude Code does — a clean "Not now" on `book_service` reaches the transcript as `Error: Okay, I haven't booked anything`. Somebody choosing not to book is an ordinary outcome of a working call, so `book_service` returns a normal result for it (Task 5, Step 1, in `apps/mcp-server`). Using `isError` for a domain outcome is the same papering-over as the bullet above, pointed the other way: there, a failure was dressed as an answer; here, an answer was dressed as a failure. Neither rule may be relaxed to make the other easier.
- **`ask_manual` will fail until Bedrock returns, and must degrade visibly.** Against the deployed Knowledge Base, `Retrieve` embeds the question as well as the documents, so the block refuses the read path and `ask_manual` returns an error result with no `structuredContent` at all (FL-032). The simulator renders that as a named, explained failure card — never as "no passages found", and never as an answer.
- **Elicitation over a proxy deadlocks if done naively, and this is a proxy.** `book_service`'s `tools/call` POST answers `200 text/event-stream` and **stays open** carrying all three `elicitation/create` requests; each answer is a separate POST sent while it is open, each returning `202`; the call's own response completes only after the third answer (FL-033). Two properties are mandatory and neither fails loudly when lost — responses are **streamed, never buffered**, and requests are allowed to **overlap**. `apps/mcp-bridge/src/proxy.ts` and `apps/mcp-bridge/src/sse.ts` already solve this; the MCP client SDK solves it for the server leg. This plan's own browser-facing leg has the identical shape and must not rediscover it.
- **The MCP session can be lost mid-conversation.** The container answers 404 in exactly one place — `apps/mcp-server/src/legacy.ts` line 50, a request carrying an `Mcp-Session-Id` its in-memory map does not hold — after an idle gap on a stack whose `idle_session_timeout_seconds` is 1800 (FL-039). The simulator rebuilds the session by reconnecting and replays the failed call **exactly once**, and says so on the transcript rather than silently.
- **"Today" is the household's day, never the UTC one.** Spec §4.2 names `now().slice(0, 10)` as the wrong construct by name, and it was a live bug three days ago: maintenance items flipped to overdue at 7 PM US Central. `packages/core` exports `todayInZone(instantIso, zone)` and `SEED_TIMEZONE` for exactly this, and the server already renders every human-facing time through them. The simulator **speaks** the date — it goes into the system prompt as `Today is …` — so it reads the household's zone from `homeledger://household` at connect and computes the date with `todayInZone`. No file in `apps/simulator` may contain `.toISOString().slice(0, 10)` or any other hand-rolled calendar date.
- **No secrets in client-side code.** `ANTHROPIC_API_KEY`, the Cognito client secret, and the AgentCore bearer token are read only under `src/server/`, only inside a request, and never at module load. No `NEXT_PUBLIC_` name carries any of them and `next.config.ts` declares no `env` block. Task 2 ships a test whose scope is **everything the Next bundler can follow**: it fails if a credential name appears anywhere under `apps/simulator/src/` outside `src/server/`, or anywhere in `apps/simulator/next.config.ts`. That is the whole of the bundler's reach and the whole of the guard's claim — test files and `playwright.config.ts` are outside it because Next never compiles them, and `playwright.config.ts`'s own placeholder is pinned by an assertion in Task 15 instead. A guard that claimed the package root while walking `src` would be a guard nobody could trust about its own scope.
- **Environment is read lazily.** `next build` runs in CI with no credentials at all, so no module may read a required environment variable at import time. Every accessor is a function called per request.
- Prettier config is `{ "singleQuote": true, "printWidth": 160, "trailingComma": "none", "arrowParens": "avoid" }`, and `jsxSingleQuote` is unset, so **JSX attributes use double quotes** while TypeScript strings use single. `pnpm format` runs in CI; `.prettierignore` gains `.next` in Task 1.
- TypeScript is `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules` — inherited from `tsconfig.base.json`. Type-only imports must say `import type`.
- `@homeledger/core` is consumed through its built `dist/`, so run `pnpm --filter @homeledger/core build` after changing core and before typechecking anything that imports it. `@homeledger/mcp-bridge` becomes the same kind of consumer in Task 2 and must be built before the simulator typechecks.
- **The simulator must never become a dependency of `@homeledger/mcp-server`.** `apps/mcp-server/Dockerfile` copies only `packages/core` and `apps/mcp-server` into its build context, and `pnpm --prod deploy` resolves the whole workspace graph before it prunes (FL-036). A dependency edge pointing the wrong way breaks an image that CI's `test` job would still call green; the `image` job is the check that catches it.
- `main` requires `test`, `terraform`, and `image`. This plan touches no Terraform and no workflow, so `terraform` and `image` must stay green by not being disturbed; `test` runs `pnpm format`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @homeledger/core test:dynamo`, and `pnpm build` — all five must pass with the new package in the workspace.
- **Make no live AWS call, no Ring API call, and do not deploy.** Every test in this plan runs against an in-process MCP server over a real local socket, or against injected fakes. The one task that talks to the deployed runtime (Task 13) is env-gated and skipped by default, exactly as `packages/core/test/dynamo.test.ts` is.
- Any deviation from documented behaviour gets a `FRICTION-LOG.md` entry in the existing six-field format, committed with the workaround. **The last entry is FL-040 — the `Intl`/ICU entry filed by the household-timezone work at `a40f3d1` — so the next free number is FL-041.** (This plan was drafted when FL-039 was last; PR #14 landed FL-040 in between, which is why every FL number named below moved up by one.) Numbers named in tasks below are estimates from FL-040; always take the lowest free number at the time you file, re-check it with `grep -n '^### FL-' FRICTION-LOG.md | tail -3` immediately before writing the heading, and say so in the commit body.

## Out of scope (their own plans)

Amplify or any other hosting, and the Terraform that would go with it (see Deviations §2). The Ring account-link, webhook, correlator, snapshot and push pipeline — `get_visit` returns `snapshotUrl` and `description` as `null` here and the visit widget renders that state, which is Plan 4's starting point. The proactive WebSocket channel (spec §7 last bullet, §6.4): it exists to deliver Ring cards, so it belongs with Ring. Voice input and output: spec §1 lists Web Speech as optional and never required, and this plan does not add it. The `skills/homeledger` Agent Skill package, the video, and the submission assets.

**The ambient home screen** (spec §7, first bullet, alongside "transcript overlay, text input") is also out of scope here, and unlike the four above it is a spec item this plan simply does not ship, so it is named rather than left to be noticed. An ambient screen is the surface a display shows when nobody is talking to it, and its content is proactive — the next visit, an alert, a due task pushed to it. The push channel that would feed it is Plan 4's, so an ambient screen built now would be a static panel that never changes, which teaches the wrong thing about the product. The frame, the canvas and the theme it would live in are all built here; what Plan 4 adds is the reason for it to exist.

---

## File structure

Every file below is created or modified by exactly one task, and every file a task creates appears here. The two lists are checked against each other in Task 16, Step 3a: a file implemented but not declared, or declared but folded into another module, is the drift that put `ProgressMeter.tsx` in this block and its code inside `ElicitationCard.tsx` in the draft this replaces.

```
apps/mcp-bridge/
├── package.json                    # MOD  T2   exports map + main/types so the simulator can import the token source
└── src/index.ts                    # unchanged (the entrypoint stays the entrypoint)

apps/mcp-server/
├── package.json                    # MOD  T6   exports map: ./app and ./test-harness
├── src/tools/service.ts            # MOD  T5   a decline returns a normal result, not isError
├── test/book-service-modern.test.ts    # MOD  T5
└── test/book-service-legacy.test.ts    # MOD  T5

apps/simulator/
├── package.json                    # NEW  T1
├── next.config.ts                  # NEW  T1   no env block, no NEXT_PUBLIC_ anything
├── tsconfig.json                   # NEW  T1   extends the base, overrides module/jsx for Next
├── vitest.config.ts                # NEW  T1   two projects: node for *.test.ts, jsdom for *.test.tsx
├── playwright.config.ts            # NEW  T15  local, scripted, no credential
├── src/
│   ├── shared/                     # vocabulary both halves speak: holds no credential, imports no React
│   │   ├── events.ts               # NEW  T3   TurnEvent union, SSE encode, incremental decode
│   │   └── canvas.ts               # NEW  T10  BASE_CANVAS, CANVAS_SCALE, DEVICE - the one place 768x480 is written
│   ├── server/                     # nothing here is ever imported from a 'use client' module
│   │   ├── env.ts                  # NEW  T2   lazy, server-only environment accessors
│   │   ├── credentials.ts          # NEW  T2   Cognito token + runtime-by-name, via @homeledger/mcp-bridge
│   │   ├── elicitation.ts          # NEW  T4   ElicitationRegistry
│   │   ├── tools.ts                # NEW  T5   MCP <-> Anthropic translation, NO_DATA_NOTICE, total result reader
│   │   ├── mcp.ts                  # NEW  T6   HomeLedgerMcp: connect, call, heal address, rebuild, replay once
│   │   ├── prompt.ts               # NEW  T7   system prompt (persona rules, honest-failure rules)
│   │   ├── model.ts                # NEW  T7   ModelPort over @anthropic-ai/sdk
│   │   ├── scripted-model.ts       # NEW  T15  the same ModelPort, answering from a fixed script
│   │   ├── agent.ts                # NEW  T8   runTurn: the tool loop
│   │   ├── session.ts              # NEW  T9   one process-wide conversation: mcp + registry + history + zone
│   │   └── http.ts                 # NEW  T9   the Request/Response layer every route adapter delegates to
│   ├── app/
│   │   ├── layout.tsx              # NEW  T1
│   │   ├── page.tsx                # NEW  T1, replaced T11, extended T12 T13 T14
│   │   ├── globals.css             # NEW  T1, appended T10 T11 T12 T13 T14
│   │   └── api/
│   │       ├── health/route.ts     # NEW  T1
│   │       ├── debug/route.ts      # NEW  T13
│   │       ├── widget/route.ts     # NEW  T14  serves one ui:// resource as HTML
│   │       ├── widget/tool/route.ts# NEW  T14  the widget tool allowlist
│   │       └── agent/
│   │           ├── turn/route.ts   # NEW  T9   SSE, never buffered
│   │           └── answer/route.ts # NEW  T9   one elicitation answer, sibling request
│   ├── components/
│   │   ├── Frame.tsx               # NEW  T10  1280x800 shell, 768x480 canvas at 1.667
│   │   ├── Disclosure.tsx          # NEW  T10  the simulation + sample-data notice
│   │   ├── Transcript.tsx          # NEW  T11, modified T13 T14
│   │   ├── Composer.tsx            # NEW  T11
│   │   ├── ElicitationCard.tsx     # NEW  T12  choice (<=5) and confirm
│   │   ├── ProgressMeter.tsx       # NEW  T12  0 -> 3
│   │   ├── FailureCard.tsx         # NEW  T13  one failed call, explained and quoted
│   │   ├── DebugDrawer.tsx         # NEW  T13  protocol version, session id, JSON-RPC log, per-call timing
│   │   └── WidgetFrame.tsx         # NEW  T14  sandboxed iframe + host attach
│   └── lib/
│       ├── transcript.ts           # NEW  T11  Entry/AgentState and the pure reducer
│       ├── useAgentTurn.ts         # NEW  T11  client hook over the SSE stream
│       ├── failures.ts             # NEW  T13  explainFailure, NOTHING_RETRIEVED
│       └── widget-host.ts          # NEW  T14  the view-side protocol's host half
└── test/
    ├── health.test.ts              # NEW  T1
    ├── credentials.test.ts         # NEW  T2,  appended T15
    ├── no-client-secrets.test.ts   # NEW  T2
    ├── events.test.ts              # NEW  T3
    ├── elicitation.test.ts         # NEW  T4
    ├── tools.test.ts               # NEW  T5
    ├── mcp.test.ts                 # NEW  T6   against a real socket
    ├── prompt.test.ts              # NEW  T7
    ├── model.test.ts               # NEW  T7
    ├── agent.test.ts               # NEW  T8   fake model, real in-process server
    ├── routes.test.ts              # NEW  T9,  appended T13 T14
    ├── frame.test.tsx              # NEW  T10
    ├── transcript.test.ts          # NEW  T11  the reducer, no React
    ├── transcript.test.tsx         # NEW  T11  the hook and the view
    ├── elicitation-card.test.tsx   # NEW  T12
    ├── failures.test.ts            # NEW  T13
    ├── failures.test.tsx           # NEW  T13
    ├── widget-host.test.tsx        # NEW  T14  .tsx, NOT .ts: it needs the jsdom project (see Task 14, Step 1)
    ├── e2e/fixtures.ts             # NEW  T15
    └── e2e/simulator.spec.ts       # NEW  T15  Playwright, run deliberately

.prettierignore                     # MOD  T1   .next
.gitignore                          # MOD  T2   .env.local
.env.example                        # MOD  T2, T15  the simulator's variables
README.md                           # MOD  T16  the simulator section
docs/RUNBOOK.md                     # MOD  T16  section 4 gains "and talk to it from the simulator"
FRICTION-LOG.md                     # MOD  T14, T15, T16  FL-041 onwards
```

---

### Task 1: Scaffold `apps/simulator` in the workspace

**Files:**
- Create: `apps/simulator/package.json`, `apps/simulator/next.config.ts`, `apps/simulator/tsconfig.json`, `apps/simulator/vitest.config.ts`, `apps/simulator/src/app/layout.tsx`, `apps/simulator/src/app/page.tsx`, `apps/simulator/src/app/globals.css`, `apps/simulator/src/app/api/health/route.ts`
- Modify: `.prettierignore`
- Test: `apps/simulator/test/health.test.ts`

**Interfaces:**
- Consumes: the workspace's `pnpm-workspace.yaml` glob `apps/*`, which already matches.
- Produces:
  ```ts
  // src/app/api/health/route.ts
  export const runtime = 'nodejs';
  export const dynamic = 'force-dynamic';
  export function GET(): Response;   // 200 {"ok":true,"app":"homeledger-simulator"}
  ```
  and the package `@homeledger/simulator` with scripts `dev`, `dev:e2e`, `build`, `start`, `typecheck`, `test`, `test:e2e`.

- [ ] **Step 1: Write the failing test**

`apps/simulator/test/health.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { GET, dynamic, runtime } from '../src/app/api/health/route.js';

describe('health route', () => {
  it('answers with the application name', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, app: 'homeledger-simulator' });
  });

  it('runs on the Node runtime and is never statically rendered', () => {
    // Both matter. The agent route holds an SSE stream open across several
    // minutes and keeps the MCP session in process memory, neither of which
    // survives the edge runtime or a prerender.
    expect(runtime).toBe('nodejs');
    expect(dynamic).toBe('force-dynamic');
  });

  it('reads no environment variable at import time', async () => {
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) delete process.env[key];
    try {
      const fresh = await import(`../src/app/api/health/route.js?fresh=${Date.now()}`);
      expect((fresh as { GET: () => Response }).GET().status).toBe(200);
    } finally {
      Object.assign(process.env, saved);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @homeledger/simulator run test`
Expected: FAIL — the package does not exist, so pnpm reports no project matched the filter.

- [ ] **Step 3: Create the package**

`apps/simulator/package.json`:
```json
{
  "name": "@homeledger/simulator",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev -p 3000",
    "dev:e2e": "next dev -p 3100",
    "build": "next build",
    "start": "next start -p 3000",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.127.0",
    "@homeledger/core": "workspace:*",
    "@homeledger/mcp-bridge": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.30.0",
    "next": "^15.5.25",
    "react": "^19.3.0",
    "react-dom": "^19.3.0"
  },
  "devDependencies": {
    "@homeledger/mcp-server": "workspace:*",
    "@playwright/test": "^1.63.0",
    "@testing-library/react": "^16.3.3",
    "@types/node": "^22.0.0",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.1",
    "jsdom": "^30.1.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

`@homeledger/mcp-server` is a **dev** dependency: the tests start the real server in process over a real socket, which is the only way this plan can prove elicitation without an AWS account. The edge points simulator → server and never the other way, so the container build is untouched (FL-036).

`@homeledger/core` is a **runtime** dependency, for exactly two symbols: `todayInZone` and `SEED_TIMEZONE`. The simulator speaks the date out loud, and the household-day rule is already solved, tested and fixed once in core (spec §4.2; the UTC construct was a live bug). A second implementation here would be a second thing to get the evening of 19:00 US Central wrong in. The edge still points simulator → core, so FL-036 is unaffected; note the standing constraint that core is consumed through its built `dist/`, so `pnpm --filter @homeledger/core build` runs before this package typechecks.

`apps/simulator/next.config.ts`:
```ts
import type { NextConfig } from 'next';

/**
 * Deliberately minimal, and the absence of an `env` block is the point: any
 * key listed there is inlined into the client bundle at build time. The
 * Anthropic API key, the Cognito client secret and the AgentCore bearer are
 * read at request time under src/server/ and reach the browser through
 * nothing.
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false
};

export default config;
```

`apps/simulator/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["dom", "dom.iterable", "esnext"],
    "jsx": "preserve",
    "noEmit": true,
    "declaration": false,
    "sourceMap": false,
    "allowJs": true,
    "incremental": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "src", "test", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`apps/simulator/vitest.config.ts`:
```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'server', include: ['test/**/*.test.ts'], environment: 'node' }
      },
      {
        extends: true,
        test: { name: 'ui', include: ['test/**/*.test.tsx'], environment: 'jsdom' }
      }
    ]
  }
});
```

`apps/simulator/src/app/api/health/route.ts`:
```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ ok: true, app: 'homeledger-simulator' });
}
```

`apps/simulator/src/app/globals.css` — the exact tokens `apps/mcp-server/src/widgets/shell.ts` uses, so the frame and the widgets inside it cannot drift:
```css
:root {
  color-scheme: dark;
  --bg: #0d1015;
  --card: #14181e;
  --nested: #1b2028;
  --text: #f4f5f7;
  --muted: #a3a9b8;
  --line: #2a303a;
  --accent: #6ea8fe;
  --warn: #e8a266;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  background: #05070a;
  color: var(--text);
  font: 15px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
```

Two things this file deliberately does **not** contain. There is no `:root[data-theme='light']` block: the theme is a property of the simulated device, not of the page around it, so the light palette is declared once on `.device[data-theme='light']` in Task 10 and the toggle inside the frame drives it. A second copy on `:root` would be dead the moment `layout.tsx` hard-codes `data-theme="dark"` on `<html>` — which it does, permanently — and a dead palette is a palette that drifts from the live one unnoticed. And there are no `--canvas-width` / `--canvas-height` / `--canvas-scale` variables: the canvas geometry lives in `src/shared/canvas.ts` (Task 10), which is the single source TypeScript, the widget host and the frame's own inline styles all read. Writing 768 in CSS as well would be the third copy of a number that must never disagree with itself.

`apps/simulator/src/app/layout.tsx`:
```tsx
import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'HomeLedger simulator',
  description: 'A simulated smart-display client driving the HomeLedger MCP server.'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
```

`apps/simulator/src/app/page.tsx` — a placeholder this task replaces nothing of; Task 8 fills it:
```tsx
export default function Home() {
  return <main>HomeLedger simulator</main>;
}
```

Append to `.prettierignore`:
```
.next
```

- [ ] **Step 4: Install and run the test**

```bash
pnpm install
pnpm --filter @homeledger/simulator run test
```
Expected: PASS, three tests.

If the third test fails with a module-resolution error on the `?fresh=` query, Vitest is not passing the query through to its loader; replace that line with `await import('../src/app/api/health/route.js')` plus `vi.resetModules()` before it, keep the assertion, and record the difference in `FRICTION-LOG.md`. Do not delete the test: reading the environment at import time is the failure it exists to catch, and `next build` in CI has no credentials.

- [ ] **Step 5: Prove the workspace still builds**

```bash
pnpm --filter @homeledger/core build
pnpm format
pnpm typecheck
pnpm test
pnpm build
```
Expected: every command exits 0. `next build` compiles the two routes and the placeholder page. If `pnpm format` complains, run `pnpm format:write` and commit the result.

- [ ] **Step 6: Commit**

```bash
git add apps/simulator .prettierignore pnpm-lock.yaml
git commit -m "feat(simulator): scaffold the Next.js package in the workspace"
```

---

### Task 2: Server-only configuration, credentials, and the secret guard

**Files:**
- Create: `apps/simulator/src/server/env.ts`, `apps/simulator/src/server/credentials.ts`
- Modify: `apps/mcp-bridge/package.json`, `.env.example`, `.gitignore`
- Test: `apps/simulator/test/credentials.test.ts`, `apps/simulator/test/no-client-secrets.test.ts`

**Interfaces:**
- Consumes: from `@homeledger/mcp-bridge` — `loadConfig`, `type BridgeConfig`, `DEFAULT_AWS_PROFILE`, `ConfigError` (`src/config.ts`); `resolveRuntime`, `createAwsRuntimeLister` (`src/runtime.ts`); `resolveClientSecret`, `createSecretsManagerReader` (`src/secret.ts`); `createTokenSource`, `type TokenSource` (`src/token.ts`); `type AwsIdentityContext` (`src/aws-errors.ts`).
- Produces:
  ```ts
  // src/server/env.ts
  export class SimulatorConfigError extends Error {}
  export interface SimulatorEnv { anthropicApiKey: string; model: string; maxRounds: number; elicitationTimeoutMs: number; allowOrigin: string | undefined }
  export function readSimulatorEnv(source?: NodeJS.ProcessEnv): SimulatorEnv;
  export const DEFAULT_MODEL = 'claude-opus-5';
  export const DEFAULT_MAX_ROUNDS = 8;
  export const DEFAULT_ELICITATION_TIMEOUT_MS = 120_000;

  // src/server/credentials.ts
  export interface UpstreamCredentials {
    url: string;
    arn: string | undefined;
    origin: 'url' | 'arn' | 'name';
    token: () => Promise<string>;
    invalidateToken: () => void;
    /** Looks the runtime up by name again and yields its current invocation URL. */
    resolveUrl: () => Promise<string>;
  }
  export async function resolveUpstream(source?: NodeJS.ProcessEnv, log?: (m: string) => void): Promise<UpstreamCredentials>;
  ```

- [ ] **Step 1: Give `@homeledger/mcp-bridge` an entry point**

Add to `apps/mcp-bridge/package.json`, between `"type"` and `"scripts"`:
```json
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./config": { "types": "./dist/config.d.ts", "import": "./dist/config.js" },
    "./runtime": { "types": "./dist/runtime.d.ts", "import": "./dist/runtime.js" },
    "./secret": { "types": "./dist/secret.d.ts", "import": "./dist/secret.js" },
    "./token": { "types": "./dist/token.d.ts", "import": "./dist/token.js" },
    "./aws-errors": { "types": "./dist/aws-errors.d.ts", "import": "./dist/aws-errors.js" }
  },
```

Subpaths rather than one barrel, for one reason: `src/index.ts` is a `#!/usr/bin/env node` entrypoint that runs the bridge on import. Importing `@homeledger/mcp-bridge` bare would start a stdio proxy inside a Next.js route. The `.` entry stays declared so the existing `node .../dist/index.js` invocation in the generated `claude mcp add` command is unaffected, and nothing in the simulator imports it.

- [ ] **Step 2: Write the failing tests**

`apps/simulator/test/credentials.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_ELICITATION_TIMEOUT_MS, DEFAULT_MAX_ROUNDS, DEFAULT_MODEL, SimulatorConfigError, readSimulatorEnv } from '../src/server/env.js';

const minimal = { ANTHROPIC_API_KEY: 'sk-ant-test' } as NodeJS.ProcessEnv;

describe('readSimulatorEnv', () => {
  it('reads the key and fills every other value from a default', () => {
    expect(readSimulatorEnv(minimal)).toEqual({
      anthropicApiKey: 'sk-ant-test',
      model: DEFAULT_MODEL,
      maxRounds: DEFAULT_MAX_ROUNDS,
      elicitationTimeoutMs: DEFAULT_ELICITATION_TIMEOUT_MS,
      allowOrigin: undefined
    });
  });

  it('names the variable, and the file it belongs in, when the key is missing', () => {
    expect(() => readSimulatorEnv({})).toThrow(SimulatorConfigError);
    expect(() => readSimulatorEnv({})).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(() => readSimulatorEnv({})).toThrow(/apps\/simulator\/\.env\.local/);
  });

  it('treats set-but-empty as a misconfiguration rather than as unset', () => {
    expect(() => readSimulatorEnv({ ANTHROPIC_API_KEY: '   ' })).toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it('overrides every default from the environment', () => {
    expect(
      readSimulatorEnv({
        ANTHROPIC_API_KEY: 'sk-ant-test',
        HOMELEDGER_SIMULATOR_MODEL: 'claude-sonnet-5',
        HOMELEDGER_SIMULATOR_MAX_ROUNDS: '3',
        HOMELEDGER_SIMULATOR_ELICITATION_TIMEOUT_MS: '5000',
        HOMELEDGER_SIMULATOR_ALLOW_ORIGIN: 'http://127.0.0.1:3000'
      })
    ).toEqual({
      anthropicApiKey: 'sk-ant-test',
      model: 'claude-sonnet-5',
      maxRounds: 3,
      elicitationTimeoutMs: 5000,
      allowOrigin: 'http://127.0.0.1:3000'
    });
  });

  it('refuses a round budget that is not a positive integer rather than silently using the default', () => {
    for (const value of ['0', '-1', '2.5', 'many', '']) {
      expect(() => readSimulatorEnv({ ...minimal, HOMELEDGER_SIMULATOR_MAX_ROUNDS: value }), value).toThrow(/HOMELEDGER_SIMULATOR_MAX_ROUNDS/);
    }
  });

  it('reads process.env when given no source', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-process';
    try {
      expect(readSimulatorEnv().anthropicApiKey).toBe('sk-ant-from-process');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
```

`apps/simulator/test/no-client-secrets.test.ts`:
```ts
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../src', import.meta.url));
/**
 * The other half of the bundler's reach.
 *
 * `next.config.ts` is not under `src/`, is never imported by anything there,
 * and is the one file outside it that can put a value into the client bundle —
 * an `env` block is inlined at build time, by design. A guard that walked only
 * `src` would be blind to the single most effective way to leak a key from this
 * package, so it is read by name. Test files and `playwright.config.ts` are
 * deliberately NOT in scope: Next never compiles them, `credentials.test.ts`
 * legitimately names `ANTHROPIC_API_KEY` on nearly every line, and a guard
 * extended to cover them would have to be relaxed until it proved nothing.
 */
const nextConfig = fileURLToPath(new URL('../next.config.ts', import.meta.url));

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) files.push(full);
  }
  return files;
}

/** Names that must never be read anywhere the bundler could follow into the browser. */
const CREDENTIAL_NAMES = ['ANTHROPIC_API_KEY', 'HOMELEDGER_COGNITO_CLIENT_SECRET', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

describe('client-side secret guard', () => {
  it('mentions a credential name only under src/server', async () => {
    const offenders: string[] = [];
    for (const file of await walk(root)) {
      if (file.includes(`${join('src', 'server')}`)) continue;
      const text = await readFile(file, 'utf8');
      for (const name of CREDENTIAL_NAMES) if (text.includes(name)) offenders.push(`${file}: ${name}`);
    }
    expect(offenders).toEqual([]);
  });

  it('never prefixes a credential with NEXT_PUBLIC_, anywhere at all', async () => {
    const offenders: string[] = [];
    for (const file of [...(await walk(root)), nextConfig]) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) offenders.push(`${file}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps next.config.ts free of credential names and of an env block entirely', async () => {
    // Two separate failures, both fatal, neither visible in `src`. A name here
    // is a name the bundler can reach; an `env` block is the mechanism that
    // reaches it, and it inlines its values into the browser bundle at build
    // time whatever they are called.
    const text = await readFile(nextConfig, 'utf8');
    for (const name of CREDENTIAL_NAMES) expect(text, name).not.toContain(name);
    expect(text).not.toMatch(/\benv\s*:/);
  });

  it("never imports src/server from a 'use client' module", async () => {
    const offenders: string[] = [];
    for (const file of await walk(root)) {
      const text = await readFile(file, 'utf8');
      if (!/^\s*(['"])use client\1/m.test(text)) continue;
      for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1] ?? '';
        if (specifier.includes('/server/') || specifier.startsWith('@/server')) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @homeledger/simulator run test -- credentials`
Expected: FAIL, cannot find module `../src/server/env.js`.

- [ ] **Step 4: Implement the environment accessor**

`apps/simulator/src/server/env.ts`:
```ts
/**
 * Every value the simulator needs from its own environment, read lazily.
 *
 * Lazily is load-bearing twice over. `next build` runs in CI with no
 * credentials at all, so a module-scope read would fail the required `test`
 * job on a machine that has no business holding an API key. And the process
 * that serves a turn is long-lived, so reading per request means a key
 * rotation takes effect on the next turn rather than on the next deploy.
 */
export class SimulatorConfigError extends Error {}

export const DEFAULT_MODEL = 'claude-opus-5';
/** Model turns per user turn before the loop gives up. Eight covers list -> get -> book (three elicitations) with room to spare. */
export const DEFAULT_MAX_ROUNDS = 8;
/** How long one elicitation may wait for a person to click. Two minutes: a demo pause, not an outage. */
export const DEFAULT_ELICITATION_TIMEOUT_MS = 120_000;

export interface SimulatorEnv {
  anthropicApiKey: string;
  model: string;
  maxRounds: number;
  elicitationTimeoutMs: number;
  /** When set, the agent routes accept only this Origin. Undefined leaves the check off, which is correct for a localhost demo. */
  allowOrigin: string | undefined;
}

function positiveInt(source: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = source[key]?.trim();
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0)
    throw new SimulatorConfigError(`${key} must be a positive whole number of ${key.endsWith('_MS') ? 'milliseconds' : 'rounds'}; got ${JSON.stringify(raw)}.`);
  return Number(raw);
}

export function readSimulatorEnv(source: NodeJS.ProcessEnv = process.env): SimulatorEnv {
  const anthropicApiKey = source.ANTHROPIC_API_KEY?.trim();
  if (!anthropicApiKey)
    throw new SimulatorConfigError(
      'ANTHROPIC_API_KEY is not set. The simulator drives the deployed MCP server with an agent on the Anthropic API, not on Bedrock, because Bedrock model invocation is blocked account-wide on this AWS account (FRICTION-LOG.md FL-019). Put the key in apps/simulator/.env.local, which is git-ignored, or export it in the shell you start `pnpm --filter @homeledger/simulator run dev` from.'
    );
  return {
    anthropicApiKey,
    model: source.HOMELEDGER_SIMULATOR_MODEL?.trim() || DEFAULT_MODEL,
    maxRounds: positiveInt(source, 'HOMELEDGER_SIMULATOR_MAX_ROUNDS', DEFAULT_MAX_ROUNDS),
    elicitationTimeoutMs: positiveInt(source, 'HOMELEDGER_SIMULATOR_ELICITATION_TIMEOUT_MS', DEFAULT_ELICITATION_TIMEOUT_MS),
    allowOrigin: source.HOMELEDGER_SIMULATOR_ALLOW_ORIGIN?.trim() || undefined
  };
}
```

- [ ] **Step 5: Implement the upstream credentials**

`apps/simulator/src/server/credentials.ts`:
```ts
import type { AwsIdentityContext } from '@homeledger/mcp-bridge/aws-errors';
import { DEFAULT_AWS_PROFILE, loadConfig } from '@homeledger/mcp-bridge/config';
import { createAwsRuntimeLister, resolveRuntime } from '@homeledger/mcp-bridge/runtime';
import { createSecretsManagerReader, resolveClientSecret } from '@homeledger/mcp-bridge/secret';
import { createTokenSource } from '@homeledger/mcp-bridge/token';

export interface UpstreamCredentials {
  /** The AgentCore invocation URL, complete with its `?qualifier=`. */
  url: string;
  arn: string | undefined;
  origin: 'url' | 'arn' | 'name';
  /** Yields the current bearer. Called per HTTP request so a mid-conversation refresh needs no plumbing upstream. */
  token: () => Promise<string>;
  /** Drops the cached bearer. Called by the MCP client on a 401 or 403, which is the bridge's rule (`proxy.ts:160-185`). */
  invalidateToken: () => void;
  /**
   * Re-resolves the runtime by name and yields its current invocation URL.
   *
   * Every consumer of this interface is long-lived, and the address it was
   * handed at startup is correct only until the runtime is next recreated:
   * AgentCore generates the id at create time and has no alias layer, so a
   * URL goes stale with nothing to say it did (FL-038, FL-039). The bridge
   * answers a 404 that carries no session with `healAddress()` — a fresh
   * lookup by name — rather than with a retry against the same place, and
   * this is what lets the simulator do the same. It re-runs only the lookup;
   * the config, the identity and the token source are already resolved.
   */
  resolveUrl: () => Promise<string>;
}

/**
 * Resolves which runtime to talk to and how to authenticate to it, reusing the
 * bridge's implementations rather than copying them.
 *
 * Reuse is not tidiness here. `resolveRuntime` is FL-039's fix: it looks the
 * runtime up by name at every start, because AgentCore generates a runtime's id
 * at create time and offers no alias layer (FL-038), so a pinned ARN is correct
 * only until the runtime is next recreated and nothing tells you when that
 * happened. A second implementation in this package would be a second thing to
 * get wrong, and it would get wrong exactly the part that has already cost this
 * project two confidently wrong answers.
 */
export async function resolveUpstream(source: NodeJS.ProcessEnv = process.env, log: (m: string) => void = () => {}): Promise<UpstreamCredentials> {
  const config = loadConfig(source);
  const identity: AwsIdentityContext = {
    region: config.region,
    profile: config.awsProfile ?? DEFAULT_AWS_PROFILE,
    profileFromEnvironment: Boolean(source.AWS_PROFILE?.trim() || source.HOMELEDGER_AWS_PROFILE?.trim())
  };
  const lookUp = () =>
    resolveRuntime({
      target: config.target,
      qualifier: config.qualifier,
      identity,
      lister: () => createAwsRuntimeLister(identity),
      log
    });
  const runtime = await lookUp();
  const clientSecret = await resolveClientSecret(config, () => createSecretsManagerReader(config));
  const tokens = createTokenSource({ tokenUrl: config.tokenUrl, clientId: config.clientId, clientSecret, scope: config.scope });
  return {
    url: runtime.url,
    arn: runtime.arn,
    origin: runtime.origin,
    token: () => tokens.get(),
    invalidateToken: () => tokens.invalidate(),
    resolveUrl: async () => (await lookUp()).url
  };
}
```

`invalidateToken` and `resolveUrl` are both produced here and both consumed in Task 6, by `HomeLedgerMcp`. That pairing is the point: the bridge already distinguishes the three ways a long-lived connection goes wrong — a refused bearer (401/403, invalidate and retry once), a 404 carrying a session (rehandshake against the same URL), and a 404 carrying none (`healAddress()`, re-resolve by name) — and a second client that implements only the middle one would fail the two failure modes this project has actually paid for. Neither function may be left unwired; Task 6, Step 6 mutation 6 exists to prove they are not.

- [ ] **Step 6: Document the variables**

Append to `.env.example`:
```bash
# --- apps/simulator ---
# The simulator's agent runs on the Anthropic API, NOT on Bedrock: Bedrock model
# invocation is refused account-wide on this account (FRICTION-LOG.md FL-019),
# so a Bedrock-backed agent could not make one call. Put the real key in
# apps/simulator/.env.local, which is git-ignored; this file is committed.
ANTHROPIC_API_KEY=
HOMELEDGER_SIMULATOR_MODEL=claude-opus-5
HOMELEDGER_SIMULATOR_MAX_ROUNDS=8
HOMELEDGER_SIMULATOR_ELICITATION_TIMEOUT_MS=120000
# Unset leaves the Origin check off, which is what a localhost demo wants.
HOMELEDGER_SIMULATOR_ALLOW_ORIGIN=
```

Add `.env.local` to `.gitignore` under the existing `.env` line:
```
.env.local
```

- [ ] **Step 7: Build the bridge and run everything**

```bash
pnpm --filter @homeledger/mcp-bridge build
pnpm --filter @homeledger/simulator run test
pnpm --filter @homeledger/simulator run typecheck
```
Expected: PASS. If the subpath imports do not resolve, the bridge's `dist/` is stale — `build` emits `dist/config.js` and friends because `tsconfig.json` has `rootDir: "src"`, so each source module becomes its own entry. Re-run the build before touching the `exports` map.

- [ ] **Step 8: Mutation check**

Apply each, run `pnpm --filter @homeledger/simulator run test`, revert, and confirm `git diff` is empty afterwards. Record the failure counts in the commit body.

1. In `readSimulatorEnv`, change `source.ANTHROPIC_API_KEY?.trim()` to `source.ANTHROPIC_API_KEY` — the set-but-whitespace case must fail.
2. In `positiveInt`, drop the `Number(raw) <= 0` clause — the `'0'` case must fail.
3. In `positiveInt`, return `fallback` instead of throwing — every case in the "positive integer" test must fail.
4. In `no-client-secrets.test.ts`'s first test, move `env.ts` to `src/env.ts` and update the import — the guard must fail, naming the file. (Revert the move; this one mutates the tree rather than a line, and it is the only way to prove the guard is not vacuous. Leaving `src/server` empty and the test green would be exactly the vacuous case FL-032's N6 warns about.)
5. Add `env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }` to `next.config.ts` — the new `next.config.ts` test must fail **twice**, once on the name and once on the `env:` match. Two assertions rather than one because the two failures are independent: a differently named key in an `env` block still ships to the browser, and a credential name reached some other way still leaks. Delete the block afterwards and confirm `git diff` on `next.config.ts` is empty.
6. In `resolveUpstream`, return `resolveUrl: async () => runtime.url` — the cached first lookup instead of a fresh one. No test in this task fails, because nothing here calls it; Task 6, Step 6 mutation 6 is where it bites. Record that honestly in the commit body rather than inventing a test here that would only assert that a closure was called.

- [ ] **Step 9: Commit**

```bash
git add apps/simulator apps/mcp-bridge/package.json .env.example .gitignore
git commit -m "feat(simulator): server-only environment and upstream credentials"
```

---

### Task 3: The turn event stream and its codec

**Files:**
- Create: `apps/simulator/src/shared/events.ts`
- Test: `apps/simulator/test/events.test.ts`

**Interfaces:**
- Consumes: nothing. **Placed under `src/shared/` rather than `src/server/` on purpose:** this is the vocabulary both halves speak, the browser's reducer is typed by it, and Task 2's guard forbids a `'use client'` module from importing anything under `src/server/`. Nothing here reads an environment variable or touches a credential.
- Produces:
  ```ts
  export interface ElicitationOption { value: string; label: string }
  export type TurnEvent =
    | { type: 'turn-started'; turnId: string }
    | { type: 'assistant-text'; text: string }
    | { type: 'tool-started'; callId: string; tool: string; args: Record<string, unknown> }
    | { type: 'tool-succeeded'; callId: string; tool: string; spoken: string; content: unknown; structured: unknown; widgetUri: string | null; ms: number }
    | { type: 'tool-failed'; callId: string; tool: string; message: string; ms: number }
    | { type: 'progress'; callId: string; progress: number; total: number; message: string }
    | { type: 'elicitation-opened'; callId: string; elicitationId: string; prompt: string; field: string; kind: 'choice' | 'confirm'; options: ElicitationOption[] }
    | { type: 'elicitation-closed'; elicitationId: string; action: 'accept' | 'decline' | 'cancel' | 'abandoned' }
    | { type: 'session-rebuilt'; note: string }
    | { type: 'turn-failed'; message: string }
    | { type: 'turn-finished'; turnId: string };
  export function encodeSse(event: TurnEvent): string;
  export function createSseDecoder(): (chunk: string) => TurnEvent[];
  ```

  `tool-succeeded` carries **both** `content` and `structured`, and they are not redundant. `spoken` is the flattened first text block, which is what the transcript reads; `content` is the result's whole `content` array, which is what the MCP Apps view protocol's `ui/notifications/tool-result` payload is specified as — `{content, structuredContent}` — and what Task 14's `WidgetFrame` has to push into a widget. A union that carried only `spoken` would leave the host with no route by which `content` could ever arrive, so it would hard-code `content={null}` and advertise a field it could never fill. The widgets this server ships all read `structuredContent`, so nothing breaks today; a widget that reads `content` tomorrow gets the real thing instead of a lie.

- [ ] **Step 1: Write the failing test**

`apps/simulator/test/events.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createSseDecoder, encodeSse, type TurnEvent } from '../src/shared/events.js';

const sample: TurnEvent[] = [
  { type: 'turn-started', turnId: 't1' },
  { type: 'assistant-text', text: 'Let me look.\n\nOne moment.' },
  { type: 'tool-started', callId: 'c1', tool: 'book_service', args: { applianceId: 'appl_x', issue: 'leak' } },
  {
    type: 'tool-succeeded',
    callId: 'c0',
    tool: 'list_appliances',
    spoken: 'Six appliances.',
    content: [{ type: 'text', text: 'Six appliances.' }],
    structured: { appliances: [{ id: 'appl_x' }] },
    widgetUri: 'ui://homeledger/appliances',
    ms: 412
  },
  {
    type: 'elicitation-opened',
    callId: 'c1',
    elicitationId: 'e1',
    prompt: 'Who should I book for the water heater?',
    field: 'provider',
    kind: 'choice',
    options: [{ value: 'prov_kettle_water', label: 'Kettle Creek Water Heaters' }]
  },
  { type: 'progress', callId: 'c1', progress: 2, total: 3, message: 'Comparing arrival windows' },
  { type: 'turn-finished', turnId: 't1' }
];

describe('the turn event codec', () => {
  it('frames one event per SSE message and terminates it', () => {
    expect(encodeSse({ type: 'turn-started', turnId: 't1' })).toBe('data: {"type":"turn-started","turnId":"t1"}\n\n');
  });

  it('never lets a newline inside an event split the frame', () => {
    // A bare newline in the payload would start a second SSE field. JSON
    // escaping is what prevents it, and this asserts the escape rather than
    // the intent: exactly one "data:" line, and the text survives intact.
    const frame = encodeSse({ type: 'assistant-text', text: 'Let me look.\n\nOne moment.' });
    expect(frame.split('\n').filter(line => line.startsWith('data:'))).toHaveLength(1);
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('round-trips every event when the whole stream arrives at once', () => {
    const decode = createSseDecoder();
    expect(decode(sample.map(encodeSse).join(''))).toEqual(sample);
  });

  it('round-trips when the stream is cut at every single byte boundary', () => {
    const wire = sample.map(encodeSse).join('');
    for (let cut = 1; cut < wire.length; cut++) {
      const decode = createSseDecoder();
      const out = [...decode(wire.slice(0, cut)), ...decode(wire.slice(cut))];
      expect(out, `cut at ${cut}`).toEqual(sample);
    }
  });

  it('yields each event as it lands rather than waiting for the stream to end', () => {
    // The property the whole design rests on. If the decoder needed the last
    // frame before it produced the first, the elicitation card could not be
    // rendered until after the answer it is waiting for.
    const decode = createSseDecoder();
    expect(decode(encodeSse(sample[0]!))).toEqual([sample[0]]);
    expect(decode(encodeSse(sample[1]!))).toEqual([sample[1]]);
  });

  it('drops a comment keep-alive without emitting anything', () => {
    const decode = createSseDecoder();
    expect(decode(': keep-alive\n\n')).toEqual([]);
  });

  it('drops a frame that is not JSON instead of throwing', () => {
    const decode = createSseDecoder();
    expect(decode('data: not json\n\n')).toEqual([]);
    expect(decode(encodeSse(sample[0]!))).toEqual([sample[0]]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @homeledger/simulator run test -- events`
Expected: FAIL, cannot find module `../src/shared/events.js`.

- [ ] **Step 3: Implement**

`apps/simulator/src/shared/events.ts`:
```ts
export interface ElicitationOption {
  value: string;
  label: string;
}

/**
 * Everything one turn can tell the browser.
 *
 * A closed union rather than a bag of strings, because the transcript decides
 * what to render from `type` alone and a failure must be impossible to render
 * as a success. In particular `tool-failed` is a separate member from
 * `tool-succeeded` with no shared "result" field: there is no shape a failed
 * call can take that a success renderer would accept (FL-039).
 */
export type TurnEvent =
  | { type: 'turn-started'; turnId: string }
  | { type: 'assistant-text'; text: string }
  | { type: 'tool-started'; callId: string; tool: string; args: Record<string, unknown> }
  /** `content` is the result's whole content array, the shape the MCP Apps view protocol expects beside `structuredContent`; `spoken` is its first text block, flattened for the transcript. */
  | { type: 'tool-succeeded'; callId: string; tool: string; spoken: string; content: unknown; structured: unknown; widgetUri: string | null; ms: number }
  | { type: 'tool-failed'; callId: string; tool: string; message: string; ms: number }
  | { type: 'progress'; callId: string; progress: number; total: number; message: string }
  | { type: 'elicitation-opened'; callId: string; elicitationId: string; prompt: string; field: string; kind: 'choice' | 'confirm'; options: ElicitationOption[] }
  | { type: 'elicitation-closed'; elicitationId: string; action: 'accept' | 'decline' | 'cancel' | 'abandoned' }
  | { type: 'session-rebuilt'; note: string }
  | { type: 'turn-failed'; message: string }
  | { type: 'turn-finished'; turnId: string };

/**
 * One event, one SSE message.
 *
 * JSON.stringify is what keeps a newline inside an assistant's text from
 * starting a second `data:` field, which would split one event across two
 * frames and desynchronise the stream from that point on.
 */
export function encodeSse(event: TurnEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function parseFrame(frame: string): TurnEvent | undefined {
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') continue;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
  }
  if (dataLines.length === 0) return undefined;
  try {
    return JSON.parse(dataLines.join('\n')) as TurnEvent;
  } catch {
    return undefined;
  }
}

/**
 * Splits a byte stream into events as they arrive.
 *
 * Incremental for the same reason `apps/mcp-bridge/src/sse.ts` is: the stream
 * this reads stays open across three questions the person on the other end has
 * not answered yet, so anything that waits for it to finish before looking at
 * its contents waits for an answer that cannot be given. Handing back a
 * partial-frame buffer between calls is the whole mechanism.
 */
export function createSseDecoder(): (chunk: string) => TurnEvent[] {
  let buffer = '';
  return chunk => {
    buffer = (buffer + chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const events: TurnEvent[] = [];
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary === -1) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseFrame(frame);
      if (parsed) events.push(parsed);
    }
    return events;
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @homeledger/simulator run test -- events`
Expected: PASS, seven tests.

- [ ] **Step 5: Mutation check**

1. In `createSseDecoder`, accumulate into `buffer` but return `[]` until the stream ends (replace the loop body's `events.push` with nothing) — the round-trip and the "as it lands" tests must fail.
2. In `encodeSse`, emit `data: ${String(event.text ?? '')}` for the `assistant-text` case — the newline test and the round-trip must fail.
3. In `parseFrame`, return `JSON.parse(...)` without the try/catch — the non-JSON test must fail with a thrown `SyntaxError` rather than an assertion; that counts, but change it to a `try` that rethrows so the test fails as an assertion, confirm, then revert.
4. In `createSseDecoder`, reset `buffer = ''` at the top of each call — the byte-boundary test must fail, at many cuts.

- [ ] **Step 6: Commit**

```bash
git add apps/simulator/src/shared/events.ts apps/simulator/test/events.test.ts
git commit -m "feat(simulator): turn event union with an incremental SSE codec"
```

---

### Task 4: The elicitation registry

**Files:**
- Create: `apps/simulator/src/server/elicitation.ts`
- Test: `apps/simulator/test/elicitation.test.ts`

**Interfaces:**
- Consumes: `node:crypto`'s `randomUUID`, `node:timers`' `setTimeout`/`clearTimeout` (imported explicitly so the return type is `NodeJS.Timeout` and not the DOM's `number`).
- Produces:
  ```ts
  export type ElicitationAnswer = { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' } | { action: 'cancel' };
  export type AnswerOutcome = 'delivered' | 'unknown-turn' | 'unknown-question';
  export class TurnClosedError extends Error {}
  export class ElicitationTimeoutError extends Error {}
  export class ElicitationRegistry {
    open(turnId: string): void;
    has(turnId: string): boolean;
    ask(turnId: string, timeoutMs: number): { elicitationId: string; answer: Promise<ElicitationAnswer> };
    answer(turnId: string, elicitationId: string, value: ElicitationAnswer): AnswerOutcome;
    close(turnId: string, reason: string): void;
  }
  ```

- [ ] **Step 1: Write the failing test**

`apps/simulator/test/elicitation.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ElicitationRegistry, ElicitationTimeoutError, TurnClosedError } from '../src/server/elicitation.js';

const accept = { action: 'accept', content: { provider: 'prov_kettle_water' } } as const;

describe('ElicitationRegistry', () => {
  it('resolves the question the answer names, with the answer', async () => {
    const registry = new ElicitationRegistry();
    registry.open('t1');
    const q = registry.ask('t1', 1000);
    expect(registry.answer('t1', q.elicitationId, accept)).toBe('delivered');
    await expect(q.answer).resolves.toEqual(accept);
  });

  it('keeps two questions on one turn independent', async () => {
    const registry = new ElicitationRegistry();
    registry.open('t1');
    const first = registry.ask('t1', 1000);
    const second = registry.ask('t1', 1000);
    expect(second.elicitationId).not.toBe(first.elicitationId);
    registry.answer('t1', second.elicitationId, { action: 'decline' });
    await expect(second.answer).resolves.toEqual({ action: 'decline' });
    registry.answer('t1', first.elicitationId, accept);
    await expect(first.answer).resolves.toEqual(accept);
  });

  it('reports an answer for a turn it does not hold, and resolves nothing', async () => {
    const registry = new ElicitationRegistry();
    registry.open('t1');
    const q = registry.ask('t1', 1000);
    expect(registry.answer('t2', q.elicitationId, accept)).toBe('unknown-turn');
    let settled = false;
    void q.answer.then(() => {
      settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    registry.close('t1', 'test over');
    await expect(q.answer).rejects.toBeInstanceOf(TurnClosedError);
  });

  it('reports a second answer to the same question as unknown rather than delivering it twice', async () => {
    const registry = new ElicitationRegistry();
    registry.open('t1');
    const q = registry.ask('t1', 1000);
    expect(registry.answer('t1', q.elicitationId, accept)).toBe('delivered');
    expect(registry.answer('t1', q.elicitationId, { action: 'cancel' })).toBe('unknown-question');
    await expect(q.answer).resolves.toEqual(accept);
  });

  it('rejects every outstanding question when the turn closes, with the reason', async () => {
    const registry = new ElicitationRegistry();
    registry.open('t1');
    const first = registry.ask('t1', 1000);
    const second = registry.ask('t1', 1000);
    registry.close('t1', 'the browser disconnected');
    await expect(first.answer).rejects.toThrow('the browser disconnected');
    await expect(second.answer).rejects.toThrow('the browser disconnected');
    expect(registry.has('t1')).toBe(false);
  });

  it('rejects a question nobody answers inside its budget', async () => {
    const registry = new ElicitationRegistry();
    registry.open('t1');
    const q = registry.ask('t1', 20);
    await expect(q.answer).rejects.toBeInstanceOf(ElicitationTimeoutError);
    // The slot is gone, so a late click is reported rather than delivered to a
    // promise that has already rejected.
    expect(registry.answer('t1', q.elicitationId, accept)).toBe('unknown-question');
  });

  it('refuses to ask on a turn that was never opened', () => {
    const registry = new ElicitationRegistry();
    expect(() => registry.ask('t9', 1000)).toThrow(TurnClosedError);
  });

  it('closing a turn that is not open is a no-op, not a throw', () => {
    const registry = new ElicitationRegistry();
    expect(() => registry.close('t9', 'gone')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @homeledger/simulator run test -- elicitation.test`
Expected: FAIL, cannot find module `../src/server/elicitation.js`.

- [ ] **Step 3: Implement**

`apps/simulator/src/server/elicitation.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'node:timers';

export type ElicitationAnswer = { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' } | { action: 'cancel' };

/**
 * What happened to an answer that arrived on its own HTTP request.
 *
 * Three outcomes rather than a boolean because the route has to say which
 * went wrong. "unknown-turn" means this process is not the one running that
 * turn — the FL-039 class of failure, where a request lands somewhere that has
 * never heard of the state it names — and "unknown-question" means the
 * question is already settled, which is a double click or a late one. Reporting
 * both as "no" would put a person in front of a card that does nothing and
 * says nothing.
 */
export type AnswerOutcome = 'delivered' | 'unknown-turn' | 'unknown-question';

export class TurnClosedError extends Error {}
export class ElicitationTimeoutError extends Error {}

interface Slot {
  resolve: (answer: ElicitationAnswer) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The join between the MCP client's elicitation callback and a person's click.
 *
 * The callback runs inside `tools/call`, on a response stream the server is
 * holding open; the click arrives minutes later on a different HTTP request.
 * This is the only thing that connects them, and it lives in process memory —
 * which is exactly why `POST /api/agent/answer` must reach the process running
 * the turn. `unknown-turn` is what a person sees when it does not.
 */
export class ElicitationRegistry {
  private readonly turns = new Map<string, Map<string, Slot>>();

  open(turnId: string): void {
    if (!this.turns.has(turnId)) this.turns.set(turnId, new Map());
  }

  has(turnId: string): boolean {
    return this.turns.has(turnId);
  }

  ask(turnId: string, timeoutMs: number): { elicitationId: string; answer: Promise<ElicitationAnswer> } {
    const slots = this.turns.get(turnId);
    if (!slots) throw new TurnClosedError(`turn ${turnId} is not open, so it cannot ask anything`);
    const elicitationId = randomUUID();
    let resolve!: (answer: ElicitationAnswer) => void;
    let reject!: (error: Error) => void;
    const answer = new Promise<ElicitationAnswer>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setNodeTimeout(() => {
      slots.delete(elicitationId);
      reject(new ElicitationTimeoutError(`nobody answered question ${elicitationId} within ${timeoutMs} ms`));
    }, timeoutMs);
    // A pending question must never be the reason the process refuses to exit.
    timer.unref();
    slots.set(elicitationId, { resolve, reject, timer });
    return { elicitationId, answer };
  }

  answer(turnId: string, elicitationId: string, value: ElicitationAnswer): AnswerOutcome {
    const slots = this.turns.get(turnId);
    if (!slots) return 'unknown-turn';
    const slot = slots.get(elicitationId);
    if (!slot) return 'unknown-question';
    // Deleted before resolving, so a second delivery cannot reach a settled
    // promise even if the resolver synchronously re-enters this method.
    slots.delete(elicitationId);
    clearNodeTimeout(slot.timer);
    slot.resolve(value);
    return 'delivered';
  }

  close(turnId: string, reason: string): void {
    const slots = this.turns.get(turnId);
    if (!slots) return;
    this.turns.delete(turnId);
    for (const slot of slots.values()) {
      clearNodeTimeout(slot.timer);
      slot.reject(new TurnClosedError(reason));
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @homeledger/simulator run test -- elicitation.test`
Expected: PASS, eight tests.

- [ ] **Step 5: Mutation check**

1. In `answer`, return `'delivered'` when `slots` is undefined (drop the `unknown-turn` branch and resolve into the first slot found anywhere) — the "does not hold" test must fail.
2. In `answer`, resolve before `slots.delete` — the double-answer test must fail.
3. In `close`, delete the map without rejecting the slots — the close test must fail on both awaits.
4. In `ask`, reuse a constant `elicitationId` instead of `randomUUID()` — the two-independent-questions test must fail.
5. In `ask`, drop the `slots.delete(elicitationId)` inside the timeout callback — the timeout test's second assertion must fail, reporting `delivered` where `unknown-question` is required.

- [ ] **Step 6: Commit**

```bash
git add apps/simulator/src/server/elicitation.ts apps/simulator/test/elicitation.test.ts
git commit -m "feat(simulator): elicitation registry joining a held-open turn to a later click"
```

---

### Task 5: What a failure is — the server's decline, and the honest failure result

**Files:**
- Create: `apps/simulator/src/server/tools.ts`
- Modify: `apps/mcp-server/src/tools/service.ts`, `apps/mcp-server/test/book-service-modern.test.ts`, `apps/mcp-server/test/book-service-legacy.test.ts`
- Test: `apps/simulator/test/tools.test.ts`

**Interfaces:**
- Consumes: `type Anthropic from '@anthropic-ai/sdk'`; `type TurnEvent` is not needed here.
- Produces:
  ```ts
  export interface McpToolDescriptor { name: string; description?: string | undefined; inputSchema: Record<string, unknown>; _meta?: unknown }
  export function toAnthropicTools(tools: readonly McpToolDescriptor[]): Anthropic.Tool[];
  export function widgetUriOf(tool: McpToolDescriptor): string | null;
  export const NO_DATA_NOTICE: string;
  export type ToolOutcome = { ok: true; spoken: string; content: unknown; structured: unknown } | { ok: false; message: string };
  export function readToolResult(result: unknown): ToolOutcome;
  export function toToolResultBlock(callId: string, outcome: ToolOutcome): Anthropic.ToolResultBlockParam;
  export function elicitationShape(requestedSchema: unknown): { field: string; kind: 'choice' | 'confirm'; options: Array<{ value: string; label: string }> } | undefined;
  ```

**This task owns the definition of "failure", and it has to fix it at the source before it can build on it.** `readToolResult` classifies every tool result the simulator will ever see, and everything downstream — the `tool-failed` event, `is_error: true` on the block handed to the model, `NO_DATA_NOTICE`, `explainFailure`'s card in Task 13 — is that classification rendered. The server currently mis-signs one result, and Step 1 fixes it there rather than special-casing it in seven places here.

- [ ] **Step 1: Fix the source — a decline is not a failure**

`apps/mcp-server/src/tools/service.ts:52` returns, when a person presses "Not now":

```ts
const notBooked = () => ({ content: [{ type: 'text' as const, text: "Okay, I haven't booked anything." }], isError: true });
```

`isError` means *the call did not execute*. A client is entitled to render it as a crash, and clients do: in Claude Code a clean decline arrives as `Error: Okay, I haven't booked anything`. Carried into this plan unchanged it would be worse — Task 5 classifies it `ok: false`, Task 8 emits `tool-failed` and hands the model `is_error: true` plus `NO_DATA_NOTICE` ("*This call did not execute… Tell the person the call failed and say what the error was*"), and Task 13's `explainFailure` renders **"book_service failed — Nothing was retrieved, so this is not an answer and not an empty one either."** Somebody who chose not to book would be told the booking system broke. That is the same papering-over this project keeps fighting, pointed the other way, so it is fixed once, at the place that signs the result.

**The one thing that makes this more than deleting a flag:** `book_service` declares an `outputSchema`, and the server SDK's `validateToolOutput` skips validation when `isError` is true and **throws** `Output validation error: Tool book_service has an output schema but no structured content was provided` when it is not. Dropping the flag alone turns a decline into a JSON-RPC error, which is strictly worse than what it replaces. The decline therefore needs a structured shape of its own.

In `apps/mcp-server/src/tools/service.ts`, lift the booking payload into a named schema and give the declined outcome its own, then union them. Replace the `outputSchema:` block on `book_service` with a reference, and add above `registerServiceTools`:

```ts
const BookedVisit = z.object({
  visitId: z.string(),
  provider: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
  // The window as a person reads it, rendered server-side in the household's
  // zone. Nullable-never, always present: the visit widget has no way of its
  // own to know the household's zone, and letting it format `windowStart`
  // itself would put the VIEWER's clock on a shared kitchen display - the one
  // thing this must not do. One rendering, computed once, spoken and shown
  // identically.
  windowLabel: z.string(),
  status: VisitStatus
});

/**
 * Nothing was booked, and that is an ordinary outcome of a working call.
 *
 * It needs a shape at all only because `outputSchema` is declared: the SDK
 * validates any result that is not flagged `isError`, and the flag is exactly
 * what this stopped using. `booked: false` is the whole payload - there is no
 * visit to describe, and inventing a visitId so the success schema would
 * accept it is the lie this change exists to remove. The success branch is
 * left byte-identical, so the visit widget and every existing assertion about
 * a completed booking are untouched.
 */
const NotBooked = z.object({ booked: z.literal(false) });
```

and change the two result builders:

```ts
const notBooked = () => ({
  content: [{ type: 'text' as const, text: "Okay, I haven't booked anything." }],
  structuredContent: { booked: false as const }
});
```

`cannotAskAnything()` and the unknown-appliance result keep `isError: true` and must not be touched: a client that cannot be asked anything, and an appliance id that names nothing, are both calls that could not do what they were asked. Only the decline moves.

The `book_service` registration then reads `outputSchema: z.union([BookedVisit, NotBooked])`. The union is unambiguous in both directions — a booking has no `booked` key and fails `NotBooked`'s literal; a decline has no `visitId` and fails `BookedVisit` — so no result can validate as the wrong one.

**Update the three assertions that pinned the old flag.** In `apps/mcp-server/test/book-service-modern.test.ts`, the decline-at-provider test (`stops without writing anything when the user declines`), the confirm-is-no test (`stops when the user answers the confirmation with no`) and the decline-at-window test each read `expect(r.isError).toBe(true);`. Replace that line in those three with:

```ts
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ booked: false });
```

and make the same replacement in `apps/mcp-server/test/book-service-legacy.test.ts`'s decline test. Leave every other `isError` assertion in those files alone — the unknown-appliance case and `book-service-no-elicitation.test.ts`'s refusals are real failures and stay flagged. The `expect(...text).toBe("Okay, I haven't booked anything.")` lines are unchanged in all four: the sentence was always right, only its signature was wrong.

Run `pnpm --filter @homeledger/mcp-server test`. Expected: PASS, with those four tests now asserting the new signature and nothing else moving. If any other test fails, it is asserting on `book_service`'s output shape and needs reading, not silencing.

Then apply the mutation that proves the fix is load-bearing rather than cosmetic: **put `isError: true` back on `notBooked()`** — the four updated assertions must fail. Revert it and confirm `git diff` shows only the intended change.

**What the visit widget does with a decline, stated rather than discovered.** `book_service`'s `_meta` names `ui://homeledger/visit`, and that pairing is on the tool descriptor, so a declined call still carries a widget URI. `apps/mcp-server/src/widgets/visit.ts` already handles it: its render guard is `if (!visit || (!visit.provider && !visit.providerName))`, and `{ booked: false }` trips it, so the card reads "No visit selected." That is a correct rendering of "nothing was booked" and it is asserted in Task 15's end-to-end decline test, so it is a tested outcome rather than a surprise. Suppressing the widget instead would mean teaching the agent a `book_service`-shaped special case, which is a branch no other tool can reach.

- [ ] **Step 2: Write the failing test**

`apps/simulator/test/tools.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { NO_DATA_NOTICE, elicitationShape, readToolResult, toAnthropicTools, toToolResultBlock, widgetUriOf } from '../src/server/tools.js';

const listAppliances = {
  name: 'list_appliances',
  description: 'List the household appliances, optionally filtered by room or category.',
  inputSchema: { type: 'object', properties: { room: { type: 'string' } } },
  _meta: { ui: { resourceUri: 'ui://homeledger/appliances' } }
};

describe('toAnthropicTools', () => {
  it('carries name, description and schema across unchanged, in order', () => {
    const second = { name: 'get_appliance', description: 'One appliance.', inputSchema: { type: 'object' } };
    expect(toAnthropicTools([listAppliances, second])).toEqual([
      { name: 'list_appliances', description: listAppliances.description, input_schema: listAppliances.inputSchema },
      { name: 'get_appliance', description: 'One appliance.', input_schema: { type: 'object' } }
    ]);
  });

  it('substitutes an empty description rather than omitting the field', () => {
    expect(toAnthropicTools([{ name: 'x', inputSchema: { type: 'object' } }])[0]?.description).toBe('');
  });
});

describe('widgetUriOf', () => {
  it('reads the nested ui.resourceUri the server sets on the tool definition', () => {
    expect(widgetUriOf(listAppliances)).toBe('ui://homeledger/appliances');
  });

  it('is null for a tool with no widget, and for malformed _meta', () => {
    expect(widgetUriOf({ name: 'ask_manual', inputSchema: {} })).toBeNull();
    expect(widgetUriOf({ name: 'x', inputSchema: {}, _meta: 'nope' })).toBeNull();
    expect(widgetUriOf({ name: 'x', inputSchema: {}, _meta: { ui: { resourceUri: 42 } } })).toBeNull();
  });
});

describe('readToolResult', () => {
  it('reads spoken text, the whole content array, and structured content from a healthy result', () => {
    // `content` is carried through unflattened because the MCP Apps view
    // protocol's tool-result payload is `{content, structuredContent}` and the
    // widget host in Task 14 has nowhere else to get it. `spoken` is the same
    // data flattened for the transcript; both, not one.
    const content = [{ type: 'text', text: 'Six appliances.' }];
    expect(readToolResult({ content, structuredContent: { appliances: [] } })).toEqual({
      ok: true,
      spoken: 'Six appliances.',
      content,
      structured: { appliances: [] }
    });
  });

  it('reads a decline as the ordinary result it is, not as a failure', () => {
    // apps/mcp-server/src/tools/service.ts's notBooked(), after Step 1. A
    // person pressing "Not now" is a working call with a negative answer, and
    // the whole downstream chain - tool-failed, is_error, NO_DATA_NOTICE,
    // explainFailure - keys off this one classification.
    expect(readToolResult({ content: [{ type: 'text', text: "Okay, I haven't booked anything." }], structuredContent: { booked: false } })).toEqual({
      ok: true,
      spoken: "Okay, I haven't booked anything.",
      content: [{ type: 'text', text: "Okay, I haven't booked anything." }],
      structured: { booked: false }
    });
  });

  it('reports an error result as a failure carrying the server sentence', () => {
    // FL-032's shape exactly: isError true, a spoken explanation, and NO
    // structuredContent at all. A reader that goes looking for passages here
    // crashes; a reader that treats it as empty lies.
    expect(
      readToolResult({ isError: true, content: [{ type: 'text', text: "I can't look in the manuals right now: model access is blocked on this account." }] })
    ).toEqual({ ok: false, message: "I can't look in the manuals right now: model access is blocked on this account." });
  });

  it('reports an error result that also carries well-formed structured content as a failure', () => {
    // The branch FL-032's mutation N6 found decorative. If the only error
    // fixture is one that would fail the next check down anyway, dropping the
    // isError check costs nothing and the suite stays green.
    expect(readToolResult({ isError: true, content: [{ type: 'text', text: 'Refused.' }], structuredContent: { passages: [] } })).toEqual({
      ok: false,
      message: 'Refused.'
    });
  });

  it('is total over every malformed shape rather than throwing', () => {
    for (const bad of [undefined, null, 'a string', 42, [], {}, { content: 'not an array' }, { content: [] }, { content: [{ type: 'image' }] }]) {
      const outcome = readToolResult(bad);
      expect(outcome.ok, JSON.stringify(bad)).toBe(false);
      expect((outcome as { message: string }).message.length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });
});

describe('toToolResultBlock', () => {
  it('sends the spoken text and the structured content back on success, unflagged', () => {
    const block = toToolResultBlock('c1', { ok: true, spoken: 'Six appliances.', content: [{ type: 'text', text: 'Six appliances.' }], structured: { appliances: [] } });
    expect(block.tool_use_id).toBe('c1');
    expect(block.is_error).toBeUndefined();
    expect(block.content).toEqual([{ type: 'text', text: 'Six appliances.\n\n{"appliances":[]}' }]);
  });

  it('flags a failure and tells the model in words that nothing was retrieved', () => {
    const block = toToolResultBlock('c1', { ok: false, message: 'Session not found.' });
    expect(block.is_error).toBe(true);
    const text = (block.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('Session not found.');
    expect(text).toContain(NO_DATA_NOTICE);
  });

  it('states in the notice that repository fixtures are not an answer', () => {
    // The literal thing that happened twice, named so the notice cannot be
    // edited down into a generic apology.
    expect(NO_DATA_NOTICE).toContain('NO DATA WAS RETRIEVED');
    expect(NO_DATA_NOTICE).toContain('fixtures');
  });
});

describe('elicitationShape', () => {
  it('reads a single-select enum with its display names', () => {
    expect(
      elicitationShape({
        type: 'object',
        properties: { provider: { type: 'string', title: 'Provider', enum: ['prov_a', 'prov_b'], enumNames: ['Alpha Plumbing', 'Beta Drain'] } },
        required: ['provider']
      })
    ).toEqual({
      field: 'provider',
      kind: 'choice',
      options: [
        { value: 'prov_a', label: 'Alpha Plumbing' },
        { value: 'prov_b', label: 'Beta Drain' }
      ]
    });
  });

  it('falls back to the value as its own label when enumNames is absent', () => {
    expect(elicitationShape({ type: 'object', properties: { window: { type: 'string', enum: ['win_1', 'win_2'] } }, required: ['window'] })?.options).toEqual([
      { value: 'win_1', label: 'win_1' },
      { value: 'win_2', label: 'win_2' }
    ]);
  });

  it('falls back per option when enumNames is shorter than enum, rather than dropping the tail', () => {
    // A separate case from "absent", and the one an off-by-one on the server
    // produces. The previous version of this test named both and exercised
    // only the first, so a reader that returned `options.length === names.length`
    // would have passed it.
    expect(
      elicitationShape({ type: 'object', properties: { window: { type: 'string', enum: ['win_1', 'win_2', 'win_3'], enumNames: ['Tuesday morning'] } }, required: ['window'] })
        ?.options
    ).toEqual([
      { value: 'win_1', label: 'Tuesday morning' },
      { value: 'win_2', label: 'win_2' },
      { value: 'win_3', label: 'win_3' }
    ]);
  });

  it('reads a boolean field as a confirmation with no options', () => {
    expect(elicitationShape({ type: 'object', properties: { confirm: { type: 'boolean', title: 'Confirm' } }, required: ['confirm'] })).toEqual({
      field: 'confirm',
      kind: 'confirm',
      options: []
    });
  });

  it('is undefined for a schema this UI cannot render, rather than guessing', () => {
    for (const bad of [undefined, null, {}, { properties: {} }, { properties: { free: { type: 'string' } } }, { properties: { n: { type: 'number' } } }]) {
      expect(elicitationShape(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @homeledger/simulator run test -- tools.test`
Expected: FAIL, cannot find module `../src/server/tools.js`.

- [ ] **Step 4: Implement**

`apps/simulator/src/server/tools.ts`:
```ts
import type Anthropic from '@anthropic-ai/sdk';

export interface McpToolDescriptor {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
  _meta?: unknown;
}

export function toAnthropicTools(tools: readonly McpToolDescriptor[]): Anthropic.Tool[] {
  return tools.map(tool => ({
    name: tool.name,
    // Empty rather than omitted: the field is what the model reads to decide
    // when a tool applies, and an absent one reads as "no guidance" in a way a
    // present-but-empty one does not.
    description: tool.description ?? '',
    input_schema: tool.inputSchema as Anthropic.Tool['input_schema']
  }));
}

/**
 * The `ui://` widget a tool names, read from the TOOL DEFINITION.
 *
 * Not from the call result: `apps/mcp-server/src/widgets/index.ts`'s `uiMeta()`
 * is passed in `registerTool`'s config, so the pairing arrives once on
 * `tools/list` and every later result of that tool inherits it. Reading the
 * result instead would find nothing and quietly render no widget at all.
 *
 * The nested `ui.resourceUri` is the shape the MCP Apps spec prefers; the
 * server also sets the flat deprecated key beside it, which this deliberately
 * ignores so that the two cannot silently disagree.
 */
export function widgetUriOf(tool: McpToolDescriptor): string | null {
  const meta = tool._meta;
  if (typeof meta !== 'object' || meta === null) return null;
  const ui = (meta as { ui?: unknown }).ui;
  if (typeof ui !== 'object' || ui === null) return null;
  const uri = (ui as { resourceUri?: unknown }).resourceUri;
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : null;
}

/**
 * What a failed tool call tells the model, in words.
 *
 * This exists because a transport error is now an input to an inference
 * engine, and a vague one does not stay vague — it gets turned into a fluent
 * answer nobody has reason to doubt. Twice, a 404 was read as "there are no
 * appliances registered" and answered from this repository's own seed
 * fixtures (FL-039). So the notice says what did NOT happen, not only what
 * went wrong, and it names the specific wrong move.
 */
export const NO_DATA_NOTICE = [
  'NO DATA WAS RETRIEVED.',
  'This call did not execute, so nothing was read from the household and no result — empty or otherwise — is implied.',
  'Do not answer from memory, from repository fixtures or seed data, or from anything earlier in this conversation: you do not know what this household contains.',
  'Tell the person the call failed and say what the error above was.'
].join(' ');

/**
 * What one `tools/call` produced, in the only two flavours anything downstream
 * branches on.
 *
 * Two, not three: a person declining a booking is `ok: true` with a spoken
 * sentence that says nothing was booked, because the call ran and answered.
 * `ok: false` means the call did not execute, and that is the only thing it
 * means — every honest-failure surface in this plan is that boolean rendered.
 */
export type ToolOutcome = { ok: true; spoken: string; content: unknown; structured: unknown } | { ok: false; message: string };

function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === 'string' && text.length > 0) return text;
  }
  return undefined;
}

/**
 * Classifies a `tools/call` result without dereferencing anything that may be absent.
 *
 * Total by construction, for the reason `scripts/smoke.ts` learned the hard
 * way: a thrown handler comes back as `{ isError: true, content: [text] }`
 * with no `structuredContent` at all, and a blind `.structuredContent.passages`
 * throws a TypeError that says nothing about the system under test and stops
 * everything after it (FL-032). The `isError` check comes FIRST and on its
 * own, so an error result that happens to carry well-formed structured content
 * — a shape the server is free to adopt — is still a failure.
 */
export function readToolResult(result: unknown): ToolOutcome {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return { ok: false, message: 'the server returned no result object' };
  const record = result as { isError?: unknown; content?: unknown; structuredContent?: unknown };
  const spoken = firstText(record.content);
  if (record.isError === true) return { ok: false, message: spoken ?? 'the server reported an error and gave no message' };
  if (spoken === undefined) return { ok: false, message: 'the server returned a result with no spoken text' };
  return { ok: true, spoken, content: record.content ?? null, structured: record.structuredContent ?? null };
}

export function toToolResultBlock(callId: string, outcome: ToolOutcome): Anthropic.ToolResultBlockParam {
  if (!outcome.ok)
    return {
      type: 'tool_result',
      tool_use_id: callId,
      is_error: true,
      content: [{ type: 'text', text: `${outcome.message}\n\n${NO_DATA_NOTICE}` }]
    };
  // Spoken text first, typed payload second. The spoken line is what the tool
  // said; the JSON is what it returned, and the model needs both — the ids in
  // structuredContent are how it reaches the next tool.
  const text = outcome.structured === null ? outcome.spoken : `${outcome.spoken}\n\n${JSON.stringify(outcome.structured)}`;
  return { type: 'tool_result', tool_use_id: callId, content: [{ type: 'text', text }] };
}

/**
 * Turns an `elicitation/create` requestedSchema into something a card can render.
 *
 * The server builds exactly two shapes (`apps/mcp-server/src/elicit.ts`): a
 * single-select `enum` + `enumNames`, and a boolean. Anything else returns
 * undefined rather than a guessed widget — a free-text box in place of a
 * choice would let a person answer something the server will reject, and a
 * silent default would hide a server change instead of surfacing it.
 */
export function elicitationShape(requestedSchema: unknown): { field: string; kind: 'choice' | 'confirm'; options: Array<{ value: string; label: string }> } | undefined {
  if (typeof requestedSchema !== 'object' || requestedSchema === null) return undefined;
  const properties = (requestedSchema as { properties?: unknown }).properties;
  if (typeof properties !== 'object' || properties === null) return undefined;
  const field = Object.keys(properties as Record<string, unknown>)[0];
  if (field === undefined) return undefined;
  const definition = (properties as Record<string, unknown>)[field];
  if (typeof definition !== 'object' || definition === null) return undefined;
  const type = (definition as { type?: unknown }).type;
  if (type === 'boolean') return { field, kind: 'confirm', options: [] };
  const values = (definition as { enum?: unknown }).enum;
  if (type !== 'string' || !Array.isArray(values) || values.length === 0) return undefined;
  const names = (definition as { enumNames?: unknown }).enumNames;
  const labels = Array.isArray(names) ? names : [];
  const options: Array<{ value: string; label: string }> = [];
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'string') return undefined;
    const label = labels[index];
    options.push({ value, label: typeof label === 'string' && label.length > 0 ? label : value });
  }
  return { field, kind: 'choice', options };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @homeledger/simulator run test -- tools.test`
Expected: PASS, seventeen tests.

- [ ] **Step 6: Mutation check**

1. In `readToolResult`, delete the `record.isError === true` branch — the two error tests must both fail, and the second one (error plus well-formed structured content) is the one that proves the branch is not decorative.
2. In `readToolResult`, replace the first guard with `if (result === undefined)` — the totality test must fail on several inputs.
3. In `readToolResult`, return `content: null` unconditionally — the healthy-result and decline tests must both fail. (Without this, `content` would be a field the union declares and nothing fills, which is the shape that made Task 14 hard-code `content={null}` in the first place.)
4. In `toToolResultBlock`, drop `is_error: true` — the failure test must fail.
5. In `toToolResultBlock`, drop `NO_DATA_NOTICE` from the text — the failure test must fail. This is the assertion that stands between a transport error and a fabricated answer; if it survives any mutation, stop and fix the test before going on.
6. In `widgetUriOf`, drop the `startsWith('ui://')` check — the malformed-`_meta` test must fail on the numeric case… confirm it does; if it does not, the numeric case is being caught by the `typeof` check alone, so add `_meta: { ui: { resourceUri: 'https://example.invalid/x' } }` to that test and re-run.
7. In `elicitationShape`, return `{ field, kind: 'choice', options: [] }` instead of `undefined` for an unrenderable schema — the last test must fail on every input.
8. In `elicitationShape`, build the options by mapping `labels` rather than `values` (`labels.map((label, index) => ({ value: values[index], label }))`) — the short-`enumNames` test must fail with one option where three are required. This is the mutation the "absent" case alone could never catch, because an absent `enumNames` makes both forms produce an empty list from the same empty array.
9. In `apps/mcp-server/src/tools/service.ts`, put `isError: true` back on `notBooked()` — the four updated assertions in `book-service-modern.test.ts` and `book-service-legacy.test.ts` must fail, and the simulator's decline test must fail with `ok: false`. Run both suites. This is Step 1's assertion that the fix is behaviour and not a comment.

- [ ] **Step 7: Commit**

```bash
git add apps/simulator/src/server/tools.ts apps/simulator/test/tools.test.ts apps/mcp-server/src/tools/service.ts apps/mcp-server/test/book-service-modern.test.ts apps/mcp-server/test/book-service-legacy.test.ts
git commit -m "feat(simulator): tool translation, and a server decline that is not an error"
```

The commit body says what moved on the server and why, in a sentence: `isError` is MCP's "the call did not execute" flag, a decline is a call that executed and answered no, and `book_service` was signing one as the other — which reached Claude Code as `Error: Okay, I haven't booked anything`.

---

### Task 6: The MCP client wrapper — rebuild, replay once, heal the address, and tap the wire

**Files:**
- Create: `apps/simulator/src/server/mcp.ts`
- Modify: `apps/mcp-server/package.json`
- Test: `apps/simulator/test/mcp.test.ts`

**Interfaces:**
- Consumes: `Client` from `@modelcontextprotocol/sdk/client/index.js`; `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js`; `ElicitRequestSchema` from `@modelcontextprotocol/sdk/types.js`; `type ElicitationAnswer` from `./elicitation.js`; `type McpToolDescriptor` from `./tools.js`.
- Produces:
  ```ts
  export interface ElicitPrompt { message: string; requestedSchema: unknown }
  export interface JsonRpcLogEntry { at: number; direction: 'out' | 'in'; method: string; id: string | number | null; ms: number | null; status: number | null }
  export const JSON_RPC_LOG_LIMIT = 100;
  export interface HomeLedgerMcpOptions {
    url: string;
    token: () => Promise<string>;
    onElicit: (prompt: ElicitPrompt) => Promise<ElicitationAnswer>;
    /** Drops the cached bearer. Called once on a 401 or 403 before the single retry. */
    invalidateToken?: () => void;
    /** Re-resolves the runtime by name. Called before every rebuild, so a recreated runtime is followed rather than retried against. */
    resolveUrl?: () => Promise<string>;
    log?: (message: string) => void;
    fetchImpl?: typeof fetch;
  }
  export function isLostSessionError(error: unknown): boolean;
  export function isUnauthorizedError(error: unknown): boolean;
  export function toDescriptors(tools: ReadonlyArray<{ name: string; description?: string | undefined; inputSchema: unknown; _meta?: unknown }>): McpToolDescriptor[];
  export class HomeLedgerMcp {
    constructor(options: HomeLedgerMcpOptions);
    connect(): Promise<void>;
    listTools(): Promise<McpToolDescriptor[]>;
    callTool(name: string, args: Record<string, unknown>, onProgress?: (p: { progress: number; total?: number; message?: string }) => void): Promise<unknown>;
    readResource(uri: string): Promise<string>;
    close(): Promise<void>;
    readonly endpointUrl: string;
    readonly sessionId: string | undefined;
    readonly protocolVersion: string | undefined;
    readonly rebuilds: number;
    readonly jsonRpcLog: readonly JsonRpcLogEntry[];
  }
  ```

**Three failure modes, not one.** `apps/mcp-bridge/src/proxy.ts` already pays for all three and this client must not implement only the middle one:

| What the endpoint says | What it means | What this does |
|---|---|---|
| 401 / 403 | the bearer was refused — rotated secret, expired token | `invalidateToken()`, retry the same call once against the same URL (`proxy.ts:160-185`) |
| 404 **with** a session id | this instance does not hold my session — the 30-minute idle recycle | rebuild the session, replay once |
| 404 **with no** session id | the runtime this URL names is gone — recreated, so its generated id changed | `resolveUrl()` first, then rebuild (`healAddress()`, FL-038 / FL-039) |

Collapsing the last two into "rebuild against the same URL" leaves the FL-038 case — the one a redeploy produces and the one that has already cost this project two confidently wrong answers — as the single failure the rebuild cannot fix. So this client re-resolves the address **before every rebuild**, unconditionally: the lookup is by name, it is idempotent, and if the runtime did not move it returns the URL already in hand. Distinguishing the two 404s to save one `ListAgentRuntimes` call on a path that runs at most once per conversation would buy nothing and cost a branch no test can reach.

- [ ] **Step 1: Verify the two SDK affordances this task depends on**

Read `node_modules/.pnpm/@modelcontextprotocol+sdk@1.30.0_*/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.d.ts` and confirm `StreamableHTTPClientTransportOptions` carries `fetch?: FetchLike`. Read `.../dist/esm/shared/protocol.d.ts` and confirm `RequestOptions` carries `onprogress?: ProgressCallback`.

Both were present at 1.30.0 when this plan was written (`fetch` at line 81 of the first file; `onprogress` at line 67 of the second). If either is gone, do not work around it silently:
- **No `fetch` option:** mint the bearer once per connection and pass it in `requestInit.headers` (`scripts/smoke.ts` does exactly this), and treat a 401 as a reason to reconnect the same way a 404 is. Say so in `FRICTION-LOG.md`, because it changes a 45-minute token into a per-connection one.
- **No `onprogress`:** the progress bar loses its source. Record it, ship without the `progress` events, and leave `ProgressMeter` unused rather than inventing a timer that looks like progress and is not.

- [ ] **Step 2: Write the failing test**

`apps/simulator/test/mcp.test.ts`:
```ts
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@homeledger/mcp-server/app';
import { seededDeps } from '@homeledger/mcp-server/test-harness';
import { HomeLedgerMcp, isLostSessionError, isUnauthorizedError, toDescriptors } from '../src/server/mcp.js';

let server: Server | undefined;
let closeApp: () => Promise<void> = async () => {};
let closeClient: () => Promise<void> = async () => {};

afterEach(async () => {
  await closeClient();
  await closeApp();
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  closeApp = async () => {};
  closeClient = async () => {};
});

async function listen(): Promise<string> {
  const deps = await seededDeps();
  const app = createApp(deps);
  closeApp = app.close;
  server = app.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
}

describe('isLostSessionError', () => {
  it('recognises the one 404 this container produces, and nothing else', () => {
    expect(isLostSessionError({ code: -32001, message: 'Session not found' })).toBe(true);
    expect(isLostSessionError(new Error('HTTP 404: Session not found'))).toBe(true);
    expect(isLostSessionError({ code: 404, message: 'Not Found' })).toBe(true);
    expect(isLostSessionError(new Error('HTTP 401: Unauthorized'))).toBe(false);
    expect(isLostSessionError(new Error('ECONNREFUSED'))).toBe(false);
    expect(isLostSessionError(undefined)).toBe(false);
  });
});

describe('isUnauthorizedError', () => {
  it('recognises a refused bearer, and does not confuse it with a lost session', () => {
    // A rotated Cognito client secret produces this and a rebuilt session
    // fixes none of it; a recycled instance produces the 404 above and a fresh
    // token fixes none of that. The two repairs are different, so the two
    // predicates must not overlap on any input either of them sees.
    expect(isUnauthorizedError(new Error('HTTP 401: Unauthorized'))).toBe(true);
    expect(isUnauthorizedError(new Error('HTTP 403: Forbidden'))).toBe(true);
    expect(isUnauthorizedError({ code: 401, message: 'Unauthorized' })).toBe(true);
    expect(isUnauthorizedError({ code: 403, message: 'Forbidden' })).toBe(true);
    expect(isUnauthorizedError(new Error('HTTP 404: Session not found'))).toBe(false);
    expect(isUnauthorizedError({ code: -32001, message: 'Session not found' })).toBe(false);
    expect(isUnauthorizedError(new Error('ECONNREFUSED'))).toBe(false);
    expect(isUnauthorizedError(undefined)).toBe(false);
  });
});

describe('toDescriptors', () => {
  it('keeps the order it was given, adding and dropping nothing', () => {
    // The property this wrapper owns. The SERVER owns which tools there are
    // and what order they come in - `apps/mcp-server/test/tools.test.ts`
    // asserts that, there - and Global Constraint 30 forbids restating its
    // list here. What can go wrong on this side is a sort, a filter or a
    // dropped field on the way through, and that is what this pins, against
    // an input written for the purpose rather than against the real nine.
    const input = [
      { name: 'zebra', description: 'z', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://homeledger/appliances' } } },
      { name: 'alpha', description: undefined, inputSchema: { type: 'object' } },
      { name: 'middle', description: 'm', inputSchema: { type: 'object' } }
    ];
    expect(toDescriptors(input).map(t => t.name)).toEqual(['zebra', 'alpha', 'middle']);
    expect(toDescriptors(input)[0]?._meta).toEqual({ ui: { resourceUri: 'ui://homeledger/appliances' } });
    expect(toDescriptors(input)[1]?.description).toBeUndefined();
  });
});

describe('HomeLedgerMcp against a real socket', () => {
  it('passes the server tool list through exactly as the wire delivered it', async () => {
    const url = await listen();
    const mcp = new HomeLedgerMcp({ url, token: async () => 'unused-locally', onElicit: async () => ({ action: 'cancel' }) });
    closeClient = () => mcp.close();
    await mcp.connect();
    expect(mcp.sessionId).toBeDefined();
    const names = (await mcp.listTools()).map(t => t.name);

    // Compared against a second, unwrapped SDK client reading the same
    // `tools/list` - not against a list written here. That keeps Global
    // Constraint 30 ("assert on tools/list's own order, not on a literal of
    // your own") while still being able to fail: a sort, a filter or a
    // truncation inside HomeLedgerMcp shows up as a difference, and a change
    // to the server's own order moves both sides together, which is correct
    // because the server's order is the server's test's business.
    const bare = new Client({ name: 'order-control', version: '0.0.0' }, { capabilities: {} });
    await bare.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      expect(names).toEqual((await bare.listTools()).tools.map(t => t.name));
    } finally {
      await bare.close();
    }
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes the negotiated protocol version, not a version of its own', async () => {
    const url = await listen();
    const mcp = new HomeLedgerMcp({ url, token: async () => 'unused-locally', onElicit: async () => ({ action: 'cancel' }) });
    closeClient = () => mcp.close();
    expect(mcp.protocolVersion).toBeUndefined();
    await mcp.connect();
    // Whatever the two ends settled on, read back off the transport that
    // settled it. Spec section 7 asks the debug drawer to show this, and the
    // only honest source for it is the handshake.
    expect(mcp.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('logs every JSON-RPC method it sends, with a status and a duration, and no payload', async () => {
    const url = await listen();
    const mcp = new HomeLedgerMcp({ url, token: async () => 'unused-locally', onElicit: async () => ({ action: 'cancel' }) });
    closeClient = () => mcp.close();
    await mcp.connect();
    await mcp.callTool('list_appliances', {});
    const methods = mcp.jsonRpcLog.map(entry => entry.method);
    expect(methods).toContain('initialize');
    expect(methods).toContain('tools/call');
    const call = mcp.jsonRpcLog.find(entry => entry.method === 'tools/call');
    expect(call?.direction).toBe('out');
    expect(call?.status).toBe(200);
    expect(call?.ms).toBeGreaterThanOrEqual(0);
    // Methods and timings, never bodies. The drawer that renders this is
    // served by /api/debug, which asserts that nothing it returns contains
    // 'token' - and every progress notification on this server carries a
    // `progressToken`. Logging payloads would put household data and that
    // word on a diagnostic endpoint at once.
    expect(JSON.stringify(mcp.jsonRpcLog)).not.toContain('appliances');
  });

  it('drives the three-round booking, answering each question through onElicit', async () => {
    const url = await listen();
    const asked: string[] = [];
    const mcp = new HomeLedgerMcp({
      url,
      token: async () => 'unused-locally',
      onElicit: async prompt => {
        const properties = (prompt.requestedSchema as { properties: Record<string, unknown> }).properties;
        const field = Object.keys(properties)[0] ?? '';
        asked.push(field);
        if (field === 'provider') return { action: 'accept', content: { provider: 'prov_kettle_water' } };
        if (field === 'window') return { action: 'accept', content: { window: 'win_1' } };
        return { action: 'accept', content: { confirm: true } };
      }
    });
    closeClient = () => mcp.close();
    await mcp.connect();
    const list = (await mcp.callTool('list_appliances', { category: 'water_heater' })) as { structuredContent: { appliances: Array<{ id: string }> } };
    const applianceId = list.structuredContent.appliances[0]!.id;

    const progress: number[] = [];
    const result = (await mcp.callTool('book_service', { applianceId, issue: 'water heater leaking at the base' }, p => progress.push(p.progress))) as {
      structuredContent: { provider: string; status: string };
    };

    expect(asked).toEqual(['provider', 'window', 'confirm']);
    expect(result.structuredContent.provider).toBe('Kettle Creek Water Heaters');
    expect(result.structuredContent.status).toBe('scheduled');
    expect(progress).toEqual([0, 1, 2, 3]);
  });

  it('reads a ui:// widget resource as HTML', async () => {
    const url = await listen();
    const mcp = new HomeLedgerMcp({ url, token: async () => 'unused-locally', onElicit: async () => ({ action: 'cancel' }) });
    closeClient = () => mcp.close();
    await mcp.connect();
    const html = await mcp.readResource('ui://homeledger/appliances');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('homeledger-appliances');
  });

  it('re-resolves the address, rebuilds the session, and replays the call exactly once when the session is gone', async () => {
    const url = await listen();
    let stolen = 0;
    const resolveUrl = vi.fn(async () => url);
    const mcp = new HomeLedgerMcp({
      url,
      token: async () => 'unused-locally',
      onElicit: async () => ({ action: 'cancel' }),
      resolveUrl,
      // Forges the failure mode FL-039 describes: a request carrying a session
      // id the instance does not hold. Rewriting the header is the only way to
      // reproduce it without waiting out a 30-minute idle timeout.
      fetchImpl: (input, init) => {
        const headers = new Headers(init?.headers);
        if (headers.get('mcp-session-id') && stolen === 0 && init?.method === 'POST' && String(init.body).includes('list_appliances')) {
          stolen += 1;
          headers.set('mcp-session-id', '00000000-0000-4000-8000-000000000000');
        }
        return fetch(input, { ...init, headers });
      }
    });
    closeClient = () => mcp.close();
    await mcp.connect();
    const before = mcp.sessionId;
    const result = (await mcp.callTool('list_appliances', {})) as { structuredContent: { appliances: unknown[] } };
    expect(result.structuredContent.appliances.length).toBeGreaterThan(0);
    expect(mcp.rebuilds).toBe(1);
    expect(mcp.sessionId).not.toBe(before);
    // Looked up again before reconnecting, not reused from startup. A runtime
    // recreated between two turns keeps its name and loses its id (FL-038), so
    // a rebuild against the remembered URL is the one repair that cannot fix
    // the one failure a redeploy causes. Exactly once: per rebuild, not per
    // attempt.
    expect(resolveUrl).toHaveBeenCalledTimes(1);
  });

  it('follows the runtime to a new address when the name now resolves somewhere else', async () => {
    const dead = await listen();
    const live = `${dead}?moved=1`;
    let stolen = 0;
    const mcp = new HomeLedgerMcp({
      url: dead,
      token: async () => 'unused-locally',
      onElicit: async () => ({ action: 'cancel' }),
      resolveUrl: async () => live,
      fetchImpl: (input, init) => {
        const headers = new Headers(init?.headers);
        if (headers.get('mcp-session-id') && stolen === 0 && init?.method === 'POST' && String(init.body).includes('list_appliances')) {
          stolen += 1;
          headers.set('mcp-session-id', '00000000-0000-4000-8000-000000000000');
        }
        return fetch(input, { ...init, headers });
      }
    });
    closeClient = () => mcp.close();
    await mcp.connect();
    expect(mcp.endpointUrl).toBe(dead);
    await mcp.callTool('list_appliances', {});
    // The query string is a stand-in for the generated id that changes when a
    // runtime is recreated: same server, different URL. What is under test is
    // that the client moved to the address the lookup returned rather than
    // reconnecting to the one it started with.
    expect(mcp.endpointUrl).toBe(live);
  });

  it('mints a fresh bearer and retries once when the endpoint refuses the one it had', async () => {
    const url = await listen();
    let refused = 0;
    const invalidateToken = vi.fn();
    const mcp = new HomeLedgerMcp({
      url,
      token: async () => 'unused-locally',
      onElicit: async () => ({ action: 'cancel' }),
      invalidateToken,
      resolveUrl: async () => url,
      // A rotated Cognito client secret, forged: the first tools/call comes
      // back 401 and every later request is passed through untouched, which is
      // what a token source that has just been invalidated produces.
      fetchImpl: async (input, init) => {
        if (refused === 0 && init?.method === 'POST' && String(init.body).includes('list_appliances')) {
          refused += 1;
          return new Response('{"error":"invalid_token"}', { status: 401, headers: { 'content-type': 'application/json' } });
        }
        return fetch(input, init);
      }
    });
    closeClient = () => mcp.close();
    await mcp.connect();
    const result = (await mcp.callTool('list_appliances', {})) as { structuredContent: { appliances: unknown[] } };
    expect(result.structuredContent.appliances.length).toBeGreaterThan(0);
    expect(invalidateToken).toHaveBeenCalledTimes(1);
    // A refused credential is not a lost session, and rebuilding one would
    // hide the other. The session is untouched.
    expect(mcp.rebuilds).toBe(0);
  });

  it('gives up rather than replaying twice when the rebuild does not help', async () => {
    const url = await listen();
    const mcp = new HomeLedgerMcp({
      url,
      token: async () => 'unused-locally',
      onElicit: async () => ({ action: 'cancel' }),
      fetchImpl: (input, init) => {
        const headers = new Headers(init?.headers);
        if (headers.get('mcp-session-id') && init?.method === 'POST' && String(init.body).includes('list_appliances')) {
          headers.set('mcp-session-id', '00000000-0000-4000-8000-000000000000');
        }
        return fetch(input, { ...init, headers });
      }
    });
    closeClient = () => mcp.close();
    await mcp.connect();
    // Matched, not bare. `rejects.toThrow()` with no argument passes on ANY
    // rejection, including a TypeError from this test's own fetch shim, so it
    // would stay green while proving nothing about the failure under test.
    await expect(mcp.callTool('list_appliances', {})).rejects.toThrow(/session not found/i);
    expect(mcp.rebuilds).toBe(1);
  });

  it('surfaces a tool the server does not have as a rejection, not as an empty result', async () => {
    const url = await listen();
    const mcp = new HomeLedgerMcp({ url, token: async () => 'unused-locally', onElicit: async () => ({ action: 'cancel' }) });
    closeClient = () => mcp.close();
    await mcp.connect();
    await expect(mcp.callTool('no_such_tool', {})).rejects.toThrow(/no_such_tool/);
    expect(mcp.rebuilds).toBe(0);
  });
});
```

The two imports from `@homeledger/mcp-server` need subpath exports. Add to `apps/mcp-server/package.json`, after `"type"`:
```json
  "exports": {
    "./app": { "types": "./dist/app.d.ts", "import": "./dist/app.js" },
    "./test-harness": { "types": "./test/harness.ts", "import": "./test/harness.ts" }
  },
```
The harness is exported from `test/` as TypeScript source on purpose: it is a test fixture, it is not compiled into `dist/`, and Vitest transpiles it. It is reachable only from a dev dependency, so nothing ships it.

- [ ] **Step 3: Run to verify failure**

```bash
pnpm --filter @homeledger/mcp-server build
pnpm --filter @homeledger/simulator run test -- mcp.test
```
Expected: FAIL, cannot find module `../src/server/mcp.js`.

- [ ] **Step 4: Implement**

`apps/simulator/src/server/mcp.ts`:
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ElicitationAnswer } from './elicitation.js';
import type { McpToolDescriptor } from './tools.js';

export interface ElicitPrompt {
  message: string;
  requestedSchema: unknown;
}

export interface HomeLedgerMcpOptions {
  /** The AgentCore invocation URL, or a plain http://127.0.0.1:PORT/mcp in tests. */
  url: string;
  /** Yields the current bearer. Called per HTTP request, so a refresh mid-conversation needs no plumbing here. */
  token: () => Promise<string>;
  /** Asks the person. Resolving is the answer; rejecting aborts the tool call. */
  onElicit: (prompt: ElicitPrompt) => Promise<ElicitationAnswer>;
  /** Drops the cached bearer so the next request mints a new one. Called once on a 401 or 403, before the single retry. */
  invalidateToken?: () => void;
  /** Re-resolves the runtime by name. Called before every rebuild; absent in tests that pin a URL. */
  resolveUrl?: () => Promise<string>;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

/** One line of the wire, for the debug drawer. Methods and timings only — never a payload; see `record`. */
export interface JsonRpcLogEntry {
  at: number;
  direction: 'out' | 'in';
  method: string;
  id: string | number | null;
  ms: number | null;
  status: number | null;
}

/** How many lines the drawer keeps. A conversation is minutes long and the drawer shows the tail; unbounded, this would grow with the session. */
export const JSON_RPC_LOG_LIMIT = 100;

/**
 * Maps `tools/list` onto the descriptor the rest of this application reads.
 *
 * Extracted from the class so the one property this side owns — that nothing
 * is reordered, filtered or flattened on the way through — can be pinned
 * without a socket. What tools exist and in what order is the server's
 * contract, asserted in the server's own suite; restating its list here is
 * what Global Constraint 30 forbids.
 */
export function toDescriptors(tools: ReadonlyArray<{ name: string; description?: string | undefined; inputSchema: unknown; _meta?: unknown }>): McpToolDescriptor[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
    _meta: tool._meta
  }));
}

const CLIENT_INFO = { name: 'homeledger-simulator', version: '0.1.0' } as const;

/**
 * Whether a failure means "the instance serving this request does not hold my session".
 *
 * The container answers 404 in exactly one place — `apps/mcp-server/src/legacy.ts`
 * line 50, a request carrying an `Mcp-Session-Id` its in-memory map does not
 * have — and AgentCore recycles an instance after 30 minutes idle, so this is
 * the failure an ordinary pause produces (FL-039). Matched on the JSON-RPC code
 * the server sends, on the HTTP status, or on the sentence, because which of
 * those reaches the caller depends on which layer noticed. Deliberately narrow:
 * a 401 is a credential problem and a connection refusal is an address problem,
 * and rebuilding a session fixes neither.
 */
export function isLostSessionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === -32001 || code === 404) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /\b404\b/.test(message) && /session not found/i.test(message);
}

/**
 * Whether a failure means "the bearer I sent was refused".
 *
 * A different repair from the one above, which is the whole reason it is a
 * different predicate: a rotated Cognito client secret is fixed by minting a
 * new token and sending the same call again, and rebuilding the MCP session
 * against the same credential fixes nothing while looking like it tried.
 * `apps/mcp-bridge/src/proxy.ts:160-185` is the rule being reused —
 * invalidate, retry exactly once, and let the second refusal through.
 */
export function isUnauthorizedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 401 || code === 403) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /\b(401|403)\b/.test(message);
}

/**
 * One MCP conversation with the deployed server, kept alive across a chat.
 *
 * A 2025-era client on purpose. The 2026-07-28 multi round-trip path exists and
 * the server serves it, but every client a person actually has — Claude Code,
 * the documented smart-display assistant, the Strands client the spec named —
 * negotiates 2025 and answers elicitation with `elicitation/create` over the
 * call's own event stream (FL-033). Using the same path the demo will be judged
 * on is worth more than using the newest one.
 *
 * "the documented smart-display assistant" rather than its product name, and
 * not as a stylistic choice: Task 7's wordmark guard walks every `.ts` under
 * `src/` except `server/prompt.ts`, lowercases both sides, and fails on the
 * mark wherever it appears — a comment included. The draft of this plan named
 * the product here, one task before it shipped the guard that forbids it.
 */
export class HomeLedgerMcp {
  private readonly options: HomeLedgerMcpOptions;
  private readonly log: (message: string) => void;
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private rebuildCount = 0;
  private url: string;
  private readonly wire: JsonRpcLogEntry[] = [];

  constructor(options: HomeLedgerMcpOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
    this.url = options.url;
  }

  /** The address currently in use. Not `options.url`: a heal moves it, and the drawer must show where the traffic actually goes. */
  get endpointUrl(): string {
    return this.url;
  }

  /** The version the two ends negotiated at `initialize`, read off the transport that negotiated it. Undefined before `connect()`. */
  get protocolVersion(): string | undefined {
    return this.transport?.protocolVersion;
  }

  /** The tail of the wire, newest last. Read by the debug drawer (spec section 7). */
  get jsonRpcLog(): readonly JsonRpcLogEntry[] {
    return this.wire;
  }

  /**
   * Appends one line, and never a payload.
   *
   * Method, id, status and duration are enough to read a conversation — which
   * call went out, whether it came back, how long it took, how many
   * notifications arrived between them — and they are the parts that carry
   * nothing private. Bodies carry the household's own data, and every progress
   * notification on this server carries a `progressToken`, which would put
   * that word on `/api/debug` and trip the credential assertion that guards
   * it. The one thing this deliberately cannot show is a request's arguments;
   * that is the price, and it is named here rather than discovered by whoever
   * goes looking for them.
   */
  private record(entry: JsonRpcLogEntry): void {
    this.wire.push(entry);
    if (this.wire.length > JSON_RPC_LOG_LIMIT) this.wire.splice(0, this.wire.length - JSON_RPC_LOG_LIMIT);
  }

  private recordOutbound(body: unknown, started: number, status: number | null): void {
    let parsed: unknown;
    try {
      parsed = typeof body === 'string' ? JSON.parse(body) : undefined;
    } catch {
      return;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (typeof message !== 'object' || message === null) continue;
      const method = (message as { method?: unknown }).method;
      if (typeof method !== 'string') continue;
      const id = (message as { id?: unknown }).id;
      this.record({
        at: Date.now(),
        direction: 'out',
        method,
        id: typeof id === 'string' || typeof id === 'number' ? id : null,
        ms: Date.now() - started,
        status
      });
    }
  }

  get sessionId(): string | undefined {
    return this.transport?.sessionId;
  }

  /** How many times the session has been rebuilt this conversation. Read by the debug drawer and by the tests. */
  get rebuilds(): number {
    return this.rebuildCount;
  }

  async connect(): Promise<void> {
    await this.close();
    const client = new Client(CLIENT_INFO, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, async request => {
      // A server-initiated request, so it never passes through the fetch tap
      // below. Logged here for the same reason spec section 7 asks for a
      // transport tap at all: a drawer that showed only outbound calls would
      // show `tools/call` sitting for two minutes with nothing in between,
      // which is exactly the moment somebody needs to see three questions.
      this.record({ at: Date.now(), direction: 'in', method: 'elicitation/create', id: null, ms: null, status: null });
      return this.options.onElicit({ message: request.params.message, requestedSchema: request.params.requestedSchema });
    });
    const base = this.options.fetchImpl ?? fetch;
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      // Per-request, not per-connection. A Cognito token lives about an hour
      // and a booking conversation can outlast one; minting here means the
      // refresh happens inside the token source and nothing above it notices.
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('authorization', `Bearer ${await this.options.token()}`);
        const started = Date.now();
        try {
          const response = await base(input, { ...init, headers });
          this.recordOutbound(init?.body, started, response.status);
          return response;
        } catch (error) {
          this.recordOutbound(init?.body, started, null);
          throw error;
        }
      }
    });
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
  }

  /**
   * Looks the runtime up by name and moves to wherever it is now.
   *
   * The bridge's `healAddress()`, reused for the same reason: AgentCore
   * generates a runtime's id at create time and offers no alias layer, so the
   * URL held since startup is correct only until the runtime is next recreated
   * and nothing announces when that happened (FL-038). Run before every
   * rebuild rather than only on a 404 that carried no session, because the
   * lookup is idempotent and a branch that fires only on the rarer of two
   * 404s is a branch no test in this repository can reach.
   */
  private async healAddress(): Promise<void> {
    if (!this.options.resolveUrl) return;
    const next = await this.options.resolveUrl();
    if (next === this.url) return;
    this.log(`the runtime moved: it now answers at ${next} rather than at ${this.url}`);
    this.url = next;
  }

  private require(): Client {
    if (!this.client) throw new Error('the MCP client is not connected; call connect() first');
    return this.client;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = await this.require().listTools();
    return toDescriptors(result.tools as ReadonlyArray<{ name: string; description?: string | undefined; inputSchema: unknown; _meta?: unknown }>);
  }

  /**
   * Calls one tool, repairing at most once.
   *
   * The replay is safe for the calls that can hit it, and the reason is the
   * failure itself: a 404 from the session lookup and a 401 from the
   * authoriser both mean the request was rejected before any handler ran, so
   * nothing was written and re-sending cannot double-apply. `mayRetry` is the
   * entire loop guard and it is cleared on the replay, so one call makes at
   * most one repair and at most two attempts — a runtime that is genuinely
   * gone, or a credential that is genuinely wrong, is never papered over by a
   * retry that keeps trying.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (p: { progress: number; total?: number; message?: string }) => void
  ): Promise<unknown> {
    return this.attempt(name, args, onProgress, true);
  }

  private async attempt(
    name: string,
    args: Record<string, unknown>,
    onProgress: ((p: { progress: number; total?: number; message?: string }) => void) | undefined,
    mayRetry: boolean
  ): Promise<unknown> {
    try {
      return await this.require().callTool(
        { name, arguments: args },
        undefined,
        onProgress
          ? {
              onprogress: progress => {
                this.record({ at: Date.now(), direction: 'in', method: 'notifications/progress', id: null, ms: null, status: null });
                onProgress(progress);
              }
            }
          : undefined
      );
    } catch (error) {
      if (!mayRetry) throw error;
      // Order matters. A refused bearer is fixed by a fresh bearer and NOT by
      // a new session, so it is tested first and repaired without touching the
      // session — rebuilding here would burn the conversation's history for a
      // problem that has nothing to do with it.
      if (isUnauthorizedError(error)) {
        this.options.invalidateToken?.();
        this.log('the endpoint refused the bearer; dropped the cached token and replaying the call once');
        return this.attempt(name, args, onProgress, false);
      }
      if (!isLostSessionError(error)) throw error;
      this.rebuildCount += 1;
      this.log('the runtime instance holding the MCP session was gone; re-resolved the runtime, re-established a session and replaying the call once');
      await this.healAddress();
      await this.connect();
      return this.attempt(name, args, onProgress, false);
    }
  }

  /** Reads a `ui://` widget, or any other resource, as text. Rejects rather than returning '' when there is no text part. */
  async readResource(uri: string): Promise<string> {
    const result = await this.require().readResource({ uri });
    for (const entry of result.contents) {
      const text = (entry as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
    throw new Error(`resource ${uri} carries no text content`);
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    if (!client) return;
    try {
      await client.close();
    } catch {
      /* a transport that is already gone is exactly the state close() wanted */
    }
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @homeledger/simulator run test -- mcp.test`
Expected: PASS, thirteen tests.

If the rebuild test does not see a 404 — because the SDK reconnects on its own before the error surfaces — check whether `StreamableHTTPClientTransport`'s `reconnectionOptions.maxRetries` (default 2) is swallowing it, pass `reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 30000, reconnectionDelayGrowFactor: 1.5 }` in `connect()`, and record the finding. Do not weaken the test to match whatever the transport happens to do.

If the 401 test's rejection does not carry the status in its message — because the installed SDK wraps a POST failure differently at this version — read what it does carry and widen `isUnauthorizedError` to match that instead, keeping the predicate narrow enough that the lost-session cases in its own unit test still return `false`. Do **not** widen it to "any error", which would make a credential problem look repairable by a retry it cannot survive. Record the shape in `FRICTION-LOG.md` as the next free number if it differs from what is written here.

If the protocol-version test finds `undefined` after `connect()`, the transport at this version exposes the negotiated version somewhere other than `transport.protocolVersion` (it is a getter over `_protocolVersion`, set by the `Protocol` base from the `initialize` result). Find where and read it there; do **not** fall back to a constant of your own, which would make the drawer show a version this client asked for rather than the one it got.

- [ ] **Step 6: Mutation check**

1. In `attempt`, pass `mayRetry` unchanged into the replay instead of `false` — the "gives up rather than replaying twice" test must fail, and it will fail by hanging or by a rebuild count above 1 rather than by a clean assertion; if it hangs, add `{ timeout: 5000 }` to that test so it reports a timeout and note that the mutation manifests as a loop.
2. In `isLostSessionError`, return `true` for every error — the unknown-tool test must fail (`rebuilds` becomes 1) and the 401/ECONNREFUSED cases must fail.
3. In `isLostSessionError`, drop the `code === -32001` arm — check whether any test fails. If none does, the arm is unreachable from this server and the unit test is asserting a shape nothing produces; keep the arm (AgentCore wraps the container's status) but say so in a comment, and add a test that exercises the 404-sentence arm and the code arm separately so neither is decorative.
4. In `connect`, move the bearer into `requestInit.headers` minted once — no test fails locally, because the local server ignores the header. That is the honest result and it belongs in the commit body: **the per-request token is not covered by any test in this repository**, only by the deployed run in Task 15, Step 7. Revert the mutation and leave the note.
5. In `callTool`, drop the `onprogress` option — the booking test's `progress` assertion must fail with `[]`, and the JSON-RPC log loses its `notifications/progress` lines.
6. In `attempt`, drop the `await this.healAddress()` before `this.connect()` — the "follows the runtime to a new address" test must fail, with `endpointUrl` still the dead one. Then, separately, make `healAddress` assign `this.url` without comparing (`this.url = await resolveUrl()`) and confirm nothing fails: that is correct, the comparison only suppresses a log line, so revert it and do not add a test for a log line.
7. In `attempt`, test `isLostSessionError` before `isUnauthorizedError` — check whether the 401 test fails. If it does not, the two predicates do not overlap on the error this server produces and the ordering is currently cosmetic; keep the order (a future endpoint that says `404 Unauthorized` is exactly the overlap this guards) and record in the commit body that the ordering is unproven by any test here.
8. In `attempt`, drop the `invalidateToken?.()` call but keep the retry — the 401 test must fail on `toHaveBeenCalledTimes(1)`. This is the assertion that a rotated secret is actually repaired rather than retried with the same dead token until the process restarts.
9. In `recordOutbound`, log `init?.body` itself alongside the method — the log test must fail on `not.toContain('appliances')`. Revert. The point of running it is that the failure is the guard working: this is the line between a diagnostic drawer and an endpoint that serves household data.
10. In `toDescriptors`, append `.sort((a, b) => a.name.localeCompare(b.name))` — the `toDescriptors` unit test and the wire-order test must both fail. Two failures from one mutation is the evidence that the second is not merely restating the first: the unit test pins the function, the socket test pins that `listTools` uses it.

- [ ] **Step 7: Commit**

```bash
git add apps/simulator/src/server/mcp.ts apps/simulator/test/mcp.test.ts apps/mcp-server/package.json
git commit -m "feat(simulator): MCP client with session rebuild and a single replay"
```

---

### Task 7: The system prompt and the model port

**Files:**
- Create: `apps/simulator/src/server/prompt.ts`, `apps/simulator/src/server/model.ts`
- Test: `apps/simulator/test/prompt.test.ts`, `apps/simulator/test/model.test.ts`

**Interfaces:**
- Consumes: `Anthropic` and its types from `@anthropic-ai/sdk`.
- Produces:
  ```ts
  // src/server/prompt.ts
  export const VOICE_MAX_ITEMS = 5;
  export const FORBIDDEN_WORDMARKS: readonly string[];
  export function buildSystemPrompt(input: { today: string; toolNames: readonly string[] }): string;

  // src/server/model.ts
  export const DEFAULT_MAX_TOKENS = 8192;
  export interface ModelRequest { system: string; messages: Anthropic.MessageParam[]; tools: Anthropic.Tool[] }
  export interface ModelPort { respond(request: ModelRequest, onText: (delta: string) => void): Promise<Anthropic.Message> }
  export interface MessagesLike { stream(params: Anthropic.MessageStreamParams): { on(event: 'text', listener: (delta: string) => void): unknown; finalMessage(): Promise<Anthropic.Message> } }
  export function createModelPort(options: { messages: MessagesLike; model: string; maxTokens?: number }): ModelPort;
  export function createAnthropicClient(apiKey: string): Anthropic;
  ```

- [ ] **Step 1: Verify the two request fields this task sends**

Open `apps/simulator/node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts` (or the workspace-hoisted copy that `pnpm ls @anthropic-ai/sdk` names) and confirm `MessageCreateParamsBase` carries `thinking?` and `output_config?`. Both were current at 0.127 with `thinking: { type: 'adaptive' }` and `output_config: { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }`.

If `output_config` is absent from the installed types, send the request without it and file the finding — the default effort is `high`, which costs latency on a surface whose whole point is a sub-3-second answer, so it is worth knowing rather than guessing. If `thinking` is absent, drop it: on `claude-opus-5` thinking is on by default and omitting the field runs adaptive anyway. In both cases do **not** cast the params object to `any` to force the field through; a field the installed SDK does not know about is a field the installed SDK will not send.

- [ ] **Step 2: Write the failing tests**

`apps/simulator/test/prompt.test.ts`:
```ts
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_WORDMARKS, VOICE_MAX_ITEMS, buildSystemPrompt } from '../src/server/prompt.js';

const NINE = ['list_appliances', 'get_appliance', 'maintenance_due', 'log_maintenance', 'recent_events', 'ask_manual', 'book_service', 'get_visit', 'echo_confirm'];

describe('buildSystemPrompt', () => {
  it('names every tool it was given, so a new tool cannot go unmentioned', () => {
    const prompt = buildSystemPrompt({ today: '2026-09-21', toolNames: NINE });
    for (const name of NINE) expect(prompt, name).toContain(name);
  });

  it('names only the tools it was given, rules included', () => {
    // Both halves of this matter and the second is the one that bites. The
    // prompt carries per-tool guidance ("book_service will ask the person
    // questions through the screen"), and guidance for a tool the server is
    // not offering is an instruction to call something that does not exist -
    // against a server started without HOMELEDGER_DEV_TOOLS, or against any
    // future one that drops a tool. The rules are therefore emitted per tool,
    // not as a fixed block.
    const prompt = buildSystemPrompt({ today: '2026-09-21', toolNames: ['list_appliances'] });
    expect(prompt).toContain('list_appliances');
    expect(prompt).not.toContain('book_service');
    expect(prompt).not.toContain('ask_manual');
  });

  it('carries each tool-specific rule when that tool IS on offer', () => {
    // The other side of the test above, and it has to exist: deleting the two
    // conditional rule lines outright would satisfy "names only the tools it
    // was given" perfectly while quietly dropping the guidance that stops the
    // model typing the three booking questions itself.
    const prompt = buildSystemPrompt({ today: '2026-09-21', toolNames: NINE });
    expect(prompt).toContain('book_service will ask the person questions through the screen');
    expect(prompt).toContain('ask_manual returns source passages');
  });

  it('carries the date it was given', () => {
    expect(buildSystemPrompt({ today: '2026-10-22', toolNames: NINE })).toContain('2026-10-22');
  });

  it('states the five-option ceiling as a number, not as a word', () => {
    expect(VOICE_MAX_ITEMS).toBe(5);
    expect(buildSystemPrompt({ today: '2026-09-21', toolNames: NINE })).toContain('at most 5');
  });

  it('forbids reading JSON aloud', () => {
    expect(buildSystemPrompt({ today: '2026-09-21', toolNames: NINE }).toLowerCase()).toContain('never read json');
  });

  it('forbids answering from fixtures when a call fails, in those words', () => {
    const prompt = buildSystemPrompt({ today: '2026-09-21', toolNames: NINE });
    expect(prompt).toContain('fixtures');
    expect(prompt).toContain('Say the call failed');
  });

  it('tells the model the marketplace is sample data', () => {
    expect(buildSystemPrompt({ today: '2026-09-21', toolNames: NINE })).toContain('sample data');
  });
});

describe('wordmark guard', () => {
  it('lists the names this product must not wear', () => {
    // The exact list, because a length check passes after someone reduces it
    // to ['Amazon'] and drops the two marks that matter most. These three are
    // what spec section 2 names - "No Amazon or Alexa logos or wordmarks" -
    // plus the device family the frame imitates, so the expected value is
    // anchored to the spec rather than restated from the module under test.
    expect([...FORBIDDEN_WORDMARKS]).toEqual(['Alexa', 'Echo Show', 'Amazon']);
  });

  it('finds none of them anywhere under apps/simulator/src, comments included', async () => {
    // Comments included is not a detail. This guard reads source text, so a
    // doc comment naming the product fails it exactly as a rendered string
    // would - which is correct, because a filename, an asset name and a
    // comment are all places the mark can travel out of this repository. Every
    // module written before this task has to be clean by the time this runs:
    // `src/server/mcp.ts`'s class comment named the product in the draft of
    // this plan, and it is written one task earlier than this test.
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(full)));
        else if (/\.(ts|tsx|css)$/.test(entry.name)) files.push(full);
      }
      return files;
    };
    const offenders: string[] = [];
    for (const file of await walk(root)) {
      if (file.endsWith(join('server', 'prompt.ts'))) continue; // the list itself lives here
      const text = await readFile(file, 'utf8').then(t => t.toLowerCase());
      for (const mark of FORBIDDEN_WORDMARKS) if (text.includes(mark.toLowerCase())) offenders.push(`${file}: ${mark}`);
    }
    expect(offenders).toEqual([]);
  });
});
```

`apps/simulator/test/model.test.ts`:
```ts
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_TOKENS, createModelPort, type MessagesLike } from '../src/server/model.js';

const finished = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text: 'Six appliances.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 4 }
} as unknown as Anthropic.Message;

function fakeMessages(deltas: string[]) {
  const seen: unknown[] = [];
  const messages: MessagesLike = {
    stream(params) {
      seen.push(params);
      let listener: ((delta: string) => void) | undefined;
      return {
        on(_event, handler) {
          listener = handler;
          return this;
        },
        async finalMessage() {
          for (const delta of deltas) listener?.(delta);
          return finished;
        }
      };
    }
  };
  return { messages, seen };
}

describe('createModelPort', () => {
  it('sends the model, the budget, the system prompt, the messages and the tools', async () => {
    const { messages, seen } = fakeMessages([]);
    const port = createModelPort({ messages, model: 'claude-opus-5' });
    const tools: Anthropic.Tool[] = [{ name: 'list_appliances', description: 'x', input_schema: { type: 'object' } }];
    await port.respond({ system: 'be brief', messages: [{ role: 'user', content: 'hi' }], tools }, () => {});
    expect(seen).toHaveLength(1);
    const params = seen[0] as Record<string, unknown>;
    expect(params.model).toBe('claude-opus-5');
    expect(params.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(params.system).toBe('be brief');
    expect(params.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(params.tools).toEqual(tools);
  });

  it('asks for a low effort, because this surface is answering out loud', async () => {
    const { messages, seen } = fakeMessages([]);
    await createModelPort({ messages, model: 'claude-opus-5' }).respond({ system: 's', messages: [], tools: [] }, () => {});
    expect((seen[0] as { output_config?: unknown }).output_config).toEqual({ effort: 'low' });
  });

  it('forwards every text delta in order and returns the finished message', async () => {
    const { messages } = fakeMessages(['Six ', 'appliances.']);
    const onText = vi.fn();
    const result = await createModelPort({ messages, model: 'claude-opus-5' }).respond({ system: 's', messages: [], tools: [] }, onText);
    expect(onText.mock.calls.map(call => call[0])).toEqual(['Six ', 'appliances.']);
    expect(result).toBe(finished);
  });

  it('honours an explicit token budget', async () => {
    const { messages, seen } = fakeMessages([]);
    await createModelPort({ messages, model: 'claude-opus-5', maxTokens: 1024 }).respond({ system: 's', messages: [], tools: [] }, () => {});
    expect((seen[0] as { max_tokens: number }).max_tokens).toBe(1024);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @homeledger/simulator run test -- prompt model`
Expected: FAIL, cannot find module `../src/server/prompt.js`.

- [ ] **Step 4: Implement the prompt**

`apps/simulator/src/server/prompt.ts`:
```ts
/** Alexa+'s published functional requirement: a spoken list never offers more than five things. */
export const VOICE_MAX_ITEMS = 5;

/**
 * Product names this simulator must not wear, checked against its own source.
 *
 * The spec's visual foundations say no logos or wordmarks, and the organiser
 * confirmed entrants cannot call the real assistant at all — so a surface that
 * uses the name is claiming a connection it does not have, whether it means to
 * or not. The disclosure in the frame therefore says what this IS (a simulation
 * driving HomeLedger's own MCP server) rather than naming what it is not, which
 * is both honest and free of the marks. The README, which is documentation
 * about the project rather than the product's own chrome, states the
 * relationship in full.
 */
export const FORBIDDEN_WORDMARKS: readonly string[] = ['Alexa', 'Echo Show', 'Amazon'];

/**
 * The persona and the rules, rebuilt per turn so the date and the live tool
 * list are always the real ones.
 *
 * Two of these rules are not style. "Never read JSON aloud" is a published
 * functional requirement and the server already enforces it on its own spoken
 * text; repeating it here stops the model from reading the structured payload
 * back out. And the failure rule exists because a transport error was twice
 * turned into a confident answer assembled from this repository's own seed
 * fixtures (FL-039) — the tool result already carries that instruction, and
 * this is the standing version of it.
 */
export function buildSystemPrompt(input: { today: string; toolNames: readonly string[] }): string {
  const offers = (name: string): boolean => input.toolNames.includes(name);
  return [
    'You are the household assistant for a smart display in one home. You speak out loud, so answer in short spoken sentences.',
    `Today is ${input.today}.`,
    '',
    'How to talk:',
    `- Name at most ${VOICE_MAX_ITEMS} things in one answer. If there are more, say how many there are and name the ones that matter.`,
    '- Never read JSON, ids, or field names aloud. Say "the washer", not "appl_washer2222222222".',
    '- One or two sentences is usually the whole answer. The screen shows the detail.',
    '',
    'The tools are the only source of truth about this household:',
    ...input.toolNames.map(name => `- ${name}`),
    '',
    'Rules you do not bend:',
    '- Call a tool before answering any question about this household. You have no prior knowledge of it.',
    '- If a tool call fails, say so. Say the call failed and what the error was. Do not answer from memory, from fixtures, from seed data, or from an earlier turn: a failed call tells you nothing, not even that the answer is empty.',
    '- The service-provider marketplace is sample data invented for this demo. If someone asks whether a booking is real, say that the providers are sample data and nothing leaves this system.',
    // Guidance for a tool, emitted only when that tool is on offer. Two rules
    // above are about the model's own conduct and always apply; these two name
    // a tool, and naming a tool the server did not list is an instruction to
    // call something that is not there. `echo_confirm` is gated behind
    // HOMELEDGER_DEV_TOOLS, so "the nine tools" is nine only against a runtime
    // that sets it - which makes "what the server offered this connection" the
    // only list either of these may be keyed on.
    ...(offers('ask_manual')
      ? ['- ask_manual returns source passages; you write the answer from them and cite the document title and page. If it returns no passages, say the manual could not be searched — do not invent the answer.']
      : []),
    ...(offers('book_service') ? ['- book_service will ask the person questions through the screen. Call it once and wait; do not ask the questions yourself in text.'] : [])
  ].join('\n');
}
```

- [ ] **Step 5: Implement the model port**

`apps/simulator/src/server/model.ts`:
```ts
import Anthropic from '@anthropic-ai/sdk';

/** Enough for a spoken answer plus a few tool calls; this surface never writes an essay. */
export const DEFAULT_MAX_TOKENS = 8192;

export interface ModelRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

export interface ModelPort {
  /** Streams text deltas to `onText` as they arrive and resolves with the completed message. */
  respond(request: ModelRequest, onText: (delta: string) => void): Promise<Anthropic.Message>;
}

/**
 * The slice of the SDK this port uses.
 *
 * Narrow on purpose: the agent tests drive a scripted model through several
 * tool rounds, and a fake that has to satisfy the whole `Anthropic` type would
 * be a fake nobody writes.
 */
export interface MessagesLike {
  stream(params: Anthropic.MessageStreamParams): {
    on(event: 'text', listener: (delta: string) => void): unknown;
    finalMessage(): Promise<Anthropic.Message>;
  };
}

export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

export function createModelPort(options: { messages: MessagesLike; model: string; maxTokens?: number }): ModelPort {
  return {
    async respond(request, onText) {
      const stream = options.messages.stream({
        model: options.model,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        thinking: { type: 'adaptive' },
        // Low, deliberately. This is a voice-first surface with a three-second
        // budget, the tools do the work, and the answers are one or two
        // sentences — the depth that higher effort buys has nothing to be
        // spent on here, and it is paid for in the pause before the display
        // says anything.
        output_config: { effort: 'low' }
      });
      stream.on('text', onText);
      return stream.finalMessage();
    }
  };
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm --filter @homeledger/simulator run test -- prompt model`
Expected: PASS, fourteen tests.

- [ ] **Step 7: Mutation check**

1. In `buildSystemPrompt`, drop the tool-name lines — the first prompt test must fail, naming the missing tools.
2. In `buildSystemPrompt`, hard-code the nine names instead of mapping `input.toolNames` — the "names only the tools it was given" test must fail.
3. In `buildSystemPrompt`, emit the two per-tool rule lines unconditionally (drop both `offers(...)` guards) — the "names only the tools it was given" test must fail, on `book_service` and on `ask_manual`. This is the mutation the draft of this plan shipped: the rules were unconditional and the test forbade them, so the task could not reach its own "Expected: PASS".
4. In `buildSystemPrompt`, delete the two per-tool rule lines entirely — the "carries each tool-specific rule" test must fail. Run this one immediately after the one above: together they pin the conditional from both sides, and either alone would be satisfied by the wrong fix.
5. In `buildSystemPrompt`, replace `at most 5` with `at most five` — the ceiling test must fail. (This is the guard against the rule being written in a form the constant cannot keep honest.)
6. In `FORBIDDEN_WORDMARKS`, drop `'Alexa'` and `'Echo Show'`, leaving `['Amazon']` — the list test must fail. The previous `length > 0` assertion passed this mutation, which removed the two marks that matter most.
7. Add the string `Alexa` to `src/components/` — create a one-line `src/components/Scratch.tsx` containing it, run, confirm the wordmark guard fails and names the file, then delete the file.
8. In `createModelPort`, drop `stream.on('text', onText)` — the delta test must fail with `[]`.
9. In `createModelPort`, change `effort` to `'high'` — the effort test must fail.

- [ ] **Step 8: Commit**

```bash
git add apps/simulator/src/server/prompt.ts apps/simulator/src/server/model.ts apps/simulator/test/prompt.test.ts apps/simulator/test/model.test.ts
git commit -m "feat(simulator): system prompt and a narrow Anthropic model port"
```

---

### Task 8: The agent loop

**Files:**
- Create: `apps/simulator/src/server/agent.ts`
- Test: `apps/simulator/test/agent.test.ts`

**Interfaces:**
- Consumes: `ElicitationRegistry`, `type ElicitationAnswer` from `./elicitation.js`; `type ElicitPrompt`, `HomeLedgerMcp` from `./mcp.js`; `type ModelPort` from `./model.js`; `buildSystemPrompt`, `VOICE_MAX_ITEMS` from `./prompt.js`; `elicitationShape`, `readToolResult`, `toAnthropicTools`, `toToolResultBlock`, `widgetUriOf`, `type McpToolDescriptor` from `./tools.js`; `type TurnEvent` from `../shared/events.js`.
- Produces:
  ```ts
  export interface ElicitRouter { handler: ((prompt: ElicitPrompt) => Promise<ElicitationAnswer>) | undefined; dispatch(prompt: ElicitPrompt): Promise<ElicitationAnswer> }
  export function createElicitRouter(): ElicitRouter;
  export const PROGRESS_TOTAL = 3;
  export interface TurnDeps {
    model: ModelPort;
    mcp: Pick<HomeLedgerMcp, 'callTool' | 'rebuilds'>;
    registry: ElicitationRegistry;
    router: ElicitRouter;
    tools: McpToolDescriptor[];
    emit: (event: TurnEvent) => void;
    now: () => number;
    today: string;
    maxRounds: number;
    elicitationTimeoutMs: number;
  }
  export async function runTurn(deps: TurnDeps, turnId: string, history: Anthropic.MessageParam[], userText: string): Promise<Anthropic.MessageParam[]>;
  ```

- [ ] **Step 1: Write the failing test**

`apps/simulator/test/agent.test.ts`:
```ts
import type { Server } from 'node:http';
import type Anthropic from '@anthropic-ai/sdk';
import { createApp } from '@homeledger/mcp-server/app';
import { seededDeps } from '@homeledger/mcp-server/test-harness';
import { afterEach, describe, expect, it } from 'vitest';
import { createElicitRouter, runTurn, type TurnDeps } from '../src/server/agent.js';
import { ElicitationRegistry } from '../src/server/elicitation.js';
import type { TurnEvent } from '../src/shared/events.js';
import { HomeLedgerMcp } from '../src/server/mcp.js';
import type { ModelPort } from '../src/server/model.js';

let server: Server | undefined;
let closeApp: () => Promise<void> = async () => {};
let closeClient: () => Promise<void> = async () => {};

afterEach(async () => {
  await closeClient();
  await closeApp();
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A model that plays a fixed script of turns, one per round. */
function scriptedModel(script: Array<(messages: Anthropic.MessageParam[]) => Anthropic.ContentBlock[]>): ModelPort {
  let round = 0;
  return {
    async respond(request, onText) {
      const content = script[round++]?.(request.messages) ?? [{ type: 'text', text: 'Done.' } as Anthropic.ContentBlock];
      for (const block of content) if (block.type === 'text') onText(block.text);
      return {
        id: `msg_${round}`,
        type: 'message',
        role: 'assistant',
        model: 'fake',
        content,
        stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
      } as unknown as Anthropic.Message;
    }
  };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): Anthropic.ContentBlock {
  return { type: 'tool_use', id, name, input } as unknown as Anthropic.ContentBlock;
}

/** Pulls the first appliance id out of the tool_result text the previous round produced. */
function applianceIdFrom(messages: Anthropic.MessageParam[]): string {
  const text = JSON.stringify(messages);
  return /appl_[a-z0-9]{16}/.exec(text)?.[0] ?? 'appl_missing';
}

/**
 * Everything `runTurn` needs with no server and no socket.
 *
 * The two guards inside `askThePerson` — an unrenderable schema, and more
 * options than this display shows — cannot be reached through the real server:
 * `apps/mcp-server/src/elicit.ts` only ever builds an enum or a boolean, and
 * `packages/core`'s `providersForCategory` ends in `.slice(0, MAX_PROVIDER_OPTIONS)`
 * with `MAX_PROVIDER_OPTIONS = 5`, so no fixture can offer six. A guard no
 * fixture can reach is the FL-032 N6 shape exactly, and the answer is a fake
 * that produces the shape rather than an assertion that quietly cannot fail.
 */
function fakeDeps(requestedSchema: unknown, over: Partial<TurnDeps> = {}) {
  const router = createElicitRouter();
  const events: TurnEvent[] = [];
  const turnDeps: TurnDeps = {
    model: scriptedModel([
      () => [toolUse('c1', 'book_service', { applianceId: 'appl_x', issue: 'leak' })],
      () => [{ type: 'text', text: 'I could not book that.' } as Anthropic.ContentBlock]
    ]),
    mcp: {
      rebuilds: 0,
      // What book_service does: ask through the connection the caller opened,
      // and let whatever comes back decide the result.
      callTool: async () => {
        const answer = await router.dispatch({ message: 'pick one', requestedSchema });
        return { content: [{ type: 'text', text: `answered ${answer.action}` }], structuredContent: { action: answer.action } };
      }
    },
    registry: new ElicitationRegistry(),
    router,
    tools: [{ name: 'book_service', description: 'Book a service visit.', inputSchema: { type: 'object' } }],
    emit: event => events.push(event),
    now: () => 0,
    today: '2026-09-13',
    maxRounds: 4,
    elicitationTimeoutMs: 2000,
    ...over
  };
  return { turnDeps, events, router };
}

async function harness(model: ModelPort, over: Partial<TurnDeps> = {}) {
  const deps = await seededDeps();
  const app = createApp(deps);
  closeApp = app.close;
  server = app.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const router = createElicitRouter();
  const mcp = new HomeLedgerMcp({ url, token: async () => 'unused-locally', onElicit: prompt => router.dispatch(prompt) });
  closeClient = () => mcp.close();
  await mcp.connect();
  const events: TurnEvent[] = [];
  const turnDeps: TurnDeps = {
    model,
    mcp,
    registry: new ElicitationRegistry(),
    router,
    tools: await mcp.listTools(),
    emit: event => events.push(event),
    now: () => 0,
    today: '2026-09-13',
    maxRounds: 6,
    elicitationTimeoutMs: 2000,
    ...over
  };
  return { turnDeps, events };
}

describe('runTurn', () => {
  it('calls a tool, emits its success, and feeds the result back to the model', async () => {
    const { turnDeps, events } = await harness(scriptedModel([() => [toolUse('c1', 'list_appliances', {})], () => [{ type: 'text', text: 'Six appliances.' } as Anthropic.ContentBlock]]));
    const messages = await runTurn(turnDeps, 't1', [], 'what appliances do we have');

    expect(events.map(e => e.type)).toEqual(['turn-started', 'tool-started', 'tool-succeeded', 'assistant-text', 'turn-finished']);
    const success = events.find(e => e.type === 'tool-succeeded');
    expect(success && success.type === 'tool-succeeded' && success.widgetUri).toBe('ui://homeledger/appliances');

    // The tool result really reached the model, as a tool_result block keyed to the call.
    const fedBack = messages[2];
    expect(fedBack?.role).toBe('user');
    expect(JSON.stringify(fedBack?.content)).toContain('"tool_use_id":"c1"');
    expect(JSON.stringify(fedBack?.content)).not.toContain('is_error');
  });

  it('surfaces a failed call as a failure and tells the model nothing was retrieved', async () => {
    const { turnDeps, events } = await harness(scriptedModel([() => [toolUse('c1', 'no_such_tool', {})], () => [{ type: 'text', text: 'That failed.' } as Anthropic.ContentBlock]]));
    const messages = await runTurn(turnDeps, 't1', [], 'do the impossible');

    const failure = events.find(e => e.type === 'tool-failed');
    expect(failure).toBeDefined();
    expect(events.some(e => e.type === 'tool-succeeded')).toBe(false);
    const fedBack = JSON.stringify(messages[2]?.content);
    expect(fedBack).toContain('"is_error":true');
    expect(fedBack).toContain('NO DATA WAS RETRIEVED');
  });

  it('drives the three-round booking through the registry and reports progress 0 to 3', async () => {
    const { turnDeps, events } = await harness(
      scriptedModel([
        () => [toolUse('c1', 'list_appliances', { category: 'water_heater' })],
        messages => [toolUse('c2', 'book_service', { applianceId: applianceIdFrom(messages), issue: 'water heater leaking at the base' })],
        () => [{ type: 'text', text: 'Booked.' } as Anthropic.ContentBlock]
      ])
    );

    // Answer each question as it is opened. This runs concurrently with the
    // turn on purpose: the tool call is still open while these land, which is
    // the whole shape the UI has to support.
    const answered: string[] = [];
    const originalEmit = turnDeps.emit;
    turnDeps.emit = event => {
      originalEmit(event);
      if (event.type !== 'elicitation-opened') return;
      answered.push(event.field);
      const content =
        event.field === 'provider' ? { provider: 'prov_kettle_water' } : event.field === 'window' ? { window: 'win_1' } : { confirm: true };
      setTimeout(() => turnDeps.registry.answer('t1', event.elicitationId, { action: 'accept', content }), 0);
    };

    await runTurn(turnDeps, 't1', [], 'book a plumber for the water heater');

    expect(answered).toEqual(['provider', 'window', 'confirm']);
    const opened = events.filter(e => e.type === 'elicitation-opened');
    expect(opened[0]?.type === 'elicitation-opened' && opened[0].kind).toBe('choice');
    // The three water_heater providers packages/core seeds, by value and in
    // order. The assertion this replaces was `options.length <= 5` against a
    // category that holds three and a server that slices to five: the value
    // was 3, the bound was 5, and no change to anything could have failed it.
    // The ceiling itself is tested where the ceiling is, two tests below.
    expect(opened[0]?.type === 'elicitation-opened' && opened[0].options.map(o => o.value)).toEqual([
      'prov_kettle_water',
      'prov_anode_and_co',
      'prov_hotline_tank'
    ]);
    expect(opened[2]?.type === 'elicitation-opened' && opened[2].kind).toBe('confirm');
    expect(events.filter(e => e.type === 'progress').map(e => (e.type === 'progress' ? e.progress : -1))).toEqual([0, 1, 2, 3]);
    expect(events.filter(e => e.type === 'elicitation-closed')).toHaveLength(3);
    const booked = events.find(e => e.type === 'tool-succeeded' && e.tool === 'book_service');
    expect(booked && booked.type === 'tool-succeeded' && (booked.structured as { status: string }).status).toBe('scheduled');
  });

  it('closes the turn and abandons an unanswered question rather than hanging forever', async () => {
    const { turnDeps, events } = await harness(
      scriptedModel([
        () => [toolUse('c1', 'list_appliances', { category: 'water_heater' })],
        messages => [toolUse('c2', 'book_service', { applianceId: applianceIdFrom(messages), issue: 'no hot water' })],
        () => [{ type: 'text', text: 'I could not book it.' } as Anthropic.ContentBlock]
      ]),
      { elicitationTimeoutMs: 30 }
    );
    await runTurn(turnDeps, 't1', [], 'book a plumber');
    expect(events.some(e => e.type === 'elicitation-closed' && e.action === 'abandoned')).toBe(true);
    expect(turnDeps.registry.has('t1')).toBe(false);
  });

  it('stops after the round budget instead of looping', async () => {
    const { turnDeps, events } = await harness(scriptedModel(Array.from({ length: 10 }, () => () => [toolUse(`c${Math.random()}`, 'list_appliances', {})])), {
      maxRounds: 2
    });
    await runTurn(turnDeps, 't1', [], 'loop please');
    expect(events.filter(e => e.type === 'tool-started')).toHaveLength(2);
    expect(events.some(e => e.type === 'turn-failed')).toBe(true);
  });

  it('refuses a question it cannot render, and reports the call as failed rather than answering for the person', async () => {
    // A free-text field where the card can only offer buttons. The previous
    // version of this test passed `requestedSchema` to a bare `dispatch` with
    // no handler set, which rejects with "no turn is running" whatever the
    // schema is - a renderable enum produced the identical rejection - so the
    // behaviour named in the title was never exercised.
    const { turnDeps, events } = fakeDeps({ type: 'object', properties: { note: { type: 'string' } }, required: ['note'] });
    await runTurn(turnDeps, 't1', [], 'book a plumber');
    const failure = events.find(e => e.type === 'tool-failed');
    expect(failure && failure.type === 'tool-failed' && failure.message).toMatch(/this display cannot render/);
    expect(events.some(e => e.type === 'elicitation-opened')).toBe(false);
  });

  it('refuses a choice wider than the display shows, rather than truncating it', async () => {
    // Six options where the published functional requirement is five. The
    // server cannot produce this - its marketplace slices to five and the
    // water_heater category holds three - so the only way to reach the guard
    // is to hand it the shape directly. Truncating instead would put a
    // provider the person was never shown into a booking they confirmed.
    const { turnDeps, events } = fakeDeps({
      type: 'object',
      properties: { provider: { type: 'string', enum: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] } },
      required: ['provider']
    });
    await runTurn(turnDeps, 't1', [], 'book a plumber');
    const failure = events.find(e => e.type === 'tool-failed');
    expect(failure && failure.type === 'tool-failed' && failure.message).toMatch(/offered 6 options and this display shows at most 5/);
    expect(events.some(e => e.type === 'elicitation-opened')).toBe(false);
  });

  it('rejects a question that arrives when no turn is running, rather than silently cancelling it', async () => {
    // The router's own guard, tested for what it is. A question outside a turn
    // means the client and the loop are out of step, and answering it with a
    // cancel would look downstream exactly like a person who declined.
    const router = createElicitRouter();
    await expect(router.dispatch({ message: 'pick', requestedSchema: { properties: { free: { type: 'string' } } } })).rejects.toThrow(/no turn is running/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @homeledger/simulator run test -- agent`
Expected: FAIL, cannot find module `../src/server/agent.js`.

- [ ] **Step 3: Implement**

`apps/simulator/src/server/agent.ts`:
```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { ElicitationAnswer } from './elicitation.js';
import { ElicitationRegistry } from './elicitation.js';
import type { TurnEvent } from '../shared/events.js';
import type { ElicitPrompt, HomeLedgerMcp } from './mcp.js';
import type { ModelPort } from './model.js';
import { VOICE_MAX_ITEMS, buildSystemPrompt } from './prompt.js';
import { elicitationShape, readToolResult, toAnthropicTools, toToolResultBlock, widgetUriOf, type McpToolDescriptor } from './tools.js';

/** `book_service`'s availability check reports 0 of 3 through 3 of 3 (`apps/mcp-server/src/progress.ts`). */
export const PROGRESS_TOTAL = 3;

export interface ElicitRouter {
  handler: ((prompt: ElicitPrompt) => Promise<ElicitationAnswer>) | undefined;
  dispatch(prompt: ElicitPrompt): Promise<ElicitationAnswer>;
}

/**
 * Routes a server-initiated question to whichever turn is running.
 *
 * The MCP client is built once per conversation and holds one elicitation
 * handler for its whole life, but the thing that can answer a question is a
 * turn, which exists for a minute. This is the indirection between them, and
 * it **rejects** rather than defaulting when no turn is running: a question
 * arriving outside a turn means the client and the loop have got out of step,
 * and answering it with a silent cancel would look to everyone downstream like
 * a person who declined.
 */
export function createElicitRouter(): ElicitRouter {
  const router: ElicitRouter = {
    handler: undefined,
    async dispatch(prompt) {
      if (!router.handler) throw new Error('the server asked a question but no turn is running to answer it');
      return router.handler(prompt);
    }
  };
  return router;
}

export interface TurnDeps {
  model: ModelPort;
  mcp: Pick<HomeLedgerMcp, 'callTool' | 'rebuilds'>;
  registry: ElicitationRegistry;
  router: ElicitRouter;
  tools: McpToolDescriptor[];
  emit: (event: TurnEvent) => void;
  now: () => number;
  today: string;
  maxRounds: number;
  elicitationTimeoutMs: number;
}

function isToolUse(block: Anthropic.ContentBlock): block is Anthropic.ToolUseBlock {
  return block.type === 'tool_use';
}

async function askThePerson(deps: TurnDeps, turnId: string, callId: string, prompt: ElicitPrompt): Promise<ElicitationAnswer> {
  const shape = elicitationShape(prompt.requestedSchema);
  // Refuse, loudly, rather than render something else. A free-text box where
  // the server wanted one of five enum values lets a person answer something
  // that will be rejected, and a silent cancel would be indistinguishable from
  // a decline they never made.
  if (!shape) throw new Error(`the server asked a question this display cannot render: ${JSON.stringify(prompt.requestedSchema)}`);
  if (shape.options.length > VOICE_MAX_ITEMS)
    throw new Error(`the server offered ${shape.options.length} options and this display shows at most ${VOICE_MAX_ITEMS}`);

  const { elicitationId, answer } = deps.registry.ask(turnId, deps.elicitationTimeoutMs);
  deps.emit({ type: 'elicitation-opened', callId, elicitationId, prompt: prompt.message, field: shape.field, kind: shape.kind, options: shape.options });
  try {
    const value = await answer;
    deps.emit({ type: 'elicitation-closed', elicitationId, action: value.action });
    return value;
  } catch {
    // Timed out, or the browser went away. `cancel` is the honest answer to
    // send the server: the question was never answered, and the server's own
    // handler turns that into "Okay, I haven't booked anything."
    deps.emit({ type: 'elicitation-closed', elicitationId, action: 'abandoned' });
    return { action: 'cancel' };
  }
}

async function runOneCall(deps: TurnDeps, turnId: string, call: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
  const args = (typeof call.input === 'object' && call.input !== null ? call.input : {}) as Record<string, unknown>;
  deps.emit({ type: 'tool-started', callId: call.id, tool: call.name, args });
  const started = deps.now();
  const rebuildsBefore = deps.mcp.rebuilds;
  deps.router.handler = prompt => askThePerson(deps, turnId, call.id, prompt);

  let outcome: ReturnType<typeof readToolResult>;
  try {
    const raw = await deps.mcp.callTool(call.name, args, progress =>
      deps.emit({
        type: 'progress',
        callId: call.id,
        progress: progress.progress,
        total: progress.total ?? PROGRESS_TOTAL,
        message: progress.message ?? ''
      })
    );
    outcome = readToolResult(raw);
  } catch (error) {
    outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    deps.router.handler = undefined;
  }

  // Checked outside the try so a rebuild that happened on the way to a failure
  // is still reported. A session that was silently rebuilt is a thing the
  // person watching should see once, not a thing only the logs know.
  if (deps.mcp.rebuilds > rebuildsBefore)
    deps.emit({ type: 'session-rebuilt', note: 'The connection to the household server had expired. It was re-established and the call was retried once.' });

  const ms = deps.now() - started;
  const tool = deps.tools.find(candidate => candidate.name === call.name);
  if (outcome.ok)
    deps.emit({
      type: 'tool-succeeded',
      callId: call.id,
      tool: call.name,
      spoken: outcome.spoken,
      // Both, and from the result rather than reconstructed: `spoken` is what
      // the transcript reads, `content` is half of the `{content,
      // structuredContent}` payload the MCP Apps view protocol specifies and
      // the only route by which Task 14's widget host can ever be handed it.
      content: outcome.content,
      structured: outcome.structured,
      widgetUri: tool ? widgetUriOf(tool) : null,
      ms
    });
  else deps.emit({ type: 'tool-failed', callId: call.id, tool: call.name, message: outcome.message, ms });
  return toToolResultBlock(call.id, outcome);
}

/**
 * One user turn: model, tools, model, until the model stops asking for tools.
 *
 * Tool calls run one at a time even when the model asks for several, because
 * they share one MCP session and because `book_service` holds its response
 * stream open across three questions — two of those in flight at once would
 * put two cards on one screen with no way to say which is which. That is a
 * sequencing choice inside the turn and it is not the property FL-033 is
 * about: the elicitation ANSWERS arrive on their own HTTP requests, into this
 * same process, while this loop is parked on `await`.
 */
export async function runTurn(deps: TurnDeps, turnId: string, history: Anthropic.MessageParam[], userText: string): Promise<Anthropic.MessageParam[]> {
  const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: userText }];
  const system = buildSystemPrompt({ today: deps.today, toolNames: deps.tools.map(tool => tool.name) });
  const tools = toAnthropicTools(deps.tools);
  deps.registry.open(turnId);
  deps.emit({ type: 'turn-started', turnId });
  try {
    for (let round = 0; round < deps.maxRounds; round++) {
      const reply = await deps.model.respond({ system, messages, tools }, text => deps.emit({ type: 'assistant-text', text }));
      // The whole content array, unedited — thinking blocks included. They are
      // bound to the model that produced them and have to be echoed back
      // unchanged for the next round to continue the same reasoning.
      messages.push({ role: 'assistant', content: reply.content });
      const calls = reply.content.filter(isToolUse);
      if (calls.length === 0) return messages;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) results.push(await runOneCall(deps, turnId, call));
      messages.push({ role: 'user', content: results });
    }
    deps.emit({ type: 'turn-failed', message: `The assistant used its ${deps.maxRounds} tool rounds without finishing, so the turn was stopped.` });
    return messages;
  } finally {
    deps.registry.close(turnId, 'the turn ended');
    deps.emit({ type: 'turn-finished', turnId });
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @homeledger/simulator run test -- agent`
Expected: PASS, eight tests.

- [ ] **Step 5: Mutation check**

1. In `runOneCall`, emit `tool-succeeded` in both branches (drop the `outcome.ok` test) — the failure test must fail on `tool-succeeded` being present.
2. In `runOneCall`, swallow the catch and return `toToolResultBlock(call.id, { ok: true, spoken: '', content: null, structured: null })` — the failure test must fail on `is_error`.
3. In `runTurn`, push `{ role: 'assistant', content: [textOnly] }` instead of `reply.content` — the first test must fail, because the tool_use block is gone and the loop ends after one round.
4. In `runTurn`, move `deps.registry.close` out of the `finally` — the abandoned test must fail on `registry.has('t1')`.
5. In `askThePerson`, return `{ action: 'cancel' }` instead of throwing on an unrenderable schema — the "refuses a question it cannot render" test must fail: no `tool-failed`, and the call reports success. That test drives the shape through `fakeDeps` rather than through the server, because the server cannot produce it; a note saying "the test is missing" is not an acceptable outcome of this mutation any more.
6. In `askThePerson`, truncate with `shape.options.slice(0, VOICE_MAX_ITEMS)` instead of throwing — the six-option test must fail: an `elicitation-opened` appears where a `tool-failed` is required. This is the one that matters most of the three: a truncated list is the only failure here a person cannot see, because five plausible providers look exactly like five providers.
7. In `runTurn`, change `round < deps.maxRounds` to `round <= deps.maxRounds` — the budget test must fail on the tool-started count.
8. In `runOneCall`, emit `content: null` instead of `outcome.content` — no test in *this* file fails; Task 11's reducer test and Task 14's widget wiring are where it bites, and both are downstream. Run it anyway and record the result: if the whole suite is green after it, run `pnpm --filter @homeledger/simulator run test` again once Task 11 lands and confirm it is not.
9. In `runOneCall`, move the rebuild check inside the `try` — no existing test fails, because the local server never loses a session here. Record that honestly: **the "rebuild reported on a failing call" path is covered only by Task 15, Step 7's deployed run.** Revert and leave the note.

- [ ] **Step 6: Commit**

```bash
git add apps/simulator/src/server/agent.ts apps/simulator/test/agent.test.ts
git commit -m "feat(simulator): the agent turn loop over the deployed tool surface"
```

---

### Task 9: The two agent routes — a held-open stream and a sibling answer

**Files:**
- Create: `apps/simulator/src/server/session.ts`, `apps/simulator/src/server/http.ts`, `apps/simulator/src/app/api/agent/turn/route.ts`, `apps/simulator/src/app/api/agent/answer/route.ts`
- Test: `apps/simulator/test/routes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2 through 8.
- Produces:
  ```ts
  // src/server/session.ts
  export interface Conversation {
    mcp: HomeLedgerMcp;
    registry: ElicitationRegistry;
    router: ElicitRouter;
    model: ModelPort;
    tools: McpToolDescriptor[];
    env: SimulatorEnv;
    endpoint: { arn: string | undefined; origin: 'url' | 'arn' | 'name' };
    /** The household's IANA zone, read from `homeledger://household` at connect. Every date this process speaks is computed in it. */
    timeZone: string;
    /** The one clock. Injectable so a test can pin an instant that makes the household day and the UTC day differ. */
    now: () => number;
    history: Anthropic.MessageParam[];
  }
  export async function householdTimeZone(mcp: Pick<HomeLedgerMcp, 'readResource'>, log?: (m: string) => void): Promise<string>;
  export async function getConversation(): Promise<Conversation>;

  // src/server/http.ts
  export const UNKNOWN_TURN_MESSAGE: string;
  export function checkOrigin(request: Request, allowOrigin: string | undefined): Response | undefined;
  export function handleTurn(conversation: Conversation, request: Request): Promise<Response>;
  export function handleAnswer(conversation: Conversation, request: Request): Promise<Response>;
  ```

`endpoint` no longer carries a `url`: `HomeLedgerMcp.endpointUrl` is the address actually in use and it moves when the client heals it (Task 6), so a copy taken at startup would be the one thing the debug drawer must never show — a stale address, displayed confidently, while the traffic goes elsewhere. `arn` and `origin` stay, because they describe how the address was *found*, which does not change.

- [ ] **Step 1: Write the failing test**

`apps/simulator/test/routes.test.ts`:
```ts
import type { Server } from 'node:http';
import type Anthropic from '@anthropic-ai/sdk';
import { SEED_TIMEZONE } from '@homeledger/core';
import { createApp } from '@homeledger/mcp-server/app';
import { seededDeps } from '@homeledger/mcp-server/test-harness';
import { afterEach, describe, expect, it } from 'vitest';
import { createElicitRouter } from '../src/server/agent.js';
import { ElicitationRegistry } from '../src/server/elicitation.js';
import { createSseDecoder, type TurnEvent } from '../src/shared/events.js';
import { handleAnswer, handleTurn, UNKNOWN_TURN_MESSAGE } from '../src/server/http.js';
import { HomeLedgerMcp } from '../src/server/mcp.js';
import type { ModelPort } from '../src/server/model.js';
import { householdTimeZone, type Conversation } from '../src/server/session.js';

let server: Server | undefined;
let closeApp: () => Promise<void> = async () => {};
let closeClient: () => Promise<void> = async () => {};

afterEach(async () => {
  await closeClient();
  await closeApp();
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

function toolUse(id: string, name: string, input: Record<string, unknown>): Anthropic.ContentBlock {
  return { type: 'tool_use', id, name, input } as unknown as Anthropic.ContentBlock;
}

function scriptedModel(script: Array<(messages: Anthropic.MessageParam[]) => Anthropic.ContentBlock[]>): ModelPort {
  let round = 0;
  return {
    async respond(request, onText) {
      const content = script[round++]?.(request.messages) ?? [{ type: 'text', text: 'Done.' } as Anthropic.ContentBlock];
      for (const block of content) if (block.type === 'text') onText(block.text);
      return { id: 'm', type: 'message', role: 'assistant', model: 'fake', content, stop_reason: 'end_turn', stop_sequence: null, usage: {} } as unknown as Anthropic.Message;
    }
  };
}

async function conversation(model: ModelPort): Promise<Conversation> {
  const deps = await seededDeps();
  const app = createApp(deps);
  closeApp = app.close;
  server = app.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const router = createElicitRouter();
  const mcp = new HomeLedgerMcp({ url, token: async () => 'unused-locally', onElicit: prompt => router.dispatch(prompt) });
  closeClient = () => mcp.close();
  await mcp.connect();
  return {
    mcp,
    registry: new ElicitationRegistry(),
    router,
    model,
    tools: await mcp.listTools(),
    env: { anthropicApiKey: 'unused', model: 'fake', maxRounds: 6, elicitationTimeoutMs: 3000, allowOrigin: undefined },
    endpoint: { arn: undefined, origin: 'url' },
    timeZone: await householdTimeZone(mcp),
    now: () => Date.now(),
    history: []
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/agent/turn', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
}

/** Reads the stream and calls `onEvent` for each event AS IT ARRIVES, never after. */
async function drain(response: Response, onEvent: (event: TurnEvent) => void): Promise<TurnEvent[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const decode = createSseDecoder();
  const all: TurnEvent[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const event of decode(decoder.decode(value, { stream: true }))) {
      all.push(event);
      onEvent(event);
    }
  }
  return all;
}

describe('POST /api/agent/turn', () => {
  it('streams the turn and tells every proxy not to buffer it', async () => {
    const convo = await conversation(scriptedModel([() => [{ type: 'text', text: 'Hello.' } as Anthropic.ContentBlock]]));
    const response = await handleTurn(convo, post({ text: 'hello' }));
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const events = await drain(response, () => {});
    expect(events.map(e => e.type)).toEqual(['turn-started', 'assistant-text', 'turn-finished']);
  });

  it(
    'completes a three-question booking with each answer POSTed while the turn stream is still open',
    async () => {
      // THE deadlock guard. If handleTurn buffered the response, `drain` would
      // yield nothing until the turn ended, the turn would wait for answers
      // that can only be sent from inside `drain`, and this test would time
      // out rather than fail — which is exactly how FL-033's naive proxy
      // failed. The timeout below is the assertion that it does not.
      const convo = await conversation(
        scriptedModel([
          () => [toolUse('c1', 'list_appliances', { category: 'water_heater' })],
          messages => [toolUse('c2', 'book_service', { applianceId: /appl_[a-z0-9]{16}/.exec(JSON.stringify(messages))?.[0] ?? 'appl_missing', issue: 'leak' })],
          () => [{ type: 'text', text: 'Booked.' } as Anthropic.ContentBlock]
        ])
      );
      const response = await handleTurn(convo, post({ text: 'book a plumber for the water heater' }));
      let turnId = '';
      const answers: Array<Promise<Response>> = [];
      const events = await drain(response, event => {
        if (event.type === 'turn-started') turnId = event.turnId;
        if (event.type !== 'elicitation-opened') return;
        const content = event.field === 'provider' ? { provider: 'prov_kettle_water' } : event.field === 'window' ? { window: 'win_1' } : { confirm: true };
        answers.push(handleAnswer(convo, post({ turnId, elicitationId: event.elicitationId, action: 'accept', content })));
      });

      expect(events.filter(e => e.type === 'elicitation-opened').map(e => (e.type === 'elicitation-opened' ? e.field : ''))).toEqual([
        'provider',
        'window',
        'confirm'
      ]);
      for (const answer of answers) expect((await answer).status).toBe(202);
      const booked = events.find(e => e.type === 'tool-succeeded' && e.tool === 'book_service');
      expect(booked && booked.type === 'tool-succeeded' && (booked.structured as { status: string }).status).toBe('scheduled');
      expect(events.filter(e => e.type === 'progress').map(e => (e.type === 'progress' ? e.progress : -1))).toEqual([0, 1, 2, 3]);
    },
    { timeout: 15000 }
  );

  it('keeps the history so a second turn sees the first', async () => {
    const convo = await conversation(scriptedModel([() => [{ type: 'text', text: 'One.' } as Anthropic.ContentBlock]]));
    await drain(await handleTurn(convo, post({ text: 'first question' })), () => {});
    expect(convo.history.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(convo.history)).toContain('first question');
  });

  it('refuses a body with no text, without opening a stream', async () => {
    const convo = await conversation(scriptedModel([]));
    for (const body of [{}, { text: '' }, { text: '   ' }, { text: 42 }]) {
      const response = await handleTurn(convo, post(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
    }
  });

  it("tells the model the household's day, which at this instant is not the UTC one", async () => {
    // 02:00Z on the 14th is still the 13th in Chicago, and the assistant SAYS
    // this date out loud. `new Date().toISOString().slice(0, 10)` - the
    // construct spec section 4.2 names as wrong, and the one that flipped
    // maintenance items to overdue at 7 PM Central three days before this plan
    // was written - yields 2026-09-14 here. The expected value is written by
    // hand rather than computed with todayInZone, so the test cannot agree
    // with the code by construction (FL-028).
    const systems: string[] = [];
    const convo = await conversation({
      async respond(request) {
        systems.push(request.system);
        return { id: 'm', type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: {} } as unknown as Anthropic.Message;
      }
    });
    convo.timeZone = 'America/Chicago';
    convo.now = () => Date.parse('2026-09-14T02:00:00.000Z');
    await drain(await handleTurn(convo, post({ text: 'what is due' })), () => {});
    expect(systems[0]).toContain('Today is 2026-09-13.');
    expect(systems[0]).not.toContain('2026-09-14');
  });
});

describe('POST /api/agent/answer', () => {
  it('reports an answer for a turn this process is not running, and says what that means', async () => {
    const convo = await conversation(scriptedModel([]));
    const response = await handleAnswer(convo, post({ turnId: 'not-a-turn', elicitationId: 'x', action: 'accept', content: {} }));
    expect(response.status).toBe(409);
    const body = (await response.json()) as { reason: string; message: string };
    expect(body.reason).toBe('unknown-turn');
    expect(body.message).toBe(UNKNOWN_TURN_MESSAGE);
    expect(UNKNOWN_TURN_MESSAGE).toContain('was not delivered');
  });

  it('rejects an action it does not know rather than guessing one', async () => {
    const convo = await conversation(scriptedModel([]));
    const response = await handleAnswer(convo, post({ turnId: 't', elicitationId: 'e', action: 'maybe', content: {} }));
    expect(response.status).toBe(400);
  });

  it('requires an object for content when the action is accept', async () => {
    const convo = await conversation(scriptedModel([]));
    const response = await handleAnswer(convo, post({ turnId: 't', elicitationId: 'e', action: 'accept', content: 'prov_kettle_water' }));
    expect(response.status).toBe(400);
  });
});

describe('checkOrigin', () => {
  it('lets everything through when no origin is configured', async () => {
    const convo = await conversation(scriptedModel([() => [{ type: 'text', text: 'ok' } as Anthropic.ContentBlock]]));
    const response = await handleTurn(convo, post({ text: 'hi' }, { origin: 'https://elsewhere.invalid' }));
    expect(response.status).toBe(200);
    await drain(response, () => {});
  });

  it('refuses a foreign origin when one is configured', async () => {
    const convo = await conversation(scriptedModel([]));
    convo.env = { ...convo.env, allowOrigin: 'http://127.0.0.1:3000' };
    const response = await handleTurn(convo, post({ text: 'hi' }, { origin: 'https://elsewhere.invalid' }));
    expect(response.status).toBe(403);
  });

  it('accepts the configured origin', async () => {
    const convo = await conversation(scriptedModel([() => [{ type: 'text', text: 'ok' } as Anthropic.ContentBlock]]));
    convo.env = { ...convo.env, allowOrigin: 'http://127.0.0.1:3000' };
    await drain(await handleTurn(convo, post({ text: 'hi' }, { origin: 'http://127.0.0.1:3000' })), () => {});
    expect(convo.history).toHaveLength(2);
  });

  it('accepts a request that sends no Origin header at all', async () => {
    // Its own test, because this is a different branch and the version that
    // promised both cases in one title ran only the first: every test in this
    // file that set an allow-origin also sent an explicit Origin, so
    // `origin === null` was never once evaluated and the mutation that refuses
    // it survived the whole suite. curl, the runbook's own diagnostics, and
    // these tests send none; a browser always sends one, which is exactly why
    // a missing Origin is not the cross-site case this check exists for.
    const convo = await conversation(scriptedModel([() => [{ type: 'text', text: 'ok' } as Anthropic.ContentBlock]]));
    convo.env = { ...convo.env, allowOrigin: 'http://127.0.0.1:3000' };
    const response = await handleTurn(convo, post({ text: 'hi' }));
    expect(response.status).toBe(200);
    await drain(response, () => {});
    expect(convo.history).toHaveLength(2);
  });
});

describe('householdTimeZone', () => {
  it('reads the zone the household record names', async () => {
    const convo = await conversation(scriptedModel([]));
    // The seeded household is in America/Chicago, and it is read off
    // `homeledger://household` rather than assumed: the server renders every
    // human-facing time in this zone and the simulator speaks the date, so the
    // two have to be reading the same record.
    expect(await householdTimeZone(convo.mcp)).toBe('America/Chicago');
    expect(await householdTimeZone(convo.mcp)).toBe(SEED_TIMEZONE);
  });

  it('falls back to the seeded zone, and says so, when the record cannot be read', async () => {
    const said: string[] = [];
    const zone = await householdTimeZone(
      {
        readResource: async () => {
          throw new Error('resource homeledger://household carries no text content');
        }
      },
      message => said.push(message)
    );
    expect(zone).toBe(SEED_TIMEZONE);
    expect(said.join(' ')).toContain(SEED_TIMEZONE);
    // Not UTC. A fallback to UTC would put the simulator back on exactly the
    // day boundary this whole mechanism exists to move off.
    expect(zone).not.toBe('UTC');
  });

  it('falls back when the record names no zone, rather than speaking an empty one', async () => {
    const zone = await householdTimeZone({ readResource: async () => JSON.stringify({ id: 'hh_test', name: 'The Harlow household' }) });
    expect(zone).toBe(SEED_TIMEZONE);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @homeledger/simulator run test -- routes`
Expected: FAIL, cannot find module `../src/server/http.js`.

- [ ] **Step 3: Implement the conversation**

`apps/simulator/src/server/session.ts`:
```ts
import type Anthropic from '@anthropic-ai/sdk';
import { SEED_TIMEZONE } from '@homeledger/core';
import { createElicitRouter, type ElicitRouter } from './agent.js';
import { resolveUpstream } from './credentials.js';
import { ElicitationRegistry } from './elicitation.js';
import { readSimulatorEnv, type SimulatorEnv } from './env.js';
import { HomeLedgerMcp } from './mcp.js';
import { createAnthropicClient, createModelPort, type ModelPort } from './model.js';
import type { McpToolDescriptor } from './tools.js';

export interface Conversation {
  mcp: HomeLedgerMcp;
  registry: ElicitationRegistry;
  router: ElicitRouter;
  model: ModelPort;
  /** Read once at connect, in the server's frozen order. A tool added to the server is picked up by restarting this process, not by a redeploy of it. */
  tools: McpToolDescriptor[];
  env: SimulatorEnv;
  /** How the address was FOUND, which does not change. Where it points does — read `mcp.endpointUrl` for that. */
  endpoint: { arn: string | undefined; origin: 'url' | 'arn' | 'name' };
  /** The household's IANA zone. Every date this process speaks is computed in it, never in UTC. */
  timeZone: string;
  /** The one clock this conversation reads, for tool timings and for the calendar date alike. */
  now: () => number;
  history: Anthropic.MessageParam[];
}

/**
 * The household's time zone, from the household's own record.
 *
 * Read rather than configured, because the server reads it the same way
 * (`resolveHouseholdTimeZone`) and a second source would let the spoken date
 * and the rendered one disagree — which is the bug class spec §4.2 exists to
 * close. `SEED_TIMEZONE` is the fallback and **UTC is not**: falling back to
 * UTC would put the date back on the boundary that flips five hours early in
 * US Central, quietly, on the one day somebody is watching. The fallback is
 * logged every time it is taken, because a wrong-but-plausible zone is the
 * hardest kind of wrong to notice.
 */
export async function householdTimeZone(mcp: Pick<HomeLedgerMcp, 'readResource'>, log: (m: string) => void = () => {}): Promise<string> {
  try {
    const record: unknown = JSON.parse(await mcp.readResource('homeledger://household'));
    const zone = typeof record === 'object' && record !== null ? (record as { timezone?: unknown }).timezone : undefined;
    if (typeof zone === 'string' && zone.trim() !== '') return zone.trim();
    log(`the household record named no time zone; speaking dates in ${SEED_TIMEZONE}`);
  } catch (error) {
    log(`could not read homeledger://household (${error instanceof Error ? error.message : String(error)}); speaking dates in ${SEED_TIMEZONE}`);
  }
  return SEED_TIMEZONE;
}

/**
 * One conversation per process, built on first use.
 *
 * Process-wide rather than per-request because the MCP session, the tool list
 * and the chat history all have to outlive one HTTP request, and because an
 * elicitation answer arriving on its own request must find the turn that asked
 * — which is only possible inside the process running it. That is a real
 * constraint on how this can be deployed and it is written down rather than
 * assumed: behind more than one instance, `POST /api/agent/answer` reaches the
 * wrong one and the registry reports `unknown-turn`, which is the same class of
 * failure as FL-039 and is why the route says so in a sentence instead of
 * failing silently.
 */
let pending: Promise<Conversation> | undefined;

export async function getConversation(): Promise<Conversation> {
  pending ??= build().catch(error => {
    // A failed build must not be cached, or one expired SSO session poisons
    // the process until it is restarted.
    pending = undefined;
    throw error;
  });
  return pending;
}

async function build(): Promise<Conversation> {
  const say = (message: string): void => console.log(JSON.stringify({ msg: 'simulator', detail: message }));
  const env = readSimulatorEnv();
  const upstream = await resolveUpstream(process.env, say);
  const router = createElicitRouter();
  const mcp = new HomeLedgerMcp({
    url: upstream.url,
    token: upstream.token,
    // Both wired, both from the bridge's own implementations. A refused bearer
    // is repaired by invalidating and retrying; a runtime that was recreated
    // is repaired by looking it up by name again. Leaving either unconnected
    // leaves one of the two failure modes this project has already paid for
    // with no repair at all (FL-038, FL-039).
    invalidateToken: upstream.invalidateToken,
    resolveUrl: upstream.resolveUrl,
    onElicit: prompt => router.dispatch(prompt),
    log: say
  });
  await mcp.connect();
  return {
    mcp,
    registry: new ElicitationRegistry(),
    router,
    model: createModelPort({ messages: createAnthropicClient(env.anthropicApiKey).messages, model: env.model }),
    tools: await mcp.listTools(),
    env,
    endpoint: { arn: upstream.arn, origin: upstream.origin },
    timeZone: await householdTimeZone(mcp, say),
    now: () => Date.now(),
    history: []
  };
}
```

There is deliberately no `resetConversation`. The draft exported one and nothing ever called it, which is the dead-producer shape this plan flags elsewhere — and a reset that exists but is never reachable from the UI is worse than none, because the comment above `tools` then promises a recovery path nobody can take. A stale tool list is fixed by restarting the process, `getConversation` already declines to cache a failed build, and when something genuinely needs to reset a live conversation it arrives with the route that calls it.

- [ ] **Step 4: Implement the HTTP layer**

`apps/simulator/src/server/http.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { todayInZone } from '@homeledger/core';
import { runTurn } from './agent.js';
import type { ElicitationAnswer } from './elicitation.js';
import { encodeSse, type TurnEvent } from '../shared/events.js';
import type { Conversation } from './session.js';

export const UNKNOWN_TURN_MESSAGE =
  'That answer was not delivered: this server is not running the turn it names. Nothing was booked and nothing was changed. The turn may have ended, or this request may have reached a different instance than the one holding the conversation. Ask again to start a fresh turn.';

const UNKNOWN_QUESTION_MESSAGE =
  'That answer was not delivered: the question it names has already been answered or has timed out. Nothing was changed by this click.';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/**
 * Same-origin check, off unless an origin is configured.
 *
 * The MCP spec asks servers to validate `Origin` for exactly this reason: a
 * browser will happily POST cross-site, and these routes spend an API key and
 * write to a household. Off by default because the demo runs on localhost and
 * a check nobody configured that blocks the owner's own browser is worse than
 * no check; on the moment `HOMELEDGER_SIMULATOR_ALLOW_ORIGIN` is set, which is
 * the first thing a hosted deployment must do.
 */
export function checkOrigin(request: Request, allowOrigin: string | undefined): Response | undefined {
  if (!allowOrigin) return undefined;
  const origin = request.headers.get('origin');
  // A request with no Origin is not a cross-site browser request: `fetch` from
  // a page always sets one. curl and the tests do not, and refusing those
  // would block the diagnosis of everything else.
  if (origin === null || origin === allowOrigin) return undefined;
  return json({ ok: false, reason: 'forbidden-origin', message: `This server accepts requests from ${allowOrigin} only; this one came from ${origin}.` }, 403);
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs one turn and streams it.
 *
 * `runTurn` is started inside `start()` and deliberately **not awaited**: the
 * Response is returned the moment the stream exists, so the browser is reading
 * events while the turn is still producing them. That is the property that
 * lets an elicitation answer be POSTed on a second request while this one is
 * open, and it is the property whose absence deadlocks rather than errors
 * (FL-033). Anything that collects the events and returns them at the end —
 * the tidy-looking version — hangs on the first question.
 */
export async function handleTurn(conversation: Conversation, request: Request): Promise<Response> {
  const forbidden = checkOrigin(request, conversation.env.allowOrigin);
  if (forbidden) return forbidden;
  const body = await readJson(request);
  const text = body?.text;
  if (typeof text !== 'string' || text.trim() === '') return json({ ok: false, reason: 'bad-request', message: 'The body needs a non-empty "text" field.' }, 400);

  const turnId = randomUUID();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const emit = (event: TurnEvent): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(encodeSse(event)));
        } catch {
          // The browser went away mid-turn. Stop writing; the turn itself is
          // cancelled by `cancel()` below.
          open = false;
        }
      };
      void runTurn(
        {
          model: conversation.model,
          mcp: conversation.mcp,
          registry: conversation.registry,
          router: conversation.router,
          tools: conversation.tools,
          emit,
          now: conversation.now,
          // The household's calendar date, not the UTC one. The model is told
          // `Today is ${today}` and then says it out loud, so this is a date a
          // person hears — and `new Date().toISOString().slice(0, 10)`, which
          // this used to be, is the construct spec §4.2 names as wrong and the
          // one that flipped maintenance items to overdue at 7 PM US Central.
          // `todayInZone` is core's, already fixed once and tested there.
          today: todayInZone(new Date(conversation.now()).toISOString(), conversation.timeZone),
          maxRounds: conversation.env.maxRounds,
          elicitationTimeoutMs: conversation.env.elicitationTimeoutMs
        },
        turnId,
        conversation.history,
        text
      )
        .then(next => {
          conversation.history = next;
        })
        .catch((error: unknown) => {
          emit({ type: 'turn-failed', message: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          open = false;
          try {
            controller.close();
          } catch {
            /* already closed by a cancel */
          }
        });
    },
    cancel() {
      conversation.registry.close(turnId, 'the browser closed the turn before answering');
    }
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      // `no-transform` as well as `no-cache`: a compressing proxy that buffers
      // to compress would reintroduce the deadlock from the outside.
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-homeledger-turn-id': turnId
    }
  });
}

function readAnswer(body: Record<string, unknown> | undefined): ElicitationAnswer | undefined {
  const action = body?.action;
  if (action === 'decline') return { action: 'decline' };
  if (action === 'cancel') return { action: 'cancel' };
  if (action !== 'accept') return undefined;
  const content = body?.content;
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return undefined;
  return { action: 'accept', content: content as Record<string, unknown> };
}

/** Delivers one elicitation answer. 202 mirrors what the MCP wire itself answers to an elicitation response. */
export async function handleAnswer(conversation: Conversation, request: Request): Promise<Response> {
  const forbidden = checkOrigin(request, conversation.env.allowOrigin);
  if (forbidden) return forbidden;
  const body = await readJson(request);
  const turnId = body?.turnId;
  const elicitationId = body?.elicitationId;
  if (typeof turnId !== 'string' || typeof elicitationId !== 'string')
    return json({ ok: false, reason: 'bad-request', message: 'The body needs "turnId" and "elicitationId" strings.' }, 400);
  const answer = readAnswer(body);
  if (!answer)
    return json({ ok: false, reason: 'bad-request', message: 'The body needs "action" of accept, decline or cancel, and an object "content" when accepting.' }, 400);

  const outcome = conversation.registry.answer(turnId, elicitationId, answer);
  if (outcome === 'delivered') return json({ ok: true }, 202);
  if (outcome === 'unknown-turn') return json({ ok: false, reason: 'unknown-turn', message: UNKNOWN_TURN_MESSAGE }, 409);
  return json({ ok: false, reason: 'unknown-question', message: UNKNOWN_QUESTION_MESSAGE }, 409);
}
```

- [ ] **Step 5: Implement the two route adapters**

`apps/simulator/src/app/api/agent/turn/route.ts`:
```ts
import { handleTurn } from '@/server/http';
import { getConversation } from '@/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** No cap: a turn is bounded by the model's round budget and the elicitation timeout, not by a wall clock. */
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleTurn(await getConversation(), request);
  } catch (error) {
    // Reached only when the conversation itself cannot be built — a missing
    // API key, an expired SSO session, a runtime that is not deployed. Those
    // messages are written to be read (`apps/mcp-bridge/src/secret.ts`,
    // `src/runtime.ts`), so they are passed through rather than flattened.
    return new Response(JSON.stringify({ ok: false, reason: 'unavailable', message: error instanceof Error ? error.message : String(error) }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
}
```

`apps/simulator/src/app/api/agent/answer/route.ts`:
```ts
import { handleAnswer } from '@/server/http';
import { getConversation } from '@/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleAnswer(await getConversation(), request);
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, reason: 'unavailable', message: error instanceof Error ? error.message : String(error) }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm --filter @homeledger/simulator run test -- routes`
Expected: PASS, fifteen tests. The booking test takes a few seconds; if it times out at 15 s, the stream is being buffered somewhere — read the mutation note below before changing the timeout.

- [ ] **Step 7: Mutation check**

1. In `handleTurn`, replace the `ReadableStream` with collecting every event into an array and returning `new Response(events.map(encodeSse).join(''))` after awaiting `runTurn` — the booking test must **time out** rather than fail an assertion. That is the signature of this bug and the reason the test carries an explicit timeout: a deadlock does not report itself. Record the timeout as the detection.
2. In `handleTurn`, `await` the `runTurn` promise before returning the Response — same outcome, same reason. Both mutations are worth running: the first is "buffered the body", the second is "serialised the requests", and FL-033 names them as separate mistakes.
3. In `handleTurn`, drop `'x-accel-buffering': 'no'` — the header test must fail.
4. In `handleAnswer`, return 202 for every outcome — **only** the unknown-turn test must fail. (The draft of this note claimed the malformed-action test would fail too. It will not: `readAnswer` returns 400 before the outcome switch is ever reached, so that test never gets as far as the mutated line. A mutation note that over-claims is a note that gets believed instead of run.)
5. In `handleAnswer`, accept any `action` string — the unknown-action test must fail.
6. In `checkOrigin`, refuse a request with no Origin header — the "accepts a request that sends no Origin header at all" test must fail, and **nothing else will**. (The draft claimed "and so will every other test in the file that sets an allow-origin". It would not: both of the other tests that set one also send an explicit `Origin`, and the third leaves `allowOrigin` undefined and returns at the first line. That over-claim is why the branch went untested through a whole plan — the note read as coverage.)
7. In `handleTurn`, assign `conversation.history = next` inside the `.catch` instead of the `.then` — the history test must fail.
8. In `handleTurn`, replace `todayInZone(new Date(conversation.now()).toISOString(), conversation.timeZone)` with `new Date(conversation.now()).toISOString().slice(0, 10)` — the household-day test must fail, showing `Today is 2026-09-14.` where `2026-09-13` is required. This is the exact regression spec §4.2 names and the exact line the draft of this plan shipped.
9. In `householdTimeZone`, return `'UTC'` from the catch instead of `SEED_TIMEZONE` — the fallback test must fail on both assertions. Then, separately, make the `catch` rethrow: `build()` now dies when the household record is briefly unreadable, and no test covers that, so revert it and note that the resource read is on the startup path and a hard failure there would take the whole conversation down for a value that has a correct default.
10. In `build()`, drop `invalidateToken` and `resolveUrl` from the `HomeLedgerMcp` options — no test in this file fails, because the local server needs neither. Task 6's four repair tests are where they are proven; what this mutation shows is that nothing checks the **wiring** between the two. Record that honestly, and confirm by hand that `apps/simulator/src/server/session.ts` passes both before committing.

- [ ] **Step 8: Run the whole workspace**

```bash
pnpm --filter @homeledger/core build
pnpm --filter @homeledger/mcp-bridge build
pnpm --filter @homeledger/mcp-server build
pnpm format
pnpm typecheck
pnpm test
pnpm build
```
Expected: all green. `next build` now compiles both agent routes; if it complains that `@/server/session` pulls AWS SDK modules into a route, that is expected and fine — they are Node-runtime route handlers, not client components.

- [ ] **Step 9: Commit**

```bash
git add apps/simulator/src/server/session.ts apps/simulator/src/server/http.ts apps/simulator/src/app/api apps/simulator/test/routes.test.ts
git commit -m "feat(simulator): streaming turn route with answers on a sibling request"
```

---

### Task 10: The display frame, the visual foundations, and the disclosure

**Files:**
- Create: `apps/simulator/src/shared/canvas.ts`, `apps/simulator/src/components/Frame.tsx`, `apps/simulator/src/components/Disclosure.tsx`
- Modify: `apps/simulator/src/app/globals.css`
- Test: `apps/simulator/test/frame.test.tsx`

**Interfaces:**
- Consumes: `FORBIDDEN_WORDMARKS` from `@/server/prompt` — **in the test only**, never from a component.
- Produces:
  ```ts
  // src/shared/canvas.ts
  export const BASE_CANVAS: { readonly width: 768; readonly height: 480 };
  export const CANVAS_SCALE = 1.667;
  export const DEVICE: { readonly width: number; readonly height: number };   // 1280 x 800, derived

  // src/components/Frame.tsx
  export type Theme = 'dark' | 'light';
  export function Frame(props: { theme: Theme; onToggleTheme: () => void; children: ReactNode }): JSX.Element;

  // src/components/Disclosure.tsx
  export const DISCLOSURE_TEXT: string;
  export function Disclosure(): JSX.Element;
  ```

**Why the canvas gets its own module in `src/shared/`.** Two things need these numbers and they are on opposite sides of the application: the frame lays the canvas out at 768 × 480 and scales it, and Task 14's `hostContextFor` tells every widget its `maxWidth`/`maxHeight` so a widget sizes itself to the surface it was authored for. Written twice, they disagree the first time one is changed — and the disagreement is invisible, because a widget laid out for 1280 inside a 768 canvas just looks slightly wrong. `src/shared/` is where vocabulary both halves speak already lives, it holds no credential and imports no React, so `lib/widget-host.ts` can read it without importing a component. Task 10's own mutations 1 and 2 exist to prove `DEVICE` is derived from these rather than restated; mutation 7 extends that proof across the module boundary to Task 14.

- [ ] **Step 1: Write the failing test**

`apps/simulator/test/frame.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Frame } from '../src/components/Frame.js';
import { DISCLOSURE_TEXT } from '../src/components/Disclosure.js';
import { BASE_CANVAS, CANVAS_SCALE, DEVICE } from '../src/shared/canvas.js';
import { FORBIDDEN_WORDMARKS } from '../src/server/prompt.js';

describe('Frame', () => {
  it('is a 1280 by 800 display, which is the base canvas at its published scale', () => {
    // The spec gives 768x480 and 1.667; the device size is derived from them
    // rather than written down separately, so the three can never disagree.
    expect(BASE_CANVAS).toEqual({ width: 768, height: 480 });
    expect(CANVAS_SCALE).toBe(1.667);
    expect(DEVICE).toEqual({ width: 1280, height: 800 });
  });

  it('renders the canvas at its unscaled size and scales it with a transform', () => {
    render(
      <Frame theme="dark" onToggleTheme={() => {}}>
        <p>content</p>
      </Frame>
    );
    const canvas = screen.getByTestId('canvas');
    expect(canvas.style.width).toBe('768px');
    expect(canvas.style.height).toBe('480px');
    expect(canvas.style.transform).toBe('scale(1.667)');
    const device = screen.getByTestId('device');
    expect(device.style.width).toBe('1280px');
    expect(device.style.height).toBe('800px');
  });

  it('shows the disclosure without anyone opening anything', () => {
    render(
      <Frame theme="dark" onToggleTheme={() => {}}>
        <p>content</p>
      </Frame>
    );
    const disclosure = screen.getByTestId('disclosure');
    expect(disclosure.textContent).toBe(DISCLOSURE_TEXT);
    expect(disclosure.hidden).toBe(false);
  });

  it('says both of the things that have to be said', () => {
    expect(DISCLOSURE_TEXT).toContain('Simulation');
    expect(DISCLOSURE_TEXT).toContain('sample data');
    expect(DISCLOSURE_TEXT).toContain('no booking leaves this system');
  });

  it('wears no product name it has no right to', () => {
    render(
      <Frame theme="dark" onToggleTheme={() => {}}>
        <p>content</p>
      </Frame>
    );
    // Lowercased on both sides, the same way Task 7's source guard does it.
    // The two checks are meant to be the same rule applied at two levels -
    // source text and rendered text - and a case-sensitive one here would let
    // a rendered `alexa` through while the source guard caught it, which makes
    // the pair confusing rather than redundant.
    const text = (document.body.textContent ?? '').toLowerCase();
    for (const mark of FORBIDDEN_WORDMARKS) expect(text, mark).not.toContain(mark.toLowerCase());
  });

  it('reflects the theme it is given and offers exactly one control to change it', async () => {
    const onToggleTheme = vi.fn();
    const { rerender } = render(
      <Frame theme="dark" onToggleTheme={onToggleTheme}>
        <p>content</p>
      </Frame>
    );
    expect(screen.getByTestId('device').dataset.theme).toBe('dark');
    const toggle = screen.getByRole('button', { name: /switch to the light theme/i });
    toggle.click();
    expect(onToggleTheme).toHaveBeenCalledTimes(1);

    rerender(
      <Frame theme="light" onToggleTheme={onToggleTheme}>
        <p>content</p>
      </Frame>
    );
    expect(screen.getByTestId('device').dataset.theme).toBe('light');
    expect(screen.getByRole('button', { name: /switch to the dark theme/i })).toBeDefined();
  });

  it('puts its children inside the canvas, not beside it', () => {
    render(
      <Frame theme="dark" onToggleTheme={() => {}}>
        <p data-testid="child">content</p>
      </Frame>
    );
    expect(screen.getByTestId('canvas').contains(screen.getByTestId('child'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @homeledger/simulator run test -- frame`
Expected: FAIL, cannot find module `../src/components/Frame.js`.

- [ ] **Step 3: Implement the disclosure**

`apps/simulator/src/components/Disclosure.tsx`:
```tsx
/**
 * The two things this surface has to say about itself, always on screen.
 *
 * It says what this IS rather than naming what it is not, and that is a
 * deliberate choice: the organiser confirmed entrants cannot call the real
 * assistant at all, so putting that product's name on this chrome would claim
 * a connection that does not exist — the spec's "no logos or wordmarks" rule
 * read at its intent rather than its letter. What it must not leave out is the
 * simulated marketplace, which the spec requires disclosed and which the README
 * alone cannot cover: somebody watching a booking happen is not reading the
 * README.
 */
export const DISCLOSURE_TEXT =
  'Simulation — a smart-display surface built from published design guidance. It drives HomeLedger’s own MCP server for real; the service-provider marketplace is sample data and no booking leaves this system.';

export function Disclosure() {
  return (
    <p className="disclosure" data-testid="disclosure">
      {DISCLOSURE_TEXT}
    </p>
  );
}
```

- [ ] **Step 4: Implement the canvas constants and the frame**

`apps/simulator/src/shared/canvas.ts`:
```ts
/**
 * The published display geometry, written down once for the whole application.
 *
 * Read by `components/Frame.tsx`, which lays the canvas out at this size and
 * scales it, and by `lib/widget-host.ts`, which tells every widget these same
 * bounds in its `hostContext` so a widget sizes itself to the surface it was
 * authored against (`apps/mcp-server/src/widgets/shell.ts` is built for the
 * same 768). Deliberately here in `src/shared/` and not in the component: a
 * module under `lib/` must be able to read it without importing React, and a
 * second copy of 768 is a second thing to forget to change.
 *
 * Not in CSS either. `globals.css` declares no `--canvas-width`; the frame
 * sets the size inline from these values, so there is nothing to keep in sync
 * by hand.
 */
export const BASE_CANVAS = { width: 768, height: 480 } as const;

/** The published scale factor for the 8- and 15-inch displays. */
export const CANVAS_SCALE = 1.667;

/** Derived, never written down twice: 768 x 480 at 1.667 is 1280 x 800. */
export const DEVICE = { width: Math.round(BASE_CANVAS.width * CANVAS_SCALE), height: Math.round(BASE_CANVAS.height * CANVAS_SCALE) } as const;
```

`apps/simulator/src/components/Frame.tsx`:
```tsx
'use client';

import type { ReactNode } from 'react';
import { BASE_CANVAS, CANVAS_SCALE, DEVICE } from '../shared/canvas.js';
import { Disclosure } from './Disclosure.js';

export type Theme = 'dark' | 'light';

export function Frame({ theme, onToggleTheme, children }: { theme: Theme; onToggleTheme: () => void; children: ReactNode }) {
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <div className="device" data-testid="device" data-theme={theme} style={{ width: DEVICE.width, height: DEVICE.height }}>
      {/* Rendered at 768x480 and scaled up, rather than laid out at 1280x800.
          Anything else would let the layout reflow at the larger size, which
          is exactly what a fixed base canvas exists to prevent: a widget
          authored for 768 wide would sit in a column it never expected. */}
      <div
        className="canvas"
        data-testid="canvas"
        style={{ width: BASE_CANVAS.width, height: BASE_CANVAS.height, transform: `scale(${CANVAS_SCALE})`, transformOrigin: 'top left' }}
      >
        <div className="surface">{children}</div>
        <Disclosure />
      </div>
      <button type="button" className="theme-toggle" onClick={onToggleTheme} aria-label={`Switch to the ${next} theme`}>
        {next === 'light' ? 'Light' : 'Dark'}
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Style it**

Append to `apps/simulator/src/app/globals.css`:
```css
.device {
  position: relative;
  margin: 24px auto;
  overflow: hidden;
  border-radius: 18px;
  background: var(--bg);
  color: var(--text);
  box-shadow: 0 24px 64px rgb(0 0 0 / 55%);
}

/* The light palette is selected by the frame itself rather than by the page,
   so the toggle inside the simulated device drives the simulated device. */
.device[data-theme='light'] {
  color-scheme: light;
  --bg: #faf9fb;
  --card: #ffffff;
  --nested: #f2f1f4;
  --text: #16181d;
  --muted: #5b6070;
  --line: #dedbe4;
  --accent: #1f6feb;
  --warn: #b3541e;
}

.canvas {
  display: flex;
  flex-direction: column;
  padding: 16px;
  gap: 8px;
}

.surface {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
}

.disclosure {
  margin: 0;
  flex: 0 0 auto;
  font-size: 11px;
  line-height: 1.35;
  color: var(--muted);
  border-top: 1px solid var(--line);
  padding-top: 6px;
}

.theme-toggle {
  position: absolute;
  top: 10px;
  right: 12px;
  font: inherit;
  font-size: 12px;
  color: var(--card);
  background: var(--accent);
  border: 0;
  border-radius: 999px;
  padding: 4px 12px;
  cursor: pointer;
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm --filter @homeledger/simulator run test -- frame`
Expected: PASS, seven tests.

- [ ] **Step 7: Mutation check**

1. Change `CANVAS_SCALE` to `1.5` — the first test must fail on `DEVICE`, which proves the device size is derived and not a coincidence.
2. Hard-code `DEVICE = { width: 1280, height: 800 }` and change `CANVAS_SCALE` to `1.5` — the first test must now fail on `CANVAS_SCALE` alone while `DEVICE` passes. That is the shape to avoid; revert to the derived form.
3. Lay the canvas out at `DEVICE.width`/`DEVICE.height` with no transform — the canvas-size test must fail on all three assertions.
4. Wrap `<Disclosure />` in `{showDetails && ...}` defaulting to false — the "without anyone opening anything" test must fail.
5. Remove `sample data` from `DISCLOSURE_TEXT` — the "both things" test must fail.
6. Put a forbidden wordmark in the toggle's label — the wordmark test must fail. (Delete it again; the guard in Task 7 would also catch it at the source level, and both should.)
7. **Re-run this one after Task 14 lands, and record it there as well.** Change `BASE_CANVAS` to `{ width: 800, height: 500 }` — this task's canvas-size test must fail, *and* Task 14's `ui/initialize` test must fail on `maxWidth`. Two suites failing from one edit is the evidence that the widget host reads this module rather than carrying its own copy; if only one fails, the number has been written down twice again and the second copy is the bug. Revert.

- [ ] **Step 8: Commit**

```bash
git add apps/simulator/src/shared/canvas.ts apps/simulator/src/components apps/simulator/src/app/globals.css apps/simulator/test/frame.test.tsx
git commit -m "feat(simulator): display frame at the published canvas with a standing disclosure"
```

---

### Task 11: The transcript reducer, the client hook, and the composer

**Files:**
- Create: `apps/simulator/src/lib/transcript.ts`, `apps/simulator/src/lib/useAgentTurn.ts`, `apps/simulator/src/components/Transcript.tsx`, `apps/simulator/src/components/Composer.tsx`
- Modify: `apps/simulator/src/app/page.tsx`, `apps/simulator/src/app/globals.css`
- Test: `apps/simulator/test/transcript.test.ts`, `apps/simulator/test/transcript.test.tsx`

**Interfaces:**
- Consumes: `type ElicitationOption`, `type TurnEvent`, `createSseDecoder` from `@/shared/events`.
- Produces:
  ```ts
  // src/lib/transcript.ts
  export type Entry =
    | { kind: 'user'; id: string; text: string }
    | { kind: 'assistant'; id: string; text: string }
    | { kind: 'tool'; id: string; tool: string; status: 'running' | 'ok' | 'failed'; spoken: string; message: string; content: unknown; structured: unknown; widgetUri: string | null; ms: number | null }
    | { kind: 'notice'; id: string; text: string; tone: 'info' | 'failure' };
  export interface PendingQuestion { elicitationId: string; callId: string; prompt: string; field: string; kind: 'choice' | 'confirm'; options: ElicitationOption[] }
  export interface Progress { callId: string; progress: number; total: number; message: string }
  export interface AgentState { entries: Entry[]; pending: PendingQuestion | null; progress: Progress | null; running: boolean; turnId: string | null }
  export const INITIAL_STATE: AgentState;
  export function askedByUser(state: AgentState, text: string): AgentState;
  export function reduceTurn(state: AgentState, event: TurnEvent): AgentState;

  // src/lib/useAgentTurn.ts
  export interface AgentTurn { state: AgentState; ask(text: string): Promise<void>; answer(action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>): Promise<void> }
  export function useAgentTurn(fetchImpl?: typeof fetch): AgentTurn;
  ```

- [ ] **Step 1: Write the failing reducer test**

`apps/simulator/test/transcript.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { INITIAL_STATE, askedByUser, reduceTurn, type AgentState } from '../src/lib/transcript.js';
import type { TurnEvent } from '../src/shared/events.js';

function run(events: TurnEvent[], from: AgentState = INITIAL_STATE): AgentState {
  return events.reduce(reduceTurn, from);
}

describe('reduceTurn', () => {
  it('joins streamed assistant deltas into one entry rather than one per delta', () => {
    const state = run([
      { type: 'turn-started', turnId: 't1' },
      { type: 'assistant-text', text: 'Six ' },
      { type: 'assistant-text', text: 'appliances.' }
    ]);
    expect(state.entries).toEqual([{ kind: 'assistant', id: expect.any(String), text: 'Six appliances.' }]);
    expect(state.running).toBe(true);
    expect(state.turnId).toBe('t1');
  });

  it('starts a new assistant entry after a tool interrupts the stream', () => {
    const state = run([
      { type: 'turn-started', turnId: 't1' },
      { type: 'assistant-text', text: 'Looking.' },
      { type: 'tool-started', callId: 'c1', tool: 'list_appliances', args: {} },
      {
        type: 'tool-succeeded',
        callId: 'c1',
        tool: 'list_appliances',
        spoken: 'Six.',
        content: [{ type: 'text', text: 'Six.' }],
        structured: { appliances: [] },
        widgetUri: 'ui://homeledger/appliances',
        ms: 120
      },
      { type: 'assistant-text', text: 'Six appliances.' }
    ]);
    expect(state.entries.map(e => e.kind)).toEqual(['assistant', 'tool', 'assistant']);
    expect(state.entries[0]).toMatchObject({ text: 'Looking.' });
    expect(state.entries[2]).toMatchObject({ text: 'Six appliances.' });
  });

  it('flips a running call to ok and keeps its content, its widget and its timing', () => {
    const state = run([
      { type: 'tool-started', callId: 'c1', tool: 'maintenance_due', args: { horizonDays: 30 } },
      {
        type: 'tool-succeeded',
        callId: 'c1',
        tool: 'maintenance_due',
        spoken: 'Two are due.',
        content: [{ type: 'text', text: 'Two are due.' }],
        structured: { items: [] },
        widgetUri: 'ui://homeledger/calendar',
        ms: 940
      }
    ]);
    expect(state.entries).toEqual([
      {
        kind: 'tool',
        id: 'c1',
        tool: 'maintenance_due',
        status: 'ok',
        spoken: 'Two are due.',
        message: '',
        // Carried, not dropped. This is the half of the MCP Apps tool-result
        // payload the widget host pushes beside `structuredContent`, and the
        // only place it can come from is here.
        content: [{ type: 'text', text: 'Two are due.' }],
        structured: { items: [] },
        widgetUri: 'ui://homeledger/calendar',
        ms: 940
      }
    ]);
  });

  it('flips a running call to failed and never gives it spoken text, content or structure', () => {
    const state = run([
      { type: 'tool-started', callId: 'c1', tool: 'ask_manual', args: { question: 'what is F21' } },
      { type: 'tool-failed', callId: 'c1', tool: 'ask_manual', message: 'Model access is blocked on this account.', ms: 1130 }
    ]);
    const entry = state.entries[0];
    expect(entry).toMatchObject({ kind: 'tool', status: 'failed', message: 'Model access is blocked on this account.', spoken: '', ms: 1130 });
    expect(entry && entry.kind === 'tool' && entry.structured).toBeNull();
    // Nulled with the rest. A failure that kept a content array from an
    // earlier attempt would be a failure a widget could still render, which is
    // the whole shape FL-039 is about.
    expect(entry && entry.kind === 'tool' && entry.content).toBeNull();
  });

  it('records a result for a call it never saw start rather than dropping it', () => {
    const state = run([{ type: 'tool-failed', callId: 'ghost', tool: 'get_visit', message: 'Session not found.', ms: 4 }]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({ kind: 'tool', id: 'ghost', status: 'failed' });
  });

  it('holds one pending question at a time and clears it when it closes', () => {
    const opened: TurnEvent = {
      type: 'elicitation-opened',
      callId: 'c1',
      elicitationId: 'e1',
      prompt: 'Who should I book?',
      field: 'provider',
      kind: 'choice',
      options: [{ value: 'prov_a', label: 'Alpha' }]
    };
    const asked = run([opened]);
    expect(asked.pending).toEqual({ elicitationId: 'e1', callId: 'c1', prompt: 'Who should I book?', field: 'provider', kind: 'choice', options: [{ value: 'prov_a', label: 'Alpha' }] });
    expect(run([{ type: 'elicitation-closed', elicitationId: 'e1', action: 'accept' }], asked).pending).toBeNull();
  });

  it('ignores a close for a question it is not showing', () => {
    const opened: TurnEvent = { type: 'elicitation-opened', callId: 'c1', elicitationId: 'e1', prompt: 'p', field: 'provider', kind: 'choice', options: [] };
    const asked = run([opened]);
    expect(run([{ type: 'elicitation-closed', elicitationId: 'other', action: 'cancel' }], asked).pending).toEqual(asked.pending);
  });

  it('keeps the latest progress and drops it when the call that reported it settles', () => {
    const during = run([
      { type: 'tool-started', callId: 'c1', tool: 'book_service', args: {} },
      { type: 'progress', callId: 'c1', progress: 2, total: 3, message: 'Comparing arrival windows' }
    ]);
    expect(during.progress).toEqual({ callId: 'c1', progress: 2, total: 3, message: 'Comparing arrival windows' });
    const after = run([{ type: 'tool-succeeded', callId: 'c1', tool: 'book_service', spoken: 'Booked.', content: null, structured: {}, widgetUri: null, ms: 1800 }], during);
    expect(after.progress).toBeNull();
  });

  it('shows a rebuilt session as a notice, and a stopped turn as a failure', () => {
    const state = run([
      { type: 'session-rebuilt', note: 'The connection had expired.' },
      { type: 'turn-failed', message: 'The assistant used its 8 tool rounds without finishing.' }
    ]);
    expect(state.entries).toEqual([
      { kind: 'notice', id: expect.any(String), text: 'The connection had expired.', tone: 'info' },
      { kind: 'notice', id: expect.any(String), text: 'The assistant used its 8 tool rounds without finishing.', tone: 'failure' }
    ]);
  });

  it('stops running and drops any pending question when the turn finishes', () => {
    const state = run([
      { type: 'turn-started', turnId: 't1' },
      { type: 'elicitation-opened', callId: 'c1', elicitationId: 'e1', prompt: 'p', field: 'confirm', kind: 'confirm', options: [] },
      { type: 'turn-finished', turnId: 't1' }
    ]);
    expect(state.running).toBe(false);
    expect(state.pending).toBeNull();
  });
});

describe('askedByUser', () => {
  it('appends the question and marks the conversation as running before any event arrives', () => {
    const state = askedByUser(INITIAL_STATE, 'what appliances do we have');
    expect(state.entries).toEqual([{ kind: 'user', id: expect.any(String), text: 'what appliances do we have' }]);
    expect(state.running).toBe(true);
  });
});
```

- [ ] **Step 2: Write the failing hook and view test**

`apps/simulator/test/transcript.test.tsx`:
```tsx
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Transcript } from '../src/components/Transcript.js';
import { INITIAL_STATE, reduceTurn } from '../src/lib/transcript.js';
import { useAgentTurn } from '../src/lib/useAgentTurn.js';
import { encodeSse, type TurnEvent } from '../src/shared/events.js';

function streamOf(events: TurnEvent[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode(encodeSse(event)));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('useAgentTurn', () => {
  it('posts the question and folds every streamed event into the state', async () => {
    const fetchImpl = vi.fn(async () =>
      streamOf([
        { type: 'turn-started', turnId: 't1' },
        { type: 'assistant-text', text: 'Six appliances.' },
        { type: 'turn-finished', turnId: 't1' }
      ])
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useAgentTurn(fetchImpl));
    await act(async () => {
      await result.current.ask('what appliances do we have');
    });

    await waitFor(() => expect(result.current.state.running).toBe(false));
    expect(result.current.state.entries.map(e => e.kind)).toEqual(['user', 'assistant']);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe('/api/agent/turn');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ text: 'what appliances do we have' });
  });

  it('reports a non-200 as a visible failure instead of an empty answer', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Your AWS SSO session expired.' }), { status: 503 })) as unknown as typeof fetch;
    const { result } = renderHook(() => useAgentTurn(fetchImpl));
    await act(async () => {
      await result.current.ask('hello');
    });
    const notice = result.current.state.entries.find(e => e.kind === 'notice');
    expect(notice).toMatchObject({ tone: 'failure' });
    expect(notice && notice.kind === 'notice' && notice.text).toContain('Your AWS SSO session expired.');
    expect(result.current.state.running).toBe(false);
  });

  it('posts an answer against the turn that asked', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      if (url === '/api/agent/turn')
        return streamOf([
          { type: 'turn-started', turnId: 't7' },
          { type: 'elicitation-opened', callId: 'c1', elicitationId: 'e1', prompt: 'Who?', field: 'provider', kind: 'choice', options: [] }
        ]);
      return new Response('{"ok":true}', { status: 202 });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useAgentTurn(fetchImpl));
    await act(async () => {
      await result.current.ask('book a plumber');
    });
    await waitFor(() => expect(result.current.state.pending).not.toBeNull());
    await act(async () => {
      await result.current.answer('accept', { provider: 'prov_a' });
    });
    const answer = calls.find(([url]) => url === '/api/agent/answer');
    expect(answer).toBeDefined();
    expect(JSON.parse(String(answer![1].body))).toEqual({ turnId: 't7', elicitationId: 'e1', action: 'accept', content: { provider: 'prov_a' } });
  });
});

describe('Transcript', () => {
  it('renders the spoken line of a successful call and no raw JSON', () => {
    const state = [
      { type: 'tool-started', callId: 'c1', tool: 'maintenance_due', args: {} },
      {
        type: 'tool-succeeded',
        callId: 'c1',
        tool: 'maintenance_due',
        spoken: 'Two tasks are due.',
        content: [{ type: 'text', text: 'Two tasks are due.' }],
        structured: { items: [{ id: 1 }] },
        widgetUri: null,
        ms: 900
      }
    ].reduce(reduceTurn, INITIAL_STATE);
    render(<Transcript state={state} />);
    expect(screen.getByText('Two tasks are due.')).toBeDefined();
    expect(document.body.textContent).not.toContain('"items"');
  });

  it('renders a failed call as a failure naming the tool and the reason', () => {
    const state = [
      { type: 'tool-started', callId: 'c1', tool: 'ask_manual', args: {} },
      { type: 'tool-failed', callId: 'c1', tool: 'ask_manual', message: 'Model access is blocked on this account.', ms: 1130 }
    ].reduce(reduceTurn, INITIAL_STATE);
    render(<Transcript state={state} />);
    const failure = screen.getByTestId('tool-c1');
    expect(failure.dataset.status).toBe('failed');
    expect(failure.textContent).toContain('ask_manual');
    expect(failure.textContent).toContain('Model access is blocked on this account.');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @homeledger/simulator run test -- transcript`
Expected: FAIL, cannot find module `../src/lib/transcript.js`.

- [ ] **Step 4: Implement the reducer**

`apps/simulator/src/lib/transcript.ts`:
```ts
import type { ElicitationOption, TurnEvent } from '../shared/events.js';

export type Entry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      tool: string;
      status: 'running' | 'ok' | 'failed';
      spoken: string;
      message: string;
      /** The result's content array, for the widget host. Null on a running or a failed call, always. */
      content: unknown;
      structured: unknown;
      widgetUri: string | null;
      ms: number | null;
    }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'failure' };

export interface PendingQuestion {
  elicitationId: string;
  callId: string;
  prompt: string;
  field: string;
  kind: 'choice' | 'confirm';
  options: ElicitationOption[];
}

export interface Progress {
  callId: string;
  progress: number;
  total: number;
  message: string;
}

export interface AgentState {
  entries: Entry[];
  pending: PendingQuestion | null;
  progress: Progress | null;
  running: boolean;
  turnId: string | null;
}

export const INITIAL_STATE: AgentState = { entries: [], pending: null, progress: null, running: false, turnId: null };

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

export function askedByUser(state: AgentState, text: string): AgentState {
  return { ...state, entries: [...state.entries, { kind: 'user', id: nextId('user'), text }], running: true };
}

/** Replaces the tool entry with this id, or appends one when the start was never seen. */
function upsertTool(entries: Entry[], id: string, make: (previous: Entry | undefined) => Entry): Entry[] {
  const index = entries.findIndex(entry => entry.kind === 'tool' && entry.id === id);
  if (index === -1) return [...entries, make(undefined)];
  const next = [...entries];
  next[index] = make(entries[index]);
  return next;
}

/**
 * Folds one event into what is on screen.
 *
 * Pure and exported so the whole transcript can be tested without React, and
 * so the one property that matters most is checked directly: a `tool-failed`
 * event can only produce an entry with `status: 'failed'`, `spoken: ''` and
 * `structured: null`. There is no path by which a failure acquires the fields
 * a success renderer reads (FL-039).
 */
export function reduceTurn(state: AgentState, event: TurnEvent): AgentState {
  switch (event.type) {
    case 'turn-started':
      return { ...state, running: true, turnId: event.turnId };

    case 'assistant-text': {
      const last = state.entries[state.entries.length - 1];
      if (last?.kind === 'assistant') {
        const entries = [...state.entries];
        entries[entries.length - 1] = { ...last, text: last.text + event.text };
        return { ...state, entries };
      }
      return { ...state, entries: [...state.entries, { kind: 'assistant', id: nextId('assistant'), text: event.text }] };
    }

    case 'tool-started':
      return {
        ...state,
        entries: upsertTool(state.entries, event.callId, () => ({
          kind: 'tool',
          id: event.callId,
          tool: event.tool,
          status: 'running',
          spoken: '',
          message: '',
          content: null,
          structured: null,
          widgetUri: null,
          ms: null
        }))
      };

    case 'tool-succeeded':
      return {
        ...state,
        progress: state.progress?.callId === event.callId ? null : state.progress,
        entries: upsertTool(state.entries, event.callId, () => ({
          kind: 'tool',
          id: event.callId,
          tool: event.tool,
          content: event.content,
          status: 'ok',
          spoken: event.spoken,
          message: '',
          structured: event.structured,
          widgetUri: event.widgetUri,
          ms: event.ms
        }))
      };

    case 'tool-failed':
      return {
        ...state,
        progress: state.progress?.callId === event.callId ? null : state.progress,
        entries: upsertTool(state.entries, event.callId, () => ({
          kind: 'tool',
          id: event.callId,
          tool: event.tool,
          status: 'failed',
          spoken: '',
          message: event.message,
          content: null,
          structured: null,
          widgetUri: null,
          ms: event.ms
        }))
      };

    case 'progress':
      return { ...state, progress: { callId: event.callId, progress: event.progress, total: event.total, message: event.message } };

    case 'elicitation-opened':
      return {
        ...state,
        pending: { elicitationId: event.elicitationId, callId: event.callId, prompt: event.prompt, field: event.field, kind: event.kind, options: event.options }
      };

    case 'elicitation-closed':
      return state.pending?.elicitationId === event.elicitationId ? { ...state, pending: null } : state;

    case 'session-rebuilt':
      return { ...state, entries: [...state.entries, { kind: 'notice', id: nextId('notice'), text: event.note, tone: 'info' }] };

    case 'turn-failed':
      return { ...state, entries: [...state.entries, { kind: 'notice', id: nextId('notice'), text: event.message, tone: 'failure' }] };

    case 'turn-finished':
      return { ...state, running: false, pending: null, progress: null };

    default:
      return state;
  }
}
```

- [ ] **Step 5: Implement the hook**

`apps/simulator/src/lib/useAgentTurn.ts`:
```ts
'use client';

import { useCallback, useRef, useState } from 'react';
import { createSseDecoder } from '../shared/events.js';
import { INITIAL_STATE, askedByUser, reduceTurn, type AgentState } from './transcript.js';

export interface AgentTurn {
  state: AgentState;
  ask(text: string): Promise<void>;
  answer(action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>): Promise<void>;
}

async function failureMessage(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.length > 0) return parsed.message;
  } catch {
    /* a non-JSON error body is still worth showing, trimmed */
  }
  return body.slice(0, 400) || `the server answered ${response.status} with no message`;
}

export function useAgentTurn(fetchImpl: typeof fetch = fetch): AgentTurn {
  const [state, setState] = useState<AgentState>(INITIAL_STATE);
  // Held in a ref as well as in state so `answer` can read the turn id without
  // being re-created on every event, which would restart the stream reader.
  const latest = useRef<AgentState>(INITIAL_STATE);
  const apply = useCallback((next: (previous: AgentState) => AgentState) => {
    setState(previous => {
      const value = next(previous);
      latest.current = value;
      return value;
    });
  }, []);

  const ask = useCallback(
    async (text: string) => {
      apply(previous => askedByUser(previous, text));
      let response: Response;
      try {
        response = await fetchImpl('/api/agent/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      } catch (error) {
        apply(previous => reduceTurn(reduceTurn(previous, { type: 'turn-failed', message: String(error) }), { type: 'turn-finished', turnId: '' }));
        return;
      }
      if (!response.ok || !response.body) {
        const message = await failureMessage(response);
        apply(previous => reduceTurn(reduceTurn(previous, { type: 'turn-failed', message }), { type: 'turn-finished', turnId: '' }));
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const decode = createSseDecoder();
      // Read and apply as events arrive. The stream stays open across every
      // question this turn asks, and each answer is sent from `answer()` on a
      // separate request while this loop is still reading.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of decode(decoder.decode(value, { stream: true }))) apply(previous => reduceTurn(previous, event));
      }
    },
    [apply, fetchImpl]
  );

  const answer = useCallback(
    async (action: 'accept' | 'decline' | 'cancel', content: Record<string, unknown> = {}) => {
      const current = latest.current;
      if (!current.pending || !current.turnId) return;
      const response = await fetchImpl('/api/agent/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turnId: current.turnId, elicitationId: current.pending.elicitationId, action, content })
      });
      if (response.ok) return;
      // 409 unknown-turn is the FL-039 shape arriving in a browser: the click
      // reached a server that is not running this turn. It is shown, in the
      // server's own words, rather than leaving a card that does nothing.
      const message = await failureMessage(response);
      apply(previous => reduceTurn(previous, { type: 'turn-failed', message }));
    },
    [apply, fetchImpl]
  );

  return { state, ask, answer };
}
```

- [ ] **Step 6: Implement the transcript and the composer**

`apps/simulator/src/components/Transcript.tsx`:
```tsx
'use client';

import type { AgentState, Entry } from '../lib/transcript.js';

function ToolRow({ entry }: { entry: Extract<Entry, { kind: 'tool' }> }) {
  return (
    <div className={`card tool ${entry.status}`} data-testid={`tool-${entry.id}`} data-status={entry.status}>
      <div className="row">
        <span className="name">{entry.tool}</span>
        <span className="pill">{entry.status === 'running' ? 'working' : entry.status === 'ok' ? `${entry.ms ?? 0} ms` : 'failed'}</span>
      </div>
      {entry.status === 'ok' && entry.spoken !== '' ? <p className="spoken">{entry.spoken}</p> : null}
      {entry.status === 'failed' ? <p className="warn">{entry.message}</p> : null}
    </div>
  );
}

export function Transcript({ state }: { state: AgentState }) {
  return (
    <div className="transcript" data-testid="transcript">
      {state.entries.map(entry => {
        if (entry.kind === 'user') return <p key={entry.id} className="said user">{entry.text}</p>;
        if (entry.kind === 'assistant') return <p key={entry.id} className="said assistant">{entry.text}</p>;
        if (entry.kind === 'tool') return <ToolRow key={entry.id} entry={entry} />;
        return (
          <p key={entry.id} className={entry.tone === 'failure' ? 'notice warn' : 'notice muted'} data-testid={`notice-${entry.id}`}>
            {entry.text}
          </p>
        );
      })}
    </div>
  );
}
```

`apps/simulator/src/components/Composer.tsx`:
```tsx
'use client';

import { useState, type FormEvent } from 'react';

export function Composer({ disabled, onAsk }: { disabled: boolean; onAsk: (text: string) => void }) {
  const [text, setText] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed === '' || disabled) return;
    setText('');
    onAsk(trimmed);
  };
  return (
    <form className="composer" onSubmit={submit}>
      <input
        type="text"
        value={text}
        onChange={event => setText(event.target.value)}
        placeholder="Ask about the house"
        aria-label="Ask about the house"
        disabled={disabled}
      />
      <button type="submit" disabled={disabled || text.trim() === ''}>
        Ask
      </button>
    </form>
  );
}
```

`apps/simulator/src/app/page.tsx` — replace the placeholder entirely:
```tsx
'use client';

import { useState } from 'react';
import { Composer } from '../components/Composer.js';
import { Frame, type Theme } from '../components/Frame.js';
import { Transcript } from '../components/Transcript.js';
import { useAgentTurn } from '../lib/useAgentTurn.js';

export default function Home() {
  const [theme, setTheme] = useState<Theme>('dark');
  const turn = useAgentTurn();
  return (
    <Frame theme={theme} onToggleTheme={() => setTheme(current => (current === 'dark' ? 'light' : 'dark'))}>
      <Transcript state={turn.state} />
      <Composer disabled={turn.state.running} onAsk={text => void turn.ask(text)} />
    </Frame>
  );
}
```

Append to `apps/simulator/src/app/globals.css`:
```css
.transcript {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.said {
  margin: 0;
  padding: 6px 10px;
  border-radius: 10px;
  max-width: 88%;
}

.said.user {
  align-self: flex-end;
  background: var(--nested);
}

.said.assistant {
  align-self: flex-start;
  font-size: 17px;
  line-height: 1.35;
}

.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 8px 10px;
}

.card.tool.failed {
  border-color: var(--warn);
}

.row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}

.name {
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.pill {
  background: var(--nested);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  color: var(--muted);
}

.spoken {
  margin: 6px 0 0;
}

.warn {
  color: var(--warn);
  margin: 6px 0 0;
}

.muted {
  color: var(--muted);
}

.notice {
  margin: 0;
  font-size: 12px;
}

.composer {
  flex: 0 0 auto;
  display: flex;
  gap: 8px;
}

.composer input {
  flex: 1;
  font: inherit;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--nested);
  color: var(--text);
}

.composer button {
  font: inherit;
  color: var(--card);
  background: var(--accent);
  border: 0;
  border-radius: 10px;
  padding: 8px 16px;
  cursor: pointer;
}

.composer button[disabled],
.composer input[disabled] {
  opacity: 0.5;
  cursor: default;
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm --filter @homeledger/simulator run test -- transcript`
Expected: PASS, fifteen tests across the two files — rising to seventeen once Step 8's mutations 7 and 9 add the two tests they call for. Those two are not optional: the mutation list names them as missing, and a mutation whose note says "add a test" and whose test never arrives is a gap recorded rather than closed.

- [ ] **Step 8: Mutation check**

1. In `reduceTurn`'s `assistant-text` case, always append a new entry — the delta-joining test must fail with two entries.
2. In the `tool-failed` case, copy `spoken: event.message` — the "never gives it spoken text" test must fail, and so must the Transcript failure test if you also render it as spoken.
3. In the `tool-failed` case, set `status: 'ok'` — both failure tests must fail.
4. In the `tool-succeeded` case, set `content: null` instead of `event.content` — the "keeps its content" test must fail. Then run Task 8's mutation 8 (`runOneCall` emitting `content: null`) again: it must fail this same test. That is what closes the loop from the result reader, through the event, to the entry the widget host reads — and it is the reason Task 8's note said to come back here.
5. In `upsertTool`, return `entries` unchanged when the id is not found — the ghost-call test must fail.
6. In the `elicitation-closed` case, clear `pending` unconditionally — the "ignores a close for a question it is not showing" test must fail.
7. In `useAgentTurn.ask`, collect every event and apply them after the loop ends — no existing test fails, because the fake stream closes immediately. **Add** a test whose fake stream emits an `elicitation-opened`, waits for `result.current.state.pending` to be set, and only then closes; confirm the mutation makes that new test hang or fail. This is the browser-side twin of the deadlock, and the suite must be able to see it. Count it in the totals below once it is written.
8. In `useAgentTurn.ask`, treat a non-200 as an empty successful turn — the 503 test must fail.
9. In `useAgentTurn.answer`, ignore a non-ok response — the 409 path has no test yet; add one that returns 409 with `{"message": UNKNOWN_TURN_MESSAGE}` and asserts a failure notice appears, then confirm the mutation fails it. Count it in the totals below once it is written.

- [ ] **Step 9: Commit**

```bash
git add apps/simulator/src/lib apps/simulator/src/components apps/simulator/src/app apps/simulator/test/transcript.test.ts apps/simulator/test/transcript.test.tsx
git commit -m "feat(simulator): transcript reducer, streaming hook, and the composer"
```

---

### Task 12: Elicitation as interface — the choice card, the confirm card, and the progress meter

**Files:**
- Create: `apps/simulator/src/components/ElicitationCard.tsx`, `apps/simulator/src/components/ProgressMeter.tsx`
- Modify: `apps/simulator/src/app/page.tsx`, `apps/simulator/src/app/globals.css`
- Test: `apps/simulator/test/elicitation-card.test.tsx`

**Interfaces:**
- Consumes: `type PendingQuestion`, `type Progress` from `@/lib/transcript`.
- Produces:
  ```ts
  export type AnswerHandler = (action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => void;
  export function ElicitationCard(props: { question: PendingQuestion; onAnswer: AnswerHandler }): JSX.Element;
  export function ProgressMeter(props: { progress: Progress }): JSX.Element;
  ```

**The design decision this task exists to make.** The server asks three questions inside one `tools/call`. The naive rendering is to print them into the transcript and let the person type an answer — which puts free text in front of an enum the server will reject, loses the display's whole reason to exist, and makes the three rounds look like three separate exchanges instead of one booking. So the questions never enter the transcript as text at all: an `elicitation-opened` event puts a card between the transcript and the composer, the composer is disabled while it is up, and the card's buttons are the only way to answer. The value sent is the enum value; the label shown is `enumNames`. That is "the agent surfaces the server's questions as interface" in one sentence.

**The five-option ceiling is enforced in the agent, not here, and that is deliberate.** `askThePerson` (Task 8) throws when the server offers more than five, so a card can never be handed six. Adding a truncation branch to this component would therefore be a branch nothing can reach — the FL-032 N6 shape, a decoration that makes a suite look thorough. The card renders exactly what it is given and the test asserts that; the ceiling's test lives where the ceiling does — Task 8, Step 1, "refuses a choice wider than the display shows", driven through a fake that can produce the six options no fixture can. That sentence was in the draft of this plan while the test it pointed at did not exist, which made this paragraph an argument for testing the ceiling nowhere.

**`ProgressMeter` is its own file.** It is in the Files list and in the plan's file-structure block, and the draft implemented it inside `ElicitationCard.tsx` — so every importer reached for it through a module named after something else, and the file the structure promised was never created. The two have nothing to do with each other beyond both sitting between the transcript and the composer: one is a question waiting for an answer, the other is a call reporting how far along it is, and they are shown at different moments for different reasons. One responsibility per file is what the structure block says, so that is what this builds.

- [ ] **Step 1: Write the failing test**

`apps/simulator/test/elicitation-card.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ElicitationCard } from '../src/components/ElicitationCard.js';
import { ProgressMeter } from '../src/components/ProgressMeter.js';
import type { PendingQuestion } from '../src/lib/transcript.js';

const choice: PendingQuestion = {
  elicitationId: 'e1',
  callId: 'c1',
  prompt: 'Who should I book for the water heater?',
  field: 'provider',
  kind: 'choice',
  options: [
    { value: 'prov_kettle_water', label: 'Kettle Creek Water Heaters' },
    { value: 'prov_anode_and_co', label: 'Anode and Company' },
    { value: 'prov_hotline_tank', label: 'Hotline Tank Service' }
  ]
};

const confirm: PendingQuestion = {
  elicitationId: 'e3',
  callId: 'c1',
  prompt: 'Book Kettle Creek Water Heaters for Tuesday, September 15, 1 to 3 PM?',
  field: 'confirm',
  kind: 'confirm',
  options: []
};

describe('ElicitationCard, choice', () => {
  it('shows the server’s question once, as the card’s own heading', () => {
    render(<ElicitationCard question={choice} onAnswer={() => {}} />);
    expect(screen.getAllByText(choice.prompt)).toHaveLength(1);
    expect(screen.getByTestId('elicitation').dataset.field).toBe('provider');
  });

  it('offers one button per option, labelled with the display name and never the id', () => {
    render(<ElicitationCard question={choice} onAnswer={() => {}} />);
    for (const option of choice.options) {
      expect(screen.getByRole('button', { name: option.label })).toBeDefined();
      expect(screen.queryByRole('button', { name: option.value })).toBeNull();
    }
    expect(document.body.textContent).not.toContain('prov_kettle_water');
  });

  it('answers with the enum value under the field the server named', () => {
    const onAnswer = vi.fn();
    render(<ElicitationCard question={choice} onAnswer={onAnswer} />);
    screen.getByRole('button', { name: 'Anode and Company' }).click();
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith('accept', { provider: 'prov_anode_and_co' });
  });

  it('offers a way out that is a decline, not a made-up answer', () => {
    const onAnswer = vi.fn();
    render(<ElicitationCard question={choice} onAnswer={onAnswer} />);
    screen.getByRole('button', { name: /not now/i }).click();
    expect(onAnswer).toHaveBeenCalledWith('decline');
  });

  it('renders exactly the options it is given, adding and removing nothing', () => {
    render(<ElicitationCard question={choice} onAnswer={() => {}} />);
    expect(screen.getAllByTestId(/^option-/)).toHaveLength(3);
  });
});

describe('ElicitationCard, confirm', () => {
  it('sends a boolean under the field, both ways', () => {
    const onAnswer = vi.fn();
    render(<ElicitationCard question={confirm} onAnswer={onAnswer} />);
    screen.getByRole('button', { name: /^yes/i }).click();
    expect(onAnswer).toHaveBeenLastCalledWith('accept', { confirm: true });
    // `/^no, don/i`, not `/^no/i`. In confirm mode the card renders three
    // buttons and two of them start with "No": "No, don't book it" and the
    // always-present "Not now". `getByRole` with the looser pattern matches
    // both and throws "Found multiple elements" before it can assert anything,
    // so the test failed rather than passing vacuously - but it still could
    // not reach its own "Expected: PASS".
    screen.getByRole('button', { name: /^no, don/i }).click();
    expect(onAnswer).toHaveBeenLastCalledWith('accept', { confirm: false });
  });

  it('keeps "No, don’t book it" and "Not now" distinguishable, because they mean different things', () => {
    // Saying no to this booking is an ANSWER - the server writes nothing and
    // the turn moves on. "Not now" is a decline of the question itself. They
    // travel as different payloads and a card that let one be clicked for the
    // other would make a refusal indistinguishable from a withdrawal.
    const onAnswer = vi.fn();
    render(<ElicitationCard question={confirm} onAnswer={onAnswer} />);
    const no = screen.getByRole('button', { name: "No, don’t book it" });
    const notNow = screen.getByRole('button', { name: /not now/i });
    expect(no).not.toBe(notNow);
    notNow.click();
    expect(onAnswer).toHaveBeenLastCalledWith('decline');
  });

  it('shows no option list at all', () => {
    render(<ElicitationCard question={confirm} onAnswer={() => {}} />);
    expect(screen.queryAllByTestId(/^option-/)).toHaveLength(0);
  });
});

describe('ProgressMeter', () => {
  it('reports the step, the total and the message to assistive technology', () => {
    render(<ProgressMeter progress={{ callId: 'c1', progress: 2, total: 3, message: 'Comparing arrival windows' }} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    expect(bar.getAttribute('aria-valuemax')).toBe('3');
    expect(screen.getByText('Comparing arrival windows')).toBeDefined();
  });

  it('renders the first and the last step of the documented run', () => {
    const { rerender } = render(<ProgressMeter progress={{ callId: 'c1', progress: 0, total: 3, message: 'Checking for openings' }} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    rerender(<ProgressMeter progress={{ callId: 'c1', progress: 3, total: 3, message: 'Found three windows' }} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @homeledger/simulator run test -- elicitation-card`
Expected: FAIL, cannot find module `../src/components/ElicitationCard.js`.

- [ ] **Step 3: Implement**

`apps/simulator/src/components/ElicitationCard.tsx`:
```tsx
'use client';

import type { PendingQuestion } from '../lib/transcript.js';

export type AnswerHandler = (action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => void;

/**
 * The server's question, rendered as controls instead of as text.
 *
 * The prompt string is the server's own `message` and appears here and nowhere
 * else: it never enters the transcript, because a question that scrolls away
 * with the conversation is a question somebody will answer into the wrong box.
 * Buttons carry the display names from `enumNames`; the value posted back is
 * the enum value the server will actually accept, so there is no path by which
 * a person answers something that gets rejected.
 */
export function ElicitationCard({ question, onAnswer }: { question: PendingQuestion; onAnswer: AnswerHandler }) {
  return (
    <section className="card elicitation" data-testid="elicitation" data-field={question.field} aria-live="polite">
      <p className="prompt">{question.prompt}</p>
      {question.kind === 'confirm' ? (
        <div className="choices">
          <button type="button" onClick={() => onAnswer('accept', { [question.field]: true })}>
            Yes, book it
          </button>
          <button type="button" className="secondary" onClick={() => onAnswer('accept', { [question.field]: false })}>
            No, don’t book it
          </button>
        </div>
      ) : (
        <div className="choices">
          {question.options.map(option => (
            <button key={option.value} type="button" data-testid={`option-${option.value}`} onClick={() => onAnswer('accept', { [question.field]: option.value })}>
              {option.label}
            </button>
          ))}
        </div>
      )}
      {/* A decline, not a fabricated answer. The server turns it into "Okay, I
          haven't booked anything" and writes nothing, which is the truthful
          outcome of somebody walking away from the question. */}
      <button type="button" className="link" onClick={() => onAnswer('decline')}>
        Not now
      </button>
    </section>
  );
}
```

`apps/simulator/src/components/ProgressMeter.tsx`:
```tsx
'use client';

import type { Progress } from '../lib/transcript.js';

/**
 * How far along a call that reports its own progress has got.
 *
 * Its own file rather than a second export of the elicitation card: it is
 * shown while the server is WORKING, and the card is shown while the server is
 * WAITING, so the two are never on screen for the same reason and one can
 * change without the other. `book_service`'s availability check reports 0 of 3
 * through 3 of 3 (`apps/mcp-server/src/progress.ts`); the numbers come from
 * the notification, never from a timer, because a bar that moves on a timer is
 * a bar that lies when the server is slow.
 */
export function ProgressMeter({ progress }: { progress: Progress }) {
  return (
    <div className="card progress" data-testid="progress">
      <div role="progressbar" aria-valuenow={progress.progress} aria-valuemin={0} aria-valuemax={progress.total} aria-label="Checking availability">
        <span className="bar" style={{ width: `${progress.total === 0 ? 0 : (progress.progress / progress.total) * 100}%` }} />
      </div>
      <p className="muted">{progress.message}</p>
    </div>
  );
}
```

- [ ] **Step 4: Wire both into the page**

Replace the body of `apps/simulator/src/app/page.tsx`'s `Frame` children:
```tsx
    <Frame theme={theme} onToggleTheme={() => setTheme(current => (current === 'dark' ? 'light' : 'dark'))}>
      <Transcript state={turn.state} />
      {turn.state.progress ? <ProgressMeter progress={turn.state.progress} /> : null}
      {turn.state.pending ? <ElicitationCard question={turn.state.pending} onAnswer={(action, content) => void turn.answer(action, content)} /> : null}
      <Composer disabled={turn.state.running || turn.state.pending !== null} onAsk={text => void turn.ask(text)} />
    </Frame>
```
and add the imports:
```tsx
import { ElicitationCard } from '../components/ElicitationCard.js';
import { ProgressMeter } from '../components/ProgressMeter.js';
```

The composer is disabled while a question is up. That is not a nicety: typing into it would start a **second** turn while the first is parked inside `book_service`, and the second turn's elicitations would arrive on a stream nobody is reading.

Append to `apps/simulator/src/app/globals.css`:
```css
.elicitation {
  flex: 0 0 auto;
  border-color: var(--accent);
}

.prompt {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 600;
}

.choices {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.choices button {
  font: inherit;
  font-size: 13px;
  color: var(--card);
  background: var(--accent);
  border: 0;
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
}

.choices button.secondary {
  background: var(--nested);
  color: var(--text);
}

button.link {
  margin-top: 8px;
  font: inherit;
  font-size: 12px;
  color: var(--muted);
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  text-decoration: underline;
}

.progress [role='progressbar'] {
  height: 6px;
  border-radius: 999px;
  background: var(--nested);
  overflow: hidden;
}

.progress .bar {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 120ms linear;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @homeledger/simulator run test -- elicitation-card`
Expected: PASS, ten tests.

- [ ] **Step 6: Mutation check**

1. Label the buttons with `option.value` instead of `option.label` — the label test must fail on both assertions.
2. Send `{ [question.field]: option.label }` — the "answers with the enum value" test must fail.
3. Hard-code the field name as `'provider'` — the confirm test must fail (it sends `confirm`).
4. Send `{ [question.field]: true }` from **both** confirm buttons — the "both ways" test must fail on its second assertion. Without this one, a card that could only say yes would pass every other test in the file, because the matcher that was supposed to click "no" used to throw before it asserted anything.
5. Make "Not now" send `('accept', {})` — the decline test must fail, and so must the "distinguishable" test. This is the one that matters: a decline the server reads as an accept with no content is a booking attempt nobody made.
6. Rename "Not now" to "No thanks" — the "distinguishable" test must fail, because `/^no, don/i` and `/not now/i` now resolve to the wrong pair. Revert; the point is that the two labels are load-bearing and cannot be reworded without reading this test.
7. Render `question.prompt` in the transcript as well (add it to `Transcript`) — the "once" test must fail with two matches.
8. In `ProgressMeter`, swap `aria-valuenow` and `aria-valuemax` — both meter tests must fail.

- [ ] **Step 7: Commit**

```bash
git add apps/simulator/src/components/ElicitationCard.tsx apps/simulator/src/components/ProgressMeter.tsx apps/simulator/src/app apps/simulator/test/elicitation-card.test.tsx
git commit -m "feat(simulator): render the server's questions as cards rather than as chat text"
```

---

### Task 13: Honest failure surfaces and the debug drawer

**Files:**
- Create: `apps/simulator/src/lib/failures.ts`, `apps/simulator/src/components/FailureCard.tsx`, `apps/simulator/src/components/DebugDrawer.tsx`, `apps/simulator/src/app/api/debug/route.ts`
- Modify: `apps/simulator/src/components/Transcript.tsx`, `apps/simulator/src/server/http.ts`, `apps/simulator/src/app/page.tsx`, `apps/simulator/src/app/globals.css`, `apps/simulator/test/routes.test.ts`
- Test: `apps/simulator/test/failures.test.ts`, `apps/simulator/test/failures.test.tsx`

**Interfaces:**
- Consumes: `type Conversation` from `@/server/session`; `type Entry` from `@/lib/transcript`.
- Produces:
  ```ts
  // src/lib/failures.ts
  export interface Explanation { title: string; detail: string }
  export const NOTHING_RETRIEVED: string;
  export function explainFailure(tool: string, message: string): Explanation;

  // src/components/FailureCard.tsx
  export function FailureCard(props: { tool: string; message: string }): JSX.Element;

  // src/server/http.ts
  export function handleDebug(conversation: Conversation): Response;

  // src/components/DebugDrawer.tsx
  export interface DebugSnapshot {
    endpointHost: string;
    endpointPath: string;
    addressing: 'url' | 'arn' | 'name';
    protocolVersion: string | null;
    sessionId: string | null;
    rebuilds: number;
    tools: string[];
    log: Array<{ at: number; direction: 'out' | 'in'; method: string; id: string | number | null; ms: number | null; status: number | null }>;
  }
  export function DebugDrawer(props: { snapshot: DebugSnapshot | null; state: AgentState }): JSX.Element;
  ```

**What spec §7 asks the drawer for, and what the draft of this plan left out.** The line is "*Debug drawer: live JSON-RPC log, protocol version, session ID, timing per call*", and the draft shipped the last two while its own Self-review table claimed all four as covered. Both missing halves now have an honest source, neither of them invented here: `protocolVersion` is read off the transport that negotiated it, and the log is the tap Task 6 puts in the `fetch` wrapper — which is also the "transport wrapper taps notifications for the debug drawer" bullet the same spec section asks for and the same Self-review over-claimed. The log carries **methods and timings, never payloads**; Task 6's `record` says why at length, and the short version is that the bodies hold the household's own data and every progress notification carries a `progressToken`, which this endpoint's own credential guard forbids.

**`FailureCard` is its own file**, for the same reason `ProgressMeter` is: it is named in the Files list and in the plan's file-structure block, and the draft inlined it into `Transcript.tsx` as an IIFE inside a ternary. A failed call is the surface this project has rewritten twice and will rewrite again; it should be a component with a name, not an expression.

- [ ] **Step 1: Write the failing tests**

`apps/simulator/test/failures.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { NOTHING_RETRIEVED, explainFailure } from '../src/lib/failures.js';

describe('explainFailure', () => {
  it('explains the account-wide model block when ask_manual cannot retrieve', () => {
    const explained = explainFailure('ask_manual', 'Invalid input or configuration provided. Error 002: Access to Bedrock models is not allowed for this account');
    expect(explained.title).toBe('The manuals could not be searched');
    expect(explained.detail).toContain('model access is blocked on this AWS account');
    expect(explained.detail).toContain('Nothing was retrieved');
  });

  it('ends every explanation, on every branch, with the sentence that forbids reading it as an empty result', () => {
    // The property, not a sample of it. A branch that dropped this sentence
    // would be a failure a reader could round off into "there is nothing
    // there", which is precisely what happened twice (FL-039) - and the
    // per-branch assertions below each cover one branch, so only this one
    // fails when a FOURTH branch is added without it.
    const cases: Array<[string, string]> = [
      ['ask_manual', 'Access to Bedrock models is not allowed for this account'],
      ['get_visit', 'HTTP 404: Session not found'],
      ['log_maintenance', 'Tool log_maintenance not found'],
      ['list_appliances', ''],
      ['', 'something nobody predicted']
    ];
    for (const [tool, message] of cases) expect(explainFailure(tool, message).detail, `${tool}/${message}`).toContain(NOTHING_RETRIEVED);
  });

  it('never describes a blocked retrieval as an empty one', () => {
    const explained = explainFailure('ask_manual', 'Access to Bedrock models is not allowed for this account');
    // The positive half first, and it is the half that carries the weight: a
    // rewording that loses the cause fails here whatever words it chose. The
    // denylist below is a second net for four phrasings that have actually
    // been written in this repository, not the assertion itself - a denylist
    // alone would pass "the manual had nothing on that", which is the same
    // lie in words nobody listed.
    expect(explained.detail).toContain('model access is blocked on this AWS account');
    expect(explained.detail).toContain(NOTHING_RETRIEVED);
    for (const phrase of ['no results', 'nothing found', 'no passages were found', 'not in the manual']) {
      expect(explained.detail.toLowerCase(), phrase).not.toContain(phrase);
    }
  });

  it('explains a lost session as a connection that expired, for any tool', () => {
    const explained = explainFailure('get_visit', 'HTTP 404: Session not found');
    expect(explained.title).toBe('The connection to the household server expired');
    expect(explained.detail).toContain('retried once');
    expect(explained.detail).toContain('Nothing was retrieved');
  });

  it('passes an unrecognised failure through verbatim rather than dressing it up', () => {
    const explained = explainFailure('log_maintenance', 'Tool log_maintenance not found');
    expect(explained.title).toBe('log_maintenance failed');
    expect(explained.detail).toContain('Tool log_maintenance not found');
    expect(explained.detail).toContain('Nothing was retrieved');
  });

  it('does not claim a Bedrock block for a tool that does not use one', () => {
    // The block explanation is keyed on the message, not only on the tool, so
    // an unrelated ask_manual failure is not mislabelled.
    expect(explainFailure('ask_manual', 'Tool ask_manual not found').title).toBe('ask_manual failed');
  });
});
```

`apps/simulator/test/failures.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DebugDrawer } from '../src/components/DebugDrawer.js';
import { Transcript } from '../src/components/Transcript.js';
import { NOTHING_RETRIEVED } from '../src/lib/failures.js';
import { INITIAL_STATE, reduceTurn } from '../src/lib/transcript.js';

const blocked = [
  { type: 'tool-started', callId: 'c1', tool: 'ask_manual', args: { question: 'what does F21 mean' } },
  { type: 'tool-failed', callId: 'c1', tool: 'ask_manual', message: 'Error 002: Access to Bedrock models is not allowed for this account', ms: 1130 }
].reduce(reduceTurn, INITIAL_STATE);

const declined = [
  { type: 'tool-started', callId: 'c9', tool: 'book_service', args: { applianceId: 'appl_x', issue: 'leak' } },
  {
    type: 'tool-succeeded',
    callId: 'c9',
    tool: 'book_service',
    spoken: "Okay, I haven't booked anything.",
    content: [{ type: 'text', text: "Okay, I haven't booked anything." }],
    structured: { booked: false },
    widgetUri: 'ui://homeledger/visit',
    ms: 220
  }
].reduce(reduceTurn, INITIAL_STATE);

describe('Transcript failures', () => {
  it('explains a blocked manual search instead of showing the AWS sentence alone', () => {
    render(<Transcript state={blocked} />);
    const card = screen.getByTestId('tool-c1');
    expect(card.dataset.status).toBe('failed');
    expect(card.textContent).toContain('The manuals could not be searched');
    expect(card.textContent).toContain('model access is blocked on this AWS account');
  });

  it('still shows the server’s own words, so the cause is not lost in the explanation', () => {
    render(<Transcript state={blocked} />);
    expect(screen.getByTestId('tool-c1').textContent).toContain('Error 002');
  });

  it('shows a decline as a call that worked, and never runs it through the failure explanation', () => {
    // The other half of Task 5, Step 1, rendered. With `isError` on the
    // server's decline this row read `data-status="failed"` and
    // `explainFailure` produced "book_service failed - Nothing was retrieved,
    // so this is not an answer and not an empty one either", which is untrue
    // about somebody who chose not to book.
    render(<Transcript state={declined} />);
    const card = screen.getByTestId('tool-c9');
    expect(card.dataset.status).toBe('ok');
    expect(card.textContent).toContain("Okay, I haven't booked anything.");
    expect(card.textContent).not.toContain('failed');
    expect(card.textContent).not.toContain(NOTHING_RETRIEVED);
  });
});

describe('DebugDrawer', () => {
  const snapshot = {
    endpointHost: 'bedrock-agentcore.us-east-1.amazonaws.com',
    endpointPath: '/runtimes/arn%3Aaws%3A.../invocations',
    addressing: 'name' as const,
    protocolVersion: '2025-11-25',
    sessionId: '259104a7-f052-4c35-958e-15b2057dfddf',
    rebuilds: 1,
    tools: ['list_appliances', 'book_service'],
    log: [
      { at: 1758400000000, direction: 'out' as const, method: 'initialize', id: 0, ms: 214, status: 200 },
      { at: 1758400001000, direction: 'out' as const, method: 'tools/call', id: 3, ms: 1840, status: 200 },
      { at: 1758400001500, direction: 'in' as const, method: 'elicitation/create', id: null, ms: null, status: null }
    ]
  };

  it('shows the endpoint, how it was addressed, the protocol version, the session and the rebuild count', () => {
    render(<DebugDrawer snapshot={snapshot} state={INITIAL_STATE} />);
    const drawer = screen.getByTestId('debug');
    expect(drawer.textContent).toContain('bedrock-agentcore.us-east-1.amazonaws.com');
    expect(drawer.textContent).toContain('resolved by name');
    // Spec section 7 asks for this by name, and it is the negotiated one
    // rather than a constant: a drawer that showed what this client asked for
    // would say the same thing whatever the server answered.
    expect(drawer.textContent).toContain('protocol 2025-11-25');
    expect(drawer.textContent).toContain('259104a7-f052-4c35-958e-15b2057dfddf');
    expect(drawer.textContent).toContain('1 session rebuild');
  });

  it('shows the JSON-RPC log with direction, method and outcome, newest last', () => {
    render(<DebugDrawer snapshot={snapshot} state={INITIAL_STATE} />);
    const lines = screen.getAllByTestId(/^rpc-/).map(node => node.textContent ?? '');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('→ initialize');
    expect(lines[0]).toContain('200');
    expect(lines[0]).toContain('214 ms');
    // A server-initiated request, which never passes through the outbound tap
    // and is the whole reason the drawer needs a transport wrapper rather than
    // a list of calls this side made: it is what fills the two-minute gap in
    // the middle of a booking.
    expect(lines[2]).toContain('← elicitation/create');
  });

  it('says the log is empty rather than rendering an empty list with no explanation', () => {
    render(<DebugDrawer snapshot={{ ...snapshot, log: [] }} state={INITIAL_STATE} />);
    expect(screen.queryAllByTestId(/^rpc-/)).toHaveLength(0);
    expect(screen.getByTestId('debug').textContent).toContain('no traffic yet');
  });

  it('says the protocol was not negotiated rather than inventing a version', () => {
    render(<DebugDrawer snapshot={{ ...snapshot, protocolVersion: null }} state={INITIAL_STATE} />);
    expect(screen.getByTestId('debug').textContent).toContain('protocol not negotiated');
  });

  it('times every call that has finished, and says so for the ones that have not', () => {
    const state = [
      { type: 'tool-started', callId: 'c1', tool: 'maintenance_due', args: {} },
      { type: 'tool-succeeded', callId: 'c1', tool: 'maintenance_due', spoken: 'Two.', content: null, structured: {}, widgetUri: null, ms: 937 },
      { type: 'tool-started', callId: 'c2', tool: 'book_service', args: {} }
    ].reduce(reduceTurn, INITIAL_STATE);
    render(<DebugDrawer snapshot={snapshot} state={state} />);
    expect(screen.getByTestId('debug').textContent).toContain('maintenance_due 937 ms');
    expect(screen.getByTestId('debug').textContent).toContain('book_service running');
  });

  it('says the endpoint is unknown rather than rendering nothing when there is no snapshot', () => {
    render(<DebugDrawer snapshot={null} state={INITIAL_STATE} />);
    expect(screen.getByTestId('debug').textContent).toContain('not connected');
  });
});
```

Add to `apps/simulator/test/routes.test.ts`:
```ts
describe('GET /api/debug', () => {
  it('describes the connection without carrying a credential', async () => {
    const convo = await conversation(scriptedModel([]));
    const body = (await (await import('../src/server/http.js')).handleDebug(convo).json()) as Record<string, unknown>;
    expect(body.addressing).toBe('url');
    expect(typeof body.sessionId).toBe('string');
    expect(body.rebuilds).toBe(0);
    expect(Array.isArray(body.tools)).toBe(true);
    const serialised = JSON.stringify(body).toLowerCase();
    for (const forbidden of ['bearer', 'authorization', 'secret', 'anthropic', 'password', 'token']) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });

  it('carries the two spec section 7 fields the drawer cannot get anywhere else', async () => {
    const convo = await conversation(scriptedModel([]));
    await convo.mcp.callTool('list_appliances', {});
    const body = (await (await import('../src/server/http.js')).handleDebug(convo).json()) as { protocolVersion: unknown; log: Array<{ method: string }> };
    expect(body.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.log.map(entry => entry.method)).toContain('tools/call');
    // `token` is on the forbidden list above and `progressToken` is on every
    // progress notification this server sends, so the log has to be methods
    // and timings rather than payloads. This asserts that the credential test
    // above is passing because the log holds no bodies, not because this
    // particular call happened to send nothing interesting.
    expect(JSON.stringify(body.log)).not.toContain('appliances');
  });

});
```

There is deliberately **no** test that `handleDebug` reports a healed address rather than the startup one. It would have to compute the expected value the same way the code does — `new URL(convo.mcp.endpointUrl).pathname` on both sides — which is the self-referential shape FL-028 names, and it would pass whatever `handleDebug` read. The guarantee comes from the type instead: `Conversation.endpoint` no longer carries a `url` at all, so there is no stale copy available to read. A type that makes the mistake unrepresentable is worth more here than an assertion that cannot fail.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @homeledger/simulator run test -- failures`
Expected: FAIL, cannot find module `../src/lib/failures.js`.

- [ ] **Step 3: Implement the explanations**

`apps/simulator/src/lib/failures.ts`:
```ts
export interface Explanation {
  title: string;
  detail: string;
}

/**
 * Every explanation ends with this, and none of them is allowed to imply an answer.
 *
 * The rule in one line: a failed call is not an empty result. The failure this
 * repository has actually produced twice was not a wrong error message, it was
 * a correct error message that a reader — a model, once, and a person the next
 * time — rounded off into "there is nothing there" (FL-039).
 *
 * Exported so the test can assert the property across every branch rather than
 * spot-checking three of them with three copies of the sentence, and so a
 * fourth branch added later cannot quietly omit it.
 */
export const NOTHING_RETRIEVED = 'Nothing was retrieved, so this is not an answer and not an empty one either.';

const BEDROCK_BLOCK = /access to bedrock models is not allowed for this account/i;
const LOST_SESSION = /session not found/i;

/**
 * Turns the server's own sentence into something a person can act on, without losing it.
 *
 * The server's message is always carried through as well as explained. An
 * explanation that replaced it would be this application asserting a cause it
 * inferred — which is the move that produced FL-039's first, wrong diagnosis.
 */
export function explainFailure(tool: string, message: string): Explanation {
  if (BEDROCK_BLOCK.test(message))
    return {
      title: 'The manuals could not be searched',
      detail: `The question was fine; model access is blocked on this AWS account, and searching a manual needs a model to turn the question into a vector before it can look anything up. ${NOTHING_RETRIEVED} The server said: ${message}`
    };
  if (LOST_SESSION.test(message))
    return {
      title: 'The connection to the household server expired',
      detail: `The server instance holding this conversation was recycled. The connection was rebuilt and the call retried once, and it failed again. ${NOTHING_RETRIEVED} The server said: ${message}`
    };
  return { title: `${tool} failed`, detail: `${NOTHING_RETRIEVED} The server said: ${message}` };
}
```

Note the first branch's title says "manuals" without checking the tool name, because the Bedrock block is the only thing that produces that sentence and `ask_manual` is the only tool that can hit it. If a second tool ever calls a model, revisit this rather than adding a tool check that no test can distinguish.

- [ ] **Step 4: Give the failure a component, and use it in the transcript**

`apps/simulator/src/components/FailureCard.tsx`:
```tsx
'use client';

import { explainFailure } from '../lib/failures.js';

/**
 * One failed call, explained and quoted.
 *
 * Two paragraphs, always both. The title and the explanation are this
 * application's reading of what went wrong; the server's own sentence follows
 * it, inside `explainFailure`'s detail, because an explanation that replaced
 * the message would be this surface asserting a cause it inferred — which is
 * the move that produced FL-039's first, wrong diagnosis. A component rather
 * than an expression inside `ToolRow` because this is the surface the project
 * has already rewritten twice, and the next person to change it should be able
 * to find it by its name.
 */
export function FailureCard({ tool, message }: { tool: string; message: string }) {
  const explained = explainFailure(tool, message);
  return (
    <>
      <p className="warn">{explained.title}</p>
      <p className="muted">{explained.detail}</p>
    </>
  );
}
```

In `apps/simulator/src/components/Transcript.tsx`, add the import:
```tsx
import { FailureCard } from './FailureCard.js';
```
and replace the failed branch of `ToolRow`:
```tsx
      {entry.status === 'failed' ? <FailureCard tool={entry.tool} message={entry.message} /> : null}
```

- [ ] **Step 5: Implement the debug endpoint and drawer**

Append to `apps/simulator/src/server/http.ts`:
```ts
/**
 * What the drawer shows. Built by hand rather than by serialising the
 * conversation, because the conversation holds a token source and an API key
 * and a spread would put both on the wire the first time somebody adds a field.
 *
 * Four things, and spec section 7 names all four: the JSON-RPC log, the
 * negotiated protocol version, the session id, and the timing per call (that
 * last one is on the client, from the transcript's own entries). The address
 * is read from `mcp.endpointUrl` and not from `conversation.endpoint`, because
 * the client heals the address on a rebuild and a drawer that showed the
 * startup URL would be confidently wrong about the one thing somebody opens it
 * to check.
 */
export function handleDebug(conversation: Conversation): Response {
  const url = new URL(conversation.mcp.endpointUrl);
  return new Response(
    JSON.stringify({
      endpointHost: url.host,
      endpointPath: url.pathname,
      addressing: conversation.endpoint.origin,
      protocolVersion: conversation.mcp.protocolVersion ?? null,
      sessionId: conversation.mcp.sessionId ?? null,
      rebuilds: conversation.mcp.rebuilds,
      tools: conversation.tools.map(tool => tool.name),
      // Methods and timings. `HomeLedgerMcp.record` keeps payloads out at the
      // source; this endpoint spreads the entries it is given and adds
      // nothing, so there is one place to read to know what can appear here.
      log: conversation.mcp.jsonRpcLog.map(entry => ({ ...entry }))
    }),
    { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }
  );
}
```

`apps/simulator/src/app/api/debug/route.ts`:
```ts
import { handleDebug } from '@/server/http';
import { getConversation } from '@/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    return handleDebug(await getConversation());
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, reason: 'unavailable', message: error instanceof Error ? error.message : String(error) }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
}
```

`apps/simulator/src/components/DebugDrawer.tsx`:
```tsx
'use client';

import type { AgentState } from '../lib/transcript.js';

export interface JsonRpcLine {
  at: number;
  direction: 'out' | 'in';
  method: string;
  id: string | number | null;
  ms: number | null;
  status: number | null;
}

export interface DebugSnapshot {
  endpointHost: string;
  endpointPath: string;
  addressing: 'url' | 'arn' | 'name';
  /** What the two ends negotiated, or null if they have not. Never a constant of this application's. */
  protocolVersion: string | null;
  sessionId: string | null;
  rebuilds: number;
  tools: string[];
  /** Methods and timings, oldest first. No payloads ever reach this — see `HomeLedgerMcp.record`. */
  log: JsonRpcLine[];
}

const ADDRESSING: Record<DebugSnapshot['addressing'], string> = {
  url: 'pinned by URL',
  arn: 'pinned by ARN',
  name: 'resolved by name'
};

export function DebugDrawer({ snapshot, state }: { snapshot: DebugSnapshot | null; state: AgentState }) {
  const calls = state.entries.filter((entry): entry is Extract<AgentState['entries'][number], { kind: 'tool' }> => entry.kind === 'tool');
  return (
    <details className="debug" data-testid="debug">
      <summary>Connection</summary>
      {snapshot === null ? (
        <p className="muted">not connected</p>
      ) : (
        <ul className="muted">
          <li>
            {snapshot.endpointHost}
            {snapshot.endpointPath}
          </li>
          <li>{ADDRESSING[snapshot.addressing]}</li>
          {/* Spec section 7 asks for the protocol version by name. Shown as
              what it is — negotiated or not — rather than defaulted, because a
              default here would read as a successful handshake. */}
          <li>{snapshot.protocolVersion === null ? 'protocol not negotiated' : `protocol ${snapshot.protocolVersion}`}</li>
          <li>session {snapshot.sessionId ?? 'none'}</li>
          <li>
            {snapshot.rebuilds} session rebuild{snapshot.rebuilds === 1 ? '' : 's'}
          </li>
          <li>{snapshot.tools.length} tools</li>
        </ul>
      )}
      <ul className="muted">
        {calls.map(call => (
          <li key={call.id}>{call.ms === null ? `${call.tool} running` : `${call.tool} ${call.ms} ms`}</li>
        ))}
      </ul>
      {/* The JSON-RPC log. `←` lines are server-initiated — an elicitation, a
          progress notification — and they are the ones that explain a
          `tools/call` that has been open for two minutes. */}
      <ul className="muted rpc">
        {snapshot === null || snapshot.log.length === 0 ? (
          <li>no traffic yet</li>
        ) : (
          snapshot.log.map((line, index) => (
            <li key={`${line.at}-${index}`} data-testid={`rpc-${index}`}>
              {line.direction === 'out' ? '→' : '←'} {line.method}
              {line.status === null ? '' : ` ${line.status}`}
              {line.ms === null ? '' : ` ${line.ms} ms`}
            </li>
          ))
        )}
      </ul>
    </details>
  );
}
```

Wire it into `apps/simulator/src/app/page.tsx` — add the imports and the fetch:
```tsx
import { useEffect, useState } from 'react';
import { DebugDrawer, type DebugSnapshot } from '../components/DebugDrawer.js';
```
inside `Home`, before the return:
```tsx
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);
  // Re-read after every turn, so a session rebuilt mid-conversation shows up
  // in the count rather than only in the transcript.
  useEffect(() => {
    if (turn.state.running) return;
    let cancelled = false;
    void fetch('/api/debug')
      .then(response => (response.ok ? (response.json() as Promise<DebugSnapshot>) : null))
      .then(value => {
        if (!cancelled) setSnapshot(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [turn.state.running]);
```
and render it after the composer:
```tsx
      <DebugDrawer snapshot={snapshot} state={turn.state} />
```

Append to `apps/simulator/src/app/globals.css`:
```css
.debug {
  flex: 0 0 auto;
  font-size: 11px;
}

.debug summary {
  cursor: pointer;
  color: var(--muted);
}

.debug ul {
  margin: 4px 0 0;
  padding-left: 16px;
}

.debug ul.rpc {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  max-height: 90px;
  overflow-y: auto;
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm --filter @homeledger/simulator run test`
Expected: PASS across every file, including the new `/api/debug` case in `routes.test.ts`.

- [ ] **Step 7: Mutation check**

1. In `explainFailure`, drop the `NOTHING_RETRIEVED` suffix from any one branch — that branch's per-case test **and** the "ends every explanation, on every branch" test must both fail. Do all three branches; two failures each time is the evidence that the property test is not merely restating the three specific ones.
2. In `explainFailure`, change the Bedrock branch's detail to "no passages were found in the manual" — the "never describes a blocked retrieval as an empty one" test must fail, on the positive assertion (the cause is gone) as well as on the denylist. This is the assertion that stands between a blocked account and a sentence that sounds like an answer.
3. In `explainFailure`, change the Bedrock branch's detail to "the manual had nothing on that" — a lie the denylist does **not** name. The positive assertion must still fail, on `model access is blocked on this AWS account`. If it does not, the test is a denylist wearing a property's clothes and needs fixing before going on.
4. In `explainFailure`, key the Bedrock branch on `tool === 'ask_manual'` instead of on the message — the "does not claim a Bedrock block" test must fail.
5. In `explainFailure`, stop appending the server's own message — the "still shows the server's own words" component test must fail.
6. In `handleDebug`, replace the hand-built object with `JSON.stringify(conversation)` — the credential test must fail, naming several forbidden substrings. (It may also throw on a circular structure; either way it fails, and that is the point of building the object by hand.)
7. In `handleDebug`, send `protocolVersion: '2025-11-25'` as a literal instead of `conversation.mcp.protocolVersion` — nothing in this file fails, because the local server negotiates that version. That is the honest result and it is why the assertion lives in Task 6 (`exposes the negotiated protocol version, not a version of its own`, where `protocolVersion` is asserted to be undefined *before* `connect()`). Revert, and record that the drawer's own suite cannot tell a negotiated version from a hard-coded one.
8. In `handleDebug`, include the raw request bodies in `log` — the "carries the two spec section 7 fields" test must fail on `not.toContain('appliances')`, and the credential test must fail on `token` as soon as a `book_service` call is in the log. Revert. Running it is how you see that the two guards are load-bearing rather than decorative.
9. In `DebugDrawer`, render `call.ms` unconditionally — the running-call test must fail.
10. In `DebugDrawer`, render `→` for every log line regardless of direction — the log test must fail on the `elicitation/create` line. A drawer that cannot show which side spoke cannot explain a stalled turn, which is the one thing spec section 7 asks a live log for.
11. In `Transcript`'s `ToolRow`, render `<FailureCard …>` for an `ok` entry as well — the decline test must fail, on `not.toContain('failed')`. This is Task 5, Step 1's rendering assertion: it is the difference between "Okay, I haven't booked anything." and "book_service failed".

- [ ] **Step 8: Commit**

```bash
git add apps/simulator/src/lib/failures.ts apps/simulator/src/components apps/simulator/src/server/http.ts apps/simulator/src/app apps/simulator/test
git commit -m "feat(simulator): explain failures honestly and surface the connection in a drawer"
```

The commit body records what the drawer now covers of spec §7 — the JSON-RPC log and the protocol version alongside the session id and the per-call timings — and the one thing it deliberately does not: request and response bodies, kept out because they carry the household's own data and the word `token`, which this endpoint's credential guard forbids.

---

### Task 14: The MCP Apps widget host

**Files:**
- Create: `apps/simulator/src/lib/widget-host.ts`, `apps/simulator/src/components/WidgetFrame.tsx`, `apps/simulator/src/app/api/widget/route.ts`, `apps/simulator/src/app/api/widget/tool/route.ts`
- Modify: `apps/simulator/src/server/http.ts`, `apps/simulator/src/components/Transcript.tsx`, `apps/simulator/src/app/page.tsx`, `apps/simulator/src/app/globals.css`, `apps/simulator/test/transcript.test.tsx`, `apps/simulator/test/failures.test.tsx`, `FRICTION-LOG.md`
- Test: `apps/simulator/test/widget-host.test.tsx`, and two cases appended to `apps/simulator/test/routes.test.ts`

**Interfaces:**
- Consumes: the view-side protocol in `apps/mcp-server/src/widgets/shell.ts`, which is the exact contract this host must satisfy — `ui/initialize` (request; the result carries `hostContext`), then `ui/notifications/initialized`, then host-to-view `ui/notifications/tool-result`, `ui/notifications/tool-input`, `ui/notifications/tool-cancelled` and `ui/notifications/host-context-changed`; view-to-host `tools/call` as a plain MCP request and `ui/notifications/size-changed`.
- Produces:
  ```ts
  // src/lib/widget-host.ts
  export const WIDGET_PROTOCOL_VERSION = '2026-01-26';
  export interface HostContext { theme: 'dark' | 'light'; displayMode: 'inline'; maxWidth: number; maxHeight: number; locale: string; timeZone: string; userAgent: string; platform: 'web'; deviceCapabilities: { touch: boolean; hover: boolean } }
  export function hostContextFor(theme: 'dark' | 'light'): HostContext;
  export interface WidgetHostOptions { frameWindow: Window; hostContext: () => HostContext; toolResult: () => { content: unknown; structuredContent: unknown }; callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>; onSize?: (height: number) => void; log?: (message: string) => void }
  export function attachWidgetHost(options: WidgetHostOptions): { detach: () => void; pushHostContext: (partial: Partial<HostContext>) => void };

  // src/server/http.ts
  export const WIDGET_TOOLS: readonly string[];   // ['log_maintenance']
  export function handleWidget(conversation: Conversation, request: Request): Promise<Response>;
  export function handleWidgetTool(conversation: Conversation, request: Request): Promise<Response>;
  ```

- [ ] **Step 1: Write the failing test**

**The file is `.tsx`, and that is not a typo.** `vitest.config.ts` splits the two projects on the extension — `test/**/*.test.ts` runs under `environment: 'node'`, `test/**/*.test.tsx` under `jsdom` — and everything in this file needs a DOM: the module under test calls `window.addEventListener('message', …)` and the helper below dispatches events on `window`. As a `.ts` file every one of these ten tests throws `ReferenceError: window is not defined` before it asserts anything, and the task cannot reach its own "Expected: PASS". The file contains no JSX, which is fine: the extension here selects an environment, not a syntax. The alternative — a third vitest project, or an `environment` override comment — would make the rule "extension picks the environment" true everywhere except one file, and a rule with one exception is a rule nobody applies.

`apps/simulator/test/widget-host.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASE_CANVAS } from '../src/shared/canvas.js';
import { WIDGET_PROTOCOL_VERSION, attachWidgetHost, hostContextFor } from '../src/lib/widget-host.js';

let detach: () => void = () => {};
afterEach(() => detach());

/**
 * jsdom will not let a MessageEvent carry an arbitrary `source`, so the frame's
 * window is faked and the event is built as a plain Event with `source`
 * assigned. That keeps the source check under test rather than bypassed.
 */
function fakeFrame() {
  const posted: unknown[] = [];
  const frameWindow = { postMessage: (message: unknown) => posted.push(message) } as unknown as Window;
  const send = (data: unknown, source: unknown = frameWindow) => {
    const event = new Event('message');
    Object.assign(event, { data, source });
    window.dispatchEvent(event);
  };
  return { frameWindow, posted, send };
}

function attach(over: Partial<Parameters<typeof attachWidgetHost>[0]> = {}) {
  const frame = fakeFrame();
  const callTool = vi.fn(async () => ({ structuredContent: { nextDueAt: '2027-01-04' } }));
  const handle = attachWidgetHost({
    frameWindow: frame.frameWindow,
    hostContext: () => hostContextFor('dark'),
    toolResult: () => ({ content: [{ type: 'text', text: 'Two tasks are due.' }], structuredContent: { items: [{ applianceId: 'appl_x' }] } }),
    callTool,
    ...over
  });
  detach = handle.detach;
  return { ...frame, callTool, handle };
}

describe('attachWidgetHost', () => {
  it('answers ui/initialize with the host context the widget reads its theme from', () => {
    const { posted, send } = attach();
    send({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { appInfo: { name: 'homeledger-calendar', version: '0.1.0' } } });
    expect(posted).toHaveLength(1);
    const reply = posted[0] as { id: number; result: { protocolVersion: string; hostContext: { theme: string; maxWidth: number; maxHeight: number } } };
    expect(reply.id).toBe(1);
    expect(reply.result.protocolVersion).toBe(WIDGET_PROTOCOL_VERSION);
    expect(reply.result.hostContext.theme).toBe('dark');
    // The base canvas, so a widget laying itself out to the host's bounds gets
    // the same 768x480 it was authored against - and NOT the 1280x800 device,
    // which is that canvas already scaled. Written as literals here on
    // purpose: `expect(...).toBe(BASE_CANVAS.width)` would be the same module
    // agreeing with itself, and would pass after someone changed the constant.
    // The link to `src/shared/canvas.ts` is proved by Task 10's mutation 7,
    // which changes BASE_CANVAS once and requires BOTH suites to fail.
    expect(reply.result.hostContext.maxWidth).toBe(768);
    expect(reply.result.hostContext.maxHeight).toBe(480);
    expect(BASE_CANVAS.width).toBe(768);
  });

  it('pushes the tool result once the widget says it is initialised, not before', () => {
    const { posted, send } = attach();
    send({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} });
    expect(posted.filter(m => (m as { method?: string }).method === 'ui/notifications/tool-result')).toHaveLength(0);
    send({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
    const pushed = posted.find(m => (m as { method?: string }).method === 'ui/notifications/tool-result') as { params: { structuredContent: unknown } };
    expect(pushed.params.structuredContent).toEqual({ items: [{ applianceId: 'appl_x' }] });
  });

  it('runs a tools/call from the widget and replies to its id', async () => {
    const { posted, send, callTool } = attach();
    send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'log_maintenance', arguments: { applianceId: 'appl_x', taskType: 'filter' } } });
    await vi.waitFor(() => expect(posted.some(m => (m as { id?: number }).id === 7)).toBe(true));
    expect(callTool).toHaveBeenCalledWith('log_maintenance', { applianceId: 'appl_x', taskType: 'filter' });
    expect(posted.find(m => (m as { id?: number }).id === 7)).toEqual({ jsonrpc: '2.0', id: 7, result: { structuredContent: { nextDueAt: '2027-01-04' } } });
  });

  it('replies with an error, not silence, when a tools/call fails', async () => {
    const { posted, send } = attach({ callTool: async () => Promise.reject(new Error('log_maintenance is not allowed from a widget')) });
    send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'book_service', arguments: {} } });
    await vi.waitFor(() => expect(posted.some(m => (m as { id?: number }).id === 8)).toBe(true));
    const reply = posted.find(m => (m as { id?: number }).id === 8) as { error: { code: number; message: string } };
    expect(reply.error.code).toBe(-32603);
    expect(reply.error.message).toContain('not allowed from a widget');
  });

  it('answers an unknown request method rather than leaving the widget waiting', () => {
    const { posted, send } = attach();
    send({ jsonrpc: '2.0', id: 9, method: 'ui/teleport', params: {} });
    expect(posted.find(m => (m as { id?: number }).id === 9)).toEqual({ jsonrpc: '2.0', id: 9, error: { code: -32601, message: 'Method not found' } });
  });

  it('reports a size change to the host', () => {
    const onSize = vi.fn();
    const { send } = attach({ onSize });
    send({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 312 } });
    expect(onSize).toHaveBeenCalledWith(312);
  });

  it('ignores a message from any window that is not this frame', () => {
    const { posted, send } = attach();
    send({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} }, { postMessage: () => {} });
    expect(posted).toHaveLength(0);
  });

  it('ignores a message that is not JSON-RPC', () => {
    const { posted, send } = attach();
    send({ hello: 'there' });
    send(null);
    send('a string');
    expect(posted).toHaveLength(0);
  });

  it('pushes only the changed fields when the theme is toggled', () => {
    const { posted, send, handle } = attach();
    send({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} });
    handle.pushHostContext({ theme: 'light' });
    const changed = posted.find(m => (m as { method?: string }).method === 'ui/notifications/host-context-changed') as { params: Record<string, unknown> };
    expect(changed.params).toEqual({ theme: 'light' });
  });

  it('stops listening after detach', () => {
    const { posted, send, handle } = attach();
    handle.detach();
    send({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} });
    expect(posted).toHaveLength(0);
  });
});
```

Append to `apps/simulator/test/routes.test.ts`:
```ts
describe('the widget routes', () => {
  it('serves a ui:// resource as HTML and refuses anything else', async () => {
    const convo = await conversation(scriptedModel([]));
    const { handleWidget } = await import('../src/server/http.js');
    const ok = await handleWidget(convo, new Request('http://x/api/widget?uri=ui%3A%2F%2Fhomeledger%2Fappliances'));
    expect(ok.status).toBe(200);
    expect((await ok.text()).startsWith('<!doctype html>')).toBe(true);
    for (const uri of ['homeledger://appliances', 'ui://elsewhere/x', 'file:///etc/passwd', '']) {
      const refused = await handleWidget(convo, new Request(`http://x/api/widget?uri=${encodeURIComponent(uri)}`));
      expect(refused.status, uri).toBe(400);
    }
  });

  it('runs only the tools a widget is allowed to run', async () => {
    const convo = await conversation(scriptedModel([]));
    const { WIDGET_TOOLS, handleWidgetTool } = await import('../src/server/http.js');

    // Two properties, neither of them `expect(WIDGET_TOOLS).toEqual(['log_maintenance'])`
    // - that line restated the producer's own literal from the same package
    //   with no independent party, and proved only that a constant equals
    //   itself. What matters is (1) the allowlist names tools that exist, so a
    //   typo cannot silently allow nothing, and (2) every OTHER tool the
    //   server offers is refused, which is the boundary this endpoint is.
    const offered = convo.tools.map(tool => tool.name);
    for (const allowed of WIDGET_TOOLS) expect(offered, allowed).toContain(allowed);
    for (const name of offered.filter(candidate => !WIDGET_TOOLS.includes(candidate))) {
      const refused = await handleWidgetTool(convo, new Request('http://x/api/widget/tool', { method: 'POST', body: JSON.stringify({ name, arguments: {} }) }));
      expect(refused.status, name).toBe(403);
    }

    const list = (await convo.mcp.callTool('maintenance_due', {})) as { structuredContent: { items: Array<{ applianceId: string; taskType: string }> } };
    const item = list.structuredContent.items[0]!;
    const allowed = await handleWidgetTool(
      convo,
      new Request('http://x/api/widget/tool', { method: 'POST', body: JSON.stringify({ name: 'log_maintenance', arguments: item }) })
    );
    expect(allowed.status).toBe(200);
    const refused = await handleWidgetTool(
      convo,
      new Request('http://x/api/widget/tool', { method: 'POST', body: JSON.stringify({ name: 'book_service', arguments: {} }) })
    );
    expect(refused.status).toBe(403);
    expect((await refused.json()).message).toContain('book_service');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @homeledger/simulator run test -- widget-host`
Expected: FAIL, cannot find module `../src/lib/widget-host.js`. Confirm the failure names the **ui** project rather than the **server** one; if Vitest reports it under `server`, the file was created as `.test.ts` and every test in it will throw `ReferenceError: window is not defined` once the module exists. Rename it now rather than debugging it later.

- [ ] **Step 3: Implement the host**

`apps/simulator/src/lib/widget-host.ts`:
```ts
import { BASE_CANVAS } from '../shared/canvas.js';

/** The version the widgets' own bridge sends in `ui/initialize` (`apps/mcp-server/src/widgets/shell.ts`). */
export const WIDGET_PROTOCOL_VERSION = '2026-01-26';

export interface HostContext {
  theme: 'dark' | 'light';
  displayMode: 'inline';
  /** The published base canvas, so a widget sizing itself to the host gets the bounds it was authored against. */
  maxWidth: number;
  maxHeight: number;
  locale: string;
  timeZone: string;
  userAgent: string;
  platform: 'web';
  deviceCapabilities: { touch: boolean; hover: boolean };
}

export function hostContextFor(theme: 'dark' | 'light'): HostContext {
  return {
    theme,
    displayMode: 'inline',
    // From `src/shared/canvas.ts`, not written out again. These are the bounds
    // a widget lays itself out to, and the frame lays the canvas out to the
    // same values; two copies of 768 disagree the first time one is changed,
    // and the disagreement shows up only as a widget that looks slightly
    // wrong. NOT `DEVICE`: that is this canvas already scaled, and a widget
    // told 1280 would size itself for a surface that does not exist.
    maxWidth: BASE_CANVAS.width,
    maxHeight: BASE_CANVAS.height,
    locale: 'en-US',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: 'homeledger-simulator/0.1.0',
    platform: 'web',
    // A smart display is touched, not hovered. The widgets do not branch on
    // this yet; it is here because it is part of the documented context and a
    // host that lies about it would be teaching the wrong thing.
    deviceCapabilities: { touch: true, hover: false }
  };
}

export interface WidgetHostOptions {
  frameWindow: Window;
  hostContext: () => HostContext;
  toolResult: () => { content: unknown; structuredContent: unknown };
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  onSize?: (height: number) => void;
  log?: (message: string) => void;
}

interface Incoming {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/**
 * The host half of the MCP Apps view protocol, written against the widgets' own bridge.
 *
 * The contract is not guessed: `apps/mcp-server/src/widgets/shell.ts` is a
 * hand-written bridge (FL-029, because the view SDK cannot be inlined into a
 * single file without a bundler), and it is the spec this satisfies — the same
 * method names, the same `result.hostContext`, the same source check. If the
 * two drift, the widgets show "Waiting for the appliance list" forever and
 * nothing errors, which is why the tests here assert the wire shape rather than
 * a rendered outcome.
 */
export function attachWidgetHost(options: WidgetHostOptions): { detach: () => void; pushHostContext: (partial: Partial<HostContext>) => void } {
  const post = (message: unknown): void => options.frameWindow.postMessage(message, '*');

  const listener = (event: Event): void => {
    // The frame is sandboxed without `allow-same-origin`, so its origin is
    // opaque and an origin check would compare against "null". Identity of the
    // sending window is the check that means something, and it is the mirror
    // of the view side's own `event.source !== window.parent`.
    if ((event as { source?: unknown }).source !== options.frameWindow) return;
    const message = (event as { data?: unknown }).data as Incoming | null;
    if (typeof message !== 'object' || message === null || message.jsonrpc !== '2.0') return;
    const { id, method } = message;
    const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;

    if (method === 'ui/initialize' && id !== undefined) {
      post({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: WIDGET_PROTOCOL_VERSION,
          hostInfo: { name: 'homeledger-simulator', version: '0.1.0' },
          hostContext: options.hostContext()
        }
      });
      return;
    }

    if (method === 'ui/notifications/initialized') {
      // Sent only now. A tool-result that arrives before the widget has
      // finished initialising is dropped by its own bridge, and the widget
      // then waits for a second one that never comes.
      post({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: options.toolResult() });
      return;
    }

    if (method === 'ui/notifications/size-changed') {
      const height = params.height;
      if (typeof height === 'number') options.onSize?.(height);
      return;
    }

    if (method === 'tools/call' && id !== undefined) {
      const name = params.name;
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      if (typeof name !== 'string') {
        post({ jsonrpc: '2.0', id, error: { code: -32602, message: 'tools/call needs a string name' } });
        return;
      }
      void options
        .callTool(name, args)
        .then(result => post({ jsonrpc: '2.0', id, result }))
        .catch((error: unknown) => post({ jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }));
      return;
    }

    // Every remaining request gets an answer. A widget that asked something
    // and is never told no keeps a button disabled forever.
    if (id !== undefined) post({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    else options.log?.(`ignored a widget notification this host does not handle: ${String(method)}`);
  };

  window.addEventListener('message', listener);
  return {
    detach: () => window.removeEventListener('message', listener),
    pushHostContext: partial => post({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: partial })
  };
}
```

- [ ] **Step 4: Implement the two server routes**

Append to `apps/simulator/src/server/http.ts`:
```ts
/**
 * The only tools a widget may run, and the reason the list is short.
 *
 * The calendar widget's "log as done" button is the one interaction the
 * widgets have (`apps/mcp-server/src/widgets/calendar.ts`). A general
 * tool-calling endpoint reachable from a sandboxed frame would let anything
 * running in that frame book a service visit, which is a write nobody asked
 * for. An allowlist checked server-side is the boundary; the widget's own good
 * behaviour is not.
 */
export const WIDGET_TOOLS: readonly string[] = ['log_maintenance'];

export async function handleWidget(conversation: Conversation, request: Request): Promise<Response> {
  // Checked here too, and not only on the tool route. This endpoint is fetched
  // by the browser like every other one, and an Origin check that covers four
  // routes out of five is a check somebody will reasonably believe covers all
  // five.
  const forbidden = checkOrigin(request, conversation.env.allowOrigin);
  if (forbidden) return forbidden;
  const uri = new URL(request.url).searchParams.get('uri') ?? '';
  // Prefix-checked, not merely scheme-checked: this endpoint exists to serve
  // this server's widgets and must not become a way to read any resource the
  // MCP server exposes.
  if (!uri.startsWith('ui://homeledger/'))
    return json({ ok: false, reason: 'bad-request', message: `Only ui://homeledger/ resources are served here; got ${JSON.stringify(uri)}.` }, 400);
  try {
    const html = await conversation.mcp.readResource(uri);
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  } catch (error) {
    return json({ ok: false, reason: 'unavailable', message: error instanceof Error ? error.message : String(error) }, 502);
  }
}

export async function handleWidgetTool(conversation: Conversation, request: Request): Promise<Response> {
  const forbidden = checkOrigin(request, conversation.env.allowOrigin);
  if (forbidden) return forbidden;
  const body = await readJson(request);
  const name = body?.name;
  if (typeof name !== 'string') return json({ ok: false, reason: 'bad-request', message: 'The body needs a string "name".' }, 400);
  if (!WIDGET_TOOLS.includes(name))
    return json({ ok: false, reason: 'forbidden-tool', message: `A widget may not call ${name}. Allowed here: ${WIDGET_TOOLS.join(', ')}.` }, 403);
  const args = (typeof body?.arguments === 'object' && body.arguments !== null ? body.arguments : {}) as Record<string, unknown>;
  try {
    return json(await conversation.mcp.callTool(name, args), 200);
  } catch (error) {
    return json({ ok: false, reason: 'tool-failed', message: error instanceof Error ? error.message : String(error) }, 502);
  }
}
```

Both route adapters carry the same `try`/`catch` as Tasks 9 and 13, for the same reason: `getConversation()` throws when the conversation cannot be built at all — a missing API key, an expired SSO session, a runtime that is not deployed — and those messages are written to be read. Without it, a widget fetch during a failed startup surfaces as a bare Next 500 with a stack trace, in a different shape from every other route in the application, on the one path where the person is looking at a card that will not load.

`apps/simulator/src/app/api/widget/route.ts`:
```ts
import { handleWidget } from '@/server/http';
import { getConversation } from '@/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    return await handleWidget(await getConversation(), request);
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, reason: 'unavailable', message: error instanceof Error ? error.message : String(error) }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
}
```

`apps/simulator/src/app/api/widget/tool/route.ts`:
```ts
import { handleWidgetTool } from '@/server/http';
import { getConversation } from '@/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleWidgetTool(await getConversation(), request);
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, reason: 'unavailable', message: error instanceof Error ? error.message : String(error) }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
}
```

- [ ] **Step 5: Implement the frame component and render it from the transcript**

`apps/simulator/src/components/WidgetFrame.tsx`:
```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { attachWidgetHost, hostContextFor } from '../lib/widget-host.js';
import type { Theme } from './Frame.js';

export function WidgetFrame({ uri, content, structured, theme }: { uri: string; content: unknown; structured: unknown; theme: Theme }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [height, setHeight] = useState(180);
  const [failure, setFailure] = useState<string | null>(null);
  // Read through refs so the host is attached once and still sees fresh values.
  const data = useRef({ content, structured, theme });
  data.current = { content, structured, theme };

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/widget?uri=${encodeURIComponent(uri)}`)
      .then(async response => {
        if (!response.ok) throw new Error(`the widget ${uri} could not be loaded (${response.status})`);
        return response.text();
      })
      .then(value => {
        if (!cancelled) setHtml(value);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  useEffect(() => {
    const frameWindow = ref.current?.contentWindow;
    if (!html || !frameWindow) return;
    const host = attachWidgetHost({
      frameWindow,
      hostContext: () => hostContextFor(data.current.theme),
      toolResult: () => ({ content: data.current.content, structuredContent: data.current.structured }),
      callTool: async (name, args) => {
        const response = await fetch('/api/widget/tool', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, arguments: args })
        });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error((payload as { message?: string }).message ?? `the call failed (${response.status})`);
        return payload;
      },
      onSize: next => setHeight(Math.min(Math.max(next, 80), 400))
    });
    return host.detach;
  }, [html]);

  useEffect(() => {
    const frameWindow = ref.current?.contentWindow;
    if (!html || !frameWindow) return;
    frameWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme } }, '*');
  }, [html, theme]);

  if (failure) return <p className="warn">{failure}</p>;
  if (!html) return <p className="muted">Loading the card…</p>;
  return (
    <iframe
      ref={ref}
      className="widget"
      data-testid={`widget-${uri}`}
      title={uri}
      srcDoc={html}
      height={height}
      // allow-scripts and nothing else. Without allow-same-origin the frame's
      // origin is opaque, so it can reach nothing of this application's; the
      // postMessage channel is its only way in or out, which is exactly the
      // isolation the MCP Apps design assumes.
      sandbox="allow-scripts"
    />
  );
}
```

In `apps/simulator/src/components/Transcript.tsx`, thread the theme through and render the widget on a successful call that names one. Change the component signature to `{ state, theme }: { state: AgentState; theme: Theme }`, pass `theme` into `ToolRow`, add the import `import { WidgetFrame } from './WidgetFrame.js';` and `import type { Theme } from './Frame.js';`, and render after the spoken line:
```tsx
      {entry.status === 'ok' && entry.widgetUri ? (
        <WidgetFrame uri={entry.widgetUri} content={entry.content} structured={entry.structured} theme={theme} />
      ) : null}
```
`content={entry.content}`, not `content={null}`. The view protocol's `ui/notifications/tool-result` payload is `{content, structuredContent}` and the entry has carried the real content array since Task 11 — the draft passed a literal `null` because the `TurnEvent` union had no field to read, which made `WidgetFrame`'s `content` prop a parameter that could only ever be null. All four widgets this server ships read `structuredContent`, so the difference is invisible today and would be a silent, permanent hole the first time one reads `content`.

Update `page.tsx`'s `<Transcript state={turn.state} />` to `<Transcript state={turn.state} theme={theme} />`, and add `theme="dark"` to **every** `<Transcript …>` render in the test files — there are five, two in `transcript.test.tsx` and three in `failures.test.tsx`. Count them with `grep -c '<Transcript' apps/simulator/test/*.tsx` before and after rather than trusting this number; the draft of this plan said "the two existing renders" when there were four, and following it literally left two typecheck errors.

Append to `apps/simulator/src/app/globals.css`:
```css
.widget {
  width: 100%;
  border: 0;
  border-radius: 10px;
  margin-top: 8px;
  background: var(--bg);
}
```

- [ ] **Step 6: Run everything**

```bash
pnpm --filter @homeledger/simulator run test
pnpm --filter @homeledger/simulator run typecheck
pnpm --filter @homeledger/simulator run build
```
Expected: PASS. The widget iframe is not exercised by jsdom (scripts inside `srcDoc` do not run there) — that gap is closed by Task 15's Playwright run, and it is named here rather than papered over with a jsdom test that would prove only that the HTML string arrived.

- [ ] **Step 7: Record the snapshot-origin gap**

`get_visit` returns `snapshotUrl: null` today and the visit widget renders that state, so nothing loads a remote image yet. When the Ring plan fills it with a presigned S3 URL, this iframe will block it: a sandboxed frame with no CSP allowance and no `resourceDomains` declaration has no origin to load it from. That is FL-030, still open, and it now has a second place it bites.

**Confirm the number before writing the heading.** Run `grep -n '^### FL-' FRICTION-LOG.md | tail -3`. The last entry is **FL-040** — the `Intl`/ICU entry filed by the household-timezone work at `a40f3d1` — so this one is **FL-041**. (The draft of this plan prescribed FL-040 verbatim, which was free when it was written and taken by the time it ran; two identical headings in a shared document is a corruption nothing else in this plan would catch except Task 16's grep.) Add to `FRICTION-LOG.md`:

```markdown
### FL-041 · MCP Apps widgets in the simulator · The snapshot origin FL-030 named has a host now, and it still has nowhere to come from
- **Expected:** With the widget host in place, the four `ui://` widgets render from the deployed server with no further configuration.
- **Actual:** Three of the four do. The visit widget's snapshot `<img>` has no source to load today — `get_visit` returns `snapshotUrl: null` until the Ring pipeline writes one — so the gap is invisible rather than fixed. When Plan 4 fills that field with a presigned S3 URL, the widget iframe (`sandbox="allow-scripts"`, opaque origin, no CSP `resourceDomains` declaration) will refuse the load, silently, as a broken image.
- **Impact:** None yet, and a broken demo image later if nobody remembers. Recorded now because the moment it breaks is the moment somebody is wiring Ring and will read it as a Ring bug.
- **Workaround / decision:** Nothing to do until a URL exists. When it does, the decision is between declaring the bucket's origin on the widget resource (the MCP Apps `resourceDomains` mechanism FL-030 named) and proxying the image through the simulator so it is same-origin to the frame. The proxy is the likelier answer here because the presigned host changes with the bucket and region, and a declaration that has to be edited per environment is a declaration that will be wrong in one of them.
- **Source:** `apps/simulator/src/components/WidgetFrame.tsx` · `apps/mcp-server/src/widgets/visit.ts` · this file's FL-030
- **Status:** Open, not blocking. Belongs to the Ring plan.
```

- [ ] **Step 8: Mutation check**

1. In `attachWidgetHost`, drop the `event.source !== options.frameWindow` check — the foreign-window test must fail.
2. Send the tool result in the `ui/initialize` reply instead of on `ui/notifications/initialized` — the "not before" test must fail.
3. Reply to `tools/call` failures with nothing — the error-reply test must fail by timing out inside `vi.waitFor`; note that it detects as a timeout.
4. Drop the `-32601` fallback — the unknown-method test must fail, as a **clean assertion, not a timeout**. (The draft's note said "again by timeout". It is wrong and harmlessly so: that test is synchronous — `send(...)`, then `expect(posted.find(...))` — so it reports a missing reply immediately. The test is stronger than the note claimed, and a note that predicts the wrong symptom is a note that gets a real failure misread as a flake.)
5. In `handleWidget`, check `uri.startsWith('ui://')` instead of `'ui://homeledger/'` — the refusal test must fail on `ui://elsewhere/x`.
6. In `handleWidgetTool`, allow any tool — the allowlist test must fail, once per tool the server offers that is not on the list. Eight failures from one mutation, rather than the one the old `toEqual(['log_maintenance'])` line would have given.
7. In `WIDGET_TOOLS`, change the entry to `'log_maintainance'` (a typo) — the allowlist test must fail on the "names tools that exist" assertion, and the 200 case must fail too. A list that allows nothing is as broken as one that allows everything and is far quieter about it.
8. In `hostContextFor`, return `maxWidth: 1280, maxHeight: 800` — the initialize test must fail. (The device size is not the canvas size, and a widget told otherwise lays itself out for a surface that does not exist.)
9. Now run **Task 10's mutation 7** from here: change `BASE_CANVAS` in `src/shared/canvas.ts` to `{ width: 800, height: 500 }`. This task's initialize test and Task 10's canvas test must **both** fail. One suite failing alone means the number is written down twice again. Revert, and record the two-suite result in the commit body — it is the evidence the constant is shared rather than coincidentally equal.
10. In `Transcript`, pass `content={null}` to `WidgetFrame` instead of `entry.content` — no test fails, because jsdom does not run the iframe's script and all four shipped widgets read `structuredContent`. Record that honestly: **the `content` half of the tool-result payload is not asserted anywhere in this repository.** What the plan can guarantee is that the value exists and is carried — Task 5's reader test, Task 11's reducer test — and that this component passes the carried value rather than a literal. Revert and leave the note.

- [ ] **Step 9: Commit**

```bash
git add apps/simulator FRICTION-LOG.md
git commit -m "feat(simulator): host the ui:// widgets in a sandboxed frame over the view protocol"
```

---

### Task 15: End-to-end in a real browser, and the run against the deployed runtime

**Files:**
- Create: `apps/simulator/playwright.config.ts`, `apps/simulator/src/server/scripted-model.ts`, `apps/simulator/test/e2e/simulator.spec.ts`, `apps/simulator/test/e2e/fixtures.ts`
- Modify: `apps/simulator/src/server/credentials.ts`, `apps/simulator/src/server/session.ts`, `apps/simulator/test/credentials.test.ts`, `apps/simulator/test/no-client-secrets.test.ts`, `.env.example`, `FRICTION-LOG.md`
- Test: the Playwright suite itself, plus the unit cases on the new modes

`scripted-model.ts` is in that Create list and in the plan's file-structure block. The draft created it in Step 2 and declared it in neither, which is how a file ends up existing that no manifest knows about.

**Interfaces:**
- Produces:
  ```ts
  // src/server/credentials.ts
  export function isUnauthenticatedLocal(source: NodeJS.ProcessEnv): boolean;
  // src/server/session.ts
  export const SCRIPTED_MODEL_FLAG = 'HOMELEDGER_SIMULATOR_SCRIPTED_MODEL';
  export function scriptedModelRequested(source: NodeJS.ProcessEnv): boolean;
  ```

**Why there are two modes, said plainly.** jsdom does not run the scripts inside a `srcDoc` iframe, so nothing built so far has proved that the widgets actually render — only that the right HTML was fetched and the right messages were posted. A real browser is the only thing that closes that. But a browser test that also drives the real model costs money on every run and returns different text each time, which makes it a bad regression suite and a good demo rehearsal. So: the Playwright suite runs against a **local** MCP server with a **scripted** model, deterministic and free, and it is the one wired into `pnpm test:e2e`. The run against the deployed runtime with the real model is a separate, manual, documented step at the end of this task — it is the verification that matters for the submission, and it is recorded in the friction log rather than automated.

- [ ] **Step 1: Write the failing unit cases for the two modes**

Append to `apps/simulator/test/credentials.test.ts`:
```ts
import { isUnauthenticatedLocal } from '../src/server/credentials.js';
import { SCRIPTED_MODEL_FLAG, scriptedModelRequested } from '../src/server/session.js';

describe('local, unauthenticated mode', () => {
  it('is on only when a whole URL is pinned and no token endpoint is configured', () => {
    expect(isUnauthenticatedLocal({ HOMELEDGER_MCP_URL: 'http://127.0.0.1:8010/mcp' })).toBe(true);
    expect(isUnauthenticatedLocal({ HOMELEDGER_MCP_URL: 'http://127.0.0.1:8010/mcp', HOMELEDGER_COGNITO_TOKEN_URL: 'https://x/oauth2/token' })).toBe(false);
    expect(isUnauthenticatedLocal({ HOMELEDGER_COGNITO_TOKEN_URL: 'https://x/oauth2/token' })).toBe(false);
    expect(isUnauthenticatedLocal({})).toBe(false);
  });

  it('refuses to skip authentication for anything that is not a loopback address', () => {
    // The whole safety of this mode is that it cannot be pointed at the
    // deployed runtime. A bearerless request to AgentCore would be refused
    // anyway, but a mode that silently tries is a mode somebody will debug.
    expect(isUnauthenticatedLocal({ HOMELEDGER_MCP_URL: 'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/x/invocations' })).toBe(false);
    expect(isUnauthenticatedLocal({ HOMELEDGER_MCP_URL: 'http://localhost:8010/mcp' })).toBe(true);
    expect(isUnauthenticatedLocal({ HOMELEDGER_MCP_URL: 'not a url' })).toBe(false);
  });

  it('accepts IPv6 loopback in the bracketed form the URL parser actually produces', () => {
    // `new URL('http://[::1]:8010/').hostname` is '[::1]', WITH the brackets:
    // the WHATWG parser keeps them, so a check for '::1' is a branch nothing
    // can ever reach. That is the fourth shape Global Constraint 26 names -
    // a branch made unreachable by a library's own preprocessing - and the
    // draft of this plan prescribed it in the same document that warns about
    // it. This case is the proof that the arm is live.
    expect(isUnauthenticatedLocal({ HOMELEDGER_MCP_URL: 'http://[::1]:8010/mcp' })).toBe(true);
    expect(new URL('http://[::1]:8010/mcp').hostname).toBe('[::1]');
  });
});

describe('the scripted model', () => {
  it('is off unless the flag is exactly 1', () => {
    expect(scriptedModelRequested({})).toBe(false);
    for (const value of ['', '0', 'true', 'yes', 'TRUE', ' 1']) expect(scriptedModelRequested({ [SCRIPTED_MODEL_FLAG]: value }), value).toBe(false);
    expect(scriptedModelRequested({ [SCRIPTED_MODEL_FLAG]: '1' })).toBe(true);
  });
});
```

- [ ] **Step 2: Implement both modes**

Append to `apps/simulator/src/server/credentials.ts`:
```ts
/**
 * Whether to talk to a local server with no bearer at all.
 *
 * This exists so the end-to-end suite and `pnpm dev` can run with no AWS
 * account, which is the same promise `docs/RUNBOOK.md` section 4 already makes
 * for the server itself. It is narrow by construction: a whole URL must be
 * pinned, it must be loopback, and no Cognito token endpoint may be configured.
 * Any one of those missing and the normal path runs — there is no way to reach
 * the deployed runtime through this branch, which is the property that makes an
 * unauthenticated mode safe to ship.
 */
export function isUnauthenticatedLocal(source: NodeJS.ProcessEnv): boolean {
  const raw = source.HOMELEDGER_MCP_URL?.trim();
  if (!raw || source.HOMELEDGER_COGNITO_TOKEN_URL?.trim()) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // '[::1]' WITH brackets. `new URL(...).hostname` keeps them for every IPv6
  // host, so the bare '::1' this used to compare against is a value the parser
  // never produces - an arm that reads as thorough and can never be true.
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
}
```
and change `resolveUpstream` to take the branch first:
```ts
export async function resolveUpstream(source: NodeJS.ProcessEnv = process.env, log: (m: string) => void = () => {}): Promise<UpstreamCredentials> {
  if (isUnauthenticatedLocal(source)) {
    const url = source.HOMELEDGER_MCP_URL!.trim();
    log(`talking to ${url} with no bearer token: a loopback URL is pinned and no Cognito token endpoint is configured`);
    // `resolveUrl` yields the same pinned URL: there is no name to look up, so
    // the client's heal-before-rebuild path is a no-op here rather than a
    // branch this mode has to know about.
    return { url, arn: undefined, origin: 'url', token: async () => 'local-no-auth', invalidateToken: () => {}, resolveUrl: async () => url };
  }
  const config = loadConfig(source);
  // ... unchanged from here
```

**This branch also closes a gap that runs the length of the plan.** `apps/mcp-bridge/src/config.ts:183-184` makes `HOMELEDGER_COGNITO_TOKEN_URL` and `HOMELEDGER_COGNITO_CLIENT_ID` **required**, so from Task 2 until this step `resolveUpstream` throws on any machine without Cognito configured — including the local-server path the runbook promises. It is not a defect in the earlier tasks (nothing before Task 9 calls it, and Task 9's tests build their `Conversation` by hand), but it does mean `pnpm --filter @homeledger/simulator run dev` against a local server does not work until this task lands. Say so in the commit body rather than letting the next person discover it by running the runbook halfway through the plan.

Append to `apps/simulator/src/server/session.ts`:
```ts
export const SCRIPTED_MODEL_FLAG = 'HOMELEDGER_SIMULATOR_SCRIPTED_MODEL';

/**
 * Whether to answer from a fixed script instead of from the model.
 *
 * On for the end-to-end suite only, and opt-in by exact value for the same
 * reason `MANUAL_INGESTION_SKIPPED` is (FL-032): a flag that accepts anything
 * truthy is a flag that gets switched on by a stray `0` or a typo, and a demo
 * that quietly stopped calling the model would look exactly like a demo that
 * was calling it. The startup log says which mode is running, every time.
 */
export function scriptedModelRequested(source: NodeJS.ProcessEnv = process.env): boolean {
  return source[SCRIPTED_MODEL_FLAG] === '1';
}
```
and in `build()`, replace the `model:` line:
```ts
  const scripted = scriptedModelRequested();
  if (scripted) console.log(JSON.stringify({ msg: 'simulator', detail: `${SCRIPTED_MODEL_FLAG}=1: answering from a fixed script, NOT from the model` }));
  const model = scripted ? createScriptedModel() : createModelPort({ messages: createAnthropicClient(env.anthropicApiKey).messages, model: env.model });
```
with `createScriptedModel` imported from a new `./scripted-model.js`:

`apps/simulator/src/server/scripted-model.ts`:
```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { ModelPort } from './model.js';

function toolUse(id: string, name: string, input: Record<string, unknown>): Anthropic.ContentBlock {
  return { type: 'tool_use', id, name, input } as unknown as Anthropic.ContentBlock;
}

function text(value: string): Anthropic.ContentBlock {
  return { type: 'text', text: value } as unknown as Anthropic.ContentBlock;
}

function lastUserText(messages: Anthropic.MessageParam[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.content === 'string') return message.content.toLowerCase();
  }
  return '';
}

function applianceIdIn(messages: Anthropic.MessageParam[]): string | undefined {
  return /appl_[a-z0-9]{16}/.exec(JSON.stringify(messages))?.[0];
}

/**
 * A stand-in that follows the same three demo paths the video does.
 *
 * It is not a model and does not pretend to be: it looks at the last thing the
 * person typed and at whether a tool has already run, and picks the next call.
 * That is enough to drive every wire in this application — tool calls,
 * elicitation, progress, widgets, failures — deterministically and for free,
 * which is what an end-to-end suite needs and what a model cannot give it.
 */
export function createScriptedModel(): ModelPort {
  return {
    async respond(request, onText) {
      const asked = lastUserText(request.messages);
      const applianceId = applianceIdIn(request.messages);
      const calls = JSON.stringify(request.messages);
      let content: Anthropic.ContentBlock[];

      if (asked.includes('book') && !calls.includes('list_appliances')) content = [toolUse('c1', 'list_appliances', { category: 'water_heater' })];
      else if (asked.includes('book') && applianceId && !calls.includes('book_service'))
        content = [toolUse('c2', 'book_service', { applianceId, issue: 'water heater leaking at the base' })];
      else if (asked.includes('manual') && !calls.includes('ask_manual')) content = [toolUse('c3', 'ask_manual', { question: 'what does F21 mean' })];
      else if (asked.includes('due') && !calls.includes('maintenance_due')) content = [toolUse('c4', 'maintenance_due', { horizonDays: 30 })];
      else if (!calls.includes('list_appliances')) content = [toolUse('c5', 'list_appliances', {})];
      else content = [text('Here is what I found.')];

      for (const block of content) if (block.type === 'text') onText(block.text);
      return {
        id: 'scripted',
        type: 'message',
        role: 'assistant',
        model: 'scripted',
        content,
        stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      } as unknown as Anthropic.Message;
    }
  };
}
```

- [ ] **Step 3: Write the Playwright config and fixtures**

`apps/simulator/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';

/**
 * Local and deterministic. The MCP server runs in memory on 8010, the model is
 * scripted, and no credential of any kind is needed — which is why this can be
 * a suite rather than a rehearsal.
 */
export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'pnpm --filter @homeledger/mcp-server run dev',
      url: 'http://127.0.0.1:8010/healthz',
      reuseExistingServer: false,
      env: { PORT: '8010', HOUSEHOLD_ID: 'hh_harlow', MEMORY_REPO: '1', HOMELEDGER_DEV_TOOLS: '1' }
    },
    {
      // `dev:e2e`, a script of its own, and NOT `run dev -- -p 3100`: that
      // expands to `next dev -p 3000 -p 3100`, because `dev` already pins
      // 3000. Last-wins is not contractual in Next's CLI parser, and the
      // health check below polls 3100, so the failure mode is a suite that
      // hangs waiting for a server listening on the other port.
      command: 'pnpm --filter @homeledger/simulator run dev:e2e',
      url: 'http://127.0.0.1:3100/api/health',
      reuseExistingServer: false,
      env: {
        HOMELEDGER_MCP_URL: 'http://127.0.0.1:8010/mcp',
        HOMELEDGER_SIMULATOR_SCRIPTED_MODEL: '1',
        // Present because readSimulatorEnv requires it; never used, because the
        // scripted model never constructs an Anthropic client. This file sits
        // outside src/, so Task 2's guard does not walk it - which is correct
        // (Next never compiles it) and is exactly why the placeholder is
        // pinned by an assertion of its own, below.
        ANTHROPIC_API_KEY: 'not-used-by-the-scripted-model'
      }
    }
  ]
});
```

Append to `apps/simulator/test/no-client-secrets.test.ts`:
```ts
describe('the end-to-end config', () => {
  it('carries only the placeholder, never a key', async () => {
    // The one place in this package where a credential NAME legitimately sits
    // outside src/server/. Task 2's guard does not reach here and should not -
    // Next never compiles this file - so the value is pinned instead: this
    // asserts the string is the placeholder itself, which fails the moment
    // somebody pastes a real key in to debug something and forgets to take it
    // out again.
    const text = await readFile(fileURLToPath(new URL('../playwright.config.ts', import.meta.url)), 'utf8');
    expect(text).toContain("ANTHROPIC_API_KEY: 'not-used-by-the-scripted-model'");
    expect(text).not.toMatch(/sk-ant-/);
    expect(text).not.toMatch(/process\.env\.ANTHROPIC_API_KEY/);
  });
});
```

`apps/simulator/test/e2e/fixtures.ts`:
```ts
import type { Page } from '@playwright/test';

export async function ask(page: Page, text: string): Promise<void> {
  await page.getByLabel('Ask about the house').fill(text);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
}
```

- [ ] **Step 4: Write the end-to-end specs**

`apps/simulator/test/e2e/simulator.spec.ts`:
```ts
import { expect, test } from '@playwright/test';
import { ask } from './fixtures.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('the display is the base canvas at its published scale, and discloses itself', async ({ page }) => {
  const device = page.getByTestId('device');
  await expect(device).toHaveCSS('width', '1280px');
  await expect(device).toHaveCSS('height', '800px');
  await expect(page.getByTestId('disclosure')).toContainText('sample data');
});

test('asking about appliances renders the widget, with its own script running inside the frame', async ({ page }) => {
  await ask(page, 'what appliances do we have');
  const frame = page.frameLocator('[data-testid="widget-ui://homeledger/appliances"]');
  // This assertion is the reason Playwright is here at all: the text below is
  // produced by the widget's own script from the tool result the host pushed
  // over postMessage, so it passes only if the whole view protocol worked.
  await expect(frame.locator('.card .name').first()).not.toBeEmpty();
  await expect(frame.locator('.card')).toHaveCount(6);
});

test('booking asks three questions as cards, shows progress, and ends with the visit card', async ({ page }) => {
  await ask(page, 'book a plumber for the water heater');

  const card = page.getByTestId('elicitation');
  await expect(card).toHaveAttribute('data-field', 'provider');
  await expect(card.getByTestId(/^option-/)).toHaveCount(3);
  // The composer is unusable while a question is up: a second turn would park
  // its elicitations on a stream nobody is reading.
  await expect(page.getByLabel('Ask about the house')).toBeDisabled();
  await card.getByTestId('option-prov_kettle_water').click();

  await expect(card).toHaveAttribute('data-field', 'window');
  await card.getByTestId('option-win_1').click();

  await expect(card).toHaveAttribute('data-field', 'confirm');
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '3');
  await card.getByRole('button', { name: /yes, book it/i }).click();

  await expect(page.getByTestId('elicitation')).toHaveCount(0);
  const visit = page.frameLocator('[data-testid="widget-ui://homeledger/visit"]');
  await expect(visit.locator('body')).toContainText('Kettle Creek Water Heaters');
  await expect(page.getByLabel('Ask about the house')).toBeEnabled();
});

test('declining a question books nothing, says so, and is not shown as a failure', async ({ page }) => {
  await ask(page, 'book a plumber for the water heater');
  await expect(page.getByTestId('elicitation')).toBeVisible();
  await page.getByRole('button', { name: /not now/i }).click();
  await expect(page.getByTestId('elicitation')).toHaveCount(0);

  // `ok`, not `failed`. Before Task 5's Step 1 the server signed this result
  // `isError: true`, so the transcript rendered "book_service failed - Nothing
  // was retrieved, so this is not an answer and not an empty one either" at
  // somebody who had simply chosen not to book - and this test asserted it.
  const row = page.locator('[data-testid^="tool-"][data-status="ok"]').last();
  await expect(row).toContainText("haven't booked anything");
  await expect(page.locator('[data-testid^="tool-"][data-status="failed"]')).toHaveCount(0);
  await expect(page.getByTestId('transcript')).not.toContainText('Nothing was retrieved');

  // book_service names the visit widget on its tool descriptor, so a declined
  // call still carries one, and the widget renders the no-visit state it
  // already has. Asserted rather than suppressed: this is what the screen
  // shows, so it is either correct and tested or wrong and worth seeing.
  const visit = page.frameLocator('[data-testid="widget-ui://homeledger/visit"]');
  await expect(visit.locator('#detail')).toContainText('No visit selected.');
});

test('a manual question against a server with no knowledge base answers from fixtures, and says nothing untrue', async ({ page }) => {
  // The local server serves SAMPLE_MANUAL_PASSAGES when KNOWLEDGE_BASE_ID is
  // unset, so this is the passing shape. The failing shape — the deployed one,
  // where retrieval is refused outright — is covered by failures.test.ts and by
  // the deployed run in Step 7.
  await ask(page, 'what does the manual say about F21');
  await expect(page.locator('[data-testid^="tool-"][data-status="ok"]')).toBeVisible();
  await expect(page.getByTestId('transcript')).not.toContainText('"passages"');
});

test('the calendar widget logs a task through the allowlisted tool', async ({ page }) => {
  await ask(page, 'what maintenance is due');
  const frame = page.frameLocator('[data-testid="widget-ui://homeledger/calendar"]');
  const button = frame.getByRole('button', { name: 'Log as done' }).first();
  await button.click();

  // `apps/mcp-server/src/widgets/calendar.ts:36` writes 'Next ' + nextDueAt on
  // success and 'Logged' when the server sent no next date. The assertion this
  // replaces was `toContainText('Next 20')`, which matches any date in the
  // years 2000-2099 - so the only thing it could actually detect was the word
  // 'Logged'. A whole ISO date, in the future, is the shape a real round trip
  // produces: a task logged today gets its next occurrence one interval out.
  await expect(button).toHaveText(/^Next \d{4}-\d{2}-\d{2}$/);
  const nextDueAt = /^Next (\d{4}-\d{2}-\d{2})$/.exec((await button.textContent()) ?? '')?.[1];
  expect(nextDueAt).toBeTruthy();
  expect(Date.parse(`${nextDueAt}T00:00:00Z`)).toBeGreaterThan(Date.now());
});
```

`test:e2e` and `dev:e2e` are both already in `apps/simulator/package.json` from Task 1. Do **not** add `test:e2e` to `pnpm test`: the workspace `test` script runs on every pull request and starting two servers and a browser there would make a fast check slow and flaky. It is run deliberately, the way `test:dynamo` is.

- [ ] **Step 5: Install the browser and run it**

```bash
pnpm --filter @homeledger/simulator exec playwright install chromium
pnpm --filter @homeledger/mcp-server build
pnpm --filter @homeledger/simulator run test:e2e
```
Expected: six tests pass. If the widget frame assertions fail with an empty body, the iframe's script did not run — check that `sandbox="allow-scripts"` is on the element and that `/api/widget` returned HTML rather than JSON.

- [ ] **Step 6: Mutation check**

1. Remove `sandbox="allow-scripts"` entirely from `WidgetFrame` (making it fully sandboxed) — the two widget specs must fail. This is the assertion that the view protocol really runs.
2. In `WidgetFrame`, stop sending the tool result (drop `toolResult` from the host options and return an empty object) — the appliances spec must fail on the card count.
3. In `page.tsx`, stop disabling the composer while a question is pending — the booking spec must fail on `toBeDisabled`.
4. In `isUnauthenticatedLocal`, drop the loopback check — the credentials unit test must fail on the AgentCore host.
5. In `isUnauthenticatedLocal`, change `'[::1]'` back to `'::1'` — the IPv6 case must fail. It is worth running precisely because it is the mutation that passed before the case existed: the arm was dead, and a dead arm reads as coverage.
6. In `scriptedModelRequested`, accept any truthy value — the unit test must fail on `'true'` and `'yes'`.
7. In `apps/mcp-server/src/tools/service.ts`, put `isError: true` back on `notBooked()` — the decline spec must fail on `data-status="ok"`, and again on the "no failed rows" assertion. The same mutation as Task 5's number 9, run here against the browser, because this is the surface a person actually sees it on.
8. In `playwright.config.ts`, change the simulator command back to `run dev -- -p 3100` — the whole suite must fail to start, timing out on the `/api/health` check because `next dev -p 3000 -p 3100` is not contractually a server on 3100. Revert. Running it once is how the `dev:e2e` script stops looking like an unnecessary extra script.
9. In the calendar spec, change the assertion back to `toContainText('Next 20')`, then make `apps/mcp-server/src/widgets/calendar.ts` write `'Next 2000-01-01'` instead of the real date — the loose matcher passes and the strict one fails. Revert both. This is the clearest demonstration in the plan of what a short `toContain` costs: `'Next 20'` matches every date this century, so the only thing it could ever detect was the literal string `Logged`.

- [ ] **Step 7: The run that actually matters — against the deployed runtime, with the real model**

Not automated, not in CI, and done by hand once per meaningful change. Two terminals.

```bash
# 1. A real AWS session, so the runtime can be resolved by name and the secret read.
aws login --profile homeledger-admin
export AWS_PROFILE=homeledger-admin

# 2. The simulator, pointed at nothing local: no HOMELEDGER_MCP_URL, so it
#    resolves demo_homeledger_mcp by name exactly as the bridge does.
cd apps/simulator
cat > .env.local <<'ENV'
ANTHROPIC_API_KEY=sk-ant-...
HOMELEDGER_COGNITO_TOKEN_URL=https://<domain>.auth.us-east-1.amazoncognito.com/oauth2/token
HOMELEDGER_COGNITO_CLIENT_ID=<client id>
AWS_REGION=us-east-1
ENV
pnpm --filter @homeledger/mcp-bridge run print-setup   # prints the two Cognito values above
pnpm --filter @homeledger/simulator run dev
```

Then drive it in a browser at `http://127.0.0.1:3000` and record, verbatim, in a new `FRICTION-LOG.md` entry:

1. `Connection` drawer: the endpoint host, `resolved by name`, the session id, and the tool count. **Nine** is the number against the deployed runtime, because it sets `HOMELEDGER_DEV_TOOLS=1`.
2. "what appliances do we have" — the appliances widget renders, the spoken line names at most five, and the drawer shows the call under 3000 ms.
3. "when did we last change the furnace filter" — the calendar widget, and a spoken answer with no ids in it.
4. "what does F21 mean on the washer" — **this must fail, visibly.** Expected: a failed `ask_manual` card titled "The manuals could not be searched", carrying the server's own sentence, and an assistant reply that says it could not look it up. **If the assistant answers the question anyway, stop and file it as a finding** — that is FL-039 recurring on a new surface and it is the single most important thing this run checks.
5. "book a plumber for the water heater Tuesday" — three cards in order, progress reaching 3 of 3, the visit widget, and a `VISIT#` row (`gh workflow run smoke.yml` or the bridge, to confirm from the other side).
6. Leave it idle for 35 minutes, then ask anything. Expected: one `session-rebuilt` notice and a correct answer. This is the only place FL-039's repair is exercised against the thing that actually produces it.

Write the entry as the next free number — **FL-042** if Task 14 filed FL-041 and nothing else has landed since; re-check with `grep -n '^### FL-' FRICTION-LOG.md | tail -3` before writing the heading, because that is the one mistake in this file that corrupts it silently. Six fields, with the timings quoted rather than summarised.

- [ ] **Step 8: Commit**

```bash
git add apps/simulator .env.example FRICTION-LOG.md
git commit -m "test(simulator): deterministic end-to-end run in a browser, and a local unauthenticated mode"
```

---

### Task 16: Documentation

**Files:**
- Modify: `README.md`, `docs/RUNBOOK.md`, `FRICTION-LOG.md`

**Interfaces:**
- Consumes: everything Plan 3 built.
- Produces: a README whose "Not yet built" list no longer claims the simulator does not exist, a runbook section that takes somebody from a clean checkout to a working display, and a friction log whose Plan 3 entries are all filed.

- [ ] **Step 1: Replace the README's simulator bullet**

In `README.md`'s "Simulated data disclosure" section, delete the "The Echo Show simulator" bullet from **Not yet built** and add a section after "Talking to HomeLedger from Claude Code":

```markdown
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
```

- [ ] **Step 2: Add a runbook section**

Insert into `docs/RUNBOOK.md` after section 4 ("Fifteen minutes, no AWS account") as **4.6 Talk to it from the simulator**:

```markdown
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
```

Also correct `docs/RUNBOOK.md` §2 ("Status at a glance") wherever it says the simulator does not exist, and §13's verified/not-verified lists: add the Playwright suite under executed, and the deployed simulator run under whichever list Task 15 Step 7 actually put it in.

- [ ] **Step 3: Check the friction log is complete, and that no number was used twice**

```bash
grep -n '^### FL-' FRICTION-LOG.md | tail -6
grep -o '^### FL-[0-9]\+' FRICTION-LOG.md | sort | uniq -d
```
Expected: **FL-041 onwards** exist for every deviation this plan hit, each with all six fields — at minimum the widget snapshot-origin entry (Task 14) and the deployed-run entry (Task 15, Step 7) — and the second command prints **nothing**. A duplicate number is the one failure in this file that no test catches and that a later reader cannot untangle, which is exactly what the draft of this plan would have produced: it prescribed FL-040 verbatim, and FL-040 was taken by PR #14's `Intl`/ICU entry between the plan being written and being run. Any task that hit a documented-behaviour deviation and filed nothing is a gap — file it now, with the evidence its commit carries.

- [ ] **Step 4: Check the file manifest against the tree**

The plan's file-structure block names every file this plan creates, and every task's **Files → Create** list names its own. They are checked here because the draft of this plan disagreed with itself in both directions at once: `ProgressMeter.tsx` and `FailureCard.tsx` were declared and never created (their code lived inside other components), while `http.ts`, `transcript.ts`, `failures.ts`, `scripted-model.ts` and three route files were created and never declared.

```bash
# Every source file that exists, against the structure block.
find apps/simulator/src apps/simulator/test -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) | sort
```
Read that list against the block at the top of this plan. Every line must appear there, and every entry there must appear in the list. A file in one and not the other is either a missing implementation or a stale manifest; fix whichever is wrong, and if the split turns out to be the wrong call, change the structure block and say why in the commit body rather than leaving the two disagreeing.

- [ ] **Step 5: Final verification across the repo**

```bash
docker compose up -d
pnpm install --frozen-lockfile
pnpm --filter @homeledger/core build
pnpm --filter @homeledger/mcp-bridge build
pnpm --filter @homeledger/mcp-server build
pnpm format
pnpm typecheck
pnpm test
pnpm --filter @homeledger/core test:dynamo
pnpm build
cd infra && terraform fmt -check -recursive && cd ..
docker compose down
```
Expected: every command exits 0. Do not run `terraform plan` or `terraform apply`. Do not deploy.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/RUNBOOK.md FRICTION-LOG.md
git commit -m "docs: the simulator, how to run it, and where its secrets live"
```

---

## Self-review

**1. Spec coverage.**

| Spec section | Requirement | Task |
|---|---|---|
| 2 (visual foundations row) | 768 × 480 base canvas, 1.667 scale, dark `#14181E` / `#1B2028`, light `#FFFFFF` / `#FAF9FB` | 1 (tokens), 10 (canvas and scale) |
| 2 (functional requirements row) | No JSON in spoken text, never more than five options, sub-3-second tools | 7 (prompt), 8 (five-option guard **and its test**, Step 1), 13 (drawer timings), 15 (deployed run) |
| 3 `apps/simulator` | Next.js Echo Show simulation, agent, MCP Apps host, debug drawer | 1, 8, 14, 13 |
| 4.2 | The same nine tools, read from `tools/list` in the server's frozen order | 6 (list), 8 (loop), 13 (drawer) |
| 4.2 (*Time rendering*) | "Today" is the household's day, not `now().slice(0, 10)` | 9 (`todayInZone` + the household zone on `Conversation`) |
| 4.4 | Widgets as single HTML files with `hostContext`, 768 × 480, theme-aware | 14 |
| 4.5 | The simulator obtains and caches the Cognito token **server-side** | 2, 6 |
| 7 | Frame, dark default with light toggle, transcript, text input | 10, 11 |
| 7 | **Ambient home screen** | **Not covered.** Out of scope, argued: its content is proactive and the push channel that would feed it is Plan 4's, so an ambient screen built now is a static panel. |
| 7 | `McpClient` over `StreamableHTTPClientTransport` with the Cognito bearer | 6 |
| 7 | `elicitationCallback` renders a choice card (≤5) or a confirm card; the card's answer resolves the callback | 4, 8, 12 |
| 7 | A transport wrapper taps notifications for the debug drawer | 6 (the `fetch` tap and the `onprogress` / `onElicit` taps, all three feeding `jsonRpcLog`), 13 (the drawer renders it) |
| 7 | System prompt carries the persona rules | 7 |
| 7 | MCP Apps host renders `ui://` resources in a sandboxed iframe with a display-shaped `hostContext` | 14 |
| 7 | Debug drawer: **live JSON-RPC log**, **protocol version**, session id, timing per call | 13 (all four; the log and the version come from Task 6's tap and transport) |
| 9 | End-to-end (Playwright): ask → card; booking with elicitation | 15 |
| 10 | Simulated-data and simulated-experience disclosure | 10 (in the UI), 16 (in the README) |

**Deliberately not covered, each with a reason stated above:** the Strands-on-Bedrock agent (Deviations §1 — the account block), Amplify hosting (Deviations §2 — a hosted endpoint holding an API key is its own security decision), the ambient home screen (Out of scope — it needs Plan 4's push channel to be anything but a static panel), the proactive WebSocket channel and the Ring pipeline (Out of scope — they belong to Plan 4), Web Speech (spec §1 lists it as optional and never required).

Two rows of this table were false in the draft of this plan and are worth naming rather than silently correcting: the debug drawer row claimed the protocol log and the protocol version, and the transport-wrapper row claimed a notification tap, when the only notification observed was `onprogress` and it went to the transcript's progress meter rather than to the drawer. Both are now real. A coverage table is the one place in a plan where a wrong entry is worse than a missing one, because it is read as evidence that somebody checked.

**2. Placeholder scan.** No "TBD", "implement later", "add appropriate error handling", or "similar to Task N". Every code step carries complete code. The six places where an installed API could differ from what was read out of `node_modules` each name the exact file to check and the exact alternative to write, with the consequence stated: `StreamableHTTPClientTransportOptions.fetch` and `RequestOptions.onprogress` (Task 6, Step 1); `MessageCreateParams.thinking` / `output_config` (Task 7, Step 1); `StreamableHTTPClientTransport.reconnectionOptions` swallowing the 404 the rebuild test needs, the shape a 401 takes when the transport wraps it, and `transport.protocolVersion` as the place the negotiated version is exposed (all three in Task 6, Step 5). Each of the last three says what **not** to do if the installed SDK differs — do not widen the predicate to "any error", do not fall back to a version constant — because the tempting workaround in both cases produces something that looks like it works.

**3. Type consistency.** `TurnEvent` is the same union in `src/shared/events.ts`, in `agent.ts`'s `emit`, in `http.ts`'s `encodeSse`, and in `transcript.ts`'s reducer — including `tool-succeeded`'s `content`, which `readToolResult` fills, `runOneCall` emits, `reduceTurn` stores on the entry, and `WidgetFrame` pushes to the widget, so the field has a producer at every hop rather than a `null` at the last one. `ElicitationAnswer` is `{ action: 'accept'; content } | { action: 'decline' } | { action: 'cancel' }` in `elicitation.ts`, in `mcp.ts`'s `onElicit`, in `agent.ts`'s `askThePerson`, and in `http.ts`'s `readAnswer`. `McpToolDescriptor` is `{ name, description?, inputSchema, _meta? }` in `tools.ts`, in `mcp.ts`'s `toDescriptors`, in `agent.ts`'s `TurnDeps`, and in `session.ts`'s `Conversation`. `PendingQuestion` carries `elicitationId, callId, prompt, field, kind, options` in `transcript.ts` and in `ElicitationCard`'s props. `AnswerOutcome` is `'delivered' | 'unknown-turn' | 'unknown-question'` in `elicitation.ts` and is the only thing `handleAnswer` branches on. `DebugSnapshot` is field-for-field what `handleDebug` serialises.

**Values that must not be written down twice, and where the single copy lives.** `768 × 480` and `1.667` live in `src/shared/canvas.ts` and nowhere else: `Frame.tsx` imports them, `widget-host.ts`'s `hostContextFor` imports them, `globals.css` declares no canvas variables at all, and `DEVICE`'s 1280 × 800 is computed from them. Task 10's mutation 7 changes the constant once and requires **two** suites to fail, which is the only evidence that "imported" is true rather than intended. (The draft of this plan asserted in this very paragraph that "`HostContext`'s `maxWidth`/`maxHeight` are `BASE_CANVAS`'s 768/480" while they were three independent literals — CSS variables in Task 1, a `const` in Task 10, bare numbers in Task 14. Nothing would have caught it, because each was individually correct.) The same rule, applied to the rest: the decline sentence `"Okay, I haven't booked anything."` lives in `apps/mcp-server/src/tools/service.ts` and is quoted in tests only; `NOTHING_RETRIEVED` and `NO_DATA_NOTICE` are each exported from one module and asserted through the export; `VOICE_MAX_ITEMS` is the only `5`; `WIDGET_PROTOCOL_VERSION` is the only `'2026-01-26'`; `SEED_TIMEZONE` is imported from `@homeledger/core` and never spelled as `'America/Chicago'` outside a test that is asserting the seeded value itself.

**Paths and names.** The route paths `/api/agent/turn`, `/api/agent/answer`, `/api/debug`, `/api/widget`, `/api/widget/tool` are identical in the route files, in `useAgentTurn`, in `WidgetFrame`, in `page.tsx`, in the Playwright config's health check, and in the README. The environment names `ANTHROPIC_API_KEY`, `HOMELEDGER_SIMULATOR_MODEL`, `HOMELEDGER_SIMULATOR_MAX_ROUNDS`, `HOMELEDGER_SIMULATOR_ELICITATION_TIMEOUT_MS`, `HOMELEDGER_SIMULATOR_ALLOW_ORIGIN`, `HOMELEDGER_SIMULATOR_SCRIPTED_MODEL` and `HOMELEDGER_MCP_URL` are identical in `env.ts`, `session.ts`, `credentials.ts`, `.env.example`, `playwright.config.ts`, the README and the runbook. Port 3000 appears in `dev` and `start`; port 3100 appears in `dev:e2e` and in the Playwright config, and in no third place — the `-- -p 3100` override that produced `next dev -p 3000 -p 3100` is gone.

**4. Where this plan knows it is thin.** Six things, each named at the mutation step that failed to cover it rather than left to be discovered.

Reachable only by the deployed run in Task 15, Step 7: the **per-request bearer token** (Task 6, mutation 4 — the local server ignores the header); the **session rebuild reported on a failing call** (Task 8, mutation 9 — the local server never loses a session on the way to a failure); and **`ask_manual`'s real refusal shape**, which the local server cannot produce because it serves fixtures. That is why Step 7 is a checklist with expected outputs rather than a sentence saying "then test it".

Not reachable anywhere: the **`content` half of the MCP Apps tool-result payload** (Task 14, mutation 10). jsdom does not run a `srcDoc` iframe's script and all four widgets this server ships read `structuredContent`, so nothing asserts that `content` arrives *inside* a widget. What is asserted is that it is read from the result, carried through the event and the entry, and passed rather than nulled — which is the difference between a field with a producer and a field with a placeholder.

Unproven ordering: the precedence of `isUnauthorizedError` over `isLostSessionError` in `HomeLedgerMcp.attempt` (Task 6, mutation 7). The two predicates do not overlap on anything this server produces, so swapping them fails nothing. The order is kept because an endpoint that answers `404 Unauthorized` is exactly the overlap it guards, and it is recorded as unproven rather than presented as tested.

Unverified wiring: `session.ts` passing `invalidateToken` and `resolveUrl` into `HomeLedgerMcp` (Task 9, mutation 10). Both functions are proven in Task 6 against fakes; that they are actually connected in `build()` is checked by reading, because the only test that could check it would need to reach the deployed runtime.

## What Plan 4 starts from

A working display in front of the deployed server. Concretely, Plan 4 (Ring) inherits:

- **A place to put a proactive card.** `TurnEvent` is a closed union and the transcript reducer is a pure function over it; a `visit.arrived` or `alert.raised` push becomes one more member and one more `case`, with no change to the stream, the routes, or the agent loop. The spec's design — push carries `{cardType, recordId}`, the simulator injects a system turn, the agent calls `get_visit` — needs a channel into the process holding the conversation, and `session.ts` is where that conversation lives.
- **The visit widget already hosted.** `ui://homeledger/visit` renders today with `snapshotUrl` and `description` null. When the Ring pipeline fills them, the widget shows them with no simulator change — **except** the image origin, which is FL-041 and is written down with both candidate fixes and the reason the proxy is likelier.
- **An MCP client that survives a 30-minute idle gap**, which matters more for a proactive surface than for a conversational one: a display waiting for a doorbell press is idle by definition, and FL-039's failure is exactly what an idle display would hit first.
- **A failure vocabulary that does not lie.** `explainFailure` and `NO_DATA_NOTICE` are the two places a new failure mode gets a sentence, and both are tested against the specific wrong answer this project has already produced twice.

