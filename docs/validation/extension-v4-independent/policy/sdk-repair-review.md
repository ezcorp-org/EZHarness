# Runtime SDK and strict-gate repair review

Reviewed objects: runtime SDK repair `1fdf454d` (coordinator equivalent `ddd024e5`) and strict SDK coverage-gate repair `1987e2a2`.

Portable rerun head: `e24dc218a831bf1e3c2d0a9e86bd644110282ea7`; tree: `d9bd9d7b3170deedd4eec04446010abb5bc2447b`. Exact stdout/stderr, mutation diffs, and the temporary six-case source are in `docs/validation/extension-v4-independent/policy/artifacts/raw-*`.

Runtime behavior:

- `withInvocationChannel` gives handlers a frozen invocation context whose direct `call` uses the same per-invocation admission ledger as `getChannel().request` and notifications.
- All admitted calls settle before the invocation result. A caught request failure can produce the handler's fallback. Notification failure propagates only if the handler succeeded. A handler failure retains precedence after all admitted effects drain.
- The `actionFailed` boolean retains thrown falsy values. An independent temporary test verified exact rejection identity for `undefined`, `null`, `0`, `false`, and `Error("original")`, while an admitted request remained pending. Result: 5 pass.
- An independent two-invocation test released each admitted call separately. The first invocation settled while the second remained pending, then the second settled. Result: 1 pass. This verifies separate admission arrays under concurrent dispatch.
- Late channel and credential calls pass through the closed invocation check. Cancellation still aborts pending host requests through the session and rejects later effects.

Runtime commands with Bun 1.3.14 and `flock --close`:

| Check | Exit | Result |
| --- | ---: | --- |
| `serve.test.ts` | 0 | 11 pass, 0 fail, 36 assertions. |
| Admission mutation: remove `pending.push` and run `drains a direct admitted host call` | 1 | Invocation replied `complete` before host replies; exact assertion failed. |
| Restore admission line and rerun named test | 0 | 1 pass, 0 fail, 3 assertions. |
| Temporary falsy-error and concurrent-isolation audit | 0 | 6 pass, 0 fail, 13 assertions. Temporary test removed after the run. |

The one-tick `setImmediate` unit proof is scheduling-sensitive as a style issue. The runtime auditor owns its deterministic barrier and rootless round-trip replacement, so this review does not duplicate that change. No additional implementation flaw was reproduced in the reviewed SDK logic.

Strict coverage-gate behavior:

- `run_legs` reads missing SDK exit files as failure, records an SDK failed-file marker, exits non-zero in legs-only mode, and includes SDK failure in the full coverage verdict.
- The regression executes extracted shell verdicts with SDK exit 1 and 0. It checks both legs-only and full-mode process exit codes, not only source text.
- `coverage-leg-lcov-guard.test.ts`: 40 pass, 0 fail, 152 assertions.
- Mutation proof: deleting the legs-only `exit 1` made the focused regression fail because the extracted shell returned 0. Restoring it returned 1 pass, 13 assertions.

The MCP change adds `--log-driver=none` to the direct Podman test, which matches the repository's documented CI requirement. The real opt-in MCP run remains part of the build/runtime evidence and was not duplicated here.

No deliberate mutation remains. No reviewed shared commit was amended.

Final freeze review: the runtime SDK files at `9ccce310` retain the reviewed admission, drain, error-precedence, and late-call protections. The final visual-evidence runner has seven focused tests. It assigns selected mock specs to the Chromium mock config, selected real-auth specs to `playwright.real.config.ts` with `PI_E2E_REAL=1`, runs both tiers for `__ALL__`, continues to the other group after one fails, uses distinct explicit blob output files, and returns non-zero for either tier. The workflow records every non-empty selection as credited before setup and only records `credited_ok` after the runner succeeds.

One documentation inconsistency remains outside this policy report: `web/e2e/lanes.json` still describes the `__ALL__` evidence fallback as soft, while the final workflow now fails it closed. This does not weaken execution, but the manifest description should be corrected by its owner.
