# Gates: W4G-4 — private-path tests on the hosted runner's home

Scope: the hosted job "External Postgres (Bun.sql)" (run 36919199727, job 110560704996) failed 6 tests in
`src/factory/pool/process.test.ts` and `src/factory/pool/readiness.test.ts` with "Private path has a non-private owned
ancestor." Run 36919476638 then showed the same class in the backend coverage shards (W4G-4 classification run).

Branch `wp/w4g-4`, base integ/w00 `842ad9fe1`. Every proof ran at that base. A rebase onto integ `4ae3dd6f7` would be
textually clean: integ changed none of the 28 files, and it adds no new suite that builds private files under `$HOME`.
integrator-3 merges.

Decision: the user chose **option A** on 2026-10-01 (relayed by team-lead). Option A changes the product rule. Option B,
a CI step `chmod 700 "$HOME"`, was not taken.

Evidence directory: `/tmp/factory-platform-evidence/w4g-4/`, written `w4g-4/` below.

## Root cause

The tests built their private trees under `$HOME`. On a hosted runner `$HOME` (`/home/runner`) is owned by the runner
user with mode 0755, and the rule requires every owned ancestor to be 0700. Locally `$HOME` is 0700, so the local
chain never saw it. The obvious test-only fix, a 0700 `mkdtemp` under `os.tmpdir()`, failed the old rule too, because
`/tmp` is root-owned 1777 and the old rule refused every world-writable foreign ancestor.

Probe, a fresh 0700 root plus `writePrivateBoundedAtomic` (`w4g-4/probe-host.log`, `w4g-4/red-container.log`):

| Where | Under `$HOME` | Under `os.tmpdir()` |
| --- | --- | --- |
| This host (`/home/dev` 0700) | OK | "writable foreign ancestor" |
| Runner container (`/home/runner` 0755) | "non-private owned ancestor" | "writable foreign ancestor" |

So no user-creatable location on a runner passed the rule.

## The rule, before and after (`src/factory/private-files.ts`)

Before: a foreign ancestor must not be group- or world-writable (`mode & 0o022`). After the first owned directory,
nothing foreign is allowed. Owned directories must be 0700, and only an owned leaf may be repaired on request.

After: the same, except that a foreign ancestor that is **root-owned (uid 0) and sticky (`mode & 0o1000`)** is accepted
even when it is world-writable. Below a sticky directory, other users cannot rename or unlink the entry this user owns.
The walk still opens each component through its parent's descriptor with `O_NOFOLLOW`. The decision is the pure function
`privateComponentVerdict(status, uid, state)`, and the walk passes it the real `fstat` of the opened descriptor. No
injectable seam exists in product code.

Production paths (`/run/ezcorp/...` in the compose files) have root-owned, non-writable ancestors, and they pass both
before and after.

## Commits

| SHA | Subject | Mapped tests in the hook |
| --- | --- | --- |
| `dc838c503` | fix(factory): accept a root-owned sticky ancestor for private paths | 1 (private-files 23/0) |
| `66e735edb` | test(factory): build the pool suites' private trees under the temp root | 3 (10/0, 5/0, 3/0 PG) |
| `4a9005ec6` | test(postgres): resolve the pinned Bun on a runner without the tool directory | 1 (4/0) |
| `8aabf527e` | test(factory): make the shared private root without $HOME | 0 (helper only) |
| `289538b43` | test(factory): build nine composition suites' private trees under the temp root | 9 (all 0 fail) |
| `61cd4a0cc` | test(factory): build nine more suites' private trees under the temp root | 9 (all 0 fail) |
| `95920067d` | test(factory): move the last two $HOME private trees to the temp root | 2 (podman supervisor 3/0, PG restore) |

The tree of the last code commit equals `46bcce826`, the tree the final runs below tested.

## Gates

- [x] G1: Red first in a runner-shaped container (podman, uid 1001 via keep-id, `/home/runner` 0755 and owned, checkout
  under it, Bun 1.4.2 with the flag, host openssl) at `842ad9fe1`. The two pool suites run as line 15 of
  `scripts/factory-pool-coverage.sh` runs them. EXPECT: 9 pass / 6 fail, the six hosted names. EVIDENCE: `w4g-4/red-container-2.log`.
- [x] G2: Rule red then green. CHECK: private-files and the two pool suites with the old rule restored, then with option A,
  on this host and in the container. Red: private-files 0/1 (the export is missing) and pool 9/6. Green: private-files
  23/0 and pool 15/0. EVIDENCE: `w4g-4/proof.log`, `host-red/`, `host-green/`, `container-red-suites.log`, `container-green-suites.log`.
- [x] G3: The verdict cases cannot come from real directories. A test cannot create a root-owned or foreign-owned
  directory, so they are unit-tested on `privateComponentVerdict`:
  - root sticky world-writable: accepted;
  - root world-writable or group-writable without sticky: refused;
  - non-root sticky: refused;
  - root sticky below an owned directory: refused;
  - owned 0755: refused unless it is a repairable leaf.
  On a real filesystem, `/tmp` (uid 0, 1777) is accepted as an ancestor and a 0700 root under it opens. The symlink-component
  test runs under `/tmp`.
  The suite's old root `/run/user/<uid>` does not exist on a runner. EVIDENCE: `w4g-4/host-final/private-files-lcov.log` (23/0).
- [x] G4: 100% of changed lines. Every changed executable line of `private-files.ts` has hits in the private-files
  suite's lcov. Lines 104–109 and 115 are not covered by that suite; they are untouched code that other suites cover.
  EVIDENCE: `w4g-4/host-final/cov-private-files/lcov.info`.
- [x] G5: Pool producer end to end. CHECK: `bash scripts/factory-pool-coverage.sh` in the runner container (host network,
  the proof PostgreSQL) and on this host. EXPECT: rc 0; nine legs, all 0 fail. EVIDENCE: `w4g-4/container-final-pool-producer.log`,
  `w4g-4/host-final/pool-producer.log`, `out-final-pool-producer/factory-pool-coverage.lcov`.
- [x] G6: The two further runner defects the producer exposed. Red, in the container with the pool fix in place:
  - `tests/postgres/factory-pool-process.test.ts` failed 0/3 with "factory pool config is unavailable" (a `$HOME` root).
    EVIDENCE: `w4g-4/container-red-coverage-home.log`.
  - `tests/postgres/helpers/pinned-bun.ts` failed with "posix_spawn ENOENT" for `/tmp/factory-tools/...`, which CI never
    provisions. EVIDENCE: `w4g-4/container-green-coverage.log`.
  Green: the producer, plus `src/__tests__/pinned-bun-resolution.test.ts` 4/0, which covers the provisioned branch, the
  running-Bun-equals-pin branch, the refusal by name, and the real binary's version.
- [x] G7: `makeFactoryPrivateRoot`: XDG_RUNTIME_DIR when the reader accepts a root there, else a 0700 root under
  `os.tmpdir()`, never `$HOME`. CHECK: its 25 suites one per process, in the container at base and head, and on this host.
  Base: 5 of 25 green. Head: 25 of 25. Host: 25 of 25. EVIDENCE: `w4g-4/proof3.log`, `container-{base,head}-private-root.log`, `host-private-root/`.
- [x] G8: Every importer of the rule still green. CHECK: the 28 suites of the private-files importers and the pool, one
  per process on this host. EXPECT: 28 of 28 rc 0. EVIDENCE: `w4g-4/proof.log` (REGRESSION lines), `w4g-4/regression/`.
- [x] G9: Classification of the hosted failing files (run 36919476638). The 24 named files ran one per process in the
  container at base, at the pre-move head with `/home/runner` set to 0700 (the control), and at the final head, and on
  this host at the final head. The 25th hosted entry is "28 ?", failures without a file name; no file could be named for it.
  EVIDENCE: `w4g-4/container-base-classification.log`, `container-head-classification-home700.log`, `container-final.log`,
  `proof6.log`, `w4g-4/classification-table.md`.

### Classification table

| File | Base (container) | Head 0700-home control | Head (container) | Head (host) | Class |
| --- | --- | --- | --- | --- | --- |
| `src/factory/installation-startup.test.ts` | red 28/29 | green | green | green | W4G-4: suite root under $HOME (commit 5) |
| `src/factory/runner/supervisor-process.test.ts` | red 27/17 | green | red 43/1 | green | W4G-4: suite root under $HOME (commit 6); one intermittent timeout-test failure in the final container run, 20/20 green on rerun (flake, reported) |
| `src/factory/runtime-composition.test.ts` | red 13/20 | green | green | green | W4G-4: suite root under $HOME (commit 6) |
| `src/factory/dispatch-composition.test.ts` | red 47/3 | green | green | green | W4G-4: suite root under $HOME (commit 5) |
| `src/factory/release-declaration.test.ts` | red 4/9 | green | green | green | W4G-4: suite root under $HOME (commit 5) |
| `src/factory/key-composition.test.ts` | red 1/6 | green | green | green | W4G-4: suite root under $HOME (commit 5) |
| `src/factory/startup-config.test.ts` | red 47/3 | green | green | green | W4G-4: suite root under $HOME (commit 6) |
| `src/factory/validator-declaration.test.ts` | red 2/5 | green | green | green | W4G-4: suite root under $HOME (commit 6) |
| `src/factory/restore-command.test.ts` | red 1/5 | green | green | green | W4G-4: suite root under $HOME (commit 6) |
| `src/factory/service-readiness.test.ts` | red 5/5 | green | green | green | W4G-4: suite root under $HOME (commit 6) |
| `src/factory/service-probes.test.ts` | red 15/5 | green | green | green | W4G-4: suite root under $HOME (commit 6) |
| `src/factory/recovery-composition.test.ts` | red 6/4 | green | green | green | W4G-4: suite root under $HOME (commit 5) |
| `src/factory/key-management.test.ts` | red 4/2 | green | green | green | W4G-4: suite root under $HOME (commit 5) |
| `src/factory/attempt-composition.test.ts` | red 10/4 | green | green | green | W4G-4: suite root under $HOME (commit 5) |
| `src/factory/private-service-composition.test.ts` | red 16/3 | green | green | green | W4G-4: suite root under $HOME (commit 5) |
| `src/factory/runner/python-runner.integration.test.ts` | red 0/4 | red 0/4 | red 0/4 | green | separate: nix not on the runner (W4G-5) |
| `src/factory/restore-composition.test.ts` | red 1/2 | green | green | green | W4G-4: suite root under $HOME (commit 6) |
| `src/factory/pool/readiness.test.ts` | red 2/3 | green | green | green | W4G-4: pool suite root under $HOME (commit 2) |
| `src/factory/runner/guest-broker-transport.integration.test.ts` | red 10/3 | green | green | green | W4G-4: suite root under $HOME (commit 6) |
| `scripts/gate-integrity-rule11.test.ts` | red 10/2 | red 10/2 | red 10/2 | green | separate: rule-11 deps (W4G-6); my container also lacks git |
| `src/factory/pool/process.test.ts` | red 7/3 | green | green | green | W4G-4: pool suite root under $HOME (commit 2) |
| `src/factory/private-https.integration.test.ts` | green | green | green | green | separate: x509 CLI on the runner (W4G-7); green in my container |
| `src/factory/release-composition.test.ts` | red 15/2 | green | green | green | W4G-4: suite root under $HOME (commit 5) |
| `src/__tests__/task-state-isolated.integration.test.ts` | red 0/1 | red 0/1 | red 0/1 | green | separate: podman/conmon (W4G-8) |

The control proves the cause. With only `/home/runner` changed to 0700, every W4G-4 file is green and only the separate
classes stay red. After the code change, the final head with a 0755 home gives the same result.

The supervisor-process timeout test ("bounds the probe and names a timeout as its own failure") failed once in the final
container run (43/1). It then passed 10 of 10 in the container and 10 of 10 on this host (`w4g-4/repeat/`). It races an
abort against a probe-timeout record, and W4G-4 does not touch that code. It is reported to the coordinator as a flake
for its own package.

- [x] G10: The two extra same-class suites (team-lead ruling). `tests/postgres/factory-restore.test.ts` on this host on
  PostgreSQL, with the storage secrets directory set, passes 17/0 (`w4g-4/repeat/host-factory-restore.log`). The podman
  supervisor integration passes 3/0 on this host in the 6b hook (`w4g-4/commit-6b-retry.log`). In the runner container it is red, as expected: no podman
  there (`out-final-container/`).
- [x] G11: Static legs at the final tree: biome over the 28 files, backend and tests typecheck, boundaries.
  EVIDENCE: `w4g-4/tsc-backend-final.log`, `tsc-tests-final.log`, `boundaries-final.log`, `lint-final.log`.

## Follow-ups

- The supervisor-process timeout-test flake (G9): W4G-12, owner w12e-2 (root cause, not a retry).
- Commit 6b's hook runs `tests/postgres/factory-restore.test.ts`, which needs `EZCORP_FACTORY_STORAGE_SECRETS_DIR` in the hook environment besides `FACTORY_TEST_POSTGRES_URL`. The first 6b attempt failed only on that missing variable (`w4g-4/commit-6b.log`); the retry exported it (`w4g-4/commit-6b-retry.log`).
- Integrator merge hold lists: `w4g-4/merge-hold-hosted-failing.txt` (24 files) and `w4g-4/merge-hold-moved-suites.txt` (20 files).
