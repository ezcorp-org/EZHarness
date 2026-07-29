# Three-branch integration plan and conflict analysis

**Date:** 2026-07-29
**Method:** read-only — `git merge-base`, `git diff <base>...<branch>`, `git show`.
**No merge was run, nothing was checked out, and neither other worktree was entered.**

Analysed at: trunk `e7fbd7c7` · C2 `9101cfde` · C6 `b9ffeaee`.

---

## 0. The headline: it is a two-branch merge, and the conflict set is one file

Two results that change how this should be planned:

1. **C6 has committed nothing.** `feat/ez-factory-c6`'s tip **is** its merge base
   (`b9ffeaee`). There is no C6 divergence to analyse yet, so today this is a
   **two-branch** integration. §5 covers what to re-check once C6 lands code.
2. **The textual conflict set is exactly one file:**
   `scripts/coverage-thresholds.json`. Not `schema.ts`, not `migrate.ts` — see
   §1 for why that expectation does not hold.

---

## 1. The real conflict set

Merge bases:

| Branch | Base | Missing from trunk |
|---|---|---|
| `feat/ez-factory-c2` | `3267cbbe` | steps 3–4 (`951a2419`, `bd9abc2e`, `cf520067`, `e736566a`, `23b0801d`) |
| `feat/ez-factory-c6` | `b9ffeaee` | nothing — **no commits yet** |

File sets since `3267cbbe`, restricted to `src/ web/ scripts/`:

- **C2:** 25 files
- **Trunk:** 8 files
- **Intersection: 1 file — `scripts/coverage-thresholds.json`**

### 1.1 Why `schema.ts` and `migrate.ts` do NOT conflict

The expectation was that all branches append to both. They do not, in this
window:

- C2 branched at `3267cbbe`, which is **after** the trunk's schema work
  (`50e73ec5`, `63827be7`) already landed — so C2 **already contains** it.
- The trunk's commits **since** `3267cbbe` are steps 3–4, which touch
  `workflow-runs.ts`, `workflow-executor.ts`, `workflow-definition-hash.ts` and
  tests — and **not** `schema.ts` or `migrate.ts` (verified: the diff for those
  two paths is empty).

So in this window **C2 owns `schema.ts` and `migrate.ts` exclusively.** Git will
fast-path them. This is luck of timing, not design — it will not hold for C6
(§5).

### 1.2 The one conflict, and why it matters more than its size

```
trunk adds:  "src/runtime/workflow-definition-hash.ts": 100,
C2 adds:     "src/extensions/triggers-handler.ts": 100,
             "src/extensions/triggers-store.ts": 100
             (and re-punctuates the preceding "…/ai-kit/src/**": 94 line)
```

Both sides append near the end of one JSON object, and C2 also **edits the
preceding line** to add a trailing comma. That is a classic adjacent-line
conflict: git will flag it, and the resolution is mechanically obvious.

**Why it is worth calling out anyway:** a botched resolution **silently drops a
threshold key**, and a dropped key is a **gate weakening that nothing reports**.
`check-new-file-coverage` only fails on a *missing* key for a *new* file; a key
deleted for a file that already exists just stops being enforced. Nobody sees it.

**Resolution rule:** the merged file must contain **all three** new keys plus
every pre-existing one. Verify by count, not by eye — the numbers are already
known:

| | keys |
|---|---|
| base `3267cbbe` | 384 |
| trunk `e7fbd7c7` | 385 (+1) |
| C2 `9101cfde` | 386 (+2) |
| **merged — required** | **387** |

```
git show <merge-commit>:scripts/coverage-thresholds.json \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"
```

**Anything other than 387 is a dropped key.** One number, checked once.

---

## 2. Migration ordering

All DDL added by either branch is `ADD COLUMN IF NOT EXISTS` /
`CREATE TABLE IF NOT EXISTS` / `CREATE … INDEX IF NOT EXISTS`, and every new
column is nullable or `NOT NULL DEFAULT <safe>`. **Ordering between the two
branches genuinely does not matter**, because:

- the two branches touch **disjoint tables** — trunk's step 1 columns were
  already in C2's base; C2 adds only to `extension_schedules` /
  `extension_webhooks`;
- no statement reads a column another statement adds;
- there are no cross-branch backfills (neither branch has one).

### 2.1 The one non-additive statement — and it is safe, for now

C2's `migrate.ts:2369` is `DROP INDEX IF EXISTS uniq_ext_webhook`, with the
partial replacements immediately after. Two things make it safe **as currently
written**:

- **Within-file order is deterministic.** `migrate()` runs top-to-bottom, so the
  `CREATE` at `:1636` always precedes the `DROP` at `:2369` on a fresh DB. There
  is no replay path that reverses them.
- **`DROP … IF EXISTS` + `CREATE … IF NOT EXISTS`** re-runs cleanly, so a
  repeated boot is a no-op.

**The hazard is future, not present:** any statement inserted **between** `:1636`
and `:2369` that depends on `uniq_ext_webhook` existing would break, and nothing
in the file signals that the index is transient. If a later phase needs to append
DDL touching `extension_webhooks`, it must append **after** `:2371`, not into the
earlier block.

**Note this interacts with an open defect.** That `DROP` is the webhook-index
over-widening I reported (my spec's error). If the fix lands — restore the total
`uniq_ext_webhook`, keep only the dynamic `key` partial — the `DROP` for webhooks
disappears entirely and this hazard goes with it. **Schedules keep theirs**, and
the asymmetry is deliberate.

---

## 3. Semantic conflicts — clean merges that still break

Git will not warn about any of these.

### 3.1 C2 was never built or tested against the trunk's steps 3–4 · **highest risk**

C2 branched at `3267cbbe`, so its tree has **no** `persistCritical`, no durable
cursor, no `run_phase`, no step-output rehydration. Every C2 test ran against a
**pre-step-3 executor**.

The merge is textually clean — the two touch different files — so **nothing will
signal that C2's 3,440 lines have never executed against the current executor.**
Most of C2 is `src/extensions/**` and genuinely independent, but the schedule
daemon dispatches fires that can reach workflow execution, and that path changed
underneath them.

**Mitigation:** after merging C2, run the **workflow** suites, not just the
extension ones. A green `src/extensions/__tests__/**` proves only that C2 is
internally consistent.

### 3.2 The reconcilers now filter on a column the daemon does not consult

C2 exempts `dynamic` rows in both reconcilers, and writes a per-row
`max_runs_per_day` at registration — but the daemon's quota gate still reads
`readGrant(...).maxRunsPerDay` extension-wide and never reads the per-row column
(reported separately as C2 defect 1).

**This merges cleanly and stays broken.** It is not introduced by the merge, but
integration is the moment it becomes invisible: with three branches landing,
"the column exists and registration tests pass" reads as done.

**Mitigation:** the post-merge checklist (§4) names the *behaviour*, not the
column.

### 3.3 C6 will collide with C4 on the cache shape — the one to plan for

C6 introduces `CachedWorkflow` (definition + source + ownership) and moves
lookup/authorization into `resolveWorkflowForCaller`, because the current cache
**erases ownership** (C6 spec §1.1). Meanwhile C4's daemon and resume path
resolve workflows by name against the existing flat `WorkflowDefinition[]`.

If C6 changes `getWorkflows()`' shape rather than adding
`getCachedWorkflows()` alongside it, **every C4 call site compiles against a
different type** — or worse, keeps compiling because the definition is still
structurally assignable, and silently loses the ownership the resolver was
supposed to enforce.

**Mitigation:** C6 spec §1.1 already mandates the additive form —
`getWorkflows()` unchanged, `getCachedWorkflows()` new. **Verify that literally**
at merge time, by grepping for `getWorkflows(` call sites and confirming their
signature is untouched. This is the single most likely clean-merge-breaks
outcome in the program.

### 3.4 Three branches each extend `permissions` in `src/extensions/types.ts`

C2 adds `triggers` (+37 lines). C3 will add `allowDelegated` to `workflows`, and
C6 touches nothing here. Today there is **no** conflict (trunk does not touch the
file), but the *next* branch that extends `ExtensionPermissions` will land in the
same region.

**Mitigation:** whoever merges second should re-run the clamp tests, not just
typecheck — a merged permissions type can compile while a clamp silently drops a
field, which is exactly the `clampWorkflowsPermission` "husk grant" failure mode.

---

## 4. Recommended merge order

**C2 first, then C6, then any later phase branch.**

| # | Merge | Why this position | Re-verify **these properties**, not just "tests pass" |
|---|---|---|---|
| 1 | **C2 → trunk** | It is the branch furthest behind (missing 5 trunk commits), so it accumulates the most drift every hour it waits. It also owns `schema.ts`/`migrate.ts` exclusively **right now** (§1.1) — a property that expires the moment C6 or a later phase appends DDL. | • `coverage-thresholds.json` key **count** matches the expected sum (§1.2)<br>• `migrate()` runs **twice** cleanly on a fresh DB — the `DROP INDEX` re-run path (§2.1)<br>• the **workflow** suites pass, not only the extension ones (§3.1)<br>• `gate-integrity` still passes — C2 branched *before* `bd9abc2e`, so confirm its cherry-pick of that fix survived the merge |
| 2 | **C6 → trunk** | It has no commits yet, so it will branch forward from a trunk that already contains C2 — eliminating the three-way case entirely. Its conflict surface (§3.3) is the executor cache, which is trunk-side, so it should merge *into* a settled trunk rather than the reverse. | • `getWorkflows()`' signature is **unchanged** and `getCachedWorkflows()` is additive (§3.3)<br>• every existing `getWorkflows(` call site still compiles **and still receives ownership-free definitions**<br>• the C4 resume path still resolves a workflow by name<br>• C6's retention sweep excludes versions pinned by a delegation (the C3↔C6 cross-constraint) |
| 3 | later phases | Serially, against a trunk that already has both. | Per that phase's own §11. |

**Do not merge trunk *into* C2.** It would leave the integration work on a
feature branch, and C2's tree is the one missing context.

**A rebase is not recommended over a merge here.** C2 is 25 files and ~3,400
lines across five commits; rebasing replays each against a moved executor, and a
mid-rebase conflict in commit 2 of 5 leaves the tree in a state no test suite
describes. A single merge commit fails once, loudly, with the whole diff visible.

---

## 5. What changes once C6 lands code

This analysis has a short shelf life. Re-run it when C6 has commits, because:

- **`schema.ts` / `migrate.ts` will become a genuine three-way conflict.** C6
  adds `project_id`, `user_id`, `visibility`, `forked_from` to
  `workflow_definitions` and a whole `workflow_definition_versions` table. C2
  appends to the extension tables. Both append near the end of `migrate.ts`, so
  the conflict will be **adjacent-line, auto-resolvable, and easy to botch in the
  same way as the JSON** — a dropped `ADD COLUMN` is silent until something reads
  the column.
- **The `getWorkflows()` question (§3.3) becomes live** rather than
  anticipatory.
- **`coverage-thresholds.json` becomes a three-way conflict** on the same lines.

The cheap check that catches all three: after any merge involving C6, compare
`migrate()`'s statement count and the threshold-key count against the sum of the
inputs. Both are countable, and a silent drop is the failure mode both share.

---

## 6. Summary for the merger

- **One textual conflict today:** `scripts/coverage-thresholds.json`. Resolve by
  **key count**, not by eye — a dropped key is an unreported gate weakening.
- **Migration ordering is genuinely safe** between these two branches; the only
  non-additive statement (`DROP INDEX uniq_ext_webhook`) is safe as written and
  disappears if the reported index defect is fixed.
- **The risk is semantic, not textual.** C2's 3,400 lines have never run against
  the current executor (§3.1), and C6's cache change is the one most likely to
  merge cleanly and break (§3.3).
- **Order: C2, then C6.** C2 is furthest behind and its exclusive ownership of
  the DB files expires; C6 has no commits and should branch forward from a trunk
  that already contains C2.
