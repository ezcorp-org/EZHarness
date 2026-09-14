# W09 complete application and service startup

Owner: coordinator-owned, delegated. Branch `wp/w09-startup` from `integ/w00` at `c22a1f846`.
Surface owned: `src/factory/application.ts`, `boot.ts`, `orchestration-process.ts`, the private-service
suite, and the startup path in `web/src/lib/server/context.ts`.
Evidence directory: `/tmp/factory-platform-evidence/w09/`.

## The rejections, and what they found

This package was rejected twice and both findings were correct. The first, at
`4e41ffd56`, was that the composition root had no production caller. The second,
at `599ea6ca4`, was that the host supervisor's container-runner probe was not
safe to repeat, so the three passing runs I had shown could not be reproduced
independently — that one is answered in "Three rounds of getting this wrong"
below, with a test against the real runner.

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

## The integration merge, and what it changed here

`integ/w00` is merged into this branch twice: `1d3edf5b0` (W03, W02, W05, W08,
W06, W07) and then `2377caaa4`, which landed W03's work-list scans while this
package was finishing — the two scans an earlier version of this file reported
as the blockers for `stop-settlement` and `usage-reconciliation`. Neither merge
conflicted in source. Three files conflicted and all three are append-only note or table files,
resolved as unions: every coverage threshold key from both sides, every lessons
section from both sides, every work-package note from both sides. **No source
file conflicted** — this branch and the integration touch disjoint source, which
the file list confirms: this branch changes nothing under `packages/`.
`factory-sdk`, `factory-transport`, and `factory-orchestrator` were rebuilt and
the whole typecheck, including the locked Python distribution, is green.

### Which roles run now, and what each held one is still missing

Two roles changed from held to running. The rest hold, and the reason each one
holds is now the ONE thing that is missing rather than a description of the
collaborators that do exist — a wrong reason is worse than no reason, because it
sends the reader to the wrong package.

| Role | State | The one thing |
| --- | --- | --- |
| `compute-admission-dispatch` | running | — |
| `compute-admission-poll` | running | — |
| `run-projection` | running | — |
| **`child-settlement`** | **running (new)** | composed here from W06's `listSettleableInTransaction` and W06's `settle` through the shared page driver |
| `attempt-dispatch` | held | the process that holds a container runner. Not a wiring change: see below |
| `stop-settlement` | held | the scan landed in `2377caaa4`. `FactoryTaskStops` still needs a pool stop acknowledger (`confirmStopped`) and the host public keys; neither exists |
| `usage-reconciliation` | held | the scan landed in `2377caaa4`. A listed hold carries no attempt, operation, provider receipt digest, or measured usage, and `reconcile` needs all four |
| `release-outcome` | held | **a project enumerator.** `FactoryReleases.listClaimableInTransaction` landed and is per project; nothing lists a tenant's projects |
| `notification-inbox-delivery` | held | the same project enumerator. The collaborator is `FactoryNotificationDelivery.deliverNext(projectId)`, also per project |
| `notification-send` | held | W17, as planned. Its seam refuses |

The `grep` behind that table, at the second merge: the `async
list*InTransaction` scans in `src/factory/` are now `child-runs.ts`,
`releases.ts`, `budgets.ts`, and `task-stops.ts` — four, where there were two —
and `factory_projects` is still written by
`FactoryRecords.bindProjectInTransaction` and read by nothing.

**A correction to my own interface.** `FactoryNotificationInboxDriver` declared
`deliverNextAcrossProjects`, which no production object implements — the same
shape of defect as the `applied` field the second review found. Its header now
states that plainly instead of implying a producer.

### The composition-owned release fence reader

`FactoryAssurance` takes a `FactoryReleaseFenceReader`, no package ships one,
and the interface's own comment says why: the record is "returned only by the
composition-owned reader after it takes project, installation, run, and
lifecycle locks". Every implementation in the tree before this one is a test
double. It is now `src/factory/release-fence.ts`, and it adds no query:
`FactoryRunLifecycle.authorizeRunInTransaction` already takes exactly those four
locks and returns the epochs, deadline, and status a fence carries. A run the
lifecycle refuses raises the lifecycle's own typed error rather than a fence
this file assembled from a second read of a table it does not own.

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
      reaches `ready` against real services, the registered roles run, the
      supervisor keeps probing safely after that, and a SIGTERM stops everything
      with no leaked process.
      CHECK: `flock /tmp/ezcorp-validation-heavy.lock timeout 2400 bash
      /tmp/factory-platform-evidence/w09/repro/run-three.sh`
      EXPECT: three runs, each `outcome: "passed"`, `recordFresh: true`, exit 0;
      pool and supervisor processes `ready`; `/api/ready` `200 ready` carrying
      the running and held role lists; five consecutive `ready` supervisor
      heartbeats holding exactly one `flock` lease child throughout; `/api/ready`
      still `200` after them; `factory-runtime` torn down second of fourteen; no
      survivors, port refused.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/full-stack-run-{1,2,3}.json`
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
- [~] G14: A durable run through public HTTP that executes a guest, records and
      projects its outcome, and survives restart. **Three of the five clauses
      are proved; two are not, and the proof says so in its own record.**
      CHECK: `flock /tmp/ezcorp-validation-heavy.lock timeout 2400 bash
      /tmp/factory-platform-evidence/w09/repro/run-three.sh`
      EXPECT: the run is started through the product's own HTTP with the session
      the setup route issues (`202`), read back durably (`200 queued`), and
      survives a full server restart with the same id and status against the
      same database. NOT proved: the guest never executes, because
      `attempt-dispatch` has no driver in the product process (W09.14), and with
      no dispatched attempt there is no terminal outcome to project.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/full-stack-run-{1,2,3}.json`,
      fields `durableRun` and `notProven`.
- [x] G15: The proof harness records its own failures instead of crashing on
      them. A proof that leaves nothing to read is worse than one that fails.
      CHECK: `flock /tmp/ezcorp-validation-heavy.lock timeout 1800 bash
      /tmp/factory-platform-evidence/w09/repro/negative-control.sh`
      EXPECT: a run pointed at a database that is not there exits 1, writes
      `outcome: "failed"` with the cause named, keeps the logs of all four
      children and the readiness the pool and supervisor did reach, and leaves no
      supervisor process behind.
      EVIDENCE: `/tmp/factory-platform-evidence/w09/negative-control.json`

## Proved through the real server

**Three consecutive independent runs, each its own receipt.** Driver
`repro/run-three.sh` under `flock /tmp/ezcorp-validation-heavy.lock` with a
`timeout`; receipts `full-stack-run-1.json`, `-2`, `-3`, records
`repro/full-stack-run-{1,2,3}.json`, logs `logs/full-stack-run-{1,2,3}.log`.
Independent means a fresh private root, fresh certificates, a fresh pool
database, and freshly started pool, supervisor, and web processes each time.

All three at this branch's tip, against a web build made there. Every receipt
under the evidence directory carries its own `producingCommit`; they were
produced by one sweep, `repro/final-sweep.sh`, run after the last commit rather
than gathered across several.

| Run | `/api/ready` | Ready beats, lease children | Run start | Read back | After restart | Exit | Survivors | Record fresh |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `200 ready` | 5 ready, 1 lease | `202` | `200 queued` | `ready`, same run, `queued` | 0 | none | yes |
| 2 | `200 ready` | 5 ready, 1 lease | `202` | `200 queued` | `ready`, same run, `queued` | 0 | none | yes |
| 3 | `200 ready` | 5 ready, 1 lease | `202` | `200 queued` | `ready`, same run, `queued` | 0 | none | yes |

Every run also reported the pool and supervisor processes `ready`,
`compute-admission-dispatch`, `compute-admission-poll`, `run-projection`, and
`child-settlement` running, and `factory-runtime` torn down second of fourteen.
A failure in any of the run-start, read-back, or restart facts now fails the
proof: they are pass criteria, not observations.

**A durable run, started through public HTTP.** The proof now walks the
product's own API with the session the setup route issues: first-run admin
setup, project creation, factory draft creation, version publish, grant read,
and `POST /api/factories/projects/:projectId/definitions/:factoryId/runs`.
Nothing reaches into the database to manufacture a principal, a project, or a
grant. The run is accepted `202`, read back `200 queued` through
`GET .../runs/:runId`, and — this is the durability claim — the server that
accepted it is stopped, a second server is started against the same database,
reaches `ready`, and answers with the same run id and the same status.

Two configuration facts the harness supplies, both of them deployment
statements rather than test shortcuts: `EZCORP_FACTORY_INTERPRETER_COMPATIBILITY`
is `factory-kernel.v1`, because the reference factory's compiled lock pins that
interpreter and the lifecycle must refuse a run whose interpreter the
installation does not declare; and `EZCORP_JWT_SECRET`/`EZCORP_ENCRYPTION_SECRET`
are fixed, because a session signed with a per-process generated secret cannot
survive the restart the proof is testing. Each run now also gets a FRESH product
database, since "a clean real application" is not one whose first-run setup
another run already completed.

**A product defect the proof found, now fixed.** Creating the project answered
`500`. `factory_projects.tenant_id` is a foreign key to
`factory_installation(tenant_id)`, and `FactoryRecords.bindInstallation` had no
production caller anywhere in the tree, so on a flag-on installation the FIRST
project a human created failed — with the offending INSERT in the server log and
nothing in the product to explain it. Every existing test seeded that row
itself, which is why only a run through public HTTP could find it.
`startFactoryInstallation` now binds it before anything touches the factory
tables, idempotently, and refuses a database already bound to another tenant
with `factory_installation_mismatch` at boot.

**What this proof does not cover, stated in the record itself.** Each run writes
a `notProven` array rather than leaving its edges to be inferred from silence:
the run stays `queued` because the `attempt-dispatch` role has no driver in the
product process, so no container is reached; and with no dispatched attempt
there is no terminal outcome for the projector to project, though the projector
itself runs. Composing the process that holds a container runner is W09.14, and
it is not a wiring change — `IsolatedFactoryAttemptRuntime` needs a launch
store, the pool client, the gateway-owned provider broker, and
`signStopReceipt`, which takes the HOST PRIVATE KEY that C01 and C02 keep out of
the product process. That is a process to compose, not a seam to fill.

**The proof no longer stops the moment the light turns green.** It holds the
supervisor and watches it publish five consecutive readiness records, counting
the `flock` lease children the supervisor process owns at each one, then re-reads
`/api/ready`. Five `ready` publications spanning eight seconds with exactly one
lease throughout is the observation the earlier runs could not make: before the
fix the second beat's probe failed `runner_store_busy`, which the supervisor
publishes as `degraded`, and every successful beat before it added a lease. A run that reaches ready once and shuts down cannot tell those apart,
which is precisely why three of them passed while the product was broken.

**The harness proves its own failure path.** `repro/negative-control.sh` sets
`W09_BREAK_PRODUCT_DATABASE`, which points the web server, and only the web
server, at a database that is not there, so the pool and supervisor still start
and there are real children to clean up. Receipt `negative-control.json`
at the same commit: exit 1, `outcome: "failed"`, `failure: "the server never
reported ready"`, the logs of all four children kept, the pool and supervisor
readiness that *was* reached recorded so the diagnostic names what worked, and no
supervisor process left running. Before the hardening this path threw ESRCH out
of `process.kill(-pid)` and wrote nothing at all.

### Three rounds of getting this wrong

The first submission showed one passing run. The second showed three, after I
decoupled the heartbeat from the probe's LATENCY — and an independent validator
still could not reproduce it, because the real fault was in the probe itself and
I had diagnosed the symptom.

`PodmanRunner.prepareStore` ends in `acquireLease()`, an exclusive
`flock --nonblock` child held for the instance's life. The probe built a NEW
runner on every call, so the second probe on the same root failed
`runner_store_busy` deterministically, and every successful one leaked a `flock`
child. A supervisor therefore degraded on its second heartbeat and leaked a
process per heartbeat before that. My three runs each started a fresh process and
sampled `/api/ready` the moment it turned green, so none of them ever observed a
second probe. Three runs of a test that cannot see the defect is not three
passes.

The fix is one runner held for the process lifetime, closed in the run's
`finally`, which makes the repeat a no-op by the runner's own memoisation and
releases the lease on stop. `src/factory/runner/supervisor-process.podman.integration.test.ts`
exercises the REAL `PodmanRunner`: three consecutive probes on one root, exactly
one `flock` child across all of them and none after `close()`, a fresh holder
able to take the store again after the first released it, and a rival holder
correctly refused with `runner_store_busy` while the first still holds it. Every
other test for this file injects a fake probe, which is why the defect survived
two reviews.

The heartbeat decoupling stands on its own merits and is unchanged: observation
and publication are separate loops, and the four intervals are stated multiples
of one heartbeat — writes every one, reader window three, probe bound four,
facts stale at five. `src/factory/runner/supervisor-process.ts` carries that
table.

The third round was the receipts rather than the product. `finish()` wrote the
record with `writeFileSync`, which the file never imported, so every run threw a
ReferenceError after its work was done, exited 1 with an empty log, and left the
PREVIOUS run's `full-stack-proof.json` on disk. `run-three.sh` copied that file,
so three receipts reported `readyStatus: 200` from a run made two hours before
the commit they named — next to an `exitCode: 1` that should have stopped me
reading them at all. Nothing about the product was wrong; the evidence was.

Three things changed so it cannot recur. The import is there. The failure path
prints the error to stderr before anything else, so an empty log can no longer be
the symptom of a crash. And the driver deletes the record before each run while
the receipt carries `recordFresh`, computed by comparing the record's own
`startedAt` and `finishedAt` against that run's window: a receipt that cannot be
shown to describe its own run now says so in its own text.

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
| Shutdown order | `background-timers`, then `factory-runtime`, then eleven more, `pglite-close` last |
| SIGTERM | exit code 0, zero surviving children, port refused after stop |

Three things follow that could not be said before. The composition root is
invoked by the real boot path: `/api/ready` now reports `ready` with the
composition's own report, where the same build without the call reported
`booting / factory-services-pending` forever. The registered roles really run,
and that is an HTTP-observable fact rather than a log line, because readiness
carries the running and held lists. And a SIGTERM stops the roles before the
database closes, with nothing left behind.

**Correction to the previous submission.** That version claimed `factory-runtime`
was "torn down first of fourteen". It is second. `hooks.server.ts` registers
`background-timers` after `ensureInitialized()` returns, so it is registered last
and, under LIFO, torn down first — by a design that predates this package. The
full observed order is `background-timers`, `factory-runtime`,
`extension-workflow-reload`, `goal-host`, `extension-delivery-runtime`,
`event-subscription-dispatcher`, `extension-contribution-reload`,
`lifecycle-dispatcher`, `extension-registry-kill-all`, `executor-destroy`,
`extension-factory-agents`, `backups`, `permission-audit-coalescer`,
`pglite-close`. Second is the position the factory wants: the host's daemons stop
before it, and every handle it holds is released well before the database closes.
The earlier claim came from a log filter that matched only `factory-runtime` and
`graceful shutdown`, so the line above it was never in the excerpt I read.

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
| `src/factory/installation-startup.test.ts` | 19 pass / 0 fail |
| `src/factory/role-drivers.test.ts` | 15 pass / 0 fail |
| `src/factory/runner/supervisor-process.test.ts` | 25 pass / 0 fail |
| `src/factory/runner/supervisor-process.podman.integration.test.ts` | 3 pass / 0 fail, real Podman |
| `src/__tests__/factory-process-boundaries.test.ts` | 14 pass / 0 fail |
| `src/__tests__/factory-boot.test.ts` | 19 pass / 0 fail |
| `src/__tests__/factory-service-routes.test.ts` | 2 pass / 0 fail, 12 assertions |
| `src/factory/release-fence.test.ts` | 8 pass / 0 fail |
| `web` Vitest: `factory-boot.server`, `context-initialization.server`, `factories.server`, `context-register-preview-bus.server`, `context-state-mediator-wiring.server` | 42 pass / 0 fail across 5 files |
| `tests/postgres/factory-{boot,schema,private-service,migration-restart}` | 12 pass / 0 fail, each file's own exit code 0 |
| neighbours: `src/__tests__/{openapi,gate-scripts,factory-shell-required,api-docs,factory-boot,tool-policy,session-scope-surface,shell-advisory-fallback,factory-service-routes}` + `web/src/__tests__/route-contract.test.ts` | 352 pass / 0 fail, ten files, each exit 0 |
| `bun run typecheck`, `bun run lint` | pass; 9 pre-existing infos |
| `bun scripts/check-factory-boundaries.ts`, `bun scripts/gate-integrity.ts` | pass |
| `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts` | PASSED, 12 new source files gated |
| `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts` | PASSED, all changed executable lines covered, 18 files |

Logs and receipt JSON per producer under `/tmp/factory-platform-evidence/w09/`.

Thirteen new source files, each at 100% line coverage after merge:
`background-workers.ts`, `startup-config.ts`, `service-probes.ts`,
`service-readiness.ts`, `runtime-seams.ts`, `runtime-workers.ts`,
`runtime-composition.ts`, `release-composition.ts`, `installation-startup.ts`,
`role-drivers.ts`, `release-fence.ts`, `runner/supervisor-process.ts`, and
`web/src/lib/server/factory-boot.ts`. The thirteenth is the release fence
reader added by the integration merge; it was twelve before it.

Every receipt under `/tmp/factory-platform-evidence/w09/` names the commit it
was produced at, and every one cited here was regenerated at the final commit
`9ccb6de7e`. The coverage legs behind `coverage/lcov.info` were regenerated too:
fourteen Bun legs plus the sanctioned `scripts/web-vitest-coverage.sh` leg,
merged with `bun scripts/merge-lcov.ts '/tmp/factory-platform-evidence/w09/lcov-final/*.lcov' coverage/lcov.info`
(1094 source files). The previous merge predated the container-runner fix, so
the two BASE_REF gates had been reading a supervisor leg that no longer matched
the source.

**What the full `bun run test:coverage` pool says, in full.** Running it found
one real defect on this branch, now fixed: `src/__tests__/factory-service-routes.test.ts`
still asserted the pre-discrepancy-10 behaviour for version publish, so my own
api-registry change was failing it, and none of my focused suites included that
file. Two other files fail in that pool and neither can be this branch's: this
branch changes nothing under `packages/`.
`packages/@ezcorp/extension-contract/src/schema.test.ts` reports the wire schema
missing seven `devices` properties the authoritative types declare, which is
W01's device-grant surface; `packages/@ezcorp/extension-runner/tests/trusted-local.test.ts`
fails with `image not known`, a container image this host does not have. The
pool also stops on `browser route coverage is required: set BROWSER_COVERAGE_RAW
and BROWSER_COVERAGE_LCOV`, which is the instrumented Playwright leg, not
something a branch supplies. That is why the coverage evidence here is the
per-leg merge common.md prescribes rather than that pool's exit code.

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

This table predates the integration merge. The current, verified version is
"What the integration still needs, in one place" below; the rows here are kept
because the attempt-dispatch row is unchanged and still mine.

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

W06's scan is at `8f1353fce` on `wp/w06-remediation`, superseding `a558a01d8`.
I read both read-only and verified the declaration against my seam; I did not
merge, because it is not in `integ/w00` and the coordinator integrates.

The consumer half is landed and tested: `src/factory/role-drivers.ts`
`factoryPageDriver` is the bounded-page shape child settlement, usage
reconciliation, and release outcomes all share. On integration the role is one
composition in `installation-startup.ts`:

```ts
const children = new FactoryChildRuns(host.database, config.tenantId, authority, stores.runs, transitions);
const childSettlement = factoryPageDriver<FactorySettleableChild>({
  // A SHORT read-only transaction, closed before settle: settle takes lockRun
  // plus the budget's root-to-leaf locks, and holding this snapshot across that
  // would risk lock ordering and pin a snapshot for the whole settlement.
  page: () => host.database.transaction((t) => children.listSettleableInTransaction(t, FACTORY_CHILD_SETTLEMENT_SCAN_LIMIT)),
  settle: (child) => children.settle(service, { projectId: child.projectId, childRunId: child.childRunId }),
  classify: factoryChildSettlementDisposition,
  report: (child, error, disposition) => host.report("child-settlement", { child, error, disposition }),
});
```

### What changed, and what I got wrong

I raised a head-of-line hazard and W06 found it was worse than I described, in a
way my mitigation could not have reached. Verification ran inside the `map` that
built the page, so one corrupt binding rejected the whole promise: the caller
received **no items at all**, not a page with one bad entry. `factoryPageDriver`
settles each item independently, but there were no items to step over. My stated
residual bound — "200 simultaneously unsettleable bindings" — was therefore
wrong by two orders of magnitude. It was one corrupt row anywhere in the first
page, stalling every child behind it permanently.

W06 moved the seal check into `settle`, where it already was, so a corrupt
binding is now reported for that child alone and the driver's behaviour is
correct against the new shape. Two consequences for this package:

- **`FactorySettleableChild` dropped `deadlineAtMs`.** An inherited clock is
  exactly what a caller must not read from a row whose seal has not been
  checked. The adapter above no longer reads one.
- **`settle` also throws `factory_budget_pending`** while a child still holds an
  uncertain budget reservation. That is a queue doing its job, not an integrity
  fault. `factoryPageDriver` now classifies: both are stepped over and both are
  reported, but the report says which, and the counts separate `deferred` from
  `failed`. An unclassified failure defaults to `fault`, so an unknown error is
  the loud one.

W06 then published the complete reachable vocabulary of `settle`
(`tasks/factory/w06-GATES.md` at `8a83dff4a`), and it caught a second error of
mine: I had `factory_child_conflict` as transient. It is a fault for this caller
specifically, because the scan already filters on terminal status, so a conflict
means the lifecycle and the binding genuinely disagree — my version would have
retried a real disagreement forever and reported it as backpressure.
`factory_budget_scope` is likewise a fault rather than contention, because
`lockFactoryScope` takes `FOR SHARE` and blocks rather than returning.

The classifier is no longer a string set in this document. It is
`factoryChildSettlementDisposition` in `installation-startup.ts`, and its test
pins all eight codes as a table, so a code that changes class fails a test
rather than quietly changing how a role behaves. It is total: it accepts `null`
without throwing, because a classifier that threw would turn one item's failure
into the whole role's failure, one layer below the driver that exists to stop
exactly that.

W06 also confirmed both questions I asked: a short read-only transaction for the
scan is the only correct shape, and no re-check of terminal status is needed
because `settle` re-reads the lifecycle itself and returns without effect when
another worker settled first.

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

## What the integration still needs, in one place

Four findings, each verified at the merge commit rather than inferred, and each
blocking a role the plan names. None of them is large; all four are somebody
else's file.

1. **Stop settlement: the scan landed, two composition inputs did not (W03).**
   `integ/w00` advanced to `2377caaa4` while this package was finishing and
   `FactoryTaskStops.listStoppableInTransaction` is exactly the scan the earlier
   version of this section asked for. It is merged here. The role still cannot
   be composed, and the reason has moved: `FactoryTaskStops` also needs a
   `FactoryPoolStopAcknowledger` — `confirmStopped` — which `PoolAdmissionClient`
   does not have (it has `request`, `status`, `acknowledgeStart`, `renew`,
   `cancel`), and a `readonly FactoryStopHostKey[]` of host PUBLIC keys to verify
   a physical-stop receipt against, for which the startup document has no field.
2. **Usage reconciliation: the scan landed, the receipt did not (W03).**
   `FactoryBudgets.listUncertainWithCostInTransaction` is merged here too. A
   listed `FactoryUncertainHold` carries `projectId`, `runId`, `reservationId`,
   `envelopeId`, `heldCostMicros`, and `uncertainty`.
   `FactoryUsageReconciler.reconcile` needs `attemptId`, `operationId`,
   `providerReceiptDigest`, and a `FactoryMeasuredUsage` — the four facts that
   make the cost knowable — and nothing maps a hold to them. This is the one gap
   a composition must NOT paper over: supplying a plausible usage here is
   precisely the "an unknown cost is never settled as zero" rule, broken.
3. **No project enumerator (owner unassigned).** This one blocks TWO roles.
   `FactoryReleases.listClaimableInTransaction` and
   `FactoryNotificationDelivery.deliverNext` are both per project, and
   `factory_projects` is written by `FactoryRecords.bindProjectInTransaction`
   and read by nothing. An installation-wide loop needs either a cross-project
   scan or a tenant project list. `FactoryRecords` looks like the right home; I
   did not add it because a second reader of another package's table is the
   duplication C13 forbids, and I refused the same shortcut in the fence reader.
4. **No GitHub async release profile (W07).** `release-github.ts` ships a
   `FactoryReleaseProvider`, not a `FactoryAsyncReleaseProfile`; the S3 side
   ships both. The coordinator's instruction named "the GitHub/S3 async release
   profiles" and only the S3 one exists.

And one that is mine: **W09.14, the process that holds the container runner.**
`FactoryAttemptDispatcher` needs a `TrustedFactoryRunner`, which in production
is `IsolatedFactoryTrustedRunner` over `IsolatedFactoryAttemptRuntime`, which
needs a launch store, the pool admission client, the gateway-owned provider
broker, and `signStopReceipt` — and that last one takes the host private key,
which C01 and C02 keep out of the product process and which the host supervisor
holds while deliberately linking no tenant store. So the dispatcher belongs to
neither existing process. That is a process to compose with its own readiness
and its own credentials, not a seam to fill, and it is the reason the pass
sentence's "executes a guest" clause is still open.

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
- The proof harness wrote its record with an unimported `writeFileSync`, so
  every run threw after its work was done, exited 1, and left the previous run's
  record on disk for the driver to copy. Three receipts therefore described a run
  older than the commit they named. Caught here, before submitting, by the
  contradiction between `exitCode: 1` and a passing body — the receipt now
  carries `recordFresh` so the contradiction cannot be silent next time.
- A test of the runner probe's close-before-probe case asserted nothing; it
  relied on a throwing loader, which proves nothing if the loader is never
  reached for some other reason. `gate-integrity.ts` found it. It now asserts
  both facts the supervisor depends on.
- `src/__tests__/factory-service-routes.test.ts` still asserted that version
  publish carries no service scope, which discrepancy 10 changed. My focused
  suites did not include that file, so only the full pool found it. It now states
  both halves of the discrepancy, the widening and the tightening.
- Two of my own evidence scripts piped each test file through `tail` inside a
  loop, so the receipt recorded `tail`'s exit code. One postgres producer was
  failing for a missing environment variable and read as green. Both scripts now
  accumulate per-file exit codes, and the log carries each one.
- `FactoryNotificationInboxDriver.deliverNextAcrossProjects` is implemented by
  nothing. I specified the shape the ROLE wanted and never checked that a
  producer existed; the collaborator that exists is per-project `deliverNext`.
  This is the same defect as the `applied` field the second review found, one
  file over, and I found it only because the integration merge made me look for
  the real producer. Before naming a collaborator in an interface, open the file
  that is supposed to implement it.
- The held-role reasons described the collaborators that DID exist rather than
  the one thing missing, so two of them sent the reader to the wrong package
  entirely: release-outcome read as "the release store cannot be composed" when
  every release collaborator had landed and the only gap was a project list.
  A reason is a pointer; a stale pointer costs more than none.
- My real-server proof reused one product database across all three runs, so
  the first run completed the first-run admin setup and the second and third
  authenticated as nobody. Every step after `auth.setup` answered 401 and the
  proof still reported `passed`, because the durable-run phase was not yet a
  pass criterion. Independence has to include the database, and a phase that
  cannot fail is not evidence.
- Giving each run its own product database silently made the NEGATIVE control
  vacuous: it had induced its failure by overriding `W09_DATABASE_URL`, which
  the harness had just stopped reading, so the control passed and proved
  nothing. It now sets an explicit fault flag that points the web server, and
  only the web server, at a dead address, so the pool and supervisor still start
  and the cleanup path is exercised with real children. A control has to be
  re-checked against the thing it controls every time that thing changes.
