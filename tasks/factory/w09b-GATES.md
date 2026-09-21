# W09b — assemble the four held roles, and prove a guest runs

Owner: coordinator-owned, delegated. Branch `wp/w09b-assembly` from
`wp/w09-startup` at `7af8579fd`.
Evidence directory: `/tmp/factory-platform-evidence/w09b/`.

W09 built the preflight and the four drivers and held the four roles. Its own
table said what remained was composition volume. This package is that volume,
the two host services the supervisor had nowhere to live in, the private worker
API the product had never bound, and the proof that a run submitted over public
HTTP reaches a real container.

## What changed, and why each one is not wiring

Three of the four roles now register and run. The fourth holds, for a reason
that moved again and is proved below rather than asserted.

| Role | State | The one thing |
| --- | --- | --- |
| `attempt-dispatch` | **running** | composed over W01b's driver, the W09 preflight, and `FactoryRemoteAttemptRuntime` through the host launch transport |
| `stop-settlement` | **running** | `FactoryTaskStops` over the host stop transport, the configured host public keys, and `PoolAdmissionClient.confirmStopped` |
| `usage-reconciliation` | **running** | the page driver over the uncertain-hold scan, settling only on `resolve` → `resolved` |
| `release-outcome` | held | no production reader maps a claimable operation to the approved approval or the automatic policy that `FactoryReleases.claim` requires |

### The store set, and why it is one construction

`src/factory/installation-stores.ts` builds the command authority, the journal,
the attempt queue, the inbox, the budgets, the usage settlements, the child
runs, and the projector once. That is not tidiness. `FactoryTaskStops` refuses
construction unless five collaborators agree on tenant and database, and
`FactoryTaskOutcomes` refuses unless the attempt queue holds the very same
transactional handle — so a second construction with a different journal is a
scope error waiting to happen rather than a duplicate. The journal is the
application's own instance, never a second one: a second journal built here with
a different attempt authorizer would authorize an attempt by one rule on the
HTTP path and another in the background.

The pool splits the set. `FactoryComputeAdmissions` needs an admission client
and both task stores need it, so an installation whose pool is unreachable gets
the base stores and nothing that settles compute — and the roles that need them
hold by name, which is visible on `/api/ready`.

### Package readiness is the shared runner client, not a stub

`FactoryPackagePreparations` takes a container runner and the product process
holds none for attempts. The tempting shape is a local stub whose `build`
throws. The correct one is the runner the product already holds:
`createLazyExtensionRunner` resolves the configured runner socket per call and
refuses by name when none is configured, which is the same seam the extension
lifecycle uses. Nothing on the dispatch path calls it — `assertDispatchReady` is
a database read, which is W01b's correction to W09's original hold reason and
the reason the role can run here at all.

### The physical stop carries physical coordinates and nothing else

`FactoryRemoteAttemptRuntime` stops a guest whose result is already durable.
There is no cancellation behind it, so there is no cancel command — and
`FactoryTaskStopRequest`, which W03 shaped for its cancelling caller, requires a
`cancelReference` and a `source` this caller genuinely does not have. Inventing
them is the class of substitute this package has twice been corrected for, so
the dependency is declared as the coordinates the transport actually puts on the
wire: exactly `FactoryPhysicalStopExpectation`, which is what
`createFactoryHostStopClient` reads and all it reads. A test asserts the seven
field names and their absence of a cancel reference.

**Interface question for W03.** Either make those two fields optional on
`FactoryTaskStopRequest`, or publish a physical-only client. Until then the
narrowing is one documented line in `attempt-composition.ts`.

### The supervisor grew the two services it was always meant to host

`src/factory/runner/supervisor-services.ts` puts W01b's launch service and
W03's stop service behind one mutual-TLS listener over the supervisor's single
`PodmanRunner` instance. One listener because two would be two ports, two
certificates and two readiness facts for one process; one runner because
`prepareStore` holds an exclusive store lease for the instance's life.

The guest's reverse broker **refuses by name**. No contract defines what a guest
sends to request a model stream or how a stream returns over one
request/response hop — W01b's own end-to-end sends an ad-hoc
`{ kind: "model", operation: "e2e" }` and its double answers
`{ accepted: true }`. An adapter over an undefined payload would be a stub that
answers, so a guest that calls the broker gets `factory_host_broker_unavailable`.

The supervisor's readiness gained a third fact, `hostServicesReady`. A
supervisor whose key loads and whose runner answers still cannot start a guest
if nothing is listening, and a configured host whose listener never bound now
publishes `degraded` with `host_services_unavailable` rather than `ready`.

### The private worker API, which had no production caller at all

`startFactoryPrivateService` shipped with none, and the composition root said so
in a comment: "C02 puts every other role in its own process. This one starts no
listener." That was right about the pool, the supervisor and the orchestrator,
and wrong about this one. The private service is not another process's listener,
it is how the product process is reached BY the orchestrator, and every route it
serves needs the product database C02 keeps out of the Node process. With
nothing listening, a submitted run has no path off `queued`: the `start_run`
command sits in the `temporal` destination of the outbox with no drainer.

Composing it needed two new declarations, both deployment facts no kernel can
know:

- `privateService.tokens` — the issuer, the audience, and the signing keys a
  commanding orchestrator is verified against, read per request so rotating a
  key file rotates the accepted set without a restart.
- `runnerProfiles` — one list read twice: `FactoryTaskAdmission` takes it as an
  allocation per resource class and `FactoryNativeRunnerPolicy` as the runners
  it will dispatch to. One declaration, because an admission that reserves a CPU
  second and a dispatch that spends it must not disagree about what one costs.

Four of the five stored-command effects have production implementations
(`FactoryProtectedCommandEffects` for acceptance and release,
`FactoryPartitionCommands` for both partition effects). `cancel-node` did not,
and the adapter here answers `null` for a stop no host confirmed:
`FactoryTaskStops.stop` returns an `attempt-stopped` event for an `uncertain`
stop as well, and handing that to the kernel would make a false stop durable.

### The bring-up deadlock, and the gate that did not weaken to break it

The orchestrator's readiness requires reaching this process's private service;
this process's readiness requires the orchestrator's record. With one probe
round, whichever starts second loses and the listener the other needs is already
closed. `startFactoryRuntime` now re-probes on a configured window with the
listener still bound and **admission still closed**, so the two converge instead
of being decided by start order. A configuration fault — PGlite, a missing
installation id — is never retried, because no wait fixes it. The window is
spent in whole delays rather than measured against a clock.

A second defect fell out of writing it: a refusal from
`assertFactoryBootConfiguration` left every listener the caller had already
bound still bound. It releases them now.

### C11's orphan detection bound is a declared factory setting

C10 requires an orphaned legacy run to reach a terminal or resumable state
within thirty seconds, and W13's orphan sweep is a sub-tick of a daemon whose
default wake is one hour — so on a default installation the bound is missed by
two orders of magnitude and nothing said so. The startup document now declares
the interval, `boot.ts` carries `FACTORY_ORPHAN_DETECTION_BOUND_MS` next to the
C09 required-service list, and the check compares the declaration against what
`getSweepIntervalMs` will really return. A document that states thirty seconds
over an hourly daemon is its own named failure.

### Both host process entries print why they refused

The orchestrator entry exited 1 with an empty log when its configuration was
refused, and the orchestrator package replaced every startup cause with a bare
"factory orchestrator process failed". Together they cost a full debugging round
on a failure that turned out to be one line. Both are W09's own lessons applied
to W09's own files: a failure path prints before it does anything else, and a
wrapper that catches adds context rather than removing it.

## Gates

- [x] G1: One construction of every durable store the roles share, with the
      scope guards that refuse a mismatched tenant, journal, or queue.
      CHECK: `bun test --timeout 30000 ./src/factory/installation-stores.test.ts`
      EXPECT: 6 pass / 0 fail; the journal is the application's own instance and
      the attempt queue holds the same transactional database.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/logs/unit-src-factory-installation-stores.log`
- [x] G2: `attempt-dispatch` composes from the document, and the physical stop
      carries exactly the coordinates the wire needs.
      CHECK: `bun test --timeout 60000 ./src/factory/attempt-composition.test.ts`
      EXPECT: 14 pass / 0 fail; a minted token verifies back to its own attempt
      and its own request digest; the stop request has seven keys and no cancel
      reference; a composed driver claims from a real queue and reports `idle`.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/logs/unit-src-factory-attempt-composition.log`
- [x] G3: Both settlement roles compose over one `FactoryTaskStops`, and neither
      composes without the pool, the endpoint, and a configured host key.
      CHECK: `bun test --timeout 60000 ./src/factory/dispatch-composition.test.ts`
      EXPECT: 23 pass / 0 fail; `factory_stop_transport_missing` and
      `factory_stop_host_keys_missing` are named refusals.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/logs/unit-src-factory-dispatch-composition.log`
- [x] G4: The supervisor hosts both host routes over one runner and one key, and
      the guest broker refuses by name.
      CHECK: `bun test --timeout 60000 ./src/factory/runner/supervisor-services.test.ts`
      EXPECT: 17 pass / 0 fail; a real stop crosses the router and comes back
      signed; an unconfirmed stop raises instead of being signed; a guest this
      host ran to a result is confirmed stopped without the runner being asked
      to prove an absence it can no longer speak to.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/logs/unit-src-factory-runner-supervisor-services.log`
- [x] G5: The supervisor binds its services once after the first good probe,
      publishes `hostServicesReady`, and releases the listener before it says
      `stopped`.
      CHECK: `bun test --timeout 60000 ./src/factory/runner/supervisor-process.test.ts`
      EXPECT: 33 pass / 0 fail; a configured host whose listener never bound
      reads `degraded / host_services_unavailable`, not `ready`.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/logs/unit-src-factory-runner-supervisor-process.log`
- [x] G6: The private service composes, and every refusal is named.
      CHECK: `bun test --timeout 60000 ./src/factory/private-service-composition.test.ts`
      EXPECT: 14 pass / 0 fail; `cancel-node` answers `null` for an uncertain
      stop and the event only for a confirmed one.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/logs/unit-src-factory-private-service-composition.log`
- [x] G7: The readiness retry converges a distributed bring-up without opening
      admission one moment earlier.
      CHECK: `bun test --timeout 60000 ./src/factory/runtime-composition.test.ts`
      EXPECT: 28 pass / 0 fail; admission is closed and the listener bound while
      the window runs; a configuration fault is never retried.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/logs/unit-src-factory-runtime-composition.log`
- [x] G8: The three assembled roles register through the real installation path,
      and each absence holds its role by name.
      CHECK: `bun test --timeout 60000 ./src/factory/installation-startup.test.ts`
      EXPECT: 39 pass / 0 fail; registered plus held equals the role set;
      removing `hostLaunch`, `hostStopKeys`, the attempt token secret, or the
      pool client each holds exactly the roles that need it.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/logs/unit-src-factory-installation-startup.log`
- [x] G9: C11's detection bound is a declared setting checked against the daemon
      that will really honour it.
      CHECK: `bun test --timeout 60000 ./src/__tests__/factory-boot.test.ts`
      EXPECT: 24 pass / 0 fail; an hourly sweep is
      `factory-orphan-sweep-too-slow`; a declaration the daemon will not honour
      is `factory-orphan-sweep-mismatch`.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/logs/unit-src---tests--factory-boot.log`
- [x] G10: The real Node orchestrator reaches `ready` against a real Temporal
      server without any relaxation of its mutual-TLS requirement.
      CHECK: `bash /tmp/w09b-probe/orch/run-probe.sh`
      EXPECT: `lifecycle: "ready"`, `workerPolling: true`, `dispatcherLive: true`.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/receipts/orchestrator-mtls-readiness.json`
- [x] G10b: The three assembled roles RUN in the real started application, over
      real PostgreSQL, real S3, the real pool, the real host supervisor, the real
      Node orchestrator and a real Temporal server, and `/api/ready` says so.
      CHECK: `GET /api/ready` during
      `flock /tmp/ezcorp-validation-heavy.lock timeout 1200 bash /tmp/factory-platform-evidence/w09b/repro/one-run.sh`
      EXPECT: `running` carries `attempt-dispatch`, `stop-settlement` and
      `usage-reconciliation`; `held` carries only `release-outcome` and
      `notification-send`; the supervisor publishes `hostServicesReady: true`;
      the orchestrator publishes `ready`; the guest package builds and prepares
      for real.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/receipts/roles-running.json`
- [x] G11: A durable run submitted over public HTTP executes a real guest in the
      supervisor's container runner, reaches a terminal projected status,
      survives restart, and shuts down with no survivors — three consecutive
      clean passes, each on a fresh product database.
      CHECK: `flock /tmp/ezcorp-validation-heavy.lock timeout 5400 bash
      /tmp/factory-platform-evidence/w09b/repro/rebuild-and-run-three.sh`
      EXPECT: three runs, each `outcome: "passed"`, `recordFresh: true`, exit 0.
      MEASURED at `ca101ff19`: three passes, `recordFresh: true` and exit 0 on
      each, `["queued","running","failed"]` reaching terminal at poll 6, the
      restarted server reading the same run back as `failed`, shutdown exit 0
      with zero survivors and the port refused. Eight roles running and two held
      on every pass. Record digests
      `601ea1a1…`, `c4577e7f…`, `f0b6da69…`, each verified against its receipt.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/full-stack-run-{1,2,3}.json`
- [x] G12: The harness records its own failures rather than crashing on them.
      CHECK: `flock /tmp/ezcorp-validation-heavy.lock timeout 1200 bash
      /tmp/factory-platform-evidence/w09b/repro/negative-control.sh`
      EXPECT: exit 1, `outcome: "failed"` with the cause named, every child's log
      kept, no supervisor left behind.
      MEASURED at `ca101ff19`: exit 1, `failure: "the server never reported
      ready"`, seven child logs kept, supervisor processes before 0 and after 0,
      record digest `34afc222…`.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/negative-control.json`
- [x] G13: The static gates, each with its own exit code.
      CHECK: `bash /tmp/factory-platform-evidence/w09b/repro/static-gates.sh`
      EXPECT: typecheck, lint, boundaries, gate-integrity and the PostgreSQL
      suite registration all exit 0.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/receipts/{typecheck,lint,boundaries,gate-integrity,postgres-suite-registration}.json`
- [x] G15: W13's `FactoryLegacyEngine` over the real executor, with `lookup`
      provably unable to create a run.
      CHECK: `bun test --timeout 60000 ./src/factory/legacy-engine.test.ts`
      EXPECT: 11 pass / 0 fail; `start` returns at the durable-row boundary while
      the engine is still running; a start that never confirmed a row raises
      `factory_legacy_engine_unconfirmed` instead of naming one; a lookup that
      missed leaves the `workflow_runs` row count unchanged.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/logs/unit-src-factory-legacy-engine.log`
- [x] G16: A retried uncertain stop reports the reason this pass learned.
      CHECK: `bun test --timeout 60000 ./src/__tests__/factory-task-stops.test.ts`
      EXPECT: 18 pass / 0 fail; two failing passes share one sealed event and
      carry two different causes.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/logs/unit-src---tests--factory-task-stops.log`
- [ ] G14: Every new source file at 100% line coverage with its own threshold
      key, and both `BASE_REF=integ/w00` gates green over this package's own
      merged LCOV.
      CHECK: `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`
      EXPECT: PASSED for both.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/receipts/coverage-gates.json`

## What the first full runs measured, including their faults

The roles were proved running before the run reached a guest, and both faults
that stopped it were the harness's rather than the product's. Both are recorded
because a proof that hides its own false starts teaches nothing.

| Run | What it reached | What stopped it |
| --- | --- | --- |
| 1 | shared stores, guest build | the harness's key-wrap store handed back base64 where `InstallationDataKey.loadOrCreate` re-reads bytes |
| 2 | pool, supervisor, Temporal | the built web server predated the C11 config field, so the document read as invalid — "rebuild before believing a receipt", again |
| 3 | every process `ready`, all three roles running, a real package built and prepared, the run accepted and projected `queued` → `running` | the pool answered HTTP 401 to every compute call: this harness keyed the pool's tenant identity by tenant id, and `authorizePoolRequest` looks it up by the client certificate's common name |

The third is the interesting one. The composition was right, the roles ran, and
the role that could not do its work said so on every pass — which is exactly the
behaviour the report-and-step-over shape exists to produce.

## What a passing run actually proves, including its terminal status

The run ends `failed`, and that is the correct end for this guest rather than a
shortfall. The guest returns the canonical `cancelled` runner result — the one
member of the union that needs no staged output artifact. `FactoryTaskOutcomes`
maps a cancelled result to a `node-failed` event with `error:
"RUNNER_CANCELLED"`, the kernel stops the attempt with `cancel-node`, and with
no failure handler on the node `failNode` begins stopping and `finish` issues
`fail-run`. The kernel's own command trail on a passing run reads:

```
run:start-timer:1  work:request-admission:2  work:start-timer:3
work:dispatch-node:4  work:cancel-node:5  run:fail-run:6
```

So the proof exercises the whole path — admission against the real pool,
dispatch through the preflight and the remote runtime, a real guest in a real
container, a durable terminal result, a physically confirmed stop signed by the
host and settled with the pool, a settled budget hold, and a projected terminal
status — and the run's verdict is the verdict that path produces.

### Four faults this run found that nothing else would have

Each passed typecheck, lint, and its own unit tests, and each cost a full
proof cycle.

1. **A guest that returned could never be confirmed stopped.**
   `factoryRunnerSandboxControl.present` reads `unknown` as PRESENT, which is
   right for a worker this host never had and wrong for one it just ran to a
   result and closed. Every normal finish raised `sandbox_stop_unconfirmed`.
   Fixed by having the router carry one fact from its launch half to its stop
   half: the workers this host itself finished.

2. **The pool was never told the process group was gone.** C03 releases a
   host's capacity only on a trusted supervisor's word; the product's own
   confirmation READS the ledger and fails closed until then. Nothing made that
   call, so every signed receipt was refused with HTTP 409 and the run sat in
   `stopping` forever. Fixed by `supervisor-pool-client.ts` and a router that
   presents the receipt before answering the caller.

3. **A CPU host's supervisor could not be declared to the pool.** The pool
   config required a supervisor's `hostIds` to be GPU hosts, and the ledger
   records a host only for a whole-host allocation — so a CPU-only installation
   could register no supervisor at all. Fixed with `resources.hosts`, which
   grants nothing and still refuses a typo.

4. **The guest withheld the one usage only it could report.** A terminal result
   without measured usage becomes an `unknown_held` reservation, the stop event
   is marked `uncertain`, and the kernel refuses to terminate a run with an
   uncertain attempt — while `usage-reconciliation` answers
   `no-operation-receipt` forever, because it resolves a hold from an uncertain
   JOURNAL OPERATION and a guest that called no model performed none. The guest
   now reports the zero-sum usage the contract defines. Reporting its own
   elapsed time instead was refused by `validateFactoryTerminalUsage`, which
   requires a measured terminal usage to EQUAL the sum over operations — a real
   measurement of the wrong quantity, and the runtime was right to refuse it.

Two of those four were found only because the diagnosis was made cheaper first:
a retried uncertain stop now reports the reason that pass learned instead of a
causeless durable read, and the host's own refusal code now travels with the
transport status.

## What this package did NOT deliver, and what each one needs

### `release-outcome`, and the reader that does not exist

The reason moved. `factoryReleaseProviderResolver` — the thing the old reason
named — is built, covered, and exported; `FactoryReleases.listClaimableInTransaction`
landed with W07; the project enumerator landed with W09. What no production code
produces is the CONSENT `claim` requires: an approved `factory_release_approvals`
row or an automatic `factory_release_policies` row, selected for one claimable
operation.

The grep, run in this worktree:

```
grep -rn "factory_release_approvals\|factory_release_policies" --include='*.ts' src/ | grep -v '\.test\.ts'
```

It finds writers and by-id consumers only: `assurance.ts` consumes an approval
by id (`consumeApprovalInTransaction`), `releases.ts` consumes a policy by id
(`consumePolicy`), and the one reader that returns an approval id is
`listDeliveredNotifications`, an actor-scoped console read that needs grants a
background role does not hold. `grep -rn "FactoryReleaseConsent"` finds the type,
the `claim` parameter, and test call sites — no producer.

Owners: W05 owns `assurance.ts` and the approvals table; W07 owns `releases.ts`
and the claimable scan. Supplying a consent this composition chose would
authorize a release nobody approved, which is the one substitute that cannot be
walked back. `factoryReleaseOutcomeDriver` already takes the consent as an
injected function, so the role registers the moment a reader exists.

### The GitHub release profile

`FactoryProtectedCommandEffects` takes a set of `FactoryReleaseCommandProfile`,
and this composition passes an empty one, so `requestRelease` answers
`factory_protected_effect_untrusted` — a refusal, not a false answer. A profile
pairs a definition's release-node adapter reference with the destination it
publishes to, so it is a per-installation declaration and the startup document
has no field for one. W05 owns `factorySynchronousReleaseProfile`; W07 owns the
GitHub adapter it would lift.

### W13's `FactoryLegacyEngine` adapter — delivered

This was held for one branch and is now built. W13 reached `integ/w00`, this
branch merged it, and the adapter landed in the same commit because it does not
compile without the merge.

`src/factory/legacy-engine.ts` implements W13's three-method seam over the real
engine: `runWorkflow` for `start`, `findWorkflowRunByIdempotencyKey` for
`lookup`, and `getWorkflowRunRow` plus the run's `workflow_step_runs` for
`facts`. `FactoryLegacyWorkflows` and `FactoryLegacyImports` are constructed in
the shared store set, where every other collaborator-checking class is built.

Two properties are worth a reader's time, because both are the kind that reads
as correct while being wrong:

**`start` returns at the durable-row boundary, not at the end of the run.**
`runWorkflow` awaits the whole graph. The journal needs the run's identity
before anything else observes the attempt, so the run is left unawaited and
polled through `facts`, which is what C10 describes. `onRunCreated` is the
engine's own name for that boundary — "called after a new durable row is
confirmed, or an existing keyed run is found" — and the async HTTP run route
answers its 202 from the same one.

**A start that never confirms a row refuses by name.** `runWorkflow` has
refusal paths (`run-persistence-failed`) that return a `WorkflowRun` whose row
was never written. Reading an id off one would journal a legacy run id that
names nothing, and every later `facts` call would read it as deleted — a
failure indistinguishable from an ordinary one. The adapter raises
`factory_legacy_engine_unconfirmed` instead.

**The lookup stays a read.** `findWorkflowRunByIdempotencyKey` is one `SELECT`
served by the partial unique index on `(workflow_name, idempotency_key)`.
Nothing on that path inserts. The test asserts the row count is unchanged
across a lookup that missed, because that is the property the crash path
depends on: without it the lookup would be the second start it exists to
prevent.

The merge itself had four conflicts, all resolved by keeping both sides, and is
described in the merge commit. One is worth naming here: the integration branch
unified the guest broker onto a single `FactoryGuestBroker` interface, so the
supervisor's refusal changed shape. The refusal itself still stands, and its
reason is now narrower and better: the payload IS defined now
(`FactoryGuestModelRequest`, served product-side by
`createFactoryOneHopProvider`), but the supervisor process holds no tenant
credential and no route exists from a host back to the provider that would
serve it. A deployment that grows that route supplies its own broker through
`FactoryHostServiceOptions`.

## Files touched outside W09's ownership, disclosed

| File | Change | Why |
| --- | --- | --- |
| `packages/@ezcorp/factory-orchestrator/src/process.ts` | the startup refusal carries its cause | Additive. The bare "factory orchestrator process failed" discarded the one line worth reading, and diagnosing a real failure without it cost a full round |
| `src/factory/runner/attempt-runtime.ts` | its wire half moved to a new `attempt-wire.ts`, re-exported unchanged | **Required by the boundary gate, which caught it.** Hosting W01b's launch routes and W03's stop route in the supervisor made the supervisor's runtime closure reach `drizzle-orm`, `@electric-sql/pglite` and `@aws-sdk/client-s3`, because the three values those routes need live in the same module as the durable launch store. `factory-process-boundaries.test.ts` failed with that exact list. The split is a pure move: no behaviour changed, every symbol is re-exported, and no existing importer changed. Eleven helpers that were module-private became exported to the pair, which is the one surface widening and is stated in the new file's header. Owner to review: Terra runtime (W01) |
| `scripts/coverage-thresholds.json` | four new keys at 100 | Required by the feature contract for every new source file |

`src/extensions/host-maintenance-daemon.ts` is READ (its `getSweepIntervalMs`)
and not changed: the C11 check compares the factory's declaration against the
daemon's own reader rather than reading the environment variable a second way.
