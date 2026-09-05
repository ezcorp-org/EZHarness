# Extension cutover test mapping

## Library control follow-up

`web/e2e/extensions-install-gate.spec.ts` now exercises source admission in
the rendered import page: a host-credential refusal is shown verbatim, the
form becomes usable again, and no installation card or activation appears.
The positive control submits an exact local source request without grants
and hands off to the exact candidate workspace for review. These are controlled
API fixtures, not a claim that the old blanket `*_API_KEY` rule still applies.
Version 4 uses declared, approved opaque credential handles. Real source import,
credential access, and approval boundaries have separate server and real-auth tests.

`web/e2e/toast-notifications.spec.ts` preserves the failed-install alert through
the supported MCP candidate endpoint. Its completion, error, dismissal, and
severity checks now use the actual runtime SSE stream, not the removed WebSocket
transport, and wait for the current sidebar link instead of a retired heading.

`web/e2e/real-auth/extension-author-flow.spec.ts` verifies that an approved
installation appears without the virtual native-tool row, the owner can prepare
and save a revision without the legacy modifiable flag, and the active release
ID and generation stay unchanged. List and detail component tests keep MCP
staging and legacy-only modification controls covered.

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

The former bundled-boot-spawn-real-process suite started a persistent host
subprocess. Its delivery and reverse-RPC cases now run in
lessons-distiller-host-integration against actual rootless workers and SQL.
Startup creates no resident worker. A queued event starts one worker, waits for
host RPC wiring, and resolves the conversation owner's settings. Restarting the
delivery service does not replay the first event; the next event starts one new
worker. The same suite checks real tool history and persisted lessons.

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

Substack-pilot installer coverage now builds the real source in the isolated
runner, checks sealed hashes and all three settings, and publishes the exact
release only after human approval. Entity seeds use the sealed artifact files.
Both credential-shaped and benign Substack environment names are refused by
the actual credential broker without invoking a host credential resolver.
Settings remain available; v4 does not expose arbitrary host environment values.
The chat suite retains the full seven-tool catalog and three-step draft flow
through the real executor and release adapter, with a controlled runner response
fixture. It additionally checks the owner identity and exact invocation inputs.
# Authoring reference tests

`ext-jail-bringup.test.ts` now builds and discovers github-projects,
task-tracking and graded-card-scanner through the sealed rootless runner. Its
negative control checks that both build and execution cannot read a host data
canary. It no longer treats the retired preload path as production isolation.
Auto-note's subprocess fixture now uses SQL-backed invocation locks and retains
all 13 file, settings, lifecycle, framing and category assertions.

`ext-docs-validation.test.ts` now checks the actual v4 control tools, immutable revision and approval rules, canonical schema links, and shared scaffold files. All 84 test cases remain, with 114 assertions. Legacy installed-binary commands, v2 manifest promotion, and minimum Markdown line counts are replaced by the current behavioral contract. The executable scaffold is inspected directly, rather than copying its manifest into another documentation template. Internal links and retained first-party example checks still run.

## Final gate-integrity review: 84 findings

Review baseline: `bb19b8be7a6669f61e41e4e9baa3658026e87b8a`.
Reviewed parent: `a81cf4d5`; error-invariant follow-up: `eea627eb`.
Input: `/tmp/ez-gate-integrity-final1.log`.
There are **1 removed threshold, 27 deleted paths, 25 renamed paths and 31
condensed files**. All 84 have a disposition below. This is source-level
traceability, not a new full-suite pass or proof of complete legacy parity.

**The policy gate remains red until a maintainer approves the deliberate gate
changes.** This document does not set `GATE_CHANGE_APPROVED`, change thresholds,
or treat a missing feature as tested. The numbered choices below require an
explicit cutover decision.

### Proof references

- **B — Bootstrap and source identity:** `src/__tests__/bundled-v4-bootstrap.test.ts`
  has the critical/ordinary disable matrix, all eight subscription cases,
  per-capability source changes, unreadable source, preserved creator, unchanged
  approved release and durable build reuse. `src/__tests__/bundled-source-lock.test.ts`
  checks the 50 exact source snapshots and determinism;
  `src/__tests__/bundled-source-registration.test.ts` checks registered paths
  and opt-outs. `src/__tests__/bundled-ceiling.test.ts` and
  `src/__tests__/bundled-v2-tools-hash-shape.test.ts` retain canonical grant/hash
  checks and reject host promotion.
- **L — Actual lifecycle boundaries:** `src/extensions/v4/lifecycle.test.ts`
  includes cross-user/scope denial, builder cannot approve, exact-release
  binding, audit rollback, stale policy, pointer races, lost acknowledgement,
  immutable records, disable/uninstall retention and rollback with fresh consent.
  `src/extensions/extension-lifecycle-service.test.ts` explicitly rejects
  missing/extra grants, inactive owners and namespace takeover. These tests
  replace mutation of live grants; they do not test configurable grant TTL.
- **I — Supported source and CLI:** `src/extensions/__tests__/source-import-staging.test.ts`
  covers actual collection, account gates, unknown authority fields, containment,
  complete source and no implicit activation. `src/extensions/__tests__/source-adoption.test.ts`
  covers explicit owner-bound upgrade adoption. `src/__tests__/install-source-roots.test.ts`
  retains 13 path cases. `src/extensions/__tests__/installer-v4-cutover.test.ts` proves legacy
  entrypoints/preloaded metadata cannot execute or approve. `src/extensions/__tests__/cli-control.test.ts`
  covers exclusive scaffold and isolated validation; `src/__tests__/git-install.test.ts`
  exercises supported GitHub admission and lifecycle activation rather than host cloning.
- **A — Host authoring:** `src/extensions/__tests__/extension-control.test.ts`
  tests create/fork/list/read/revision edits/build/inspect, strict inputs and no
  approval tool. `src/__tests__/reopen-extension.test.ts` checks owner-bound
  immutable forks with actual SQL/blob state. `web/src/__tests__/extension-control-routes.server.test.ts`
  and `web/src/__tests__/extension-control-actor.server.test.ts` check trusted
  actor construction and human consent. `web/src/__tests__/extension-author-page.component.test.ts`
  tests revision save-before-build, stale saves, editor changes, traversal,
  unsaved state, binary files, explicit review, rejection and activation.
  `web/src/__tests__/extension-author-page-server-load.server.test.ts` covers scoped loading.
- **D — Definition and isolation:** `src/__tests__/ts-manifest-e2e.test.ts`
  checks contribution data and rejects executable metadata;
  `src/__tests__/ts-manifest-integration.test.ts` compiles and serves actual
  generated source in the isolated runner. Each migrated `extension.test.ts`
  imports its real entrypoint and asserts its discovered definition.
  `packages/@ezcorp/sdk/src/v4/serve.test.ts` checks framed transport, malformed
  input, schemas, cancellation and host errors. `packages/@ezcorp/sdk/src/v4/runtime.test.ts`
  checks invocation-only effects and registration failures.
  `src/__tests__/marketplace-release-isolation.integration.test.ts` covers sealed
  publication and rebuild, not mutable legacy marketplace metadata.
- **V — Verification:** `src/extensions/extension-lifecycle-service.test.ts`
  covers expected smoke error/success, literal text assertions, catalog mismatch,
  schema-invalid output, separate verification identity and worker cleanup.
  `src/extensions/candidate-verification-broker.test.ts` tests actual scoped
  filesystem/storage/network handlers, fixture-only credentials and honest
  unexercised evidence. `src/__tests__/ext-verify-cli-and-foldin.test.ts` verifies
  isolated CLI evidence and failure exit. Missing smoke on a metadata-only release
  does not cause an invented invocation; feature tests and sealed catalog still apply.
- **M — MCP staging:** `web/src/__tests__/helpers/mcp-stage-route-tests.ts`
  runs for each install/update/refresh route, not merely a shared uncalled helper.
  It tests authentication, denied keys, validation/size limits, exact actor,
  candidate-only response, conflicts, safe errors and no legacy client.
  `src/__tests__/mcp-api-routes.test.ts` adds real guarded target/probe behavior.
  `src/extensions/__tests__/mcp-control.test.ts` checks unchanged active
  connection and no credential carry to another origin;
  `src/extensions/__tests__/mcp-workspace-credentials.test.ts` checks encrypted,
  immutable, scope-bound credentials. L covers consent/publication audit
  transactions. A refresh no longer edits the active tools before review.
- **P — Lazy delivery:** `src/__tests__/lessons-distiller-host-integration.test.ts`
  replaces boot-process tests with rootless event delivery, actual SQL settings,
  history/lessons and restart behavior. No assertion of permanent process identity remains.
- **R — Required discovery:** `scripts/lib/test-file-sets.sh` includes
  `find src -name "*.test.ts"` in pass/fail and coverage sets. The moved
  `src/extensions/first-party-integration/**` files do not match its two narrow
  integration exclusions. All 25 rename pairs retain every test title and
  assertion semantics; the four changed assertion strings in ez-factory
  workflow tests only add TypeScript non-null assertions. Moving suites outside
  extension build snapshots does not remove them from required host tests.

### Explicit cutover choices, not equivalent proof

1. **C1 — Development watcher:** the unsafe host hot-reload path is retired.
   Isolated CLI build/verify exists, but no automatic watcher/debounce/reload or
   equivalent development-session shutdown workflow is proved. Keep this
   ergonomic loss visible; refusal is not watch-feature coverage.
2. **C2 — Visual permission composition:** source editing and full exact-release
   review replace inline draft composition and mutable capability toggles.
   The deleted composition-panel integration test has no equivalent visual
   toggle/save flow in v4. Component tests prove the new editor, not that old UI.
3. **C3 — Configurable grant expiry:** legacy expiry utilities and expired-grant
   banner tests remain, but v4 approval/grant issuance does not provide the old
   per-capability TTL/Never renewal options. Lifecycle grants are exact permission
   identifiers, not TTL-bearing grant records. Finite invocation deadlines,
   approval revocation and policy revalidation are different controls.
4. **C4 — Retention:** discard/purge and destructive draft consumption are replaced
   by immutable workspace/release history and retained user data. Removal and
   uninstall tests must not be presented as proof of an explicit purge feature.
5. **C5 — Import/update breadth:** generic non-GitHub Git remotes and automatic
   remote updates are not implemented. Supported exact GitHub/marketplace/local
   imports are tested. See `docs/extensions/v4-imports.md`; no claim of complete
   source-format parity follows from the fail-closed legacy adapters.
6. **C6 — Unsupported executable metadata:** host lifecycle scripts such as
   `preuninstall` are not preserved as host execution. The old orchestrator
   `subAgents` array was not consumed by the host; supported agent prompt
   guidance is retained. This is not proof of running two legacy child agents.

Two still-valid error invariants were weaker after migration: exact delegated
error text and no second delegation after a failed read. Follow-up
`eea627eb` restores these in code-quality and code-review-delegator tests.
The focused real-handler cohort passes **10 tests / 33 assertions** and the
source lock check passes. No other source or test change is implied by this ledger.

### Complete finding ledger

| # | Gate classification | Original path | Disposition and existing proof |
| --- | --- | --- | --- |
| 1 | Threshold | `src/extensions/bundled-drift-reapprove.ts` | Retired source, not an uncovered replacement. B, L: canonical grant comparison, exact human consent, stale policy and atomic audit rollback replace mutable disk healing. |
| 2 | Deleted | `docs/extensions/examples/auto-note/e2e-server-pipeline.test.ts` | Moved and adapted to `src/extensions/first-party-integration/auto-note/e2e-server-pipeline.test.ts`: seven sequential/concurrent capture, lifecycle framing/state and malformed-input cases use isolated workers. |
| 3 | Deleted | `docs/extensions/examples/docs-updater/subprocess.integration.test.ts` | Moved and adapted to `src/extensions/first-party-integration/docs-updater/subprocess.integration.test.ts`: real git read, one agent spawn and deferred cursor through isolated execution. |
| 4 | Deleted | `docs/extensions/examples/extension-author/e2e-server-pipeline.test.ts` | A, I and V replace child draft CRUD/install with host workspace/scaffold, strict source inputs, ownership, revision, isolated build and exact review. Current diagnostic smoke runs rootless. C2/C4 record composition/discard changes. |
| 5 | Deleted | `docs/extensions/examples/github-stats/e2e-server-pipeline.test.ts` | Moved and adapted to `src/extensions/first-party-integration/github-stats/e2e-server-pipeline.test.ts`: three tool denial cases plus unknown tool recovery, sequential/concurrent calls and no disable after five tool errors. |
| 6 | Deleted | `docs/extensions/examples/repo-activity-notify/index.integration.test.ts` | Moved and adapted to `src/extensions/first-party-integration/repo-activity-notify/index.integration.test.ts`: real commit produces one append/persist; unchanged commit is declined. |
| 7 | Deleted | `src/__tests__/bundled-boot-spawn-real-process.test.ts` | P: actual rootless lessons delivery, reverse RPC, owner settings, restart and subsequent delivery. A resident host process is intentionally replaced by lazy workers. |
| 8 | Deleted | `src/__tests__/bundled-critical-s9-ceiling-exceeds.test.ts` | B capability-change matrix and L exact-grant mismatch: no critical exception or silent grant narrowing. |
| 9 | Deleted | `src/__tests__/bundled-critical-s9-disk-null.test.ts` | B three unreadable critical-source cases: revoke legacy authority, no candidate/build/approval on collection failure. |
| 10 | Deleted | `src/__tests__/bundled-critical-s9.test.ts` | B critical/ordinary and user-disabled matrix: preserve disabled choice and approved release; source changes create candidates. Automatic acceptance is retired. |
| 11 | Deleted | `src/__tests__/bundled-drift-disable-idempotent.test.ts` | B once-only revocation, user-disable preservation, source snapshot reuse. Mutable description refresh and repeated warning wording are not v4 operations. |
| 12 | Deleted | `src/__tests__/bundled-drift-reapprove.test.ts` | B and L: canonical comparisons, immutable source, exact review, races and audit rollback. Audit failure must now roll back rather than be swallowed. |
| 13 | Deleted | `src/__tests__/bundled-grant-event-subscriptions.test.ts` | B subscription matrix: additions, removals, overlap and absent declarations cannot alter approved grants. Automatic union/backfill is retired. |
| 14 | Deleted | `src/__tests__/bundled-grant-reconcile-drafts.test.ts` | B custom.drafts and stale-grant cases; A host-only workspace controls. No child receives authoring authority. |
| 15 | Deleted | `src/__tests__/bundled-phase5-clamp.test.ts` | B capability matrix and L exact grant checks replace automatic ceiling-clamped activation. |
| 16 | Deleted | `src/__tests__/bundled-phase5-integration.test.ts` | B source-lock determinism/all-50 inventory, source containment and L blob tamper/approval binding. Host configuration imports are refused. |
| 17 | Deleted | `src/__tests__/bundled-refresh-code-change-invalidation.test.ts` | B source-change and unreadable-source cases. Active immutable code is unchanged; no killing/reloading it from mutable checkout edits. |
| 18 | Deleted | `src/__tests__/bundled-user-disabled.test.ts` | B six critical/ordinary disable cases and idempotent legacy revocation. Non-user-disabled legacy rows are not automatically repaired. |
| 19 | Deleted | `src/__tests__/installer-coverage.test.ts` | I local/GitHub staging and all 13 extracted containment cases; L immutable release/uninstall. Arbitrary Git/update and purge are explicit choices C4/C5. |
| 20 | Deleted | `src/__tests__/installer-deputy-flag.test.ts` | I installer-v4-cutover checks deputy declarations without grants; L exact declared authority and no caller-approved shortcut. |
| 21 | Deleted | `src/__tests__/installer-idempotent-local.test.ts` | I source import/adoption preserves IDs and active release; B snapshot/build reuse; L revision and activation fencing. No mutable in-place refresh. |
| 22 | Deleted | `src/__tests__/installer-preloaded-manifest.test.ts` | I preloaded executable metadata refusal plus real collected-source staging; metadata must be produced in isolation, never trusted from a caller. |
| 23 | Deleted | `src/__tests__/installer-tool-list-drift.test.ts` | B canonical tool hash/presentation tests; L catalog mismatch and exact immutable release binding. Checkout drift creates a candidate, not an active mutation. |
| 24 | Deleted | `src/__tests__/installer-v2.test.ts` | I malformed/name/deputy tests; D canonical data manifests and immutable marketplace release tests. Automatic v2 promotion and old module-import topology assertions are retired. |
| 25 | Deleted | `src/__tests__/installer.test.ts` | I canonical name boundaries and actual local/GitHub staging; pinned runner dependencies replace host cp/npm. C5 records unsupported generic Git/update. |
| 26 | Deleted | `src/__tests__/manifest-drift-event-subscriptions.test.ts` | B eight subscription candidate cases preserve approved grants and exact new snapshot/build identity; no grant healing. |
| 27 | Deleted | `src/__tests__/ts-manifest-installer-gaps.test.ts` | I source collection and D isolated config discovery/rejection; nested explicit GitHub directory and missing entrypoint checks replace host findManifest/checkout imports. |
| 28 | Moved | `packages/@ezcorp/ai-kit/test/e2e/bundled.test.ts` | Moved to `src/extensions/first-party-integration/ai-kit/e2e/bundled.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 29 | Moved | `packages/@ezcorp/ai-kit/test/e2e/doctor.test.ts` | Moved to `src/extensions/first-party-integration/ai-kit/e2e/doctor.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 30 | Moved | `packages/@ezcorp/ai-kit/test/e2e/fanout.test.ts` | Moved to `src/extensions/first-party-integration/ai-kit/e2e/fanout.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 31 | Moved | `packages/@ezcorp/ai-kit/test/e2e/internal-auth.test.ts` | Moved to `src/extensions/first-party-integration/ai-kit/e2e/internal-auth.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 32 | Moved | `packages/@ezcorp/ai-kit/test/e2e/on-behalf-of.test.ts` | Moved to `src/extensions/first-party-integration/ai-kit/e2e/on-behalf-of.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 33 | Moved | `packages/@ezcorp/ai-kit/test/e2e/quickstart.test.ts` | Moved to `src/extensions/first-party-integration/ai-kit/e2e/quickstart.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 34 | Moved | `packages/@ezcorp/ai-kit/test/e2e/real-subprocess-obo.test.ts` | Moved to `src/extensions/first-party-integration/ai-kit/e2e/real-subprocess-obo.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 35 | Moved | `packages/@ezcorp/ai-kit/test/unit/events.test.ts` | Moved to `src/extensions/first-party-integration/ai-kit/unit/events.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 36 | Moved | `docs/extensions/examples/docs-updater/index.integration.test.ts` | Moved to `src/extensions/first-party-integration/docs-updater/index.integration.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 37 | Moved | `extensions/ez-factory/__tests__/unattended-fire-e2e.test.ts` | Moved to `src/extensions/first-party-integration/ez-factory/__tests__/unattended-fire-e2e.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 38 | Moved | `extensions/ez-factory/lib/sanitize.test.ts` | Moved to `src/extensions/first-party-integration/ez-factory/lib/sanitize.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 39 | Moved | `extensions/ez-factory/workflow-templates.test.ts` | Moved to `src/extensions/first-party-integration/ez-factory/workflow-templates.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 40 | Moved | `docs/extensions/examples/file-organizer/index.test.ts` | Moved to `src/extensions/first-party-integration/file-organizer/index.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 41 | Moved | `docs/extensions/examples/file-organizer/lib/page.test.ts` | Moved to `src/extensions/first-party-integration/file-organizer/lib/page.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 42 | Moved | `docs/extensions/examples/sample-loop/index.integration.test.ts` | Moved to `src/extensions/first-party-integration/sample-loop/index.integration.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 43 | Moved | `docs/extensions/examples/sample-loop/try-loop.test.ts` | Moved to `src/extensions/first-party-integration/sample-loop/try-loop.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 44 | Moved | `docs/extensions/examples/seo-watcher/subprocess.integration.test.ts` | Moved to `src/extensions/first-party-integration/seo-watcher/subprocess.integration.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 45 | Moved | `docs/extensions/examples/substack-pilot/tests/install-gate.test.ts` | Moved to `src/extensions/first-party-integration/substack-pilot/tests/install-gate.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 46 | Moved | `docs/extensions/examples/substack-pilot/tests/permissions.test.ts` | Moved to `src/extensions/first-party-integration/substack-pilot/tests/permissions.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 47 | Moved | `docs/extensions/examples/task-stack/e2e-server-pipeline.test.ts` | Moved to `src/extensions/first-party-integration/task-stack/e2e-server-pipeline.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 48 | Moved | `docs/extensions/examples/task-stack/sandbox-load.test.ts` | Moved to `src/extensions/first-party-integration/task-stack/sandbox-load.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 49 | Moved | `docs/extensions/examples/todo-tracker/e2e-server-pipeline.test.ts` | Moved to `src/extensions/first-party-integration/todo-tracker/e2e-server-pipeline.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 50 | Moved | `docs/extensions/examples/todo-tracker/sandbox-load.test.ts` | Moved to `src/extensions/first-party-integration/todo-tracker/sandbox-load.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 51 | Moved | `docs/extensions/examples/web-search/e2e-server-pipeline.test.ts` | Moved to `src/extensions/first-party-integration/web-search/e2e-server-pipeline.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 52 | Moved | `docs/extensions/examples/webhook-ticket-loop/subprocess.integration.test.ts` | Moved to `src/extensions/first-party-integration/webhook-ticket-loop/subprocess.integration.test.ts`. All old test titles and assertion semantics remain; fixture/import paths change. Included by required host test discovery (R). |
| 53 | Deleted | `web/src/routes/(app)/extensions/author/__tests__/page.component.test.ts` | A real author editor component tests replace draft saving, but visual composition panel/toggle integration is not retained. Explicit choice C2. |
| 54 | Condensed | `docs/extensions/examples/code-quality/index.test.ts` | Current file tests real handlers, rule results and delegated inputs; review follow-up eea627eb restores exact delegated error/no retry. D shared SDK owns framing/unknown dispatch. Preuninstall declaration is retired, C6. |
| 55 | Condensed | `docs/extensions/examples/code-review-delegator/index.test.ts` | Current file tests chained result/recommendations and optional analysis failure; eea627eb restores exact read error and no second invocation. D owns framing/unknown dispatch. |
| 56 | Condensed | `docs/extensions/examples/extension-author/index.test.ts` | A plus the current migration diagnostic: host workspace/scaffold/owner/revision/build/review replaces child draft RPC. Immutable history replaces discard; C4. |
| 57 | Condensed | `docs/extensions/examples/github-stats/index.test.ts` | Current table covers all three response mappings, 404/403/500, and invocation-broker credentials. Its host integration suite retains all three network-denial/recovery/concurrency cases. |
| 58 | Condensed | `docs/extensions/examples/multi-agent-orchestrator/index.test.ts` | Current manifest test preserves planner/executor instructions and tool references in supported agent prompt. Legacy subAgents was unconsumed metadata, not an executable feature; C6. |
| 59 | Condensed | `extensions/memory-extractor/manifest-load.test.ts` | Current memory tests validate v4 and retain snake_case/negative camelCase assertions; lessons-distiller/extension.test.ts separately validates its own sealed definition. |
| 60 | Condensed | `src/__tests__/ai-kit-bundled-install.test.ts` | Current opt-out tests remain; hostApi scope/no host credentials declaration replaces raw env/localhost grants. B stages disabled; D checks sealed MCP catalog. |
| 61 | Condensed | `src/__tests__/authored-install-auto-modifiable.test.ts` | Current seven refusal/state-preservation cases plus real SQL reopen-extension.test.ts: owner forks regardless of old setting, foreign actors denied, active code/grants preserved. |
| 62 | Condensed | `src/__tests__/bundled-suggest-examples-phantom-drift.test.ts` | Current three pure hash tests retain presentation exclusion, full-source tamper fidelity and tool-add/remove distinction; B replaces mutable manifest refresh. |
| 63 | Condensed | `src/__tests__/define-extension-unit.test.ts` | Current identity/helpers retained; executable config variants prove host non-execution. D proves data/handler separation and isolated validation, instead of stripping executable fields on host. |
| 64 | Condensed | `src/__tests__/ext-dev.test.ts` | Current canary proves no host import, DB write or unsafe hot reload; I CLI isolated validation/scaffold works. Automatic watcher/debounce/shutdown ergonomics are not equivalent: C1. |
| 65 | Condensed | `src/__tests__/extensions-patch-route.test.ts` | Current route tests retain scoped disable/uninstall, malformed input, conflict/no success, missing/legacy refusal and secret redaction. L owns atomic publication and process retirement. |
| 66 | Condensed | `src/__tests__/mcp-api-routes.test.ts` | M: candidate-only connection staging, audit/credential origin checks and redacted errors. Active catalog cannot change during install/update/refresh. |
| 67 | Condensed | `src/__tests__/scratchpad-bundled-install.test.ts` | Current registration/storage-only declarations retained; B covers startup/disable/drift/idempotency. Actual scratchpad-e2e.test.ts uses SQL, isolated build, approval and runtime tool state. |
| 68 | Condensed | `src/__tests__/security/c3-confirm-endpoint.test.ts` | Current retired-route auth/refusal tests plus L/A human approval, exact grants, denied agent/API-key approval and atomic audit. No direct confirmation bypass. |
| 69 | Condensed | `src/__tests__/security/c3-extension-install.test.ts` | Current auth/refusal tests plus I real local/GitHub source admission, no automatic permissions and owner/admin gates. |
| 70 | Condensed | `src/__tests__/security/c4-extension-permissions-grant.test.ts` | Current auth/refusal tests plus L exact declared grants; submit-and-clamp mutable permission overrides are intentionally replaced by full release review. |
| 71 | Condensed | `src/__tests__/ts-manifest-sdk-gaps.test.ts` | Current config/JSON canaries refuse host evaluation; D isolated manifest and handler validation, I isolated CLI validation cover supported path. |
| 72 | Condensed | `src/__tests__/verify-extension.test.ts` | Current legacy refusal plus V real candidate verification: smoke success/error/text mismatch, changed catalog, schema-invalid output, no invented smoke, worker close. |
| 73 | Condensed | `src/__tests__/web-search-bundled-install.test.ts` | Current sealed discovery checks tool names and search-only declaration; B disabled staging, no backfill or timestamp fabrication. |
| 74 | Condensed | `src/__tests__/web-search-search-grant-reconcile.test.ts` | Current real search handler denies absent grant and permits explicit grant; B source/legacy-revocation matrix replaces grant restoration. |
| 75 | Condensed | `web/src/__tests__/api-extensions-id-permissions.server.test.ts` | Current retired-route auth/refusal plus L exact grants and A human consent. Mutable per-capability quota/disable controls are not represented as retained UI: C2/C3. |
| 76 | Condensed | `web/src/__tests__/api-extensions-id-reapprove-drift.server.test.ts` | Current retired GET/POST refusal matrix plus B source-integrity and L exact human approval. No live disk preview/heal authority. |
| 77 | Condensed | `web/src/__tests__/api-mcp-servers-id-put.server.test.ts` | M shared route matrix runs for update; origin-change credential non-transfer and encrypted workspace binding replace active secret merge. |
| 78 | Condensed | `web/src/__tests__/api-mcp-servers-id-refresh.server.test.ts` | M shared route matrix runs for refresh; redacted errors, actor gates and candidate-only catalog. L audit failures now roll back instead of degrade silently. |
| 79 | Condensed | `web/src/__tests__/api-mcp-servers.server.test.ts` | M shared route matrix runs for install; validation, size bound, auth, uniform error redaction and no legacy client/spawn. |
| 80 | Condensed | `web/src/__tests__/cap-expiry-flow.server.test.ts` | Current expired-grant banner/auth/404 assertions remain; renewal route refuses. L release approval is not configurable per-capability renewal; C3 is an issuance gap. |
| 81 | Condensed | `web/src/__tests__/extension-author-install.server.test.ts` | Current canary/auth/refusal tests plus A/I/V supported workspace/build/review path; D dependency validation. No child install, config evaluation, moved directory or skipped skill verification. |
| 82 | Condensed | `web/src/__tests__/extension-author-page-logic.server.test.ts` | Current safe filename/prefill tests remain; A editor and server load, V validation failures and revision rebuilding replace host draft verification. |
| 83 | Condensed | `web/src/__tests__/extensions-api.test.ts` | Current list/read/auth/redaction, lifecycle disable/uninstall and refusal matrix; I supported source import; L exact approval replaces direct enable, mutable clamping and bundled allowlist activation. C4/C5. |
| 84 | Condensed | `web/src/__tests__/extensions-reapprove-route.server.test.ts` | Current refusal and MCP-secret redaction plus L exact release approval. No retained custom TTL/Never issuance: C3. |
