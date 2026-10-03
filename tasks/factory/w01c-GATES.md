# Gates: W01c review of W12's material mount

Branch `wp/w01c-materials-mount`, a descendant of `wp/w01c-materials-review` at `b2b3e614e`, itself cut from `integ/w00` at `5f04c7131`.

`wp/w01c-materials-review` is checked out in the validator's worktree, so git will not let a second worktree hold it and moving the ref would change what that worktree holds underneath a verdict already issued there. The work is therefore on a direct descendant: fast-forward `wp/w01c-materials-review` onto this head and nothing is rewritten.
Validator verdict: ACCEPT-WITH-FIXES; the hardening itself is sound.
Evidence: `/tmp/factory-platform-evidence/w01c/`, verdict in `materials-mount-review.md`.

This leaf is a review, so its gates are the review's own findings and the one correction that was code rather than a rule.

- [x] G1: The claim that a guest can subvert the material mount is measured, not argued.
  CHECK: `flock /tmp/ezcorp-validation-heavy.lock /tmp/factory-platform-evidence/w01c/w01c-mount-probe2.sh`
  EXPECT: a real guest in the shipped profile creates a symbolic link inside the mount
  EVIDENCE: `logs/mount-option-probe-2.log`, three mount-option variants against a fresh directory each. Write and mkdir allowed, symlink to `/etc/passwd` allowed and confirmed on the host as `lrwxrwxrwx escape -> /etc/passwd`, hardlink out EXDEV, execute EACCES in every variant. `logs/mount-option-probe-1.log` is the first probe, retained although its shared directory made the mkdir and symlink rows ambiguous across variants; probe 2 replaced it with a fresh directory per variant.

- [x] G2: The host never follows what a guest wrote.
  CHECK: bun test --timeout 20000 ./packages/@ezcorp/extension-runner/tests/materials.test.ts
  EXPECT: exit 0, six cases
  EVIDENCE: 6 pass / 0 fail, `packages/@ezcorp/extension-runner/src/materials.ts` at 39/39 lines. `O_NOFOLLOW` refuses a planted link at the syscall and the descriptor must be a regular file; `O_NONBLOCK` is load-bearing because opening a planted FIFO for reading otherwise hangs the read-back forever, which my own test found by hanging; the walk refuses symlinks, FIFOs, sockets, and devices rather than skipping them, refuses a path that escapes the root, and is bounded in entries, bytes, and depth.

- [x] G3: Static gates.
  CHECK: bun run typecheck; bun run lint; bun scripts/check-factory-boundaries.ts; bun scripts/gate-integrity.ts
  EXPECT: all exit 0
  EVIDENCE: all four exit 0 at `b2b3e614e`.

- [x] G4: The verdict and its binding rules are recorded where consumers read them.
  EVIDENCE: `materials-mount-review.md` and the dated line in interface freeze section 16. Corrections 2 and 3 are rules the code here cannot enforce and belong to W11 and W12: the mount options must add `noexec,nosuid,nodev`, and the caller-created directory must never be world-writable, never be shared or reused between attempts, and needs a filesystem quota because Podman cannot bound a bind mount.

- [x] G5: The material mount itself lands in Terra's files, so W12 consumes one canonical version.
  CHECK: bun test --timeout 20000 ./packages/@ezcorp/extension-runner/tests/materials.test.ts; flock /tmp/ezcorp-validation-heavy.lock timeout 1200 bun test --timeout 300000 ./packages/@ezcorp/extension-runner/tests/podman.integration.test.ts
  EXPECT: exit 0 on both
  EVIDENCE: `logs/materials-unit.log` 7 pass / 0 fail and `logs/podman-suite.log` 17 pass / 0 fail. Taken from W12's implementation with the review's corrections applied as it landed: the options carry `rw=true,relabel=private,noexec,nosuid,nodev`, `materials` absent means no mount so v4 callers are unchanged, and a discovery guest never receives one. `StartRequest.materials` is in the contract and the wire schema is regenerated, which `schema.test.ts` confirms. One case reads the exported `runnerMaterialMount` for the exact option string, because both packs consume that one function and a drifted option is a silent weakening. A real-guest case proves the round trip: the guest writes a file and a nested partition, plants a symlink and REPORTS that it succeeded so the host-side refusal is a refusal of something that really happened, the reader refuses the tree while the link is present, and the ordinary files round-trip exactly once it is gone.

- [x] G6: Removing a material directory needs the user namespace.
  EVIDENCE: measured, not assumed. A guest's subdirectories belong to a mapped subuid, so the host cannot write into them and an ordinary recursive remove fails with EACCES; the first run of the real-guest case failed in its own `finally` for exactly that reason, which also masked a fully passing body. Cleanup now runs `podman unshare rm -rf` and never throws. An `idmap` bind mount would have made the host the owner and did not work on Podman 5.8.2 here (`logs/idmap-probe.log`), so it is not the answer.

## The validator's items, each with where it is proved

| Item | Where | State |
| --- | --- | --- |
| Mount options carry `rw=true,relabel=private,noexec,nosuid,nodev` | `runnerMaterialMount` in `podman.ts`; asserted as an exact string in `materials.test.ts` | done |
| No `0o777` anywhere | no mode is set by this package at all: `runnerMaterialMount` builds arguments and never creates the directory, and `grep -rn '0o777' packages/@ezcorp/extension-runner/src` is empty. The directory is the caller's, and the binding rule is recorded in the freeze and in the review | done, as a rule for W11 and W12 |
| A non-regular entry is refused with a typed error | `listRunnerMaterials` and `openRunnerMaterial` throw `RunnerError` with code `material_untrusted` for a symlink, a FIFO, a socket, a device, an escaping path, and a bound breach; four unit cases plus the real-guest case | done |
| Freeze section 16 line | dated 2026-09-14 entry describing the guest byte path and its three binding rules | done |
| Freeze section 12 table note | `packages/@ezcorp/extension-contract/src/types.d.ts` now reads `StartRequest.devices` and `StartRequest.materials` only | done |

## Freeze section 12 ownership note

Applied: the row now reads `` `StartRequest.devices` and `StartRequest.materials` only ``, since W12's field lands in the same W01-owned declaration file.

## Where this work sits

`wp/w01c-materials-review` is checked out in the validator's own worktree at `b2b3e614e`, the commit their verdict names, so git will not let a second worktree hold it and moving the ref would change what that worktree contains underneath an issued verdict. This branch is a direct descendant: fast-forward `wp/w01c-materials-review` onto its head and nothing is rewritten.


## Validation

Independent validator verdicts: ACCEPT-WITH-FIXES at `b2b3e614e` (the hardened helpers alone; the mount itself still lived on W12's branch without the corrections), ACCEPT at `aa0f15870` with the mount landed by its owner. Reports: `/tmp/factory-platform-evidence/w01c-validation/report.md`, `report-r2.md`. Merged to `integ/w00` by the coordinator; W12 consumes `listRunnerMaterials`/`openRunnerMaterial` and drops its own copy of the mount, W11 closes its egress rows on it.
