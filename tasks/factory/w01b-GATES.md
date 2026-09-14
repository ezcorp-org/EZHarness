# Gates: W01b attempt-dispatch driver and production host launch transport

Branch `wp/w01b-attempt-dispatch`, from `integ/w00` at `1d3edf5b0`. Evidence under `/tmp/factory-platform-evidence/w01b/`.

Status: **partial.** The seam W09 needs is delivered and proven. The host launch transport and the end-to-end proof are designed and not yet built; each open gate says so in its own line rather than claiming otherwise.

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

- [ ] G3: The supervisor process serves `FactoryHostLaunchProtocol` over the private mutual-TLS service.
  EXPECT: launch, attach, and stop over the same transport W03's host stop uses, with the supervisor holding only host identity
  EVIDENCE: OPEN, designed not built. See the design note below.

- [ ] G4: Recovery and crash matrix over the transport: lost launch response then attach, supervisor restart, gateway restart.
  EVIDENCE: OPEN. The in-process equivalents are already proven in `src/factory/runner/attempt-recovery.test.ts`; the over-the-wire cases need G3.

- [ ] G5: A queued attempt from a real product run executes in a real Podman guest through the supervisor process and its outcome is recorded, on PGlite and on real PostgreSQL and S3.
  EVIDENCE: OPEN. Needs G3.

- [ ] G6: Full verification per common.md, the `BASE_REF=integ/w00` gates, and registration of any new `tests/postgres` suite.
  EVIDENCE: OPEN. Static gates pass today; the coverage gates and the PostgreSQL producers belong with G5.

## Design note for G3, the host launch transport

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

None so far. Everything added is under `src/factory/runner/`, plus one key appended to `scripts/coverage-thresholds.json` for the new file, which the common brief permits. Building G3 will touch `src/factory/private-service.ts` to mount the new routes; that is disclosed here in advance.
