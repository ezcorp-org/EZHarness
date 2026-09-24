# Local runtime qualification gates

- [x] Read repository rules, lessons, and the pluggable infrastructure plan.
- [x] Select rootless Podman as the installed local runtime candidate.
- [x] Implement an owned, bounded canary with a JSON receipt.
- [x] Prove filesystem persistence, process execution, restart, isolation, and cleanup.
- [x] Read back CPU, memory, PID, and security controls from the created container.
- [x] Reject `linux-exec.v1` when any mandatory control is absent.
- [x] Reject `persistent-web-compose.v1` unless isolated nesting and outer resource controls are proven.
- [x] Prove a controlled missing control changes a passing canary to a rejection.
- [x] Run the final integrated probe under the shared heavy-run lock.
- [x] Document exact scope, commands, results, and unsupported claims.
- [x] Review the diff and commit the scoped deliverable.

## Review

Static validation passed: Python compilation, shell syntax, and `git diff --check`.

The integrated suite passed under `/tmp/ezcorp-validation-heavy.lock`. It ran a passing canary, a controlled missing-CPU rejection, a passing `linux-exec.v1` qualification, and a fail-closed Compose rejection. Every run verified owned-resource cleanup.
