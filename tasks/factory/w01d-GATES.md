# Gates: W01d material handover

Branch `wp/w01d-materials-handover`, cut from `integ/w00` at `f30da62fa`, which already contains the W01c mount. Head `12070ce49`. `integ/w00` has since moved to `8810d6eae`; merging it is not required for this leaf and was not done.
Evidence and receipts: `/tmp/factory-platform-evidence/w01d/`.

W12 measured the defect against the merged mount: the runner set neither mode nor owner on the material directory, so a guest could not write to it at all. The only thing hiding that was a `chmod(materials, 0o777)` in W01's own integration test, which is the exact mode the W01c review forbade, moved out of production and into a test. That is my defect, and the handover belongs in the runner rather than repeated in every domain pack.

- [x] G1: The runner performs the handover, and no caller sets a mode or an owner.
  CHECK: flock /tmp/ezcorp-validation-heavy.lock timeout 1500 bun test --timeout 300000 ./packages/@ezcorp/extension-runner/tests/podman.integration.test.ts
  EXPECT: exit 0; a guest writes with no caller-side mode change
  EVIDENCE: `logs/podman-suite.json`, 18 pass / 0 fail. The caller creates the directory `0o700` and does nothing else to it. `handOverMaterials` sets `0o770` and only then moves ownership with `podman unshare chown 65534:0`; the order is load-bearing, because after ownership moves the runner can no longer chmod it.

- [x] G2: The directory is closed to everyone but the guest and the runner.
  CHECK: the same suite, case "the runner's material handover leaves the directory closed to everyone but the guest and itself"
  EXPECT: mode exactly `0o770`, no bits for others, owner moved away from the runner, group still the runner's
  EVIDENCE: asserted on the host after a real guest ran: `mode & 0o777` is `0o770`, `mode & 0o007` is `0`, `uid` is no longer the runner's, `gid` still is, and the runner reads back what the guest wrote. Never `0o777`; `grep -rn '0o777' packages/@ezcorp/extension-runner/src` is empty.

- [x] G3: Every refusal branch is refused, and refuses before anything happens.
  CHECK: bun test --timeout 20000 ./packages/@ezcorp/extension-runner/tests/materials.test.ts; flock /tmp/ezcorp-validation-heavy.lock timeout 1500 bun test --timeout 300000 ./packages/@ezcorp/extension-runner/tests/podman.integration.test.ts
  EXPECT: exit 0 on both; the typed error for each branch and no launch
  EVIDENCE: `logs/r2-materials-unit.json` 8 pass / 0 fail and `logs/r2-podman-suite.json` 27 pass / 0 fail. The validator found these three branches untested, which was correct. A light harness constructs a `PodmanRunner` whose podman binary is a path that cannot execute, so reaching podman at all would surface as a spawn error rather than the typed refusal: a missing directory, a regular file in its place, a symlink pointing at a good directory, and a directory the runner does not own each raise `RunnerError` code `material_directory_invalid` with its own message. The symlink case also asserts the target it pointed at was never chmodded, which is the point of refusing a symlink at all. Through the real `start()` path, a materials directory owned by root rejects with the same typed error, no container carries the worker's name afterwards, and the filesystem root is untouched.

- [x] G4: Inputs the caller placed stay readable.
  EVIDENCE: the integration case writes an input before the start and the guest reads it, returning its value. The handover changes the directory only, so files keep their own ownership and mode. Measured while getting this wrong: `writeFile(..., { mode: 0o644 })` is masked by the process umask, the file became `0o600`, and the guest reported `EACCES`. The mode is now set with an explicit `chmod` after the write, which is why the runner's own staging does the same.

- [x] G5: The factory Podman suites still pass.
  EVIDENCE: `logs/package-preparation-podman.json` 1 pass / 0 fail, `logs/attempt-runtime-podman.json` 7 pass / 0 fail, `logs/materials-unit.json` 7 pass / 0 fail.

- [x] G6: Static gates and the `BASE_REF=integ/w00` coverage gates.
  CHECK: bun run typecheck; bun run lint; bun scripts/check-factory-boundaries.ts; bun scripts/gate-integrity.ts; BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts; BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts
  EVIDENCE: `logs/static-gates.json`, all six exit 0.

## The contract, for W11 and W12

The caller creates a private directory it owns, places any inputs in it with an explicit `chmod`, and passes the path as `StartRequest.materials`. It sets no mode and no owner on the directory itself. The runner refuses anything it does not own, hands the directory over, and the caller reads results back only through `listRunnerMaterials` and `openRunnerMaterial`. Removing the directory afterwards needs `podman unshare rm -rf`, because the guest's own files and subdirectories belong to a mapped subuid.

Recorded as a dated line in interface freeze section 16.
