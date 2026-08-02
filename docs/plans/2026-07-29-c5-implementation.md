# C5 implementation spec — trace, cost telemetry, run read API

**Status:** Binding for phase 3
**Date:** 2026-07-29
**Implements:** C5 of [2026-07-29-ez-factory-design.md](2026-07-29-ez-factory-design.md)
**Depends on:** C1 (landed), C4 steps 1–4 (landed) · **see §7 for the steps 5–9 dependencies I could not read**
**Scope:** `src/db/`, `src/runtime/`, `web/src/routes/api/workflows/**`, `web/src/routes/(app)/workflows/**`

> **Citation anchor.** Verified at **`e736566a`**. Phase 2 is still committing;
> `workflow-executor.ts` and `workflow-runs.ts` move under every read. Anchor on
> the **symbol name**, not the number.

**§1 is the reason this document exists.** Two things the design record claims
about C5 are wrong, and one of them — "factory spend appears in the existing
cost dashboard **for free**" — is mine.

---

## 1. Findings against the real source

### 1.1 `obs:turn` cannot carry factory spend to the existing dashboard · **BLOCKING, and the design record is wrong**

The design record's C5 section says: *"Agent steps emit `obs:turn` events, so
factory spend appears in the **existing** observability cost dashboard for
free."* That is false for **two independent reasons**, either of which alone
kills it.

**(a) A workflow agent step never traverses the path that emits `obs:turn`.**
`obs:turn` is emitted in exactly one place —
`src/runtime/stream-chat/finalize.ts:110`. A workflow `agent` step runs through
`configToAgent`, whose LLM call is `ctx.llm.complete(...)`
(`src/runtime/config-to-agent.ts:80`) against the pi-llm adapter. It does not go
through `streamChat` at all, so the event is never emitted.

**(b) Even if it were emitted, the row cannot be written.**
`ObservabilityCollector` maps every subscribed event to
`insertObservabilityEvent({ conversationId, … })`, whose parameter is a
**required `string`** (`src/db/queries/observability.ts:7-13`), inserting into
`observability_events.conversation_id` — **`NOT NULL`, FK to `conversations`**
(`src/db/schema.ts:809`). A workflow has no conversation: it mints the synthetic
`workflow-run:<id>` scope key, which has no `conversations` row by design.

This is the **same structural fact** already documented for tool calls:

> A workflow tool step writes no `tool_calls` row… the synthetic
> `workflow-run:<id>` id has no row, so `persistToolCall` silently drops it.
> — `docs/features/orchestration/workflows.md:318`

So the "for free" claim was never true, and the design record must be corrected.

**Resolution — aggregate, do not widen.** Three options were considered:

| Option | Verdict |
|---|---|
| Make `observability_events.conversation_id` nullable | **Rejected.** Widening a shared audit table's FK to serve one subsystem, then auditing every existing dashboard query for the new NULL case. Large blast radius for a reporting convenience. |
| A parallel workflow-cost table | **Rejected.** `workflow_step_runs.cost_usd` already is that table. A second one is the "second cost plane" this item exists to avoid. |
| **The dashboard aggregates across both planes** | **Adopted.** `workflow_step_runs` is already the authoritative per-step cost record. The dashboard's cost query gains a UNION over it, keyed by time and provider/model. No schema change, no FK widening, no duplicate storage. |

The trace view (§5) is the *detail* surface; the dashboard remains the
*aggregate* surface and simply learns a second source.

### 1.2 Token counts are produced and then discarded before they can be persisted

The adapter **does** return usage: `complete` returns
`{ text, usage: { inputTokens, outputTokens } }`
(`src/runtime/executor-helpers.ts:153`) and the stream's `done` event carries the
same (`:179`).

But `AgentRun` (`src/types.ts`) carries **`provider` and `model` and no usage
fields at all** — so the counts are dropped at that boundary, and
`runAgentAttempt` (which stamps `stepRun.provider` / `.model`) has nothing to
stamp for tokens.

C5 must therefore thread usage the **same way C1 threaded provider/model**:
adapter → `AgentRun` → `stepRun` → `workflow_step_runs`. That is a real plumbing
change in `executor.ts`, not a pure-additive column. It is small and the
precedent is exact, but it is not free and should be sized as such.

### 1.3 There is no host-side price table, so `cost_usd` cannot be computed in phase 3

I searched `src/providers/` and `src/runtime/` for a cost/pricing source and
found **none** — no `costCents`, no per-token price map, nothing. The SDK's
`LlmUsage.estCostCents` (`packages/@ezcorp/sdk/src/runtime/llm.ts`) is the
*extension* surface and is not populated host-side.

**Consequence:** C5 ships **tokens now, cost later.** `cost_usd` is added as a
nullable column and left NULL; the trace view renders tokens and shows cost as
"—" with a tooltip. Introducing a price table is its own change (it needs a
source of truth, a refresh path, and a per-provider currency decision) and
bundling it here would make C5 unshippable on a pricing argument.

**This has a knock-on for C3.** C3's rung D9 (per-job spend cap) sums
`workflow_step_runs.cost_usd`. With that column NULL, **D9 cannot enforce
anything.** C3 must either land the price table itself or bound spend on
**tokens** instead. Flagged in §7 and worth telling whoever builds C3.

---

## 2. `workflow_step_iterations` — the additive child table

`workflow_step_runs` upserts on `(workflow_run_id, step_name)`
(`uniq_workflow_step_run`), so a looped step has exactly **one** row and
per-iteration facts cannot live there.

**Widening the arbiter to `(workflow_run_id, step_name, iteration)` is
rejected**: it is a `DROP INDEX` plus a backfill of `iteration = 1` against live
history, to serve a purely additive need — and phase 5 just demonstrated
(C2 review) that narrowing a live unique index can silently remove a constraint
that was doing useful work. A child table costs one join and risks nothing.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `TEXT` PK | no | |
| `workflow_step_run_id` | `TEXT` → `workflow_step_runs(id)` **ON DELETE CASCADE** | no | an iteration without its step is meaningless — unlike run *history*, which is preserved via `SET NULL` |
| `iteration` | `INTEGER` | no | 1-based, matching `$loop.iteration` |
| `attempt` | `INTEGER` | no | retry attempt within the iteration; `0` for the first |
| `status` | `TEXT` | no | `WorkflowRunStatus` |
| `run_id` | `TEXT` → `runs(id)` **ON DELETE SET NULL** | yes | the `AgentRun` for this iteration |
| `provider` / `model` | `TEXT` | yes | may differ per iteration — a `$loop.*` binding escalates cheap→strong (C1, `workflow-executor.ts` loop site) |
| `input_tokens` / `output_tokens` | `INTEGER` | yes | |
| `cost_usd` | `NUMERIC(12,6)` | yes | NULL until a price table exists (§1.3) |
| `duration_ms` | `INTEGER` | yes | |
| `error_code` | `TEXT` | yes | |
| `created_at` | `TIMESTAMPTZ` | no | `NOW()` |

- `uniq_workflow_step_iteration ON (workflow_step_run_id, iteration, attempt)` — the upsert arbiter.
- `idx_workflow_step_iterations_step ON (workflow_step_run_id)` — the trace query, and the FK's delete scan.

**Retention:** iterations are capped at the loop ceiling (25,
`MAX_ITERATIONS_CEILING`) × the retry ceiling (2, `RETRIES_CEILING`), so a step
can produce at most ~75 rows and no sweep is needed. Cascade with the run.

**`workflow_step_runs.iterations` (the count) stays** — it is the summary the
existing SSE payload already carries, and the child table is the detail.

---

## 3. Telemetry columns on `workflow_step_runs`

**Already landed — do not re-specify:** `provider`, `model` (C1);
`output` (C4 step 2).

| Column | Type | Null | Notes |
|---|---|---|---|
| `attempt` | `INTEGER` | yes | final attempt count for a non-looped step |
| `input_tokens` | `INTEGER` | yes | §1.2 plumbing |
| `output_tokens` | `INTEGER` | yes | |
| `cost_usd` | `NUMERIC(12,6)` | yes | **NULL in phase 3** (§1.3). `NUMERIC`, not float — a dashboard that sums floats accumulates error, and C3's spend cap reads this. |
| `duration_ms` | `INTEGER` | yes | wall-clock for the step, including retries |
| `error_code` | `TEXT` | yes | the typed reason, not the message |
| `resolved_input` | `JSONB` | yes | redacted + capped, §4 |
| `skipped_reason` | `TEXT` | yes | populated by C7's `when`; NULL until then |

`skipped_reason` is added now and written by C7 — a nullable column with no
writer for one phase is acceptable here (unlike C3's `run_as`, which C4 correctly
deferred) because C7 is the *immediately following* phase and the column is inert
rather than misleading.

---

## 4. Redaction — one redactor, not two

`resolved_input` carries whatever the ref language resolved, which routinely
includes credentials threaded through `$input`. It gets **exactly** the treatment
C4 established for `output`:

**Redact first, then measure.** `prepareStepOutput`
(`src/runtime/workflow-step-output.ts`) calls `redactSecretsDeep` **before**
computing the byte cap, so the stored bytes are the redacted bytes. C5 reuses
that module — `redactSecretsDeep` from `src/runtime/secret-redaction.ts:60` — via
a sibling `prepareResolvedInput` in the **same file**, not a second implementation.

This is **ported invariant 12**, and it is the row most likely to be quietly
skipped, so §9 row 3 asserts it by grep as well as by test: there must be exactly
one module exporting a redactor, and every jsonb payload column must route
through it.

Cap: 64 KB for `resolved_input` (smaller than `output`'s 256 KB — an input
mapping is a handful of refs, and a large one is a smell). On overflow store
`{ __truncated: true, bytes }`, the same sentinel shape, so a reader has one case
to handle rather than two.

---

## 5. The read API and the trace view

### 5.1 Routes

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/workflows/runs` | `read` | list; filters `workflowName`, `status`, `projectId`, `since`, `until`; cursor pagination on `(started_at, id)` |
| `GET /api/workflows/runs/[id]` | `read` | one run: the run row, its step rows, and each step's iterations |
| `GET /api/workflows/runs/[id]/steps/[step]/iterations` | `read` | the iteration detail, split so the trace page can lazy-load a hot loop |

All three register in `src/api-registry.ts` (category `workflows`, alongside the
existing three at `:195-197`). Cursor pagination, not offset — a run list ordered
by `started_at DESC` with offset skips rows as new runs arrive.

Page size default 50, cap 200.

### 5.2 Authorization — the part that must not ship loose

**C6 has not shipped, so `workflow_definitions` has no owner and
`POST …/[name]/run` has no owner scoping.** A run trace, however, carries
`resolved_input` and `output` — **redacted, but redaction is a loose regex pass,
not a guarantee**. Shipping an unscoped read over that is worse than shipping no
read at all.

**C5's interim rule — strictest available, tightened by C6 later:**

| Caller | May read |
|---|---|
| `admin` | any run |
| the run's `user_id` | that run |
| anyone else | **nothing** — 404, not 403, so the endpoint is not an existence oracle |

`workflow_runs.user_id` already exists and is the initiating principal, so this
is enforceable **today** with no new schema. Runs with `user_id IS NULL` (CLI,
extension-triggered) are **admin-only**, which is the fail-closed reading and
matches the column's own documented rationale in `schema.ts`.

**What C6 must tighten:** once `workflow_definitions` carries
`project_id`/`user_id`/`visibility`, the trace read moves onto
`resolveWorkflowForCaller` so a project member can read a project workflow's runs
without being the initiator. **Until then the rule above is deliberately narrower
than the eventual one** — a user who can *run* a system workflow cannot read
another user's trace of it. That is the correct direction to be wrong in.

### 5.3 The trace view — `/workflows/runs/[id]`

DAG + timeline. Per step: status, **model used**, tokens, cost (or "—", §1.3),
duration, resolved input, output, loop iterations (lazy-loaded), linked agent
transcript, and **Retry from here**.

`suspended` / `resumable` / `suspended_reason` render as first-class states —
they exist in the schema today (C4 step 1) even though resume does not, so the
view must not assume a run is terminal.

**`@evidence` spec required** — this is the largest new page in the program.

### 5.4 SSE

`workflow:step-log` is the only new event name, and it goes **only** in
`web/src/lib/runtime-event-names.ts` (the binding invariant), mirrored into the
`@ezcorp/ai-kit` and `@ezcorp/harness-client` lists. `workflow:approval` belongs
to C4, not here.

---

## 6. Cost attribution

**Where the numbers come from:** the adapter's `usage` (`executor-helpers.ts:153`
for `complete`, `:179` for the stream's `done` event), threaded through
`AgentRun` per §1.2.

**When a provider returns no usage** — which happens: a cached response, a
provider that omits it, a stream that errors mid-flight — store **NULL, never
zero**. Zero is a claim ("this call cost nothing") and it silently deflates every
aggregate that sums it; NULL is the truth ("not reported") and every SQL
aggregate already ignores it. The trace renders "not reported", not "0".

**Per-run rollups are computed, never stored.** `SUM` over the step rows at read
time. A stored rollup is a denormalization that drifts the moment a step row is
corrected, and the row counts here are small.

---

## 7. Dependencies on steps 5–9 I could **not** read

Phase 2's steps 5–9 are not built, so these are stated as dependencies rather
than guessed at:

| Dependency | Why it matters | Status |
|---|---|---|
| **`suspended` run states** in the trace view | §5.3 renders them; the columns exist (step 1) but no run ever reaches `suspended` yet, so the rendering is **untestable end-to-end** until step 5 | Columns readable; behaviour **guessed** |
| **The `approval` step kind** | An approval step's telemetry row shape (does it get tokens? duration?) is undefined until the kind exists | **Not specced here** — C5 treats an unknown kind as "no LLM telemetry" |
| **`workflow:approval` SSE** | C4's, not C5's — listed only so the two are not double-added | Deferred to C4 |
| **Retry-from-here** | The button is C5's; the **mechanism** is C4's resume path, which does not exist | UI specced, **wired in phase 2's step 5+** |

Where I had to guess, §9 row 7 requires the phase-3 build to **re-verify against
the landed step 5–9 code** rather than trusting this document.

---

## 8. Migration, tests, build order

### 8.1 Migration

All additive, appended after C4's `workflow_step_runs` block:

1. Eight `ALTER TABLE workflow_step_runs ADD COLUMN IF NOT EXISTS …` (§3)
2. `CREATE TABLE IF NOT EXISTS workflow_step_iterations (…)` + its two indexes
3. **No backfill** — every column is genuinely absent for historical rows and
   NULL is the honest value. Inventing zeros would corrupt the first aggregate
   anyone runs.

`schema.ts` and `migrate.ts` in lockstep.

### 8.2 Tests

New files → threshold keys (100): the three route files,
`src/db/queries/workflow-step-iterations.ts`, and whatever `prepareResolvedInput`
lands in (`workflow-step-output.ts` already has a key).

- **Redaction (highest value):** a `resolved_input` containing `sk-…`, a bearer
  token and a JWT is stored redacted; the byte cap is measured **after**
  redaction; oversize stores the `__truncated` sentinel.
- **Authorization matrix:** `{admin, owner, stranger, api-key-no-user}` ×
  `{run with user_id, run with NULL user_id}` — eight cases, and **unauthorized
  is 404** in every one.
- **Usage threading:** an agent step's tokens reach `workflow_step_runs`; a
  provider returning no usage stores **NULL, not 0**.
- **Iterations:** a 3-iteration loop writes 3 rows with distinct `iteration`, and
  a per-iteration model change is visible.
- **Pagination:** a cursor page is stable across an insert (the offset bug this
  design avoids).
- **Canaries:** existing workflow e2e specs pass unmodified.

### 8.3 Build order

| # | Land | Why here |
|---|---|---|
| 1 | Migration + schema + the child table. No behaviour. | Additive, provable alone. |
| 2 | `prepareResolvedInput` in the existing module + its redaction tests. | The security-relevant piece, before anything writes the column. |
| 3 | Usage threading adapter → `AgentRun` → `stepRun` (§1.2). | The only executor surgery; isolated. |
| 4 | Iteration rows written by the loop runner. | Needs 3 for per-iteration tokens. |
| 5 | The three read routes + the authorization matrix + registry entries. | Read surface on data that now exists. |
| 6 | The trace view + `@evidence`. | |
| 7 | Dashboard UNION over `workflow_step_runs` (§1.1). | Last — it is a reporting change, not a correctness one. |

Steps 1–2 are worth landing alone: they make the redaction guarantee real before
any payload column is written.

---

## 9. Acceptance criteria

Falsifiable. **A floor, not a ceiling**; §9.1 is what the rows cannot cover.

| # | Criterion | Proven by |
|---|---|---|
| 1 | Per-iteration rows exist and the `workflow_step_runs` arbiter is **unchanged**. | Grep: `uniq_workflow_step_run` untouched. A 3-iteration loop writes 3 child rows. |
| 2 | `cost_usd` is `NUMERIC`, not float, and is **NULL** in phase 3 (§1.3). | Schema assertion + a test that no code path writes it. |
| 3 | **One redactor.** Exactly one module exports a redactor, and every jsonb payload column routes through it. | Grep for a second `redactSecrets*` implementation; a test that `resolved_input` is redacted **before** measuring. |
| 4 | Unauthorized read is **404**, never 403 or 200. | The eight-case matrix; asserted per-status. |
| 5 | A run with `user_id IS NULL` is **admin-only**. | Named test — this is the fail-closed case for CLI and extension-triggered runs. |
| 6 | Missing provider usage stores **NULL, not 0**. | Named test. Zero is a claim; NULL is the truth. |
| 7 | The steps 5–9 assumptions in §7 were **re-verified against landed code**, not inherited from this doc. | A checklist item in the phase-3 PR description naming each. |
| 8 | No second cost plane. | Grep: no new cost table; the dashboard reads `workflow_step_runs`. |

### 9.1 Beyond the checklist

- **Interaction:** redaction (row 3) and the byte cap both transform
  `resolved_input`. Verify a payload that is *only* oversize **after** redaction
  expands it (redaction lengthens: `sk-…` → `[REDACTED]` can be longer) still
  caps correctly — the order is redact-then-measure precisely so this works, and
  a test should pin it rather than assume.
- **Migration extensibility:** can C7 add `skipped_reason` writes and C3 add a
  spend-cap read without touching this shape? The nullable columns say yes;
  verify the query layer does not `NOT NULL`-assert them.
- **Meaningless coverage:** the route tests must assert the **response body
  shape**, not merely a 200.
- **Untested by default:** a run whose step rows outnumber the page size; an
  iteration row orphaned by a step-row delete (CASCADE); a trace read racing a
  run that is still writing steps.

**And the standing one:** anything here the build proves wrong. §1 already
records two errors in the design record, one of them mine — a third is a better
outcome than a spec defended past its evidence.
