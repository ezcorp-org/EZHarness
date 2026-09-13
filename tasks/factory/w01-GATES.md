# Gates: W01 durable Bun execution and recovery

Scope: `docs/plans/2026-09-13-composable-factory-platform-completion.md` section 5, W01. Interface surface 6 of the W00 freeze. Receipts live under `/tmp/factory-platform-evidence/w01/`; each `logs/<label>.json` records the producing commit, dirty files, exact command, exit code, UTC start and end, duration, and the log's SHA-256. `INDEX.md` maps them and `SHA256SUMS` checksums the raw logs.

Branch `wp/w01-durable-runtime`. Base `integ/w00` at `c6ac529d2`. All sixteen gates pass.

**Closed: guest lifetime is decoupled from the supervising process.** The validator reported the SIGKILL case as timing flakiness and recommended a bounded retry. Root-causing it found a product defect, so the design was fixed instead of the test. The guest's stdin was a `podman attach` stream whose pipe the supervisor held; killing the supervisor closed it, podman forwarded the end-of-input, and the guest died. Measured before the fix in `logs/attach-eof-repro.log`: `running` while the parent lived, `exited exit=7` at the first observation 250 ms after `SIGKILL`, where 7 is the guest's own end-of-input handler.

The control channel is now a FIFO triple bound read-write at `/channel`, with an in-guest shim holding all three `O_RDWR` for the guest's whole life. A FIFO reader sees end-of-file only when every writer closes, so no host process's exit can reach the guest; the supervisor's death closes only its own descriptors. Design and the pre-implementation feasibility measurement are in `DESIGN-guest-lifetime.md` and `logs/fifo-channel-feasibility.log`. `FramedExecution` gained a `FramedTransport` interface that `ChildProcessWithoutNullStreams` satisfies structurally, so all nine consuming files and the entire frame policy are unchanged, and builds never used this path.

- [x] G1: One concurrent claimant launches one physical attempt, with stable worker and invocation identities committed before the guest starts.
  CHECK: bun test --timeout 120000 ./src/factory/runner/attempt-recovery.test.ts ./src/factory/runner/attempt-runtime.test.ts
  EXPECT: exit 0; the losing claimant attaches and never starts a second guest
  EVIDENCE: `logs/final-focused-suites.json`, 66 pass / 0 fail, 234 assertions. `factoryAttemptInvocationId` is reproducible from attempt, candidate generation, and attempt number, stored NOT NULL under `uq_factory_attempt_launches_invocation`.

- [x] G2: The intent binds the canonical request digest, the full identity tuple, worker and invocation IDs, the lease fence, and the complete prepared package receipt; readiness is revalidated immediately before the token mint.
  CHECK: bun test --timeout 120000 ./src/factory/runner/attempt-recovery.test.ts
  EXPECT: exit 0; a package revoked between claim and mint denies the launch before a token exists
  EVIDENCE: `logs/final-focused-suites.json`. A denial before any physical start releases the claim to `prepared`; a denial while reattaching a live guest records `uncertain`. The real-guest case in `logs/final-attempt-runtime-integration.json` proved the check fires against a drifting receipt before it was corrected.

- [x] G3: Every guest control frame is bound to its worker, invocation, and attempt, and a mismatched frame is denied rather than answered.
  CHECK: bun test --timeout 60000 ./src/factory/runner/guest-frames.test.ts
  EXPECT: exit 0; drift in worker, invocation, token, deadline, scope, or principal is `frame_unbound`
  EVIDENCE: `logs/final-focused-suites.json`; `guest-frames.ts` 13/13 lines; the single-tool supervisor adapter shares the same policy.

- [x] G4: Losing the controlling attachment terminates no guest, and a fresh attach skips normal startup's orphan cleanup.
  CHECK: flock /tmp/ezcorp-validation-heavy.lock bun test --timeout 180000 ./packages/@ezcorp/extension-runner/tests/podman.integration.test.ts
  EXPECT: the guest is still running after its supervisor dies, independent of how fast a replacement attaches
  EVIDENCE: `logs/final-podman-suite-run1.json` and `-run2.json`, both exit 0, 15 pass / 0 fail, 78 assertions, run back to back under the lock. The SIGKILL case asserts `running` before any attach, after observing the child's exit rather than a clock, and asserts no probe and no sweep on the attach. Its controlled fault reproduces the superseded stdin transport and settles on a terminal state with the guest's own exit code 7, so the assertion cannot pass vacuously.

- [x] G5: Terminal results are durable before they are acknowledged, and a fresh supervisor or gateway reads the same result without another `extension/invoke`.
  CHECK: bun test --timeout 120000 ./src/factory/runner/attempt-recovery.test.ts
  EXPECT: exit 0; one start and one invocation across the original and the recovered gateway
  EVIDENCE: `logs/final-focused-suites.json`. Covers a crash at the acknowledgement boundary, a crash before the result boundary staying uncertain, a losing claimant returning the winner's exact result, digest tampering, and the database CHECK constraints.

- [x] G6: Recovery of transcript, cursor, tool results, and pinned model configuration from durable records, on a supervisor that does not hold the original local directory.
  CHECK: flock ... bun test --timeout 180000 ./packages/@ezcorp/extension-runner/tests/podman.integration.test.ts; bun test ./src/factory/runner/attempt-recovery.test.ts
  EXPECT: exit 0 on both
  EVIDENCE: `logs/final-podman-suite-run1.json` and `-run2.json` reconnects from a second supervisor process after SIGKILL. `logs/final-focused-suites.json` replays the durable `journalCursor`, every operation result, `workspaceCheckpoint`, and the pinned `runner.model` and `runner.configurationDigest`. Workspace bytes remain W04's material service behind the existing artifact-store seam.

- [x] G7: One real model or tool operation through Node, the Bun gateway, and an isolated guest, with the shared executor's broker transport and journal hooks intact.
  CHECK: flock ... bun test --timeout 300000 ./src/factory/runner/attempt-runtime.integration.test.ts
  EXPECT: 6 pass / 0 fail
  EVIDENCE: `logs/final-attempt-runtime-integration.json`, exit 0, 6 pass / 0 fail, 27 assertions. The guest receives only the minted attempt token and makes exactly one broker call. No authority check was removed.

- [x] G8: The crash matrix kills the gateway, guest, and supervisor around each journal and result boundary with no duplicate invocation or external effect.
  CHECK: both suites above
  EXPECT: exit 0
  EVIDENCE: gateway-side crashes in `logs/final-focused-suites.json`; a real SIGKILLed supervisor in `logs/final-podman-suite-run1.json` and `-run2.json`. One start and one invocation throughout.

- [x] G9: Both recovery topologies: a restarted or moved gateway reconnects to the same host supervisor, and replacement follows only a signed physical-stop receipt with fencing.
  CHECK: flock ... bun test ./packages/@ezcorp/extension-runner/tests/podman.integration.test.ts; ./src/factory/runner/attempt-runtime.integration.test.ts
  EXPECT: exit 0 on both
  EVIDENCE: `logs/final-podman-suite-run1.json` and `-run2.json` reconnects a second supervisor to the same host guest. `logs/final-attempt-runtime-integration.json` verifies the RSA signature over the canonical unsigned facts and its digest, and `stopPhysical` refuses to call a worker absent until a terminal runtime observation confirms it.

- [x] G10: The real subprocess test: start the guest, SIGKILL its owning supervisor, count exactly one labelled container, attach from a new supervisor without cleanup, then remove every owned resource.
  CHECK: flock ... bun test --timeout 180000 ./packages/@ezcorp/extension-runner/tests/podman.integration.test.ts
  EXPECT: deterministic, not race-dependent
  EVIDENCE: `logs/final-podman-suite-run1.json` and `-run2.json`. A real child process and a real SIGKILL, not an injected `Runner.attach`. Two consecutive runs pass, and the property no longer depends on winning a race.

- [x] G11: Re-run C05 PGlite, real PostgreSQL and S3, real Podman preparation, and schema and foreign-key parity.
  CHECK: postgres-env.sh bun test ./tests/postgres/factory-{schema,migration-restart,executions,attempt-queue,execution-gateway,package-preparation}.test.ts; flock ... bun test ./src/factory/package-preparation.podman.integration.test.ts; bun scripts/verify-factory-storage.ts
  EXPECT: exit 0 on all three
  EVIDENCE: `logs/final-postgres-producers.json`, exit 0, 28 pass / 0 fail, 2794 assertions. `logs/final-package-preparation-podman.json`, exit 0, 1 pass / 0 fail. Local S3 conformance passed for 10 tenant identities. Terra's reported pre-import three-foreign-key mismatch for `factory_runner_package_bindings` does not reproduce on this merged tree.

- [x] G12: In the composed launcher, two model and configuration tuples share one package and export and only one is revoked; every dispatch path consumes current readiness.
  CHECK: bun test --timeout 120000 ./src/factory/runner/attempt-recovery.test.ts
  EXPECT: exit 0; the revoked tuple never starts and never reuses the other tuple's result
  EVIDENCE: `logs/final-focused-suites.json`.

- [x] G13: The migration registers as entry 33 after `add-factory-protected-command-effects`, carries the freeze's `package_receipt_json` correction, and has a repeat-migration conformance case.
  CHECK: bun test ./src/__tests__/factory-migration-restart.test.ts; postgres-env.sh bun test ./tests/postgres/factory-migration-restart.test.ts
  EXPECT: exit 0 on both engines
  EVIDENCE: `logs/final-focused-suites.json` and `logs/final-postgres-producers.json`. One uniqueness mechanism and one named CHECK per constraint on both the fresh and the upgraded path, avoiding freeze correction 4's defect.

- [x] G16: The workspace-checkpoint seam carries what W04's material service needs, without an implementer parsing an operation index back out of an identifier.
  CHECK: bun test ./src/factory/runner/supervisor.integration.test.ts; flock ... bun test --timeout 300000 ./src/factory/runner/supervisor.podman.integration.test.ts
  EXPECT: exit 0 on both
  EVIDENCE: `logs/final-focused-suites.json` asserts the writer receives `operationIndex` and the attempt authority, and that the operation ID still ends with that index. `logs/final-supervisor-podman.json`, exit 0, 2 pass / 0 fail, proves the seam through a real container. The seam returns `FactoryCheckpointReference`, verified against W04's real implementer signature with a throwaway assignability probe; typed as `JsonValue` it did not compile, because a declared interface never gains that index signature. Fixtures return a real sealed-material reference whose `journalCursor` equals the operation index. `src/factory/runner/workspace-checkpoint-seam.test.ts` now pins the seam permanently: re-widening the return type to `JsonValue` fails that file's typecheck with `TS2322`, verified by a controlled revert. The consumer cannot hold this guard, because a worker who may not import this interface can only mirror it and a mirror encodes belief rather than declaration. The checkpoint bytes remain W04's `FactoryAttemptMaterials` under the reserved `workspace/` prefix; W01 builds no blob path of its own.

- [x] G14: Static gates.
  CHECK: bun run typecheck; bun run lint; bun scripts/check-factory-boundaries.ts; bun scripts/gate-integrity.ts
  EXPECT: all exit 0
  EVIDENCE: `logs/final-static-gates.json`, exit 0.

- [x] G15: Coverage of every new file and every changed executable line.
  CHECK: BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts; BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts
  EXPECT: both exit 0
  EVIDENCE: `logs/final-static-gates.json`. "New-file coverage gate PASSED: 3 new source file(s) gated" and "Patch coverage gate PASSED: all changed executable lines covered (9 file(s))". Merged from four producer LCOVs: `attempt-runtime.ts` 307/307, `guest-frames.ts` 13/13, `supervisor.ts` 71/71, `add-factory-attempt-launches.ts` 23/23, `podman.ts` 315/315, all 100%.

## Host fault during this package

`user@1001.service` was killed by the kernel OOM killer at 13:40 EDT, taking rootless Podman's cgroup manager and the shared proof PostgreSQL container with it. Every producer above was rerun after the coordinator restored the host at 14:47 EDT. The receipts from the fault window are retained in `INDEX.md` as historical evidence and are not counted as passes.
