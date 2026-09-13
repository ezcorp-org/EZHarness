# Stage 2b runner and secret provisioning — prepared, not applied

Successor to [stage 2a](../stage-2a/runner-readiness-inspection.md). That
report is historical and is not edited here.

## Read-only inspection

Inspected at 2026-09-13T18:11:20Z from commit `9bc39a30c` on branch
`wp/w18-ci-coverage`:

```sh
gh api repos/ezcorp-org/EZHarness/actions/runners
gh api repos/ezcorp-org/EZHarness/actions/secrets --jq '.secrets[].name'
FACTORY_RUNNER_READ_TOKEN=<gh auth token> FACTORY_TEST_TENANT_COUNT=10 \
  GITHUB_REPOSITORY=ezcorp-org/EZHarness bun scripts/check-factory-runners.ts
```

The runner response was `{"total_count":0,"runners":[]}`. The repository secret
name list was empty. `scripts/check-factory-runners.ts` exited 1 and reported:

```
registered runners (0): none
missing (2): no online runner has required label 'factory-real'; no online runner has required label 'factory-gpu'
```

This is unchanged from stage 2a. What changed is the consumer side: at stage 2a
the two labels appeared only inside `scripts/check-factory-runners.ts` and no
job requested either (W00 audit discrepancy 17). Three jobs now do.

## Runner labels to register

| Label | Consuming job | Check name | Hardware the job needs |
| --- | --- | --- | --- |
| `factory-gpu` | `factory-isolation` | Factory isolation | One authorized GPU plus a rootless container runtime, because the lane proves a CPU attempt sees NO device and a GPU attempt sees EXACTLY the authorized one |
| `factory-real` | `factory-product-e2e` | Factory product and domain E2E | Real Temporal, real object storage, real provider credentials, and a browser for the `factory-services` lane |
| `factory-real` | `factory-deployment-operations` | Factory deployment and operations | Docker for the PostgreSQL service container and the image upgrade, rollback, and restore proofs |

Every one of the three declares `needs: [factory-runner-readiness]`. That is
load-bearing: GitHub queues a job for a label nobody serves for up to 24 hours,
so without the dependency an absent runner would look like a slow run rather
than a failure. With it, the five-minute precheck fails first.

Each runner must also carry the `self-hosted` label, which GitHub applies
automatically on registration. `scripts/check-factory-lanes.ts` rejects a lane
that requests a dedicated label without it.

## Secret names to provision

| Secret name | Read by | Effect when absent |
| --- | --- | --- |
| `FACTORY_RUNNER_READ_TOKEN` | `factory-runner-readiness` -> `scripts/check-factory-runners.ts` | The script throws before any API call. The precheck fails, which fails the three dependent lanes. This is the designed state and needs no change to reach. |
| `FACTORY_TEST_POSTGRES_URL` | `factory-product-e2e` | `collect-browser-route-coverage-lane.sh factory-services` exits non-zero on its `:?` guard |
| `EZCORP_FACTORY_STORAGE_SECRETS_DIR` | `factory-product-e2e` | Same guard, same exit |
| `FACTORY_TEMPORAL_TEST_SERVER` | `factory-product-e2e` | Same guard, same exit |

`FACTORY_RUNNER_READ_TOKEN` needs only `repo` read scope for
`actions/runners`. It is a READ token; nothing in CI registers or removes a
runner.

No secret VALUE appears in this document, in any workflow file, or in any
evidence file. The names above are the only thing recorded.

## Applying

```sh
# One per runner host, from the GitHub Actions runner registration UI or:
gh api --method POST repos/ezcorp-org/EZHarness/actions/runners/registration-token
# then, on the host: ./config.sh --labels factory-gpu    (or factory-real)

gh secret set FACTORY_RUNNER_READ_TOKEN --repo ezcorp-org/EZHarness
gh secret set FACTORY_TEST_POSTGRES_URL --repo ezcorp-org/EZHarness
gh secret set EZCORP_FACTORY_STORAGE_SECRETS_DIR --repo ezcorp-org/EZHarness
gh secret set FACTORY_TEMPORAL_TEST_SERVER --repo ezcorp-org/EZHarness
```

Runner registration and secret provisioning are external administrative
mutations. They have NOT been applied. Applying them needs explicit user
authorization.

## Proof after applying

```sh
FACTORY_RUNNER_READ_TOKEN=... FACTORY_TEST_TENANT_COUNT=10 bun scripts/check-factory-runners.ts
```

It exits 0 only when an ONLINE runner carries each label and the tenant count
is at least 10. A registered-but-offline runner still fails.
