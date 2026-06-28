# Handoff — Extension logging standard + EZCORP_DEBUG + github-projects per-board default model

**Date:** 2026-06-28 · **Branch:** `feat/gh-ext-logging-and-default-model`
**Commits:** `275f1669` (features) + `55fe7a43` (polish) · **NOT pushed, no PR.**
**Base:** branched off `feat/extension-hub-project-route` @ `fac1165b` (carrying its lineage:
`feat/extension-secrets` → `feat/github-projects`). Branched onto its own branch to keep this
work isolated from the concurrent hub-route agent.

Read this before touching the code. Everything below is **landed + gate-green** on the branch.

---

## 1. Status at a glance

- Two features shipped + validated this session, plus two review-flagged polish fixes.
- **Gate green:** `bun run typecheck` ✓, `bun run lint` ✓ (0 errors in changed files),
  all touched suites pass isolated, changed source files at **100% lines**, e2e `@evidence`
  present, no gate-weakening (no `.skip/.only`, no threshold edits, no new EXCLUDES).
- **Validated three ways** (sub-agent teams): adversarial code review (no Critical/High),
  full gate run, and **live** against the running dev container.
- Two clean commits, working tree clean, build worktree removed.

---

## 2. What shipped

### A. Extension logging standard + `EZCORP_DEBUG` toggle  (`src/logger.ts`)
The reusable convention every extension's host-side code follows.
- **`extensionLogger(name, component?)`** → `ext.<name>[.<component>]` subsystem namespace.
  github-projects adopted it: `ext.github-projects.daemon` / `.handler` / `.spawn`.
- **`EZCORP_DEBUG`** per-subsystem debug override (read per-emit; only RAISES verbosity):
  unset→off; `1|true|*|all`→all; comma list matches a subsystem **exactly OR under the
  `entry + "."` boundary** (so `ext` lights up all `ext.*` but NOT `ext-other`;
  `ext.github-projects` lights up the whole feature). Lets an operator debug one extension
  without the global `LOG_LEVEL=debug` firehose.
- **Daemon observability** (`src/integrations/github-projects/daemon.ts`): one default-visible
  INFO **"github-projects poll sweep"** summary per sweep (`{enabledLinks,due,fetched,triggers,
  newProposals,autoSpawned,degraded}`, only when ≥1 enabled link) via `runPoll`/`pollLink`
  returning a `LinkPollResult`; per-link + per-trigger DEBUG; enriched degrade warns
  (`projectId`+`authMode`, never the token); `wake loop armed` + `poll-now` logs.
- Docs: `docs/extensions/logging.md` + a CLAUDE.md "Extension logging" section.

### B. github-projects per-board default model
Fixes the auto-run dying with **"No credentials available for anthropic"** — the spawn
called `streamChat` with no model, falling back to the `anthropic`-first preference order.
- **`default_model TEXT` column** on `github_projects_links` (`src/db/schema.ts` Drizzle
  mirror + `src/db/migrate.ts` `ALTER … ADD COLUMN IF NOT EXISTS`, mirroring the
  `status_options` precedent). Value = `"<provider>:<model>"`; null = instance default.
- **`spawn.ts`**: pure `parseDefaultModel(raw)` splits on the **FIRST** `:` (so
  `ollama:gemma4:e2b` → `{provider:"ollama", model:"gemma4:e2b"}`); `approveProposal` threads
  `{provider,model}` into `streamChat` only when set (the executor already accepts them —
  `src/runtime/executor.ts`). The existing `agentConfigId`/`permissionMode`/`runId` path is
  untouched.
- **Connect page** (`web/.../integrations/github-projects/+page.svelte`): a `<select
  data-testid="gh-projects-default-model">` populated from `GET /api/models` (filtered to
  `available:true`), first option "— Use instance default —", sent on Save (PATCH).
- Threaded through `LinkUpdatePatch`/`upsertLink` (`src/db/queries/github-projects.ts`),
  `publicLinkView` + the link/connect routes.

### C. Polish (commit `55fe7a43`)
- **DRY'd the validator:** single exported `parseDefaultModelInput()` in the routes'
  `_shared.ts`, used by BOTH the link PATCH route and the connect route. The connect route
  now **fast-fails 400** on a malformed `defaultModel` (before any GitHub egress) — it
  previously did zero validation. Tests added in `handlers.test.ts` + the real-DB
  `web-connect-flow.integration.test.ts`.
- **Locked the `EZCORP_DEBUG` dot boundary** with a regression test (`ext` selects `ext.x`,
  NOT `ext-other`).

---

## 3. Tests (all three layers)

| Layer | Where |
|---|---|
| Unit | `logger.test.ts` (20), `spawn.test.ts` (34, incl. `parseDefaultModel` + model threading), `daemon.test.ts` (37, incl. poll-sweep observability), `github-projects-handler*.test.ts`, web `handlers.test.ts` (64, incl. connect-400) |
| Integration (real DB) | `web-connect-flow.integration.test.ts` (9, incl. defaultModel round-trip + connect-400) |
| E2E (`@evidence`) | `web/e2e/github-projects-connect.spec.ts` — the model dropdown + `captureEvidence` |

Changed source files at **100% lines**: `logger.ts`, `daemon.ts`, `spawn.ts`,
`db/queries/github-projects.ts`, the three web route files.

---

## 4. Gotchas / invariants (these bit us — carry forward)

1. **Test typecheck is gate-EXCLUDED** (`tsconfig.typecheck.json` skips `__tests__`). The
   whole gh-projects test suite has pre-existing strict-fn-type looseness in mocks under the
   FULL tsconfig (e.g. `makeRuntime`'s `streamChat` returns `{id}` not `AgentRun`). **Do NOT
   chase full-tsconfig cleanliness on the tests** — it cascades. Source is clean; `bun run
   typecheck` is authoritative. (Editor/LSP "Cannot find module '$lib…'/'../_shared'" and
   "implicit any" diagnostics on these files are LSP context-loss, not real errors.)
2. **Run gh-projects test suites ISOLATED** (`./`-prefixed, one `bun test` per file). A shared
   process has documented `mock.module` materialization-freeze + query-layer-mock leakage
   (daemon.test mocks the query layer → bleeds into queries.test / web-connect-flow in the
   same process → spurious fails). CI shards each spec → green. `bun test <path>` treats a
   slashed arg as a FILTER unless prefixed `./`.
3. **`mock.module("../logger", …)` stubs must export `extensionLogger` too** (superset),
   or a shared run can freeze the module to a partial shape and break a sibling importing it
   (already fixed in background-timers.test + observability-collector.test).
4. **Patch onto an uncommitted tree:** the default-model feature originally overlapped the
   uncommitted logging edits; applied via GNU `patch` (context-based, offset, no fuzz) — not
   `git apply --3way` (index mismatch on a dirty tree). Now both are committed, so this is moot.
5. **Manifest-lock mount gap (dev):** `manifest.lock.json` is image-baked at `/app`, NOT
   bind-mounted, so on every container RECREATE github-projects boots disabled ("no lockfile
   entry") → re-`docker cp manifest.lock.json ez-corp-ai-app-1:/app/ && docker restart`. A
   `docker restart` (not recreate) keeps the cp'd file. The drift re-approval (Codex/admin)
   for a permission bump needs an **admin COOKIE** (API keys are always `role:member`); the
   headless path is `docker exec … bun -e "await initDb(); reapproveBundledDrift(getExtension(id), adminId)"` + restart.
6. **`/api/models` availability is over-broad (pre-existing, NOT this feature):** it marks
   discovered models `available:true` even when the OAuth won't accept them, so the dropdown
   can offer a model that errors at run time. This dev's OpenAI auth is **Codex-with-a-
   ChatGPT-account OAuth** — very restrictive (rejected gpt-4o-mini, gpt-5.1, even
   gpt-5.2-codex). Local `ollama:gemma4:*` (host :11434) works. **Follow-up:** cross-check
   `getOAuthModelIds(provider)` (`src/providers/registry.ts`) in `/api/models`.

---

## 5. Dev-environment state (live, as left)

- Container `ez-corp-ai-app-1` running the main tree; github-projects **enabled**; daemon
  emitting the poll-sweep INFO summary every ~30s; no errors.
- The board (project `cee39e9d-…`, "Features board", `ezcorp-org/projects/3`) has
  **auto-spawn enabled on the two `plan` columns** (`d930e00b` needs-planning + `f75ad846`
  Todo) — a user choice this session. `default_model = ollama:gemma4:e2b` (a working test
  value; change it to your preferred model in the dropdown). A plan run completed
  successfully on it ("Today is October 26, 2023.").
- The connect-route 400 change is **live only after `docker restart ez-corp-ai-app-1`**
  (dev vite doesn't hot-reload host edits). Tests cover it; not critical.
- Admin user: `test@test.com` / `Test123!`.

---

## 6. What's left / next steps

1. **Push + open a PR** (`arch1tect0x`/`EZArchy` per project policy — verify `gh api user
   --jq .login` first). Required checks: typecheck, lint, Backend tests, Web (vitest),
   coverage gate, Gate integrity, Visual evidence. Decide the merge target/stacking for the
   `feat/extension-secrets → github-projects → hub-route` lineage (all unpushed).
2. **`/api/models` accuracy follow-up** (gotcha #6) — make the dropdown only offer models the
   active provider/OAuth will actually accept.
3. Untracked in the tree (NOT committed): verification screenshots (`gh-*.png`,
   `secrets-*.png`, `gh-connect-snapshot.md`) — discard or ignore.

---

## 7. Verify locally
`bun run typecheck && bun run lint` then the touched suites ISOLATED (`./`-prefixed):
`logger.test.ts`, `spawn.test.ts`, `daemon.test.ts`, `web-connect-flow.integration.test.ts`,
`github-projects-handler*.test.ts`, web `handlers.test.ts`, `background-timers.test.ts`,
`observability-collector.test.ts`. e2e from `web/`:
`bunx playwright test e2e/github-projects-connect.spec.ts --project=chromium`.

## 8. Memory written this session
`project_extension_logging_standard.md`, `project_github_projects_default_model.md` (+ MEMORY.md
pointers). Auto-memory dir: `/home/dev/.claude/projects/-home-dev-work-EZCorp-ez-corp-ai/memory/`.
