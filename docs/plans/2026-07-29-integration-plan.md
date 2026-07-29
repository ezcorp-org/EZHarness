# Three-branch integration plan and conflict analysis

**Date:** 2026-07-29
**Method:** read-only — `git merge-base`, `git diff <base>...<branch>`, `git show`.
**No merge was run, nothing was checked out, and neither other worktree was entered.**

Analysed at: trunk `e7fbd7c7` · C2 `9101cfde` · C6 `b9ffeaee`.

---

> ## ⚠ RE-VERIFIED 2026-07-29 — this analysis was WRONG within hours
>
> Written when C2 was at step 5 and **C6 had no commits**. Both moved. §5 said
> this had a short shelf life; it did. **The corrected analysis is §7 — read that
> first.** §0–§6 are retained as the original, because the *method* held even
> though the *findings* expired, and the delta is the useful part.

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


---

# 7. RE-VERIFICATION — corrected analysis

Re-run at trunk `68ac8e01` · C2 `f8708bee` · C6 `bc53448b`. Merge bases unchanged
(`3267cbbe`, `b9ffeaee`).

**Both headline claims from §0 are now false.** C6 has landed `bc53448b`, so this
is a genuine **three-branch** merge, and the conflict set is **six files**, not
one.

## 7.1 The corrected conflict set

File counts since each base: **C2 36 · C6 28 · trunk 10.**

| Intersection | Files |
|---|---|
| **C2 ∩ C6** — new three-way risk | `src/api-registry.ts`, `src/db/migrate.ts`, `src/db/schema.ts` |
| **C6 ∩ trunk** — new, and the sharp one | `src/runtime/workflow-executor.ts`, `src/db/queries/workflow-runs.ts`, `src/runtime/workflow-definition-hash.ts` |
| **C2 ∩ trunk** — unchanged from §1 | `scripts/coverage-thresholds.json` |

**§1.1 is now void.** C2 no longer owns `schema.ts` / `migrate.ts` exclusively —
C6 adds `project_id`/`user_id`/`visibility`/`forked_from` plus a
`workflow_definition_versions` table to the same files. That property expired
exactly as predicted.

## 7.2 The one genuinely overlapping hunk — `workflow-executor.ts`

This is the only place where two branches edit the **same lines**, and it needs a
human.

Hunk start lines against the shared base:

```
C6:    30, 112, 159, 168, 241, 249, 619
trunk:  2,  34,  96, 257, 339, 372, 462, 481, 507, 558
```

**C6's `@@ -249,11` covers old lines 249–259; trunk's `@@ -257,8` covers 257–264.
They overlap on 257–259.** Everything else is adjacent-but-disjoint.

- **C6's edit** there is the `stepSubstitute` option plumbing (dry-run).
- **Trunk's edit** is the `executeFrom` / suspend-resume restructure.

Both are in the constructor/options region of `WorkflowExecutor`. A textual
resolution that keeps both hunks is almost certainly correct — but **verify the
`stepSubstitute` field survives**, because losing it silently removes the
dry-run's structural guarantee (C6 spec §4.2), and nothing would fail: the dry-run
route would simply start executing tool steps for real.

That is the single highest-consequence line in this merge.

## 7.3 `coverage-thresholds.json` — the number changed

| | keys |
|---|---|
| trunk `68ac8e01` | 386 |
| C2 `f8708bee` | 388 (+4 over its base of 384) |
| C6 `bc53448b` | 385 (+0 over its base of 385) |
| **merged — required** | **390** |

C6 adds **no** new threshold key, which is worth a glance during review: it
introduced `workflow-scope.ts` and several routes, so either they are covered by
an existing glob or a key is missing. **Not a merge defect** — flagging it for
whoever reviews C6's coverage.

## 7.4 What still holds from the original analysis

- **Migration ordering is still safe.** All three append idempotent DDL to
  disjoint tables; no statement reads a column another adds; no cross-branch
  backfill. The `DROP INDEX` caveat (§2.1) is unchanged and still the only
  non-additive statement.
- **The semantic risks in §3 all stand**, and §3.3 is now **resolved**: C6 added
  `getCachedWorkflows()` and left `getWorkflows()` untouched, which was the
  clean-merge-breaks case I rated most likely. It did not happen.
- **§3.1 stands and grew**: C2 is now 36 files behind the current executor, none
  of it exercised against suspend/resume.

## 7.5 Revised merge order

**C2 → trunk, then C6 → trunk.** Unchanged in order, changed in reasoning:
previously C2 first because it owned the DB files; now C2 first because it is
**furthest behind** (36 files, still branched at `3267cbbe`) and every trunk
commit widens the gap. C6 is only one commit behind and its conflicts are
concentrated in one file.

Re-verify after **C2**: threshold count is on its way to 390; `migrate()` runs
twice cleanly; **workflow** suites pass, not just extension ones.

Re-verify after **C6**: `stepSubstitute` survives in `workflow-executor.ts`
(§7.2) and a dry-run of a tool-bearing graph still **throws** rather than
executing; `getWorkflows()` signature still untouched; threshold count is exactly
**390**.

## 7.6 The standing lesson

This document was accurate when written and wrong within hours, and the failure
mode was not an error in the analysis but **an assumption that branch state
holds**. Any future integration analysis should be re-run immediately before the
merge, not consulted from cache — and should say so in its own header, as this
one now does.
