# W4H-13: the hooks run tests with git's environment; a staged test's `git init` re-initialises the shared repository as bare

Brief: `/tmp/factory-platform-evidence/w00/briefs/w4h-13.md`. Branch `wp/w4h-13-hook-git-env` off integ/w00 `1bc5f63c7`.
Evidence root: `/tmp/factory-platform-evidence/w4h-13/` (report.txt, logs/).

## Finding: the one-place fix is already on integ/w00; origin/main does not have it

- integ/w00 has scrubbed every `^GIT_` name from the hook's test processes since `48da9c886` (2026-09-24).
  `without_git_context` in `scripts/lib/hook-lib.sh` computes the unset list from `compgen -e`. It wraps all three runners:
  `bun test`, `bunx vitest run` and the factory-orchestrator `bun run test`.
- origin/main (`beaff68c8`, 187 lines, no scrub) runs `bun test --timeout 30000 "./$t"` with the hook's environment intact.
  The brief's line numbers are this file.
- The 2026-10-06 12:34Z incident branch `fix/incus-git-listing-sol61-oct06` (`5a5c1e165`) descends from main.
  Its hook-lib.sh has no scrub (188 lines).
- So `scripts/lib/hook-lib.sh` is unchanged on this branch. The repair for main is to bring `48da9c886` to origin/main.
  That is outside this branch and is the coordinator's and user's call.

## G1 = R1: red reproduced in a throwaway repository

Harness: `r1-repro.sh <ref>`. It builds a temp repo under `/tmp/w4h-13-r1.*` with a linked worktree. It copies the ref's
`.githooks/pre-commit`, `scripts/` tree, `.bun-version`, `biome.json` and `.gitignore`. It stages `src/repro.test.ts`, which runs
`git init --quiet <own tmpdir>` with no scrub, and commits from the linked worktree. Every git write first asserts that
`git rev-parse --absolute-git-dir` starts with the temp root. The temp root is removed at the end.

| Ref | Hook result | Staged test saw GIT_* | Shared config before | Shared config after | Verdict |
|---|---|---|---|---|---|
| origin/main `beaff68c8` | exit 0, 1 pass | GIT_DIR, GIT_INDEX_FILE, GIT_PREFIX, GIT_EXEC_PATH, GIT_EDITOR, GIT_AUTHOR_* | `4977e193d57b4ec9` core.bare=false | `623722a761dadf95` core.bare=true | RED |
| integ/w00 `1bc5f63c7` | exit 0, 1 pass | none | `4977e193d57b4ec9` core.bare=false | `4977e193d57b4ec9` (byte-equal) | GREEN |

Hashes are sha256, first 16 hex. The only config diff on the red leg is `bare = false` to `bare = true`.
Logs: `r1-red-origin-main.log`, `r1-base-integ-w00.log`, `r1-commit-origin_main.log`, `r1-commit-integ_w00.log`.
The origin/main leg runs Bun 1.3.14 from `~/.bun/bin`, with the version asserted. The shared 1.3.14 tool binary is 0 bytes.

## G2 = R2: the scrub at the root, and every hook subprocess

No change: the root fix already exists at base (see the finding above). Hook subprocesses at head:

| Hook | Subprocess | Runs git against a path it owns? | Scrubbed |
|---|---|---|---|
| pre-commit | staged `bun test --timeout 30000 ./<file>` | yes, any staged test may | yes, `without_git_context` |
| pre-commit | staged `bunx vitest run` (web) | yes, any staged test may | yes, `without_git_context` |
| pre-commit | `bun run test` in factory-orchestrator | yes, its tests may | yes, `without_git_context` |
| pre-commit | `bunx biome check -- <staged>` | no, lint only | no: it needs the work tree's ignore files |
| pre-commit | `check_bun_version_skew` (scripts/check-bun-version.ts) | no, reads .bun-version | no: no git |
| pre-commit | `bun run scripts/regenerate-manifest-lock.ts --check` | no, spawns nothing | no: no git |
| pre-push | lint, typecheck, svelte-check | no, spawns no tests | no: no git; pre-push spawns no tests |

The hook's own git calls (`rev-parse`, `diff --cached`) keep git's environment.

## G3 = R3: the hook suite's end-to-end case

`src/__tests__/git-hooks.test.ts`, "pre-commit hook > a staged suite that runs git", commit `8ac43c218`. A commit from a linked
worktree runs the real pre-commit hook and the tree's real `scripts/`. The staged suite runs a bare `git init` in a directory it owns.
The case asserts five things:
- the suite ran (1 pass);
- core.bare stays false and the fixture's shared config is byte-equal;
- the suite saw no GIT_* variable;
- its `git init` made its own repository;
- the commit landed.

- Green at head: 29 pass, 0 fail (`head-git-hooks.log`, `logs/final-unit-git-hooks.log`).
- Red with the scrub removed from the bun runner (`mutation-red.sh`, which restores the file on exit). The failure is
  `core.bare` Expected "false", Received "true" (`r3-mutation-red.log`).
- Changed executable lines: none outside the test file. CRAP: 0 touched functions. biome: clean.

## G4 = R4: R1 re-run at the head

hook-lib.sh at the head equals integ/w00. The integ/w00 R1 leg above is therefore the head result: core.bare stays false, the staged
test ran (1 pass), and the hook exits 0. The commit of `8ac43c218` ran the hook normally and mapped 1 suite (29 pass).

## G5 = R5: gate tooling and legs (head `8ac43c218`, `logs/final-legs.log`)

| Leg | Result |
|---|---|
| gate-integrity vs integ/w00 | rc=0 |
| gate-integrity vs origin/main | rc=1, exactly the 8 expected "coverage gate tool changed" lines (diff against `w00/expected-integ-findings-vs-main.txt` is empty) |
| new-file / patch coverage vs integ/w00 (binding) | rc=0 / rc=0 |
| new-file / patch coverage vs origin/main (informational) | rc=1 / rc=1: whole integ-vs-main diff, measured with one suite's lcov |
| CRAP (changed) | 0 functions, rc=0 |
| guard set (w00/guard-suites.sh) | 500 pass, 0 fail |
| typecheck | rc=0, 0 errors (after the package builds in dependency order) |
| lint | rc=0 |
| check-factory-boundaries | rc=0 |
| prune scan | rc=0 |

Hook count per commit: 1 suite. Real shared config: reads `546e460d3bfa387b` (the known incident, baseline `888c78b9e94ea660`).
This branch never wrote it. The worktree's core.bare=false override is in `config.worktree` (common.md rule).
