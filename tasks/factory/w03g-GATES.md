# W03g — patch-gate attestation for one uncredited line

Base: integ/w00 a24a619ad. Branch: wp/w03g-patch-gate-attestation. Evidence: /tmp/factory-platform-evidence/w03g/.
Decision memo: /tmp/factory-platform-evidence/w03f/decision-memo.md (option A).

## Merge conditions

- This package merges ONLY on the user's decision A, and ONLY with the `gate-change-approved` label. It changes the
  patch gate and adds an attestation file, so gate-integrity rule 11 (G2) refuses it without the label, by design.
- It is removed at the Bun upgrade (W12e) if Bun 1.4.2 credits src/factory/task-stops.ts:370. The gate enforces this:
  a `.bun-version` change stales every entry, and a credited line fails as no longer needed.

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
to `proof` when its probe reports.

Tests: scripts/check-patch-coverage-attestation.test.ts, 26 cases (schema, every verdict branch, five end-to-end runs of
the real gate in a sandbox). The sandbox is shared with the type-only suite (src/__tests__/helpers/patch-coverage-sandbox.ts),
not copied. Red: eleven mutants, each disabling one branch, each fail the suite (logs/mutants-results.txt).

## G2 — gate-integrity rule 11

Filled by the second commit.

## Results

Filled at the head.
