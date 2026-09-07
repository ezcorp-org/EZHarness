# DB live-holder readiness follow-up

This checkpoint preserves the accepted **test-only** readiness repair from an isolated worktree. It is not a production lifecycle repair and it does not claim the exact hosted assertion or root cause.

The hosted Coverage shard 1 job (run `34158014590`, job `101853766688`) recorded one first-pass failure for `src/__tests__/db-live-holder-guard.test.ts`; its isolated plain retry passed. The retained hosted log has no failed assertion output.

The final test waits for the real child executable identity through `/proc/<pid>/exe` before each classification: the live control must be the running Bun executable and the stale/recycled control must be the resolved `sleep` executable. It also awaits every owned child exit in `afterEach`.

`controls/repro-gated-exec.*.txt` is a deterministic local control. It starts with an executable name containing `bun`, verifies that the guard denies the pidfile, then uses a pipe to exec real `sleep` and verifies that the same guard passes. It proves why target-executable readiness is required. It does **not** reproduce the unknown hosted failure.

The immediate `Bun.spawn(["sleep", "30"])` observation ran 1,000 times: 992 initial cmdlines were empty, 8 were `sleep`, 0 were `bun`, and there were 0 unexpected guard denials. It therefore did not reproduce the hosted failure.

Validation used the commands in [inputs/commands.txt](inputs/commands.txt): file lint passed; focused covered test passed 14 tests / 26 expectations; five grouped covered replays passed with separate Bun processes (holder guard 14/0 and adjacent connection-health holder test 11/0 each run).

[provenance.json](provenance.json) maps every copied raw input to its source byte hash. [SHA256SUMS](SHA256SUMS) indexes every published file except itself. Raw hosted logs and coverage LCOV remain private.
