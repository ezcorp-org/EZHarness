# W09b — assemble the four held roles, and prove a guest runs

Owner: coordinator-owned, delegated. Branch `wp/w09b-assembly` from
`wp/w09-startup` at `7af8579fd`.
Evidence directory: `/tmp/factory-platform-evidence/w09b/`.

W09 built the preflight and the four drivers and held the four roles. Its own
table said what remained was composition volume. This package is that volume,
the two host services the supervisor had nowhere to live in, the private worker
API the product had never bound, and the proof that a run submitted over public
HTTP reaches a real container.

## Round 3 — where a release publishes, declared

The coordinator ruled the startup document is W09's own surface and that the
release destination belongs in it. It does now, and `release-outcome` composes
from it.

### The declaration

`src/factory/startup-config.ts` gains a `release` section, validated in the
idiom `runnerProfiles` and `hostStopKeys` already use: one shape function per
entry, because their leaves are data rather than field names.

```jsonc
"release": {
  "destinations": [
    { "name": "ordinary", "kind": "s3", "endpoint": "https://…", "bucket": "…",
      "account": "tenant-01", "prefix": "releases",
      "credentialsPath": "/run/secrets/publish.json" },
    { "name": "upstream", "kind": "github",
      "repository": "ezcorp-org/factory-platform-publication-tests",
      "tokenPath": "/run/secrets/github.token" }
  ],
  "profiles": [
    { "adapter": { "package": "…", "manifestName": "…", "version": "…",
                   "digest": "sha256:…", "export": "…" },
      "action": "factory.release.publish", "destination": "ordinary",
      "estimatedSpendMicros": 1000 }
  ]
}
```

**Every credential is a path, and no value appears in any refusal.** Each one is
read through `readPrivateBounded`, which refuses a file that is missing, not a
regular file, not owned by this process, or readable by anyone else. The error
names the destination and what is wrong with the FILE. A test asserts the access
key and the secret key never appear in the message.

**Five things are refused at boot that would otherwise refuse at the first
release**, each by name: either half of the section without the other; a
malformed destination by index and by kind (an S3 entry carrying a `tokenPath`,
a GitHub entry carrying a `bucket`); a destination name declared twice, which
would make a profile depend on declaration order; an adapter declared twice,
which `FactoryProtectedCommandEffects` refuses at construction so the document
would compose nothing rather than pick one; and a profile naming an undeclared
destination, reported as `release.profiles[0].destination` rather than as a
broken destination.

### The composition

`src/factory/release-declaration.ts` builds both halves.

**A profile names where it publishes and nothing about the payload.** `build`
is the identity on the request: it IS the accepted candidate the decision
sealed, so a profile can never publish bytes the acceptance never sealed. What
it adds is the destination and the declared cost. The definition's release node
supplies the object and may pin an `expectedVersion`; a node naming a field the
deployment owns, or restating a provider or account that disagrees with the
declaration, is refused rather than silently overridden — an author who moved a
release elsewhere must not publish into the deployment's own account.

**A GitHub provider is built per operation.** `FactoryGitHubReleaseProvider`
binds a project for the shared transport's audit and takes an `authorize` that
runs immediately before every network call. Bound to the operation, that recheck
re-reads it and refuses unless it is still `executing` at the generation the
claim took and under the same sender token, so a claim this worker has lost
cannot send and a settled release cannot be re-sent. `readToken` re-reads the
token file per call, so rotating the file rotates what the next release sends
with nothing restarted; an emptied file is an ABSENT credential rather than an
empty one, which is what the transport's `string | null` distinguishes.
`factoryGitHubReleaseOptions` is exported so both closures are tested on public
surface instead of through the provider's private options.

**S3 publishers are built once**, over `S3FactoryManifestReleaseProvider`,
sharing the scoped reader and the publication provenance the archive writer
already holds — a second reader would read members under another scope.

### The one ruling that could not be implemented as written

`FactoryReleases.claim` opens its own transaction and takes none, and
`readInTransaction` is private, so a literal single-transaction read-and-claim
is not expressible against W07's surface. The coordinator accepted the two
transactions as written, because `claim` re-derives the consent and the
destination inside its own transaction. The test that ruling asked for is
added: a consent revoked between the read and the claim fails the claim with a
typed error, exactly one claim is attempted over exactly the consent that was
read, nothing is dispatched, and the refusal reaches the report.
**`claimInTransaction` on W07's surface is a possible follow-up, not a
requirement.**

### What `S3FactoryReleaseProvider` would need

The declaration builds the manifest publisher only. Both publishers register
under the provider string `s3`, and a resolver keyed by
`operation.destination.provider` can serve one of them. If a deployment needs
the single-object byte publisher, the declaration needs a discriminator. The
design did not need one here, so none was invented. **Owner to decide: W08.**

## Round 3 C — the declared destination, proved against the live store

- [x] G17: A destination declared in the startup document reaches the real S3
      store with the credentials the declaration points at, and a wrong secret
      does not.
      CHECK: `EZCORP_FACTORY_STORAGE_SECRETS_DIR=<dir> bun
      /tmp/factory-platform-evidence/w09b/repro/s3-destination-proof.ts`
      EXPECT: `outcome: "passed"`, and nothing written to the shared store.
      MEASURED: `composeFactoryReleaseDestinations` read the real credential set
      by path through the private bounded reader and built a real
      `S3FactoryManifestReleaseProvider`; that provider issued real
      authenticated HEADs the live SeaweedFS answered, so an operation nobody
      published reads as no effect; **the same declaration with a wrong secret
      was refused by the store**, which is what makes the passing arm evidence
      that it reached the store at all rather than evidence that it did not;
      and an account nobody declared was refused `factory_release_destination_unknown`.
      Every call is a HEAD, so `wroteToStore: false` and there are no keys to
      clean up.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/receipts/s3-destination-proof.json`

**What G17 does NOT prove, and what it needs.** The full production path:
`requestRelease` creating the operation from a definition's release node, an
approval or an automatic policy written through W05's production writers, and
the running `release-outcome` role claiming and publishing it. That needs the
acceptance and provenance chain `factoryS3PublicationConformance` already
builds, plus a guest definition carrying a release node — `publish` opens a
material scope through `FactoryS3PublicationProvenance`, which is a database
read, so it cannot be proved with a fake. Recorded as pending, and it is the
one pending item that is not blocked purely on a store.

### Two operational findings this proof measured

**The 0644 credential set is not the one an installation reads — settled.**
`ordinary.json` and `archive.json` in the shared directory are mode `0644`, and
the factory's own `readPrivateBounded` refuses any file with group or other
bits. That is not a defect: those files are **SeaweedFS's server identity
config**, mounted into the container that runs as uid 1000, and they stay
`0644`. A factory installation reads its OWN per-installation credential file
at `0600`, which W16's provisioner writes (C12 step two). The proof's private
`0600` copy is therefore the right shape, and the full-stack harness already
does the same thing for the archive writer. Ruled by the coordinator; the setup
script was not changed and neither were the shared files.

**A declared prefix must lie inside the tenant's entitled root**, and that is
now enforced at parse rather than discovered at the first release.
`FACTORY_RELEASE_ENTITLED_S3_ROOT` is `ordinary`, and a prefix outside it is
refused by name. Measured against the live store: inside the root an absent
object answers `404`, outside it the same HEAD answers `403`, so a declaration
that leaves the root cannot tell absent from denied and `proveNoEffect` raises
instead of answering. A sibling root that merely starts with the same letters —
`ordinary-two` — is outside it, so the test is on the whole first segment.

**A declared prefix must stay inside the tenant's entitled root.** Measured
against the live store with the tenant's own credentials: a HEAD under
`ordinary/…` answers `404`, and the same HEAD under a sibling root answers
`403`. A declaration whose prefix leaves `ordinary/` therefore cannot tell an
absent object from a denied one, and `proveNoEffect` would raise instead of
answering. Worth stating in whatever document tells an operator how to write a
destination.

## Round 2 — the consent reader, and the coverage legs that were never run

Two things changed after the first round's gates were stamped.

**`release-outcome` consumed W07b's consent reader.** The role's held reason was
false the moment W07b landed, and it is rewritten. The driver now reads the
consent itself and claims as the run's own live initiator. It still holds — on a
collaborator further down the chain than anyone had checked — and the whole
chain is set out under "release-outcome: the consent is delivered, the
destination is not".

**G14's red receipt was measuring five files nobody had run a leg for.** The
runner that produced it ran the bun focused pool and nothing else. Five of the
files it reported as "no lcov data" were fully tested; their producing leg was
simply absent. `/tmp/factory-platform-evidence/w00/combined-integration.py`
names nine producers, and this package's changed files need six of them. The
leg set is now mirrored in `repro/coverage-legs.sh`, and the difference it makes
is set out under G14.

That audit also found a real regression the missing leg had hidden: this branch
made an attempt dispatch result carry the `cause` of a refused commit, and
`src/__tests__/helpers/factory-run-lifecycle-suite.ts` — the only suite that
asserts that result — was never run on this branch. Four of its cases were red
at `7495a7750`. Three were the unasserted `cause`; the fourth was a cascade,
because each early failure skipped the projection the next case's ordering
depends on. The assertions now name the cause, and name its absence on the two
paths that carry none.

## What changed, and why each one is not wiring

**All four roles W09 held now register and run in the real started
application.** The fourth took three rounds and its reason moved twice; both
moves are recorded below rather than quietly rewritten.

| Role | State | The one thing |
| --- | --- | --- |
| `attempt-dispatch` | **running** | composed over W01b's driver, the W09 preflight, and `FactoryRemoteAttemptRuntime` through the host launch transport |
| `stop-settlement` | **running** | `FactoryTaskStops` over the host stop transport, the configured host public keys, and `PoolAdmissionClient.confirmStopped` |
| `usage-reconciliation` | **running** | the page driver over the uncertain-hold scan, settling only on `resolve` → `resolved` |
| `release-outcome` | **running** | composed end to end from `config.release`: the consent reader, the run's live initiator, the declared providers and the declared profile set. Proved running on the real started application at `45183071f`. It holds only on an installation that declares no destination, and the reason then names the field to fill in |

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
      **NOW FOUR, measured at `45183071f`.** The coordinator ruled the startup
      document is W09's own surface, the `release` section landed, and the
      harness's document declares one S3 destination. `/api/ready` on the real
      started application reports nine roles running including
      `release-outcome`, and one held — `notification-send`, which is W17's as
      planned. All four roles W09 held now run: `attempt-dispatch`,
      `stop-settlement`, `usage-reconciliation`, `release-outcome`.
      The declaration is the whole difference, and
      `installation-startup.test.ts` proves both sides against the real startup
      path: declare a destination and the role registers and runs from the
      document alone; declare none and it holds with a reason naming the field
      to fill in.
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
      NOT REFRESHED at the final head: every shared store is down, so this
      run cannot be repeated. The measurement above stands at `ca101ff19`;
      nothing since then touched the run path. Pending command under "PENDING
      on the shared stores".
- [x] G12: The harness records its own failures rather than crashing on them.
      CHECK: `flock /tmp/ezcorp-validation-heavy.lock timeout 1200 bash
      /tmp/factory-platform-evidence/w09b/repro/negative-control.sh`
      EXPECT: exit 1, `outcome: "failed"` with the cause named, every child's log
      kept, no supervisor left behind.
      MEASURED at `ca101ff19`: exit 1, `failure: "the server never reported
      ready"`, seven child logs kept, supervisor processes before 0 and after 0,
      record digest `34afc222…`.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/negative-control.json`
      NOT REFRESHED at the final head, for the same reason as G11.
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
- [x] G14: Every new source file at 100% line coverage with its own threshold
      key, and both `BASE_REF=integ/w00` gates green over this package's own
      merged LCOV.
      CHECK: `flock /tmp/ezcorp-validation-heavy.lock timeout 5400 bash
      /tmp/factory-platform-evidence/w09b/repro/coverage-gates.sh`, which runs
      every leg, merges with
      `bun scripts/merge-lcov.ts '/tmp/factory-platform-evidence/w09b/lcov-final/*.lcov' coverage/lcov.info`,
      then `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts` and
      `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`.
      EXPECT: PASSED for both.
      MEASURED: "New-file coverage gate PASSED: 23 new source file(s) gated."
      and "Patch coverage gate PASSED: all changed executable lines covered
      (40 file(s))." No `EXCLUDES` entry was added, no threshold lowered, and
      every new executable file carries its own key at 100 in
      `scripts/coverage-thresholds.json`.
      EVIDENCE: `/tmp/factory-platform-evidence/w09b/receipts/coverage-gates.json`;
      the red receipt it replaces is kept at
      `/tmp/factory-platform-evidence/w09b/receipts/coverage-gates-red-83b3a98be.json`.

### What the red G14 receipt was actually measuring

Nine of its fourteen findings were not uncovered code. They were files whose
producing leg the runner never ran. `combined-integration.py` names nine
producers; the red receipt's runner ran one.

| Reported as | Real cause | Leg that measures it |
| --- | --- | --- |
| `src/factory/legacy-engine.ts`, `src/factory/pool/process.ts` no data | their suites were added to the leg list after the receipt was stamped | bun focused pool |
| `web/src/lib/server/factory-boot.ts`, `web/src/routes/api/factories/**` no data | the Vitest leg never ran; it is the ONLY producer that measures `web/**` | `scripts/web-vitest-coverage.sh` |
| `src/factory/orchestration-process.ts` no data | the Node orchestrator leg never ran; it names this file in its own `--test-coverage-include` | `scripts/factory-orchestrator-coverage.sh` |
| `src/factory/task-stops.ts`, `src/factory/runner/supervisor-pool-client.ts` uncovered lines | same as the first row | bun focused pool |
| `web/src/lib/server/context.ts` uncovered lines | the Vitest leg never ran | `scripts/web-vitest-coverage.sh` |
| `src/factory/attempt-dispatcher.ts` uncovered lines | `./src/__tests__/factory-run-lifecycle.test.ts` was not on the leg list, and it is the only suite that exercises the dispatcher's refused-commit path | bun focused pool |

Five findings were real, and each is a default that only production uses:
`productionMainDependencies.fail` on both process entries, the retry window's
real timer, and the private service's per-request token reader. All four are now
exported and proved directly; the reasons are in their own doc comments.

**Two legs could not run: the shared PostgreSQL proof database is down.**
`podman ps -a` reports `factory-platform-proof-postgres` as `Exited (0) 7 days
ago` and `podman port factory-platform-proof-postgres 5432` returns nothing, so
`tests/postgres/**` and `scripts/factory-pool-coverage.sh` fail at connect with
`ERR_POSTGRES_CONNECTION_CLOSED`. Nothing in this worktree restarted it —
repairing a shared store is the coordinator's. It did not block G14: both gates
pass without those two legs, because every line they would have measured is
also measured by a PGlite suite in the focused pool. It DOES block a fresh
`postgres-producers` receipt, and the one at
`/tmp/factory-platform-evidence/w09b/receipts/postgres-producers.json` now
records that failure rather than the earlier round's pass.

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

**Nothing in this section is still missing.** Round 1 held three things: the
consent reader (landed with W07b, consumed here), W13's legacy-engine adapter
(landed with the `integ/w00` merge), and the release destination (declared in
Round 3, composed, and the role runs over it). The sections below are kept as
the record of how each one moved, because the reasons changed twice and a gate
file that silently rewrites its own history teaches nothing.

What remains is PROOF, not code: the publication has not been run end to end
against a live store. See "PENDING on the shared stores".

### `release-outcome`: the consent is delivered, the destination is not

**The consent half is done.** W07b landed
`FactoryReleases.readConsentInTransaction(transaction, requester, operation)`
and it is on this branch. `factoryReleaseOutcomeDriver` no longer takes a
consent from its caller: it reads the one consent the operation already has, or
a typed reason there is none. The injected-consent parameter is gone, which
closes the hole a caller could have filled with a release nobody approved.

Three decisions this round had to make, all recorded rather than assumed:

**The requester is the run's own live initiator.** A background role holds no
authority of its own, and no production `FactoryPrincipal` exists for one — the
other background roles carry a `TrustedFactoryServiceIdentity`
(`{ subject, tenantId }`), which is not a principal and confers no grant.
Inventing `{ kind: "service", id: <certificate identity> }` would be an
authority nobody granted. The platform already answers this question:
`FactoryProtectedCommandEffects.requestRelease` prepares the operation under
`context.initiator`, the run's own initiator re-derived from the durable run
request. The driver claims as the same principal, read through
`FactoryRunLifecycle.readExecutionPlanInTransaction` — whose own comment is
"private command admission uses the exact published plan and the live
initiator". It confers nothing: `claim` re-authorizes that principal for
`factory.release` inside its own transaction, and a policy is keyed by the
principal it was created for, so a policy created for someone else simply does
not match.

**What is in one transaction, and what the frozen surface cannot express.** The
initiator and the consent are read in ONE transaction, which is W07b's recorded
answer and what stops two workers reading different consents and then
disagreeing about why a claim failed. `claim` opens its OWN transaction —
`FactoryReleases.claim(requester, projectId, operationId, consent)` takes no
transaction argument, and `readInTransaction` is private, so there is no public
in-transaction read of an operation either. A literal single-transaction
read-and-claim is therefore not expressible against W07's surface as frozen.
Forking it was refused (freeze rule: consume a surface as written, report it if
it is wrong). The property the rule protects still holds and is tested: the read
half mutates nothing, so the only mutating step is `claim`'s own transaction and
a failure between them leaves the operation untouched rather than half done.
**Interface question for W07 and the coordinator** below.

**The role still holds, on the last collaborator: there is nowhere to publish.**
`factoryReleaseProviderResolver` needs at least one `FactoryReleaseProvider`,
and no production code builds one. The grep, run in this worktree:

```
grep -rn "S3FactoryReleaseProvider\|FactoryGitHubReleaseProvider\|S3FactoryManifestReleaseProvider\|FactoryReleaseApplication" \
  --include='*.ts' src/ web/src/ packages/ | grep -v '\.test\.ts'
```

Every hit is a declaration, a type import, or a test helper. `createFactoryApplication`'s
`createReleaseOperations` hook — the one thing that would build a
`FactoryReleaseApplication` with a resolver — has no production caller either.
Each provider binds a destination: `S3FactoryReleaseProvider` and
`S3FactoryManifestReleaseProvider` refuse any `destination.account` but their
own configured one, and `FactoryGitHubReleaseProvider` takes a repository plus a
token reader. The startup document (`FACTORY_STARTUP_FIELDS`) names no release
destination at all, and adding a field the interface freeze does not name is
forbidden. Choosing one would publish to a place nobody declared, which is the
class of substitute this package has been corrected for twice.

So `FactoryInstallationStartOptions.releaseProviders` is the seam: supply a
resolver and this process composes the role over the same stores, the same
project enumerator and the same run lifecycle every other role uses. It is the
collaborator, not the finished role — `seams.releaseProviders` remains the other
half of the pair and REPLACES the composition for a host that drives the role
itself. `installation-startup.test.ts` proves both sides: the role registers and
runs with a resolver, and holds with the named reason without one.

The held reason also learned to tell its two cases apart. It used to read
`factoryReleaseSeamsPresent(collaborators.seams)`, which is never true on the
real startup path because the composition builds the release store directly
rather than through those five seams — so the provider reason could never
appear in a real run. It now reads the inbox driver, which is built from the
same `FactoryReleases` and is therefore the honest witness that the store
composed.

### The GitHub release profile — still refused, and why

`FactoryProtectedCommandEffects` takes a set of `FactoryReleaseCommandProfile`,
and this composition still passes an empty one, so `requestRelease` answers
`factory_protected_effect_untrusted` — a refusal, not a false answer.

This round was asked to replace it if W07b's gate file records how profiles
compose from pack registries. It does not: `tasks/factory/w07b-GATES.md` is
about `readConsentInTransaction` and says nothing about profiles or pack
registries. The measurement stands as W09b first recorded it. A profile pairs a
definition's release-node adapter reference with the destination it publishes
to, so it is a per-installation declaration and the startup document has no
field for one. It is the same missing declaration the provider needs, seen from
the other end: with no destination declared, there is nothing for a profile to
name and nothing for a provider to publish to. W05 owns
`factorySynchronousReleaseProfile`; W07 owns the GitHub adapter it would lift.

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
| `src/__tests__/helpers/factory-run-lifecycle-suite.ts` | three dispatch-result assertions name the `cause` this branch added, and its absence on the two paths that carry none | **Required.** This branch changed `attempt-dispatcher.ts` to carry the refused commit's cause, and this is the only suite that asserts that result. It was red at `7495a7750` and nobody had seen it, because the leg that runs it was missing from the coverage runner. No production line moved. Owner to review: Sol lifecycle (W02) |
| `packages/@ezcorp/factory-orchestrator/test/process-launcher.test.ts` | one case for the process entry's own failure reporter | Additive, and the counterpart to the `process.ts` change already disclosed above: the entry prints the cause before it sets the exit code, and nothing proved it. Owner to review: Node orchestrator (W02b) |

`src/extensions/host-maintenance-daemon.ts` is READ (its `getSweepIntervalMs`)
and not changed: the C11 check compares the factory's declaration against the
daemon's own reader rather than reading the environment variable a second way.

## PENDING on the shared stores, with the exact commands

The stores were down for Rounds 2 and most of 3, and came back during Round 3.
Measured in this worktree, receipt
`/tmp/factory-platform-evidence/w09b/receipts/shared-store-state.json`:

| Store | At `214d7251e` | At `edd04b1e3` |
| --- | --- | --- |
| PostgreSQL proof database | `Exited (0)`, no published port | **Up**, published on `127.0.0.1:46343` |
| S3 (SeaweedFS) | no container, not even an exited record | endpoints `18333` and `18334` answering; still NO container, so it runs as a host process |
| S3 secrets directory | `…8yWJyCIQ` gone | **`/run/user/1001/ezcorp-factory-storage.0yXaRPtQ`** |

Nothing here started, restarted, or reconfigured any of them, and
`EZCORP_FACTORY_STORAGE_SECRETS_DIR` was never re-pointed at a substitute. Five
of the six `tests/postgres` producers passed as soon as PostgreSQL returned; the
sixth needed the new secrets directory exported, which Round 2's stale-path fix
had deliberately left empty rather than wrong.

**The red logs are kept as evidence**, not deleted and not re-run into silence:
`/tmp/factory-platform-evidence/w09b/logs/store-down-214d7251e/*.store-down.log`
(six `tests/postgres` producers plus the postgres and pool coverage legs, each
failing at connect with `ERR_POSTGRES_CONNECTION_CLOSED`).

**What is pending, and what it does NOT block.** G14 is closed without these:
both `BASE_REF=integ/w00` gates pass over the legs that could run, because every
line the postgres and pool legs would measure is also measured by a PGlite suite
in the focused pool. What is pending is the refresh of receipts whose earlier
round ran against live stores.

| Producer | Gate | State at `edd04b1e3` |
| --- | --- | --- |
| `tests/postgres/factory-{boot,schema,private-service,migration-restart,tenant-projects,host-launch}.test.ts` | the `postgres-producers` receipt and real-PostgreSQL schema parity | **DONE**, 6 files, 29 pass, 0 fail |
| the `postgres` and `pool` coverage legs | the `legs` block of the G14 receipt | **DONE**, both exit 0 |
| `rebuild-and-run-three.sh` | G10b and G11 at the final head, and the four-running-roles answer | PENDING |
| `negative-control.sh` | G12 at the final head | PENDING |
| the release publication proof | a new gate for Round 3 C | PENDING, and it needs harness work as well as a store — see below |

**The publication proof needs more than a live store.** `rebuild-and-run-three.sh`
proves G11's real-guest run and creates no release operation. Proving that the
running role claims and publishes needs a claimable operation made through the
production path: a release node in the guest definition, and an approval or an
automatic policy written through W05's production writers. That harness work is
not done, and it is the one pending item that is not blocked purely on a store.

**The GitHub half is workable on this host**, measured rather than assumed:
`gh repo view ezcorp-org/factory-platform-publication-tests` answers
`{"isPrivate":true,…,"viewerPermission":"ADMIN"}`.
`repro/github-token-file.sh --write` materialises the token under
`/tmp/factory-platform-evidence/w09b/secrets/github.token` with `umask 077`,
mode 600, straight from `gh auth token` into the file — never echoed, never in
argv, never anywhere else. Proved end to end this round: written (41 bytes, mode
600), searched for with `grep -rlF` across the whole evidence directory with
zero hits, then deleted. The resume script writes it, exports its path, removes
it on every exit path including a signal, and ends with that same leak scan.

One command runs all four once the coordinator names the new S3 secrets
directory and confirms the PostgreSQL port. It refuses by name rather than
guessing if a store is still missing, and it assembles the database URL inside
the script so no credential reaches an argv:

```
flock /tmp/ezcorp-validation-heavy.lock timeout 7200 \
  bash /tmp/factory-platform-evidence/w09b/repro/resume-store-producers.sh \
    --secrets-dir /run/user/1001/<new-ezcorp-factory-storage-dir>
```

It verifies the stores first (`bun scripts/verify-factory-storage.ts`), then
runs `postgres-producers.sh`, `coverage-gates.sh` (the full leg set, including
the two legs that could not run, then both gates), `rebuild-and-run-three.sh`
and `negative-control.sh`, and rewrites each receipt with the head that produced
it.

**Six repro scripts had `common.md`'s S3 path hard-coded**, so a resumed run
would have exported the dead directory over the live one the coordinator
supplies. All six now read
`${EZCORP_FACTORY_STORAGE_SECRETS_DIR:-}` and let the caller win:
`coverage-legs.sh`, `postgres-producers.sh`, `negative-control.sh`,
`one-run.sh`, `run-three.sh`. `grep -rl 8yWJyCIQ repro/` is now empty, and every
script passes `bash -n`. `common.md` itself still names the dead path and needs
the new one written into it. G10b's "three running roles" answer is expected to be unchanged: the fourth
role waits on a declaration, not on a store.

## A red I attributed wrongly, and what it actually was

For one round this file said `bun run typecheck` exited 1 on 25 errors in
`packages/@ezcorp/ai-kit`, inherited from `integ/w00` and not this package's to
fix. **That was wrong.** Typecheck is green here, at 0 errors.

The evidence I offered was real and insufficient:
`git diff integ/w00 HEAD --stat -- packages/@ezcorp/ai-kit bun.lock package.json`
was empty, so the SOURCE trees were byte-identical. What differed was not in
git. This worktree's `node_modules/.bun` still held `zod@4.5.2` from before
main's dependency bump, alongside `zod@4.5.4`: Bun's isolated store keeps a
stale version after a lockfile change, and an incremental
`bun install --frozen-lockfile` does not remove it. The coordinator typechecked
staging at the same merge base with the same `@modelcontextprotocol/sdk 1.30.0`
and got 0 errors, which is the check I should have made before naming anyone.

The fix is a clean reinstall: remove `node_modules` at the root and in `web/`,
install both, rebuild the workspace packages, then typecheck. Measured here:
two zod versions before, one after; 25 errors before, 0 after.
EVIDENCE: `/tmp/factory-platform-evidence/w09b/receipts/typecheck-red-was-a-stale-store.json`.

## Round 4 is parked into W01g and W08b — settled

Both blockers below were accepted and given owners; W09b does not reattempt the
proof.

- **W01g (Terra runtime)** adds a material-staging frame set over W01e's guest
  broker: typed frames in the SDK with Bun and Python parity, a host adapter
  onto W04's `FactoryAttemptMaterials` under the attempt's OWN authority, and a
  guest SDK `begin`/`chunk`/`seal`. A sandboxed guest can then return COMPLETED
  with staged references. It reuses this package's repro harness and owns the
  three-pass COMPLETED proof. **G11 stays recorded as notProven for the
  COMPLETED path, pointing at W01g.**
- **W08b** changes `S3FactoryManifestReleaseProfile` to list through the
  accepted attempt's own authority via W04's scoped reader — no tenant-wide
  lister. After it lands, a short composition round wires the profile set from
  this package's declaration. **The empty profile set with the prepare-time
  refusal is the right state until then**, and is what this branch ships.

## Round 4 — what the completed-guest release proof needs, measured

Round 4 asks for two things on the real started application: a guest that
stages an output artifact and returns COMPLETED, and a definition whose release
node publishes to the declared S3 destination through the running role. Both
are blocked, and neither is blocked on effort. The blockers are named here with
the reading that found them, because a round that reports "hard" teaches
nothing.

### (a) A COMPLETED guest has no production staging path

`FactoryRunnerResult`'s `completed` member requires `output:
FactoryArtifactReference` and `workspaceCheckpoint: FactoryCheckpointReference`
(`packages/@ezcorp/factory-sdk/src/types.ts` ~627). The only code that produces
either is `runNativeFactoryRunner` (`src/factory/runner/native.ts`), through
`options.artifacts.output(...)` and `options.artifacts.checkpoint(...)` — the
`NativeFactoryArtifacts` seam at line 15.

Two greps decide it:

```
grep -rn "runNativeFactoryRunner" --include='*.ts' src/ packages/ extensions/
grep -rn "NativeFactoryArtifacts" --include='*.ts' src/ packages/
```

Both find the seam, its integration test, and nothing else. **`NativeFactoryArtifacts`
has no production implementation and `runNativeFactoryRunner` has no production
caller.** Nor can a sandboxed guest reach the material service itself:
`FactoryBrokerTransport` is `{ attemptToken, audience }` — a token and an
audience, no base URL and no socket — and the only frame defined over that seam
is `FactoryGuestModelRequest`. There is no staging frame.

So a guest cannot stage an artifact today by any route, and the minimal guest
returns `cancelled` because that is the one union member needing none. **This
is W01/W04's to close**: either a production `NativeFactoryArtifacts`, or a
staging frame over the guest broker.

**And a fabricated reference is not an escape**, which is the check that turns
this from a guess into a blocker. `FactoryTaskCompletions` LOADS the artifact
back:

```
src/factory/task-completions.ts:85
  const loaded = await this.artifacts.loadInTransaction(transaction, reference,
    { objectId: result.output.artifactId, digest: result.output.digest,
      encodedBytes: result.output.encodedBytes }, ["candidate_output"]);
```

The bytes must exist in W04's store under this attempt's scope, at that digest
and that length, as a `candidate_output`. A guest that returned a well-formed
reference to bytes it never staged fails there — correctly. So the two options
are: stage for real, which no route allows, or fabricate, which the platform
catches and which this package has been corrected for twice. Blocked, and the
right kind of blocked.

This was VERIFIED rather than inferred, because the previous round's
"inherited" typecheck attribution was wrong and grep evidence alone had already
been enough to convince me once.

### (b) The release profile has no buildable collaborator

Recorded above under the profile correction: `S3FactoryManifestReleaseProfile`
needs `Pick<FactoryMaterialService, "list">`, and the only implementation,
`FactoryAttemptMaterials`, is bound to ONE attempt's authority
(`assertOwnScopeOnly` plus `authorizeMaterialReadInTransaction`). A release
profile resolves for whichever attempt the decision names, so one instance
cannot serve it. **W04 owns the material service; W08 owns the profile.**

(b) is downstream of (a) in any case: with no staged materials there is nothing
for the profile to list.

### What Round 4 DID deliver

The correction above, which is the part that was wrong rather than missing: the
declaration no longer composes an invented profile. The provider half still
composes, which is why `release-outcome` runs.

## W08's second S3 destination kind — settled

The declared `s3` destination kind maps to W08's manifest publisher
(`S3FactoryManifestReleaseProvider`) only; `S3FactoryReleaseProvider` stays
reachable only through tests until a later package names a second S3
destination kind. Ruled by the coordinator; no discriminator was added.

## Interface questions

**1. For W07 — `claim` cannot join a caller's transaction, so read-and-claim
cannot be one transaction.** W07b's recorded answer says the consumer "reads
consent inside the same transaction as `listClaimableInTransaction`, and claims
in that transaction". The first half is delivered. The second is not
expressible: `FactoryReleases.claim(requester, projectId, operationId, consent)`
opens `this.database.transaction` itself and takes no transaction argument, and
`readInTransaction` is private, so there is no public in-transaction read of an
operation to pair with the consent read either. Forking the surface was refused.
The property the rule protects holds and is tested — the read half mutates
nothing, so `claim`'s own transaction is the only mutating step and a failure
between them leaves the operation untouched. If the literal single transaction
is wanted, W07 would publish `claimInTransaction(transaction, ...)` plus an
in-transaction operation read, with `claim` delegating to it unchanged.

**2. For the coordinator — the release destination is undeclared, and three
things wait on it.** The provider resolver, the release command profile, and
therefore the `release-outcome` role all need one per-installation declaration
that the startup document does not have: where a release publishes, under which
account, with which credentials. The freeze forbids adding the field here. This
is the single remaining blocker for a fourth running role, and it is one
decision rather than three.

**3. For the coordinator — `common.md` is wrong in two places, measured.**
The stores came back during Round 3, and the document that tells a worker how to
reach them did not.

- The S3 secrets directory is now `/run/user/1001/ezcorp-factory-storage.0yXaRPtQ`.
  `common.md` still names `…8yWJyCIQ`, which no longer exists.
- `common.md` points at `bun scripts/verify-factory-storage.ts` as the readiness
  check. Despite its name it RESTARTS the local SeaweedFS as part of its
  durability check, which is coordinator-only work. I ran it before reading it;
  it failed immediately because it shells out to `docker` on a podman host, so
  no store state changed — verified before and after, no SeaweedFS container
  exists either way and PostgreSQL stayed up. It is removed from this package's
  resume path and replaced with a read-only TCP probe of ports 18333 and 18334.
  A worker who is told a store is coordinator-only should not be pointed at a
  script that restarts one.
