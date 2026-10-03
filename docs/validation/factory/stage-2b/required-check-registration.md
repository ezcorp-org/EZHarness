# Stage 2b required-check registration — prepared, not applied

Successor to [stage 1](../stage-1/required-check-inspection.md). That report is
historical and is not edited here.

## Read-only inspection

Inspected `ezcorp-org/EZHarness` branch `main` at 2026-09-13T18:11:20Z from
commit `9bc39a30c` on branch `wp/w18-ci-coverage`. The commands were:

```sh
gh api repos/ezcorp-org/EZHarness/branches/main/protection/required_status_checks
GITHUB_TOKEN=<gh auth token> GITHUB_REPOSITORY=ezcorp-org/EZHarness bun scripts/check-required-checks.ts
```

`scripts/check-required-checks.ts` exited 1. The API reported `strict: true` and
10 required contexts. `DESIRED_REQUIRED_CHECKS` now holds 21, because W18 adds
the five missing C11 lane names to the two that were already listed.

| Result | Count | Contexts |
| --- | --- | --- |
| strict | — | `true`, unchanged |
| existing | 10 | Backend critical (strict pass/fail), Backend tests, E2E (mock, no Docker), Lint (biome), Manifest lockfile drift check, Per-file coverage gate, Typecheck, Web security coverage, Web tests (bun-leg orphans), Web tests (vitest) |
| missing | 11 | E2E (real auth + real DB), Factory Temporal integration, Factory assurance and release, Factory deployment and operations, Factory isolation, Factory product and domain E2E, Factory runner contracts, Factory schema and kernel, Gate integrity, Svelte check, Visual evidence |
| unexpected | 0 | none |

Six of the eleven were already missing at stage 1. The five new ones are the
C11 lanes W18 added: `Factory runner contracts`, `Factory assurance and
release`, `Factory isolation`, `Factory product and domain E2E`, and `Factory
deployment and operations`.

## The exact change to apply

The complete replacement payload is
[branch-protection-required-status-checks.json](branch-protection-required-status-checks.json).
It is the full desired set, not a delta, because the GitHub endpoint replaces
the context list rather than merging it.

```sh
gh api --method PATCH \
  repos/ezcorp-org/EZHarness/branches/main/protection/required_status_checks \
  --input docs/validation/factory/stage-2b/branch-protection-required-status-checks.json
```

Registering a required check is an administrative mutation on branch
protection, not a code change. It has NOT been applied. Applying it needs
explicit user authorization.

## Ordering constraint

Three of the five new lanes run on self-hosted labelled runners that do not
exist yet (see
[runner-and-secret-provisioning.md](runner-and-secret-provisioning.md)).
Registering them as required before those runners are online makes every pull
request block on `Factory runner readiness precheck`, which is the intended
fail-closed behaviour but stops all merges. Apply runner and secret
provisioning first, then this payload.

## Proof after applying

```sh
GITHUB_TOKEN=... bun scripts/check-required-checks.ts
```

It exits 0 only when `strict` is true and the existing set equals the desired
set exactly. A renamed, missing, or unexpected context fails it.
