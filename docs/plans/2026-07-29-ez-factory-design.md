# ez-factory — phase 0 design record

**Status:** Binding contract for phases 1–9
**Date:** 2026-07-29
**Implements:** `tasks/2026-07-29-ez-factory-replan.md`
**Supersedes:** the `ez-code-factory` extension — **deleted 2026-08-03 in phase 9**

> **Every `docs/extensions/examples/ez-code-factory/...` path in this document
> is now HISTORY, not a map** — §4's "Lives today" column and the scattered
> citations elsewhere alike. They stopped resolving when that tree was removed;
> read them in git history.
> The **"Lands in"** and **"Regression test"** columns are the live half, and
> they were reconciled against the shipped code at deletion time — the outcome,
> row by row, is recorded in the phase-9 PR. Two corrections that table itself
> needed: row 8's claimed home ("the `emit_artifact` / validator finding schema
> parses through the identical fail-closed coercion") is **false** — `ez-factory`
> v1 ships no findings model, and the invariant was re-homed onto the surface
> that does exist, the approval decision vocabulary in
> `extensions/ez-factory/workflow-templates.test.ts`. Row 18's named test file
> was never written; the invariant lives in
> `src/__tests__/extension-rbac-resolver.test.ts` instead.

> **Citation anchor.** Every `file.ts:line` in this document was read and
> verified against **`5b33d731`**, whose `src/**` tree includes **phase 1
> complete** (`0c88c133` + `7c31806c`, with the `effort` removal reverted).
> Citations were originally taken at the pre-phase-1 branch point `40d57aae`
> and **re-anchored on 2026-07-29** — 69 updates, each spot-checked to land on
> its named symbol. When a later phase re-reads a citation, still anchor on the
> **symbol name**, not the number: phases 2–9 will move these lines again.

**Per-phase specs win on detail.** Where a phase has its own implementation
spec, that document is the authority for that phase and this record is the
summary. Today: **C4 / phase 2 →
[2026-07-29-c4-implementation.md](2026-07-29-c4-implementation.md)** (commit
`698df1e8`). Its findings are folded into §2.1, §2.3, §2.4, §7.3 and the C4
delta table below; on any residual conflict, the C4 spec wins.

Read alongside: [orchestration/workflows.md](../features/orchestration/workflows.md),
[platform/database-and-migrations.md](../features/platform/database-and-migrations.md),
[platform/rbac-and-permission-modes.md](../features/platform/rbac-and-permission-modes.md),
[extensions/scheduling-and-loops.md](../features/extensions/scheduling-and-loops.md).

**§7 is the most important section for a reviewer** — it lists eight places the
spec was wrong or infeasible against the real source. **All eight are now
resolved** and the corrections are folded into both this document and the spec.

> ### Decisions settled 2026-07-29
> Phase 0's four open questions were decided by the team lead after independent
> re-verification against `main@abc41f35`. They are binding on every later phase:
>
> 1. **Async opt-in is the `X-EZ-Workflow-Async: 1` request header**, never a
>    body key — headers and workflow input are different namespaces, so the
>    collision is impossible by construction rather than merely unlikely. Sync
>    stays the default when the header is absent. (§7.1)
> 2. **C6 is phase 6, C3 is phase 7.** A consent hash cannot pin a definition
>    version that does not exist yet, and rung D7 cannot re-run an authorization
>    ladder C6 has not built. (§7.8)
> 3. **C3's authority lives in a real `workflow_delegations` table with
>    `ON DELETE CASCADE`** on the owner. `SET NULL` would leave an enabled
>    delegation naming nobody — a latent ownerless grant. (§7.4, §2.7)
> 4. **Per-iteration telemetry goes in an additive `workflow_step_iterations`
>    child table.** Never widen the live `(workflow_run_id, step_name)` arbiter
>    for a purely additive need. (§7.6, §2.4)

---

## 1. Scope and the seven core deltas

The split rule from the spec holds: a capability only a code factory wants lives
in the `ez-factory` extension; the *absence of a generic primitive* that forces
an extension to hand-roll an engine goes in core. All seven deltas pass.

The one-line statement of what core is missing today: **a workflow run is a JS
call stack owned by whoever's HTTP request is blocked on it.** Every delta below
is a consequence of moving that ownership into the database.

### C1 — Per-step model + effort · **S** · phase 1 — **COMPLETE** (`0c88c133` + `7c31806c`)

Today `AgentExecutor.runAgent(name, input, projectId?, userId?)`
(`src/runtime/executor.ts:434`) takes no model overrides, and
`configToAgent` (`src/runtime/config-to-agent.ts:68`) hard-binds the LLM call to
the agent config's own `provider`/`model`/`temperature`/`maxTokens`
(`src/runtime/config-to-agent.ts:80-89`). A workflow that wants a cheap
extractor and an expensive validator must define two agent configs.

| Touch point | Change |
|---|---|
| `src/types.ts` — `WorkflowStep` (`:268`, `loop?` at `:324`) | add `model?: WorkflowModelOverride` |
| `src/types.ts` — new types | `ModelEffort` (the pi-ai `ThinkingLevel` vocabulary), `WorkflowModelOverride = { provider?, model?, temperature?, maxTokens?, effort? }` |
| `src/types.ts` — `WorkflowDefinition` (`:327`) | add `defaultModel?: WorkflowModelOverride` |
| `src/runtime/executor.ts` — `runAgent` (`:445`) | optional 5th arg `overrides?: WorkflowModelOverride`, threaded into the `AgentContext` handed to `configToAgent` |
| `src/runtime/config-to-agent.ts:80-89` | override precedence at the single `ctx.llm.complete` call site |
| `src/runtime/workflow-validator.ts` — `validateWorkflow` (`:136`) | definition-time rejection of an unknown provider/model/effort; **literal** values only — a `$input.x` ref is unresolvable at definition time and must be deferred to run time |
| `src/runtime/workflow-executor.ts` — `runAgentStep` (`:527`) / `runAgentAttempt` (`:569`) | resolve `defaultModel` → step `model` → job override, resolving refs through `workflow-refs.ts` |
| `src/db/schema.ts` — `workflowStepRuns` (`:431`) | `provider`, `model` (see §2) |

**`effort` ships, and it reaches the provider.** It has no home on the *raw*
`stream`/`complete` options — each provider spells reasoning differently — so an
effort-bearing call routes through pi-ai's `*Simple` normalizer instead. That is
a **third** path, distinct from `config-to-agent`'s `ctx.llm.complete` and from
`streamChat` → `build-pi-agent`; a trace covering only those two concluded
(wrongly) that no plumbing existed, and that conclusion was reversed:

- `src/runtime/executor.ts:480` — `createPiLlmAdapter(modelOverride)` swaps the
  adapter for the run.
- `src/runtime/executor-helpers.ts:124` — `const reasoning = overrides?.effort`,
  under the comment at `:120-123` naming `*Simple` as the normalizer.
- `src/runtime/executor-helpers.ts:146-147` / `:174-175` — `completeSimple` /
  `streamSimple`; every other call keeps the raw path unchanged.
- `ModelEffort` (`src/types.ts:217`) is byte-identical to pi-ai's `ThinkingLevel`
  (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:21`, consumed as
  `reasoning?: ThinkingLevel` at `:211`). `"max"` exists; `"off"` is correctly
  excluded — it belongs to `ModelThinkingLevel` (`:22`), model *configuration*
  rather than a per-call option, and on the raw path "no reasoning" is already
  the default, so `"off"` would be a second spelling of the same thing.

A test pins the call shape directly: *"effort routes through the `*Simple`
entrypoint as `reasoning`"*. Phase 1 isolated validation + ref resolution + the
closed vocabulary in `src/runtime/workflow-model.ts`: one module, one coverage
target, no vocabulary duplicated into the validator.

**Absent ⇒ byte-identical behaviour.** The 5th arg is optional and the
`configToAgent` precedence must be `override ?? config.<field>`, so an agent
config's `__current__` inherit sentinel keeps working untouched.

### C2 — Dynamic triggers (`ctx.triggers`) · **M** · phase 5

The wall: a user cannot create a trigger at run time. Cron lives in
`permissions.schedule.crons[]` (`src/extensions/types.ts:643`), clamped to **8
entries** (`src/extensions/clamp-permissions.ts:425`) at a **≥5-minute**
interval (`MIN_INTERVAL_MS`, `src/extensions/clamp-permissions.ts:350`, probed
over 48 samples). Webhook slugs live in `permissions.webhooks: string[]`
(`src/extensions/types.ts:580`) and the SDK is explicit that "the host refuses
to route any undeclared slug"
(`packages/@ezcorp/sdk/src/runtime/webhook.ts:52-55`).

| Touch point | Change |
|---|---|
| `src/extensions/types.ts` — manifest `permissions` (`:593` region) | new `triggers?: { maxCron, maxWebhooks, webhookPrefix, maxRunsPerDay }` envelope |
| `src/extensions/types.ts` — grant shape (`:947` region) | the clamped mirror, all fields required |
| `src/extensions/clamp-permissions.ts` | `clampTriggersPermission`, modelled on `clampWorkflowsPermission` (`:274`) — intersect, never widen; drop the grant rather than leave a husk |
| new `src/extensions/triggers-handler.ts` | the `ezcorp/triggers` reverse-RPC enforcement ladder |
| `src/extensions/tool-executor/rpc-handlers.ts` | `handlePiTriggers` delegate, modelled on `handlePiWorkflows` (`:586`) |
| `src/db/schema.ts` — `extensionSchedules` (`:1401`) | `dynamic BOOLEAN NOT NULL DEFAULT false`, `key TEXT`, `timezone TEXT` |
| `src/db/schema.ts` — `extensionWebhooks` (`:1453`) | `dynamic`, `key` |
| `src/extensions/schedule-reconcile.ts` — `reconcileSchedules` (`:20`) | **the soft-disable sweep at `:55-73` must exclude `dynamic = true`** |
| `src/extensions/webhook-reconcile.ts` — `reconcileWebhooks` (`:28`) | the same exclusion (the spec omits this — see §7.2) |
| new `packages/@ezcorp/sdk/src/runtime/triggers.ts` | `register` / `unregister` / `list` |

The daemon, the cron validator, the per-fire history, the quota and the
auto-disable-after-5 policy (`AUTO_DISABLE_AFTER = 5`,
`src/extensions/schedule-daemon.ts:87`, applied at `:575`) are **reused
unchanged**. A dynamic row is an ordinary `extension_schedules` row with a flag.

**Host-minted slugs.** The extension supplies a `key`; the host derives
`<webhookPrefix><hash(extensionName, key)>`. The extension never chooses the
slug, so it cannot collide with or forge another extension's — the same
structural bound namespacing gives workflows.

### The manifest-only pattern — C2 is one instance of three

C2 exists because a user cannot create a **cron** or a **webhook** at run time.
Building the extension surfaced a **third instance of the identical wall**:

| Grant | Declared where | Blocks |
|---|---|---|
| `permissions.schedule.crons[]` | manifest | a user creating a schedule |
| `permissions.webhooks[]` | manifest | a user creating an endpoint |
| **`permissions.network[]`** | **manifest** | **a user's job reaching a new host** |

The network case is the one C2 does not cover, and it is why `http_fetch` is cut
from `ez-factory` v1 (extension design §1.1). The subtlety that makes it worse
than it looks: **the network grant belongs to the *extension*, not the
workflow.** A user forking a template forks the *workflow*; the extension's
declared hosts are unchanged. Reaching a new host requires forking and
reinstalling the **extension** — the same wall, one level up.

**Follow-up delta (not scheduled): dynamic network hosts**, in the same shape as
C2 — a manifest-declared *envelope* (`maxHosts`, an optional suffix constraint)
with per-host registrations made at run time through `ctx.network`, audited and
revocable. Until it exists, **no extension can host a user-defined job that
reaches a user-chosen host**, which is a hard ceiling on the "factory anyone can
use" premise.

Naming the pattern matters more than the individual fix: three capabilities have
now hit it, so the next one will too. Any new grant whose value a *user* — not an
author — must choose needs an envelope from the start.

### C3 — Delegated execution (`runAs` + service accounts) · **M** · phase 7 · **security-critical**

Full review in §3. The shape:

| Touch point | Change |
|---|---|
| `src/extensions/types.ts` — `permissions.workflows` (manifest `:593`, grant `:947`) | add `allowDelegated?: boolean` / `allowDelegated: boolean` |
| `src/extensions/workflows-handler.ts` — `handleWorkflowsRpc` (`:186`) | a second entry point `runFor`, sharing rungs 1–6 and 9–13, replacing rung 7 (`:291-311`) with owner resolution + consent verification |
| `src/extensions/workflows-handler.ts` — `WorkflowTriggerDenyReason` (`:102-116`) | new codes (§3.4) |
| new `src/db/schema.ts` — `workflow_delegations` | the consent record (§2) |
| new `src/db/schema.ts` — `service_accounts` | the opt-in non-human identity (§2) |
| `src/db/schema.ts` — `workflowRuns` (`:387`) | `run_as`, `run_as_kind`, `delegation_id` |
| new `packages/@ezcorp/sdk/src/runtime/workflows.ts` | `runFor(ownerRef, name, input)` alongside `run` (`:54`) |
| `src/extensions/audit-actions.ts` (`:116` region) | `WORKFLOW_DELEGATED_RUN`, `WORKFLOW_CONSENT_STALE`, `WORKFLOW_DELEGATION_REVOKED` |

**The `-32106` ownerless refusal is not relaxed.** It stays exactly where it is,
in both places it lives:
`src/extensions/tool-executor/provenance.ts:79-92` (`resolveReverseRpcMeta`) and
`src/extensions/workflows-handler.ts:291-311` (rung 7, re-asserted so the bound
is testable in isolation). `runFor` does not bypass it — it *satisfies* it by
supplying a real, consenting principal.

### C4 — Async runs, suspend/resume, and the `approval` step · **L** · phase 2

Today `runWorkflow` (`src/runtime/workflow-executor.ts:163`) awaits the entire
graph and the run route blocks on it
(`web/src/routes/api/workflows/[name]/run/+server.ts:32-38`).
`awaiting_approval` is **terminal** (`src/runtime/workflow-executor.ts:425`,
type at `src/types.ts:266`) — the run is recorded, not resumable.

> **Phase-2 authority:** [2026-07-29-c4-implementation.md](2026-07-29-c4-implementation.md)
> (commit `698df1e8`). It wins on any conflict with this section or §2.3.

| Touch point | Change |
|---|---|
| `src/db/schema.ts` — `workflowStepRuns` (`:431`) | **`output` (`JSONB`)** — moved here from C5; resume rehydrates `stepResults` from it (§2.4) |
| `src/runtime/workflow-executor.ts` — new `persistCritical` | strict sibling of `persistWrite` (`:154-161`, which swallows errors by contract); exactly 3 call sites |
| `src/types.ts:266` — `WorkflowRunStatus` | add `"suspended"` (**non-terminal**, distinct from the terminal `awaiting_approval`) |
| `src/types.ts` — `WorkflowStepKind` (`:205`) | add `"approval"` |
| `src/types.ts` — `WorkflowStep` | `prompt?`, `choices?`, `rbacScope?`, `form?`, `requireItemConsent?`, `timeoutMs?`, `onTimeout?` |
| `src/runtime/workflow-executor.ts` — `runWorkflow` (`:163`) | drive from a persisted `cursor`; a batch boundary is a commit point |
| `src/runtime/workflow-executor.ts` — `runStep` (`:467`) | dispatch the `approval` kind |
| new `src/runtime/workflow-runner-daemon.ts` | claim-before-dispatch + PID lockfile + concurrency caps, modelled on `ScheduleDaemon` |
| `src/db/queries/workflow-runs.ts` — `finalizeWorkflowRunRow` (`:128`) | the CAS is `WHERE status='running'`; it must also accept `'suspended'` (§7.3) |
| `src/db/queries/workflow-runs.ts` — `terminalizeOrphanedWorkflowRuns` (`:190`) | already excludes `suspended` structurally (§7.3) |
| `web/src/routes/api/workflows/[name]/run/+server.ts` | async opt-in via the **`X-EZ-Workflow-Async: 1` request header** — never a body field (§7.1) |
| new `web/src/routes/api/workflows/runs/[id]/resume/+server.ts`, `…/cancel/+server.ts` | |
| `src/api-registry.ts:195-197` | register every new route with a scope |
| `web/src/lib/runtime-event-names.ts:16` | `workflow:approval` (and `workflow:step-log` for C5) |
| `src/runtime/workflow-validator.ts:136` | reject `approval` without `choices`; reject `loop` on an `approval` step |

**Recovery rule, written before the code** (ported from ez-code-factory's
`recoverRuns`, `docs/extensions/examples/ez-code-factory/lib/recovery.ts:51`,
which got this right):

- a run suspended **at a step boundary** — cursor committed, no step in flight —
  **resumes**;
- a run interrupted **mid-step** **fails closed** with `retryable: true`; the UI
  offers *retry from step N*. Re-entering a half-executed step is never safe,
  because a `tool` step may already have written files or run shell.

The mechanism that decides which of those a crashed run is:
**commit-at-boundary, claim-with-lease, decide-at-recovery** (§2.3 hazard 1, C4
spec §1). The executor records `run_phase` strictly around the batch dispatch;
`suspended` is written only by a deliberate park; the recovery sweep selects on
one predicate and branches its action on `run_phase`. A run resuming against an
edited definition **fails closed** on `definition_hash` mismatch until C6 ships
versioning.

**Synchronous stays the default.** The CLI's exit-code contract
(`src/cli.ts` `workflow:run` — exit 0 only on terminal `success`), the
`/workflows/[name]` page, and the extension-author chain must be byte-identical.

**New step kind — `approval`.** Suspends the run, writes a `workflow_approvals`
row, and the human's answer becomes the step's result
(`$steps.<name>.output.choice`). Three views over one store: the `/workflows`
inbox, a Hub card, a chat card. `requireItemConsent` generalizes
ez-code-factory's no-blanket-approval rule (§4, invariant 6) into core, so it
lives in exactly one place.

### C5 — Observability · **M** · phase 3

| Touch point | Change |
|---|---|
| `src/db/schema.ts` — `workflowStepRuns` (`:431`) | `attempt`, ~~`iteration`~~, `input_tokens`, `output_tokens`, `cost_usd`, `duration_ms`, `error_code`, `resolved_input`, `skipped_reason` (`provider`/`model` land in C1; **`output` lands in C4** — §2.4). **CORRECTED in phase 3: eight columns, not nine.** A singular `iteration` was dropped — `workflow_step_runs.iterations` (the final count) already exists and predates C5, so the column would have been redundant with it, and per-iteration DETAIL lives in the `workflow_step_iterations` child table (§7.6) rather than in either. |
| `src/db/queries/workflow-runs.ts` — `upsertWorkflowStepRun` (`:94`) | write them; the upsert arbiter `uniq_workflow_step_run` (`src/db/schema.ts:460`) is `(workflow_run_id, step_name)` and **cannot express per-iteration rows** (§7.6) |
| new `web/src/routes/api/workflows/runs/+server.ts` | `GET`, scope `read` |
| new `web/src/routes/api/workflows/runs/[id]/+server.ts` | `GET`, scope `read` |
| ~~new `web/src/routes/api/workflows/approvals/…`~~ | **Already shipped in C4 (phase 2)** — `web/src/routes/api/workflows/approvals/{,[id]}/+server.ts` exist. Nothing to add. |
| new `web/src/routes/(app)/workflows/runs/[id]/+page.svelte` | the trace view — DAG + timeline, per-step model/tokens/cost/duration, resolved input, output, loop iterations, linked agent transcript, **Retry from here** |
| `src/api-registry.ts` | **two** new entries, category `workflows` (the approvals pair registered with C4) |

~~Agent steps already mint real `AgentRun`s, so emitting `obs:turn` puts factory
spend in the **existing** observability cost dashboard for free.~~
**CORRECTED during phase 3 — this was wrong, for two independent reasons,
either of which alone kills it.** (a) A workflow `agent` step never traverses
the path that emits `obs:turn`: it is emitted in exactly one place
(`src/runtime/stream-chat/finalize.ts:110`), and `configToAgent`'s LLM call is
`ctx.llm.complete(...)` (`src/runtime/config-to-agent.ts:80`), which does not go
through `streamChat` at all. (b) Even if it were emitted, the row cannot be
written: `insertObservabilityEvent` takes a **required** `conversationId`
(`src/db/queries/observability.ts:7-13`) into
`observability_events.conversation_id`, which is `NOT NULL` FK to
`conversations` (`src/db/schema.ts:1037`) — and a workflow has no conversation,
only the synthetic `workflow-run:<id>` scope key. This is the same structural
fact already documented for tool calls. **Resolution: aggregate, do not widen.**
`workflow_step_runs` is the authoritative per-step cost record; a dashboard that
wants factory spend learns to read it as a second source. Widening a shared
audit table's FK to serve one subsystem was rejected.

**Redaction is not optional.** `resolved_input` and `output` carry whatever a
workflow author threaded in — including anything an extension tool returned.
Both columns are size-capped and pass the same secret-redaction pass the ported
prompt hygiene uses (§4, invariant 12). `jsonb` writes are NUL-scrubbed by
`src/db/nul-column-patch.ts`; **a bare `` sql`…` `` template bypasses the column
mapper entirely** (`docs/features/platform/database-and-migrations.md:57`), so
any raw-SQL writer of these columns must scrub itself.

### C6 — Ownership, project scoping, versioning · **M** · phase 6

`workflow_definitions` (`src/db/schema.ts:367-375`) has **no owner, user or
project column** — workflows are global, and
`POST /api/workflows/[name]/run` gates only on `requireScope(locals, "chat")` +
`requireAuth` (`web/src/routes/api/workflows/[name]/run/+server.ts:19-21`). Any
authenticated `chat` caller can run any workflow with any input
(`docs/features/orchestration/workflows.md:248`).

| Touch point | Change |
|---|---|
| `src/db/schema.ts:367` | `project_id`, `user_id`, `visibility` |
| new `src/db/schema.ts` — `workflow_definition_versions` | immutable snapshots |
| `src/db/schema.ts` — `workflowRuns` (`:387`) | `definition_version_id` |
| `src/db/queries/workflows.ts` — `createWorkflow` (`:22`) / `updateWorkflow` (`:38`) | write a version row on every mutation |
| `web/src/routes/api/workflows/[name]/run/+server.ts` | the authorization ladder: system → any `chat` caller; project → project members; private → owner + admin |
| new `web/src/routes/(app)/workflows/[name]/edit/+page.svelte` | form + raw-YAML tabs, live `validateWorkflow` errors, dry-run |
| new `web/src/routes/api/workflows/[name]/fork/+server.ts` | clone a shipped `<ext>:<name>` into an editable project-scoped DB row |

**Dry-run** executes only `transform` / `gate` / `when` steps with stub outputs —
zero LLM, zero side effects. That is the whole reason `transform` was built
declarative (`docs/features/orchestration/workflows.md:12`): it is the only step
kind that is provably safe to run speculatively.

**Fork is the mechanism that makes this "a factory for building factories."**
Note the namespacing consequence: a forked workflow gets a **bare** name and is
therefore no longer reachable by `ctx.workflows.run` from the extension that
helped create it (the wire carries a bare name and the host prefixes `<ext>:`,
`src/extensions/workflows-handler.ts:236-243, 372`). C3's `runFor` is what closes
that loop.

### C7 — Composition & control flow · **M** · phase 4

Today `condition` is gate-only and a false gate **fails** the run
(`src/types.ts:298`). There is no way to say "skip this branch."

| Touch point | Change |
|---|---|
| `src/types.ts` — `WorkflowStep` | `when?: WorkflowCondition`, `skipDependents?: boolean` (default `true`) |
| `src/types.ts` — `WorkflowStepKind` (`:205`) | add `"workflow"` |
| `src/types.ts` — `WorkflowStep` | `workflow?: string` (the nested definition name) |
| `src/types.ts` — `WorkflowRunStatus` (`:266`) | add `"skipped"` for step rows |
| `src/runtime/workflow-executor.ts` — `runStep` (`:467`) | evaluate `when` before dispatch, reusing `evaluateCondition` **unchanged** |
| `src/runtime/workflow-executor.ts` — `runLoop` (`:608`) | permit `loop` on a `workflow` step |
| `src/runtime/workflow-validator.ts:136` | depth cap 3, cycle check at definition time, `loop` still banned on `gate` and `tool` |
| `src/db/schema.ts` — `workflowRuns` (`:387`) | `parent_run_id` |

**`loop` becomes legal on a `workflow` step, and only there.** That gives
fix→re-validate loops without loosening the correct ban on looping a raw
side-effecting tool step
(`docs/features/orchestration/workflows.md:98`). The nested workflow may itself
contain a `tool` step; the bound that matters is that the *loop* wraps a graph
with an LLM or a gate in the middle, not a bare install/write/shell call.

---

## 2. DB migration plan

**House pattern (binding).** There is no version ledger. `migrate(db)`
(`src/db/migrate.ts`) is one idempotent function: `CREATE TABLE IF NOT EXISTS`,
`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, CTE
backfills guarded to touch **only still-`NULL` rows**, seeds with
`ON CONFLICT DO NOTHING`. `src/db/schema.ts` and `src/db/migrate.ts` must move in
lockstep or you get a silent runtime mismatch
(`docs/features/platform/database-and-migrations.md:126`). Modules under
`src/db/migrations/*.ts` are **not** boot-sequenced — do not add a table there
and expect it to apply (`:127`).

**Placement.** The existing workflow-run DDL sits near the end of `migrate()`
(`src/db/migrate.ts:2208-2252`) "purely because every FK target it needs —
`workflow_definitions`, `projects`, `users`, `runs` — is created above." Every
new table below FKs into `users` (`:814`), `projects` (`:13`), `extensions`, or
`workflow_definitions`, so **all new DDL appends after `:2248`**, before the
github-projects secret backfill. New columns on existing tables go as
`ADD COLUMN IF NOT EXISTS` immediately after their table's `CREATE`.

**Coverage gotcha.** A multi-line `` sql`…` `` template leaves interior lines as
orphan coverable lines that never receive an execution hit — Bun attributes the
whole statement to its first line — which the patch-coverage gate then flags.
The existing code works around this with single-line `SELECT`s
(`src/db/migrate.ts:125-131`). Follow it for any new probe query.

### 2.1 Ordering

Migrations are idempotent and unordered relative to a version, but they **are**
ordered relative to FK targets. The required sequence:

1. **C1** — `workflow_step_runs.provider`, `.model`.
2. **C4** — `workflow_runs` columns (incl. `run_phase`, `definition_hash`, the
   lease pair); **`workflow_step_runs.output`** (moved from C5 — resume is
   impossible without it); `workflow_approvals` (FKs `workflow_runs`).
3. **C5** — the remaining `workflow_step_runs` telemetry columns.
4. **C7** — `workflow_runs.parent_run_id` (self-FK).
5. **C2** — `extension_schedules` / `extension_webhooks` columns.
6. **C6** — `workflow_definitions` columns; `workflow_definition_versions` (FKs
   `workflow_definitions`); then `workflow_runs.definition_version_id`.
7. **C3** — `service_accounts` (FKs `users`), then `workflow_delegations` (FKs
   `users`, `service_accounts`, `projects`), then `workflow_runs.run_as` /
   `.delegation_id` (FKs `workflow_delegations`).

Two of these orderings are hard requirements, not preferences. **C4 before C5** —
C5's telemetry columns are written by the daemon C4 introduces. **C6 before C3** —
the consent hash pins a `workflow_definition_versions` row and rung D7 re-runs
C6's authorization ladder, so building C3 first would mean hashing a version that
does not exist and re-running a ladder that has not been written (§6, §7.8).

### 2.2 C1 — per-step model

| Table | Column | Type | Null | Default |
|---|---|---|---|---|
| `workflow_step_runs` | `provider` | `TEXT` | yes | — |
| `workflow_step_runs` | `model` | `TEXT` | yes | — |

Nullable with no default: a `transform` / `gate` / `approval` step invokes no
model, and "no model" must be distinguishable from "the default model". No new
index. No backfill — historical rows genuinely have no model, and inventing one
would be a lie in the trace view.

### 2.3 C4 — async, suspend/resume, approvals

> **Authority.** [2026-07-29-c4-implementation.md](2026-07-29-c4-implementation.md)
> (commit `698df1e8`) is the binding detail for phase 2 and **wins on any
> conflict with this section**. What follows is the migration-level summary,
> corrected to match it.

**`workflow_runs` additions:**

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `cursor` | `JSONB` | yes | — | `{ batchIndex, completedSteps[], prevStepName }`; NULL ⇒ a legacy synchronous run |
| `run_phase` | `TEXT` | no | `'boundary'` | `'boundary' \| 'in-batch'` — written **strictly** around the batch dispatch; the sole input to the recovery decision |
| `definition_hash` | `TEXT` | yes | — | canonical hash of the definition the run started against; resume **fails closed** on mismatch |
| `job_ref` | `TEXT` | yes | — | opaque extension-owned job id; **no FK** — jobs live in extension `Storage`, not a table |
| `idempotency_key` | `TEXT` | yes | — | |
| `suspended_reason` | `TEXT` | yes | — | `"approval" \| "consent-stale" \| "quota" \| "orphaned-resumable" \| "approval-timeout"` |
| `resumable` | `BOOLEAN` | no | `false` | **written by the recovery sweep**, derived from `run_phase` — never by the executor (see hazard 1) |
| `claimed_by` | `TEXT` | yes | — | daemon instance id; set by the claim CAS |
| `lease_expires_at` | `TIMESTAMPTZ` | yes | — | claim lease, renewed on a 20s heartbeat; 60s lease |

`run_as` / `delegation_id` are **not** C4 columns — they move to C3 (phase 7).
Shipping them here would add a permanently-NULL column with no writer, which
reads as implemented.

`workflow_step_runs.output` (`JSONB`, nullable, size-capped, secret-redacted)
**moves from C5 into C4** — see §2.4. Resume rehydrates `stepResults` from it,
so phase 2 cannot resume without it.

Indexes:
- `idx_workflow_runs_claimable ON workflow_runs(status, lease_expires_at) WHERE status IN ('running','suspended')` — shared by the daemon's claim scan and the recovery sweep.
- `uniq_workflow_runs_idem ON workflow_runs(workflow_name, idempotency_key) WHERE idempotency_key IS NOT NULL` — a partial unique index; a NULL key must never collide.

`DEFAULT 'boundary'` on `run_phase` is what makes the migration backward-safe:
every pre-existing row reads as "at a boundary", and since they are all already
terminal or drained by the existing sweep, nothing is misclassified.

**New table `workflow_approvals`:**

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `TEXT` PK | no | — |
| `workflow_run_id` | `TEXT` → `workflow_runs(id)` **ON DELETE CASCADE** | no | — |
| `step_name` | `TEXT` | no | — |
| `prompt` | `TEXT` | no | `''` |
| `choices` | `JSONB` | no | — |
| `rbac_scope` | `TEXT` | yes | — |
| `form_schema` | `JSONB` | yes | — |
| `require_item_consent` | `BOOLEAN` | no | `false` |
| `item_ids` | `JSONB` | yes | — |
| `status` | `TEXT` | no | `'pending'` |
| `answered_by` | `TEXT` → `users(id)` **ON DELETE SET NULL** | yes | — |
| `answer_choice` | `TEXT` | yes | — |
| `answer_form` | `JSONB` | yes | — |
| `answered_item_ids` | `JSONB` | yes | — |
| `expires_at` | `TIMESTAMPTZ` | yes | — |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | no | `NOW()` |

- `CASCADE` on `workflow_run_id`: an approval without its run is meaningless —
  unlike run *history*, which is deliberately preserved via `SET NULL`
  (`src/db/schema.ts:398-403`).
- `SET NULL` on `answered_by`: same IDOR-guard rationale as `runs.user_id` and
  `workflow_runs.user_id` (`src/db/schema.ts:408-414`) — deleting a user
  un-attributes the answer, it does not erase that an approval happened.
- `uniq_workflow_approval ON workflow_approvals(workflow_run_id, step_name)` —
  one live approval per step; a resumed-then-re-suspended step updates in place.
- `idx_workflow_approvals_pending ON workflow_approvals(status, expires_at) WHERE status = 'pending'` — the inbox and the timeout sweep.

**Backward-compatibility hazards:**

1. **`terminalizeOrphanedWorkflowRuns` and `suspended`.** The predicate is
   `status = 'running' AND started_at < cutoff`
   (`src/db/queries/workflow-runs.ts:190`). A `suspended` run is therefore
   **already excluded structurally** — the original spec's stated hazard does not
   exist as written (§7.3). The real hazard is the inverse: a run that is
   `running` when the process dies, having already committed a cursor, gets
   drained to `error` even though it is resumable.

   **The fix is NOT "transition to `suspended` before every await point".** That
   was this document's earlier answer and it is wrong: of the eight await sites
   in `runWorkflow`, only one precedes a step, and marking a run `suspended`
   before the tool dispatch (`src/runtime/workflow-executor.ts:780`) would assert
   "parked at a boundary, safe to resume" while a `write_file` may already have
   landed — contradicting ported invariant #16 (§4). The corrected model is
   **commit-at-boundary, claim-with-lease, decide-at-recovery**:
   - the executor writes `run_phase` strictly around the batch dispatch;
   - `suspended` is written only by a deliberate park, which is at a boundary by
     construction;
   - the sweep's **selection** stays one predicate
     (`status='running' AND lease_expires_at < now()`) and only its **action**
     branches on `run_phase`: `'boundary'` → `suspended` + `resumable=true`;
     `'in-batch'` → `error` + `resumable=false`.

   Full derivation and the await inventory: C4 spec §1.
2. **`persistWrite` swallows every error by contract**
   (`src/runtime/workflow-executor.ts:154-161` — "Never throws and never blocks
   the run"). Correct for telemetry, **fatal for a cursor**: a silently-dropped
   cursor write makes the next resume start from a stale `batchIndex` and
   re-execute a completed batch. C4 adds a strict `persistCritical` with exactly
   three call sites (the `'in-batch'` marker, the boundary cursor advance, the
   suspend transition). `persistWrite` is left untouched so its never-fail
   contract is not weakened by accident.
3. **`finalizeWorkflowRunRow` is a CAS on `status='running'`**
   (`src/db/queries/workflow-runs.ts:128-140`). A resumed run that finishes is
   at `running` again, so this holds — **but** a run cancelled while `suspended`
   would silently no-op the finalize. The CAS must widen to
   `status IN ('running','suspended')` and keep its zero-row-no-op contract.
   Widening the CAS is **necessary but not sufficient**: the `finally` block
   (`src/runtime/workflow-executor.ts:440-458`) calls the finalizer
   **unconditionally** at `:451`, and `TerminalWorkflowRunStatus`
   (`src/db/queries/workflow-runs.ts:28-32`) correctly excludes `suspended`. The
   `finally` needs a `suspended` guard around the finalize; the scope teardown
   (`:445`, `:450`) stays unconditional.
4. **Resume must not re-emit `workflow:start`.** That event prepends a new run to
   `store.workflowRuns` (`docs/features/orchestration/workflows.md:130`), so a
   resumed run would render as two. `resumeWorkflow` emits only `workflow:step`
   and the terminal `workflow:complete` / `workflow:error`.
5. **Definition drift across a suspension.** A run parked overnight can resume
   against an **edited** definition whose batches no longer match its
   `cursor.batchIndex` — silent corruption, with no compensating control until
   C6 ships versioning. C4 stores `definition_hash` at start and **fails closed**
   (`error`, `definition-changed`, message naming the drift) when it differs on
   resume. C6 later replaces the hash with `definition_version_id`.
6. **`WorkflowRunStatus` is a plain `TEXT` column** (`src/db/schema.ts:416`)
   `$type<>`-annotated only. Adding `'suspended'` needs no DDL, and old rows are
   unaffected — but nothing in the DB stops a bad write. The type is the only
   guard; there is no CHECK constraint and adding one is **not** recommended
   (PGlite and external Postgres both take it, but it turns a future status
   addition into a destructive migration).
7. **Code that branches on `status === "error"` will not match `suspended`**, the
   same trap `awaiting_approval` already has
   (`docs/features/orchestration/workflows.md:243`). Audit every consumer:
   `web/src/lib/stores.svelte.ts`, `src/cli.ts`, `web/src/lib/workflow-run-display.ts`.
8. **`awaiting_approval` is not reused for the `approval` step.** It keeps
   today's meaning — a sensitive-capability tool step failed closed, parked
   *and dead* (`src/runtime/workflow-executor.ts:412-432`). Reusing it would
   retroactively make every historical `awaiting_approval` row look resumable.
   The new step kind produces `suspended`.

### 2.4 C5 — telemetry

**`workflow_step_runs.output` ships in C4 (phase 2), not here.** Resume
rehydrates `stepResults` from it, and the upsert payload carries no output today
(`src/db/queries/workflow-runs.ts:66-79`), so phase 2 is blocked without it.
It is a **prerequisite, not telemetry**: `JSONB`, nullable, 256 KB cap after
secret-redaction, and a resume that meets a truncated value fails closed rather
than continuing with a silently-different `$steps`.

`resolved_input` is **not** needed for resume (it is recomputed from `cursor` +
`stepResults`) and stays here.

**`workflow_step_runs` additions in C5** (all nullable, no defaults — absent is
meaningful):

| Column | Type |
|---|---|
| `attempt` | `INTEGER` |
| `iteration` | `INTEGER` |
| `input_tokens` | `INTEGER` |
| `output_tokens` | `INTEGER` |
| `cost_usd` | `NUMERIC(12,6)` |
| `duration_ms` | `INTEGER` |
| `error_code` | `TEXT` |
| `resolved_input` | `JSONB` |
| `skipped_reason` | `TEXT` |

`cost_usd` is `NUMERIC`, not `DOUBLE PRECISION` — a cost dashboard that sums
floats accumulates error, and this column is the input to a spend cap that
auto-disables jobs.

Index: `idx_workflow_step_runs_run ON workflow_step_runs(workflow_run_id)` — the
trace view's only query, and today there is no such index (only the unique
composite at `src/db/schema.ts:460`, which does serve this prefix; add it only
if the composite is later reordered).

**Hazard: the upsert arbiter cannot hold iterations.** `upsertWorkflowStepRun`
conflicts on `(workflow_run_id, step_name)`
(`src/db/queries/workflow-runs.ts:112-113`), so a looped step has exactly **one**
row and `iteration` can only ever record the last one. The trace view's "every
step, every iteration" requirement needs either a widened arbiter
`(workflow_run_id, step_name, iteration)` — a **destructive** index change
requiring a `DROP INDEX` + backfill of `iteration = 1` on existing rows — or a
separate `workflow_step_iterations` child table. **The child table was chosen:**
it is purely additive, needs no backfill, and leaves the existing upsert and its
tests untouched (§7.6).

### 2.5 C7 — composition

| Table | Column | Type | Null | FK |
|---|---|---|---|---|
| `workflow_runs` | `parent_run_id` | `TEXT` | yes | → `workflow_runs(id)` **ON DELETE SET NULL** |

`SET NULL`, not `CASCADE`: a child run's history is independently valuable and
deleting a parent must not erase what its children cost. Declare it as **plain
text with no drizzle self-reference** in `schema.ts` and add the real FK in
`migrate.ts`, mirroring `sdk_capability_calls.parent_call_id`
(`src/db/schema.ts:1266-1269`), which took this route for exactly the same
drizzle same-table-reference ergonomics.

Index: `idx_workflow_runs_parent ON workflow_runs(parent_run_id)` — required,
because `SET NULL` on delete scans this column.

### 2.6 C2 — dynamic triggers

**`extension_schedules` additions** (`src/db/schema.ts:1414`):

| Column | Type | Null | Default |
|---|---|---|---|
| `dynamic` | `BOOLEAN` | no | `false` |
| `key` | `TEXT` | yes | — |
| `timezone` | `TEXT` | yes | — |

`DEFAULT false` is what makes this backward-compatible: every existing row is
manifest-declared, so the reconciler keeps managing it exactly as today.

**`extension_webhooks` additions** (`src/db/schema.ts:1453`): `dynamic BOOLEAN NOT NULL DEFAULT false`, `key TEXT`.

Indexes:
- `uniq_ext_schedule_key ON extension_schedules(extension_id, key) WHERE key IS NOT NULL` — partial, so manifest rows (NULL key) never collide.
- `uniq_ext_webhook_key ON extension_webhooks(extension_id, key) WHERE key IS NOT NULL`.

The existing `uniq_ext_schedule ON (extension_id, cron)`
(`src/db/schema.ts:1414`) stays — but note it means **two dynamic jobs cannot
share a cron expression** within one extension. That is a real product
limitation (25 jobs at "0 3 * * 1" is a plausible ask) and phase 5 must either
relax the index to `(extension_id, cron) WHERE dynamic = false` or key dynamic
rows on `key` alone. **Relax it** — the constraint exists to dedupe manifest
declarations, which dynamic rows are not.

**Backward-compatibility hazard:** `reconcileSchedules` today soft-disables
every row whose cron is not in the manifest
(`src/extensions/schedule-reconcile.ts:55-73`), and the `valid.length === 0`
branch at `:64-73` **disables them all**. Without the `dynamic` exclusion,
installing an update to `ez-factory` silently kills every user-created job. Same
for `reconcileWebhooks` (`src/extensions/webhook-reconcile.ts:28`), whose
disabled-count is derived from a pre-fetch snapshot at `:56` and must exclude
dynamic rows from that snapshot too, or the audit count lies.

### 2.7 C3 — delegated execution

**New table `service_accounts`:**

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `TEXT` PK | no | — |
| `name` | `TEXT` UNIQUE | no | — |
| `description` | `TEXT` | no | `''` |
| `created_by_user_id` | `TEXT` → `users(id)` **ON DELETE RESTRICT** | no | — |
| `project_id` | `TEXT` → `projects(id)` **ON DELETE CASCADE** | yes | — |
| `scopes` | `JSONB` | no | `'[]'` |
| `max_cost_cents_per_day` | `INTEGER` | no | — |
| `enabled` | `BOOLEAN` | no | `true` |
| `disabled_reason` | `TEXT` | yes | — |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | no | `NOW()` |

`RESTRICT` on `created_by_user_id`, matching `sdk_capability_calls.on_behalf_of`
(`src/db/schema.ts:1257-1264`): a service account is a standing grant of
authority, and letting the admin who created it be deleted out from under it
would leave an unaccountable identity running jobs. An admin must
explicitly disable or reassign it first.

**New table `workflow_delegations`** — the consent record:

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `TEXT` PK | no | — |
| `extension_id` | `TEXT` → `extensions(id)` **ON DELETE CASCADE** | no | — |
| `job_ref` | `TEXT` | no | — |
| `owner_kind` | `TEXT` (`'user' \| 'service'`) | no | — |
| `owner_user_id` | `TEXT` → `users(id)` **ON DELETE CASCADE** | yes | — |
| `owner_service_account_id` | `TEXT` → `service_accounts(id)` **ON DELETE CASCADE** | yes | — |
| `workflow_name` | `TEXT` | no | — |
| `project_id` | `TEXT` → `projects(id)` **ON DELETE CASCADE** | yes | — |
| `trigger_kind` | `TEXT` | no | — |
| `trigger_spec` | `JSONB` | yes | — |
| `consent_hash` | `TEXT` | no | — |
| `capability_set` | `JSONB` | no | — |
| `max_cost_cents_per_run` | `INTEGER` | no | — |
| `max_runs_per_day` | `INTEGER` | no | — |
| `consecutive_failures` | `INTEGER` | no | `0` |
| `enabled` | `BOOLEAN` | no | `true` |
| `disabled_reason` | `TEXT` | yes | — |
| `consented_at` | `TIMESTAMPTZ` | no | — |
| `consented_by_user_id` | `TEXT` → `users(id)` **ON DELETE SET NULL** | no | — |
| `revoked_at` | `TIMESTAMPTZ` | yes | — |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | no | `NOW()` |

**`CASCADE` on `owner_user_id` is the load-bearing choice, and it differs from
the spec.** The spec says `ON DELETE SET NULL → the job auto-disables`. `SET
NULL` on a column that *is* the authority produces a delegation row that is
enabled, has a valid consent hash, and names nobody — a **latent ownerless
grant**, which is precisely what `-32106` exists to prevent. Deleting the user
must delete the authority. The job itself (in extension `Storage`) then finds no
delegation on its next fire and refuses; the extension surfaces
"disabled: owner removed". See §7.4.

- `owner_user_id` and `owner_service_account_id` are both nullable, with exactly
  one populated per `owner_kind`. There is no CHECK constraint — enforce it in
  the query layer, consistent with the rest of the schema.
- `uniq_workflow_delegation ON workflow_delegations(extension_id, job_ref) WHERE revoked_at IS NULL` — one live delegation per job. Partial, so revoked rows accumulate as history.
- `idx_workflow_delegations_owner ON workflow_delegations(owner_user_id)` and `…_service ON (owner_service_account_id)` — both FK columns fire on delete.

**`workflow_runs` additions:**

| Column | Type | Null | FK |
|---|---|---|---|
| `run_as_kind` | `TEXT` | yes | — |
| `run_as` | `TEXT` | yes | — |
| `delegation_id` | `TEXT` | yes | → `workflow_delegations(id)` **ON DELETE SET NULL** |

`run_as` is deliberately a **plain text snapshot with no FK** — it is the audit
record of who a run executed as, and it must survive the delegation being revoked
and the owner being deleted. `delegation_id` carries the live FK and goes NULL;
`run_as` never does. This is the same denormalization rationale as
`workflow_runs.workflow_name` (`src/db/schema.ts:404-406`).

Index: `idx_workflow_runs_run_as ON workflow_runs(run_as_kind, run_as, started_at DESC)` — backs both the "jobs running as me" page and the daily-quota count.

### 2.8 C6 — ownership and versioning

**`workflow_definitions` additions** (`src/db/schema.ts:367`):

| Column | Type | Null | Default |
|---|---|---|---|
| `project_id` | `TEXT` → `projects(id)` **ON DELETE CASCADE** | yes | — |
| `user_id` | `TEXT` → `users(id)` **ON DELETE SET NULL** | yes | — |
| `visibility` | `TEXT` | no | `'system'` |

`CASCADE` on `project_id`: a project-scoped workflow is part of the project and
dies with it. `SET NULL` on `user_id`: an orphaned private workflow becomes
admin-only, never disappears.

**"Mark every existing row system-owned" needs no backfill.** `ADD COLUMN
visibility TEXT NOT NULL DEFAULT 'system'` gives every pre-existing row
`'system'` in one statement, and `project_id`/`user_id` are NULL, which is
exactly what system-owned means. A CTE backfill would be a re-runnable statement
that could reattribute rows on a later boot — the opposite of the house rule
that backfills touch only still-`NULL` rows
(`docs/features/platform/database-and-migrations.md:29`). **Do not write one.**

Index: `idx_workflow_definitions_scope ON workflow_definitions(visibility, project_id)`.

**New table `workflow_definition_versions`:**

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `TEXT` PK | no | — |
| `workflow_definition_id` | `TEXT` → `workflow_definitions(id)` **ON DELETE CASCADE** | no | — |
| `version` | `INTEGER` | no | — |
| `name` | `TEXT` | no | — |
| `description` | `TEXT` | no | `''` |
| `input_schema` | `JSONB` | yes | — |
| `steps` | `JSONB` | no | — |
| `capability_hash` | `TEXT` | no | — |
| `created_by_user_id` | `TEXT` → `users(id)` **ON DELETE SET NULL** | yes | — |
| `created_at` | `TIMESTAMPTZ` | no | `NOW()` |

`CASCADE` here, unlike run history: a version snapshot without its definition is
not audit evidence, it is dead weight. `workflow_runs.definition_version_id`
therefore FKs with **`ON DELETE SET NULL`** so the run row survives, matching the
existing `workflow_definition_id` treatment (`src/db/schema.ts:398-403`).

- `uniq_workflow_definition_version ON workflow_definition_versions(workflow_definition_id, version)`.
- `capability_hash` is stored here, not recomputed — this is what makes C3's
  consent check a cheap string compare (§3.3).

**Migration for existing definitions:** seed **version 1** from each current
`workflow_definitions` row, guarded by `WHERE NOT EXISTS (SELECT 1 FROM
workflow_definition_versions WHERE workflow_definition_id = …)` so a re-run is a
no-op. Then `workflow_runs.definition_version_id` stays NULL for all historical
runs — correct, because we genuinely do not know which version they ran.

---

## 3. C3 security review — delegated execution

This is the sharpest edge in the program. It ships **behind a flag**, with
CODEOWNERS review, in its own PR.

### 3.1 Threat model

The one-sentence statement of what C3 changes: **an extension gains the ability
to start a workflow run attributed to a principal other than the caller of the
current RPC.** Everything below is a consequence.

| # | Attacker | Capability they hold | What they attempt | Bound |
|---|---|---|---|---|
| T1 | Malicious/compromised extension | Runs arbitrary code in its sandbox; can call any reverse-RPC | `runFor(<any user id>, …)` — invent an owner and inherit their authority | The owner ref must resolve to a **live, unrevoked `workflow_delegations` row keyed on (this extension, this job_ref)**. The wire supplies a job ref, never a user id (§3.4 rung D2). |
| T2 | Malicious/compromised extension | Same | Register a delegation for a user who never consented | Delegation rows are written **only** by a host-side, session-authenticated route. There is no reverse-RPC that creates one. The extension can read its own delegations, never write one. |
| T3 | Malicious workflow author | `chat` scope; can edit a DB workflow | Consent to a harmless 2-step workflow, then edit it to add `run_command` + `write_file` | The **consent hash** covers the computed capability set of the definition **version**. Any step edit changes it; the next fire suspends for re-consent (§3.3). |
| T4 | Malicious workflow author | Same | Edit a *transitively nested* workflow (C7 `kind: workflow`) to smuggle capability in below the hashed root | The capability set is computed over the **transitive closure** of the graph to depth 3 (§3.3 input 4). A nested edit changes the root hash. |
| T5 | Compromised webhook sender | Knows the hook URL + secret | Fire the job at 1000 rps to burn the owner's credits | Per-job daily quota + per-job spend cap + the extension's `maxRunsPerDay` envelope + the daemon's existing auto-disable-after-5. The webhook delivery queue is already claim-before-dispatch. |
| T6 | Compromised webhook sender | Same | Supply an `input` that steers an agent step into exfiltration | `input` is capped at 16KB (`MAX_WORKFLOW_INPUT_BYTES`, `src/extensions/workflows-handler.ts:95`) and passes the ported prompt-hygiene stack (§4, invariants 10–13). The delegation's capability set — not the input — decides what the run may *do*. |
| T7 | User narrower than the owner | Any authenticated user; `manage-jobs` scope | Edit a job whose `runAs` is a broader user, then trigger it | Editing a job's `workflow`, `trigger`, `runAs`, `projectId` or model set **invalidates the consent hash** (§3.3 input 6). A narrower user cannot re-consent on the owner's behalf — re-consent requires a session **as the owner**. |
| T8 | User narrower than the owner | Same | Read the run's output to exfiltrate data the owner could see but they cannot | The run's SSE delivery is scoped to the owner (`userId`, fail-closed — `src/runtime/workflow-executor.ts:179-184`). The `GET /api/workflows/runs/[id]` route (C5) applies the same ladder as C6 run authorization. |
| T9 | Admin | `admin` role | Create a service account with scopes exceeding their own | Service-account scopes are clamped to the **creating admin's** scopes at creation (§3.5). Admins already hold every extension RBAC scope, so this bound is about *future* narrower roles; write it now, not later. |
| T10 | Anyone | — | Replay a stale delegation after the extension's manifest narrowed | Rung 4 of the existing ladder — the manifest allowlist is re-read on every call (`src/extensions/workflows-handler.ts:250-253`), copied from `schedule-handler.ts`. `runFor` keeps it. |

### 3.2 Why borrowing a consenting human's authority is safe where inventing an owner is not

The refusal we are *not* relaxing is stated twice in the source, in the same
words. `resolveReverseRpcMeta`:

> ownerless background fire → `-32106`, logged at INFO (a clean, expected
> soft-fail; never the `missing onBehalfOf` throw)
> — `src/extensions/tool-executor/provenance.ts:61-62`, enforced at `:79-92`

and rung 7 of the workflows handler, which re-asserts it so the bound is testable
in isolation:

> `"Workflow triggers require an acting user — a background (cron/webhook) fire
> has no owner to attribute the run to"`
> — `src/extensions/workflows-handler.ts:292-293`, returned at `:310`

The module doc explains *why* (`src/extensions/workflows-handler.ts:47-62`):
`runWorkflow` scopes `workflow:*` SSE delivery on `userId` and is fail-closed on
a missing one, so an ownerless run executes **with no owner AND no
observability** — real LLM spend with nobody watching and nobody accountable.
Attributing it to (say) the installing user "would bill that user's provider
credits for work they did not initiate and would push the run's event stream at
them."

Three properties distinguish `runFor` from that:

1. **The principal is real and pre-existing.** `runFor` does not manufacture a
   `userId`; it resolves one from a row a human created in a session
   authenticated *as that human*. The `-32106` invariant is "no run without an
   accountable principal" — `runFor` satisfies it rather than bypassing it.
2. **The human saw exactly what they were authorizing.** Consent is captured in
   a dialog naming the workflow, the trigger, and the computed capability set:
   > This job runs **as you**, on **every push to `main`**, and may run
   > **shell commands** and **write files** in `<project>`.
   > [Cancel] [Authorize]
   Inventing an owner has no such moment; that is the whole difference.
3. **The authority is per-job, revocable, and self-invalidating.** It is scoped
   to one `(extension, job_ref)` pair — never a user-global always-allow row —
   dies when the workflow changes (§3.3), when the job is disabled, when the
   delegation is revoked, and when the user is deleted (`CASCADE`, §2.7).

The extension **never gains authority**. It gains the ability to *present* a
delegation the host already holds. Every existing rung still runs against the
extension's own grants — the extension can only ask for a workflow it declared,
within its own quota. Delegation decides *whose credits and whose visibility*,
not *what may be reached*.

### 3.3 The consent-hash design

**What is hashed.** `consentHash = SHA-256` over a canonically-serialized tuple
(sorted keys, no whitespace, explicit `null`s — a JSON serializer whose output
depends on insertion order would make the hash non-deterministic and every fire
would suspend):

1. **`workflowName`** — the fully-namespaced name (`<ext>:<name>` or the bare DB
   name).
2. **`definitionVersionId`** and **`version`** — pinning the exact steps. C6's
   `workflow_definition_versions` is what makes this cheap; without it we would
   have to re-serialize the whole `steps` blob on every fire.
3. **The computed capability set of the definition** — the sorted, deduplicated
   list of `{kind, value}` capabilities every step can reach: for each `tool`
   step, the tool's declared capabilities resolved through the registry; for
   each `agent` step, `llm:<provider>` plus the agent's tool scope; for a `gate`
   / `transform` / `approval` step, nothing.
4. **The transitive closure of nested workflows** (C7 `kind: workflow`), to the
   depth-3 cap, each contributing its own capability set. Closes T4.
5. **`triggerKind` + a canonical `triggerSpec`** — the cron expression and
   timezone, or the webhook key, or the event name and filter. "Runs on every
   push to `main`" is part of what the human authorized; changing it to "every 5
   minutes" must re-ask.
6. **`projectId`** and the **`runAs` ref** (`kind` + id). A job moved to another
   project touches different files.
7. **The model-override set** (C1), sorted by step name. A job silently
   re-pointed from Haiku to Opus is a 30× spend change on the owner's credits.
8. **`extensionName`** (registry-resolved, never the wire) — so a delegation can
   never be presented by a different extension.

Deliberately **not** hashed: the job's `input` values, its display name, its
description, its concurrency policy. Those change routinely and change nothing
about authority. Hashing them would train users to click through re-consent,
which is worse than not asking.

**When it is recomputed.** On every `runFor` call, immediately before dispatch,
from live state — never read back from the delegation row and compared to
itself. The row stores the hash the human agreed to; the handler computes what
the world says now.

**What invalidates it.** Any edit to the workflow definition (C6 mints a new
version → new `capability_hash`); adding, removing or re-pointing a nested
workflow; changing the trigger, project, `runAs`, or model set; the extension
narrowing its manifest so a step's tool is no longer reachable (the capability
set shrinks — still a mismatch, still re-ask, because the *behaviour* changed);
and installing an extension update that changes a shipped `*.workflow.yaml`.

**What happens on mismatch.** Not a failure. The run is created and immediately
**suspended** with `suspended_reason = 'consent-stale'`, a `workflow_approvals`
row is written whose prompt is a **diff of the capability set** (added
capabilities highlighted), and an `ext:workflow-consent-stale` audit row is
written. The owner — and only the owner — can re-consent from the approvals
inbox, which updates `consent_hash` and resumes the run. Nothing executes in the
interim: suspension happens **before** the first step dispatches.

Making the mismatch path *suspend* rather than *fail* is deliberate. A hard
failure trains authors to disable the consent check; a suspension with a legible
diff makes the security control the fastest path to a working job.

### 3.4 The full enforcement ladder for `ctx.workflows.runFor(...)`

Modelled rung-for-rung on the existing ladder
(`src/extensions/workflows-handler.ts:16-42`, implemented `:186-410`). Rungs 1–6
and 8–13 are **shared verbatim** with `run` — `runFor` is a different rung 7, not
a different handler. Every outcome, accept and reject, writes an
`sdk_capability_calls` row (`capability: "workflows"`, `action: "runFor"`) with a
typed `errorCode`, via the existing `audit` helper at `:458`.

| Rung | Check | Deny code | Audited to |
|---|---|---|---|
| 0 | Provenance — host-issued `_meta.ezCallId`, resolved by `handlePiWorkflows` (`src/extensions/tool-executor/rpc-handlers.ts:586`) → `resolveReverseRpcMeta`. **Unresolved ⇒ `-32602`.** | — | log (ERROR) |
| 1 | Kill switch `EZCORP_DISABLE_CAPABILITY_TOOLS=1` (`:214`) | `WORKFLOWS_DISABLED` | `sdk_capability_calls` |
| 1b | **New: delegation kill switch** `EZCORP_DISABLE_DELEGATED_WORKFLOWS=1` — turns off C3 alone without disabling the whole capability tier | `DELEGATION_DISABLED` | `sdk_capability_calls` |
| 2 | Structural grant check (`:221-231`) | `WORKFLOWS_NOT_GRANTED` | `sdk_capability_calls` |
| 2b | **New:** `granted.workflows.allowDelegated === true` | `DELEGATION_NOT_GRANTED` | `sdk_capability_calls` |
| 3 | Workflow name — bare, `:`-free (`isValidWorkflowName`, `:238`) | `WORKFLOW_NAME_INVALID` | `sdk_capability_calls` |
| 4 | Manifest allowlist re-read live (`:250-253`) — closes T10 | `WORKFLOW_NOT_DECLARED` | `sdk_capability_calls` |
| 5 | Grant allowlist (`:256`) | `WORKFLOW_NOT_GRANTED` | `sdk_capability_calls` |
| 6 | PDP `authorize` for `{kind:"ezcorp:workflows:run", value:<name>}` (`:266-279`) | `WORKFLOWS_PERM_DENIED` | `sdk_capability_calls` |
| **D1** | **`jobRef` payload** — a non-empty string ≤128 chars. The wire carries a **job ref, never a user id.** | `DELEGATION_BAD_REF` | `sdk_capability_calls` |
| **D2** | **Delegation lookup** — `(extension_id = <registry-resolved id>, job_ref, revoked_at IS NULL)`. Absent ⇒ refuse. Closes T1 and T2: there is no wire field that names a principal. | `DELEGATION_NOT_FOUND` | `sdk_capability_calls` |
| **D3** | **Delegation enabled** — `enabled = true` | `DELEGATION_DISABLED_ROW` | `sdk_capability_calls` |
| **D4** | **Owner resolution.** `owner_kind='user'` ⇒ the `users` row must exist and be `status='active'` (`src/db/schema.ts:833`). `owner_kind='service'` ⇒ the `service_accounts` row must exist and be `enabled`. **A resolution failure here is the one rung that audits to `audit_log`, not `sdk_capability_calls`** — for the identical reason rung 7 does today (`:286-290`): `sdk_capability_calls.on_behalf_of` is `NOT NULL` with an FK to `users` (`src/db/schema.ts:1264`), so an ownerless row cannot exist there, and routing it through `deny()` would produce a swallowed insert and **no trail at all for exactly the rejection class that most needs one**. | `DELEGATION_OWNER_UNRESOLVED` | `audit_log` (`ext:workflow-delegation-no-owner`, nullable `user_id`) |
| **D5** | **Workflow name matches the delegation.** The consented `workflow_name` must equal the resolved `<ext>:<name>`. Prevents presenting a delegation for workflow A to run workflow B. | `DELEGATION_WORKFLOW_MISMATCH` | `sdk_capability_calls` |
| **D6** | **Consent hash.** Recompute (§3.3) and compare. **Mismatch ⇒ suspend, not deny** — HTTP-equivalent success, `{suspended: true, reason: "consent-stale"}`, run row created at `suspended`. | `DELEGATION_CONSENT_STALE` | `sdk_capability_calls` (`success: false`) **and** `audit_log` (`ext:workflow-consent-stale`) |
| **D7** | **Owner authorization for this workflow.** Re-run C6's run-authorization ladder **as the owner**: system → any `chat`; project → project member; private → owner or admin. The delegation cannot grant reach the owner does not have. | `DELEGATION_OWNER_UNAUTHORIZED` | `sdk_capability_calls` |
| **D8** | **Per-job daily quota** — count `workflow_runs` where `delegation_id = <id>` and `started_at > now() - 24h` against `max_runs_per_day`. **Durable, not in-memory**, unlike the hourly extension quota at `:146-160` — a restart must not reset a spend bound. | `DELEGATION_QUOTA_EXCEEDED` | `sdk_capability_calls` |
| **D9** | **Per-job spend cap** — sum `workflow_step_runs.cost_usd` over the same window against `max_cost_cents_per_run × max_runs_per_day`. Also checked *during* the run by the C4 daemon at each step boundary; exceeding it suspends with `suspended_reason='quota'`. | `DELEGATION_SPEND_EXCEEDED` | `sdk_capability_calls` |
| 8 | Wiring gate — only when the call carries a conversation (`:316-321`). A delegated fire normally has none. | `WORKFLOWS_NOT_WIRED` | `sdk_capability_calls` |
| 9 | Instantaneous rate limit, 50 ops/s (`:324`) | `WORKFLOWS_RATE_LIMITED` | `sdk_capability_calls` |
| 10 | Payload: `v === 1`, `input` a plain object ≤16KB (`:329-347`) | `WORKFLOWS_BAD_PAYLOAD` | `sdk_capability_calls` |
| 11 | Extension hourly quota (`:350`) | `WORKFLOWS_QUOTA_EXCEEDED` | `sdk_capability_calls` |
| 12 | Resolve `<extensionName>:<name>` against the live cache (`:364-376`) | `WORKFLOW_NOT_FOUND` | `sdk_capability_calls` |
| 13 | Dispatch — `runWorkflow(definition, input, projectId, <resolved owner id>)`, writing `run_as_kind`, `run_as`, `delegation_id` on the run row | `WORKFLOWS_DISPATCH_FAILED` | `sdk_capability_calls` |

On **any** dispatch outcome the delegation's `consecutive_failures` is updated:
reset to 0 on a run that reaches `success`, incremented on `error`, and at **5**
the row is auto-disabled with `disabled_reason` and an audit entry — the same
policy and the same threshold as `AUTO_DISABLE_AFTER`
(`src/extensions/schedule-daemon.ts:87`, applied `:575-592`). Reusing the number
matters more than the number itself; two auto-disable thresholds that drift is a
support burden.

**`projectId` is derived host-side.** Today it comes from the calling
conversation (`src/extensions/workflows-handler.ts:381-383`). A delegated fire
has no conversation, so it comes from `workflow_delegations.project_id` — a value
the human consented to. **Never from the wire.** This is the same
confused-deputy fix `handlePiGithubProjects` documents
(`src/extensions/tool-executor/rpc-handlers.ts:625-629`).

### 3.5 Service-account identities

A service account is an **opt-in, admin-created, non-human principal** for
org-level jobs whose owner should not be a person who might leave.

- **Created only** by an `admin` through a session-authenticated route
  (`POST /api/service-accounts`), never by an extension, never by an API key
  holding only `chat`. Every creation writes an `audit_log` row naming the
  creating admin.
- **Bounded** by `scopes` (a subset of the creating admin's — closes T9),
  optional `project_id` (a project-scoped account cannot reach another project),
  and a mandatory `max_cost_cents_per_day`. There is no "unlimited" value.
- **Cannot log in.** No `users` row, no password hash, no session, no API key. It
  exists solely as a `run_as` target. This is the property that keeps the blast
  radius small: compromising the identity gives an attacker nothing except the
  jobs already delegated to it.
- **Auditable and revocable** — `enabled: false` immediately stops every
  delegation naming it; `disabled_reason` is surfaced in the job list.
- **Held by the RESTRICT FK** on `created_by_user_id` (§2.7): an admin with live
  service accounts cannot be hard-deleted.

**How it differs from a user `runAs`:**

| | user `runAs` | service account |
|---|---|---|
| Consent | the user, in their own session, per job | an admin, once, at creation; then per job |
| Credits | the user's provider credentials | the instance's, via the account's cap |
| SSE visibility | the owner sees the run stream | nobody; observed via the trace view + audit |
| Dies with | the user (`CASCADE`) | explicit disable only |
| Default | **yes** | opt-in |
| Reach | whatever that user can reach | only the account's `scopes` ∩ project |

The default is a user `runAs` because it is the *narrower*, more accountable
option: a real person is on the hook, and the run is visible to them in real
time. Service accounts trade that visibility for durability, which is only worth
it for genuinely org-level work.

### 3.6 Explicitly NOT relaxed

- **The `-32106` ownerless refusal stays**, in both `resolveReverseRpcMeta`
  (`src/extensions/tool-executor/provenance.ts:79-92`) and rung 7
  (`src/extensions/workflows-handler.ts:291-311`). `runFor` adds rungs; it
  removes none. A cron or webhook fire that presents no valid delegation still
  gets `-32106`.
- **Namespacing stays structural.** The wire carries a bare name; a name with
  `:` is rejected (`:236-243`); the host applies the `<ext>:` prefix from the
  registry-resolved manifest (`:383`). No delegation makes a host workflow or
  another extension's workflow expressible.
- **The manifest allowlist re-read stays** (`:250-253`). A stale grant against a
  narrowed manifest is not exploitable.
- **Sensitive-capability steps still fail closed inside the run.** A `tool` step
  hitting a `SENSITIVE_KINDS` capability with no always-allow row rejects
  synchronously under the non-interactive scope
  (`docs/features/orchestration/workflows.md:79`). Delegation does **not**
  pre-approve tool consent — that is a separate, deliberately separate, gate.
- **The synthetic conversation id stays** (`workflow-run:<runId>`,
  `workflowScopeKey`, `src/runtime/workflow-executor.ts:130`). An empty string
  would fail *open* on SSE delivery and null the sec-H2 ownership check.
- **No always-allow row is ever written** on the owner's behalf. A delegation is
  scoped to one job; it is not a permission grant.
- **Extensions still cannot write delegations.** There is no reverse-RPC that
  creates, edits, or re-consents one.

### 3.7 Abuse bounds — summary

| Bound | Value | Where enforced |
|---|---|---|
| Per-job spend cap | `max_cost_cents_per_run` (required, no unlimited) | rung D9 + per-step-boundary check in the C4 daemon |
| Per-job daily quota | `max_runs_per_day` (required) | rung D8, **durable** count over `workflow_runs` |
| Per-extension hourly quota | `maxRunsPerHour`, clamp default 20, ceiling 500 | rung 11 (existing, in-memory) |
| Per-extension daily trigger budget | `permissions.triggers.maxRunsPerDay` | C2 daemon |
| Auto-disable | 5 consecutive failures | delegation row update, mirroring `AUTO_DISABLE_AFTER` |
| Service-account daily spend | `max_cost_cents_per_day` | service-account resolution (D4) |
| Global kill switch | `EZCORP_DISABLE_DELEGATED_WORKFLOWS=1` | rung 1b |
| Whole capability tier off | `EZCORP_DISABLE_CAPABILITY_TOOLS=1` | rung 1 (existing) |
| Ship flag | delegation routes + `allowDelegated` clamp gated on a settings flag, default off | install/clamp |

---

## 4. Ported security invariants from ez-code-factory

`ez-code-factory` is deleted in phase 9. Its six documented invariants
(`docs/features/extensions/ez-code-factory.md:53-76`) plus twelve more that live
only in code are enumerated below. **Each names the regression test that must
exist so it cannot silently regress.** Nothing here is dropped; the git-specific
ones are captured for the later git template.

| # | Invariant | Lives today | Lands in | Regression test |
|---|---|---|---|---|
| 1 | **Trusted-branch config reads.** Executing keys (`commands.*`, `agent`, `document.instructions`, `disable_project_settings`, and the `allow_repo_commands` opt-in itself) are read ONLY from the freshly-fetched default branch at a pinned SHA — never the pushed ref. A default-branch fetch/parse failure aborts before any agent dispatches. Fixes a supply-chain-RCE-class bug. | `lib/repo-config.ts:186` `effectiveRepoConfig`, `:254` `assertGateTrustedConfigReadable`, `:337` `resolveTrustedRepoConfig` | **Deferred with the git template.** No v1 home — nothing in `ez-factory` reads config from a git ref. | `git-template-trusted-config.test.ts` — "pushed-branch commands are ignored without a trusted opt-in" + "unreadable trusted config aborts before dispatch" |
| 2 | **Verbatim ask-user relay.** A result carrying an `ask-user` finding is wrapped with a machine-enforced "relay verbatim; do not paraphrase or pre-judge; STOP" directive, structurally separating ask-user from agent-discretion findings. The LLM cannot see the finding without the directive. | `lib/chat-contract.ts:33` `RELAY_DIRECTIVE`, `:89` `formatGateRelay` | **Core, C4** — the `approval` step's chat card and inbox render the same structure; `directive` is non-null iff `stop` is true. | `src/__tests__/workflow-approval-relay.test.ts` — "an approval carrying blocking items renders the stop directive and the items verbatim" |
| 3 | **Patch-id force-push safety.** `rev-list --cherry-pick --right-only` against a last-observed anchor; refuse on out-of-band commits, naming them; `--force-with-lease=<ref>:<sha>` with an explicit anchor, never bare `--force`; unverifiable state fails closed. | `lib/steps/push.ts:62` `resolveForcePushDecision`, `:100` `remoteCommitsNotIncorporated`, `:39` `ForcePushWouldDiscardError` | **Deferred with the git template.** | `git-template-force-push.test.ts` — "refuses when the remote carries commits not incorporated by patch-id" |
| 4 | **HEAD continuity before every fix commit.** The worktree HEAD must still descend from the pipeline's last-recorded head, else abort to protect an out-of-band rewrite. | `lib/steps/common.ts:293` `assertPipelineHeadContinuity`, called at `:313` `commitAgentFixes` | **Deferred with the git template.** | `git-template-head-continuity.test.ts` — "a divergent or backward HEAD aborts the commit" |
| 5 | **No blanket approval.** An `approve`/`fix` that does not name explicit finding ids over a gate carrying ask-user findings is refused; a **clean** gate approves ids-free; standing consent bypasses and is **flagged for audit** (`consentAllUsed`), never silent. | `lib/chat-contract.ts:135` `enforceNamedApproval` | **Core, C4** — `requireItemConsent` on the `approval` step; `workflow_approvals.answered_item_ids` is the proof-of-surface. | `src/__tests__/workflow-approval-consent.test.ts` — "ids-free approve of an approval with items is refused; clean approval passes; consent-all is recorded" |
| 6 | **Named ids must exist.** A named finding id absent from the parked step's real set is rejected — junk ids cannot be smuggled through the length>0 check. | `lib/chat-contract.ts:171` `crossCheckFindingIds` | **Core, C4** — cross-check `answered_item_ids ⊆ item_ids`. | same spec as #5, case "invented item id is rejected" |
| 7 | **One shared respond chokepoint.** Both the chat tool and the Hub action clear the **same** guard function, in order, so the invariant cannot be bypassed by driving one surface instead of the other. | `lib/chat-contract.ts:207` `enforceRespondContract` | **Core, C4** — one `answerApproval()` service behind `POST /api/workflows/approvals/[id]`, the Hub card, and the chat card. Three views, one store, one guard. | `src/__tests__/workflow-approval-chokepoint.test.ts` — "every answer path routes through the same guard" (asserts by call-count on a spy, not by inspection) |
| 8 | **Fail-closed findings deserialization.** A missing, empty, or unrecognized `action` becomes `ask-user` (always blocks); an unknown `severity` normalizes to `error`; unknown `source` to `agent`. Enforced at the **deserialization boundary**, not in app logic. | `lib/runs.ts:265` `deserializeFinding`, `:301` `deserializeFindings` | **`ez-factory` tool** — the `emit_artifact` / validator finding schema parses through the identical fail-closed coercion. | `extensions/ez-factory/__tests__/findings-fail-closed.test.ts` — "unknown action ⇒ blocking" |
| 9 | **Nested jail for mutating ops.** The rw set is the worktree + the gate bare repo + `/dev` — **never the project root**, which is passed only as the forbidden `.ezcorp/data` anchor. Read-only ops stay on the plain runner. Containment is asserted read AND write, realpath-based. | `lib/jail.ts:73` `jailRwPaths`, `:116` `buildJailInvocation`, `:149` `makeJailedShell` | **Deferred with the git template.** `run_command` is cut from v1 (extension design §1.1) — `ez-factory` v1 requests no `shell` grant at all, so there is no v1 home for this. | `extensions/ez-factory/__tests__/run-command-jail.test.ts` — "a write outside the declared workspace is denied (landlock tier)"; must assert **read and write**, not just write |
| 10 | **Fail-safe jail widening.** `localUpstreamPath` returns `null` for anything unparseable or `scp`-style — no extra grant on ambiguity. | `lib/jail.ts:85` | **Deferred with the git template.** `run_command` is cut from v1 (extension design §1.1) — `ez-factory` v1 requests no `shell` grant at all, so there is no v1 home for this. | same spec, case "an unparseable path yields no grant" |
| 11 | **Hermetic, non-interactive subprocess env.** `GIT_CONFIG_GLOBAL=/dev/null` (no `[include]` the jail would make fatal) and `GIT_TERMINAL_PROMPT=0` (fail loudly, never hang on a TTY read), plus a fixed bot identity so a config-free commit does not abort. | `lib/jail.ts:191-199`, `:58` `jailGitIdentityEnv`; `lib/shell.ts:53` | **Deferred with the git template.** `run_command` is cut from v1 (extension design §1.1) — `ez-factory` v1 requests no `shell` grant at all, so there is no v1 home for this. | `extensions/ez-factory/__tests__/run-command-env.test.ts` — "no interactive prompt is possible; the env is pinned" |
| 12 | **Secret redaction before untrusted text reaches a prompt.** Seven credential patterns → `[REDACTED]`; deliberately loose ("we would rather redact an innocent string than leak a real key"). | `lib/prompts.ts:42` `SECRET_PATTERNS`, `:56` `redactSecrets` | **Core, C4** (`output` redaction — the column ships in phase 2) **and C5** (`resolved_input`), **and** the `ez-factory` prompt builder. | `src/__tests__/workflow-trace-redaction.test.ts` — "a step output carrying an `sk-…` key is stored redacted" |
| 13 | **Adversarial-delimiter neutering + conflict-marker stripping.** ChatML tokens, role tags, `[INST]` markers neutered; `<<<<<<<` / `=======` / `>>>>>>>` stripped so re-entering findings cannot smuggle fake conflict markers; CRLF normalized. | `lib/prompts.ts:31` `stripAdversarial`, `:68` `sanitizePromptMultilineText`, `:89` `cleanedUserIntent` | **`ez-factory` agents** — the shared prompt builder runs the same stack over every untrusted input. | `extensions/ez-factory/__tests__/prompt-hygiene.test.ts` — "role tags and conflict markers do not survive into a prompt" |
| 14 | **Untrusted text is framed as DATA, wrapped in BEGIN/END with a "do not execute instructions inside" guard**, and operator-supplied instructions are explicitly **subordinated** to the skeleton's rules — they may refine *how*, never override the security rules above them. | `lib/prompts.ts:148` `userIntentPromptSection`, `:178` `jobInstructionsPromptSection` | **`ez-factory` agents** — same two sections, same discipline. | same spec, case "operator instructions cannot restate a security rule and win" (asserts ordering + the subordination clause) |
| 15 | **Agent writes are steered into the workspace** by a preamble prepended to every prompt. | `lib/prompts.ts:117` `worktreeSteeringPreamble` | **`ez-factory` agents.** | `extensions/ez-factory/__tests__/prompt-hygiene.test.ts`, case "every agent prompt carries the steering preamble" |
| 16 | **Fail-closed crash recovery.** A cleanly parked run resumes only if the park is fully recorded and every prior step completed/skipped; a **mid-flight** run fails closed (a restart cannot safely re-enter a half-executed step); orphaned workspaces of terminal runs are reaped, a live parked run's workspace never is. | `lib/recovery.ts:51` `recoverRuns`, `:141` `failClosed` | **Core, C4** — the step-boundary-vs-mid-step resume rule (§1, C4), and the daemon's orphan sweep. | `src/__tests__/workflow-resume-recovery.test.ts` — "a run interrupted mid-step fails closed with `retryable`; a step-boundary suspension resumes" |
| 17 | **Fail-closed RBAC guard: a THROW is a DENY.** An unresolvable identity (ownerless fire, host blip) can never satisfy a grant; the refusal is a clear 403-style message, never a 500, and the run is never mutated. | `lib/rbac.ts:64` `guardScope` | **Core, C4** (`approval.rbacScope`) **and** the `ez-factory` manifest scopes. | `src/__tests__/workflow-approval-rbac.test.ts` — "a scope-check throw denies the answer and leaves the run untouched" |
| 18 | **Least privilege across triage verbs.** The broader action gets its **own** scope: `respond-gate` (answer one gate) vs `yolo` (clear every gate) vs `manage-jobs` (shape what future runs exist). A grant can hand out one without the others. Read-only reconcile is **not** scope-gated — it is also driven by a sweep with no acting user. | `lib/rbac.ts:28`, `:30`, `:35` | **`ez-factory` manifest** — `manage-jobs` / `run-job` / `approve-gate`, the same three-way split. | `extensions/ez-factory/__tests__/rbac-scopes.test.ts` — "`approve-gate` does not imply `manage-jobs`" |

**Count: 18 invariants** — the 6 documented, plus 12 more read out of the code.

**Six are deferred with the git template** (#1, #3, #4, #9, #10, #11): the three
git-specific ones, plus the three shell-jail ones, which defer because
`run_command` is **cut from v1** — the SDK provides no mediated shell, so
`permissions.shell` is an unbounded arbitrary-execution grant and neither v1
template needs it (extension design §1.1, §2.1). The remaining **twelve** land in
v1, split 8 to core and 4 to the extension. Phase 9 must not expect the six.

**Consequence worth stating:** `ez-factory` v1 requests **no unbounded
capability** — `storage`, `filesystem: ["$CWD"]` (host-mediated and audited),
`llm` (quota-capped), `triggers`, `workflows`. For an extension whose premise is
"anyone can install this and build factories", that is a product advantage, not
a reduction.

---

## 5. Test strategy

The feature contract in `CLAUDE.md` is binding: 100% coverage on each new source
file with a key in `scripts/coverage-thresholds.json`, 100% patch coverage,
a Playwright e2e spec for user-facing behaviour, and an `@evidence`-tagged spec
for any frontend-visual change. **No `EXCLUDES` entries, no lowered thresholds,
no `.skip`/`.only`, no assertion-free tests, no empty `catch {}` in test files.**

### Per-delta

| Delta | New source files → threshold key | Backend tests | E2E | `@evidence`? |
|---|---|---|---|---|
| **C1** | `src/runtime/workflow-model.ts` → 100 | validation matrix (literal vs ref, unknown provider/model/effort), precedence (`defaultModel` < step < job), absent ⇒ byte-identical `configToAgent` args | `workflows-per-step-model.spec.ts` — a definition with two model tiers runs and the detail page shows the model per step | **yes** — `/workflows/[name]` gains a per-step model column |
| **C2** | `src/extensions/triggers-handler.ts`, `packages/@ezcorp/sdk/src/runtime/triggers.ts` (covered by the `packages/@ezcorp/sdk/src/**` glob already at 100) → 100 | every ladder rung; envelope clamping; **`reconcileSchedules` and `reconcileWebhooks` leave `dynamic` rows alone** (the highest-value test in the phase); host-minted slug cannot be chosen or forged | `extensions-dynamic-triggers.spec.ts` — register a cron from a Hub action, see the row, uninstall-safe | **yes** — the trigger editor is a new form |
| **C3** | `src/db/queries/workflow-delegations.ts`, `src/db/queries/service-accounts.ts`, `src/runtime/workflow-capability-hash.ts` → 100 | one test **per rung** including every deny code; the two `audit_log`-not-`sdk_capability_calls` rungs; hash determinism under key reordering; each of the 8 hash inputs individually invalidating; each of the 4 non-inputs individually **not** invalidating; T1–T10 as named cases | `workflows-delegation.spec.ts` — consent dialog → job fires as owner → edit the workflow → next fire suspends with a capability diff → re-consent → resumes | **yes** — the consent dialog and the stale-consent diff card |
| **C4** | `src/runtime/workflow-runner-daemon.ts`, `src/db/queries/workflow-approvals.ts` → 100 | suspend/resume round-trip; mid-step fails closed; `finalizeWorkflowRunRow` CAS over `suspended`; orphan sweep leaves `suspended` alone; approval timeout; the shared-chokepoint spy; **the synchronous path is byte-identical** (assert the existing `workflows.spec.ts` and CLI exit codes unchanged) | `workflows-approvals.spec.ts`, `workflows-async-run.spec.ts` | **yes** — the approvals inbox is a new surface |
| **C5** | the four route files → 100 | redaction of secrets in `resolved_input`/`output`; size caps; NUL scrubbing on jsonb; cost as `NUMERIC` not float | `workflows-trace.spec.ts` — run a workflow, open the trace, assert model/tokens/cost/duration per step and *retry from here* | **yes** — the trace view is the largest new page in the program |
| **C6** | `src/db/queries/workflow-versions.ts`, the fork route → 100 | the three-way authorization ladder (system/project/private) × (owner/member/stranger/admin); **existing rows default to `system`, no backfill**; a version row per mutation; dry-run executes zero LLM and zero side effects | `workflows-ownership.spec.ts`, `workflows-fork.spec.ts`, `workflows-editor.spec.ts` | **yes** — editor, fork button, visibility badge |
| **C7** | none (changes land in existing files) — patch coverage only | `when` false ⇒ `skipped` + dependents skipped + run still succeeds; `skipDependents: false`; depth cap 3; cycle detection at definition time; `loop` legal on `workflow`, still illegal on `gate`/`tool` | `workflows-conditional.spec.ts` | **yes** — skipped steps render distinctly from failed ones |
| **ez-factory** | every `extensions/ez-factory/**` file → 100 (the 5 tools, 3 agents, jobs store, page builders) | per-tool: jail containment, path bounds, size caps, timeouts; job CRUD; the storage `withLock` read-modify-write rule (`src/extensions/CLAUDE.md`) | `ez-factory-console.spec.ts`, `ez-factory-job-editor.spec.ts`, `ez-factory-templates.spec.ts` | **yes** — two Hub pages |
| **phase 9** | — | delete `ez-code-factory` tests; **verify no orphan threshold keys remain** in `coverage-thresholds.json` | delete the five `ez-code-factory-*.spec.ts` specs | n/a |

### Cross-cutting

- **Never bare `bun test` at the repo root** — it deadlocks on cross-file
  `mock.module()` contamination. Use `bun run test` (one process per file);
  targeted single-file runs are fine.
- **New runtime event names go ONLY in `web/src/lib/runtime-event-names.ts:16`**,
  mirrored into the `@ezcorp/ai-kit` and `@ezcorp/harness-client` lists.
- **Every new `/api/*` route registers in `src/api-registry.ts`** with a scope
  (today only three workflow routes are registered, `:195-197`; C4 and C5 add
  six more).
- **The 18 ported invariants (§4) are a named checklist for phase 9's review** —
  no phase may land marking one "TODO".
- **Migration tests** run `migrate()` twice against a fresh PGlite and assert
  idempotency plus zero data change on the second pass; every backfill is
  asserted to be a no-op on re-run.

---

## 6. Phase dependency graph

```
        ┌──────────────────────────────────────────────┐
   0 ───┤  design record (this doc)                    │
        └──┬─────────────┬─────────────┬───────────────┘
           │             │             │
           ▼             ▼             ▼
     ┌───────────┐  ┌─────────┐  ┌───────────┐
     │ 1  C1     │  │ 5  C2   │  │ 6  C6     │
     │ per-step  │  │ dynamic │  │ ownership │
     │ model     │  │ triggers│  │ + versions│
     └─────┬─────┘  └────┬────┘  └─────┬─────┘
           │             │             │
           ▼             │             │
     ┌───────────┐       │             │
     │ 2  C4     │       │             │
     │ async +   │       │             │
     │ approval  │       │             │
     └──┬─────┬──┘       │             │
        │     │          │             │
        ▼     ▼          │             │
  ┌───────┐ ┌───────┐    │             │
  │ 3  C5 │ │ 4  C7 │    │             │
  │ trace │ │ compose│   │             │
  └───┬───┘ └───┬───┘    │             │
      │         │        │             │
      └────┬────┴────────┴──────┬──────┘
           ▼                    ▼
     ┌───────────┐        (6 also feeds 7)
     │ 7  C3     │
     │ delegated │
     └─────┬─────┘
           ▼
     ┌───────────┐
     │ 8  ez-    │
     │  factory  │
     └─────┬─────┘
           ▼
     ┌───────────┐
     │ 9  delete │
     │  + docs   │
     └───────────┘
```

### Strictly sequential — and why

| Edge | Reason |
|---|---|
| **0 → everything** | The migration ordering (§2.1) and the C3 ladder (§3.4) are the contract later phases implement against. |
| **1 → 2** | C4's daemon persists per-step `provider`/`model` on the step row; those columns are C1's migration. Landing 2 first means writing them twice. |
| **2 → 3** | C5's telemetry columns are written **by** the C4 daemon at each step boundary. Without the daemon there is no per-step commit point to write them from. |
| **2 → 4** | C7's `kind: "workflow"` runs a nested graph whose child must be independently suspendable and independently traced. Nesting a synchronous, unsuspendable run inside a suspendable parent produces a parent that can never park while a child is mid-flight. |
| **3 → 7** and **4 → 7** | C3's spend cap (rung D9) sums `workflow_step_runs.cost_usd` — a C5 column. C3's consent hash covers the **transitive closure** of nested workflows — a C7 concept. Landing C3 before either means shipping a spend cap that reads nothing and a hash that misses T4. |
| **6 → 7** | The consent hash pins `definitionVersionId` (§3.3 input 2) and rung D7 re-runs C6's authorization ladder as the owner. Without C6 there is no version to pin and no ladder to re-run — the hash would have to re-serialize the whole `steps` blob on every fire, and D7 would be a no-op. **This was the spec's one ordering error; the phases are now swapped** (§7.8). |
| **5 → 8** | `ez-factory` jobs are user-created triggers. Without `ctx.triggers` the extension has manual-only jobs — a demo, not the product. |
| **7 → 8** | Without `runFor`, a cron or webhook job cannot fire at all (`-32106`). |
| **8 → 9** | You cannot delete the old extension before the replacement exists. |

### Can run in parallel

- **1, 5 and 6** — three disjoint file sets (runtime/model, extensions/triggers,
  db+web/workflows-CRUD). The only shared file is `src/db/migrate.ts`, and
  because migrations are append-only idempotent DDL the conflicts are trivial
  textual ones at the end of the function. **This is the widest parallel front in
  the program — take it.**
- **3 and 4**, once 2 lands. C5 is read-side (routes + a page); C7 is
  executor-side (`runStep`, `runLoop`, the validator). They touch
  `src/types.ts` and `workflow_step_runs` in different places.
- Documentation for each delta can be drafted alongside its phase; only phase 9's
  `workflows.md` rewrite must come last, because it describes the union.

### The critical path

`0 → 1 → 2 → {3,4} → 6 → 7 → 8 → 9`. Phase 5 is fully off it and can land any
time after 0. Phases **1–4 are a real automation engine on their own** — a
per-step-model, async, suspendable, human-gated, traced, composable workflow
runner. If the program stops after phase 4, core is strictly better than today
and nothing is half-built.

---

## 7. Where the spec is wrong or infeasible

Ordered by how much a phase would suffer for not knowing.

> **All eight are resolved.** The team lead independently re-verified the four
> load-bearing claims against source at `main@abc41f35` and accepted every
> recommendation on 2026-07-29; `tasks/2026-07-29-ez-factory-replan.md` now
> carries the corrections inline under its own "Corrections applied" header.
> This section is kept as the **audit trail** — what was wrong, how it was
> found, and what was decided. Nothing here is open.

### 7.0 Method — where spec errors actually live

`ph5-build`'s closing observation, recorded here rather than left in a chat log
because it generalises past this program:

> **All nine C2 spec errors came from claims the spec made without a
> `file:line` citation. Every cited claim held.**

That is a nine-for-nine split on a single axis, and it has a mechanical reading:
writing a citation forces the author to open the file, and opening the file is
what catches the error. An uncited claim was never checked against source — it
was recalled, inferred from symmetry with a neighbouring subsystem, or carried
forward from an earlier draft.

**So review a spec by citation density, not front to back.** Sort the
assertions into cited and uncited, verify the uncited ones first, and treat a
cited claim as low-yield until the uncited pile is exhausted. It also gives
spec authors a cheap self-check: an assertion you cannot cite is one you have
not verified, and the honest move is to either go and cite it or mark it
explicitly as an assumption.

Two caveats, so this is not applied further than the evidence supports. It says
nothing about a citation that is itself *wrong* — §7.5 in this document was
exactly that, a confidently wrong line number — so verifying citations remains
necessary; the claim is only that uncited assertions are the richer seam. And
it is one delta's worth of evidence. If C4, C6 and C3 land with the same split,
it is a rule; today it is a strong prior worth acting on.

### 7.1 `async: true` in the run body is swallowed by the `.loose()` schema — **was blocking for phase 2 · RESOLVED**

The spec: "`POST /api/workflows/[name]/run` gains `async: true`".

The route's body schema is `z.object({ projectId: z.string().optional() }).loose()`
(`web/src/routes/api/workflows/[name]/run/+server.ts:14-16`) and the handler does
`const { projectId, ...input } = parsed.data` (`:31`). **Every field that is not
`projectId` is workflow input.** Adding a top-level `async` key means a workflow
with an input field named `async` can never receive it — exactly the
`projectId` collision already documented as a trap
(`docs/features/orchestration/workflows.md:156, 254`), which the team has
already been bitten by once.

**Decided — the `X-EZ-Workflow-Async: 1` request header.** The alternative was a
sibling route (`POST /api/workflows/[name]/run/async`); the header wins because
it keeps one route and one registry entry, and the sync/async contract stays
visibly the same call. The deciding argument is stronger than convenience:
**HTTP headers and workflow input are structurally different namespaces, so the
collision is impossible by construction** — a reserved body key like `_ez` would
only make the documented `projectId` trap rarer, not gone. Sync remains the
default when the header is absent.

### 7.2 C2 names only `reconcileSchedules`; `reconcileWebhooks` needs the identical exemption — **was blocking for phase 5 · RESOLVED**

The spec: "`reconcileSchedules` learns to leave dynamic rows alone."

There are **two** reconcilers with the same soft-disable behaviour:
`reconcileSchedules` (`src/extensions/schedule-reconcile.ts:20`, sweep at
`:55-73`) and `reconcileWebhooks` (`src/extensions/webhook-reconcile.ts:28`).
Both run on install/update. Without the exemption in **both**, updating
`ez-factory` silently disables every user-created webhook job.

Additionally, `reconcileWebhooks` derives its `disabled` count from a **pre-fetch
snapshot** (`src/extensions/webhook-reconcile.ts:56`) because PGlite's UPDATE
`rowCount` is unreliable. Dynamic rows must be excluded from that snapshot too,
or the audited count lies.

And a third, unnamed hazard: `uniq_ext_schedule ON (extension_id, cron)`
(`src/db/schema.ts:1414`) means **two dynamic jobs in one extension cannot share
a cron expression** — 25 jobs at "0 3 * * 1" is a plausible ask and would fail.
Relax it to `WHERE dynamic = false`.

### 7.3 The `terminalizeOrphanedWorkflowRuns` hazard is stated backwards — **mattered for phase 2 · RESOLVED**

The spec: "`terminalizeOrphanedWorkflowRuns` must **skip `suspended`** — today it
would eat every parked job on restart."

The predicate is `and(eq(status,'running'), lt(startedAt, cutoff))`
(`src/db/queries/workflow-runs.ts:190`). A `suspended` run is **already excluded
structurally** — no change needed, and no change should be made: the sweep's
single-predicate simplicity is the reason it is correct.

The real hazards are two others the spec does not mention:

1. A run that is `running` at crash time, with a committed cursor, is drained to
   `error` even though it is resumable.

   > **Superseded 2026-07-29.** This document originally answered "transition to
   > `suspended` before every await point, not by teaching the sweep about
   > `resumable` — keep the sweep dumb." **That answer is wrong** and the C4 spec
   > §1 disproves it: of the eight await sites in `runWorkflow`, only `:186`
   > precedes a step. Marking a run `suspended` before the tool dispatch
   > (`src/runtime/workflow-executor.ts:780`) asserts "parked at a boundary, safe
   > to resume" while a `write_file` may already have landed — a resume then
   > re-enters a half-executed step, contradicting ported invariant #16 (§4).
   >
   > **Corrected model — commit-at-boundary, claim-with-lease,
   > decide-at-recovery** (§2.3 hazard 1). The "dumb sweep" intent is preserved
   > precisely: the sweep's *selection* stays one predicate
   > (`status='running' AND lease_expires_at < now()`); only its *action*
   > branches on an honestly-maintained `run_phase`.
2. `finalizeWorkflowRunRow` is a CAS on `WHERE status='running'`
   (`src/db/queries/workflow-runs.ts:128-140`). A run **cancelled while
   suspended** silently no-ops. Widen to `status IN ('running','suspended')`,
   keeping the zero-row-no-op contract.

### 7.4 C3's `ON DELETE SET NULL → the job auto-disables` is infeasible **and** unsafe — **was blocking for phase 7 · RESOLVED**

Two problems.

**Infeasible:** the job record lives in extension `Storage` (a KV blob under
`.ezcorp/extension-data/ez-factory/`, per the spec's own §6.1). It is not a DB
row and has **no FK to fire**. Nothing in Postgres can auto-disable it.

**Unsafe:** applying `SET NULL` to the delegation's owner column produces a row
that is `enabled`, carries a valid consent hash, and names **nobody** — a latent
ownerless grant, which is precisely the state `-32106` exists to prevent.

**Decided — a real `workflow_delegations` table (§2.7) with `ON DELETE CASCADE`
on `owner_user_id`.** Deleting the user deletes the
authority. The job's next fire finds no delegation at rung D2 and refuses; the
extension surfaces "disabled: owner removed". Same user-visible outcome, achieved
by the database rather than by hope.

### 7.5 `-32106` is not at `workflows-handler.ts:280` — **citation error · RESOLVED**

The spec cites `src/extensions/workflows-handler.ts:280`. Line 280 is inside
rung 6 (the PDP branch). The ownerless guard is at **`:291-311`**, with the
`rpcError(req.id, -32106, …)` at **`:310`**. The shared refusal is at
`src/extensions/tool-executor/provenance.ts:79-92`.

Two smaller drifts: `sdk/src/runtime/spawn.ts:79` → the overrides field is
`overrides?: Record<string, unknown>` at
`packages/@ezcorp/sdk/src/runtime/spawn.ts:83` (substance correct — the doc
comment at `:80-83` names `model`/`provider`). `sdk/src/runtime/webhook.ts:53` →
the quoted sentence is at `:54` (comment spans `:52-55`).

### 7.6 C5's "every step, every iteration" cannot be stored in `workflow_step_runs` — **mattered for phase 3 · RESOLVED**

The upsert arbiter is `uniq_workflow_step_run ON (workflow_run_id, step_name)`
(`src/db/schema.ts:460`, used at `src/db/queries/workflow-runs.ts:112-113`). A
looped step therefore has **exactly one row**, and `iteration` can only hold the
last value. The trace view's stated requirement — "every step, **every
iteration**" — is unstorable in this shape.

Two ways out. Widening the arbiter to `(workflow_run_id, step_name, iteration)`
is a **destructive** index change requiring a `DROP INDEX` plus a backfill of
`iteration = 1`. A child `workflow_step_iterations` table is purely additive,
needs no backfill, and leaves the existing upsert and its tests untouched.
**Decided — the child table.** Never widen a live arbiter for a purely additive need.

### 7.7 C1's `defaultModel` and the "job overrides again" layer are not in the type system — **minor, phase 1/8 · RESOLVED**

The spec describes three precedence layers: definition `defaultModel`, per-step
`model`, per-job override. `WorkflowDefinition` (`src/types.ts:327-332` at HEAD)
has only `{ name, description, inputSchema?, steps }`. The job layer lives in
extension `Storage` and reaches the executor only through `input`, which is
16KB-capped (`src/extensions/workflows-handler.ts:95`) and resolved by the ref
language.

Phase 1 must add `defaultModel` to `WorkflowDefinition` **and** to the create /
update route schemas (`web/src/routes/api/workflows/schema.ts`) — otherwise a job
can only express per-step models via `$input.*` refs, which works but is a
strictly worse authoring experience than the spec advertises. Phase 8 then
threads the job's overrides as `$input` fields, sized against the 16KB cap.

### 7.8 The phase order puts C3 (6) before C6 (7), but C3 depends on C6 — **was blocking · RESOLVED**

The spec's table runs `… 5 → 6 (C3) → 7 (C6) → 8`. But:

- the consent hash pins `definitionVersionId` (§3.3, input 2) — a C6 concept;
- rung D7 re-runs C6's run-authorization ladder as the owner — without C6 there
  **is** no ladder (any `chat` caller can run anything today,
  `docs/features/orchestration/workflows.md:248`), so D7 is a no-op and the
  "cannot grant reach the owner does not have" bound is unenforced;
- and without versioning, the hash must re-serialize the whole `steps` blob on
  every fire.

**Decided — swapped.** C6 is phase 6; C3 is phase 7 and ships last. §6's graph
and the spec's §7 table both carry the corrected order, and every phase-number
cross-reference in both documents has been re-checked (§6 edge table, the
parallel front, the critical path, and the spec's "Phases 5–7" sentence).

### Also worth knowing (not errors)

- **`permissions.webhooks` is `string[]`, not an object**
  (`src/extensions/types.ts:580`). C2's new `permissions.triggers` envelope is a
  separate key; do not try to extend the slug array in place.
- **`LlmCompleteOpts.provider` and `.model` are required, not optional**
  (`packages/@ezcorp/sdk/src/runtime/llm.ts:27-36`), and there is **no `effort`
  field** — the SDK surface is fine as the spec describes it, but C1's `effort`
  has no home on the raw options and must route through the pi-ai normalizer.
  Phase 1 has already found this and isolated it in `src/runtime/workflow-model.ts`.
- **`spawnAssignment`'s per-member overrides are an opaque
  `Record<string, unknown>`** forwarded to `startAssignment` → `streamChat`
  (`packages/@ezcorp/sdk/src/runtime/spawn.ts:83`). It is a precedent for the
  *shape* of C1's override bundle, not a typed contract to reuse.
- **Two existing `awaiting_approval` traps carry over to `suspended`**: nothing
  branching on `status === "error"` will match it
  (`docs/features/orchestration/workflows.md:243`), and the parked capability
  name is collapsed onto `shell`/`fs.write` before the gate opens (`:244`), so
  an `approval` step's reported capability may not be the PDP's true one.
- **A workflow tool step writes no `tool_calls` row** — the synthetic
  `workflow-run:<id>` conversation id has no `conversations` row and
  `persistToolCall` silently drops it (`docs/features/orchestration/workflows.md:245`).
  C5's trace must not expect one; `workflow_step_runs` and the PDP's own audit
  row are the trail.
