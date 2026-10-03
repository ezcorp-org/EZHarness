# Gates: W4H-5 — the run lifecycle suite's 'publication' credential set on the hosted runner

Scope: hosted CI run 37138524741 at 52d8ba079 failed 12 tests of the factory run lifecycle suite in two jobs:
"Coverage shard 11" (`src/__tests__/factory-run-lifecycle.test.ts`, PGlite) and "External Postgres (Bun.sql)"
(`tests/postgres/factory-run-lifecycle.test.ts`, step `bash scripts/factory-compute-admissions-coverage.sh`). Seven fail
with "Factory storage credential set 'publication' is missing or malformed"; five approval tests fail in cascade at
`factory-run-lifecycle-suite.ts:230` (they read a notification that a failed release test left behind).

Branch `wp/w4h-5`, base integ/w00 `52d8ba079`. Evidence directory: `/tmp/factory-platform-evidence/w4h-5/`, written
`w4h-5/` below. integrator-3 merges.

## Root cause (differs from the brief's assumption)

The brief assumed the hosted jobs lack the factory storage credential dir and an S3 service. They do, but these tests
need neither. Both failing variants use the suite's in-memory S3 store (`fixture.publication` is undefined). The suite
wrote the 'publication' set below `mkdtemp(join(process.env.HOME, ...))` (suite line 1102 at the base). On the hosted
runner `$HOME` is an owned 0755 directory, and the private reader (`src/factory/private-files.ts`, the W4G-4 rule)
refuses a private file below it. `loadFactoryStorageCredentials` maps that refusal to "missing or malformed". W4G-4 moved
the other suites to `makeFactoryTempPrivateRoot` and missed this one, because no check named the rule.

Proof: the same runner-shaped container with a 0700 home, still without a credential dir or S3, is green (G2).
The only suite that uses real S3, `tests/postgres/factory-run-lifecycle-s3.test.ts`, already runs after "Start factory
object storage" in db-postgres.yml and is green on the hosted run. So no workflow change, service, or generated set is
part of this package (reported to the coordinator in report 1).

Runner-shaped container (`w4h-5/image/Containerfile`): Ubuntu 24.04, user `runner` uid 1001, home 0755, the checkout
at `/home/runner/work/EZHarness/EZHarness` from a clean `git archive`, Node 24.14.1 (official tarball, sha256 checked),
the pinned Bun 1.4.2 mounted read-only, `--cpus 4 --memory 14g`, no `EZCORP_FACTORY_STORAGE_SECRETS_DIR`, no
`XDG_RUNTIME_DIR`. Install: `bun install --frozen-lockfile --ignore-scripts && bun run build:packages` (the archive has
no .git for the hook installer). The PostgreSQL legs use a throwaway `pgvector/pgvector:pg15` (the job's service image),
own name `w4h5-pg`, no host port, a fresh random password in a 0600 file passed by variable name, never printed; the
container is removed with its volumes after each leg.

## Gates

- [x] G1: red, coverage shard shape. CHECK: `bash w4h-5/run.sh 52d8ba079 lifecycle 755 red-lifecycle-home755` EXPECT: the hosted 12 fails, same errors. EVIDENCE: `w4h-5/logs/red-lifecycle-home755.log` (80 pass / 12 fail; 7x "credential set 'publication' is missing or malformed", 3x Received "approval_requested", 1x "release_settled").
- [x] G2: control, root cause. CHECK: `bash w4h-5/run.sh 52d8ba079 lifecycle 700 red-lifecycle-home700` EXPECT: green with no credential dir and no S3. EVIDENCE: `w4h-5/logs/red-lifecycle-home700.log` (92 pass / 0 fail).
- [x] G3: red, external-postgres shape. CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 1500 bash w4h-5/pg-leg.sh 52d8ba079 755 red-lifecycle-pg-home755` EXPECT: the hosted 12 fails. EVIDENCE: `w4h-5/logs/red-lifecycle-pg-home755.log` (80 pass / 12 fail, same errors).
- [x] G4: guard red at the base. CHECK: `bash w4h-5/guard-run.sh <base snapshot> red-guard-base` EXPECT: names the suite line. EVIDENCE: `w4h-5/logs/red-guard-base.log` (1 pass / 1 fail, finding `src/__tests__/helpers/factory-run-lifecycle-suite.ts:1102`).
- [x] G5: fix commit e4059c18f; hook mapped 1 suite (`scripts/factory-private-root-registration.test.ts`, 2 pass / 0 fail). EVIDENCE: `w4h-5/logs/commit-1.log`.
- [x] G6: green, coverage shard shape. CHECK: `bash w4h-5/run.sh e4059c18f lifecycle 755 green-lifecycle-home755` EXPECT: 0 fail, home 0755, no credential dir. EVIDENCE: `w4h-5/logs/green-lifecycle-home755.log` (92 pass / 0 fail).
- [x] G7: green, external-postgres shape. CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 2400 bash w4h-5/green-heavy.sh e4059c18f` EXPECT: 0 fail. EVIDENCE: `w4h-5/logs/green-heavy-2.log` (SUITE rc=0, 92 tests; lock held 19:15:43Z to 19:17:06Z). Its leg log `green-lifecycle-pg-home755.log` was overwritten by the G17 rerun at 1fa4a5354 (same label), which is also 92 pass / 0 fail. The first queue of this batch (`logs/green-heavy.log`) stopped at the resource gate (SwapFree 1 GiB) and ran nothing.
- [x] G8: coverage. The changed lines are test code only (`**/__tests__/**` is excluded; the guard is a test file), so no source line is new or changed. CHECK: the coverage legs of `green-heavy.sh`, then `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts` and `check-patch-coverage.ts` EXPECT: rc 0. EVIDENCE: lifecycle suite 92 pass / 0 fail and guard 2 pass / 0 fail under `--coverage` (`w4h-5/logs/cov-*.log`); new-file gate rc 0 "no new source files in this diff"; patch gate rc 0 "all changed executable lines covered (0 file(s))" (`w4h-5/logs/new-file-coverage.log`, `w4h-5/logs/patch-coverage.log`).
- [x] G9: static and guard legs at e4059c18f. CHECK: `bash w4h-5/light.sh` EXPECT: all rc 0. EVIDENCE: lint rc 0 (`logs/lint.log`), check-factory-boundaries rc 0, gate-integrity rc 0, typecheck rc 0 (`logs/typecheck.log`), guard set 37 files 470 pass / 0 fail with the new guard listed (`logs/guard-set.log`, `guard-list.txt`).
- [x] G10: secrets. No credential value or PostgreSQL URL in argv, logs or receipts: `grep -c -E "postgres://|POSTGRES_PASSWORD="` over `w4h-5/logs/*.log` finds none; the host's tmpfs credential dir and the proof PostgreSQL were never read. Shared `.git/config` sha256 stays `44962525…`.

## Coordinator widening (2026-10-03): one storage action and the R10 stop guard

The coordinator accepted report 1 and asked for (1) ONE composite action for the three copies of "Start factory object
storage", with a pin test, and (2) classifier cause R10: in external-postgres the always() stop step ran `down` after
the start step was skipped, and failed with "Set the generated credential directory before stop." (hosted log line 1225).

Commit 1fa4a5354. Action `.github/actions/factory-storage` (`command: up|down`) runs `scripts/setup-factory-storage.sh`;
the image digest and the ports stay in `compose.factory-storage.local.yml`. Call sites (start id `factory-storage-up`,
stop `if: always() && steps.factory-storage-up.outcome != 'skipped'`):
- ci.yml factory-deployment-operations (self-hosted factory-real)
- db-postgres.yml external-postgres
- db-postgres.yml factory-assurance-release

- [x] G11: pin test red before the workflow change. CHECK: `bash w4h-5/one-test.sh ./scripts/factory-storage-action-registration.test.ts red-storage-action` EXPECT: the call-site test fails. EVIDENCE: `w4h-5/logs/red-storage-action.log` (3 pass / 1 fail: no job used the action).
- [x] G12: pin test green; it also names a stop without the guard, a start without the id, and a stray order (unit cases). EVIDENCE: `w4h-5/logs/green-storage-action.log` (4 pass / 0 fail); hook at 1fa4a5354 ran 3 suites: check-factory-lanes 20/0, factory-postgres-suite-registration 6/0, factory-storage-action-registration 4/0 (`w4h-5/logs/commit-3.log`).
- [x] G13: every test that reads a workflow, one per process. CHECK: `bash w4h-5/readers.sh` EXPECT: rc 0. EVIDENCE: `w4h-5/logs/readers.log` (21 files, all 0 fail; the two DATABASE_URL suites are not workflow-shape tests and are left out). `bun scripts/check-factory-lanes.ts`: 7 lanes passed.
- [x] G14: actionlint 1.7.12 on ci.yml and db-postgres.yml: only the 3 unknown self-hosted label findings (factory-gpu, factory-real x2), the same 3 as at the base. EVIDENCE: `w4h-5/logs/actionlint.log`.
- [x] G15: static and guard legs at 1fa4a5354: lint, boundaries, gate-integrity rc 0; guard set 38 files 474 pass / 0 fail (`bash w4h-5/light.sh`).
- [x] G16: shard-shape container green at 1fa4a5354: 92 pass / 0 fail (`w4h-5/logs/green2-lifecycle-home755.log`).
- [x] G17: heavy batch at 1fa4a5354 (postgres-shape container leg + coverage of the 5 changed or new suites + coverage gates). CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 2400 bash w4h-5/green-heavy.sh 1fa4a5354` EVIDENCE: `w4h-5/logs/green-heavy-3.log` (lock 21:24:57Z to 21:27:04Z; the worktree had only these two docs files dirty). Postgres-shape leg at 1fa4a5354: 92 pass / 0 fail (`logs/green-lifecycle-pg-home755.log`). Coverage: lifecycle 92/0, private-root guard 2/0, check-factory-lanes 20/0, storage action 4/0, postgres registration 6/0; new-file gate rc 0; patch gate rc 0 "all changed executable lines covered (1 file(s))" (scripts/check-factory-lanes.ts).

