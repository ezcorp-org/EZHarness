# Gates: W18 wave-1 coverage and CI framework

Scope: the FRAMEWORK AND REGISTRATION half of W18. The final seven-lane
enforcement gate runs after W13–W17 and is not claimed here. Every result below
is LOCAL. None of it claims hosted enforcement: no required check is registered,
no runner exists, and no secret is provisioned.

Receipts live under `/tmp/factory-platform-evidence/w18/`, indexed by
`RECEIPTS.md` with checksums in `SHA256SUMS`. Producing commits are named per
gate. The working tree was clean at every producer run.

- [x] G1: All seven exact C11 lanes exist as jobs with real producers, artifacts, runner labels, and readiness dependencies.
  CHECK: `bun scripts/check-factory-lanes.ts`
  EXPECT: exit 0, "C11 lane inventory passed: 7 lanes"
  EVIDENCE: `bdb1cca4a`. Four lanes were added (`Factory runner contracts`, `Factory assurance and release`, `Factory isolation`, `Factory product and domain E2E`, `Factory deployment and operations`); two existed. The gate judges the commands a job RUNS with YAML comments stripped, not its name.

- [x] G2: The lane gate rejects every way a lane can be hollowed out.
  CHECK: `bun test --timeout 60000 ./scripts/check-factory-lanes.test.ts`
  EXPECT: 19 pass, 0 fail
  EVIDENCE: `bdb1cca4a`. Deliberate violations, each asserted individually: renamed job, producer replaced by `echo skipped`, producer present only in a comment, artifact renamed, `if-no-files-found: warn`, `needs:` removed from a labelled lane, runner label swapped for `ubuntu-latest`, `continue-on-error: true`, and an unsupplied workflow file.

- [x] G3: W00 discrepancy 12 — the five unregistered PostgreSQL suites are registered in a producer, and the registration is derived from disk.
  CHECK: `bun test --timeout 60000 ./scripts/factory-postgres-suite-registration.test.ts`
  EXPECT: 5 pass, 0 fail; 0 unregistered suites
  EVIDENCE: `bdb1cca4a`. The gate derives the requirement from `tests/postgres/` on disk, so the next unregistered suite fails closed instead of waiting for an audit.

- [x] G3a: The five suites PASS against real PostgreSQL and real S3.
  CHECK: `bun test --timeout 180000 --coverage` over the five files with `FACTORY_TEST_POSTGRES_URL` and `EZCORP_FACTORY_STORAGE_SECRETS_DIR`, under the heavy lock
  EXPECT: exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w18/postgres-five-suites.log` and `.meta` — exit 0, 40 pass / 0 fail / 269 assertions in 20.65 s, from clean committed source `6751f08b5` against `factory-platform-proof-postgres` on 127.0.0.1:46343 and both SeaweedFS servers. `bun scripts/verify-factory-storage.ts` passed first: 10 tenant identities across ordinary and archive storage.
  HISTORY: the first attempt at 2026-09-13T14:15:54-04:00 exited 1 with `PostgresError: Connection closed` on all five, during the host outage described below. That receipt is retained as `postgres-five-suites-FAILED-oom-window.log`.

- [x] G4: W00 discrepancy 17 — both guarded runner labels have a consuming job that cannot queue behind an absent runner.
  CHECK: `bun scripts/check-factory-lanes.ts` (its `unconsumedRunnerLabels` leg)
  EXPECT: no "guarded by the readiness precheck but no C11 lane job requests it"
  EVIDENCE: `bdb1cca4a`. `factory-isolation` requests `factory-gpu`; `factory-product-e2e` and `factory-deployment-operations` request `factory-real`; all three declare `needs: [factory-runner-readiness]`.

- [x] G5: Strict Python lint, strict types, standard-library test discovery, and coverage.py LCOV run from the repository pins.
  CHECK: `bash scripts/python-quality.sh all`
  EXPECT: exit 0; ruff clean; mypy --strict clean; 15 tests; c02_runner.py at 100% statements and branches
  EVIDENCE: `eb0eb799c`; `/tmp/factory-platform-evidence/w18/python-lane-receipt.md`. Interpreter 3.13.12 matches `.python-version`; dependencies from the committed `uv.lock` via `uv sync --locked`.

- [x] G6: Every Python lane input failure is a non-zero exit, not a skip.
  CHECK: the five probes recorded in the receipt
  EXPECT: exit 1 for empty discovery, pin skew, absent lock, absent project; exit 2 for an unknown mode
  EVIDENCE: `/tmp/factory-platform-evidence/w18/python-lane-receipt.md`. Each probe removed one real input and recorded the exact exit code and message.

- [x] G7: Python source is registered in the coverage gates with its own producer tag.
  CHECK: `scripts/coverage-config.ts` SOURCE_GLOBS and `canonicalCoverageProducer`; `scripts/coverage-thresholds.json`
  EXPECT: one scoped glob, a wildcard key and a per-file key at 100, no catch-all, `TN:ezcorp-python-coverage`
  EVIDENCE: `eb0eb799c`. The merged LCOV carries one `SF:src/factory/runner/python/c02_runner.py` record; a Bun leg can never stand in for it because `canonicalCoverageProducer` pins every `.py` path to the Python producer.

- [x] G8: A hand-edited generated factory schema fails CI.
  CHECK: `bun test --timeout 120000 ./scripts/check-schema-generate-drift.test.ts`; `bun scripts/check-schema-generate-drift.ts`
  EXPECT: 14 pass, 0 fail; the CLI exits 0 on the committed tree and restores its bytes
  EVIDENCE: `8b60685a0`. Freeze open question 32, default yes. The checked set is derived from the package's own `--out` arguments and cross-checked against `*.schema.json` on disk, so neither a new generated schema nor a hand-written one escapes it.

- [x] G9: The C13 reuse inventory covers every shared module the integrated factory modules import.
  CHECK: `bun test --timeout 120000 ./scripts/factory-c13-inventory.test.ts`; `bun scripts/check-factory-boundaries.ts`
  EXPECT: 0 undeclared edges; boundary gate exit 0
  EVIDENCE: `2fba1851b`. The real integ/w00 graph has 46 reuse edges and 12 were declared, so 34 were un-gated. The test re-derives the graph on every run, so the inventory is self-maintaining.

- [x] G10: The boundary checker rejects deliberate violations of real declarations.
  CHECK: `bun test --timeout 120000 ./scripts/factory-c13-inventory.test.ts ./scripts/check-factory-boundaries.test.ts`
  EXPECT: 33 pass, 0 fail
  EVIDENCE: `2fba1851b`. A real declared import removed from a real factory module and a duplicate of a real shared function signature are both rejected; a same-name different-shape function is not, proving the check is not a name ban.

- [x] G11: The type-only LCOV correction holds, and runtime-bearing TypeScript still fails without coverage.
  CHECK: `bun test --timeout 60000 ./src/__tests__/gate-scripts.test.ts`
  EXPECT: the `shouldFailOnLcovAbsence` suite passes, including the enum and `const` cases
  EVIDENCE: `b6cfa4798` (already in integ/w00) plus the end-to-end case in `scripts/check-patch-coverage-typeonly.test.ts`. See the note below.

- [x] G12: The `factory-services` browser lane is registered in every canonical consumer and fails closed while empty.
  CHECK: `bun test --timeout 180000 ./src/__tests__/e2e-lanes.test.ts`
  EXPECT: 24 pass, 0 fail
  EVIDENCE: `9bc39a30c`. Registered in the manifest, `LANE_NAMES`, the collector, the merger, the local driver, the mock `testIgnore` partition, and the ci.yml job. No existing lane loses a spec. The lane is empty by design: W14 owns its specs and its Playwright configuration, and four guards stop an empty lane from being collected as a pass.

- [x] G13: The read-only GitHub inspection is refreshed and the external changes are prepared, not applied.
  CHECK: `bun scripts/check-required-checks.ts`; `bun scripts/check-factory-runners.ts`
  EXPECT: both exit 1 with the exact missing lists
  EVIDENCE: `fe9a7636e`; `/tmp/factory-platform-evidence/w18/required-checks.log`, `runner-readiness.log`, `gh-inspection.log`. 0 runners, 0 secrets, 10 of 21 required contexts. `docs/validation/factory/stage-2b/` carries the exact payload, labels, and secret names. Stage 1 and stage 2a are untouched history.

- [x] G14: The Python producer is registered in the canonical local pipeline, so its own wildcard gate cannot red every local run.
  CHECK: `bun test --timeout 180000 ./scripts/python-quality-registration.test.ts ./src/__tests__/coverage-leg-lcov-guard.test.ts`; `COVERAGE_LEGS_ONLY=1 bash scripts/test-coverage.sh`
  EXPECT: 56 pass, 0 fail; legs-only exit 0 with 9 shards and no Python leg
  EVIDENCE: `dc122aa21`; `/tmp/factory-platform-evidence/w18/cov-legs2.log` (1437 pass / 0 fail, exit 0). Registered in full local mode only, like the Web Vitest receipt, because CI publishes the same producer from the one job that installs the pinned uv. Its exit gates the COVERAGE verdict.

- [x] G15: The whole W18 surface passes the repository's own checks.
  CHECK: `bun run typecheck`; `bun run lint`; `BASE_REF=integ/w00 bun scripts/gate-integrity.ts`; both `BASE_REF=integ/w00` coverage gates
  EXPECT: all exit 0
  EVIDENCE: `/tmp/factory-platform-evidence/w18/RECEIPTS.md`. 425 tests pass across the 16 W18 suites; 3 new source files gated at 100%; all changed executable lines covered across 5 files. The 8 remaining biome infos are pre-existing in files W18 did not touch.

- [ ] G16: Hosted enforcement. NOT CLAIMED IN THIS WAVE.
  CHECK: `bun scripts/check-required-checks.ts` after an administrator applies `docs/validation/factory/stage-2b/branch-protection-required-status-checks.json`
  EXPECT: exit 0
  EVIDENCE: none. No runner is registered, no secret is provisioned, and no required check is added. The three labelled lanes are expected to be RED until those exist; that is the designed fail-closed state, not a defect.

- [ ] G17: A deliberate lane failure blocks the candidate, then is removed with both results retained. NOT CLAIMED IN THIS WAVE.
  CHECK: a temporary failing assertion on a branch, then its removal
  EXPECT: two retained hosted results
  EVIDENCE: none. Requires hosted enforcement from G16.

- [ ] G18: The full feature diff passes the new-file and patch gates. NOT CLAIMED IN THIS WAVE.
  CHECK: `BASE_REF=2588c9f19edcae24273f4a2049eb3ac37bd6f920 bun scripts/check-new-file-coverage.ts && ... check-patch-coverage.ts`
  EXPECT: exit 0 after W13–W17
  EVIDENCE: reproduced and recorded as the backlog below, not fixed by exclusion.

## W18 backlog: the reproduced full-diff coverage gaps

Base `2588c9f19edcae24273f4a2049eb3ac37bd6f920`. The W00 recheck logs
(`docs/validation/factory/w00/w18-backlog-*`) came from FOCUSED producers and
overstated the gap, so the list below is a canonical-pipeline reproduction from
`79c589dfd` on a REPAIRED host: the full host pool (`SHARD_INDEX=0
SHARD_TOTAL=1`, 1705 files, 25764 pass / 0 fail, exit 0), all nine coverage
legs, the Web Vitest V8 leg (590 files / 7437 tests), the Python producer, the
five real-PostgreSQL suites, and the W00 staging merged LCOV, merged with
`scripts/merge-lcov.ts` into 1874 source records.

| Producer set | new-file violations | patch violations |
| --- | --- | --- |
| W00 recheck logs (focused producers) | 41 | 75 |
| W00 staging merged LCOV alone | 35 | 67 |
| + host pool, nine legs, Python producer | 21 | 17 |
| + Web Vitest V8 leg | 16 | 12 |
| + repaired host pool, PostgreSQL suites, closure tests (final) | 16 | 12 |

Receipts: `/tmp/factory-platform-evidence/w18/backlog-final-new-file.log` and
`backlog-final-patch.log`, both exit 1. More than half of the originally
reported gap was producer absence, not missing tests. Nothing below is excluded
and no threshold is lowered.

### Missing producer, not missing coverage (6 of the 16)

Five files are `ezcorp-browser-v8` canonical and one is `ezcorp-node-v8`
canonical. The browser route-coverage lane did not run on this host: it needs a
prior verified receipt that `bun run test:coverage` refuses to synthesise, and
the shared container runtime was down (see the blocker below). A Bun leg may
not stand in for either producer.

- browser: `web/src/lib/factory/FactoryConsole.svelte`, `FactoryGraph.svelte`, `FactoryGraphBoundary.svelte`, `FactoryNode.svelte`, `web/src/routes/(app)/factories/+page.svelte`
- Node/V8: `web/src/routes/(app)/factories/+page.server.ts`

### Genuinely ungated new files (8) — need a threshold key

- `src/db/migrations/add-factory-projection-attempts.ts`
- `src/db/migrations/repair-transactional-audit-metadata.ts`
- `src/factory/private-files.ts`
- the five `web/src/routes/api/factories/projects/[projectId]/...` run and control routes (W14)

### Genuinely unmeasured new files (2) — no test loads them under coverage

- `packages/@ezcorp/factory-sdk/src/kernel-types.ts` (W01/W03 own the kernel event set)
- `src/factory/provisioning/local.ts` (W16)

### Genuinely uncovered changed lines (10 files, 87 lines)

`src/factory/pool/service-server.ts` (35), `src/factory/pool/service.ts` (15),
`web/src/lib/server/security/bearer-auth.ts` (15),
`src/factory/encryption.ts` (10),
`packages/@ezcorp/extension-runner/src/service.ts` (6),
`src/auth/jwt.ts` (1), `src/factory/private-files.ts` (1),
`src/runtime/factory-execution.ts` (1), `src/runtime/tools/shell.ts` (1),
`web/src/hooks.server.ts` (1).

W18 closed the one entry it owned: the repaired host pool exposed two uncovered
lines in `scripts/check-factory-boundaries.ts` (the recursion inside
`localImportClosure`), and `79c589dfd` covers them with real multi-hop, cycle,
and non-local-specifier cases. That file now measures 297/297.

### Python source outside the locked project (in no gate)

`packages/@ezcorp/extension-runner/src/peer-gateway.py` (71 lines, fully
unannotated) and `scripts/fixtures/factory-local-gpu.py` (23 lines, imports
`torch`, which is absent from `uv.lock`). The Python SOURCE_GLOBS entry is
scoped to the locked project rather than `**/*.py`, so these two are recorded
here instead of being pulled into a gate nothing can satisfy.

### Deferred ruff rules

`I001`, `S603`, and `E501` fail on `src/factory/runner/python/c02_runner.py`,
which W02 owns. They are left out of the rule SELECTION rather than silenced
with a per-file ignore.

## Host outage during this package, and the reruns that replaced it

A kernel OOM at 13:38 EDT, caused by an unrelated 20 GB run in another session,
killed the per-user systemd manager and the PostgreSQL proof container's
processes. While it was down, `/run/user/1001/bus` refused connections, `crun`
could not delegate cgroups, podman started no container, and
`factory-platform-proof-postgres` reported `Up 17 hours` from stale state while
its recorded PID did not exist.

Three receipts were produced inside that window and are retained as history,
each renamed with a `-FAILED-oom-window` suffix:

| Receipt | What it recorded |
| --- | --- |
| `postgres-five-suites-FAILED-oom-window.log` | exit 1, `PostgresError: Connection closed` on all five suites in 747 ms |
| `cov-host-FAILED-oom-window.log` | 22 host-pool failures, 18 of them `crun: sd-bus call: Access denied` |
| `canonical-test-coverage.log` | the same 18 container failures plus the browser-receipt precondition |

The coordinator repaired the host. Both affected producers were rerun under the
heavy lock from the same clean commit and their receipts replaced; the numbers
in the backlog table above are from the reruns.

## Defect routed to W02

`jsonschema.exceptions.SchemaError` is not a subclass of `ValueError`, so
`Draft7Validator.check_schema(schema)` at `c02_runner.py:54` escapes the
`except (OSError, ValueError, SchemaError, json.JSONDecodeError)` handler at
line 63. A malformed generated schema crashes the Python runner with a
traceback instead of the documented `{"ok": false, "error": ...}` envelope and
exit 1. W18 did not modify product source, and deliberately did NOT add a test
asserting the defective behaviour.
