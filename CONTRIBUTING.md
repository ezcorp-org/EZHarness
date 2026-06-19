# Contributing to EZCorp

EZCorp uses a **trunk-based** workflow: `main` is always deployable, and every
change lands through a pull request that passes a cheat-resistant gate. The full
spec — including the rationale for each gate and how it resists an autonomous
agent gaming "all green" — is in
[docs/development-lifecycle.md](docs/development-lifecycle.md). This file is the
quick reference.

## The loop

1. **Branch** off `main`: `feat/…`, `fix/…`, `ci/…`, `docs/…`, `chore/…`,
   `security/…`. Keep it short-lived.
2. **Build with tests.** Every new source file ships with tests; every changed
   line is covered; user-facing behavior gets a Playwright e2e spec under
   `web/e2e/`.
3. **Open a PR.** All required checks must be green and a **non-author** must
   approve. Squash-merge to `main` (linear history; no force-push).
4. **Release** by bumping `package.json` `version` and pushing an `app-vX.Y.Z`
   tag — `release-image.yml` verifies, builds the multi-arch image, pushes it to
   GHCR, and publishes the GitHub Release. Deployed instances update-check
   against `releases/latest`.

## The feature contract (CI-enforced)

Every feature PR MUST:

1. Cover each **new source file** to its threshold (default **100%**), with a
   key in `scripts/coverage-thresholds.json` (or a justified `EXCLUDES` entry in
   `scripts/coverage-config.ts`).
2. Cover **every new/changed executable line** (patch-coverage gate).
3. Add/update a **Playwright e2e spec** for user-facing behavior.
4. Not weaken the gate and not fake tests green — no lowered thresholds, no new
   `EXCLUDES`, no `.skip/.only/.todo`, no assertion-free tests
   (`gate-integrity` gate).

## Before you push

```sh
bun run typecheck
bun run lint
bun run test
bun run test:coverage
```

## Changing the gate itself

The gate files (`scripts/coverage-*.ts`, `coverage-thresholds.json`, CI
workflows, `playwright.config.ts`, …) are **CODEOWNERS-owned**. A PR that
changes them needs a human (CODEOWNERS) review, and the diff-scoped checks need
a maintainer to apply the `gate-change-approved` label. This is by design: it
keeps the gate out of reach of the same automation that has to pass it.
