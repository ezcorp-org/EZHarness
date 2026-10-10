# W4H-3: pinned images present for the hosted shards

Brief: `/tmp/factory-platform-evidence/w00/briefs/w4h.md` (section W4H-3). Owner w4h-3, branch `wp/w4h-3` off integ/w00 `52d8ba079`.
Evidence root: `/tmp/factory-platform-evidence/w4h-3/` (E below). Hosted logs: `w00/wave4h/push/ci-37138524741/Coverage_shard_{1,3,7}.log`.

Runner-shaped container (E/image/Containerfile, E/start-runner.sh): Ubuntu 24.04 booting systemd, user `runner` uid 1001, home 0755,
passwordless sudo, `--cpus 4 --memory 12g`, no images. Podman 4.9.3, conmon 2.2.1, cgroup delegation and the two pulls all come from
the real `scripts/setup-extension-runner-ci.sh --install`. Bun 1.4.2 comes from the release zip, checked against SHASUMS256.txt. uv 0.11.8
comes from the release tarball, checked against its .sha256. Each leg runs on a clean `git archive` snapshot (sha256 in E/snapshot-*.sha256).
Stated exception: /etc/subuid and /etc/subgid give `runner` the outer ids 1-1000 and 1002-65536, because a nested user namespace cannot map
the hosted runner's 100000+ range. That range still maps the guest uid 65534.

Cause: no step in the cov-shard job puts the Python images on the runner. setup-extension-runner-ci.sh pulls only DEFAULT_IMAGE and
scripts/test-images.json. Three files spell the base digest (DEFAULT_PYTHON_IMAGE, the data Containerfile FROM, pinned.json base), and
no test tied them together.

Data image: the hosted runner's podman (4.9.3) does not rebuild the pinned data digest. It builds `sha256:e64f66da…` stably (three
builds), against the pin `sha256:f9cc7477…` (podman 5.8.2). The four base layers and the config are equal. Only the COPY and RUN layers
differ. The copied requirements file is byte-identical, and a build under umask 077 (the host's) gives the same e64f66da…, so the cause is the
podman toolchain. scripts/build-factory-data-image.sh refuses the mismatch, as designed. No retag and no repin. The journey suite therefore
runs in the factory-real lane (W4H-4, its own commit). The hosted step pulls only the base (coordinator ruling: option A; option C, a
pinned podman 5.8.x in CI, rejected). Standing user decision (option B): publish the data image by digest to a registry; then a hosted
step can pull it and the journey can return to the hosted shards.

Placement: the step runs after the podman setup and before the gate-integrity step. It needs no uv, so it does not depend on W4H-2's
setup-python-toolchain step, and the two hunks merge cleanly. The shared helper stepsNeedingAction (scripts/lib/ci-registration.ts) is
only in integ/w00 (W4H-2), not in this base 52d8ba079. The placement test here uses its own step search; after integration it can use
the helper.

- [x] G1: red in the runner-shaped container at 52d8ba079 with the hosted errors. CHECK: E/run-tests-locked.sh after E/in-runner-setup.sh.
  EXPECT: applied-controls and python-guest "docker.io/library/python@sha256:3121f8b0…: image not known"; journey
  "localhost/ezcorp-factory-python-data@sha256:f9cc7477…: image not known". EVIDENCE: E/red-setup.log, E/red-tests.log (2026-10-03T17:53Z).
- [x] G2: one pin source. The step reads DEFAULT_PYTHON_IMAGE, the value the suites read, and a unit test pins the step's input, the
  data recipe's FROM and pinned.json's base to it. CHECK: `bash E/unit.sh`. EXPECT: 9 pass. Red at the base workflow: 8 pass, 1 fail
  (the workflow placement test). EVIDENCE: E/unit-base-red.log, E/unit-base.log. Commit 8c93335e5.
- [x] G3: a shared step. `.github/actions/factory-python-base` runs `bun scripts/setup-factory-python-base.ts` (podman pull by digest, then
  `podman image exists` by digest) in cov-shard after the podman setup. The test asserts this place in every host-shard coverage job and
  asserts that no workflow step or action restates a Python image. Commit 8c93335e5.
- [x] G4: green in a fresh runner-shaped container at 8c93335e5. CHECK: E/run-head-locked.sh. EXPECT: step exit 0; applied-controls 5 pass;
  python-guest 12 pass. EVIDENCE: E/head-setup.log, E/head-run.log (2026-10-03T21:11Z-21:16Z). The step takes 4 s. The journey still fails
  "image not known" on this branch, because the lane binding is W4H-4's commit.
- [x] G5: data image on a 4-vCPU container. CHECK: E/run-green-locked.sh at c906e5cdf, E/run-head-locked.sh, E/run-umask-locked.sh. EXPECT:
  reproduce f9cc7477 or refuse. RESULT: it refused (e64f66da…). The build takes 19-20 s (uv export plus podman build, base already pulled).
  EVIDENCE: E/green-run.log, E/head-run.log, E/umask-run.log, E/host-pinned-layers.json, E/probe-layers.json.
- [x] G6: hook noise fixed (seen at this package's first commit). run_staged_tests piped a 100 KB list into `grep -q`; under `git commit`
  SIGPIPE is ignored, so the hook printed "printf: write error: Broken pipe". CHECK: `bash E/hooks-test.sh`. EXPECT: red 1 fail, then 28 pass.
  EVIDENCE: E/hooklib-red.log, E/hooklib-green.log. Commit 491b7cc22.
- [x] G7: coverage 100 percent of new and changed lines. CHECK: E/coverage-locked.sh at 8c93335e5 (heavy lock, 2026-10-03T22:52Z).
  RESULT: scripts/setup-factory-python-base.ts LF 18 LH 18 (key added at 100 in scripts/coverage-thresholds.json). The new-file and patch
  gates pass but measure no file here, because they read src/ only. scripts/lib/hook-lib.sh is shell; its changed line runs in the new
  git-hooks test. EVIDENCE: E/coverage-run.log, E/coverage-new-file.txt, E/cov/run1.lcov.
- [x] G8: static and guard checks. typecheck 0, lint 0, check-factory-boundaries 0, guard set plus changed tests at 8c93335e5 (38 files, 505 pass,
  2 skip, 0 fail). gate-integrity shows only the eight standing coverage-tool findings that need the label, none from this branch.
  EVIDENCE: E/typecheck.log, E/lint.log, E/boundaries.log, E/guard.log, E/gate-integrity.log.
- [x] G9: hook count per commit: c906e5cdf 1, 491b7cc22 1, 8c93335e5 1. EVIDENCE: E/commit{1,2,3}-hook.log.
