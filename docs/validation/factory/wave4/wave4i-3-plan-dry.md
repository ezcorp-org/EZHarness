# wave4i-3 combined run: DRY PLAN (integrator-4, 2026-10-06 ~18:30Z; lock-free; run only on the lead's word, after W4H-11 lands)

The binding run for the second push. Prepared at integ/w00 0363f883a (W4H-13 + W4H-12 merged); when W4H-11 lands, ONLY the head
changes: redo step 0 at the new head and compare the plan line count (W4H-11's new tests join auto-extra).
E=/tmp/factory-platform-evidence  W0=$E/w00  O=$W0/wave4i-3  S=$W0/wave4i/standalone

## 0. DRY at the run head (done at 0363f883a: exit 0)
WAVE_RUN=wave4i-3 PREV_COMBINED_HEAD=1c84df6d5 DRY=1 bash $W0/wave4i/run.sh
  at 0363f883a: preflight (both Temporal binaries, sha) OK; config baseline; prune scan vs 1c84df6d5 exit 0 (12 hits, 0 STOP);
  plan 1499 lines sha256 24ad8dd9bd98d28e (wave4i-2: 1494); 39 runner legs; 369 auto-extra files in 10 chunks; pgSteps 4;
  manifest producers: cov-shard, cov-extras, web-security-coverage, factory-reference-data (factory-temporal covered by node-coverage).

## 1. The combined run (wrapper; the runner takes the lock itself; after-runner through gated-flock; final gates lock-free)
WAVE_RUN=wave4i-3 PREV_COMBINED_HEAD=1c84df6d5 bash $W0/wave4i/run.sh      (detached; a foreground poll of $O/summary.log and
  $O/after.exit at most 10 minutes apart while it runs — lead's lesson 2026-10-06)
  Start margin outside any lock: disk >= 104 GB, swap >= 2.5 GiB, memory >= 6 GiB.
  Known: the runner's own gate for manifest-cov-shard / manifest-cov-extras needs 15 GiB available (1200 s wait, else exit 96, not run).

## 2. ONLY IF the runner reports mergeBlockedBy [manifest-cov-shard and/or manifest-cov-extras] with exit 96 (the wave4i-2 path)
for each blocked leg, one after the other (each through gated-flock, its own exit file; a foreground poll):
  GATED_FLOCK_START_MEM_GIB=15 GATED_FLOCK_EXIT_FILE=$O/producers/<leg>/heavy.exit \
    bash $W0/gated-flock.sh <leg> $O/producers/<leg>/gate.log bash $S/producer-leg.sh wave4i-3 <leg>
then (lock: the runner's own fcntl; resource gate before it):
  cp -p $E/wave4i-3-results.json $E/wave4i-3-results-blocked.json; cp -p $E/wave4i-3-coverage-results.json $E/wave4i-3-coverage-results-blocked.json
  python3 $S/standalone-records.py wave4i-3 > $O/standalone-records.json
  GATE_LOG=$O/merge-only.log bash $S/merge-only.sh wave4i-3 $O/standalone-records.json
  An exit 1 whose only causes are the gate-integrity leg and the interim new-file gate on the 5 BROWSER_CANONICAL_SOURCES .svelte
  files is the KNOWN INTERIM SHAPE (ruled for wave4i-2); any other red: stop and report.
  If the after-runner had red legs for an environment cause, a WHOLE re-run into $O/after-2 on the lead's word (wave4i-2 form).

## 3. Final gates (lock-free; AUTHORITATIVE)
  run.sh runs: FINAL_OUT=$O/final final-merge-gates.sh wave4i-3 $O/after/browser/browser-merged origin/main origin/main  (BINDING)
  if step 2 ran, re-run it by hand after merge-only (move the not-run final/ to final-attempt1-notrun/ first).
  python3 $W0/findings-match.py $O/final/gate-integrity-origin_main.log $W0/expected-integ-findings-vs-main.txt > $O/final-origin-main-expected-match.txt
  second base (lock-free): FINAL_OUT=$O/final-1c84df6d5 bash $W0/wave4f/final-merge-gates.sh wave4i-3 <browser-merged> 1c84df6d5 origin/main
  (1c84df6d5 = the last combined head, wave4i-2, as 1992630f3 was for wave4i-2.)

## 4. Receipts on the lead's word (wave4i-2 form): AFTER_DIR=<after or after-2> run-receipt-json.py / run-receipt-sources.sh wave4i-3,
   the added sources as in wave4i-2 (wrapper, preflight, prune, after gate/exit, final-1c84df6d5, standalone and merge-only files if
   step 2 ran), extra.json computed from the files; merge-receipts.sh; one commit; then the docs line (lessons below), then the push.
   Lesson candidates for that docs line (accepted by the lead): (a) while a hold of yours runs, poll its exit file in the foreground at
   most 10 minutes apart; background notices do not wake an idle teammate; (b) never suggest a host-wide memory action (swapoff,
   drop_caches, kills); report the gate figures.

## Headroom (measured; disk 122 GiB = 131 GB at 18:25Z)
  wave4i-2 took the host from 249 to 239-241 GiB over the run (about 10 GiB residual; logs, lcov, coverage dirs, browser build).
  In-run peaks: the image-building legs (test-coverage.sh producers, podman-* suites, reference-data) are budgeted +20 GB (10^9) above
  the 100 GB floor by the runner (need 120 GB at their start); the producer gate the same. Expected peak use: about 20-30 GB transient
  over the start + about 10 GiB residual. At 122 GiB free the image legs' 120 GB gate passes by about 11 GB only; a W4H-11 hold that
  leaves images/volumes behind (podman: images 53 GB, volumes 23.5 GB now) would close that gap.
  RECOMMENDATION: start wave4i-3 at >= 140 GiB free (or the user's go below it with the risk named).

## RULED (lead, 2026-10-06 ~18:40Z): start threshold
wave4i-3 starts only at >= 140 GiB free; 135-140 GiB only on the lead's explicit word, with the risk named in the receipts; below 135 it waits.
Headroom sources, in order: (1) w4h-11's end-of-package cleanup, ordered by the lead (its container, volume ~15 GB, snapshot, image tag,
own rebuild layers by ID); (2) nothing else of ours is removable, never a prune; (3) the user, asked by the lead.
At the start: read `df -BG /` (GiB) and record it in the wrapper log line before the run; the wrapper's own outside-lock margin (104 GB)
stays as is: the 140 GiB rule is the start word's condition, checked by the integrator, not a lowered or raised floor in the scripts.
Then: redo step 0 (DRY) at the W4H-11 head and report the plan line count; the run starts on the lead's word after that.

## Tooling list for the wave4i-3 receipts (accepted by the lead 2026-10-06)
- own PostgreSQL (W4H-12): heavy-lib.sh a30ab97e7016bcda, detached-merge/commit.sh 88ed9c7c3c2f4d78, own-pg.sh ad7babdd3199dfc0.
- typecheck gate (lead's rule 2026-10-06, tsgo OOMs): tc-gate.sh 84f8b66f0bd3faf0 (test tc-gate.test.sh 190102257917b5fa, 10/10);
  merge-fast-checks.sh 30abfa0ab951b263; heavy-lib.sh 2ae9cc616d683d4e (current; adds TC_IN_LOCK=1 and tc_leg);
  combined-integration.py bc5b463c8aa87cbf (TC_IN_LOCK=1 for every leg; the types leg through tc_run); push-checklist.md 35dc9341d27cfd43.
- shared standalone tools: wave4i/standalone/producer-leg.sh bd2bbbe23dd855d5, standalone-records.py cca3069365537571, merge-only.sh 7326bfed9c56b5e9.
- installs-lib.sh 36e14c55cd666ed0 (every install --ignore-scripts; web then svelte-kit sync).
DRY redo at the W4H-11 head: name the new plan sha and the reason: the runner's types leg is now `bash -c '. tc-gate.sh; tc_run types …'`
(the plan at 0363f883a, 24ad8dd9bd98d28e, predates it), besides any line-count change from W4H-11's files.
