# Pluggable sandbox and secrets: delivery plan

Date: 20 September 2026

Status: implementation started in `feat/pluggable-infrastructure`; no live qualification claimed

Input: the supplied **Pluggable Sandbox & Secrets Infrastructure — Proposed v1, 19 September 2026** PRD

Target: `ezcorp-org/EZHarness`

## 1. Outcome and completion rule

Build one engine on AMD. Keep one authoritative checkout per feature in a persistent sandbox on Xeon. Route all feature tools to that checkout. Use reviewed v4 extensions for sandbox and external secret providers. Keep authorization, approvals, durable state, and credential delivery in the host.

This document turns the PRD into work that can be assigned and verified. It does not promise zero defects. “Complete” means every required task and acceptance case has passing evidence for an exact release and deployment. Missing evidence is a failed release gate. Optional features stay unavailable until their own gates pass.

Preserve these requirements throughout the work:

- Keep the existing Podman extension runner and v4 build/review/activation path.
- Never route a sandbox-required project to a local filesystem or process after an error.
- Never infer authority from an input path, resource ID, provider response, or model instruction.
- Keep secret bytes out of ordinary tool results, transcripts, settings, audit fields, and provider diagnostics.
- Do not weaken isolation, networking, or resource controls to pass a fixture.
- Keep work across turns, client disconnects, and PR creation. Destructive cleanup needs the approved retention policy or explicit disposal authority.
- Use one authoritative contract, shared validation, shared fixtures, and existing permission/proposal checks. Do not build a second approval system.

## 2. Planning evidence and limits

The local checkout is detached at `d5bc9441cc87ef72872989bd4a2965134715f23e`, committed 13 September 2026. The PRD baseline, `550b7c67e1116f78f0448f2133f8ad18201fed1d`, is one descendant commit ahead. The local diff between these commits covers breadcrumb UI, tests, hooks, and coverage registration. It does not change the inspected contract, credential broker, runner protocol, or built-in tool factory. Neither SHA is claimed to be current remote main. Refresh the base before implementation.

Focused source review confirmed these integration points:

| Existing surface | Planning implication |
| --- | --- |
| [Contract ownership](../../packages/@ezcorp/extension-contract/README.md), [types](../../packages/@ezcorp/extension-contract/src/types.d.ts), [wire schema](../../packages/@ezcorp/extension-contract/src/wire-schema.json) | Extend the shared types, regenerate the schema, and run its existing check. Unknown wire fields are rejected. |
| [v4 lifecycle](../../src/extensions/v4/README.md) | Approval, publication, generation checks, recovery, and data migration already have host ownership. Runtime calls resolve the active release. |
| [Security rules](../extensions/security.md) | Service authority differs from human authority. Not every broker supports service calls. Build and discovery remain offline. |
| [Credential broker](../../src/extensions/credential-broker.ts) | Current handles are invocation-bound, expire after 60 seconds, and support a finite set of bearer destinations. This is not durable controller authority or an mTLS provider transport. |
| [Tool factory](../../src/runtime/tools/index.ts), [tool setup](../../src/runtime/stream-chat/setup-tools.ts), [shell](../../src/runtime/tools/shell.ts) | Tools accept a local path. Shell has a legacy local fallback. Routing must change at construction and at every other project access path. |
| [Runner limits](../../packages/@ezcorp/extension-runner/src/core.ts), [framing](../../packages/@ezcorp/extension-runner/src/protocol.ts) | Default execution is 60 seconds, 512 MiB, and 1 MiB output. Framing captures worker stderr and can use it in an exit error. Sensitive calls need explicit treatment of these paths. |
| [Database connection](../../src/db/connection.ts), [migrations](../../src/db/migrations), [CI](../../.github/workflows/ci.yml) | Support PGlite and external PostgreSQL. Reuse canonical quality and production-image lanes. |
| [Project Git broker](../../src/extensions/project-git-broker.ts), [PR broker](../../src/extensions/project-pull-request-broker.ts), [MCP credentials](../../src/extensions/mcp-workspace-credentials.ts), [preview code](../../src/runtime/preview) | Inventory these paths explicitly; replacing the built-in shell alone cannot prove remote workspace containment. |

The PRD's standalone prototype and claimed 53 design checks were not supplied as files and were not located in the inspected planning paths. They are unverified input claims here. Recover their source and raw evidence, or record them as unavailable. Do not count them as production tests.

Selected official sources were checked for this plan. Incus documents nesting and host kernel prerequisites for Docker; that does not qualify this deployment. [Incus FAQ](https://linuxcontainers.org/incus/docs/main/faq/#how-can-i-run-docker-inside-an-incus-container)

Incus separates authentication from authorization. The connection design must include restricted access and certificate lifecycle, not just an endpoint and TLS handshake. [Authentication](https://linuxcontainers.org/incus/docs/main/authentication/), [authorization](https://linuxcontainers.org/incus/docs/main/authorization/)

Infisical lists dynamic secrets under its Advanced plan, including a license for self-hosted use. Static lookup remains the first external integration. Recheck entitlement when implementing leases. [Dynamic secrets](https://infisical.com/docs/documentation/platform/dynamic-secrets/overview)

No live Incus, Infisical, native-agent, security, benchmark, or repository CI run was performed for this planning document.

## 3. Release scope and the main specification gap

| Release gate | Required behavior | Claim allowed after passing |
| --- | --- | --- |
| R1: first deployment | M0–M2 plus the shared hardening/release tasks. Real Incus `persistent-web-compose.v1`, native EZ loop, existing static store, Infisical static lookup, UI, restart, cleanup, resource and security checks. | The selected deployment works with the recorded recipe and controls. No independent sandbox portability claim. |
| R2: baseline portability | R1 plus M3. Incus and a genuinely different sandbox implementation pass the same `linux-exec.v1` suite. Built-in store and Infisical pass the same static consumer flow. | `linux-exec.v1` and static secret consumer portability only. |
| R3: Compose portability | R2 plus a second independent implementation of `persistent-web-compose.v1`, with the same full feature lifecycle. | The full Compose workflow satisfies the PRD's unqualified A01. |
| R4: selected optional features | M4 tasks and the relevant shared gates for every advertised runtime/profile/capability pair. | Only the named, tested combinations. |

**Gap:** M3 proposes a second `linux-exec.v1` implementation, but A01 asks for the same feature flow on two providers. A baseline execution backend does not prove Compose portability. Keep A01 open until R3 passes, unless the product owner explicitly narrows A01 to a named baseline flow. This plan includes work for both paths; it does not silently rewrite the PRD.

Recommended initial scope: R1 first, then R2, with R3 remaining required for the full portability promise. Dynamic leases, snapshots, PTY, suspend, large transfers, and resize are conditional R4 work. Claude/Codex guest workers are excluded by user decision. “All PRD work complete” must identify which conditional features were selected; an unchecked optional feature is not supported.

## 4. Gaps and decisions to close

All recommendations below are proposals. Task completion records the selected decision, owner, date, and any effect on acceptance. “Before” identifies the point that decision blocks.

| ID | Gap or unresolved case | Recommended decision / required result | Before / tasks |
| --- | --- | --- | --- |
| D01 | Release scope conflicts with A01. | Use R1–R4 above. Keep full A01 open for an independent Compose implementation. | Contract freeze; P01, P02, V03 |
| D02 | Hardware and versions are unknown. | Measure AMD/Xeon resources, kernel, OS, architecture, storage driver, cgroups, virtualization, routing, DNS and clock sync. Pin versions after qualification. NixOS in this workspace does not establish the Xeon OS. | Live provisioning; P03, I01 |
| D03 | Private infrastructure traffic does not fit ordinary public HTTP policy. | Add a distinct host capability tied to approved connection, destination, method/path/body scope, resource binding, and mTLS identity. Specify streaming/upgrades needed by Incus and previews. | Real credentials; H01, H02, H04 |
| D04 | Sensitive return types alone do not stop leaks. | Trace backend response through transport, worker stdout/stderr, errors, cache, telemetry and host delivery. Restrict sensitive dispatch to the broker; suppress unsafe diagnostics. Review the trusted provider boundary. | Infisical credentials; H03, S03, Q02 |
| D05 | Background recovery outlives a user invocation. | Persist an explicitly scoped host controller delegation with expiry/cancellation rules. Recheck current project, principal, release and connection grants for each new effect. Do not retain an expired invocation token or impersonate a human. | Provisioning/recovery; H02, B02 |
| D06 | Preflight before activation creates an approval cycle. | Keep candidate build tests offline. Authorize a separate bounded, audited operator probe for the exact candidate/config before activation; no ordinary allocation authority. Define its consent using the existing review path. | Connection UX; C04, U01 |
| D07 | Emergency disable also disables the cleanup adapter. | Deny new authority immediately. Provide operator recovery using inventory and an independently authorized cleanup procedure. Never secretly keep the disabled provider active. | Lifecycle rollout; C05, O03 |
| D08 | “Persistent” does not define process survival. | Promise durable workspace and control records. Distinguish engine restart from guest stop/reboot, helper crash, Incus restart and host power loss. Record interrupted process outcomes honestly. | Process contract; C02, B05, I04 |
| D09 | File methods omit mkdir, mode changes, and large transfer behavior. | Define directory creation, delete recursion, permissions/executable bits, revisions, root path, encoding and limits before freezing v1. Reject unsupported sizes. Keep large staged transfer optional. | SDK freeze; C02, I03 |
| D10 | A native process can bypass a broker write lock. | One managed writer; serialize managed turns and edits. Treat autonomous watchers/background mutation as source invalidation. Quiesce writers for validation and commit, or report that evidence is stale. | Test/PR workflow; B06, W04, W05 |
| D11 | Stop/start reservation and retention behavior is unclear. | Release compute reservation only after observed stop; retain disk charges. Re-admit before start. Keep ambiguous allocations reserved until reconciled. Separate idle stop, retention expiry and data deletion. | Admission; B03, O01 |
| D12 | No complete storage/backup budget. | Account for image layers, guest Docker cache, named volumes, logs, artifacts and snapshots. Set export/backup destination, encryption, retention, recovery time and acceptable data loss; test restore. | R1; P04, I05, O02 |
| D13 | Incus resource limits may differ by mode/storage. | Prove hard CPU, memory, PID and disk bounds for the exact recipe. If a mode cannot enforce a mandatory bound, reject that profile. VM mode is not an automatic pass. | Profile qualification; I05, Q03 |
| D14 | Preview control API omits the actual traffic path. | Specify AMD-to-guest routing, TLS termination, per-sandbox origin, session authorization, expiry, WebSocket rechecks, ports, traffic limits and network teardown. | Previews; H04, W03 |
| D15 | Network policy must cover nested Docker and build steps. | Separate management, guest, build/dependency, service and preview traffic. Define approved DNS, registries, proxy policy and IPv6 treatment. Prove guest root cannot relax host enforcement. | Compose; I02, I06, Q02 |
| D16 | Git/PR idempotency is outside sandbox lifecycle. | Journal pushes and PR creation; reconcile by exact branch/head and proposal identity. Preserve source revision checks and separate read/write/PR permissions. Define branch collision, base updates and LFS/submodule support. | Feature completion; W05 |
| D17 | Ownership changes and account deletion leave persistent work. | Define transfer, suspended access, cleanup authority and retention for revoked users, removed projects and lost service consent. Block new effects; retain recoverable work under policy. | R1; B02, O01, Q04 |
| D18 | Secret content and version semantics are incomplete. | Bound bytes; define binary/multiline material, null vs denied, exact environment/path scope, reference expansion, version selection and rotation/cache invalidation. Do not inherit the existing single-line bearer rule for all secret types. | Secret schema; C03, S02, S04 |
| D19 | Guest secret delivery cannot guarantee non-disclosure. | Approve each delivery purpose and exposure. Keep model keys on AMD for native EZ. Define supported runtime proxy/auth methods before claiming native CLI support. | Raw delivery; S05 |
| D20 | There are no numeric operational acceptance targets. | Set deployment-specific readiness, reconnect, cancellation, cleanup, retention and performance budgets after measuring the baseline, before acceptance runs. A command's timeout is not a recovery objective. | R1; P04, Q05 |
| D21 | Backend drift can invalidate prior qualification. | Bind evidence to release/config/recipe/helper/backend versions. Invalidate qualification on material changes. Re-probe current controls at admission; drain or block incompatible changes. | Release activation; C04, I07 |
| D22 | Control-plane restore can revive stale authority. | Restore keys and metadata separately; fence old controllers, reauthorize resources and inspect backend state before effects. Do not replay old create or lease commands from a restored journal. | R1; B04, O02 |
| D23 | “53 checks passed” and placeholder references lack reviewable artifacts. | Recover the supplied PRD and its prototype evidence with real links/checksums; record unavailable evidence explicitly. Add pinned repository links for R1–R12 and verify official E1–E13 when their tasks start. | Plan baseline; P01 |
| D24 | Provider author workflow has no proof of independence. | Have a new adapter use only the published contract/SDK and author guide. Record any host change it needs; fix contract defects before declaring portability. | R2/R3; V01, V04 |

## 5. Task rules and ownership

All implementation boxes start open. Roles are assignment targets, not named assignees: **Platform** (contract, controller, DB), **Security** (authority, transport, secrets), **Runtime** (workspace and agents), **Infrastructure** (hosts, adapters, recipes), **Web** (product UI), **Quality** (independent proof), **Product** (scope and operating policy).

Each task must have one accountable person before it starts. The owner supplies implementation, tests, docs and an evidence link. Sensitive boundary changes also need a Security reviewer. Quality owns live verification; provider authors do not qualify their own claims only through mocks.

To close a task: record source SHA, test command and exit, fixture/backend versions, observed result and evidence location. Use the existing test harness. Tests must exercise production paths and fail when the relevant protection is removed. Never convert a missing live prerequisite into a passing skip.

### P — Baseline and decisions (M0)

Entry: planning approval. Owner: Product + Platform, with Infrastructure and Security for their decisions.

- [ ] **P01 — Establish the source of truth.** Save the supplied PRD at its proposed path; attach or mark missing the prototype/evidence; replace placeholder references. Record the implementation base and review current main drift. **Done:** versioned PRD, this backlog, and an evidence inventory distinguish input claims from observed results.
- [ ] **P02 — Approve scope and threat model.** Resolve D01 and select first runtime, profile, isolation type, independent backend and optional features. Draw control/data/secret paths and list trusted components, including guest Docker control and provider code. The native EZHarness loop runs on the engine. **Done:** a decision record names allowed claims and the release that must satisfy full A01.
- [ ] **P03 — Inventory deployment and access.** Measure both servers, record OS/kernel/CPU/storage/cgroup/network/virtualization details, locate the existing Podman runner, and identify operator-owned bootstrap identity. **Done:** redacted inventory and a provisionable host specification; no guessed capacity.
- [ ] **P04 — Set operating policy.** Define quota, queue order/fairness, parallel test limits, memory headroom, idle stop, retention, backup, logs, artifacts and numeric acceptance budgets. Assign operational and release owners. **Done:** bounded values, units, recovery objectives and explicit disposal rules; 48 GiB remains a proposal until measured.

### C — Contract, SDK, registry and review (M0; lifecycle proof continues through M2)

Depends on: P01, P02. Owner: Platform. Existing surfaces: shared contract, SDK and `src/extensions/v4/`.

- [ ] **C01 — Define provider contributions once.** Add provider kind/ID, protocol major, method groups, config schema, minimum host contract, permissions and claims to authoritative types. Generate wire schema and SDK exports. **Done:** old manifests still pass; unsupported fields/versions, duplicate IDs and invalid contribution/method combinations fail clearly; no second validator.
- [ ] **C02 — Specify sandbox wire semantics.** Define mandatory profiles and every method, scope-bound pagination/cursors, operation receipts, states, power transitions, process identities, argv/env/user/cwd, file rules, errors and idempotency scopes. Include D08–D09 and distinguish RPC deadlines from process deadlines. Specify safe integer bounds, UTF-8 byte limits, binary encoding overhead and chunk sizes within the existing frame budget. **Done:** schema and semantic tests cover all methods, partial results, unknown outcomes and unsupported capabilities; no unbounded JSON or ambiguous CPU units.
- [ ] **C03 — Specify secret wire semantics.** Define approved refs and static/leased results, sensitive method classification, auth/cache/issuer lifetimes, scope/version metadata and optional lease operations. **Done:** static expiry is unknown unless issuer metadata supports it; binary/multiline cases and all size limits are explicit; no plaintext ordinary result type.
- [ ] **C04 — Register reviewed providers and connections.** Resolve exact active release through v4; bind connection revision, endpoints, schema, capability evidence and dependency graph. Design the operator probe from D06. Reject cycles and unqualified profiles. **Done:** candidate tests remain offline; live probe needs exact consent; config/permission/endpoint drift requires review; background use cannot select arbitrary packages or URLs.
- [ ] **C05 — Enforce drain and lifecycle rules.** Block update/disable/uninstall/incompatible config changes while dependent sandboxes, deliveries or leases remain. Define drain progress and timeout; retain cleanup references for static guest deliveries too. Implement emergency disable and operator recovery metadata. **Done:** tests cover queued/in-flight calls, revocation races, safe retry and surviving resources without executing a disabled release.
- [ ] **C06 — Publish shared conformance fixtures.** Build one profile-driven harness consumed by adapters and host tests, with fake providers for deterministic faults. **Done:** fixtures test wire compatibility and capabilities separately from live qualification; an intentionally nonconforming adapter fails; harness records exact release/config/recipe identity.

### H — Host authority, infrastructure transport and secret boundary (M0 prerequisite for live access)

Depends on: P02, C01–C03. Owner: Security + Platform.

- [ ] **H01 — Specify and review infrastructure transport.** Define approved private destinations, mTLS/server trust, rotation, path/method/resource restrictions, DNS pinning, redirects, response limits, cancellation and any binary/WebSocket operations. Document how the provider translates requests while the host constrains granted authority. **Done:** reviewed message flows include create, file transfer, exec and preflight; no generic unrestricted private-network proxy.
- [ ] **H02 — Implement fresh authority for controller effects.** Bind durable feature/controller delegation to principal, project, provider installation/release, connection, operation, limits and generation. Mint bounded invocations per call; recheck authority before dispatch and secret delivery. **Done:** user deletion, grant revocation, stale generation, service cancellation and forged IDs deny new effects through real brokers after a restart.
- [ ] **H03 — Implement the sensitive result path.** Route approved secret results directly to the credential broker. Cover success, malformed frames, thrown errors, timeout, stdout/stderr capture, tracing, crash reports, caching and audit. Prevent sensitive methods entering the model tool catalog. **Done:** canary scans and fault tests find no secret in ordinary sinks; bounded buffers and diagnostic policy are documented; trusted provider code exposure is explicit.
- [ ] **H04 — Implement protected connection I/O.** Add the reviewed transport and host-owned identity storage, including all data paths required by Incus and preview routing. Keep private keys out of provider configuration/results and ordinary workers. **Done:** wrong endpoint/certificate, revocation, redirects, DNS changes, IPv6 alternatives and over-limit streams are denied; certificate rotation recovers without dropping scope checks.
- [ ] **H05 — Close the boundary review.** Review actual host/provider/helper flows, dependency cycles, least privilege and remaining trust assumptions before assigning live credentials. **Done:** blocking findings fixed, exact revision recorded, operator credentials scoped to a dedicated fixture project; no security conclusion based on types alone.

### B — Database, controller and admission (M1)

Depends on: C02, C04, H02; real dispatch also needs H04–H05. Owner: Platform.

- [ ] **B01 — Add durable data and migrations.** Model bindings, config revisions, desired/observed states, operations, processes, endpoints, reservations, workspace leases, credential/lease metadata and tombstones. Define constraints/indexes and retention. **Done:** upgrade/reopen tests pass on PGlite and PostgreSQL; encrypted refs contain no plaintext; old local projects remain usable.
- [ ] **B02 — Implement authorized lifecycle transitions.** Journal before dispatch; preserve original scoped idempotency receipt; reject payload changes. Bind feature ownership, current grants and generation to each transition. **Done:** all state transitions have allowed/denied tests, concurrent requests cannot double-admit, audit failure rolls back authority changes, revoked owners cannot continue new effects.
- [ ] **B03 — Implement reservations and queue admission.** Atomically reserve memory/CPU/PIDs/disk and execution slots against project and host limits before create/start. Reconcile external usage/headroom. Separate stopped compute from retained disk accounting. **Done:** simultaneous admissions and stop/start races cannot overcommit; unknown allocations keep reservations; OOM or disk exhaustion has a visible result and preserves a healthy neighbor.
- [ ] **B04 — Implement reconciliation and fencing.** Recover pending operations from persisted IDs, scoped ownership tags and bounded provider lists. Handle lost responses, stale controllers, provider outage and database restore. **Done:** create/start/destroy uncertainty never causes a blind duplicate; orphan review is nondestructive; tombstones survive restart; missing connectivity remains unknown.
- [ ] **B05 — Implement durable process control.** Start/inspect/output/cancel through short calls; persist process/boot identity, exit and cancellation state; enforce guest deadlines and process-tree termination. **Done:** jobs exceed worker lifetime, survive client/engine disconnect, and reattach with bounded output; guest reboot/helper crash cannot reuse a PID as a different process or fabricate successful continuation.
- [ ] **B06 — Implement the workspace writer lease.** Serialize managed turns, broker writes and native agent sessions; define timeout, takeover, generation and cancellation. Track source commit plus bounded dirty/untracked manifest. **Done:** second writer denied/queued; stale owner cannot edit through managed paths; independent shell mutation invalidates test evidence rather than being hidden by file CAS.
- [ ] **B07 — Add controller health and bounded retry.** Bound polling, backoff/jitter, retries, queue sizes and reconciliation batches. Expose readiness, operation age, unknown outcomes and cleanup debt without high-cardinality secret fields. **Done:** unavailable backend cannot flood AMD or hide stalled work; metrics and operator alerts identify failed controllers.

### I — Incus host, helper and workload recipe (M1)

Depends on: P03–P04, C02, H05. Adapter integration depends on B01–B05. Owner: Infrastructure.

- [ ] **I01 — Provision the restricted backend.** Create the operator-reviewed Incus project, storage/network settings and project-restricted identity. Record server trust and backup access separately. **Done:** attempted access to a second project, host devices/paths and privileged settings is denied; pins, package versions and redacted setup evidence are retained.
- [ ] **I02 — Build the pinned guest recipe.** Use an unprivileged container with approved nesting, explicit guest user, `/workspace`, Docker/Compose and minimal dependencies. Review image sources, mounts, ports and hooks. **Done:** reproducible image/recipe digests, dependency inventory, no AMD checkout mount or host credentials, and verified helper readiness; use a separately qualified VM if container qualification fails.
- [ ] **I03 — Build contained file operations.** Reuse safe primitives where available; implement descriptor-based path containment, revision-bound ranged reads and atomic same-filesystem writes, with the directory/mode contract from C02. **Done:** real filesystem tests reject traversal, symlink races, hardlink escape imports, devices, bombs, stale revisions and oversized inputs; binary content/executable bits/deletions work; Git is an independent clone.
- [ ] **I04 — Build durable guest supervision.** Install a small versioned helper with bounded process records/logs, boot identity, deadlines, process-tree cancellation and crash recovery. Define boot ordering and helper compatibility. Enforce admitted execution deadlines during a control-plane outage; distinguish stopping compute from deleting retained work. **Done:** attached exec is not required to keep a job alive; restart/reattach/gap tests pass; guest output remains untrusted and cannot grant host authority.
- [ ] **I05 — Prove actual resource controls.** Map requested integer units to backend enforcement for memory, CPU ceiling, PIDs and storage. Count guest daemon, native workers, nested containers, volumes/cache/logs and host image overhead. **Done:** controlled load plus authoritative metrics prove limits; guest root cannot raise outer ceilings; disk full, inode pressure and logging cannot exhaust host reserves.
- [ ] **I06 — Enforce network separation.** Implement approved management, guest, dependency/build, service and preview paths. Block management API, sockets, unrelated guests, engine paths and metadata endpoints; inspect nested Docker and guest host-network behavior. **Done:** real tests cover IPv4/IPv6, DNS/redirect alternatives and guest-root bypass attempts while permitted dependency installation and app networking succeed.
- [ ] **I07 — Ship the Incus extension.** Map every required method and operation error; use pinned host transport, explicit guest user/cwd, scope tags and configured profile. Probe actual backend/recipe/helper controls without allocation in discovery. **Done:** shared suite and live lifecycle pass through the reviewed release; stale qualifications or missing controls fail admission; VM mode checks incus-agent if selected.
- [ ] **I08 — Implement the Compose workload driver.** Clone pinned source, create a unique branch, install dependencies, start approved Compose services and wait for bounded readiness. Make bootstrap stages resumable; retain diagnostics and partial state. **Done:** retry after a failed install/service start is safe; two real feature stacks have distinct branches, ports and volumes; guest reboot/stop/start preserve intended data and report interrupted work.

### W — Workspace routing and complete feature workflow (M0 canary; M1–M2 integration)

Depends on: C02, B02, B05–B06; live flow needs I07–I08 and approved credentials. Owner: Runtime.

- [ ] **W01 — Inventory every project access path.** Trace built-in tools, preview, attachments, Git/PR, workflow tools, subagents, extension project brokers and project-bound MCP. Classify control-plane configuration separately from workspace content. **Done:** a checked routing inventory names constructor/call sites, existing permission checks and a canary test for each path; no path is assumed covered by shell changes.
- [ ] **W02 — Inject one explicit workspace backend.** Keep an explicit local implementation for existing projects and add sandbox routing for read/edit/list/glob/search/shell. Define large search paging, virtual paths, output bounds and unavailable errors. **Done:** real AMD/guest canaries prove every tool uses the guest checkout; loss of backend never calls local spawn or reads local files; local regressions pass.
- [ ] **W03 — Route authenticated previews.** Reuse suitable preview/security code with H04's data path, isolated origins, private routes, expiry and authorized WebSocket reconnect. **Done:** application assets and dev reload work; unrelated users, expired routes, cross-sandbox ports and application-origin cookie access fail; routes close during cleanup.
- [ ] **W04 — Bind runs, agents and MCP to the feature.** Persist execution target and writer lease across turns, disconnects and subagents. Place or reject project-bound MCP/native processes explicitly. **Done:** no hidden local project tool, prompt-only routing or duplicate mutable checkout; stale source evidence is shown after unmanaged changes.
- [ ] **W05 — Complete validation and PR flow.** Pin immutable starting SHA/repo, validate source state, run bounded tests, collect artifacts, commit and push through approved scope, then open/reconcile a PR. Preserve existing proposal checks. Define submodules/LFS policy and safe base-update handling. **Done:** exact pushed SHA matches evidence; branch collision, lost push/PR response, dirty-tree changes and denied main/merge actions are tested; opening a PR retains the sandbox.
- [ ] **W06 — Prove disconnect and review workflow.** Exercise feature request through retained PR, laptop closure, engine restart, reconnect, revision and authorized disposal. **Done:** same workspace/sandbox identity persists; process control recovers within agreed budget; interrupted model turns are reported without claiming instruction-level continuation.

### S — Static store, Infisical and delivery (M2)

Depends on: C03–C05, H02–H05, B01. Owner: Security + Platform; Infisical adapter: Infrastructure.

- [ ] **S01 — Preserve the existing encrypted store.** Expose a built-in broker-private static backend using existing storage/key ownership. **Done:** existing scoped credentials work before/after upgrade and restart without export or re-encryption; ordinary extension migrations cannot touch encrypted values.
- [ ] **S02 — Add approved credential references.** Bind principal/project/purpose, installation/connection revision, exact backend scope/version, destination, allowed delivery and use lifetime. Invalidate caches on scope/version/rotation changes. **Done:** forged paths, alternate environments, imports/reference expansion and revoked users cannot widen access; binding expiry never appears as static credential expiry.
- [ ] **S03 — Implement the Infisical static extension.** Add sealed methods, config schema, approved machine identity/bootstrap auth, retry/rate-limit behavior and sensitive retrieval. **Done:** exact released adapter resolves a real non-production fixture secret, denies another project/environment, survives supported auth renewal, and does not expose secret material through failure paths.
- [ ] **S04 — Deliver destination-bound HTTP credentials.** Extend the broker without exposing arbitrary retrieval to the model. Bind each use to current authority and approved destination; distinguish provider auth token lifetime from retrieved value lifetime. **Done:** redirect, DNS, replay, expired handle and cross-scope requests fail; engine restart recreates handles from approved references rather than persisting handles as secrets.
- [ ] **S05 — Implement approved guest delivery.** Support restricted temporary file or pipe/FD where available; make process environment an explicit compatibility option. Define owner/mode, unlink, crash cleanup and process restart rules. **Done:** credentials never enter argv, Git URLs, image layers or source; consent shows guest exposure; termination/revocation removes future access and records limits for bytes already copied.
- [ ] **S06 — Reconcile credential cleanup.** Revoke future binding access, invalidate handles/caches, end deliveries, and record supported issuer cleanup plus failures. Tie process pause/stop policy to secret availability. **Done:** sandbox destroy, permission loss, provider disable and restart preserve cleanup intent; static issuer rotation remains an explicit operator action, not a false revocation claim.

### U — Product UI and operator workflow (M1–M2)

Depends on: C04–C05 and stable B/S APIs. Owner: Web + Product.

- [ ] **U01 — Build connection/review/preflight UI.** Extend existing install/review views. Show endpoint scope, exact release/config, probe consent, controls, resource bounds, unsupported capabilities and qualification age. **Done:** operator can configure, probe and review without exposing secrets or gaining activation by testing; validation and permission errors have a clear next action.
- [ ] **U02 — Build environment selection and admission status.** Select approved logical profile/runtime, show resource request, queue reason and no-capacity state. **Done:** users cannot supply raw backend flags/URLs; unqualified combinations are unavailable; double-submit returns the same admitted request.
- [ ] **U03 — Build persistent feature/run views.** Show desired/observed state, source/branch, logs with gaps, processes, private preview, retained work and test freshness. Provide authorized cancel/stop/start/dispose actions. **Done:** reload, reconnect and stale-tab behavior work; unknown never renders as deleted/success; stop versus delete is clear.
- [ ] **U04 — Build cleanup and secret status views.** Show remaining backend resources, failed steps, retry/recovery instructions and the three credential lifetimes. **Done:** users see static expiry as unknown where appropriate; destructive disposal reflects uncommitted/unpushed work and backup policy; operator-only details stay restricted.
- [ ] **U05 — Validate the real UI.** Use authenticated browser flows, desktop/mobile widths, keyboard navigation, readable labels, long errors and all loading/failure states. **Done:** inspect screenshots, assert no clipped/overlapping controls, check console/network errors, and meet repository accessibility/browser gates. Fix defects found during these tests.

### O — Retention, backup and operations (required for R1)

Depends on: P04, B03–B07, S06, W05–W06. Owner: Platform + Infrastructure.

- [ ] **O01 — Implement safe retention and disposal.** Apply idle stop, merged/closed PR policy, orphaned owner/project handling, uncommitted/unpushed work protection and approved export/discard. **Done:** cleanup order first blocks new work/access, preserves required artifacts, terminates services/deliveries, revokes routes and deletes resources; retries retain accurate tombstones and accounting.
- [ ] **O02 — Implement backup and disaster recovery.** Back up engine metadata and required key material securely; export guest Git changes/artifacts and application-consistent service data according to policy. Test restore onto a clean recovery target. **Done:** recovered control plane reconciles live resources without duplicate effects or revived stale authority; restored work meets P04's recovery/data-loss targets; failed exports block automatic destruction.
- [ ] **O03 — Write and test operator runbooks.** Cover backend outage, cert/key rotation, emergency disable, manual scoped inventory/recovery, host reboot, out-of-space, corrupted helper, stolen static secret and stuck cleanup. **Done:** a second operator can follow the runbooks; recovery steps retain approvals/audit and never require the disabled extension to self-authorize.
- [ ] **O04 — Define upgrades and rollback.** Use a feature flag defaulting off, additive migrations and drain-before-update. Document compatible rollback floors, helper/image upgrades and immutable release/config references. **Done:** upgrade/rollback with retained work and active dependent records is tested; older code cannot silently drop new state or resume local execution.

### V — Independent provider proof and author workflow (M3 / R2–R3)

Depends on: C06 and the functioning host/workspace flow. Owner: Infrastructure + Quality.

- [ ] **V01 — Build a real independent baseline adapter.** Select and record a second implementation, with rootless OCI as a candidate. Implement `linux-exec.v1` in a separate reviewed provider extension, not a mock or Incus VM alias. **Done:** it passes live required file/process/resource/lifecycle controls and uses the same engine contracts; unavailable mandatory controls block the claim.
- [ ] **V02 — Run unchanged baseline consumer flows.** Execute the same workspace scenario against Incus and the independent adapter, and the same static secret scenario against built-in store and Infisical. **Done:** fixture code/workflow remains unchanged; only approved connection/profile/credential mapping differs; publish real logs and exact support matrix.
- [ ] **V03 — Close full Compose portability or obtain an explicit spec amendment.** Choose an independent backend able to implement `persistent-web-compose.v1`, implement its reviewed adapter/recipe, and run the same clone/edit/Compose/test/PR/retain/reconnect/cleanup flow. **Done:** two independent full-profile results satisfy A01, or the product owner signs a clearly scoped A01 revision; R2 alone does not close this task.
- [ ] **V04 — Ship SDK scaffolding and author guide.** Document methods, error/retry behavior, host permissions, configuration, offline fixtures, operator qualification and unsupported capabilities. Provide scaffold/template and version compatibility examples. **Done:** a new author builds/tests/packages a provider using published SDK artifacts without editing the agent loop or bypassing v4 review; any required host changes are resolved before the claim.

### N — Conditional capabilities (M4)

Depends on: stable R1 and the relevant contract/security gates. Owner: Runtime + Infrastructure + Quality. Keep each feature disabled until selected and qualified.

- **N01 — Removed from scope by user, 20 September 2026.** Native EZHarness loop only; no Claude or Codex guest worker.
- **N02 — Removed from scope by user, 20 September 2026.** Native EZHarness loop only; no Claude or Codex guest worker.
- [ ] **N03 — Qualify dynamic leases only with a real issuer.** Check licensing; implement issue/renew/revoke/inspect with issuer IDs and actual expiry, skew margin, bounded retries and fresh authority. Reconcile lost issue/revoke responses. **Done:** live issuer tests cover expiry and outage, dependent work pauses/stops by policy, and no long-lived fallback key is substituted.
- [ ] **N04 — Qualify large file transfer if selected.** Add staged chunks, bounded storage, digest-checked finalize, expiry and abort recovery. **Done:** malicious/partial/replayed chunks fail; range revisions remain consistent; ordinary workers and logs stay bounded.
- [ ] **N05 — Qualify snapshot/restore and suspend if selected.** Define volume consistency, scope, encryption, retention, resource identity and secret/authority revalidation on restore/resume. **Done:** exact provider capability tests pass without claiming cross-provider snapshot portability or preserving stale authority.
- [ ] **N06 — Qualify PTY and resize if selected.** Define PTY transport/backpressure/resize/disconnect and separately define resource resize admission, enforcement and failure semantics. **Done:** every advertised capability has its own schema/live tests; reducing resources or reconnecting cannot bypass policy.
- [ ] **N07 — Track future backend requests without expanding v1.** OpenBao, AWS Secrets Manager, Firecracker and Kata each need their own bounded adapter project and qualified profile. **Done:** support matrix says unsupported until real evidence exists; no universal lease/Compose claim and no extra artifact/telemetry contracts without a second concrete implementation.

### Q — Integrated proof and release (applies to every shipped scope)

Depends on: relevant preceding tasks. Owner: Quality; release owner signs Q08.

- [ ] **Q01 — Build end-to-end qualification fixtures.** Use real authenticated UI/API and production broker paths; dedicated non-production projects and secret canaries; shared fixture entrypoints parameterized by approved connection/profile. **Done:** fixture cleanup itself is verified, captures exact candidate identity, and cannot access production scope.
- [ ] **Q02 — Run the negative security suite.** Cover A02/A03/A08/A10/A12/A15 plus review/probe abuse, private transport and preview boundaries. Include malicious worker output and guest-root attempts where in scope. **Done:** host-owned evidence proves denied effects; controlled removal of the tested boundary makes representative tests fail; unresolved boundary failures block release.
- [ ] **Q03 — Run resource and concurrency qualification.** Two active Compose features, a queued excess request, controlled CPU/memory/PID/disk/log load, guest reboot and healthy neighbor checks. **Done:** authoritative measurements prove P04 bounds, correct reservations and no unintended cross-feature access or host resource exhaustion.
- [ ] **Q04 — Run the failure/recovery matrix.** Kill engine/worker/helper at admission, create response, bootstrap, process start, file replace, push/PR, secret delivery and cleanup boundaries. Add network partition, backend restart, grant revocation and DB restore. **Done:** no duplicated unknown effects, leaked new authority or lost required work; recovery uses the same IDs and meets P04 budgets where promised.
- [ ] **Q05 — Run ten consecutive real feature lifecycles.** Use the chosen deployment and same workload/concurrency as the measured local baseline. Include engine restart, denied credential use and failed-cleanup recovery within the run set. **Done:** ten complete recorded lifecycles, no hidden rerun failures, metrics for create/bootstrap/tool latency/test time/memory/host pressure/idle use, and agreed thresholds met. A fix requires a fresh consecutive set on the new candidate.
- [ ] **Q06 — Pass all repository gates.** Use pinned toolchains and canonical lint, types, builds, contract/SDK, backend/web/browser, both DB drivers, coverage/security/quality and production-image CI lanes. **Done:** final candidate hosted results and raw first-attempt failures reviewed; no disabled workflow, weakened gate, unjustified skip or unexplained flake.
- [ ] **Q07 — Publish the evidence and support matrix.** Link every acceptance row below to its exact test and receipt. Record unsupported combinations, optional exclusions, remaining operational risk and provider/version compatibility. **Done:** neither mock checks nor old SHAs can satisfy a live/new-release claim; secrets are absent from published artifacts.
- [ ] **Q08 — Roll out and verify the selected release.** Approve the reviewed artifacts/configuration, enable for one feature, verify metrics/alerts and rollback, then raise capacity within measured limits. **Done:** Product, Security, Infrastructure and Quality sign the exact scope; first-deployment and portability status are separate; operator handoff and recovery drill complete.

## 6. Order, dependencies and review points

The letters above are work packages, not a requirement to finish every letter before starting the next. These are the mandatory review points:

| Gate | Required tasks/results | What becomes safe to start |
| --- | --- | --- |
| G0: scope and source | P01–P04, decision owners and base revision | Contract and fixture implementation |
| G1: contract and boundary | C01–C04, H01–H05, C06 fixtures, W01 inventory and W02 fake-backend local-denial canary | Operator-scoped live access; durable vertical-slice integration |
| G2: durable feature | B01–B07, I01–I08, W02–W06; reviewed test Git credential path as needed | Real retained Compose feature and recovery testing |
| G3: credential and lifecycle | C05, S01–S06, U01–U05, O01–O04 | First-deployment candidate qualification |
| G4: R1 release | Q01–Q08 for R1; all applicable acceptance evidence | First deployment support claim |
| G5: R2/R3 portability | V01–V04, rerun applicable Q gates for the declared profiles | Only the independently verified portability claim |
| G6: optional support | Selected N tasks plus applicable Q gates | Named runtime/profile/capability support |

Useful work can overlap: host inventory with contract design; file/helper work with controller work after C02; UI work with stable API fixtures; static compatibility with controller integration. Use separate non-production fixtures and avoid competing load during measurements.

W02 has two deliveries: the M0 routing abstraction and denial canary use a fake backend; live routing proof waits for B/I integration. Private clone/push in G2 also requires the relevant S01, S02, S04 and S05 delivery path to be complete and reviewed. Bring that narrow static-credential work forward from M2; do not pass a raw token through an ordinary tool to unblock M1. Infisical and the full secret lifecycle still close at G3.

The critical path is **scope → contract/authority/transport → durable Incus and workspace flow → secrets/retention/UI → live recovery/security proof → deployment**. Independent-provider work is a second critical path for portability. Resolve feasibility of hard limits and nested Compose early; do not wait until UI completion to discover an unsupported host recipe.

No calendar estimate is credible until P03, the transport review and initial live recipe probe are complete. Split work into reviewable changes at these gates. Every change must keep existing local projects and release controls functional.

## 7. Acceptance coverage

All rows are pending implementation. References below map the PRD's acceptance IDs to tasks; they are not test results.

| PRD | Proof and principal tasks | Release |
| --- | --- | --- |
| A01 | Same full feature fixture on two independent Compose providers; V01–V03, W05–W06, Q07 | R3; baseline subset only at R2 |
| A02 | Missing profile/isolation/egress/resource control rejected before unsafe allocation; C02, C04, I07, Q02 | R1 |
| A03 | AMD/guest canaries for every routing-inventory entry; W01–W04, Q02 | R1 |
| A04 | Two feature branches/stacks/ports/volumes/credentials with denied cross-access; I08, S02, Q03 | R1 |
| A05 | Complete guest limits and healthy host/neighbor under controlled load; B03, I05, Q03 | R1 |
| A06 | Client disconnect and engine restart retain IDs/workspace and process control; B04–B05, W06, Q04 | R1 |
| A07 | Lost create/start/destroy response is reconciled without duplicate effects; B02, B04, Q04 | R1 |
| A08 | Stale generations, revoked authority and forged scope denied by production brokers; H02, B02, Q02 | R1 |
| A09 | Real nested Docker/Compose lifecycle on recorded kernel/storage/image; I02, I07–I08, Q05 | R1 container claim; separately qualify selected VM |
| A10 | Management/host/metadata/other-tenant access denied, including DNS/IPv6; H04, I01, I06, Q02 | R1 |
| A11 | Static validity, auth TTL and handle TTL remain distinct in API/UI; C03, S01–S04, U04 | R1 |
| A12 | Canary scans of transcripts/settings/audit/errors/telemetry and documented raw-delivery limits; H03, S03–S05, Q02 | R1 |
| A13 | Real issuer expiry/renew/revoke and failure policy; N03, S06, Q04 | Conditional; unsupported without qualification |
| A14 | Exact review/activation/drain/update/disable/uninstall behavior with live bindings; C04–C05, O03–O04, Q04 | R1 |
| A15 | Real helper/filesystem traversal, races, revisions, archive and size rejection; C02, I03, Q02 | R1; large transfer via N04 only if advertised |
| A16 | Approved source SHA and PR scope, main/merge denial, lost-response reconciliation; W05, Q04 | R1 |
| A17 | Work preserved, access ended, exports verified and backend inventory matches cleanup receipt; S06, O01–O03, Q04–Q05 | R1 |
| A18 | Removed from this build by user decision: native EZHarness only. | Excluded |
| A19 | Long jobs with bounded RPC/frame/log memory and reconnect gaps; C02, B05, I04, Q03–Q04 | R1 |
| A20 | Existing quality/security/approval gates pass on the exact candidate; Q06 | Every release |

Additional acceptance checks close gaps that A01–A20 do not fully specify:

| ID | Required additional evidence | Tasks |
| --- | --- | --- |
| X01 | Pre-activation probe cannot become general provider authority; service/controller delegation survives restart safely. | C04, H02, Q02 |
| X02 | Stop releases only confirmed compute; resume re-admits; ambiguous resources retain capacity and disk accounting. | B03–B04, Q03–Q04 |
| X03 | Real data/key/metadata restore meets recovery targets and cannot replay stale effects. | O02, Q04 |
| X04 | Emergency disable denies new effects while independent operator recovery remains usable and audited. | C05, O03, Q04 |
| X05 | Upgrade, rollback, cert rotation and backend/config drift preserve explicit compatibility and review. | H04, I07, O04, Q04 |
| X06 | Unmanaged source changes invalidate evidence; pushed SHA and final CI revision agree. | B06, W04–W05, Q06 |
| X07 | Full browser workflow works through failure, reconnect and cleanup with inspected desktop/mobile screens. | U01–U05, Q01 |
| X08 | SDK-only provider author can pass the published suite without modifying engine workflow. | V04 |

## 8. Validation lanes and evidence format

Use four distinct lanes. Passing one does not replace the next:

1. **Contract and deterministic tests:** schemas, compatibility, state transitions, broker authorization, faults and fake-provider fixtures. Offline candidate verification stays here.
2. **Repository integration:** real database drivers, runner framing, workspace routing, API/browser/proposal flows, built production image and existing quality gates.
3. **Operator live qualification:** approved Incus/Infisical/independent backend connections, filesystem/kernel/network/resource controls, recovery and repeated feature lifecycles. Use protected access and test scope, never production credentials on untrusted PR execution.
4. **Deployment acceptance:** exact host/config/recipe release, capacity baseline, UI walkthrough, restore drill, monitoring and signed support matrix.

Existing commands found in this checkout include:

```sh
# Use the repository's .bun-version and CI Node version.
# Install root and web dependencies separately in the implementation checkout.
bun install --frozen-lockfile
bun install --cwd web --frozen-lockfile

bun run --cwd packages/@ezcorp/extension-contract schema:check
bun run --cwd packages/@ezcorp/extension-contract build
bun run test:sdk
bun run lint
bun run typecheck
bun run --cwd web check
bun run build
bun run test
bun run test:e2e
bun run test:coverage
```

These are entrypoints, not a claim that this list reproduces every CI gate. Q06 must also use the exact required jobs in [CI](../../.github/workflows/ci.yml) and [external PostgreSQL CI](../../.github/workflows/db-postgres.yml), including production-image, browser, security and changed-source gates. Use existing shared resource locks and fixture namespaces. Register new test files with the canonical selectors/coverage manifests. New live-provider commands must be implemented and documented in C06/Q01; do not invent a command and report it as available.

Store qualification under a proposed `docs/validation/pluggable-infrastructure/<candidate-id>/` manifest, with large/redacted logs in the existing artifact system. Each receipt needs:

- Acceptance/task ID, test name/command, UTC start/end, exit status and first-attempt outcome.
- Engine source SHA and image digest; provider installation/release digest; connection revision; fixture and helper/recipe/image digest; backend/OS/kernel/storage versions.
- Profile, declared/observed controls, principal/scope category, host resource settings and benchmark workload/concurrency.
- Sanitized operation/process IDs and expected versus observed result, including failures, retries, unknown outcomes and remaining backend inventory.
- Evidence links/checksums, secret-scan result, reviewer and qualification date. No secret values, handles or private keys.

Any material source/configuration change invalidates affected evidence. Regenerate the support matrix from the recorded results rather than maintained marketing claims.

## 9. Final release checklist

- [ ] Every required task for the declared release is closed with evidence; conditional features are explicitly selected or unavailable.
- [ ] D01–D24 have recorded decisions or a release-specific reason they do not apply.
- [ ] Applicable A01–A20 and X01–X08 pass; no skipped prerequisite is called a pass.
- [ ] Ten consecutive real lifecycles pass on the selected candidate/deployment; thresholds and baseline comparison are published.
- [ ] All current repository gates pass on the release source. No known failing test, unexplained flake or broken UI is deferred as unrelated.
- [ ] Security review, operations handoff, clean-target restore, rollback and cleanup recovery pass.
- [ ] First-deployment readiness and each portability/runtime/profile claim match the exact support matrix.
- [ ] The release owner signs the scope and evidence. Any open mandatory item means the work is not complete.

## 10. Planning review

Completed in this planning pass: focused repository inspection, baseline comparison, selected official-documentation checks, gap/decision analysis, task decomposition, dependency gates and acceptance mapping.

Document validation is recorded in `tasks/todo.md`. Implementation, live providers and release qualification remain open. The next work is P01–P04, followed by the M0 boundary and routing foundation.

## 11. Execution review — 20 September 2026

Implementation base: refreshed `origin/main`, `550b7c67e1116f78f0448f2133f8ad18201fed1d`. The source checkout and its local changes are preserved. Integration worktree: `EZHarness-worktrees/pluggable-infrastructure`; isolated Sol and Terra worktrees share this base.

Independent Sol review found these additional corrections:

| ID | Correction | Implementation rule |
| --- | --- | --- |
| D25 | C04 depends on connection records introduced by B01. | Split C04 contract design from registration persistence. B01 must precede complete C04 registration. |
| D26 | G2 private clone/push requires secret delivery before G3. | Bring H03 and S01/S02/S04/S05 for approved Git use into G2; full Infisical and lifecycle work still closes at G3. |
| D27 | Existing `credentials.read` returns plaintext to an ordinary extension worker. | Preserve existing manifests during additive contract work. Do not claim this legacy API has sealed results. New provider-secret methods cannot enter the tool catalog; decide migration and reapproval before enabling external secrets. |
| D28 | Provider execution topology affects all wire and secret rules. | Ordinary short-lived reviewed v4 adapter calls translate requests. Host owns scoped transport and credentials; guest helper owns durable processes. No long-running job depends on an open runner call. Sensitive transport/dispatch remains unavailable until its separate boundary tests pass. |
| D29 | Existing lifecycle status cannot represent dependency drain and cleanup debt. | Design additive durable dependency records and API projection before C05/U work. Existing activation grants remain authoritative. Older clients cannot activate a dependent change by omitting new fields. |
| D30 | Optional routing parameters can silently restore local execution. | Persist a required execution policy before allowing sandbox binding. Every project-content entrypoint must resolve policy. An unavailable or invalid sandbox backend returns an error before local tool construction or I/O. |
| D31 | Manifest compatibility and provider protocol versions are distinct. | Add optional provider contributions to schemaVersion 4. Provider protocol major 1 and minimum host contract major 4 are separate fields. Old manifests keep current behavior; unqualified contributions confer no authority. |

R1 is first, followed by R2/R3; full A01 remains open until two independent Compose implementations qualify. Optional R4 features await selection. No optional support is inferred. The original PRD/prototype remains unavailable; this backlog is the supplied implementation input. Host capacity, live connections, numeric operating budgets and deployment signoff remain outstanding. No fabricated owner approval or measured value is used.

Offline contract design, compatibility tests and routing inventory can proceed while host inventory is pending. This refines G0 sequencing: P03/P04 still block admission defaults, live provisioning and release qualification, but do not block platform-independent contract and denial tests.

Execution checklist: `tasks/todo.md`. Integration gates: `GATES.md`. Shared implementation ownership: `PLAN.md`.

### Local-first milestone (user direction)

No approved infrastructure or prototype deployment exists. Implement and validate locally first, then build external-host networking. Local code and qualification must not depend on a remote AMD/Xeon deployment. Use available local runtime primitives and dedicated temporary resources; retain v4 provider/approval boundaries and fail-closed routing. Record which sandbox/resource/Compose/secret controls are actually available. Local proof does not claim remote host networking or independent provider portability. External networking, remote provisioning and deployment signoff are a later milestone.

Optional-scope decision: N01/N02 removed by user. N03–N06 are under discussion, not selected. N07 is future-backend tracking, not an implementation commitment.

### Active MVP scope — final user direction

Build the bare minimum locally. Use the native EZHarness loop and one persistent sandbox workspace per feature. Route the seven built-in file/search/edit/shell tools there; preserve work across disconnects and engine restart; run tests and expose bounded logs, cancellation and explicit cleanup. Keep existing approval and stored-credential behavior. A sandbox failure cannot use local project files or processes. Add the smallest supported selection/status surface needed to use the feature, and verify it end to end.

Deferred: all R4 features, external Infisical integration, a second sandbox provider and portability proof, external-host networking/provisioning and deployment qualification. Nested Compose is not an MVP requirement if the local runtime cannot qualify it safely. Declare only actually supported profiles and controls. The original R1–R3 task list is retained as the later roadmap, not as the active MVP completion rule.
