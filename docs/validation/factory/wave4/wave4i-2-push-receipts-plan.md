# wave4i-2 push receipts: PLAN ONLY (integrator-4, 2026-10-05 ~23:20Z; commit on the lead's word)

One docs-only commit on integ/w00, destination docs/validation/factory/wave4/, prefix wave4i-2-push-, through
w00/merge-receipts.sh <dir> <sources> (refuses a missing source, an existing name, the proof PostgreSQL password; SHA256SUMS
append-only; sha256sum -c; digest-pinned gitleaks over wave4; lint; stage). Hook count measured (docs: expect 0); archy; dirty=0.
Note: the push happened from the feature worktree at 1bc5f63c7; the receipts commit lands on integ/w00 AFTER it, so it reaches
origin only with the next push (after W4H-11/12 and the next combined run).

## Sources (merge-receipts.sh format: "<source> <name>")
/tmp/factory-platform-evidence/w00/wave4i-2/push/pre-checks.log wave4i-2-push-pre-checks.log
/tmp/factory-platform-evidence/w00/wave4i-2/push/ff.log wave4i-2-push-ff.log
/tmp/factory-platform-evidence/w00/wave4i-2/push/installs.log wave4i-2-push-installs-1.log
/tmp/factory-platform-evidence/w00/wave4i-2/push/installs-2.log wave4i-2-push-installs-2.log
/tmp/factory-platform-evidence/w00/installs-lib.sh.bak-20261005T2240Z wave4i-2-push-installs-lib-before.sh.txt
/tmp/factory-platform-evidence/w00/installs-lib.sh wave4i-2-push-installs-lib-after.sh.txt
/tmp/factory-platform-evidence/w00/wave4i-2/push/push.log wave4i-2-push-push.log
/tmp/factory-platform-evidence/w00/wave4i-2/push/pr-318.json wave4i-2-push-pr-318.json
/tmp/factory-platform-evidence/w00/wave4i-2/push/ci-37383355593-jobs.json wave4i-2-push-ci-37383355593-jobs.json
/tmp/factory-platform-evidence/w00/wave4i-2/push/ci-37383355593-comparison.md wave4i-2-push-ci-37383355593-comparison.md
/tmp/factory-platform-evidence/w00/wave4i-2/hosted-baseline-37138524741.tsv wave4i-2-push-hosted-baseline-37138524741.tsv
/tmp/factory-platform-evidence/w00/wave4i-2/hosted-compare.py wave4i-2-push-hosted-compare.py.txt
/tmp/factory-platform-evidence/w00/wave4i-2/push/ci-37383355593-failed-excerpt.log wave4i-2-push-ci-37383355593-failed-excerpt.log
/tmp/factory-platform-evidence/w00/wave4i-2/push/receipts-plan.md wave4i-2-push-receipts-plan.md

## Open choice for the lead
- all-failed.log (gh run view 37383355593 --log-failed) is 1.2 MB. Plan: commit an EXCERPT made at commit time by one script
  (per failed job: its error lines and the 40 lines around each "(fail)", "##[error]" and the BundledBootstrapTimeoutError stack),
  with the full log's sha256 recorded in the excerpt header; the full log stays in the evidence dir. Alternative: commit it whole.
- installs.log (the first install, web without --ignore-scripts) is kept as the disclosed history next to installs-2.log.

## Facts the commit message and the receipt cite
- pre-checks 22:29:47Z: status empty; HEAD = origin/feat = 1ef82e971; ancestor of integ/w00 1bc5f63c7; config 888c78b9e94ea660.
- ff exit 0: 1ef82e971..1bc5f63c7.
- installs-1 exit 0 22:30:32Z (web without --ignore-scripts; disclosed); installs-lib.sh 0852f87c0c2cf88b -> 36e14c55cd666ed0
  (every install --ignore-scripts; web then `bunx svelte-kit sync`); installs-2 exit 0 22:32:49Z, status empty, config unchanged.
- push exit 0 22:34:34Z, plain (pre-push hook green; svelte-check 620 files 0 errors); HEAD = origin/feat = 1bc5f63c7.
- PR 318: OPEN, draft, headRefOid 1bc5f63c7, MERGEABLE, mergeStateStatus BLOCKED (checks pending at read time).
- ci 37383355593 (failure): red 20 -> 9; fixed 11; same 38; green->red 0; still red: 3 expected (A, A, B), 3 new causes
  (now W4H-11 bootstrap deadline, W4H-12 factory-host-launch), 3 aggregators (B). deps-audit 37383354998 success.

## Host events to list in the receipt (added 2026-10-06 on the lead's word; the excerpt choice: RULED excerpt, header with the full log's sha256 and bytes)
- 2026-10-05 07:55:39Z systemd-tmpfiles-clean (q /tmp 10d): lost temporal-test-server, temporal-cli, postgres.env, w01h/graph/dump-and-drop.sh; restores recorded in w00/wave4i-2/tool-restore.txt.
- 2026-10-05 23:18-23:20Z host OOM storm: a 14 GiB tsgo (not ours) was killed; swap fell to 0.3 GiB free; nothing heavy started until it recovered.
- /tmp/factory-tools/bun-1.3.14/bun-linux-x64/bun found 0 bytes, mode 600, mtime 2026-10-05 08:54:22Z (bunx -> bun). Cause UNEXPLAINED (the time falls in integrator-3's 08:50-08:55Z restore window, whose `touch -a` cannot truncate). Lead ruling 2026-10-06: LEFT as is; no live chain needs 1.3.14 (every chain derives the pin from its tree: 1.4.2); bun_pin refuses a 1.3.14 tree by name (exit 95); W4H-13's only origin/main leg ran with ~/.bun/bin/bun 1.3.14, version-asserted.
- 2026-10-06 14:10Z read-only tools check: the wave4i/run.sh preflight PASSED; temporal-test-server daa58458d32f6254 and temporal-cli 712217694cac9f78 equal their records after the 2026-10-06 07:55Z tmpfiles run (the w00/*.sha256 files hold the bare hash, the form the preflight reads; not the sha256sum -c form). ctime from the restore keeps them safe until about 2026-10-15 without the user's tmpfiles exclusions.
- 2026-10-06 01:06-01:08Z second host OOM storm: a 15.4 GiB tsgo (not ours) was killed; it voided w4h-12's control leg. Both SeaweedFS stores read "unhealthy" only because podman exec failed during the storm; their health checks returned rc 0 at 01:11Z; no restart.
- 2026-10-06 overnight: five more tsgo OOM kills (8.4-10.4 GiB each) and swap at the floor for about 12 h, which held every resource gate (w4h-11's gate gave up at about 04:47Z).
- 2026-10-06 12:34:26Z the shared /home/dev/work/EZCorp/EZHarness/.git/config flipped core.bare (content hash 888c78b9e94ea660 -> 546e460d3bfa387b): Codex session 01a10d6e's staged test ran an unscrubbed `git init` under origin/main's pre-commit hook (main lacks 48da9c886). Found 13:42Z by validator-5's config check; repair routed to the user; package W4H-13 pins the hook behaviour end to end.
- 2026-10-06 ~14:23Z the shared .git/config repaired by the user; verified by the coordinator: config-check.py --check-only reads the accepted baseline 888c78b9e94ea660 (rc 0, 14:24Z).
