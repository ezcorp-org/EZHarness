# First backend and coverage result: 6c05453e

This is the failed first canonical backend run. It is evidence of failure, not a passing coverage receipt. No LCOV file is included: the controller recorded `lcov-copy` as skipped after the coverage failure.

## Provenance and commands

`provenance.txt` records source `6c05453edbb4148d53cbc37b67d05907b5459c67`, tree `b7d807c1d7bed701cec4a23fe0a1c84b38306a12`, base `origin/main` at `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`, Bun 1.3.14, Node v22.22.2, and the runner control path. Command files preserve the exact producer invocations. `gate-file-hashes.txt` identifies the four controller scripts.

## Results

- Overall controller exit: `1` (`exit`).
- Coverage producer exit: `1` (`exits.tsv`).
- Runner probe: `0`; it verified extension-runner kernel controls.
- Residual pass/fail producer: `0` — 178 pass, 0 fail, 14 files.
- New-file coverage gate: `0` — 133 new source files gated.
- Patch coverage gate: `0` — all changed executable lines covered across 389 files.
- The coverage log records 25,969 pass, 2 fail, and 1,556 shards. It must not be described as all tests passing.
- The threshold gate itself passed: 1,251 enforced files met their thresholds. The coverage producer still failed.

## Recorded failures

`coverage.log` retains the raw producer and isolated retry output. The failures were:

1. `src/__tests__/compose-podman-masks.test.ts` failed in the pooled run and again in its isolated plain retry. The live workspace contained two ignored browser summary files with credential-shaped `.json` names outside the secret masks. The parent later preserved their bytes and renamed them `.txt`; the mask rules and assertions remain unchanged.
2. The SDK coverage leg exited 1 after `packages/@ezcorp/sdk/test/integration/tarball.test.ts` had a before/after hook timeout at 120 seconds.

`summary-renames.json` is the exact metadata-name mapping from the browser regression receipt. It records two `.json` to `.txt` renames, hashes, and purpose; it contains no authentication material. This mapping explains the mask-test naming delta without copying the credential-shaped metadata itself.

## Contents

Only commands, exits, provenance, script hashes, producer logs, and the rename mapping are retained. This directory excludes raw authentication files, caches, traces, and post-failure LCOV output.
