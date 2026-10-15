# Composable factory platform: plan review

Date: 2026-09-12. Initial result: **changes required**. Resolution: **all 11 planning findings addressed** in the revised plan and its [launch contracts](2026-09-12-composable-factory-platform-contracts.md). Implementation proofs remain **not run**.

The [resolution map](2026-09-12-composable-factory-platform.md#16-review-resolution-map) links each finding to its normative contract and required stage proof. The text below is the initial review, preserved for context. Its line numbers and plan hash describe the original 420-line revision, not the amended plan.

The [plan](2026-09-12-composable-factory-platform.md) is a sound architecture outline. It is not yet a complete implementation contract. This review found **11 gaps: six P1 and five P2**. P1 means a missing decision can undermine a core safety or recovery promise. P2 means the expected behavior or proof is too open to verify completion. Close each gap before its dependent stage.

These are gaps in the plan, not reproduced defects in a factory implementation. The factory platform does not exist yet. Failure examples below are proposed tests, not test results.

Reviewed all 420 lines against repository base `93598600a17aab127fe69471343313c6a2130bd4`, relevant current code, repository test rules, and primary product documentation. The plan has seven local links; all resolve. Its 15 external links were opened. The plan and unrelated edits were preserved. Its SHA-256 is `74b67b3ed541ddb12af4b02671ea854cacb983600207551ee29ca58277d76471`.

**1. P1 — Define the tenant and authority model before adding factory records.**

Plan: [sections 10–11](2026-09-12-composable-factory-platform.md#10-isolation-packages-and-admission), lines 284–300. The plan requires tenant/project scope and authenticated authority, but does not define a tenant, its membership, or its relation to existing users and projects. It also does not assign rights to author, publish, run, approve, trust validators, or release.

This cannot be inherited without a decision. [AuthUser](../../src/auth/types.ts) has an instance role and no tenant identity. [Projects and project membership](../../src/db/schema.ts) have no tenant field. [Project listing](../../web/src/routes/api/projects/+server.ts) is deliberately instance-wide, and [project role checks](../../src/auth/middleware.ts) allow instance admins to bypass membership. These may be valid legacy rules; they do not define hosted factory tenancy.

**Add:** Choose shared-instance tenancy or isolated harness instances per tenant. Define membership, service principals, tenant-admin versus operator rights, consent-only actions, and object ownership. Map each factory API and subscription to these rules. Define tenant scope for database keys, object references, package grants, credentials, and execution commands. Include the legacy adapter in this boundary.

**Close with:** Two tenants with overlapping resource names, different project memberships, tenant admins, API keys, and service principals. Prove that list/search, live events, artifact downloads, approvals, and legacy calls enforce the chosen boundary. Close before stage 2 storage/API work.

**2. P1 — Specify the Node/Bun worker bridge and durable operation recovery.**

Plan: [section 8](2026-09-12-composable-factory-platform.md#8-agent-and-worker-contracts), lines 225–229; section 11, line 296. A separate Node.js Temporal worker and retained Bun harness are named, but their transport, process ownership, checkpoint protocol, and retry ownership are not.

The harness [shell provider](../../src/providers/shell.ts) uses `Bun.spawn`; the [file provider](../../src/providers/file.ts) uses `Bun.file` and `Bun.write`. Existing [tool persistence](../../src/runtime/stream-chat/subscribe-bridge.ts), lines 349–376, queues records after tool completion. That record path alone cannot provide the required operation-before-effect recovery protocol.

**Add:** Define the authenticated bridge, language-neutral request/result schema, stable operation IDs, workspace snapshot storage, and durable model/tool journal. Define when a result is committed and can be reused. Assign retry control to one layer and map Temporal attempts to product attempts so retries do not multiply. Specify heartbeat timeouts, cancellation acknowledgement, child-process cleanup, and rejection of writes by an expired attempt. Temporal cancellation requires activity cooperation; its TypeScript documentation describes heartbeat delivery and cancellation signals. [Temporal activity timeouts](https://docs.temporal.io/develop/typescript/activities/timeouts).

**Close with:** A real Node → Bun agent → tool journey. Kill each process before and after operation recording; resume on another worker without a local workspace. Prove completed operations are reused, uncertain operations are held for reconciliation, retries remain within bounds, and cancellation reaches the worker. Include a Python worker in contract conformance because Python workers are in launch scope. Close in stage 2.

**3. P1 — Give admission reservations a durable lifecycle.**

Plan: [readiness and admission](2026-09-12-composable-factory-platform.md#readiness-and-admission), line 173; section 7, line 215; section 10, lines 290–292. The resource and budget requirements are clear. The reservation protocol is missing.

A worker can disappear after reservation but before dispatch. Releasing its capacity on a timer can admit replacement work while the old worker still runs; never releasing it can stop progress. A parent that holds the only execution slot while waiting for a child can also deadlock. Stable command IDs do not decide these cases.

**Add:** Define reservation states, atomic acquisition, renewal, expiry, reconciliation, and a worker generation token that prevents an old holder from continuing protected work. Separate budget reservations from active compute slots. Define resource release during approvals and child waits, nested acquisition rules, queue backpressure, and a fairness rule that prevents indefinite tenant starvation. Preserve uncertain charges until usage is reconciled.

**Close with:** Lost dispatch acknowledgements, disconnected workers that keep running, duplicate settlement, a one-slot nested factory, concurrent reservations against one budget, and a continuously busy tenant beside a small tenant. Assert capacity, spending, and eventual progress. Close in stage 2.

**4. P1 — Make release authorization and dispatch one defined concurrency protocol.**

Plan: [release protocol](2026-09-12-composable-factory-platform.md#release-protocol), lines 269–278. Acceptance, revocation, stable identity, receipts, and uncertainty are covered. The ordering between concurrent dispatch, cancellation, revocation, and approval consumption is not.

With only the listed steps, a worker can pass the authority check, pause, and dispatch after a revocation. Two attempts can also enter dispatch before either has a receipt. Stable IDs help only when their uniqueness scope and the adapter's use of them are defined.

**Add:** Specify an atomic dispatch claim bound to the artifact, action, destination, policy revision, and logical release identity. Define request-key scope and reject the same key with a changed request. Decide whether an exact approval authorizes one operation or repeated operations. Define the point after which revocation/cancellation treats the write as in flight. Specify provider idempotency, single-writer enforcement, destination version preconditions where needed, and operator actions for unresolved outcomes. Require all publication-capable tool effects to use this gate; general agent network or filesystem grants must not provide a second publication path.

**Close with:** Concurrent dispatchers; revocation and cancellation immediately before/after the dispatch claim; approval reuse; changed payload under one key; changed destination state; and a provider that commits but loses its response. Close in stage 3.

**5. P1 — Apply package isolation to the full executable lifecycle and name a supported deployment.**

Plan: [section 10](2026-09-12-composable-factory-platform.md#10-isolation-packages-and-admission), lines 284–288. The plan correctly requires real isolation and rejects advisory isolation. It does not select an enforceable worker profile or state where installation, build scripts, TypeScript authoring, and package loading execute.

If installation or compilation executes package code in the control plane, isolating the later task is too late. The existing [sandbox builder](../../src/extensions/sandbox/build-sandbox-argv.ts), lines 140–143, can return an advisory command with no OS isolation. A factory must verify the applied controls, not merely call this shared helper.

**Add:** Choose the supported self-hosted and hosted isolation profiles. Cover fetch/unpack/build/import/execute, candidate test execution, filesystem and network restrictions, resource enforcement, and credential delivery. Keep package code away from the Temporal workflow worker and its service credentials. Define who can access Temporal APIs and its operator UI; these controls require configuration in a self-hosted deployment. [Temporal security](https://docs.temporal.io/self-hosted-guide/security).

Pin executable dependencies as well as the top-level package. Define quarantine/revocation behavior for an installed package or validator still referenced by active runs. Fail closed while retaining required audit bytes.

**Close with:** Malicious install/build hooks, hostile candidate tests, direct control-plane calls, credential access, sandbox fallback, and package revocation during a wait. Run these in both shipped deployment profiles. Specify the profile before stage 2 integration; complete third-party enforcement in stage 4.

**6. P1 — Define how projections and release records survive retention and restore.**

Plan: [sources of truth](2026-09-12-composable-factory-platform.md#4-architecture-and-sources-of-truth), lines 115–117; section 11, line 300; fault scenarios, line 392. Rebuildable projections and evidence retention are required, but the lasting rebuild source and a consistent restore procedure are not.

If completed Temporal history expires and the run projection is lost, preserving artifact/evidence rows alone cannot reconstruct every attempt, selected branch, cost, and execution outcome. Temporal archival is an explicit setup choice. [Temporal archival](https://docs.temporal.io/self-hosted-guide/archival).

Restoring PostgreSQL, Temporal persistence, and object storage to different points can also remove the record of an external release that already happened. Provider lookup cannot recover an operation whose identity was lost unless another retained record supplies it.

**Add:** Choose a durable event journal, retained execution archive, or sufficient snapshots with a defined retention relationship. Specify projection sequence/cursor rules and rebuild behavior. Define a compatible restore point across stores, retention of operation identities and encryption keys, maximum permitted data loss, and a release hold until post-restore reconciliation completes. Keep Temporal as execution authority; the archive is not another scheduler.

**Close with:** Expire normal execution history, remove projections in an isolated test, and rebuild the promised run view. Restore mismatched backup points after a recorded external effect and prove release remains blocked until consistency is restored. Decide the design in stage 2; exercise the full recovery procedure in stage 6.

**7. P2 — Complete the IR's control and value contracts.**

Plan: [compiler](2026-09-12-composable-factory-platform.md#5-factory-ir-authoring-and-compiler), lines 138–146; kernel, lines 179–208. The vocabulary is defined, but several observable decisions are still open: the JSON Schema subset, expression grammar, loop exit predicate and carried inputs, failed branch handling, and the point at which the whole run becomes terminal.

For example, after an ordinary required task exhausts retries, must independent branches finish or be cancelled? After an `any` join wins, when may the parent finish while losing work is still cancelling? Without expected outcomes, replay tests can prove consistent execution of the wrong rule.

**Add:** Publish the schema subset, canonical serialization/digest rules, expression rules, loop input/output rules, and transition tables. Separate run execution state from acceptance/release state as already required. Require actual input and worker-output validation at runtime, with a defined failure result; compatible declared port schemas do not prove that returned values match them. Verify referenced artifact ownership and content before accepting outputs.

**Close with:** Golden definitions and event traces covering each control construct, null/missing values, malformed worker output, retry exhaustion, cancellation cleanup, and loop completion/exhaustion. The compiler, simulator, worker boundary, and editor must consume the same schema contract. Close in stage 1, with boundary enforcement in stage 2.

**8. P2 — Bound workflow payloads and define continuation state.**

Plan: [Temporal constraints](2026-09-12-composable-factory-platform.md#temporal-constraints-that-affect-the-design), lines 84–86; artifact storage, line 257. History limits and external artifact storage are covered. There is no byte budget for the IR, map input, result-reference collections, approval context, or continuation snapshot.

A valid 10,000-node plan can exceed a transport limit before it approaches an event-count limit. Temporal Cloud documents a 2 MB request payload limit and a 4 MB history transaction limit. These are separate constraints from total history size. [Temporal Cloud limits](https://docs.temporal.io/cloud/limits).

**Add:** Set small inline payload limits, load immutable plans through recorded activities, and page large collections. Define the exact state carried across continuation, its schema/version, deduplication horizon, approval routing, and partition thresholds. State how quiescence is reached before limits when approval or child work is still pending. Specify and test limits for the chosen self-hosted configuration too.

**Close with:** Worst-case supported metadata and output sizes, a large map reduction, repeated continuation, and an approval delivered across a continuation boundary. Test serialized bytes and pending commands, not node count alone. Close in stage 2.

**9. P2 — Specify authoring round trips and live-view consistency.**

Plan: [authoring](2026-09-12-composable-factory-platform.md#5-factory-ir-authoring-and-compiler), line 123; [console](2026-09-12-composable-factory-platform.md#11-storage-api-and-product-interface), lines 298–311. The visual editor, imports, and live view are in scope, but their compatibility and concurrent-update rules are missing.

**Add:** Require lossless execution semantics when supported JSON/YAML/SDK definitions pass through the editor. Unknown presentation support must not silently delete execution fields. Define draft revision checks for concurrent saves/publication, run-command responses, and snapshot-plus-cursor recovery for missed or duplicate live events. Define safe preview handling for untrusted artifacts, keyboard access to graph actions, and visible stale/disconnected states.

**Close with:** Import → edit → export → compile comparisons; two editors racing to save; reconnect after missing events; a preview containing active content; and keyboard/browser journeys through nested factories and large maps. Close the contracts before stage 5.

**10. P2 — Turn the three domain examples into concrete launch contracts.**

Plan: [domain packs](2026-09-12-composable-factory-platform.md#12-domain-packs-and-legacy-integration), lines 315–321. The table identifies domains and evidence classes. It does not name each launch adapter, supported input/output format, protected validator configuration, or a reference acceptance contract with actual pass criteria.

A generic mocked “publish” operation could satisfy the current stage wording without proving a production image publication or data export. The code flow also needs a clear contract for which repository state was tested and which exact commit is published.

**Add:** Name at least one supported production input/generation path and release destination per pack. Provide a versioned example definition, protected criteria, representative fixtures, repair bounds, and provider-specific reconciliation rules. Define who establishes the original trusted acceptance contract. State unsupported formats and destinations. Supply one concrete cross-domain composition.

**Close with:** Each pack's real configured path succeeds, rejects a known invalid artifact, repairs a candidate, and reconciles a lost release response. Verify the actual remote receipt and artifact identity. Do not substitute a mocked provider journey for this gate. Complete the contracts before stage 5 implementation.

**11. P2 — Make operational and repository gates capable of rejecting a release.**

Plan: [stage 6](2026-09-12-composable-factory-platform.md#stage-6--hosted-and-self-hosted-operation), lines 362–364; [load and monitoring](2026-09-12-composable-factory-platform.md#load-and-monitoring), lines 404–410. The plan correctly avoids invented capacity claims, but recording measurements does not define acceptable service. A run with extreme admission delay or hours of recovery could still pass the current wording.

**Add:** After an initial measurement phase, freeze a representative workload, hardware/configuration, test duration, executing-versus-waiting mix, minimum throughput, maximum admission/recovery/projection delay, and retention assumptions for the launch gate. Define acceptable restore data loss and recovery duration in line with finding 6. Distinguish ordinary fault recovery from disaster recovery when stating “no lost acknowledged transitions.” Define alert thresholds and the operator action for each alert.

Add explicit build/test/coverage lanes for the new SDK, Node Temporal worker, Python conformance, real Temporal, and deployment smoke tests. Existing [test file sets](../../scripts/lib/test-file-sets.sh) and [typecheck wrapper](../../scripts/typecheck.sh) name existing runners and packages; “repository checks pass” does not itself register a new runtime's tests. Retain the repository's [required checks](../development-lifecycle.md#the-gate-required-checks-on-main) and browser evidence rules.

**Close with:** A recorded load/soak/fault report evaluated against thresholds fixed before the release run. Run a deliberate failing assertion in each new test lane and verify that its required check fails. Install each deployment from clean documented inputs, then exercise upgrade, worker drain, rollback, and restore. Add test lanes with their owning stages; complete operational gates in stage 6.

The existing design choices worth retaining are the pure transition kernel, pinned dependency closure, independent branch progress, separate acceptance and release records, explicit uncertainty, legacy isolation, and full-launch stage gates. The plan's history limits and parent-continuation caution agree with the [Temporal limits](https://docs.temporal.io/workflow-execution/limits) and [child-workflow documentation](https://docs.temporal.io/child-workflows). This review does not provide evidence to reverse the engine choice.

Recommended amendment order: settle tenancy and the IR contract first (1, 7); specify worker recovery, admission, isolation, durable records, and payloads before stage 2 (2, 3, 5, 6, 8); complete the release protocol before stage 3 (4); then freeze product/domain contracts and objective launch gates (9–11). Put these in the plan or linked specifications and map every required proof to a stage.

No product code changed and no factory runtime, load, browser, or recovery tests were run. This review validates documentation and identifies missing proof obligations. The plan refers to an earlier handoff without linking its source; completeness against that external handoff remains outside the verified scope.
