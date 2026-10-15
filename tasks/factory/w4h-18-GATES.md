# Gates: W4H-18 — the runner-FD settle in the production resources proof

Scope: hosted run 37986983940 on 6df16debf failed "Production proof (resources)", R4 cycle 1: "Cycle 1 runner FDs 26 did not
return to baseline 25." (scripts/verify-shipping-runtime-resources.ts). The run before it, 37960843272, passed the same job, and
no commit between them touches the script or the runner. Branch `wp/w4h-18-runner-fd-settle` from integ/w00 `6df16debf`.
Evidence directory: `/tmp/factory-platform-evidence/w4h-18/`, written `w4h-18/` below. validator-8 validates; integrator-5 merges.
integ/w00 is at 95bc71b20 at the time of writing. The commits after 6df16debf change docs/ only. The gates compare against the
merge-base, 6df16debf.

## Root cause

After each cycle the script settled the APP's port-3000 connections (waitForAppConnections, #329). Then it read the EXTENSION
RUNNER's /proc/<pid>/fd count ONCE and compared it to the baseline by strict equality. A socket or pipe of the finished cycle
that the runner closes a moment after that one read failed the proof. A real leak stays open. The check could not tell the two
apart, and the failure receipt held only the app's descriptors (hosted receipt: no runner field), so the extra descriptor
could not be named. The W4H-11 R5 note "Cycle 1 runner FDs 24 did not return to baseline 23" is the same defect. It is not the
#329 flake.

## Fix (rulings of the lead, 2026-10-09: helpers in the accounting lib; equality only; runner snapshot for the kinds)

- `scripts/lib/shipping-runtime-resource-accounting.ts`:
  - `settleRunnerFds` re-reads the count until it EQUALS the baseline. It makes at most `RUNNER_FD_SETTLE_POLLS` = 150 reads,
    100 ms apart, in the same shape as waitForAppConnections.
  - The bound is a wait, never an allowance. A count above OR below the baseline after the bound is returned as read, and the
    strict check then fails.
  - Bound 0 is one strict read with no wait (today's behavior). A negative or fractional bound is refused.
  - `runnerFdFailureEvidence` lists each runner descriptor that is not in the baseline snapshot, with its kind
    (socket, pipe, anon = anon_inode, path, other), and the baseline descriptors that closed.
  - `multisetDelta` moves here from the script (DRY). It now takes an identity function. The app-descriptor and mapped-file
    identities are byte-equal to the old ones.
- `scripts/verify-shipping-runtime-resources.ts`:
  - It takes a runner fd snapshot (fd number to readlink target, with the kind) right after the baseline sample.
  - It calls the settle after the app-connection settle and BEFORE the cycle sample.
  - Every cycle sample records `runnerFdSettle` (the polls used).
  - The strict check and its message are byte-equal to before. On failure the receipt gains `failure.runner`: the settle
    result, the extra descriptors, their kinds and the missing descriptors.
  - No app-side check changed. No threshold changed.
- Bound against the timeouts: 150 × 100 ms is at most about 15 s per cycle, plus the reads. The default run has 10 cycles, so the
  worst case is about 150 s. The local cycles took about 141 s. That fits the proof's 25-minute timeout and the 75-minute shard
  job timeout.

## Gates

Commit note: the gate file and `tasks/todo.md` are force-added (`-f`) because of the bare `tasks` rule at .gitignore:8.
This is established practice.

- [x] G1 (R1a, red first): the settle test is RED at base. CHECK: `bash w4h-18/unit.sh r1-red-at-base` at 6df16debf with the new
  test file untracked. EXPECT: the new file fails on the missing helper, and the existing accounting test stays green.
  EVIDENCE: `w4h-18/logs/r1a-unit-red-at-base.log` (5fee097c281f9e54): "SyntaxError: Export named 'RUNNER_FD_SETTLE_POLLS' not
  found", 4 pass 1 fail 1 error.
- [x] G2 (R1b): the hosted receipt cannot name the extra runner descriptor. CHECK: read the copied job log and the
  read-only downloaded artifact. EXPECT: a failure block with no runner field. EVIDENCE: `w4h-18/logs/hosted-37986983940-resources-job.log`
  (3d372f23426aeb3f, byte-equal to the w00 copy), `w4h-18/hosted-artifact-37986983940/runtime-resources/runtime/r4-resource-samples.json`
  (a221ad4b80b3ab80): runnerFds 25 at baseline and 26 at cycle 1. The failure block lists 430 APP descriptors (there is no warm
  snapshot at cycle 1) and no runner field.
- [x] G3 (R1c): the resources shard at base, under the lock. CHECK: `GATED_FLOCK_EXIT_FILE=… w00/gated-flock.sh w4h-18 … timeout
  3600 bash w4h-18/heavy.sh 6df16debf… r1c-base resources`. EXPECT: a log, red or green. EVIDENCE: `w4h-18/r1c-base/heavy.log`
  (1f95bcc106422fbd), heavy.exit 0, receipt (ecd72d41bc90ff17): 10/10 cycles, runnerFds 24 in every sample. Green, which does not
  refute the hosted red (the race depends on timing). Try 1 (`w4h-18/r1c-base-try1-harness-perm/`) failed in setup with
  "Permission denied": the harness copies had mode 0600/0700. This was fixed to W4H-11's modes and is not a product result.
- [x] G4 (R2): the unit test is GREEN at the fix with 100 percent of the lib. CHECK: `bash w4h-18/unit.sh r2-green --coverage
  --coverage-reporter=lcov`. EXPECT: 0 fail, and the lib has LH = LF and FNH = FNF. EVIDENCE: `w4h-18/logs/r2-unit-green.log`
  (2f8698ab63b16500): 16 pass 0 fail. `w4h-18/cov-r2/lcov.info` (b0cab13625cf762a): the accounting lib has LF 63 LH 63 and
  FNF 12 FNH 12. The cases are: late close (3 polls above, then the baseline), already settled, permanent leak (stops at the
  bound with the count unchanged), below the baseline, oscillation 26/24/26/25 (settles only on equality), default bound 150
  settles a late close, the default 100 ms pause, bound 0 (one strict read), negative or fractional bound refused, permanent
  leak with its kind named, receipt kinds for socket/pipe/anon/path, and a reused fd number with a new target.
- [x] G5 (R2 mutants): every mutant of the lib goes RED, and the file is restored byte-equal. CHECK: `bash w4h-18/mutants.sh`.
  EXPECT: 5/5 RED. EVIDENCE: `w4h-18/logs/mutants-summary.log` (43e8cb418c31b088):
  - polling removed (one read): RED, 7 fail (ddefaf7f0319175d).
  - bound 0 (RUNNER_FD_SETTLE_POLLS = 0): RED, 1 fail (077a2f0c85aee189).
  - kinds omitted: RED, 3 fail (2f6ba9f1b400d727).
  - `<=` allowance below the baseline: RED, 2 fail (6dc5f29d8169e6bc).
  - no wait between polls: RED, 2 fail (69e20cdced44f20f).
  - The restored lib sha is ee6078c0e253546b.
- [x] G6 (R3): the resources shard of scripts/verify-shipping-production-suite.sh at the head, as CI runs it, under the lock.
  CHECK: `w00/gated-flock.sh w4h-18 … bash w4h-18/heavy.sh dcc3212c4… r3-head resources`. The shard selects runtime-resources
  only (`bun scripts/production-proof-plan.ts select resources`). EXPECT: green, and every cycle sample carries runnerFdSettle.
  EVIDENCE: `w4h-18/r3-head/heavy.log` (9871f8e4b470e402), heavy.exit 0, summary.tsv (d7a23358fd56ce70): runtime-resources exit 0.
  The receipt (2e9524e57fbec978) shows 10/10 cycles, runnerFds 24, and runnerFdSettle {remaining 24, polls 1, maxPolls 150}
  in each of cycles 1–10. The late close did not occur locally, so every cycle needed 1 poll. The call-site proof is this
  receipt plus the validator's static check that the settle call (script line 336) comes before the sample (line 337).
- [x] G7 (legs, lock-free, 3 files): CHECK: `bash w4h-18/legs.sh` at dcc3212c4. EVIDENCE under `w4h-18/logs/legs-dcc3212c4/`:
  - lint 0 (6a7415167984044f).
  - check-boundaries 0 (43dbf76f5c9cd8f3), check-factory-boundaries 0 (b9a13ffcaa12b4fb).
  - gate-integrity integ/w00 PASS (c520eaba9b8d5d3d). origin/main shows exactly the 8 standing lines, the same set as W4H-11's
    (e01a86fbfedf302b).
  - unit with lcov: 16 pass (af6b02c37a8b27c0).
  - new-file (71923f31eb329d8b) and patch (fe253e6393e21c6c) vs integ/w00: PASSED, and VACUOUS. scripts/ is outside
    SOURCE_GLOBS (0 files).
  - CRAP --changed vs integ/w00: 0 files, vacuous (b66326665ef45ea9). The touched lib functions score at worst 11.0, max 30
    (7dcb217888e49e3c).
  - prune scan clean, 0 hits (0a26d00d6c9e0424).
- [x] G8 (typecheck, tc rule): CHECK: `bash w4h-18/tc.sh`, pinned Node 24.14.1 and Bun 1.4.2, lock-free with no holder.
  EXPECT: 0/0. EVIDENCE: `w4h-18/logs/typecheck.log` (837349230471fadc): build:packages 0, typecheck 0 (MemAvailable 18.8 GiB
  before, lowest 15.5 GiB), svelte-check 0.
- [x] G9 (guard set, under the lock): CHECK: `w00/gated-flock.sh w4h-18 … bash w4h-18/guard.sh`. EXPECT: 0 fail, a nonzero count.
  EVIDENCE: `w4h-18/guard/guard.log` (fababefdd17fdc1e): 41 files, 511 pass, 2 skip, 0 fail. The 2 skips are host-capability
  skipIf cases inside mcp-seccomp-profile and podman-compose-wrapper, which run other tests. No file ran zero tests.
- [x] G10 (hook): the fix commit dcc3212c4 printed 1 suite (the new settle test), 12 pass. EVIDENCE: `w4h-18/logs/commit-1.log`
  (c16a47eabdfffb6f).

## Disclosed limits

- The script cannot be loaded by a unit test, because it runs the proof at module load. Its changed lines therefore have no unit
  lcov. The pure logic is in the lib at 100 percent. R3 executed the baseline snapshot, the settle call and the per-cycle settle
  field. The runner-failure branch (`failure.runner` in the receipt) did not run live, because no cycle failed. Its content is
  the lib's runnerFdFailureEvidence, which the unit test covers.
- R3 ran in the W4H-11 runner-shaped container (Ubuntu 24.04, Podman as `docker`, app ids 0:0), copied to `w4h-18/` with its
  shims. The hosted job uses rootful Docker for the app. This is as disclosed in w4h-11-GATES.md.
