# W4H-6: three hosted timing failures, root cause each

Order: coordinator brief w00/briefs/w4h.md, section W4H-6 (owner w4h-6). Base integ/w00 at 52d8ba079. Red source: hosted CI run
37138524741 (Coverage shards 0, 2 and 7). Evidence: /tmp/factory-platform-evidence/w4h-6/.

## The runner-shaped container

- Image `localhost/w4h-6-runner:24.04` (image/Containerfile): Ubuntu 24.04 with systemd as PID 1, so the repository's own
  `scripts/setup-extension-runner-ci.sh --install` runs unchanged: Ubuntu's podman 4.9.3, crun, conmon 2.2.1 by checksum, the
  user@1001 delegation of cpu, memory and pids, and the image pulls. Non-root `runner` (uid 1001, 0755 home, NOPASSWD sudo as
  on the hosted runner). Bun is the pinned release (/tmp/factory-tools/bun-1.4.2), the one setup-bun installs from .bun-version.
- 4 CPUs (`--cpus=4`, and `taskset -c 0-3` so `nproc` and Bun see 4) and 16 GiB, as the hosted runner.
- A clean `git archive` of the head under test, made a one-commit repository that tracks every archived file.
- The job's own steps in order (job-setup.sh, job-shard.sh): the setup action's installs and svelte-kit sync, the runner setup
  script, the gate-integrity parser, then `bash scripts/test-coverage.sh` with SHARD_INDEX, SHARD_TOTAL=12 and COV_OUT.
- Nesting exceptions, stated here as the brief requires: the outer container runs `--privileged` (rootless; systemd and nested
  rootless podman need a writable cgroup and /dev/fuse inside the outer user namespace). The outer namespace holds ids 0..65536
  only, so `runner`'s subordinate ids are 2..1000 and 1002..65536 (65,534 ids, still mapping the guest uid 65534) instead of the
  hosted 100000+65536. Nothing is mounted from the host's Nix store.
- The hosted shard does not run its file list in one process: host-shard mode runs one Bun process per file, four at a time
  (pool width min(nproc, 6)), then re-runs each failed file alone. The reproductions use that same script and file list, plus
  each file alone.

## Causes

1. reference-code/workspace "kills a command that outruns its budget": product defect. ReferenceCodeProcessRunner sent SIGKILL
   to the direct child only and settles on `close`. Ubuntu's `sh` is dash, which keeps `sleep 30` as a child; the orphan held
   the pipes for 30 s. Fix: the command leads its own process group and the budget kills the group (a group that already ended
   is not an error).
2. The "Worker closed" pair (supervisor.podman.integration, auto-note "concurrent captures"): product defect in
   packages/@ezcorp/extension-runner/src/podman.ts. channelTransport read each guest's `out` and `err` FIFOs with
   FileHandle.createReadStream: a blocking read on Bun's file-system thread pool (one thread per CPU), held for the worker's
   whole life. At CPUs/2 live workers (two on 4 vCPUs) no file operation in the process could run, the next request frame's
   FIFO write included, until a worker deadline closed it. Fix: Bun's own file stream, which polls the FIFO.
3. supervisor.podman.integration also had a test defect: it hashed the raw `attempt-live:0` for the worker id while the
   supervisor hashes its canonical JSON, so the ids never matched on any host and the test never attached. It started a second
   worker, which met cause 2 on the runner. Fix: the supervisor exports its derivation, the test uses it, and its client
   refuses `start`.

## Gates

Code head 8a4cf8b04 (tree a3a644888); the container head snapshot carries that exact tree (`git rev-parse HEAD^{tree}` inside it).
The base snapshot carries the exact 52d8ba079 tree (47f9186cf). Shard legs at the head use the hosted shard lists, computed at
52d8ba079 (base-shard-{0,2,7}.txt: 165, 167, 167 files, as the hosted job), through the script's file-list override, which needs CI
unset; no target file and no runner code reads CI.

- [x] G1 workspace.test.ts (cause 1). CHECK: the new test "kills every process the command started when the budget runs out" at
  52d8ba079 and at the head; the file alone and the hosted shard 7 list in the container. EXPECT: red at base, green at head.
  RESULT: host red pin at base (the grandchild printed after the budget), green 15/15 at the head on host and in the container;
  container base alone 12/1 (30000 ms timeout), head alone 15/0; shard 7 base 2217/4 (workspace red), head 2220/3 (workspace green).
  EVIDENCE: red-pin-workspace-host-52d8ba079.log, red-workspace-alone-52d8ba079.log, green-workspace-host.log,
  out-green-head2/file_src_factory_reference-code_workspace.test.ts.log, out-red3-52d8ba079/shard_7.log,
  out-green-head-lists/list_7.log. Commit 1b4954ce2.
- [x] G2 e2e-server-pipeline.test.ts (cause 2). CHECK: tests/channel-pool.test.ts at 52d8ba079 and at the head (pool pinned to two
  threads); the file alone and the hosted shard 2 list in the container. EXPECT: red at base, green at head. RESULT: channel test red
  by name at base on host and in the base container ("still blocked after 20 s"), green at head (host 5/5 runs, container 2/0; its
  child 20/20 on host and in the container); auto-note alone base 6/1 twice (concurrent captures, Worker closed), head 7/0; shard 2
  base 2299/1, head 2300/0. EVIDENCE: red-pin-channel-pool-host-52d8ba079.log, red-pin-channel-pool-container-52d8ba079.log,
  green-container-channel-pool.log, loop-channel-child-*.log, out-red2-52d8ba079/ (plain and traced), out-red3-52d8ba079/shard_2.log,
  out-green-head2/, out-green-head-lists/list_2.log. Commits e090a379f, 1be3d0ac5, 0d71cf09f.
- [x] G3 supervisor.podman.integration.test.ts (causes 2 and 3). CHECK: the base test with only the start guard added, in the base
  container; the fixed file alone and the hosted shard 0 list at the head. EXPECT: red pin by name at base; green at head. RESULT:
  red pin "the fresh supervisor started a second worker instead of attaching" (9.4 s); base alone 1/1 three times (Worker closed,
  73.8 s); head alone 2/0 in the container and 2/0 in the commit hook on the host; shard 0 base 2522/2, head 2524/0. EVIDENCE:
  out-redpin-52d8ba079/, out-red-52d8ba079/, out-red2-52d8ba079/ (trace), out-green-head2/, out-green-head-lists/list_0.log,
  commit-3.log. Commit 8a4cf8b04.
- [x] G4 quality at 8a4cf8b04. RESULT: typecheck 0; lint 0; boundaries 0; gate-integrity with BASE_REF=integ/w00 0 (against
  origin/main only the eight standing label findings); guard set 468 pass, 0 fail, 36 files; new-file and patch coverage gates
  passed (3 files, every changed executable line). EVIDENCE: typecheck.log, lint.log, boundaries.log, gate-integrity-integ.log,
  guard-suites.log, cov/.

## Not caused here, seen in the container legs

- applied-controls.integration (shard 7): the pinned python image is absent; W4H-3 owns it. Red at base and at head alike.
- biome-ignores-worktrees (shard 7) and guest-broker-transport (another slice): "node" is absent from this container. The hosted
  image ships Node, so this is a gap in the container's shape, the same at base and at head. Disclosed, not fixed mid-run.
- The memory-cgroup kills in some legs are guests at their own --memory limit inside the shard's limit tests (uid 231071 = guest
  65534), not host OOMs (host_oom=0 in every leg).
