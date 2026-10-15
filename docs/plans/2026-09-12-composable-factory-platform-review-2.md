# Composable factory platform: second plan review

Date: 2026-09-12. Initial result: **changes required**. Resolution: **all 34 gaps addressed** in the amended [plan](2026-09-12-composable-factory-platform.md) and [launch contracts](2026-09-12-composable-factory-platform-contracts.md); the plan's [second resolution map](2026-09-12-composable-factory-platform.md#second-review) links each gap to its contract and stage. Implementation proofs remain **not run**. A [third review](2026-09-12-composable-factory-platform-review-3.md) later found that this review read a fix-branch commit rather than main and corrected the affected findings.

Reviewed the amended plan, its contracts (C01–C11 at the time), the [first review](2026-09-12-composable-factory-platform-review.md), `CONTEXT.md`, and the execution-boundary decision record against HEAD `93598600a`. Method: three read-only verifiers (runtime, security/tenant, infra/CI) plus direct confirmation of every P1 code claim. No product code changed and no tests ran. File references are to that baseline. The text below is the review as delivered, preserved for context.

Severity: P1 = a stated safety/recovery promise cannot hold on the current base or
the spec contradicts itself. P2 = required work with no owner, stage, or proof.
P3 = the plan's description of existing code is wrong.

## P1 — promises the base or the spec cannot hold

1. **Install path runs untrusted manifest code in the host process before
   verification.** `src/extensions/installer.ts:502` calls `loadManifest`, which
   does `await import()` (`src/extensions/loader.ts:82`) with full `process.env`,
   BEFORE the env-leak gate (`:509`) and checksum check (`:519-523`). C05's
   "isolated preparation worker" is correct, but section 10 says to reuse the
   harness installer, and F05 cannot pass through it as-is.
2. **Master encryption key is reachable from `$CWD` grants in the plan's own
   target config.** With `DATABASE_URL` set and no `EZCORP_SECRETS_DIR`,
   `.pi-secret` is written to `process.cwd()` (`src/providers/encryption.ts:31-42,97-105`)
   and `getDbMaskDirs()` returns `[]` (`src/db/connection.ts:55`), so the reserved
   deny set (`src/extensions/permissions.ts:186-215`) does not cover it. Eight
   bundled extensions hold `filesystem: ["$CWD"]`.
3. **The shared sandbox seam fails open; C05 demands fail closed.**
   `resolveShellSandbox` returns null on advisory tier or jail error and the
   caller spawns unjailed (`src/runtime/tools/shell.ts:84-104`). Only MCP has a
   fail-closed flag. The plan never says this is a behavior change to three
   existing spawn seams or which stage owns it.
4. **No feature-flag system exists, and the nearest precedent is fail-open.**
   Section 13 and C09 gate everything behind a "factory feature flag". No flag
   mechanism exists; the loops kill switch (`src/extensions/loops-kill-switch.ts:18-38`)
   is deliberately fail-open. The mechanism and its fail-closed default are
   unspecified.
5. **JWTs carry no `iss`/`aud`; verification checks signature + expiry only**
   (`src/auth/types.ts:8-17`, `src/auth/jwt.ts:68-90`). C01's cross-installation
   rejection rests entirely on distinct per-installation secrets, which nothing
   in the plan mandates the provisioner to generate.
6. **C06's 15-minute stop-the-world checkpoint barrier is not reconciled with
   C11.** The barrier stops effect claims and worker dispatch. C11 requires
   p95 admission ≤ 2 s and no backlog growth; fault windows are excluded from
   percentiles, barrier windows are not. Per-tenant vs global barrier on a
   shared Temporal cluster, and a maximum barrier duration, are unspecified.
7. **The pool admission service is shared cross-tenant state with no
   tenancy, storage, auth, or failure-domain spec.** C03 puts compute
   reservations in "a separate resource ledger" with round-robin across
   tenants. C01 says shared infrastructure never shares product authority.
   The ledger is product authority.
8. **Legacy adapter: "opaque" contradicts "reject publication-capable steps".**
   Section 12 exposes workflows opaquely; C04 rejects publication-capable legacy
   steps. Legacy step definitions are free-form jsonb with shell/MCP tools and
   declare no effects. No classification rule exists.
9. **Legacy reconciliation has no API to stand on.** The run route accepts no
   idempotency key or caller run id (`web/src/routes/api/workflows/[name]/run/+server.ts:15-18`);
   `workflow_runs.idempotency_key` is reserved for the `nested:` shape and
   insertion is at-least-once (`docs/features/orchestration/workflows.md:1014-1015`);
   `awaiting_approval` is terminal; orphan recovery runs only at web boot
   (`web/src/lib/server/context.ts:221`) and terminalizes a mid-batch orphan; a boundary orphan becomes resumable.
10. **Approval reuse is implied but impossible.** `workflow_approvals` binds
    `(run_id, step_name)` with no request digest, and re-parking overwrites the
    answered row (`src/db/queries/workflow-approvals.ts:55-67`). Per-tool-call
    gates are in-memory (`src/runtime/tools/permissions.ts:188`). The reusable
    precedent — delegation `consentHash` + widening-only reconcile
    (`src/runtime/workflow-capability-hash.ts:501`,
    `src/runtime/workflow-consent-reconcile.ts:157`) — is never cited.
11. **Audit plane unmapped.** The existing governance audit is fail-open by
    design (`docs/features/platform/audit-and-observability.md`); C06's factory
    audit is fail-closed. C01 consent/grant records say "audit record" without
    naming which plane. Consent recorded fail-open can be silently lost.

## P2 — required work with no owner, stage, or proof

12. **Hosted control plane / tenant provisioning is unspecified.** Provisioner,
    hosted directory, ingress→tenant mapping, per-installation secret generation,
    fleet migration (2,972-line `migrate()` at every boot × 100), fleet
    upgrade/backup. No section, stage, or proof. No Kubernetes artifact exists.
13. **GPU host pool lifecycle unowned.** C05 needs tenant-dedicated GPU hosts
    reimaged between tenants; C03 must schedule them. No provisioning/reimage/
    scale component, no GPU CI runner (all jobs `ubuntu-latest`).
14. **Native executor refactor unowned.** C02's one sentence ("native harness
    extraction must add these operation boundaries") implies a pluggable
    provider transport, journal hooks, COW workspace checkpoints, and a Bun
    runner image, coexisting with the chat path without duplication.
15. **Where runtime schema validation executes is unstated.** C07 validates
    node input before dispatch and results before success. Inside a Temporal
    workflow the validator must be sandbox-safe (no codegen); in an activity it
    must be recorded. One validator must serve Node workflow sandbox, Bun, and
    Python.
16. **Temporal SDK confinement and the outbox dispatcher are unstated.** The
    Bun API cannot link `@temporalio/client` (native core). C08's "trusted
    dispatcher" (outbox → Temporal) has no owner, lane, or delivery semantics.
    Worker-per-namespace capacity for 100 namespaces is unmodelled. Worker
    versioning mechanism (Build IDs vs `patched()`) is unchosen.
17. **Python and Node runtimes have no foothold.** Zero Python files, no
    interpreter pin, packaging, lint, or coverage producer. No Node pin
    (`.bun-version` is the single pin), no second process in `Dockerfile`,
    compose, `release-image.yml`, or the upgrade/rollback verifiers.
18. **Object storage and key management are greenfield.** No S3 client or
    config anywhere. C06's key-version retention has no KMS design; the master
    key is a file with no rotation. MinIO AIStor Free licensing is an unowned
    deployment prerequisite.
19. **Coverage pipeline excludes new packages.** `SOURCE_GLOBS`
    (`scripts/coverage-config.ts:156-168`) lists six patterns; a new
    `packages/@ezcorp/factory-sdk` or Node/Python dir is outside the new-file
    and patch gates until six CODEOWNERS-owned files change.
20. **Lane manifest and required checks.** `web/e2e/lanes.json` allows exactly
    five lane names (`src/__tests__/e2e-lanes.test.ts:28,106`). Required checks
    are a branch-protection admin action on a config already drifted (10 of 13
    enforced). C11's "release readiness check that inspects actual required-check
    configuration" does not exist.
21. **Svelte Flow + ELK contradict a recorded decision.** `tasks/2026-07-26-chat-dag-graph.md:19`
    and `web/src/lib/graph/layout.ts:5-7` reject graph libraries; a deterministic
    hand-rolled layout ships. The plan never mentions it. This is a contested
    choice needing a decision record.
22. **`/factories` console is a first-party host subsystem.** The Hub page
    schema has nine fixed node types and no custom rendering; the existing
    ez-factory console cannot host it. The plan treats it as a bullet list.
23. **External Postgres has no migration rollback.** Snapshot/rollback/circuit
    breaker exist only on PGlite. Factory tables on Postgres are additive-only
    with code-only rollback; say so. Feature-off boots will still create the
    factory DDL on every install.
24. **Single-container invariant is abandoned silently.** `CLAUDE.md:8` and
    `docs/features/platform/deployment-and-releases.md:7` state it; factory
    profile adds hard deps. Needs an explicit decision record + CLAUDE.md edit.
25. **Supervisor privileges unspecified.** C05 forbids socket mounts in
    sandboxes; the supervisor that launches runsc containers needs container
    runtime access. Where it runs and how it is confined is unstated. gVisor vs
    the existing unshare/bwrap/seccomp/nftables stack and setuid `preview-spawn`
    (`Dockerfile:36-100`) is unanalysed.
26. **Two artifact stores will coexist.** ez-factory `emit_artifact` writes
    sha256-named files under `.ezcorp/extension-data/ez-factory/artifacts/`
    (`extensions/ez-factory/lib/tools/shared.ts:508-511`); its job store is
    install-wide and ownerless (`lib/jobs.ts:7-20`). Boundary unspecified.
27. **Stage 2 is overloaded with no sub-gates.** F01, F02, F03, F08, F06-storage,
    F05-baseline plus provisioning, gateway, Python, journals, admission, archive.
28. **Product gaps not in scope or deferred list:** approval notifications
    (24 h expiry, no channel), cross-tenant identity/SSO, billing/metering,
    alerting mechanism for C11 rules (existing observability is a per-turn
    telemetry table).
29. **C07 semantics to state explicitly:** no arithmetic in the AST, so loop
    counters/derived values need task nodes; Branch has no multi-way switch;
    node-deadline maximum unstated; an Approval consumed inside a losing
    speculative branch has no defined outcome.
30. **C01 reuse claims name fields that do not exist.** `service_accounts`
    (`src/db/schema.ts:594-635`) and `extension_rbac_grants` (`:2676-2695`) have
    no expiry or revocation revision. Membership enforcement covers mutations
    only; reads are instance-global by recorded decision. `requireScope` is a
    no-op for cookie sessions; scopes have no hierarchy.

## P3 — the plan misdescribes existing code

31. **Section 2 module inventory.** "Model routing" does not exist for
    workflows (`src/runtime/workflow-model.ts:159` is a static override).
    "Bounded loops" bound iterations only (ceiling 25, no wall clock, token
    check only at batch boundaries for delegated runs). "Version records"
    precedence is unimplemented (`src/runtime/workflow-definition-hash.ts:70-76`).
    "Immutable versions" — definitions are mutable, resolved by name, nested
    children resolve by name at dispatch (`src/runtime/workflow-executor.ts:2033`).
    "Ownership" policy is instance-wide. `$prev` in `workflow-refs.ts` is
    batch-defined and meaningless under independent branch progress. Four of
    nine are portable pure modules: condition eval, ownership ladder, capability
    hash, consent reconcile.
32. **Section 2 recovery wording.** "Rejects uncertain in-flight work" — it
    terminalizes the whole run (`src/db/queries/workflow-runs.ts:855-916`).
    "Limits its distributed scheduling scope" — multi-host is safe via lease CAS
    (`:1180-1202`); coordination/fairness is what is missing.
33. **Section 6 implies a transition-function house pattern.** None exists.
    Nearest is `packages/@ezcorp/sdk/src/runtime/loop-core.ts:349`, which returns
    state and no commands. Stage 1 is greenfield.
34. **Stale inputs the plan leans on.** `docs/features/orchestration/workflows.md:1029`
    says the approval timeout sweep and run-history API do not exist (both do:
    `src/extensions/host-maintenance-daemon.ts:465`, `src/api-registry.ts:413-414`).
    `docs/features/extensions/ez-factory.md` line refs are stale.
    `tasks/capability-expiry-design.md:3` says "design only" but
    `src/extensions/perm-expiry-sweep.ts` is 950 lines.

## Withdrawn during review

- C01's `session` rule is valid: it is `SESSION_ROUTE_SCOPE` in `ApiRouteScope`
  (`src/api-registry.ts:15-38`), not an API-key scope.
- The "deliberate failing assertion" proof in C11 does not collide with
  `scripts/gate-integrity.ts`; a plain failing `expect` matches none of its ten checks.
