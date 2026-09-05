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
| ai-kit/ez-code/scratchpad/ez-factory bundled-install integration blocks | First-party registration and operator opt-out remain. Startup cannot create enabled projection rows, inject credentials, re-enable disabled rows, or mutate an approved manifest in place. | bundled-source-registration checks every bundled name and exact reviewed path plus opt-out; bundled-v4-bootstrap checks disable/idempotency/grant invariants; source extension.test.ts and sealed candidate suite check actual declared tools and contributions |

Pure permission-ceiling, source hashing, grant-diff, path containment, and
release-policy tests remain. Runtime feature parity is checked separately by
the sealed first-party candidate suite; these bootstrap tests do not claim it.

Disk-based drift healing has no production callers and is removed, not renamed.
The eight manifest-drift-event-subscriptions cases now run in
bundled-v4-bootstrap as the subscription candidate matrix. Additions, removals,
overlap, missing and empty declarations preserve approved grants, store the
exact new snapshot, and reuse the same build identity on the next boot.
The former bundled-drift-reapprove suite's grant-order and declaration-only
comparisons remain covered by bundled-ceiling.test.ts canonicalization tests.
Exact human approval, stale policy, generation races, immutable release records,
and corrupt source refusal run in extensions/v4/lifecycle.test.ts and
extension-lifecycle-service.test.ts. Startup can no longer bypass those checks
by rewriting a projection grant or swallowing an audit failure.

bundled-drift-disable-idempotent and bundled-refresh-code-change-invalidation
now map to the bootstrap's once-only legacy revocation, unreadable source,
source-change workspace, and active-release preservation cases. A changed
checkout does not kill an approved immutable release or silently rewrite its
description. The new candidate has separate identity and approval.

bundled-phase5-integration now maps to bundled-source-lock.test.ts (all 50
snapshot hashes and determinism), collector containment tests, and lifecycle
blob-tampering/approval checks. A source lock does not itself grant execution.

The former reopen suite's owner, modifiable, bundled, ID lookup, and complete
source invariants now run against real PGlite and the immutable blob store in
reopen-extension.test.ts. Missing source refuses a partial workspace. Reopen
cannot copy host files, execute configuration, approve, or activate a release.

## Installer replacement

The retired installer, installer-coverage, installer-v2,
installer-preloaded-manifest, installer-deputy-flag,
installer-idempotent-local, installer-tool-list-drift, and
ts-manifest-installer-gaps suites invoked the removed direct installer.
Their replacement is not merely its rejection test:

- installer-v4-cutover tests every legacy entrypoint, preloaded executable
  metadata, caller/bundled flags, malformed canonical metadata, name boundaries,
  and deputy declarations without automatic grants.
- source-import-staging tests actual filesystem collection and local, registered
  project, bundled, and scoped GitHub import orchestration. It checks all human
  account gates, symlink/relative/outside-root refusal, complete source snapshots,
  secret exclusion, host-written provenance, revision/build identity, and failure
  without activation. import-wired-e2e checks real database workspace persistence.
- install-source-roots preserves all 13 pure containment and path-portability
  cases from installer-coverage, including empty paths inside an allowed root,
  traversal, near-matches, bundled paths, and registered project roots.
- v4 lifecycle tests cover source and release immutability, idempotency, source
  revision conflicts, exact approval binding, catalog verification, activation,
  registry generation acknowledgement, disable, and uninstall retention.
- Runner dependency tests cover pinned package resolution and integrity instead
  of testing host npm execution or a host cp/git extraction error string.

Direct remote update and arbitrary git clone are not silently emulated. The
supported import surfaces and remaining gaps are recorded in
docs/extensions/v4-imports.md. Uninstall retains source and user data; it never
uses a caller-supplied host path for deletion.

## Orchestration, Task Tracking, and Web Search

Their bundled install suites keep source registration, opt-out behavior, all
tool names, and exact capability declaration checks through actual worker
discovery. Bundled name recognition no longer implies an integrity-check bypass.
The shared bundled-v4-bootstrap suite adds first-boot and legacy-revocation
cases for each of these three extensions. It verifies disabled installations,
empty grants and approvals, preserved installation identity, one source snapshot,
and the same durable build key on later boots. A user-disabled legacy row stays
disabled, and stale grants are revoked once rather than restored.

Storage migration is no longer invoked by host source staging. Release activation
and its transactional migration tests own that boundary. Orchestration remains
storage-free in its discovered manifest; staging cannot run its code or create
extension-owned storage rows.

The old bundled-critical-s9-disk-null suite is replaced by three explicit
critical-source failure cases in bundled-v4-bootstrap. An actual collector
exception must occur, legacy execution and grants must be revoked, and no
workspace, build, or approval may be created. There is no critical auto-approval
branch or third host config evaluation to reach in v4.

The web-search grant-reconcile suite keeps both real search-handler boundary
cases: absent grant denies and an explicit search grant permits the injected
provider. Its automatic-backfill cases move to the web-search revocation and
idempotency cases above, plus a source-change case that proves search cannot
widen a current release's grants. No boot path may restore search, network,
or credential permissions without exact human release approval.

Authored-install-auto-modifiable moves to real immutable reopen tests. Unset,
false, true, and string-valued old settings all permit the owner to fork, edit,
and queue a candidate while preserving active code, grants, release history,
and the stored false flag. Bundled owners can also prepare a candidate; foreign
actors, mismatched lifecycle owners, and uninstall remain opaque refusals.
Production authorization tests retain human-admin approval and scope checks.

Bundled-v2-tools-hash-shape now proves v2/v3 metadata cannot be promoted on the
host, canonical v4 hashes are independent of object key order, and an added tool
is refused by actual candidate discovery verification. Automatic manifest refresh
and re-enable are retired; existing lifecycle tests bind human approval to the
exact immutable release rather than a mutable stored tool-array shape.
