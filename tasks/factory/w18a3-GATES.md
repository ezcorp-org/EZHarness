# Gates: W18a-3 — initPglite, loadExisting, compute-admissions order, test-path imports

Receipts are under `/tmp/factory-platform-evidence/w18a3/`. `steps.jsonl` records each gate run with its head,
exit code, and times. The combined runner is an unchanged copy of `/tmp/factory-platform-evidence/w00/combined-integration.py`.

## Package branch

The package branch is `wp/w18a3-quality-r2` (coordinator ruling 2026-09-24); `wp/w18a3-quality` stays at f7d79e629.
The three fixture-authored commits were rebuilt with `git commit-tree` on their own trees and parents, with only the
author changed to archy: db1ad8652 -> 48da9c886, 15bb52e0b -> 48ad53775, f7d79e629 -> 5e4772016 (parents d6914c53b
and 6c8ec29c5 kept). A plain rebase would have linearized the merge and rewritten about 30 integ/w00 commits.
Identical-tree proof: `git diff --quiet f7d79e629 5e4772016` exits 0, and each pair has the same tree id
(`git rev-parse <sha>^{tree}`). `backup/w18a3-quality-fixture-authored` keeps f7d79e629 until the merge lands.
The four leak commits were first made on `wp/w18a3-leaks` (from the staged main merge 0d3671c51) and were then
cherry-picked onto -r2 after the merge of integ/w00 7a87aed5e: 2c03e3625 -> e8bba6baf, 9e14d178c -> fb4c8c2e0,
0ae26f4b0 -> 0221670af, 17e2e8a63 -> 0d5e64514. The ten files they touch are byte-identical on both branches.
`wp/w18a3-leaks` is kept until the merge lands.

## Gates

- [x] G1: initPglite is judged only because the gate ran on an uncommitted merge. No leg is missing, and the gap is not real on a committed tree.
  CHECK: `BASE_REF=origin/main bun scripts/crap-score.ts --changed` over the integrator's merged lcov, in three states
  EXPECT: the committed merge does not judge initPglite
  EVIDENCE: `initpglite-staged-merge-repro.txt`. The gate takes touched lines from `git diff <merge-base>...HEAD`
  and scores the working-tree files. At the pre-merge head 39a7189e0, the diff still touched line 435 of
  initPglite. With that HEAD and the merged `connection.ts` in the working tree, as in a staged merge, initPglite
  scores 420.0. At the committed merge 8949b300b, the same lcov judges only loadExisting.

- [x] G2: loadExisting is split into named units with no behaviour change.
  CHECK: complexity rules of `scripts/crap-score.ts` (`cx.ts`); an old-versus-new run on generated wrap stores
  EXPECT: loadExisting at or below 5; 0 differences
  EVIDENCE: loadExisting 6 -> 4, with `ownWrapsNewestFirst` (1) and `openWrap` (3). loadOrCreate now uses the
  same `openWrap` instead of its own copy of the loop body. `encryption-differential.txt`: 4967 cases, 0 differences,
  covering keys at versions 1, 2, and 3 and refusals. The encryption suites pass unchanged in bun (36), node (10),
  and PostgreSQL (42).
  Update 2026-09-24 (continuation): the merge of integ/w00 6c8ec29c5 took `encryption.ts` from integ/w00. Its
  `open()` gives `loadExisting` and `loadOrCreate` one shared wrap opener, so the split's aim holds in a different
  shape: `loadExisting` measures 3 and `open` 5 (`cx.ts`). The direct `loadExisting` tests are in the tree, and
  the CRAP gate over the final merged lcov does not name any `encryption.ts` function.

- [x] G3: The compute-admissions order dependence is found and fixed, with the assertions as strong or stronger.
  CHECK: `repro/compute-flake-loop.sh` (the W16 loop adapted to a PostgreSQL suite; each copy creates its own databases), base versus head at the same settings
  EXPECT: red at base under load; 0 red at head under the same load
  EVIDENCE: 15 rounds of 6 copies under 26 CPU burners each. Base d5ee52309: 12 red of 90 (`compute-flake-base3.log`).
  All 12 are the ordering fault: 8 at line 153 and 4 at line 194. Head d6914c53b: 0 red of 90, at a load of 38–51 (`compute-flake-fixed3.log`).
  The cause is that `enlisted()` reset the product clock to `Date.now()` for every case. A delivery settled for
  retry comes due one second later, so a loaded host crossed that second and `dispatchNext` served an earlier
  case's retry. The fix keeps one test clock that only the test advances. It drains the lost retry explicitly and
  asserts its answer, and it pins the reservation id on the raced and revoked dispatches. There are no retries
  and no timeout increases.
  An 8-copy run is also kept (`compute-flake-base.log`, `compute-flake-fixed.log`). Its extra reds at both heads
  are PostgreSQL "too many clients" from the loop itself, so the 6-copy run is the proof.
  The test file is unchanged from d6914c53b to the final head. The combined runner's PostgreSQL list does not
  include it, so one real-PostgreSQL run at d2c025a29 is queued on the heavy lock (`continue/compute-admissions-final.sh`,
  result in `final-d2c025a29/steps.jsonl` as `compute-admissions-pg`).

- [x] G4: A non-test file may not import a test path.
  CHECK: `bun scripts/check-boundaries.ts`; `bun test ./src/__tests__/gate-scripts.test.ts`
  EXPECT: 0 violations on the tree; a deliberate violation exits 1
  EVIDENCE: `boundary-tree.txt` (5555 files, 0 violations) and `boundary-deliberate-violation.txt` (a
  `src/factory/boot.ts` import of `src/__tests__/helpers/test-pglite` exits 1). The suite covers rejected edges
  from src, web, scripts, and packages, the allowed test-to-test and data cases, and the test-path definition.
  Two verification harnesses imported test helpers from `scripts/`, so they moved to `scripts/__tests__/live/`.
  No path is excluded.

- [x] G5: The hook runs staged tests without the git context it exports, and no scratch repository uses the caller's git context.
  CHECK: `bun test ./src/__tests__/git-hooks.test.ts ./src/__tests__/gate-scripts.test.ts`; `continue/poisoned-env-e2e.sh`
  EXPECT: the test process sees no GIT_* variable; a dummy repository named by every GIT_* variable and HOME stays byte-identical
  EVIDENCE: commits 48da9c886 (hook-lib `without_git_context`) and d2c025a29 (shared `helpers/scratch-git.ts`,
  scratch HOME, guard test with a control). `continue/poisoned-env-e2e.txt`: the whole gate-scripts suite with
  GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY, and GIT_PREFIX set to a dummy
  repository. The file at f7d79e629 wrote `patch-fixture@example.test` into the dummy's config; the file at
  d2c025a29 exits 0 and leaves the dummy unchanged. The commit of d2c025a29 went through the real pre-commit
  hook (gate-scripts 210 pass, git-hooks 17 pass), and the shared config's sha256 was the same before and after.
  9dc2ba9fb adds GIT_CONFIG_NOSYSTEM=1 to `scratchGitEnv` (validator-3 L3); the unit test pins it, also over a
  caller's GIT_CONFIG_NOSYSTEM=0, and the guard test pins that it is the only GIT_* variable left.

- [x] G6: Every producer is green at the final head over the fullest lcov, and the tree is clean.
  CHECK: `g6-c5507c5ce/heavy.sh` (disk check, `continue/final-sweep.sh`, disk check, backend pool at umask 022 under
  the lock), then `g6-c5507c5ce/remerge-gates.sh`; receipts in `g6-c5507c5ce/receipts/*.json` (commit, command,
  exit, times, log sha256)
  EXPECT: every producer exits 0; CRAP --changed exits 0; new-file and patch vs integ/w00 15410e421 exit 0
  EVIDENCE at c5507c5ce (the merge of integ/w00 15410e421, W15b included), clean tree, 151 GB free before each
  heavy leg (`g6-c5507c5ce/df.txt`):
  - All 17 runner producers exit 0, pool-coverage included (`final-c5507c5ce/runner.log`, `w18a3-final-results.json`).
  - Backend pool at umask 022: 28983 pass, 0 fail, 1955 files, exit 0 (`g6-c5507c5ce/logs/backend-pool-umask022.log`,
    sha256 1abcd562...). The 14 main-origin reds (F3, F4) are gone; the earlier pool had 15 fail.
  - The runner's web-bun leg omits `web/src/__tests__/mock-llm-store.test.ts`, the suite that covers W19a's
    `promptWords` (a leg-list gap, not a test gap). `remerge-gates.sh` adds it as one web extra leg with the same
    re-rooting; `final-sweep.sh` now lists it. Over the 30-input merge (`fullest-lcov-remerged.info`, sha256
    8404badd...): CRAP --changed exit 0; new-file and patch vs 15410e421 exit 0.
  - integ/w00 moved to a6ce95fe0 during the sweep, so the runner's own integ checks used that ref; the gates above
    use 15410e421 explicitly. origin/main moved to 84ee6f0ad.
  - Red and not owned here: new-file and patch vs origin/main 84ee6f0ad, global floor (77.57 percent), per-file
    thresholds. None names any of the 21 files this package changes against 15410e421.
  - At c5507c5ce also: git-hooks, gate-scripts, factory-process-boundaries, and check-factory-boundaries suites
    279 pass, 0 fail; typecheck, lint, check-boundaries, check-factory-boundaries, gate-integrity
    (BASE_REF=15410e421) exit 0.
  - Merge c5507c5ce: no conflict. Only `tasks/todo.md` changed on both sides; git merged it with both sides kept
    (no integ line removed). The G13 hook routing is intact. The merge commit's hook skipped its staged tests
    because I set EZ_PRECOMMIT_TEST_MAX=0 (64 test files mapped); the hook printed the skip.

## Main-origin leaks and flakes (now on -r2)

Base for every comparison: integ/w00 7a87aed5e (the committed origin/main 96e7ee58c merge), in its own clean worktree.
Head: 9dc2ba9fb, clean tree, after `bun install --frozen-lockfile` (root and web). Every matrix runs at umask 077.
Receipts: `continue/consolidated/`. The first head run used node_modules from before the main merge; it gave the same
counts but is kept apart in `consolidated/stale-deps/` and is not cited. Earlier receipts at 0d3671c51 and
17e2e8a63 stay in `continue/` as history.

- [x] G7: workflow-branch then mentions-search-symlink-integration (6 fail); three suites, then h1-local-provider-ssrf ("Export named 'requireAdmin' not found"); executor-slash-command-expansion-e2e, then h1 or cross-tenant-deletion-projects-kb-modes.
  CHECK: `continue/pair-matrix.sh` (a copy of the triage tool; worktree and file list are parameters) over `leak-files.txt` (4 files) and `wide-files.txt` (the triage list plus both security suites, 14 files)
  EXPECT: the recorded pairs green; no new bad pair
  EVIDENCE: e8bba6baf and 0d5e64514. Four files: 4 of 12 bad at base (`consolidated/pairs-leak-base-7a87aed5e.txt`),
  0 of 12 at head (`consolidated/pairs-leak-head-9dc2ba9fb.txt`). Fourteen files: 9 of 182 bad at base
  (`consolidated/pairs-wide-base-7a87aed5e.txt`), 3 at head (`consolidated/pairs-wide-head-9dc2ba9fb.txt`). The 3 are
  the pairs the focused-triage report ruled a suite redesign (trusted-local-runner-wiring then in-process;
  scratchpad-e2e then either mentions suite); they are red at base too. (validator-3 L2: the earlier "0 of 12" rests
  on these clean-head receipts and on `pairs-wide-head-17e2e8a63.txt`, not on the dirty `pairs-leaks-exp2.txt`.)
  Cause 1: the symlink suite stubbed workspace-target through the `$server` alias, which cannot reach a route another
  suite linked first; it now stubs the relative path, spreads the real module, and restores it in afterAll.
  Cause 2: a partial `$lib` factory freezes the module's export names; `webLibModule()` in `helpers/mock-cleanup.ts`
  spreads the real module under the overrides (complete the mock, as the focused-triage fixes did).
- [x] G8: four tests fail at umask 077 (setup-podman, dev-image-provenance, local-sandbox-startup x2).
  CHECK: `continue/umask-run.sh` at umask 077, 022, and 000; the pair matrix over `umask-files.txt`
  EXPECT: 0 fail at every umask; 0 bad pairs
  EVIDENCE: fb4c8c2e0 and 0221670af. Before, at 077: 100 pass, 4 fail (`umask077-base.log`, at 0d3671c51). Head:
  167 pass, 0 fail at each umask (`consolidated/umask-four-{077,022,000}-9dc2ba9fb.log`). Pairs: 12 of 12 bad at base,
  where no suite is green alone (`consolidated/pairs-umask-base-7a87aed5e.txt`); 0 of 12 at head
  (`consolidated/pairs-umask-head-9dc2ba9fb.txt`; also `pairs-umask-head-17e2e8a63.txt`). (validator-3 L1:
  `umask077-fixed.log`, `umask022-fixed.log`, `umask000-fixed.log`, `umask-four-fixed{077,022,000}.log`, and
  `podman-wrapper-fixed{022,077}.log` are superseded dirty-tree attempts, not proof.)
- [x] G9: podman-compose-wrapper fails 10 of 63 "dirty" on pure main.
  CHECK: `continue/umask-run.sh` on the wrapper suite; EZCORP_DEBUG_SOURCE_STATE=1 for the cause
  EXPECT: 63 pass at every umask
  EVIDENCE: 0221670af. The fixture copied `.dockerignore` with its source mode; a checkout made under umask 077 holds it
  at 0600, and the resolver rightly counts a permission change ("tracked permission mode changed: .dockerignore").
  Before: 53 pass, 10 fail at 022 (`podman-wrapper-base022.log`). Head: 63 pass alone in
  `consolidated/pairs-umask-head-9dc2ba9fb.txt` and inside the 167 of each `consolidated/umask-four-*-9dc2ba9fb.log`.
- [x] G10: static gates at the consolidated head.
  CHECK: `continue/consolidated/static-fresh.sh`
  EXPECT: lint, typecheck, gate-integrity (BASE_REF=7a87aed5e), both boundary scripts, mock-cleanup-coverage, and gate-scripts plus git-hooks exit 0
  EVIDENCE: `consolidated/static-fresh.txt` at 9dc2ba9fb: all seven exit 0, tree clean before and after.
- [x] G11: the test-path boundary rule holds on the merged tree.
  CHECK: `bun scripts/check-boundaries.ts`; `bun test ./src/__tests__/gate-scripts.test.ts`
  EXPECT: 0 violations
  EVIDENCE: 380588398. The main merge brought `web/qualification/local-sandbox/local-mvp.pw.ts`, a Playwright spec its
  config selects with testMatch, which imports web/e2e fixtures (3 violations). `isTestPath` now counts the `.pw.`
  suffix; the table test pins the spec as a test path and its config and a `pwd` name as production.
  `consolidated/boundaries-9dc2ba9fb.log`: 0 violations.
- [x] G12: WITHDRAWN (coordinator, 2026-09-24). The pool-service import rule is carried by W15c (wp/w15c-pool-leaf
  126b776d2) as the node-service-link rule in the boundary gate, and W15c merges first.
- [x] G13: the hook runs staged factory-orchestrator files through the package's own test script, never `bun test`.
  CHECK: `bun test ./src/__tests__/git-hooks.test.ts`; a real `run_staged_tests packages/@ezcorp/factory-orchestrator/test/dispatcher.test.ts`
  EXPECT: the package script runs once in the package directory; no orchestrator test goes to bun; other tests stay on bun; a failing script fails the hook
  EVIDENCE: 7f4d27042. git-hooks 21 pass, 0 fail (also in the commit's own hook run). Against the old hook-lib, three
  of the four new tests fail (`consolidated/hook-orchestrator-against-unfixed.txt`). Real run with bun 1.3.14 and
  node 24.14.1: tsc, then node --test, 87 pass, 0 fail, exit 0 (`consolidated/hook-orchestrator-real.log`).

## Disclosed follow-ups (owner: W18 hygiene; not done in this package)

- F1: convert every partial `$lib/server/security/api-keys` mock to `webLibModule()`, and add a guard test that
  rejects a partial `$lib/*` factory. No measured pair fails because of them today, but any of them run before a
  route that imports `requireAdmin` fails to link. The 60 suites at 9dc2ba9fb:
  - `src/__tests__/admin-analytics-api-routes.test.ts`
  - `src/__tests__/admin-session-api-routes.test.ts`
  - `src/__tests__/attachments-admin-audit.test.ts`
  - `src/__tests__/attachments-cross-user-security.test.ts`
  - `src/__tests__/attachments-gc.test.ts`
  - `src/__tests__/attachments-serve-route.test.ts`
  - `src/__tests__/conversations-clone-turns-api.test.ts`
  - `src/__tests__/ext-files-route.test.ts`
  - `src/__tests__/extension-event-end-to-end.test.ts`
  - `src/__tests__/extension-toggle-agent-gating.test.ts`
  - `src/__tests__/extensions-delete-route-policy.test.ts`
  - `src/__tests__/extensions-patch-route.test.ts`
  - `src/__tests__/feature-endpoints.test.ts`
  - `src/__tests__/local-model-test-endpoint.test.ts`
  - `src/__tests__/memory-list-derived-owner.integration.test.ts`
  - `src/__tests__/messages-multipart-route.test.ts`
  - `src/__tests__/messages-patch-content.test.ts`
  - `src/__tests__/messages-permission-mode-ceiling-route.test.ts`
  - `src/__tests__/modes-api.test.ts`
  - `src/__tests__/seam-auth-chat-integration.test.ts`
  - `src/__tests__/security/c1-settings-api.test.ts`
  - `src/__tests__/security/c2-session-revocation.test.ts`
  - `src/__tests__/security/c3-confirm-endpoint.test.ts`
  - `src/__tests__/security/c3-extension-install.test.ts`
  - `src/__tests__/security/c5-provider-keys-admin-gate.test.ts`
  - `src/__tests__/security/h1-local-provider-ssrf.test.ts`
  - `src/__tests__/security/h2-tool-call-ownership.test.ts`
  - `src/__tests__/security/h3-conversations-memories-idor.test.ts`
  - `src/__tests__/security/h3b-conversation-subroutes-idor.test.ts`
  - `src/__tests__/security/kb-file-sharing-api.test.ts`
  - `src/__tests__/security/kb-ownerless-rows-are-shared.test.ts`
  - `src/__tests__/security/kb-retrieval-is-user-scoped.test.ts`
  - `src/__tests__/security/m3-fs-list-sandbox.test.ts`
  - `src/__tests__/security/project-members-api.test.ts`
  - `src/__tests__/security/project-permission-mode-authz.test.ts`
  - `src/integrations/github-projects/__tests__/web-connect-flow.integration.test.ts`
  - `web/src/__tests__/agent-chat-api.test.ts`
  - `web/src/__tests__/ask-user-answer-route.test.ts`
  - `web/src/__tests__/extension-browser-isolation.test.ts`
  - `web/src/__tests__/extensions-api.test.ts`
  - `web/src/__tests__/extensions-data-route.test.ts`
  - `web/src/__tests__/extensions-events-route.test.ts`
  - `web/src/__tests__/memories-api-post.test.ts`
  - `web/src/__tests__/mention-search-cmd-api.test.ts`
  - `web/src/__tests__/mention-search-file-api.test.ts`
  - `web/src/__tests__/messages-ownership-api.test.ts`
  - `web/src/__tests__/messages-ownership-baseline-api.test.ts`
  - `web/src/__tests__/security/bearer-auth.test.ts`
  - `web/src/__tests__/tasks-api.test.ts`
  - `web/src/__tests__/tasks-assignment-api.test.ts`
  - `web/src/__tests__/tasks-stop-retry-api.test.ts`
  - `web/src/__tests__/team-panel-refresh-flow.test.ts`
  - `web/src/routes/api/conversations/[id]/extension-toolbar/__tests__/list.test.ts`
  - `web/src/routes/api/extensions/[name]/uploads/__tests__/upload.test.ts`
  - `web/src/routes/api/extensions/__tests__/secrets-route.test.ts`
  - `web/src/routes/api/extensions/__tests__/triggers-route.test.ts`
  - `web/src/routes/api/hub/pages/[id]/__tests__/run-variant-route.test.ts`
  - `web/src/routes/api/import/__tests__/commit.test.ts`
  - `web/src/routes/api/import/__tests__/preview.test.ts`
  - `web/src/routes/api/integrations/github-projects/__tests__/handlers.test.ts`
- F2 (validator-3 L3): route every test that runs `git init` in a tmpdir through `helpers/scratch-git.ts`, and add a
  lint or guard that forbids a bare `git init` in tests. The hook now strips GIT_* from staged tests, so the
  2026-09-24 incident cannot repeat through the hook; these files still inherit the caller's context when run any
  other way. The 27 files at 9dc2ba9fb:
  - `docs/extensions/examples/docs-updater/index.integration.test.ts`
  - `docs/extensions/examples/task-stack/index.test.ts`
  - `packages/@ezcorp/ai-kit/test/unit/cli-install.test.ts`
  - `scripts/check-patch-coverage-typeonly.test.ts`
  - `src/extensions/first-party-integration/docs-updater/git.test.ts`
  - `src/extensions/first-party-integration/repo-activity-notify/git.test.ts`
  - `src/extensions/project-git-refs.test.ts`
  - `src/extensions/__tests__/project-git-broker.test.ts`
  - `src/extensions/__tests__/project-open-pr.test.ts`
  - `src/extensions/__tests__/source-project-credentials.test.ts`
  - `src/factory/git-objects.test.ts`
  - `src/factory/reference-code/git-reader.test.ts`
  - `src/factory/release-git-refs.test.ts`
  - `src/__tests__/biome-ignores-worktrees.test.ts`
  - `src/__tests__/cli-ext-coverage.test.ts`
  - `src/__tests__/cli-ext-typed-scaffold.test.ts`
  - `src/__tests__/ext-docs-validation.test.ts`
  - `src/__tests__/ext-init.test.ts`
  - `src/__tests__/git-install.test.ts`
  - `src/__tests__/lessons-audit-queries.test.ts`
  - `src/__tests__/memory-types.test.ts`
  - `src/__tests__/security/c3-extension-install.test.ts`
  - `src/__tests__/source-parser-git-coverage.test.ts`
  - `src/__tests__/source-parser.test.ts`
  - `src/__tests__/unlanded-branches.test.ts`
  - `src/__tests__/visual-evidence-select.test.ts`
  - `web/src/__tests__/copyable-content.test.ts`
