# Gates: W01g guest material staging over the broker

Branch `wp/w01g-staging`, cut from `integ/w00` at `850ffaa54`.
Evidence: `/tmp/factory-platform-evidence/w01g/`.

| Commit | What it is |
| --- | --- |
| `261b6f645` | the SDK frame contract: four request frames, one response union, generated schemas, the guest client |
| `d0d063880` | the host adapter onto W04's material service, and the candidate-output promotion |
| `acd70a45b` | the native runner's artifacts over the same two writers; guest checkpoint staging |
| `cc5bb961f` | the guest-broker route a runner host forwards to, and its client |
| `bc834e9f1` | the staging contract in the Python runtime, with fixture parity |
| `e0f57b446` | a host composes its guest broker from a declaration, resolved on first use |
| `c3dc11cde` | the SDK routes a staging frame by name, so a runner host loads no product module to route one |
| `994deebe8` | the supervisor forwards staging frames from `services.guestBroker`; the declared client from `e0f57b446` is removed |

## What this leaf is

W09b proved that a sandboxed guest has no way to produce a COMPLETED result: the guest broker
carried exactly one frame, `NativeFactoryArtifacts` had no production implementation, and W09b's
own record named the gap in `notProven[0]`. Every real run ended `failed` because the minimal
guest returned `cancelled`. This is the byte path, the host adapter, the completed result, and a
real proof.

Round 2 receipts (2026-09-22): every coverage, PostgreSQL, Podman and real-server receipt under
`/tmp/factory-platform-evidence/w01g/` was produced at `179674cbf` on a clean tree; the static
sweep receipts are from the final head. `report.txt` names each one.

### The reproduction, first

- [x] G0: At the base, a real run ends `failed` because the guest returns `cancelled` and has no
  staging path.
  CHECK: `W01G_GUEST=cancelled W01G_LABEL=reproduction flock --close /tmp/ezcorp-validation-heavy.lock timeout 1800 bash /tmp/factory-platform-evidence/w01g/repro/one-run.sh`
  EXPECT: `statusTimeline` ends `failed`; the durable terminal result is `cancelled` with
  `output`, `resultDigest` and `workspaceCheckpoint` all null
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/reproduction.json` (run at `000e71b96`, the proof
  base; W09b's harness reports `outcome: passed` because reaching ANY terminal status is its
  criterion, and the run it describes ended `failed`)

### The contract

- [x] G1: The staging frames exist as SDK types with generated schemas, and both runtimes enforce
  them identically (C07).
  CHECK: `bun run --cwd packages/@ezcorp/factory-sdk build`; `bun test --timeout 30000 ./packages/@ezcorp/factory-sdk/src/guest-material-frames.test.ts ./packages/@ezcorp/factory-sdk/src/guest-materials.test.ts`; `bash scripts/python-quality.sh lint typecheck test`; `bun test --timeout 600000 ./src/factory/runner/python-runner.integration.test.ts`
  EXPECT: all exit 0; the two runtimes agree on 14 accepted and 46 rejected fixtures, code for code
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

- [x] G2: One broker and one channel. A staging frame carries no authority the attempt token does
  not already carry.
  CHECK: read `src/factory/runner/guest-material-broker.ts`; `bun test --timeout 60000 ./src/factory/runner/guest-material-broker.integration.test.ts`
  EXPECT: every scope field (tenant, project, run, attempt, node instance, candidate generation)
  is read from `factoryRunnerRequestAuthority(request)` or from the verified attempt token; a
  frame names only an operation, an object name and a version; the cross-scope case is refused
  `unknown_material` without disclosing existence
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

- [x] G3: Every refusal is named, and the mapping is exhaustive over the material service's own
  codes.
  CHECK: `bun test --timeout 60000 ./src/factory/runner/guest-material-broker.integration.test.ts`
  EXPECT: the suite's table test derives the code list from `artifact-materials.ts` source and
  finds no unmapped code (exhaustive mapping, not reachability). Each refusal a guest can receive
  is then asserted by name in a real case: `deadline_expired`, `stale_epoch` (a moved fence),
  `oversize`, `digest_mismatch`, `chunk_out_of_order`, `sealed`, `unknown_material`,
  `output_not_canonical_json`, `invalid_request`, `conflict` (a begin that contradicts its own
  plan), `operation_full` (the 257th material in one operation), `unknown_attempt` (a
  never-admitted attempt, and an unknown run, against the real journal; round 4), and
  `unavailable` (an object-store fault, which then succeeds on resend; round 4)
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/coverage-runner.json`

### The host adapter

- [x] G4: Repeated frames after a lost response are durably idempotent, and a restarted host
  finishes the same material.
  CHECK: `bun test --timeout 60000 ./src/factory/runner/guest-material-broker.integration.test.ts`
  EXPECT: a repeated begin, chunk, seal and promotion each answer identically and write one chunk
  row; a seal issued by a broker built after the chunks still returns the same bytes
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

- [x] G5: Cancellation and the deadline are honoured mid-upload.
  CHECK: `bun test --timeout 60000 ./src/factory/runner/guest-material-broker.integration.test.ts`
  EXPECT: a cancellation landing between two chunks refuses the next chunk and the seal as
  `stale_epoch`; an attempt past its own signed deadline is refused `deadline_expired` before the
  database is touched
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

- [x] G6: The completed result is validated, recorded and projected through the broker path, and
  the native entrypoint is implemented but NOT composed (coordinator ruling, round 4).
  CHECK: `grep -rln "createNativeFactoryArtifacts\|runNativeFactoryRunner\|executeFactoryAttempt" src web packages | grep -v test`; `bun test --timeout 60000 ./src/factory/runner/guest-material-broker.integration.test.ts ./src/factory/runner/native.integration.test.ts`
  EXPECT: the grep lists only `src/factory/runner/native.ts` and `src/runtime/executor.ts`, the
  definition of `executeFactoryAttempt`. `createNativeFactoryArtifacts`, `runNativeFactoryRunner`
  and `executeFactoryAttempt` have no production caller. The entrypoint stays: contract C02
  (contracts line 71) and plan section 5 (line 156) name it as the thing to extend. Removing it
  needs the maintainer-only gate label, because gate-integrity refuses a deleted test file and a
  removed threshold key. As written it reads the journal and writes artifacts through the product
  database, so composing it in the product process would break the no-host-process rule. A C02
  native runner inside the runner image needs a guest-side journal read and a runner-image main.
  That is a stage-2c item owned by W01, due before W18's final gate. The candidate digest equals
  `sha256:${resultDigest}` by derivation.
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/coverage-runner.json`

### The real-server proof

- [x] G7: A real sandboxed guest stages one output and the run reaches terminal COMPLETED, three
  consecutive passes on fresh product databases.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 5400 bash /tmp/factory-platform-evidence/w01g/repro/run-three.sh`
  EXPECT: each pass ends `statusTimeline` … `succeeded`; the durable terminal result is
  `completed` carrying a staged `output`; the candidate output is readable and equals the bytes
  the guest staged
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/proof-1.json`, `proof-2.json`, `proof-3.json`

- [x] G8: The harness records its own failures rather than crashing, and a guest that stages
  nothing still ends `failed`.
  CHECK: `W01G_GUEST=cancelled … bash /tmp/factory-platform-evidence/w01g/repro/one-run.sh`
  EXPECT: the negative control writes a record whose run ends `failed` with a `cancelled` terminal
  result, unchanged from the reproduction
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/negative-control.json`

### The gates every package owes

- [x] G9: 100 percent coverage of every new file and every changed line.
  CHECK: `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts` over the merged lcov
  EXPECT: both exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

- [x] G10: No gate weakened; boundaries, schema drift, typecheck and lint green at the final head
  on a clean tree.
  CHECK: `bun run typecheck && bun run lint && bun scripts/check-factory-boundaries.ts && bun scripts/gate-integrity.ts`; `bun run --cwd packages/@ezcorp/factory-sdk schema:generate && git diff --exit-code packages/@ezcorp/factory-sdk/src`
  EXPECT: all exit 0, and schema regeneration produces no drift
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

- [x] G11: The PostgreSQL producers this package touches are green against the real engine.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 2400 …` over `tests/postgres/factory-guest-material-broker.test.ts` and `tests/postgres/factory-artifact-materials.test.ts`
  EXPECT: exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

- [x] G12: The Podman suites are green under `flock --close`.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 3600 bun test --timeout 900000 ./src/factory/runner/python-guest.integration.test.ts …`
  EXPECT: exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

### The host mount (round 2)

- [x] G13: A supervisor whose configuration names `services.guestBroker` forwards a guest's
  staging frames to the product route, and a model request keeps its named refusal.
  CHECK: `bun test --timeout 60000 ./src/factory/runner/supervisor-process.test.ts ./src/factory/runner/guest-broker-transport.integration.test.ts`
  EXPECT: exit 0; the section has the pool section's exact shape and is optional, complete or
  refused; a configured broker answers a begin frame `begun` over a real mutual-TLS route and a
  model request `factory_host_broker_unavailable`; a missing credential fails before the listener
  binds; the three G7 receipts show `guestBrokerHost.configuredIn = services.guestBroker`
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/coverage-runner.json`, `proof-1.json`

### The product mount (round 3, delegated by the coordinator)

- [x] G14: The product runtime binds the guest-broker route from `guestBroker` in its startup
  document, readiness reports it, and a host without `services.guestBroker` refuses a staging
  frame by name.
  CHECK: `bun test --timeout 120000 ./src/factory/startup-config.test.ts ./src/factory/installation-startup.test.ts ./src/factory/runner/guest-broker-transport.integration.test.ts ./src/factory/runner/supervisor-process.test.ts`; the G7 passes
  EXPECT: exit 0; the section is all parts or none, needs `hostLaunch.attemptTokenSecretPath`, and
  refuses a bad `allowedPeers`; a composed route takes a two-chunk upload from a configured host,
  refuses a token signed with another secret, and reads `unconfigured` or `unavailable` with a
  code otherwise; the route verifies the host's bearer token (subject = peer identity, scope
  `factory:guest-broker`) and refuses `forbidden_host` unless the attempt's launch record names
  the host the peer runs as (round 4); a host with no section answers `factory_host_broker_unavailable` naming
  `services.guestBroker`; in each of the three passes `/api/ready` carries
  `guestBroker: { state: "bound" }` and `guestBrokerObserver.boundBy` names the web server
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/coverage-runner.json`, `proof-1.json` to `proof-3.json`

Round 3 receipts (2026-09-22/23): the passes, the negative control, the coverage legs and the
Podman suites ran at `23965e397` on a clean tree; the static sweep at the final head.

## Round 4 (validator ACCEPT-WITH-FIXES at f00605f72)

- F1: the journal's liveness fence throws `FactoryAttemptLivenessError`; the broker maps an
  unknown attempt to `unknown_attempt`, a moved fence to `stale_epoch`, and an untyped store fault
  to `unavailable`. Commit `82162aff4`.
- F2: G3 now names a real case for every refusal (above).
- F3: the route binds the host to the attempt's lease and verifies its bearer token. Commit
  `12a1ad076`.
- F5: recorded in G6, per the coordinator's ruling.
- CLOSED at `a805171a5` (0 dirty): G7 and G8 (three passes and the control, host bound by lease
  and bearer token), G11 (`coverage-postgres`, now also `tests/postgres/factory-executions.test.ts`),
  and G12 (the three Podman suites). Before that store repair, G7, G8, G11 and G12 needed their
  receipts at the round-4 head. The shared ordinary object
  store refused writes from 08:32 on 2026-09-23 because the host disk is full.
  `receipts/store-unwritable-r4.json` records it, and the failed runs are kept in
  `repro/history/*-r4-store-unwritable.json`. The coordinator owns the repair.
