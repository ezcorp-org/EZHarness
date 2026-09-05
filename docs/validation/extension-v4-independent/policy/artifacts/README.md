# Policy audit artifacts

Portable bundle: `policy-raw-receipts.tar.gz`.

Bundle SHA-256 and standalone mutation/source hashes are in `SHA256SUMS`. Verify from the repository root with `sha256sum -c docs/validation/extension-v4-independent/policy/artifacts/SHA256SUMS`. List the archive with `tar -tzf docs/validation/extension-v4-independent/policy/artifacts/policy-raw-receipts.tar.gz`.

## Receipt identity

- Merged policy audit head used for portable reruns: `e24dc218a831bf1e3c2d0a9e86bd644110282ea7`.
- Tree: `d9bd9d7b3170deedd4eec04446010abb5bc2447b`.
- Current base: `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`.
- Runtime SDK repair reviewed: `ddd024e5b1e724d33963c8ea2c83aad7e18af022` (equivalent source commit `1fdf454d059a89644214eb2422f5426e5d9b0751`).
- Strict SDK gate repair reviewed: `1987e2a219fcf8c8d1ed87a4de55e4366e27dd67`.
- Bun: 1.3.14 (`0d9b296a`).
- All bounded test commands used `flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock`.

## Bundle contents

- Raw baseline: full 28-test lifecycle stdout/stderr.
- Raw faults and restored runs: human approval, blob SHA-256 integrity, SDK direct-call admission, and strict SDK coverage-leg exit.
- Exact unified diff for each deliberate mutation.
- Exact temporary six-case falsy-error/concurrent-isolation test source and raw stdout/stderr.
- Gate integrity stdout/stderr at the merged audit head: exit 1 with exactly 84 findings and no approval override.

Each raw run records the head, tree, command or mutation, and actual exit. Restored logs record a zero `git diff --exit-code` before their passing test. The temporary source was removed after execution. A final source check confirmed no diff in `lifecycle.ts`, `blobs.ts`, `invocation-channel.ts`, or `test-coverage.sh`.

The older `.txt` files are labeled summaries of the first run. The `.tar.gz` bundle is the portable raw evidence requested after that run.
