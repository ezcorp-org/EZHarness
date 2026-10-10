# Push checklist, SECOND push of the wave (updated by integrator-4, 2026-10-06; every step waits for the lead's word)
(The first push, 2026-10-05: feat 1ef82e971 -> 1bc5f63c7, hosted run 37383355593; the old checklist is push-checklist.md.bak-20261006T1835Z.)

Order: W4H-11 merged and receipted -> wave4i-3 combined run green and receipted (w00/wave4i-3/plan-dry.md) -> the docs line on integ/w00 ->
the wave4i-2 push receipts (w00/wave4i-2/push/receipts-plan.md; excerpt of --log-failed, ruled) if the lead orders them into the same push -> steps below.
Paths: integ worktree I=/home/dev/work/EZCorp/EZHarness-worktrees/composable-factory-platform/.worktrees/w00-integration;
feature worktree F=/home/dev/work/EZCorp/EZHarness-worktrees/composable-factory-platform (branch feat/composable-factory-platform;
at 1bc5f63c7 = origin/feat after the first push). Logs under w00/wave4i-3/push/. Commands zsh-safe (literal paths).

1. Pre-checks (read only) -> push/pre-checks.log
   - git -C F status --porcelain -> empty; git -C F branch --show-current -> feat/composable-factory-platform
   - git -C F fetch origin; git -C F rev-parse HEAD origin/feat/composable-factory-platform -> equal (1bc5f63c7 unless someone pushed: then STOP)
   - git -C F merge-base --is-ancestor HEAD integ/w00 -> exit 0
   - python3 /tmp/factory-platform-evidence/w00/config-check.py --check-only -> 0 (accepted baseline; a branch-only change is accepted by the rule)
2. Fast-forward (in F; never a merge commit, never a rebase): git -C F merge --ff-only integ/w00 > push/ff.log 2>&1 -> "Fast-forward"
3. Frozen installs in F at that head (w00/installs-lib.sh 36e14c55cd666ed0: EVERY install with --ignore-scripts; web then `bunx svelte-kit sync`;
   the six package builds): resource gate first; bash -c '. /tmp/factory-platform-evidence/w00/bun-pin.sh; bun_pin F;
   . /tmp/factory-platform-evidence/w00/installs-lib.sh; frozen_installs F <O>/push/installs.log' -> exit 0; status empty; config unchanged
4. Push (plain; the pre-push hook runs typecheck + svelte-check --tsgo (8-15 GB peaks); never --force, never --no-verify), through the
   typecheck gate LOCK-FREE (lead's rule 2026-10-06: MemAvailable >= 16 GiB, no heavy-lock holder, one typecheck at a time; MemAvailable
   before and the lowest during are logged; exit 75 = red gate or a killed hook: VOID, re-queue the push, never retry blind):
   bash -c '. /tmp/factory-platform-evidence/w00/tc-gate.sh; TC_IN_LOCK=0 tc_run push <O>/push/tc-gate.log git -C F push origin feat/composable-factory-platform' > push/push.log 2>&1
   -> exit 0; then git -C F rev-parse HEAD origin/feat/composable-factory-platform -> equal
5. PR state (read only): gh pr view 318 --json number,state,isDraft,headRefOid,mergeable,mergeStateStatus,statusCheckRollup > push/pr-318.json
   -> headRefOid = the pushed head. (The PR body line is the lead's.)
6. Hosted CI against the LAST run 37383355593 (1bc5f63c7; 9 red), baseline w00/wave4i-3/hosted-baseline-37383355593.tsv (01285a508f1be6e9):
   - the new ci run on the pushed head: gh run list --branch feat/composable-factory-platform --limit 3
   - ONE blocking waiter that, when the run completes, saves the jobs (gh run view <id> --json jobs > push/ci-<id>-jobs.json), runs
     python3 /tmp/factory-platform-evidence/w00/wave4i-2/hosted-compare.py /tmp/factory-platform-evidence/w00/wave4i-3/hosted-baseline-37383355593.tsv push/ci-<id>-jobs.json 37383355593 <id> > push/ci-<id>-comparison.md
     and gh run view <id> --log-failed > push/ci-<id>/all-failed.log; PLUS a foreground poll at most 10 minutes apart (lesson 2026-10-06).
   - Expected GREEN after this push: Production proof (content) and (resources) (W4H-11, bootstrap deadline), external-postgres /
     External Postgres (Bun.sql) (W4H-12), and their aggregators Backend tests, Per-file coverage gate, E2E (mock, no Docker),
     Production image extension lifecycle.
   - May stay RED (known): Gate integrity (the gate-change-approved label, 8 findings), Factory runner readiness precheck
     (FACTORY_RUNNER_READ_TOKEN; its 3 dependents skipped).
   - Any other red is new: classify A-E with its log line before reporting; green->red is reported at once.
7. Report to the lead: ff head, installs exit, push exit, PR headRefOid and mergeStateStatus, the new run id; then the lane table.
