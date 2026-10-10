# Gates: W4H-20 — the four biome lint warnings on integ/w00

Scope: `bunx biome lint` at integ/w00 `95bc71b20` gave 0 errors and 4 warnings in three files (the brief said "four
files"; it is three files, four warnings; the lead accepted this reading). The hosted lint job was green; the standard is
zero warnings.

Branch `wp/w4h-20-lint-warnings` from integ/w00 `95bc71b20`. Fix commit `ae1612f2f`. Evidence directory:
`/tmp/factory-platform-evidence/w4h-20/`, written `w4h-20/` below. Validator: validator-8. Integrator: integrator-5.

## Root cause

1. `scripts/lcov-artifact-names-registration.test.ts:126` and `:136`, `scripts/setup-factory-python-base.test.ts:101`
   (noTemplateCurlyInString): the strings hold GitHub workflow expressions (`${{ matrix.i }}`, `${{ matrix.shard }}`) on
   purpose. They are workflow text, not JS templates, but a plain string that holds `${` reads like a template mistake.
2. `tests/postgres/helpers/factory-recovery-databases.ts:50` (noCommaOperator): the class field ran the Bun SQL
   pipelining assertion and then made the admin client in one comma expression.

## Fix

- `scripts/lib/ci-registration.ts` (the shared module for CI registration tests; both test files already import it)
  gains `ghExpr(expression)`, a template that returns the literal `${{ <expression> }}`. The three sites build their
  text with it. One definition serves three sites and the lint rule stays on everywhere. This is DRY-er than three
  `biome-ignore` comments, which would each repeat the reason and switch the rule off on those lines. The literal is
  checked against real workflow text: the setup-factory-python-base test compares a `ghExpr` result with ci.yml's step name.
- `tests/postgres/helpers/factory-recovery-databases.ts`: `adminSql()` runs `assertBunSqlPipeliningOff()` and then
  returns `new SQL(adminUrl(), { max: 1 })`. The field stays `private readonly admin = adminSql();`. The assertion still
  runs before the client is made. Behaviour is unchanged.
- No biome.json change. No other file.

## Gates

The gate file is force-added because of the bare `tasks` rule at .gitignore:8 (established practice).

- [x] G1 (R1): red first at base. CHECK: `bash w4h-20/scripts/lint4.sh` at `95bc71b20` (clean tree). EXPECT: the 4
  warnings at :126:43, :136:78, :101:89 (noTemplateCurlyInString) and :50:56 (noCommaOperator); "Found 4 warnings".
  EVIDENCE: `w4h-20/r1-red-lint.log` (sha256 b52e44dae8689b0a2f092734974ce9f40e7f8e9ca68133d764079b51b9d8badf).
- [x] G2 (R2): lint green. CHECK: `bash w4h-20/scripts/lint-r2.sh` (the four changed files, then `bunx biome lint .`) and
  `bash w4h-20/scripts/check4.sh` (the hook's `biome check`). EXPECT: 0 warnings, 0 errors, rc 0 for the files and for the
  repo (6145 files). EVIDENCE: `w4h-20/r2-green-lint.log`, `w4h-20/r2-biome-check.log`, `w4h-20/legs-ae1612f2f/lint-repo.log`
  (`bun run lint`, rc 0, no warning).
- [x] G3 (R2): the touched tests pass, each file alone with lcov. CHECK: `bash w4h-20/scripts/unit-lcov.sh`. EXPECT:
  lcov-artifact-names-registration 4 pass / 0 fail; setup-factory-python-base 10 / 0; scripts/lib/ci-registration 16 / 0.
  EVIDENCE: `w4h-20/r2-unit-lcov.log`, `w4h-20/lcov/*/lcov.info`.
- [x] G4 (R2): the suite that imports the helper, on the hold's OWN PostgreSQL (`w00/own-pg.sh`, pgvector pg15, server
  15.19; never the shared proof server). CHECK: `tests/postgres/factory-restore.test.ts` with lcov in `w4h-20/scripts/heavy.sh`
  under `w00/gated-flock.sh`. EXPECT: 17 pass / 0 fail; container removed with -v. EVIDENCE:
  `w4h-20/heavy-20261009T222741Z/restore-suite.log` (17 pass, 97 expect calls) and try 2 `w4h-20/heavy-20261009T220700Z/`
  (17 / 0; byte-equal lcov). Try 1 (`heavy-20261009T220241Z`, 0 pass / 1 fail) is VOID by a defect in MY script: it did
  not export `EZCORP_FACTORY_STORAGE_SECRETS_DIR`. It is kept as evidence; it is not a code failure.
- [x] G5 (R2): 100 percent of changed lines. CHECK: `bash w4h-20/scripts/patch-cov.sh <restore lcov dir>` (merged lcov of
  the three unit files and the restore suite; `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts` and
  `check-new-file-coverage.ts`). EXPECT: patch gate PASSED (1 file); new-file gate vacuous (no new source file); every
  added executable line hit. EVIDENCE: `w4h-20/patch-cov.log`: ci-registration.ts:56 and :57 hit;
  factory-recovery-databases.ts:42, :43, :44 and :55 hit. That file is outside SOURCE_GLOBS, so the patch gate does not judge it; the
  lcov lines prove it anyway. Note: ci-registration.test.ts alone does not run line 56; the two consumer tests run it.
- [x] G6 (legs): typecheck under the tc rule. CHECK: `bun run typecheck` and `web` `bun run check` through `w00/tc-gate.sh`
  in the hold (TC_IN_LOCK=1). EXPECT: both exit 0. EVIDENCE: `w4h-20/heavy-20261009T222741Z/typecheck.log`,
  `svelte-check.log` (620 files, 0 errors, 0 warnings), `tc-gate.log` (MemAvailable 18.6 GiB before, 15.4 GiB lowest).
  Tries 1 and 2 read svelte-check RED "another typecheck runs" (exit 75, not run). At 22:04:35Z the holder was a real
  other typecheck. At 22:09:47Z it was the `sleep 2` of tc_run's own memory sampler, which inherits the lock fd. heavy.sh now
  probes the lock for at most 5 s before svelte-check. The shared tc-gate.sh is not changed (reported to the lead).
- [x] G7 (legs): static legs. CHECK: `bash w4h-20/scripts/legs.sh`. EXPECT: boundaries 0 violations; factory boundaries
  pass; gate-integrity vs integ/w00 PASSED; gate-integrity vs origin/main exactly the 8 known coverage-tool findings, no
  new line; prune scan clean (0 hits). EVIDENCE: `w4h-20/legs-ae1612f2f/*.log`.
- [x] G8 (legs): guard set under the heavy lock. CHECK: `w00/guard-suites.sh` list (41 files) in `w4h-20/scripts/heavy.sh`.
  EXPECT: nonzero count, 0 fail. EVIDENCE: `w4h-20/heavy-20261009T222741Z/guard-set.log` (511 pass, 2 skip, 0 fail).
- [x] G9 (hook): hook-mapped suites. CHECK: the fix commit's pre-commit hook; `w4h-20/scripts/hook-map.sh`. EXPECT: 3
  suites (lcov-artifact-names-registration, lib/ci-registration, setup-factory-python-base) = 30 pass / 0 fail.
  EVIDENCE: `w4h-20/commit-fix-hook.log`, `w4h-20/hook-map-fix.txt`.

## Review

The four warnings are gone at their root, and the rule is not weakened. Four files are changed, with no biome.json change.
Every leg is green at `ae1612f2f`. Two defects were found and are disclosed: my first hold missed the S3 credential
directory (G4 try 1), and the shared tc-gate sampler holds the typecheck lock for up to 2 s (G6). One small note outside
scope: web's Vite config prints a `configLoader: 'native'` warning (an import without a file extension, vite.config.ts:6).
