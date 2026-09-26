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
  RESIDUAL — 13 test failures surfaced under poison, in 3 of the 17 files, ALL and ONLY on tests that
  exercise pre-existing PRODUCTION git wrappers this item's scope never touched:
  `src/extensions/git.ts`'s `gitExec()` (spreads `{...process.env}` with no `GIT_*` stripping — used by
  its `clone()`/`getCurrentRef()`/`lsRemoteTags()`, exercised by `source-parser.test.ts` and
  `source-parser-git-coverage.test.ts`) and `scripts/unlanded-branches.ts`'s internal
  `Bun.spawnSync(["git",...args],{cwd})` (no `env` override at all — exercised by its exported `main()`,
  used in `unlanded-branches.test.ts`'s real-git describe block). A third instance of the same gap
  (found earlier, not triggered by this specific poison run): `docs/extensions/examples/docs-updater/index.ts`'s
  `HERMETIC_GIT_ENV` blocks global/system config reads but never strips `GIT_DIR`/`GIT_INDEX_FILE`/
  `GIT_WORK_TREE`. These are production runtime code, not test fixtures — outside item C's stated scope
  ("convert 27 disclosed bare git-init TESTS") — reported to team-lead for a ruling rather than fixed
  unilaterally; item C's own 17 conversions are unaffected by and do not depend on that ruling.
  EVIDENCE: `/tmp/w18-hygiene-3-poison-check.ts`, `/tmp/w18-hygiene-3-poison-check2.ts` (not repo-tracked,
  scratch proof scripts); full failing-test list captured, all 13 map 1:1 to the three production
  call sites above.

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
  17/0, 17/0 — matching W18c's own cited numbers exactly for the four it ran); all four together 44/0;
  the 25-file sample plus all four together 353/0 (the sample alone is 369/0 across 25 files — the count
  differs because the four polluter/victim files are additional, not because anything in the sample
  changed). A DIFFERENT, PRE-EXISTING, UNRELATED issue surfaced only in that 25-file sample (`Export
  named 'checkRole'/'checkProjectRole'/'requireRole' not found in module '$server/auth/middleware'`) —
  confirmed present identically whether this item's fix is applied or not (reproduced against the
  pre-GC9 committed head with the same sample), so it is a latent partial-`auth/middleware`-mock
  collision among files in that random sample, unrelated to and not caused by this item; reported to
  the coordinator, not investigated further here (out of this item's scope).
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
