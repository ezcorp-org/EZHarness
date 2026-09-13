# Stage 2a runner readiness inspection

Inspected repository runner and secret metadata at 2026-09-13T01:22:10Z with
read-only GitHub API calls:

```sh
gh api repos/ezcorp-org/EZHarness/actions/runners
gh api repos/ezcorp-org/EZHarness/actions/secrets --jq '.secrets[].name'
```

The runner response was `{"total_count":0,"runners":[]}`. The repository
secret-name list was empty. No online runner has `factory-real` or
`factory-gpu`, and the workflow cannot receive `FACTORY_RUNNER_READ_TOKEN`.
The `Factory runner readiness precheck` therefore fails before a job can queue
on a missing self-hosted runner. It does not skip or report green.

The precheck sets `FACTORY_TEST_TENANT_COUNT=10` for the current local test
campaign. The 100-tenant hosted launch target in C11 is unchanged and remains
a Stage 6 release proof.

This inspection changed no runner, secret, workflow, or branch-protection
configuration. Runner registration and secret provisioning are external
administrative actions and require explicit user authorization.
