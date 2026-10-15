# W4H-14: main sync (W-SYNC-3), origin/main e3309906d into the wave head

Brief: `/tmp/factory-platform-evidence/w00/briefs/w4h-14-sync.md`. Owner w4h-14, branch `wp/w4h-14-sync` from integ/w00 `0363f883a`,
fast-forwarded to `000f75d10` (W4H-11 merged) before the merge. Evidence root: `/tmp/factory-platform-evidence/w4h-14/` (E below).
Step 0 (the conflict table below) was accepted by the coordinator before the merge started.

Commits (archy noreply, author and committer):
- `de8fa57ec` Merge origin/main (e3309906d) into the wave head. Parents exactly `000f75d10` and `e3309906d`. Hook ran normally:
  13 staged files, 0 test files mapped ("no test file maps to the staged changes"), lint clean. E/commit-merge.log, E/hook-list-merge.txt(.staged).
- the docs commit with this file.

Main's four commits: #327 `4d2d2252e` proxy-addr 2.0.8 and source-map-js 1.2.2; #328 `4999c3d90` @modelcontextprotocol/sdk 1.31.0 and
sharp 0.35.5; #326 `0d9b9a9c5` staged hook tests without the git context (a cherry-pick of the wave's `48da9c886` plus `8ac43c218`'s block);
#329 `e3309906d` the R4 resource sample waits for transient app connections.

## The five conflicts (one line each)
- scripts/lib/hook-lib.sh: the wave's side (byte-equal to `000f75d10`). Proof below.
- src/__tests__/git-hooks.test.ts: the wave's side (byte-equal to `000f75d10`). Proof below.
- web/package.json: union. Main's `sharp` 0.35.5 override plus the wave's `patchedDependencies` (stryker vitest-runner) and its
  `@xyflow/svelte` and `elkjs` dependencies.
- bun.lock: the wave's 21 added entries (@isaacs/cliui, @jridgewell/*, @js-sdsl/ordered-map, @jsonjoy.com/*) plus main's
  `@modelcontextprotocol/sdk@1.31.0` entry; the 1.30.1 entry dropped.
- manifest.lock.json: regenerated with `bun scripts/regenerate-manifest-lock.ts`; `--check` exit 0. Against the wave three digests move:
  substack-engagement (main's value), substack-pilot and packages/@ezcorp/ai-kit (new values: both sides changed those sources).

## #326 is a subset of the wave's files (the superset proof)
Line sets of base `beaff68c8`, main and the wave compared with difflib (E/step0/).
- hook-lib.sh: main adds 17 lines, all 17 are in the wave's file; main's 2 removed base lines are absent from the wave's file too.
  `without_git_context` is byte-equal (no hunk in the main-vs-wave diff). The 10 lines only on main's side are base lines the wave
  changed itself (the no-silent-skip cap, the orchestrator routing, the broken-pipe here-string), none a #326 line.
- git-hooks.test.ts: main adds 88 lines, all 88 are in the wave's file. Byte-equal blocks: "pre-commit hook > a staged suite that runs
  git" (`8ac43c218`), "fixture env isolation", `STAGED_SUITE_TIMEOUT_MS`. One placement difference: `const HOOK_LIB` is at module scope in
  the wave's file (line 62), inside the staged_test_targets describe on main. Main's test-local `withoutGitContext` plus its undefined
  filter equals the wave's shared `withoutGitContext` from `@ezcorp/sdk/git` (packages/@ezcorp/sdk/src/git/index.ts:64), re-exported by
  src/__tests__/helpers/scratch-git.ts (`d2c025a29`).

## Lockfiles and dependency bumps
- A pinned Bun 1.4.2 `bun install --ignore-scripts` (root, then web) against the hand-resolved locks left BOTH lockfiles byte-unchanged
  (cmp), so no unrelated package moved. E/lock-install.log.
- Against the first parent `000f75d10`: bun.lock changes 29 entries, web/bun.lock 28, every one main's bump family (sharp 0.35.5 and its
  @img packages, libvips 1.3.4, MCP 1.31.0, proxy-addr 2.0.8, source-map-js 1.2.2); nothing added or removed. Against main the
  differences are the wave's own (hono 4.13.12, devalue 5.9.4, undici 8.11.2 kept from the last sync). No version is below either parent.
  E/lock-compare.txt.
- Frozen installs (root, web, gate-integrity deps; `--ignore-scripts`) and the package builds: exit 0, "no changes". E/installs-resolved.log.
- `bun scripts/audit-deps.ts`: clean at the high floor (one moderate below the floor: sprintf-js). E/audit-resolved.log.

## #329 and W4H-11
No shared file or line: #329 changes only scripts/verify-shipping-runtime-resources.ts, which W4H-11 does not touch and the wave had not
changed since `beaff68c8`. Two call-path links, both before #329's code in each run: the bootstrap wait (`waitForProductionBootstrap`,
resources script line 242, runs verify-shipping-bootstrap.ts with W4H-11's progress model) and the per-cycle build wait
(`production.waitVerified`, line 328; at `000f75d10` it delegates to W4H-11's `waitForBuildVerified`). #329's new
`waitForAppConnections` (up to 150 polls of 100 ms) runs after the build wait in each cycle. It adds at most about 15 s per cycle
(about 150 s at the default 10 cycles), counted against the production-proof-shard's 75-minute timeout (ci.yml:666), not against the
bootstrap budget. #329 ships no test; no test file reads the script; it is outside the coverage gates' source scope
(`isSourceFile` false). Coordinator ruling (2026-10-08): the containerized resources proof is NOT run in this package. #329 is main's
own fix, the wave never touched its file, and it arrives byte-equal: the blob at the head is `29bde5859950`, the same as at `e3309906d`
(the wave's `a56c88c02a62` equals `beaff68c8`'s; 0 wave commits touched it). E/p329-byte-equal.txt. Local evidence: typecheck, lint,
byte-equality and the diff read above. Its runtime proof is the hosted "Production proof (resources)" job (ci.yml
`production-proof-shard`, shard `resources`) on the next push.

## Red and green
- [x] G1 red at the raw merge (markers in place, installs from the base so no red is a missing-module red): all 7 legs red, each on a
  conflict marker. hooks 0/1 "Unexpected <<"; manifest suites 33/1 and `--check` exit 1; dependency suites 16/3; frozen root (bun.lock
  ParserError) and web (web/package.json parse) exit 1; audit-deps exit 2. E/red-raw.log (script E/red-raw.sh).
- [x] G2 green at `de8fa57ec`, the same legs: hooks 29/0; manifest suites 34/0, `--check` 0; dependency suites 19/0; frozen root and web 0;
  audit-deps 0. E/green-resolved.log (script E/conflict-legs.sh).

## Legs at the head (`de8fa57ec`)
- [x] Typecheck under the memory rule (lock-free; no holder; one at a time), pinned Node 24.14.1 (/tmp/factory-tools/node-24.14.1)
  and Bun 1.4.2: `bun run typecheck` all programs (backend, web, tests and web-e2e, Python mypy --strict) exit 0, MemAvailable 17.8 GiB
  before, lowest 14.3 GiB; svelte-check 620 files 0 errors 0 warnings, lowest 16.2 GiB. E/tc.log, E/tc-record.log. Disclosure: the
  first typecheck, web build and install-builds ran with the system Node 24.21.0 on PATH (all green); they are kept as
  E/*-VOID-system-node-24.21.0.log and were re-run under the Node pin (env.sh now asserts it).
- [x] Lint 0 (6111 files); boundaries 0 violations; factory boundaries pass. E/head-legs.log.
- [x] Guard set (w00/guard-suites.sh): 40 files, 507 pass, 2 skip, 0 fail. E/head-legs.log, E/guard-list.txt.
- [x] Gate integrity: vs origin/main the 8 standing findings, equal to w00/expected-integ-findings-vs-main.txt (findings-match PASS);
  vs `000f75d10` PASSED. E/gi-head-main.log, E/gi-head-wave.log.
- [x] Coverage (heavy lock, gated; lane w4h-14): 10 suites, one process each, 113 pass 0 fail: git-hooks (29), W4H-11's
  bundled-bootstrap-progress (13), shipping-bootstrap-state (12), e2e-bundled-bootstrap-wait (6), and the conflict-leg suites.
  New-file and patch vs `000f75d10` PASSED (no source file in scope changes). Vs `e3309906d` both fail across the whole wave (a 10-suite
  LCOV cannot measure the wave; the binding run is wave4i-3); none of the merge's 13 changed files is named. E/cov-run.log, E/cov/.
- [x] Web build exit 0 (Node 24.14.1; bun and bunx 1.4.2). Frozen installs and package builds re-run under the Node pin: exit 0,
  no changes. E/web-build.log, E/installs-resolved.log.
- [x] Prune scan: no prune subcommand (2 candidates, both this package's own log line). Config: 888c78b9e94ea660 = accepted baseline,
  before and after every git command. E/head-legs.log.
- [x] Migrations: not run; main changed no schema or migration file.
- [x] Hook count per commit: the merge 0 test files; the docs commits 0.

## Leftover
- sprintf-js moderate advisory GHSA-hp3w-g68c-fv3c (root lockfile), below the high floor of `scripts/audit-deps.ts`: not blocking, not
  fixed here; for the leftover list (coordinator, 2026-10-08).
