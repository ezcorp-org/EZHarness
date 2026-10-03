# Gates: W-SYNC — merge origin/main into the integration branch

Scope: merge origin/main `31052930d` (28 commits, #304–#320) into integ/w00 `6fe920150`, so that PR #318 is no longer DIRTY.

Merge commit: `787f8676c` on `wp/w-sync-main`. Its parents are exactly `6fe920150` (integ/w00) and `31052930d` (origin/main).
Its tree is `3667d4bce`, and the author and committer are both archy (noreply). This gates document is a separate docs-only
commit on `wp/w-sync-gates`, so `wp/w-sync-main` stays at the merge commit.

The user made the merge commit by hand under the ruling `w00/w-sync-merge/ruling-hook-skip-3667d4bce.txt`
(EZ_SKIP_HOOK_TESTS=1, bound to the 26-file set). Both agents' permission checkers had refused to make that commit with the
skip variable. The hook's printed set at commit time equals the ruled set (26 files, no package line;
`w00/w-sync-merge/printed-787f8676c.txt`). The commit message holds the ruling text in full.

Proof tree for every leg below: `3667d4bce`. Toolchain: Bun 1.4.2 (bun and bunx), with
BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 set at process start, Vitest 5.0.0, and Node 24.14.1. Before the tests ran, the three
frozen installs and the six package builds ran at the merged tree. Receipts are under `/tmp/factory-platform-evidence/w-sync/`
(shortened to `w-sync/` below).

## The three conflicts

| File | Before (each side) | After | Proving tests |
| --- | --- | --- | --- |
| `src/runtime/stream-chat/build-pi-agent.ts` | Wave `190ad3afa`: `const model = factoryRuntime ? resolved.piModel : resolveModelForCredential(…)`. Main `8aa507304` (#315): `const model = withKeylessAuth(resolveModelForCredential(…), initialCred.token)` | `const model = factoryRuntime ? resolved.piModel : withKeylessAuth(resolveModelForCredential(resolved.piModel, resolved.provider, initialCred.type), initialCred.token)`. A factory attempt keeps the gateway-approved model untouched, because the model is part of the brokered request identity. A host chat turn takes the keyless rule. Main's comment is kept, and one comment line explains the factory branch. | `keyless-auth-header` 10/0 (its source scan matches `withKeylessAuth(resolveModelForCredential(`), `build-pi-agent-stream-fn`, `build-pi-agent-compaction` and `factory-execution.integration` 6/0, all in the 173-suite leg |
| `tasks/lessons.md` | Both sides appended at the same anchor | Union: main's text first, ours after. A multiset `comm` shows 0 lines lost from either side. | `git diff` against each parent; validator-6's merge check |
| `tasks/todo.md` | Both sides appended at the same anchor | Union: main's text first, ours after, with 0 lines lost. One blank line was added before `## W02c` so the heading does not run into main's last paragraph. | same |

## The one change beyond the conflict files (team-lead approved)

At the merged tree, main's `keyless-auth-header` source scan failed (9/1). It found `apiKey: credential.token` in
`src/providers/factory-broker.ts:163`, the wave's direct pi-ai call, which git had auto-merged. #315 requires every direct pi-ai
site to spread `authCallOptions(token)`. Without that, a factory attempt pinned to a keyless provider sends `Bearer no-key-needed`.

- Fix: `{ ...request.options, ...authCallOptions(credential.token) }`, plus the import. A real key still goes through
  unchanged, and the broker's options never carry headers.
- Test: `factory-broker.test.ts` has a new case. The keyless placeholder sends `headers: { Authorization: null }`, and a real key sends `apiKey` only.
- Red first: with the old line restored, the suite gives 12 pass, 1 fail (`w-sync/fix/red-factory-broker.log`). Green: 13/0, and
  `keyless-auth-header` 10/0 (`w-sync/fix/`). LCOV `DA:163,313`.

## Gates

- [x] G1: Exactly three conflicts, all resolved as above. CHECK: `git merge --no-commit origin/main`, then `git ls-files -u | wc -l`
  EXPECT: 3 conflicted files before, 0 after. EVIDENCE: this session's merge output (the three CONFLICT lines); `w-sync/setup.log` (staged tree).
- [x] G2: Installs and builds at the merged tree. CHECK: `bash w-sync/setup.sh` EXPECT: every step rc=0. EVIDENCE: `w-sync/setup.log`.
- [x] G3: Static legs. CHECK: `bash w-sync/static-legs.sh` EXPECT: typecheck, `web check` (svelte-check), lint, boundaries all rc=0.
  EVIDENCE: `w-sync/static-legs-final.log`, `w-sync/leg-{typecheck,web-check,lint,boundaries}.log`. Lint shows 1 warning, which
  predates the merge (`noCommaOperator` in `tests/postgres/helpers/factory-recovery-databases.ts:50`, a wave file the merge does not touch).
- [x] G4: Guard set. CHECK: `bun test --timeout 30000 <guard-suites.sh list>` EXPECT: 60 pass, 0 fail, 12 files.
  EVIDENCE: `w-sync/leg-guard-set.log`.
- [x] G5: Gate integrity against origin/main equals the 8 standing wave findings. CHECK: `bun scripts/gate-integrity.ts` (no
  GATE_CHANGE_APPROVED) and `findings-match.py … origin/main` EXPECT: PASS. Found: `scripts/check-coverage.ts`,
  `scripts/check-new-file-coverage.ts`, `scripts/check-patch-coverage.ts`, `scripts/coverage-attestations.json`,
  `scripts/factory-orchestrator-v8-to-lcov.mjs`, `scripts/merge-browser-route-coverage.sh`, `scripts/merge-lcov.ts`,
  `scripts/node-v8-to-lcov.mjs`. Each is byte-identical to `6fe920150`. EVIDENCE: `w-sync/gate-integrity-match-pre-commit.txt`,
  `w-sync/leg-gate-integrity.log`.
- [x] G6: Wide per-file leg under the heavy lock (lane w-sync, lock_veto checked, memory gate before every suite). This covers every
  test that imports `stream-chat/*`, `providers/router.ts`, `runtime/executor.ts` or `factory-broker`, from both sides, plus main's
  changed tests and the hook-mapped suites. CHECK: `flock --close … bash w-sync/heavy-legs-final.sh` EXPECT: every suite rc=0.
  Result: 173/173 Bun suites rc=0, one process per file, and Vitest 12 files / 123 tests passed. EVIDENCE:
  `w-sync/heavy-legs-final.log`, `w-sync/heavy-final/`, suite lists `w-sync/final-{backend,web}-suites.txt`. An earlier run at tree
  `26ffb8de0`, before the broker fix, had 170/171 green. Its one red was `keyless-auth-header`, which led to the fix (`w-sync/heavy-legs.log`).
- [x] G7: The 26 hook-mapped suites ran outside the hook at the proof tree, as the ruling requires. The 19 root suites ran one
  process per file. The 7 web component suites ran one at a time under Vitest 5. CHECK: `bash w-sync/ruled-receipts.sh` EXPECT: 26 receipts, all rc=0 with
  nonzero counts. EVIDENCE: `w-sync/ruled-receipts.txt` (exit, count and log sha256 for each suite), `w-sync/ruled-web/`.
- [x] G8: Merge identity. CHECK: `git log -1 --format='%T %P %an <%ae>' 787f8676c` EXPECT: tree `3667d4bce`, parents
  `6fe920150 31052930d`, archy noreply. EVIDENCE: `w-sync/names-vs-integ.txt` (91 files) and `w-sync/names-vs-main.txt` (2,471 files).
  Every file in the second list is a file the wave changed since the merge base `96e7ee58c`, so main's own changes no longer appear
  in the diff against main.

## Auto-merged files and the legs that cover them

The brief named these auto-merged files. Each one is covered by tests:
- `providers/router.ts`, `runtime/executor.ts` and `stream-chat/failover.ts`: G6.
- `web-vitest-coverage-guard.test.ts` and `web-vitest-coverage-includes.sh`: G6 and G7 (guard test 9/0).
- `coverage-thresholds.json` and `ci.yml`: G4 and G5.
- `+layout.svelte`: the layout component test in G6 and G7, plus svelte-check in G3.

Playwright specs (`web/e2e/*`, `lanes.json`) are not covered here. The integrator's chain at the published head runs them.
