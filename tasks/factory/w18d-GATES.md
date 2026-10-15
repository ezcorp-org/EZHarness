# Gates: W18d mutation tooling after the Vitest 5.0.0 bump

Scope: main's Vitest 5.0.0 bump (`96e7ee58c`) broke Stryker's per-mutant test selection.
Branch `wp/w18d-mutation`, cut from `integ/w00` at `0a95d765b`. Receipts are under
`/tmp/factory-platform-evidence/w18d/`: JSON receipts in `receipts/` and raw logs in `logs/`.
The driver scripts are in `scripts/`.

## Reproduction, before any change

`run-format.ts` exists only on W14's branch, so the control runs at W14's code head `4b96f6f77`.
The commit before the bump (`d2b76e41a`) has no factory console files at all. So the "before"
side is the same tree with only the bump reverted: `web/package.json` reversed from `96e7ee58c`
and `web/bun.lock` re-resolved to Vitest 4.1.11. Nothing else differs.

Each Stryker run uses the committed `web/stryker.config.json` plus the gate threshold, which is
the same derived config `scripts/mutation.ts` writes. The command is
`npx stryker run .stryker-run.json --mutate src/lib/factory/<file>`.

| receipt | tree | Vitest | score | killed / timeout / survived | tests per mutant |
|---|---|---|---|---|---|
| diag-runformat-v4 (4 workers) | 4b96f6f77 with Vitest reverted | 4.1.11 | 97.98 | 97 / 0 / 2 | 1.89 |
| diag-runformat-v5 (4 workers) | 4b96f6f77 | 5.0.0 | 9.09 | 9 / 0 / 90 | 0.70 |
| control-runformat-vitest4 | 4b96f6f77 with Vitest reverted | 4.1.11 | 97.98 | 97 / 0 / 2 | 1.18 |
| control-runformat-vitest5 | 4b96f6f77 | 5.0.0 | 61.62 | 9 / 52 / 38 | 0.85 |
| runstream-vitest4 | 4b96f6f77 with Vitest reverted | 4.1.11 | 93.46 | 281 / 5 / 19 | 2.38 |
| runstream-vitest5 | 4b96f6f77 | 5.0.0 | 57.19 | 0 / 175 / 130 | 0.00 |

The `control-*` and `runstream-*` rows use Stryker's default concurrency (31 workers), as CI
does. The Vitest-reverted worktree is dirty by exactly those two files, and its receipts record
`dirtyFiles: 2`. In the broken runs every Survived mutant and every Timeout mutant has
`testsCompleted: 0` (`control-runformat-vitest5`: 38 and 52; `runstream-vitest5`: 130 and 175).
The broken timeouts are therefore also artifacts, and they inflate the score, because Stryker
counts a timeout as detected.

## Root cause

Vitest 5 matches `testNamePattern` against `fullTestName`, which is the suite chain joined with
`" > "` (`createTaskName`, `vitest/dist/task-utils.js`). Vitest 4 matched against
`getTaskFullName`, which joins with a space. `@stryker-mutator/vitest-runner` 10.0.0 builds its
per-mutant filter from test names joined with a space. So every test inside a `describe` block is
filtered out, and a covered mutant runs zero tests and is reported Survived. Top-level tests and
static mutants (which run without a filter) still work, which explains the few kills.

Evidence:

- A Vitest node-API probe that repeats the runner's `start()` with the filter ran 0 tests on
  every run under 5.0.0 and every test under 4.1.11 (`scripts/probe/bail-node.mjs`).
- A second probe showed that the setup-file hooks, `inject`/`provide`, `suite.meta` and the
  `related` filter all still work under Vitest 5 (`scripts/probe/`, `scripts/related-probe.mjs`).
- Upstream reports the same defect as stryker-js issue 6210, with open fixes in PR 6214 and
  PR 6220. 10.0.0 is still the latest release (npm, 2026-09-25).

## Fix

- `81dfe3cb4`: a Bun `patchedDependencies` patch
  (`web/patches/@stryker-mutator%2Fvitest-runner@10.0.0.patch`) that mirrors PR 6214. The runner
  picks the separator by Vitest version, provides it to its setup file, and builds test ids,
  results and the filter with it. A frozen `bun install --cwd web`, as CI runs it, applies the
  patch. `web/stryker.config.json` documents why the patch exists and when to drop it.
  - Upstream: issue 6210 (https://github.com/stryker-mutator/stryker-js/issues/6210) and the
    open fixes PR 6214 and PR 6220.
  - Removal condition: remove the patch and its `patchedDependencies` entry when a released
    `@stryker-mutator/vitest-runner` contains the fix. Bump the runner to that release in the
    same commit, then rerun the run-format.ts control to prove the score holds. If a runner bump
    drops the patch before the fix is released, the zero-tests check below fails the run.
- `7c1811611`: `mutationExitCode()` fails the run when any mutant is Survived with
  `testsCompleted: 0`, even under `--report-only` and even on a clean Stryker exit. Such a
  mutant was never tested, so the result is a measurement failure and not a score. Failing the
  run on it is fail-closed, in the same class as a run that wrote no report. It is not a mode
  change, because `--report-only` still suppresses the threshold verdict and nothing else. It
  is not a threshold change, because the break score stays 80. The coordinator approved this
  commit on 2026-09-25. Zero-test Timeouts are deliberately left out; see the next section.

## Why the check does not cover zero-test Timeouts (validator-3's question)

At CI concurrency, the unpatched runs turned most zero-test mutants into Timeouts (52 in the
run-format.ts control, 175 in run-stream.ts). Stryker counts a Timeout as detected. So a broken
filter that produced only Timeouts would not fire the check. I looked for a report field that
separates such a Timeout from a genuine one. There is none, so the check does not cover
Timeouts:

- Stryker's reporter writes a Timeout with only `statusReason`
  (`@stryker-mutator/core/dist/src/reporters/mutation-test-report-helper.js`,
  `case MutantRunStatus.Timeout`). It writes `testsCompleted` for Survived and Killed only, and it
  never records which test ran or hung. No Timeout in any receipt has `testsCompleted` or
  `killedBy`.
- `statusReason` is set only for a hit-limit timeout ("Hit limit reached (n/limit)"), which
  needs the mutant's code to have run. A wall-clock timeout, where the runner is killed after
  `timeoutMS`, has no reason.
- Every broken-filter Timeout has the wall-clock shape: `static: false`, `coveredBy` non-empty,
  no `statusReason` (`control-runformat-vitest5`, `runstream-vitest5`).
- The patched gate on the proof merge (`gate-proof-w14-fixed`) has five genuine wall-clock
  Timeouts with exactly that shape: `client.ts:66`, `run-stream.ts:175` (two mutants),
  `run-stream.ts:229` and `model.ts:67`. Any rule that flags the broken ones also flags these
  five, which are real detections.

A red/green proof is therefore impossible without false positives, and no Timeout case is added.
The remaining signal is that a broken filter leaves zero-test Survivors in any realistic run.
Every broken receipt had them: 38 in the control, 130 in run-stream.ts, 1 279 in the CI gate.
Only a run where every covered mutant timed out would slip through.

## Proof

Proof merge `f693a3a08` = `4b96f6f77` + `wp/w18d-mutation` (ref `proof/w18d-w14-mutation`).
A guard-only head `f232d6c0e` = `4b96f6f77` + `7c1811611` without the patch (ref
`proof/w18d-guard-only`). The first proof merge `83e1ab52c`, named by `diag-runformat-v5-fixed`,
is kept as `proof/w18d-w14-mutation-r1`. It has the same patch commit.

| receipt | head | command | exit | score | tests per mutant |
|---|---|---|---|---|---|
| diag-runformat-v5-fixed (4 workers) | 83e1ab52c | stryker, run-format.ts | 0 | 97.98 | 1.28 |
| control-runformat-vitest5-fixed | f693a3a08 | stryker, run-format.ts | 0 | 97.98 (97 / 0 / 2) | 2.39 |
| runstream-vitest5-fixed | f693a3a08 | stryker, run-stream.ts | 0 | 93.46 (282 / 4 / 19) | 2.37 |
| gate-proof-w14-fixed | f693a3a08 | `BASE_REF=origin/main bun scripts/mutation.ts --changed --report-only` | 0 | 95.83 | 2.15 |
| gate-guard-only-unfixed | f232d6c0e | same | 1 | 7.83 | 0.16 |
| gate-branch-head | 7c1811611 | same | 0 | 76.12 | 1.57 |

- The control is back to its pre-bump score, and the survivor set is the same two mutants.
- The run-stream.ts gate at W14's code kills 278 and times out 8 of 306 mutants in the full CI
  scope, where W14's head measured 0 killed and 305 survived. That matches the Vitest 4 figure.
- On the unpatched head, the check fails the report-only gate, naming 1 279 mutants that
  "survived" with zero tests.
- `origin/main` was `84ee6f0ad` for every gate run.
- Every Stryker run mutated only named targets: `--mutate <file>` for the controls, and the
  CI command's own changed-file scope for the gate rows. The `core.bare` override and the archy
  identity are set with `--worktree` in every worktree used (`git config --show-origin`).

## Gate policy (coordinator's call; nothing changed here)

`ci.yml` runs the "Mutation (changed files)" job as `bun scripts/mutation.ts --changed
--report-only` (a non-blocking pilot). `mutation-nightly.yml` also runs `--report-only` per
shard. The threshold is 80. Real scores after the fix:

- W14 proof merge, CI scope: 95.83 percent, above the threshold.
- `integ/w00` content (this branch head vs `origin/main`): 76.12 percent, under the threshold.
  `download.ts` 30.77, `layout.ts` 68.63, `model.ts` 76.39 and `client.ts` 79.60. These are real
  test gaps now that the toolchain measures, and `--report-only` hides them.

## Fast legs at 7c1811611 (all exit 0, receipts `receipts/fast-*.json`)

typecheck, lint, boundaries (`check-factory-boundaries.ts`), gate-integrity,
`src/__tests__/quality-report-fail-closed.test.ts` (42 pass), frozen web install, and the
new-file and patch coverage gates with `BASE_REF=0a95d765b`. `scripts/mutation.ts` is outside
`SOURCE_GLOBS`, so I measured its changed lines by hand. The new functions are fully covered.
Three glue lines inside `main()` are not unit-reachable, because `main()` spawns Stryker. The
gate receipts above run those lines end to end.

## Also observed (not fixed)

- Stryker with two workers on a cold `web/node_modules/.vite` cache crashed once with
  `ENOTEMPTY` on the Vite deps rename (`logs/diag-download-v5.log`). A rerun with a warm cache
  passed.
- With `logLevel: debug`, runner 10.0.0 crashes on Vitest 5's circular config (issue 6210).
  That setting is not used here.
- W14's `mutation-run-format-control.json` (97.98) and the per-file data inside it came from an
  older full-scope report, not from a run-format-only control. The A/B above replaces it.
