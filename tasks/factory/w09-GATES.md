# W09 complete application and service startup

Owner: coordinator-owned, delegated. Branch `wp/w09-startup` from `integ/w00` at `c22a1f846`.
Surface owned: `src/factory/application.ts`, `boot.ts`, `orchestration-process.ts`, the private-service
suite, and the startup path in `web/src/lib/server/context.ts`.
Evidence directory: `/tmp/factory-platform-evidence/w09/`.

## The rejection, and what it found

The first submission of this package was **REJECTED** by independent validation
at `4e41ffd56`, and the finding was correct: **`startFactoryRuntime` was never
invoked by any production code path.** I had built the composition root and not
called it. A flag-on installation therefore sat at
`booting / factory-services-pending` for the process lifetime — the static
placeholder `src/db/connection.ts:816` writes — and every `/api/factories/*`
route answered 503 forever.

Worse than the omission: the previous G11 table and real-server verdict
presented that 503-forever as proof of fail-closed admission control, and
attributed every remaining gap to W03/W05/W07/W08/W17 while omitting this one,
which needed none of them. That was an overstatement and it is corrected below.

Two further defects fell out of fixing it, both mine:

- **Three seam-driven roles could never register.** `registerFactoryRuntimeWorkers`
  called `hold()` inside `if (!seam.present)` with no `define()` branch under any
  condition, so supplying a seam removed the hold and registered nothing: the
  role vanished from both lists. The test asserted only absence from `held`,
  which is exactly the assertion that let it through.
- **The projection driver was typed against a field that does not exist.**
  `projectPending` returns a page of visited runs; I had typed it as returning an
  `applied` count, so `applied === 0` was always false and the role would have
  spun at its batch bound forever without ever reporting progress.

## The original finding, still true

`createFactoryApplication` and `assertFactoryBootReadiness` both existed on
`integ/w00` with no production caller. The readiness gate's `availableServices`
parameter defaulted to the empty array and no code ever supplied one, so the gate
that "closes admission until real probes pass" had a gate and no probe.
`FactoryAttemptDispatcher.dispatchOne`, `FactoryComputeAdmissions.pollNext`,
`FactoryRunTransitionProjector.projectPending`, and
`FactoryReleases.deliverNextNotification` each had no production driver at all.

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
- [x] G11: The composition root is invoked by the real boot path, `/api/ready`
      reaches `ready` against real services, the registered roles run, and a
      SIGTERM stops them with no leaked process.
      CHECK: `bun /tmp/factory-platform-evidence/w09/repro/full-stack-proof.ts`
      EXPECT: pool and supervisor processes `ready`; `/api/ready` `200 ready`
      carrying the running and held role lists; `factory-runtime` torn down
      first; exit 0, no survivors, port refused.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/repro/full-stack-proof.json`
- [x] G12: A role registers when its driver exists and holds by name when it does
      not — one rule, no role in neither list.
      CHECK: `bun test --timeout 30000 ./src/factory/runtime-workers.test.ts`
      EXPECT: 15 pass / 0 fail; a supplied seam puts its role in
      `workers.names()`; registered plus held always equals the role count.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/logs/unit-runtime-workers.log`
- [x] G13: The host supervisor publishes the readiness the seventh probe reads.
      CHECK: `bun test --timeout 60000 ./src/factory/runner/supervisor-process.test.ts`
      EXPECT: 17 pass / 0 fail; `ready` only after the host key loads and the
      runner initializes; `degraded` names which fact failed; `stopped` on exit.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/logs/unit-supervisor-process.log`
- [ ] G14: A durable run through public HTTP that executes a guest, records and
      projects its outcome, and survives restart.
      CHECK: waits on the packages in "What waits, and on whom".
      EXPECT: open. The attempt dispatcher is the missing half and it is W09's
      own, not another package's — see the entry below.
      EVIDENCE: none yet.

## Proved through the real server

Receipt: `/tmp/factory-platform-evidence/w09/repro/full-stack-proof.json`,
harness `repro/full-stack-proof.ts`, log `logs/full-stack-proof.log`.

Real processes in this run: the shared PostgreSQL proof container, the local S3
services (ordinary and archive), **the real pool admission process**
(`src/factory/pool/process.ts`, real mTLS, real RS256 tokens, its own real
database), **the real host supervisor process**
(`src/factory/runner/supervisor-process.ts`, real host key, real container
runner probe), a real mTLS listener on the gateway port, and the built
SvelteKit server.

**One simulated input, and it is the only one.** The orchestration/temporal
readiness record is written by the production writer from the harness rather than
by a live Node orchestrator. The pinned Temporal test server serves plaintext,
and `FactoryOrchestratorProcessConfig` requires mTLS material to Temporal because
C01 requires an authenticated namespace. Relaxing that to produce a green light
is not acceptable, so the record is supplied and **labelled** rather than the
requirement weakened. It is recorded in the receipt's `simulatedInputs` field.

| Fact | Observed |
| --- | --- |
| Pool process readiness | `lifecycle: "ready"`, `databaseReady/schemaReady/listenerReady` all true |
| Supervisor process readiness | `lifecycle: "ready"`, `facts: { hostKeyReady: true, runnerReady: true }` |
| `GET /api/ready` | `200` `{"state":"ready"}` |
| Roles running, from `/api/ready` | `compute-admission-dispatch`, `compute-admission-poll`, `run-projection` |
| Roles held, from `/api/ready` | `attempt-dispatch` (W09), `notification-inbox-delivery` (W07/W08), `child-settlement` (W06), `release-outcome` (W07/W08), `usage-reconciliation` (W03), `notification-send` (W17), `stop-settlement` (W03) |
| Shutdown order | `factory-runtime` teardown first of fourteen, `pglite-close` last |
| SIGTERM | exit code 0, zero surviving children, port refused after stop |

Three things follow that could not be said before. The composition root is
invoked by the real boot path: `/api/ready` now reports `ready` with the
composition's own report, where the same build without the call reported
`booting / factory-services-pending` forever. The registered roles really run,
and that is an HTTP-observable fact rather than a log line, because readiness
carries the running and held lists. And a SIGTERM stops the roles before the
database closes, with nothing left behind.

`GET /api/factories/projects/project-1/definitions` answered `401 Setup required`
in this run, because the proof database has no administrator; the auth hook
answers before the route. That is correct auth behaviour and not a factory
verdict. The flag-off `404 factory-disabled` and the admission-closed `503` are
proved separately in `repro/real-server-factory-probe.json`.

## Other receipts

| Producer | Result |
| --- | --- |
| `src/factory/background-workers.test.ts` | 20 pass / 0 fail |
| `src/factory/startup-config.test.ts` | 14 pass / 0 fail |
| `src/factory/service-probes.test.ts` | 15 pass / 0 fail |
| `src/factory/service-readiness.test.ts` | 8 pass / 0 fail |
| `src/factory/runtime-seams.test.ts` | 7 pass / 0 fail |
| `src/factory/runtime-workers.test.ts` | 15 pass / 0 fail |
| `src/factory/runtime-composition.test.ts` | 23 pass / 0 fail |
| `src/factory/release-composition.test.ts` | 17 pass / 0 fail |
| `src/factory/installation-startup.test.ts` | 15 pass / 0 fail |
| `src/factory/runner/supervisor-process.test.ts` | 17 pass / 0 fail |
| `src/__tests__/factory-process-boundaries.test.ts` | 14 pass / 0 fail |
| `web/src/__tests__/factory-boot.server.test.ts` | 10 pass / 0 fail |
| `web/src/__tests__/context-initialization.server.test.ts` | 4 pass / 0 fail |
| `tests/postgres/factory-{boot,schema,private-service,migration-restart}` | 12 pass / 0 fail, 2745 assertions |
| `bun run typecheck`, `bun run lint` | pass; 9 pre-existing infos |
| `bun scripts/check-factory-boundaries.ts`, `bun scripts/gate-integrity.ts` | pass |

Logs and receipt JSON per producer under `/tmp/factory-platform-evidence/w09/`.

Eleven new source files, each at 100% line coverage after merge:
`background-workers.ts` 151, `startup-config.ts` 131, `service-probes.ts` 85,
`service-readiness.ts` 92, `runtime-seams.ts` 40, `runtime-workers.ts` 84,
`runtime-composition.ts` 96, `release-composition.ts` 78,
`installation-startup.ts` 112, `runner/supervisor-process.ts` 127, and
`web/src/lib/server/factory-boot.ts`.

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

The previous version of this table attributed every gap to another package. One
of them is mine, and it is the one that blocks the pass sentence:

| Step | Owner | Exact missing collaborator |
| --- | --- | --- |
| **Attempt dispatch** | **W09 (mine)** | `FactoryAttemptDispatcher` needs a `TrustedFactoryRunner` and a dispatch readiness. The only production readiness is `FactoryPackagePreparations`, whose constructor takes a container `Runner` (`build`/`collectArtifacts`) plus the package trusts and the v4 catalog. The product process holds no container runner, so the role holds there and registers unchanged in a process that does. Composing that process is the remaining work on this package. |
| Stop settlement | W03 | the bounded step that finds the next stoppable attempt and settles it against a signed physical-stop receipt |
| Usage reconciliation | W03 | the bounded step over reservations in `uncertain` that hold a cost; an unknown cost is never settled as zero |
| Release store construction | W05 | `FactoryTrustedValidatorGateway`, `FactoryReleaseFenceReader`, `FactoryCurrentCandidateResolver` — all three are `FactoryAssurance` constructor parameters with no production implementation |
| Release outcomes | W07/W08 | `FactoryDestinationReservationReader` and `FactorySenderFence` have no production implementation, and `FactoryReleases` exposes no claimable-operation scan for an outcome loop |
| Notification delivery off-host | W17 | the sender that confirms a notification left this host |
| Child settlement | W06 — **scan landed at `a558a01d8`, not yet in `integ/w00`** | `FactoryChildRuns.listSettleableInTransaction` exists on `wp/w06-remediation`. I may not consume another package's branch, so the role stays held until the coordinator integrates it. The adapter is written out below and is one call. |

Every one of these is now a `FactoryRoleDriver` seam: supplying it registers the
role and starts it, with no change to this package.

## The child-settlement handover, ready to land

W06 announced `FactoryChildRuns.listSettleableInTransaction` at `a558a01d8` on
`wp/w06-remediation`. I read that commit read-only and verified the declaration
against my seam; I did not merge it, because it is not in `integ/w00` and the
coordinator integrates.

The consumer half is landed and tested: `src/factory/role-drivers.ts`
`factoryPageDriver` is the bounded-page shape child settlement, usage
reconciliation, and release outcomes all share. On integration the role becomes
one composition in `installation-startup.ts`:

```ts
const children = new FactoryChildRuns(host.database, config.tenantId, authority, stores.runs, transitions);
const childSettlement = factoryPageDriver<FactorySettleableChild>({
  page: () => host.database.transaction((t) => children.listSettleableInTransaction(t, FACTORY_CHILD_SETTLEMENT_SCAN_LIMIT)),
  settle: (child) => children.settle(service, { projectId: child.projectId, childRunId: child.childRunId }),
  report: (child, error) => host.report("child-settlement", error),
});
```

**One consumer-side hazard W06 should know about, already handled.** The scan
orders by start instant and throws `factory_child_corrupt` rather than skipping a
binding whose sealed clock no longer matches its digest — which is right. But a
driver that abandoned the page on that throw would leave the oldest corrupt row
at the head of every later scan, and nothing behind it would ever settle: one bad
row would stop settlement for the whole installation. `factoryPageDriver` settles
each item independently, reports the failure, and steps over it, and it reports
progress only when at least one item settled, so a page that fails entirely backs
the role off instead of spinning on rows it cannot move. The residual bound is
named in that module: progress stalls only if an entire page fails, which needs
200 simultaneously unsettleable bindings, and every one is reported every pass.

## Disclosed design decisions

- **The bounded worker loop is a deliberate fork from the C13 recovery
  scheduler.** `src/extensions/lifecycle-recovery-scheduler.ts` is
  edge-triggered and coalescing and has no stop signal; these roles observe
  durable queues another process writes, so they need a continuous bounded poll
  that aborts mid-flight. Wrapping the scheduler to poll itself would give it
  the one property it was written not to have. The reasoning is in the module
  header so a reader does not have to infer it, and an edge-triggered role
  should use the shared scheduler instead.
- **The credential-free boundary rule is derived, not listed.** The load-bearing
  assertion is that the Node orchestration closure's bare specifiers contain no
  client that could hold a product credential (`@aws-sdk/*`, `drizzle-orm`,
  `@electric-sql/*`, `postgres`, `pg`, `bun`). A credential-bearing module cannot
  be reached without also reaching the client it holds the credential for, so a
  new one under an unlisted path is caught by the package it must import. The
  classifier is proved non-vacuous against `src/db/connection.ts` and
  `src/extensions/v4/blobs.ts`, which it must flag. The path list is kept as a
  redundant second reading because it names the offender directly.
- **`/api/ready` now carries the factory's role report.** Role names, their
  owning packages, and the tenant id. No endpoint, no credential, no identity
  beyond the tenant. This is what makes "the background work is live" an answer
  an operator reads rather than a claim they accept.

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

- The first composition called `assertFactoryBootReadiness(url, [], …)` before
  probing, which reported every service down before a single probe had run. Its
  own test caught it; the pre-probe call is now `assertFactoryBootConfiguration`.
- The three seam-driven roles could never register, because `hold()` had no
  `define()` counterpart. Found by independent validation, not by my tests,
  whose assertion checked only absence from the held list.
- The projection driver was typed against an `applied` field `projectPending`
  does not return, so the role would have spun at its batch bound forever. Found
  while wiring the real projector into the boot path.
- The first real-server receipt reported the old disabled reason string because
  it ran against a build made before the fix. Rebuild before believing a receipt.
