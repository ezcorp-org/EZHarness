# AI-kit E2E gate audit

Source checkpoint: `c9407b86`. Bun: `1.3.14`. Heavy commands used `flock --close /home/dev/work/EZCorp/extension-v4-independent-audit/.cache/validation-heavy.lock`.

## Gate inventory

| Existing file | Named checks | Gate | Runnable scope |
|---|---:|---|---|
| `bundled.test.ts` | 3 | base URL + API key | Registration and tool discovery are safe on an owned server. Sending a message writes a conversation and can start a provider run. |
| `doctor.test.ts` | 2 | healthy check: base URL; unreachable check: always | Both are safe and non-billable. The unreachable check now runs when no E2E target is configured. |
| `fanout.test.ts` | 4 | base URL + API key | Requires configured agents/team and creates conversations/runs. No provider credential was supplied in this audit. Missing fixtures now fail instead of returning a false pass. |
| `internal-auth.test.ts` | 4 | first 3: base URL; valid key: base URL + API key | Safe against a fresh owned server. It checks three real 401 paths and one valid-key path. |
| `on-behalf-of.test.ts` | 1 | base URL + API key | Writes a disposable conversation. It was not needed for the bounded safe HTTP proof. |
| `quickstart.test.ts` | 1 | base URL + API key | Creates a conversation and runs a configured model. No paid or external provider call was made. |
| `real-subprocess-obo.test.ts` | 4 | `EZCORP_E2E_SUBPROCESS=1`; its before/after hooks are also reported as skipped when disabled | Fully owned PGlite and subprocess fixture; no provider call. |

## Results

- Before repair, an unreachable configured target reported 6 passes, 0 failures, and only 1 assertion because the selected checks returned early. See `unreachable-false-pass.txt.gz`.
- After repair, the same bad target exits 1. The always-safe unreachable doctor check passes, while configured readiness hooks fail. See `unreachable-after.txt.gz`.
- With E2E variables unset, the suite exits 0 with 1 safe doctor pass, 27 explicit skips, and 1 assertion. See `default-after.txt.gz`. Credentials and opt-ins are represented as skips rather than passing returns.
- A fresh owned container from image `sha256:8f722e76d30f7a4866eb61a2546af64da73f170a5cc9c23866f53ced660e40be`, a new local database, and a disposable API key produced 6 passes, 0 failures, and 8 assertions for doctor plus internal-auth. The three denial checks returned real HTTP 401 responses. The container and storage were removed by the test trap. See `owned-server-safe-after.txt.gz` and `owned-server-command.sh`.
- The production HTTP proof exposed two client projection defects: `/api/health` returns `{status:"healthy"}` and `/api/auth/me` returns `{user:...}`. The client now validates and projects those envelopes to its documented public return types. The AI-kit package suite passes 219 tests and 539 assertions. See `package-after.txt.gz`.
- The owned subprocess proof passes 4 tests and 17 assertions. See `local-obo-after.txt.gz`.

No provider credential, paid API, production database, or persistent service was used. The fanout and quickstart provider-dependent paths remain unexecuted in this bounded audit; their configured setup can no longer count an unreachable target or missing fixture as a pass.

## Follow-up at source `352ca47c`

- Health normalization accepts both production `healthy` and `degraded` statuses. It returns `{ok:false}` for degraded and rejects malformed status values.
- The same fresh owned server passed the on-behalf-of check: 1 test and 2 assertions. Doctor plus internal-auth passed 6 tests and 7 assertions. See `owned-server-on-behalf.txt.gz`.
- The current immutable image plus a real rootless extension runner did not contain an `ai-kit` installation after first-run setup. The configured bundled check correctly failed instead of silently passing. This does not verify its two positive assertions and is a concrete mismatch with the test's auto-install claim. See `owned-server-bundled.txt.gz`.
- The first focused lifecycle attempt caught a test type error and exited 1. After correction, the isolated AI-kit lifecycle passed 1/1 with source digest `09dd062a299fdca243be73e42fa8b7caec55c4ede6c6586d0a6c691421e700d0`, artifact digest `29d7544f76bcf1f6af44b93f4e9b44854254d185ee6853837c0f8328427a12f4`, and release digest `907169814c0366f56bf00c21e71f0ed8b8d8cde8da79bf1debb9b912b0f47677`. See `ai-kit-lifecycle.txt.gz` and `ai-kit-lifecycle-after.txt.gz`.
