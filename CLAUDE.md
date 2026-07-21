## Project

EZCorp — a self-hosted AI platform for multi-model chat with persistent memory and an extension ecosystem.

**Goals:**
- **Extensibility** — user-built extensions for custom UI, tools, and interactions
- **Security** — RBAC and per-tool-call permissions for LLM actions
- **Reliability** — safe migrations, durable storage, single-container deploy

**Stack & layout:**
- `src/` — Bun backend: runtime executor + built-in tools, providers, auth/RBAC, db, extension host
- `web/` — SvelteKit frontend (Svelte 5 runes, Vite, Tailwind 4) — see `web/CLAUDE.md`
- `packages/@ezcorp/` — bun workspaces: `sdk` (extension authoring), `ai-kit` (LLM-driver integration kit), `harness-client` (remote-control client)
- `extensions/` — first-party **bundled** extensions (git-tracked, registered in `src/extensions/bundled.ts`); `docs/extensions/examples/*/` holds the reference extensions — see `src/extensions/CLAUDE.md`
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
<script>`, `bunx <pkg>`. Bun auto-loads `.env` — don't use dotenv.

Don't add replaced deps:
- `Bun.serve()` (WebSockets/HTTPS/routes built in) — no `express`, no `ws`
- PGlite embedded + `Bun.sql` for external Postgres — no `pg`/`postgres.js`/`bun:sqlite`/`better-sqlite3`
- `Bun.redis` if Redis is ever introduced (none today) — no `ioredis`
- Prefer `Bun.file` over `node:fs` read/write; Bun.$`cmd` over execa

## Testing

Three runners; use the wrapper scripts, not raw `bun test` at the root.

- **Backend (`src/`)** — `bun run test` → `scripts/test.sh`, one isolated bun
  process PER FILE. **Never bare `bun test` at the repo root** — globbing the
  full backend pool into one process deadlocks on cross-file `mock.module()`
  contamination (it hangs, not fails). Targeted single-file runs
  (`bun test src/__tests__/foo.test.ts`) are fine.
- **Web** — plain unit tests: `scripts/test-web.sh`; Svelte component/server
  tests: Vitest, the one sanctioned Vitest surface (details: `web/CLAUDE.md`).
- **E2E** — Playwright in `web/e2e/`: `bun run test:e2e` (mock tier); real
  tier `web/playwright.real.config.ts` + `PI_E2E_REAL=1`.
- **Coverage** — `bun run test:coverage` → sharded bun coverage + package legs
  + a Node-run Vitest leg, merged into `coverage/lcov.info` and gated against
  `coverage-thresholds.json`.

Write backend/unit tests with `bun:test`. Lint and typecheck are separate:
`bun run lint` (biome) and `bun run typecheck`.

## Binding invariants (digest)

Full rules live in the linked docs and nested CLAUDE.md files; these are the
ones that break things silently if missed:

- **Session tree** — never mutate `parentMessageId`
  ([chat/rewind-branching-sessions.md](docs/features/chat/rewind-branching-sessions.md)).
- **Context compaction is input-only** — never mutate `model.maxTokens` or
  clone the model to "save context"; trim input only, `responseReserve` is
  never written back ([docs/context-compaction.md](docs/context-compaction.md)).
- **Mention/command/feature expansion is literal** — the raw token is
  persisted, expanded text is never re-parsed for other mention kinds, unknown
  targets are silent no-ops
  ([composer/mention-grammar.md](docs/features/composer/mention-grammar.md),
  [docs/slash-commands.md](docs/slash-commands.md)).
- **Extensions** — state only under `<projectRoot>/.ezcorp/extension-data/<name>/`;
  `.ezcorp/data` is never reachable from a sandbox; host-side loggers only via
  `extensionLogger()` (`src/extensions/CLAUDE.md`).
- **API surface** — every new `/api/*` route registers in `src/api-registry.ts`
  with a scope; `/api/__test/**` routes gate on fail-closed
  `isTestSurfaceEnabled()`; new runtime event names go ONLY in
  `web/src/lib/runtime-event-names.ts`
  ([docs/harness-contract.md](docs/harness-contract.md), details: `web/CLAUDE.md`).

## Where to look

Canonical subsystem index: [docs/features/README.md](docs/features/README.md)
(50+ docs, each with a "Key files" section). Read the matching doc before
touching a subsystem:

| Working on | Read first |
|---|---|
| `web/` frontend, components, composer UI, e2e | `web/CLAUDE.md` |
| `src/extensions/` host, extension authoring | `src/extensions/CLAUDE.md` |
| DB & migrations (Drizzle, `src/db/`) | [platform/database-and-migrations.md](docs/features/platform/database-and-migrations.md) |
| Auth, RBAC, permission modes (`src/auth/`) | [platform/rbac-and-permission-modes.md](docs/features/platform/rbac-and-permission-modes.md) |
| Streaming runtime & runs (`src/runtime/`) | [chat/streaming-runtime.md](docs/features/chat/streaming-runtime.md) |
| Providers, routing, failover (`src/providers/`) | [docs/llm-routing-and-failover.md](docs/llm-routing-and-failover.md) |
| Memory & knowledge base (`src/memory/`) | [chat/persistent-memory.md](docs/features/chat/persistent-memory.md) |
| Session tree, rewind/branching (`src/db/session-*`) | [chat/rewind-branching-sessions.md](docs/features/chat/rewind-branching-sessions.md) |
| Context compaction (`src/runtime/stream-chat/`) | [docs/context-compaction.md](docs/context-compaction.md) |
| Mentions, slash commands, suggestions (`src/suggest/`), EZ actions | [composer/](docs/features/composer/) |
| Orchestration: agents/teams/modes/workflows | [orchestration/](docs/features/orchestration/) |
| Hub, marketplace, loops/webhooks/scheduling | [extensions/](docs/features/extensions/) |
| Remote control & test surfaces | [docs/harness-contract.md](docs/harness-contract.md) |
| Settings / observability / audit | [platform/](docs/features/platform/) |
| Deploy & releases | [platform/deployment-and-releases.md](docs/features/platform/deployment-and-releases.md) |
