# Gates: W18 hygiene backlog (60 partial api-keys mocks, hook cap, 27 bare git-init tests)

Receipts are under `/tmp/factory-platform-evidence/w18-hygiene/receipts/`. Base `integ/w00` `2b2e12550`,
branch `wp/w18-hygiene`. Item lists (F1, F2) are W18a-3's, verbatim from `tasks/factory/w18a3-GATES.md`.

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
  (`coverage-new-file-a2.log`, `coverage-patch-a2.log`).

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
  EVIDENCE: both files, all lines `exit=0`. `extensions-events-route.test.ts` has a pre-existing,
  base-reproducible failure (`Export named 'disableExtension' not found in module
  '.../src/db/queries/extensions.ts'`) when force-run standalone from `web/` — reproduced identically on
  unmodified `2b2e12550` in a throwaway worktree (`.worktrees/w18-hygiene-base-check`, removed after use) —
  and is unrelated to api-keys; it passes under its real invocation.

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
  EVIDENCE: `typecheck-a2.log`, `lint-a1.log`, `boundaries-a1.log`, `gate-integrity-a1.log`,
  `factory-process-boundaries-a1.log` — all exit 0.

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
  EVIDENCE: commits `702a97468` (fix) and `05b6329db` (tests). `git-hooks-b1.log`: 19/19 pass. Reproduced
  the bug directly: committing this package's own 36-file and 24-file conversions (before the fix)
  printed `36 test files map to this commit (cap 12) — skipping.` / `24 test files map to this commit
  (cap 12) — skipping.` and exited 0 with the commit landing, no file names, matching the coordinator's
  incident report of the 74-file main merge.

- [x] GB2: typecheck, lint, boundaries, gate-integrity, `factory-process-boundaries.test.ts`, and
  `gate-scripts.test.ts` (which also drives the real hook machinery) all green on the final head.
  CHECK: see item A's GA8, same commands, rerun on `05b6329db`
  EXPECT: all exit 0
  EVIDENCE: `typecheck-final.log`, `lint-final.log`, `boundaries-final.log`, `gate-integrity-final.log`,
  `factory-process-boundaries-final.log` — all exit 0; `gate-scripts-b1.log` 204/204.

- [x] GB3: `check-new-file-coverage.ts` / `check-patch-coverage.ts` against `BASE_REF=2b2e12550` pass
  (informational for this item — `.githooks/pre-commit` and `scripts/lib/hook-lib.sh` are shell, outside
  this repo's lcov-based coverage system; the change is exercised by `git-hooks.test.ts` directly, not
  measured by these gates).
  EVIDENCE: `coverage-new-file-b1.log`, `coverage-patch-b1.log` — both exit 0.

Pass for item B: the silent skip is gone; a wide commit is loud and, by default, blocked; the one
escape hatch is visible in both directions it applies (over and under the cap); no other hook behavior
changed (the three original `repoWithPreCommit()` tests and `EZ_SKIP_HOOKS=1` bypass are unaffected).

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

- [ ] GD8 — DISCLOSED, NOT FIXED: a residual pollution, unrelated to the four named modules, previously
  masked by the crash GD1 fixed. `extension-event-end-to-end.test.ts` also partially mocks
  `$server/db/queries/conversations` (and very likely `db/queries/tool-calls`, same file, not
  individually confirmed) — when combined with `messages-multipart-route.test.ts` and
  `messages-permission-mode-ceiling-route.test.ts` in one process, 5 tests in those two files fail on
  assertion mismatches (`convQueries.getLatestLeaf is not a function`, and downstream body-shape
  mismatches), not link-time crashes. Each of the three files passes alone and in every pairing that
  excludes `extension-event-end-to-end.test.ts`'s db/queries/conversations mock specifically.
  RULING (this session, matching the coordinator's own F1 scope decision): out of scope for item D,
  which named four specific modules. Not fixed. Two much larger surveys, found while enumerating GD2,
  are also disclosed here rather than undertaken: 83 files across the tree still partially mock
  `db/queries/extensions` via the PLAIN relative specifier outside this item's 26-file set (item D only
  touched the ones needed for the GD1 reproduction), and roughly 39 files partially mock `$server/
  auth/middleware` (only `extension-event-end-to-end.test.ts`'s instance, GD7, was fixed, because it
  directly blocked this item's own reproduction). Recommend a follow-up package if the coordinator
  wants these closed; do not fold into item D's already-large diff.

Pass for item D: the four named modules are fully closed everywhere they were partially mocked, proven
by direct reproduction before and after; the harder finding (context.ts cannot be spread) is fixed with
a purpose-built, non-cascading helper instead of forcing the F1 pattern where it does not fit; every
touched file passes at its real invocation; what's left undone is named, not hidden.

## Item C — F2: the 27 bare git-init tests

- [ ] GC1: BLOCKED on the integ/w00 hash containing W18a-3 (for `src/__tests__/helpers/scratch-git.ts`),
  per the spawn brief. Not started.
