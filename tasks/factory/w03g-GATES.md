# W03g — patch-gate attestation for one uncredited line

Base: integ/w00 a24a619ad. Branch: wp/w03g-patch-gate-attestation. Evidence: /tmp/factory-platform-evidence/w03g/.
Decision memo: /tmp/factory-platform-evidence/w03f/decision-memo.md (option A).

## Merge conditions

- This package merges ONLY on the user's decision A, and ONLY with the `gate-change-approved` label. It changes the
  patch gate and adds an attestation file, so gate-integrity rule 11 (G2) refuses it without the label, by design.
- Bun 1.4.2 was probed and does NOT clear the defect: w19a's probe at W03f a4c07dca5 under Bun 1.4.2 reads DA 370 = 156
  and DA 371 = 0, so the method's last statement is still uncredited (w03f/logs/w12e-bun142-probe.log, now in the
  entry's `proof`). The upgrade does not remove this entry by itself.
- The entry never carries over silently. A `.bun-version` change stales it by name, so a Bun bump forces a re-probe
  and a re-attestation with the label. A change to the line text, the line number or the file hash stales it by name.
  A line that becomes credited, on any Bun, fails as no longer needed, and the entry must then be removed.

## Why

Under Bun 1.3.14 the last statement of `stopSettlement` runs in every stop settlement, but coverage credits it to the
line before it in every code shape tried (validator-4, w03f-validation/logs/attr/: DA 370 = 0, DA 369 = 176). A throw
planted on it fails 34 of 43 stop-suite tests. The patch gate is red on that one line, and the standing rules forbid an
exclusion.

## G1 — the patch gate accepts an attested line only while four facts match

scripts/check-patch-coverage.ts reads scripts/coverage-attestations.json (beside coverage-thresholds.json, same
CODEOWNERS review). An entry records the file, the line number, the exact line text, the SHA-256 of the whole file, the
`.bun-version`, the reason and the proof paths. The schema fails closed by name (unknown field, bad line, bad hash, empty
proof, duplicate line).

| Case | Verdict |
|---|---|
| All four facts match, the line is changed in the diff and uncovered | attested; printed as `<file>:<line> attested (Bun <v> coverage defect): <reason> Proof: <paths>`; PASSED names the attested count |
| `.bun-version` differs from the entry | stale, FAILS by name, checked on every run |
| The file is not changed in this diff | inactive, printed, not failing |
| The file is gone | stale, FAILS by name |
| Any edit to the file (SHA-256 differs) | stale, FAILS by name |
| The line's text or number differs | stale, FAILS by name |
| The line is not changed in this diff | inactive, printed, not failing |
| Coverage credits the line, or records no uncovered hit | no longer needed, FAILS by name |

Why the file facts are checked only when the file is in the diff: an entry for W03f's version of task-stops.ts is stale
against every other version, so it would fail every package that does not carry W03f. The Bun pin is checked always,
so the upgrade stales every entry at once.

The one entry: src/factory/task-stops.ts:370, text
`    return factoryJournalStopSettlement(await this.journal.operations(liveAuthority.authority));`, SHA-256 of the file at
wp/w03f-provider-settle 9c954b11a (15da47f8…c3aa), Bun 1.3.14. W03f's two later refactors (a4c07dca5, 86330b87c) move
the line; under decision A, W03f reverts them to the 9c954b11a form, or it records the new hash and line in the entry
(a change rule 11 labels). Proof paths: validator-4's throw mutants (stops-line370-throw.log, stops-sync-helper-throw-370.log),
the DA readings (attr/cov/lcov.info and the five shape probes), W03f's attribution receipts. w19a's receipts are added
to `proof` when its probe reports; its Bun 1.4.2 probe is there now (see Merge conditions).

Tests: scripts/check-patch-coverage-attestation.test.ts, 26 cases (schema, every verdict branch, five end-to-end runs of
the real gate in a sandbox). The sandbox is shared with the type-only suite (src/__tests__/helpers/patch-coverage-sandbox.ts),
not copied. Red: eleven mutants, each disabling one branch, each fail the suite (logs/mutants-results.txt).

## G2 — gate-integrity rule 11

scripts/gate-integrity.ts check 11: any added, modified, deleted, renamed or copied path that is
scripts/check-patch-coverage.ts (the gate, which holds the attestation schema) or scripts/coverage-attestations.json
needs the `gate-change-approved` label. Removal is a change too; the label is the review either way. Before this, an
edit to check-patch-coverage.ts was not flagged by any gate-integrity check (only EXCLUDES growth, the ratchets, biome
and test cheats were).

Tests: scripts/gate-integrity-rule11.test.ts, 12 cases: name-status fixtures for A, M, D, R (both sides), C, a
C-quoted path and the neighbours that must not match; two end-to-end runs of the real gate in a scratch repository
(without the label: FAILED naming check 11; with GATE_CHANGE_APPROVED=1: bypassed and logged). Each end-to-end case
spawns the gate once under its own 60 s bound (a cold spawn took up to 22 s under swap pressure, W18 hygiene C2).
Red (logs/mutants-rule11-results.txt): main() without the check-11 wiring fails both end-to-end cases; a rename that
ignores the new side, a surface without the patch gate, and a matcher without unquoting each fail the fixtures.

## Results (code head 77c860dcf, Bun 1.3.14 and bunx 1.3.14 asserted against .bun-version)

| Leg | Result | Log (w03g/logs/) |
|---|---|---|
| check-patch-coverage-attestation.test.ts | 26/0; red by 11 mutants | suite-check-patch-coverage-attestation.log, mutants-results.txt |
| gate-integrity-rule11.test.ts | 12/0; red unwired and by 3 mutants | suite-gate-integrity-rule11.log, mutants-rule11-results.txt |
| check-patch-coverage-typeonly.test.ts (shared sandbox) | 7/0 | suite-check-patch-coverage-typeonly.log |
| gate-scripts.test.ts, dependency-denylist.test.ts | 210/0, 10/0 | suite-gate-scripts.log, suite-dependency-denylist.log |
| typecheck, lint, check-boundaries, check-factory-boundaries | all 0 | typecheck.log, lint.log, boundaries.log, factory-boundaries.log |
| gate-integrity vs a24a619ad, no label | FAILED, exactly the two check-11 findings (M check-patch-coverage.ts, A coverage-attestations.json), as designed | gate-integrity.log |
| gate-integrity vs a24a619ad, GATE_CHANGE_APPROVED=1 | PASSED, the two findings logged as bypassed | gate-integrity-labelled.log |
| patch coverage vs a24a619ad | PASSED; the task-stops entry printed as inactive (file not in this diff) | patch-coverage.log |
| new-file coverage vs a24a619ad | PASSED (no new source files) | new-file-coverage.log |

Hook: commit 1 mapped 2 tests (26/0, 7/0), commit 2 mapped 1 (12/0), this docs commit maps 0. CI runs both new
suites: scripts/lib/test-file-sets.sh collects every scripts/*.test.ts.

## Fold into check 11 and the integ merge (w18c-2, 2026-09-29; coordinator ruling)

MERGE 508cc28dd: integ/w00 ad22592da (after W18c, C2, W09e and W09h) into this branch. The one conflict,
scripts/gate-integrity.ts, was resolved as the union so that gate-integrity-rule11.test.ts still loads at that commit:
W18c's check 11 (coverage gate tools) as integ has it, and this package's attestation-surface check kept unchanged as
check 12. The hook mapped 159 suites; the coordinator's list-bound skip (w03g-fold/ruling-hook-skip-merge-ad22592da.txt,
with its addendum: the hook prints the orchestrator file as one package line) applied, and all 159 ran outside the hook
under the lock, green with nonzero counts (w03g-fold/merge-suites-508cc28dd/ 158 suites; the orchestrator package's node
runner, 91 tests, in w03g-fold/merge-suites-508cc28dd-factory-orchestrator_/; shared git config hash unchanged).
FOLD (one watched set): scripts/coverage-attestations.json joins COVERAGE_GATE_TOOLS (scripts/check-patch-coverage.ts
was already in it); check 12's list, function and call are removed. gate-integrity-rule11.test.ts is rewritten in place,
not deleted (a deleted test file is itself a gate-integrity finding), and keeps every case in check 11's form: the
watched set holds both files, the seven name-status statuses including C100, the silent neighbours, the C-quoted path,
and the two end-to-end runs without and with the label. Red first: 3 pass, 9 fail on the union (only the
attestation-file cases; the patch gate was already watched); green 12/0; gate-scripts.test.ts 248/0 with the watched-set
equality extended by the json. The finding text is now "coverage gate tool changed (<status>): <path> — it decides what
coverage counts or how a coverage gate judges it".
