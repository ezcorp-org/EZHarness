# Gates: W01b attempt-dispatch driver and production host launch transport

Branch `wp/w01b-attempt-dispatch`, from `integ/w00` at `1d3edf5b0`. Evidence under `/tmp/factory-platform-evidence/w01b/`.

Status: **complete.** All six gates pass. Receipts in `/tmp/factory-platform-evidence/w01b/logs/`.

## The seam W09 must call

`src/factory/runner/attempt-dispatch-driver.ts`, a composition module that adds no queue and no second state machine. Every step already existed and was never driven, which is exactly why W09 held the role by name.

```ts
import { createFactoryAttemptDispatchDriver } from "./runner/attempt-dispatch-driver";

const attempts = createFactoryAttemptDispatchDriver({
  database,                 // TransactionalDb, the same one the queue binds
  service,                  // TrustedFactoryServiceIdentity
  installationId,
  attemptTokenSecret,
  queue,                    // FactoryAttemptQueue
  completions,              // FactoryTaskCompletions
  outcomes,                 // FactoryTaskOutcomes
  readiness,                // FactoryPackagePreparations
  runtime,                  // FactoryAttemptRuntime: in-process, or the host transport
  preflight,                // lease(request) and preparedPackage(request)
  // optional: attemptTokenLifetimeSeconds, leaseMs
});

registerFactoryRuntimeWorkers({ ...collaborators, attempts });
```

`dispatchOne()` returns `FactoryAttemptDispatchResult`, whose `kind` is `"idle"` only when there was no work, which is exactly the shape `FactoryAttemptDispatchDriver` in `src/factory/runtime-workers.ts` expects. Registering it removes the `attempt-dispatch` hold with no change to W09's file.

**One correction to W09's recorded hold reason.** It says the role needs `FactoryPackagePreparations`, "which requires a container runner this process does not hold". `FactoryPackagePreparations` takes a container runner in its constructor, but `assertDispatchReady`, the only method the dispatch path calls, is a database read that never touches it. The container runner is needed by `prepare()` and by actually running a guest, not by readiness. So the product process needs a runner only for the `runtime` argument, which is the deployment choice below.

## The transport configuration W09 must compose

Two processes, one private mutual-TLS service each way, and no second transport.

### The supervisor process, which holds the container runner

```ts
import { startFactoryPrivateHttps } from "./private-https";
import { createFactoryHostLaunchRouteHandler } from "./runner/host-launch-service";
import { createFactoryHostLaunchSupervisor } from "./runner/host-launch-supervisor";

const supervisor = createFactoryHostLaunchSupervisor({
  runner,                    // PodmanRunner, the only process that holds one
  hostId,                    // must equal the lease's hostId on every intent
  broker,                    // forwards the guest's one reverse call to the product process
});

startFactoryPrivateHttps({
  tls: { key, cert, ca },    // the same server material the host stop route uses
  hostname, port,            // the host launch port; may be the host stop port, the paths do not collide
  handle: createFactoryHostLaunchRouteHandler({
    hostId,
    allowedPeers: [productCertificateSubject],   // mutual-TLS subjects allowed to drive attempts here
    supervisor,
    launchTimeoutMs,         // default 60000
    resultTimeoutMs,         // default 120000
  }),
});
```

Paths served: `POST /v1/host/launches`, `POST /v1/host/attachments`, `POST /v1/host/results`. W03's `POST /v1/host/stops` is unchanged and can be mounted on the same listener; nothing here touches it or the host signing key, because this transport signs nothing. The host key stays exactly where W03 put it: `loadFactoryHostSigningKey` reads the PEM and key-id files per signature so rotation needs no restart, and only the stop route uses it.

### The product process, which holds every durable record

```ts
import { createFactoryHostLaunchClient } from "./host-launch-client";
import { FactoryRemoteAttemptRuntime } from "./runner/remote-attempt-runtime";

const transport = await createFactoryHostLaunchClient({
  baseUrl,                   // the supervisor's private HTTPS URL
  tls: { caPath, certificatePath, privateKeyPath, serviceTokenPath },
  serverName,                // TLS server name, "localhost" in the local profile
  hostId,                    // an intent for any other host never leaves this process
});

const runtime = new FactoryRemoteAttemptRuntime({
  launches,                  // FactoryDatabaseAttemptLaunchStore on the product database
  transport,
  readiness,                 // FactoryPackagePreparations
  mintAttemptToken,          // signFactoryAttemptToken bound to the installation
  pool,                      // acknowledgeStart only
  stop,                      // W03's FactoryPhysicalStopper, so the product never signs a host fact
});
```

Then pass that `runtime` to `createFactoryAttemptDispatchDriver` above. The in-process deployment passes `IsolatedFactoryAttemptRuntime` instead and changes nothing else, which is the point of putting the deployment choice behind that one argument.

The `serviceTokenPath` file must exist and be non-empty because the shared gateway transport requires one, but these routes authorize by mutual-TLS peer identity alone, exactly as the host stop route does. Nothing in a request body names its caller.

## Gates

- [x] G1: The `attempt-dispatch` role has a driver with the shape W09 registers.
  CHECK: bun test --timeout 120000 ./src/factory/runner/attempt-dispatch-driver.test.ts
  EXPECT: exit 0; an empty queue is idle without reaching the runtime, a queued attempt is claimed and dispatched exactly once and then no longer claimable, a revoked package cancels without reaching the runtime, and an unprepared one retries.
  EVIDENCE: 4 pass / 0 fail; `src/factory/runner/attempt-dispatch-driver.ts` at 22/22 lines.

- [x] G2: Static gates on the composition.
  CHECK: bun run typecheck; bun run lint; bun scripts/check-factory-boundaries.ts; bun scripts/gate-integrity.ts
  EXPECT: all exit 0
  EVIDENCE: all four exit 0. The module reuses `FactoryAttemptDispatcher`, `FactoryAttemptQueue`, `IsolatedFactoryTrustedRunner`, and `factoryPackageDispatchDisposition` rather than reimplementing any of them, so the C13 boundary check stays green.

- [x] G3: The supervisor process serves `FactoryHostLaunchProtocol` over the private mutual-TLS service.
  CHECK: bun test --timeout 180000 ./src/factory/host-launch-transport.integration.test.ts
  EXPECT: exit 0; launch, attach, and result over real mutual TLS beside W03's unchanged signed stop
  EVIDENCE: 3 pass / 0 fail. `host-launch-service.ts` 63/63, `host-launch-supervisor.ts` 62/62, `remote-attempt-runtime.ts` 52/52, `host-launch-client.ts` 50/50, all 100%. The supervisor holds live guest handles and a container runner and nothing else: no tenant database, no journal, no host signing key. The guest's one reverse capability returns to the product process under the attempt's own short-lived token. An unauthorized peer, another host's intent, and an intent whose derived worker, invocation, request digest, or device grant does not follow from its own contents are each refused.

- [x] G4: Recovery and crash matrix over the wire.
  CHECK: bun test --timeout 180000 ./src/factory/host-launch-transport.integration.test.ts
  EXPECT: exactly one physical start, one invocation, and one broker effect across every failure
  EVIDENCE: a lost launch response reconnects to the running guest instead of starting a second one; a restarted supervisor, which remembers nothing, reattaches from the intent alone and never issues a second invocation; a restarted gateway reads the same durable result and never invokes again. A host's memory is not a durable record, so a recovered wait with no recorded terminal stays uncertain rather than guessing.

- [x] G5: A queued attempt from a real product run executes in a real Podman guest through the supervisor process and its outcome is recorded, on PGlite and on real PostgreSQL.
  CHECK: flock /tmp/ezcorp-validation-heavy.lock bun test --timeout 300000 ./src/factory/host-launch-e2e.podman.integration.test.ts; and the same suite through `tests/postgres/factory-host-launch.test.ts` with `FACTORY_TEST_POSTGRES_URL`
  EXPECT: exit 0 on both engines
  EVIDENCE: `logs/e2e-podman-pglite.json` and `logs/e2e-postgres.json`, both exit 0, 1 pass / 0 fail. A real v4 guest builds, runs, performs one broker effect that crosses back from the container, and returns the canonical result; that result is durable in the product database before anything acknowledges it, the queue settles, and a second pass finds nothing to claim. Local S3 is unchanged by this path and was not exercised.

- [x] G6: Full verification and the `BASE_REF=integ/w00` gates, with the new PostgreSQL suite registered.
  CHECK: bun run typecheck; bun run lint; bun scripts/check-factory-boundaries.ts; bun scripts/gate-integrity.ts; BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts; BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts
  EXPECT: all exit 0
  EVIDENCE: all six exit 0. "New-file coverage gate PASSED: 5 new source file(s) gated" and "Patch coverage gate PASSED: all changed executable lines covered (6 file(s))". `tests/postgres/factory-host-launch.test.ts` is the new registered suite; it delegates to the shared `verifyFactoryHostLaunchEndToEnd` so the two engines run the same proof.

## How the transport is shaped, and why

The shape is settled by two constraints already in the tree.

The durable records stay in the product process. `IsolatedFactoryAttemptRuntime` owns the launch intent, the terminal result, and the journal, and the brief requires the supervisor to hold only host identity. So the supervisor must not hold the tenant database.

The broker stays in the product process. `IsolatedFactoryAttemptRuntimeOptions.broker` is gateway-owned and the supervisor never owns tenant credentials, so a guest's `factory.broker` frame has to come back to the product process rather than be served where the guest runs.

That makes the transport bidirectional over the one private service: the product process asks the supervisor to launch, attach, or stop, and the supervisor calls back for broker effects. It is the same transport and the same mutual-TLS peer policy in both directions, not a second one.

`FactoryAttemptOpen` is a handle, so it decomposes into routes rather than crossing the wire whole:

```
POST /v1/host/launches      -> { disposition, workerId, invocationId }
POST /v1/host/attachments   -> { disposition, workerId, invocationId }
POST /v1/host/results       -> FactoryRunnerResult   (bounded long poll)
POST /v1/host/stops         -> signed receipt        (W03's existing route, unchanged)
```

The client composes those four into a `FactoryHostLaunchProtocol` and a `FactoryAttemptRuntime`, which is exactly the `runtime` argument above. Nothing in the dispatcher, the queue, or W09's registration changes between the in-process and the distributed deployment, which is the point of putting the choice behind that one argument.

Reuse, not new transport: `src/factory/private-https.ts` for the server, `src/factory/runner/host-stop-service.ts` for the route and host-key policy, and `src/factory/host-stop-client.ts` for the client. The host signing key is loaded per signature there and must stay that way so rotation keeps working.

## Files outside the owned set

None. Everything added is under `src/factory/` and `src/factory/runner/`, both W01-owned, plus `src/__tests__/helpers/` for the shared suites, `tests/postgres/factory-host-launch.test.ts` for the registered PostgreSQL producer, and five keys appended to `scripts/coverage-thresholds.json` for the new files, which the common brief permits.

`src/factory/private-service.ts` was NOT touched after all. I disclosed in the previous revision that mounting the routes would need it; it did not, because the host routes belong on the supervisor's own listener rather than on the product's private service, and `startFactoryPrivateHttps` already takes a handler. W03's `/v1/host/stops` and this package's three paths can share one listener without either file changing.
