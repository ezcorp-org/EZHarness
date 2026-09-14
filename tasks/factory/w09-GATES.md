# W09 complete application and service startup

Owner: coordinator-owned, delegated. Branch `wp/w09-startup` from `integ/w00` at `c22a1f846`.
Surface owned: `src/factory/application.ts`, `boot.ts`, `orchestration-process.ts`, the private-service
suite, and the startup path in `web/src/lib/server/context.ts`.
Evidence directory: `/tmp/factory-platform-evidence/w09/`.

## The finding, stated first

**Nothing in production ever composed the factory.** `createFactoryApplication` and
`assertFactoryBootReadiness` both existed on `integ/w00`, and a repository-wide search found no
production caller of either. The readiness gate's `availableServices` parameter defaulted to the
empty array and no code ever supplied one, so the gate that "closes admission until real probes
pass" had a gate and no probe. `FactoryAttemptDispatcher.dispatchOne`, `FactoryComputeAdmissions.pollNext`,
`FactoryRunTransitionProjector.projectPending`, and `FactoryReleases.deliverNextNotification` each
had no production driver at all.

W09 is therefore the composition root itself, not a rewiring of one.

## Gates

- [x] G1: The startup document names every missing dependency at once, not one per restart.
      CHECK: `bun test --timeout 30000 ./src/factory/startup-config.test.ts`
      EXPECT: 14 pass / 0 fail; `Missing: poolReadinessFilePath, keys.masterKeyId` in one error.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/logs/unit-startup-config.log`
- [x] G2: Seven real probes produce the readiness gate's input.
      CHECK: `bun test --timeout 30000 ./src/factory/service-probes.test.ts`
      EXPECT: 15 pass / 0 fail; a stale, foreign, or non-`ready` record fails by name; a store that
      silently drops a write fails with `object_storage_roundtrip_mismatch`.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/logs/unit-service-probes.log`
- [x] G3: One bounded stop-aware worker shape, reused by every role.
      CHECK: `bun test --timeout 30000 ./src/factory/background-workers.test.ts`
      EXPECT: 20 pass / 0 fail; a pass stops at the batch bound, `stop()` awaits the in-flight step,
      a failed step reports and backs off 100/200/250 to its cap, the registry stops in reverse.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/logs/unit-background-workers.log`
- [x] G4: Absent collaborators are typed seams that refuse, never stubs that answer.
      CHECK: `bun test --timeout 30000 ./src/factory/runtime-seams.test.ts`
      EXPECT: 7 pass / 0 fail; `require()` throws `factory_seam_unavailable` naming the package.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/logs/unit-runtime-seams.log`
- [x] G5: Ten roles registered or held, each held one naming its seam and owner.
      CHECK: `bun test --timeout 30000 ./src/factory/runtime-workers.test.ts`
      EXPECT: 13 pass / 0 fail; five roles drive real primitives, five are held and not registered
      as loops.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/logs/unit-runtime-workers.log`
- [x] G6: Admission opens only after every probe passes, and a failed start stops what it started.
      CHECK: `bun test --timeout 30000 ./src/factory/runtime-composition.test.ts`
      EXPECT: 23 pass / 0 fail; flag off starts no service; flag-on PGlite fails
      `factory-pglite-unsupported` before any probe runs; one failing probe leaves
      `getFactoryApplication()` null and readiness `degraded`; a lost dependency, a
      refusing queue, a re-drive, a rotated credential, and a stale readiness record
      each behave as the plan requires.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/logs/unit-runtime-composition.log`
- [x] G7: W04a's archive writer is wired as `FactoryReleases`' archive, and publication grade is a
      visible field rather than an error.
      CHECK: `bun test --timeout 30000 ./src/factory/release-composition.test.ts`
      EXPECT: 16 pass / 0 fail; `publicationGrade: false` with
      `withheldBecause` containing `deployed-independent-failure-domain` on a successful result.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/logs/unit-release-composition.log`
- [x] G8: C02's process boundaries are executable.
      CHECK: `bun test --timeout 60000 ./src/__tests__/factory-process-boundaries.test.ts`
      EXPECT: 11 pass / 0 fail; only the orchestrator package links `@temporalio/*` and declares the
      dependency; its runtime closure reaches no product database, object store, or provider
      credential; the supervisor's options carry no tenant identity or host key; an attempt token
      verifies only back to its own attempt.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/logs/unit-boundaries.log`
- [x] G9: The startup race is reproduced against the real module and fixed at its source.
      CHECK: `bunx vitest run src/__tests__/context-initialization.server.test.ts` from `web/`
      EXPECT: 4 pass / 0 fail after the fix; 3 fail / 1 pass before it.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/logs/context-race-before.log`,
      `context-race-after.log`
- [x] G10: The contract's disabled reason and C01's scopes are answered over real HTTP and in the
      route suites.
      CHECK: `bunx vitest run src/routes/api/factories/factories.server.test.ts` from `web/`;
      `bun test --timeout 30000 ./src/__tests__/session-scope-surface.test.ts ./web/src/__tests__/route-contract.test.ts`
      EXPECT: 26 pass; 13 pass; 29 pass. The flag-off answer is a 404 carrying `factory-disabled`.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/repro/real-server-factory-probe.json`
- [~] G11: A clean real application starts a durable run through public HTTP, executes a guest,
      records and projects its outcome, survives restart, and shuts down without leaked processes or
      false readiness.
      CHECK: the real-server probes below plus the packages named in "What waits".
      EXPECT: partial today. Start, restart, shutdown, readiness, and the two documented flag
      answers are proved through the real server; the durable run itself waits.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/repro/real-server-factory-probe.json`

## Proved through the real server

`bun web/build/index.js` against real PostgreSQL, three scenarios, receipt
`/tmp/factory-platform-evidence/w09/repro/real-server-factory-probe.json`
(sha256 `7d9c8efc541b19ab…`), producing commit `bfc5a6a23`:

| Scenario | `/api/ready` | `/api/factories/...` | SIGTERM | Surviving children | Port after stop |
| --- | --- | --- | --- | --- | --- |
| Flag off | `200 ready` | `404 factory-disabled` | exit 0 | none | refused |
| Flag on, nothing composed | `503 booting / factory-services-pending` | `503 factory_application_unavailable` | exit 0 | none | refused |
| Restart on the same database | `503 booting / factory-services-pending` | `503 factory_application_unavailable` | exit 0 | none | refused |

Four facts follow, each from the table rather than from code review. The
contract's `factory-disabled` reason is what a client actually receives, over
HTTP, from a build of this branch. With the flag on and nothing composed the
server never claims ready, which is admission closed rather than false
readiness. A restart on the same database answers identically. And a SIGTERM
leaves exit code 0, no surviving child process, and a refused port.

An earlier run of the same probe reported the OLD `factory_disabled` string
because it ran against a build made before the fix. That run is preserved at
`real-server-startup-probe.json`; the code was right and the evidence was stale.

## Other receipts

| Producer | Result | Receipt |
| --- | --- | --- |
| `src/factory/background-workers.test.ts` | 20 pass / 0 fail, 60 assertions | `unit-background-workers.json` |
| `src/factory/startup-config.test.ts` | 14 pass / 0 fail, 74 assertions | `unit-startup-config.json` |
| `src/factory/service-probes.test.ts` | 15 pass / 0 fail, 41 assertions | `unit-service-probes.json` |
| `src/factory/runtime-seams.test.ts` | 7 pass / 0 fail, 29 assertions | `unit-runtime-seams.json` |
| `src/factory/runtime-workers.test.ts` | 13 pass / 0 fail, 61 assertions | `unit-runtime-workers.json` |
| `src/factory/runtime-composition.test.ts` | 23 pass / 0 fail, 77 assertions | `unit-runtime-composition.json` |
| `src/factory/release-composition.test.ts` | 16 pass / 0 fail, 38 assertions | `unit-release-composition.json` |
| `src/__tests__/factory-process-boundaries.test.ts` | 11 pass / 0 fail | `unit-process-boundaries.json` |
| `web` Vitest pool, full | 591 files / 7443 tests pass | `logs/web-vitest-coverage.log` |
| `tests/postgres/factory-boot` | 1 pass / 0 fail | `logs/postgres-affected.log` |
| `tests/postgres/factory-schema` | 2 pass / 0 fail, 2620 assertions | `logs/postgres-affected.log` |
| `tests/postgres/factory-private-service` | 5 pass / 0 fail, 76 assertions | `logs/postgres-affected.log` |
| `tests/postgres/factory-migration-restart` | 4 pass / 0 fail, 48 assertions | `logs/postgres-affected.log` |
| `bun run typecheck` | passed | `gate-typecheck.json` |
| `bun run lint` | passed, 8 pre-existing infos | `gate-lint.json` |
| `bun scripts/check-factory-boundaries.ts` | passed | `gate-factory-boundaries.json` |
| `bun scripts/gate-integrity.ts` | passed | `gate-integrity.json` |
| `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts` | passed, 7 new files gated | `logs/` |
| `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts` | passed, 13 files | `logs/` |

Every new source file is at 100% line coverage: `background-workers.ts` 151/151,
`startup-config.ts` 129/129, `service-probes.ts` 76/76, `runtime-seams.ts` 39/39,
`runtime-workers.ts` 63/63, `runtime-composition.ts` 85/85,
`release-composition.ts` 78/78.

## The startup race, before and after

`web/src/lib/server/context.ts` set `initialized = true` before doing any of the
work the latch stood for. Two callers were told initialization had succeeded
when it had not: one arriving during initialization, and every one after an
attempt that failed. Both then reached `getExecutor()` and got
"Server not initialized".

| Run | Result | Receipt |
| --- | --- | --- |
| Pre-fix source at `404a490e5^` | 3 fail / 1 pass | `logs/context-race-before.log` |
| Fixed source | 4 pass / 0 fail | `logs/context-race-after.log` |

**The verdict the plan asked for.** The race is real in the module and is not
reachable over HTTP today, because all seven routes that initialize lazily call
`requireAuth` before `ensureInitialized`, and resolving a principal needs the
database that initialization opens. The eager path fails closed instead: a
server started against an unreachable database exits 1 rather than listening
(`repro/real-server-startup-probe.json`, scenario B). The fix still lands at the
source, because that distance is one `await` wide and the next public or
service-authenticated lazy caller removes it.

## What waits, and on whom

The pass sentence's middle — *starts a durable run through public HTTP, executes a guest, records
and projects its outcome* — cannot be composed today, and the reason is a missing collaborator in
every case, not missing wiring:

| Step | Blocked on | Exact missing collaborator |
| --- | --- | --- |
| Stop settlement | W03 | `FactoryPhysicalStopper`; freeze section 3 assigns its `AbortController` to this package, and the worker is registered the moment the stopper is supplied |
| Usage reconciliation | W03 | `FactoryUsageReconciler` (freeze section 4). An uncertain reservation is never settled as zero, so the role holds rather than draining |
| Release store construction | W05 | `FactoryTrustedValidatorGateway`, `FactoryReleaseFenceReader`, `FactoryCurrentCandidateResolver` — all three are `FactoryAssurance` constructor parameters with no production implementation |
| Release outcomes | W07/W08 | `FactoryDestinationReservationReader` and `FactorySenderFence` have no production implementation; and even with them, `FactoryReleases` exposes no claimable-operation scan for an outcome loop to drive |
| Release profiles | W07/W08 | `FactoryAsyncReleaseProfile.resolve` (freeze section 5); the release worker's `AbortController` is this package's and is already in place |
| Notification delivery off-host | W17 | the sender that confirms a notification left this host |
| Child settlement | W05/W06 | `FactoryChildRuns` exposes `resolve` and `settle`, both keyed by an exact child. Nothing enumerates the settleable set, so no loop can be written without inventing a lifecycle query in the composition root |

## Interface questions for the coordinator

1. **A settleable-child scan has no owner.** The plan's W09 checklist names a child-settlement
   worker, and `FactoryChildRuns` has no scan to drive one. Whose file gains
   `listSettleableInTransaction`? It reads run lifecycle state, so W06 looks right, but the freeze's
   section 12 does not assign it.
2. **A claimable-release scan has no owner.** `FactoryReleases.claim` takes an exact operation and an
   actor. A release-outcome worker needs to enumerate `pending` operations whose archive is ready
   and whose deadline has not passed. W07 owns `releases.ts`; confirm the scan lands there.
3. **Discrepancy 10 loosens one control and tightens another.** C01's table assigns version publish
   the `write` scope, so a `write`-scoped API key holding the project `factory.publish` grant can now
   publish where the route previously required a human session. That is the contract, and it is a
   real widening; the coordinator may prefer to keep the stricter behaviour and record the contract
   as wrong instead. Grant management moved the other way: the `admin` scope is now gated on the
   tenant-administrator role as well, which refuses the ordinary member that `requireSessionAuth`
   admitted.
4. **The package install/quarantine row still has no route.** C01 assigns it `admin`. W02's package
   lifecycle is not on this branch, so there is no handler to register a scope against, and
   registering an entry with no handler fails `route-contract.test.ts` in both directions. Recorded
   rather than stubbed.

## Corrections this package made to its own work

- The first composition called `assertFactoryBootReadiness(databaseUrl, [], …)` before probing, which
  reported every service as down before a single probe had run. Its own test caught it; the
  pre-probe call is now `assertFactoryBootConfiguration`, which is the half that does not need a
  probe result.
