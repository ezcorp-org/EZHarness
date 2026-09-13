# Gates: W00 reconcile the integration baseline

Scope: bookkeeping and integration of already-produced work. No platform launch gate closes here. Receipts live under `docs/validation/factory/w00/` (checksums in `SHA256SUMS`) and `/tmp/factory-platform-evidence/w00/`.

- [x] G1: Preserve worktrees, branch heads, dirty diffs, stashes, and producer identities.
  CHECK: git branch --list 'preserve/*' | wc -l; ls docs/validation/factory/w00/dirty-diff-hashes.txt
  EXPECT: 10 preserve branches; hashes for every remaining dirty diff
  EVIDENCE: ten `preserve/stash-*` branches; `dirty-diff-hashes.txt`; no producer process in any factory worktree at audit time.

- [x] G2: Parent GitHub-transport tests and static checks on the baseline.
  CHECK: docs/validation/factory/w00/baseline-results.jsonl
  EXPECT: every exitCode 0 at 33cab8657
  EVIDENCE: transport tests, SDK build, typecheck, lint, boundaries, gate integrity all exit 0.

- [x] G3: Integrate 3a84d4867 before b6cfa4798 and prove the coverage-gap correction on the combined source.
  CHECK: docs/validation/factory/w00/w00-staging3-coverage-results.json
  EXPECT: new-file and patch exit 0 for base 644987ada
  EVIDENCE: `bd2cedcc9` merge; focused, web (590 files / 7437 tests), PostgreSQL/S3 (20 producers), types, lint, gate integrity, boundaries, orchestrator, node coverage exit 0; both 644987ada gates exit 0 at `425c1bfde`.

- [x] G4: Commit Terra's exact tested dirty changes and rerun.
  CHECK: git -C ../factory-lazy-input log -1 --format=%h; docs/validation/factory/w00/terra-recovery-results.jsonl
  EXPECT: 28bc2bfc3; retest recorded honestly
  EVIDENCE: 11 pass / 1 fail on that tree (fresh-runner artifact directory regression); staging baseline 11/11. Not merged; W01 owns the fix before integration.

- [x] G5: Requirement and evidence index for C01–C13, F01–F13, and the eleven gates.
  CHECK: docs/validation/factory/w00/requirement-index.md
  EXPECT: 201 rows labelled implemented/unmerged/unproven/missing/infrastructure-blocked
  EVIDENCE: 76 implemented, 47 unproven, 64 missing, 9 infrastructure-blocked, 5 unmerged; 22 discrepancies with routing in the postscript.

- [x] G6: Freeze the shared interfaces with single writers.
  CHECK: docs/plans/2026-09-13-composable-factory-platform-interfaces.md
  EXPECT: eleven surfaces, ownership table, merge order, open-question defaults
  EVIDENCE: sections 1–15; wave A/B/C type-checkpoint order; migration registry order 32–40.

- [x] G7: Copy redacted evidence summaries and checksums into the repository; correct overstated notes without deleting history.
  CHECK: ls docs/validation/factory/w00/; grep -c "W00 audit 2026-09-13" GATES.md tasks/factory/*.md tasks/todo.md
  EXPECT: summaries, checksums, audit, receipts present; appended notes only
  EVIDENCE: `evidence-summaries.md` (redacted), `evidence-checksums.json`, `task-note-audit.md`, receipts; notes appended to eight files.

- [x] G8: Fix regressions found while proving the baseline.
  CHECK: docs/validation/factory/w00/w00-staging3-results.json
  EXPECT: web-coverage exit 0
  EVIDENCE: `425c1bfde` mints backdated session JWTs through the installation-bound signer; the canonical web pool passes 7437/7437.

Deferred to owners: Terra runtime range (W01), multi-claim validator binding worktree (W05), Phase B stop settlement via `5e017a9c7` (W03, after W01), full-diff coverage backlog (W18).
