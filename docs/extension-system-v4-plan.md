# Extension system rewrite: review and implementation plan

Date: 2026-09-04. Reviewed checkout: `93598600` in EZHarness, with existing local city-conditions and bundled-registration edits present. Those edits were not changed.

## 1. Recommendation and fixed decisions

Replace the extension lifecycle with one host-owned module. It manages editable workspaces, repeatable builds, immutable releases, tests, approval, activation, and recovery. Run extension code in rootless Podman. Keep useful host capability handlers and product features, but replace their public contracts and remove the old authoring and install paths at cutover.

The harness should write business logic and use a small set of build tools. It should not write transport loops, locate host directories, repair dependency resolution in the host app, or infer success from an installed database row.

User decisions:

- Clean break from the current extension format. No permanent compatibility runtime.
- Reliable self-building is the main priority. Preserve all current extension features.
- Use Podman for local isolation. Permit weaker execution only through an explicit admin exception for trusted code.
- A user approves the exact tested release and its permissions before activation. Approval does not let a user exceed their own rights.
- The builder owns and may edit feature tests. The host owns security, protocol, and lifecycle checks. Show feature-test changes in release review; a passing builder test is not independent proof that the user request is satisfied.
- Deliver a plan now. Do not implement the rewrite as part of this review.

Absolute security is not a valid acceptance claim. The target is a defined threat model, enforced controls, reproducible tests, clear exceptions, and a safe recovery path.

Alternatives considered: patching the existing lifecycle leaves executable host config and mutable install state; running extensions in-process weakens fault and security isolation; a WASM-only rewrite limits current native dependencies and MCP programs. Rootless Podman with a small SDK best fits the requested security and feature coverage. A container per installation shared by all users was also rejected because process memory can retain another user's inputs.

## 2. Review findings and evidence

| Finding | Evidence | Required design response |
|---|---|---|
| Extension config executes in the host before validation. | `src/extensions/loader.ts:82` imports the supplied TypeScript module. A temporary invalid config set a marker in the host global object before validation rejected it. The comment in author-install describing a child-process import does not match this implementation. | Never import extension source in a host process. Compile and discover metadata inside isolation; accept data only. |
| The acceptance decision depends on a draft label, not just executable content. | `src/extensions/author-gate.ts:119`: the same tool fixture without a smoke test passed with `draftType: skill` and failed with `draftType: tool`. | Derive required tests from the validated release contributions. Remove the separate draft-type gate. |
| Authoring cannot represent an ordinary source tree. | `src/db/queries/ez-drafts.ts:49` allows seven flat file names. The author extension has a mirror; modify copies back files absent from the draft. | Support bounded relative file paths, directories, additions, deletions, and assets. Remove mirrored file lists and implicit carry-forward. |
| Install combines file moves, database writes, enablement, draft consumption, and registry reload. | `src/extensions/author-install.ts:363` moves the draft before the install catch block. Later stages consume the draft and reload the registry separately. | Immutable artifacts plus a durable operation journal and atomic active-release pointer. No live directory replacement. Crash behavior needs fault-injection tests; it was not reproduced here. |
| Isolation can degrade automatically. | `subprocess.ts` skips wrapping without a project root or under advisory mode, and catches jail construction errors to run unjailed. The current E2E spawn probe also accepts an unjailed fallback. | Probe specific controls and refuse secure execution if one is missing. Trusted fallback must be separately authorized and visibly classified. |
| The current RSS flag is not an effective Linux memory limit. | `src/extensions/subprocess.ts:246` uses `prlimit --rss`. Linux documents that RLIMIT_RSS only affected specific old Linux 2.4 behavior. | Enforce memory, CPU, process, temporary-storage, and output limits through the runner. [Linux getrlimit documentation](https://www.man7.org/linux/man-pages/man2/getrlimit.2.html). |
| Call tokens are not strictly bound to the receiving extension. | `src/extensions/tool-executor/provenance.ts:106` logs an actor mismatch and proceeds. The existing provenance suite explicitly passes a test for an ext-A token used at ext-B. | Bind tokens to worker instance, extension release, principal, scope, and active invocation. Mint a new bounded token for cross-extension calls. This review did not establish token theft through an end-user exploit. |
| Dependencies depend on deployment state. | `src/extensions/npm-deps.ts` resolves from local/host modules and accepts an unreadable package version at line 97. | Lock and package the dependency closure per release. No runtime resolution through host node_modules. |
| A smoke result covers little of a rich extension. | `sdk/verify.ts` checks one declared tool result. Its test helper constructs a subprocess without the production broker wiring. | Test through the same broker and runner as production, in a separate test scope. Cover every contribution and declared dependency. |
| Authors must know transport and host details. | The tool scaffold writes a JSON-RPC stdin loop; SDK and host contain separate manifest types; handlers, manifests, grants, and UI rendering have separate shape rules. | One contract package, generated clients and validators, and an SDK-owned transport. |

Existing strengths to retain: owner-scoped drafts, host-issued call provenance, capability mediation, permission ceilings, typed install errors, real-browser release testing, rollback intent, and centralized dependency checks. Replace the fragile contracts around these strengths rather than discard working domain behavior.

### Executed checks

- `bun test src/__tests__/verify-extension.test.ts`: 7 passed. The first sandboxed CLI run failed with IPC `EPERM`; the rerun outside that sandbox passed. This was an environment restriction, not a product failure.
- `bun test src/__tests__/extension-author-passes-own-gate.test.ts`: 2 passed with a real subprocess.
- `bun test src/__tests__/author-install.test.ts`: 46 passed. These include mocked dependencies; they do not prove crash consistency.
- `bun test ./src/extensions/__tests__/tool-executor.provenance.test.ts`: 14 passed, including the permissive cross-extension-token case.
- From `web/`, `bun x playwright test --config playwright.real.config.ts e2e/real-auth/extension-release-gate.spec.ts --reporter=list`: 1 passed. This built the app and exercised real auth, install, activation, browser invocation, visible output, repeat use, and upgrade.
- Temporary fixtures reproduced host config execution and the draft-label gate difference without editing product source.
- `podman info` reported Podman 5.8.2, rootless mode, cgroup v2, CPU/memory/PID controllers, and seccomp on this NixOS machine.
- An offline, disposable Alpine container ran as UID 65534 with zero effective capabilities, no-new-privileges, seccomp, a read-only root, no network route, no host mounts, and explicit memory/CPU/PID limits visible in cgroup files.
- A disposable cached Bun 1.3.14 container ran successfully under the same restrictions and failed an outbound network attempt. A bounded memory-allocation probe exited 137 under a 128 MiB limit. A second probe retained its container for inspection: Podman reported `OOMKilled: true` and exit code 137. The probe container was then removed.

The browser run also reported existing Svelte/build warnings, a github-stats install refusal for `GITHUB_TOKEN`, and a file-organizer daemon permission warning. The browser flow passed despite these. Their fixes were outside this review; extension startup failures must be resolved or explicitly excluded from the future release gate. No full repository suite, pixel review, live model authoring benchmark, or complete penetration test was performed.

## 3. Architecture and public contracts

### One contract package and one lifecycle module

Create `@ezcorp/extension-contract` with no database or runtime imports. It owns the versioned release schema, tool and contribution schemas, host capability schemas, diagnostics, and operation states. Generate SDK types, wire validators, tool descriptions, and reference examples from these definitions. The host validates all received data using its own installed copy; sharing definitions does not mean trusting validation done by a child.

Expose the lifecycle through thin HTTP, CLI, and harness adapters. They must call the same host implementation, including authorization and validation. Move authoring management out of the privileged extension-author subprocess and into host tools. A product page may still present the authoring workflow.

| Harness tool | Contract and result |
|---|---|
| `extensions.describe` | Return supported contributions, SDK version, capabilities, limits, templates, and relevant examples. Filter to the caller's scope. |
| `extensions.workspace` | Create, fork an installed release, list/read files, or apply an atomic batch of writes/deletes. Changes require an expected workspace revision. Return workspace ID and new revision. |
| `extensions.build` | Build and verify one workspace revision. Require an idempotency key. Return an operation ID immediately. |
| `extensions.inspect` | Read operation status, diagnostics, source/test diffs, release evidence, and activation state. Support an event cursor for reconnects. |
| `extensions.release` | Request exact-release approval, activate an approved release, roll back, disable, or uninstall. The caller cannot submit or forge an approval decision. |

The host approval UI/API is separately authenticated. No builder capability can approve its own release or enable a fallback exception.

Build and activation operations return `operationId`, `state`, and typed diagnostics. A diagnostic contains `code`, `stage`, `message`, optional file/line, and whether retry is safe. Do not make the model parse stack traces or HTTP status prose. Failed calls with uncertain side effects return `outcome_unknown`, not a retry suggestion.

Use existing tool discovery and invocation for installed extensions. Do not add a second execution route for the builder.

### Author SDK and release format

- Authors use `defineExtension` with metadata, declared contributions, schemas, and handlers. The SDK owns startup, tool registration, framing, cancellation, logging, and error conversion. Expose capabilities on an invocation-scoped `ctx`; do not expose host paths or global identity.
- The build container loads the definition and emits data-only metadata. The host validates it. Runtime startup must report matching contribution identities and schema hashes before becoming ready. Startup has no user capability token and cannot perform host effects.
- Use a new release format, schema version 4. A host-created descriptor records source digest, artifact digest, SDK/protocol version, runtime image digest, locked dependency digests, contribution catalog, requested capabilities, resource limits, and test evidence. The host never accepts a builder assertion that a release is verified.
- Artifacts are immutable and addressed by a SHA-256 digest. Include source, tests, compiled code, assets, dependency closure, and build recipe. Verification evidence also records the host validator version and test environment. A change to any input requires a new build and approval.
- Support nested source/assets and explicit delete operations. Reject absolute paths, traversal, NULs, device files, and links escaping the artifact. Keep code, test output, user data, and secrets in separate stores. Do not merge old node_modules or missing source files into a new release.
- Begin with TypeScript/Bun for authored code. Preserve native binaries and other languages through controlled MCP/command contributions and approved runner profiles; do not add multiple author SDKs in this rewrite.

### Extensibility without a generic escape hatch

Register each host capability once with its request/response schema, handler, required scope, permission rule, quota, and audit policy. Generate the SDK wrapper and contract tests from that registration. New domain capabilities should not require edits to several dispatch switches or permission maps. Extensions cannot register new privileged host handlers.

Preserve tools, skills, agent definitions, workflows, cross-extension calls, lifecycle hooks, preprocessors and attachments, message actions, panels/pages, entities, settings/secrets, storage/files, events, schedules, loops, webhooks, LLM calls, search, memory, lessons, and MCP connections. Each contribution has a host adapter and acceptance check. Unknown types fail with a supported-version diagnostic.

Reuse the existing host page schema and safe renderer. Both push updates and pull rendering pass through the same validator. Do not add extension-supplied HTML/JavaScript to the host page. Typed output schemas and artifact handles replace large opaque text payloads where structured data is available.

MCP remains a transport adapter under the same release, grant, audit, and invocation rules. Local MCP runs in Podman; remote MCP uses a host connector with controlled destinations and secrets. Record the observed MCP tool catalog. Newly discovered tools or changed capability requirements require review; discovery cannot silently expand the approved catalog. Remote server code itself cannot be made immutable by a local digest.

## 4. Podman isolation and authorization

### Threat model and runner placement

Treat generated source, dependencies, build scripts, tests, extension output, MCP servers, and remote responses as untrusted. Protect host credentials/database, other users and extensions, the harness process, approval records, and availability. Rootless containers share the host kernel; kernel compromise and compromised administrators remain outside the isolation guarantee.

Use a small host runner under a dedicated unprivileged OS account. It invokes Podman with fixed argument construction. The app talks to a narrow authenticated runner interface: build, start, cancel, inspect, and collect output by host-issued IDs. The runner resolves paths and image profiles itself. It accepts no arbitrary Podman flags, host mounts, shell command strings, or caller-selected container IDs.

When the harness runs in Compose, the runner remains on the host. Mount only its restricted communication socket into the app. Never mount the Podman socket into the app or an extension. Podman's service API grants the caller the ability to execute code as its service user; it is not an authorization layer. [Podman service security](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html).

Use versioned HTTP over a Unix-domain socket for the app-to-runner interface, restricted to the app/runner OS group and checked peer identity. Stream artifact bytes by digest; do not let callers supply host source paths. Use SDK-owned JSON-RPC over attached stdin/stdout for the worker, with stderr reserved for bounded logs. Validate frame size before parsing, method schemas before dispatch, and response IDs before resolving a call. Malformed output terminates that worker with a structured protocol error. Container output is never interpreted as a shell command or approval event.

### Secure execution profile

- Rootless Podman, pinned image digest, non-root container UID, private PID/IPC namespaces, `--network=none`, `--read-only`, `--cap-drop=ALL`, no-new-privileges, and an explicit tested seccomp profile. Never use privileged mode, host namespaces, devices, or host runtime sockets.
- Mount only the release artifact read-only. Provide bounded temporary storage. Do not mount the repository, host home, app database, or host dependency tree. Host services and persistent data are reached through the broker.
- Default invocation limits: 512 MiB memory, no additional swap, 1 CPU, 64 PIDs, 64 MiB temporary storage, 60-second call deadline, 1 MiB control frames, and 1 MiB retained logs per call. Large results use bounded artifact streams. Default build limits: 2 GiB memory, 2 CPUs, 128 PIDs, 1 GiB temporary storage, and 5 minutes. Admin policy can raise limits explicitly; a manifest cannot raise its own ceiling.
- Enforce global queue/concurrency budgets as well as per-container limits: initially one build and four execution containers per runner. Each rejected or queued request has a visible reason. Validate these defaults against the complete bundled inventory before cutover; adjust profiles through reviewed policy, not hidden exceptions.
- Confirm actual cgroup controller settings and isolation at startup. Report the missing control and stop secure execution if validation fails. Do not treat a successful `bun --version` as proof of isolation. [Podman run controls](https://docs.podman.io/en/latest/markdown/podman-run.1.html).
- Run normal calls in a fresh execution context. Persistent extensions get workers keyed by installation, release, principal and permission scope. Never share a user-scoped process between users. Serialize stateful handlers within a scope; different scopes remain independent. Host storage still requires transactional concurrency controls.

### Broker and data rules

- Bind every invocation token to the worker instance, release, installation, principal, scope, deadline, and permitted operations. Reject identity mismatches. Revoke tokens on completion, cancellation, process death, retirement after draining, or permission revocation. Replacing a release stops new old-generation work; already-running calls retain their bounded tokens only through their existing deadline unless rights are revoked.
- Cross-extension calls mint a new callee token with explicit delegation and a parent trace. Effective authority is bounded by user rights, installation grants, the callee declaration, and the caller's delegation. Reject cycles beyond a fixed depth of 8. Dependencies cannot inherit the root extension's grants automatically.
- Check access on every host effect, including page actions, events, background jobs, and reverse RPC. Scheduled work has a recorded owner or an explicit service grant; it cannot use an implied current user. Missing consent produces a resumable awaiting-approval state, not a blocked transport call.
- Default network access is denied. HTTP requests go through a host broker that validates scheme, host, port, resolved address, redirects, timeouts, and response sizes. Block private/link-local/metadata destinations unless an exact destination has a separate grant. Revalidate redirects and the connected address. Strip credentials on origin changes.
- SDK code uses the broker directly. Native/MCP programs can use a runner-owned loopback proxy relayed through the broker channel, without an external container network interface. HTTP and exact-destination TCP tunnel grants are distinct; a TCP grant does not claim to inspect encrypted application traffic. A program that cannot use the supported proxy must be adapted or receive a separately reviewed trusted-local exception; never silently grant a host network namespace.
- Keep secrets in the existing encrypted host store. Prefer broker-side credential injection; tests use synthetic credentials. Preserve integrations that need raw credentials only through a separate explicit secret-read grant. Mark that an extension with secret-read plus network access can disclose that secret; the system cannot promise otherwise.
- File operations use host-issued resource handles and descriptor-relative containment checks, not child-supplied host paths. Existing arbitrary shell use becomes a scoped command contribution executed in a separate container with reviewed mounts and network policy. A boolean shell grant must not become unrestricted host execution.
- Add host storage compare-and-set/transactions. Use installation, scope, and principal as keys. Global storage is intentionally shared and cannot contain user secrets. Code release rollback does not automatically roll user data back.

### Trusted fallback

Disabled by default. An admin may approve a specific immutable source/build input digest for a trusted build, or a specific release digest for trusted execution on a host without required isolation. Record the omitted controls and approver. The builder cannot set trust, bundled status alone does not imply trust, and trust does not follow a changed digest.

Use the strongest available local process restrictions, a separate unprivileged account, and the same broker where possible. Label the result `trusted-local`, never `isolated`. Do not automatically enter this mode after a runner failure. Review exact-release activation separately. This exception carries lower protection against malicious code, as requested.

## 5. Build, test, activation, and recovery

### Repeatable build and repair

1. Accept an atomic workspace revision. Bound source size and file count (initially 20 MiB and 2,000 files); allow admin-reviewed larger profiles. The builder reads and patches this workspace without access to the harness repository or control records.
2. Snapshot and hash that revision before starting work. Resolve dependencies through a controlled fetcher to exact versions and integrity hashes. Use an approved registry and immutable cache; reject path escapes during extraction. Git dependencies require a commit and content digest. Runtime has no package installation step.
3. Build with the pinned SDK, Bun image, and lockfile in Podman. Builds are offline after dependency fetch. Dependency lifecycle scripts are disabled by default; approved exceptions run only in the build container and become recorded build inputs. Native requirements select a maintained runner profile, not a model-supplied privileged Dockerfile.
4. Compile/type-check, validate metadata, run builder tests, then run host-owned contribution/security/protocol tests. The latter use the production runner and broker against isolated test data and synthetic integrations. Collect exit status and assertions from outside the extension. Reject skipped required checks, stale evidence, timeouts, or merely printed PASS text.
5. Return structured diagnostics for repair. Each repair produces a new revision. Default automated repair budget is three builds per request; exhaustion returns the accumulated evidence and a clear failed state. It must not grant permissions, alter host tests, or activate code to get a green result.
6. Store the immutable verified release and render source, feature-test, capability, dependency, and isolation changes for review. A real external-service test requires a separate approved test grant; offline checks cannot certify provider behavior. Never silently reuse production secrets during verification.

### Durable state and exact approval

Use separate records for workspace/revision, build operation, immutable release, approval, installation/active release, and invocation. Use the current database layer; implement its transaction behavior on both supported database engines. Source and artifact bytes live outside the database under host-controlled digest paths.

Build states: queued → building → verifying → verified, failed, or cancelled. Activation states: awaiting_approval → activating → active, failed, or cancelled. An installed extension can separately be disabled or degraded. Store durable operation events and expose the same states in CLI, chat, and UI.

Bind approval to release digest, installation, principal/scope, exact capability set, dependency release set, resource profile, runner image and isolation mode. At activation, recheck actor rights, permission policy, revocation, evidence version, and expected current release. Any changed approval input makes the approval stale. The build job cannot write approval or verification records.

### Activation and restart rules

- Serialize activation per installation with a durable lease and fencing value. Use expected-active-release comparison to reject stale updates. An idempotency key returns the original operation instead of creating a second install.
- Fully copy and hash the artifact into its final immutable store before referencing it. File copying across volumes is a staging operation; it never replaces live files. A crash leaves either an unreferenced artifact for cleanup or the existing active release.
- Start the candidate in a test namespace without production effects. Check its startup catalog and required behavior. Then switch the active database pointer with the approval record in one transaction and publish a catalog generation through a durable outbox.
- New invocations resolve the active generation. Existing invocations stay pinned to their old release and bounded permissions until completion or deadline; the old worker is then removed. Reject new background work from a retired generation. Do not kill the authoring control operation while it activates another extension.
- Reconcile the active generation before accepting traffic after a host restart. Abandoned builds are retried from their frozen inputs; activation resumes from its journal. A process crash after an external effect gives an uncertain result unless the integration has a durable idempotency key. Never promise exactly-once external effects.
- Persist event/webhook deliveries with deduplication IDs, leases, retries and a dead-letter state. Deliver at least once; expose duplicates to idempotent handlers. Pause generation changes and record outstanding work during cutover. Permission revocation cancels queued work and invalidates live broker tokens.
- Report activation success only after the required runner/catalog acknowledgements arrive. If acknowledgement fails, retain a truthful degraded/reconciling state and an operation link. Never render an installed row as a working extension.
- Keep the previous verified artifact for rollback. Rollback uses the same approval/policy and active-pointer rules. Security revocation can prevent rollback to an old release. Uninstall disables routing and drains work first; retain data by default and use a separate explicit deletion operation.

### Data migration

Require versioned data schemas for extensions that change stored shape. Use a quiesced migration window with an extension-scoped snapshot and a migration executed in isolation. No migration has network or unrelated data access. Validate transformed data before resuming work. If a migration fails, restore the snapshot before allowing writes.

After new-version writes resume, roll code back only if the data remains readable by the prior release. Otherwise require an explicit data-restore decision that states which writes would be lost. Do not hide a destructive data restore inside automatic code rollback.

## 6. Implementation sequence and release gates

### Ordered work

1. Record an inventory of all bundled and reference extensions, host handlers, contribution types, install sources, database relationships and UI entry points. Map every retained feature to a new contribution and executable parity test. Start regression fixtures for the findings in section 2. Store implementation checkboxes in tasks/todo.md.
2. Build the contract package, SDK entry point, workspace/revision store and operation journal. Remove transport knowledge from generated examples. Test version rejection and atomic workspace edits through the public interface.
3. Implement the Podman runner, broker and trusted-local adapter. Gate progress on isolation, identity, quota and revocation tests. Ship a NixOS/systemd setup and Compose connection configuration for the host runner; do not silently change host settings.
4. Implement locked builds, isolated verification, durable evidence and exact-release approval. Replace scaffold/validate/install chains with the shared lifecycle tools and UI status model.
5. Connect all contribution adapters and migrate bundled/reference source. Run feature parity against the old behavior, including real pages, attachments, background work, delegated workflows, MCP, and secrets. Keep old and new code only during implementation; no mixed active runtime at release cutover.
6. Rehearse backup, cutover, restart and rollback on a production-shaped copy. Preserve installation IDs, user data, settings, ownership and conversation links. Convert first-party code explicitly; mark other old-format installs disabled with a rebuild/export path. Do not execute old TypeScript manifests to migrate them. Do not widen grants or auto-approve rebuilt releases.
7. Release the major version after all gates pass. Remove the old TypeScript manifest loader, flat-file scaffold allowlists, duplicate verification/install paths, old protocol clients and implicit fallback branches. Update docs, templates and SDK package exports in the same change.

### Required tests

| Gate | Required scenarios and pass evidence |
|---|---|
| Author experience | A fresh harness request creates a nested-source extension, adds a locked dependency, encounters an injected compile failure, repairs it, builds, waits for approval, activates, invokes and renders the result. Repeat with a tool, page/entity extension, and workflow/event extension. No host repository edits or hand-written RPC required. |
| Acceptance integrity | A skill-labelled tool cannot skip checks; missing handlers, mismatched output, failed/skipped tests, page-schema violations, stale evidence and edits after build are rejected. Builder test edits are visible. A printed PASS is insufficient. |
| Host separation | Malicious config, dependency scripts and tests cannot access host files/env, database, runtime sockets, other workspaces, or approval records. Test archive traversal, symlink swaps, IPC spoofing, secret handling and cross-user storage. |
| Isolation | Prove network denial including IPv4/IPv6 and metadata routes, immutable code, non-root identity, seccomp/no-new-privileges, memory OOM attribution, process limit, CPU control, disk/output bounds and cancellation of descendants. Run on NixOS and the supported deployment/CI host. Missing controls fail; trusted fallback never happens automatically. |
| Authorization | Wrong-extension, wrong-worker, expired and replayed tokens fail. Cross-extension calls get fresh bounded tokens. Test simultaneous users, role changes, dependency updates, scope changes, revocation during a run and ownerless jobs. |
| Lifecycle | Inject failure after every durable transition and file-stage boundary. Test duplicate installs, concurrent edits, stale approvals, cross-device staging, crashes before/after pointer commit, restart recovery, registry acknowledgement loss, old in-flight calls, rollback and uninstall/data retention. |
| Effects and storage | Test duplicate webhook/event delivery, lost response after external success, idempotency, compare-and-set conflicts, atomic entity changes, failed migration, and code rollback after new data writes. Never auto-retry an ambiguous destructive effect. |
| Product parity | Run the current real-auth release flow against the new architecture, then every retained contribution. Check visible results and errors, keyboard use, long output, loading states, and light/dark mobile/desktop pages. Capture and inspect screenshots rather than accept mocked API success. |
| Build integrity | Build the same frozen input twice in separate containers and compare artifact digests. Include missing/modified dependencies, native build exception, offline cache miss, new runtime image and changed SDK. Any non-repeatable artifact blocks release until the input or build output is corrected. |
| Operations | Restart app and runner independently; test queue pressure, unavailable Podman, cancellation, orphan cleanup, crash-loop backoff and storage cleanup without deleting referenced releases. Verify audit and metrics for every failure stage. |

Run repository lint, type checks, build, backend tests, SDK tests and web tests with the repository's configured per-file isolation. Register new E2E tests in the required lane/evidence manifests. Do not count a skipped security suite as a pass. Resolve relevant startup failures before release; track unrelated warnings separately.

Use structured audit records with operation, release, invocation and trace IDs. Record build duration, queue time, verification failures, activation failures, worker restarts, resource kills, policy denials and uncertain outcomes. Sanitize logs and cap retention. A failed audit write must not authorize an effect that required an approval record.

### Final review and limits

The plan addresses the observed causes rather than only reorganizing files: host code loading becomes isolated discovery; mutable installs become immutable releases; flat drafts become versioned workspaces; repeated declarations become shared contracts; author-written transport becomes SDK behavior; implied security becomes enforced runner policy.

The two real runner adapters are Podman and explicitly trusted local execution. Additional runner abstractions are unnecessary until another implementation is required. Keep the lifecycle as one module with private storage/build/runner seams, not a set of separately deployed business services.

Validated now: current selected tests, two concrete gate defects, local Podman controls, and Bun feasibility. Not validated now: the proposed implementation, its full security properties, migration against production data, all feature parity, or performance under production load. Those are explicit implementation release gates, not claims of completion.

Your Actions: Review the saved plan before implementation. No system setup or approval action is needed for this review.

