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

## What this leaf is

W09b proved that a sandboxed guest has no way to produce a COMPLETED result: the guest broker
carried exactly one frame, `NativeFactoryArtifacts` had no production implementation, and W09b's
own record named the gap in `notProven[0]`. Every real run ended `failed` because the minimal
guest returned `cancelled`. This is the byte path, the host adapter, the completed result, and a
real proof.

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

- [ ] G1: The staging frames exist as SDK types with generated schemas, and both runtimes enforce
  them identically (C07).
  CHECK: `bun run --cwd packages/@ezcorp/factory-sdk build`; `bun test --timeout 30000 ./packages/@ezcorp/factory-sdk/src/guest-material-frames.test.ts ./packages/@ezcorp/factory-sdk/src/guest-materials.test.ts`; `bash scripts/python-quality.sh lint typecheck test`; `bun test --timeout 600000 ./src/factory/runner/python-runner.integration.test.ts`
  EXPECT: all exit 0; the two runtimes agree on 14 accepted and 46 rejected fixtures, code for code
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

- [ ] G2: One broker and one channel. A staging frame carries no authority the attempt token does
  not already carry.
  CHECK: read `src/factory/runner/guest-material-broker.ts`; `bun test --timeout 60000 ./src/factory/runner/guest-material-broker.integration.test.ts`
  EXPECT: every scope field (tenant, project, run, attempt, node instance, candidate generation)
  is read from `factoryRunnerRequestAuthority(request)` or from the verified attempt token; a
  frame names only an operation, an object name and a version; the cross-scope case is refused
  `unknown_material` without disclosing existence
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

- [ ] G3: Every refusal is named, and the mapping is exhaustive over the material service's own
  codes.
  CHECK: `bun test --timeout 60000 ./src/factory/runner/guest-material-broker.integration.test.ts`
  EXPECT: the suite's table test derives the code list from `artifact-materials.ts` source and
  finds no unmapped code; `deadline_expired`, `stale_epoch`, `oversize`, `digest_mismatch`,
  `chunk_out_of_order`, `sealed`, `unknown_attempt`, `unknown_material`,
  `output_not_canonical_json`, `conflict`, `operation_full`, `invalid_request` each have a case
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

### The host adapter

- [ ] G4: Repeated frames after a lost response are durably idempotent, and a restarted host
  finishes the same material.
  CHECK: `bun test --timeout 60000 ./src/factory/runner/guest-material-broker.integration.test.ts`
  EXPECT: a repeated begin, chunk, seal and promotion each answer identically and write one chunk
  row; a seal issued by a broker built after the chunks still returns the same bytes
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

- [ ] G5: Cancellation and the deadline are honoured mid-upload.
  CHECK: `bun test --timeout 60000 ./src/factory/runner/guest-material-broker.integration.test.ts`
  EXPECT: a cancellation landing between two chunks refuses the next chunk and the seal as
  `stale_epoch`; an attempt past its own signed deadline is refused `deadline_expired` before the
  database is touched
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

- [ ] G6: The completed result is validated, recorded and projected, and `NativeFactoryArtifacts`
  has a production implementation over the same two writers.
  CHECK: `grep -rn "runNativeFactoryRunner\|NativeFactoryArtifacts" --include='*.ts' src/ | grep -v test`; `bun test --timeout 60000 ./src/factory/runner/guest-material-broker.integration.test.ts ./src/factory/runner/native.integration.test.ts`
  EXPECT: `createNativeFactoryArtifacts` is the production implementation (the seam is implemented,
  not removed: `runNativeFactoryRunner` is C02's Bun native entrypoint and the seam now has one
  answer on both sides); the candidate digest equals `sha256:${resultDigest}` by derivation
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

### The real-server proof

- [ ] G7: A real sandboxed guest stages one output and the run reaches terminal COMPLETED, three
  consecutive passes on fresh product databases.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 5400 bash /tmp/factory-platform-evidence/w01g/repro/run-three.sh`
  EXPECT: each pass ends `statusTimeline` … `succeeded`; the durable terminal result is
  `completed` carrying a staged `output`; the candidate output is readable and equals the bytes
  the guest staged
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/proof-1.json`, `proof-2.json`, `proof-3.json`

- [ ] G8: The harness records its own failures rather than crashing, and a guest that stages
  nothing still ends `failed`.
  CHECK: `W01G_GUEST=cancelled … bash /tmp/factory-platform-evidence/w01g/repro/one-run.sh`
  EXPECT: the negative control writes a record whose run ends `failed` with a `cancelled` terminal
  result, unchanged from the reproduction
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/negative-control.json`

### The gates every package owes

- [ ] G9: 100 percent coverage of every new file and every changed line.
  CHECK: `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts` over the merged lcov
  EXPECT: both exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

- [ ] G10: No gate weakened; boundaries, schema drift, typecheck and lint green at the final head
  on a clean tree.
  CHECK: `bun run typecheck && bun run lint && bun scripts/check-factory-boundaries.ts && bun scripts/gate-integrity.ts`; `bun run --cwd packages/@ezcorp/factory-sdk schema:generate && git diff --exit-code packages/@ezcorp/factory-sdk/src`
  EXPECT: all exit 0, and schema regeneration produces no drift
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

- [ ] G11: The PostgreSQL producers this package touches are green against the real engine.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 2400 …` over `tests/postgres/factory-guest-material-broker.test.ts` and `tests/postgres/factory-artifact-materials.test.ts`
  EXPECT: exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

- [ ] G12: The Podman suites are green under `flock --close`.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 3600 bun test --timeout 900000 ./src/factory/runner/python-guest.integration.test.ts …`
  EXPECT: exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w01g/receipts/`

## Open, and why

- [ ] G13: The composition that mounts this route in a deployment.
  The product-side guest-broker route and the host's forwarding client are product code under
  proof, but the two lines that MOUNT them belong to W09's composition surfaces
  (`supervisor-process.ts` for the host, the product runtime's listener set for the tenant side).
  This branch does not touch either. The proof worktree `.worktrees/w01g-proof` carries the host
  half as two lines in `supervisor-process.ts` and starts the product half from the harness
  process against the real product database; both are named in every receipt. The production
  shape to land in W09c is stated in the report.
