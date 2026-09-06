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

`lessons-installed-ollama-green.log.gz` and its tracked test body record an exact built Lessons Distiller release: denied LLM authority caused no write, then the same process called local `gemma4:e2b` and produced one captured lesson write (1 pass, 7 assertions). The write handler is an owned collector, not the production lesson database handler. `local-llm-quota-persistence.log.gz` supplies the production-handler and database layers: 34 pass, 120 assertions for provider/model denial, quota/refund/budget, lesson subprocess writes, and memory dedup persistence. `keyless-installed-replay-final.log.gz` proves the corrected replay wrapper: 4 pass, 8 assertions, helper hash identical before/after, exit 0.

`local-llm-production-delivery-db.log.gz` adds the production persistence layers: delivery queue to owner-bound lesson row, lessons authority/audit/daily quota, and memory database injection (15 pass, 71 assertions). It does not combine the tool-less Memory Extractor event, live Ollama, and database write in one invocation.

`memory-installed-ollama-json-unsafe-red.log.gz` is the combined-path red receipt. The installed Memory Extractor reached local Ollama and received valid facts, but the production LLM handler returned a non-finite cost value; Bun rejected the reverse-RPC response with `Only JSON data is accepted`, and no memory row was written. Repair `735bcc18` admits only finite provider costs. `llm-json-safe-green.log.gz` records its focused result (19 pass, 61 assertions).

`memory-installed-ollama-combined-green.log.gz` is the final combined result (1 pass, 10 assertions). A real built Memory Extractor release receives `run:complete` through the production dispatcher and durable delivery queue. The first fire has no Ollama authority, receives `-32101`, and writes no row. The same process then receives an explicit local Ollama grant, calls live `gemma4:e2b`, and persists one row through the production dedup handler and owned PGlite database. Assertions cover conversation ownership, the intentionally null memory `userId`, project junction, provenance, and injection eligibility. Only embeddings are replaced with a fixed 384-value vector to avoid an unrelated model download; model routing, credential sentinel, quota, LLM completion, extension parsing, runtime invocation, dedup, and database writes are production code. The replay body and wrapper are `memory-installed-ollama-combined.test.ts.txt` and `memory-installed-ollama-combined-replay.sh.txt`; `memory-installed-ollama-combined-replay.log.gz` records the wrapper itself passing 1 test/10 assertions and removing its temporary test file.

`file-organizer-dynamic-lifecycle-green.log.gz` records the focused runtime lifecycle result after the real Compose test exposed restart-only activation: 64 pass, 0 fail, 264 assertions on Bun 1.3.14. The transition regression covers absent-at-boot activation, duplicate reload suppression, disable, uninstall, reactivation, and final teardown. A deferred-start case queues another reload, begins shutdown, proves shutdown remains pending, then proves the late-started daemon is stopped, the queued reload is cancelled, and no handle survives.

`file-organizer-lock-race-red.log.gz` deterministically holds the old daemon's lockfile release and proves the former fire-and-forget `stop()` reported completion early (0 pass, 1 fail). `file-organizer-lock-race-green.log.gz` is the preliminary combined-process green. The authoritative isolated-process receipts are `file-organizer-daemon-green-final.log.gz` (57 pass, 139 assertions) and `background-timers-green-final.log.gz` (64 pass, 264 assertions); separating them prevents the timer suite's broad module mocks from contaminating daemon evidence. Stop now completes after unlink; only then can reconciliation start a successor, whose lock remains present until its own awaited stop.
