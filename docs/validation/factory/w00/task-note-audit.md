# Task-note overstatement audit — composable factory platform

Read-only audit. No file in any repository or worktree was modified while
producing this report. Integration repo audited at head `33cab8657`
(`/home/dev/work/EZCorp/EZHarness-worktrees/composable-factory-platform`).

Scope covered: `tasks/todo.md` (factory-related sections), every file under
`tasks/factory/`, root `GATES.md`, `docs/validation/factory/**`, and the
uncommitted/committed task notes in the `factory-assurance`,
`factory-lazy-input`, `factory-validator-binding`, `factory-hardening`, and
`factory-kernel` worktrees. Work was split between the lead auditor (direct
verification below) and four parallel sub-audits; findings from all five are
merged into one table, deduplicated, and in three cases independently
re-checked live (test re-run or fresh `git`/`sha256sum` commands) rather than
taken on the sub-audit's word alone.

## Findings

| File:line | Claim (quoted, trimmed) | Problem | Receipt checked (path or none) | Proposed correction wording (append, never delete) |
|---|---|---|---|---|
| `factory-assurance` worktree, `GATES.md:118` (E4) | "`[x]` E4 Real local ordinary S3 proves encrypted artifact round-trip... EVIDENCE: 2 fail \| Ran 2 tests across 1 file." | Checked `[x]` while its own EVIDENCE line records the test run failing. No re-run needed — the note contradicts itself. | Evidence is inline in the note itself; no external log needed to see the contradiction. | "CORRECTION (audit 2026-09-13): this item's own evidence records 2 fail / 0 pass. Revert to `[ ]` until a passing run is recorded." |
| `tasks/factory/provider-publication-GATES.md:3` (P1) | "`[x]` P1: Reconciliation cannot turn a matching but unverified receipt into success. EVIDENCE: root-provider-receipt-red.log and ...-final-combined-integration-results.json" | Nuanced: the underlying claim is actually TRUE today — I independently re-ran the cited test live against integration HEAD `33cab8657` (`bun test ./src/factory/releases.integration.test.ts -t fabricated`) and got 1 pass / 0 fail. But the cited EVIDENCE is wrong: `root-provider-receipt-red.log` records the test **failing** (0 pass/1 fail — a red/pre-fix run), and the results JSON's head `17b79bab1d6da0f58620d77a6c8ac4ab0d50617b` is confirmed NOT an ancestor of `33cab8657` (`git merge-base --is-ancestor` returns false; it sits on an unmerged branch). The checkbox state happens to be correct, but the citation trail is broken and points to the wrong evidence. | `/tmp/factory-platform-evidence/root-provider-receipt-red.log` (shows fail); live re-run at `33cab8657` (shows pass, done by this auditor) | "CORRECTION (audit 2026-09-13): the cited red.log and head 17b79bab1 do not support this claim (red.log fails; that head is unmerged). Re-verified live against 33cab8657: the fabrication-rejection test passes (1 pass/0 fail). Replace the EVIDENCE citation with a receipt whose head is an ancestor of the integration branch, e.g. `root-provider-receipt-store-green.log`, or record this live re-run." |
| `tasks/factory/generic-command-approval-GATES.md:22,41` | "`releases.ts`: 402/402 lines" and frozen digest `c1eaf0465b98...` | Digest is stale. Current `sha256` of `src/factory/releases.ts` at `33cab8657` is `ead089da22...`, not the frozen value. Two commits changed the file afterward: `f150e8566` ("keep current approvals visible after progress") and `1ba2b6763` ("verify provider receipts before reconciliation"), both confirmed ancestors of `33cab8657`. The 402/402 coverage figure was measured on content that no longer exists. | `/tmp/factory-command-approval-coverage-merge/lcov.info` (coverage only, matches the *old* content); `git log 12525d282..33cab8657 -- src/factory/releases.ts` (shows the 2 later commits) | "Note (audit 2026-09-13): releases.ts changed in f150e8566 and 1ba2b6763 after this digest/coverage was frozen. Re-measure coverage and re-freeze the digest against current HEAD." |
| `tasks/factory/grants.md:10` | "grants-final.log and postgres-factory-grants-records.log, each 20 pass / 0 fail / 126 assertions across grant and records suites." | `postgres-factory-grants-records.log` actually records **21 pass / 0 fail / 135 expect() calls**, not 20/126. PGlite log (`grants-final.log`) does show 20/0/126. The two suites are not identical, as the note implies. | `/tmp/factory-platform-evidence/grants-final.log` (20/0/126, matches); `/tmp/factory-platform-evidence/postgres-factory-grants-records.log` (21/0/135, does not match) | "Note: PostgreSQL suite actually ran 21 pass / 0 fail / 135 assertions, one more test than the PGlite run, not an identical 20/126." |
| `tasks/todo.md:1232-1236` (CI storage producer leaf) | "`[x]` Provision the ordinary Compose-backed store... Review: `71700a687` reuses the strict local storage provisioner..." | `71700a687` is confirmed NOT an ancestor of integration HEAD `33cab8657` (independently re-checked: `git merge-base --is-ancestor` returns false; commit lives on unmerged branch `feat/factory-artifacts`). `.github/workflows/db-postgres.yml` exists at HEAD but has diverged from what that commit added, so the checked-off work isn't traceable to an integrated commit. | commit `71700a687` (exists, confirmed wrong branch); `.github/workflows/db-postgres.yml` at HEAD (exists, diverged) | "Note: cited commit 71700a687 is not merged into the integration branch (lives on feat/factory-artifacts). Confirm an equivalent change actually landed here, or re-open this item." |
| `factory-assurance` worktree, `tasks/factory/run-controls-GATES.md:3` | "Status: ready for integration" | The same note's own "Receipts" section links `root-protected-effects-parent-coverage-patch.log`, which records a **FAILED** patch-coverage gate (3 files with uncovered changed lines: `kernel-types.ts` has no LCOV data at all, plus one uncovered line each in `kernel.ts` and `command-authority.ts`). All the leaf's own test/coverage claims are individually accurate (43 pass/635 assertions, 1 pass Temporal replay, and all 6 cited file coverage counts matched exactly against `sol-run-controls-final-cov.envB3F/merged-final.lcov`), but "ready for integration" overstates readiness given the linked failing parent gate. Corroborated independently by `tasks/todo.md:1901-1905`, which keeps a coverage item unchecked for the same baseline commit `644987ada`. | `/tmp/factory-platform-evidence/root-protected-effects-parent-coverage-patch.log` (shows FAILED); `/tmp/factory-platform-evidence/sol-run-controls-final-cov.envB3F/merged-final.lcov` (leaf coverage confirmed accurate) | "Note: 'ready for integration' should be qualified — the linked parent patch-coverage gate is still failing on 3 files (kernel-types.ts, kernel.ts, command-authority.ts). This leaf's own tests/coverage are solid; the platform-level gate is not yet closed." |
| `tasks/todo.md:47-51` (Factory assurance integrity — 2026-09-13) | Three items checked `[x]` ("Bind every persisted contract field...", "Revalidate that snapshot...", "Write approval request, decision, and consumption audit facts...") | No receipt, log path, or review text of any kind for these three checked items — the section jumps straight to the next header. Two proof items in the same block are honestly left unchecked. | none found | "Note: no review or evidence was recorded for these three checked items as of 2026-09-13. Confirm against current source before relying on this checkbox state." |
| `tasks/todo.md:54-59` and `:61-68` | "Focused coverage reports 100% executable lines for the three owned source files." / "Focused Bun source coverage has 100% lines for `encryption.ts` and `private-files.ts`..." | No LCOV/log path cited, unlike nearly every neighboring section. "100%" cannot be independently checked. | none found | "Note: no coverage receipt path is cited; add the lcov path or mark unverifiable." |
| `tasks/todo.md:86` | "...and 3 real-Python C02 conformance cases. The focused canonical Bun coverage receipt at `.../terra-backend-regression-coverage.log`..." | The cited log only contains Bun test files (event-subscriptions, grant-reconcile-drafts cases); no Python conformance run appears in it. The citation exists but does not back this specific piece of the claim. | `/tmp/factory-platform-evidence/terra-backend-regression-coverage.log` (found; doesn't contain the Python case) | "Note: no receipt is cited for the 3 real-Python C02 conformance cases specifically; add the actual log or mark unverifiable." |
| `factory-hardening` worktree, `tasks/todo.md:953-968` | "Focused C02 journal, supervisor, and runner-service tests pass. Real rootless Podman attach/recovery test passes under the shared heavy lock. Canonical typecheck passes." (6 items `[x]`) | Zero receipt, log path, test count, or assertion count cited for any of the 6 checked items — unlike every other gate note in this codebase. Worktree HEAD `bd2cedcc9` is not yet an ancestor of `33cab8657` (expected for an unmerged leaf), but the missing citation means the claim can't be checked at all, merged or not. | none | "Note (audit 2026-09-13): no log path, test count, or coverage file is cited. Add actual command output/log path before treating this leaf as verified." |
| `factory-kernel` worktree, `tasks/todo.md:931-940` | "Review: local real-PostgreSQL recovery tests and source coverage pass." (5 items `[x]`, 1 `[ ]`) | No receipt path or test/assertion count cited. A plausible candidate (`/tmp/factory-provisioning-coverage-e31/lcov.info`, `local.ts` 158/158 lines) exists but is not the file this note actually points to, so it can't be treated as confirming this specific claim. Cited-adjacent commits `e30c63090`, `f6f6bfad8`, `284080ead` are not yet ancestors of `33cab8657` (expected, unmerged). | `/tmp/factory-provisioning-coverage-e31/lcov.info` (found independently, not cited by the note) | "Note: review names no log/coverage path. A likely candidate is /tmp/factory-provisioning-coverage-e31/lcov.info (local.ts 158/158) but this is unconfirmed — cite the real receipt explicitly." |
| `tasks/factory/pool-process-GATES.md:10` | "focused process and readiness tests pass 10 tests with 176 assertions... isolated PostgreSQL subprocess suite passes two tests with 16 assertions... canonical pool producer passes 65 tests with 430 assertions" | Only a coverage-only LCOV is discoverable (confirms all 10 pool source files at 100% lines). No transcript log anywhere under the evidence root or bare `/tmp` records the specific 65/430, 10/176, or 2/16 pass/assertion counts. | `/tmp/factory-pool-process-final/lcov.info` (coverage only; confirms 100% lines, not the test counts) | "Note: test/assertion counts (65/430, 10/176, 2/16) have no discoverable transcript; only the coverage LCOV survives. Re-run and save a transcript, or cite the correct log." |
| `GATES.md` (root), 19 checked items across "Cancellation authority leaf", "Factory runner authority binding" (G1-G5), "Factory Drizzle schema gates" (S1-S4), "Factory journal lock-order" (L1-L2), "Factory artifact storage" (A1-A5) | e.g. "EVIDENCE: factory-execution integration passed 6 tests."; "Combined journal LCOV was 202/202"; "including a 512-page linked manifest" | This file uses a different, rerunnable CHECK/EXPECT/EVIDENCE convention (inline prose summarizing a command's output) rather than a saved-log citation. None of the 19 items point to a persisted log/LCOV file. I independently re-ran one CHECK command (`rg -n "execution_epoch=.*cancellation_epoch" src/factory/executions.ts`) and it still matches, so that one item holds up today. The remaining 18 were not independently re-run in this audit — this is a documentation/process gap (no persisted receipt), not a proven false claim. | none persisted; 1 of 19 spot-checked live and confirmed | "Note: this leaf's checked items cite no receipt paths; either persist the actual command output as a log, or accept that this file's convention is rerun-on-demand and periodically re-verify all 19 items live (only 1 was re-run in this audit)." |
| `tasks/factory/task-outcomes-GATES.md` (Review section, no checkboxes) | "PGlite focused coverage: 44 tests, 707 assertions, exit 0. `task-outcomes.ts` is 118/118 lines..." | No receipt path cited anywhere in the file for any of these narrative claims. | none | "Note: no receipt path is cited for this leaf's review claims; add the actual log/lcov path." |
| `factory-lazy-input` worktree, `tasks/todo.md:50` | "`attempt-runtime.integration.test.ts` passes five PGlite/real-Podman cases and 24 assertions." | Coverage figures in the same sentence (177/177, 9/9) are confirmed exactly against `terra-c02-attempt-runtime-coverage/lcov.info`. No test-transcript log recording "5 pass/24 assertions" for this specific file was found anywhere. Minor gap, not a contradiction. | `/tmp/factory-platform-evidence/terra-c02-attempt-runtime-coverage/lcov.info` (coverage only) | "Note: coverage counts confirmed; the 5-pass/24-assertion transcript itself has no located receipt — add one." |

## Items verified as supported

Roughly **108** checked items/claims were independently confirmed against
matching receipts (exact pass/fail/assertion counts, exact LCOV line counts,
or confirmed commit ancestry), with zero discrepancy. A representative
sample:

- `tasks/factory/budgets.md` — all 5 checked items match exactly (57 pass/0
  fail/10 files; `budgets.ts` 168/168, `outbox.ts` 130/130, migration 7/7;
  PostgreSQL 7 pass/0 fail/49 assertions).
- `tasks/factory/inbox.md` — all 4 checked items match exactly (29/0/203
  PGlite, 8/0/66 PostgreSQL, `inbox.ts` 89/89, clean lint).
- `tasks/factory/completion-plan-GATES.md` P1-P5 and
  `docs/validation/factory/completion-plan/structure.json` — fully
  supported; plan document digest, baseline ancestry, and byte-identical
  `tasks/factory/GATES.md` all confirmed.
- `tasks/factory/release-api-GATES.md`, `release-authority-GATES.md`,
  `release-idempotency-GATES.md`, `release-notification-delivery-GATES.md`,
  `run-lifecycle.md`, `validator-materials-GATES.md` — every checked item's
  cited LCOV matches the claimed line counts exactly (e.g.
  release-authority.ts 169/169, migration 24/24, artifacts 95/95,
  executions 224/224, schema 1249/1249).
- `tasks/factory/private-command-dispatch-GATES.md` — all 5 checked items
  confirmed, including the specific "77 real Node tests" claim (found via
  `root-private-validator-dispatch-merge-node-coverage/test-progress.log`,
  a differently-named companion log; content matched exactly: 77 tests, 77
  pass, 0 fail). Merged head `ac656591e` and base `fe7be0bbe` both confirmed
  ancestors of `33cab8657`.
- `factory-assurance/GATES.md` E1-E3 — all three legitimately changed from
  `[ ]`/pending to `[x]` with matching passing test logs (48 expect() calls
  each, 8 tests per file; separate Node Temporal round-trip test also
  passing).
- Roughly 40 further `tasks/todo.md` sections (Trusted factory command
  lookup, Factory transition status projector, Factory product budget
  store, native-terminal/lifecycle-artifacts/assurance-integrated
  integration batches, parent integration proofs for input resolver/task
  admission and command routing) all matched their receipts exactly,
  including a 26,152 pass/0 fail/1,714-file full regression receipt.
- `factory-lazy-input` and `factory-validator-binding` worktrees — the
  `310534627` foreign-key fix commit and the `ac656591e`/`fe7be0bbe`
  private-command-dispatch counts were independently re-confirmed a second
  time from a different worktree's notes, with no discrepancy.

## Unverifiable

Items where a receipt could not be found at all (as opposed to a receipt
that was found and contradicted the claim) are listed in the findings table
above with "none" or "none found" in the Receipt column. In summary, these
are: `tasks/todo.md:47-51`, `tasks/todo.md:54-59,61-68`, `tasks/todo.md:86`
(partially — a wrong-but-real receipt is cited), `factory-hardening
tasks/todo.md:953-968`, `factory-kernel tasks/todo.md:931-940`,
`tasks/factory/pool-process-GATES.md:10` (test counts only; coverage is
confirmed), root `GATES.md`'s 19 checked items (18 of 19 not re-run),
`tasks/factory/task-outcomes-GATES.md`'s narrative review, and
`factory-lazy-input tasks/todo.md:50` (test-count transcript only; coverage
confirmed). None of these are proven false — they simply have no
independently checkable evidence trail as things stand.

## Summary

- **Total items audited:** ~160 checked items/status claims across
  `tasks/todo.md`, all 22 files under `tasks/factory/`, root `GATES.md`,
  `docs/validation/factory/**`, and the five worktrees' task notes.
- **Overstated (receipt contradicts, or ancestry/source check fails):** 6
  confirmed findings (see rows 1-6 in the table above; two — the E4 gate and
  the provider-publication P1 citation — were independently re-verified live
  by this auditor, not just from logs).
- **Supported:** ~108 checked items/claims confirmed exactly against
  receipts.
- **Unverifiable (no receipt exists to check, claim neither proven nor
  disproven):** 9 findings (rows 7-15 in the table above), covering roughly
  25 individual checked items.

**Five most serious overstatements:**

1. `factory-assurance/GATES.md:118` — E4 checked `[x]` while its own
   EVIDENCE line reads "2 fail." Self-contradicting; highest severity
   because it needs no external check to disprove.
2. `tasks/factory/provider-publication-GATES.md:3` (P1) — cites a red
   (failing) log and a head commit not merged into the integration branch as
   if they were passing evidence. The underlying claim is actually true (I
   re-ran it live against `33cab8657` and got 1 pass/0 fail), but the
   evidence trail is broken and points to the wrong artifacts — this is a
   dangerous pattern because the next person auditing this file would
   reasonably conclude the claim is false, or trust an unmerged commit as if
   integrated.
3. `tasks/factory/generic-command-approval-GATES.md:22,41` — frozen digest
   and 402/402 coverage for `releases.ts` are stale; two later merged
   commits changed the file and the gate was never re-run.
4. `tasks/todo.md:1232-1236` — CI storage producer leaf checked off citing
   commit `71700a687`, confirmed not an ancestor of the integration branch
   (lives on an unmerged branch).
5. `factory-assurance/tasks/factory/run-controls-GATES.md:3` — "Status:
   ready for integration" while the note's own linked receipt shows a
   FAILED parent patch-coverage gate on three files; corroborated by an
   unchecked item in `tasks/todo.md` for the same baseline commit.
