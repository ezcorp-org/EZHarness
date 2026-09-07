# Backend checkpoint — da6bc4db

This is a safe failed backend-checkpoint for source
`da6bc4db6326696347d76a2225677954b31d3a2b` (tree
`be66104272e97354db0f54d8aa5e614ddff5d0ba`). The outer controller exited 1.
It is not a complete backend pass.

## Actual outcomes

| Leg | Exit | Result |
| --- | ---: | --- |
| Runner probe | 0 | passed |
| Coverage | 0 | 26,034 passed, 0 failed, 1,563 shards |
| Residual | 1 | 178 passed, 1 timeout, 15 files |
| New-file coverage | 0 | 134 files checked |
| Patch coverage | 0 | 394 files checked |
| Authored whitespace | 0 | passed |

The parent coverage review records 1,412 LCOV records with SHA-256
`4633a9eb67ad3e9510b50c27f6de106c3b2152686def706f21e29f062b4c663f`.
It records 1,260 enforced coverage-threshold files. Raw LCOV and coverage logs
remain private. Their exact paths, byte counts, and hashes are in
`raw-hashes/private-artifact-hashes.json`.

## Inputs and limits

`committed-inputs/` contains 19 inert frozen copies. Eighteen are byte-equal to
source commit `da6bc4db`; the nineteenth is the private canonical backend
controller snapshot, verified against its recorded input hash. See
`metadata/committed-input-verification.json`. `controllers/` holds inert copies
of the outer controller and that backend controller.

This checkpoint preserves the residual timeout as a failure. It does not waive,
retry, or classify the failed full backend controller as green.
