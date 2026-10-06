# Gates: W4H-12 — factory-host-launch on real PostgreSQL rejects in the hosted external-postgres job

Scope: hosted run 37383355593 at 1bc5f63c7 (PR 318) failed ONE test in the storage step of "external-postgres / External
Postgres (Bun.sql)": `tests/postgres/factory-host-launch.test.ts:6` "the attempt-dispatch path through the supervisor
conforms on real PostgreSQL", "Received promise that rejected: Promise { <rejected> }" after 2977 ms. The value was hidden
by `expect(promise).resolves.toBeUndefined()`. Latent: the baseline never reached this step.

Branch `wp/w4h-12-factory-host-launch` from integ/w00 `1bc5f63c7`. Evidence directory:
`/tmp/factory-platform-evidence/w4h-12/`, written `w4h-12/` below. integrator-4 merges.

## Root cause

1. `.github/workflows/db-postgres.yml` external-postgres (job at line 60 at the base) runs a Podman-guest suite in its
   storage step (`./tests/postgres/factory-host-launch.test.ts`, line 197 at the base), but the job never ran
   `bash scripts/setup-extension-runner-ci.sh --install`. Seven ci.yml jobs that run the runner do. That script is the only
   place that pulls the pinned guest image, installs the pinned conmon 2.2.1, delegates cpu/memory/pids to the user
   manager and exports the user session (XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS).
2. `packages/@ezcorp/extension-runner/src/podman.ts:477` starts every guest with `--pull=never` (deliberate: pinned and
   pre-provisioned). The isolation probe's run (`podman.ts:325`) is the first guest, so on an unprovisioned host it fails
   with podman's "image not known" as a generic `command_failed`, under podman's cgroup warnings.
3. Disproved by G6 (kept as a record): I first named `.github/actions/factory-storage/action.yml:33` (base), which writes
   `XDG_RUNTIME_DIR=$RUNNER_TEMP/factory-storage-runtime` to GITHUB_ENV, as a second cause that would survive the runner
   setup. G6 ran the fixed workflow with that export forced and was green: the setup's explicit DBUS_SESSION_BUS_ADDRESS
   keeps podman on the systemd manager, and the image store lives under HOME. The cgroupfs fallback in G1 came from the
   missing setup alone.
4. The test hid all of this: `.resolves.toBeUndefined()` prints no value. Locally the file was green only because this host
   has the image pulled and a user session.

Not "flaky": the red is deterministic (R1, r5-named) and the green needs the provisioned runner (r5-green).

## Fix

- `e18becde4` external-postgres runs `bash scripts/setup-extension-runner-ci.sh --install` after the setup action; new guard
  `scripts/podman-guest-job-registration.test.ts` (a step that names a test file whose relative-import closure starts a Podman
  guest must run after the runner setup in its job); `scripts/lib/ci-registration.ts` gains `stepsNeedingPreparation`
  (`stepsNeedingAction` delegates to it). This commit also changed the storage action; `ac20f1a8a` reverted that part.
- `44e2121e9` the runner refuses an unprovisioned image by name: `initialize()` asks `podman image exists` first and throws
  `image_unavailable` (image, `--pull=never`, the setup script); `RunnerCommandError` keeps the exit status so the refusal
  keys on podman's exit 1, not on stderr text.
- `f0cf1e8f7` both host-launch twins await the helper directly, so a rejection prints its value.
- `e423c827b` (coordinator review) the guard matches the setup as a command (`workflowCommands` strips a `#` comment), refuses
  a job that runs the setup after its factory-storage start, and pins `scripts/fixtures/podman-guest-jobs/base/db-postgres.yml`
  (byte-equal to 1bc5f63c7). Cases: base red by name; committed green; committed with the setup only in a comment red by
  name. (Its setup-after-storage rule was dropped in 643f12dd5.)
- `ac20f1a8a` (coordinator ruling 01:26Z, after G6) the storage action and its registration test are back to their base text.
- `643f12dd5` the twins read `expect(await helper()).toBeUndefined()`: f0cf1e8f7's bare `await helper()` left no assertion and
  gate-integrity reported both as vacuous (G7b, first run). The guard's setup-before-storage rule is dropped (G8, coordinator
  ruling): its reason was not proven. The ordering case now moves the setup after the guest step. Hook: 16/0, 7/0, 1/0, 1/0
  (both twins on PostgreSQL and Podman).

Net change against 1bc5f63c7 (11 files): the workflow step, the guard and its fixture, the shared helper, the runner
precondition with its tests, and the two test twins. `.github/actions/factory-storage/action.yml` and `scripts/factory-storage-action-registration.test.ts` are
unchanged.

## Harness (R1 and R5)

`w4h-12/r1.sh` with `w4h-12/in-container.sh`, run only through `w00/gated-flock.sh` (START_MEM 8 GiB, exit file):
a fresh `docker.io/pgvector/pgvector:pg15` (digest `sha256:9a169499888c…`, PostgreSQL 15.19) with the job's user and
database and a throwaway password in 0600 files (never printed, never in argv); a runner-shaped Ubuntu 24.04 container
(`w4h-12/image/Containerfile`, byte-equal copy of W4H-6's, tag `localhost/w4h-12-runner:24.04`, apt podman 4.9.3, systemd,
4 CPUs, 12 GiB) sharing the PostgreSQL container's network so `localhost:5432` resolves as on the hosted job; the snapshot
tree from `git archive`; the setup action's install (`--ignore-scripts` + `bun run build:packages`); then the job as the
SNAPSHOT TREE defines it: the runner setup only when the tree's external-postgres job runs it, the storage action's
XDG_RUNTIME_DIR export only when the tree's action writes it; then the storage step's command.
Deviation (accepted by the coordinator): the step runs only `./tests/postgres/factory-host-launch.test.ts`, because the
other 46 files need the job-local SeaweedFS (Docker compose on the hosted runner). Each file creates its own database.

## Gates

- [x] G1 (R1): red reproduced under the hosted shape, rejection visible. CHECK: `GATED_FLOCK_START_MEM_GIB=8 bash
  w00/gated-flock.sh w4h-12 w4h-12/logs/r1-red.gate timeout 3600 bash w4h-12/r1.sh r1-red ./tests/postgres/factory-host-launch.test.ts`
  at 1bc5f63c7 plus the visibility change. EXPECT: the hosted fail with its value. EVIDENCE: `w4h-12/logs/r1-red-step.log`
  (0 pass / 1 fail, 7 expect() calls, exit 1): `RunnerError command_failed` at core.ts:98, "docker.io/oven/bun@sha256:9114c058…:
  image not known" after podman's "no systemd user session … Falling back to --cgroup-manager=cgroupfs"; after the step:
  image absent, cgroupfs, /usr/bin/conmon, XDG_RUNTIME_DIR the action's directory.
- [x] G2 (R2): root cause named with its lines (above). CHECK: read the lines at the base. EVIDENCE: the four points above;
  G1 shows the value, G4 and G5 show the switch.
- [x] G3 (R3): fixed at the root, no retry, no timeout change, no skip; the test stays on real PostgreSQL. CHECK:
  `git diff 1bc5f63c7..643f12dd5 --stat`. EVIDENCE: the commits above; the job's 15-minute limit is unchanged
  (the hosted job ran 7.5 min).
- [x] G4 (R4): tests that fail without the fix. CHECK: `bash w4h-12/unit.sh <file>` with the base source restored. EXPECT:
  red. EVIDENCE: `w4h-12/logs/unit-red-without-precondition.log` (image-precondition.test.ts 0 pass / 4 fail on base
  podman.ts) and `w4h-12/logs/unit-red-base-workflow.log` (base workflow and action: the guard names "db-postgres.yml
  external-postgres … Run factory storage and private services on Postgres and S3", the storage rule names XDG_RUNTIME_DIR;
  1 fail each; the storage-rule case was later reverted with the action in ac20f1a8a); green with the fix:
  `w4h-12/logs/unit-2.log` (4/0), `w4h-12/logs/unit-3.log` (5/0, 5/0, 16/0), and after e423c827b `w4h-12/logs/unit-4.log`
  (guard 7/0, ci-registration 16/0). Coverage and CRAP: G7b.
- [x] G5 (R5): green under the hosted shape at the head, fresh database, same command, one run. CHECK: `w4h-12/r5-chain.sh`
  leg r5-green at f0cf1e8f7 (snapshot tree 9a3f51547). EXPECT: exit 0. EVIDENCE: `w4h-12/logs/r5-green-step.log` (runner setup
  rc 0, storage action exports no XDG_RUNTIME_DIR, 1 pass / 0 fail, 12 expect() calls, test 20.2 s, exit 0; after the step:
  image present, systemd cgroup manager, conmon 2.2.1). Named-precondition leg r5-named (runner setup left out on purpose):
  `w4h-12/logs/r5-named-step.log` (0 pass / 1 fail, `image_unavailable` naming the image and the setup script).
  For the head's job shape (runner setup, base action exporting XDG_RUNTIME_DIR) the green leg is r6-xdg (G6): that is
  exactly what ac20f1a8a ships.
- [x] G6: does the runner setup survive the base action's XDG export? CHECK: `W4H12_CHAIN_LEGS="xdg control" w4h-12/chain.sh`,
  leg r6-xdg (fixed workflow, base export forced with W4H12_FORCE_XDG_EXPORT=1) at e423c827b. EXPECTED (my R2 point 4): red.
  RESULT: GREEN, which disproves point 4. EVIDENCE: `w4h-12/logs/r6-xdg-step.log` (runner setup rc 0;
  XDG_RUNTIME_DIR=/home/runner/work/_temp/factory-storage-runtime, DBUS set; 1 pass / 0 fail, 12 expect() calls; after the
  step: image present, systemd cgroup manager, conmon 2.2.1). This leg corrected R2 point 4: the action change was not
  needed, and ac20f1a8a reverted it (coordinator ruling 01:26Z).
- [x] G7a: local db-postgres list green. CHECK: `w4h-12/chain.sh` leg control at e423c827b (wave4i-2's 56-file postgres list,
  one bun process, my own fresh pg15, the shared S3 under the tests' own prefixes). EXPECT: 0 fail. EVIDENCE:
  `w4h-12/logs/control-2.log` (629 pass / 0 fail, 9172 expect() calls, 56 files, 1136 s, exit 0; no OOM kill during the run).
  The first run, `w4h-12/logs/control.log` (00:59Z, exit 143), is VOID: OOM kills on the host 01:06–01:08Z (a 15.4 GiB tsgo
  that is not ours), and the coordinator found the shared stores alive. I stopped my own run.
- [x] G7b: final light legs at 643f12dd5. CHECK: `bash w4h-12/final-legs.sh` (log `w4h-12/logs/final-legs.log`, each leg
  `w4h-12/logs/final-<leg>.log`). RESULT: unit core 5/0, image-precondition 4/0, ci-registration 16/0, podman-guest-job-registration
  7/0, factory-storage-action-registration 4/0; vs integ/w00: new-file PASSED ("no new source files in this diff"), patch
  PASSED ("all changed executable lines covered (3 file(s))"), gate-integrity PASSED; vs origin/main: gate-integrity exactly
  the 8 expected coverage-tool lines (0 vacuous); new-file and patch red only on the integration branch's own files, and the
  one touched file they name (podman.ts, "175 changed lines uncovered", the integ diff of that file) has none of this
  package's 15 added lines (9, 322, 335-347) among its 40 uncovered lines; CRAP --changed: 6 functions, none above 30
  (probeSecurity 20 = its complexity at 100 percent; requireImage 4; the CRAP tool does not measure scripts/, and
  ci-registration.ts's changed lines are fully covered); guard set 507/0; typecheck, lint, boundaries, lanes rc 0; prune scan
  clean. The first run at ac20f1a8a (02:45Z) found the two vacuous twins on both gate-integrity legs; 643f12dd5 fixed them.
  Binding rule (coordinator, 2026-10-06): for this package the coverage legs vs integ/w00 bind (PASSED); new-file and patch vs
  origin/main red on integ's own lines is the known package-head pattern and binds at the combined run.
- [x] G8: the setup-before-storage ordering rule — DROPPED (coordinator ruling), the setup step's presence stays required.
  CHECK: `W4H12_CHAIN_LEGS=order w4h-12/chain.sh`, leg r7-order at ac20f1a8a (02:47–02:50Z). RESULT: inconclusive, exit 1
  (`w4h-12/logs/r7-order-step.log`): case A (setup after the storage start) up rc 0, then the runner setup itself failed rc 1
  (its log stayed in the container and was lost: a harness defect; logs must live outside the container), down rc 1; case B void ("Factory storage containers
  already exist": A's cleanup failed). The cited reason (`scripts/setup-factory-storage.sh:44`) is therefore not evidence,
  and no other reason is proven.

Risk closed (coordinator order 01:2xZ): while `e18becde4` stopped the action's XDG_RUNTIME_DIR export, the later steps of
factory-assurance-release and factory-deployment-operations would have seen a different XDG_RUNTIME_DIR. Hosted run 37383355593
(`w00/wave4i-2/push/ci-37383355593-jobs.json`): "external-postgres / Factory assurance and release" success; "Factory deployment
and operations" skipped (self-hosted factory-real). `w4h-12/xdg-readers.py`, output `w4h-12/logs/xdg-readers.txt`, follows every
file the two jobs run after their storage start through relative imports and script calls. Assurance: 10 entry files, 654 files,
one XDG_RUNTIME_DIR line, `packages/@ezcorp/extension-runner/src/core.ts:85` (podman spawn env; the job starts no guest, the
guard holds that). Deployment: 7 entry files, 696 files, `src/factory/provisioning/certificates.ts:55` and
`src/__tests__/helpers/factory-private-root.ts:20` besides core.ts:85; none reads it to find the storage directory (that is
EZCORP_FACTORY_STORAGE_SECRETS_DIR). G6 showed the export harmless, so `ac20f1a8a` restored it: both jobs now get exactly the
environment they had in run 37383355593. Expectation for the next hosted run: both stay as they are (success; skipped).
