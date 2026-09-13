# W00 requirement and evidence index

Audited revision: `33cab8657` on `feat/composable-factory-platform`, worktree
`/home/dev/work/EZCorp/EZHarness-worktrees/composable-factory-platform`. Audit date 2026-09-13.

## How to read this index

`EV/` is short for `/tmp/factory-platform-evidence/`. An evidence citation of the form
`EV/x.json@abc123def` means that file records producing head `abc123def`, and
`git merge-base --is-ancestor abc123def 33cab8657` returns true.

Status values:

- **implemented** — source is in HEAD `33cab8657` and at least one evidence file records a head that is an ancestor of HEAD.
- **unproven** — source is in HEAD, but no evidence file records an ancestor head for it.
- **unmerged** — source exists only on a branch, stash, or dirty worktree that is not an ancestor of HEAD.
- **missing** — no source exists.
- **infrastructure-blocked** — the work cannot complete on this host because hardware, an independent failure domain, or hosted runners are unavailable.

No row is marked implemented because a task note says so. Every cited repository path was
checked for existence. Every cited evidence head was checked with `git merge-base --is-ancestor`.

Unmerged sources named in this index:

| Label | Location | Merge base with HEAD | Diff size |
| --- | --- | --- | --- |
| Sol run controls | `a83f91556`, `3a84d4867`, `b6cfa4798` on `feat/factory-release-idempotency-v2`, worktree `/home/dev/work/EZCorp/EZHarness-worktrees/factory-assurance` | `a7e20a4e8` | 19 files, +555/-16 |
| Terra durable attempt runtime | `599e49e73`..`6c500113a` on `feat/factory-lazy-input`, worktree `/home/dev/work/EZCorp/EZHarness-worktrees/factory-lazy-input` | `84cfd2a99` | 10 files, +712/-13 |
| Terra podman working-tree diff | uncommitted in `/home/dev/work/EZCorp/EZHarness-worktrees/factory-lazy-input` | n/a | 2 files, +1/-6 |
| Sol multi-claim validator binding | uncommitted plus untracked `src/db/migrations/allow-factory-validator-multiclaim.ts` and `.test.ts` in `/home/dev/work/EZCorp/EZHarness-worktrees/factory-validator-binding` | `84cfd2a99` | 7 files, +104/-44 |
| Sol Phase B stop settlement | stash commit `8fda869045129d415ac8fc2b8df6cb5ffb7f50ea` | `84cfd2a99` era | 6 files, +90/-18 |


## A. Contract requirements C01–C13

### C01 Tenant and authority

Plan section 7 owners: W03, W09, W13, W14, W16, W19.

| ID | Requirement | Status | Source | Evidence | Owner | Note |
| --- | --- | --- | --- | --- | --- | --- |
| C01.1 | Provisioning creates a per-tenant PostgreSQL database and login role with a generated password. | implemented | `src/factory/provisioning/local.ts:78-129` | `EV/root-c06-results.json@c82b1b05b` | W16 | The PostgreSQL leg runs `tests/postgres/factory-provisioning.test.ts` and exits 0. |
| C01.2 | Provisioning mints object-store credentials restricted to the tenant prefix. | missing | `src/factory/provisioning/local.ts:43` reads a pre-seeded identity file | none | W16 | No prefix is created and no credential is minted. |
| C01.3 | Provisioning creates an authenticated Temporal namespace with namespace-scoped mutual TLS credentials. | missing | `src/factory/provisioning/local.ts:9,118` declares an injected `TemporalNamespaces` interface | none | W16 | No implementation exists under `src/factory`. |
| C01.4 | Session tokens carry `iss` and `aud` equal to the installation ID, and verification rejects a missing or foreign claim. | implemented | `src/auth/jwt.ts:91-92,142` | `EV/root-auth-integration-results.json@d84359f84` | W09 | Covered by `src/__tests__/auth-jwt-password.test.ts`. |
| C01.5 | `service_accounts` carries `expires_at` so a service principal can itself expire. | implemented | `src/db/migrate.ts:2510`; `src/db/schema.ts:632,644` | `EV/root-authority-integration-results.json@647e63a53` | W14 | The same file records a failing full `bun run test` leg at that head. |
| C01.6 | `factory_grants` rows key tenant, project, principal, and action with issuer, expiry, and revocation revision. | implemented | `src/db/migrations/add-factory-grants.ts`; `src/db/factory-schema.ts:189-206` | `EV/root-authority-integration-results.json@647e63a53` | W09 | PostgreSQL leg runs `tests/postgres/factory-grants.test.ts`. |
| C01.7 | Membership-scoped factory reads are enforced, not only mutations. | implemented | `src/factory/grants.ts:70-74,203,213` | `EV/root-authority-integration-results.json@647e63a53` | W14 | `authorizeInTransaction(..., "read")` runs the membership lookup before the read short-circuit. |
| C01.8 | Every factory action names its exact API-key scope or session rule. | unproven | `src/api-registry.ts:60-93`, 34 factory entries | none with an ancestor head | W14 | Two rows deviate. Version publish is `session` where the contract says `write`. Grant management is `session` where the contract says `admin`. |
| C01.9 | A package install and quarantine route under tenant-administrator authority. | missing | none in `src/api-registry.ts` or `web/src/routes/api/factories/` | none | W14 | The C01 authority table row has no route. |
| C01.10 | Tenant bootstrap records explicit first-administrator consent and trust grants. | missing | `src/factory/grants.ts:85-99` grants only author, publish, run, and operate | none | W16 | Provisioning stores an invitation UUID at `local.ts:65` and never issues it. |
| C01.11 | Cross-project read-sharing grants expose named bytes and transfer no evidence or release authority. | implemented | `src/factory/artifact-access.ts`; `src/db/migrations/add-factory-artifact-read-grants.ts` | `EV/root-lazy-authority-combined-integration-results.json@dcd8b40e2`; `EV/root-run-inputs-integration-results.json@a93fa0afa` | W14 | Digest and byte count are re-verified on load at `artifact-access.ts:159-163`. |
| C01.12 | Consent, grant, trust, approval, and release facts commit through `insertTransactionalAuditEntry`. | implemented | `src/factory/grants.ts:183`; `assurance.ts:77,168,178,198`; `release-authority.ts:145-212` | `EV/root-private-validator-dispatch-merge-combined-integration-results.json@ac656591e` | W09 | No third audit path exists. |
| C01.13 | Trusted ingress maps a provisioned hostname to a tenant, and the server matches it to the installation identity. | missing | `src/factory/provisioning/local.ts:54` stores a unique hostname only | none | W16 | No request-path resolver reads the Host or forwarded header. |

### C02 Worker bridge and operation recovery

Plan section 7 owners: W01, W02, W03, W04, W09, W19.

| ID | Requirement | Status | Source | Evidence | Owner | Note |
| --- | --- | --- | --- | --- | --- | --- |
| C02.1 | One Node.js orchestration process hosts the Temporal worker, and only it links `@temporalio/*`. | implemented | `src/factory/orchestration-process.ts`; `packages/@ezcorp/factory-orchestrator/src/process.ts`, `worker.ts` | `EV/root-production-orchestrator-integration-results.json@8d83911c2` | W09 | No boundary test enforces the confinement; `scripts/check-factory-boundaries.ts` has no Temporal import rule. |
| C02.2 | The tenant gateway hosts the provider broker role. | missing | only an unimplemented `FactoryBroker` interface at `src/runtime/factory-execution.ts:53` | none | W09 | Nothing extends `src/extensions/credential-broker.ts` or `network-broker.ts`. |
| C02.3 | The tenant gateway hosts the release broker role. | missing | nothing extends `src/extensions/project-pull-request-broker.ts` | none | W07 | `src/factory/execution-gateway.ts` is 47 lines and serves only the execution endpoints. |
| C02.4 | The tenant gateway hosts the fetch proxy role over the v4 dependency fetcher. | missing | nothing imports `packages/@ezcorp/extension-runner/src/dependencies.ts` from factory code | none | W02 | |
| C02.5 | The tenant gateway hosts the archive writer role. | unproven | `src/factory/release-adapters.ts:32` `S3FactoryReleaseArchive` | `EV/assembled-platform-results.json@8a21a81d9` covers `release-adapters.test.ts` | W04a | The adapter exists; no gateway role, credential separation, or independent failure domain is composed. |
| C02.6 | Private HTTPS between services uses mutual TLS and derives the caller identity from the peer certificate. | implemented | `src/factory/private-https.ts:61,64,92` | `EV/private-service-final-results.json@ee82337b1`; `EV/assembled-platform-results.json@8a21a81d9` | W09 | |
| C02.7 | The attempt token binds project, run, node instance, candidate generation, attempt, grant revision, reservation, deadline, and execution epoch under `tokenUse: "factory-attempt"`. | implemented | `src/factory/attempt-token.ts:6-8,30,38` | `EV/attempt-token-final-results.json@8a0008033` | W01 | Verification enforces an exact key count. |
| C02.8 | The four internal execution operations: idempotent submit, authenticated status, idempotent cancel, and result notification. | unproven | `src/factory/execution-gateway.ts:29-44`; `src/factory/private-service.ts:115-125` | `EV/root-auth-integration-results.json@d84359f84` covers the gateway suite | W01 | Submit, status, and cancel exist with 409 on hash mismatch. Result notification exists only as an in-process durable write at `src/factory/executions.ts:313-319`, not as a named operation. |
| C02.9 | The gateway journals every model and tool operation before its effect, through the states prepared, dispatched, and then completed, failed, or uncertain. | implemented | `src/factory/executions.ts:13,248,259,270-284,392` | `EV/root-input-execution-combined-integration-results.json@106371c8c`; `EV/root-package-outcome-partition-merge-combined-integration-results.json@57751b80b` | W01 | |
| C02.10 | The factory runner reuses the shared executor with a pluggable provider transport and journal hooks; no copied executor. | implemented | `src/runtime/executor.ts:1448-1455`; `src/runtime/factory-execution.ts:53-87,224-264`; `src/factory/runner/native.ts` | `EV/root-package-outcome-partition-merge-combined-integration-results.json@57751b80b` | W01 | The provider transport explicitly rejects host API keys. |
| C02.11 | Copy-on-write workspace checkpoints containing the transcript, operation cursor, tool results, and workspace manifest. | missing | `checkpointWorkspace` is an interface hook at `src/runtime/factory-execution.ts` with no production implementer | none | W04 | No copy-on-write, overlay, or reflink code exists under `src/factory` or `src/runtime`. |
| C02.12 | A bounded authenticated reconnectable guest-control channel where losing the attachment neither terminates the guest nor authorizes another effect. | unmerged | `src/factory/runner/attempt-runtime.ts` (+363) and `src/db/migrations/add-factory-attempt-launches.ts` on `feat/factory-lazy-input` at `6c500113a` | none with an ancestor head | W01 | Not an ancestor of HEAD. The branch also carries an uncommitted `podman.ts` revert. |
| C02.13 | Heartbeat every 5 seconds with a 20-second failure-detection timeout. | implemented | `packages/@ezcorp/factory-orchestrator/src/gateway-activities.ts:56`; `workflow.ts:57-58` | `EV/shared-transport-final-integration-results.json@5d6a92d44` | W01 | `maximumAttempts: 1` is set as C02 requires. |
| C02.14 | After cancellation the supervisor aborts, allows 10 seconds of cleanup, then kills the whole sandbox process group and confirms no process remains. | missing | `src/factory/runner/supervisor.ts:125-127` calls only `worker.close()` | none | W03 | No abort, no 10-second budget, no process-group kill. |
| C02.15 | Each interpreter compatibility version is a worker deployment pinned to a Temporal build ID. | missing | `interpreterBuild` is a product string at `src/factory/run-lifecycle.ts:113`; `worker.ts` passes no `buildId` | none | W09 | Worker versioning is not configured. |

### C03 Admission and reservations

Plan section 7 owners: W02, W03, W09, W15, W19.

| ID | Requirement | Status | Source | Evidence | Owner | Note |
| --- | --- | --- | --- | --- | --- | --- |
| C03.1 | The pool admission service is a separate trusted process that owns its own PostgreSQL database. | unproven | `src/factory/pool/process.ts`, `service.ts`, `ledger.ts:10`; verifies `current_database()` and `current_user` | `EV/terminal-pool-provisioning-results.json` records no head; `EV/postgres-factory-pool-parent-results.json` records no head | W03 | The five pool PostgreSQL suites have no evidence file carrying an ancestor head. |
| C03.2 | The pool accepts a tenant ID only from the mutual-TLS peer certificate. | unproven | `src/factory/pool/service.ts` `authenticatePoolPrincipal`; `service-routes.ts` `peerIdentity`; `service-server.ts` requires TLS 1.3 client certificates | none with an ancestor head | W03 | Tenant ID is never read from request JSON. |
| C03.3 | GPU hosts are a pool resource class bound whole to one tenant, released only after a verified supervisor reimage receipt. | unproven | `src/factory/pool/ledger.ts` `POOL_RESOURCE_CLASSES`, `factory_pool_hosts` states, `confirmGpuReimage` | none with an ancestor head | W03 | Ledger bookkeeping exists. No supervisor produces a real reimage receipt. |
| C03.4 | Budget is acquired first in a transaction that also writes the compute outbox request, then the whole compute vector is acquired atomically for an allocation token. | implemented | `src/factory/task-admission.ts`; `src/factory/budgets.ts`; `src/factory/pool/ledger.ts` `schedule()` | `EV/root-budget-allocation-integration-results.json@6d99c8225`; `EV/root-terminal-budget-integration-results.json@1d09de66f` | W03 | |
| C03.5 | Reservation states `requested`, `held`, `running`, `revoking`, `uncertain`, `settled`. | unproven | `src/factory/pool/ledger.ts:7` and the `factory_pool_requests` CHECK | none with an ancestor head | W03 | The contract's `requested` is named `queued`, and an extra `rejected` state exists. |
| C03.6 | Lease rows carry fence, generation, and effects counter; leases last 30 seconds and renew every 5 seconds; expiry increments the allocation generation. | unproven | `src/factory/pool/ledger.ts` `leaseMs = 30_000`, `expireLocked` | none with an ancestor head | W03 | No 5-second renewal driver exists anywhere under `src/factory`. The lease row has no `quarantined` state. |
| C03.7 | A waiting parent or subfactory holds no compute slot; only running leaf tasks consume compute. | implemented | `packages/@ezcorp/factory-sdk/src/kernel.ts:709-720` | `EV/root-authority-integration-results.json@647e63a53` runs the full SDK suite | W03 | |
| C03.8 | Round-robin service across runnable tenants, one feasible allocation per tenant per round per resource class, ordered by priority then ready sequence then node identity. | unproven | `src/factory/pool/ledger.ts` `chooseFair`, `isRoundEligible`, `factory_pool_round_members` | none with an ancestor head | W03 | Plan section 3 records a scheduling audit lead here; W03 must compare real allocation traces. |
| C03.9 | After 30 seconds an eligible request enters an oldest-first lane that holds capacity until the whole vector fits. | unproven | `src/factory/pool/ledger.ts:83-84` `ageLaneMs = 30_000` and `schedule()` | none with an ancestor head | W03 | |
| C03.10 | Reserved tenant minima hold, and requests larger than the configured pool maximum fail at admission. | unproven | `src/factory/pool/ledger.ts` `respectsReservedMinimums`, `factory_pool_tenant_minima`, `ledger.ts:339` | none with an ancestor head | W03 | |
| C03.11 | Outstanding admission requests are bounded at 10,000 per tenant and 100,000 per pool; new starts return HTTP 429 with `Retry-After`. | unproven | limits at `src/factory/pool/ledger.ts:85-86,345` | none with an ancestor head | W03 | The HTTP layer returns 200 with a `queue-full` body at `src/factory/pool/service-routes.ts:91`. No 429 and no `Retry-After` header exists under `src/factory`. |
| C03.12 | Unknown usage never settles as zero, and providers without enforceable cost caps produce an explicit estimated-cost contract. | implemented | `src/factory/budgets.ts:193-231`; settle requires a `sha256:` receipt digest | `EV/root-terminal-budget-integration-results.json@1d09de66f` | W03 | The hold exists. The estimated-cost contract construct does not exist in `src/`. |
| C03.13 | The pool ledger is included in the C06 checkpoint barrier so a restore cannot double-allocate. | missing | no barrier code exists | none | W15 | See C06.10. |

### C04 Acceptance and release dispatch

Plan section 7 owners: W04a, W05, W06, W07, W08, W09, W17, W19.

| ID | Requirement | Status | Source | Evidence | Owner | Note |
| --- | --- | --- | --- | --- | --- | --- |
| C04.1 | A trusted human approves the acceptance contract revision and validator trust; the generator cannot change it. | implemented | `src/factory/assurance.ts:63` `approveContract`; `src/factory/release-authority.ts:129` `publishTrust` | `EV/root-private-validator-dispatch-merge-combined-integration-results.json@ac656591e` | W05 | |
| C04.2 | The gateway validator path builds evidence from the assigned candidate and validator lock; runner JSON cannot mint issuer provenance. | implemented | `src/factory/validator-materials.ts:288`; `src/factory/assurance.ts:106-126` | `EV/root-protected-effects-parent-combined-integration-results.json@84cfd2a99` | W05 | |
| C04.3 | `ReleaseOperation` carries candidate digest, decision, action, destination identity, expected destination version, canonical request hash, and policy revision, with one operation per run, release node, candidate, action, and destination. | implemented | `src/db/migrations/add-factory-releases.ts:16-34`; `src/factory/releases.ts:121` | `EV/root-provider-receipt-parent-combined-integration-results.json@1ba2b6763` | W07 | |
| C04.4 | The v4 approval check, claim compare-and-swap, and uncertain-outcome settlement are extracted into shared modules used by both v4 and the factory. | unproven | only the approval check is shared, at `src/extensions/v4/approval-context.ts` | `EV/root-provider-receipt-parent-combined-integration-results.json@1ba2b6763` | W07 | The claim compare-and-swap and uncertain settlement are a factory-only implementation at `src/factory/releases.ts:484,515-530`. `project-pull-request-broker.ts` shares no module with it. |
| C04.5 | Automatic release policies bind project, principal, action, destination prefix, contract, maximum operations and spend, and expiry of at most 30 days; counters consume atomically at dispatch. | implemented | `src/db/migrations/add-factory-releases.ts:6-15`; `src/factory/releases.ts:21,453,502` | `EV/root-provider-receipt-parent-combined-integration-results.json@1ba2b6763` | W07 | |
| C04.6 | Step 1: persist the operation, archive an immutable recovery intent, and verify it is readable before any dispatch. | implemented | `src/factory/releases.ts:330,437,491`; `src/factory/release-adapters.ts:32` | `EV/root-provider-receipt-parent-combined-integration-results.json@1ba2b6763` | W04a | The write-then-read-back byte compare exists. Independent failure-domain separation does not. |
| C04.7 | Step 2: one product transaction locks the operation, rechecks acceptance, membership, trust, deadline, archive receipt, and release-enable epoch, then atomically claims `pending → executing`. | implemented | `src/factory/releases.ts:484-514` | `EV/root-provider-receipt-parent-combined-integration-results.json@1ba2b6763` | W07 | |
| C04.8 | Step 4: the confirmed provider receipt is archived before the product database and orchestration notification. | implemented | `src/factory/releases.ts:515-530`; `src/factory/release-adapters.ts:131` | `EV/root-provider-receipt-parent-combined-integration-results.json@1ba2b6763` | W04a | Verified receipt attachment landed at `1ba2b6763`. |
| C04.9 | The three reconciliation actions each require a scoped operator, a reason, and provider evidence. | implemented | `src/factory/releases.ts:532` `reconcile`; `factory_release_reconciliations` CHECK | `EV/root-provider-receipt-parent-combined-integration-results.json@1ba2b6763` | W07 | Requires a human session plus `factory.operate`. |
| C04.10 | The release broker is the only holder of publish credentials; candidate runners cannot reach Git remotes or object-store write APIs. | unproven | credentials live in `src/factory/release-adapters.ts`; `packages/@ezcorp/extension-runner/src/podman.ts:103` uses `--network=none` | `EV/assembled-platform-results.json@8a21a81d9` | W07 | No release broker role exists yet, so the rule holds only because no factory publication path exists. |
| C04.11 | Publication-capable legacy steps are rejected unless mediated by the release broker. | missing | no legacy classifier under `src/factory` | none | W13 | |
| C04.12 | An approval request produces exactly one delivery in the notification outbox. | implemented | `src/factory/releases.ts:367-372` `factory_notifications` insert, claim, settle | `EV/root-provider-receipt-parent-combined-integration-results.json@1ba2b6763` | W17 | Delivery is the in-app view only. See C11.11. |
| C04.13 | A GitHub release adapter that creates one unique branch and one draft pull request. | missing | `src/factory/release-adapters.ts` exports only S3 adapters | none | W07 | `src/extensions/project-github-transport.ts` is the shared v4 transport, not a `FactoryReleaseProvider`. |
| C04.14 | An S3 release adapter that publishes an approved multi-object set and its final `manifest.json`. | missing | `src/factory/release-adapters.ts:93-135` publishes exactly one object | none | W08 | No `manifest.json` reference exists under `src/factory`. |

### C05 Package lifecycle and isolation

Plan section 7 owners: W01, W02, W05, W07, W09, W16, W19.

| ID | Requirement | Status | Source | Evidence | Owner | Note |
| --- | --- | --- | --- | --- | --- | --- |
| C05.1 | The supported CPU profile is the shipped rootless Podman profile with its fail-closed kernel probe. | implemented | `packages/@ezcorp/extension-runner/src/podman.ts:103`; driven by `src/factory/runner/supervisor.ts` | `EV/root-package-outcome-partition-merge-combined-integration-results.json@57751b80b` runs `package-preparation.podman.integration.test.ts` | W02 | |
| C05.2 | Factory runners add an attempt-private writable workspace. | missing | the workspace bind in `src/factory/runner/supervisor.ts` is read-only | none | W04 | Only a `FactoryWorkspaceCheckpoint` callback exists at `supervisor.ts:7`. |
| C05.3 | Factory runners have host-enforced egress to the tenant provider broker only. | missing | runners use `--network=none`; no netns or nftables route to a broker | none | W02 | |
| C05.4 | C03 resource classes are carried into each runner launch. | missing | launches use the fixed `executionLimits` constant at `packages/@ezcorp/extension-runner/src/core.ts:32` | none | W02 | Resource classes live separately in `src/factory/native-runner-policy.ts`. |
| C05.5 | The GPU profile injects one whole GPU through CDI on a tenant-dedicated host with a supported NVIDIA driver and toolkit pair, compute and utility capabilities, device reset, and reimage before reassignment. | infrastructure-blocked | no GPU, CDI, or NVIDIA reference exists in `packages/@ezcorp/extension-runner/src/podman.ts` | `EV/gpu-compute.log`, `EV/gpu-ten-workloads.log` record real AMD ROCm compute and record no producing commit | W02 | The available device is an AMD Radeon RX 7900 XTX. No production NVIDIA host is available. Plan section 3 records that the local probe maps both render devices. |
| C05.6 | Factory runners have no degraded tier; an unavailable isolation control fails admission. | implemented | `src/factory/boot.ts:5-13,96-113` `assertFactoryBootReadiness` | `EV/root-boot-phases-green-integration-results.json@8d83911c2` | W09 | `TrustedLocalRunner` is not referenced from `src/factory`. |
| C05.7 | Base hardening item 2: the secrets directory, `.pi-secret`, `.pi-salt`, and `.env` are in the deny set for every installation. | implemented | `src/extensions/permissions.ts:203-228` `resolveReservedSensitiveDirs`; `src/factory/boot.ts:83-92` | `EV/root-boot-phases-green-integration-results.json@8d83911c2` | W02 | |
| C05.8 | Base hardening item 3: one required-sandbox setting is honored by the shell and MCP seams and is on when `EZCORP_FACTORY_ENABLED=1`. | implemented | `src/factory/boot.ts:34-36`; `src/runtime/tools/shell.ts:88,93,113`; `src/extensions/mcp-sandbox.ts:201` | `EV/root-boot-phases-green-integration-results.json@8d83911c2`; `EV/hardening-config.json` records no head | W02 | |
| C05.9 | Base hardening item 4: a substring environment-leak classifier that classifies values as well as names. | implemented | `src/extensions/sensitive-environment.ts`; consumed by `src/extensions/clamp-permissions.ts:26,586` | `EV/root-boot-phases-integration-results.json@8d83911c2` | W02 | |
| C05.10 | The host supervisor runs outside every sandbox as a systemd unit, a privileged Compose service, or a DaemonSet. | missing | `deploy/extension-runner/extension-runner.service` is the v4 runner as a rootless user unit | none | W16 | No privileged Compose service and no DaemonSet manifest exists. |
| C05.11 | Package states extend the v4 fence with `quarantined` and `revoked`, and quarantine cancels and fences affected attempts. | unproven | `revoked` exists as a trust-revision state at `src/db/migrations/add-factory-package-preparations.ts:20`; `src/factory/package-preparation.ts:106` | `EV/root-package-trust-parent-integration-results.json@070f09796` | W02 | `quarantined` does not exist anywhere. The state is not on the v4 `installation.generation` fence. No cancellation or fencing of affected attempts exists. |
| C05.12 | Fetch and unpack run through the fetch proxy reusing the v4 dependency fetcher; install and build run in the v4 build container. | unproven | `packages/@ezcorp/extension-runner/src/dependencies.ts`; `src/factory/package-preparation.ts:129` `runnerClient.build` | `EV/root-package-outcome-partition-merge-combined-integration-results.json@57751b80b` | W02 | The build container is reused. No fetch proxy service exists. |
| C05.13 | Protected validators run in a separate sandbox with the candidate mounted read-only and unreplaceable protected assets. | unproven | `src/factory/validator-materials.ts:256-311` records assignment and evidence | `EV/root-protected-effects-parent-combined-integration-results.json@84cfd2a99` | W05 | Bookkeeping exists. No distinct validator sandbox launch with a read-only candidate mount exists. |
| C05.14 | Imported author TypeScript executes only in an isolated compiler job with no secrets or network. | missing | `src/factory/validator-materials.ts:204` calls `compileFactory` in the host process | none | W05 | The v4 discover RPC path exists but is not used for factory authoring. |
| C05.15 | The content lock extends `.runner/recipe.json` with model weights and resource classes. | missing | `podman.ts:184` writes only image, SDK, toolchain, seccomp, limits, and entrypoint | none | W02 | |

### C06 Durable records, retention, and restore

Plan section 7 owners: W04, W04a, W07, W08, W15, W16, W17, W19.

| ID | Requirement | Status | Source | Evidence | Owner | Note |
| --- | --- | --- | --- | --- | --- | --- |
| C06.1 | A canonical audit batch is appended before every externally visible kernel transition, keyed by tenant, logical run, interpreter, and source sequence, with batch and predecessor digests and a unique constraint. | implemented | `src/factory/records.ts:166-187,285`; `src/db/migrations/add-factory-records.ts:30-42` | `EV/root-private-validator-dispatch-merge-combined-integration-results.json@ac656591e` | W09 | The projection sequence is allocated under a `FOR UPDATE` run-row lock. |
| C06.2 | Projection consumers apply only the next contiguous sequence, ignore verified duplicates, and stop on gaps or conflicting digests. | implemented | `src/factory/records.ts:210-227`; `src/factory/run-transition-projector.ts` | `EV/root-projection-integration-results.json@55232b905` | W09 | That evidence file records a failing `types` leg at the same head. |
| C06.3 | A snapshot carries a verified sequence and digest, and rebuild replays subsequent batches. | unproven | `factory_run_projections` holds sequence, digest, and payload | `EV/root-projection-regression-results.json@618560260` records a failing `backend` leg | W09 | No named rebuild-by-replay entry point exists. |
| C06.4 | Retention classes of 30 days, 90 days, and 365 days with tombstone and reference-aware garbage collection. | missing | no retention, tombstone, or GC code under `src/factory` or the factory migrations | none | W15 | |
| C06.5 | Canonical audit batches and referenced snapshots are archived before their primary records expire, and archival failure stops cleanup. | missing | no expiry path exists | none | W15 | |
| C06.6 | Temporal history archival is configured for diagnostic replay during the audit period. | missing | no `archival` configuration in any workflow, Compose file, or script | none | W15 | |
| C06.7 | A per-installation data key encrypts payload codecs, archives, snapshots, and backups; rotation re-wraps and retains prior versions without re-encrypting in place. | implemented | `src/factory/encryption.ts:16,36-56,133-190`; `src/factory/encryption-key-wrap-store.ts` | `EV/assembled-platform-results.json@8a21a81d9` runs `encryption.test.ts` and `tests/postgres/factory-encryption-s3.test.ts` | W15 | |
| C06.8 | The self-hosted profile wraps the data key with an operator master key stored outside every grantable root; the wrapped key file is a separate Node orchestration-process secret. | implemented | `src/factory/encryption.ts:116` `readOperatorMasterKey`; `src/factory/file-key-wraps.ts:89-99` | `EV/root-c06-results.json@c82b1b05b` (node leg on `file-key-wraps.ts`) | W15 | |
| C06.9 | Hosted operation wraps the data key with a cloud KMS key. | missing | only `StaticMasterKeyProvider` at `src/factory/encryption.ts:107` | none | W15 | No KMS client or adapter exists in the repository. |
| C06.10 | Continuous PostgreSQL WAL backup and versioned object storage. | unproven | versioning is enabled by `scripts/setup-factory-storage.sh:62` and checked by `scripts/verify-factory-storage.ts:96-114` | `EV/integrity-local-storage.log` records no head | W15 | `src/db/backup.ts` is a PGlite directory copy. No `archive_command`, `pg_basebackup`, or WAL shipping exists. |
| C06.11 | A per-tenant compatible checkpoint barrier that stops mutations, drains senders, records positions, and seals a manifest in the independent archive, with a 2-second target, a 10-second maximum, at most 16 concurrent barriers, and a 15-minute age bound. | missing | no barrier code exists anywhere; all `checkpoint` hits are per-attempt workspace revisions | none | W15 | |
| C06.12 | Restore into a new execution epoch with admissions and release claims disabled, old deployment fencing, projection rebuild, archive import, provider reconciliation, and a signed operator recovery report. | missing | no restore procedure exists | none | W15 | |
| C06.13 | Every attempt token carries the execution epoch, and the gateway rejects tokens from an older epoch. | implemented | `src/factory/attempt-token.ts:7,20`; epoch predicates at `src/factory/executions.ts:210,327,359,392,403,412,521` | `EV/attempt-token-final-results.json@8a0008033` | W09 | Nothing in production increments `execution_epoch`; only a test helper does. `src/factory/execution-gateway.ts:23-45` does not itself compare the epoch. |
| C06.14 | The independent release archive uses conditional-create immutable objects with separate credentials, in a failure domain the product and restore credentials cannot reach. | infrastructure-blocked | `src/factory/release-adapters.ts:32`; `compose.factory-storage.local.yml` runs two separately credentialed SeaweedFS services | `EV/root-provider-receipt-s3-live.json` records `"failureDomain":"same-host-not-independent"` and no producing commit | W04a | Credential separation is proven. Failure-domain independence is not, and cannot be on this host. |

### C07 IR values and control semantics

Plan section 7 owners: W01, W02, W04, W05, W06, W13, W18, W20.

| ID | Requirement | Status | Source | Evidence | Owner | Note |
| --- | --- | --- | --- | --- | --- | --- |
| C07.1 | `@ezcorp/factory-sdk` owns the only execution schema and its versioned JSON Schema export. | implemented | `packages/@ezcorp/factory-sdk/src/index.ts:3-4` and eight checked-in schemas | `EV/root-authority-integration-results.json@647e63a53` runs the whole SDK suite | W18 | `scripts/check-factory-boundaries.ts` carries an `f13-duplicate` rule. |
| C07.2 | I-JSON parsing rejects duplicate keys, YAML aliases and custom tags, non-finite numbers, unsafe integers, and unpaired surrogates. | implemented | `packages/@ezcorp/factory-sdk/src/parse.ts:116,150,182-184`; `canonical.ts:7,22,25,43` | `EV/root-authority-integration-results.json@647e63a53` | W18 | |
| C07.3 | Canonical execution JSON is hashed with SHA-256 under RFC 8785, and presentation metadata has a separate digest. | implemented | `packages/@ezcorp/factory-sdk/src/canonical.ts:78,110`; `compiler.ts:764,788`; `validation.ts:463,466` | `EV/root-authority-integration-results.json@647e63a53` | W18 | |
| C07.4 | Only the listed port-schema keywords are supported; remote references, recursion, regex, combinators, and unknown keywords are rejected. | implemented | `packages/@ezcorp/factory-sdk/src/validation.ts:92-143` | `EV/root-authority-integration-results.json@647e63a53` | W18 | |
| C07.5 | Compatibility uses conservative structural containment. | implemented | `packages/@ezcorp/factory-sdk/src/validation.ts:272`; `kernel-containment.test.ts` | `EV/root-authority-integration-results.json@647e63a53` | W18 | |
| C07.6 | A static check proves the generated validator contains no code generation, regex, network, or ambient time. | implemented | `scripts/check-factory-boundaries.ts:99-121`; `scripts/check-factory-boundaries.test.ts:26-50` | `EV/root-authority-static-backend-integration-results.json@7ea6e4bd9` (boundaries leg exit 0) | W18 | |
| C07.7 | The generated validator executes inside a Temporal workflow bundle in the time-skipping environment. | implemented | `packages/@ezcorp/factory-orchestrator/test/temporal-replay.test.ts:201-202` | `EV/root-production-orchestrator-integration-results.json@8d83911c2` | W18 | |
| C07.8 | The Python runtime rejects the same forms through a generated Python validator. | missing | `src/factory/runner/python/c02_runner.py:41-60` validates JSON Schema, then shells out to `src/factory/runner/canonical-validator.mjs` | none | W02 | A validator that works in only one runtime is rejected by C07. Python has no independent equivalent. |
| C07.9 | The bounded expression AST supports exactly the 13 listed operators within 256 nodes, depth 16, and 1,024 steps. | implemented | `packages/@ezcorp/factory-sdk/src/expressions.ts:42`; `types.ts:20-22,65` | `EV/root-authority-integration-results.json@647e63a53` | W18 | |
| C07.10 | All ten constructs exist with their exact launch behavior. | implemented | `packages/@ezcorp/factory-sdk/src/types.ts:178-260`; `kernel.ts:763-775` | `EV/root-authority-integration-results.json@647e63a53` | W13 | |
| C07.11 | Run deadlines of 7 days by default and 30 days maximum, node deadlines of 30 minutes and 24 hours, and a 24-hour approval wait. | implemented | `packages/@ezcorp/factory-sdk/src/types.ts:24-28`; `kernel.ts:16`; `validation.ts:426` | `EV/root-authority-integration-results.json@647e63a53` | W13 | |
| C07.12 | The seven run states and eleven node states, with a waiting reason and absolute deadline. | implemented | `packages/@ezcorp/factory-sdk/src/kernel-types.ts:19-43,91` | `EV/root-authority-integration-results.json@647e63a53` | W13 | A separate product vocabulary exists at `types.ts:607 FactoryRunStatus`. |
| C07.13 | A speculative branch cannot contain a Release node or a publication effect, and cancelling it cancels pending approvals. | implemented | `packages/@ezcorp/factory-sdk/src/compiler.ts:205,429,439`; `kernel.ts:786-788,839-841` | `EV/root-authority-integration-results.json@647e63a53` | W13 | A decision that arrives after cancellation is deduplicated, not marked late. |
| C07.14 | All nine identity and counter terms exist with their stated owners. | implemented | `kernel-types.ts:57-59`; `pool/ledger.ts:35,63`; `releases.ts:77,315`; `attempt-token.ts:7` | `EV/root-provider-receipt-parent-combined-integration-results.json@1ba2b6763` | W13 | |
| C07.15 | Reference remediation makes protected rejection create a new candidate, freeze, checks, and a new decision within each domain's bound. | unmerged | `src/factory/run-controls.ts` (+92) and `src/factory/transition-authority.ts` (+66) on `feat/factory-release-idempotency-v2` at `3a84d4867` | none with an ancestor head | W06 | `b6cfa4798` adds a separate coverage-gate correction that must land after `3a84d4867`. |

### C08 Payloads, partitions, and continuation

Plan section 7 owners: W01, W03, W04, W06, W09, W13, W19.

| ID | Requirement | Status | Source | Evidence | Owner | Note |
| --- | --- | --- | --- | --- | --- | --- |
| C08.1 | Graph limits: 10,000 expanded node instances, scope depth 16, 16 MiB compiled definition. | implemented | `packages/@ezcorp/factory-sdk/src/types.ts:13,15,16`; `compiler.ts:398,697,698,747`; `validation.ts:392,426,464` | `EV/root-authority-integration-results.json@647e63a53` | W13 | |
| C08.2 | Transport limits: 64 KiB encoded argument, 512 KiB aggregate commands per workflow task, 32 KiB recorded page, 64 KiB inline input. | implemented | `packages/@ezcorp/factory-orchestrator/src/contracts.ts:14,18`; `factory-sdk/src/page-bytes.ts:1,7`; `types.ts:14,18` | `EV/root-production-orchestrator-integration-results.json@8d83911c2` | W04 | |
| C08.3 | Partition limits: 128 node instances per partition and 32 simultaneous activities per interpreter. | implemented | `packages/@ezcorp/factory-sdk/src/types.ts:17,19`; `compiler.ts:616`; `contracts.ts:23`; `workflow.ts:215` | `EV/root-production-orchestrator-integration-results.json@8d83911c2` | W04 | |
| C08.4 | A separate limit of 32 simultaneous child workflows per interpreter. | missing | children share `MAX_INFLIGHT_COMMANDS` with activities at `workflow.ts:105-115,215` | none | W09 | |
| C08.5 | A planned history budget of 8,000 events or 8 MiB per workflow run. | missing | no event or byte budget accounting exists in the orchestrator | none | W09 | |
| C08.6 | Stop new work and start drain or continuation at 4,000 events or 4 MiB. | missing | the nearest analogue is `contracts.ts:13 CONTINUE_AFTER_EVENTS = 64`, an unrelated count | none | W09 | |
| C08.7 | Control snapshot at most 64 KiB and at most 128 queued distinct control decisions per logical run. | implemented | `packages/@ezcorp/factory-orchestrator/src/validation.ts:19,170-172`; `contracts.ts:12`; `src/factory/inbox.ts:75` | `EV/private-service-final-results.json@ee82337b1` | W08 | |
| C08.8 | Immutable partition and page manifests; a workflow performs no unrecorded object-store read. | implemented | `factory-sdk/src/types.ts:328-371`; `compiler.ts:565-606`; `orchestrator/src/contracts.ts:192-204` | `EV/root-production-orchestrator-integration-results.json@8d83911c2` | W04 | `workflow.ts` imports no blob or S3 client. |
| C08.9 | A topologically ordered partition dependency graph that cannot introduce a cycle. | implemented | `factory-sdk/src/compiler.ts:536,603,609,629`; `validation.ts:517-542` | `EV/root-authority-integration-results.json@647e63a53` | W13 | |
| C08.10 | Cross-partition per-node completion notifications through the dispatcher, stored for a not-yet-started partition. | implemented | `src/factory/partition-commands.ts:26-30`; `src/factory/inbox.ts:62`; `orchestrator/src/dispatcher.ts:30-32` | `EV/root-package-outcome-partition-merge-combined-integration-results.json@57751b80b` | W04 | |
| C08.11 | History space is reserved for a task's worst-case command and event path before scheduling it. | missing | admission uses only `MAX_INFLIGHT_COMMANDS` | none | W09 | Follows from C08.5. |
| C08.12 | Continue-as-new only with no active execution activity or child workflow in that interpreter. | implemented | `orchestrator/src/workflow.ts:275` | `EV/root-production-orchestrator-integration-results.json@8d83911c2` | W09 | |
| C08.13 | The continuation snapshot carries the full listed field set, recreates timers from absolute deadlines, and persists acknowledged inbox positions across the chain. | unproven | `orchestrator/src/contracts.ts:97-108`; `workflow.ts:182,219-221,267,276` | `EV/root-production-orchestrator-integration-results.json@8d83911c2` | W09 | `KernelState` at `kernel-types.ts:124-175` carries `cancellationEpoch` but no `executionEpoch`, which the contract lists. |
| C08.14 | The product inbox retains ID and hash tombstones for the run's audit period. | missing | no tombstone concept in `src/factory/inbox.ts`, `outbox.ts`, or any factory migration | none | W15 | |
| C08.15 | The transactional approval inbox addresses the stable logical run and approval ID, with unique decision and outbox delivery and a chain-resolving dispatcher. | implemented | `src/factory/inbox.ts:9,55-81`; `src/factory/outbox.ts:81,103-105`; `orchestrator/src/dispatcher.ts:28-32,68-89` | `EV/private-service-final-results.json@ee82337b1` | W08 | |

### C09 API, authoring, and console behavior

Plan section 7 owners: W06, W09, W14, W16, W18, W20.

| ID | Requirement | Status | Source | Evidence | Owner | Note |
| --- | --- | --- | --- | --- | --- | --- |
| C09.1 | Factory API resources live under `/api/factories` with one validated request and response schema source from the SDK. | unproven | 28 `+server.ts` files under `web/src/routes/api/factories/projects/[projectId]/`; `_shared.ts` | none with an ancestor head | W14 | No evidence file with an ancestor head covers the web route suites. |
| C09.2 | Every route and its actual scope are registered in `src/api-registry.ts`. | unproven | `src/api-registry.ts:60-93`, 34 entries with `category: "factories"` | none with an ancestor head | W14 | |
| C09.3 | Factory event names are registered in the canonical runtime event-name module. | missing | `web/src/lib/runtime-event-names.ts` contains no factory name | none | W14 | The route-contract parity test therefore checks nothing factory-related. |
| C09.4 | A first-party SvelteKit console route family under `/factories`. | unproven | `web/src/routes/(app)/factories/+page.svelte`; components under `web/src/lib/factory/` | `EV/authoring-integration-results.json` records exit 0 and no producing commit | W14 | One page, not a route family. Nested run inspection, attempts, blockers, costs, and controls are absent. |
| C09.5 | `EZCORP_FACTORY_ENABLED=1` is read once at boot and fails closed; the required-service list gates readiness. | implemented | `src/factory/boot.ts:5-13,43`; `web/src/hooks.server.ts:533-536` | `EV/root-boot-phases-green-integration-results.json@8d83911c2` | W09 | |
| C09.6 | A flag-on PGlite installation fails startup with a named error. | implemented | `src/factory/boot.ts:69-74` throws `factory-pglite-unsupported` | `EV/root-boot-phases-red-integration-results.json@8d83911c2` | W09 | The red evidence file records a failing `postgres` leg at that head. |
| C09.7 | When the flag is off, factory routes return 404 with a `factory-disabled` reason. | implemented | `web/src/routes/api/factories/_shared.ts:109` | `EV/root-boot-phases-green-integration-results.json@8d83911c2` | W09 | The emitted reason string is `factory_disabled` with an underscore, not the contract's `factory-disabled`. |
| C09.8 | Factory DDL is idempotent and additive and runs on every installation regardless of the flag. | implemented | `src/db/migrate.ts:3027+` invokes about 25 `add-factory-*` migrations unconditionally | `EV/root-restart-adapter-integration-results.json@176f6871f` runs `factory-migration-restart.test.ts` | W09 | That evidence file records a failing `types` leg at the same head. |
| C09.9 | One shared handler wrapper implements the idempotency key and payload hash for both v4 and factory surfaces. | unproven | shared helpers at `src/idempotency.ts`; factory logic at `web/src/routes/api/factories/_shared.ts:153-180` | none with an ancestor head | W14 | Helpers are shared. The handler wrapper is not: the Hub action route has its own. |
| C09.10 | Live view uses an authenticated snapshot plus SSE from the contiguous projection cursor, with 410 on an expired cursor, gap catch-up, and revocation closing the stream. | missing | no `text/event-stream` route under `web/src/routes/api/factories/` | none | W14 | |
| C09.11 | All supported constructs round-trip through the visual editor without semantic loss, and unknown versions open read-only. | unproven | `web/src/lib/factory/model.ts`, `layout.ts`, `download.ts` | `EV/authoring-integration-results.json` records no producing commit | W14 | |
| C09.12 | A boundary test forbids Svelte Flow and ELK imports outside `web/src/lib/factory/`. | implemented | `scripts/check-boundaries.ts`; `src/__tests__/gate-scripts.test.ts:2260-2269` | `EV/root-authority-static-backend-integration-results.json@7ea6e4bd9` | W18 | |
| C09.13 | Hostile preview handling: `nosniff` and attachment headers, re-encoded images, non-executable SVG and HTML, and scoped artifact tickets. | missing | no factory artifact download or preview route exists | none | W14 | `web/src/lib/factory/download.ts` is a client-side Blob download of the definition only. |
| C09.14 | A tenant purge request surface for a human administrator. | missing | no purge route in `src/api-registry.ts` or under `web/src/routes/api/factories/` | none | W14 | |
| C09.15 | Repair and replan request routes wired to the production application and user controls. | unmerged | `web/src/lib/factory/client.ts` (+9) and `web/src/routes/api/factories/_shared.ts` (+14) on `feat/factory-release-idempotency-v2` at `3a84d4867` | none with an ancestor head | W06 | |

### C10 Concrete launch domain contracts

Plan section 7 owners: W05, W06, W07, W08, W10, W11, W12, W13, W14, W19.

| ID | Requirement | Status | Source | Evidence | Owner | Note |
| --- | --- | --- | --- | --- | --- | --- |
| C10.1 | `reference.code.v1` compiles with the exact graph shape: snapshot, generate, freeze, protected checks, acceptance, bounded repair, approval, GitHub release. | implemented | `packages/@ezcorp/factory-sdk/src/references.ts:102-165` | `EV/root-authority-integration-results.json@647e63a53` runs `reference-execution.test.ts` | W10 | Shape only. Every task body names a package that does not exist, with synthetic digests from `references.ts:15`. |
| C10.2 | The ten code mandatory claims run against a real repository with real provider usage. | missing | claim IDs are declared at `references.ts:152-163`; no evaluator exists | none | W10 | The rubric fields `matchesRequest`, `noUnrequestedEffect`, and `noKnownCriticalIssue` appear nowhere in the tree. |
| C10.3 | The slugify golden fixture and its three negative fixtures. | missing | no `slugify` or `hello-factory` fixture anywhere in the tree | none | W10 | |
| C10.4 | `reference.image.v1` compiles with seeds 11, 23, 37, 53, 30 steps, guidance 7.5, 1024 by 1024, and a two-of-three semantic quorum. | implemented | `packages/@ezcorp/factory-sdk/src/references.ts:184-262` | `EV/root-authority-integration-results.json@647e63a53` | W11 | |
| C10.5 | The SDXL pipeline, pinned model revision and weight digests, and the pinned Tesseract English validator. | missing | the only Python project, `src/factory/runner/python/pyproject.toml`, depends on `jsonschema` alone | none | W11 | No Diffusers, no safetensors, no Tesseract. |
| C10.6 | The image negative fixtures: wrong size, SALE caption, car, and the retained human-reviewed tree. | missing | none in the tree | none | W11 | |
| C10.7 | `reference.data.v1` compiles with 10,000-row partitions, a 1,000,000-row and 256 MiB bound, and an explicit ordered reduction. | implemented | `packages/@ezcorp/factory-sdk/src/references.ts:269-299` | `EV/root-authority-integration-results.json@647e63a53` | W12 | |
| C10.8 | The CSV header `record_id,category,amount_cents`, the pinned PyArrow transform, Parquet output, the golden three-row fixture, and the four negative fixtures. | missing | `"pyarrow-transform"` is a node ID string only; no PyArrow dependency and no Parquet code | none | W12 | |
| C10.9 | The shared `s3.immutable-publish.v1` adapter with an operation directory and a final `manifest.json` publication point. | missing | `references.ts:176` names a nonexistent package; `src/factory/release-adapters.ts:93-155` publishes one object | none | W08 | |
| C10.10 | `reference.catalog.v1` composes data and image children in acceptance-only mode, with `releaseMode` as a typed two-value enum. | implemented | `packages/@ezcorp/factory-sdk/src/references.ts:313-343`; `types.ts:229`; `factory-definition.schema.json:1384,1410` | `EV/root-authority-integration-results.json@647e63a53` | W13 | Shape only. The children have no implementations. |
| C10.11 | The three legacy-engine changes: a `factory:` caller-facing key, unique-conflict discrimination, and a periodic orphan sweep sub-tick. | implemented | `src/runtime/workflow-executor.ts:893-897,1029-1047`; `src/idempotency.ts:38`; `src/extensions/host-maintenance-daemon.ts:516-526` | `EV/root-authority-static-backend-integration-results.json@7ea6e4bd9` (full `bun run test` exit 0) | W13 | |
| C10.12 | The `legacy.workflow.v1` adapter with non-publishing allowlist classification, administrator attestation bound to a definition digest, and the full status mapping. | missing | no `legacy.workflow.v1` kind in the SDK or `src/factory` | none | W13 | |
| C10.13 | Real remote receipts: a draft pull request and verified remote object content. | infrastructure-blocked | no GitHub release adapter exists | `EV/root-provider-receipt-s3-live.json` records ten S3 publications and no producing commit | W07, W08 | The private test repository `ezcorp-org/factory-platform-publication-tests` is authorized. The selected-repository GitHub App and broker-only namespace are unverified. |

### C11 Service targets and verification lanes

Plan section 7 owners: W15, W16, W17, W18, W19, W20.

| ID | Requirement | Status | Source | Evidence | Owner | Note |
| --- | --- | --- | --- | --- | --- | --- |
| C11.1 | The hosted load profile: 100 installations, 1,000 active runs, 100 ready tasks per second, 10 MiB per second of object traffic. | infrastructure-blocked | no load harness exists | none | W19 | The plan's local milestone substitutes a ten-installation profile and states it is not this proof. |
| C11.2 | The self-hosted certification profile: one installation, ten active runs, one completion per second, one 10,000-node graph. | missing | no load harness exists | none | W19 | |
| C11.3 | The fixed target table: throughput, admission delay, API and projection latency, recovery, replay, cancellation, safety, disaster recovery, browser. | missing | no measurement producer exists for any row | none | W19 | |
| C11.4 | The fault-injection matrix and the separate reporting of fault and barrier windows. | missing | no fault harness exists | none | W19 | |
| C11.5 | A Prometheus-format `/metrics` endpoint on every factory service. | missing | no `/metrics` route in `src/api-registry.ts` or `src/factory/private-service.ts` | none | W17 | |
| C11.6 | The eight alert rules shipped as rule files with a configured evaluator for both profiles. | missing | no rule file exists anywhere | none | W17 | |
| C11.7 | A `factory_notifications` outbox drained by a new outbound webhook and optional SMTP sender. | unproven | the outbox exists at `src/factory/releases.ts:367-372,581-589` | `EV/root-provider-receipt-parent-combined-integration-results.json@1ba2b6763` | W17 | `deliverNextNotification` only flips state to `delivered`. `src/factory/notification-delivery.ts` is an in-app view wrapper. No outbound sender exists: `src/factory` contains no `fetch(` call and the tree has no SMTP client. |
| C11.8 | Node and Python are pinned by `.node-version`, `.python-version`, and `src/factory/runner/python/uv.lock`, reusing the Bun skew comparison helpers. | unproven | `.node-version` 24.14.1, `.python-version` 3.13.12, `uv.lock` present | `EV/temporal-environment-probe.json` records no head | W18 | `src/__tests__/runtime-version-pins.test.ts` does literal string equality. The `scripts/check-bun-version.ts` helpers are not reused, and no Node or Python skew checker exists. |
| C11.9 | `ruff` and strict `mypy` are wired into the lint and typecheck wrappers. | missing | both are declared in `src/factory/runner/python/pyproject.toml` and invoked nowhere | none | W18 | `package.json` `lint` is Biome only; `scripts/typecheck.sh` runs `tsc` only. |
| C11.10 | Node built-in lcov and Python `coverage.py` lcov are registered as producers and covered by the lcov guard test. | missing | `scripts/coverage-config.ts:155-168,322-326` registers neither | none | W18 | `src/factory/runner/python-runner.integration.test.ts:27,58` produces `coverage.json` in a temp directory that `afterAll` deletes. |
| C11.11 | The factory SDK is registered in `SOURCE_GLOBS`, coverage thresholds, the test-file sets, and shard timings. | implemented | `scripts/coverage-config.ts:122`; `scripts/coverage-thresholds.json:150-164`; `scripts/lib/test-file-sets.sh:85-87,114,353`; `scripts/shard-timings.json` | `EV/root-authority-static-backend-integration-results.json@7ea6e4bd9` | W18 | |
| C11.12 | All seven required CI lanes exist as named checks. | unproven | `.github/workflows/ci.yml:62` `Factory schema and kernel`; `:78` `Factory Temporal integration`; `:44` `Factory runner readiness precheck` | `EV/root-authority-static-backend-integration-results.json@7ea6e4bd9` (actionlint exit 0) | W18 | Two of seven exist. `Factory runner contracts`, `Factory assurance and release`, `Factory isolation`, `Factory product and domain E2E`, and `Factory deployment and operations` are absent. `db-postgres.yml` carries factory steps inside `External Postgres (Bun.sql)`, not a factory lane. |
| C11.13 | `scripts/check-required-checks.ts` reads branch protection and fails on a missing or renamed lane. | implemented | `scripts/check-required-checks.ts:3-19,82-84,125` | `EV/root-authority-static-backend-integration-results.json@7ea6e4bd9` | W18 | Actual hosted enforcement is unverified. `docs/validation/factory/stage-1/required-check-inspection.md` is the historical report. |
| C11.14 | Self-hosted `factory-real` and `factory-gpu` runners with a precheck that fails within 5 minutes. | infrastructure-blocked | `scripts/check-factory-runners.ts:23`; `.github/workflows/ci.yml:44-60` with `timeout-minutes: 5` | `EV/initial-manifest.json@55cf79ec5` records an empty runner inventory | W18 | No job anywhere uses `runs-on: [self-hosted, factory-real]` or `factory-gpu`. The precheck guards jobs that do not yet exist. |
| C11.15 | A `factory-services` browser lane registered in all five CODEOWNERS files and the ci.yml consumer. | missing | `src/__tests__/e2e-lanes.test.ts:30` and `web/e2e/lanes.json` list seven lanes without it | none | W18 | The only `factory-services` string in the repository is the boot readiness reason at `src/factory/boot.ts:52`. |

### C12 Hosted control plane and provisioning

Plan section 7 owners: W15, W16, W17, W19.

| ID | Requirement | Status | Source | Evidence | Owner | Note |
| --- | --- | --- | --- | --- | --- | --- |
| C12.1 | A separate operator-only control plane holding the tenant directory and nothing else about customers. | missing | no control-plane service, operator API, or tenant directory exists | none | W16 | `factory_installations` at `src/factory/provisioning/local.ts:54` is a provisioning ledger. |
| C12.2 | Provisioning step 1: PostgreSQL database and role with a generated password, idempotent by tenant ID. | implemented | `src/factory/provisioning/local.ts:20,78-129` | `EV/root-c06-results.json@c82b1b05b` | W16 | Includes a committed pre-DDL phase for crash reconciliation. |
| C12.3 | Provisioning step 2: object-store prefix with prefix-scoped credentials plus a separately credentialed archive prefix in another failure domain. | infrastructure-blocked | `src/factory/provisioning/local.ts:43,78` reads two pre-seeded credential files | `EV/root-provider-receipt-s3-live.json` records `same-host-not-independent` | W16, W04a | No prefix is created and no credential is minted. `compose.factory-storage.local.yml` states both services run on one host. |
| C12.4 | Provisioning step 3: Temporal namespace with namespace-scoped mutual TLS credentials. | missing | injected interface at `local.ts:9,118`; `verifyReady` at `:135` only checks files exist | none | W16 | The mutual-TLS server configuration lives in `compose.factory-platform.local.yml:15-42`, not the provisioner. |
| C12.5 | Provisioning step 4: generated JWT and encryption secrets plus the wrapped data key. | unproven | `local.ts:78-79` generates both secrets | `EV/root-c06-results.json@c82b1b05b` | W16 | The wrapped data key is not provisioned. `SecretBundle` at `local.ts:14` has no wrapped-key field. |
| C12.6 | Provisioning step 5: harness, orchestration process, and gateway deployments delivered as secrets. | missing | no deployment step exists | none | W16 | |
| C12.7 | Provisioning step 6: ingress hostname bound to the installation ID. | missing | `local.ts:54` records and uniqueness-constrains a hostname only | none | W16 | |
| C12.8 | Provisioning step 7: first-administrator invitation, with the first human login as the consent authority. | missing | `local.ts:65` generates an invitation UUID; `:119` sets `current_step = 'invitation'` | none | W16 | No invitation is issued, sent, or redeemable. |
| C12.9 | Separate states for resources prepared, deployment ready, invitation issued, and human bootstrap complete. | missing | the CHECK at `local.ts:54` allows only `partial` and `ready` | none | W16 | The file comment at `:45` states that a `ready` record means only that infrastructure resources exist. |
| C12.10 | Pinned Compose self-hosted and Kubernetes hosted deployments for the factory services. | missing | `deploy/` holds only the v4 extension runner, preview DNS, and SearXNG; no Kubernetes manifest, chart, or namespace file exists | none | W16 | `compose.factory-platform.local.yml` and `compose.factory-storage.local.yml` are digest-pinned local proof services and deploy no factory service. |
| C12.11 | Canary-first fleet upgrade waves, old build-ID retention, staggered barrier backups, and teardown that keeps the release archive. | missing | no canary or tombstone code under `src/factory` | none | W16 | |
| C12.12 | The installation checklist naming every operator prerequisite from C05, C06, and C11. | missing | only the plan documents mention it | none | W16 | `docs/factory-local-gpu.md`, `docs/factory-local-storage.md`, and `docs/factory-local-publication.md` are narrow local guides. |

### C13 Reuse of the extension v4 lifecycle

Plan section 7 owners: W00 through W20.

| ID | Requirement | Status | Source | Evidence | Owner | Note |
| --- | --- | --- | --- | --- | --- | --- |
| C13.1 | A boundary test asserts that factory modules import the shared v4 modules named in the C13 table. | implemented | `scripts/check-factory-boundaries.ts:28-60,253`; run at `.github/workflows/ci.yml:72` | `EV/root-authority-static-backend-integration-results.json@7ea6e4bd9` | W18 | `SHARED_REUSE_MODULES` covers 14 modules. `REQUIRED_SHARED_IMPORTS` is 12 pairs touching only 3 distinct shared modules across 7 factory files. |
| C13.2 | No factory module defines a function whose name and signature duplicates a shared module's. | implemented | `scripts/check-factory-boundaries.ts:186-213` | `EV/root-authority-static-backend-integration-results.json@7ea6e4bd9` | W18 | The key is name plus parameter counts only. A rename or one extra optional parameter passes silently. |
| C13.3 | The delivery queue is one shared module used by both v4 and the factory. | implemented | `src/delivery-queue/durable-delivery-queue.ts`, imported by `src/extensions/v4/deliveries.ts:6` and `src/factory/outbox.ts:6` | `EV/private-service-final-results.json@ee82337b1` | W00 | No second implementation. |
| C13.4 | The blob store is one shared interface with an S3 implementation behind it. | implemented | `src/extensions/v4/blobs.ts:113` `S3BlobStore`; six factory files are required to import it | `EV/assembled-platform-results.json@8a21a81d9` | W04 | |
| C13.5 | `insertTransactionalAuditEntry` is the only record of authority; no third audit path is added. | implemented | `src/db/queries/audit-log.ts`, required by four factory modules in the boundary inventory | `EV/root-private-validator-dispatch-merge-combined-integration-results.json@ac656591e` | W00 | |
| C13.6 | The v4 human approval is reused through shared modules with added tenant and destination fields. | unproven | `src/extensions/v4/approval-context.ts` is shared with `src/factory/assurance.ts` | `EV/root-provider-receipt-parent-combined-integration-results.json@1ba2b6763` | W07 | No `REQUIRED_SHARED_IMPORTS` row covers approval, so the boundary checker does not enforce it. |
| C13.7 | Each work package extends the boundary inventory for the shared modules it touches. | unproven | the inventory is static at `scripts/check-factory-boundaries.ts:28-60` | none | W18 | No mechanism links a work package to an inventory extension. W18 must verify the accumulated inventory. |
| C13.8 | The isolation profile, dependency fetcher, build container, recipe machinery, runtime locks, and maintenance daemon are reused, not reimplemented. | implemented | all six are in `SHARED_REUSE_MODULES`; the factory drives `podman.ts` through `src/factory/runner/supervisor.ts` | `EV/root-package-outcome-partition-merge-combined-integration-results.json@57751b80b` | W02 | Reuse holds. The factory extensions those modules need are listed under C05. |

## B. Launch proofs F01–F13

In this table, status describes the proof artifact, not the source. **implemented** means the
complete proof ran and its evidence records an ancestor head. **unproven** means at least one
producer exists but the complete proof is not established. **missing** means no producer exists.
**unmerged** means the producer exists only on unmerged source. **infrastructure-blocked** means a
required leg needs hardware, an independent failure domain, or hosted runners that are unavailable.

| ID | Requirement | Status | Source | Evidence | Owner | Note |
| --- | --- | --- | --- | --- | --- | --- |
| F01 | Two secrets reject a foreign-signed and an audience-less token in stage 2a; two C12-provisioned installations with overlapping IDs exercise lists, search, download, provider access, expiry, and revocation in stage 2d; SSE, approvals, and the legacy adapter in stage 5. | unproven | `src/auth/jwt.ts:91-142`; `src/factory/grants.ts`; `src/factory/artifact-access.ts` | `EV/root-auth-integration-results.json@d84359f84` (stage 2a leg only) | W03, W09, W13, W14, W16, W19 | The stage 2a token leg passes. No provisioner produces two serving installations, so stages 2d and 5 have no producer. |
| F02 | Node to Bun to a real tool plus a Python conformance task; kill Node, gateway, sandbox, and host at each journal boundary; recover on a different host without the prior local directory. | unmerged | `src/factory/runner/attempt-runtime.ts` on `feat/factory-lazy-input` at `6c500113a`; `src/factory/runner/native.ts` and `supervisor.ts` in HEAD | none with an ancestor head | W01, W02, W03, W04, W09, W19 | The plan records one real supervisor SIGKILL, attach, and cancel case on the unmerged checkpoint. Recovered `wait()` still refuses a terminal result. No evidence file records `6c500113a`. |
| F03 | Lose each acquire, acknowledgement, and settlement response; partition a running runner; race two children for the last budget unit; cancel during admission; run a nested one-slot run; assign and reimage a GPU host; destroy the pool ledger. | unproven | `src/factory/pool/ledger.ts`, `service.ts`, `process.ts`; `src/factory/budgets.ts` | `EV/root-budget-allocation-integration-results.json@6d99c8225`; `EV/root-terminal-budget-integration-results.json@1d09de66f` | W02, W03, W09, W15, W19 | Budget legs pass at ancestor heads. No pool PostgreSQL evidence file records a head. The GPU reimage leg has no supervisor to sign a receipt. |
| F04 | Race dispatchers, policy revocation, cancellation, approval expiry and reuse, changed request bytes, and destination version changes on both sides of the claim; then drop a real provider response, stop the old sender, and reconcile without a second effect. | unproven | `src/factory/releases.ts`; `src/factory/release-adapters.ts`; `src/factory/assurance.ts` | `EV/root-provider-receipt-parent-combined-integration-results.json@1ba2b6763`; `EV/root-provider-receipt-s3-live.json` (no head) | W04a, W05, W06, W07, W08, W09, W17, W19 | The stage 3 fixture legs pass. The GitHub real-adapter leg has no adapter. The archive prerequisite is same-host only. |
| F05 | Prove each open base-hardening item, keep the closed-item regressions, run malicious archive, install, build, import, and task fixtures under both deployment profiles, and verify exclusive GPU assignment and fencing. | infrastructure-blocked | `src/extensions/permissions.ts:203-228`; `src/extensions/sensitive-environment.ts`; `src/factory/boot.ts:34-92`; `packages/@ezcorp/extension-runner/src/podman.ts` | `EV/root-boot-phases-green-integration-results.json@8d83911c2`; `EV/gpu-compute.log` and `EV/gpu-ten-workloads.log` (no head) | W01, W02, W05, W07, W09, W16, W19 | Base hardening passes at an ancestor head. The GPU gate needs a tenant-dedicated NVIDIA host that does not exist here. Both deployment profiles are absent. |
| F06 | Expire ordinary history, delete test projections, rebuild the run view from the archive, inject gaps and conflicts, restore a mismatched backup, restore the latest compatible checkpoint, fence old workers, and measure loss and recovery. | unproven | `src/factory/records.ts`; `src/factory/encryption.ts`; `src/extensions/v4/blobs.ts:113` | `EV/assembled-platform-results.json@8a21a81d9`; `EV/root-c06-results.json@c82b1b05b` | W04, W04a, W07, W08, W15, W16, W17, W19 | Storage and key legs pass. Retention, archival-before-expiry, the barrier, and restore have no producer. |
| F07 | Golden schema fixtures and event traces over every construct; static proof that the generated validator contains no code generation; in-bundle execution under the Temporal time-skipping environment; Python rejects the same forms. | unproven | `packages/@ezcorp/factory-sdk/src`; `scripts/check-factory-boundaries.ts:99-121`; `packages/@ezcorp/factory-orchestrator/test/temporal-replay.test.ts` | `EV/root-authority-integration-results.json@647e63a53`; `EV/root-production-orchestrator-integration-results.json@8d83911c2`; `EV/root-authority-static-backend-integration-results.json@7ea6e4bd9` | W01, W02, W04, W05, W06, W13, W18, W20 | Stage 1 and stage 2b legs pass. The stage 2c Python equivalence leg has no producer; the Python runner delegates to a Node bridge. |
| F08 | Load a 10,000-node graph with paged map inputs and results, force repeated continuation below server limits, deliver an approval and a cancel before, during, and after continuation, and replay the full chain. | unproven | `packages/@ezcorp/factory-orchestrator/src/workflow.ts`, `validation.ts`; `src/factory/inbox.ts`, `outbox.ts` | `EV/root-production-orchestrator-integration-results.json@8d83911c2`; `EV/private-service-final-results.json@ee82337b1` | W01, W03, W04, W06, W09, W13, W19 | The history-budget and drain thresholds that F08 checks are not implemented, so the accounting leg cannot run. |
| F09 | Round-trip every construct to the same execution digest, race two saves and a publish, test unknown-version read-only handling, SSE missed and duplicate events, revocation, hostile previews, keyboard-only authoring, and narrow-screen evidence. | unproven | `web/src/lib/factory/`; `web/src/routes/api/factories/`; `src/factory/boot.ts` | `EV/authoring-integration-results.json` (no head); `EV/root-boot-phases-green-integration-results.json@8d83911c2` (flag leg) | W06, W09, W14, W16, W18, W20 | The flag and migration legs pass. SSE, hostile previews, and purge have no implementation. Console browser evidence records no producing commit. |
| F10 | Each reference definition compiles and runs with its real runner, provider, and destination, passes a valid fixture, rejects negatives, repairs, reconciles a lost response, and yields a verified remote receipt. | unproven | `packages/@ezcorp/factory-sdk/src/references.ts` | `EV/root-authority-integration-results.json@647e63a53` (compile and simulate legs) | W05, W06, W07, W08, W10, W11, W12, W13, W14, W19 | Only inert graph signatures exist. No generator, validator, model, OCR, PyArrow, or legacy adapter implementation exists. |
| F11 | Execute the declared steady, soak, and fault profiles; evaluate the fixed target table; validate hosted required checks, deliberate lane failures, all native builds and coverage, clean installations, upgrades, backup-age enforcement, restore, and alerts. | infrastructure-blocked | `scripts/check-required-checks.ts`; `scripts/check-factory-runners.ts`; `.github/workflows/ci.yml` | `EV/initial-manifest.json@55cf79ec5` records an empty GitHub runner inventory | W15, W16, W17, W18, W19, W20 | Hosted enforcement needs branch-protection administration. Labelled self-hosted runners are not registered. No load or soak harness exists. |
| F12 | Provision two tenants and use them as the F01 installations, provision 100 for the load run, fail each provisioning step, run a canary-first upgrade wave with a deliberate migration failure, and tear down a tenant. | unproven | `src/factory/provisioning/local.ts` | `EV/root-c06-results.json@c82b1b05b` (step 1 and fault legs) | W15, W16, W17, W19 | Only provisioning step 1 exists. No control plane, deployment, ingress, invitation, canary, or teardown producer exists. |
| F13 | A boundary test asserts shared-module imports and no duplicate name-and-signature, run from stage 1, with each stage extending the list. | unproven | `scripts/check-factory-boundaries.ts`; `scripts/check-factory-boundaries.test.ts`; `.github/workflows/ci.yml:72` | `EV/root-authority-static-backend-integration-results.json@7ea6e4bd9` | W00, W01, W02, W03, W04, W04a, W05, W06, W07, W08, W09, W13, W18, W20 | The stage 1 form passes at an ancestor head. The inventory has not been extended per work package, and the duplicate key is name plus parameter counts only. |

## C. Platform gates

The eleven gates are in `tasks/factory/GATES.md`. Every one is open. Closing work packages are
derived from the plan's section 7 gate table and the section 5 pass criteria.

| ID | Requirement | Status | Source | Evidence | Owner | Note |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Kernel, compiler, and simulator plus golden domain definitions satisfy F07, F10, and F13; the SDK builds with registered coverage. | unproven | `packages/@ezcorp/factory-sdk/src`; `scripts/check-factory-boundaries.ts`; `scripts/coverage-config.ts:122` | `EV/root-authority-integration-results.json@647e63a53`; `EV/root-authority-static-backend-integration-results.json@7ea6e4bd9` | W02, W13, W18, W20 | SDK build, coverage registration, and the boundary check pass. F07's Python leg and F10's realigned real definitions remain open. |
| S2a | Base hardening plus token, flag, and toolchain proofs pass. | unproven | `src/extensions/permissions.ts`; `src/extensions/sensitive-environment.ts`; `src/factory/boot.ts`; `src/auth/jwt.ts` | `EV/root-boot-phases-green-integration-results.json@8d83911c2`; `EV/root-auth-integration-results.json@d84359f84` | W02, W09, W18 | Hardening, token, and flag legs pass. The pinned Node and Python lanes, `ruff`, `mypy`, native coverage producers, and the no-runner failure proof are open. |
| S2b | Real Temporal, durable storage, outbox, projections, and continuation proofs pass. | unproven | `packages/@ezcorp/factory-orchestrator/src`; `src/factory/records.ts`, `inbox.ts`, `outbox.ts`; `src/extensions/v4/blobs.ts` | `EV/root-production-orchestrator-integration-results.json@8d83911c2`; `EV/private-service-final-results.json@ee82337b1` | W04, W09, W13, W18 | The Temporal lane exists and passes. The object-store conformance suite runs in the PostgreSQL job, not this lane. The history budget and drain thresholds are unimplemented. |
| S2c | The real native and Python bridge plus recovery and isolation proofs pass. | unmerged | `src/factory/runner/attempt-runtime.ts` on `6c500113a`; `src/factory/runner/native.ts`, `supervisor.ts` in HEAD | none with an ancestor head for the recovery case | W01, W02, W03, W04 | The one real crash-and-attach case lives on unmerged source. Workspace checkpoints, the stop budget, and the isolated Python guest are absent. |
| S2d | Tenant installations, scoped reads, budgets and fencing, pool fairness, and GPU allocation proofs pass. | unproven | `src/factory/pool/`; `src/factory/budgets.ts`; `src/factory/grants.ts`; `src/factory/provisioning/local.ts` | `EV/root-budget-allocation-integration-results.json@6d99c8225`; `EV/root-authority-integration-results.json@647e63a53` | W02, W03, W16, W19 | Budgets and grants pass. No pool evidence records a head. No installation serves traffic. Per-attempt device allocation does not exist. |
| S3 | Assurance, release authority and reconciliation, and delivered notification proofs pass. | unproven | `src/factory/assurance.ts`, `releases.ts`, `release-authority.ts`, `validator-materials.ts` | `EV/root-provider-receipt-parent-combined-integration-results.json@1ba2b6763`; `EV/root-protected-effects-parent-combined-integration-results.json@84cfd2a99` | W04a, W05, W06, W07, W08, W17 | Authority, idempotency, and reconciliation legs pass. The notification is in-app only. Protected rejection, remediation, and both publication adapters are open. The patch-coverage gate failed at `84cfd2a99`. |
| S4 | All package preparation, execution, and revocation CPU and GPU isolation proofs pass in both deployment profiles. | infrastructure-blocked | `src/factory/package-preparation.ts`; `packages/@ezcorp/extension-runner/src/podman.ts` | `EV/root-package-outcome-partition-merge-combined-integration-results.json@57751b80b`; `EV/gpu-compute.log` (no head) | W02, W16, W19 | CPU preparation passes on real Podman. `quarantined` does not exist. No GPU profile, no CDI, and no deployment profile exists. |
| S5 | The console and all three production domain journeys plus composition pass with actual remote receipts. | missing | `packages/@ezcorp/factory-sdk/src/references.ts` holds inert signatures; `web/src/lib/factory/` holds the authoring console | `EV/authoring-integration-results.json` (no head); `EV/factory-authoring-wide-light-long-labels.png` | W07, W08, W10, W11, W12, W13, W14 | No domain implementation exists. The gate file's own evidence note already limits the claim to focused authoring proofs. |
| S6 | Hosted and self-hosted deployment, restore, load, soak, fault, alerts, and provisioning proofs pass. | missing | `src/factory/provisioning/local.ts` step 1 only | none | W15, W16, W17, W19 | No deployment profile, retention, backup barrier, restore, metrics, alert rule, or load harness exists. |
| REG | Full application build, lint, types, backend, web, browser, and legacy regressions and measured coverage pass. | unproven | repository-wide | `EV/root-authority-static-backend-integration-results.json@7ea6e4bd9` records `bun run test` exit 0 | W18, W20 | That full backend pass predates `84cfd2a99`, `57751b80b`, `1ba2b6763`, and `0ba97dc7c`. The patch-coverage gate failed at `84cfd2a99`. No regression has run at HEAD `33cab8657`. |
| AUDIT | All F01–F13 evidence is tied to the final revision and independent review finds no unresolved defect. | missing | no release evidence manifest exists | `docs/validation/factory/` holds three files only | W20 | The W00 criterion to copy redacted summaries and checksums into the repository validation area is not done. |

## D. Discrepancies

Each item below is a place where the plan's section 2 audited state, the W00 task brief, a task
note, or a contract statement disagrees with what this audit observed.

1. **The `preserve/stash-*` branches do not exist.** The W00 brief names branch
   `preserve/stash-sol-phase-b-stop-verification` and "other preserved stashes: branches
   `preserve/stash-*`". `git for-each-ref` in the integration repository returns only
   `refs/heads/ci/coverage-retry-preserve-instrumentation`. Sol's Phase B stop settlement is stash
   entry `8fda869045129d415ac8fc2b8df6cb5ffb7f50ea`, reachable only through `git stash list`.
   Nine further factory-related stash entries exist, including `82cc267c2`
   (`root-c08-delivery-before-controls-integration`, 2 files), `7020735314`
   (`api-sol-protected-effects-wip`, 9 files), `f268c2352`
   (`preserve-run-controls-before-authority-base`, 19 files touching the SDK kernel and compiler),
   `9e155ef93` (`c09-wip`, `assurance.ts`), and `c7ae220f3` (`preserve-shared-gates-run-controls`,
   `GATES.md`). `f268c2352` is the only one that contains unintegrated factory source of
   consequence; the rest are notes, small fixes, or supersets of merged work.

2. **The baseline commit `0ba97dc7c` has no parent-level evidence.** No evidence file in
   `/tmp/factory-platform-evidence` records head `0ba97dc7c`. The plan's own table says the shared
   GitHub transport must be validated on the parent.

3. **The cited GitHub-transport evidence is not an ancestor of HEAD.**
   `EV/root-github-transport-committed-coverage-results.json` records head `bd36bd7fa`, and
   `git merge-base --is-ancestor bd36bd7fa 33cab8657` is false. So is
   `EV/root-github-transport-final-combined-integration-results.json` at `a02e279d6`. The plan
   states the branch-level result accurately, but nothing ties it to HEAD.

4. **Four more evidence heads are not ancestors of HEAD:** `21d5612bc`
   (`root-partition-batch-correction-*`), `e43904013` and `47f57dc4e`
   (`root-partition-delivery-*`), and `e3ced38c6` and `17b79bab1`
   (`root-provider-receipt-final-*` and `root-provider-receipt-committed-coverage-*`). For the
   provider receipt, an ancestor-head parent result exists at `1ba2b6763`; for the partition
   delivery work, `0c7219dca` and `cf4984b49` are the ancestor-head equivalents.

5. **Thirty-five of the 137 evidence JSON files record no producing commit.** Among them are
   `root-provider-receipt-s3-live.json`, which the plan cites for ten tenant publications and forty
   rejected receipts; `authoring-integration-results.json`, which backs the S5 console note in
   `tasks/factory/GATES.md`; every `postgres-factory-*-results.json`;
   `temporal-environment-probe.json`; `release-s3-real.json`; `run-api-results.json`; and
   `terminal-pool-provisioning-results.json`, which is the only record of the pool and provisioning
   coverage producers. None can be checked against HEAD.

6. **The protected-effects coverage report mixes producers across two commits.**
   `EV/root-protected-effects-parent-coverage-results.json` records `patch` exit 1 at `84cfd2a99`,
   which the plan states. It also records its `sdk` and `node` producers at the older `57751b80b`
   with `src/db/migrate.ts` and `src/db/schema.ts` listed in `excludedChangedSources`.
   `EV/root-protected-effects-parent-coverage-source-mismatch.json` records the reason: the old SDK
   report contains product imports and `src/db/migrate.ts` changed. The plan describes this as "new-file
   coverage passed; broader patch coverage failed" and does not mention the producer mismatch.

7. **Terra's uncommitted diff removes code rather than adding fixes.** The plan says "Terra checkpoint
   `6c500113a` plus uncommitted fixes passed one real supervisor SIGKILL/attach/cancel case." The
   working tree of `/home/dev/work/EZCorp/EZHarness-worktrees/factory-lazy-input` contains two
   modified files only: `packages/@ezcorp/extension-runner/src/podman.ts` at minus five lines and
   `packages/@ezcorp/extension-runner/tests/podman.integration.test.ts` at plus one, minus one. The
   diff is a net deletion. W00 must establish which exact tree produced the passing run before
   committing anything as "the tested fixes".

8. **The validator-binding worktree has one more untracked file than the brief names.**
   `/home/dev/work/EZCorp/EZHarness-worktrees/factory-validator-binding` holds untracked
   `src/db/migrations/allow-factory-validator-multiclaim.ts` and
   `allow-factory-validator-multiclaim.test.ts`. The brief named only the first. No evidence file
   records that worktree's head or its dirty state.

9. **The disabled-factory reason string does not match C09.** The contract requires a 404 with a
   `factory-disabled` reason. `web/src/routes/api/factories/_shared.ts:109` emits `factory_disabled`.

10. **Two registered scopes do not match the C01 authority table.** `src/api-registry.ts:60-93`
    registers version publish and grant management as `session`. C01 assigns them `write` and
    `admin`. The C01 row for package installation and quarantine has no route at all.

11. **The pool returns HTTP 200 where C03 requires 429 with `Retry-After`.**
    `src/factory/pool/service-routes.ts:91` returns `json(200, ...)` carrying a `queue-full` body
    and a `retryAfterSeconds` field. No 429 status and no `Retry-After` header exists under
    `src/factory`.

12. **Five factory PostgreSQL suites are registered in no CI producer.**
    `tests/postgres/factory-budgets.test.ts`, `factory-encryption-s3.test.ts`, `factory-inbox.test.ts`,
    `factory-project-creation.test.ts`, and `factory-records.test.ts` appear in neither
    `.github/workflows/db-postgres.yml` nor any `scripts/factory-*-coverage.sh`. The plan's section 8
    requires the canonical registered producer list to be used whole for final certification.

13. **Four task gate files are understated, not overstated.** `tasks/factory/kernel.md`,
    `hardening.md`, `durable-records.md`, and `verification.md` mark every gate pending. The
    corresponding source exists in HEAD, and kernel, hardening, and durable-records legs pass at
    ancestor heads. W00's instruction to correct overstated notes should also correct these.

14. **Task-note evidence lives outside the evidence directory and outside version control.**
    `tasks/factory/release-api-GATES.md`, `pool-process-GATES.md`,
    `generic-command-approval-GATES.md`, `release-notification-delivery-GATES.md`, and
    `validator-materials-GATES.md` cite about fifteen paths such as
    `/tmp/factory-sdk-partition-cov-20260912e/lcov.info`, `/tmp/factory-release-api-backend-1963307/lcov.info`,
    `/tmp/factory-pool-process-final/lcov.info`, `/tmp/factory-command-approval-coverage-merge/lcov.info`,
    `/tmp/factory-notification-backend-final.pLLdhf/lcov.info`, `/tmp/factory-generic-approval-inbox.png`,
    and `/tmp/factory-release-inbox-authorized.png`. Every one exists today. None records a producing
    commit, and none is under `/tmp/factory-platform-evidence`.

15. **The repository validation area holds three files.** `docs/validation/factory/` contains
    `completion-plan/structure.json`, `stage-1/required-check-inspection.md`, and
    `stage-2a/runner-readiness-inspection.md`. W00's pass criterion to copy redacted summaries and
    checksums from temporary evidence into that area is not started.

16. **`C03`'s reservation vocabulary differs from the implementation.** The contract lists
    `requested`; `src/factory/pool/ledger.ts:7` uses `queued` and adds a seventh state, `rejected`.

17. **`Factory runner readiness precheck` guards jobs that do not exist.**
    `.github/workflows/ci.yml:44-60` runs `scripts/check-factory-runners.ts` on `ubuntu-latest`
    with a five-minute timeout. The labels `factory-real` and `factory-gpu` appear only inside
    `scripts/check-factory-runners.ts:23`; `grep -rn 'factory-real\|factory-gpu' .github/workflows/`
    returns nothing, so no job requests either label.

18. **The last full backend regression predates four merged factory commits.**
    `EV/root-authority-static-backend-integration-results.json@7ea6e4bd9` is the only ancestor-head
    record of `bun run test` at exit 0. `7ea6e4bd9` precedes `070f09796`, `57751b80b`, `84cfd2a99`,
    `1ba2b6763`, and `0ba97dc7c`. `EV/root-authority-integration-results.json@647e63a53` and
    `EV/root-projection-regression-results.json@618560260` both record a failing backend leg.

19. **Plan section 2 understates the artifact gap.** It says the artifact modules "support existing
    immutable records" and that W04 must add scoped binary and chunk operations. It does not record
    that `checkpointWorkspace` in `src/runtime/factory-execution.ts` is an interface hook with no
    production implementer, so C02's copy-on-write workspace checkpoint has no implementation at all.

20. **Plan section 2 does not record that the Python validator equivalence required by C07 is absent.**
    `src/factory/runner/python/c02_runner.py:41-60` validates against the generated JSON Schema and
    then shells out to the Node bridge `src/factory/runner/canonical-validator.mjs`. C07 rejects a
    validator that works in only one runtime.

21. **Downstream briefs point at two repository paths that do not exist.**
    `/tmp/factory-platform-evidence/w00/briefs/common.md` tells the W01, W04, and W18 workers to
    read `docs/plans/2026-09-13-composable-factory-platform-interfaces.md` and
    `docs/validation/factory/w00/requirement-index.md`. Neither path exists in HEAD `33cab8657`,
    in the `w00-integration`, `w01-runtime`, `w04-artifacts`, or `w18-ci` worktrees. This audit is
    read-only and wrote only `/tmp/factory-platform-evidence/w00/requirement-index.md`, so the
    repository copy still has to be produced by whoever owns the integration commit.

22. **This audit overwrote its own deliverable path without first inspecting it.** The directory
    `/tmp/factory-platform-evidence/w00/` already held sibling W00 outputs when this audit started:
    `evidence-checksums.json`, `evidence-summaries.md`, `shared-interfaces.md`, `task-note-audit.md`,
    five `survey-*.md` files, and several captured patches. If a `requirement-index.md` existed
    before 13:16 on 2026-09-13, this file replaced it and the earlier content is not recoverable.
    Cross-check this index against `task-note-audit.md` and `evidence-summaries.md` before acting on
    either alone.

## E. Counts

| Status | Contracts (A) | Proofs (B) | Gates (C) | Total |
| --- | --- | --- | --- | --- |
| implemented | 76 | 0 | 0 | 76 |
| unproven | 31 | 10 | 6 | 47 |
| missing | 61 | 0 | 3 | 64 |
| infrastructure-blocked | 6 | 2 | 1 | 9 |
| unmerged | 3 | 1 | 1 | 5 |
| **Total rows** | **177** | **13** | **11** | **201** |

Rows per contract: C01 13, C02 15, C03 13, C04 14, C05 15, C06 14, C07 15, C08 15, C09 15,
C10 13, C11 15, C12 12, C13 8.


## F. Coordinator postscript (2026-09-13, after this audit)

- Discrepancy 1 is resolved: ten `preserve/stash-*` branches now pin every factory stash entry (`git branch --list 'preserve/*'`).
- Discrepancy 7 is resolved: Terra's dirty diff is committed as `28bc2bfc3` on `feat/factory-lazy-input`; the full Podman suite on that tree is 11 pass / 1 fail (a fresh-runner artifact directory regression), while `integ/w00` passes 11/11. W01 owns the fix.
- Discrepancies 15, 21, and 22 are resolved by the W00 integration commits that add `docs/validation/factory/w00/` and the interface freeze document.
- Discrepancies 9, 10, 11, 16 are routed to W03 (pool 429/Retry-After, reservation vocabulary), W09/W14 (disabled reason string, API scopes, package install/quarantine route). Discrepancies 12 and 17 are routed to W18 (unregistered PostgreSQL suites, runner precheck without consuming jobs). Discrepancy 19 is routed to W04 with a W01 seam (workspace checkpoints). Discrepancy 20 is routed to W02 (Python-native validator equivalence).
- Discrepancy 13 is addressed by appended notes in the four understated gate files; their boxes stay open until the final candidate re-run.
- The 2588c9f19 full-diff coverage gates in `w00-staging-coverage-results.json` used focused producers, not the canonical full pipeline; their uncovered lists overstate the real gap and are W18 input only.
