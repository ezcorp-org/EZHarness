# The `read` API-key scope authorizes mutation and destruction

**Status: investigation. No authorization was changed.** This document proposes;
it decides nothing. The one thing it ships is a pinning regression test
(`web/src/__tests__/api-read-scope-mutation-inventory.test.ts`) that freezes
today's behaviour so whatever is decided later starts from a measurement instead
of an assumption.

Date: 2026-08-02. Base: `19057cd6`.

---

## 1. The count, and how it was obtained

**18 mutating handlers gate on the `read` scope.** The earlier audit said "at
least 17"; the floor was right and the missing one is instructive.

Scopes are **flat**. `hasRequiredScope` (`src/auth/api-key.ts:32-38`) is a plain
`apiKeyScopes.includes(scope)` — there is no ordering, no hierarchy, no
`read ⊂ chat`. So `read` admitting a `DELETE` is a per-route decision, 18 times
over, not a consequence of some implied ranking. (`chat` does **not** subsume
`read`: a `chat`-only key gets 403 on all 18. That inversion matters in §4.)

### 1.1 Method A — static, closure-aware

The original scan read only the text **after** each `export const <METHOD>`
line. That misses any route whose `requireScope` call lives in a helper declared
**above** the export — an entire class of route, skipped with no signal that
anything was skipped.

Method A splits each module into top-level declarations, then takes the
**transitive closure of the identifiers each handler references**, and looks for
`requireScope` anywhere in that closure.

Reproduced in the committed test
(`web/src/__tests__/api-read-scope-mutation-inventory.test.ts`), so the method
itself is now regression-guarded, not just its output.

### 1.2 Method B — behavioral, reads no source at all

Import all 209 `+server.ts` modules, invoke every exported handler with a
principal that is an **API key holding zero scopes**, and read the `required`
field off the resulting `403 {"error":"Insufficient scope"}`. Because
`requireScope` short-circuits before any DB work, that field is the route's
**true runtime scope**, derived from execution.

```ts
// web/probe-scopes.ts (run from web/ with PI_SKIP_INIT=1)
const user = { id: "probe-user", role: process.argv[2] ?? "member", /* … */ };
const locals = { user, apiKeyScopes: [] };
for (const rel of new Glob("api/**/+server.ts").scanSync("src/routes")) {
  const mod = await import(`src/routes/${rel}`);
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    if (typeof mod[m] !== "function") continue;
    const res = await mod[m](makeEvent(m, fileToRoutePath(rel)));   // 4s timeout
    const body = res?.status === 403 ? await res.clone().json() : {};
    record(m, rel, body.error === "Insufficient scope" ? body.required : null);
  }
}
```

Run twice — once with a `member` principal, once with `admin`. The second pass
matters: `requireRole`/`checkRole` deny on **role** first and would otherwise
hide the scope gate behind them. The two passes differ on exactly 7 handlers
(the `checkRole` ones: `GET|PUT|DELETE /api/settings/:key`, `POST /api/extensions`,
`POST /api/extensions/:id/activate`, `POST /api/extensions/:name/webhooks/:slug/rotate`,
`PUT /api/extensions/:id/permissions`), all of which resolve to `admin`. The 18
are identical under both.

### 1.3 The cross-check

| | handlers discovered | mutating + `read` |
|---|---|---|
| Original audit (text after `export`) | 291 | **17** |
| Method A (static closure) | 291 | **18** |
| Method B (behavioral) | 291 | **18** |
| `web/src/__tests__/route-contract.test.ts` discovery | 291 | — |

Methods A and B **agree on all 287 control-tier handlers**. The only 4
disagreements are `/api/__test/**` routes where `isTestSurfaceEnabled()` returns
404 *before* the scope gate, so Method B never reaches it — expected, and a
fail-closed gate, not an offender.

The one route the original method missed:

> **`POST /api/ez/conversation`** — gates on `read` inside `findOrCreate()` at
> `web/src/routes/api/ez/conversation/+server.ts:36`, ten lines **above** the
> export at `:60`.

A third cross-check against `src/api-registry.ts` is weak on coverage (only
66/162 entries declare a scope at all) but useful on accuracy — see §5.3.

### 1.4 What these methods CANNOT see

Stated plainly, because a scan that silently drops a class of route is the
defect being investigated.

1. **Gates in an imported helper.** Method A is file-local. Verified
   empirically to be a non-issue today: the *only* cross-file `requireScope`
   caller in `web/src` is `authGithubRoute`
   (`web/src/routes/api/integrations/github-projects/_shared.ts:46`, scope
   `extensions`). This is a real instance of the blind-spot class — those six
   github-projects routes look ungated to a naive scan. The committed test
   re-derives this set every run and fails if a second one appears.
2. **Dynamically computed scopes** (`requireScope(locals, someVar)`). None
   exist; asserted in the committed test.
3. **Gate order.** Method A reports which scopes a handler *can* require, not
   which fires first. Immaterial here — all 18 call `requireScope` as their
   first statement. Method B covers the ordering question directly.
4. **Non-HTTP surfaces.** WebSocket upgrades, the preview dispatcher
   (`web/src/lib/server/preview/dispatch.ts`) and extension host calls are out
   of scope for both methods. **Unverified.**
5. **Method B's known distortions.** Handlers reached with `PI_SKIP_INIT=1`
   sometimes fail at "Database not initialized" — that is still a *positive*
   result (no scope gate fired before the DB call), but it means the probe
   proves "no scope gate on this path", not "no gate anywhere downstream".

---

## 2. The inventory

All 18 are reachable by a key minted with `--scopes read` and nothing else.
"Owner-gated" = the handler refuses rows the caller does not own.

| # | Handler | Owner gate | What a `read` key does |
|---|---|---|---|
| 1 | `DELETE /api/projects/:id` `projects/[id]/+server.ts:41-48` | **NONE** | Deletes **any** project on the instance |
| 2 | `PUT /api/projects/:id` `projects/[id]/+server.ts:28-39` | **NONE** | Rewrites any project's name/path/vars |
| 3 | `POST /api/projects` `projects/+server.ts:29` | n/a (create) | Creates projects |
| 4 | `DELETE /api/knowledge-base/:id` `knowledge-base/[id]/+server.ts:18-29` | **fails OPEN on unowned rows** (`:24`) | Deletes own + every `userId IS NULL` KB file |
| 5 | `POST /api/knowledge-base` `knowledge-base/+server.ts:34` | n/a | Uploads KB files |
| 6 | `DELETE /api/memories/:id` `memories/[id]/+server.ts:189-200` | yes, fail-closed (`:196`) | Deletes own memories |
| 7 | `PUT /api/memories/:id` `memories/[id]/+server.ts:43` | yes (`:50`) | Rewrites own memories |
| 8 | `PATCH /api/memories/:id` `memories/[id]/+server.ts:126` | yes (`:136`) | Flips injection eligibility |
| 9 | `POST /api/memories` `memories/+server.ts:56` | n/a | Creates memories |
| 10 | `DELETE /api/lessons/:id` `lessons/[id]/+server.ts:22-28` | yes (`deleteLessonAsOwner`) | Deletes own lessons |
| 11 | `PATCH /api/lessons/:id` `lessons/[id]/+server.ts:53` | yes (`:66`, `:76`) | Changes lesson visibility |
| 12 | `DELETE /api/contexts/:id` `contexts/[id]/+server.ts:7-16` | yes, fail-closed (`:16`) | Deletes own saved contexts |
| 13 | `POST /api/fs/mkdir` `fs/mkdir/+server.ts:18-24` | **admin, inline** (`:22`) | Creates dirs in the sandbox |
| 14 | `POST /api/import/preview` `import/preview/+server.ts:30-34` | authed only | Writes/sweeps FS staging dirs |
| 15 | `POST /api/ez-actions/:name` `ez-actions/[name]/+server.ts:316` | conversation-owner | Runs an EZ action |
| 16 | `POST /api/ez/conversation` `ez/conversation/+server.ts:36` | own user | Find-or-create (idempotent) |
| 17 | `POST /api/composer/suggest` `composer/suggest/+server.ts:155` | authed only | LLM suggestion (write-shaped call) |
| 18 | `POST /api/warmup` `warmup/+server.ts:7` | none | Warms the embedding cache |

### 2.1 Two corrections to the finding's premise

The finding assumed *"All the known cases are owner-gated, so there is no
cross-tenant reach."* That is **false for two of them**, and both are worse than
the headline:

- **`DELETE` / `PUT /api/projects/:id` have no ownership check at all.**
  `web/src/routes/api/projects/[id]/+server.ts:41-48` is `requireScope(read)` →
  `requireAuth` → `deleteProject(params.id)`. Projects are instance-scoped (no
  owner column — see the note at
  `web/src/routes/api/integrations/github-projects/_shared.ts:5-7`), so member A
  with a `read` key deletes a project member B created. This is cross-tenant
  reach, and it is a **pre-existing authorization gap independent of the scope
  question** — re-scoping to `write` would not fix it.
- **`DELETE /api/knowledge-base/:id` fails OPEN on unowned rows.** The guard is
  `if (file.userId && file.userId !== user.id)`
  (`web/src/routes/api/knowledge-base/[id]/+server.ts:24`) — the `file.userId &&`
  short-circuit means a KB file with `userId IS NULL` passes for **every** user.
  Compare the sibling memories route, which is deliberately fail-CLOSED
  (`memories/[id]/+server.ts:196`, tagged `sec-H3`). This looks like a genuine
  bug, not a design choice.

Neither is a scope problem. Both should be filed separately; they are the more
urgent of the two issues in this document.

### 2.2 The adjacent class: mutating handlers with NO scope gate at all

Because scope enforcement is **entirely per-route** (`hooks.server.ts` attaches
`locals.apiKeyScopes` at `web/src/lib/server/security/bearer-auth.ts:146,182`
and never gates on it), a handler that never calls `requireScope` accepts a
`read` key too — and every other scope equally.

**30 mutating non-`__test` handlers have no scope gate on the path probed.** Most
are role-gated (providers, MCP servers, search backend, settings) or public by
design (`/api/auth/*`, `/api/hooks/*`). The ones that are neither:

- `PUT /api/user/agent-picker` — returned **200** to a zero-scope key in the probe.
- `POST /api/rbac/extension-grants`, `DELETE /api/rbac/extension-grants/:id`
- `POST /api/onboarding/complete`, `POST /api/preview/consent`
- `PUT` / `DELETE /api/extensions/:id/settings/user` — **already being fixed by a
  concurrent agent (`authz-two-axis`); not touched here.**

This is a *different* defect (the scope axis is absent, not miscalibrated) and is
deliberately **not** frozen by the committed test, because the `authz-two-axis`
and `route-registry` branches are actively editing those files.

---

## 3. Proposed scope mapping

### 3.1 The vocabulary is insufficient

`ApiKeyScope = "read" | "chat" | "extensions" | "admin"`
(`src/auth/api-key.ts:14,17`). The four are **surfaces**, not verbs — `chat` is
"the conversation surface", not "write". There is **no `write`**, and no scope
whose meaning is "may modify the caller's own data".

So the 18 cannot be re-mapped inside the existing vocabulary without a lie:

- → `chat` is wrong. These are memories, projects, lessons, KB files. Filing
  `DELETE /api/projects/:id` under "chat" makes `chat` mean "everything
  non-admin" and destroys the axis.
- → `admin` is wrong. These are a member's own rows; requiring `admin` locks
  every non-admin member out of their own data (the same trap already recorded
  at `web/src/__tests__/route-contract.test.ts:99-102`).

**Minimum vocabulary change: add one scope, `write`.** Precedent exists in the
codebase — `ToolCategory = "read" | "write" | "execute" | "ez"`
(`src/runtime/tools/types.ts:11`) already uses exactly this verb split on the
tool axis.

### 3.2 The mapping, if the decision is to re-scope

| Handlers | Proposed | Why |
|---|---|---|
| 1–12 (projects, KB, memories, lessons, contexts — all C/U/D) | **`write`** | Verb-shaped mutation of durable user data. The whole point of the change. |
| 13 `POST /api/fs/mkdir` | **`admin`** scope + keep the role check | Already admin-only by role (`:22`); its scope should say so. See F4 in §5.2. |
| 14 `POST /api/import/preview` | **`write`** | Writes staging dirs under the project root. |
| 15 `POST /api/ez-actions/:name` | **`chat`** | It is a conversation action, already conversation-owner-gated. |
| 16 `POST /api/ez/conversation` | **leave `read`** | Idempotent find-or-create keyed by the caller's own id; nothing is destroyed, nothing is chosen by the caller. Genuinely read-shaped. |
| 17 `POST /api/composer/suggest` | **leave `read`** | Returns suggestions; POST for body size, not for mutation. |
| 18 `POST /api/warmup` | **leave `read`** | Idempotent cache warm. |

Net: 14 re-scoped (13 → `write`, 1 → `admin`), 1 → `chat`, 3 unchanged.

---

## 4. Breaking-change analysis

### 4.1 Who breaks in-repo

| Surface | Impact |
|---|---|
| **Cookie/browser UI** | **None.** `requireScope` is allow-all when `locals.apiKeyScopes` is `undefined` (`src/auth/api-key.ts:36`). The entire web app is unaffected. |
| **`packages/@ezcorp/harness-client`** | **None.** `HARNESS_ROUTES` contains none of the 18 (verified by grep over `packages/@ezcorp/harness-client/src/routes.ts`). |
| **`packages/@ezcorp/sdk`** | **None.** Its `"read"` occurrences are extension-permission vocabulary (`packages/@ezcorp/sdk/src/types.ts:386`), a different axis. |
| **`web/e2e/`** | **None.** Its `scopes:` fixtures are extension-RBAC verbs (`use`, `approve-runs` — `web/e2e/rbac-permissions.spec.ts:80,89`), not API-key scopes. |
| **Tests** | **13 files** encode today's behaviour and would need editing. |
| **CLI** | `parseKeyScopes` defaults to `["read","chat"]` (`src/cli.ts:293-296`). A new `write` scope means the default should become `["read","chat","write"]` or the default key silently loses the ability to save a memory. |
| **Key-mint UI** | `web/src/lib/components/settings/ApiKeyManager.svelte:2` would need `write` in `SCOPES`; `:10,40` default the selection to `["read"]`. |
| **Docs** | `docs/harness-contract.md:31,245`, `docs/features/platform/rbac-and-permission-modes.md:21,113`, `src/api-registry.ts:13-15`. |

The 13 test files: `api-composer-suggest-feedback`, `api-contexts`,
`api-fs-mkdir`, `api-knowledge-base-id`, `api-knowledge-base`, `api-lessons-id`,
`api-memories-id`, `api-memories-patch`, `api-memories`,
`api-projects-id-features-scan`, `api-projects-id-tool-permission-mode`,
`api-projects-id`, `api-projects` (all `web/src/__tests__/*.server.test.ts`).

Note **what** they pin, because it is the counter-intuitive half: they assert a
**`chat`-only key is REFUSED** on these routes, e.g.
`web/src/__tests__/api-projects-id.server.test.ts:45-47,64-70` names its fixture
`badScope = { apiKeyScopes: ["chat"] }` and asserts `body.required === "read"` on
`PUT` and `DELETE`. Today `chat` cannot delete a project; only `read` can.

### 4.2 Who breaks outside the repo, and can they be migrated

**Yes, cheaply — and this is the decisive practical fact.**

A key's scopes are **not** bound to its secret. `generateApiKey` hashes only the
raw string (`src/auth/api-key.ts:147-154`); the scope list lives in a mutable
JSON settings row at `apikey:<userId>:<keyId>`
(`apiKeySettingsKey`, `src/auth/api-key.ts:81-83`) with the shape `ApiKeyEntry`
(`:67-77`), read back on every request by `verifyApiKey`
(`web/src/lib/server/security/api-keys.ts:53-107`).

So an operator-side migration can **append `write` to every existing key that
holds `read`** without re-issuing a single secret. Nobody's key stops working
and nobody has to be told to rotate.

That is important because the alternative is bad: there is **no update-scopes
endpoint**. `web/src/routes/api/settings/developer/api-keys/+server.ts` exposes
`GET` (`:24`), `POST` (`:41`), `DELETE` (`:76`) only, and the raw key is shown
once (`:73`). Without a migration, re-scoping means every holder must be handed
a new secret out-of-band.

**Operator experience, with the migration:** invisible. **Without it:** every
integration 403s at once with `{"error":"Insufficient scope","required":"write"}`
and no way to fix it except minting new keys.

**Not verified:** whether any deployed instance exists whose keys would need this.
There is no telemetry in-repo to answer that.

### 4.3 Staged paths

| Path | Cost | Verdict |
|---|---|---|
| **Migration + flip** — backfill `write` onto every `read`-holding key, then re-scope. | One migration; 13 test files; docs. No external breakage. | **Cheapest and safest.** The mutable-settings-row property (§4.2) makes it work. |
| **Dual-accept** — `requireScope(locals, ["write", "read"])` for a release, then drop `read`. | Needs `requireScope` to take a set; a second deprecation PR that will be forgotten. | Redundant given the migration works. |
| **Warn-then-enforce** — log on `read`-only mutation, enforce later. | Needs a log sink an operator actually reads; no such channel exists for key usage. | Weakest — a warning nobody sees is not a stage. |
| **Versioned scopes** (`read` vs `read.v2`) | New vocabulary, permanent confusion. | Rejected. |

---

## 5. Related findings

### 5.1 The shipped docs already promise "read-only", and are wrong three ways

`packages/@ezcorp/ai-kit/skills/ezcorp-auth/SKILL.md:33-36` tells operators:

> - `read` — list projects, agents, messages (**no writes**).
> - `chat` — **everything in `read` plus** create/send conversations.
> - `admin` — **full access** including agent authoring and project management.

All three lines are false against `hasRequiredScope`
(`src/auth/api-key.ts:32-38`): `read` performs 18 mutations including deletes;
`chat` does **not** include `read` and 403s on all 18; `admin` is not full access
and 403s on every `read`/`chat`/`extensions` route. Line 63 of the same file adds
"`admin` scope is required for … project creation" — `POST /api/projects` gates
on `read` (`web/src/routes/api/projects/+server.ts:29`).

Compounding it, the mint UI **defaults the scope selection to exactly `["read"]`**
(`web/src/lib/components/settings/ApiKeyManager.svelte:10,40`) with no
description next to the checkbox. The default key an operator mints from the UI
is the one the docs call "no writes".

`docs/harness-contract.md:31` is the one accurate description in the tree —
"gates WHICH **surfaces** a key can touch" — which is the surface reading, not
the verb reading.

### 5.2 F4 — the admin-pairing scan's blind spot

`web/src/__tests__/route-contract.test.ts:120-148` only ever **opens files that
match `requireScope(_, "admin")`** — **28 of 209** route files. The other 181 are
never examined by it at all.

Counting what hides there, in two shapes:

- **38** route files contain an inline `role !== "admin"` / `role === "admin"`;
  **36** of those carry no admin scope and so are invisible to the pairing scan.
- But **34** of the 36 use admin as an **ownership bypass**
  (`row.userId !== user.id && user.role !== "admin"` — the `sec-H3` fail-closed
  idiom). Admin is an escape hatch there, not a gate. Not the F4 shape.
- The genuine F4 shape — a **standalone** inline admin **gate** — is **4** files:
  `extensions/[id]/violations` (has the admin scope, so the scan *does* see it,
  and it is already carved out at `route-contract.test.ts:114`),
  `fs/list` (`:13`), `fs/mkdir` (`:22`), and `runs/[id]` (`:28`).
  `runs/[id]:28` is `if (user.role === "admin") return true` inside
  `callerOwnsRun` — an ownership bypass, a false positive on inspection.

> **F4 answer: 2 routes hide in the blind spot** — `POST /api/fs/mkdir`
> (`web/src/routes/api/fs/mkdir/+server.ts:22`) and `GET /api/fs/list`
> (`web/src/routes/api/fs/list/+server.ts:13`). Both enforce admin inline while
> carrying `requireScope(read)`, so the scan meant to catch "admin scope without
> role" never looks at them.
>
> Neither is exploitable — the inline check is a real gate. The defect is that
> the *check* cannot see them, so a future edit that deletes the inline `if`
> would land green.

The cheap fix (not applied): teach the pairing scan to also flag *inline* admin
gates, i.e. scan all 209 files for `INLINE_ADMIN` and require either an admin
scope or a structured role gate — with the 34 ownership-bypass files carved out
by requiring the condition be standalone.

### 5.3 Registry drift (third cross-check)

`src/api-registry.ts` declares a scope on 66 of 162 matched entries. Of those,
**11 disagree with what is enforced**:

- `GET|POST /api/extensions/:id/reapprove-drift` — registry says `admin`,
  enforced `extensions`.
- 9 more declare `admin` where the enforced gate is a **role** gate with no scope
  check reachable by a member (`/api/settings/:key` ×3, `POST /api/extensions`,
  `POST /api/extensions/:id/activate`, `POST /api/extensions/:name/webhooks/:slug/rotate`,
  `PUT /api/extensions/:id/permissions`, `GET|POST|DELETE /api/rbac/extension-grants*`).
  For the `checkRole` subset this is arguably accurate (it *does* enforce the
  admin scope, just after the role); for `/api/rbac/extension-grants*` there is
  no scope gate at all.

Only 2 registry entries declare `read` on a mutating route
(`DELETE /api/contexts/:id`, `POST /api/composer/suggest`) — so the registry
under-documents this issue 16 times over. It is a weak coverage cross-check and
was used only for accuracy.

### 5.4 F6 — `requireRole` throws, SvelteKit renders 500

Confirmed **behaviorally**, not just by reading: **12 handlers threw a `Response`
out of the handler** during Method B rather than returning it —
`DELETE|POST /api/providers`, `POST /api/providers/local/{models,test}`,
`GET|POST|DELETE /api/search/backend`, `GET /api/settings`,
`POST|PUT /api/mcp-servers*`, `POST /api/auth/reset-password`. Root cause is
`requireRole` at `src/auth/middleware.ts:29-33`; the intended 403 surfaces as a
500. This is already documented at `docs/harness-contract.md:45-48` and
`checkRole` (`src/auth/middleware.ts:66-80`) is the existing fix — these 12 have
simply not been converted. **12 is a lower bound**: the probe stopped at the
first denial, so handlers that throw later were not exercised. Several of these
files are owned by the concurrent `authz-two-axis` work and were not touched.

---

## 6. Recommendation

**Default: do the re-scope — Option A — but only because the docs already promise
read-only and the migration is cheap. If either of those were false, Option C
would be right.**

### Option A (recommended) — add `write`, migrate, re-scope

1. Add `"write"` to `ApiKeyScope` / `API_KEY_SCOPES` (`src/auth/api-key.ts:14,17`).
2. Backfill: append `write` to every stored `ApiKeyEntry` that holds `read`
   (§4.2 — a settings-row rewrite; **no secret is re-issued**).
3. Re-scope the 14 handlers per §3.2.
4. Update the 13 test files, `parseKeyScopes` (`src/cli.ts:293-296`),
   `ApiKeyManager.svelte`, and the docs in §5.1.
5. Update the frozen list in
   `web/src/__tests__/api-read-scope-mutation-inventory.test.ts` — the test is
   designed to fail until that edit is deliberate.

**Why this over "just document it":** the honest counter-argument is that flat,
owner-gated scopes are a coherent model where `read` means *"access your own
data"*. That argument would win **if the product said so**. It does not — the
shipped skill doc says "`read` — no writes"
(`ezcorp-auth/SKILL.md:34`) and the mint UI defaults to exactly that scope
(`ApiKeyManager.svelte:10`). An operator following the documented path today gets
a key they were told is read-only and which deletes their memories, projects,
lessons and knowledge-base files. That is a promise the code breaks, not a naming
preference.

**Cost is genuinely low:** zero external breakage (§4.2), zero UI breakage
(cookie sessions are not scope-gated), zero harness-client/SDK/e2e breakage, and
13 test files whose edits are mechanical.

### Option C (the honest alternative) — document the semantics instead

Rewrite `ezcorp-auth/SKILL.md:33-36` and the mint UI to say `read` means *"access
your own data — including creating, updating and deleting it"*, add per-scope
help text in `ApiKeyManager.svelte`, and change the UI default off bare `read`.
Fix the `chat`-includes-`read` and `admin`-is-full-access falsehoods either way.

**Take Option C if** the maintainer's position is that scopes are surfaces, not
verbs (which `docs/harness-contract.md:31` already says), and that adding a fifth
scope is worse than a naming correction. It is a defensible answer and costs a
day. It leaves an operator who wants a genuinely read-only key with no way to
mint one — that is the trade.

### Both options: file these separately, they are more urgent

1. `DELETE`/`PUT /api/projects/:id` have **no ownership check**
   (`projects/[id]/+server.ts:41-48`) — cross-tenant, unaffected by scope.
2. `DELETE /api/knowledge-base/:id` **fails open on unowned rows**
   (`knowledge-base/[id]/+server.ts:24`).
3. F4: extend `route-contract.test.ts`'s admin scan to inline gates (§5.2).
4. F6: convert the 12 `requireRole` throwers to `checkRole` (§5.4) — coordinate
   with `authz-two-axis`.

---

## 7. What was NOT verified

- Whether any deployed instance has issued `read`-only keys (no in-repo telemetry).
- Non-HTTP surfaces: WebSocket upgrades, preview dispatch, extension host calls.
- F6's true total — 12 is a floor; the probe stopped at the first denial.
- The 30 no-scope-gate mutating handlers were classified from probe status codes
  and route names, not by reading all 30 handlers end to end.
