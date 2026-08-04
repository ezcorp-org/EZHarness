# C3 certification — `feat/c3-finish`

Branch cut from `integration/c3-complete` @ `5d9aece5` (verified 2-parent merge
of `3020e3cc` × `f2fef8ef`).

Every lane below was run to completion, its **full** output written to a file,
and its exit code captured **into that file** with `$?` immediately after the
command — never through `tail`, never inferred from a shell's trailing status.

## Final gate set — the state of the branch at tip

| # | Gate | Exit | Result |
|---|---|---|---|
| 26 | `bun run typecheck` | **0** | clean |
| 17 | `bun run test` (serial) | **0** | 20828 pass, 0 fail, 1263 files |
| 13 | `bun run test:coverage` | **0** | Coverage gate PASSED — 980 enforced files; 22450 pass, 0 fail, 1275 shards |
| 18 | `bunx vitest run` (web) | **0** | 488 files, 6073 tests |
| 19 | `bash scripts/test-web.sh` | **0** | 4313 pass, 0 fail, 228 files |
| 20 | `bun run --cwd web check` | **0** | clean |
| 23 | `bun scripts/gate-integrity.ts` | **0** | no gate-weakening or test-cheating |
| 16 | `bun scripts/check-patch-coverage.ts` | **0** | all changed executable lines covered (32 files) |
| 15 | `bun scripts/check-new-file-coverage.ts` | **1** | **FAILS — 1 pre-existing file, see below** |
| 25 | `bun scripts/check-visual-evidence.ts` | **0** | 3 visual surface files, 6 specs |
| 24 | biome, explicit paths | **0** | 3403 files, 52 warnings |
| 21 | e2e mock-gate lane (17 specs) | **0** | 130 passed |
| 22 | e2e `workflow-delegations.spec.ts` | **0** | 13 passed |

**One gate fails, and it is pre-existing.**

```
New-file coverage gate FAILED (1 file(s)):
  web/src/lib/components/DelegationConsentDialog.svelte: new source file
  with no measured coverage
```

Not in my diff. Absent from `main`; added by phase 8b
(`c4f0e61f`, `2f39662b`). It has **no** entry in `scripts/coverage-thresholds.json`,
**no** entry in the node-vitest leg's spec list or `--coverage.include` list in
`scripts/test-coverage.sh`, and **no** `*.component.test.ts`. Its only test
surface is the Playwright spec, which produces no line coverage.

Deliberately NOT fixed here — see "What I did not do".

## Lanes superseded, kept on the record

| # | Lane | Exit | Why superseded |
|---|---|---|---|
| 02 | backend, `EZCORP_DB_PATH=/tmp/c3-cert-db` | 1 | 20814 pass / **2 fail** — the pinned DB path armed a `rm -rf`; see `02f` |
| 02g | backend, clean env | 0 | 20821 pass / 0 fail — superseded by 17 after later commits |
| 11 | coverage | 1 | 3 files under threshold; one was caused by my own bun pin test |
| 12 | coverage | 1 | 2 files under threshold, both pre-existing |
| 14 | backend, run CONCURRENTLY with lane 13 | 1 | **flake** — 1 fail in `workflows-delegated-ladder.test.ts`, `rung 9 … drains the SAME bucket`, a rate-limit test on a machine saturated by the coverage lane. In isolation: 78 pass / 0 fail. Superseded by lane 17, run serially. |

Lane 14 is my own error and is recorded rather than hidden: never run the
backend pool concurrently with the coverage pool. Rate-limit and timing
assertions are the first thing to go.

## Two claims in the handoff brief that are WRONG

**1. `bun run lint` is NOT a false green in a `.claude/worktrees/*` worktree.**
The brief says `biome.json:20` excludes `**/.claude`. Line 20 is `"!.claude"`
— root-anchored to the biome config's own directory, which IS the worktree
root. An ancestor path component named `.claude` excludes nothing. Measured:
`bun run lint` scans **3426** files, the explicit-path invocation **3402**, and
both report the identical 52 warnings and exit 0. `bun run lint` is a superset.
Both are recorded (`05`, `05b`, `05c`, `24`) regardless.

**2. Pinning `EZCORP_DB_PATH` is what CAUSED the worktree deletion, not what
prevents it.** The brief instructs pinning it under `/tmp`. Following that
literally produced a 2-fail backend lane whose cleanup tried to `rm -rf /tmp`.
`preload.ts:17` yields to an explicit `EZCORP_DB_PATH` — so pinning it is
precisely what transfers ownership of the path to you, and
`db-connection-real-init.test.ts` then recursively deleted `dirname()` of it.
Set **nothing**: `preload.ts:18` already mints a per-process
`mkdtempSync(join(tmpdir(), "ezcorp-test-db-"))`, already under `/tmp`, already
outside the worktree, and per-process isolated in a way one shared pinned path
is not. Full mutation proof in `02f-MUTATION-PROOF-worktree-deletion.md`.

## CODEOWNERS-owned files

**None edited.** The four the brief named were verified and all four citations
are correct: `scripts/coverage-thresholds.json` `:23`,
`web/e2e/evidence-covers.json` `:32`, `scripts/test-coverage.sh` `:33`,
`web/e2e/lanes.json` `:45`. My diff is 10 files, none of them owned.

## What I did not do

**Job 5 (three additive features) — not attempted.** Certification is the
brief's stated priority, and the branch arrived uncertified. Each of the three
needs a route or query change plus a registry entry, unit tests, an e2e spec
and a coverage key — and every one of those invalidates the coverage, backend,
vitest and e2e lanes above, which cost roughly 40 minutes of wall clock to
re-run as a set. Shipping them without re-certifying would have left the branch
in exactly the state this run exists to end. Research done and handed off in
the final report.

**The `DelegationConsentDialog.svelte` new-file gap — not closed.** Same
reasoning, plus it needs edits to two CODEOWNERS-owned files
(`scripts/test-coverage.sh` for the leg + include lists,
`scripts/coverage-thresholds.json` for the key) and a component test driving a
dialog with preview fetching, owner-kind switching, capability diffing and
error states to its threshold. Half-doing that means CODEOWNERS files edited
without a verified green.
