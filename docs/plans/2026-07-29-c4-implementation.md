# C4 implementation spec — durable runs, suspend/resume, the `approval` step

**Status:** Binding for phase 2
**Date:** 2026-07-29
**Implements:** C4 of [2026-07-29-ez-factory-design.md](2026-07-29-ez-factory-design.md)
**Scope:** `src/runtime/`, `src/db/`, `web/src/routes/api/workflows/**`, `web/src/routes/(app)/workflows/**`

> **Citation anchor.** Every `file.ts:line` was read and verified at commit
> **`0b2cb260`** (its `src/**` tree is identical to `40d57aae`). Phase 1 is in
> flight and uncommitted in this worktree; it shifts `workflow-executor.ts`,
> `workflow-runs.ts`, `schema.ts` and `types.ts` downward. Anchor on the
> **symbol name**, not the number. §8 lists the phase-1 deltas C4 inherits.

**Read §1 first.** The design record's stated suspend-before-await rule is
**wrong**, and §1 replaces it. §9 lists everything else C4's detail proves wrong
in the design record — that section is the reason this document exists.

---

## 1. The suspend-before-await rule — it does not hold

### 1.1 What the design record claimed

[Design record §7.3](2026-07-29-ez-factory-design.md) says the fix for
crash-recovery is to "transition to `suspended` **before** every await point,
not by teaching the sweep about `resumable` — keep the sweep dumb."

I wrote that. Against the real executor it is wrong, and shipping it would
create the exact data-loss class it was meant to prevent.

### 1.2 The await inventory

Every `await` in `src/runtime/workflow-executor.ts`:

| # | Line | Await | At a step boundary? |
|---|---|---|---|
| A1 | `:186-188` | `persistWrite("insert", …)` → `getWorkflowByName` + `insertWorkflowRun` | **Yes** — before any step dispatches |
| A2 | `:372` | `Promise.all(promises)` — the whole batch | **No.** N steps concurrently in flight |
| A3 | `:333` | `this.runStep(…)` inside each step promise | **No.** This *is* the step |
| A4 | `:559` | `this.agentExecutor.runAgent(…)` | **No.** An LLM call is in flight |
| A5 | `:753` | `toolCtx.scope.run(…)` — the tool dispatch | **No.** Side effects may already be applied |
| A6 | `:613` | `runAgentAttempt(…)` inside `runLoop` | **No.** Mid-iteration |
| A7 | `:440` | `persistWrite("finalize", …)` | Terminal — the run is over |
| — | `:535` | `runAgentAttempt(…)` inside `runAgentStep` | Same as A4, one frame up |

Of eight await sites, exactly **one** (A1) precedes a step and one (A7) follows
the last. **The five that matter are all inside a step.**

### 1.3 Why the rule is not just imprecise but unsafe

`suspended` means *"no process owns this run; it is parked at a boundary and is
safe to resume."* Writing it before A2–A6 asserts that while an LLM call or a
side-effecting `tool` dispatch is mid-flight. A crash at that moment leaves a
row that says **resume me**, and the resume re-enters a half-executed step:
a `write_file` applied twice, a `run_command` re-run, an LLM call re-billed.

This is precisely the failure ez-code-factory's recovery refuses to allow:

> a **mid-flight** run (running/created/worktree_ready) fails closed (a restart
> cannot safely re-enter a half-executed step)
> — `docs/extensions/examples/ez-code-factory/lib/recovery.ts:5-7`, enforced at
> `:51` `recoverRuns` → `:141` `failClosed`

Design-record §4 invariant #16 ports that rule into core. The
suspend-before-await formulation contradicts the invariant the same document
says C4 must uphold.

### 1.4 The corrected rule — commit-at-boundary, claim-with-lease, decide-at-recovery

The load-bearing intent survives: **the boot sweep must never have to guess.**
You achieve that by making the executor record, durably and synchronously, which
side of a step boundary it is on — not by lying about the status.

1. **`run_phase`** (`'boundary' | 'in-batch'`) is written **synchronously and
   strictly**:
   - `'in-batch'` immediately before A2 (`:372`), flushed before the batch
     dispatches;
   - `'boundary'` immediately after the batch resolves and the cursor advances
     (after `:378`).
2. **`suspended` is written ONLY by a deliberate park** — an `approval` step, a
   stale-consent hold (C3), or a quota hold. By construction those happen at a
   boundary: an `approval` step parks *before* dispatching anything.
3. **The daemon holds a lease** (`claimed_by`, `lease_expires_at`), renewed on a
   heartbeat. A dead process stops renewing.
4. **Recovery selects on one predicate and branches its action**:

```sql
-- selection: still ONE predicate (the "dumb sweep" intent preserved)
WHERE status = 'running' AND lease_expires_at < now()
```

| `run_phase` | Action | Result |
|---|---|---|
| `'boundary'` | → `suspended`, `suspended_reason='orphaned-resumable'`, `resumable=true` | the daemon picks it up and continues from `cursor` |
| `'in-batch'` | → `error`, `resumable=false`, message names the batch index and the steps that were in flight | operator gets *retry from step N* |

The sweep's **selection** stays a single predicate; only its **action** branches
on a column the executor maintained honestly. That is the honest version of
"keep the sweep dumb".

### 1.5 The sub-finding that makes or breaks it: `persistWrite` swallows errors

`persistWrite` (`src/runtime/workflow-executor.ts:151-158`) is documented as:

> Never throws and never blocks the run: a DB glitch must not fail a workflow
> that otherwise succeeded (same contract as `persistToolCall`).

Correct for **telemetry**. Fatal for a **cursor**. A silently-dropped cursor
write means the next resume starts from a stale `batchIndex` and **re-executes a
completed batch** — duplicate side effects, which is worse than failing.

**C4 must add a second, strict path** — `persistCritical(what, fn)` — that
propagates the error and fails the run closed with
`error_code='cursor-write-failed'`. Exactly three writes use it: the
`'in-batch'` marker, the boundary cursor advance, and the suspend transition.
Everything else keeps `persistWrite`. Keeping the two paths visibly distinct (and
the strict one down to three call sites) is what stops the swallow-by-default
contract leaking onto the durability path.

### 1.6 Verdict

**Suspend-before-await holds at A1 only, and A1 is not a point anyone needs to
suspend at.** It fails at A2–A6, and at A5 (`tool` dispatch) failing it is a
correctness bug, not a nicety. Phase 2 must implement §1.4 instead. The design
record's §7.3 and §2.3 are corrected accordingly in §9.

---

## 2. The durable state machine

### 2.1 Status transitions

```
   (create) ──────────────▶ running ◀──────────── resume (daemon claim)
                              │                        ▲
        ┌──────────┬──────────┼──────────┬─────────────┘
        ▼          ▼          ▼          ▼
    success     error     cancelled   suspended ──── answer / lease reclaim
   (terminal) (terminal) (terminal)   (NON-terminal)

   awaiting_approval — pre-existing, terminal, UNCHANGED meaning
```

**`awaiting_approval` is not reused.** It keeps exactly today's meaning: a
sensitive-capability tool step failed closed and the run is parked *and dead*
(`workflow-executor.ts:401-421`, type at `src/types.ts:215`). Reusing it for the
new `approval` step would retroactively make every historical
`awaiting_approval` row look resumable. The new step kind produces `suspended`.

`suspended` is the only non-terminal, non-`running` state.

### 2.2 Columns on `workflow_runs`

| Column | Type | Null | Default | Written by |
|---|---|---|---|---|
| `cursor` | `JSONB` | yes | — | executor, strictly, at each boundary |
| `run_phase` | `TEXT` | no | `'boundary'` | executor, strictly, around A2 |
| `suspended_reason` | `TEXT` | yes | — | executor on park; sweep on reclaim |
| `resumable` | `BOOLEAN` | no | `false` | **sweep**, not the executor (see §9.4) |
| `claimed_by` | `TEXT` | yes | — | daemon claim CAS |
| `lease_expires_at` | `TIMESTAMPTZ` | yes | — | daemon claim + heartbeat |
| `job_ref` | `TEXT` | yes | — | caller (ez-factory); no FK — jobs live in extension `Storage` |
| `idempotency_key` | `TEXT` | yes | — | caller |

Indexes:
- `idx_workflow_runs_claimable ON workflow_runs(status, lease_expires_at) WHERE status IN ('running','suspended')` — the daemon's claim scan and the sweep share it.
- `uniq_workflow_runs_idem ON workflow_runs(workflow_name, idempotency_key) WHERE idempotency_key IS NOT NULL` — partial, so NULL keys never collide.

`DEFAULT 'boundary'` on `run_phase` is what makes the migration backward-safe:
every pre-existing row reads as "at a boundary", and since they are all already
terminal or will be drained by the existing sweep, nothing is misclassified.

### 2.3 What `cursor` means across parallel batches

```ts
type WorkflowCursor = {
  batchIndex: number;        // next batch to execute
  completedSteps: string[];  // every step name completed so far, in order
  prevStepName: string | null; // the step whose result is $prev for batchIndex
};
```

`resolveExecutionOrder` (`workflow-executor.ts:651-688`) is **pure and
deterministic**: the no-deps path emits one step per batch in declaration order
(`:654-657`), and the topo path iterates `steps` in declaration order within each
batch (`:666-672`). So recomputing it on resume from the same definition yields
byte-identical batches, and `batchIndex` is a stable coordinate.

**Reproducing `$prev`.** Today `prevResult = results[results.length - 1]`
(`:378`) — the last element of the batch's results array, which by the ordering
above is `batch[batch.length - 1]`. On resume:

```ts
prevResult = cursor.prevStepName ? stepResults.get(cursor.prevStepName) : undefined;
```

This reproduces the documented order-fragility **exactly**
(`docs/features/orchestration/workflows.md:249` — "`$prev` is order-fragile in
parallel batches"). We deliberately do **not** "fix" it: making `$prev`
graph-deterministic on resume would give a resumed run a different `$prev` than
the same workflow run straight through, which is a far worse bug than the
documented fragility.

### 2.4 Rebuilding `stepResults` — and the blocking dependency

`stepResults` is an in-memory `Map<string, AgentResult>` (`:199`) that **any**
later step can address via `$steps.<name>` — not just the immediately preceding
batch. A resumed run must rehydrate the whole map.

**`workflow_step_runs` does not store step output today.** The upsert payload is
`{ workflowRunId, stepName, runId, status, iterations }`
(`src/db/queries/workflow-runs.ts:66-74`, written at `:84-99`). There is nowhere
to read a completed step's result from.

**Therefore C4 cannot resume anything until `workflow_step_runs.output` exists.**
The design record assigns `output` to C5 (phase 3), which lands *after* C4. That
ordering is wrong for this one column — see §9.2. Phase 2 must land:

| Column | Type | Null | Notes |
|---|---|---|---|
| `output` | `JSONB` | yes | the step's `AgentResult`, size-capped, secret-redacted |

Size cap: 256 KB per step after redaction; on overflow store
`{ __truncated: true, bytes: <n> }` and fail the run closed on resume rather than
resuming with a silently-different `$steps` value. Redaction reuses the ported
secret scrubber (design record §4, invariant #12).

`resolved_input` is **not** required for resume (it is recomputed from `cursor` +
`stepResults`) and stays a C5 column.

### 2.5 A looped step's partial progress

`runLoop` (`:583-649`) stamps `stepRun.iterations = i` after each iteration and
calls `emitStep()` (`:627-628`), which persists. A crash mid-loop is `in-batch`,
so by §1.4 it is **not resumable** — it fails closed with the recorded
`iterations` telling the operator how far it got. *Retry from step N* restarts
the loop at iteration 1.

This is deliberate and matches the mid-step rule: a loop iteration may have run a
side-effecting agent, and re-entering at iteration *k* would replay `$loop.last`
against a result the new process never produced.

### 2.6 Where suspension exits `runWorkflow`

Two structural obstacles in the current control flow, both in the `finally`
(`:429-447`):

1. **`finalizeWorkflowRunRow` is called unconditionally** (`:440-446`) and its
   parameter type `TerminalWorkflowRunStatus`
   (`src/db/queries/workflow-runs.ts:28-32`) correctly excludes `suspended`. A
   suspended run must not pass through it.
2. **`approvalScope.end()`** (`:434`) and
   **`toolCallsThisTurn.delete(scopeKey)`** (`:439`) must still run — the process
   is releasing the run and nothing may outlive it.

Implementation: a `WorkflowSuspendedError` sentinel thrown from the step
dispatcher, caught in the existing `catch` alongside `WorkflowApprovalRequiredError`
(`:401`), setting `workflowRun.status = "suspended"` and a `suspended` flag the
`finally` checks before calling the finalizer. The scope teardown stays
unconditional.

On resume the scope is re-established with the **same** key, because
`workflowScopeKey(runId)` is deterministic (`:127-129`) — a pure function of the
run id. That is what makes a resumed run's tool steps land in the same
non-interactive scope, with the same fail-closed PDP behaviour.

**Accepted semantic change:** `toolCallsThisTurn` is keyed by the scope key and
deleted on suspend (`:439`), so a resumed run starts with a fresh per-turn
tool-call budget. Document it; do not try to persist the counter — it is a
runaway-loop guard, not an accounting ledger, and persisting it would make a
long-parked run un-resumable for a reason no operator could diagnose.

---

## 3. `WorkflowRunner` daemon

Modelled on `ScheduleDaemon` (`src/extensions/schedule-daemon.ts`), whose locked
invariants are stated at `:4-37`.

### 3.1 Claim — CAS, never `FOR UPDATE SKIP LOCKED`

The schedule daemon is explicit about why (`:12-15`, implemented `:290-305`):

> This CAS is the guard for the multi-instance / external-Postgres topology and
> works on BOTH drivers (no `FOR UPDATE SKIP LOCKED`, which PGlite doesn't honor
> identically).

The workflow claim:

```sql
UPDATE workflow_runs
   SET status = 'running', claimed_by = $me, lease_expires_at = $now + $lease,
       run_phase = run_phase          -- unchanged; the cursor decides where to resume
 WHERE id = $1
   AND status = 'suspended'
   AND (claimed_by IS NULL OR lease_expires_at < $now)
RETURNING id;
```

Zero rows ⇒ lost the race, skip (mirrors `:305`). Winning the CAS **is** the
transition `suspended → running`, so the claim and the state change are one
atomic act — there is no window in which two workers both believe they own it.

### 3.2 Lockfile, caps, tick, shutdown

| Concern | Design | Precedent |
|---|---|---|
| Single writer | `acquireLockfile(".ezcorp/workflow-runner.pid")`; refuse to start on a live sibling | `process-lockfile.ts:179`; `schedule-daemon.ts:150-159` |
| PID reuse | Handled by the shared primitive's identity token | `process-lockfile.ts:133` `isLiveSibling` |
| Concurrency | per-project cap 5, host-wide 20; counters seeded on start from rows this instance holds | `schedule-daemon.ts:22-24`, seeding `:180-198` |
| Tick | `setInterval(wakeIntervalMs, default 5s)` + `.unref()` | `schedule-daemon.ts:200-205` |
| Test seam | `tick()` public and directly drivable; `now` injection; `skipLockfile` / `lockfilePath` overrides | `schedule-daemon.ts:218-220`, `:61-63`, `:64-67` |
| Shutdown | `stop()` clears the timer, **releases claims** (`claimed_by=NULL, status='suspended'` for anything at a boundary), releases the lockfile | `schedule-daemon.ts:209-215`; wiring at `background-timers.ts:609-612` |
| Wiring | started in `startBackgroundTimers` behind `EZCORP_DISABLE_WORKFLOW_RUNNER=1` | `background-timers.ts:122`, `:216-241` |

Releasing claims on graceful shutdown (rather than waiting out the lease) is the
one place this daemon should be *better* than its model: a rolling restart
otherwise stalls every parked run for a full lease period.

### 3.3 Coexisting with the synchronous path without double-executing

Both paths live in the same process. Four rules keep them disjoint:

1. **The daemon only claims `status='suspended'`.** A synchronous run is at
   `running` from insert (`workflow-runs.ts:53-63`) to terminal, so it is never
   claimable. This is the primary guard and it is structural.
2. **A synchronous run that hits an `approval` step suspends and returns.** The
   HTTP request does **not** block on a human: the route returns 200 with the run
   object at `status: "suspended"`. The daemon resumes it when the answer
   arrives.
3. **Resume is a distinct entry point.** `resumeWorkflow(runId)` rehydrates and
   continues; it must **not** re-emit `workflow:start`. That event prepends a new
   run to `store.workflowRuns`
   (`docs/features/orchestration/workflows.md:130`), so re-emitting it would show
   one parked job as two runs. Resume emits only `workflow:step` and the terminal
   `workflow:complete` / `workflow:error`.
4. **Lease re-check at each boundary.** Before advancing the cursor the executor
   asserts `claimed_by = $me`; a mismatch (another instance reclaimed an expired
   lease) aborts this worker's copy without writing. One indexed read per batch.

### 3.4 The heartbeat

The lease is 60s, renewed every 20s by the daemon while any claimed run is live.
A run whose steps legitimately exceed the lease keeps it — the heartbeat is per
*daemon*, not per step, so a 30-minute agent step does not lose its claim. The
lease exists to detect a **dead process**, not a slow step.

---

## 4. The `approval` step kind

### 4.1 `workflow_approvals`

Columns, FK behaviour, and indexes are specified in
[design record §2.3](2026-07-29-ez-factory-design.md); C4 implements it as
written, with these refinements:

- `item_ids JSONB` is resolved **at suspend time** from the step's declared ref,
  so the answer is checked against what the run actually produced, not against
  what the definition hoped for.
- `consent_all_used BOOLEAN NOT NULL DEFAULT false` — the audit marker for an
  ids-free bulk clear. Mirrors `ApprovalGuard.consentAllUsed`
  (`docs/extensions/examples/ez-code-factory/lib/chat-contract.ts:113-116`): a
  blanket clear is allowed but **never silent**.

### 4.2 Answer → step result

```ts
{ success: true,
  output: { choice, form, itemIds, answeredBy, answeredAt } }
```

so `$steps.publish-gate.output.choice` resolves through the unchanged ref
grammar. `choice` is validated against the step's declared `choices` at answer
time and the list itself is validated at definition time — an answer outside the
declared set is rejected, never coerced.

### 4.3 `requireItemConsent` — ported invariants #5, #6, #7

One guard, three surfaces. This is design-record invariant **#7** (the shared
chokepoint), and it is the reason the rule is worth porting into core at all:

```
POST /api/workflows/approvals/[id]  ─┐
Hub approval card                   ─┼─▶ answerApproval()  ─▶ guard ─▶ resume
chat approval card                  ─┘
```

`answerApproval()` runs the two guards **in order**, ported from
`enforceRespondContract` (`chat-contract.ts:207`):

1. **`enforceNamedApproval`** (`:135`) — an ids-free approve over a step with
   non-empty `item_ids` is refused. A **clean** step (empty `item_ids`) approves
   ids-free (`:146`); `consentAll` bypasses and is flagged.
2. **`crossCheckFindingIds`** (`:171`) — every named id must exist in
   `item_ids`. Invented ids cannot be smuggled through the length>0 check.

The test that matters asserts the chokepoint by **call-count on a spy**, not by
inspection — a fourth surface added later must fail the test, not slip past a
reviewer.

### 4.4 Timeout

`expires_at` is set at suspend from `timeoutMs`. The daemon sweeps expired
approvals on each tick using the **injected clock**, and applies `onTimeout`
(`abort` default) by resuming the run with a synthetic answer whose `choice` is
the `onTimeout` value. `abort` terminalizes the run `cancelled` with
`suspended_reason='approval-timeout'` retained for the trace.

### 4.5 RBAC

`rbacScope` is optional; absent ⇒ project members may answer. The check is
**fail-closed: a throw is a DENY** — ported invariant #17
(`docs/extensions/examples/ez-code-factory/lib/rbac.ts:64` `guardScope`). An
unresolvable identity can never satisfy a grant, the refusal is a 403-shaped
message rather than a 500, and **the run is never mutated on a denied answer**.

---

## 5. Compatibility ledger

Every existing caller, and why the absent header leaves it byte-identical.

| Caller | Site | Why unaffected |
|---|---|---|
| **Run route (sync)** | `web/src/routes/api/workflows/[name]/run/+server.ts:32` | Header absent ⇒ same inline `await runWorkflow(...)`, same returned `WorkflowRun`, same 200. The body schema (`:14-16`) is untouched, so the `.loose()` input contract and the documented `projectId` split (`:31`) are unchanged. |
| **CLI `workflow run`** | `src/cli.ts:447-461` | Never sets the header; `runWorkflow`'s positional signature is unchanged (new state is on the row, not the parameter list). Exit code stays `run.status === "success" ? 0 : 1` (`:461`). **New reachable path — see §5.1.** |
| **Extension trigger** | `src/extensions/workflows-handler.ts:427` | Fire-and-forget by design (`:420-453`); it already ignores the terminal status except for one log line (`:438-445`). A `suspended` outcome logs identically. The `-32106` ownerless refusal (`:291-311`) is untouched. |
| **Boot orphan sweep** | `src/db/queries/workflow-runs.ts:162`, predicate `:176` | Predicate is `status='running' AND started_at < cutoff`; `suspended` is excluded **structurally**, no change needed for that. It gains the lease predicate per §1.4 and keeps its single-select shape. |
| **`finalizeWorkflowRunRow`** | `:114`, CAS `:126` | CAS on `status='running'`. Widened to `status IN ('running','suspended')` for the cancel-while-parked path; the zero-row-no-op contract and the "never clobber a richer terminal state" guarantee are preserved. |
| **Client store** | `web/src/lib/stores.svelte.ts` | `workflow:start` prepends, `:step`/`:complete`/`:error` replace by id. Resume must not re-emit `workflow:start` (§3.3 rule 3) or a parked job renders twice. |
| **`/workflows/[name]`** | route page | Renders `store.workflowRuns`; `suspended` needs a badge, nothing breaks without one. |
| **`WorkflowRunStatus` consumers** | `src/types.ts:215` | Anything branching `=== "error"` will not match `suspended` — the same documented trap `awaiting_approval` already carries (`workflows.md:243`). Audit `web/src/lib/workflow-run-display.ts` and the CLI. |
| **Demo workflows** | `src/agents/demo-*.workflow.yaml` | No `approval` step ⇒ never suspend. `workflows-demos.spec.ts` must pass unmodified — that is the phase's regression canary. |
| **Authoring chain** | `src/agents/extension-author.workflow.yaml` | Still terminalizes `awaiting_approval` via `WorkflowApprovalRequiredError` (`workflow-executor.ts:401-421`). C4 does not touch that path. |

### 5.1 The CLI's new exit path — the sharpest one

The CLI exits `1` for anything that is not `success` (`src/cli.ts:455-461`,
deliberately including `awaiting_approval`). A `suspended` run is not `success`,
so it exits **1** — correct under the existing loud-failure rule, and only
reachable if an operator puts an `approval` step in a workflow they run from the
CLI.

But exiting 1 with only `run.result` printed is unhelpful: the run is *alive* and
answerable. **C4 must print the approval id and the resume URL** on the
`suspended` branch, mirroring how the `awaiting_approval` comment (`:450-453`)
justifies itself by noting the printed result already names the blocking step.
Exit code stays 1; only the printed payload gains a line.

---

## 6. Test plan

Feature contract: 100% on each new file with a key in
`scripts/coverage-thresholds.json`, 100% patch coverage, e2e for user-facing
behaviour, `@evidence` for frontend-visual change. No `EXCLUDES`, no `.skip`.

### 6.1 New files → threshold keys (all 100)

- `src/runtime/workflow-runner-daemon.ts`
- `src/runtime/workflow-resume.ts` (rehydrate + `resumeWorkflow`)
- `src/db/queries/workflow-approvals.ts`
- `src/runtime/workflow-approval-guard.ts` (the ported chokepoint — pure, no I/O)

### 6.2 Determinism: how to test a daemon without a clock

Copy the schedule daemon's seams exactly — they exist because this was solved
once already:

- **`now` injection** (`schedule-daemon.ts:61-63`). No `Date.now()` in the
  daemon body. Lease expiry, heartbeat, and approval timeout are all driven from
  it.
- **`tick()` public and directly awaited** (`:218-220`). Tests never wait on
  `setInterval`; they call `tick()` and assert. No sleeps, no flake.
- **`skipLockfile` + `lockfilePath` overrides** (`:71-73`, `:75-77`) so parallel
  test files never collide on `.ezcorp/*.pid`.
- **Registry-less mode** (`:64-67`) — claim and audit without dispatching — is
  exactly how the claim-before-dispatch unit test is made possible. Mirror it.

### 6.3 Crash recovery without crashing

Do **not** kill a process. Write the row state directly and call the sweep — the
established pattern in `src/__tests__/workflow-run-persistence.test.ts:294`
("drains rows a dead process left running").

| Case | Setup | Assert |
|---|---|---|
| Boundary orphan | `status='running'`, `run_phase='boundary'`, expired lease, cursor at batch 2 | → `suspended`, `resumable=true`; daemon then completes from batch 2 |
| Mid-batch orphan | same but `run_phase='in-batch'` | → `error`, `resumable=false`, message names the batch |
| Parked run untouched | `status='suspended'`, no lease | sweep is a **zero-row no-op** |
| Live run untouched | `status='running'`, fresh lease | zero-row no-op |
| Cursor write failure | `persistCritical` throws | run fails closed `cursor-write-failed`; **no** silent continue |

### 6.4 Concurrency and races

- Two daemon instances, same tick, one due run ⇒ **exactly one** claims (assert
  by `RETURNING` row counts, mirroring `schedule-daemon.ts:290-305`).
- Claim CAS against a run someone else already resumed ⇒ zero rows, no throw.
- Lease reclaim mid-run ⇒ the losing worker aborts at the next boundary check
  without writing a cursor.

### 6.5 Round trips

- Suspend/resume: workflow with `approval` → assert `suspended` + one
  `workflow_approvals` row → answer → assert resume completes and
  `$steps.<gate>.output.choice` resolves.
- `$prev` fidelity: a parallel-batch workflow run straight through vs suspended
  and resumed at the same boundary ⇒ **identical final result**. This is the test
  that pins §2.3.
- `stepResults` fidelity: a resumed run reading `$steps.<first-batch-step>` gets
  the same value as the uninterrupted run.
- Guard: ids-free approve with items ⇒ refused; clean approve ⇒ passes; invented
  id ⇒ refused; `consentAll` ⇒ passes **and** sets `consent_all_used`.
- Chokepoint: all three answer surfaces route through one guard (spy call-count).
- RBAC: a scope-check **throw** denies and leaves the run untouched.

### 6.6 Byte-identical sync path (the regression canary)

`web/e2e/workflows.spec.ts`, `workflows-demos.spec.ts`, `workflows-actions.spec.ts`
and the CLI exit-code assertions must pass **unmodified**. If any needs editing,
the async opt-in has leaked into the default path — treat it as a phase-2 defect,
not a test to update.

### 6.7 E2E

| Spec | Covers | `@evidence` |
|---|---|---|
| `web/e2e/workflows-approvals.spec.ts` | inbox renders, answer resumes the run | **yes** — new surface |
| `web/e2e/workflows-async-run.spec.ts` | header returns `{runId, status}` immediately; run completes in background | no |
| `web/e2e/workflows-suspended-badge.spec.ts` | `suspended` renders distinctly from `error` | **yes** |

---

## 7. Build order

Each step leaves the tree green, lint/typecheck clean, and the synchronous path
byte-identical. The risky executor surgery (3–5) lands before any user-visible
surface depends on it.

| # | Land | Why here |
|---|---|---|
| 1 | Migration + `schema.ts` columns + `workflow_approvals` table. **No behaviour.** | Schema/migrate lockstep is its own reviewable unit; `DEFAULT 'boundary'` proves backward-safe in isolation. |
| 2 | `workflow_step_runs.output` write + `loadStepResults(runId)` rehydration helper. | Purely additive; the sync path gains persistence it already should have had, and §2.4's blocking dependency is cleared before anything needs it. |
| 3 | `persistCritical` + `run_phase` / `cursor` writes. Still no suspension. | Honest bookkeeping with zero new states. Fully testable alone. |
| 4 | Sweep action branches on `run_phase`. | **Crash recovery becomes correct before async exists** — this is the step that pays for itself even if the phase stopped here. |
| 5 | `WorkflowSuspendedError` + suspend path + `resumeWorkflow(runId)`, driven directly in tests. | Executor surgery, no daemon yet, no HTTP surface. |
| 6 | `approval` step kind + `workflow_approvals` queries + the single `answerApproval()` chokepoint. | First user-meaningful capability; guards ported here. |
| 7 | `WorkflowRunner` daemon + lockfile + lease + `background-timers` wiring. | Now there is something worth scheduling. |
| 8 | `X-EZ-Workflow-Async` header + `/resume` + `/cancel` routes + `src/api-registry.ts` entries. | Public surface last, once the machine underneath is proven. |
| 9 | Approvals inbox UI + `@evidence` specs. | |

Steps 1–4 are independently valuable: they make crash recovery correct without
introducing a single new run state.

---

## 8. Phase-1 deltas C4 inherits

Phase 1 is uncommitted in this worktree at the time of writing. C4 builds on it:

- `WorkflowStep.model` + `WorkflowDefinition.defaultModel` (`src/types.ts`) — the
  cursor does **not** need to capture these; they are re-read from the definition
  on resume. But see §9.6: resuming against an *edited* definition is a hazard C6
  fixes and C4 must fail closed on until then.
- `workflow_step_runs.provider` / `.model` — already added by phase 1, so C4's
  `output` column joins an already-widened upsert payload
  (`upsertWorkflowStepRun`).
- `src/runtime/workflow-model.ts` — the per-step model resolver. Resume re-runs
  it; it is pure, so a resumed step resolves the same model.

---

## 9. What C4's detail proved wrong in the design record

> **All eight were accepted and folded back on 2026-07-29.** The design record's
> §1 (C4 table), §2.1, §2.3, §2.4 and §7.3, and the plan's C3/C4/C5 sections and
> phase table, now match this document. This section is the **audit trail** —
> the "said" column records what those documents contained *before* the fold-back,
> not what they say now. **This spec is the authority for phase 2 detail;** on any
> residual conflict it wins.

| # | Design record said (pre-fold-back) | Reality | Fix |
|---|---|---|---|
| 1 | §7.3, §2.3: "transition to `suspended` **before** every await point". | Holds at 1 of 8 await sites. At A5 (`tool` dispatch, `workflow-executor.ts:753`) it would mark a run resumable while side effects are mid-flight — contradicting ported invariant #16. | Replace with §1.4 commit-at-boundary / claim-with-lease / decide-at-recovery. |
| 2 | §2.1, §2.4: `workflow_step_runs.output` is a **C5** column (phase 3). | Resume rehydrates `stepResults` from it. Without it C4 **cannot resume at all**. | `output` moves into C4 (phase 2). The rest of C5's telemetry stays in phase 3. |
| 3 | §2.3 does not mention `persistWrite`. | `persistWrite` swallows every error by contract (`:151-158`). A dropped cursor write silently re-executes a completed batch. | Add `persistCritical`, strict, exactly three call sites. |
| 4 | §2.3: `resumable` is written "at suspend time" by the executor. | The executor cannot know: at suspend time it is at a boundary by construction, so the flag is always `true`. The interesting case is a *crash*, decided by the sweep. | `resumable` is written by the **sweep**, from `run_phase`. |
| 5 | §2.3 is silent on eventing. | Re-emitting `workflow:start` on resume duplicates the run in `store.workflowRuns` (`workflows.md:130`). | `resumeWorkflow` emits only `workflow:step` + terminal events. |
| 6 | §2.3 says widen the `finalizeWorkflowRunRow` CAS and treats that as sufficient. | Necessary but not sufficient: the `finally` (`:429-447`) calls the finalizer **unconditionally**, and `TerminalWorkflowRunStatus` (`workflow-runs.ts:28-32`) correctly excludes `suspended`. | The `finally` needs a `suspended` guard around the finalize; scope teardown stays unconditional. |
| 7 | §2.3 does not address definition drift. | A run suspended for a day may resume against an **edited** definition — different batches, a `cursor.batchIndex` pointing somewhere else entirely. | Until C6 ships versioning, store a `definition_hash` on the run and **fail closed** (`error`, `definition-changed`) when it differs on resume. C6 then replaces the hash with `definition_version_id`. **This is a new requirement the design record missed entirely.** |
| 8 | §1's C4 table lists `run_as` among the columns C4 adds. | `run_as` is meaningless until C3 (phase 7) and would ship as a permanently-NULL column with no writer. | Defer `run_as` / `delegation_id` to C3's migration; C4 adds only `job_ref` and `idempotency_key`. |

Item **7** is the one to escalate: it is a correctness hazard with no
compensating control today, it is cheap to fix (one hash column, one comparison),
and without it a long-parked run can resume into a workflow that no longer
resembles what the operator parked.

---

## 10. Open risks

| Risk | Mitigation |
|---|---|
| Executor surgery destabilizes the sync path | Build order 1–5 keeps suspension out of the tree until the bookkeeping is proven; §6.6's canary specs must pass unmodified. |
| A resumed run double-charges an LLM step | Mid-batch is never resumed (§1.4); only completed batches are skipped, and their results come from `output`, not re-execution. |
| Lease flapping under load | Lease 60s, heartbeat 20s, per-daemon not per-step (§3.4) — a slow step never loses its claim. |
| PGlite vs Postgres claim semantics diverge | CAS only, no `FOR UPDATE SKIP LOCKED` (`schedule-daemon.ts:12-15`); the claim test runs on both drivers. |
| Approval inbox becomes an unbounded queue | `expires_at` + `onTimeout` sweep with the injected clock (§4.4); partial index keeps the scan cheap. |
