# Development lifecycle

How code gets from a branch to a deployed release in EZCorp, and how the gate
stays trustworthy when an **autonomous agent** writes both the feature and its
tests in the same PR that must pass the gate.

## Why this exists

EZCorp ships features through agent workflows (`ez-feature`, sub-agent teams).
The same actor writes the code, writes the tests, and *can edit the gate config*
— and is rewarded for declaring "done / all green". A naive coverage gate is
gameable: lower a threshold, add an `EXCLUDES` entry, write assertion-free
tests, `.skip` a failing one, or push straight past CI. This lifecycle is
designed so it **can't** be — every control is either:

- **Out-of-reach** — the gate lives where the PR diff can't touch it (GitHub
  branch protection, CODEOWNERS requiring a *different* approver), or
- **Semantic** — it measures behavior, not a number a vacuous test satisfies
  (patch coverage, mutation testing).

## Branching & promotion (trunk-based)

```
feat/… fix/… ci/… docs/… chore/… security/…   ← short-lived, branched off main
      │
      ▼ open PR
   required checks (green) + non-author review
      │
      ▼ squash-merge   (linear history, no force-push, no admin bypass)
    main ── always deployable ─────────────────────────────────────────►
      │
      ▼ bump package.json version + push tag app-vX.Y.Z
 release-image.yml → verify → multi-arch build → GHCR → GitHub Release
      ▼ self-hosted instances update-check against releases/latest
```

- `main` is the single source of truth and is always releasable.
- Branches are short-lived, rebased on `main`, deleted after merge.
- No long-lived `develop` branch. No direct pushes to `main`.

## The gate (required checks on `main`)

Every PR must pass these before it can merge. Names are the GitHub check
contexts (the job `name:` in `.github/workflows/ci.yml`), pinned in branch
protection so renaming/deleting a job in a PR doesn't dodge the requirement.

| Check | Proves | Cheat it closes |
|---|---|---|
| **Typecheck** | `tsc` clean (backend + web) | — |
| **Backend tests** | `bun test` per-file isolation passes | — |
| **Web tests (vitest)** | component + server-route units pass | — |
| **E2E (mock, no Docker)** | UI render + action wiring works | broken UI shipped green |
| **Lint (biome)** | style/lint clean | — |
| **Manifest lockfile drift check** | bundled-ext lockfile in sync | stale lockfile |
| **Per-file coverage gate** | each gated file ≥ its threshold; **+ new-file gate + patch coverage** ride in this job | undertested code |
| **Gate integrity** | the PR doesn't weaken the gate or fake tests green | gate tampering / vacuous tests |
| **Visual evidence** | a frontend-visual change ships a changed `@evidence` Playwright spec — and, when the changed file has a covering entry in `web/e2e/evidence-covers.json`, that specific covering spec must be the one touched (deterministic, browser-free, fails closed, fails open to the coarse rule on a bad map; bypass via maintainer-only `evidence-exempt` label) | frontend shipped with no visual spec/screenshot, or evidenced by an unrelated spec |

### Per-file coverage gate
`scripts/check-coverage.ts` enforces `scripts/coverage-thresholds.json` against
`coverage/lcov.info`. Two diff-scoped gates run in the same job (reusing the
lcov it just built, so it isn't rebuilt twice):

- **New-file gate** (`scripts/check-new-file-coverage.ts`): every source file
  *added* in the PR must be measured (≥1 covered line) **and** matched by a
  threshold key. Closes the hole where a new file nobody added to
  `coverage-thresholds.json` was silently un-gated.
- **Patch coverage** (`scripts/check-patch-coverage.ts`): every *changed
  executable line* must be covered. Catches undertested edits to existing files.

### Gate integrity (anti-tamper + anti-cheat)
`scripts/gate-integrity.ts` diffs the PR against `origin/main` and fails on:

1. **EXCLUDES grew** — a new un-gating pattern in `scripts/coverage-config.ts`.
2. **Coverage ratchet broken** — a removed key or lowered value in
   `coverage-thresholds.json` (thresholds may only rise).
3. **`.skip` / `.only` / `.todo`** added to a test file.
4. **Empty `catch {}`** added to a test file (swallowed failures).
5. **Assertion-free test** — a newly-touched `test()`/`it()` block with no
   `expect`/`assert`.
6. **Committed `coverage/lcov.info`** — the report must be built in CI.

All six are diff-scoped, so pre-existing skips/mocks don't false-positive.

## Local hooks (shift-left)

The checks above run in CI, but you don't have to wait for a red CI run to find
a lint slip or a stale lockfile. Checked-in git hooks under `.githooks/` run the
cheap ones locally:

- **pre-commit** — biome-lints your **staged** files (by explicit path) and, when
  a staged path is an `ezcorp.config.ts` or `manifest.lock.json`, runs the
  manifest-lock drift check. Fast (targets a couple seconds on a typical commit).
- **pre-push** — the fuller pass before you share code: full biome lint,
  `bun run typecheck` (backend + web + tests ratchet), and `svelte-check`.

**Auto-setup:** `scripts/setup-git-hooks.sh` points git at `.githooks` and runs
from `bun install`'s postinstall. It scopes the setting **per working tree**
(`extensions.worktreeConfig` + `git config --worktree core.hooksPath .githooks`)
rather than to the shared config — so enabling hooks in one worktree doesn't flip
them on for a sibling checkout that shares the same `.git`. It's a safe no-op in
CI (`$CI` set), in Docker builds, in tarball installs (no `.git`), and on a git
too old for `--worktree`, so it never fails an install.

**Escape hatches:** skip a single run with `git commit --no-verify` /
`git push --no-verify`, or set `EZ_SKIP_HOOKS=1` for the command.

These hooks are **advisory speed, not the gate** — they're bypassable by design,
and the CI required checks above remain the enforcement backstop. They just move
the feedback earlier.

## Trustworthy green

The blocking e2e suite runs with **`retries: 0`** (`web/playwright.config.ts`):
a retry that flips red→green hides a real failure and makes "all green"
meaningless. A genuinely-flaky spec must be moved to a **separate, non-blocking
lane** with an owner and a tracking issue — never papered over with a retry.

## Out-of-reach: branch protection + CODEOWNERS

The in-repo gate only binds because the GitHub config below sits above the repo:

**Branch protection on `main`** (applied via `gh`; see "Applying" below):
required status checks (strict) for all the jobs above; ≥1 approving review;
dismiss stale approvals; require CODEOWNERS review; `enforce_admins` on (no
admin bypass — break-glass is a named human); linear history; no force-push, no
deletion.

**`.github/CODEOWNERS`** assigns the gate files (the `coverage-*` scripts,
`coverage-thresholds.json`, CI workflows, `playwright.config.ts`, `biome.json`,
`bunfig.toml`) to a human. With "require CODEOWNERS review" on, a PR that
changes the gate needs an approval the agent cannot give itself.

**Org setting (manual, one-time):** *disallow GitHub Actions from approving
PRs* — closes the `github-actions`-bot self-approval bypass.

## Changing the gate

Legitimate gate changes (a new threshold, a justified `EXCLUDES` entry, a CI
tweak) go through a human:

1. A CODEOWNERS reviewer approves the gate-file diff.
2. A maintainer applies the **`gate-change-approved`** label, which sets
   `GATE_CHANGE_APPROVED=1` so the `Gate integrity` check bypasses its findings.

An agent's token cannot apply a restricted label, so it cannot self-clear.

## Release & deploy

1. Bump `version` in `package.json`.
2. Push tag `app-vX.Y.Z` (tag must equal `package.json` version —
   `release-image.yml` hard-checks this).
3. The workflow runs fast unit + snapshot/rollback/circuit-breaker verification,
   then a Docker smoke + rollback + two-image-upgrade check, then pushes a
   multi-arch image to GHCR and publishes the GitHub Release marked `latest`.
4. Deployed instances poll `releases/latest` (see
   [docs/update-check.md](update-check.md)) and surface the update.

**Rollback:** redeploy a prior `app-v*` image; the Docker rollback flow is
covered by `scripts/verify-docker-rollback.sh` / `verify:docker-rollback`.

## Applying branch protection (one-time)

As an org admin (`gh auth switch --user EZArchy`):

```sh
gh api -X PUT repos/ezcorp-org/EZCorp/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Typecheck", "Backend tests", "Web tests (vitest)",
      "E2E (mock, no Docker)", "Lint (biome)",
      "Manifest lockfile drift check", "Per-file coverage gate",
      "Gate integrity", "Visual evidence"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON

gh label create gate-change-approved \
  --description "Maintainer-approved gate-config change (bypasses gate-integrity)" \
  --color B60205
```

## Residual risks (honest)

- **Admin/token bypass** is the only structural hole: an agent running under a
  repo-admin token or a ruleset bypass could disable protection. Mitigation:
  `enforce_admins=true`, named-human-only bypass, CI `GITHUB_TOKEN` scoped to
  `contents: read` (already the default in `ci.yml`).
- **e2e-per-feature** isn't fully mechanically inferable for the *general* case
  (no feature→spec manifest). The **visual subset**, however, now HAS one:
  `web/e2e/evidence-covers.json` maps each visual-source glob to the `@evidence`
  spec(s) that render it. That manifest drives both the `Visual evidence` gate
  (a changed visual file with a covering entry must have one of its covering
  specs touched — not just any spec) and diff-scoped capture selection (only the
  specs that render the diff are screenshotted). A meta-test
  (`src/__tests__/visual-evidence-covers.test.ts`) self-ratchets it: adding an
  `@evidence` spec without a mapping fails CI. The non-visual remainder is still
  enforced by the PR-template checkbox + the agent contract in `CLAUDE.md` + CI
  running all specs at `retries: 0`.
- **Visual evidence proves presence, not assertion.** The `Visual evidence` gate
  proves *a spec was added/changed*, not that it asserts the visual behavior —
  a junk `expect(true)` passes it. Non-author review + the assertion-free-spec
  ban (`gate-integrity`'s `unassertedAddedBlocks`) are the backstop; full
  assertion quality is future mutation-testing work (see below).
- **Assertion quality** beyond "has an assertion" is only truly caught by
  **mutation testing**, the planned next layer (see below).

## Roadmap: mutation testing

Line coverage is blind to assertion quality; mutation testing is the definitive
fix. Stryker has no official Bun runner and the backend suite's per-file
`mock.module` isolation fights perTest coverage, so the pragmatic path is to run
Stryker via the **Node/Vitest leg** the coverage job already provisions, scoped
to **pure-logic modules** (`web/src/lib/search/**`, `goal-row-logic.ts`,
`deep-link-resolve.ts`, …), **diff/incremental on PR + full nightly**, with the
`break` threshold **ratcheted to the current score**. It starts as a
**non-blocking pilot** and is promoted to a required check once stable.
