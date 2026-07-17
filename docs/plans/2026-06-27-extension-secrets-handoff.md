# Handoff — Extension Secrets + github-projects (secrets store, connect UX, column-fix, poll-now)

**Date:** 2026-06-27 · **Branch:** `feat/extension-secrets` · **Tip:** `7aed4254` · **NOT pushed, no PR.**
**Base:** off `feat/github-projects` (merge-base `19b04faf`); merge-base with `main` = `ee73f5ad`.

Read this before touching code. Everything below is **landed + gate-green** on the branch. Three bodies of
work shipped this session, all on the github-projects extension line.

---

## 1. Status at a glance

- **Full coverage gate PASSED** — `bun run test:coverage` → "Coverage gate PASSED: 304 enforced file(s) at or above threshold." typecheck + lint green; all relevant e2e green; backend boot-smoke clean on `:3000`.
- **Only non-green shard** is `packages/@ezcorp/sdk/test/**` — a **local-environment** artifact: `EACCES mkdir .ezcorp/extension-data/__sdk_unit_test_fallback__` from the primary tree's accumulated `.ezcorp/` cruft. It passes **185/185 in a clean worktree** and in CI. NOT a real failure; do not chase it.
- Branch is **local only**. No push, no PR yet (matches the whole `feat/github-projects` lineage, which is also unpushed).

---

## 2. What shipped (3 features)

### A. Extension Secrets capability (Stage 1) + github-projects de-bespoke + UX-B
The reusable, scope-isolated, **AEAD-bound** credential store; github-projects' PAT migrated onto it; connect UX moved off a top-level nav item. Built by a 4-agent Opus team (Phase-0 contract + 3 parallel).
- **New source:** `src/db/queries/extension-secrets.ts` (raw CRUD), `src/extensions/secrets-store.ts` (host store: `getSecret`/`setSecret`/`hasSecret`/`deleteSecret`/`listSecretMeta` + debounced `last_used_at` + audit + idempotent `backfillGithubProjectsApiTokens`), `web/src/routes/api/extensions/[id]/secrets/+server.ts` (generic POST/DELETE entry route), `src/db/migrations/add-extension-secrets.ts` (doc mirror).
- **Encryption:** `encryptWithAad`/`decryptWithAad` added to `src/providers/encryption.ts` (non-breaking; same `v1:iv:tag:ct` wire; AAD = `"${extensionId}:${projectId}"`, reconstructed from scope, never stored).
- **Table:** `extension_secrets` (inline in `src/db/migrate.ts` + Drizzle mirror in `src/db/schema.ts`). `extension_id` stores the **slug**, FK → `extensions(name)` (NOT the UUID `extensions.id` — the PRD had this wrong; `name` is the stable unique slug the gh code keys on). project_id/user_id FK→cascade. Scope unique = `UNIQUE(extension_id, COALESCE(project_id,''), COALESCE(user_id,''), name)`.
- **github-projects swap:** handler + daemon `resolveAuth` now read via `getSecret("github-projects", projectId, "apiToken")`; connect/link routes write/purge via `setSecret`/`deleteSecret`; `githubTokenSettingKey` deleted; backfill moves the legacy `githubProjects:<pid>:apiToken` settings blob → AAD row + clears the key.
- **UX-B:** removed the top-level "GitHub Projects" nav item (`web/src/routes/(app)/+layout.svelte`); discoverable from the extension detail page + Project Settings (an "Integrations" section); masked saved-state (`•••••••• saved`) + "Replace token" on the connect page.
- **Audit-actor invariant (subtle, keep it):** the store's `opts.userId` is the **scope** userId; a separate `opts.actorUserId` is the **audit actor**. Host-readable secrets (read by the daemon with NO user context) MUST be **project-scoped** (`userId: null`); routes pass `{ actorUserId: user.id }` to attribute the audit without filing the secret in a per-user slot the daemon could never read.
- Full council-approved spec: `docs/plans/2026-06-27-extension-secrets-and-github-projects-prd.md` (untracked, in the tree).

### B. Connect-page column-mapping fix (`f48a1b78`)
Bug: the column→action editor showed the right names on first connect but, **after a refresh, showed option IDs and dropped unmapped columns.** Root cause: the board's Status options (id→name) were only in the transient connect response; after reload the editor fell back to `Object.keys(columnActionMap)`.
- **Fix:** persist `status_options` JSONB on `github_projects_links` (additive `ALTER ADD COLUMN IF NOT EXISTS`; set on connect via `upsertLink`; returned by `publicLinkView`). The page (`…/integrations/github-projects/+page.svelte`) prefers connect-time options → persisted `link.statusOptions` → legacy key fallback.
- Verified **live on real Postgres**: backfill round-tripped a seeded legacy token to an AAD row + cleared the key; AAD anti-row-swap proven (wrong-scope AND no-AAD decrypt both rejected); the ALTER applied to the pre-existing table.

### C. "Poll now" manual trigger (`090014b0` + `b4d15070` + `7aed4254`)
A button to force an immediate board poll, bypassing the due-check. Built by a 2-agent Opus team (backend ∥ Hub-UI).
- **Daemon** (`src/integrations/github-projects/daemon.ts`): extracted `runPoll`; added `pollProjectNow(projectId): Promise<{polled, reason?}>` (forces past `isDue`; `reason` = `"no-board"` / `"paused"`); emit now falls back to `getGithubProjectsEmit()` (bus-registry) so the lazily-created `getGithubProjectsDaemon()` singleton still refreshes the Hub (the running daemon is a *separate* `new GithubProjectsDaemon` in `background-timers.ts`, but all state is DB-backed).
- **Handler** (`src/extensions/github-projects-handler.ts`): `poll-now` reverse-RPC verb — ownership-checked by `linkId`, audited (`AUDIT_CONTROL`, `{verb:"poll-now"}`), delegates to the daemon.
- **Hub UI** (`docs/extensions/examples/github-projects/index.ts` + `ezcorp.config.ts`): "Poll now" button in Connection Health (enabled boards only), `github-projects:poll-now` event + `handlePollNow` + `RPC.pollNow`.

**Polling cadence (for reference):** wake loop every **30s** (`DEFAULT_WAKE_MS`); each board polled when due — `now − lastPolledAt ≥ pollIntervalSec` (default **60s**, configurable **15–3600s** on the connect page).

---

## 3. Tests (all three layers green)

| Layer | Where | Notes |
|---|---|---|
| Unit | `secrets-store.test.ts`, `extension-secrets-queries.test.ts`, `encryption-aad.unit.test.ts`, `daemon.test.ts`, `github-projects-handler.test.ts` (+ `-default-db`), example `index.test.ts` | All new source files **100% lines** |
| Integration (real DB, mocked GitHub client) | `web-connect-flow.integration.test.ts` (secrets + statusOptions round-trip), `poll-now.integration.test.ts` | `*.integration.test.ts` run in `scripts/test.sh`, EXCLUDED from the coverage leg by the existing globs |
| E2E | `web/e2e/github-projects-connect.spec.ts` (@evidence; masked state, discoverability, reload-renders-named-columns), `web/e2e/github-projects-hub.spec.ts` (Poll-now click) | |

---

## 4. Gotchas / invariants to carry forward (these bit us)

1. **Coverage gate is LINE-only** (`scripts/check-coverage.ts`: `coveredLines/totalLines`). A file at "77% funcs / 100% lines" PASSES. Don't chase funcs%.
2. **A gated file's coverage is the MERGE of all its test files.** Running ONE of `github-projects-handler.test.ts` / `…-default-db.test.ts` alone shows <100%; the coverage leg runs both (`github-projects-handler*.test.ts` glob) and merges → 100%.
3. **Adding an eventSubscription to a BUNDLED extension = 4 synced edits**, not 1: `ezcorp.config.ts` (disk) + `src/extensions/bundled.ts` (grant) + `src/extensions/bundled-ceiling.ts` (`BUNDLED_CEILING` — else the boot auto-heal clamps the new event out and re-fires the backfill audit every boot → `bundled-grant-event-subscriptions.test.ts` fails) + `bun run scripts/regenerate-manifest-lock.ts` (commit `manifest.lock.json`, else "tampered" on clean boot; `--check` is the gate). Page-action events do **NOT** go in `web/src/lib/runtime-event-names.ts`.
4. **bun `--coverage` attribution drift:** multi-line template literals / multi-line generics inside function bodies false-drop a file below 100% in large suites. Hoist them to module level.
5. **`mock.module` in `src/__tests__` or `src/extensions/__tests__`** must be snapshotted/restored or registered in `src/__tests__/helpers/mock-cleanup.ts` `MODULE_PATHS`, or use the in-file restore pattern (mock the same path ≥2× + re-register real in `afterAll`) — else `mock-cleanup-coverage.test.ts` fails. (`docs/extensions/examples/**` tests are NOT scanned by that meta-test.)
6. **Coverage-leg flake:** DB-heavy embeddings shards (`message-embed-outbox.ts`, `backfill-embeddings.ts`) occasionally crash/timeout under parallel `--coverage` load → transient gate red. Re-run; verify the file in isolation (it's ~99%). The leg prints `TOTAL_FAIL` but only hard-fails on `check-coverage` + the vitest leg.
7. **Worktree hook:** `git worktree add` MUST target `./worktrees/` (a PreToolUse hook blocks otherwise). `isolation:"worktree"` auto-mode bases off `origin/main` — useless here (branch is unpushed) — so create **manual** worktrees off the local branch and point agents at the absolute path.
8. **`git add -A` footgun:** the tree has pre-existing untracked files (the PRD doc, `gh-connect-snapshot.md`, `gh-connect.png`, plus two verification screenshots `secrets-*.png`). Do NOT `git add -A` — stage explicit paths so these don't get swept into a commit.
9. **Dev container manifest-lock mount gap:** `manifest.lock.json` is image-baked at `/app`, NOT bind-mounted, so a host regen doesn't reach the running container → github-projects shows "manifest tamper / disabled" in dev. Pre-existing; not caused by this work.

---

## 5. What's left / next steps

1. **Push + open a PR.** Decide the target: stack on `feat/github-projects` (then that on `main`), or rebase the whole lineage onto `main`. Required checks: typecheck, lint, Backend tests, Web (vitest), coverage gate, Gate integrity, Visual evidence. Use `EZArchy` per project policy (verify `gh api user --jq .login` first).
2. **Stage 2 (deferred — own PR + security review):** the sandbox-facing `ctx.secrets.fetch` broker with manifest `permissions.secrets: { name, host, allow:[{method,pathPrefix}], headerTemplate }`, redirect refusal, per-secret rate-limit, no-log, `has()`-oracle mitigation. This is where the egress residual-risk lives. Do NOT generalize `envEscapeHatch` into `ctx.secrets`.
3. **Full live click-through of Poll-now / connect** is currently blocked by (a) no real GitHub PAT in the dev container (PAT-only, no `gh`/`curl`) and (b) the manifest-lock mount gap disabling github-projects in dev. The unit/integration/e2e suite is the verification of record; backend boot is confirmed live. To do it for real: connect a real board with a fine-grained PAT on a host that can reach GitHub, or fix the dev manifest-lock mount.
4. **Untracked files** in the tree (PRD doc, `gh-connect-*`, screenshots) — decide whether to commit the PRD + this handoff (recommended) and discard the rest.

---

## 6. Memory written this session (read for full context)
`project_extension_secrets_capability.md`, `project_github_projects_extension.md`, `lesson_bundled_ext_event_subscription_registration.md` (the 4-edit rule), plus `MEMORY.md` index pointers. The auto-memory dir is `/home/dev/.claude/projects/-home-dev-work-EZCorp-ez-corp-ai/memory/`.

## 7. Verify locally before pushing
`bun run typecheck && bun run lint && bun run test && bun run test:coverage`
e2e: from `web/` → `bunx playwright test e2e/github-projects-connect.spec.ts e2e/github-projects-hub.spec.ts --project=chromium`
lockfile gate: `bun run scripts/regenerate-manifest-lock.ts --check`
