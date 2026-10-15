# Composable factory platform: third plan review (against main)

Date: 2026-09-13. Initial result: **changes required**. Resolution: **all items addressed** in the amended [plan](2026-09-12-composable-factory-platform.md) and [launch contracts](2026-09-12-composable-factory-platform-contracts.md) (now C01–C13); the plan's [third resolution map](2026-09-12-composable-factory-platform.md#third-review) links the 12 new gaps to their contracts and stages, and the 22 wrong statements and 58 document defects listed here were corrected in place. Implementation proofs remain **not run**.

The text below is the review as delivered, preserved for context.

Date: 2026-09-13. Verified against `main` = `2588c9f19` in the detached read-only
worktree `.worktrees/factory-plan-main`. Method: three read-only Opus verifiers on main
(security/v4 lifecycle, CI/coverage/lanes, runtime/docs) plus one documents-only
consistency reviewer of the amended plan; every headline claim spot-checked by hand.
No product code changed, no tests run.

## 0. The root cause: the plan was verified on the wrong branch

The plan's stated baseline `93598600a` is the tip of `fix/podman-oom-victim-ordering`,
not main. Its merge-base with main is `b11955ca2`; main has 14 commits past that point
touching 6,763 files (5,136 are checked-in validation evidence under `docs/validation/`;
648 are `src/`). Both earlier reviews, and my amendment, read that stale tree. The most
consequential missed commit is #246 "isolate builds and unify release control", which
shipped an extension v4 lifecycle that overlaps much of C04/C05 and part of C02/C03/C06.

Unchanged on main and still valid: the fixed-batch executor, `suspended`-only lease CAS,
boot-only orphan sweep, iteration-only loop bound, static model override, batch-defined
`$prev`, `nested:`-only idempotency column, keyless public run route, `.pi-secret` in
`process.cwd()` outside the deny set, fail-open shell seam, JWT without `iss`/`aud`,
no tenant model, no feature flag, no Node/Python/Temporal/Svelte Flow/ELK/S3/gVisor/GPU/
Kubernetes, no self-hosted or labelled runner, no branch-protection reconciliation script,
Hub schema of nine node types, `web/src/lib/graph/` with its no-library header.

## 1. Statements in the amended plan/contracts that are wrong on main (22)

Security / lifecycle
1. C05 base-hardening #1 (in-process manifest import before checksum): FIXED on main.
   `src/extensions/loader.ts:8` and `installer.ts:7` throw `EXTENSION_V4_REQUIRED`; the
   source digest is verified before any code runs (`extension-runner/src/podman.ts:129`)
   and the manifest is discovered inside a container whose reverse-RPC denies every host
   capability (`podman.ts:190-195`).
2. C05 base-hardening #3 names `src/extensions/subprocess.ts` as a fail-open seam: dead
   for extension code on main (`release-process.ts:59` throws `NO_HOST_EXECUTION`). The
   surviving fail-open seams are the shell tool (`shell.ts:61,105`) and MCP's degraded tier.
3. C05 base-hardening #5 (`envEscapeHatch` until `ctx.secrets`): superseded. The container
   receives only `HOME`, `TMPDIR`, `BUN_INSTALL_CACHE_DIR`; credentials flow as 60-second
   opaque handles from `src/extensions/credential-broker.ts:68-88`.
4. C05 "Nothing configures cgroups or a container runtime today": cgroups v2 and rootless
   Podman are configured and probe-enforced (`podman.ts:78-86,103`). gVisor/GPU still absent.
5. C05 "one in-container stack for MCP": there are two stacks now (bwrap/netns MCP stack
   and the rootless-Podman v4 runner).
6. C05 lifecycle rows fetch/unpack, install/build, metadata-as-data are presented as new:
   all three exist (`extension-runner/src/dependencies.ts:17-143`, `podman.ts:103,149,155-196`).
7. C04 "approvals and policies are new tables; no durable digest-bound approval exists":
   `LifecycleApproval` (`src/extensions/v4/lifecycle.ts:277-347`) is durable, human-only,
   single-use (`consumed`), bound to release digest + exact grants + expected generation,
   re-validated at every use; `extension_project_decisions` + the GitHub PR broker
   (`src/extensions/project-pull-request-broker.ts:67,92,109,115,147`) implement the
   digest-bound proposal, 24 h window, atomic CAS claim, and explicit uncertain outcome.
8. C04/C09 "no HTTP idempotency-key convention exists": `POST /api/extensions/control`
   requires `idempotencyKey` with input-digest conflict detection (`v4/lifecycle.ts:73-81`);
   Hub action route honours an `Idempotency-Key` header, auto-injected client-side
   (`extension-event-receipts.ts:37`, `web/src/lib/utils/fetch-policy.ts:131`).
9. C01/C06 "the governance audit is fail-open; the factory audit is a new fail-closed path":
   `insertTransactionalAuditEntry` (`src/db/queries/audit-log.ts:12`) already aborts the
   enclosing transaction and is used by releases, runtime locks, loop events, secrets.
10. Plan section 2 "not present anywhere: a transactional outbox": `ExtensionDeliveryQueue`
    over `extension_release_deliveries` with dedup, leases, dead-letter and `outcome_unknown`
    (`src/extensions/v4/deliveries.ts:19,74,85`).
11. Plan section 2 "not present: an object-storage client / store abstraction": a
    content-addressed `BlobStore` with digest verification exists (`src/extensions/v4/blobs.ts`);
    only the S3 implementation is new.
12. Plan section 2 "not present: durable approvals": narrower than stated (see 7).
13. Plan section 9/14 "approvals notify through the existing webhook delivery daemon":
    FALSE. That daemon is inbound-only and extension-bound (`webhook-delivery-daemon.ts:151`
    `sendNotification`; rows carry a slug, never a URL). No outbound human channel of any
    kind exists (no email, Slack, push, or `notifications` table).
14. Plan section 11/14 and C11 "`/metrics` … C11 names the mechanism" reads as reuse: no
    metrics endpoint, exporter, or OpenTelemetry exists; `/api/ready` returns a boot flag.
15. Inventory row "ez-factory is a v2 in-process Hub extension": now `schemaVersion: 4`,
    served runtime subprocess under Podman with `/project`,`/data` mounts
    (`extensions/ez-factory/ezcorp.config.ts:116,254`); job page lost its actions.
16. C10 "a duplicate insert is swallowed": the unique-key conflict already raises; the
    executor's bare catch misclassifies it as `run-persistence-failed`
    (`workflow-executor.ts:927-930`). The fix is discrimination, not surfacing.
17. Review-2 summary "orphan recovery kills the whole run": only a mid-batch orphan is
    terminalized; a boundary orphan becomes resumable `suspended` (`workflow-runs.ts:808-812`).
    Plan section 2 already says "inside a batch"; the review doc does not.

CI / coverage
18. C11 lane mapping (`docker`, `evidence-soft`, "exactly five names"): main pins seven:
    `mock-gate, mock-full, fresh-setup, real-auth, production-image, evidence, external-model`
    (`src/__tests__/e2e-lanes.test.ts:30`). Docker specs → `production-image` (single-spec
    lane, asserted at :237); evidence → `evidence`; real model → `external-model` (manual).
19. C11 "`SOURCE_GLOBS` lists six patterns, excludes ai-kit/harness-client": twelve
    patterns, both included (`scripts/coverage-config.ts:109-129`). Conclusion (factory-sdk
    invisible until added) still holds.
20. C11 "each package addition needs a leg and a CI job": the #246 precedent needed neither.
    Recipe: SOURCE_GLOBS entry + wildcard/per-file threshold keys at 100 + test-find line in
    BOTH `passfail_files()` and `coverage_host_files()` (`scripts/lib/test-file-sets.sh:100,338`).
21. C11 "`.bun-version` is the single runtime pin; Node is only a coverage tool": Node 22
    is also the SDK npm-publish runtime (`release-sdk.yml:45-67`), pinned as a literal in
    two workflows.
22. C09 "the route-contract, session-scope-surface, and event-name meta-tests": the tests are
    `web/src/__tests__/route-contract.test.ts` (which also covers event names) and
    `src/__tests__/session-scope-surface.test.ts`; there is no separate event-name test.

## 2. Existing v4 subsystems the plan must reuse or reconcile (DRY)

| Plan concept | Existing on main | Verdict |
| --- | --- | --- |
| C05 isolation profile (gVisor `runsc`) | Rootless Podman + deny-by-default seccomp + live kernel probe, fail-closed; recorded as a fixed decision in `docs/extension-system-v4-plan.md:15,22` | CONFLICT — decide; if gVisor wins, migrate the shipped runner |
| C05 degraded tier "advisory refuses" | `TrustedLocalRunner` requires a digest-bound admin waiver listing each omitted control (`trusted-local.ts:14-36`) | REUSE the waiver model |
| C05 fetch/build/metadata boundaries | `dependencies.ts`, `podman.ts` | REUSE |
| C05 content lock | `.runner/recipe.json` pins image, sdk, toolchain, seccomp, limits (`podman.ts:184,251`); `manifest.lock.json` at repo root | REUSE |
| C05 package states incl. `quarantined`, security-revocation-wins | `enabled/disabled/uninstalled` + generation fence only | EXTEND: add quarantine on the generation fence |
| C04 ReleaseOperation, request hash, single-use human approval, claim = authorization point, uncertain outcome | `LifecycleApproval`, `extension_project_decisions`, PR broker | REUSE; add tenant/destination fields |
| C04 reconciliation actions (attach receipt / confirm no effect / keep uncertain) | Only "verify manually" | EXTEND |
| C04 broker is sole credential holder | `secrets-store.ts:32-36`, `credential-broker.ts`, `project-pr-broker.ts:14`, `network-broker.ts`, `host-api-broker.ts` | REUSE |
| C10 GitHub PR adapter | `project-pull-request-broker.ts` (digest-bound, human, CAS, uncertain) | REUSE; add branch-namespace + receipt fields |
| C02 outbox + dispatcher, `outcome_unknown` | `ExtensionDeliveryQueue`, `domain-event-outbox.ts`, `run_domain_event_intents` | EXTRACT the pattern; do not build a second queue |
| C02 operation recovery after restart | `lifecycle-recovery-scheduler.ts`, `ExtensionLifecycle.recover` | REUSE the pattern |
| C03 lease fencing, generations, `quarantined` locks | `extension_runtime_locks` with `fence`, `generation`, `effects`, `held\|quarantined`; `recoverLock` needs `expectedFence` + `acknowledgeUncertainEffects` | REUSE |
| C06 fail-closed audit | `insertTransactionalAuditEntry` | REUSE; no third audit path |
| C06 blob store | `BlobStore` interface (`v4/types.ts:30`), `FileBlobStore` | IMPLEMENT S3 behind the same interface |
| C06 write-pause during release transition | plpgsql `extension_release_storage_gate()` trigger | PRECEDENT |
| C09 idempotency convention | bounded key + input digest (`v4/lifecycle.ts:73-81`); `Idempotency-Key` header + receipt table | REUSE; `factory:` namespace follows it |
| C09 human-session gate on code activation with 202 + queued operation | 8 new registry entries; MCP/marketplace/import routes re-scoped to `session` | REUSE the posture verbatim |
| C10 legacy adapter periodic sweep | `host-maintenance-daemon.ts` hourly with sub-tick cadences | New sub-tick, not new infrastructure |
| C10 legacy status mapping | `workflowReleaseCanExecute` now gates execution at six executor points; mid-run loss throws | ADD a status-map row for release-authority loss |

## 3. New gaps found on main (12)

1. No out-of-band human notification channel exists; approvals/uncertain releases need one.
2. No metrics/telemetry surface; `/metrics` is greenfield.
3. No `quarantined` package state; no security-revocation-wins rule.
4. No operator reconciliation vocabulary for uncertain external effects.
5. No independent recovery archive; release bytes live in one local blob store.
6. No tenant dimension: lifecycle actor scope is `global` or `project:<id>`.
7. `browser-route-coverage` fails closed on any new scripted route
   (`scripts/browser-route-coverage-manifest.ts:12-24`): the first `/factories/+page.svelte`
   reds a required check until a lane visits it. Stage 5 must land route + lane together.
8. No real-credential lane precedent at all; `kokoro-real-model.yml` is manual dispatch,
   no secret, non-blocking. Self-hosted labelled runners are built from zero, and GitHub
   queues (24 h) rather than fails a job with no matching runner.
9. Adding a lane name is a five-file CODEOWNERS change (`e2e-lanes.test.ts:30`,
   `collect-browser-route-coverage-lane.sh:8`, `merge-browser-route-coverage.sh:14`,
   `run-browser-route-coverage.sh:57`, ci.yml consumer).
10. Adding tests to the pools reshards the 12-shard backend pool; `scripts/shard-timings.json`
    (CODEOWNERS) needs a refresh.
11. Multi-runtime coverage needs the #256 producer-tag machinery
    (`NODE_V8_COVERAGE_PRODUCER`, `BUN_CANONICAL_PRODUCERS`, coverage-config.ts:149-290),
    not just `merge-lcov.ts`.
12. `E2E (real auth + real DB)` is non-blocking in applied branch protection, and
    `Web security coverage` is enforced but undocumented; reconciliation is bidirectional.
    Also: "ez-factory" naming collides with the existing bundled extension in lanes,
    thresholds, and the `ez-factory/<operationId>` branch prefix.

## 4. Internal contradictions and holes in the amended documents (58)

Contradictions (A): host supervisor per-tenant (C02:43) vs shared (C02:45) while holding
credentials, breaking C01's "only shared component" claim; base hardening "every
installation" (decision record) vs "factory-enabled only" (C05 items 2,3); two mandatory-
service lists (plan §1 vs C09) and neither names the pool service or both name the
orchestration process; shared Temporal cluster allowed (C01) but per-tenant restore resumes
a shared persistence position (C06); 100 tenants × 10 s max barrier, staggered and never
concurrent, cannot fit 15 min; publish credentials owned by both gateway (glossary) and
release broker (C04); C11 lane table puts F01–F03 in 2b while contracts put F02 in 2c and
F03/F01-full in 2d; resolution rows 9 and 16 cite stages their proofs do not have; C11
names four lanes then says five; decision records are both "accepted inputs" and stage-1
deliverables; "only two legacy changes" vs three in C10; fairness owned by "Admission
module" (plan table) and pool scheduler (C03); pool service "shared" (glossary) vs "one per
pool / one process per installation" (C03).

Undefined terms (B): release broker (used, never defined, no topology slot, no stage);
five broker names with no mapping; "execution epoch", "release-enable epoch"; four
generation counters never reconciled; "candidate generation" is in every operation ID and
attempt token but defined nowhere and absent from the continuation snapshot; "inbox
router"; `interpreterId`/`sourceSequence`; "logical run"/interpreter/partition not in the
glossary; "trusted fetch proxy", "trusted archive writer", "validator supervisor" appear
once each; "explicit reducers" is not a construct; "C05 conformance tests" names no test
set; per-definition availability (C11) has no C09 surface; "installation checklist",
"release manifest", "content lock" have no owner; the four unenforced checks are unnamed.

Unowned work (C): base-hardening #5 has no proof; the graph-library import boundary test
has no proof or stage; `layout.ts` header/task-note update not in stage 1's list; the
stage-2 capacity experiment is in no sub-stage gate; OpenAPI generation has no stage; GitHub
branch-namespace protection "during adapter setup" is no stage and not in F10; tenant purge
has no API surface or F06 clause; alert-evaluator docs not in stage 6's list; the
deliberate-failure lane proof is stated only for 2a.

Resolution-map integrity (D): rows 4 and 23 name F09 at 2a/2b but no stage-2 gate carries
F09; rows 9 and 16 wrong stage; row 24's deliverable is a CLAUDE.md edit F11 cannot prove;
row 28 understates its proof.

Stage ordering (E): F01-full at 2d needs approvals (3), console SSE and the legacy adapter
(5); F01-token at 2a needs the provisioner (2d); stage 1's validator-in-bundle proof needs
the Node pin (2a) and Temporal test server (2b); F07 at stage 1 needs the Python validator
(2a/2c); F04 at stage 3 needs the real adapters (5); 2b's object store needs C05
conformance tests (4); the 2b lane claims F01–F03.

Glossary (F): "control plane" has two meanings (hosted provisioner vs trusted host plane);
"worker" is used for runners in five places against the glossary; gateway vs release
broker; "factory version" has three constituents in the glossary and four in C07; pool
service "shared"; "its host supervisor" binds it to the gateway; no entries for logical
run, interpreter, candidate generation, release broker, reducer.

## 5. Recommended shape of the fix

1. Re-baseline the plan on main (`2588c9f19`); state that in the header.
2. Add a "Reuse of the extension v4 lifecycle" section: cite `src/extensions/v4/README.md`
   and `docs/extension-system-v4-plan.md`; rewrite C04/C05 as extensions of v4
   (tenant fields, quarantine state, reconciliation actions, GPU/archive/supervisor) rather
   than parallel designs; rewrite C02/C03/C06/C09 to reuse the outbox, lock fencing,
   transactional audit, blob-store interface, and idempotency convention.
3. Decide isolation: adopt rootless Podman as the CPU profile (it is shipped, probe-enforced
   and fail-closed) and scope gVisor to a future GPU/`nvproxy` profile decision, or record
   why gVisor replaces Podman and what happens to the shipped runner.
4. Replace the notification and metrics sentences with owned new work.
5. Fix the 22 wrong statements, the 58 document defects, and add the 12 new gaps to the
   resolution map as a third table.
