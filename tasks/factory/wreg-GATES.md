# Gates: inherited backend-pool regressions (WREG)

Scope: the seven backend-pool failures across five files that no work package owns, recorded by W07
and W10 on the integrated branch (`/tmp/factory-platform-evidence/w10/backend-pool.json`, log
`/tmp/factory-platform-evidence/w10/logs/backend-pool.log`).

Branch `wp/wreg-backend-failures`. Worktree created at `integ/w00` `2377caaa4`; `integ/w00` advanced
to `5f04c7131` (W10 code reference pack) while this work ran, so the branch merged it at `c8bbf95f7`
before the gates. There is no file overlap between the two sides.

Status: all seven failures fixed at the source. The canonical backend pool reports **0 fail**.

## Commits

| SHA | Subject |
| --- | --- |
| `3a8350b88` | fix(contract): regenerate the wire schema for StartRequest.devices |
| `c9d0c3a05` | fix(runner): declare the guest search path so a v4 extension can spawn by name |
| `638f2e7d1` | fix(runner): route trusted-local execution through its own launch seam |
| `c8bbf95f7` | merge: receive integ/w00 through the W10 code reference pack (5f04c7131) |

Every producer below ran at `c8bbf95f7`. The later documentation commit changes only `tasks/`
and no file the pool, the gates or the coverage diff reads.

Three root causes explain all seven failures. Two are product regressions from the wave-1 runtime;
one is a stale generated artifact. None is a stale test and none is an environment fault.

---

## Failure 1 — `packages/@ezcorp/extension-contract/src/schema.test.ts`

**Reproduction.** `bun test --timeout 30000 ./packages/@ezcorp/extension-contract/src/schema.test.ts`
with `src/wire-schema.json` restored from `integ/w00`: 1 fail, the generated schema carries a
`StartRequest.devices` property the committed schema does not.
Receipt `/tmp/factory-platform-evidence/wreg/repro-wire-schema.json`.

**Root cause.** A stale generated artifact, not a product regression and not a stale test. W01 added
the optional `devices` field to `types.d.ts` under interface freeze section 6 ("Shared-package
change, additive only"), but `wire-schema.json` was never regenerated. The brief states the failure
the other way round; the measured direction is that the generator emits `devices` and the committed
schema lacks it.

This was a live defect, not only a drift check. `validation.ts` compiles the committed schema into
the wire validator, and `StartRequest` carries `additionalProperties: false`, so
`validateWire("startRequest", …)` rejected every start that named a device — exactly the payload
section 6 authorizes.

**Fix.** Ran the package's own `schema:generate` (`3a8350b88`). The file is generated only and is
never hand-edited; the sole hand step was restoring the trailing newline the generator omits.

**Owner (freeze section 12).** `types.d.ts` is Terra runtime's, and section 12 records
`packages/@ezcorp/factory-sdk/src/*.schema.json` as "Generated only. Never hand-edit." The generated
`wire-schema.json` has no owner row of its own. **Disclosure to Terra runtime (W01):** the field you
landed in `types.d.ts` needs its generated schema alongside it; `schema:generate` is now run.

**Receipts.** Repro `/tmp/factory-platform-evidence/wreg/repro-wire-schema.json`; verification
`/tmp/factory-platform-evidence/wreg/verify-wire-schema.json` (1 pass, 0 fail).

---

## Failures 2, 3, 5 — the guest lost `PATH`

Covers `docs/extensions/examples/docs-updater/subprocess.integration.test.ts`,
`docs/extensions/examples/auto-note/e2e-server-pipeline.test.ts`, and
`src/__tests__/substack-pilot-installer.test.ts` (four of the seven failures: the substack build
plus the two credential-broker cases that cascade from it through `installationId`).

**Reproduction.**

- docs-updater, on the unmodified branch:
  `flock … bun test --timeout 30000 ./docs/extensions/examples/docs-updater/subprocess.integration.test.ts`
  fails in the build's feature-test stage with `isSelfRepo > symlink alias resolves to a real
  .../repo → true`. Receipt `/tmp/factory-platform-evidence/wreg/repro-docs-updater.json`.
- auto-note and substack-pilot-installer, with only the guest `PATH` argument removed from
  `podman.ts args()`: auto-note fails its `beforeAll` inside the guest's own `index.test.ts`, and
  the substack installer fails 3/3 (`+ (fail) real MCP stdio spawn … real Bun.spawn`).
  Receipt `/tmp/factory-platform-evidence/wreg/repro-autonote-substack.json`.

**Root cause.** A product regression from the wave-1 runtime. W02 added `--unsetenv-all` to the
`podman run` arguments (`662682a00`, "separate the declared guest environment from the runtime
residue"). That drops the pinned image's whole `ENV`, and `PATH` went with it. Before wave 1 the
guest inherited `PATH=/usr/local/sbin:/usr/local/bin:…` from the image.

A v4 extension may spawn a helper process under its shell grant, and three first-party extensions
resolve that helper by bare name, so each one stopped building:

- auto-note `index.test.ts:1487` — `Bun.spawn(["bun", …scripts/postinstall.ts])`.
- substack-pilot `tests/mcp-real-spawn.test.ts:147` — `command: "bun"`, with the test's own comment
  "PATH is required so `bun` is resolvable" and `PATH: process.env.PATH ?? ""` resolving to empty.
- docs-updater `index.ts:312` — `realPath()` calls `Bun.which("realpath")`, gets null without
  `PATH`, and falls back to a lexical `normalize` that cannot resolve a symlink alias.

The contract text (`…-contracts.md:140,156`) describes main's *declared* environment as exactly
`HOME`, `TMPDIR` and `BUN_INSTALL_CACHE_DIR`. That was true of the `--env` flags; the guest process
also carried the image's `PATH`. `--unsetenv-all` made the process environment literally those three
and broke v4 callers, so this is a runtime change to restore, not a contract change to ratify.

**Fix** (`c9d0c3a05`). The runner declares `PATH` itself instead of inheriting it: a
`guestPath` member holding the pinned image's own directory list, emitted as `--env=PATH=…`, with
`PythonPodmanRunner` overriding it for its own image exactly as it already overrides
`guestInterpreter`. `RUNNER_GUEST_ENVIRONMENT` gains `PATH`.

This keeps every property W02 established. The value is fixed and tenant-independent, carries no
host identity, and reaches only the read-only image; the environment stays declared by the runner
rather than inherited from the image; every other image variable is still dropped. The two closure
tests derive their permitted set from `RUNNER_GUEST_ENVIRONMENT`, so they still assert the exact
declared set — no assertion was relaxed. Only their prose changed ("three declared variables" →
"declared variables").

**Owner (freeze section 12).** `packages/@ezcorp/extension-runner/src/podman.ts` and the
`src/factory/runner/*` suites are Terra runtime's (W01/W02). **Disclosure to Terra runtime:**
`--unsetenv-all` removed `PATH` as collateral and broke the v4 extension spawn path; the
declared-environment property you wanted is preserved, and `guestPath` is the seam if a future image
changes its list.

**Receipts.** Repros above; verification
`/tmp/factory-platform-evidence/wreg/verify-path-docs-autonote.json` (docs-updater + auto-note, 8
pass, 0 fail) and `/tmp/factory-platform-evidence/wreg/verify-substack.json` (3 pass, 0 fail).

---

## Failure 4 — `packages/@ezcorp/extension-runner/tests/trusted-local.test.ts`

**Reproduction.** `flock … bun test --timeout 30000
./packages/@ezcorp/extension-runner/tests/trusted-local.test.ts` with the runner sources restored
from `integ/w00`: the build's diagnostics carry
`localhost/trusted-local@sha256:…: image not known`.
Receipt `/tmp/factory-platform-evidence/wreg/repro-trusted-local.json`.

**Root cause.** A product regression from the wave-1 runtime. Before wave 1, `startExecution` ran
`this.launch(workerId, limits, stage, ["./.runner/extension.js"])`, and `TrustedLocalRunner`
overrode `launch` to spawn a local `setpriv` process instead of a container. Detached execution
replaced that call with a **private** `launchDetached`, which always runs `podman run`. The
trusted-local runner has no image — its name is a synthetic `localhost/trusted-local@sha256:…`
digest — so every build now failed at its discovery worker.

W01's own revalidation note records the blind spot exactly:
"`build()`/`launch()`/`run()` are byte-for-byte unchanged; only `start()` … now routes through
`launchDetached`/`channelTransport` … proven by the full shared Podman suite passing unchanged"
(`docs/validation/factory/wave1/w01-revalidation-results.json`). `launch()` was indeed unchanged;
`start()` simply stopped calling it, and the shared Podman suite never exercises the trusted-local
runner.

**Fix** (`638f2e7d1`). `launchDetached` becomes the execution-launch seam (`protected`), and
`TrustedLocalRunner` overrides it with the same local process it already uses for build guests. The
override refuses a device grant rather than ignoring one: the mode omits every kernel control, so it
cannot hold a guest to the devices an allocation authorized. The test gained that case and its title
names it; no existing assertion changed.

**Owner (freeze section 12).** `packages/@ezcorp/extension-runner/src/podman.ts` is Terra runtime's.
`trusted-local.ts` has no section 12 row. **Disclosure to Terra runtime:** detached execution needs
a protected seam, because a runner subclass whose execution guest is not a container cannot reach a
private method; the shared Podman suite cannot see this class of break.

**Receipts.** Repro above; verification `/tmp/factory-platform-evidence/wreg/verify-trusted-local.json`
(1 pass, 0 fail, 9 assertions).

---

## Gates

- [x] G1: The generated wire schema matches the authoritative data types.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun test --timeout 30000 ./packages/@ezcorp/extension-contract/src/schema.test.ts
  EXPECT: /1 pass[\s\S]*0 fail/
  EVIDENCE: /tmp/factory-platform-evidence/wreg/verify-wire-schema.json — 1 pass, 0 fail.

- [x] G2: A v4 extension guest resolves a helper process by bare name again.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH flock /tmp/ezcorp-validation-heavy.lock timeout 1200 bun test --timeout 30000 ./docs/extensions/examples/docs-updater/subprocess.integration.test.ts ./docs/extensions/examples/auto-note/e2e-server-pipeline.test.ts
  EXPECT: /8 pass[\s\S]*0 fail/
  EVIDENCE: /tmp/factory-platform-evidence/wreg/verify-path-docs-autonote.json — 8 pass, 0 fail, 63 assertions.

- [x] G3: The substack pilot builds, seals its settings and refuses host environment through the credential broker.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH flock /tmp/ezcorp-validation-heavy.lock timeout 900 bun test --timeout 30000 ./src/__tests__/substack-pilot-installer.test.ts
  EXPECT: /3 pass[\s\S]*0 fail/
  EVIDENCE: /tmp/factory-platform-evidence/wreg/verify-substack.json — 3 pass, 0 fail, 29 assertions.

- [x] G4: The trusted-local runner builds and executes through its own launch seam and refuses a device grant it cannot confine.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH flock /tmp/ezcorp-validation-heavy.lock timeout 600 bun test --timeout 30000 ./packages/@ezcorp/extension-runner/tests/trusted-local.test.ts
  EXPECT: /1 pass[\s\S]*0 fail/
  EVIDENCE: /tmp/factory-platform-evidence/wreg/verify-trusted-local.json — 1 pass, 0 fail, 9 assertions.

- [x] G5: The full shared Podman suite and every suite that reads the declared guest environment stay green.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH flock /tmp/ezcorp-validation-heavy.lock timeout 3000 bun test --timeout 30000 <podman.integration, podman-devices.integration, channel-identity, applied-controls.integration, python-guest.integration>
  EXPECT: /0 fail/ on all five
  EVIDENCE: /tmp/factory-platform-evidence/wreg/podman-suites.json — 42 pass, 0 fail, 350 assertions (16/6/3/5/12).

- [x] G6: The canonical backend pool reports zero failures.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH flock /tmp/ezcorp-validation-heavy.lock timeout 2400 bun run test
  EXPECT: /0 fail/
  EVIDENCE: /tmp/factory-platform-evidence/wreg/backend-pool.json — **26947 pass | 0 fail | 1804 files**, exit 0, at `c8bbf95f7`, 10:44:50–10:57:07.

- [x] G7: Typecheck, lint, factory boundaries and gate integrity pass.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun run typecheck && bun run lint && bun scripts/check-factory-boundaries.ts && bun scripts/gate-integrity.ts
  EXPECT: exit 0 on all four
  EVIDENCE: /tmp/factory-platform-evidence/wreg/gates.json — all exit 0. Lint reports the eight pre-existing informational findings and no error.

- [x] G8: Every changed executable line is covered against the current base.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun scripts/merge-lcov.ts '/tmp/factory-platform-evidence/wreg/lcov/*.lcov' coverage/lcov.info && BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts && BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts
  EXPECT: both gates exit 0
  EVIDENCE: /tmp/factory-platform-evidence/wreg/gates.json — "no new source files in this diff"; "all changed executable lines covered (3 file(s))". Per file: `podman.ts` LF:402 LH:396 (the six misses are pre-existing, none on a changed line), `python.ts` 84/84, `trusted-local.ts` 23/23.

## What was not weakened

No test was skipped, relaxed or deleted; no threshold was lowered; no `EXCLUDES` entry was added.
The two guest-environment closure tests keep their assertions and read the exported constant, and
`trusted-local.test.ts` kept every assertion it had and gained one behavior.

## Receipts

All under `/tmp/factory-platform-evidence/wreg/`: `repro-wire-schema.json`, `verify-wire-schema.json`,
`repro-docs-updater.json`, `repro-autonote-substack.json`, `repro-trusted-local.json`,
`verify-path-docs-autonote.json`, `verify-substack.json`, `verify-trusted-local.json`,
`podman-suites.json`, `coverage-producers.json`, `gates.json`, and `backend-pool.json`. Each names
its log under `logs/` with that log's SHA-256.
