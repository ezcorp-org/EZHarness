## Project

EZCorp — a self-hosted AI platform for multi-model chat with persistent memory and an extension ecosystem.

**Goals:**
- **Extensibility** — user-built extensions for custom UI, tools, and interactions
- **Security** — RBAC and per-tool-call permissions for LLM actions
- **Reliability** — safe migrations, durable storage, single-container deploy

**Stack & layout:**
- `src/` — Bun backend: runtime executor + built-in tools, providers, auth/RBAC, db, extension host
- `web/` — SvelteKit frontend (Svelte 5 runes, Vite, Tailwind 4; prod served via `svelte-adapter-bun`)
- `packages/@ezcorp/` — bun workspaces: `sdk` (extension authoring), `ai-kit` (LLM-driver integration kit), `harness-client` (remote-control client)
- `extensions/` — first-party **bundled** extensions (git-tracked, registered in `src/extensions/bundled.ts`); `docs/extensions/examples/*/` holds the reference extensions, several also bundled
- `worker/` — Cloudflare Workers deploy target (LLM-only agents reusing `src/runtime/executor` with stubbed shell/file providers)
- Database: PGlite embedded by default; external Postgres via `DATABASE_URL` (`Bun.sql`)

---

## Development lifecycle (binding)

Trunk-based: branch off `main` (`feat/ fix/ ci/ docs/ chore/ security/`), open a
PR, land all required checks green + a non-author review, squash-merge to `main`
(always deployable), release via an `app-vX.Y.Z` tag. Full spec (including the
complete required-check table): [docs/development-lifecycle.md](docs/development-lifecycle.md).

**Feature contract — every feature you ship MUST:**
1. Cover each **new source file** to its threshold (default **100%**) and add a
   key to `scripts/coverage-thresholds.json` (or a justified `EXCLUDES` entry in
   `scripts/coverage-config.ts`).
2. Cover **every new/changed executable line** (patch-coverage gate).
3. Add/update a **Playwright e2e spec** under `web/e2e/` for user-facing behavior.
4. For a **frontend-visual change** (route/layout pages, `web/src/lib/components/**`,
   css), ship an `@evidence`-tagged Playwright e2e spec under `web/e2e/` that
   calls `captureEvidence(page, testInfo, label)`. The `Visual evidence` CI gate
   enforces a spec is present and the bot attaches screenshots to the PR.
5. **Never** weaken the gate or fake green — no lowered thresholds, no new
   `EXCLUDES`, no `.skip/.only/.todo`, no assertion-free tests, no empty
   `catch {}` in test files, no committed `coverage/lcov.info`. These are
   blocked by the `Gate integrity` CI check; a maintainer-only
   `gate-change-approved` label is the only bypass (you cannot apply it).

The gate files (`scripts/coverage-*.ts`, `coverage-thresholds.json`, CI
workflows, `playwright.config.ts`) are CODEOWNERS-owned — changing them needs
human review. Verify locally before pushing:
`bun run typecheck && bun run lint && bun run test && bun run test:coverage`.

**Worktree isolation (binding):** ALWAYS run agents in a separate git
worktree — never let a spawned agent edit the primary working directory
directly. Before delegating work, create an isolated worktree on its own
branch (`git worktree add ../ez-corp-ai-<slug> -b <branch>`), point the
agent at that path, and have it do all reads/writes/commits there. This
keeps parallel agents from contaminating each other or the main tree, and
keeps `main` clean. When using the Agent/Workflow tools, pass
`isolation: "worktree"` so each agent gets its own worktree automatically.
Notes: `tasks/` is gitignored and does NOT propagate to a fresh worktree —
copy any planning docs over after `git worktree add`; and dev-container
compose mounts resolve relative paths from the compose CWD, so recreate the
container from the worktree dir if it must serve worktree edits.

---

## Bun

Default to Bun instead of Node.js: `bun <file>`, `bun install`, `bun run
<script>`, `bunx <pkg>`. Bun auto-loads `.env` — don't use dotenv. For tests
see **Testing** below (never bare `bun test` at the repo root; Svelte
component/server tests are the one sanctioned Vitest surface — don't add
Vitest anywhere else).

APIs — don't add replaced deps:
- `Bun.serve()` (WebSockets/HTTPS/routes built in) — no `express`, no `ws`
- PGlite embedded + `Bun.sql` for external Postgres — no `pg`/`postgres.js`/`bun:sqlite`/`better-sqlite3`
- `Bun.redis` if Redis is ever introduced (none today) — no `ioredis`
- Prefer `Bun.file` over `node:fs` read/write; Bun.$`cmd` over execa

## Subsystem map

The canonical subsystem reference is
[docs/features/README.md](docs/features/README.md) (50+ per-feature docs, each
with a "Key files" section). Read the matching feature doc before touching a
subsystem. Orientation:

**Platform**
- **Database & migrations** — Drizzle ORM: `src/db/` (`schema.ts`, `migrate.ts`,
  `migrations/`) · [platform/database-and-migrations.md](docs/features/platform/database-and-migrations.md)
- **Auth, RBAC & permission modes** — `src/auth/` (JWT, API keys, middleware,
  extension RBAC, OAuth) · [platform/rbac-and-permission-modes.md](docs/features/platform/rbac-and-permission-modes.md)
- **Settings** — `(app)/settings` + `/api/settings` · [platform/settings-system.md](docs/features/platform/settings-system.md)
- **Observability & audit** — `src/observability/` · [platform/audit-and-observability.md](docs/features/platform/audit-and-observability.md)
- **Deploy & releases** — `compose.prod.yml` (prod), `docker-compose.yml` (dev
  HMR, Linux-only), `app-vX.Y.Z` tags · [platform/deployment-and-releases.md](docs/features/platform/deployment-and-releases.md)

**Chat**
- **Streaming runtime & runs** — `src/runtime/`; `AgentExecutor.streamChat` →
  EventBus → SSE · [chat/streaming-runtime.md](docs/features/chat/streaming-runtime.md)
- **Providers & routing/failover** — `src/providers/`: layered credentials
  (OAuth/BYOK/env), fused model registry · [docs/llm-routing-and-failover.md](docs/llm-routing-and-failover.md)
- **Memory & knowledge base** — `src/memory/` (embeddings, chunking, retrieval,
  injection; pgvector) · [chat/persistent-memory.md](docs/features/chat/persistent-memory.md)
- **Session tree (rewind/branch/A-B retry)** — `src/db/session-*.ts` (pi
  session-tree). Invariant: never mutate `parentMessageId` ·
  [chat/rewind-branching-sessions.md](docs/features/chat/rewind-branching-sessions.md)

**Orchestration** — agents, teams, modes, workflows/pipelines: `src/agents/` +
`(app)/{agents,active-agents,workflows,pipelines}` routes · [orchestration/](docs/features/orchestration/)

**Composer** — mention grammar (below), suggestions (`src/suggest/`,
`/api/composer/suggest`), EZ concierge & runtime actions (`/api/ez`, `/api/ez-actions`;
`read_page`/`fill_form`/`navigate_to`) · [composer/](docs/features/composer/)

**Extensions** — next section; hub/marketplace docs under
[extensions/](docs/features/extensions/) (hub-pages, marketplace, bundled-catalog).

## Extension system

Host side is `src/extensions/`; the authoring surface is `@ezcorp/sdk`
(`defineExtension` + runtime helpers).

- **Sandbox & isolation** — tiered sandboxes (bwrap › landlock › advisory); the
  SDK poisons `node:fs`/`Bun.file` at load, so ALL extension IO goes through
  host-mediated reverse-RPC handlers (`src/extensions/*-handler.ts`).
  Invariant: `.ezcorp/data` is never reachable from a sandbox ·
  [extensions/sandbox-and-isolation.md](docs/features/extensions/sandbox-and-isolation.md)
- **Permissions & ceilings** — `clamp-permissions.ts`, `permission-engine.ts`,
  install-time grants; `bundled-ceiling.ts` hard-caps bundled extensions.
- **Scheduling, loops & webhooks** — cron/schedule daemons, `defineLoop`
  (approvals, provenance-checked registration, global kill switch),
  `WebhookDeliveryDaemon` behind public `POST /api/hooks/:extensionId/:slug` ·
  [extensions/scheduling-and-loops.md](docs/features/extensions/scheduling-and-loops.md)
- **Hub pages** — extensions push live dashboards (`pushPage` → page-schema /
  panel-validator / page-cache, `web/src/lib/server/hub-extension-pages.ts`).
- **Install/registry/manifest** — `installer.ts`, `registry.ts`, `manifest.ts`,
  `bundled.ts`, `dependency-resolver.ts`.

### Extension data

Every extension — bundled (`extensions/*`) or example
(`docs/extensions/examples/*/`) — stores its persistent user-visible state
under `<projectRoot>/.ezcorp/extension-data/<extension-name>/`. When reading or
writing extension-managed files (task stores, note vaults, config json, etc.),
always use that path. The `.ezcorp/` directory is gitignored. See
`docs/extensions/data-storage.md` for the full convention.

### Extension logging

Host-side extension code (integration daemons, reverse-RPC handlers, spawn
bridges) MUST get its logger from `extensionLogger(name, component?)` in
`src/logger.ts` — never `logger.child(...)` directly — so every extension log
lands under the `ext.<name>[.<component>]` subsystem namespace. That lets an
operator raise debug for one extension via `EZCORP_DEBUG=ext.<name>` (or all
extensions via `EZCORP_DEBUG=ext`, everything via `EZCORP_DEBUG=1`) without the
global `LOG_LEVEL=debug` firehose. Default-visible `info` should carry
once-per-cycle summaries; `debug` carries per-item detail; never log secret/token
plaintext. See `docs/extensions/logging.md` for the full convention.

## Mention grammar

The chat composer supports five mention sigils — all five share one
pure-logic module at `web/src/lib/mention-logic.ts`, and the single
`/api/mentions/search` endpoint routes on a `type=` query parameter.

| Sigil | Kind(s) | Token format | Source |
|---|---|---|---|
| `!` | `agent`, `ext`, `team`, `EZ` | `![kind:name]` | DB (`agentConfigs`, `extensions`) + executor's in-memory map + EZ-action registry + built-in tool categories |
| `@` | `file`, `dir` | `@[kind:relpath]` | Active project's filesystem (symlink-escape filtered) |
| `/` | `cmd` | `/[cmd:name]` | `.claude/{commands,agents}`, `.codex/prompts`, `agents/` (project + home) + `user_commands` DB table |
| `$` | `feature` | `$[feature:name]` | DB (`features` table, scoped to active project) |
| `%` | `lesson` | `%[lesson:slug]` | DB (`lessons` table, scoped to user + project, visibility-filtered) |

The `!` sigil also nests tool autocomplete: `![ext:<name>/` lists that
extension's tools (`type=tool`). The `EZ` kind (`![EZ:name]`,
case-insensitive) is stripped pre-prompt by `stripEzActionTokens` and invokes
a code-defined runtime action instead of being shown to the LLM. Lesson
mentions expand server-side via `applyLessonExpansion`. Full reference:
[docs/features/composer/](docs/features/composer/mention-grammar.md).

Slash commands (discovery gated by `EZCORP_SCAN_GLOBAL_COMMANDS`, default on)
and feature mentions both expand server-side in `src/runtime/mention-wiring.ts`
(`applyCommandExpansion` / `applyFeatureExpansion`): the raw token is
persisted; the LLM sees the substituted body (for `$[feature:]`, a system note
with the description + plain-text file paths — NOT `@[file:…]` tokens, no
double-expansion). Expansion is **literal** — never re-parse expanded text for
other mention kinds. Unknown/deleted features are silent no-ops, mirroring
`@[file:…]` for missing files. Specs: [docs/slash-commands.md](docs/slash-commands.md),
[docs/plans/2026-05-01-feature-index-design.md](docs/plans/2026-05-01-feature-index-design.md).

## Context compaction

Conversation history is trimmed per-model before every LLM call via
pi-agent-core's `transformContext` hook, wired in
`src/runtime/stream-chat/build-pi-agent.ts` and configured from
`src/runtime/stream-chat/context-compaction.ts`. It is a swappable
strategy (`trim` default, `summarize` for an LLM condense that fails open
to `trim`, `none` to disable) selected by the `compaction:strategy`
setting; the `compaction:` namespace also holds byte-stable trim anchoring
for Anthropic prompt-cache hits (`cacheAnchorFraction`, default off),
cache-retention TTL (`cacheRetention`), and summarizer routing
(`summarizeModel`/`summarizeMaxTokens`).

**Invariant — input-only:** never mutate `model.maxTokens` (or clone
the model) to "save context". For the Codex API that field is metadata
only (no `max_output_tokens` is sent); for other providers pi-ai
already derives the output cap from it, so shrinking it truncates
output. Trim **input** only; `responseReserve` sizes the budget and is
never written back. See
[docs/context-compaction.md](docs/context-compaction.md) for the full
spec, settings keys, and how to add a custom strategy.

## Remote testability contract

The app is remotely controllable + deterministically testable by external
harnesses, and new features must keep it that way. A CI meta-test
(`web/src/__tests__/route-contract.test.ts`) enforces the rules; see
[docs/harness-contract.md](docs/harness-contract.md) for the full spec.

- **New `/api/*` route** → register it in `src/api-registry.ts` with a `scope`
  (`read`/`chat`/`extensions`/`admin`/`public`). It then documents itself and
  appears in the generated OpenAPI spec (`src/openapi.ts`). The meta-test
  ratchets the unregistered-route count — a new unregistered route fails. It
  also enforces admin scope↔role pairing and controllable↔harness-client
  route parity.
- **New `/api/__test/**` route** (determinism tier) → gate it with
  `isTestSurfaceEnabled()` from `$lib/server/test-surface`. The gate is
  fail-CLOSED: it returns 404 unless **all three** of
  `EZCORP_ALLOW_TEST_SURFACE=1` (conscious operator opt-in), `PI_E2E_REAL=1`,
  and a non-production `NODE_ENV` hold. The meta-test fails any ungated one.
- **New client-facing runtime event** → add it to the single canonical list
  `web/src/lib/runtime-event-names.ts` (the SSE `BUS_EVENTS` and `ws.ts`'s
  `WSRunEvent` both derive from it). Never re-list event names elsewhere.
- **Cold-start auth** is `ezcorp key mint` (CLI, no UI). The control tier is
  scope-gated and works in production; the determinism tier never does.
- External harnesses use the `@ezcorp/harness-client` package
  (`packages/@ezcorp/harness-client`) — extend it (not ad-hoc fetch) when
  adding a `harness: { controllable: true }` route.

## Testing

Three runners; use the wrapper scripts, not raw `bun test` at the root.

- **Backend (`src/`)** — `bun run test` → `scripts/test.sh`, one isolated bun
  process PER FILE. **Never bare `bun test` at the repo root** — globbing the
  full backend pool into one process deadlocks on cross-file `mock.module()`
  contamination (it hangs, not fails). Targeted single-file runs
  (`bun test src/__tests__/foo.test.ts`) are fine.
- **Web** — plain unit tests: `scripts/test-web.sh` (the "bun-leg orphans"
  pool). Svelte component/server-route/`*.unit.` tests run under **Vitest**
  (`bun run --cwd web test:component`) — Svelte 5 files need the Svelte
  compiler at import, which bun lacks.
- **E2E** — Playwright in `web/e2e/`: `bun run test:e2e` (mock tier); the
  real-auth/real-DB tier is `web/playwright.real.config.ts` + `PI_E2E_REAL=1`.
- **Coverage** — `bun run test:coverage` → sharded bun coverage +
  SDK/harness-client/ai-kit legs + a Node-run Vitest leg, merged into
  `coverage/lcov.info` and gated against `coverage-thresholds.json`.

Write backend/unit tests with `bun:test`. Lint and typecheck are separate:
`bun run lint` (biome) and `bun run typecheck`.

## Frontend

SvelteKit in `web/` — Svelte 5 (runes), Vite, Tailwind 4; routes under
`web/src/routes/**/+page.svelte`, prod via `svelte-adapter-bun`, dev via
`vite dev` (the `docker-compose.yml` dev container runs it with HMR). No
React; no Bun HTML-imports pattern — `Bun.serve()` is the backend's server,
not the frontend build.
