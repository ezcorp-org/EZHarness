# Stage 1 required-check inspection

Inspected `ezcorp-org/EZHarness` branch `main` at 2026-09-13T01:04:15Z from
commit `4d2228a293772746585f215d700500418d1fc51e`. The read-only command was:

```sh
gh api repos/ezcorp-org/EZHarness/branches/main/protection/required_status_checks
```

The API reported `strict: true` and 10 required contexts. Comparing that set
with `DESIRED_REQUIRED_CHECKS` in `scripts/check-required-checks.ts` now finds six
missing contexts and no unexpected contexts:

- `E2E (real auth + real DB)`
- `Factory schema and kernel`
- `Factory Temporal integration`
- `Gate integrity`
- `Svelte check`
- `Visual evidence`

The desired replacement is the 16-context array in the branch-protection
snippet in `docs/development-lifecycle.md`. After an administrator applies it,
run this read-only proof with a token that can read branch protection:

```sh
GITHUB_TOKEN=... bun scripts/check-required-checks.ts
```

The script fails for a missing, renamed, unexpected, or non-required context,
and when strict status checks are disabled. This inspection did not alter
branch protection. Applying the replacement is an external administrative
mutation and requires explicit user authorization.
