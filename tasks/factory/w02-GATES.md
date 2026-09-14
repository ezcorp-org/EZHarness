# Gates: W02 isolated Python and per-attempt CPU/GPU allocation

Scope: `docs/plans/2026-09-13-composable-factory-platform-completion.md` section 5, W02. Interface surface 6 of the W00 freeze, jointly owned with W01. Receipts live under `/tmp/factory-platform-evidence/w02/`; each `logs/<label>.json` records the producing commit, the SHA-256 of every dirty file, the exact command, the exit code, UTC start and end, duration, and the log's own SHA-256.

Branch `wp/w02-python-isolation`. Base `integ/w00` at `88effb159`, then merged with the coordinator's current `integ/w00` at `ab29eea11` as `2ec0ea129`; `tasks/lessons.md` resolved by union.

Commits:

| SHA | Subject |
| --- | --- |
| `9e6b7aecf` | feat(runner): carry per-attempt device authority instead of the host list |
| `e0598fe79` | feat(factory): isolated Python guest with a Python-native C02 validator |
| `c25455b01` | feat(factory): prove the per-attempt GPU grant and record the supported profile |
| `755b15502` | docs(factory): W02 gates, checklist and review (this gate file did not land here; see the note below) |
| `284001d7c` | test(factory): run the hostile task fixture inside the component environment |
| `6f06a82bc` | fix(factory): the supervised tool path also names its own devices |
| `1911488e4` | test(factory): measure the hostile fixture's two non-refusal facts correctly |
| `4723671d1` | test(factory): give the hostile probe its own control write |
| `1be759c0c` | test(factory): read the dropped capability set the way podman reports it |
| `662682a00` | test(factory): separate the declared guest environment from the runtime residue |
| `b0810f9c1` | test(factory): put the shared Python fixtures in the tests package marker |
| `fa2a6e6d1` | test(factory): cover the device preflight and drop an unused helper |

Every receipt in `/tmp/factory-platform-evidence/w02/INDEX.md` was produced from clean committed source with no dirty files: the suites and proofs at `fa2a6e6d1`, the static, focused, Python and coverage gates re-run on the merge result at `2ec0ea129`, and the static, Python and coverage gates re-run once more on the final tree at `e7ca1edd2`. Twenty receipts, every one exit 0 with no dirty files. Every heavy producer ran under `flock /tmp/ezcorp-validation-heavy.lock`; every producer that touches the GPU also ran under `flock $XDG_RUNTIME_DIR/ezcorp-factory-local-gpu.lock`. Nothing here reimaged or reconfigured this machine's GPU.

**Host fault during this package.** At 21:30 EDT a `core.bare = true` in the shared `.git/config` broke `git status`, `add` and `commit` in every worktree; the coordinator wrote `core.bare = false` into this worktree's `config.worktree` at 21:46 EDT. One commit (`9e6b7aecf`, 21:15) predates the window and the next (`e0598fe79`, 22:14) follows the repair, so no commit was attempted inside it. No receipt was produced inside it either: `receipt.py` reads `git rev-parse` and `git status --porcelain` before every run and would have failed rather than recorded a result. Every commit named above is reachable from `HEAD`, and the gates were re-run on the final tree afterwards.

## Gates

- [x] G1: A factory execution start carries exactly the devices its held pool allocation authorized, and a CPU start carries none, on a host runner configured with three.
  CHECK: `flock $XDG_RUNTIME_DIR/ezcorp-factory-local-gpu.lock flock /tmp/ezcorp-validation-heavy.lock bun test --timeout 400000 ./packages/@ezcorp/extension-runner/tests/podman-devices.integration.test.ts`
  EXPECT: exit 0; a real guest reports no `/dev/kfd` and no `/dev/dri` under an empty grant
  EVIDENCE: `logs/podman-devices.json`, exit 0, 6 pass / 0 fail, 18 assertions, 12 real containers created. The same suite's v4 case is the controlled fault: with no `devices` field the identical guest reports every configured device, so the empty-grant assertion cannot pass vacuously. `startExecutionDevices` decides it: a caller that names the field owns the decision and the host list is ignored; only a v4 caller that names nothing keeps the host default. A build or discovery guest is denied a device whatever the host configures.

- [x] G2: Unapproved, stale and overlapping device grants are all refused, durably.
  CHECK: `bun test --timeout 60000 ./src/factory/runner/attempt-devices.test.ts ./src/factory/runner/attempt-runtime.test.ts`
  EXPECT: exit 0
  EVIDENCE: `logs/focused-suites.json`, exit 0, 169 pass / 0 fail, 719 assertions across 18 files. A grant with no held `gpu-host`, a node outside the shared allowlist, a duplicate, more than sixteen, a malformed CDI name, a second `prepare` under a different lease, and a tampered stored grant are each refused with their own message. Overlap is fenced in `claimStart` under `pg_advisory_xact_lock` on the host, so two simultaneous claims cannot both observe an empty conflict set; disjoint nodes and the same node on another host both claim. A terminal holder releases its devices; an `uncertain` holder does not. Controlled fault in `logs/controlled-fault-device-fence.log`: disabling `assertDevicesExclusive` turns 11 pass / 0 fail into 7 pass / 4 fail.

- [x] G3: The device authority is derived from the held allocation, never from the host.
  CHECK: `bun test --timeout 60000 ./src/factory/runner/attempt-runtime.test.ts`
  EXPECT: exit 0
  EVIDENCE: `logs/focused-suites.json` and `logs/factory-podman-suites.json`. `factoryHeldAllocationDevices` returns an empty authorization unless the vector holds a `gpu-host`, and it refuses a profile registered for any host other than the one holding the lease. `IsolatedFactoryTrustedRunner` carries it through an optional `devices` preflight, with a case for a held allocation and one for none, so a CPU dispatch keeps its empty grant. `FactoryRunnerSupervisor`, the second factory start path, names its own list too: absent means none, never the host's.

- [x] G4: A digest-pinned Python 3.13.12 guest is sealed through the shared recipe machinery with an immutable dependency and model closure.
  CHECK: `flock /tmp/ezcorp-validation-heavy.lock bun test --timeout 900000 ./src/factory/runner/python-guest.integration.test.ts`
  EXPECT: exit 0; the recipe pins the image digest, the interpreter, the committed `uv.lock` digest, the importable closure, the model closure and the resource class
  EVIDENCE: `logs/python-guest-integration.json`, exit 0, 12 pass / 0 fail, 93 assertions. `PythonPodmanRunner` extends `PodmanRunner`, so the fail-closed kernel probe, the private artifact store and its exclusive lease, the read-only channel mount with its FIFO identity check, the detached launch, the frame policy and the device contract are one implementation for both guest languages. The build's lanes run inside that profile: every module is parsed, the guest's actual importable distributions are compared with the declared lock, the committed Python suite runs, and only then is the artifact stored and its manifest read back from a real guest. A closure that drifts from the pinned image fails with `dependency_closure_changed` and stores nothing; a module that cannot be parsed stores nothing; a guest with no declared test never builds.

- [x] G5: The framed request and result bridge crosses the FIFO control channel, and the Python guest implements W01's shim contract.
  CHECK: the same suite
  EXPECT: exit 0; a real framed `extension/invoke` is answered by the guest's own verdict
  EVIDENCE: `logs/python-guest-integration.json`. The in-guest shim opens `/channel/{in,out,err}` `O_RDWR` and hands them to the guest as its stdio, so a FIFO reader sees end-of-file only when the guest itself exits. A valid `FactoryRunnerRequest` becomes a completed `FactoryRunnerResult` that the shared contract admits and that repeats byte for byte; a refused request becomes a failed result carrying that exact issue code, never a completed one; and a result the contract would reject never leaves the guest, proved by a controlled fault that breaks the guest's result schema.

- [x] G6: C07.8 and discrepancy 20 are closed: the Python runtime has its own validator, and the two runtimes agree issue code by issue code.
  CHECK: the same suite, plus `bash scripts/python-quality.sh all`
  EXPECT: exit 0 on both; every committed fixture yields the same verdict and the same first issue code in Bun and in the isolated Python guest
  EVIDENCE: `logs/python-guest-integration.json` and `logs/python-quality-all.json`. `c02_runner.py` no longer starts a subprocess: `factory_ijson`, `factory_schema` and `factory_validation` are the Python counterpart of the SDK's `canonical.ts`, `schema.ts` and `validation.ts`, walking the same committed generated schema documents. Number printing follows the ECMAScript decimal-and-exponential rule rather than Python's `repr`, verified byte for byte against `JSON.stringify` over twenty-one values including subnormals, so a canonical encoding measures the same number of bytes in both runtimes. Host-Python conformance stays a separate, narrower entry point behind the same `Guest.verdict`.

- [x] G7: W18's Python lanes stay green with full coverage, and the rule families W18 deferred are now enforced.
  CHECK: `bash scripts/python-quality.sh all`
  EXPECT: exit 0; 100% line and branch coverage of every Python source file
  EVIDENCE: `logs/python-quality-all.json`. 122 discovered tests, `c02_runner.py` 28/28, `factory_ijson.py` 179/179, `factory_schema.py` 108/108, `factory_validation.py` 303/303, `guest.py` 127/127, 420 branches, all 100%. `I`, `S` and `E5` are selected: W18 deferred them because the old shell-out failed all three, and that shape is gone. Two branches that a finite non-integral float can never take were removed rather than left unreachable, and the one rule the shared limits make unreachable today is stated against a lowered constant so a future divergence stays covered.

- [x] G8: `quarantined` and `revoked` sit on the shared v4 package generation fence, and a blocking transition fences live attempts in the same commit.
  CHECK: `bun test --timeout 120000 ./src/factory/package-preparation.integration.test.ts ./src/db/migrations/add-factory-package-quarantine.test.ts ./src/__tests__/factory-migration-restart.test.ts`
  EXPECT: exit 0
  EVIDENCE: `logs/focused-suites.json`, exit 0, 169 pass / 0 fail, 719 assertions. Every trust revision records the `extension_release_installations.generation` it was decided against and seals it into the protected digest. A decision the installation has outrun fails dispatch with `factory_package_fence_stale`; a quarantined package fails with `factory_package_quarantined`, and both dispositions are `deny`. Quarantine is lifted only by an explicit human re-publish at the next revision, which then needs its own preparation because a receipt is keyed to its trust revision. Revocation may follow a quarantine without returning to active first. Every earlier decision is preserved: the revision history reads `1:active, 2:quarantined, 3:active`. The stop seam runs inside the same transaction as the state change, so a package cannot reach a blocking state without its live attempts being fenced in the same commit.

- [x] G9: The quarantine migration is self-idempotent on both a fresh and an upgraded database, with one named check per constraint.
  CHECK: `bun test --timeout 120000 ./src/db/migrations/add-factory-package-quarantine.test.ts ./src/__tests__/factory-migration-restart.test.ts`; `postgres-env bun test ./tests/postgres/factory-migration-restart.test.ts ./tests/postgres/factory-schema.test.ts`
  EXPECT: exit 0 on both engines
  EVIDENCE: `logs/focused-suites.json` and `logs/postgres-producers.json`, exit 0, 35 pass / 0 fail, 2942 assertions on real PostgreSQL. The backfill reads the generation out of the installation's JSON payload, fails closed on an incomplete backfill, then applies `SET NOT NULL` with no column default, so a row that names no fence is refused rather than defaulted to zero. The old state check is dropped by catalogue lookup and replaced once, so a rerun leaves exactly one `factory_runner_package_trust_state_check`. `factoryMigrationRestartConformance` reproduces the pre-upgrade shape and asserts both after two consecutive boots.

- [x] G10: Every applied runtime control is verified from the host and corroborated by the guest, for both pinned guest languages.
  CHECK: `flock /tmp/ezcorp-validation-heavy.lock bun test --timeout 900000 ./src/factory/runner/applied-controls.integration.test.ts`
  EXPECT: exit 0
  EVIDENCE: `logs/applied-controls.json`, exit 0, 5 pass / 0 fail, 133 assertions. Every fact is read from `podman inspect` on the live container while the guest runs and then compared with the guest's own report, so a control the runtime claims but the kernel did not apply cannot pass unseen in either direction: network mode and both route tables, read-only root and the absence of any read-write mount but `/tmp`, non-privileged, with an empty `CapAdd` and every default capability in `CapDrop`, against the guest's all-zero `CapEff`, no-new-privileges, a seccomp profile whose default action is `SCMP_ACT_ERRNO`, uid and gid 65534, the memory, swap, CPU and PID cgroup limits, and an empty device list on a host that configures two. There is no advisory fallback: a control the guest cannot read reports `unavailable`, which no exact comparison accepts.

- [x] G11: No provider or publish credential reaches a guest, and a manifest import side effect never runs in the host.
  CHECK: the same suite
  EXPECT: exit 0
  EVIDENCE: `logs/applied-controls.json`. Every guest carries the three declared variables, and the only other names permitted are `HOSTNAME` and `LC_CTYPE`, which the OCI runtime writes after podman has built the spec and which `--unsetenv` cannot reach. Which of the two appears depends on the image; the hostname is pinned to a fixed value so it carries no container identity. Neither the declared environment nor the observed one contains any credential-shaped name or the attempt token. The manifest is read back over a control frame from a guest whose reverse channel denies every host capability, and an import-time side effect in author source leaves the host process untouched.

- [x] G12: Measured defect, fixed here: the image's own environment reached every guest.
  CHECK: the same suite
  EXPECT: the declared environment is exactly the three C05 variables
  EVIDENCE: `logs/applied-controls.json`. The requirement index records C05 base-hardening item 5 as closed with "the v4 container receives only `HOME`, `TMPDIR`, and `BUN_INSTALL_CACHE_DIR`". Measured, it also received the image's `ENV`: `PATH`, `container`, and on the interpreter image `GPG_KEY`, `PYTHON_VERSION` and `PYTHON_SHA256`. `--unsetenv-all` removes it. The full shared Podman suite is the proof that v4 behaviour is otherwise unchanged: `logs/podman-shared-suite.json`, 16 pass / 0 fail.

- [x] G13: The base-hardening regressions still hold on the final code.
  CHECK: `bun test --timeout 120000 ./src/__tests__/factory-boot.test.ts ./src/__tests__/mcp-sandbox-require-sandbox.test.ts ./src/__tests__/mcp-launcher-fs-jail.test.ts ./src/extensions/__tests__/env-key-leak-install-block.test.ts ./src/extensions/__tests__/env-key-leak-install-path.test.ts`
  EXPECT: exit 0
  EVIDENCE: `logs/base-hardening-regressions.json`, exit 0, 67 pass / 0 fail, 243 assertions, plus the hostile task fixture run inside the component environment in `logs/python-guest-integration.json`: ten escapes all refused by the kernel, the probe's own control write succeeding so the report is not vacuous, at most four processes visible in the private namespace, and a spawned child inheriting the same zero capabilities, no-new-privileges, seccomp mode and empty route table. The secrets directory, `.pi-secret`, `.pi-salt` and `.env` deny set; a secrets directory inside or symlinked into a grantable root refused; one required-sandbox setting that both the shell and the MCP seams honour, on whenever `EZCORP_FACTORY_ENABLED=1`; a factory shell call failing before its command can spawn without a jail; an MCP request failing before the degraded no-context spawn; and the substring environment classifier over names and values.

- [x] G14: Real local AMD computation, and the per-attempt grant proved through the factory's own launch path.
  CHECK: `bash scripts/verify-factory-local-gpu.sh`; `bun scripts/verify-factory-attempt-gpu.ts --out <path>`
  EXPECT: exit 0 on both, each holding the user-scoped GPU lock for its whole run
  EVIDENCE: `logs/local-gpu-rocm-compute.json` and `logs/local-gpu-attempt-proof.json`, both exit 0, with the emitted verdict in `local-gpu-attempt-proof.json`. Ten fresh containers each computed on an AMD Radeon RX 7900 XTX, 25,753,026,560 usable VRAM bytes, PyTorch 2.12.0+rocm7.14.1, HIP 7.14.60850, and the missing-device control failed with `GPU_REQUIRED` as required. The attempt proof records six cases, all pass: a CPU attempt sees no device on a host configured with three; a held `gpu-host` allocation reaches exactly its three nodes with `/dev/kfd` open inside the guest; a narrower grant reaches one render node and no other; an unapproved grant is denied before any launch; a node outside the profile is refused by the shared validator; and the CDI profile has no implementation here. The supported profile is recorded in `docs/factory-local-gpu.md`.

- [x] G15: Every production GPU criterion is written as an explicit unmet row with its own measured verdict.
  CHECK: `docs/factory-local-gpu.md`, section "Unmet criteria for the production GPU profile"
  EXPECT: eight rows, none of them a pass
  EVIDENCE: the document, and the code that makes the first row fail closed. CDI injection is **not implemented**, and a grant naming CDI devices is now refused at start rather than launched with no device at all (`src/factory/runner/attempt-devices.test.ts`). A tenant-dedicated host, absence of co-location, a supported NVIDIA driver and toolkit pair, enforced compute-and-utility capabilities, device reset before reuse, a supervisor-verified reimage, and strict single-device isolation are each unmet, with the reason stated. Hardware being absent is recorded as absent, never as a pass. This machine's GPU configuration was not altered and nothing was reimaged.

- [x] G16: Static gates.
  CHECK: `bun run typecheck`; `bun run lint`; `bun scripts/check-factory-boundaries.ts`; `bun scripts/gate-integrity.ts`; `bun scripts/check-factory-lanes.ts`
  EXPECT: all exit 0
  EVIDENCE: `logs/static-gates.json`, `logs/final-static-gates.json` and `logs/head-static-gates.json`, all exit 0. `scripts/check-factory-runners.ts` is not in this set: it requires `FACTORY_RUNNER_READ_TOKEN`, which is a deployment readiness input W16 provisions, and it fails closed without one rather than passing.

- [x] G17: Coverage of every new file and every changed executable line.
  CHECK: `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts`; `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`
  EXPECT: both exit 0
  EVIDENCE: `logs/coverage-gates.json`, `logs/final-coverage-gates.json` and `logs/head-coverage-gates.json`, all exit 0. "New-file coverage gate PASSED: 7 new source file(s) gated" and "Patch coverage gate PASSED: all changed executable lines covered (11 file(s))". Merged from seven producers: the focused suites, the isolated Python guest, the applied-control probe, the shared Podman suite, the factory Podman suites, the real-PostgreSQL producers, and `scripts/python-quality.sh coverage`, which is the only instrumenter that can measure Python. Every touched file is at 100%: `podman.ts` 407/407, `python.ts` 84/84, `protocol.ts` 86/86, `attempt-runtime.ts` 326/326, `python-guest.ts` 36/36, `supervisor.ts` 72/72, `package-preparation.ts` 115/115, `add-factory-package-quarantine.ts` 9/9, and the five Python modules 790/790 lines with 424/424 branches.

## Landed deviations for the coordinator

1. **`FactoryAttemptRuntimeError` gains `device_conflict`.** Freeze section 6 lists the error union implicitly through W01's landed type. An overlapping device claim is a distinct outcome from `launch_conflict`, and the caller needs to tell them apart. Additive.
2. **`FactoryIsolatedRunnerPreflight` gains an optional `devices` method.** It is how the held allocation's device authority reaches `open()`. Absent means a CPU attempt with an empty grant, so no existing caller changes.
3. **`FactoryPackageTrusts` gains an optional quarantine fence seam.** `fenceAttempts` runs inside the same transaction as the state change. W03 owns the stop path and implements it; the seam is exposed and exercised here against a recording double. **Request to W03:** implement `FactoryPackageQuarantineFence` over the physical stop path and pass it to the `FactoryPackageTrusts` constructor in the composition root.
4. **`PodmanRunner` promotes five members to `protected` and gains two seams.** `prepare`, `stage`, `storeArtifact`, `startExecution`, `operations` and `deadlines` become protected; `probeProgram()` and `guestEntrypointArgs()` are new protected seams. This is what lets a second pinned guest language extend the class rather than fork the launch path, which is the C13 reuse rule.
5. **`--unsetenv-all` and a pinned hostname on every guest.** A behaviour change to the shared v4 runner, made because the measured environment did not match what C05 and the requirement index both claim. The full shared Podman suite is green.
6. **One new migration, `add-factory-package-quarantine`, appended at the end of `migrate()`.** The freeze's registry order lists entries 32 to 40 and reserves none for W02. It appends and depends only on `add-factory-package-preparations`, so the coordinator may place it anywhere after that entry. It also touches `src/db/schema.ts` for the two column changes, which the coordinator owns.
7. **`scripts/python-quality.sh` argv and `pyproject.toml` rule selection.** W18's lane invoked `c02_runner.py --sdk-bridge`, a flag the Python-native validator no longer has; the invocation is updated and the three rule families W18 deferred for that exact reason are now selected. Filed here rather than changed silently.
8. **Revocation is not terminal.** A blocked package returns only through an explicit human re-publish at the next revision, which is C05's "explicit repair within existing authority". This preserves the landed contract, which the package-preparation suite already asserted, rather than changing it.

## Interface questions

1. Freeze section 6 open question 4 keeps `devices` and `cdiDevices` as separate fields. Confirmed and implemented, with the consequence that a CDI grant is now a launch-time refusal rather than a silent no-device start. If W16 later lands CDI injection, the refusal in `startRequest` is the single place to remove.
2. `factoryHeldAllocationDevices` takes a `FactoryGpuHostProfile` the pool registers for a host. `src/factory/pool/process.ts` is W16's, and no host device registry exists yet. The derivation is pure and tested; W16 supplies the profile.
3. The guest environment now carries two variables the OCI runtime injects and podman cannot unset. C05 names exactly three. Recorded as a measured residue with fixed, tenant-independent values rather than as a deviation, but the coordinator may want it noted in the contract.
