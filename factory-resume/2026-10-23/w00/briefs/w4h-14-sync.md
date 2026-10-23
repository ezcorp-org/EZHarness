# W4H-14 — main sync (W-SYNC-3): merge origin/main e3309906d into the wave head (coordinator, 2026-10-07 19:5xZ)
Owner: w4h-14. Validator: assigned at the head. Integrator: integrator-5 merges into integ/w00. Evidence dir: evidence/w4h-14/
Read first: w00/briefs/common.md (every rule; the Typecheck memory rule; read your inbox before every action); w00/briefs/w4h-10-sync.md and
tasks/factory/w4h-10-GATES.md (the previous sync: its form, its conflict table, the Pi catalog rule); the W4H-10 merge receipts under
docs/validation/factory/wave4/w4h-10-merge*; the last 150 lines of w00/HANDOFF-2026-09-24-weekly-limit.md.

## Why
PR 318 is DIRTY again: origin/main moved 4 commits past beaff68c8 (the W4H-10 base):
  4d2d2252e fix(deps): patch proxy-addr 2.0.8 and source-map-js 1.2.2 (#327)
  4999c3d90 fix(deps): patch @modelcontextprotocol/sdk 1.31.0 and sharp 0.35.5 (#328)
  0d9b9a9c5 fix(hooks): run staged tests without the git context the hook exports (#326 — a cherry-pick of OUR 48da9c886 + 8ac43c218's block)
  e3309906d fix(proof): let transient app connections settle before the R4 resource sample (#329)
`git merge-tree integ/w00 origin/main` conflicts in 5 files: bun.lock, manifest.lock.json, scripts/lib/hook-lib.sh, src/__tests__/git-hooks.test.ts,
web/package.json. GitHub runs no pull_request workflow while the PR is dirty, so the sync must land before the next push.

## Order of events (do not start the merge before step 0 is done)
0. ANALYSIS NOW, in a worktree from the shared root (`git worktree add ./.worktrees/w4h-14 integ/w00 --detach`; branch wp/w4h-14-sync;
   <USER> identity with --worktree): the conflict table — for each of the 5 files, what each side changed and the intended resolution;
   whether #329 touches anything W4H-11 changes (W4H-11 = wp/w4h-11-bootstrap-deadline: scripts/lib/bundled-bootstrap-progress.ts,
   shipping-bootstrap-state.ts, verify-shipping-delivery.ts, web/e2e/fixtures/bundled-bootstrap.ts, coverage-thresholds.json) — if it does,
   name the lines; the hook-lib.sh and git-hooks.test.ts conflicts should be resolution = OURS (our branch is the superset: #326 is our
   patch cherry-picked, placed differently) — prove it with a diff of main's version against ours; the dependency patches (#327, #328,
   web/package.json): take main's bumps plus the wave's additions, no pin lowered; lockfiles regenerated with the pinned Bun and
   `--ignore-scripts`; manifest.lock.json regenerated with `bun scripts/regenerate-manifest-lock.ts` and checked with --check.
   Report the table to team-lead. Nothing else until the word.
1. WORD from team-lead after W4H-11 merges (integ moves): `git merge integ/w00` first (fast-forward your branch base), then `git merge origin/main`
   (a MERGE commit, not a rebase) and resolve per the table. Red first where main's changes meet the wave's (the suites that read each
   conflicted file at the raw auto-merge), green at the resolved head.
2. Legs at the head: typecheck (tc rule), lint, boundaries, the hook-mapped suites with lcov, the guard set, frozen installs (--ignore-scripts),
   `bun run typecheck` all programs, the web build, new-file and patch vs origin/main (base e3309906d), gate-integrity both legs (expect the 8
   standing findings only; a new line is a STOP), prune scan, config check, the hook suites main touched (git-hooks.test.ts), the proof
   change of #329 (its own tests), migrations if schema moved. Hook count per commit; above 12, send the list and wait.
3. Gate file tasks/factory/w4h-14-GATES.md (force-add; ".gitignore:8 bare `tasks`, established practice"): the conflict table and how each was
   resolved, the #329/W4H-11 overlap statement, red/green logs, leg counts. Report evidence/w4h-14/report.txt once.
Then: the validator; integrator-5 merges (W-SYNC form: targeted hold binding; new-file/patch vs the first parent INFORMATIONAL via
MCG_COVERAGE_INFORMATIONAL; gate-integrity binding = the 8); wave4i-3 at the synced head binds coverage vs e3309906d; docs line; ff; push.
