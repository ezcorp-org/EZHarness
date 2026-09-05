# Extension cutover test mapping

These legacy suites tested host-imported metadata and automatic permission
changes. Version 4 removes that behavior rather than granting it another route.
No test is skipped. The replacements exercise the new boundary explicitly.

| Retired suite | Preserved or changed invariant | Executable replacement |
| --- | --- | --- |
| bundled-user-disabled | User-disabled state is preserved. Automatic repair of other disabled rows is intentionally forbidden. Critical extensions have no exemption. | bundled-v4-bootstrap: six named ask-user/task-tracking/scratchpad disable cases; legacy revocation is idempotent |
| bundled-critical-s9 | Critical version changes cannot grant access or enable execution; user choice remains unchanged. Automatic metadata convergence is replaced with a separate immutable workspace. | bundled-v4-bootstrap: six critical/ordinary disable cases; source change creates a workspace; approved active release remains unchanged |
| bundled-critical-s9-ceiling-exceeds | New authority never activates without exact human approval, whether below or above a former ceiling. | bundled-v4-bootstrap: six capability-change cases; extension-lifecycle-service: exact declared grants and human administrator authorization |
| bundled-grant-event-subscriptions | Startup cannot backfill, union, preserve stale legacy grants, or silently remove active release grants. A changed subscription is a new candidate. | bundled-v4-bootstrap: eventSubscriptions source-change case; stale capability revocation once; exact snapshot/build-key reuse |
| bundled-grant-reconcile-drafts | Extension authoring authority is no longer handed to a child through custom.drafts. Legacy stale authority is revoked once; unchanged approved releases retain their own grants. | bundled-v4-bootstrap: custom.drafts source-change case; stale capability revocation; extension-control tests for host workspace/build/approval boundaries |
| bundled-phase5-clamp | Startup no longer silently narrows declarations and activates a different grant set. Candidates preserve source; exact grants require a human decision. | bundled-v4-bootstrap: storage/network/shell/env source-change cases; extension-lifecycle-service exact-grant mismatch test |

Pure permission-ceiling, source hashing, grant-diff, path containment, and
release-policy tests remain. Runtime feature parity is checked separately by
the sealed first-party candidate suite; these bootstrap tests do not claim it.

The former reopen suite's owner, modifiable, bundled, ID lookup, and complete
source invariants now run against real PGlite and the immutable blob store in
reopen-extension.test.ts. Missing source refuses a partial workspace. Reopen
cannot copy host files, execute configuration, approve, or activate a release.
