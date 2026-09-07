# Coverage failure-output follow-up

Base source: `2bdf4708594db3e27e25269e7c4fbb7cf0dc87f7`.

The original real-wrapper control runs one pass/fail-set host file through the
actual `scripts/test-coverage.sh` host-shard path. Its fake Bun fails the first
instrumented run with `FIRST_PASS_FAILURE_SENTINEL`, then writes lcov during
coverage recovery and passes the plain retry. Before the repair, the wrapper
exited 0 and did not print the first-pass sentinel.

The accepted patch prints the captured pooled output before recovery or retry.
The behavioral test runs the real wrapper under a hostile inherited control
set (`CI=true`, `COVERAGE_LEGS_ONLY=1`, `COV_OUT`, wrong shard values), then
explicitly replaces all child controls. It verifies the one selected file runs
three times, the parent artifact root is unchanged, and the outer child has a
10-second timeout with a 2-second kill grace.

Limits: this evidence proves diagnostic retention and child-environment
containment. It does not repeat a full coverage shard. The retry, tolerance,
coverage recovery, and exit rules remain unchanged.

`SHA256SUMS` hashes every retained evidence file by relative path; it excludes only itself.
