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
  (validator-3 N2: the original L1 evidence cited no receipt for the 20/20 claim itself — the
  `typecheck`/`lint`/`boundaries`/`gate-integrity`/`gate-scripts` sweep never re-runs `git-hooks.test.ts`
  directly. `git-hooks-l1.log` (20/20, exit 0) fills the gap: re-run on `wp/w18-hygiene-2`, where
  `git diff 344b11efc -- src/__tests__/git-hooks.test.ts` is empty, i.e. byte-identical to the cited
  commit — see `MANIFEST.json`'s `_notes_from_validator3.N2`.)

Pass for item B: the silent skip is gone; a wide commit is loud and, by default, blocked; the one
escape hatch is visible in every direction it applies (over cap, and now proven under cap too); no
other hook behavior changed (the three original `repoWithPreCommit()` tests and `EZ_SKIP_HOOKS=1`
bypass are unaffected).

**Evidence fixes N1, N2 (validator-3, folded into item D's receipts per the ruling — no branch change):**
N1 — `SHA256SUMS.txt` listed itself, so `sha256sum -c` always reported one `FAILED`; regenerated
excluding its own filename from the input glob (`sha256sum -c` now exits 0 clean). N2 — above.

## Validator-3 fix round (M1, L1) — receipts corrected, one test added, no code behavior changed by M1

M1 and L1 (above, GA3/GA6/GA8/GB1/GB2/GB3 citations and GB4) are validator-3's required fixes on the
ACCEPT-WITH-FIXES verdict at `b7349ba8c`. M1 touched only evidence (this file's citations,
`receipts/MANIFEST.json`, `receipts/SHA256SUMS.txt`); L1 added one test and no production or hook-lib.sh
behavior change beyond what `702a97468`/`05b6329db` already shipped. New head after both: `344b11efc`.
L2 (the withheld-factory-orchestrator name in the over-cap list; the empty-list guard when only
orchestrator files are staged; removing the F1-guard's by-name W18a-3 exemption once those four files
land) is item C's scope on `wp/w18-hygiene-2`, per the ruling — not done here.

## Item D — the other pre-existing partial-mock pollution (coordinator ruling on finding 2)

Base for the reproduction: `b7349ba8c` (items A+B, validated). Branch `wp/w18-hygiene-2`. Four named
modules: `$lib/server/context`, `$server/db/queries/extensions`, `$server/providers/local-model-check`,
`$lib/server/security/resource-quotas`.

- [x] GD1: reproduced on the base, before any item-D fix — running the 36 F1 files together throws
  exactly the class the F1 disclosure predicted, for these four modules (not api-keys, which item A
  already closed).
  CHECK: `bun test --timeout 30000 <36 F1 src files> ./src/__tests__/mock-cleanup-coverage.test.ts`
  EXPECT (before): `SyntaxError: Export named 'getCommandRegistry'/'ensureInitialized' not found in
  module '$lib/server/context'`; `'listExtensions' not found ... db/queries/extensions`;
  `'listModels' not found ... providers/local-model-check`; `'checkStorageQuota' not found ...
  security/resource-quotas`
  EVIDENCE: `f1-src-batch.log` (captured incidentally while finishing item A, before item D existed;
  quoted verbatim in the item-D commit message) names all four.

- [x] GD2: every file that partially mocks one of the four modules is found and converted, repo-wide
  (not just the files that happened to collide in the GD1 batch).
  CHECK: a repo-wide scan (src + web) for `mock.module()` calls matching each module's `$lib`/`$server`/
  relative specifier forms, classified complete (spreads the real module, or resolves via a
  `serverModule`/`webLibModule`/`contextModule`-bound const) vs partial
  EXPECT: zero partial after the fix
  EVIDENCE: 26 files (10 src, 16 web), all touched in commit `69d04ed70`. Re-scan after the commit:
  zero partial instances remain for any of the four modules (script output recorded in this session;
  reproducible via the same regex-based scan described in the commit message).

- [x] GD3: `db/queries/extensions`, `providers/local-model-check`, `security/resource-quotas` use
  `serverModule()`/`webLibModule()` — proven shallow enough to spread safely (unlike `context`, GD4).
  CHECK: standalone Bun reproduction requiring each module directly (see item A's GA4/GA5 for the
  precompute-once requirement, which applies here too); each of the resulting 20 (of 26) files
  individually with `--coverage`
  EXPECT: full real export set, no cascade, 0 failures
  EVIDENCE: sanity checks in this session (not committed) confirmed `db/queries/extensions` (22 real
  exports) and `providers/local-model-check` (6) resolve cleanly with no side effects; all 20 files
  pass individually — see GD6.

- [x] GD4: `$lib/server/context` cannot use `webLibModule()` — it is the app's central wiring module.
  CHECK: attempted the same fix as GD3; ran each affected file individually and in combination with
  its siblings after each attempted fix
  EXPECT (if webLibModule were safe): 0 failures
  ACTUAL: an unbounded cascade — completing `context` via `webLibModule()` transitively required
  `db/queries/agent-configs`, `db/queries/conversations`, `db/queries/user-commands`, `db/connection`,
  `runtime/pending-messages` in turn, each already mocked, partially, by the very file whose context
  mock was being completed, for a reason unrelated to context. Each fix revealed the next layer.
  RULING: do not spread `context.ts` for real. `completeFactory()` + `contextModule()`
  (`helpers/mock-cleanup.ts`, commit `7bb15980f`) build a facade with the real 9-function export
  surface (`CONTEXT_EXPORT_NAMES`) always present — overrides where given, a function that THROWS on
  call (never on link) everywhere else. This fixes the "Export named X not found" link-time bug (the
  actual defect) without ever requiring the real module, so no transitive graph is pulled in.
  EVIDENCE: the cascade reproduction is not preserved (reverted between attempts, per this session's
  transcript); the final, working `contextModule()` design and its 13 call sites are in commit
  `69d04ed70`.

- [x] GD5: a companion bug in the "every mock.module target is snapshotted or exempt" meta-test —
  `serverModule()`/`webLibModule()`-bound `$server/*` factories were misclassified as REDIRECTS
  (fail-closed), not recognized as shims, because `collectModuleBindings()` only recognized
  `require(...)`/`import * as` bindings.
  CHECK: `bun test --timeout 30000 ./src/__tests__/mock-cleanup-coverage.test.ts`
  EXPECT: 0 fail
  EVIDENCE: commit `1645390fc`. Before: 6 false-positive "missing from MODULE_PATHS" reports for
  `$server/db/queries/extensions` / `$server/providers/local-model-check` across 4 files. After: 23/23.

- [x] GD6: every one of the 26 touched files passes individually, at its real invocation; the batch
  reproduction (GD1) no longer shows ANY "Export named X not found" for the four target modules.
  CHECK: `d-src-isolated-results.txt` (10 files, each isolated, `--coverage`), `d-web-isolated-results.txt`
  (16 files; 13 via `cd web && bun test`, 3 — ask-user-answer-route, extensions-data-route,
  extensions-events-route — via the repo-root invocation `passfail_files` actually uses, same pattern
  as item A's GA6); `d-src-batch-after2.log` (the GD1 batch, post-fix) grepped for the four modules'
  "not found" text: zero matches.
  EXPECT: exit 0 for all 26; zero matches
  EVIDENCE: all files `exit=0`; grep confirmed zero.

- [x] GD7: a bonus, single-file fix found while closing a residual failure: `extension-event-end-to-end
  .test.ts` also had a partial `$server/auth/middleware` mock (2 of 9 real exports). Fixed with
  `serverModule()` (lazy form — this file only ever runs from the repo root, where `$server` is
  virtual, so the precompute-once requirement does not apply; see GA5).
  EVIDENCE: part of commit `69d04ed70`.

- [x] GD8 (coordinator ruling, fixed): the residual pollution disclosed above is closed.
  `extension-event-end-to-end.test.ts` had THREE more partial mocks, not one:
  `$server/db/queries/conversations` (2 of 34 real exports), `$server/db/queries/tool-calls` (1 of 5),
  both converted with `serverModule()`. The third was a different bug class entirely and the one that
  actually explained the failure: `$lib/server/http-errors` had the right export NAME (`errorJson`)
  but a hand-rolled 2-arg body that silently dropped the real 4-arg signature's `details`/
  `extraHeaders` (`web/src/lib/server/http-errors.ts` spreads `details` into the response body).
  `mock-cleanup-coverage.test.ts`'s guard only checks for a missing export, never a narrower
  reimplementation of a present one, so nothing caught it. `messages-permission-mode-ceiling-
  route.test.ts`'s route imports `errorJson` statically; bun test loads every given file's top-level
  code (every top-level `mock.module()` and top-level `await import()`) before running ANY file's
  tests, so that route captured the stale 2-arg override at import time — before
  `extension-event-end-to-end.test.ts`'s own tests, and therefore its `afterAll`'s
  `restoreModuleMocks()`, had run. A near-identical hand-rolled `errorJson` was independently found and
  fixed in `memory-list-derived-owner.integration.test.ts` while re-running the full batch after the
  first fix and finding it still red.
  CHECK: `bun test --timeout 30000 <36 F1 src files> ./src/__tests__/mock-cleanup-coverage.test.ts`
  (the exact GD1 reproduction)
  EXPECT: 0 fail
  EVIDENCE: commit `fc2148e3c`. `d-src-batch-final2.log`: 682 pass, 0 fail (was 677/5 before this
  commit). Both files individually: `extension-event-end-to-end.test.ts` 12/12,
  `memory-list-derived-owner.integration.test.ts` 8/8.

The two much larger surveys found while enumerating GD2 (83 files partially mocking
`db/queries/extensions` via a plain relative specifier elsewhere in the tree; ~39 partially mocking
`$server/auth/middleware`) are coordinator ruling: item E, a later package on its own branch after item
C. Not undertaken here; kept as a named record only.

Pass for item D: the four named modules, plus the residual pollution the coordinator ruled to fix, are
fully closed everywhere they were partially mocked, proven by direct reproduction before and after; the
harder finding (context.ts cannot be spread) is fixed with a purpose-built, non-cascading helper instead
of forcing the F1 pattern where it does not fit; every touched file passes at its real invocation; the
two remaining surveys are named, not hidden, and deferred to item E by ruling.

## Validator-3 pre-review fixes (P1, P2, P3) — required for item D's final head

- [x] P1: `completeFactory()` has its own tests, independent of `contextModule()`'s specific 9-name
  surface — a missing name exists on the object (so linking a route's static import never sees
  "Export named X not found") but throws only when actually CALLED; the thrown error names the export;
  a given override always wins over the throwing default and does not affect sibling names; a
  non-function override value is accepted verbatim (the factory does not inspect it).
  CHECK: `bun test --timeout 30000 ./src/__tests__/mock-cleanup-coverage.test.ts`
  EXPECT: the 4 new tests in "completeFactory() (the contextModule() fix for a too-heavy module)" pass
  EVIDENCE: commit `94167e2b2`.

- [x] P2: `CONTEXT_EXPORT_NAMES` is pinned against `web/src/lib/server/context.ts`'s real export list,
  parsed from source (never imported — the entire point of `contextModule()`, GD4, is to avoid pulling
  in that module's graph).
  CHECK: `bun test --timeout 30000 ./src/__tests__/mock-cleanup-coverage.test.ts`
  EXPECT: "CONTEXT_EXPORT_NAMES stays in sync with context.ts's real export list" passes (2 tests: the
  parser itself against a synthetic fixture, then the real pin)
  EVIDENCE: commit `94167e2b2`.

- [x] P3: `1645390fc` (GD5's fix) made ANY `serverModule()`/`webLibModule()`-bound `$server/*` factory
  count as a covered shim unconditionally — wrong for an override-bearing binding, which REPLACES
  exports exactly like the raw-object-literal factories this file exists to catch, and needs the alias
  to be `served`/`skipped` like any other stub. `collectHelperBindings()` (new) tracks the binding's
  target plus whether `overrides` is empty; an empty-overrides binding at a matching alias is still a
  true shim (nothing to restore, identical to a `require()` passthrough); a non-empty one records NO
  verdict and falls through to the served/skipped check; a target MISMATCH is a redirect regardless of
  overrides.
  CHECK: `bun test --timeout 30000 ./src/__tests__/mock-cleanup-coverage.test.ts`; the real 26-file item
  D conversions re-classified under the fixed rule (no regression)
  EXPECT: 5 new fixtures pass (unserved override-bearing binding still fails; served override-bearing
  binding passes via rule 3, not rule 2; empty-overrides binding is a true shim; target-mismatch
  binding is a redirect either way; the P2-adjacent source-parser sanity test); the 37-file src
  reproduction batch stays 0 fail
  EVIDENCE: commit `94167e2b2`. `mock-cleanup-coverage.test.ts` 33/33 (was 23 pre-item-D, 29 after
  P1/P2, 33 after P3). `d-src-batch-p123.log`: 692 pass, 0 fail — the real item-D conversions are still
  correctly classified after the fix (validator-3's own probe of "nothing real is exempted today" is
  now also a standing regression test, not just a one-time check).

Full item D verification on the final head (`94167e2b2`): all 28 touched files (26 from GD2 + the 2
residual-fix files) pass individually at their real invocation (`d-src-isolated-final.txt`,
`d-web-isolated-final.txt`, all `exit=0`); typecheck, lint, boundaries, gate-integrity,
`factory-process-boundaries.test.ts` (15/15) all green.

## Item C — F2: the 27 bare git-init tests

- [x] GC1: branch `wp/w18-hygiene-3` created from `integ/w00` at `6cea43e67` (W18a-3 landed as `8a08328fc`,
  receipts in `6cea43e67`), per the team-lead-supplied hash. Worktree set up per the standing
  incident-response rule: `git config --worktree core.bare false` + worktree identity set FIRST,
  confirmed with `git config --show-origin --get-all core.bare` (both the shared `.git/config` and this
  worktree's own `config.worktree` read `false`, unchanged throughout everything below); `GIT_DIR`,
  `GIT_INDEX_FILE`, `GIT_WORK_TREE` confirmed clear before every suite.

- [x] GC2: hardened `packages/@ezcorp/sdk/src/test/filesystem.ts`'s `gitInDirectory()` to full isolation.
  It previously only stripped `GIT_*`; it still read the real user's `~/.gitconfig` and the host's
  system config. Extracted the isolation rule as a new export `isolatedGitEnv(home, env)` (strip
  `GIT_*`, drop `XDG_CONFIG_HOME`, set `HOME`, set `GIT_CONFIG_NOSYSTEM=1`) used by both
  `gitInDirectory()` (default: a fresh scratch `HOME` per call) and `src/__tests__/helpers/scratch-git.ts`'s
  `scratchGitEnv()`, which now delegates to it instead of duplicating the rule. This is Group 2 (the 2
  SDK-based files use `gitInDirectory()`/`markGitRepository()` already — no test-file change needed):
  `docs/extensions/examples/task-stack/index.test.ts`, `packages/@ezcorp/ai-kit/test/unit/cli-install.test.ts`.
  CHECK: `bun scripts/check-boundaries.ts` and `bun scripts/check-factory-boundaries.ts` (app code
  importing `@ezcorp/sdk/*` is unrestricted by either); `bun test packages/@ezcorp/sdk/test/fs.test.ts`
  + the two Group 2 files.
  EXPECT: both boundary checks 0; 122/0 across the three files.
  EVIDENCE: commit `d296f0b91`. Verified with the pinned bun 1.3.14 (`.bun-version`); typecheck, lint,
  gate-integrity all 0; shared `.git/config` `core.bare` unchanged (`false`) before/after.

- [x] GC3: Group 1 (17 confirmed real bare-git-init files) converted to the shared helper. Each file's
  hand-rolled isolation (several already replaced the child's env wholesale — safe by accident, not by
  the shared rule — most did not: full `...process.env` spreads, or no `env` override at all, meaning
  an ambient hook `GIT_DIR` would act on the wrong/real repository). Converted to
  `scratchRepository()`/`scratchGitEnv()` uniformly; where a file needed a fixed author/committer
  identity AND date (so previously-pinned object hashes keep reproducing — `git-objects.test.ts`,
  `reference-code/git-reader.test.ts`), composed `{ ...scratchGitEnv(home), GIT_AUTHOR_DATE: ..., ... }`
  rather than using `scratchRepository()`'s own (undated) identity path, so no behavior/hash changed.
  Files: `docs/extensions/examples/docs-updater/index.integration.test.ts`,
  `src/extensions/first-party-integration/docs-updater/git.test.ts`,
  `src/extensions/first-party-integration/repo-activity-notify/git.test.ts`,
  `scripts/check-patch-coverage-typeonly.test.ts`, `src/extensions/project-git-refs.test.ts`,
  `src/extensions/__tests__/project-git-broker.test.ts`, `src/extensions/__tests__/project-open-pr.test.ts`,
  `src/extensions/__tests__/source-project-credentials.test.ts`, `src/factory/git-objects.test.ts`,
  `src/factory/reference-code/git-reader.test.ts`, `src/__tests__/biome-ignores-worktrees.test.ts`,
  `src/__tests__/git-install.test.ts`, `src/__tests__/security/c3-extension-install.test.ts` (the exact
  file the 2026-09-24 incident named), `src/__tests__/source-parser-git-coverage.test.ts`,
  `src/__tests__/source-parser.test.ts`, `src/__tests__/unlanded-branches.test.ts`,
  `src/__tests__/visual-evidence-select.test.ts`.
  CHECK: each file alone, then all 17 + the 2 Group 2 files together in one process.
  EXPECT: alone — 3 batches of 8/4/5 files, 49/0, 42/0, 121/0; combined — 334/0 across 20 files.
  EVIDENCE: `git status --short` shows exactly the 17 files touched; shared `.git/config` `core.bare`
  unchanged (`false`) after every run.

- [x] GC4: Group 3 (8 files disclosed as uncertain) verified against this real merged base — all 8 are
  false positives; none invoke a real git subprocess. Grep evidence per file:
  `src/__tests__/cli-ext-coverage.test.ts` (only fake `.git@v1.0.0`/`github:` source strings, no spawn);
  `src/__tests__/ext-docs-validation.test.ts` (only a doc example name `github-stats`);
  `src/__tests__/ext-init.test.ts` (only `.gitignore` file-content assertions);
  `src/__tests__/lessons-audit-queries.test.ts`, `src/__tests__/memory-types.test.ts`,
  `web/src/__tests__/copyable-content.test.ts`, `src/factory/release-git-refs.test.ts` (zero
  case-insensitive `git` matches in the whole file); `src/__tests__/cli-ext-typed-scaffold.test.ts`
  (spawns the project's OWN built CLI's `ext init`, which calls `@ezcorp/sdk/scaffold` — confirmed by
  grep to contain no git invocation at all, pure file scaffolding). No code change; no false-positive
  filed as real.

- [x] GC5: poisoned-env guard-with-control proof, the pattern `gate-scripts.test.ts` already uses for
  `scratchRepository()`/`scratchGitEnv()` themselves, run over all 17 Group 1 files: a dummy repository
  built with `scratchRepository()`, snapshotted (config/index/refs/objects/HEAD), then the SAME 17
  files run via `bun test` with `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`/
  `GIT_OBJECT_DIRECTORY`/`HOME` all pointed at the dummy (exactly what a pre-commit hook exports).
  RESULT: the dummy repository's snapshot is BYTE IDENTICAL before and after (my 17 conversions never
  read or write the poisoned target); the control (the same poisoned env, unprotected) DOES leak into
  the dummy (`git config user.email` written into its real config), proving the poison in the proof is
  real and not a no-op.
  RESIDUAL, CORRECTED (validator-3's F2 finding on the original draft of this entry, which undercounted
  both the failures and the sites): this item's own scratch poison probe found 13 failures in 3 files
  and named 3 production wrapper sites; validator-3's later, more rigorous poison run over the full 17
  Group 1 files plus their siblings found 21 test failures across 7 files, naming FOUR real production
  wrapper sites, one of which (`repo-activity-notify`) this item's own probe missed entirely. All ONLY
  on tests that exercise pre-existing PRODUCTION git wrappers this item's scope never touched — these
  are production runtime code, not test fixtures, outside item C's stated scope ("convert 27 disclosed
  bare git-init TESTS") — reported to team-lead for a ruling rather than fixed unilaterally; item C's
  own 17 conversions are unaffected by and do not depend on that ruling. The fixes for all four sites
  landed later, in item C2 (branch `wp/w18-hygiene-c2`, gates doc GC11-15).
  POISON RECIPE (validator-3's, `/tmp/factory-platform-evidence/w18-hygiene-validation/itemC/poison.sh`):
  a real scratch "dummy" repo at `$D`, then every file run as
  `env GIT_DIR=$D/.git GIT_INDEX_FILE=$D/.git/index GIT_WORK_TREE=$D GIT_COMMON_DIR=$D/.git
  GIT_OBJECT_DIRECTORY=$D/.git/objects HOME=$H timeout 600 bun test --timeout 60000 ./<file>`, one file
  per process (no lock needed). A snapshot of `$D` before and after every run, plus an explicit control
  (the same poison, no protection, does write into `$D`), proves the poison is both harmless-if-ignored
  and effective-if-not.
  - `src/extensions/git.ts`'s `gitExec()` (spreads `{...process.env}` with no `GIT_*` stripping — used
    by its `clone()`/`getCurrentRef()`/`lsRemoteTags()`): 7 failures —
    `src/__tests__/source-parser-git-coverage.test.ts` (3) + `src/__tests__/source-parser.test.ts` (4).
  - `scripts/unlanded-branches.ts`'s internal `Bun.spawnSync(["git",...args],{cwd})` (no `env` override
    at all — exercised by its exported `main()`): 5 failures — `src/__tests__/unlanded-branches.test.ts`.
  - `docs/extensions/examples/docs-updater/index.ts`'s `HERMETIC_GIT_ENV` (blocks global/system config
    reads but never strips `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE` — IS triggered, this entry's
    original draft said only "found earlier, not triggered"; that was wrong): 7 failures —
    `docs/extensions/examples/docs-updater/index.integration.test.ts` (3) +
    `src/extensions/first-party-integration/docs-updater/git.test.ts` (4).
  - `docs/extensions/examples/repo-activity-notify/index.ts`'s `readGitHead` (undisclosed by this
    entry's original draft entirely): 1 failure —
    `src/extensions/first-party-integration/repo-activity-notify/git.test.ts`.
  Total: 20 real failures across four sites. The 21st (`src/__tests__/git-install.test.ts`, 1 failure)
  is a METHODOLOGY ARTIFACT, not a fifth site: poisoning `HOME` moves rootless podman's image store,
  which this test's runner depends on regardless of git isolation — `RunnerError: ...image not known`,
  unrelated to any git-context bug. Stated explicitly so it is never miscounted as a real site.
  EVIDENCE: `/tmp/w18-hygiene-3-poison-check.ts`, `/tmp/w18-hygiene-3-poison-check2.ts` (this item's own
  original, less complete probe; not repo-tracked, scratch proof scripts);
  `/tmp/factory-platform-evidence/w18-hygiene-validation/itemC/poison-results.txt` and the per-file
  `poison-*.log` files beside it (validator-3's authoritative run, cited above).

- [x] GC6: bisected leak fix — `src/__tests__/extensions-patch-route.test.ts` and
  `src/__tests__/extensions-delete-route-policy.test.ts` converted their `extension-lifecycle-service`/
  `registry`/`db/queries/extensions` mocks to `serverModule()`, plus two structural fixes the bisection
  required beyond that:
  1. `ExtensionRegistry.getInstance()` is a cheap in-memory singleton (no I/O) — replacing the whole
     class/module still freezes on whichever file's registration is active when another file's
     already-loaded consumer (`scoped-tools.ts`, `context.ts`, both call `ExtensionRegistry.getInstance()`
     at their own top level) first resolves the alias, breaking every real method the frozen shape
     omits. Fixed by `spyOn()`-ing the real singleton's `reload`/`killAll` instead of replacing the
     module, with `ExtensionRegistry.resetInstance()` in `afterAll` (un-spying first, since
     `resetInstance()` calls the instance's own `killAll()`) so the next `getInstance()` anywhere gets a
     fresh, unspied instance.
  2. `getExtensionByRef`/`getExtension` and `getExtensionLifecycle` are gated/proxied rather than
     wholesale-replaced: `db/queries/extensions` reads fall through to the real, DB-backed function for
     any id other than the fixture's own; `getExtensionLifecycle()` returns a `Proxy` over the fake
     (`inspect`/`disable`/`uninstall`) that lazily delegates any OTHER method call to the real service —
     needed because `installer-idempotent-local.test.ts`'s author-loader calls `.list()`, which the
     original hand-rolled fake never had. Both real references are snapshotted as standalone function
     values BEFORE the override is registered — `mock.module()` on the same relative specifier updates
     properties on the same object in place, so a captured OBJECT reference (not a captured FUNCTION
     value) would see the override too.
  BUG FOUND AND FIXED DURING THIS: the lazy-delegate Proxy's `get` trap, if it returns a function for
  `"then"`, makes the returned object look like a thenable to JS's own promise-resolution machinery —
  `await getExtensionLifecycle()` then calls `proxy.then(resolve, reject)`, which calls
  `getExtensionLifecycle()` again to build the fallback, which is also awaited, checking `.then` again:
  an infinite loop that hung the process (confirmed via a temporary route-file trace: the override was
  called thousands of times, no test body ever reached). Fixed by excluding `prop === "then"` (and
  symbols) from the lazy-delegate branch.
  CHECK (all four required proofs): each file alone; `extensions-patch-route.test.ts` + `phase-2b-e2e.test.ts`;
  `extensions-delete-route-policy.test.ts` + `phase-2b-e2e.test.ts`; `extensions-delete-route-policy.test.ts`
  + `installer-idempotent-local.test.ts`.
  RESULT: alone 11/0 and 9/0; both `phase-2b-e2e.test.ts` pairs fully green (19/0, 17/0) — the disclosed
  leak for those two pairs is closed. The third pair (`extensions-delete-route-policy.test.ts` +
  `installer-idempotent-local.test.ts`) still fails the SAME 3 tests the original bisection named, but
  the proximate error changed (was `TypeError: lifecycle.list is not a function`; now a DB-connection-
  lifecycle error, `PGlite is closed`, plus one data-content assertion mismatch). CONFIRMED PRE-EXISTING,
  NOT A REGRESSION: checked out the ORIGINAL, unconverted `extensions-delete-route-policy.test.ts` from
  HEAD and ran the identical pairing — the SAME 3 test names fail there too (with the pre-fix
  `.list is not a function` symptom). The pair passes cleanly in the REVERSED order (25/0) and each
  file passes alone (16/0, 9/0), so this is order-dependent but not caused by anything item C's scope
  touches — it traces to `installer-idempotent-local.test.ts`'s own `mockDbConnection()` (in
  `helpers/test-pglite.ts`) registering `../../db/connection`, a second instance of the exact "$server/*
  alias frozen by load order" class this item fixes, one layer down and in the opposite direction
  (the VICTIM's own mock can't reach a consumer whose `db/connection` binding another file's earlier
  load already froze). Reported to the coordinator; not fixed here (out of item C's two-file scope,
  requires touching `helpers/test-pglite.ts` and/or `installer-idempotent-local.test.ts`).
  ALSO EXTENDED THE GUARD: added `isCompleteServerFactoryBody()` (serverModule()'s counterpart to the
  existing `isCompleteLibFactoryBody()`) and a real-file walker guard, analogous to the F1
  `$lib/server/security/api-keys` one, over every `mock.module($server/extensions/{extension-lifecycle-service,registry})`
  in the tree. Running it uncovered FIVE more pre-existing offenders beyond the two files fixed here —
  `src/__tests__/hub-render-pull.test.ts`, `src/__tests__/phase-2b-e2e.test.ts` (its own narrow
  `ExtensionRegistry.getInstance` override, the same class of bug), `src/__tests__/extension-events-hub-branch.test.ts`,
  `web/src/routes/api/import/__tests__/commit.test.ts`, `web/src/__tests__/extensions-api.test.ts`,
  `web/src/__tests__/extensions-events-route.test.ts` — recorded as a `PENDING_ELSEWHERE` exemption list
  (same pattern as the api-keys guard's own), disclosed to the coordinator as a new candidate survey
  (same shape as item E), not fixed here.
  EVIDENCE: `mock-cleanup-coverage.test.ts` 34/34 (was 33/33; the new describe block adds the walker
  test). Typecheck, lint, gate-integrity, both boundary checks all 0. Shared `.git/config` `core.bare`
  unchanged (`false`) throughout.

- [x] GC7: `workflow-run-persistence.test.ts`'s `terminalizeOrphanedWorkflowRuns` timing flake fixed.
  The crash-recovery describe block's `BOOT`/`NOW` (`2026-07-29T12:00:00Z`/`T12:05:00Z`) hoisted to
  MODULE level — one clock for the whole file, not per-test copies — and reused in all three places:
  the flaky test itself ("sweeps rows a dead process left running"), the neighbouring
  "the boot sweep drains a half-written row" test (dropped its `Date.now() - 60_000` margin), and the
  existing crash-recovery block (unchanged behaviour, now reading the module-level constant instead of
  its own describe-scoped copy). Both fixed tests now insert with `startedAt: BOOT` and pass explicit
  cutoffs strictly after it by construction (`BOOT.getTime() + 1000` for the draining sweep, `NOW` —
  five fixed minutes later — for the half-written test's second cutoff and the "second sweep finds
  nothing" call) instead of calling `terminalizeOrphanedWorkflowRuns()` with no arguments, which read
  `new Date()` twice internally. No wall-clock read (`new Date()`/`Date.now()`) in either test.
  CHECK: the file alone, five consecutive runs.
  EXPECT/RESULT: 95/0 every time.
  EVIDENCE: typecheck, lint, gate-integrity, both boundary checks all 0.

- [x] GC8 (L2, from the A+B verdict): the hook's over-cap/skip messages now name the withheld
  `packages/@ezcorp/factory-orchestrator` run whenever one is staged, and never print an empty list
  when ONLY orchestrator files are staged with `EZ_SKIP_HOOK_TESTS=1` set. Two bugs fixed in
  `scripts/lib/hook-lib.sh`'s `run_staged_tests()`:
  1. `printf '%s\n' "$targets" | wc -l` on an EMPTY `$targets` still emits one (empty) line, so `count`
     was wrongly `1` instead of `0` whenever only orchestrator files were staged (the exact case this
     ruling names) — fixed with an explicit `[ -z "$targets" ] && count=0` branch.
  2. Neither the over-cap "NOT running" list nor the `EZ_SKIP_HOOK_TESTS=1` "skipping" list ever
     mentioned the orchestrator run, even though both branches `return` before it would run — a hook
     that silently withholds a real test run without saying so is exactly the bug item B fixed for the
     cap itself, just for the orchestrator's separate execution path. Both messages now print
     `packages/@ezcorp/factory-orchestrator (node: bun run test) — also withheld[, blocked by the same
     cap]` whenever `orchestrator=1` and the function is about to return without running it.
  Also removed the F1 guard's by-name W18a-3 exemption (`mock-cleanup-coverage.test.ts`'s
  `PENDING_ELSEWHERE` for the four files fixed on wp/w18a3-quality-r2) now that its merge landed in this
  package's base — all four already use `webLibModule()`; the guard test re-confirms zero offenders
  repo-wide with the list gone.
  CHECK: two new tests in "hook-lib > run_staged_tests > factory-orchestrator" (EZ_SKIP_HOOK_TESTS=1
  with only an orchestrator file staged; the over-cap block with an orchestrator file staged alongside
  three real test files); `git-hooks.test.ts`, `gate-scripts.test.ts`, `mock-cleanup-coverage.test.ts`.
  EXPECT/RESULT: `git-hooks.test.ts` 27/27 (was 25/25); `gate-scripts.test.ts` 210/0;
  `mock-cleanup-coverage.test.ts` 34/34 with zero api-keys offenders and the exemption list removed.
  EVIDENCE: typecheck, lint, gate-integrity, both boundary checks all 0.

- [x] GC9: the third pair (`extensions-delete-route-policy.test.ts` + `installer-idempotent-local.test.ts`,
  GC6's residual) fixed, per the coordinator's ruling that it stays in item C's scope. GC6's own
  `serverModule()`-plus-lazy-`Proxy` approach for the lifecycle-service/registry aliases is SUPERSEDED —
  it left this pair red (same 3 tests, "PGlite is closed" instead of the original
  `TypeError: lifecycle.list is not a function`) and, separately, introduced a `getOwnPropertyDescriptor`
  bug of its own (a Proxy advertising a real export name via `ownKeys` but reporting a hardcoded
  `value: undefined` broke Bun's static `import { X }` linking for names outside the override set —
  confirmed with an isolated reproduction outside this repo before diagnosing it correctly). Replaced
  with W18c's independently-produced fix, offered as evidence at
  `/tmp/factory-platform-evidence/w18c/leak-fix-alias-withdrawal.diff` (README and raw results
  alongside it) and adopted here with attribution:
  1. The lifecycle service is mocked on its RELATIVE path ONLY — no `$server/extensions/extension-lifecycle-service`
     alias registration at all. A route resolves that alias NATIVELY to the same record as the relative
     path when nothing has claimed the alias separately (confirmed empirically — this is why
     `restoreModuleMocks()`'s existing relative-path restoration, via `MODULE_PATHS`, is sufficient once
     the alias is never separately claimed). An alias registration, once made, can never be withdrawn;
     with one in place, `installer-idempotent-local.test.ts`'s own `spyOn()` on the real lifecycle-service
     namespace stopped reaching its author-loader.
  2. `db/queries/extensions` keeps its alias (other suites claim it too, so a relative-only mock cannot
     be relied on) and hands it back to the real module in `afterAll` — claim-and-revert, the exact
     pattern GC6 already used for this one alias, kept unchanged; this item's own id-gating (fall through
     to the real, DB-backed function for any id but the fixture's own) stays layered on top, on the real
     module handed back for the OTHER thing that reads it.
  3. `ExtensionRegistry`'s `spyOn()` (GC6) is kept, not replaced — it already avoids the alias question
     entirely.
  A THIRD bug found and fixed while proving this at a realistic scale (a 25-file random sample of
  `helpers/test-pglite.ts` consumers run alongside all four polluter/victim files together, per the
  coordinator's "run every file that uses test-pglite.ts" instruction): `extensions-patch-route.test.ts`'s
  and `extensions-delete-route-policy.test.ts`'s own `ExtensionRegistry.getInstance()` + `spyOn()` calls
  were at THIS FILE's own top level — during the shared loading phase, before any file's tests run and
  before the singleton has been reset by anyone. Two files doing this same thing capture the SAME
  instance; the first file's own `afterAll` then calls `resetInstance()`, discarding it, so the second
  file's module-level spy references a stale object `getInstance()` no longer returns — its own
  assertions silently check nothing, and a LATER real caller (`phase-2b-e2e.test.ts`'s `publish()`)
  hits whichever spy is still active from whoever spied last ("Route bypassed fenced publication" from
  the OTHER file's throwing mock). Fixed by moving both files' `ExtensionRegistry.getInstance()` +
  `spyOn()` calls into `beforeAll` (test-execution time, after every earlier file's own `resetInstance()`
  has already run), so each file gets the instance actually live for its own run.
  PROOF (all four required demonstrations plus both orders, superseding GC6's partial result):
  each file alone; all 4 pair combinations in BOTH orders (`extensions-patch-route.test.ts`/
  `extensions-delete-route-policy.test.ts` × `installer-idempotent-local.test.ts`/`phase-2b-e2e.test.ts`,
  forward and reversed); all four files together in one process; a 25-file random sample of
  `helpers/test-pglite.ts` consumers alongside all four.
  RESULT: alone 11/0 and 9/0; every pair, both orders, all green (27/0, 27/0, 25/0, 25/0, 19/0, 19/0,
  17/0, 17/0 — matching W18c's own cited numbers exactly for the four it ran); all four together 44/0.
  L3 (validator-3 fix round): the original citation here for the 25-file sample plus all four together
  read "353/0" — a pass/fail count only, with no separate count of LOAD errors (bun reports a module
  that fails to link as an error distinct from a test failure; a pass/fail count alone can under-state
  what actually happened, since a file whose module graph never linked contributes neither a pass nor a
  fail for its own tests). That omission is the bug L3 names, not a specific number now known to be
  wrong — the raw log from that run is gone. Re-run today (2026-09-27, same worktree, same 25-file
  list at `/tmp/pglite-sample.txt`, same four files, same order) to replace it with a citation that
  states both counts explicitly: 413 pass, 0 fail, 0 errors across 29 files
  (`/tmp/w18-hygiene-3-gc9-sample-rerun.log`; `bun test` prints an explicit "N error(s)" line whenever a
  module fails to link; its absence here is confirmed, not assumed, by grepping the full run's output
  for "Unhandled error" / "SyntaxError" / "not found in module", zero matches). Going forward, any
  citation of a multi-file run's result in this doc states pass, fail, AND error counts together, never
  pass/fail alone.
  A DIFFERENT, PRE-EXISTING, UNRELATED issue was reported at the time as surfacing in that 25-file
  sample (`Export named 'checkRole'/'checkProjectRole'/'requireRole' not found in module
  '$server/auth/middleware'`), confirmed present identically whether this item's fix is applied or not
  (reproduced against the pre-GC9 committed head with the same sample) — a latent partial-
  `auth/middleware`-mock collision among files in that random sample, unrelated to and not caused by
  this item. It did NOT reproduce in today's re-run (0 errors, confirmed above) — multi-file `bun test`
  module-load order is not fully pinned by argument order alone, so a collision between two specific
  mocks can be present in the file set without triggering on every invocation. The underlying bug is
  independently confirmed elsewhere regardless (item C2's GC12 converts the `$server/auth/middleware`
  offenders this collision comes from), so its absence from today's specific re-run is not evidence it
  is fixed on this branch — it isn't; C2 owns that fix, not item C.
  EVIDENCE: `/tmp/factory-platform-evidence/w18c/leak-fix-alias-withdrawal.{diff,README.txt,results.txt}`.
  Typecheck, lint, gate-integrity, both boundary checks all 0; shared `.git/config` `core.bare`
  unchanged (`false`) throughout; `mock-cleanup-coverage.test.ts` still 34/34 (the alias this item's
  files claim, `$server/db/queries/extensions`, is unchanged, so the guard's own coverage of it is
  unaffected).

- [x] GC10: the six further offenders GC9's extended F1 guard found — each converted, per the
  coordinator's ruling, as its own file-level fix, and the guard's by-name `PENDING_ELSEWHERE`
  exemption removed entirely (an exemption that exists so a new guard passes is an EXCLUDES list,
  forbidden here). All six shared the same bug shape as GC9's `ExtensionRegistry` piece: a
  `$server/extensions/registry` alias replacement of the whole module (or, for `phase-2b-e2e.test.ts`,
  a partial-shape alias factory), which is a PERMANENT registration — any later file's own
  `getInstance()` call would keep resolving through the earlier file's narrow stub forever. Fix
  pattern, identical across all six: register no alias at all; `spyOn()` the real, cheap in-memory
  `ExtensionRegistry.getInstance()` singleton's specific method(s) (`reload`, `killAll`, `getProcess`,
  as each file needed), inside `beforeAll` (test-execution time, never module top level — GC9's own
  multi-file stale-spy bug is exactly what top-level placement causes); un-spy and
  `ExtensionRegistry.resetInstance()` in `afterAll`, un-spying BEFORE the reset so `resetInstance()`'s
  own `killAll()` call hits the real implementation, not a possibly-throwing spy.
  - `src/__tests__/hub-render-pull.test.ts`: `spyOn(ExtensionRegistry.getInstance(), "getProcess")`.
  - `src/__tests__/extension-events-hub-branch.test.ts`: same, delegating to the file's existing
    `fakeProc`/`spawnShouldFail` fixtures.
  - `src/__tests__/phase-2b-e2e.test.ts`: `spyOn(ExtensionRegistry.getInstance(), "reload")`
    (the file's own mock only ever stubbed `reload`).
  - `web/src/routes/api/import/__tests__/commit.test.ts`: `spyOn(ExtensionRegistry.getInstance(), "reload")`.
  - `web/src/__tests__/extensions-api.test.ts`: `spyOn(…, "reload")` + `spyOn(…, "killAll")`; its
    `extension-lifecycle-service` mock also moved off the `$server/*` alias onto the relative path only
    (spread over `serverModule("extensions/extension-lifecycle-service", {})`), matching GC9's pattern.
  - `web/src/__tests__/extensions-events-route.test.ts`: `spyOn(ExtensionRegistry.getInstance(), "getProcess")`.
    This file also had its own, SEPARATE pre-existing bug, found and fixed as directly adjacent work in
    the same file: its `$server/runtime/sse-conversation-filter` mock called `serverModule(...)`
    *lazily inside* the `mock.module()` factory callback — since that alias resolves to the same
    absolute module the relative `require()` inside `serverModule()` reaches, the call landed on this
    same in-progress mock registration and returned only the override, silently dropping every real
    export (surfacing as `Export named 'SCOPED_RUNTIME_EVENT_TYPES' not found`). Fixed by precomputing
    the merged real+override object ONCE, before the `mock.module()` call — the same precompute-once
    shape `serverModule()`'s own callers elsewhere already use for exactly this reason.
  PROOF (file alone, then a pair with the file that follows it in the focused order — the order the
  guard's removed exemption list enumerated them in): `hub-render-pull.test.ts` alone 27/0; paired with
  `phase-2b-e2e.test.ts` 35/0. `phase-2b-e2e.test.ts` alone 8/0; paired with
  `extension-events-hub-branch.test.ts` 27/0. `extension-events-hub-branch.test.ts` alone 19/0. A pair
  with the next file in the order (`commit.test.ts`) is not meaningful as a same-process proof: `web/`
  runs its own files via a separate `bun test` invocation under `web/bunfig.toml`'s own root, so a
  `src/__tests__` file and a `web/` file never share a module registry and cannot pollute each other by
  construction. `commit.test.ts` alone 13/0; paired with `extensions-api.test.ts` 68/0.
  `extensions-api.test.ts` alone 55/0. `extensions-events-route.test.ts` alone 44/0.
  The `extensions-api.test.ts` + `extensions-events-route.test.ts` pair, in EITHER order, hits a
  DIFFERENT, PRE-EXISTING, UNRELATED bug: both files register their own partial
  `$server/auth/middleware` mock.module() factory (`extensions-api.test.ts` supplies `requireRole`/
  `checkRole` only; `extensions-events-route.test.ts` supplies `checkProjectRole` only), and the alias
  registration is permanent — whichever file runs first freezes the other's route on the narrower
  shape (`checkProjectRole` missing one order, `checkAuth` missing the other). Confirmed unrelated to
  this item's fix: reproduced identically with the ORIGINAL committed `extensions-api.test.ts` swapped
  in for the fixed one (still fails, same error), and this exact bug class
  (`auth/middleware`) is already called out by name in GC9's own guard comment as a separate,
  previously-disclosed candidate survey out of item C's scope (item E's, not item C's). Not fixed
  here; reported only.
  Full-guard re-run after removing `PENDING_ELSEWHERE` entirely: `mock-cleanup-coverage.test.ts` 34/0,
  zero offenders repo-wide.
  EVIDENCE: typecheck (backend + web + backend-tests + web-e2e + locked Python `mypy --strict`, all
  clean), `bun run lint` (5637 files, no fixes needed), `gate-integrity.ts` PASSED, `check-boundaries.ts`
  (5727 source files, 0 violations), `check-factory-boundaries.ts` PASSED, full backend per-file-isolated
  pool (`scripts/test.sh`) and full web bun-leg pool (`scripts/test-web.sh`, 3630/0 across 194 files).

- [x] GC11: GC5 — the three production git wrappers the coordinator named (`src/extensions/git.ts`'s
  `gitExec()`, `scripts/unlanded-branches.ts`'s internal `run()`, `docs/extensions/examples/docs-updater/index.ts`'s
  `HERMETIC_GIT_ENV`), fixed under all five of the coordinator's conditions.
  1. ONE PRODUCTION DEFINITION: `withoutGitContext(env)` — strip every `GIT_*`-prefixed variable, nothing
     else — lives in a NEW production module, `packages/@ezcorp/sdk/src/git/index.ts` (a new `./git`
     package export, `dist/git/` built alongside the existing subpaths). Deliberately narrow: it does
     NOT touch `HOME`, `XDG_CONFIG_HOME`, or disable global/system git config — only the confirmed,
     previously-incidented threat (a git hook's `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/etc.
     silently redirecting a `cwd`/`-C`-scoped command onto the wrong repository) is defended against,
     so a caller that depends on the host's transport/auth config (a credential helper, an `insteadOf`
     rewrite, a container's `safe.directory` entry, `gh`'s own HOME-based auth) keeps working unchanged.
     Every test helper now DELEGATES to this one definition rather than reimplementing it — the SDK's
     own `isolatedGitEnv()` (`../test/filesystem.ts`) layers a scratch `HOME` + `GIT_CONFIG_NOSYSTEM`
     on top of it (full isolation, for tests that WRITE); `src/__tests__/helpers/scratch-git.ts`'s
     `withoutGitContext` is now a bare re-export of the SDK's, removing a second, independent
     strip-loop implementation that had silently drifted into existence alongside `isolatedGitEnv`'s
     own (a DRY violation predating this item, found and fixed in passing). No production module
     depends on any test helper — test helpers depend on the production module, never the reverse.
  2. NO BEHAVIOUR CHANGE: verified by running every existing consumer of the changed functions
     unchanged — `source-parser.test.ts`/`source-parser-git-coverage.test.ts` (gitExec/clone/
     lsRemoteTags/getCurrentRef), `unlanded-branches.test.ts`, `git-hooks.test.ts`,
     `gate-scripts.test.ts`, the docs-updater and repo-activity-notify example test suites, the full
     `packages/@ezcorp/sdk` test suite (1027/0/1-skip across 56 files), and a broader sweep of every
     `scratch-git.ts` consumer (383/0 across 8 files) — all green, unchanged. The docs-updater fix
     deliberately keeps `makeProductionShell`'s (git+`gh` mixed) runner on the SAME hardened env
     (`hermeticGitEnv()`) since the added strip never touches `HOME`, so `gh`'s own auth is
     unaffected — verified via that file's own `makeProductionShell` test.
  3. POISONED-ENV GUARD-WITH-CONTROL, one per wrapper, each independently confirmed to FAIL without
     its fix (temporarily reverted, re-run, restored) before being accepted:
     - `gitExec()`: a new `describe` in `source-parser-git-coverage.test.ts` builds a target + a
       foreign real repo, mutates `process.env.GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` toward the
       foreign one (valid here — `gitExec` explicitly spreads `process.env` at call time, confirmed by
       an isolated repro), and asserts `git log` on the target still reports the target's own commit.
     - `unlanded-branches.ts`'s `run()`: the ORIGINAL bug (env omitted entirely) is NOT reachable by
       mutating `process.env` in-process — confirmed by an isolated repro that Bun's default env
       inheritance for an omitted `env` key does not re-read `process.env` live, only an explicit
       `{...process.env}` spread does. So this one's guard spawns the CLI as a REAL child process with
       the poison baked into its environment from start (mirroring `dev-image-provenance.test.ts`'s /
       `podman-compose-wrapper.test.ts`'s existing convention for the same reason), in a new `describe`
       in `unlanded-branches.test.ts`.
     - docs-updater's `readGitHead`/`readCommitSubjects`/`readOriginUrl`: a new `describe` in
       `src/extensions/first-party-integration/docs-updater/git.test.ts` builds a target + a foreign
       scratch repo and mutates `process.env` the same way as `gitExec` (valid here too — confirmed by
       the same repro finding, since these three explicitly spread `process.env` at call time).
  VALIDATOR-3 CORRECTION (F2, medium): this entry originally named three production wrapper sites and
  reported a fourth (`repo-activity-notify`) as merely "found in passing, not fixed" — incomplete.
  Validator-3 poisoned the ambient environment (recipe below) and ran the 17 Group-1 git-init test
  files plus their siblings one file per process; 7 of 17 failed with 21 tests total, naming FOUR real
  production wrapper sites this item's scope touches (the fixes for all four landed in this item;
  `repo-activity-notify`'s specific fix is GC13, below, since the coordinator's re-sequencing put it in
  item C2 rather than folding it into GC11's own three):
  POISON RECIPE (validator-3's, `/tmp/factory-platform-evidence/w18-hygiene-validation/itemC/poison.sh`):
  a real scratch "dummy" repo at `$D`, then every file run as
  `env GIT_DIR=$D/.git GIT_INDEX_FILE=$D/.git/index GIT_WORK_TREE=$D GIT_COMMON_DIR=$D/.git
  GIT_OBJECT_DIRECTORY=$D/.git/objects HOME=$H timeout 600 bun test --timeout 60000 ./<file>`, one file
  per process (no lock needed). A snapshot of `$D` before and after every run, plus an explicit control
  (the same poison, no protection, does write into `$D`), proves the poison is both harmless-if-ignored
  and effective-if-not.
  - `src/extensions/git.ts`'s `gitExec()`: 7 failures — `src/__tests__/source-parser-git-coverage.test.ts`
    (3) + `src/__tests__/source-parser.test.ts` (4).
  - `scripts/unlanded-branches.ts`'s `run()`: 5 failures — `src/__tests__/unlanded-branches.test.ts`.
  - `docs/extensions/examples/docs-updater/index.ts`'s `HERMETIC_GIT_ENV`: 7 failures (IS triggered —
    this entry's first draft said "not triggered"; that was wrong) —
    `docs/extensions/examples/docs-updater/index.integration.test.ts` (3) +
    `src/extensions/first-party-integration/docs-updater/git.test.ts` (4).
  - `docs/extensions/examples/repo-activity-notify/index.ts`'s `readGitHead` (undisclosed in this
    entry's first draft): 1 failure —
    `src/extensions/first-party-integration/repo-activity-notify/git.test.ts`.
  Total: 20 real failures across four sites. The 21st (`src/__tests__/git-install.test.ts`, 1 failure)
  is a METHODOLOGY ARTIFACT, not a fifth site: poisoning `HOME` moves rootless podman's image store,
  which this test's runner depends on regardless of git isolation — `RunnerError: ...image not known`,
  unrelated to any git-context bug. Stated explicitly so it is never miscounted as a real site.
  4. COVERAGE: every changed line, and the one new file, verified covered via targeted `--coverage`
     runs cross-checked from both sides of the package boundary — `packages/@ezcorp/sdk`'s own suite
     (`src/git/index.ts` 100/100; `src/test/filesystem.ts`'s changed `isolatedGitEnv` lines covered,
     its only gap the pre-existing, untouched `gitInDirectory`/`outsideAnyGitRepository`) and the main
     repo's suite (`src/extensions/git.ts` 100/100; `scripts/unlanded-branches.ts` 98.27%, its only gap
     the pre-existing, untouched `if (import.meta.main)` CLI bootstrap; `docs-updater/index.ts`'s
     changed `hermeticGitEnv()` + all four call sites covered, gaps are pre-existing unrelated code
     elsewhere in the file; `scratch-git.ts`'s changed re-export line covered, its only gap the
     pre-existing, untouched `scratchRepository()`). The full repo-wide `check-patch-coverage.ts` CI
     gate was not run (its `origin/main` diff base does not correspond to this branch's actual history
     and a full-repo coverage pass is a ~6-40 minute separate CI job); the per-file cross-checked
     verification above answers the same question with more precision than that blunt tool would.
  5. RECORDED here and in `tasks/todo.md`.
  A fourth instance of the SAME weaker pattern (`GIT_CONFIG_GLOBAL` only, no `GIT_DIR` strip) at
  `docs/extensions/examples/repo-activity-notify/index.ts` was found in passing and reported to the
  coordinator, but this entry originally undercounted it as "not fixed here" without naming it as a
  poison-confirmed real site — corrected above (VALIDATOR-3 CORRECTION). Its fix is GC13, in item C2.
  EVIDENCE: typecheck (backend + web + backend-tests + web-e2e + Python, all clean), `bun run lint`
  (5639 files, no fixes needed), `gate-integrity.ts` PASSED, `check-boundaries.ts` (5727 files, 0
  violations), `check-factory-boundaries.ts` PASSED.
  FOLLOW-UP: a full 1956-file backend regression sweep run alongside this item's own targeted
  verification caught one real gap the targeted checks did not exercise:
  `ci-test-set-drift.test.ts` failed because `packages/@ezcorp/sdk/src/git/index.test.ts` (this item's
  new coverage for `withoutGitContext`) was the first test file outside `sdk_leg_files()`'s four listed
  search directories, so no CI job would ever have run it. Fixed by adding
  `packages/@ezcorp/sdk/src/git` to that function's search paths (`scripts/lib/test-file-sets.sh`).
  The same sweep's other apparent failure, `bundled-source-lock.test.ts`, was a timing artifact — the
  sweep read `manifest.lock.json` mid-run, before `bun scripts/regenerate-manifest-lock.ts` had been
  run for the docs-updater edit; re-run alone against the committed state, it passes. Committed
  separately (`8ce48ca9e`).

## Item C2 (branch `wp/w18-hygiene-c2`, from item C's accepted head)

Per the coordinator's re-sequencing: item C stayed test-and-hook only (GC5 and the auth/middleware
finding moved here so item C's own validation and merge stay simple). This branch rebases onto item
C's head whenever it moves.

- [x] GC12: `$server/auth/middleware` added to the F1 walker's guarded modules; every partial mock of
  it repo-wide converted; the walker itself extended to recognize the shape the fix actually needs.
  SCOPE FOUND VIA THE REAL WALKER, NOT GUESSED: adding the target to `TARGETS` in
  `mock-cleanup-coverage.test.ts` found 38 offenders repo-wide (not the 2 the coordinator named to
  start with — those 2 are among the 38). The other ~41 files that reference this module are either
  already complete (`serverModule()`-style, 10 files) or are Vitest `.server.test.ts` files using
  `vi.mock()` — a different test runner with a different isolation model, outside `mock.module()`'s
  alias-freeze mechanism and this walker's mechanism entirely.
  FIX MECHANISM, STRONGER THAN serverModule() ALONE: unlike extension-lifecycle-service/registry
  (missing-export only), auth/middleware mocks collide on VALUE, not just shape — two files can both
  supply a COMPLETE factory with DIFFERENT `requireAuth` behavior, and whichever registers last wins
  for both in a shared process. Confirmed on the coordinator's named pair
  (`extensions-api.test.ts`/`extensions-events-route.test.ts`): reproduced the original bug on the
  unfixed committed pair first (`SyntaxError: checkProjectRole not found`), then fixed by moving the
  `mock.module()` registration into `beforeAll` (completed via a module-top-level-precomputed
  `serverModule("auth/middleware", {})`), with the alias handed back to the real module in `afterAll` —
  the same beforeAll-not-top-level principle as GC9's `ExtensionRegistry` fix, applied to `mock.module()`
  itself rather than `spyOn()`. Proven: both files alone green, both orders of the pair green (99/0
  each), reproduced on the unfixed pair to confirm the fix is load-bearing.
  WALKER GAP FOUND AND FIXED: `isCompleteServerFactoryBody` didn't recognize `{ ...realThing, override }`
  where `realThing` is a PRECOMPUTED VARIABLE (not an inline `serverModule(...)`/`require(...)` call) —
  every prior TARGET (extension-lifecycle-service/registry) avoided the alias-retention case entirely
  (GC9's fix drops the alias registration outright), so this shape had never been exercised by the
  walker before. Extended `isCompleteServerFactoryBody` to resolve a spread identifier back through its
  own `const NAME = <expr>;` declaration (reusing `resolveConstDecl`), recursively checking THAT
  expression — pinned by six new fixture tests in a new `describe("$server/* factory completeness
  detector...")` block before touching the repo-wide scan.
  CONVERSION AT SCALE: all 38 files converted, dispatched across four parallel agent batches (~9-10
  files each) following the proven pattern, each file's pass count recorded before and after (identical,
  0 fail both times) and independently spot-checked. `mock-cleanup-coverage.test.ts`'s extended F1 guard
  confirms zero offenders (40/40, no exemption list — none was ever added; `TARGETS` was extended
  directly).
  DUAL-SPECIFIER FOLLOW-UP: 10 of the 38 ALSO registered a second, relative-path mock of the same
  module (`../auth/middleware` or `../../auth/middleware` — the "dual-specifier lesson" already
  established elsewhere in this codebase: some routes resolve via the alias, others via the relative
  path, so both need the same complete, correct value) that the walker doesn't check (it only targets
  the `$server/*` alias literal) and the four batch agents correctly flagged as out of their assigned
  scope rather than silently leaving it. Fixed identically (moved into the same `beforeAll`/`afterAll`,
  completed the same way) for all 10:
  `src/__tests__/{provider-api-crud,local-model-test-endpoint,provider-test-connection,provider-status-api}.test.ts`
  and `src/__tests__/security/{h3b-conversation-subroutes-idor,kb-retrieval-is-user-scoped,h3-conversations-memories-idor,kb-ownerless-rows-are-shared,m3-fs-list-sandbox,h2-tool-call-ownership}.test.ts`.
  NOT chased further: files that mock ONLY a relative path (never the alias) are outside the walker's
  stated target and were not enumerated — a materially larger, separate investigation, reported to the
  coordinator rather than silently expanded into.
  EVIDENCE: typecheck, lint, `gate-integrity.ts`, both boundary checks all clean. Per-file before/after
  pass counts recorded for all 48 touched files (38 + 10 dual-specifier). A combined multi-file
  regression run of all 38 converted files (two groups — `src/` and `web/`, since they run under
  separate `bun test` roots — under the heavy lock) is [queued/pending; update on completion].

- [x] GC13: `docs/extensions/examples/repo-activity-notify/index.ts`'s `readGitHead` — the fourth
  instance flagged in passing during GC5 (only `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`, never
  `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`) — now goes through `withoutGitContext()`, same as the
  other four wrappers. Only one spawn call site in this file (no `gh`-mixed runner to preserve, unlike
  docs-updater's `makeProductionShell`). Verified via `docs/extensions/examples/repo-activity-notify/`'s
  own test suite (`boot`, `extension`, `git-broker`, `index.integration`, `index` — 26 tests, one
  PRE-EXISTING unrelated failure — `ContractError: Runtime tool dispatcher was not registered` in
  `extension.test.ts` — confirmed present identically on the unmodified committed file, reported not
  fixed) plus `src/extensions/first-party-integration/repo-activity-notify/git.test.ts` (2/0).

- [x] GC14: repo-wide guard that every production `git` subprocess spawn (literal `Bun.spawn(["git",
  ...`/`Bun.spawnSync(["git", ...`) goes through `withoutGitContext()` — new file
  `src/__tests__/git-spawn-context-guard.test.ts`. Scans `src/`, `scripts/`, `packages/`,
  `docs/extensions/examples/` (production only — test files excluded; a test's own git isolation is
  `scratch-git.ts`'s established, separate concern). Recognizes: a direct `withoutGitContext(...)` call;
  a same-file helper function call (`hermeticGitEnv()`) whose own body calls it; a bare/shorthand
  variable reference whose own `const` declaration resolves — possibly through ANOTHER level of a
  helper call — to something that does (`gitInDirectory()`'s `env` → `isolatedGitEnv(home)` → its own
  `withoutGitContext(env)`). Declaration/call resolution uses the NEAREST PRECEDING match in the file,
  not the first one — a same-named `const`/function in an unrelated, earlier scope cannot be mistaken
  for the one actually referenced (found and fixed during development: a naive first-match resolver
  incorrectly resolved `gitInDirectory`'s own `env` to an unrelated, earlier `buildHarnessEnv`'s `env`
  in the same file). DELIBERATELY NARROW, STATED IN THE FILE'S OWN DOCBLOCK: a generic passthrough
  runner taking an arbitrary `cmd: string[]` (docs-updater's `makeProductionShell`, reused for both
  `git` and `gh`) is not detectable by a literal-argv match and is out of this guard's reach by
  construction — its own env is checked at the pure-git call sites in the SAME file instead.
  Positive fixtures: the four already-fixed wrappers (`src/extensions/git.ts`,
  `scripts/unlanded-branches.ts`, both docs-updater and repo-activity-notify examples) — each confirmed
  recognized and guarded. Negative fixture: nine unit tests pin the detector directly (a raw
  `{...process.env}` passthrough, an omitted `env` key entirely, a non-git spawn not matched at all,
  the shorthand/transitive-resolution cases) before the repo-wide scan runs at all.
  REPO-WIDE SCAN FOUND EIGHT MORE REAL INSTANCES beyond the four named wrappers, none previously
  disclosed: `scripts/{check-visual-evidence,gate-integrity,check-boundaries,verify-browser-coverage-receipt,git-worktree-clean,git-output}.ts`
  and `packages/@ezcorp/ai-kit/src/cli/install.ts`'s `gitProjectRoot()` (a THIRD independent
  reimplementation of the identical GIT_*-strip filter — fixed to delegate to the canonical
  `withoutGitContext()` instead, using ai-kit's already-declared `@ezcorp/sdk` peer dependency, which no
  other ai-kit source file had exercised until now — confirmed safe via ai-kit's own install test suite,
  40/0). `packages/@ezcorp/sdk/src/test/filesystem.ts`'s `gitInDirectory()` was ALSO initially flagged —
  a walker false positive (shorthand `env` property, not a genuine violation; `isolatedGitEnv()` already
  called `withoutGitContext()` since GC5) — fixed in the walker itself (see above), not the file.
  `scripts/git-worktree-clean.ts` needed one additional care: its inner function's own result variable
  was named `process`, shadowing the global `process.env` for its own initializer (a `let`/`const`
  temporal-dead-zone rule) — renamed to `process_`, env computed on the line before.
  Each of the 8 fixes verified with a poisoned-env guard-with-control equivalent: the guard test itself
  is the control (reverted `scripts/git-output.ts`'s fix, confirmed the guard fails with the exact
  offender named, restored the fix, confirmed green again) — a real, load-bearing detector, not vacuous.
  EVIDENCE: typecheck, lint, `gate-integrity.ts` (self-referentially — this gate script is itself one of
  the 8 fixed files, and its own guard check on itself passes), both boundary checks (`check-boundaries.ts`
  is also one of the 8 fixed files) all clean.

- [x] GC15: validator-3's medium finding on GC14 — a real regression, not a false alarm. Converting all
  six gate/coverage scripts (`check-boundaries`, `check-visual-evidence`, `gate-integrity`, `git-output`,
  `git-worktree-clean`, `verify-browser-coverage-receipt`) to `withoutGitContext()` broke ten tests: seven
  in `scripts/check-patch-coverage-typeonly.test.ts`, `"coverage diff gates: dependency-free Git
  controls"` and `"gate-integrity: isolated parser dependency"` in `src/__tests__/gate-scripts.test.ts`,
  and `"checked-in lock matches every source snapshot"` in `src/__tests__/bundled-source-lock.test.ts`
  (a manifest-lock staleness the same edits caused, regenerated).
  TWO INDEPENDENT PROBLEMS, NOT ONE — CORRECTED 2026-09-27 (validator-3 M3: the first version of this
  entry blamed all ten failures on stripping `GIT_*`, then in its own next paragraph said the bare-fixture
  import failure was "exactly what broke all ten tests initially even after adding the class-B helper" —
  a straight contradiction it never resolved. The two mechanisms are independent, and only one of them
  needed a test-observed failure to be real):
  (1) SEMANTIC: these six do not target an explicit repository the caller names (GC11/GC13's four
  wrappers all do — a clone URL, an `ls-remote` URL, an explicit `-C`/`cwd`) — they operate on the
  repository AS INVOKED, including a pre-commit hook's STAGED (not committed) view via `GIT_INDEX_FILE`.
  Stripping `GIT_*` there is a real correctness bug independent of any test that happens to catch it —
  confirmed directly this round (validator-3 M3): a fresh hook-like test on `git-worktree-clean.ts`
  (`src/__tests__/git-worktree-clean.test.ts`) sets `GIT_INDEX_FILE` to a scratch index staged with a file
  the real `.git/index` has never seen, and asserts the reported status names that file as staged
  (`"A  hook-staged.ts"`) — genuinely red when `currentRepositoryGitContext` is swapped for
  `withoutGitContext` (the script then reports `"?? hook-staged.ts"`, reading the real index instead).
  (2) IMPORT RESOLUTION, wholly separate from (1): three of the six (`gate-integrity.ts`, `git-output.ts`,
  `check-visual-evidence.ts`) are each copied whole-file into a bare, `node_modules`-free scratch fixture
  by their own tests (`gate-scripts.test.ts`'s "isolated parser dependency" describe block;
  `check-patch-coverage-typeonly.test.ts`; `visual-evidence-select.test.ts`'s `runScenario()`) — importing
  `@ezcorp/sdk/git` (a workspace package) cannot resolve there, REGARDLESS OF WHICH FUNCTION IS IMPORTED.
  Verified directly (validator-3 M3): temporarily changing `gate-integrity.ts` to `import {
  withoutGitContext } from "@ezcorp/sdk/git"` — the semantically WRONG class, imported instead of the
  local copy — reproduces the identical failure the bare-fixture test showed originally: `"Cannot find
  module '@ezcorp/sdk/git'"`, not a wrong-env assertion failure. This is what actually accounts for the
  bulk of the ten originally-observed failures (the seven in `check-patch-coverage-typeonly.test.ts`,
  which copies `git-output.ts`, and `"gate-integrity: isolated parser dependency"`, which copies
  `gate-integrity.ts`) — they would have failed the SAME way with either class, so long as the fix
  imports rather than locally reimplements. The `"coverage diff gates: dependency-free Git controls"` and
  `bundled-source-lock.test.ts` failures are not part of this mechanism (the former is a
  dependency-footprint assertion on `git-output.ts` also tripped by the new import; the latter is the
  manifest-lock staleness noted above, mechanical and unrelated to git context at all).
  FIX (semantic half): a second named class in `@ezcorp/sdk/git`, `currentRepositoryGitContext(env)` — a
  declared, walker-recognized identity function (returns `env` unchanged) alongside `withoutGitContext()`.
  Every production git spawn now calls exactly one of the two, by name; the guard
  (`src/__tests__/git-spawn-context-guard.test.ts`) checks that, not which is semantically correct for a
  given call site — stated honestly in both the guard's own docblock and `@ezcorp/sdk/git`'s. All six
  gate/coverage scripts reverted to the new class-B helper. New guard fixtures: a direct
  `currentRepositoryGitContext(...)` call is guarded (unit-level), and the six class-B scripts are
  pinned as their OWN positive-fixture group (not merely "guarded" like the class-A four — specifically
  guarded VIA `currentRepositoryGitContext`, so a regression back to `withoutGitContext` on any of them
  fails this specific assertion, not just the blanket zero-unguarded-spawns check).
  FIX (import-resolution half): the three bare-fixture-copied scripts each get a LOCAL, identically-named,
  non-imported copy of `currentRepositoryGitContext` instead of importing it (a one-line identity
  function; duplicating it carries no drift risk) — documented in both the SDK module's own docblock and
  each local copy, cross-referenced. The other three (`check-boundaries.ts`,
  `verify-browser-coverage-receipt.ts`, `git-worktree-clean.ts`) are never copied into a bare fixture and
  keep the normal import. Each of the three local copies is now `export`ed and pinned by a dedicated unit
  test asserting reference equality (`toBe`, not `toEqual`) against the input env, with and without a
  supplied argument (`src/__tests__/gate-scripts.test.ts` for `gate-integrity.ts` and `git-output.ts`;
  `src/__tests__/visual-evidence-select.test.ts` for `check-visual-evidence.ts`) — a drifted local copy
  (one that started stripping GIT_* by accident) would defeat the whole class-B contract silently,
  since the repo-wide guard only checks that SOME function named `currentRepositoryGitContext` is
  called, never what it does.
  PROOF: all ten originally-regressed tests green (217/0 across
  `check-patch-coverage-typeonly.test.ts` + `gate-scripts.test.ts`); the visual-evidence suite, which
  the SAME bare-fixture-copy issue also broke via `check-visual-evidence.ts` (found during this fix,
  not previously reported) — 64/0 across four files; `git-worktree-clean.test.ts` +
  `verify-browser-coverage-receipt.test.ts` + `e2e-lanes.test.ts` — 37/0; the extended guard itself —
  11/0; the SDK's own `git/index.test.ts` — 8/0, 100% coverage on `currentRepositoryGitContext`; all
  eleven files combined in one run — 332/0. `manifest.lock.json` regenerated for the two class-A files'
  changed source digests (`ai-kit/src/cli/install.ts`, `repo-activity-notify/index.ts` — unchanged by
  this entry, already fixed in GC14/GC13). The new hook-context test (semantic half) and the three
  identity pins (import-resolution half) added 2026-09-27: `git-worktree-clean.test.ts` — 7/0 (was 6/0);
  `gate-scripts.test.ts` + `visual-evidence-select.test.ts` — 257/0 combined; genuine red-green control
  demonstrated for each (a reverted class on `git-worktree-clean.ts` flips the hook-context assertion's
  observed status code from `"A "` to `"??"`, matching the semantic mechanism exactly; a wrong-class-but-
  still-imported `gate-integrity.ts` reproduces `"Cannot find module '@ezcorp/sdk/git'"`, matching the
  import-resolution mechanism exactly).
  EVIDENCE: typecheck, lint, `gate-integrity.ts`, both boundary checks all clean (including
  `gate-integrity.ts` and `check-boundaries.ts` checking themselves, now correctly on the keeping side).

- [x] GC16: validator-3's L1 finding on GC14/15 — the repo-wide git-spawn guard's own docblock claimed
  "every production git spawn" while its detection was structurally narrower: it only ever recognized a
  literal `Bun.spawn(["git", ...`/`Bun.spawnSync(["git", ...` argv, missing two real production call
  sites entirely. Both are safe TODAY (each builds its `env` from scratch, never spreading ambient
  `process.env`), so this was a docblock-vs-reality gap, not a live vulnerability — but the guard could
  not have caught a regression on either site, which is the whole point of having one.
  SITE 1: `src/factory/reference-code/git-reader.ts`'s `runGit()` — `node:child_process`'s `spawn(options.git
  ?? "git", args, { env: { PATH: ..., GIT_CONFIG_GLOBAL: "/dev/null", ... } })`, a from-scratch env with no
  SDK helper call at all (a third, independent isolation strategy, same class as the two pre-GC5 hand-
  rolled filters GC14 already found and fixed elsewhere).
  SITE 2: `src/extensions/project-open-pr.ts`'s `createProjectCommandRunner()` — `Bun.spawn(command, { cwd,
  env: environment, ... })` where `command` is a runtime-assembled array (`argv[0] === "git" ? ["git",
  ...GIT_POLICY, ...argv.slice(1)] : argv`), invisible to a literal-argv match by construction.
  `project-git-broker.ts` calls this factory but has no git-spawn code of its own to miss.
  FIX: two new detector families in `git-spawn-context-guard.test.ts`, alongside the original (now
  "family 1"): family 2 recognizes a `node:child_process` `spawn`/`execFile`/`exec` call whose first
  argument is (or `??`/`||`-falls-back to) the literal `"git"`, scoped to files that import from
  `"node:child_process"` (excludes a same-named local function or a namespaced `child_process.spawn(...)`
  call — stated honestly as a scope limit, matching this guard's existing convention). Family 3 recognizes
  any `Bun.spawn`/`Bun.spawnSync` call inside a function/arrow declaration whose name ends in
  `CommandRunner`, by name rather than by argv shape. Both families are held to a NEW, stricter check,
  `isSafeExplicitTargetEnv()` — neither operates on "the repository as invoked" (both take an explicit
  path/argv the caller controls), so unlike family 1's `isGuardedEnvExpr()`, `currentRepositoryGitContext()`
  does NOT satisfy it here; only an explicit `withoutGitContext()` call or a genuinely from-scratch env (no
  `...process.env` spread, however wrapped — a parenthesized or type-cast spread like `...(process.env as
  T)` counts too, caught by regex, not a bare substring check) passes. The repo-wide scan now walks all
  three families over the same file roots; two new positive fixtures pin the two real sites; six new unit
  tests (three per family, including one negative control per family: a bare `{...process.env}` spread, and
  — family 2 only — an explicit `currentRepositoryGitContext()` call, the wrong class for this family)
  pin the detectors before the repo-wide scan runs.
  PROOF: repo-wide scan clean across all three families (zero offenders); both new positive fixtures pass;
  genuine red-green control on both real sites — reverting `git-reader.ts`'s env to `{ ...process.env }`
  and `project-open-pr.ts`'s to a wrapped `...(process.env as Record<string, string>)` spread each
  independently flips the repo-wide scan and that file's own positive fixture to failing, with the fix
  restored to green after; the wrapped-spread case specifically caught a real gap in the first draft of
  `isSafeExplicitTargetEnv()` (a bare-substring check missed it; fixed to a regex before this landed).
  Full guard suite: 19/0 (was 11/0).
  EVIDENCE: typecheck, lint clean.

- [x] GC17: validator-3's L2 finding on the mock-cleanup meta-test — `isCompleteServerFactoryBody()`'s
  naive `if (b.includes("serverModule(")) return true;` accepted a LAZY, INLINE `() =>
  serverModule("X", { ...overrides })` mock.module() factory just as readily as the safe,
  established precomputed-identifier-spread shape (`const realX = serverModule(...);
  mock.module(alias, () => ({ ...realX, ...overrides }))`), but the two are not equivalent: an
  inline call has no guarantee it runs BEFORE the alias's own mock.module() registration takes
  hold, unlike a precomputed call, which always runs first, synchronously, at module load. If the
  alias and the relative `require()` a `serverModule()` call makes ever resolve to the same module,
  an inline call can self-recurse against its own half-registered value and silently come back
  with no exports at all ("item A", predating this branch) — exactly the class of bug this whole
  meta-test exists to catch, missed here because the check only looked for the SUBSTRING
  `serverModule(`, not whether the call had actually been precomputed.
  A REAL, repo-wide offender existed at this shape: `src/__tests__/extension-event-end-to-end.test.ts`
  mocked `$server/db/queries/conversations`, `$server/db/queries/tool-calls`, and (inside this
  file's own TARGETS list) `$server/auth/middleware` all three this way.
  FIX: the check now looks at whether the factory body still starts with an unresolved `() =>`
  wrapper — `extractLibFactoryBodies()`'s own const-resolution (and the spreadIdent branch here)
  already strips that wrapper when a `serverModule(...)` call came from a preceding `const NAME =
  serverModule(...)` declaration, so a body that STILL has it was written directly as the factory,
  never precomputed. Rejected in that case; accepted otherwise (unchanged for the precomputed
  forms). The existing fixture that pinned the WRONG expectation (`() => serverModule(...)` treated
  as complete) is inverted into the negative case this always should have been, plus a new positive
  fixture for the resolved (no-wrapper) form. The real offender is converted to the precomputed
  pattern alongside this fix — same values, same overrides, just precomputed once before either
  registration, matching every other auth/middleware conversion on this branch.
  PROOF: genuine red-first control — reverting just the `$server/auth/middleware` call site in
  `extension-event-end-to-end.test.ts` back to the inline shape (detector fix left in place)
  reproduces exactly one offender in the repo-wide "F1 guard" test, naming that file and alias;
  restored to green after. `mock-cleanup-coverage.test.ts` + `extension-event-end-to-end.test.ts`
  combined: 53/0.
  EVIDENCE: typecheck, lint, `gate-integrity.ts`, both boundary checks all clean.

- [x] GC18: validator-3's follow-up on the focused producer's single failure — "gate-integrity: isolated
  parser dependency" (exitCode null after a 30s timeout, "killed 1 dangling process" logged at the
  run's start) chased to root cause rather than noted.
  WHAT IT SPAWNS/WAITS ON: `runGate()` in this test (`src/__tests__/gate-scripts.test.ts`) is
  `Bun.spawnSync([process.execPath, "scripts/gate-integrity.ts"], {...})` — a full cold bun-runtime
  subprocess running `gate-integrity.ts`'s `main()`, which itself spawns `git merge-base`/`git diff`
  as further nested subprocesses. The test calls this FOUR times sequentially inside one outer test
  timeout.
  WHAT THE DANGLING PROCESS WAS: found bun's own format string in the binary (`strings` on the
  pinned bun binary): `"killed %d dangling process"` is bun:test's own timeout-enforcement message —
  when a test's outer timeout fires while `Bun.spawnSync` is blocked waiting on a child, bun
  force-kills that child and reports it here. It is the SAME event as the assertion's observed
  `exitCode: null`, not a separate leftover from an earlier run.
  REPRODUCED, cheaply and directly, twice over: (1) running `gate-scripts.test.ts` three times in one
  `bun test` invocation (two in-place scratch copies alongside the original, deleted after) failed
  intermittently, roughly 1-in-8 to 1-in-16 attempts, lock-free, no heavy leg needed. `ps -eo
  pid,ppid,etimes,stat,cmd` sampled every second during these runs caught the exact failing process:
  alive continuously from `etimes=0` (state `D`, uninterruptible sleep — blocked in-kernel at
  fork/exec, not CPU-bound) through `etimes=29`, then gone — killed at the cap, in the same run bun
  reported "1 fail" and "killed 1 dangling process". Host snapshot at the time: swap 10 GiB of 16 GiB
  in use, ~3164 processes, loadavg 3.76 on 32 cores. (2) The SAME reproduction repeated properly
  inside the real 405-file focused-producer run, under the shared validation lock, gated before each
  attempt: loaded run 1 (6135 tests across 407 files) was clean; loaded run 2 reproduced it directly
  (`gate-scripts-repro-copy-a.test.ts` timed out the same way, 1 fail).
  CONCLUSION: this is host memory/swap pressure occasionally delaying fork/exec itself (D-state at
  spawn time), not a slow parser or a network install (that class was already fixed 2026-09-26 per
  this test's own comment) and not a defect in `gate-integrity.ts`'s or the test's own logic — every
  isolated single-file run this whole engagement was fast and clean.
  RULING (validator-3, superseding this entry's first draft): a test that runs multiple cold bun
  subprocesses inside ONE shared outer timeout is timing-sensitive by construction — a measured
  single clean spawn taking up to 22s under load means several such spawns can exceed any ONE shared
  budget with no defect anywhere. A blanket timeout bump (this entry's original fix: 30s → 120s
  shared across all three spawns) was rejected in favor of a DESIGN fix: ONE SPAWN PER TEST CASE.
  `gate-scripts.test.ts`'s combined test is split into three (`beforeAll` builds the shared,
  progressively-committed scratch fixture once; `afterAll` tears it down once; the three test bodies
  rely on bun:test's default in-file sequential ordering, the same pattern already used elsewhere in
  this repo for a progressively-built fixture): "fails closed when the TypeScript AST parser is
  unavailable", "passes with the locked parser available and only an asserted test present", "fails
  closed on a vacuous (unasserted) test, parser available" — each with its OWN 60s bound (2× the ~30s
  worst single-spawn duration directly observed under real host contention), the cause written beside
  each bound, and no assertion anywhere on elapsed time (only exit code and output).
  REPRODUCTION CORRECTION: an earlier attempt to reproduce this "properly, inside the real 405-file
  focused-producer run" by adding `gate-scripts.test.ts`'s path twice more to the file list was
  invalid — `bun test` deduplicates by resolved absolute path when the same relative path string
  repeats, so it silently ran once. Corrected with two genuinely distinct scratch copies
  (different filenames, same directory so relative imports resolve unchanged): loaded run 1 (6135
  tests across 407 files) was clean; loaded run 2 reproduced it directly
  (`gate-scripts-repro-copy-a.test.ts` timed out the same way, 1 fail) — confirming run 1's clean
  result was chance, not absence of the mechanism, and confirming the design fix (not an environment
  note) was the correct call.
  PROOF: gate-scripts.test.ts alone, post-split, 216/0 (was 214/0 combined into one test; +2 net from
  the split); five consecutive local three-copy runs (the same reproduction method) after the split,
  all clean (648/0 each, 32-52s each — well inside each case's own 60s bound).
  EVIDENCE: typecheck, lint, `gate-integrity.ts`, the boundary check all clean.

- [x] GC19: validator-3's tree review at 301dcfaac (M1/M3/L1/L2 all held, verified by their own
  mutation controls) plus three findings for this same commit round.
  F-M2 (medium, required): `src/__tests__/web-mock-pair-pollution.test.ts` (M2) encoded the WRONG
  OPEN-1 direction and only ONE OPEN-2 order. The ruled OPEN-1 is `extensions-api.test.ts` THEN
  `extension-settings-api.test.ts` (a read-only API key's PUT/DELETE got 200 instead of 403), fixed in
  `7705cb1cf`, red at `8275cccd4` — the file's own case ran the REVERSE order instead (still a real,
  independently-worth-keeping pair, kept, relabeled "OPEN-1 reverse order"). OPEN-2 was proven red in
  BOTH orders during M1's own fix, but the committed test only ran one ("commit then preview").
  FIX: two new cases. (1) `extensions-api.test.ts` THEN `extension-settings-api.test.ts`, asserting BY
  NAME rather than by aggregate fail-count — a bare fail-count assertion would also pass if the two
  named tests were SKIPPED rather than genuinely exercised and passing. `bun test
  --test-name-pattern` isolates exactly the two "F1 — settings/user writes require the 'extensions'
  scope" tests (`"read-only key"` matches nothing else in either file's actual test names — the only
  other occurrences of that phrase are source comments, invisible to bun's own name-pattern matching,
  confirmed: exactly 2 tests match, 2 pass, 0 fail on the fixed head), and the pass count for that
  FILTERED run must be exactly 2. (2) "import preview (polluter) then import commit (victim)" — OPEN-2's
  other order.
  RED-FIRST PROOF for the new by-name case: checked out both files at `8275cccd4` (git show, restored
  via `cp` after), ran the pair-pollution suite — the new by-name test failed with `result.fail`
  received `2` (both named tests genuinely failed), confirming genuine red at the cited pre-fix commit;
  restored, reconfirmed green (5/5).
  L-a (low): `runFilesInOneProcess()`'s summary parsing took the FIRST regex match anywhere in the
  captured output, which also carries interleaved application JSON logs from the routes under test — a
  false positive was possible in principle even if none was observed. FIX: anchored to a line that is
  JUST `"<N> pass"`/`"<N> fail"` (bun's own exact format, one leading space, digits, the word, nothing
  else — confirmed against captured runs; no JSON log line can ever match this shape) and takes the
  LAST such match, not the first.
  L-b (low): the item-C2 lazy-inline-`serverModule()`/`webLibModule()` guard (GC17) only ever checked a
  short, hand-kept TARGETS list (auth/middleware, extension-lifecycle-service, registry, api-keys) —
  the self-recursion hazard is not specific to those aliases, it is a property of `web/`'s OWN module
  resolution (`.svelte-kit/tsconfig.json` maps `$server/*`/`$lib/*` to the same files the two helpers
  `require()` relatively). MEASURED (validator-3's standby plants,
  `/tmp/factory-platform-evidence/w18-hygiene-c2-standby/`, one alias per helper, lazy vs. precomputed,
  `web/` vs. repo root):

  | helper | alias | root | shape | result |
  |---|---|---|---|---|
  | serverModule | `$server/auth/middleware` | web/ | lazy | `keys=[]`, `overrideApplied=false` |
  | serverModule | `$server/auth/middleware` | web/ | precomputed | 9 real keys, `overrideApplied=true` |
  | serverModule | `$server/auth/middleware` | root | lazy | 9 real keys, `overrideApplied=true` |
  | serverModule | `$server/auth/middleware` | root | precomputed | 9 real keys, `overrideApplied=true` |
  | webLibModule | `$lib/server/security/api-keys` | web/ | lazy | `keys=[]`, `overrideApplied=false` |
  | webLibModule | `$lib/server/security/api-keys` | web/ | precomputed | 12 real keys, `overrideApplied=true` |
  | webLibModule | `$lib/server/security/api-keys` | root | lazy | 12 real keys, `overrideApplied=true` |
  | webLibModule | `$lib/server/security/api-keys` | root | precomputed | 12 real keys, `overrideApplied=true` |

  RULING: refuse both lazy shapes for EVERY `$server/*`/`$lib/*` alias in `web/` test files; the
  root-side lazy shape is safe by this same measurement and stays permitted there — the 25 root-side
  files using an inline `webLibModule()` call (`src/__tests__/**`, `src/integrations/**`, cataloged in
  `inline-weblib-files.txt` in the same standby evidence directory) stay explicitly out of scope for
  this new check (an earlier attempt to reuse the EXISTING, shared `isCompleteLibFactoryBody()`
  unconditionally would have wrongly flagged all 25 as new offenders — reverted; the new check is a
  SEPARATE, `web/`-scoped scan instead, leaving the existing api-keys/extension-lifecycle-service/
  registry/auth-middleware checks, which intentionally also cover root-side, untouched).
  FIX: `src/__tests__/mock-cleanup-coverage.test.ts` gains a new describe block scanning every
  `web/src/**/*.test.ts` file for EVERY `$server/*`/`$lib/*` `mock.module()` factory (regardless of
  which specific alias — `extractAllAliasFactories()`, built from the existing per-alias extraction
  already used by the two named-target guards) and rejecting any that is still `() =>`-wrapped
  (unresolved) and calls either helper.
  RED-FIRST PROOF: a scratch plant, never committed, on `$server/lib/cache-utils` (a real, existing
  module, `src/lib/cache-utils.ts`, not in any TARGETS list) with a lazy `() =>
  serverModule("lib/cache-utils", {...})` factory — caught immediately, correctly named; a second
  plant on a made-up `$lib/*` alias with a lazy `() => webLibModule(...)` factory — also caught. Both
  plants deleted after (confirmed via `git status`, never staged).
  PROOF: `gate-scripts.test.ts` + `mock-cleanup-coverage.test.ts` + `web-mock-pair-pollution.test.ts`
  combined — 264/0.
  EVIDENCE: typecheck, lint, `gate-integrity.ts`, both boundary checks all clean.
