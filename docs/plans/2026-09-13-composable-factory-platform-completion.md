# Composable factory platform completion plan

Date: 2026-09-13. Status: completion plan; implementation and release gates remain open.

Integration baseline: `feat/composable-factory-platform` at `0ba97dc7c`, in `/home/dev/work/EZCorp/EZHarness-worktrees/composable-factory-platform`. Keep the original checkout unchanged. Agent branches are separate worktrees; a passing branch test is not a passing integration test.

This plan completes the [original platform plan](2026-09-12-composable-factory-platform.md) and its [launch contracts](2026-09-12-composable-factory-platform-contracts.md). Those contracts remain the source of protocol details and fixed launch targets. This document adds the missing work, dependency order, ownership, and proof requirements. It does not mark any platform gate complete.

## 1. Completion targets

Deliver two distinct results:

1. **Local milestone:** a working feature in this application, with ten actual tenant installations, local Docker Compose S3, the available AMD GPU, complete supported user journeys, and the local load/fault/soak campaign below. Record any hardware or infrastructure constraint as an unmet criterion, not a successful substitute.
2. **Full launch:** every original F01–F13 proof and all eleven [platform gates](../../tasks/factory/GATES.md) pass on the final release candidate. This still includes the original hosted scale, both deployment profiles, an independent recovery archive, and the specified production GPU isolation profile.

The user selected ten tenants **for initial testing**. This does not remove the later 100-installation target. The user authorized the local GPU and private publication-test repository. It does not establish that this development host meets the production GPU host isolation contract.

## 2. Audited starting point

The integration branch contains substantial compiler/kernel, Temporal transport, storage, encryption, authority, admission, approval, and console work. Several component and PostgreSQL/S3 suites pass. The feature is not yet composed into a complete running application.

| Area | Audited state | Consequence |
| --- | --- | --- |
| Integration | `0ba97dc7c` includes shared GitHub transport; `1ba2b6763` includes provider-verified receipt attachment | Validate the shared transport on the parent; preserve the successful receipt tests |
| Runtime recovery | Terra checkpoint `6c500113a` plus uncommitted fixes passed one real supervisor SIGKILL/attach/cancel case | Commit the exact tested fixes and rerun; that commit alone is not the passing source |
| Recovered result | Agent runtime has a durable launch intent, but recovered `wait()` still refuses to return a terminal result | Finish result recovery and prove no repeated invocation; surviving container recovery is only one boundary |
| Repair/replan controls | Sol checkpoint `3a84d4867` is unmerged; `b6cfa4798` contains a separate coverage-gate correction | Integrate both in order, test with PostgreSQL, wire startup, and add the actual user journey |
| Stop settlement | Sol's uncommitted Phase B has focused PGlite/PostgreSQL and coverage proof | It still needs live-attempt cancellation before a result exists, concurrency/fault tests, host transport, and later usage reconciliation |
| Multi-claim validators | Sol's uncommitted `factory-validator-binding` worktree has a migration/binder and focused PGlite/type proof | Verify old populated PostgreSQL upgrade, schema parity, coverage/static checks, and ordinary-task binding orchestration before integration |
| Acceptance | [Protected command effects](../../src/factory/protected-command-effects.ts) implement successful acceptance | A protected FAIL still needs a durable rejection and bounded remediation path |
| Artifacts | [FactoryArtifacts](../../src/factory/artifacts.ts) and [input artifacts](../../src/factory/input-artifacts.ts) support existing immutable records | Add scoped binary/chunk material operations; terminal JSON cannot carry a 256 MiB data export |
| Publication | [S3 provider](../../src/factory/release-adapters.ts) verifies one immutable object; [GitHub transport](../../src/extensions/project-github-transport.ts) shares the existing broker boundary | GitHub commit/branch/PR publication and multi-object S3 manifest publication remain |
| Startup | [Application](../../src/factory/application.ts) composes HTTP-facing stores; [boot](../../src/factory/boot.ts) checks prerequisites | Compose the required services and durable background work; optional callbacks are not a deployed service |
| Provisioning | [Local provisioner](../../src/factory/provisioning/local.ts) creates database/credential/namespace records and sets `ready` at the invitation step | Separate resource preparation from serving readiness; add deployments, ingress, wrapped keys, and first-admin bootstrap |
| Local infrastructure | [S3](../factory-local-storage.md), [AMD GPU](../factory-local-gpu.md), and [private GitHub target](../factory-local-publication.md) exist | Infrastructure smoke tests do not replace full factory journeys |
| UI | [Authoring console](../../web/src/lib/factory/FactoryConsole.svelte), approval/release inbox, and focused browser tests exist | Complete and test live run inspection, controls, artifacts, and all service-backed journeys |
| CI | [CI](../../.github/workflows/ci.yml) has schema/kernel, Temporal, and runner-readiness jobs | Complete the seven contract lanes, native coverage, browser registration, and actual required-check enforcement |
| Notifications | [Notification delivery](../../src/factory/notification-delivery.ts) feeds the durable in-app view | Implement the outbound webhook/SMTP sender and its actual receiving-service proof |
| Operations | Storage/audit/key primitives and pool fencing exist | Retention, compatible backup/restore, deployment, fleet operations, alerts, and real soak remain separate deliverables |

Existing evidence is under `/tmp/factory-platform-evidence`. The following reports were read for this plan; they are historical source-specific results, not final certification:

- `root-package-outcome-partition-merge-combined-integration-results.json`: combined checks on `57751b80b`.
- `root-protected-effects-parent-combined-integration-results.json`: product, PostgreSQL/S3, build, types, lint, and boundary checks on `84cfd2a99`.
- `root-protected-effects-parent-coverage-results.json`: new-file coverage passed; broader patch coverage failed. Preserve the failure and prove its correction after integration.
- `root-provider-receipt-parent-combined-integration-results.json`: receipt correction passed parent checks on `1ba2b6763`.
- `root-provider-receipt-s3-live.json`: ten tenant publications and verified receipts; forty altered receipts rejected; explicitly records a shared host failure domain.
- `root-github-transport-committed-coverage-results.json`: branch-level patch/new-file checks passed on `bd36bd7fa`; parent checks remain.

W00 must collect later agent checkpoints and correct stale checked items in historical task notes. A checked note without matching source and evidence is not completion.

## 3. Additional gaps and constraints

These items need explicit work beyond the previous status list:

| Gap | Required treatment | Work |
| --- | --- | --- |
| Runtime restart can attach without recovering a result | Journal invocation/result identity and checkpoints; recover without another effect | W01 |
| GPU configuration is host-global in the runtime branch | Carry exact devices from the pool allocation to each start; CPU starts receive no devices | W02 |
| Python conformance currently runs host Python | Build and execute a pinned isolated Python guest through the same contracts | W02 |
| Cancellation receipts lack final production host-key wiring | The supervisor signs only observed physical facts; the gateway verifies before settlement | W03 |
| Stop settlement currently requires a non-success result | Derive live cancellation from exact sealed admission/launch authority; cancellation cannot wait for the worker to return | W03 |
| Unknown usage remains held with no later settlement service | Add trusted usage reconciliation with an idempotent recorded settlement event | W03 |
| Auxiliary artifact writes lack a complete runner API | Bounded, journaled, scoped chunk writes/reads and verified immutable handles | W04 |
| Generic task success can be confused with validator PASS | Typed protected reports, complete provenance, separate validator execution | W05 |
| Reference code repair precedes protected checks and trusts generator `accepted` | Make protected rejection trigger new candidate, freeze, checks, and acceptance within the bound | W06, W10 |
| Git operation IDs contain a colon, which cannot appear in a Git ref | Specify one reversible branch encoding; bind both the operation ID and exact ref in authority/receipt | W07 |
| GitHub repository creation does not establish broker-only refs | Verify selected-repository App permissions and namespace restrictions; distinguish OAuth smoke evidence | W07 |
| Single-object S3 success does not prove dataset publication | Verify all immutable files before conditional final-manifest publication | W08 |
| Startup readiness can be mistaken for configured dependencies | Prove actual process start, admission closure, dependency loss, recovery, and clean teardown | W09 |
| A `ready` provisioning row is not ten running installations | Require live readiness, hostname identity, human bootstrap, and namespace checks | W16 |
| Same-host archive does not survive loss of this host | Test logic locally, then certify a separately credentialed independent failure domain | W15, W19 |
| Publication needs the archive before its first dispatch | Verify the immutable recovery intent and all referenced material before claim; archive the receipt before product settlement | W04a, W07, W08 |
| Existing browser proof does not cover a full factory run | Test actual authentication, execution, SSE, controls, evidence, and publication | W14 |
| Coverage and CI can omit new runtimes or files | Verify source discovery, producer tags, complete lanes, and actual required checks | W18 |
| Temporary reports can disappear or describe older source | Create durable, redacted, checksummed evidence tied to the final candidate | W00, W20 |

Possible startup race: [server context](../../web/src/lib/server/context.ts) sets `initialized` before initialization completes. W09 must reproduce concurrent startup and failed-start retry through the real server before deciding whether a fix is needed. This is an audit lead, not a reproduced defect.

Scheduling audit lead: the [pool ledger](../../src/factory/pool/ledger.ts) combines round membership with weighted service scoring, and its tests name weighted max-min behavior. W03 must compare actual allocation traces with C03's one-feasible-allocation-per-tenant-per-round rule, including multiple persistently queued tenants and unequal weights. Reproduce and correct any divergence; the test name alone does not prove a scheduling defect.

The local AMD probe maps both render devices because the current ROCm setup fails with only the discrete device. An environment variable selecting a GPU is not a device access control. Do not admit hostile packages under that configuration. Keep the development GPU assigned to one trusted local test tenant until isolation is proven; the other installations can run CPU journeys. Cross-tenant GPU reassignment requires actual fencing and a verified reset/reimage path. Do not reimage this development machine as an incidental test action.

## 4. Work order and team

Use the requested Sol and Terra team, with one coordinator and at most four active workers. Keep one owner for each shared file group. Workers must preserve each other's edits. Each work package below needs its own narrow implementation checklist, tests, and review before integration. Reuse the shared v4 lifecycle, executor, queue, credential, blob, and audit modules; do not add parallel implementations.

Every package must extend the C13 import/duplicate-signature boundary inventory for the shared modules it touches, and run that gate before integration. W18 verifies the accumulated inventory; a general instruction to reuse code is not the proof.

Before parallel implementation, record the shared contracts and assign their writers:

| Shared surface | Single writer | Consumers |
| --- | --- | --- |
| SDK validator report, public artifact-reference validation, acceptance events, kernel/reference graph semantics | Sol controls | Artifact, assurance, domain, and UI workers |
| Host launch/attach/stop protocol and per-attempt device contract | Terra runtime | Sol lifecycle and root startup |
| Auxiliary material service, scoped reader, gateway artifact routes | Sol artifacts | Validators, providers, domains, previews |
| Journal outcome/stop/usage validation | Sol lifecycle | Runtime, artifact writer, validators |
| Protected candidate/validator binding and async release-profile interface | Sol assurance | Provider and startup owners |
| Cross-branch migration ordering, final boot composition, evidence merge | Coordinator | Every worker |

W00 records interface decisions; owners then land small shared type checkpoints before dependent behavior. This lets W05 consume the report/event contract without waiting for all of W06, while W06's full remediation proof still depends on W05. Coordinate edits to SDK schemas, the migration registry, `schema.ts`, and test fixtures explicitly. Domain workers submit graph changes through the SDK owner.

| ID | Work package | Suggested owner | Depends on |
| --- | --- | --- | --- |
| W00 | Reconcile source, evidence, and current checkpoints | Coordinator | None |
| W01 | Durable Bun execution and recovery | Terra runtime | W00 |
| W02 | Isolated Python and per-attempt CPU/GPU allocation | Terra runtime | W00, W01 |
| W03 | Physical stop, cancellation, and settlement | Sol lifecycle | W00, W01 |
| W04 | Artifact material and workspace checkpoint transport | Sol artifacts | W00 |
| W04a | Independent archive writer and publication readiness | Terra storage | W00, W04 |
| W05 | Protected validator execution and child provenance | Sol assurance | W01, W03, W04 |
| W06 | Rejection, repair, and replan | Sol controls | W03, W05 |
| W07 | GitHub publication and reconciliation | Coordinator, then free Sol worker | W04, W04a, W05 |
| W08 | S3 manifest publication and reconciliation | Free Terra worker | W04, W04a, W05 |
| W09 | Complete application and service startup | Coordinator | W01, W02, W03, W04, W05, W06, W07, W08 |
| W10 | Real code reference pack | Sol domain | W06, W07, W09 |
| W11 | Real image reference pack | Terra domain | W02, W06, W08, W09 |
| W12 | Real data reference pack | Sol domain | W02, W06, W08, W09 |
| W13 | Composition and legacy integration | Sol lifecycle | W10, W11, W12 |
| W14 | Live console, scoped API, and browser journeys | Sol product | W09, W13 |
| W15 | Retention, compatible backups, and restore | Terra operations | W03, W04, W07, W08, W09, W16 |
| W16 | Complete provisioner and deployment profiles | Terra deployment | W09 |
| W17 | Metrics, alerts, and notification operations | Sol operations | W09, W15, W16 |
| W18 | Complete CI lanes, native coverage, and check enforcement | Free Sol worker | W00, W13, W14, W15, W16, W17 |
| W19 | Ten-installation campaign and remaining launch proofs | Coordinator + both models | W13, W14, W15, W16, W17, W18 |
| W20 | Final regression, evidence audit, and release handoff | Coordinator + independent reviewers | W19 |

Dependencies mean the package's final integration needs those results. Interface work, fixtures, image preparation, deployment templates, and CI registration can start sooner on frozen contracts. W01 can prove an initial recovery case with the existing artifact store; W04 then provides the complete binary/workspace path. This avoids a circular dependency.

W02's component gate supplies the runner images, device contract, supported-host tests, and readiness denials needed by W09. Certification of both completed deployment profiles and the production GPU fleet runs in W19 after W16; it is not a prerequisite for constructing W09. W18 starts its framework/registration work after W00, but its final seven-lane/enforcement gate follows W13–W17. W15 can build backup logic earlier, but its deployed restore proof follows W16. These are separate component and certification checks, not waived requirements.

Execution waves:

1. W00; then W01, W04, W18 in parallel, followed by W04a's archive prerequisite. Integrate the existing controls checkpoint and its gate fix without starting the later remediation rewrite early.
2. W02, W03, W05, W06 as their inputs become available. The coordinator develops W07; a free worker develops W08. Their production dispatch proofs require W04a first. Start W09 composition against agreed interfaces, then certify it after all dependencies pass.
3. W10–W12 in parallel; W13 follows. W14 can build run views earlier, but its complete browser proof follows W13. Start W15–W17 once startup works.
4. W19 on a frozen tested build; W20 follows. Prepare full-launch infrastructure while local proofs run. Do not substitute local-only results for unmet launch tests.

The critical path is durable execution and artifacts → stop/validator/repair semantics and verified archive readiness → publication and boot → real journeys → operations → sustained testing → final audit. More agents do not shorten the 24-hour soak.

## 5. Work package pass criteria

### W00 — Reconcile the integration baseline

- [ ] Preserve all worktrees, branch heads, dirty diffs, active producer identities, and historical failures. Do not edit a producer's source until it exits.
- [ ] Collect exact agent commits; inspect ancestry before merge/cherry-pick. Commit Terra's passing dirty recovery changes before claiming their proof. Integrate `3a84d4867` before its `b6cfa4798` follow-up.
- [ ] Run parent GitHub-transport tests and the appropriate static checks. Recheck the protected-input and public-authority coverage gaps on the combined controls source.
- [ ] Produce one requirement/evidence index covering C01–C13, F01–F13, and all eleven platform gates. Label each entry implemented, unmerged, unproven, missing, or infrastructure-blocked.
- [ ] Freeze the shared interfaces above before fan-out, including typed validator origin, multi-claim result identity, live cancellation source, usage-settled event, and asynchronous release profile. Give each field and shared file one owner.
- [ ] Copy required redacted summaries and checksums from temporary evidence into the repository's factory validation area; retain large raw artifacts in durable storage with checksums. Correct overstated task notes without deleting their history.

Pass: the selected integration revision is clean; each imported change has an exact source/test record; every remaining requirement has an owner and test. No launch gate is closed solely by this bookkeeping.

### W01 — Durable execution and recovery

Extend the existing [native runner](../../src/factory/runner/native.ts), [supervisor](../../src/factory/runner/supervisor.ts), [execution journal](../../src/factory/executions.ts), shared executor, and the unmerged attempt runtime.

- [ ] Commit launch intent before starting the guest; one concurrent claimant launches one physical attempt. Use stable worker and invocation identities.
- [ ] Bind that intent to canonical request digest, tenant/project/run/node/candidate/attempt, worker/invocation IDs, reservation/fence/generation/host, and the full prepared package receipt: complete runner reference including model/configuration, trust revision, and release/source/artifact/image/manifest/evidence/build facts. Revalidate current package readiness immediately before token mint and launch.
- [ ] Provide a bounded authenticated reconnectable guest-control channel. Bind frames to worker, invocation, and attempt. Losing the controlling attachment must not terminate the guest or authorize another effect. Fresh attach must avoid normal startup's orphan cleanup and must never issue a second invocation.
- [ ] Persist terminal results and operation/checkpoint references before acknowledging them. A fresh supervisor/gateway must read the same result without sending `extension/invoke` again.
- [ ] Recover model transcript, cursor, tool results, workspace bytes, and pinned model/provider configuration from durable records. Recover on a different CPU runner host without the old local directory.
- [ ] Preserve the shared executor's broker transport and journal hooks; prove one real model/tool operation through Node → Bun gateway → isolated guest. Remove no authority check for convenience.
- [ ] Kill Node, gateway, guest, and supervisor before/after each journal and result boundary. Reattach a surviving attempt or confirm its stop before replacement; API failure or timeout never proves physical absence.
- [ ] Prove both recovery topologies: a restarted/moved gateway reconnects to the same host supervisor; replacement on a different compute host occurs only after signed physical-stop or infrastructure power-off proof and fencing/reconciliation of unresolved operations. A new host's missing-container result cannot prove the old host stopped.
- [ ] Retain a real subprocess test: start the guest, SIGKILL its owning supervisor, count exactly one labelled container, attach from a new supervisor without cleanup, recover the same terminal result with one invocation and one broker/tool effect, then cancel/remove every owned resource. An injected `Runner.attach` is insufficient.
- [ ] Re-run C05 PGlite, PostgreSQL/S3, real Podman preparation/recovery, and schema/FK parity. In the composed launcher, run two full model/configuration tuples sharing a package/export and revoke only one. Verify every dispatch path consumes current readiness.

Pass: no duplicate invocation or external effect in the crash matrix; exact completed result/checkpoint reuse; forged and late callbacks denied; unknown usage stays held; fixed retry/deadline bounds survive recovery. Run the full shared Podman suite because detached execution changes existing v4 behavior.

### W02 — Python and CPU/GPU isolation

- [ ] Build a digest-pinned Python guest using the shared recipe machinery, `.python-version`, and the committed `uv.lock`; add the framed request/result bridge and immutable dependency/model closure.
- [ ] Run the shared generated schemas and their negative fixtures under actual isolated Bun and Python guests. Keep host-Python conformance as a separate, narrower test.
- [ ] Replace host-global device injection with exact per-attempt device authorization carried from the held pool allocation. CPU starts must have an empty device list. Reject unapproved, stale, or overlapping allocations.
- [ ] Verify applied runtime controls from the host: namespaces, seccomp, cgroups, filesystem, environment, egress, and devices. No advisory fallback or provider/publish credentials in the guest.
- [ ] Recheck the exact base-hardening cases on the final code: deny secret directories, `.pi-secret`, `.pi-salt`, and `.env` through grants; reject sensitive environment names and values; require factory-enabled shell/MCP to refuse spawn when isolation is unavailable; retain manifest import-side-effect and no-provider-key regressions.
- [ ] Run hostile fetch/unpack/build/import/test/task fixtures, quarantine/revocation during waits and execution, broker denial, and protected-asset mutation attempts on the component environment. Repeat against both final deployment profiles in W19 after W16.
- [ ] Implement or complete `quarantined` and `revoked` on the shared v4 package generation fence, with current trust checks and cancellation/fencing of affected attempts. Connect state changes to W03; preserve prior decisions and prevent new acceptance/release. W14 owns the corresponding product/API/UI proof.
- [ ] Prove local AMD computation and document its supported profile. Separately prove exclusive production GPU host assignment, reset, reimage receipt, and the contract's supported driver/device profile. A host that lacks these controls stays unavailable to untrusted factory GPU work.
- [ ] For the original production profile, verify CDI injection of one whole GPU on a tenant-dedicated VM/host, no host-plane/other-tenant co-location, an explicitly supported NVIDIA driver/toolkit pair, compute/utility capabilities, device reset before reuse, and supervisor-verified reimage before the pool reoffers the host to another tenant. Host-global `configuredDevices` and unrestricted raw device injection cannot satisfy this proof. An AMD production replacement requires an explicit supported-profile revision and equivalent measured controls; the local probe alone does not establish one.

Component pass: real Bun and Python CPU jobs run and recover; CPU jobs cannot access GPU devices; allocated-device behavior and unsupported-profile denials pass on the available host. Real authorized GPU execution and all GPU security requirements above must have their own measured verdict; unavailable hardware does not become a pass. W09 can start supported CPU services with the image pack unavailable. W19 closes the separate production GPU and both-deployment-profile certifications after W16.

### W03 — Stop, cancellation, and budget settlement

- [ ] Finish the Phase B stop service using the exact attempt, reservation, worker, host, allocation generation, request, and cancellation command.
- [ ] Support cancellation of a still-running attempt before it has a terminal/non-success result. Derive its stop authority from the exact sealed admission and launch record; do not fabricate an outcome to satisfy a store precondition.
- [ ] Wire host identity/key configuration so only the supervisor can sign physical observations. Gateway callbacks cannot request an arbitrary signed “stopped” fact.
- [ ] Provide the concrete authenticated host stop transport and prove host-key rotation/reload, unknown key rejection, and old-key receipt handling under the retained trust policy.
- [ ] Implement abort, up to ten seconds of cleanup, then whole-sandbox termination. Confirm stop from the runtime; test normal completion, cancellation, crashes, and concurrent stop requests.
- [ ] On the bounded stop timeout, retain durable uncertainty and holds. Reconcile a later valid stop without launching replacement work or rewriting the prior outcome.
- [ ] Verify stop receipts before pool release and before atomic journal/budget/inbox settlement. Release proven unused compute; do not settle unknown provider cost as zero.
- [ ] Add trusted later usage reconciliation with one idempotent usage-settled event. Prove concurrent stop/confirm, corruption rejection, and recovery after a pool acknowledgement succeeds but the product transaction fails.
- [ ] Exercise cancellation during admission, nested cancellation, losing join branches, one-slot parent/child execution, last-budget-unit races, lost acknowledgements, ledger loss, and surviving partitioned workers.
- [ ] Verify round-robin tenant service, the thirty-second oldest-first lane, reserved minima, atomic whole-vector admission, and infeasible-request rejection. Test the 10,000-per-tenant/100,000-per-pool outstanding limits and HTTP 429 with `Retry-After`. Add a fixed skewed workload where one small tenant must progress under sustained competitors; W19 repeats it with real installations.

Pass: no new claim after cancellation; no capacity reuse while the previous holder can run; no double charge/refund; unknown external work stays visible. Late receipts settle only the original operation.

### W04 — Artifact materials and checkpoints

- [ ] Add auxiliary immutable material records beside the existing terminal candidate artifact. Bind each to tenant/project/run/attempt/operation/object identity.
- [ ] Add attempt-authenticated bounded write/read operations to the existing gateway and journal. Commit the operation before upload; recheck authority before issuing a handle. Use the shared encrypted blob store.
- [ ] Support chunk/manifests for the 256 MiB data input/export and complete code trees. Enforce chunk count, aggregate bytes, media type, digest, version, and traversal limits.
- [ ] Supply one scoped reader for validators, release profiles, and previews: `read(scope, artifactReference, signal?) → verified bytes`. Avoid separate unverified blob loaders.
- [ ] Recover partial uploads and workspace checkpoints by identity; reject changed bytes, cross-scope reads, late writes, duplicate-name conflicts, missing versions, and unsafe archive paths.

Pass: a real guest stores material, restarts, and consumes the verified same bytes from PostgreSQL/S3. Large data stays in bounded pages/chunks; Temporal arguments remain within C08 limits.

### W04a — Archive writer before publication

- [ ] Compose the existing immutable archive adapter as the gateway's archive-writer role with separate credentials and a verified independent failure domain. Test conditional create, checksum, version reads, access restrictions, and loss of the ordinary store.
- [ ] Before a dispatch claim, archive the exact recovery intent plus every candidate/evidence/request object needed for reconciliation and verify their readability. Publication stays pending when any member is unavailable or corrupt.
- [ ] After a confirmed provider effect, archive its receipt before product settlement or orchestration notification. Crash at each boundary and recover the same operation by identity.
- [ ] Prove that normal product and restore credentials cannot overwrite/delete the archive. Record the deployed independence evidence; separate volumes on this development host prove only credential separation.

Pass: W07/W08's production broker cannot dispatch without a verified archive prerequisite and cannot lose a confirmed receipt across product-store failure. Local same-host adapter probes may test protocol mechanics, but cannot close this gate or enable a production-equivalent publication claim. If an independent store is unavailable, continue code and isolated adapter tests and record the resulting end-to-end milestone blocker. Full backup barriers and restore remain W15.

### W05 — Protected validators and child provenance

- [ ] Define one strict validator report for PASS, FAIL, INCONCLUSIVE, and VALIDATOR_ERROR. A successful process exit alone is insufficient.
- [ ] Complete the multi-claim result key migration and populated-schema backfill; one admitted runtime can supply several uniquely identified claims. Verify repeat migration and real PostgreSQL schema parity without rewriting prior evidence.
- [ ] Resolve the exact compiled evidence source and stopped task, verify its journal request and candidate binding, and bind claims only to their pinned runner/model/configuration.
- [ ] Schedule missing protected validators through durable admission, pool allocation, the attempt dispatcher, and isolated execution. Use separate read-only candidate/protected assets and gateway-issued provenance.
- [ ] Extend shared admission with a typed validator origin where ordinary task admission requires a dispatch-node command. Never forge a transition command or equate an acceptance command ID with a new task attempt. Test lost admission responses, concurrent polls, restart, cancellation, and exactly one budget reservation/result per validator identity.
- [ ] Verify all required and quorum claims, freshness, issuer grants, complete report fields, current trust, and latest immutable trust revision. Optional quorum members remain protected evidence.
- [ ] Bind a child's accepted artifact alias to the exact parent attempt, child binding, child decision, artifact, and live ancestry fences. Parent acceptance remains separate.

Pass: valid reports produce the expected decision; forged reports, stale candidates, trust rollback/revocation, changed assets, missing fields, foreign children, and evaluator errors cannot produce acceptance. Prove the same cases on PostgreSQL/S3 and actual isolated validators.

### W06 — Rejection and bounded remediation

- [ ] Integrate existing repair/replan authority and API/client work; wire the production application and user controls.
- [ ] Persist a typed protected rejection receipt/event. Map semantic claim failure to rejection; keep infrastructure, corruption, and trust errors distinct.
- [ ] Add the kernel's remediation wait and bound consumption. Virtual acceptance failure must not create a physical-task cancellation command.
- [ ] Permit repair only on declared editable inputs, and replan only to a compatible pinned child revision with the **exact same protected contract**, within current grants, effects, resource limits, and parent budget. Changed protected contract or widened authority requires a new explicitly authorized run/version. Test equality and widening denials separately.
- [ ] Stop replaced active work first; keep previous candidates/evidence immutable; preserve absolute deadlines, spending, retry counters, and continuation state.
- [ ] Rewrite reference remediation so protected rejection causes a new candidate, freeze, all checks, and a new decision. Enforce each domain's declared bound.

Pass: positive repair/replan, stale generation, unauthorized widening, deadline/budget exhaustion, cancellation, replay, and continuation tests pass; code never exceeds three total candidate generations. Rejection cannot be retried indefinitely as an activity error.

### W07 — GitHub publication

- [ ] Resolve immutable code manifests outside product transactions; capture bounded output, then rederive current acceptance/authority in the final transaction before persisting the exact request.
- [ ] Use the agreed shared asynchronous release profile: `resolve({tenantId, projectId, runId, acceptedManifest, requestedDestination, decision, material}, signal)`. Resolve under an abortable timeout outside transactions, freeze the result, then revalidate the exact input in the final transaction. Apply this same boundary to W08; do not add provider-specific transaction I/O.
- [ ] Verify complete tree, exact base parent, accepted commit SHA, protected assets, paths, and dependency lock. Reject submodules, LFS pointers, escaping links, and network installs.
- [ ] Extend the shared broker transport to materialize immutable Git objects, create the exact unique branch, and open one draft PR. Verify returned object identities. Never force-update a conflict or merge the PR.
- [ ] Specify a reversible `encodeURIComponent(operationId)` representation in the branch suffix because factory operation IDs contain `:`. Bind both original ID and exact branch in the approved request and receipt; add round-trip/conflict tests and the contract note.
- [ ] Bind repository ID, head SHA, tested base SHA, base branch, title/body digest, branch, and provider receipt identity. The body names the exact tested base.
- [ ] Enforce W04a's archive-before-claim and receipt-before-settlement order through the shared release store. Drop responses after each external and archive write; recover without another publication.
- [ ] Reconcile lost branch responses by exact ref/SHA. Lookup all PR states by exact head/base/operation marker. Empty lookup after lost POST remains uncertain; multiple or mismatched results require intervention. Do not send a second POST from reconciliation.
- [ ] Run the shared real-adapter F04 reconciliation matrix for GitHub and S3: attach a provider-verified receipt; confirm failed/no effect only after reliable provider evidence and old-sender stop; or keep uncertain. Require a scoped operator, reason, and evidence. A further possibly effective send needs a new exact approval or unused valid policy allowance; an already-consumed approval cannot be reused. Settling a prior verified send needs no new publication consent.
- [ ] Test the private repository `ezcorp-org/factory-platform-publication-tests`, verify remote content, retain receipts, and clean up only disposable test resources after evidence capture.
- [ ] Verify the selected-repository GitHub App and broker-only branch namespace. Existing CLI credentials can prove a narrower private API smoke test; they do not prove that setup requirement.

Pass: actual draft PR publication, dropped-response recovery, sender fencing, exact-content verification, stale authority denial, and one confirmed effect. Ordinary runner and wrapped legacy tools cannot publish.

### W08 — S3 manifest publication

- [ ] Extend the existing provider to publish an approved set of exact files under one operation directory, using configured destination credentials only.
- [ ] Conditionally stage private immutable files; verify SHA-256, media type, and object version; publish `manifest.json` only after all members verify.
- [ ] Include every file key/digest/version and the final manifest digest in the verified receipt. Do not use ETag as a content digest.
- [ ] Enforce W04a before the dispatch claim, then archive the verified receipt before product settlement. A successful object/manifest write with failed receipt storage remains recoverable uncertainty.
- [ ] Prove actual multipart export, interrupted staging, conflicting content, missing versions, changed media, manifest races, response loss after write, and read-only reconciliation with the real local store.

Pass: partial staging never appears published; identical prior objects reconcile only under the same authorized identity; no overwrite or duplicate confirmed publication; all ten tenant credentials enforce isolation.

### W09 — Production startup and background work

- [ ] Compose the harness/API, Node orchestration/dispatcher, Bun gateway roles, host supervisor, pool, encrypted stores, controls, validators, release profiles, and notification sender from validated configuration.
- [ ] Register stop-aware bounded workers for compute polling, attempts, command/inbox delivery, child settlement, projections, release outcomes, reconciliation, and notifications. Reuse existing queue/recovery scheduling patterns.
- [ ] Deliver every durable completion/rejection/release result back to orchestration. A prepared release is not a completed Release node; an uncertain release remains visible.
- [ ] Prove startup closes admission until real probes pass. When factories are off, start no factory service and return the documented 404. Flag-on PGlite and any missing required dependency fail by name.
- [ ] Test simultaneous initialization, failed-start retry, shutdown order, credential expiry/refresh, dependency loss, restart, queue backpressure, and safe re-drive. Fix any reproduced initialization race at its source.
- [ ] Retain process boundaries: only Node links Temporal; Node holds no product DB/S3/provider credential; the supervisor holds only host identity; runners hold attempt-scoped authority.

Pass: a clean real application starts a durable run through public HTTP, executes a guest, records and projects its outcome, survives restart, and shuts down without leaked processes or false readiness. No test injects a precompleted result to prove this path.

### W10 — Real code reference pack

- [ ] Implement the pinned repository snapshot, native generator, complete-tree freeze, dependency/build/type/test checks, advisory and secret scans, path/protected-asset checks, and separate supervised review.
- [ ] Use the contract's exact model/configuration and actual provider usage; verify availability before a test. A missing credential/model is a readiness failure, not a substitute response.
- [ ] Run the valid slugify fixture and each protected negative fixture. Repair through W06, rerun every mandatory claim, enforce freshness, then publish through W07.

Pass: the remote draft PR contains the accepted complete tree and exact base parent; all protected failures block release; all candidate generations and actual usage remain auditable.

### W11 — Real image reference pack

- [ ] Lock the SDXL model revision, weights, Python image/dependencies, normalization, OCR, and evaluation configuration.
- [ ] Execute seeds 11/23/37/53 with the C10 settings in isolated GPU jobs; keep explicit ordered collect semantics and at most two candidate rounds.
- [ ] Prove PNG size/frame/format/payload constraints, OCR threshold, and three strict protected semantic evaluations with the required quorum/error rules.
- [ ] Run wrong-size, SALE-caption, car, and retained human-reviewed tree fixtures. A model disagreement fails for investigation; do not rerun until green.

Pass: the first accepted variant in input order is published through W08 with exact verified bytes; every failed variant remains visible. Report AMD execution separately from production GPU isolation certification.

### W12 — Real data reference pack

- [ ] Implement immutable CSV snapshot, strict parse, ordered 10,000-row partitions, pinned Python/PyArrow transform, ordered reduction, and Parquet/manifest output.
- [ ] Independently recompute every row, ID, count, sum, schema, and partition invariant from input and exported data. Test signed-64-bit boundaries and accounting overflow.
- [ ] Exercise the golden three-row input and duplicate, missing-partition, changed-value, overflow, malformed, maximum-row, and 256 MiB boundary cases.
- [ ] Repair a defective transform only through a new pinned child/package revision. Correcting input requires a new snapshot/run.

Pass: real exported Parquet and manifest reconcile exactly with the immutable source, including order, and publish through W08. No silent coercion, dropped rows, or transform self-certification.

### W13 — Composition and legacy adapter

- [ ] Run `reference.catalog.v1` with data/image children in typed acceptance-only mode; no child release operation is created. Embed their actual accepted bytes in the code candidate and perform parent checks/acceptance.
- [ ] Preserve child budgets, exact aliases, pinned revisions, parent authority, cancellation, and output schema boundaries. Child acceptance never grants parent acceptance.
- [ ] Complete the allowlisted and administrator-attested legacy adapters on the existing executor. Verify `factory:` start identity, journal-before-start, lookup after crash, unique-conflict classification, and periodic orphan sweep.
- [ ] Exercise every C10 legacy status row, including terminal uncertainty for `awaiting_approval`, authority loss, expired lease, resumable suspension, and nonresumable failure.
- [ ] Import legacy output only by a recorded digest-verified copy; exclude the ownerless ez-factory job store. Keep existing workflows/approvals/ez-factory behavior outside factories working.

Pass: real catalog PR contains actual child bytes; no duplicate legacy run after a crash; shell-bearing unattested workflow and publication bypass are denied; legacy regression suites pass.

### W14 — Complete application-facing behavior

- [ ] Complete nested run inspection, attempts/iterations, blockers, costs, artifact/evidence views, acceptance reasons, repair/replan controls, approval and uncertain-release actions.
- [ ] Complete scoped package installation/quarantine/revocation, grant administration, and affected-run previews with current human/session rules and auditable queued results. Provide the administrator purge request with the retention/uncertainty preconditions from W15/W16; full destructive-purge certification runs on disposable tenants in W19.
- [ ] Implement or verify snapshot plus contiguous SSE cursor handling: duplicates, gaps/catch-up, expired cursor 410, reconnect, visible lag/disconnection, revocation during streaming, and bounded large-map pages.
- [ ] Prove JSON/YAML/SDK/editor round-trip digest parity for every construct; unknown versions remain read-only/exportable. Race save/publish and repeat idempotency keys.
- [ ] Test actual users, restricted API keys, and service principals across at least two provisioned installations with overlapping IDs. Cover all list/search/read/download/event/mutation paths, expiry, membership/grant revocation, and transactional audit failure.
- [ ] Test cross-project read-sharing grants explicitly: only the named bytes become readable; evidence and release authority do not transfer. Recheck authority even for cached idempotent responses and artifact downloads.
- [ ] Enforce hostile preview handling: escaped code/data, bounded re-encoded images, non-executable SVG/HTML, correct download headers, and scoped artifact tickets.
- [ ] Register every route/spec/evidence surface; inspect real browser captures at 1440 and 390 pixels, long labels, large maps, light/dark themes, keyboard-only use, and reduced motion. Correct visible layout defects and console errors.

Pass: all complete domain/control journeys work through the real authenticated application; no route is covered solely by mocks; no unauthorized existence leak, stale success, inaccessible required action, or layout overflow.

### W15 — Retention, backup, and restore

- [ ] Implement reference-aware retention/tombstone/GC using canonical audit and immutable artifacts. Archive before expiry; retain active versions, keys, journals, accepted evidence, approvals, and receipts for C06 periods.
- [ ] Enforce the explicit 30-day ordinary-history, 90-day unaccepted-candidate/debug, and 365-day canonical-audit/accepted-evidence/approval/release classes. Retain prior key versions and Temporal history archival for their promised periods; no live reference is collected because its age passed a default.
- [ ] Configure and prove continuous PostgreSQL WAL backup, versioned product objects, Temporal archival, hosted cloud-KMS wrapping, and the self-hosted external-master-key/KMS adapter. Rotate by rewrapping while retaining old key versions; prove old archived/checkpointed data remains readable and objects were not rewritten in place.
- [ ] Build the per-tenant compatible checkpoint coordinator: pause mutations/effect claims, drain/fence senders, reconcile accepted outbox/audit writes, quiesce the namespace, record product/pool/Temporal positions and object versions, seal the manifest, then resume.
- [ ] Enforce the two-second target and ten-second maximum barrier, at most sixteen concurrent barriers, and fifteen-minute checkpoint age bound. A failed barrier claims no checkpoint; old checkpoints close new effect claims.
- [ ] Implement restore epochs, ingress/credential/host fencing, key/version checks, projection rebuild, archive import, and provider reconciliation before enabling service. Distinguish tenant restore against a live namespace from cluster-wide Temporal disaster restore.
- [ ] Include launch intents, allocation holds, host workers, terminal results/checkpoints, and signed stop receipts. Reconcile every pre-epoch worker with the original supervisor: inspect/reattach or prove physical stop before re-enable. Restored rows alone are insufficient. Test a restored gateway DB with a surviving guest, old-epoch broker token, and post-checkpoint guest/release.
- [ ] Test expired history, deleted test projections, conflicting/gapped audit streams, missing keys/versions, incompatible backups, lost pool ledger, and real releases after the selected checkpoint.
- [ ] Prove archive credentials and failure-domain independence in the deployed profile; normal product/restore credentials cannot erase it. Keep same-host SeaweedFS proofs labelled local.

Pass: no acknowledged facts lost in ordinary faults; no dispatch from inconsistent restore; all dispatched release identities recovered while the independent archive survives. Measure the original disaster bounds: at most fifteen minutes of internal progress loss and four hours of recovery after replacement infrastructure/archive access are available. Human tenant authority signs the recovery report before service resumes.

### W16 — Provisioning and deployment

- [ ] Extend the current provisioner instead of creating another resource workflow. Separate resources prepared, deployment ready, invitation issued, and human bootstrap complete.
- [ ] Supply pinned Compose self-hosted and Kubernetes hosted deployments, shared pool/supervisor services, scoped secret delivery, trusted ingress identity, health checks, storage, and bounded resources.
- [ ] Deliver the separate operator-only hosted control plane and tenant directory. It stores routing/membership/resource references, no product facts/artifacts/provider secrets, and exposes no tenant route or implicit product authority.
- [ ] Complete all seven idempotent C12 steps in order: database/role; product and independent archive storage credentials; namespace mTLS; installation secrets/wrapped key; harness/Node/gateway deployments; trusted hostname ingress; first-admin invitation. Retain explicit per-step ownership and failure records.
- [ ] Deploy supervisors outside harnesses as host systemd units or privileged Compose services, and hosted DaemonSets. They alone have container-runtime access and host identity; they hold no tenant secrets, attempt tokens, or product authority. Test this separation in both profiles.
- [ ] Generate correct wrapped data-key/master-key references separately from application secrets; verify private file format, permissions, and process ownership. Do not reuse a base64 application secret as a raw master key.
- [ ] Complete the first-admin invitation/login and explicit bootstrap consent/trust grants with transactional audit. Creating the invitation ID does not establish human consent.
- [ ] Fault every provisioning step and recover or tear down only owned resources. A partial tenant serves no traffic. Prove credential rotation/revocation and rerun idempotence.
- [ ] Implement canary-first fleet upgrades in the C12 order, old build retention, failure-stopped waves, additive schema/code rollback, teardown, and human-admin purge after active/uncertain work closes. Teardown retains the release archive; final purge records audit loss under C06.
- [ ] Document operator prerequisites, image/runtime locks, secret references, recovery, drain, upgrades, rollback, and CPU-only resource availability.

Pass: ten separate application installations start with distinct identities and credentials; both deployment profiles install from clean state; migration/readiness failure stops a wave; teardown credentials fail and retained archive evidence survives.

### W17 — Metrics, alerts, and notifications

- [ ] Add bounded-cardinality Prometheus metrics to every factory service for admission, execution, pool holds, unknown usage, projections, validator outcomes, release uncertainty, backup age, and required old workers.
- [ ] Ship every C11 alert and its operator action; configure a real evaluator for both deployment profiles. Verify each rule by forcing the condition, not by reading its YAML.
- [ ] Implement a new outbound webhook/optional SMTP sender on the existing durable queue pattern; the current notification-delivery module only serves the in-app view. Wire it into boot with bounded retries, leases, stable delivery IDs, configured/authenticated destinations, expiry, and restart recovery. Test lost acknowledgements; require receiver deduplication or retain uncertainty where delivery cannot safely repeat.
- [ ] Prove approval and uncertain-release delivery to a local receiving service, plus inbox actions. Configure external webhook/SMTP delivery only within already approved test destinations; do not message real people without authorization.

Pass: forced conditions create the expected alert/inbox item; operator actions preserve authority and uncertainty; one logical notification is not duplicated by normal re-drive; no secret or unbounded run identifier appears in metrics labels.

### W18 — Coverage and CI enforcement

- [ ] Complete all seven exact C11 lanes: schema/kernel, runner contracts, Temporal integration, assurance/release, isolation, product/domain E2E, deployment/operations. A job name alone is insufficient; verify its producer inputs and artifacts.
- [ ] Wire strict Python lint/typecheck/native tests/coverage, actual Node native coverage, Bun coverage, SDK and worker builds, console and every deployed image. Register new source files, wildcards, per-file floors, shard timings, and producer tags through existing helpers.
- [ ] Verify every completed work package extended the C13 import/duplicate-signature inventory for its touched shared modules, and exercise deliberate violations to prove the boundary checker rejects them.
- [ ] Require 100% of new executable files and every changed executable line. Retain meaningful behavioral assertions and fault tests; no synthetic counters, reduced thresholds, exclusions, or green skips.
- [ ] Integrate the structural type-only LCOV correction and tests; enum/runtime-bearing TypeScript must still fail if coverage is missing. Recheck the entire feature diff against `2588c9f19edcae24273f4a2049eb3ac37bd6f920`.
- [ ] Add the `factory-services` browser lane to every canonical consumer, route manifest, and evidence map; retain existing lane ownership and legacy coverage.
- [ ] Refresh read-only GitHub runner/secret-name/required-check inspection. Prepare the exact missing runner labels, credential references, and branch-protection change. Apply external administrative changes only under the applicable authorization; no new permission is needed to prepare and validate those files.
- [ ] Prove real/GPU runners are available and no-runner precheck fails within five minutes. Prove a deliberate lane failure blocks the candidate, then remove the failure and retain both results. Obtain required CODEOWNER/non-author review.

Pass: no executable source drops out of coverage; no runtime producer substitutes for another; all relevant required checks execute and enforce the exact candidate. Local green results do not claim hosted enforcement.

### W19 — Sustained test campaigns

- [ ] Freeze a workload manifest, image/dependency/model locks, host resources, seed, retained-data size, service process counts, and metric definitions before running the campaign. Run a capacity experiment first; publish the measured envelope and cost.
- [ ] Complete the local profile in section 6, retaining a continuous full-duration report and separate fault/barrier windows. Test one and ten concurrent 10,000-node runs without silently shrinking the graph.
- [ ] Run the separate self-hosted C11 profile and the original 100-installation hosted profile when their infrastructure is available. Keep each verdict separate.
- [ ] Run real model/GPU/publication journeys beside the synthetic orchestration benchmark and report their actual latency/usage separately.
- [ ] Repeat affected sustained proofs if source, configuration, workload, or infrastructure changes. Do not splice runs across failed restarts into one successful soak.

Pass: all applicable fixed performance/safety targets are evaluated, failures remain recorded, and the report states exactly which profile passed. Full launch stays blocked by any missing original F01–F13 proof.

### W20 — Final integration and independent audit

- [ ] Freeze the final candidate; run full application/backend/web/browser/legacy regressions, all type/lint/build/image checks, PostgreSQL schema/migration proofs, native coverage, and full feature patch/new-file gates.
- [ ] Independently review standards/reuse and specification/security. Assign reviewers areas they did not implement. Fix each finding and rerun its affected checks.
- [ ] Generate a release evidence manifest covering every F01–F13 requirement and every platform gate with source/configuration hashes, commands, runtime/hardware, timestamps, exit codes, counts, and raw artifact checksums.
- [ ] Verify every claimed pass from its actual producer; preserve historical failures; reject missing, skipped, expired, dirty-source, or mismatched evidence.
- [ ] Update operating docs, task ledger, and platform gates only when their proof is complete. Prepare the final reviewable diff and handoff; source publication, merge, and deployment remain separate actions under their applicable authorization.

Pass: a reviewer can reproduce the feature and every readiness claim from the final candidate. Local milestone completion and full launch completion are stated separately.

## 6. Fixed local campaign and full-launch differences

The following is the planned **ten-installation local profile**, chosen as one tenth of the original hosted offered load. Freeze it before execution. These values are not measurements or a revision to C11.

| Measure | Local campaign |
| --- | --- |
| Installations/runs | Ten actual installations; 100 active logical runs, split into 70 approval waits and 30 executing runs |
| Offered work | Ten ready synthetic leaf tasks/second; distinct verified object upload/read traffic at 1 MiB/second |
| Task/graph/result mix | Keep the exact C11 ratios, durations, encoded result sizes, artifact-reference proportion, graph mix, fixed seed, and arrival trace |
| Duration | Thirty-minute warm-up, two-hour steady run, then twenty-four-hour soak at half task/object rate with the same tenant/run mix |
| Throughput | At least ten successful synthetic completions/second steady and five/second in soak; no backlog growth over the final sixty minutes |
| Other targets | Keep C11 admission/API/projection/replay/recovery/browser targets and all safety constraints; do not scale latency limits upward |
| Large graphs | One and ten concurrent 10,000-node graph cases; report their resource use separately |
| GPU | Trusted local AMD real execution plus explicit isolation verdict; no simulated tenant reassignment or reimage receipt |
| Archive | Same-host protocol tests only; independent-domain certification is a separate full-launch proof, not a local campaign pass criterion |

The timed local load sequence alone requires at least **26.5 hours** after a stable build exists. Fault/recovery drills and any failed-run corrections add time. Do not give a shorter completion estimate by omitting the soak.

A local campaign pass certifies only its declared profile. It does not satisfy W04a's production archive prerequisite, certify a protected production GPU profile, or close the full-feature milestone while a required journey remains blocked. Local adapter tests may publish only to the authorized disposable destinations; production-equivalent end-to-end publication remains held until its independent archive prerequisite is met.

The original hosted profile remains 100 actual installations, 1,000 active runs (700 waiting/300 executing), 100 ready tasks/second, 10 MiB/second object traffic, and the C11 warm-up/steady/soak schedule. The self-hosted profile remains one installation with ten active runs (seven waiting/three executing), one completion/second, a 10,000-node graph, two-hour steady test, and twenty-four-hour half-rate soak. Run these as separate certifications.

Fault matrix for each applicable profile: individual/all-worker loss; network partition while old workers survive; sixty-second PostgreSQL/S3 outages; delayed/duplicate results; lost admission/settlement acknowledgements; stopped projector; approval/cancellation/expiry races; repeated continuation; compatible and revoked interpreter/package changes; missing keys/object versions; incompatible backup; stale checkpoint; and post-checkpoint real publication. Measure detection within thirty seconds, healthy-spare resumption within sixty seconds, and backlog/projection recovery within five minutes after dependencies recover. Uncertain writes stay blocked until verified.

## 7. Proof and platform-gate mapping

| Contract/proof | Completion work |
| --- | --- |
| C01 / F01 | W03, W09, W13, W14, W16, W19 |
| C02 / F02 | W01, W02, W03, W04, W09, W19 |
| C03 / F03 | W02, W03, W09, W15, W19 |
| C04 / F04 | W04a, W05, W06, W07, W08, W09, W17, W19 |
| C05 / F05 | W01, W02, W05, W07, W09, W16, W19 |
| C06 / F06 | W04, W04a, W07, W08, W15, W16, W17, W19 |
| C07 / F07 | W01, W02, W04, W05, W06, W13, W18, W20 |
| C08 / F08 | W01, W03, W04, W06, W09, W13, W19 |
| C09 / F09 | W06, W09, W14, W16, W18, W20 |
| C10 / F10 | W05, W06, W07, W08, W10, W11, W12, W13, W14, W19 |
| C11 / F11 | W15, W16, W17, W18, W19, W20 |
| C12 / F12 | W15, W16, W17, W19 |
| C13 / F13 | W00, W01, W02, W03, W04, W04a, W05, W06, W07, W08, W09, W13, W18, W20 |

| Platform gate | Required closure |
| --- | --- |
| S1 | F07 golden/property/expected-state traces, F10 realigned definitions, F13 reuse, SDK build/coverage |
| S2a | Base hardening, token/flag tests, pinned runtime lanes and no-runner failure proof |
| S2b | Real storage/Temporal/audit/projector/continuation, legacy engine changes, migrations, replay |
| S2c | Complete isolated Bun/Python bridge, durable results, checkpoints, stop/recovery, baseline isolation |
| S2d | Actual tenancy, budgets, pool fairness/fencing, GPU allocation and measured capacity |
| S3 | Protected evidence/acceptance/rejection, exact release authority, reconciliation and delivered notifications |
| S4 | Full package preparation/execution/revocation and actual CPU/GPU isolation in both deployment profiles |
| S5 | Complete console, real code/image/data/catalog/legacy journeys and remote receipts |
| S6 | Both deployment profiles, provisioning, retention/restore, alerts, upgrades, load/fault/soak |
| REG | Current full application, native runtime, web/browser/legacy, build/type/lint/coverage results |
| AUDIT | Exact-candidate F01–F13 evidence and independent review with no unresolved finding |

## 8. Validation commands and evidence rules

Reuse the existing commands below. Supply credentials through the private configuration references; never place secret values in the document, shell transcript, or evidence. Serialize heavy tests with `/tmp/ezcorp-validation-heavy.lock` in this local workspace and use the pinned Bun/Node/Python toolchains. SDK changes require a fresh SDK build before dependent type/Node checks.

On this host, run each heavy producer in this form (example uses an existing test):

```sh
flock /tmp/ezcorp-validation-heavy.lock \
  env PATH="/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH" \
  bun test --timeout 180000 ./packages/@ezcorp/extension-runner/tests/podman.integration.test.ts
```

The following commands assume that pinned Bun directory is first on `PATH`; verify `bun --version` against `.bun-version`, `node --version` against `.node-version`, and the locked Python interpreter against `.python-version` before starting. Node/Python version or lock mismatch fails the producer. Install Python dependencies from `src/factory/runner/python/uv.lock` with `uv sync --locked`, not an ad hoc environment. In CI, derive tool paths from the repository pins, not these machine-specific paths.

```sh
bun run --cwd packages/@ezcorp/factory-sdk build
FACTORY_ONLY=1 bun run test
bun run --cwd packages/@ezcorp/factory-orchestrator build
bash scripts/factory-orchestrator-coverage.sh
bun run typecheck
bun run lint
bun scripts/check-factory-boundaries.ts
bun scripts/gate-integrity.ts
bun run test
bun run test:coverage
bun run build
BASE_REF=2588c9f19edcae24273f4a2049eb3ac37bd6f920 bun scripts/check-new-file-coverage.ts
BASE_REF=2588c9f19edcae24273f4a2049eb3ac37bd6f920 bun scripts/check-patch-coverage.ts
```

For PostgreSQL/S3, run every registered factory test producer in [db-postgres.yml](../../.github/workflows/db-postgres.yml), including schema parity and migrations, with `FACTORY_TEST_POSTGRES_URL` and `EZCORP_FACTORY_STORAGE_SECRETS_DIR`. Do not replace that list with a handpicked subset for final certification. Use the existing web lane wrappers and exact registered browser manifests; W18 adds the missing service/native lanes before they can be counted as checks.

Existing direct infrastructure checks are `scripts/setup-factory-storage.sh`, `bun scripts/verify-factory-storage.ts`, `bun scripts/verify-factory-release-s3.ts`, and `bash scripts/verify-factory-local-gpu.sh`. Their existing scope is storage/single-object/GPU smoke. W07–W19 must add runnable full-journey, deployment, restore, load, and soak producers; no such future command is presented here as already available.

| Producer | Existing entry or work to add | Required result |
| --- | --- | --- |
| Podman crash/reconnect/cancel | Existing full `packages/@ezcorp/extension-runner/tests/podman.integration.test.ts`; W01 extends and registers its crash case | Actual subprocess/container observations; unavailable runtime fails readiness |
| Bun/Python guest recovery | W01/W02 register complete isolated guest tests beside existing runner conformance tests | Same generated schemas, durable results, one invocation/effect, physical stop |
| Node native coverage | Existing `bash scripts/factory-orchestrator-coverage.sh` with `FACTORY_TEMPORAL_TEST_SERVER` set to the pinned binary | Real native producer, histories/replay, canonical LCOV and source discovery |
| Python native quality/coverage | W02/W18 add required standard-library test discovery plus `coverage.py` LCOV, `ruff`, and strict `mypy` in the locked Python project | Discover actual Python tests; empty discovery fails; no Bun substitute for Python source coverage |
| C05 package readiness | Existing package-preparation PGlite, PostgreSQL, and Podman integration files | Current full runner-reference/trust binding on every dispatch; migration/FK parity |
| CPU/GPU isolation | Existing local GPU smoke plus W02's new allocation/isolation producer | CPU has no devices; exact authorized GPU only; absent required hardware fails |
| PostgreSQL/S3 | Canonical registered producer list in `db-postgres.yml`; W18 registers new stop/validator/artifact migrations and suites | Real engine/storage, populated upgrade and repeated migration, schema parity |
| Runner availability | Existing `bun scripts/check-factory-runners.ts` with private credential reference | Both required runner labels online; missing runner/credential produces failure within five minutes |

W18 must make every added producer executable in the required lanes before its work package can close. Preserve the pre-fix C02 reports as historical evidence; they do not cover the later detached/recovery changes.

An evidence record must include the producing commit plus dirty/untracked file hashes when relevant, dependency/image/model locks, environment and hardware, workload/seed, start/end timestamps, exact command, exit code, test/assertion counts, measured coverage, and artifact checksums. For integration closure, produce from clean committed source. Reuse old coverage only for byte-identical source with matching runtime producer maps. Never add Bun and Node counters for the same source as if they were equivalent.

Add behavior-first tests for new functionality. For bugs, first reproduce through the closest real end-user path. Include success, negative authority/schema inputs, concurrent calls, lost responses, crash/restart, cancellation/deadline, old generation, cross-scope denial, and byte/version corruption where applicable. Assertions must compare promised outcomes and identities, not just run the same implementation twice.

## 9. Environment references and external prerequisites

| Resource | Existing reference or next verification |
| --- | --- |
| Private GitHub target | `ezcorp-org/factory-platform-publication-tests`, main branch; [local publication guide](../factory-local-publication.md) |
| GitHub CLI credential | `/home/dev/.config/gh/hosts.yml`; reference only; keep publish material in the trusted broker |
| Local S3 credentials | `EZCORP_FACTORY_STORAGE_SECRETS_DIR`; current generated directory `/run/user/1001/ezcorp-factory-storage.8yWJyCIQ` |
| Local tenant bundles | `/run/user/1001/ezcorp-factory-provisioning/installations`; private files, not evidence payloads |
| Local Temporal identities | `/run/user/1001/ezcorp-factory-temporal-auth`; inspect expiry and refresh service before a long run |
| Local PostgreSQL proof config | `/tmp/factory-platform-evidence/postgres.env`; discover the current container port rather than copying an old port |
| Pinned Temporal test server | `/tmp/factory-tools/temporal-test-server/temporal-test-server_1.38.0_linux_amd64/temporal-test-server` |
| Model credentials and model/weight locks | Resolve existing application provider configuration by reference in W00/W10/W11; missing references remain explicit readiness failures |
| Hosted CI requirements | Reinspect runner labels and secret names with the existing read-only scripts; historical reports are [stage 1](../validation/factory/stage-1/required-check-inspection.md) and [stage 2a](../validation/factory/stage-2a/runner-readiness-inspection.md) |
| Full launch resources | Independent archive host/failure domain, suitable dedicated GPU host(s), spare CPU host for recovery, Kubernetes capacity, and original 100-installation envelope |

No user decision is required to write this plan or finish already authorized local implementation and tests. When an external prerequisite actually blocks execution, prepare the exact configuration or change first, report the measured blocker, and request only the missing action. Do not repeatedly ask for the already authorized local S3, host GPU testing, or private GitHub test repository.

## 10. Plan review record

The plan is ready for execution. Four active workstream audits informed the baseline. Independent Sol and Terra reviews found missing dependencies and criteria; the document now includes their corrections. Both reviewers confirmed that their reported findings are resolved. This review does not claim there are no possible implementation defects.

The document maps 22 work packages to all thirteen contract/proof pairs and all eleven platform gates. The structural check verifies local links, unique work IDs, complete mappings, an acyclic dependency graph, archive-before-publication ordering, and the deployed restore/final CI prerequisites. Its source checksum and results are in the [plan validation record](../validation/factory/completion-plan/structure.json).

Only documentation was changed for this planning task. No new product test run or feature completion is claimed. The platform gates remain open; execution begins with W00.
