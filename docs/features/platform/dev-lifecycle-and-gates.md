# Development Lifecycle & Cheat-Proof Gates

> _Trunk-based branch → PR → required-checks → squash-merge → release-tag flow, hardened by Bun-native coverage gates and an anti-tamper meta-check that an autonomous agent — which writes the feature, its tests, AND can edit the gate config in the same PR — cannot game._

## Intent

EZCorp ships features through autonomous agent workflows (`ez-feature`, sub-agent teams). The same actor writes the code, writes the tests, and is rewarded for declaring "done / all green" — so a naive coverage gate is trivially gameable: lower a threshold, add an `EXCLUDES` entry, write assertion-free tests, `.skip` a failing one, or hand-doctor the lcov report. This feature is the set of CI gates plus the GitHub branch-protection / CODEOWNERS scaffolding designed so that **none** of those cheats work. Every control is either **out-of-reach** (lives where the PR diff can't touch it) or **semantic** (measures behavior, not a number a vacuous test satisfies).

## How it works

The full spec lives in `docs/development-lifecycle.md`; this is the architectural map of the moving parts.

### Branching & promotion (trunk-based)

1. Work happens on a short-lived branch off `main` (`feat/…`, `fix/…`, `ci/…`, `docs/…`, `chore/…`, `security/…`), rebased on `main`, deleted after merge.
2. A PR opens against `main`. All **13 required status checks** must go green and a **non-author** must approve (CODEOWNERS for gate-file diffs).
3. **Squash-merge** keeps linear history — no direct pushes, no force-push, no admin bypass.
4. To release: bump `version` in `package.json`, push tag `app-vX.Y.Z`. `release-image.yml` verifies + builds the multi-arch image to GHCR and publishes the GitHub Release marked `latest`.
5. Deployed instances poll `releases/latest` and surface the update banner (see `docs/update-check.md`).

### The 13 required CI checks (`.github/workflows/ci.yml`)

Each is a GitHub check context pinned by branch protection (renaming/deleting a job in a PR can't dodge the requirement). Job `name:` → what it proves:

| Check | Proves |
|---|---|
| **Typecheck** | `bun run typecheck` → `scripts/typecheck.sh` (backend `tsconfig.typecheck.json` + web svelte-kit sync + scoped `tsc`). |
| **Svelte check** | `cd web && bunx svelte-check --tsgo` — Svelte template/type errors in `web/`, via the TypeScript 7 (`@typescript/native`) dual install. |
| **Backend tests** | Thin aggregator (`needs: [cov-shard, residual-tests]`, `if: always()`) that keeps the pinned check name over the sharded pool — green iff every `Coverage shard` matrix leg (the backend suite run under `--coverage`, gated on pass/fail-set membership with an isolated retry sweep) and `Residual integration tests` (the pass/fail files the shards don't run, incl. `route-contract.test.ts`) succeeded. |
| **Backend critical (strict pass/fail)** | `CRITICAL_ONLY=1 bash scripts/test.sh` — curated deterministic correctness suites (RBAC engine/resolver, migration idempotency, auth, secrets, mention-wiring) run **plain**, with no coverage instrumentation. |
| **Web tests (vitest)** | Thin aggregator over a 3-way sharded `cd web && bunx --bun vitest run` — `*.component.test.ts` (Svelte DOM) + `*.server.test.ts` (route-handler units). |
| **Web tests (bun-leg orphans)** | `scripts/test-web.sh` — the plain `web/src/**/*.test.ts` files that neither the vitest leg nor the backend coverage/pass-fail pools already run. |
| **E2E (mock, no Docker)** | Scoped Playwright run vs **mocked** backends (preview server on :4173, no Docker/seed). Gates UI render + action wiring. |
| **E2E (real auth + real DB)** | `PI_E2E_REAL=1` Playwright against `playwright.real.config.ts` — the real-auth/real-DB/mock-LLM tier, incl. a sandbox-spawn probe so the two extension specs can't silently skip on a runner that lost spawn capability. |
| **Lint (biome)** | `bun run lint` → `biome check` over an EXPLICIT path list (not `.`, which an ignore glob can silently reduce to zero files inside an agent worktree). Hard gate; warnings/infos stay non-blocking. |
| **Manifest lockfile drift check** | `scripts/regenerate-manifest-lock.ts --check` — re-derives `manifest.lock.json` from bundled extensions' `ezcorp.config.ts` and fails on drift. |
| **Per-file coverage gate** | `bun run test:coverage` → `scripts/check-coverage.ts`; the **new-file** + **patch-coverage** gates ride in the same job (reusing the lcov it just built). |
| **Gate integrity** | `scripts/gate-integrity.ts` — anti-tamper / anti-cheat meta-check (diff-scoped). |
| **Visual evidence** | a frontend-visual change ships a changed, diff-scoped `@evidence` Playwright spec; when the changed file has a covering entry in `web/e2e/evidence-covers.json`, that specific covering spec must be the one touched **and** must pass. |

Bun is **pinned** to `1.3.14` in every job (an unannounced bun release can change install/test semantics).

### The coverage pipeline (the `Per-file coverage gate` job)

`scripts/test-coverage.sh` builds a single `coverage/lcov.info` by merging several shards, then enforces it:

1. **Host + example shards** — each `src/__tests__/*.test.ts`, `docs/extensions/examples/**/*.test.ts`, and the `web/src/routes/api/import` endpoint tests run per-file under `--coverage` (per-file isolation, same reason as `test.sh`). A scoped set of `web/src/__tests__` + `web/src/lib/**` bun:test suites join the loop.
2. **SDK bundle shard** — `packages/@ezcorp/sdk/test/` + `…/src/entities/__tests__/` run bundled (mock.module-free, preserving 100% module-load instrumentation parity).
3. **harness-client shard** — `packages/@ezcorp/harness-client/`.
4. **Node-vitest leg** — the vitest-only `web/src/lib/**` files (Svelte-rune-importing modules bun can't compile) run under `npx vitest run … --coverage.provider=v8`, because `@vitest/coverage-v8` needs node:inspector's Coverage domain, which Bun does not implement — so CI provisions node 22 before the job. SF paths are re-rooted (`SF:src/` → `SF:web/src/`).
5. `scripts/merge-lcov.ts` unions all shard lcovs into `coverage/lcov.info`; `scripts/check-coverage.ts` enforces thresholds. (`scripts/lcov-noise-filter.ts` strips spurious DA spans.)

**Three diff-scoped enforcement layers** (all share `scripts/coverage-config.ts` for the lcov parser, source-file classification, and `EXCLUDES`):

- **`scripts/check-coverage.ts` (per-file)** — for every file in lcov that matches a key in `scripts/coverage-thresholds.json`, assert `covered/total ≥ threshold`. Keys are matched **most-specific-first** (specificity = pattern length minus `*`s), so the most-specific glob wins. A file in lcov with **0 measured lines** fails loudly ("coverage script doesn't measure this path"). A non-wildcard threshold key that matches **no** lcov file fails too (silence is made audible) — wildcard keys are treated as fallbacks and may match nothing.
- **`scripts/check-new-file-coverage.ts` (new-file)** — every source file **added** vs `origin/main` (per `git diff --diff-filter=A`, filtered by `isSourceFile && !isExcluded`) must be both **measured** (≥1 line in lcov) **and matched by a threshold key**. Closes the hole where a brand-new file nobody added to `coverage-thresholds.json` is silently un-gated by the per-file gate's wildcard fallback. The default policy floor for a new file is **100** (the value lives in the CODEOWNERS-reviewed thresholds JSON).
- **`scripts/check-patch-coverage.ts` (patch)** — every **changed executable line** (added line with a DA record) vs `origin/main` must be hit. "Executable" = has a DA record; comments / blanks / type-only / declarations are ignored. Catches an undertested edit to an **existing** file (which the added-files-only new-file gate doesn't see). Files with no lcov data at all are skipped (owned by the other two gates). Reuses `parseUnifiedDiff` from `gate-integrity.ts`.

### Gate integrity (anti-tamper + anti-cheat)

`scripts/gate-integrity.ts` diffs the PR against `origin/main` (the job checks out `fetch-depth: 0` + fetches main) and **fails** on any of:

1. **EXCLUDES grew** — a new un-gating pattern in `scripts/coverage-config.ts` (`addedExcludes` compares the parsed `EXCLUDES` arrays of base vs HEAD; has a bootstrap fallback to the old inline home in `check-coverage.ts`).
2. **Coverage ratchet broken** — a removed key or a **decreased** value in `coverage-thresholds.json` (`thresholdRatchetViolations`; increases / new keys are allowed).
3. **`.skip` / `.only` / `.todo`** added to a test file. `ALWAYS_FORBIDDEN` catches `.only/.todo/.failing`, `x*/f*` focus globals, and `describe.skip`; `STATIC_SKIP` catches an unconditional `test/it/bench.skip(…)` — a **runtime-conditional** `.skip(<condition>, …)` (e.g. a Docker-only or "no real fixture on disk" suite) is intentionally **allowed**.
4. **Empty `catch {}`** added to a test file (swallowed failures).
5. **Assertion-free test** — a newly-touched `test()`/`it()` block (overlapping an added line) with no `expect` / `assert` / `.rejects` / `.resolves` / `toThrow` / `expectTypeOf` / `expect.poll` / `expect.soft`.
6. **Committed `coverage/lcov.info`** — the report must be CI-built, never checked in.
7. **`biome.json` weakened** (`biomeGateWeakenings`) — the LINT gate's un-gating surface, structurally identical to `EXCLUDES`. Fires on: a new `"!<path>"` in `files.includes` (or a **positive** include removed, which narrows what biome looks at without any `!` in the diff); a new or **widened** `overrides[]` entry that disarms a rule — widened meaning a path added to its `includes`, a new rule turned off inside it, or a `!` exemption removed from it; a severity **lowered** out of `"error"` in either form (`"error"` or `{"level": "error", …}`); a rule **deleted** while it stood at `error` and is no longer pinned at `error` anywhere covering it; an `options.paths` denylist entry dropped; and the blanket disarms (`linter.enabled: false`, `recommended: false`, `preset: "none"`, a group set to `"off"`).
8. **The biome config FILE moved** (`biomeConfigFileViolations`) — root `biome.json` deleted or renamed (biome falls back to its built-in defaults), or a **nested** `biome.json`/`biome.jsonc` added anywhere else (biome resolves the *nearest* config for a file, so a nested one can un-lint a whole subtree while the root config's diff shows nothing).

All of them are **diff-scoped** so the tree's pre-existing skips and ~365 mock files don't false-positive. A `stripNoise` pass removes string/template literals and line comments before pattern-matching, so a skip/empty-catch that only appears inside a quoted fixture string isn't mistaken for a real cheat.

**Why 7 exists** (issue #143): `src/__tests__/dependency-denylist.test.ts` already pins parts of `biome.json`, but it is an ordinary test — an author editing the config can edit the test in the same commit. An `EXCLUDES` addition cannot be self-approved. Check 7 removes that asymmetry: the test is now the fast local signal, and CI holds the teeth. **Only weakening fires** — raising a severity, removing an exclusion, shrinking an opt-out override, adding an override at `error`, and a `recommended: true` → `preset: "recommended"` migration are all silent, because a gate that fires on strengthening gets routed around. Two adjacent surfaces are deliberately **not** guarded and are named in the script header: `.gitignore` additions (`vcs.useIgnoreFile` is on, but flagging every `.gitignore` edit would drown the signal) and a reorder of two overrides that set the same rule at different severities (no such pair exists, and the denylist test drives the real biome binary).

**Escape hatch:** a maintainer sets `GATE_CHANGE_APPROVED=1` (wired in CI from the maintainer-only `gate-change-approved` label) to bypass these findings — it logs each bypassed finding loudly. An agent's token cannot apply a restricted label, so it cannot self-clear.

### Out-of-reach scaffolding (GitHub config above the repo)

The in-repo gate only **binds** because of config the PR diff can't reach:

- **Branch protection on `main`** (applied via `gh api …/branches/main/protection`): strict required status checks for all 13 jobs; ≥1 approving review; dismiss stale approvals; require CODEOWNERS review; `enforce_admins` (no admin bypass — break-glass is a named human); linear history; no force-push, no deletion.
- **`.github/CODEOWNERS`** assigns every gate file to `@EZArchy` — the `coverage-*` / `check-*` / `gate-integrity` scripts, `coverage-thresholds.json`, `coverage-config.ts`, `merge-lcov.ts`, `lcov-noise-filter.ts`, `test.sh`, `test-coverage.sh`, `.github/workflows/`, `.github/CODEOWNERS`, the PR template, `biome.json`, `bunfig.toml`, `web/playwright.config.ts`. With "require CODEOWNERS review" on, a PR that changes the gate needs an approval the agent can't give itself.
- **Org setting (one-time, manual):** *disallow GitHub Actions from approving PRs* — closes the `github-actions`-bot self-approval bypass.

### Trustworthy green

The blocking e2e suite runs with **`retries: 0`** (`web/playwright.config.ts`) — a retry that flips red→green hides a real failure and makes "all green" meaningless. A genuinely-flaky spec must move to a separate non-blocking lane with an owner, never be papered over.

### Release & deploy

`release-image.yml` fires on `app-v*` tag push:

1. **Verify tag == `package.json` version** (fail-fast before the expensive build).
2. **Gate 1 — fast in-process verification:** db/backup, readiness, update-check, migrate-idempotency, encryption unit tests + `verify:backup` (snapshot/rollback) + `verify:edges` (circuit-breaker).
3. **Gate 2 — Docker:** build once (`load: true`), then `verify-docker-image.sh` (labels/VOLUME/readiness/version), `verify-docker-rollback.sh`, `verify-docker-upgrade.sh` (two-image data + snapshot preservation).
4. **Publish:** push multi-arch (`linux/amd64,linux/arm64`) image to GHCR, then publish the GitHub Release marked `--latest`.

## Usage

This feature is experienced through Git/GitHub and CI, not an app UI.

- **Run the gate locally** (mirrors the PR checklist):
  ```sh
  bun run typecheck && bun run lint && bun run test && bun run test:coverage
  ```
- **`test:coverage` reports two verdicts and three exit codes.** It prints a
  `TESTS:` line and a `COVERAGE:` line, then exits:

  | code | meaning |
  |---|---|
  | `0` | coverage gate passed **and** no pass/fail-gated test failed |
  | `1` | the **coverage** verdict failed — a threshold, a gating leg (`harness-client` / `ai-kit` / `web-vitest` / `web-security`), or a dead producer |
  | `2` | coverage passed but **tests failed** — a pass/fail-set (P) file failed the pooled run *and* an isolated plain re-run |

  Tests are gated on the same P-membership + isolated-retry rule the CI cov
  shards use (`gate_host_failures` in `scripts/lib/test-file-sets.sh`), so a
  full local run and a CI shard cannot disagree about whether a file is red.
  Host files outside P and the `sdk` / `suggest` legs stay explicitly tolerated
  — the banner names them. Until 2026-08, exit code `0` meant only "coverage
  passed": a run printing `22953 pass | 14 fail` still exited 0 and told
  readers the suite was clean.
- **Individual scripts:** `bun scripts/check-coverage.ts`, `bun scripts/check-new-file-coverage.ts`, `bun scripts/check-patch-coverage.ts`, `bun scripts/gate-integrity.ts`. The three diff-scoped scripts honor `BASE_REF` (default `origin/main`).
- **Add/raise a threshold:** edit `scripts/coverage-thresholds.json` (a key → percentage; default new-file floor is 100). Ratchet allows **increases and new keys only**; a removal or decrease fails Gate integrity.
- **Un-gate a file legitimately:** add it to `EXCLUDES` in `scripts/coverage-config.ts` **with a justification comment** — this requires the `gate-change-approved` label to pass Gate integrity, plus CODEOWNERS approval.
- **Regenerate the manifest lockfile** (after editing a bundled `ezcorp.config.ts`): `bun run scripts/regenerate-manifest-lock.ts` (drop `--check` to write).
- **Release verification suite:** `bun run verify:all` (backup + circuit-breaker + docker image/rollback/upgrade).
- **Env / inputs:**
  - `BASE_REF` — diff base for the three diff-scoped scripts (default `origin/main`).
  - `GATE_CHANGE_APPROVED` — set to `1` (via the `gate-change-approved` label in CI) to bypass Gate integrity findings.
  - `PARALLEL` — shard parallelism in `test.sh` / `test-coverage.sh` (default 6).
- **PR contract:** `.github/pull_request_template.md` lists the required checkboxes (new files covered, every changed line covered, Playwright e2e for user-facing behavior, no gate weakening, local gate run).

## Key files

- `scripts/coverage-config.ts` — single source of truth: `EXCLUDES`, `SOURCE_GLOBS`, `isSourceFile`/`isExcluded`, `escapeGlob` (Bun treats `[id]` as a char class), `parseLcov`, `parseHitLines`, `REPO_ROOT`. Imported by all four gate scripts (DRY).
- `scripts/check-coverage.ts` — per-file gate; most-specific-threshold-wins; 0-measured-line and orphaned-key fail-loud paths.
- `scripts/check-new-file-coverage.ts` — new-file gate; added source files must be measured AND threshold-matched. `newFileViolations` exported for unit test.
- `scripts/check-patch-coverage.ts` — patch/diff-coverage gate; every changed executable line must be hit. `uncoveredAddedLines` exported.
- `scripts/gate-integrity.ts` — anti-tamper meta-check; pure helpers (`parseExcludeEntries`, `addedExcludes`, `thresholdRatchetViolations`, `parseUnifiedDiff`, `forbiddenTestAdditions`, `unassertedAddedBlocks`, `biomeGateWeakenings`, `biomeConfigFileViolations`) exported for unit test.
- `scripts/coverage-thresholds.json` — per-glob threshold map (~170 keys); the ratcheted policy surface.
- `scripts/test.sh` — backend test runner (per-file bun process isolation; avoids the 553-file `mock.module` deadlock).
- `scripts/test-coverage.sh` — coverage runner: host/example/SDK/harness-client bun shards + node-vitest leg → merge → `check-coverage.ts`.
- `scripts/merge-lcov.ts` — unions per-shard lcov files into `coverage/lcov.info`.
- `scripts/lcov-noise-filter.ts` — strips spurious zero-hit DA spans (iface sigs, switch labels) from merged lcov.
- `scripts/regenerate-manifest-lock.ts` — re-derives / `--check`s `manifest.lock.json` from bundled `ezcorp.config.ts` files.
- `scripts/typecheck.sh` — backend + web typecheck.
- `scripts/verify-docker-image.sh`, `scripts/verify-docker-rollback.sh`, `scripts/verify-docker-upgrade.sh`, `scripts/verify-backup-rollback.ts`, `scripts/verify-circuit-breaker-edges.ts` — release verification suite.
- `.github/workflows/ci.yml` — the 13 required-check jobs.
- `.github/workflows/release-image.yml` — tag→verify→multi-arch build→GHCR→Release.
- `.github/CODEOWNERS` — gate files owned by `@EZArchy`.
- `.github/pull_request_template.md` — the feature-contract checklist CI enforces.
- `web/playwright.config.ts` — e2e config; `retries: 0`.
- `docs/development-lifecycle.md` — the canonical spec (branch-protection JSON, residual risks, mutation-testing roadmap).
- `src/__tests__/coverage-gate.test.ts`, `src/__tests__/gate-scripts.test.ts` — the gate scripts' own test suites (sandboxed temp-dir + fixture-driven).

## Features it touches

- [[deployment-and-releases]] — the `app-v*` tag → `release-image.yml` → GHCR → GitHub Release flow is the back half of this lifecycle; deploy/update-check is its consumer.
- [[remote-testability]] — the harness-client package + mock-LLM route are gated as their own coverage shards and feed the deterministic e2e lane.
- [[bundled-catalog]] — the Manifest lockfile drift check re-derives `manifest.lock.json` from the bundled extensions' `ezcorp.config.ts`.
- [[database-and-migrations]] — release Gate 1 runs migrate-idempotency + backup/rollback + circuit-breaker verification before any image ships.
- [[overview-and-authoring]] — `docs/extensions/examples/**` index/config files are gated by the examples threshold (some sample indexes carry `EXCLUDES` carve-outs).

## Related docs

- [development-lifecycle](../../development-lifecycle.md) — the canonical spec (this doc is the feature-map companion).
- [update-check](../../update-check.md) — how deployed instances poll `releases/latest`.
- [deployment](../../deployment.md) — single-container deploy + rollback.

## Notes & gotchas

- **The escape hatch is a label, not a flag.** `GATE_CHANGE_APPROVED` is set in CI **only** from `contains(github.event.pull_request.labels.*.name, 'gate-change-approved')`. The whole anti-tamper design rests on agents being unable to apply a restricted label and unable to self-approve a CODEOWNERS PR — both are GitHub-side controls outside the repo diff.
- **Teeth depend on branch protection being applied.** CODEOWNERS and the gate are only enforced when `main` has "Require review from Code Owners" + status checks + no self-approval. Applying branch protection is a one-time `gh api` call (documented in `docs/development-lifecycle.md`); the CODEOWNERS file header says so explicitly.
- **Conditional `.skip` is intentionally allowed.** `gate-integrity.ts` permits a runtime-conditional `test.skip(<condition>, …)` (Docker-only suites, "no fixture on disk → skip honestly"). A maintainer can still spot an always-`true` condition in review — the gate does not try to evaluate the condition.
- **Dual-instrumentation drives most `EXCLUDES`.** Many excluded `web/src/lib/**` and `web/src/lib/server/security/**` files **are** covered behaviourally (≥95% under their bun:test or vitest suites) but can't be cleanly line-measured here: `merge-lcov` unions bun's superset of "executable" lines with the vitest leg's v8 line set, and bun-only lines with no v8 hit drag the merged percentage below either measurement alone. They're gated under `Web tests (vitest)`, not the coverage percentage — this is the documented justification, not a coverage hole.
- **The coverage job does not re-gate test pass/fail.** `test-coverage.sh` prints `TOTAL_FAIL` but only hard-fails on `check-coverage` exit or the vitest-leg exit — the dedicated `Backend tests` / `Web tests (vitest)` jobs own pass/fail, so a flaky shard under `--coverage` instrumentation can't hold the coverage gate hostage (a real coverage drop is still caught by `check-coverage`).
- **`mock.module` isolation is load-bearing.** A bare `bun test` from the repo root deadlocks (553 files × cross-file `mock.module` bleed); `test.sh`/`test-coverage.sh` run each file in its own process. Never route a CI step through bare `bun test` from the root.
- **Gate-integrity's `parseExcludeEntries` reads only the first quoted literal per `EXCLUDES` line.** A reviewer-facing convention ("one path per line with a justification comment"); a multi-pattern line would partially escape detection — known false-negative surface, mitigated by CODEOWNERS review of every `coverage-config.ts` diff.
- **Mutation testing is the planned next layer, not yet a required check.** Line coverage is blind to assertion quality (Gate integrity only proves "has an assertion"). The roadmap is a Stryker pilot via the node-vitest leg, scoped to pure-logic modules, starting non-blocking. See `docs/development-lifecycle.md` → "Roadmap".
- **`enforce_admins` / token bypass is the only structural hole.** An agent under a repo-admin token or a ruleset bypass could disable protection. Mitigation: `enforce_admins=true`, named-human-only break-glass, and CI `GITHUB_TOKEN` scoped to `contents: read` (already the default in `ci.yml`).
