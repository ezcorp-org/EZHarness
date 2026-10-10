# Gates: W12d reproducible data image build

Scope: make `scripts/build-factory-data-image.sh` reproducible, so that a rebuild from the same
`uv.lock` and Containerfile gives the committed pin in `src/factory/reference-data/image/pinned.json`.
This closes W12c's open gate G8. Branch `wp/w12d-reproducible-image`, from `wp/w12c-data-image-repin`
at `7821e5d7c`, merged with `integ/w00` at `2b2e12550`. Receipts live under
`/tmp/factory-platform-evidence/w12d/`. Each `receipts/<leg>.json` records the producing commit, the
dirty tree, the exact command, the exit code, UTC start and end, the test counts, and the log's SHA-256.

## Cause

Two no-cache builds of the W12c Containerfile with `--timestamp 0` still differed, by 8 files.
All 8 were `.pyc` files in `pyarrow/__pycache__` and `pyarrow/parquet/__pycache__`. The final import
check (`python -c "import pyarrow, pyarrow.parquet"`) wrote them, and they are not byte-stable. File
order, file modes and the image config were already equal once the timestamp was fixed. Without a
fixed timestamp, the created time, the history and every file time also differ. EVIDENCE:
`experiment/base-a.log`, `experiment/base-b.log` (digests `93905097…` and `668055fb…`).

## Fix

- The Containerfile step runs with `PYTHONDONTWRITEBYTECODE=1` and `PIP_DISABLE_PIP_VERSION_CHECK=1`,
  so the install and the import check write no bytecode.
- The script builds with `--no-cache --timestamp 0 --identity-label=false`.
- The script compares what it built with the committed pin. With no match it fails, unless `--repin`
  is passed.
- The script builds under `candidate-<tag>`. Only a build that matches the pin, or one recorded with
  `--repin`, gets the real tag. A failed check removes only the candidate tag, so it never moves or
  removes the pinned image, even when the inputs are unchanged and the tags would be equal.
- The guest's pin errors name `--repin`. The two pin readers take an optional folder, so the
  readiness test calls the real reader for each broken pin.

## Claim, and its limit

The build reproduces **on the same toolchain**: on this host's Podman version (5.8.2), the same lock
and Containerfile give the same manifest digest. Across Podman versions, layer tar ordering and
compression are not proven.

One stated exception: the Containerfile comment still says "so the committed pin is reproducible".
The Containerfile is an input to the image tag. Editing the comment would change the tag, force a
repin, and void build 3 as the proof, so the comment is left unchanged. The script header and the
`guest.ts` doc comment carry the precise wording.

## Gates

- [x] G1: a rebuild after removal gives the committed pin. This is the binding reproduction proof.
  CHECK: remove the local image and prune, then `bash scripts/build-factory-data-image.sh` (check
  mode). EXPECT: exit 0 and the pinned digest. EVIDENCE: `receipts/build-3-reproduce-after-removal.json`,
  at `55f58739f`, clean tree, exit 0, built `sha256:f9cc747722e79b54e59fafd32d29da39f5352ffca3a835d31fcac982bc9d9e8c`,
  equal to the pin. `logs/remove-image.log` shows the image removed and `podman image exists` exit 1
  before the build. The W12c image `sha256:1bf456b7…` was never removed.
- [x] G2: pre-commit evidence, not binding. Build 1 (check mode, exit 1) refused the stale pin and
  left it unchanged. Build 2 (`--repin`, no cache) gave `f9cc7477…` again and wrote the pin. Both ran
  on a dirty tree over `7821e5d7c`. Their `dirtyFiles` map omits `scripts/build-factory-data-image.sh`
  because of a defect in the receipt runner (`run-leg.py`). The runner stripped the whole
  `git status --porcelain` output, which cut the first line's leading space, so ` M scripts/…` parsed
  as `cripts/…` and was dropped. The runner is fixed for every later receipt. EVIDENCE:
  `receipts/build-1-check-stale-pin.json`, `receipts/build-2-repin.json`.
- [x] G3: at the final head, a check-mode build reproduces the pin before and after the control.
  CHECK: `bash scripts/build-factory-data-image.sh`. EXPECT: exit 0, "reproduced the committed pin".
  EVIDENCE: `receipts/final-build-4-check-at-head.json` and
  `receipts/final-build-5-positive-after-control.json`, both at `0c62f68e8`, clean tree, exit 0,
  digest `f9cc7477…`.
- [x] G4: a failed check removes only what it built. CHECK: `bash control.sh`, which runs the
  committed script from a `git archive` copy of the head. Case A adds a LABEL (changed inputs). Case B
  keeps the inputs and writes a wrong digest into the copied pin. EXPECT: in both cases exit 1 and no
  candidate tag left. In case A the built digest `acb13fdb…` no longer exists. In case B the build
  gives `f9cc7477…` and the real tag still names it. The W12c image and the pinned image stay.
  EVIDENCE: `receipts/final-control-failed-check.json`, at `0c62f68e8`, exit 0, 12 of 12 checks
  PASS in `logs/final-control-failed-check.log`.
- [x] G5: the guest unit suite passes. EVIDENCE: `receipts/final-guest-unit.json`, 7 pass, 0 fail.
- [x] G6: the three Podman guest suites pass against the new image. EVIDENCE:
  `receipts/final-podman-journey.json` (11 pass, 0 fail),
  `receipts/final-podman-applied-controls.json` (5 pass, 0 fail),
  `receipts/final-podman-python-guest.json` (12 pass, 0 fail).
- [x] G7: the process-boundary and closure suites pass. CHECK:
  `src/__tests__/factory-process-boundaries.test.ts`, `scripts/check-factory-boundaries.test.ts`,
  `src/factory/reference-image/closure.test.ts`. EVIDENCE:
  `receipts/final-process-boundaries-and-closure.json`, 62 pass, 0 fail.
- [x] G8: the static gates pass. EVIDENCE: `receipts/final-{typecheck,lint,boundaries,gate-integrity,schema-drift}.json`,
  exit 0 each.
- [x] G9: the coverage gates pass with `BASE_REF=2b2e12550`. EVIDENCE: `receipts/final-merge-lcov.json`
  (640 files), `receipts/final-new-file-coverage.json` (no new source files),
  `receipts/final-patch-coverage.json` (all changed executable lines covered, 1 file).

Every `final-*` receipt is at `0c62f68e8` on a clean tree. The free-disk log is `logs/final-df.log`,
with 123 GB before every heavy leg.

## Known low item (fixed after acceptance)

At `0c62f68e8`, in case B the failure message said "The built image was removed", but only the
candidate tag went, because the real tag still names that image. The behavior was correct; only the
message overstated it. The coordinator ruled a one-line fix after acceptance, with no rerun: the
message now says "The candidate tag was removed; the image stays while another tag names it". The
final receipts above are at `0c62f68e8` and show the old wording. The integrator's merge batch runs
the check build, `control.sh` and the positive check on the merged tree.

## Merge with integ/w00

`ee1cb47f4` merges `2b2e12550` with no conflicts. Git merged two files automatically, and both
hunks come from the W01g merge `97809fd85`. `guest.ts` adds `factory_materials.py` to
`SHARED_GUEST_MODULES`. `guest.test.ts` adds that module to the file-list test and adds a test that
every imported `factory_*` module is sealed. Neither hunk overlaps W12d. `uv.lock`, the Containerfile
and the pin are unchanged by the merge.

## Host images

Both `localhost/ezcorp-factory-python-data:a8034aa9676cedc3706aefa3ef4e7939` (W12c, `1bf456b7…`) and
`:5f02158652f81805fc6b0e7fb74bb317` (W12d, `f9cc7477…`) stay until the coordinator confirms the merge.
