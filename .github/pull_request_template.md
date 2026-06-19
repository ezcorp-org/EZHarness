<!--
EZCorp PR. Full spec: docs/development-lifecycle.md.
Branch off main, keep it short-lived, squash-merge once all required checks
are green and a non-author has approved.
-->

## What & why

<!-- One or two sentences. Link the spec/issue if there is one. -->

## Feature contract (required — CI enforces these)

- [ ] **New source files are covered** — each new file in `src/`, `web/src/`,
      `packages/@ezcorp/sdk/src/` has tests and a key in
      `scripts/coverage-thresholds.json` (default **100**), or an
      `EXCLUDES` entry in `scripts/coverage-config.ts` with justification.
- [ ] **Every changed line is covered** — patch-coverage gate is green.
- [ ] **Playwright e2e** added/updated under `web/e2e/` for user-facing behavior.
- [ ] **No gate weakening / fake-green** — no lowered thresholds, no new
      `EXCLUDES`, no `.skip/.only/.todo`, no assertion-free tests
      (gate-integrity is green).
- [ ] Ran locally: `bun run typecheck && bun run lint && bun run test && bun run test:coverage`.

## Gate-config change?

<!--
Only if this PR intentionally changes the gate (thresholds / EXCLUDES / CI /
test config). These need a CODEOWNERS review, and the diff-scoped checks need
the maintainer-only `gate-change-approved` label to pass. Explain why here.
-->

N/A
