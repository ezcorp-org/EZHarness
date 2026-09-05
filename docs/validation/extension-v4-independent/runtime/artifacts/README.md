# Invocation runtime receipt bundle

Archive: `invocation-runtime-receipts.tar.gz`

SHA-256: `0b445837c26edcf2cb39cd5e449ae8b35d01c98a39530531fd12c9a6ab693e4d`

Source candidate for red/green repair: `3093a3a5e327b5ca6fb585b9f1271817553804e8`, tree `e7d774a0d81983060dc60c2b92b9393ba464b05c`, base `537f074e7303ecdf3cbef1a7af4fd60a3244b0a3`.

Repair commit: `1fdf454d`. Integrated equivalent: `ddd024e5`.

Deterministic rootless follow-up: `d00629a6`. Integrated equivalent: `691f4135`.

All executable receipts use `/tmp/ez-extension-bun-1.3.14/bun-linux-x64/bun`, version 1.3.14.

Contents:

- `ez-runtime-audit-root-install.log`: first root frozen install, exit 0.
- `ez-runtime-audit-web-install.log`: first web frozen install, exit 0.
- `ez-runtime-sdk-served-red.log`: served protocol before repair, 8 pass and 2 fail.
- `ez-runtime-sdk-served-green4.log`: targeted SDK after repair, 22 pass and 0 fail.
- `ez-runtime-rootless-lifetime-fault-red.log`: controlled original-code fault, 0 pass and 1 fail.
- `ez-runtime-rootless-lifetime-fault-restored-green.log`: restored rootless result, 1 pass and 0 fail.
- `ez-runtime-sdk-default.log`: SDK default, 1,028 pass, 1 opt-in skip, 0 fail.
- `ez-runtime-sdk-mcp-optin.log`: networkless rootless MCP opt-in, 7 pass and 0 fail.
- `ez-runtime-sdk-build-final.log`: final SDK declaration build, exit 0.
- `ez-runtime-sdk-lint.log`: initial scoped lint receipt. It records one warning that was removed. The later direct scoped check reported no diagnostics before commit.

The bundle contains test output only. It contains no credential values or live-service payloads.

## Final lifecycle and PostgreSQL receipts

- `all-first-party-lifecycle-freeze2.jsonl.gz` — authoritative frozen-tree JSONL for 50 extension records, summary, and command exit. It reports 50 passed, 0 failed, 0 untested; 4 smoke passed, 46 smoke not declared; and 1/117 capability rows tested. SHA-256 `fbfa262f97509e54441f2a77492398e724d713946f97aabfca89446522a0837b`.
- `all-first-party-lifecycle.jsonl.gz` — retained freeze-one checkpoint before the final capability narrowing. SHA-256 `462fa4718e1b076267942200d4b0c905874da5acb7c5878caf36c0dcd2f00221`.
- `capability-test-sources.txt` — 92 distinct exact test sources mapped by the capability inventory. SHA-256 `4a337e792485b40db572e74460c059b0f1fc2c8815489d3a3131d2acfea05207`.
- `postgres-final.log.gz` — authoritative clean non-login-shell run. SHA-256 `8a39a144e1c4f9334d7e6635d5aef35c7d5a578fac18ab46d6edb712dd9d9db5`.
- `postgres-wrapper-exit127.log.gz` — retained invalid wrapper receipt. Both child programs passed, but `/etc/bash_logout` failed under `set -u`, so the wrapper correctly remains exit 127. SHA-256 `22647adcdf629fad5592531347619f12352ad2f2ec401e8939203a21092980b0`.

The authoritative PostgreSQL rerun used Bun 1.3.14, rootless Podman, the pinned image `docker.io/library/postgres@sha256:485935f94cc7165afa896978809c37b592dc07f0a37d2c8f645f12412d0212c8`, `--pull=never`, `--log-driver=k8s-file`, a 256 MB memory limit, and a random loopback-only port. An exact-name trap removed the disposable container. The verifier exited 0 and proved release, publication, owner user, project membership, service account, workflow delegation, and running workflow revocation. Runtime-lock tests passed 2/2 with 4 assertions. The combined command exited 0.

Additional compressed receipts are indexed in `SHA256SUMS`: repository-activity fault red/final green, deterministic policy gap checks, Claude Design unit/browser/vendor checks, direct keyless-provider checks (including unauthenticated GitHub HTTP 200), the installed-live harness limitation, and changed-extension lifecycle red/green records. The `changed-lifecycle-red` receipt preserves the rejected `.js` text-import attempt and the subsequent body-boundary test failure; `changed-lifecycle-green` is the final successful two-extension proof.

Controlled-fault artifacts preserve the deterministic event grant-filter mutation and the todo root-denial failure. `repo-activity-red.log.gz` is an initial expectation mismatch, not a protection-removal fault; `repo-activity-green.log.gz` is the useful denied/error and recovery integration result. The Claude browser receipt applies network/style CSP through a meta policy and does not prove iframe sandbox opacity.

`keyless-installed-real-dns.log.gz` records the complete four-release real-broker run: GitHub Stats and Price Chart passed; Weather and City Conditions failed at the guarded Open-Meteo geocoder connection. `keyless-installed-production-resolver-detail.log.gz` records the exact weather tool error and City Conditions `UPSTREAM_UNAVAILABLE` envelope with empty broker failure arrays.

`keyless-installed-transport-diagnostic.log.gz` confirms the installed Open-Meteo failures occur in sandbox native fetch before a reverse-RPC network request. GitHub and Yahoo succeeded through the same release harness. Direct host guarded fetch to the same Open-Meteo geocoder returned HTTP 200. This was historical investigation evidence. The later late-binding repair and authoritative four-release run closed it; the SSRF guard was not weakened with hostname fallback.

`keyless-installed-after-fetch-fix.log.gz` proves the late-binding repair changed Weather and City Conditions from native connection failures to host-brokered provider HTTP 403 responses. `weather-city-lifecycle.log.gz` records the final affected lifecycle result: 2 passed, 0 failed, 0 untested.

`weather-city-fetch-capture-fault-red.log.gz` restores the early captured fetch and fails both authority assertions (0 pass, 2 fail). `weather-city-fetch-green.log.gz` restores the fix (2 pass, 0 fail, 8 assertions). `openmeteo-guarded-user-agent.log.gz` shows direct guarded geocoder HTTP 200 both with and without an explicit User-Agent; User-Agent does not explain the installed provider HTTP 403.

`keyless-installed-final.log.gz` is the authoritative production-resolver live run after the fetch repair: GitHub Stats, Weather, City Conditions, and Price Chart passed (4/4, 8 assertions, command exit 0). `keyless-installed-final.test.ts.txt` preserves the executed test body. `keyless-installed-final-replay.sh.txt` supplies the required production-resolver override, asserts that the synthetic seam is present, restores the helper with a trap, and makes the receipt replayable from a repository root. `weather-pinned-ip-diagnostic.log.gz` records the resolved IP targets, original Host headers, semantic weather payload, and zero broker failures. Earlier HTTP 403 and connection-failure logs remain as non-authoritative investigation history.
