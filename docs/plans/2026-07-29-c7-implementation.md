# C7 implementation spec — conditional skip, sub-workflows, looped composition

**Status:** Binding for phase 4
**Date:** 2026-07-29
**Implements:** C7 of [2026-07-29-ez-factory-design.md](2026-07-29-ez-factory-design.md)
**Depends on:** C4 steps 1–4 (landed) · **steps 5–9 unbuilt — see §4**
**Scope:** `src/types.ts`, `src/runtime/workflow-*.ts`, `src/db/`

> **Citation anchor.** Verified at **`b9ffeaee`**. Phase 2 is still committing —
> `workflow-executor.ts` moved between reads during the last two reviews. Anchor
> on the **symbol name**.

**§1 is the reason this document exists.** Conditional skip interacts with the
ref language in a way that **silently breaks existing graphs** unless it is
specified precisely, and the design record's one-line description does not
address it.

---

## 1. The skip/ref ambiguity — the sharp edge

### 1.1 The facts

`workflow-refs.ts` is explicit about strictness (module doc `:12-19`, enforced at
`:72`, `:81`, `:99-102`):

- **`$steps.<name>` is STRICT on the step.** A reference to a step that has not
  produced a result **throws** a descriptive error. Lenient only on the *field*,
  and only for conditions.
- **`$prev` is STRICT.** `prevResult === undefined` throws.

A skipped step produces **no result**. So a downstream `$steps.<skipped>` throws
— and C7's entire premise is that a skipped step leaves the run **succeeding**.

### 1.2 Why `skipDependents` does not cover it

The dependency graph is built from **`dependsOn`** (`resolveExecutionOrder`),
while strictness is enforced against **refs**. **Those two are independent
today** — nothing requires a step that reads `$steps.X` to declare
`dependsOn: [X]`, and the ref resolver never consults the graph.

So `skipDependents: true` correctly skips declared dependents, and a step that
reads `$steps.<skipped>` **without declaring the dependency** still runs, hits
the strict ref, and **throws — failing a run C7 promised would succeed.**

That is the silent breakage: a graph that works today (because nothing is ever
skipped) starts failing the moment someone adds a `when` upstream of an
undeclared reader.

### 1.3 Resolution — three rules, in this order

**Rule 1 — a skipped step's result is `SKIPPED`, not absent.** The executor
records a distinct sentinel in `stepResults` rather than leaving the key unset.
This is what lets the resolver distinguish "skipped" (a known outcome) from
"has not run yet" (a graph error), which it currently cannot.

**Rule 2 — `$steps.<skipped>` throws a *different, actionable* error.** Not the
generic "no result yet", but:

> `Cannot resolve "$steps.draft.path" for step input "x": step "draft" was
> SKIPPED (its `when` evaluated false). Declare `dependsOn: ["draft"]` so this
> step is skipped too, or guard it with its own `when`.`

Still a failure — silently substituting `undefined` would hand a downstream step
a broken value and is exactly the "silently changes existing graphs" outcome —
but the message names the fix. **Loud failure is the subsystem's stated rule**
(`workflows.md` design constraint 3) and skipping is not a licence to break it.

**Rule 3 — definition-time validation makes it unreachable.** `validateWorkflow`
gains a check: **if any step declares `when`, every step whose `input` /
`output` / `condition` references `$steps.<that step>` must declare
`dependsOn` on it.** That converts a run-time throw into a definition-time
error, which is where this subsystem puts every other structural mistake
(circular deps, `loop` on a gate, unknown `dependsOn`).

Rule 3 is the one that matters; rules 1–2 are the safety net for a definition
that predates the check or reaches it via a ref the validator cannot see
(a `{{…}}` template inside a transform, which C7 must also scan).

### 1.4 `$prev` across a skipped batch

`prevResult = results[results.length - 1]` (`workflow-executor.ts:496`) — the
last element of the batch's results array.

**If every step in a batch is skipped**, the naive reading makes `prevResult`
the skip sentinel, and the next batch's `$prev` resolves to a sentinel — garbage
that no existing workflow expects.

**Rule: a skipped step never becomes `$prev`.** `prevResult` advances to the
last **executed** step of the batch; if the batch executed nothing, `prevResult`
is **left unchanged**, so `$prev` continues to name the last real result. This
preserves the documented order-fragility exactly (`workflows.md:326`) while
making a fully-skipped batch transparent rather than destructive.

**Cursor consequence:** `cursor.prevStepName` must therefore record the step
whose result *is* `$prev` — which after a fully-skipped batch is a step from an
**earlier** batch. Phase 2 pinned "cursor.prevStepName names the step whose
result IS $prev" as a named test; C7 must extend that test rather than weaken it.

---

## 2. `when` — the mechanics

```ts
WorkflowStep.when?: WorkflowCondition;      // reuses evaluateCondition unchanged
WorkflowStep.skipDependents?: boolean;      // default true
```

- Evaluated **before dispatch**, in `runStep`, with the same `RefContext` the
  step's input would use.
- False ⇒ step status **`skipped`**, `skipped_reason` populated (the C5 column),
  dependents skipped transitively when `skipDependents` is true.
- **The run still succeeds.** This is the whole distinction from `gate`, which
  throws (`runGate`).
- `when` on a step that also has `loop`: evaluated **once**, before the loop.
  A per-iteration guard is `until`, not `when`.
- **`skipped` is a step status only.** `WorkflowRunStatus` already carries it for
  step rows; a *run* never terminalizes `skipped`.

**Transitive skip** is computed over `dependsOn` at dispatch time, not
pre-computed: a step is skipped if its own `when` is false **or** any step it
depends on was skipped with `skipDependents !== false`.

---

## 3. `kind: "workflow"` — nested runs

```yaml
- name: revise-until-valid
  kind: workflow
  workflow: ez-factory:draft-and-verify
  input: { draft: $steps.draft.output }
  loop: { maxIterations: 3, until: {…}, onExhausted: fail }
```

| Concern | Design |
|---|---|
| **Depth cap** | 3. Enforced at **run time** (a counter threaded through the child's execution context) *and* at definition time where statically knowable. |
| **Cycle check** | **Definition time**, in `validateWorkflow`: walk `kind: "workflow"` edges from this definition; a cycle is a validation error naming the loop. Cross-extension edges resolve through the same merged cache the executor uses. |
| **Linkage** | `workflow_runs.parent_run_id` → `workflow_runs(id)` **ON DELETE SET NULL** — a child's history is independently valuable. Declared as **plain text with no drizzle self-reference**, FK added in `migrate.ts`, mirroring `sdk_capability_calls.parent_call_id`. **Does not exist yet** (`schema.ts` has no `parentRunId`) — C7 adds it. |
| **Result** | The child's terminal `WorkflowRun.result`. A child that fails throws in the parent, exactly like a failed agent step. |
| **Version pinning (C6)** | The child run records its own `definition_version_id`, the same way the parent does. A parent pinned to v3 does **not** pin its children — each nested run resolves the child's *current* version at dispatch and records it. Pinning transitively would freeze a shared sub-workflow for every caller. |

### 3.1 The transitive capability closure — built here, not by C3

C3's consent hash covers the **transitive closure of nested workflows** (C3 spec
§3.1 input 5). That closure computation is a **C7 concern**, because C7 is what
introduces nesting, and C3 must not have to invent a graph walk over a step kind
it did not design.

C7 therefore ships `collectWorkflowClosure(definition, depth)` in
`workflow-model.ts`'s neighbourhood — a pure function returning the ordered set
of definitions reachable through `kind: "workflow"` edges, sharing the **same
walk** as the cycle check so the two cannot disagree. C3 consumes it; C7 uses it
for validation. One walk, two callers.

---

## 4. Interaction with phase 2's durable cursor — **what I could and could not verify**

The lead asked for this to be verified rather than assumed. Splitting it
honestly:

### 4.1 Verified against landed code

- **The cursor shape is `{ batchIndex, completedSteps, prevStepName }`**
  (`src/types.ts:307-310`) and is written atomically with `run_phase: 'boundary'`
  in one UPDATE (`advanceWorkflowRunCursor`).
- **`run_phase` is written `in-batch` before `batch.map` and `boundary` after
  `Promise.all`.** A nested run dispatches **inside** a parent's batch, so **for
  the whole life of a child run the parent is `in-batch`** — which is correct and
  needs no change: the parent is genuinely mid-step.
- **Each run row is independent**, so a child gets its own `cursor`,
  `run_phase`, and `definition_hash` for free. No shared-cursor problem exists.

### 4.2 Depends on unbuilt async work — **NOT verified**

- **A suspended grandchild.** Resume is step 5+; nothing reaches `suspended`
  today. The *intended* behaviour is that a suspended child leaves the parent
  `in-batch` and therefore **not resumable** by phase 2's own rule (mid-step is
  never resumed) — meaning **a parent whose child suspends fails closed on
  parent restart even though the child could resume.** That is safe but poor,
  and resolving it properly requires the parent to learn "suspended child" as a
  distinct state.
- **Whether that is acceptable for C7, or needs a `suspended-child` parent
  state**, is a decision I cannot make against unbuilt code. **Flagged as an open
  question for whoever builds phase 4 after step 5 lands** — C7 should not
  guess, and I am not going to spec a state machine against an executor that is
  still being written.

**Recommended sequencing:** land C7's `when` (§2) — which has no cursor
interaction at all — before the `workflow` kind (§3), so the half that is fully
verifiable ships without waiting on phase 2.

---

## 5. `loop` on a `workflow` step

**Legal on `workflow`; the `tool` ban stays.** The reasoning is unchanged from
the design record: looping a graph that contains an LLM or a gate is bounded
re-execution; looping a raw side-effecting tool call is not.

**`$loop.last` composes with the child's result** exactly as it does for an agent
step: it is the previous iteration's `WorkflowRun.result` (an `AgentResult`), so
`$loop.last.output.valid` addresses the child's final step output through the
unchanged grammar. Iteration 1 omits the key (the documented lenient exception,
`workflow-refs.ts:85-87`).

**Each iteration is a separate child run** with its own `workflow_runs` row and
its own `parent_run_id` — not one run re-entered. That is what makes the trace
readable ("3 attempts, here is each") and what lets a per-iteration model
override escalate (C1's loop site re-resolves per iteration).

`loop` + `retries` stay mutually exclusive, unchanged.

---

## 6. Dry-run composition — the guarantee does hold

C6's dry-run is structural: the harness constructs the executor with a
`toolRunnerFactory` that **throws** and an `AgentExecutor` whose `runAgent`
**throws** (C6 spec §4.2).

**A nested `workflow` step inherits it for free — verified by construction, not
assumption:** the child is executed by the **same `WorkflowExecutor` instance**,
which holds the same injected factories. There is no path by which a child
constructs its own tool runner, because `getToolRunner` closes over the
executor's `toolRunnerFactory`. A tool step three levels down therefore hits a
throwing factory exactly like one at the top.

**The one requirement C7 must not break:** the nested dispatch must **not**
create a fresh `WorkflowExecutor`. If a future refactor does, the dry-run
guarantee silently evaporates. §8 row 5 asserts this by grep.

---

## 7. Migration

| Table | Column | Type | Null | FK |
|---|---|---|---|---|
| `workflow_runs` | `parent_run_id` | `TEXT` | yes | → `workflow_runs(id)` **ON DELETE SET NULL** |

Index: `idx_workflow_runs_parent ON workflow_runs(parent_run_id)` — required,
because `SET NULL` on delete scans it.

`skipped_reason` on `workflow_step_runs` is **C5's column** (added phase 3);
C7 is its first writer. No new column here.

Additive, `IF NOT EXISTS`, no backfill — `parent_run_id` is genuinely NULL for
every historical run.

---

## 8. Test plan and acceptance criteria

New file → threshold key (100): `src/runtime/workflow-closure.ts` (§3.1).
`workflow-validator.ts` and `workflow-executor.ts` already have keys.

| # | Criterion | Proven by |
|---|---|---|
| 1 | A false `when` skips the step, skips its declared dependents, and **the run still succeeds**. | Named test asserting run `status: "success"` and step `status: "skipped"`. |
| 2 | **`$steps.<skipped>` from an undeclared reader is a DEFINITION-time error** (§1.3 rule 3), not a run-time surprise. | `validateWorkflow` test; plus a run-time test that the fallback message **names the skipped step and the fix**. |
| 3 | A fully-skipped batch leaves `$prev` **unchanged**, and `cursor.prevStepName` names a step from an earlier batch. | Extends phase 2's existing named cursor test rather than replacing it. |
| 4 | Cycle detection is **definition-time** and names the loop; depth cap 3 enforced at run time. | Two named tests. |
| 5 | A nested run uses the **same executor instance** — no `new WorkflowExecutor` in the nested path. | **Grep**, plus a dry-run test where a tool step **three levels deep** still hits the throwing factory. |
| 6 | Each loop iteration of a `workflow` step is a **separate child run** with its own `parent_run_id`. | A 3-iteration loop produces 3 child rows. |
| 7 | `loop` on `tool` remains rejected; on `gate` remains rejected. | Existing validator tests must pass **unmodified**. |
| 8 | The closure walk and the cycle check share one implementation. | Grep: one exported walk, two callers. |

### 8.1 Beyond the checklist

- **Interaction:** `when` (§2) and `skipDependents` both suppress a step. Verify a
  step skipped *transitively* also writes `skipped_reason` — otherwise the trace
  shows a skipped step with no explanation, and rows 1 and 3 both pass.
- **Migration extensibility:** can C3 add `delegation_id` and C6 add
  `definition_version_id` to a **child** run row without special-casing nesting?
  The independent-row design says yes; verify no code assumes `parent_run_id IS NULL`.
- **Meaningless coverage:** the skip tests must assert the **run's** terminal
  status, not just the step's — the run-still-succeeds property is the point.
- **Untested by default:** a child that fails while a sibling batch step is still
  running; a `when` referencing `$steps` of a step in the *same* batch (a
  same-batch ref is unresolvable by construction — the validator should reject
  it); depth-cap enforcement when the chain is formed at run time through
  different definitions.

**And the standing one:** anything here the build proves wrong — including §4.2,
which is explicitly unverified.
