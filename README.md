# EZHarness

Part of the [EZCorp](https://github.com/ezcorp-org/EZCorp) platform.

## Status

New project — scaffold only. Repo settings, branch protection, license, PR
template, and CODEOWNERS are seeded from `ezcorp-org/EZCorp` so the same
trunk-based development lifecycle applies from day one:

- Branch off `main` (`feat/ fix/ ci/ docs/ chore/ security/`), open a PR,
  land all required checks green plus a non-author review, squash-merge.
- `main` is always deployable.

Required status checks are intentionally empty until this repo has its own CI
workflows — add them to the `main` branch protection as the pipeline lands.
