# Runtime audit preflight

Date: 2026-09-05

Candidate: `3093a3a5e327b5ca6fb585b9f1271817553804e8`

Candidate tree: `e7d774a0d81983060dc60c2b92b9393ba464b05c`

Base and merge base: `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`

Branch: `extension-v4-audit-runtime`

## Runtime and inputs

- Required Bun: `/tmp/ez-extension-bun-1.3.14/bun-linux-x64/bun`, verified as 1.3.14.
- System Bun 1.3.9 is invalid for final receipts.
- Git: 2.53.0. Podman: 5.8.2.
- Root and web dependencies were absent before the first frozen install.
- PostgreSQL image: `docker.io/library/postgres@sha256:485935f94cc7165afa896978809c37b592dc07f0a37d2c8f645f12412d0212c8`.
- `EXTENSION_TEST_POSTGRES_URL` is absent before disposable database setup.
- No live-service credential variable names used by this audit were present. Values were not read or printed.

No install, build, container, lifecycle verifier, or heavy test ran during preflight because another owner held the shared heavy-run slot. The branch was then fast-forwarded from the original candidate `2c73e6b` to the coordinator candidate above after the user requested a merge from current `main`. The added baseline commit changes Bun version guards, hooks, and Compose resources; it does not change SDK dependencies or invocation code.

## First-party discovery

The discovery implementation scans immediate child directories of `extensions`, `docs/extensions/examples`, and `packages/@ezcorp`. A directory qualifies when it has a regular `ezcorp.config.ts`. Static discovery found 50 sources, including `packages/@ezcorp/ai-kit`.

The strong verifier creates clean PGlite state and a rootless Podman runner. It snapshots each source without importing its config in the host, resolves locked dependencies, builds through `ExtensionLifecycle`, runs candidate verification, and confirms that verification did not activate the release. `EXTENSION_VERIFY_ALL=1` disables fail-fast. Any failed or untested source produces exit 1.

Only four configs declare a deterministic `smokeTest`: city-conditions, extension-author, harness-smoke-test, and substack-engagement. The other 46 have no config-level smoke declaration. This does not mean that they lack unit tests. Their lifecycle reports and test files still need unit, integration, and live-service classification.

## Known live-service inputs

These needs are blocked until an owner supplies an approved test account or states that the live check is out of scope.

| Extension | Live input | Owner and exact next check |
| --- | --- | --- |
| openai-image-gen-2 | `OPENAI_API_KEY` or `OPENAI_ACCESS_TOKEN`; paid generation can incur cost | Product/service owner: approve cost, invoke both approved auth paths through an active release, then test missing grant, cancellation, timeout, and remote failure. |
| github-stats | Least-privilege `GITHUB_TOKEN` and approved test account/repository | GitHub integration owner: invoke through an active release; test valid, missing/revoked token, rate limit, timeout, and upstream error. |
| graded-card-scanner | Approved PSA test token or stored extension credential and stable card IDs | Scanner owner: run lookup/pricing through an active release; test invalid token, malformed output, timeout, and upstream failure. |
| city-conditions | Optional stored Google Pollen key; Open-Meteo is keyless | Weather owner: exercise keyless weather and credentialed pollen through an active release; test denied storage/network, invalid key, timeout, and remote failure. |
| substack-engagement and substack-pilot | Approved temporary Substack account/session and native MCP dependency | Substack owner: exercise native MCP and HTTP through the rootless runner, using temporary resources; verify revocation, cancellation, uncertain outcomes, and cleanup. |
| github-projects | Approved GitHub account, project, and least-privilege token | GitHub owner: read and mutate a temporary project through an active release; prove exact project binding and cross-project denial. |
| docs-updater, ez-code, repo-activity-notify | Approved temporary Git repository and GitHub account where remote actions apply | GitHub owner: exercise a temporary branch/repository; prove path scope, revision conflict, denial, and retained last working release. |

Keyless remote integrations such as Open-Meteo still need live network proof. A mocked response or isolated discovery is not that proof.

## PostgreSQL authority proof

`scripts/verify-extension-postgres.ts` uses two independent PostgreSQL clients. Its seven ordered authority fences are release installation state, publication snapshot, owner user status, project membership, service-account state, workflow delegation, and running workflow state.

For each fence, the admitted transaction reads authority, starts revocation through the peer client, confirms PostgreSQL reports the peer as blocked, writes the proof row, commits, and confirms revocation. The checks then verify revoked state or later denial. Service and delegation call the canonical `workflowReleaseCanExecute` in the effect transaction.

`src/extensions/runtime-locks-postgres.test.ts` has two tests and four assertions. It checks one winner across two clients and checks that a waiting acquisition does not block the holder's effect counter update.

These checks prove ordering for database-admitted effects and denial of later admissions. They do not prove rollback, cancellation, or exactly-once behavior for an external network, shell, or file effect that already passed admission.

## Runtime conditional execution

| Source | Behavior without input | Required closing run |
| --- | --- | --- |
| `packages/@ezcorp/sdk/src/v4/mcp.test.ts` | One networkless rootless MCP test skips unless `EZCORP_RUN_PODMAN_TESTS=1`. | Run the file with the opt-in and count it separately from default totals. |
| `src/__tests__/marketplace-release-isolation.integration.test.ts` | Rootless immutable publish/rebuild skips unless `EZCORP_RUN_PODMAN_TESTS=1`. | Run the file with the opt-in. |
| `src/extensions/runtime-locks-postgres.test.ts` | Setup throws without `EXTENSION_TEST_POSTGRES_URL`; it does not skip. | Run against owned disposable PostgreSQL. |
| `scripts/verify-extension-postgres.ts` | The verifier throws without `EXTENSION_TEST_POSTGRES_URL`; it does not skip. | Run against owned disposable PostgreSQL. |
| `scripts/verify-first-party-lifecycle-v4.ts` | Default mode stops after the first failure. | Use `EXTENSION_VERIFY_ALL=1` for a record per discovered source. |

## SDK invocation teardown review

The head change closes notification admission after the handler settles, waits for admitted notifications with `Promise.allSettled`, retains the handler error when both handler and notification fail, reports a notification error when the handler succeeds, and rejects delayed notifications after closure.

The added tests cover notification paths. They do not yet establish the same lifetime behavior for direct `context.call`, `channel.request`, or credential helpers. This needs a real served host-path check because invocation context can outlive the notification channel's open flag. SDK files remain owned by the build/SDK owner.

## Evidence limits

- Rootless containers share the host kernel.
- Trusted-local mode has reduced isolation.
- Raw-secret access plus approved egress permits disclosure.
- Database rollback and cancellation cannot undo an admitted external effect.
- Discovery proves build, metadata, registration, and isolated runner behavior. It does not prove live external services.
- Line coverage is not penetration, sustained-load, or fault-injection evidence.

No candidate-specific penetration or sustained-load receipt has been found. Prior fault-injection receipts identify earlier trees and are starting evidence only.

## Invocation teardown defect and repair

The original candidate tracked only `channel.notify` promises. Direct `context.call`, `channel.request`, `getGrantedEnv`, and `readGrantedCredential` used the served context without the notification channel's admission gate. A handler could start a host effect without awaiting it and return an invocation result before the host effect completed. A delayed credential helper could also admit a new host request while earlier notifications drained.

The deterministic served-protocol regression was:

```sh
/tmp/ez-extension-bun-1.3.14/bun-linux-x64/bun test ./packages/@ezcorp/sdk/src/v4/serve.test.ts --timeout 30000
```

Before repair it reported 8 pass, 2 fail, and 30 assertions. The direct-call case observed the final response before the host response. The delayed credential case reached the invocation deadline instead of rejecting at admission closure. Evidence: `/tmp/ez-runtime-sdk-served-red.log`.

The repair gives the handler an immutable invocation-scoped context whose one `call` wrapper checks admission and tracks every admitted host call. Channel requests, notifications, environment handles, and raw credential helpers use that context. Admission closes when the handler settles, then all admitted operations drain. Notification failures remain invocation failures. A request failure that the handler catches can still return a valid fallback. Handler errors retain priority after draining.

The final targeted SDK cohort passes 22 tests and 99 assertions with zero failures. Evidence: `/tmp/ez-runtime-sdk-served-green4.log`.

The real rootless Podman worker regression builds and runs the extension artifact, starts host calls, confirms the invocation stays pending, releases the host replies, and confirms the worker returns the expected result. It passes 1 test and 6 assertions; 10 unrelated tests were filtered out. Evidence: `/tmp/ez-runtime-rootless-lifetime-green.log`.

The full SDK default suite passes 1,028 tests and 2,341 assertions, with one documented rootless MCP opt-in skip. Evidence: `/tmp/ez-runtime-sdk-default.log`. The separate opted-in MCP run passes 7 tests and 32 assertions with no skips. Evidence: `/tmp/ez-runtime-sdk-mcp-optin.log`.

The SDK declaration build passes. Scoped Biome checks pass with no diagnostics after removing one new warning. Evidence: `/tmp/ez-runtime-sdk-build.log` and `/tmp/ez-runtime-sdk-lint.log`.

Both first clean frozen installs pass on Bun 1.3.14. The root install built the SDK from its direct TypeScript development dependency. Evidence: `/tmp/ez-runtime-audit-root-install.log` and `/tmp/ez-runtime-audit-web-install.log`.
