# W4H-11: the bundled bootstrap deadline on the hosted 4-CPU runner

Order: coordinator brief w00/briefs/w4h-11.md (owner w4h-11). Base integ/w00 at 1bc5f63c7. Red source: hosted CI run 37383355593,
"Production proof (content)" and "Production proof (resources)", both BundledBootstrapTimeoutError at 360 s for 28 installations.
Evidence: /tmp/factory-platform-evidence/w4h-11/.

## The hosted red, read from the log

hosted-timeline.py over w00/wave4i-2/push/ci-37383355593/all-failed.log (output hosted-timeline.txt):

| Job | Started | Verified at 360 s | Still building | Mean step | Slowest step | 28 x mean |
| --- | --- | --- | --- | --- | --- | --- |
| content (legacy-adoption proof) | 22:59:28Z | 27 of 28 | task-tracking | 13.2 s | 37.6 s | 370 s |
| resources (runtime-resources proof) | 22:45:16Z | 27 of 28 | file-refactor | 13.1 s | 34.2 s | 367 s |

The last build in each started 0 to 5 s before the deadline; no idle gap between builds. The two builds that ran last carry the
retryable `runner_busy` diagnostic: they were deferred and requeued, and ran when the slot was free.

The same 28-build chain, earlier: 229 s (hosted main-recovery), 335 s (hosted recovery, one failed build), 307 s (W4H-1 local,
w4h-1/rr4); run 37383355593 crossed 360 s. The flat deadline had no margin by design: it equals the build lease
(buildLimits.timeoutMs 300 s + 60 s).

## One build at a time is by design (lead ruling 1)

- packages/@ezcorp/extension-runner/src/podman.ts:561: a second build is refused with retryable `runner_busy` (maxBuilds default 1).
- src/extensions/bundled-bootstrap.ts:15 and :96: the bootstrap chains its builds on one promise.
- web/e2e/fixtures/bundled-bootstrap.ts header: the server "builds each one through its single isolated runner".
The concurrency is not changed.

## The runner-shaped container (W4H-6 recipe, own copy)

- Image localhost/w4h-11-runner:24.04 (image/Containerfile): /tmp/factory-platform-evidence/w4h-6/image/Containerfile plus four Ubuntu
  packages (podman-docker, docker-compose-v2, jq, xz-utils) and the pinned Node release (below). Removed by name at the end.
- 4 CPUs (`--cpus=4`, every job step under `taskset -c 0-3`), a clean `git archive` snapshot made a one-commit repository
  (`git add -A --force`; heavy.sh exits 3 unless the snapshot tree equals the source tree), the legacy source 537f074e fetched from the
  local repository into the snapshot.
- Job steps in order (job-setup.sh, job-proof.sh): the setup action with web and Playwright, setup-extension-runner-ci.sh --install, the
  candidate build as the "Production candidate image" job runs it, then scripts/verify-shipping-production-suite.sh with the job's
  environment and EZ_SHIPPING_SHARD.

Shape exceptions (lead rulings):
- Podman only. The hosted job runs the app under rootful Docker and the builds under rootless Podman. Here both run on rootless Podman:
  EZCORP_CONTAINER_ENGINE resolves to the docker CLI, which is Ubuntu's podman-docker shim, and Compose drives the rootless Podman
  socket. The proofs' direct docker calls that the shim serves: `inspect` (State.Pid, State.Running, Mounts), `stats --no-stream`
  (MemUsage), `exec`, `cp`, `kill`, `start`, `image inspect`, `build --load`, `run --rm`. Field parity is NOT assumed: it is read
  from the run's own logs (setup.log prints whether `docker build` accepts --load). A difference shows as a proof step failure
  before or after the bootstrap wait, not as a bootstrap timing, and is named here if seen.
- App ids 0:0 (the rootless Podman contract of verify-production-image-lifecycle.sh); the hosted job passes the runner's own uid under
  rootful Docker. Runner uid 1001 as hosted.
- Memory cap 8 GiB (`--memory=8g --memory-swap=8g`, lead ruling), against the hosted VM's 16 GB total. Sizing: app container peak
  0.68 GiB (w4h-1/rr4/runtime-resources/runtime/r4-resource-samples.json), one build guest capped at 2 GiB (core.ts:33), at most four
  execution workers at 512 MiB (core.ts:32, service.ts:157), about 1 GiB for the proof process, Podman and systemd: 5.7 GiB.
  The in-container candidate build (the hosted job builds it on a separate runner) is not measured. A step that hits the cgroup cap
  voids its leg (sampler and journal lines); it is never a result.
- Outside-lock start floor GATED_FLOCK_START_MEM_GIB=8; swap 2.5 GiB and disk 104 GB floors unchanged.
- Three harness shims (evidence dir, mounted read-only; no repository change), each found by a void leg:
  - docker-load-shim.sh at /usr/local/bin/docker: Ubuntu Podman 4.9 `build` has no --load (setup.log: "docker build --load accepted: 0");
    rootful Docker's --load only stores the image locally, which podman build always does; the shim drops --load for `build` only.
  - registries-docker-hub.conf (unqualified-search-registries = docker.io): the legacy source's `FROM oven/bun:1.3.14` is a short
    name that Docker resolves on Docker Hub and Ubuntu Podman refuses (r1-void4).
  - containers-log-driver.conf (log_driver = "k8s-file"): the repository's pinned conmon 2.2.1 is built without journald and Ubuntu
    Podman under systemd defaults to journald, so every container without an explicit driver fails "conmon failed: exit status 1"
    (r1-void4, diag1). The extension runner passes --log-driver=none itself (podman.ts:477); on the hosted runner the app runs under
    Docker. Leftover candidate: any rootless Podman 4.x host with the pinned conmon cannot run a container without a log driver.
- Node 24.14.1 (.node-version; the official linux-x64 tarball, sha256 84d38715d449447117d05c3e71acd78daa49d5b1bfa8aacf610303920c3322be)
  in the image: Playwright needs Node 20 or newer and Ubuntu ships 18.19 (r1q-void1); the hosted image ships its own Node.

## Harness guards (heavy.sh, evidence dir)

- GIT_ guard: before the snapshot's `git init`/`git config` chain, heavy.sh exits 9 if GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE or
  GIT_COMMON_DIR is set, so the chain can only write /tmp/w4h-11-home-snap-<label> (coordinator audit after the shared-config incident
  of 2026-10-06 20:02:49Z). The snapshot repository also sets gc.auto 0 and maintenance.auto false: a background auto-maintenance from
  its commit and fetch raced the container's `chown -R` (r5 hold 4: "maintenance.lock: No such file or directory").
- Resume (coordinator ruling 21:40Z): with W4H11_RESUME=1, a gate release after a green setup stops the container and keeps it, its
  volume and the snapshot (disk only) for the next hold, and only while free disk is at least 115 GB; any other end removes all three.
  The resume check reads the snapshot inside the user namespace and refuses a tree that differs from the source (exit 3).
- Host OOM void (w4h-11b, 2026-10-07): a leg that ends on a signal while the kernel log shows host OOM kills (or suppressed kill lines)
  in the leg's window is VOID: heavy.sh removes its state and exits 5, never 4 (setup failure) or 75 (gated-flock re-queues only 75), so
  nothing re-runs without the coordinator's word. Offline test heavy-void.test.sh (the real leg/void_exit definitions with stubs):
  5 of 5 pass; the previous heavy.sh fails its two void cases. The resource sampler's podman calls run under `timeout 10`.

## Void attempts (kept)

- r1-void1/ (2026-10-05 23:40:28Z, exit 4): `leg=setup rc=126 ... bash: /usr/local/bin/job-setup.sh: Permission denied`. The job
  scripts were 0600 and the container's runner is a subordinate id. The same log showed the snapshot tree cad0d63b0 != source
  1ea7bdd24 (`git add -A` dropped tracked files that .gitignore matches). Fixed: scripts 0644; `git add -A --force` and the tree check.
  Offline proof: the forced add of 1bc5f63c7's archive writes tree 1ea7bdd24, equal to the source. The proofs never ran.
- r1-void2/ (2026-10-06 00:44:30Z, exit 4): root `bun install --frozen-lockfile` failed in @ezcorp/sdk's prepare script
  (`bun run build`, `tsc -b tsconfig.build.json`): "Cannot find module 're2js'" (a dependency of @ezcorp/extension-contract), on 32
  visible CPUs. The signature of an install race (a workspace prepare script running before its dependency is linked). The hosted setup
  action runs this install WITH lifecycle scripts (.github/actions/setup/action.yml "Install root deps"). Setup now runs under
  `taskset -c 0-3`, the hosted shape. The proofs never ran.
- r1-void3/ (gave up 2026-10-06 04:47Z, exit 91): the outside gate never passed in 14400 s (swap under 2.5 GiB); 0 lock tries.
- r1-void4/ (2026-10-06 14:17:53Z, exit 1): setup green on 4 CPUs (the re2js race did not recur), then both shards failed in seconds on
  the conmon and short-name shape gaps above. Its tries 1 and 2 released at the in-lock gate before the first proof; try 2 overwrote try
  1's setup logs (the 3.13 GB setup peak and the "--load accepted: 0" line survive in the report to the coordinator); since then every
  hold writes its own hold-<UTC> folder.
- r1q-void1/ (15:28Z, exit 4): Node 18.19 too old for Playwright. r1s-void-resume/ (20:13Z, exit 3): resources green at 1.8 CPUs
  (below), then the resume check read the runner-owned snapshot as the host user and failed closed; fixed (read inside the user
  namespace), content re-run as r1t.
- r5-released3/ (holds 1 to 3, 2026-10-06 21:18Z, 21:41Z, 21:51Z, each exit 75): setup green at 3.0 CPUs (18.2, 7.4, 7.2 min;
  host_oom 0), then the in-lock gate read SwapFree under 2 GiB before proof-resources-c3.0 and the hold released. No proof ran.
- r5-void4-oom/hold-20261006T220005Z/ (hold 4, exit 4 at 22:14:26Z, VOID): the setup leg was SIGKILLed (rc 137, "Killed") at 22:10:38Z in a
  host-wide OOM storm (kernel: first invocation 22:09:18Z, 160 kills to 22:14Z, global_oom, "oom_kill_process: 7 callbacks
  suppressed"). The memory holder was a pool of 21 bun processes outside any container (34.1 GB anon at kill time, up to 2.5 GB each,
  in the login session scope; not attributable by cwd after the fact); the victims included the rootless podman pause process, conmon
  and podman clients. The W4H-11 container used at most 2.6 GB of its 8 GiB cap; inside it only a dbus-daemon was killed. The old
  harness reported any setup exit as "setup failed" (exit 4); the host OOM void guard above now classifies it. No proof ran.
- r5-gaveup1/ (queued 2026-10-07 15:04Z on the coordinator's word at 134 GB; heavy.exit 91 at 19:04Z): the outside gate waited on swap
  (SwapFree 0 to 0.3 GiB from 15:11Z against the 2.5 GiB start floor) until 17:46:55Z; then setup green at 3.0 CPUs (13.8 min, host_oom 0;
  the maintenance.lock race did not recur), and the in-lock gate released before proof-resources-c3.0 (SwapFree 1.71 GiB against 2 GiB;
  disk 103 GB, so no kept state). gated-flock gave up after 14400 s with one lock try. No proof ran. Setup writes about 17 GB, so the
  115 GB resume rule keeps state only when a hold starts at about 132 GB or more.
- Coordinator ruling (2026-10-07, after five setup-only tries: r5-released3 holds 1 to 3, r5-void4-oom, r5-gaveup1): no floor is
  lowered; the hold starts only with margin enough to survive its own setup. GATED_FLOCK_START_MARGIN_GB=35 (outside disk floor 135 GB,
  so the first proof sees at least about 118 GB and the 115 GB resume rule keeps the state) and GATED_FLOCK_START_MARGIN_SWAP_KIB=1572864
  (outside swap floor 3.5 GiB, so setup's swap use still leaves at least 2 GiB at the proof gate); GATED_FLOCK_START_MEM_GIB=8 and the
  in-lock floors unchanged; W4H11_RESUME=1, so a later proof-gate release makes the next try proof-only.

## R1 local measurements (every run 28 of 28 verified, no stall, no idle gap)

| run | CPUs | proof | last verified | mean step | min/max step | margin to 360 s | host load |
| --- | --- | --- | --- | --- | --- | --- | --- |
| r1-green4cpu | 4.0 | resources | +351.9 s | 12.6 s | 9.2/30.4 s | 8.1 s | about 9 |
| r1-green4cpu | 4.0 | legacy-adoption | +349.3 s | 12.5 s | 9.0/28.8 s | 10.7 s | about 9 |
| r1q-green36 | 3.6 | resources | +298.0 s | 10.6 s | 8.5/21.7 s | 62.0 s | about 3.5 |
| r1q-green36 | 3.6 | legacy-adoption | +346.7 s | 12.3 s | 9.2/30.0 s | 13.3 s | about 7 |
| r1r | 3.0 | resources | +294.2 s | 10.5 s | 8.4/24.2 s | 65.8 s | about 3 |
| r1r | 3.0 | legacy-adoption | +356.7 s | 12.8 s | 9.8/30.0 s | 3.3 s | about 5.5 |
| r1s-void-resume | 1.8 | resources | +319.9 s | 11.4 s | 8.4/23.5 s | 40.1 s | about 6 |
| r1t | 1.8 | legacy-adoption | +295.7 s | 10.6 s | 8.5/23.0 s | 64.3 s | about 7 |

The CPU quota does not set the rate: each build guest has its own 2-CPU cap (core.ts:33 buildLimits.cpuMillis 2000), so the build time
follows host contention (10.5 to 12.8 s at every quota). The same chain ends between 294 s and 357 s on one host on one day, and past
360 s on the hosted runner (13.1 to 13.2 s per build). Timelines: <hold>/resources-timeline.txt and <hold>/content-timeline.txt
(receipt-timeline.py over bundled-bootstrap-initial.json and adoption-state.json runnerCapacity). The r1t setup leg saw nine host OOM
kills (20:26-20:27Z, kernel journal: two other containers, a 10.2 GB tsgo and chromium in a desktop session, two core dumps); no
process of the W4H-11 container was killed and the leg ended rc 0.

## Gates

- [x] G1 (R1) the red, end to end. CHECK: the hosted log, W4H-1's local runs and this package's container runs, each with its
  per-installation timeline. EXPECT: the BundledBootstrapTimeoutError with its timeline. RESULT (coordinator ruling (A), 2026-10-06):
  red on the hosted runner (run 37383355593: 27 of 28 verified at 360 s in both jobs, 13.1-13.2 s per build; hosted-timeline.txt)
  and in W4H-1's three local runtime-resources runs on this host ("deadline with 17 / 5 / 6 of 28 verified, no failed build";
  tasks/factory/w4h-1-GATES.md G4 table; /tmp/factory-platform-evidence/w4h-1/green.log, green2.log, green3.log; W4H-1's passing run
  rr4/ finished the same chain at 307 s). Not reproduced in this
  package's container in eight observations (table above: margins 3.3 to 65.8 s, rate 10.5 to 12.8 s per build at every quota); the
  chain's length varies 22 percent with host load alone. EVIDENCE: hosted-timeline.txt; r1-green4cpu/, r1q-green36/, r1r/,
  r1s-void-resume/ (its resources leg), r1t/ (each hold-*/resources-timeline.txt or content-timeline.txt).
- [x] G2 (R2) root cause: (a), a deadline model defect; not (b). The 28 bundled builds run one at a time by design (the three cites
  above), so the chain needs 28 serial build steps. Every timeline (hosted and local) shows each build start right after the previous
  verifies: no idle gap, no installation stuck in any state, no failed build. The total therefore equals 28 build steps, and a build
  step's length follows the host: each build guest has its own 2-CPU cap (packages/@ezcorp/extension-runner/src/core.ts:33
  buildLimits.cpuMillis 2000), so above about 2 CPUs host contention, not the CPU count, sets it (10.5 to 12.8 s here, 13.1 to 13.2 s
  hosted). The flat 360 s (scripts/lib/shipping-bootstrap-state.ts:79 at 1bc5f63c7) equals one build lease (300 s build timeout +
  60 s) and has no relation to 28 steps: 229 s, 307 s, 335 s, 294-357 s and 360+ s for the same chain. A total wall clock over a serial
  chain whose length follows host speed: it fails a healthy chain on a slower host. The delivery proof copied its own 480 s for the
  same reason, and the e2e setups held a flat 600 s.
- [x] G3 (R3) fix at the root (commits 2c4a535e4, b8a443fb3; the second waiter 88de7acce, see G5). scripts/lib/bundled-bootstrap-progress.ts is the one named policy, read
  by the proof waiter (shipping-bootstrap-state.ts), the delivery proof (480 s copy removed) and the real-server e2e setups
  (web/e2e/fixtures/bundled-bootstrap.ts, flat 600 s removed). The wait ends on NO PROGRESS: no build changed state for stallMs 120 s,
  counted from the later of the last change and the latest lease of a pending build (a live lease is the lifecycle's promise, so silence
  under it is expected: the delivery proof waits a whole lease out after a restart). The total is a safety net only:
  builds x maxObservedStepMs (38 s, the slowest hosted step, 37.6 s) + buildLeaseMs (360 s, tied by a test to buildLimits.timeoutMs +
  60 s) + stallMs (120 s, so a build stuck under its lease always ends as a named stall first) = 1544 s for 28 builds. The timeout error
  names the reason, the stall clock, the elapsed time, and each unverified build with its state and time since its last transition;
  a finished wait's receipt carries `progress` {elapsedMs, maxStallClockMs, stallMs, safetyNetMs, lastProgressAt}. The concurrency and
  the proof's requirement (all 28 verify) are unchanged. The one-placement rule: the module sits in scripts/lib, which web/e2e may import
  (scripts/check-boundaries.ts: web/e2e is a test path; only shipped code may not import test code and packages may not import src or
  web); check-boundaries 0 violations.
- [x] G4 (R4) unit tests and quality, at b8a443fb3. CHECK: unit-cov.sh (one file per process, lcov), biome, check-boundaries,
  check-factory-boundaries, gate-integrity (integ/w00 and origin/main), guard set, CRAP. RESULT: bundled-bootstrap-progress.test.ts 13/0,
  shipping-bootstrap-state.test.ts 7/0, e2e-bundled-bootstrap-wait.test.ts 6/0 (fake clock and fake client: the hosted shape of 28 builds
  at 13.2 s runs past 360 s and finishes; no change for 120 s ends the wait as a stall naming every stuck build; a live lease holds the
  clock, an expired or non-pending lease does not; the safety net ends a chain that keeps moving; the R2 restart waits a 360 s lease out).
  Line coverage: bundled-bootstrap-progress.ts 71/71, shipping-bootstrap-state.ts 80/80, web/e2e/fixtures/bundled-bootstrap.ts 47/48 (the
  one line is the unchanged closing brace of the poll loop, outside every hunk): 100 percent of new and changed lines. The repo's
  new-file, patch and CRAP gates pass but are VACUOUS for this diff (scripts/lib and web/e2e are outside SOURCE_GLOBS,
  scripts/coverage-config.ts:109), so the numbers above are the proof; CRAP of every touched function by the gate's own scoreFile
  (crap-touched.ts): worst 14.0 (both waiters, cc 14, 100 percent), max 30. biome 0; check-boundaries 0 (6060 files); check-factory-
  boundaries 0; gate-integrity integ/w00 PASSED, origin/main the 8 standing lines only; guard set 502/0 (39 files); hook printed sets 3 and
  2 suites, all green. typecheck GREEN at b8a443fb3 (w4h-11b, 2026-10-07 15:33-15:34Z, lock-free under the tc rule through w00/tc-gate.sh, no heavy holder; tc.sh, typecheck.log): package builds exit 0; `bun run typecheck` exit 0 (backend, web, backend-tests, web-e2e, mypy --strict 21 + 16 files), MemAvailable 17.8 GiB before, lowest 14.2 GiB during; web `bun run check` (svelte-check --tsgo) exit 0, 620 files, 0 errors, 0 warnings, MemAvailable 17.7 GiB before, lowest 15.9 GiB. Disclosure: the host node is 24.21.0, not the 24.14.1 pin (no pinned node in /tmp/factory-tools); tsc runs under the pinned bun 1.4.2. EVIDENCE: cov/, cov2/, commit-1.log, commit-2.log,
  lint-files.log, boundaries.log, factory-boundaries.log, gate-integrity-integ.log, gate-integrity-main.log, guard-suites.log,
  crap-touched.log.
- [x] G5 (R5) green end to end at 88de7acce, ONE hold per head (W4H11_CPUS=3.0, W4H11_MEM=8g, gated-flock start floors disk 135 GB / swap 3.5 GiB /
  mem 8 GiB by the coordinator's ruling, in-lock floors unchanged, W4H11_RESUME=1). CHECK: heavy.sh <rev> r5 resources content cpus=4
  resources content delivery recovery. EXPECT: every leg exit 0, 28 of 28 verified in every bootstrap wait, each receipt's `progress`
  inside its safety net, host_oom 0.

  Hold at b8a443fb3 (r5-b8a443fb3/hold-20261007T194207Z/, lock 19:42:07Z, heavy.exit 1 at 21:20:48Z; r5-progress.py over the receipts):

  | leg | CPUs | exit | verified | elapsedMs | maxStallClockMs | stallMs | safetyNetMs | host_oom |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | setup | 3.0 | 0 (16.4 min) | n/a | n/a | n/a | n/a | n/a | 0 |
  | resources | 3.0 | 0 | 28/28 | 332268 | 1068 | 120000 | 1544000 | 0 |
  | content (legacy-adoption) | 3.0 | 0 | 28/28 | 302768 | 1074 | 120000 | 1544000 | 0 |
  | `podman update --cpus 4` | 4 | NanoCpus 4000000000 | | | | | | |
  | resources | 4 | 0 | 28/28 | 283397 | 1067 | 120000 | 1544000 | 0 |
  | content (legacy-adoption) | 4 | 0 | 28/28 | 290642 | 1072 | 120000 | 1544000 | 0 |
  | delivery (restart wait r2) | 4 | 0 | 28 (26 pending at the restart) | 365995 | 1074 | 120000 | 1544000 | 0 |
  | recovery: runtime | 4 | 0 | | | | | | 0 |
  | recovery: historical-upgrade | 4 | 1 | | | | | | 0 |

  The delivery restart wait ran 366.0 s, past the old flat 360 s, and finished on progress. RED: historical-upgrade, "Build d57c5921-...
  did not finish within six minutes" (scripts/lib/production-lifecycle-client.ts:118 at b8a443fb3, waitVerified, a flat 360 s). The
  candidate app staged its 28 bundled builds at 21:14:12Z (assert-candidate/compose.log), just before the upgraded extension's build;
  the runner builds one at a time, so that build waited behind the chain (283 to 366 s here today). The same model defect as G2 in a
  second waiter the first fix did not reach. The app log in the receipt ends at 21:14:22Z, so the build's queue position is inferred.

  Fix 88de7acce: waitVerified delegates to waitForBuildVerified (shipping-bootstrap-state.ts), which reads the one policy over the
  awaited build plus every bundled build (no progress for stallMs ends it; safety net 1582 s for 29 builds); the error names the
  awaited build, its state and its time since the last transition; the bundled inspection is shared with waitForBundledBootstrap.
  Legs at 88de7acce: shipping-bootstrap-state.test.ts 12/0 (five new), bundled-bootstrap-progress.test.ts 13/0; lines
  shipping-bootstrap-state.ts 116/116 (43 changed, all covered), progress.ts 71/71; the one changed line of
  production-lifecycle-client.ts (the delegation) is exercised by the recovery E2E only; mutation (a flat 360 s added back) turns two
  new tests red; hook printed 2 suites, green; biome 0; check-boundaries 0; check-factory-boundaries 0; gate-integrity integ/w00 PASS,
  origin/main the standing 8; CRAP worst 13.0; typecheck exit 0 and svelte-check 620 files 0 errors under the tc rule
  (typecheck-c3.log).

  Hold 1 at 88de7acce (r5-void-88de-oom/hold-20261007T213048Z/, 4 CPUs, lock 21:30:48Z, heavy.exit 5 VOID at 21:58:06Z):
  setup rc 0 (10.1 min, host_oom 0); guard set rc 0 (39 files at a clean head 88de7acce: 500 pass, 2 skip, 0 fail; guard.log);
  resources rc 1 (21:41:52-21:48:13Z, host_oom 2, load 34): bootstrap 28/28 (elapsedMs 312231, maxStallClockMs 1142), then "Cycle 1
  runner FDs 24 did not return to baseline 23" while the host OOM killer ran (an 11.05 GB tsgo of another session killed 21:47:54Z);
  the diff cannot reach runner FDs (inspect is a repository read, v4/lifecycle.ts:102; GET /api/extensions reads the DB and
  list-flags), and the receipt does not name the extra runner descriptor, so host pressure is the likely cause, not a proven one;
  RULED VOID by the coordinator (2026-10-07), two reasons: (1) host OOM kills during the leg (chromium 21:47:27Z; an 11 GB tsgo of
  another session at 21:47:54Z in session-3.scope; the R4 sample about 20 s later; load 34); (2) the failing check is the R4
  descriptor sample that main fixed in #329 (e3309906d "fix(proof): let transient app connections settle before the R4 resource
  sample", scripts/verify-shipping-runtime-resources.ts), which this branch receives with the W4H-14 main sync. W4H-11's subject,
  the bootstrap wait, was green in this leg (28/28, elapsed 312 s, maxStall 1.1 s). If the resources-only rerun reds again on the FD
  sample with host_oom 0, it is recorded as the #329 flake (outside W4H-11's scope) with its receipt; no third try;
  content rc 143 (SIGTERM) at 21:56:59Z, host_oom 3, MemAvailable 262 MB, load 88: VOID by the harness (exit 5); delivery and recovery
  did not run. Memory holder: a 12.7 GB tsgo in /home/dev/work/obviousRepos/obvious/.worktrees/skip-review-fixes/apps/api.

  Hold 2 at 88de7acce (r5/, coordinator rulings 21:59Z and 22:5xZ: setup, resources, content, delivery, recovery at 4 CPUs; start
  floors disk 135 GB / swap 3.5 GiB / mem 15 GiB; resume on). Try 1 (lock 22:03:38Z; heavy-try1.log, gated-try1.log,
  hold-20261007T220338Z/): setup rc 0 (9.5 min, host_oom 0); resources rc 0 (host_oom 0); content rc 1 (22:20:58-22:57:08Z) in a host
  OOM storm (host_oom 50, MemAvailable and SwapFree at 0, load 100-160; three tsgo processes of another session in
  /home/dev/work/obviousRepos/obvious/.worktrees/skip-review-fixes/apps/api held 7.3, 5.3 and 4.0 GB): file-organizer timed out
  waiting on the app ("apiRequestContext.post: Timeout 30000ms exceeded") and legacy-adoption lost its socket; not counted, rerun by
  the coordinator's word; then a gate release with the state kept (disk >= 115 GB). The owner stopped the waiting re-queue (no lock
  held) because a resume reruns every listed shard, and re-queued the remaining legs only. Try 2 (lock 02:40:05Z, resume, setup
  skipped; heavy-try2.log, hold-20261008T024005Z/): content rc 0, then a gate release (MemAvailable 4 GiB). Try 3 (lock 02:55:42Z,
  resume; hold-20261008T025542Z/): delivery rc 0, recovery rc 0; heavy.exit 0 at 03:20:53Z; container, volume and snapshot removed.

  RESULT at 88de7acce (4 CPUs, every leg host_oom 0; r5-progress.py over each hold's receipts):

  | leg | hold | exit | verified | elapsedMs | maxStallClockMs | stallMs | safetyNetMs |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | setup | 2 try 1 | 0 (9.5 min) | n/a | n/a | n/a | n/a | n/a |
  | guard set (39 files) | 1 | 0 (500 pass, 2 skip, 0 fail) | n/a | n/a | n/a | n/a | n/a |
  | resources (R4 10/10 cycles) | 2 try 1 | 0 | 28/28 | 309745 | 1063 | 120000 | 1544000 |
  | content: file-organizer + legacy-adoption | 2 try 2 | 0 | 28/28 | 288991 | 1084 | 120000 | 1544000 |
  | delivery (restart wait r2) | 2 try 3 | 0 | 28 (27 pending at the restart) | 364588 | 1075 | 120000 | 1544000 |
  | recovery: runtime (initial; r1) | 2 try 3 | 0 | 28/28; 28 (0 pending) | 292416; 1181 | 1067; 1074 | 120000 | 1544000 |
  | recovery: historical-upgrade | 2 try 3 | 0 ("UPGRADE VERIFIED") | | | | | |

  Every bootstrap wait verified all 28 and ended on progress; the two restart waits ran past the old flat 360 s (364.6 s, 366.0 s at
  b8a443fb3) and finished; the stall clock never passed 1.2 s of its 120 s limit. EVIDENCE: r5/heavy.log, r5/heavy.exit (0),
  r5/heavy-try1.log, r5/heavy-try2.log, r5/gated*.log, r5/hold-20261007T220338Z/, r5/hold-20261008T024005Z/,
  r5/hold-20261008T025542Z/ (proof-*-c4.log, *.resources.log, receipts-*-c4/), r5-void-88de-oom/ (hold 1, guard.log).

## Lessons (for tasks/lessons.md at the merge; full text in /tmp/factory-platform-evidence/w4h-11/pending-lesson.md)

- Bind-mounted job files are 0644 in a rootless runner container; a `git archive` snapshot uses `git add -A --force` and asserts its
  tree; heavy.exit is read and reported within ten minutes of the end.
- A ruling that closes a line of inquiry is followed, not re-argued; the inbox is read before every queue action and after every leg
  (r1r, r1s and r1t were queued after rulings that forbade them).
- A heavy harness classifies a signal death during a host OOM as VOID with its own exit code; mapping it to "setup failed" hid the
  cause until the next owner read the kernel log.
- A fix that names "every caller" is proven by a sweep and a call graph before the commit, not by the first green E2E: the second flat
  wait (waitVerified) surfaced only in the recovery leg of R5.
- A resumed hold runs its whole shard list again; after a gate release, re-queue only the legs that have not passed at the head.

## Sweep for fixed deadlines (coordinator ruling 2026-10-07 21:22Z)

`git grep -n -a -E '360_?000|480_?000|600_?000|\* 60 \* 1000|six minutes|ten minutes' -- scripts web/e2e src` at 88de7acce: 323 hits in 168
files (-a: without it git reports src/__tests__/import-staging.test.ts as "Binary file" and hides its line). Full output:
/tmp/factory-platform-evidence/w4h-11/sweep-88de7acce.txt (sha256 d9dd603300fb8230...). Accepted by the coordinator. Result: no hit is a bootstrap-chain wait outside the policy; the two that were
(shipping-bootstrap-state.ts at 1bc5f63c7, production-lifecycle-client.ts:118 at b8a443fb3) are gone. Disclosure: the ruling asked for the
sweep BEFORE the commit; 88de7acce was committed before the ruling was read, and the sweep found nothing that changes it.

- scripts/factory-fleet-init-local.ts (23): factory job record fields (deadlineMs, computeMs, runDeadlineMs) written as data, not a wait
- scripts/factory-graph-proof/graph.ts (141,147): factory job record fields (deadlineMs, computeMs, runDeadlineMs) written as data, not a wait
- scripts/factory-reference-data-coverage.sh (54): bun test per-test timeout of a test runner
- scripts/fetch-factory-sdxl-weights.ts (30): model weight download timeout
- scripts/lib/bundled-bootstrap-progress.test.ts (35,36,56,71,88,100,106,111): fake-clock values in the policy's own tests
- scripts/lib/bundled-bootstrap-progress.ts (32): the policy itself: buildLeaseMs = the runner build timeout + 60 s (tied by a test), a lease, not a total wait
- scripts/lib/shipping-bootstrap-state.test.ts (92,123,135,137,167): fake-clock values in the policy's own tests
- scripts/run-factory-postgres-suite.sh (39): bun test per-test timeout of a test runner
- scripts/seed-marketplace.ts (608): seeded token expiry data
- scripts/verify-factory-archive-writer.ts (222): factory job record fields (deadlineMs, computeMs, runDeadlineMs) written as data, not a wait
- scripts/verify-factory-image-publication.ts (179): factory job record fields (deadlineMs, computeMs, runDeadlineMs) written as data, not a wait
- scripts/verify-factory-reference-code-journey.ts (171): factory job record fields (deadlineMs, computeMs, runDeadlineMs) written as data, not a wait
- scripts/verify-factory-reference-code-provider.test.ts (46): OAuth token expiry fixture data
- scripts/verify-factory-release-github.ts (150): factory job record fields (deadlineMs, computeMs, runDeadlineMs) written as data, not a wait
- scripts/verify-factory-s3-publication.ts (98): factory job record fields (deadlineMs, computeMs, runDeadlineMs) written as data, not a wait
- src/__tests__/always-allow-value-shape.test.ts (356): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/audit-global.test.ts (283,304,320,332,354,364,369,376,386): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/audit-log.test.ts (280): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/audit-merge.test.ts (361): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/await-run-completion.test.ts (136,152): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/background-timers.test.ts (627,703,1757,1837): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/briefing-daemon.test.ts (389): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/builtin-tool-call-timeout.test.ts (11,354,358,370,381,401): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/builtin-tool-watchdog-no-regression.integration.test.ts (16,21,23,292,294,300,341,342,350,395,397,400,407): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/caller-tool-declarations.test.ts (150): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/credentials.test.ts (28,76): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/executor-watchdog-inflight-tools.test.ts (436,437,438,801,1020): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/executor-watchdog-suspend-reason.test.ts (156,157,170,189): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/expired-grants.test.ts (41): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/extension-build-clock.test.ts (41,42): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/extension-trusted-local-approvals.test.ts (76,97): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/ez-drafts-queries.test.ts (55,56): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/factory-boot.test.ts (298,303,309,314,324): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/factory-legacy-orphan-sweep.test.ts (67,72,130): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/file-organizer-daemon.test.ts (80,622): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/fixtures/session-golden-baseline.json (159,872): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/format.test.ts (26): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/goal-host-unit.test.ts (1630): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/factory-archive-writer-suite.ts (85,154): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/factory-artifact-materials-suite.ts (66): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/factory-attempt-fixtures.ts (28): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/factory-attempt-launch-fixture.ts (36): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/factory-child-artifacts-suite.ts (48,79,94,98,119,122): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/factory-guest-material-broker-suite.ts (99,103): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/factory-guest-model-route-suite.ts (136): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/factory-installation-bootstrap-suite.ts (206): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/factory-legacy-workflow-suite.ts (114): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/factory-material-gateway-suite.ts (62): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/factory-private-root.ts (86): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/factory-reference-data-suite.ts (192,209): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/factory-run-lifecycle-suite.ts (109,739,797,1167): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/factory-s3-publication-suite.ts (261,517): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/factory-service-credentials-suite.ts (28): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/make-test-extension.ts (28): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/helpers/pglite-snapshot-cache.ts (121,160): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/host-maintenance-daemon.test.ts (103): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/import-staging.test.ts (624): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/invites.test.ts (91,118,131): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/memory-decay-sweep.test.ts (71,84,107,126,140,162,172,189): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/memory-lifecycle.test.ts (11,16,21,26,31,36): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/model-router.test.ts (356): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/native-workspace-tools.test.ts (58): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/oauth-api.test.ts (428): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/password-reset.test.ts (41,62,76,116): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/perm-expiry-config.test.ts (26): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/perm-expiry-sweep.integration.test.ts (85): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/perm-expiry-sweep.test.ts (21,837): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/pglite-snapshot-cache.test.ts (444): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/phase4-verification.test.ts (100,103): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/provider-status-api.test.ts (85,134): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/relative-time.test.ts (27,45,89,90,91,92,95,96): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/routing-analytics.test.ts (36,38): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/routing-export-script.test.ts (38,40): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/routing-spend-truncation.test.ts (98): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/routing-sweep-script.test.ts (54): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/run-workflow-tool.test.ts (547,548): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/runtime-tools-grep-args.test.ts (26,27): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/runtime-tools-validate.test.ts (68,69,70): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/sdk-capability-calls-queries.test.ts (383,395,407,413,414): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/security/file-organizer-security.test.ts (177): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/security/l2-touchsession-throttle-param.test.ts (86,102,126,145,163): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/security/m2-oauth-state-server-side.test.ts (348): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/spawn-assignment-hourly-quota.integration.test.ts (304): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/spawn-quota.test.ts (123,139): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/tool-permission-handler.test.ts (105): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/update-check.test.ts (186,203): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/v1.3-permission-backbone-integration.test.ts (82): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/watchdog-reasoning-idle-window.integration.test.ts (269): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/__tests__/workflow-run-persistence.test.ts (2330): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/auth/oauth-callback-worker.ts (80): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/db/backup.ts (32): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/db/queries/expired-grants.ts (56): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/db/queries/extension-browser-requests.ts (17): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/db/queries/extension-event-receipts.ts (7): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/db/queries/extension-trusted-local-approvals.ts (21,52): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/db/queries/ez-drafts.ts (32): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/db/queries/memories.ts (576,577): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/db/queries/preview-sessions.ts (28): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/extensions/__tests__/drafts-handler.test.ts (289): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/extensions/__tests__/workflows-delegated-ladder.test.ts (1369,1539): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/extensions/bundled-ceiling.ts (382): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/extensions/bundled.ts (543): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/extensions/drafts-handler.ts (257): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/extensions/file-organizer-daemon.ts (579): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/extensions/file-organizer-state.ts (662): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/extensions/host-maintenance-daemon.ts (101,160): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/extensions/llm-quota.ts (82): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/extensions/perm-expiry-config.ts (49): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/extensions/project-pull-request-broker.ts (108): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/extensions/spawn-quota.ts (80): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/extensions/subprocess.ts (15): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/extensions/workflows-handler.ts (171): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/factory/background-workers.ts (185): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/factory/console.test.ts (20,21,22): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/factory/gateway-process.ts (100): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/factory/private-service-composition.test.ts (79): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/factory/provisioning/compose-profile.test.ts (295): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/factory/provisioning/compose-profile.ts (195): factory compose stack readiness timeout (option, default 600 s); no extension build or bootstrap
- src/factory/provisioning/deployment.test.ts (502,533,548): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/factory/provisioning/purge-approval.ts (33): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/factory/reference-code/checks.integration.test.ts (68,79,93,102,114): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/factory/reference-code/checks.ts (47): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/factory/release-s3-publication.test.ts (92): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/factory/releases.ts (28): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/factory/runner/attempt-dispatch-driver.test.ts (35): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/factory/runner/attempt-recovery.test.ts (56): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/factory/runner/guest-broker-transport.integration.test.ts (137): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/factory/runner/guest-model.podman.integration.test.ts (41): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/factory/runtime-composition.test.ts (739): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/factory/startup-config.test.ts (299,362): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/factory/startup-values.ts (24): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/integrations/github-user/__tests__/transport.test.ts (24): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/memory/lifecycle.ts (6,7,8): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/providers/factory-broker.test.ts (239): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/providers/kilo.ts (356): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/providers/model-discovery.ts (104): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/runtime/briefing/completion-intents.ts (8): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/runtime/caller-tool-declarations.ts (63): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/runtime/sandbox/controller/controller.ts (211): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/runtime/tools/filter.ts (162): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/runtime/tools/grep.ts (32,40): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/runtime/tools/run-workflow.ts (57): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/runtime/tools/shell.ts (155,160,165): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/runtime/tools/validate.ts (44): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/search/index.ts (36,37): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/startup/background-timers.ts (188,191,211,240,257,578): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/suggest/__tests__/user-tool-priors.test.ts (20): unit-test value (fake clock, TTL, cap or fixture data); no live server
- src/suggest/user-tool-priors.ts (30): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/ui/format.ts (20,21,22): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- src/update-check.ts (7): product constant (retention, TTL, interval, quota, timeout cap or format); not a wait on a build or the bootstrap
- web/e2e/conversation-list.spec.ts (142,150,151,159,160): timestamp or expiry data in a mocked spec; no wait
- web/e2e/factory-services-console.spec.ts (114,541,635): factory-services stack prepare poll (its own global setup) and timestamp data; no extension build or bootstrap
- web/e2e/factory-services/guest.ts (28): factory-services stack hold, evidence age and allocation data; no extension build or bootstrap
- web/e2e/factory-services/stack.ts (68,240,332): factory-services stack hold, evidence age and allocation data; no extension build or bootstrap
- web/e2e/fixtures/api-mocks.ts (538): mocked draft expiry data
- web/e2e/fixtures/extension-v4.ts (47): RUNNER_WAIT_BUDGET_MS 480 s: every spec that uses it runs after a global setup that waits the bundled bootstrap out on the policy (real-auth-setup.ts:111, docker-auth-setup.ts:35; trusted-local spreads the real config), so its builds start after the chain; its build clock counts only runner-held time and the Playwright test timeout caps it
- web/e2e/kokoro-tts-realmodel.spec.ts (77): real TTS model audio wait; no extension build
- web/e2e/personal-github-settings.spec.ts (7): timestamp or expiry data in a mocked spec; no wait
- web/e2e/provider-settings.spec.ts (427): timestamp or expiry data in a mocked spec; no wait
- web/e2e/real-auth/extension-browser-scanner.spec.ts (12): test.setTimeout per spec: the specs run after real-auth-setup.ts waits the bundled bootstrap out on the policy; a test bound, not a chain wait
- web/e2e/real-auth/extension-lifecycle-flow.spec.ts (411,668,787): test.setTimeout per spec: the specs run after real-auth-setup.ts waits the bundled bootstrap out on the policy; a test bound, not a chain wait
- web/e2e/real-auth/extension-release-gate.spec.ts (35): test.setTimeout per spec: the specs run after real-auth-setup.ts waits the bundled bootstrap out on the policy; a test bound, not a chain wait
- web/e2e/real-auth/extension-source-import.spec.ts (45,235,264): test.setTimeout per spec: the specs run after real-auth-setup.ts waits the bundled bootstrap out on the policy; a test bound, not a chain wait
- web/e2e/real-auth/ez-factory-job-run.spec.ts (82): test.setTimeout per spec: the specs run after real-auth-setup.ts waits the bundled bootstrap out on the policy; a test bound, not a chain wait
- web/e2e/real-auth/permission-backbone.spec.ts (13): test.setTimeout per spec: the specs run after real-auth-setup.ts waits the bundled bootstrap out on the policy; a test bound, not a chain wait
- web/e2e/settings-audit.spec.ts (15): timestamp or expiry data in a mocked spec; no wait
- web/e2e/v1.3-permission-backbone.spec.ts (16): timestamp or expiry data in a mocked spec; no wait
- web/e2e/workflows-run-output.spec.ts (35,289): timestamp or expiry data in a mocked spec; no wait

## Call-graph check: may the b8a443fb3 receipts stand at 88de7acce? (coordinator ruling 2026-10-07 21:22Z) NO

Head pair b8a443fb3 -> 88de7acce changes scripts/lib/production-lifecycle-client.ts (waitVerified) and scripts/lib/shipping-bootstrap-state.ts
(waitForBuildVerified added; waitForBundledBootstrap now reads the extracted inspectBundledInstallations). `git grep -nE
'waitVerified|createBuild|waitForBundledBootstrap|waitForProductionBootstrap|shipping-bootstrap-state' 88de7acce -- 'scripts/*.ts' 'scripts/*.sh'`:
- resources shard (verify-shipping-runtime-resources.ts): waitForProductionBootstrap (:234) -> verify-shipping-bootstrap.ts:8
  waitForBundledBootstrap; createBuild (:250) -> waitVerified; production.waitVerified (:320). Executes changed lines.
- content shard, legacy-adoption (verify-legacy-adoption.ts): waitForBundledBootstrap (:88), waitVerified (:107). Executes changed lines.
- delivery (verify-shipping-delivery.ts:72 createBuild, :122 waitForBundledBootstrap) and recovery (verify-shipping-runtime.ts:178;
  verify-docker-upgrade-state.ts:58, :107) also execute them; both rerun at the head by the ruling.
Result: the four receipts at b8a443fb3 (resources and content at 3.0 and 4) do NOT stand as head evidence; they stay as the record of the
first R5 hold. The rerun at 88de7acce covers them. Coordinator ruling: ONE hold at 88de7acce at 4 CPUs only (setup, guard set,
resources, content, delivery, recovery). The 3.0-CPU legs are dropped: the eight base runs and the b8a443fb3 R5 showed that the outer
quota does not change the build rate above each build guest's own 2-CPU cap (10.5 to 12.8 s a build at 4.0, 3.6, 3.0 and 1.8 CPUs), so a
3.0 run adds no information.

## Leftover candidates (not changed here)

- Install race: root `bun install --frozen-lockfile` WITH lifecycle scripts (.github/actions/setup/action.yml "Install root deps") ran
  @ezcorp/sdk's `prepare` (`bun run build` = `tsc -b tsconfig.build.json`) before @ezcorp/extension-contract's dependency re2js was
  linked: "Cannot find module 're2js'" on 32 visible CPUs (r1-void2/setup.log); not seen under `taskset -c 0-3`.
- The pinned conmon 2.2.1 has no journald; on a rootless Podman 4.x host whose default log driver is journald, any container without an
  explicit log driver fails "conmon failed: exit status 1" (diag1/hold-*/diag.log).
- legacy-adoption under Podman: `$ENGINE build --load` (scripts/verify-legacy-adoption.sh:89, scripts/lib/build-archived-image.sh
  ensure_archived_image) cannot run under Podman 4.9 (no --load); the existing leftover "the legacy-adoption proof calls docker directly".
- The coverage, patch and CRAP gates do not measure scripts/lib or web/e2e (SOURCE_GLOBS, inScope): a change there passes them vacuously.
- scripts/verify-extension-container.ts:40 waits for one build with a flat 240 s; no workflow or script calls it today.

## External events recorded

- Shared /home/dev/work/EZCorp/EZHarness/.git/config: core.bare false to true at 2026-10-06 12:38:50Z (sha 888c78b9e94ea660 to
  546e460d3bfa387b; coordinator note: not this package); at 20:02:49Z (mtime) it also held user.name/user.email = the archy noreply
  identity (sha 65fd34d98d707d5f). Not written by this package (audit: every git write of this harness is in /tmp/w4h-11-home-snap-*;
  no GIT_DIR in its environment). This package's commits wrote only its worktree (config.worktree: core.bare false, archy identity).

## Proposed text to close W4H-1 G4 (for the coordinator; w4h-1-GATES.md is not edited here)

"G4 runtime-resources: CLOSED by W4H-11 (commits 2c4a535e4, b8a443fb3, 88de7acce). The three 'starved' runs were the bundled bootstrap's flat 360 s
deadline over a serial 28-build chain whose length follows host speed, not a product defect. The wait now ends on no progress (stall
120 s after the last change or the latest pending lease; safety net 1544 s for 28 builds), and runtime-resources passed 28/28 in the
runner-shaped container at 4 CPUs at 88de7acce (tasks/factory/w4h-11-GATES.md G5)."
