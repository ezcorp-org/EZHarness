# C6 implementation spec — ownership, project scoping, versioning, editor, fork

**Status:** Binding for phase 6
**Date:** 2026-07-29
**Implements:** C6 of [2026-07-29-ez-factory-design.md](2026-07-29-ez-factory-design.md)
**Scope:** `src/db/`, `src/runtime/workflow*`, `web/src/routes/api/workflows/**`, `web/src/routes/(app)/workflows/**`

> **Citation anchor.** Verified at **`b0f8accc`**. Phase 2 is actively editing
> `src/db/schema.ts`, `src/db/queries/workflow-runs.ts` and
> `src/runtime/workflow-executor.ts`; C6 touches `workflow_definitions` and the
> CRUD routes, which phase 2 does not. Re-verify schema line numbers. Anchor on
> the **symbol name**, not the number.

**§1 is the reason this document exists.** C6's authorization ladder, as written
in the design record, **cannot be implemented where the design record puts it** —
the cache erases ownership before any route can see it. §1.1 and §1.2 are the
two structural findings; everything else follows from how they are resolved.

---

## 1. Findings against the real source

### 1.1 The cache erases ownership, so route-level authorization is impossible · **BLOCKING**

The design record says: "Run authorization: system → any `chat` caller; project →
project members; private → owner + admin", and puts the check on
`POST /api/workflows/[name]/run`. That route cannot perform it.

`buildWorkflowCache` (`web/src/lib/server/context.ts:471-478`) returns a flat
`WorkflowDefinition[]`:

```ts
const extensionWorkflows = await loadExtensionWorkflows(…);
const yamlWorkflows = await loadYamlWorkflows(agentsDir);
const dbWorkflows = await loadDbWorkflows();
return [...extensionWorkflows, ...yamlWorkflows, ...dbWorkflows];
```

and `loadDbWorkflows` (`src/db/queries/workflows.ts:60`) projects each row into
that shape:

```ts
return rows.map((row) => ({
  name: row.name, description: row.description,
  inputSchema: …, defaultModel: …, steps: …,
}));
```

**`id`, and therefore any future `project_id` / `user_id`, are dropped.**
`WorkflowDefinition` (`src/types.ts`) is the *shape of the graph* — name,
description, inputSchema, defaultModel, steps — and carries no provenance at all.

Every route then does `getWorkflows().find((w) => w.name === params.name)`
(`[name]/+server.ts:24`, `[name]/run/+server.ts:22`). By the time the route holds
a workflow it knows only its name and its steps. **There is nothing to authorize
against.**

**Resolution — a cache entry type, not a widened definition.** Do *not* add
`projectId`/`userId` to `WorkflowDefinition`: it is shared by YAML and
extension-shipped workflows that have no owner, by `runWorkflow`, by the CLI and
by `validateWorkflow`, and DB-only provenance does not belong on the graph type.
Introduce instead:

```ts
export type WorkflowSource = "extension" | "yaml" | "db";
export interface CachedWorkflow {
  definition: WorkflowDefinition;
  source: WorkflowSource;
  /** DB rows only; null for yaml/extension. */
  id: string | null;
  projectId: string | null;
  userId: string | null;
  visibility: "system" | "project" | "private";
}
```

`getWorkflows()` keeps returning `WorkflowDefinition[]` for existing callers;
a new `getCachedWorkflows()` returns `CachedWorkflow[]`, and **one** shared
resolver does the lookup + authorization:

```ts
resolveWorkflowForCaller(name, caller): { ok: true; entry } | { ok: false; reason }
```

Every consumer routes through it — the five REST routes, the extension
reverse-RPC handler, and the CLI — so the ladder lives in exactly one place and
cannot drift. **Authorization moves into the lookup, not the route.** That is the
answer to the question this section opens with.

### 1.2 `name` is globally unique, and dropping that is a cross-project data leak · **BLOCKING**

`workflowDefinitions.name` is `text("name").notNull().unique()`
(`src/db/schema.ts`, `workflowDefinitions`). So today two DB rows cannot share a
name, and `find(w => w.name === name)` is unambiguous.

Project scoping invites the obvious change — let project A and project B each own
a workflow called `deploy`, so drop the global unique for a composite
`(name, project_id)`. **Do not do this.** The cache is a flat array and the
lookup returns the **first** match, ordered by `listWorkflows()`' row order. With
two `deploy` rows, a caller in project B asking for `deploy` receives **project
A's graph** — a silent cross-project leak, and non-deterministic to boot.

Making the lookup correct would mean re-keying `(name, callerProjectId) →
workflow`, but the API surface is keyed on a bare name in the URL
(`/api/workflows/[name]`, three of them registered at
`src/api-registry.ts:195-197`) and the CLI resolves by name with no project at
all. That is a much larger, more breaking change than C6 is scoped for.

**Resolution — ownership authorizes, it does not namespace.** Keep `name`
globally unique. `project_id` / `user_id` / `visibility` decide **who may run and
edit** a workflow, never **which workflow you get**. Consequences, stated plainly
because this is a real limitation and not a free win:

- Two projects **cannot** both own a workflow literally named `deploy`. The
  second create fails on the unique constraint with a clear 409.
- The place per-project names actually arise is **fork** (§5), so the fork flow
  auto-suffixes on collision (`docs-factory` → `docs-factory-2`) and shows the
  final name before saving.
- The unique index stays exactly as it is — **no migration, no shadowing, no
  ambiguity, and `find()` remains correct.**

If per-project namespacing is later wanted, it is its own phase: re-key the API
on id, migrate the CLI, and change the cache to a `Map<projectId, Map<name, …>>`.
Bundling it into C6 would ship the leak.

### 1.3 `updateWorkflow` lets a rename collide, and silently 500s · minor

`updateWorkflow` (`src/db/queries/workflows.ts:38-51`) copies `data.name` into
the update set (`:43`) with no collision check; the unique index rejects it and
the error surfaces as an unhandled 500 rather than a 409. C6 adds renames to the
editor, so this becomes reachable by ordinary use. Catch it and return 409 with
the conflicting name.

### 1.4 Versioning and phase 2's `definition_hash` overlap · needs an authority

Phase 2 adds `workflow_runs.definition_hash` as the interim drift guard: a run
suspended and resumed against an edited definition **fails closed**
(C4 spec §2.2, §9 row 7). C6 adds `workflow_definition_versions` and
`workflow_runs.definition_version_id`.

Two mechanisms answering the same question is how they drift. **The version id
becomes authoritative; the hash becomes a cheap pre-check, not a second source
of truth.** Precisely:

- C6 keeps `definition_hash` **as a column**, computed as the hash **of the
  version row's `steps`**, so it is a function of `definition_version_id` and
  cannot disagree with it.
- Resume compares `definition_version_id` first. The hash is only consulted when
  the version id is NULL — i.e. runs created before C6, which C6 does not
  backfill (§3.3).
- The C4 spec's §2.2 row for `definition_hash` gains a pointer here, so the next
  reader sees which one wins.

### 1.5 Dry-run "zero side effects" must be structural, not conventional

The design record says dry-run "executes only `transform`/`gate`/`when` steps
with stub outputs (zero LLM, zero side effects)". A dry run that merely *skips*
`agent` and `tool` steps relies on the skip list staying correct forever — and
C7 is about to add a `workflow` step kind that recursively contains tool steps.

**A tool step in a dry run must be unable to dispatch, not merely skipped.** §4.2
specifies that as a constructor-level capability, not a branch.

---

## 2. Ownership migration

### 2.1 Columns

| Table | Column | Type | Null | Default |
|---|---|---|---|---|
| `workflow_definitions` | `project_id` | `TEXT` → `projects(id)` **ON DELETE CASCADE** | yes | — |
| `workflow_definitions` | `user_id` | `TEXT` → `users(id)` **ON DELETE SET NULL** | yes | — |
| `workflow_definitions` | `visibility` | `TEXT` | no | `'system'` |

`CASCADE` on `project_id`: a project-scoped workflow is part of the project and
dies with it. `SET NULL` on `user_id`: an orphaned private workflow becomes
admin-only, never disappears — the same IDOR-guard rationale as
`workflow_runs.user_id`.

Index: `idx_workflow_definitions_scope ON workflow_definitions(visibility, project_id)`.

**No backfill.** `ADD COLUMN visibility TEXT NOT NULL DEFAULT 'system'` makes
every pre-existing row system-owned in one statement, with `project_id` and
`user_id` NULL — which *is* what system-owned means. A CTE backfill would be a
re-runnable statement that could reattribute rows on a later boot, the opposite
of the house rule that backfills touch only still-`NULL` rows
(`docs/features/platform/database-and-migrations.md:125`).

### 2.2 What each visibility means

| `visibility` | `project_id` | `user_id` | Who may **run** | Who may **edit/delete** |
|---|---|---|---|---|
| `system` | NULL | NULL | any `chat` caller — **today's behaviour** | admin |
| `project` | set | set (creator) | project members | creator + project admin + admin |
| `private` | optional | set | owner + admin | owner + admin |

YAML and extension-shipped workflows have no row and are treated as **`system`**
— unchanged from today, and the only correct reading: they ship with the install,
not with a project.

### 2.3 Every caller that could break, and why it does not

`POST /api/workflows/[name]/run` has **no** owner or project scoping today
(`run/+server.ts:19-22` is `requireScope("chat")` + `requireAuth` only), so
adding a ladder is a behaviour change on a live endpoint. It is safe because
**every row that exists at migration time is `system`**, and `system` authorizes
exactly the callers who are authorized today.

| Caller | Site | Why unaffected |
|---|---|---|
| `POST …/[name]/run` (REST) | `run/+server.ts:22` | Pre-existing rows are `system` ⇒ any `chat` caller, byte-identical. New checks bite only on newly-scoped rows. |
| `GET /api/workflows` (list) | `+server.ts:21` | Returns `getWorkflows()` unfiltered today. **Changes**: filtered to what the caller may see. A `read`-scoped caller in no project sees `system` only — see the trap below. |
| `GET /api/workflows/[name]` | `[name]/+server.ts:24` | Same ladder; 404 (not 403) on unauthorized, so the endpoint is not an existence oracle. |
| `PUT` / `DELETE /api/workflows/[name]` | `[name]/+server.ts:30+` | DB-only today; gains the edit ladder. Pre-existing rows are `system` ⇒ admin-only for edit. **This is a real tightening** — see below. |
| CLI `ezcorp workflow run` | `src/cli.ts` | No auth context at all (a local operator tool). Resolves against YAML + DB directly, bypassing the routes. **Unchanged**, and deliberately so. |
| Extension trigger | `src/extensions/workflows-handler.ts` | Resolves `<ext>:<name>` against the merged cache; extension-shipped workflows are `system`. Unchanged. C3 later adds the owner ladder on top (`runFor`). |
| `web/src/lib/stores.svelte.ts` | client | Consumes the list route; sees fewer entries, no shape change. |

**Two traps to design around, both of which the design record does not mention:**

1. **`PUT`/`DELETE` on a `system` workflow becomes admin-only.** Today any
   `chat` caller can edit any DB workflow. Every pre-existing row is `system`,
   so on upgrade **non-admins lose the ability to edit workflows they created**.
   That is the correct end state, but it is a silent capability removal for
   existing users. Mitigation: the migration sets `user_id` from
   `workflow_runs.user_id` where a single distinct user has run that workflow —
   **no.** That is a guess, and guessing ownership is how you hand someone else's
   workflow to the wrong person. Instead: leave them `system`, and surface an
   admin-only "claim workflow" action in the editor that sets
   `visibility='project'` + `user_id` explicitly. Deliberate, audited, reversible.
2. **List filtering changes what an API-key caller sees.** A `read`-scoped key
   with no project context sees `system` workflows only. Anything scripted
   against the full list gets a shorter array. Document it in the route's
   registry entry and the feature doc.

---

## 3. Versioning

### 3.1 `workflow_definition_versions`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `TEXT` PK | no | |
| `workflow_definition_id` | `TEXT` → `workflow_definitions(id)` **ON DELETE CASCADE** | no | a version snapshot without its definition is dead weight, not evidence |
| `version` | `INTEGER` | no | monotonic per definition, starting at 1 |
| `name` / `description` | `TEXT` | no | the name **at that version**, so a rename is visible in history |
| `input_schema` | `JSONB` | yes | |
| `default_model` | `JSONB` | yes | |
| `steps` | `JSONB` | no | the snapshot |
| `steps_hash` | `TEXT` | no | canonical hash of `steps`; §1.4 |
| `created_by_user_id` | `TEXT` → `users(id)` **ON DELETE SET NULL** | yes | |
| `created_at` | `TIMESTAMPTZ` | no | `NOW()` |

`uniq_workflow_definition_version ON (workflow_definition_id, version)`.

`workflow_runs.definition_version_id` → `workflow_definition_versions(id)`
**ON DELETE SET NULL**, matching the existing `workflow_definition_id`
treatment: the run row survives, the pointer goes NULL.

### 3.2 What constitutes a new version

A new row **only** when the executable content changes — `steps`, `input_schema`,
or `default_model`. A `description` edit does not mint a version; a `name` edit
does not either (the name is recorded *on* the version so history reads
correctly, but renaming does not change what runs).

This matters because C3's consent hash pins a version: minting a version on a
typo fix would suspend every delegated job for re-consent over a description
edit, which trains users to click through — the exact failure the consent design
is built to avoid.

### 3.3 What a run records, and the trace

`runWorkflow` resolves the current version id at start and writes it on the run
row. The trace view (C5) shows **"ran v3"** by joining
`definition_version_id → version`, and a run whose definition has since advanced
shows "ran v3 · current is v5" with a diff link.

**No backfill for historical runs.** `definition_version_id` stays NULL for every
run created before C6 — we genuinely do not know which version they executed, and
inventing one would be a lie in an audit surface. The trace renders "version
unknown (pre-versioning)".

### 3.4 Retention

> **Constraint from C3 (phase 7) — binding on this sweep.** A version row pinned
> by a live `workflow_delegations.definition_version_id` is FK'd **ON DELETE
> RESTRICT** and **must not be reapable**, or a consent hash would reference a
> snapshot that no longer exists. The retention sweep must exclude any version
> referenced by a non-revoked delegation, not merely handle the FK error. See
> [C3 spec §2.1](2026-07-29-c3-implementation.md).

Versions are small (a `steps` blob) and are the audit trail for what actually
ran, so the default is **keep all**. Bounded pragmatically: keep every version
referenced by a surviving `workflow_runs` row, plus the most recent 50
unreferenced ones per definition. The sweep runs in the existing host-maintenance
daemon, not a new one.

---

## 4. Editor and dry-run

### 4.1 Editor

`/workflows/[name]/edit` — form and raw-YAML tabs over the **existing shared**
`validateWorkflow` (`src/runtime/workflow-validator.ts`), which is already the
one validator used by both the API and the YAML loader. The editor calls it
client-side for live errors and the route calls it server-side as the real gate —
the client copy is UX, never the enforcement.

`web/src/lib/workflow-builder-logic.ts` is framework-free and mirrors the server
rules for the create form; the editor extends it rather than forking it. It still
models only three step kinds — `tool` is creatable via API/YAML but not the
builder (`docs/features/orchestration/workflows.md:246`) — and C6 is the natural
place to close that gap, plus `approval` (C4) and `workflow`/`when` (C7) as those
land.

Renames go through the 409 path from §1.3.

### 4.2 Dry-run — why "zero side effects" is structural

A dry run executes `transform`, `gate`, and (once C7 lands) `when` evaluation,
substituting a **stub result** for every `agent`, `tool`, `approval` and
`workflow` step so downstream refs resolve.

Skipping by kind is not enough (§1.5). Three structural guarantees, none of which
depends on the skip list being right:

1. **No tool runner is constructed.** `WorkflowExecutor` takes a
   `toolRunnerFactory` and builds it lazily, only if the graph has a tool step
   (`workflow-executor.ts`, `getToolRunner`). A dry run passes a factory that
   **throws** — so a tool step that somehow reaches dispatch fails loudly instead
   of executing. A future step kind that dispatches a tool inherits the guarantee
   for free.
2. **No agent executor.** The dry-run harness constructs the executor with an
   `AgentExecutor` whose `runAgent` throws. Zero LLM is then a property of the
   object graph, not of a branch.
3. **`persist: false`.** The default already
   (`WorkflowExecutorOptions.persist` defaults false), so a dry run writes no
   `workflow_runs` row. Assert it explicitly rather than relying on the default.

A dry run therefore cannot touch the filesystem, the network, an LLM, or the DB —
because the objects that could do those things are not present.

---

## 5. Fork a template

Forking `<ext>:<name>` clones the shipped definition into an editable,
project-scoped DB row.

**Naming.** `WORKFLOW_NAME_RE` is `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`
(`src/runtime/workflow-name.ts:26`) — no `:` — and the extension loader rejects a
declared name containing the separator, which is what makes namespacing
structural. So a fork **cannot** keep its source name. The fork is named the
**bare** half (`ez-factory:docs-factory` → `docs-factory`), and on collision with
the global unique (§1.2) the route suffixes `-2`, `-3`, … and returns the final
name so the UI can show it before save.

**Provenance.** `forked_from` (`TEXT`, nullable) records the source's fully
qualified name as a **string snapshot, not an FK** — the source is an extension
asset with no row, and the extension may later be uninstalled. The editor shows
"forked from `ez-factory:docs-factory`" and, if that name still resolves, a diff.

**A fork of a fork** is an ordinary DB→DB clone: same route, `forked_from` set to
the *immediate* parent's bare name, no chain walking. Depth is unbounded and
uninteresting — each fork is an independent row.

**Fork does not copy ownership.** The new row is always
`visibility='project'`, `project_id` = the caller's active project, `user_id` =
the caller. Forking a `private` workflow you can read gives you your own copy;
it never widens the original.

Route: `POST /api/workflows/[name]/fork` → `{ name, id }`, scope `chat`,
registered in `src/api-registry.ts` alongside the existing three
(`:195-197`).

---

## 6. Migration plan

Ordered, idempotent, appended after the existing `workflow_definitions` DDL
(`src/db/migrate.ts`, the `CREATE TABLE IF NOT EXISTS workflow_definitions`
block).

1. `ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES projects(id) ON DELETE CASCADE`
2. `… ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL`
3. `… ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'system'`
4. `… ADD COLUMN IF NOT EXISTS forked_from TEXT`
5. `CREATE INDEX IF NOT EXISTS idx_workflow_definitions_scope ON workflow_definitions(visibility, project_id)`
6. `CREATE TABLE IF NOT EXISTS workflow_definition_versions (…)` + its unique index
7. `ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS definition_version_id TEXT REFERENCES workflow_definition_versions(id) ON DELETE SET NULL`
8. **Seed version 1** for every existing definition, guarded:
   `INSERT INTO workflow_definition_versions (…) SELECT … FROM workflow_definitions d WHERE NOT EXISTS (SELECT 1 FROM workflow_definition_versions v WHERE v.workflow_definition_id = d.id)`

Step 8 is the only backfill and it is guarded by `NOT EXISTS`, so a re-run is a
zero-row no-op. **The unique index on `name` is untouched** (§1.2).
`schema.ts` and `migrate.ts` move in lockstep or the mismatch is silent
(`docs/features/platform/database-and-migrations.md:126`).

---

## 7. Test plan

**New files → threshold keys (all 100):** `src/db/queries/workflow-versions.ts`,
`src/runtime/workflow-scope.ts` (the shared resolver from §1.1), the fork route,
the dry-run route.

**The resolver is the highest-value target.** The ladder lives in one function,
so test it as a matrix: `{system, project, private} × {owner, project member,
stranger, admin, api-key-no-project} × {run, edit}`. Twenty-four cases, all cheap,
and they are the entire security surface of C6.

**Regression guards for §1.1 / §1.2:**
- A `CachedWorkflow` for a YAML and an extension workflow reports
  `source`/`visibility` correctly with `id: null` — the resolver must not assume
  a row exists.
- Creating a second workflow with an existing name returns **409**, not 500
  (§1.3), including via rename.
- The list route returns a strict subset for a non-admin, and `system` entries
  are present for everyone.

**Unauthorized reads 404, not 403**, so the endpoint is not an existence oracle —
assert the status explicitly.

**Dry-run:** a definition containing `agent` and `tool` steps dry-runs to
completion with stubs; and — the structural assertion — a harness whose tool
factory throws proves no dispatch occurred, rather than asserting "the branch was
skipped".

**Versioning:** editing `steps` mints a version; editing only `description` does
**not** (§3.2 — this is the test that protects C3's consent hash); a run records
the version it executed; pre-C6 runs read NULL and render "version unknown".

**Migration:** run `migrate()` twice, assert idempotency and that step 8 is a
zero-row no-op on the second pass; assert every pre-existing row reads `system`.

**Unchanged-path canaries:** `web/e2e/workflows.spec.ts`,
`workflows-demos.spec.ts`, `workflows-actions.spec.ts`, `workflows-new.spec.ts`
must pass **unmodified**, and the CLI's behaviour is untouched. If any needs
editing, scoping has leaked into the system-owned path.

**E2E:** `workflows-ownership.spec.ts`, `workflows-editor.spec.ts` (`@evidence` —
new page), `workflows-fork.spec.ts` (`@evidence` — new action), and a dry-run
spec.

---

## 8. Build order

| # | Land | Why here |
|---|---|---|
| 1 | Migration + `schema.ts` columns + versions table. No behaviour. | Backward-safety (`DEFAULT 'system'`) provable in isolation. |
| 2 | `CachedWorkflow` + `getCachedWorkflows()`; `getWorkflows()` unchanged. | §1.1's plumbing with **zero** behaviour change — every existing caller keeps its exact shape. |
| 3 | `resolveWorkflowForCaller` + the 24-case matrix. Not yet wired. | The entire security surface, testable before anything depends on it. |
| 4 | Wire the resolver into the five routes + list filtering. | The behaviour change, landing on a resolver already proven. |
| 5 | Versions: write on mutation, record on run, seed v1. | Independent of the ladder. |
| 6 | The 409 rename/collision fix (§1.3). | Small, and the editor needs it. |
| 7 | Editor (form + YAML tabs) + dry-run harness. | |
| 8 | Fork route + UI. | Needs the editor to land in. |
| 9 | Point C4's `definition_hash` row at §1.4; update the design record. | Documentation last, once the shape is real. |

Steps 1–3 change no behaviour at all and are worth landing as one reviewable
unit; step 4 is where the tightening from §2.3 becomes visible.

---

## 9. Acceptance criteria

Falsifiable — a named test or a grep per row. **§9 is a floor, not a ceiling**;
§9.1 is what the rows cannot cover.

| # | Criterion | Proven by |
|---|---|---|
| 1 | Authorization lives in **one** resolver, not per-route. | Grep: no route contains a `visibility` comparison; a spy asserts all five routes + the extension handler call the resolver. |
| 2 | Every pre-existing row is `system`, and `system` behaves exactly as today. | Migration test asserting `visibility='system'` for all seeded rows; the four e2e canaries pass unmodified. |
| 3 | `name` stays globally unique; no shadowing is possible (§1.2). | Grep: the unique index is untouched. A test asserting a duplicate name is **409**, not a second row. |
| 4 | Unauthorized read is a **404**, not 403. | Asserted per-status, so the endpoint is not an existence oracle. |
| 5 | Dry-run cannot dispatch, structurally (§4.2). | The tool factory and `runAgent` both **throw** in the dry-run harness, and a dry run of a tool-bearing graph still completes. |
| 6 | A description-only edit mints **no** version (§3.2). | Named test — this is what protects C3's consent hash from re-consent churn. |
| 7 | The version id is authoritative over the hash (§1.4). | A test where hash and version disagree ⇒ the version id decides; the hash is only read when the version id is NULL. |
| 8 | Fork produces a legal bare name and never widens the original. | Fork of `<ext>:<name>` yields the bare name (or a `-N` suffix), `visibility='project'`, caller as `user_id`; the source row is unchanged. |

### 9.1 Beyond the checklist

- **Interactions:** the resolver (row 1) and list filtering (row 2) both consult
  `visibility`; verify a caller who can **run** a workflow can also **see** it in
  the list. A workflow that is runnable but invisible is undiagnosable for the
  user and trivially produced by two independently-correct filters.
- **Migration extensibility:** can C3 add `service_accounts` as a `visibility`
  principal, and C7 add a `workflow` step that resolves a *nested* definition
  through the same resolver, without another schema change? The resolver's
  signature is the thing to check — if it takes a `userId` rather than a
  principal, C3 will have to widen it.
- **Meaningless coverage:** the 24-case matrix must assert **which** reason a
  denial carries, not merely that it denied.
- **Untested by default:** a workflow whose `project_id` points at a deleted
  project mid-run (CASCADE fires between resolve and execute); a rename racing a
  run that resolved the old name; and a fork of a workflow whose source extension
  is uninstalled between read and write.

**And the standing one:** anything here the build proves wrong. §1 already
records two blocking findings against the design record — a third is a better
outcome than a spec defended past its evidence.
