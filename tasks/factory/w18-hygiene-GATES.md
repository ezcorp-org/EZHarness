# Gates: W18 hygiene backlog (60 partial api-keys mocks, hook cap, 27 bare git-init tests)

Receipts are under `/tmp/factory-platform-evidence/w18-hygiene/receipts/`. Base `integ/w00` `2b2e12550`,
branch `wp/w18-hygiene`. Item lists (F1, F2) are W18a-3's, verbatim from `tasks/factory/w18a3-GATES.md`.

`receipts/MANIFEST.json` maps every log/results file cited below to its producing commit, the tree
state at capture (clean at that commit, or dirty — pre-commit working tree whose content is identical
to the named commit, per the file's own methodology note), the exact command, the exit code (with a
note wherever it is non-zero and why), and start/end timestamps (end = the file's own mtime; start is
either an exact duration the tool itself reported, or the previous record's end in the same sequential
capture group — the manifest's `_methodology` field states this precisely; no independent start-time
instrumentation exists for the non-timed tools). `receipts/SHA256SUMS.txt` covers every file in the
directory, including `MANIFEST.json` itself and the two per-file result logs that were previously
uncovered (validator-3 M1).

## Item A — F1: the 60 partial api-keys mocks

- [x] GA1: `webLibModule()` exists in `src/__tests__/helpers/mock-cleanup.ts`, identical to W18a-3's.
  CHECK: `diff <(git show wp/w18-hygiene:src/__tests__/helpers/mock-cleanup.ts | sed -n '539,558p') <(cat /home/dev/work/EZCorp/EZHarness/.worktrees/w18a3-quality/src/__tests__/helpers/mock-cleanup.ts | sed -n '539,558p')`
  EXPECT: no diff
  EVIDENCE: confirmed identical at commit time (byte-for-byte, same doc comment, same body, same
  surrounding context) so the two branches merge without a duplicate-function conflict.

- [x] GA2: every one of the 60 listed suites mocks `$lib/server/security/api-keys` completely
  (`webLibModule(...)`, never a raw object literal), through the one shared helper.
  CHECK: `git diff 2b2e12550..wp/w18-hygiene -- <each of the 60 files>`
  EXPECT: every partial `() => ({ ... })` factory becomes `() => webLibModule("server/security/api-keys", { ... })`
  (or, for the 14 dual-specifier files, `const NAME = webLibModule(...); mock.module(path, () => NAME)` at both
  specifiers — see GA4).
  EVIDENCE: commits `65a1a46d8` (36 src-side files) and `b563b7395` (24 web-side files).

- [x] GA3: no behavior change to production code.
  CHECK: `git diff 2b2e12550..wp/w18-hygiene -- src web packages scripts extensions worker` excluding
  `**/__tests__/**` and `**/*.test.ts`
  EXPECT: empty
  EVIDENCE: the diff touches only `src/__tests__/helpers/mock-cleanup.ts` (a test helper) and the 60 listed
  `*.test.ts` files. `check-new-file-coverage.ts`/`check-patch-coverage.ts` against `BASE_REF=2b2e12550` both
  report zero gateable files, because `**/__tests__/**` is in `NON_SOURCE_GLOBS`
  (`coverage-new-file-a2.log`, `coverage-patch-a2.log`; commit `bb74831c0`, clean tree at capture — both
  exit 0; see `MANIFEST.json`).

- [x] GA4: the dual-specifier files (`$lib/...` + the resolved relative path, same factory) do not
  self-recurse into a partial result.
  CHECK: standalone Bun reproduction; `bash scripts/typecheck.sh`; each of the 14 files individually
  EXPECT: calling `webLibModule()` lazily from inside a factory ALSO registered for the module's resolved
  path returns only the override (documented failure mode); computing it once before either
  `mock.module()` registration and registering a constant factory for both returns the full merge
  EVIDENCE: two throwaway repros under `/tmp/bun-mock-experiment` (not committed) proved the lazy form
  drops all real exports but requireScope, and the precompute-once form returns the full set for both
  specifiers. All 14 files use the precompute-once form (part of commits `65a1a46d8` / `b563b7395`).

- [x] GA5: same self-recursion risk exists for EVERY web-side single-registration file too, because
  `web/`'s generated tsconfig maps `$lib/*` to a REALLY resolvable path (unlike the repo root, where
  `$lib` is purely virtual).
  CHECK: `cat web/.svelte-kit/tsconfig.json` (paths: `"$lib/*": ["../src/lib/*"]`); rerun each of the 24
  web files after the fix
  EXPECT: the precompute-once form applied to all 24, not only the dual-specifier ones
  EVIDENCE: `web/src/__tests__/agent-chat-api.test.ts` reproduced `SyntaxError: Export named 'requireScope'
  not found` with the lazy form under `cd web && bun test`; 0 failures after switching all 24 to the
  precompute-once form. Commit `b563b7395`.

- [x] GA6: every touched suite passes, at its real invocation.
  CHECK: `/tmp/factory-platform-evidence/w18-hygiene/receipts/f1-src-isolated-results.txt` (36 files, each
  isolated, `bun test --timeout 30000 --coverage --coverage-reporter=lcov ./<file>`) and
  `f1-web-isolated-results.txt` (24 files; 23 via `cd web && bun test`, one — `extensions-events-route.test.ts`
  — via the repo-root invocation `scripts/test.sh` actually uses, because it is listed in `passfail_files`)
  EXPECT: exit 0 for all 60
  EVIDENCE: both files (commit `bb74831c0`, dirty tree at capture — content identical to that commit;
  see `MANIFEST.json`), all lines `exit=0`. `extensions-events-route.test.ts` has a pre-existing,
  base-reproducible failure (`Export named 'disableExtension' not found in module
  '.../src/db/queries/extensions.ts'`) when force-run standalone from `web/` — reproduced identically on
  unmodified `2b2e12550` in a throwaway worktree (`.worktrees/w18-hygiene-base-check`, removed after use) —
  and is unrelated to api-keys; it passes under its real invocation. Separately, the wider 37-file
  combined-process batch run at this same commit (`f1-src-batch.log`, exit 1: 453 pass / 7 fail / 4
  errors) shows ONLY pollution from four modules item A did not touch — no api-keys failure — see item
  D's GD1, which closes those four; `f1-src-batch.log`'s non-zero exit is expected and disclosed, not a
  gap in this item.

- [x] GA7: guard test added, rejecting a partial `$lib/*` factory; enforced for the module this item
  completed.
  CHECK: `bun test --timeout 30000 ./src/__tests__/mock-cleanup-coverage.test.ts`
  EXPECT: 23/23 pass, including the new "F1 guard" describe blocks
  EVIDENCE: commit `bb74831c0`. Detector `isCompleteLibFactoryBody` + scanner `extractLibFactoryBodies`,
  pinned by 6 fixture tests (general `$lib/*` rule) plus one repo-wide scan test for
  `$lib/server/security/api-keys` specifically (roots: `src/__tests__`, `src/extensions/__tests__`,
  `src/integrations/**/__tests__`, `web/src/**`). Four files still mocking this module partially on
  W18a-3's in-flight branch (not yet on this package's base) are exempted by name with a removal note.

- [x] GA8: typecheck, lint, boundaries, gate-integrity, `factory-process-boundaries.test.ts` all green
  on the final head.
  CHECK: `bash scripts/typecheck.sh`; `bun run lint`; `bun scripts/check-factory-boundaries.ts`;
  `bun scripts/gate-integrity.ts`; `bun test --timeout 30000 ./src/__tests__/factory-process-boundaries.test.ts`
  EXPECT: all exit 0
  EVIDENCE (commit `bb74831c0`; `typecheck-a2.log` clean-tree, the rest dirty-tree with content
  identical to that commit — see `MANIFEST.json`): `typecheck-a2.log`, `lint-a1.log`, `boundaries-a1.log`,
  `gate-integrity-a1.log`, `factory-process-boundaries-a1.log` — all exit 0.

Pass for item A: every listed suite is fixed, every touched suite passes at its real invocation, no
production behavior changed, and a guard exists so the same class of defect cannot silently return for
the module this item completed.

## Item B — pre-commit hook: no silent skip above the staged-suite cap

- [x] GB1: above `EZ_PRECOMMIT_TEST_MAX` (default 12), the hook names every test file it is not
  running and, by default, blocks the commit; `EZ_SKIP_HOOK_TESTS=1` is the one acknowledged escape
  hatch and it still prints the list plus the reason. The pre-existing under-cap
  `EZ_SKIP_HOOK_TESTS=1` skip (previously zero output) now prints the same way, through the same code
  path — one skip mechanism, not two.
  CHECK: `bun test --timeout 30000 ./src/__tests__/git-hooks.test.ts`
  EXPECT: all pass, including the 3 new cases in "pre-commit hook > staged-test cap (no silent skip)"
  EVIDENCE: commits `702a97468` (fix) and `05b6329db` (tests). `git-hooks-b1.log` (commit `b7349ba8c`,
  dirty tree at capture — content identical to `05b6329db`, folded unchanged into `b7349ba8c` by the
  following docs-only commit; see `MANIFEST.json`): 19/19 pass. Reproduced the bug directly: committing
  this package's own 36-file and 24-file conversions (before the fix) printed `36 test files map to this
  commit (cap 12) — skipping.` / `24 test files map to this commit (cap 12) — skipping.` and exited 0
  with the commit landing, no file names, matching the coordinator's incident report of the 74-file main
  merge.

- [x] GB2: typecheck, lint, boundaries, gate-integrity, `factory-process-boundaries.test.ts`, and
  `gate-scripts.test.ts` (which also drives the real hook machinery) all green on the final head.
  CHECK: see item A's GA8, same commands, rerun on `05b6329db`
  EXPECT: all exit 0
  EVIDENCE (commit `b7349ba8c`, clean tree at capture: `05b6329db` is the last code commit and
  `b7349ba8c` only adds docs, so this sweep's result is identical for both — see `MANIFEST.json`):
  `typecheck-final.log`, `lint-final.log`, `boundaries-final.log`, `gate-integrity-final.log`,
  `factory-process-boundaries-final.log` — all exit 0; `gate-scripts-b1.log` (commit `b7349ba8c`, dirty
  tree, same content-identity note as `git-hooks-b1.log` above) 204/204.

- [x] GB3: `check-new-file-coverage.ts` / `check-patch-coverage.ts` against `BASE_REF=2b2e12550` pass
  (informational for this item — `.githooks/pre-commit` and `scripts/lib/hook-lib.sh` are shell, outside
  this repo's lcov-based coverage system; the change is exercised by `git-hooks.test.ts` directly, not
  measured by these gates).
  EVIDENCE: `coverage-new-file-b1.log`, `coverage-patch-b1.log` (commit `b7349ba8c`, dirty tree at
  capture, content identical to `05b6329db`; see `MANIFEST.json`) — both exit 0.

- [x] GB4 (validator-3 L1): the fourth branch — at or under the cap, WITH `EZ_SKIP_HOOK_TESTS=1` set —
  has its own test. Before this item's fix that combination never reached `run_staged_tests()` at all
  (the caller pre-filtered the env var), so it was ALSO silent — the same defect as the over-cap case,
  simply never exercised.
  CHECK: `bun test --timeout 30000 ./src/__tests__/git-hooks.test.ts`
  EXPECT: 20/20 pass, including "at or under the cap WITH EZ_SKIP_HOOK_TESTS=1: prints the list, skips,
  commit lands"
  EVIDENCE: commit `344b11efc`. `typecheck-l1.log`, `lint-l1.log`, `boundaries-l1.log`,
  `gate-integrity-l1.log`, `gate-scripts-l1.log` (204/204) — all exit 0, commit `344b11efc`, clean tree
  at capture. Coverage: `hook-lib.sh` is shell (outside the lcov-based coverage system, same as GB3);
  the new test file's own lines are not separately lcov-measured either (Bun's coverage instruments
  production code the test exercises, not the test file itself — the same convention this repo's own
  `NON_SOURCE_GLOBS` encodes for the gated coverage checks). The new assertions are real (see the test
  body) and the suite passing at 20/20 is the proof this branch is exercised.

Pass for item B: the silent skip is gone; a wide commit is loud and, by default, blocked; the one
escape hatch is visible in every direction it applies (over cap, and now proven under cap too); no
other hook behavior changed (the three original `repoWithPreCommit()` tests and `EZ_SKIP_HOOKS=1`
bypass are unaffected).

## Validator-3 fix round (M1, L1) — receipts corrected, one test added, no code behavior changed by M1

M1 and L1 (above, GA3/GA6/GA8/GB1/GB2/GB3 citations and GB4) are validator-3's required fixes on the
ACCEPT-WITH-FIXES verdict at `b7349ba8c`. M1 touched only evidence (this file's citations,
`receipts/MANIFEST.json`, `receipts/SHA256SUMS.txt`); L1 added one test and no production or hook-lib.sh
behavior change beyond what `702a97468`/`05b6329db` already shipped. New head after both: `344b11efc`.
L2 (the withheld-factory-orchestrator name in the over-cap list; the empty-list guard when only
orchestrator files are staged; removing the F1-guard's by-name W18a-3 exemption once those four files
land) is item C's scope on `wp/w18-hygiene-2`, per the ruling — not done here.

## Item C — F2: the 27 bare git-init tests

- [ ] GC1: BLOCKED on the integ/w00 hash containing W18a-3 (for `src/__tests__/helpers/scratch-git.ts`),
  per the spawn brief. Not started.
