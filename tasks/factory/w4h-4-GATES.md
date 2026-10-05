# Gates: W4H-4, lane-bound tests run only in the lane whose runner has their precondition

Brief: `/tmp/factory-platform-evidence/w00/briefs/w4h.md` (W4H-4, widened by the 17:45Z amendment R3/R4). Base integ/w00
`52d8ba079`, branch `wp/w4h-4`. Evidence: `/tmp/factory-platform-evidence/w4h-4/` (paths below are relative to it).
Pinned Bun 1.4.2.

Cause: `scripts/lib/test-file-sets.sh` sweeps every `src` and extension-runner test into the hosted sets P and C, so
the 12 coverage shards selected `podman-devices.integration` (needs `/dev/kfd` and two render nodes; CI shard 3:
"stat /dev/kfd: no such file or directory") and `reference-data/journey.integration` (needs the pinned data image that
no registry holds; CI shard 1: "image not known"). The gpu lane listed its own files inline in ci.yml; the C11 lane
manifest repeated three of them as strings.

Fix: `FACTORY_LANES` in `scripts/check-factory-lanes.ts` (the existing C11 lane manifest) is the ONE list. Each lane
names `tests` (the hosted shards run them too) and `boundTests` (only that lane's runner has the precondition). Both
lane jobs run `bash scripts/run-factory-lane-tests.sh <job>`, which reads `--lane-tests <job>`. The hosted sets read
`--bound-tests` through `lane_bound_test_files` and subtract it from P and C.

Runner-shaped container: `image/Containerfile` (`localhost/w4h4-runner:24.04`): Ubuntu 24.04, CI's Node 24.14.1,
Ubuntu's podman, uid 1001 `runner`, 0755 home, a clean `git archive` checkout at the hosted path, the pinned Bun mounted
read-only, 4 CPU, 14 GB, no device. Stated exception for the nested test run only: `--cap-add=SETUID,SETGID,SYS_ADMIN`
and `label=disable`, so the inner rootless podman can make its user namespace and cgroup v2 controllers as the hosted
VM's podman can. No `--device`, no `--privileged`; `/dev/kfd` and `/dev/dri` are absent inside.

Commits on `wp/w4h-4` (hook-printed suites; all green):
- `8ee0a5c72` manifest and both selections (4: check-factory-lanes, ci-test-set-drift, combined-runner-legs, factory-ci-registration)
- `170c7dd18` takes the journey binding out of the device work (coordinator split ruling) (1: check-factory-lanes)
- `e613a833f` journey bound to factory-deployment-operations with the image-pin precondition (1: check-factory-lanes, 41/0).
  Final per the coordinator ruling (hosted podman 4.9.3 cannot reproduce the data-image pin).
- `c5e527b1d` the device test's named precondition case, committed under the heavy lock and the local GPU lock
  (1: podman-devices.integration, 7/0)
- the commit that adds this gates file (0)

- [x] G1: the hosted selection selects the two files at base and selects neither at the head.
  CHECK: `bash repro-selection.sh <rev> <out>` EXPECT: at 52d8ba079 shard 3/12 selects the device test and shard 1/12
  the journey, both in P and C; at the head no shard, P, C or residual set selects either, and the lane view lists
  them. EVIDENCE: `red-selection-52d8ba079/selection.log` (red), `green-selection-8ee0a5c72/selection.log` (green:
  P 2043 to 2041, C 1999 to 1997, residual 15 unchanged).
- [x] G2: red of record. The hosted CI log (run 37138524741, shard 3): "RunnerError: Error: stat /dev/kfd: no such file
  or directory" on two cases. Journey red reproduced in the runner-shaped container exactly as CI: "image not known"
  (`logs/red-test-attempt1.log`). Container limit for the device test (see below).
- [x] G3: one manifest, unit tests on the manifest and both selections, red at base.
  CHECK: `bun test ./scripts/check-factory-lanes.test.ts` EXPECT: 41/0 at the head; 9 fail with the base selection code
  and workflow. EVIDENCE: `logs/red-unit-base-selection.log`, `unit-c5e527b1d/scripts_check-factory-lanes.test.ts.log`
- [x] G4: the device test fails by name on a host without the device, every assertion kept, no skip. The device
  behaviour is exactly as at 52d8ba079; the commit adds a named precondition case and a precondition check before the
  two cases that hand host devices to a guest. Proof: code review of `c5e527b1d` plus the green host run (7/0,
  `logs/commit4.log`). The runner-shaped container could not reach the device step (container limit below).
- [x] G5: the lanes run their files on this host (it has /dev/kfd and the data image), at `c5e527b1d`.
  `logs/lane-factory-isolation.log`: `bash scripts/run-factory-lane-tests.sh factory-isolation`, 30/0 over 5 files.
  `logs/lane-factory-deployment-operations.log`: 11/0 (journey, after the image-pin precondition passed).
- [x] G6: repository legs at `c5e527b1d`: typecheck, lint, lane gate, boundaries green; gate-integrity shows only the 8
  base findings that need the label (`logs/gate-integrity-head.txt`); guard set green (`logs/guard-head.log`);
  new-file and patch coverage gates green with BASE_REF=52d8ba079 (`logs/coverage-gates.log`;
  check-factory-lanes.ts 301/301 lines); actionlint clean (`logs/actionlint-head-labels.log`). The removal of the
  device test from the hosted shards drops no runner line: every device-related line in podman.ts is a single line
  that the remaining hosted tests also run.

## Container limit for the device test (nested rootless podman in a rootless container)
The device test's beforeAll starts real guests, so the container needs a working nested runtime. Three variants, no
device, never `--privileged`, each red in beforeAll before any device step:
- `localhost/w4h4-runner:24.04` (inner id map 0-64534): "OCI runtime error: crun: setgroups: Invalid argument" (the
  guest's uid 65534 is unmapped). `logs/red-container.log`, `logs/container-green.log`.
- `localhost/w4h4-runner:24.04-idmap` (`image2/Containerfile`, inner map 0-65535): "OCI runtime error: crun: open
  `/proc/sys/net/ipv4/ping_group_range`: Read-only file system". `logs/red-container-idmap.log`,
  `logs/green-container-idmap.log`.
- the same image with `--security-opt unmask=/proc/sys` on the outer container: "crun: mount `proc` to `proc`: Operation not permitted: OCI permission denied" (container
  exit 1). `logs/red-container-unmask.log`, `logs/green-container-unmask.log`. Per the coordinator ruling this was the
  last try; the hosted log is the red of record for the device test.
Note: `repro-test.sh` first exited with the container's last echo (rc 0 beside a failed test); fixed so the container
exits with the highest test exit. Both images were removed by name after the last try; a rebuild needs the W4G-5 and
W4G-7 base recipes first (their image is gone from the host).

## Decision: two shard-container failures from W4H-6's list 7 stay in the hosted shards (not bound)

The lead asked (2026-10-04) whether `src/__tests__/biome-ignores-worktrees.test.ts` (exit 127 in W4H-6's shard
container) and `src/factory/runner/applied-controls.integration.test.ts` (pinned python image absent there) belong in
the lane manifest. Decision: no binding. A bound test is one whose precondition ONLY a self-hosted lane's runner has;
the hosted shard runner provides both preconditions, so binding would remove them from the hosted shards (and from
hosted coverage) for no reason.
- biome-ignores-worktrees runs `node_modules/.bin/biome`, a `#!/usr/bin/env node` script; exit 127 is "node not found".
  ubuntu-latest ships node, and the hosted run 37138524741 did not fail this file (absent from
  `w00/wave4h/push/new-failing-files.txt` and from `all-failed.log`). The gap is the shard container's shape: it must
  carry the runner's node (CI's Node 24.14.1, checksum-verified, as the W4G-7 recipe w4g-7/image/Containerfile installs).
- applied-controls failed on hosted only because the python base digest was not pulled (classifier R3). W4H-3 (merged
  at 5f7722ae1) added `./.github/actions/factory-python-base` to the cov-shard job, which pulls that digest from the one
  pin. A shard container that models the job must run that action's pull first.
Neither change is inside this package (no manifest entry, no precondition). Coordinator ruling 2026-10-04: the shard
container's shape fix (node, then the factory-python-base pull) is a leftover item for the wave4i docs commit.
