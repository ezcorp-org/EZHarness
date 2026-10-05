# Gates: W4H-7, "concurrent task_add loses an update" (R8)

Brief: w00/briefs/w4h.md section W4H-7. Hosted CI run 37138524741 at 52d8ba079 failed in two lanes:
- Coverage shard 11: src/__tests__/task-state-isolated.integration.test.ts, "expect(revisions).toHaveLength(3)", received 2, after 38 s.
- E2E (real auth + real DB): web/e2e/real-auth/task-panel-durability.spec.ts:107, "Test timeout of 60000ms exceeded".

Red base: 52d8ba079. Branch `wp/w4h-7b` from integ/w00 `6ac2458c7` (W4H-6 merged at 87e1e197c; W4H-9's runner-service change on top). Evidence: `/tmp/factory-platform-evidence/w4h-7/`
(below: `E/`). Pinned Bun 1.4.2. Every leg after 2026-10-04 01:44Z ran through w00/gated-flock.sh. A red gate or a 1-min load of 10 or
more inside the lock exits 75. Counts are executed runs only.

## Corrected cause (coordinator ruling 2026-10-03 23:21Z: the brief's read-modify-write guess is withdrawn)

The task-state write path is serialised. There is no lost update:
- task_add saves at docs/extensions/examples/task-tracking/index.ts:748, inside `withLock` (index.ts:1343-1346).
- In a v4 worker, `withLock` takes a host-held row lock (packages/@ezcorp/sdk/src/runtime/lock.ts:46-68; src/extensions/runtime-locks.ts:57-81).
- The host write locks the conversation row (`FOR UPDATE`) and checks the expected revision in the same transaction
  (src/runtime/task-tracking-host.ts:154-163).

The failure is a stall of the worker channels. W4H-6 found and fixed it, and the fix is merged in integ/w00 at 87e1e197c
(packages/@ezcorp/extension-runner/src/podman.ts, `channelReader` at :149, used at :446). The runner read each worker's `out` and `err`
FIFOs on Bun's file-system thread pool, which has one thread per CPU. Two live workers on a 4-CPU host fill the pool, so nothing else in
the process that needs the pool moves until a worker's deadline closes it.

The trace (`E/host-trace-1/iter-3.log`; test-helper and host trace lines only, diff in `E/trace-instrumentation.diff`, never committed):
- 10.601 worker B takes the host lock; 10.612 B reads; 10.622 B sends emit-task-event (its revision is recorded, its write commits).
- 10.820 worker A asks for the lock and is refused (`retryAfterMs: 50`). A's retry frame never reaches the host.
- 39.182 the 30 s invocation deadline closes both workers ("Worker closed"); 39.188, 6 ms later, B's emit answer arrives.
- Result: revisions 2, titles [Initial task, Choice B], the CI signature. A passing run (`E/host-trace-1/iter-2.log`) had no overlap.

W4H-7 therefore makes no product change and adds no test (coordinator ruling: W4H-6's channel-pool test, "two live workers still exchange
frames and report their exits when the file-system pool has two threads", already pins this lane's shape). The UNCHANGED isolated suite
run with `UV_THREADPOOL_SIZE=2` is the lane's regression pair (G3).

Fix tree for the pair legs: `proof/w4h-7-fix` = 40875d887, which is 52d8ba079 plus `E/w4h6-runner-src.diff` (W4H-6's
extension-runner src, 52d8ba079..56c9579d7, sha256 f0e6db66f3cbde1a), made with commit-tree. 56c9579d7 is an ancestor of
integ/w00, so the merged code subsumes it. The ref stays only to keep the receipts' commit reachable.

## Gates

- [x] G1 (unit lane, red/green, 4 CPUs, --coverage, the unchanged isolated suite):
  - Runner-shaped container: Ubuntu 24.04, podman 4.9.3, conmon 2.2.1, `--cpus=4`, 16 GiB, uid 1001, clean `git archive` snapshot
    (`E/snap-52d8ba079.sha256`; removed after the legs).
    RED at 52d8ba079: first failure at run 1, "Expected length: 3 / Received length: 2" (`E/ctr-red-52d8-v3/`, run-1.log sha256 05d5b8fc2b08fe55).
    GREEN with the runner diff: 20 of 20 (`E/ctr-green-fix-v3/`, summary sha256 e8b6c29fa29d1fbc).
  - Host, taskset 0-3. RED at 52d8ba079: red at run 1 (`E/host-probe-1/`, probe) and at run 3 (`E/host-trace-1/`).
    GREEN at 40875d887: 20 of 20 (`E/host-green-fix-v3/`, summary sha256 7792b4187b304bcd). Probe 10 of 10 (`E/host-green-fix-probe-v2/`).
    GREEN at 87e1e197c (merged): see G4.
  CHECK: `bash E/container-loop.sh` and `bash E/host-loop.sh` via w00/gated-flock.sh. EXPECT: red within 20 runs at 52d8ba079; 20 of 20 green with the fix.
- [x] G2 (E2E real-auth lane): task-panel-durability.spec.ts, taskset 0-3, its own fixtures (no external credential), port 4917.
  RED at 52d8ba079: :107 "Test timeout of 60000ms exceeded"; :75 passed; :138 did not run (`E/e2e-red-base/run-1.log`, sha256 f1911c4b07974b44).
  GREEN at 40875d887: 2 of 2 runs, 3 passed each (`E/e2e-green-fix-v2/`, sha256 dd5c0def82a6af08, 94b8c31328329744).
  GREEN at 87e1e197c (merged): see G4.
  CHECK: `bash E/e2e-leg.sh` via w00/gated-flock.sh. EXPECT: 3 passed.
- [x] G3 (regression pair, no new test): the unchanged isolated suite with UV_THREADPOOL_SIZE=2.
  RED at 52d8ba079: red at run 1 (`E/pool2-red-base/`). GREEN at 40875d887: 10 of 10 (`E/pool2-green-fix-v2/`).
- [x] G4 (W4H-6 merged, integ/w00 87e1e197c): E2E 2 of 2 runs, 3 passed each (`E/e2e-merged-87e1/`, sha256 d83ae4a8e7cde6a9,
  0857f496f9b2cc32); the unchanged isolated suite 10 of 10 (`E/host-merged-87e1/`, summary sha256 43215a1861c928c2).
- [ ] G4b (this branch's head on 6ac2458c7): 87e1e197c..6ac2458c7 changes packages/@ezcorp/extension-runner/src/service.ts (W4H-9), which
  the real-auth stack uses, so the E2E spec runs again at the head (`E/e2e-head/`). The isolated suite uses PodmanRunner in-process, not
  service.ts; its runner, SDK and task-state files are unchanged since 87e1e197c.
- [ ] G5 (scope): this branch changes only this file, tasks/todo.md and tasks/lessons.md. Hook count per commit is in the report.
