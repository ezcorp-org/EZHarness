# Pluggable infrastructure: Astra review and validation

Date: 2026-09-22
Worktree: `feat/pluggable-infrastructure-v1` at `EZHarness-worktrees/pluggable-infrastructure-v1`

## Verdict

The offline contract, controller, routing, admission, and adapter slices have useful focused tests. The feature is **not ready for live Incus or Infisical use**. The host has no registered protected Incus transport route, reviewed connection binding, or host-owned mTLS transport. No live guest workflow or independent second sandbox provider has passed the acceptance suite. An offline adapter test does not establish an installed provider works end to end.

## Astra findings and fixes

| Finding | Result | Verification |
| --- | --- | --- |
| A sensitive provider could send `provider/log` notifications into the ordinary event queue. | Classified workers and the service now suppress ordinary notifications and reverse RPC; five new regressions failed before the fix. | 57 focused secret-transport tests pass. |
| Sandbox preview requests could forward browser credentials and internal headers. The first empty-header fix also failed under pinned Bun. | Preview forwarding now creates an explicit request with sanitized headers and preserved method/body. | Astra reran its exact credential canaries; they pass. |
| Reconciliation could starve later operations, apply an old STOP after START, or start after DESTROY. | Journal ordering and current-operation fencing were repaired. | Astra reran exact failure cases; controller suite passes 16 tests and 94 assertions on PGlite and real PostgreSQL. |
| A CREATE still in flight could race DESTROY and produce a false cleanup result. | Dispatch for one binding is serialized; cleanup waits for uncertain earlier effects. | The prior failing race test now passes. |
| Migration reapply could leave legacy operations without a current-operation pointer. | Reapply backfills the pointer, with DESTROY priority for tombstones. | The prior failing legacy fixture now passes. |
| History could drop local image attachments, and extension uploads could fail before target selection was handled. | History resolves the persisted project through the target guard; uploads deny sandbox bindings before writing. | Independent Astra rerun: 36 attachment tests, 81 assertions. |
| A direct `AgentExecutor.runAgent` call without `control.workspaceTarget` could read AMD files for a durably sandbox-bound project. | A shared durable resolver now preflights agent, chat, workflow start/resume, and setup-tool entrypoints. | Astra reproduced the AMD read before the fix; an independent final rerun passed the real-PGlite host-file canaries. |
| Infisical setup accepted a connection ID that the broker and SDK later rejected. | Config now applies the same narrow ID grammar at creation. | Astra reproduced `infisical.production` before the fix; 57 Infisical and 18 broker/SDK tests now pass. |
| Real Incus `describe` could not pass candidate conformance: the provider reported its declared capabilities, while the matcher expected an older shape without them. | The cross-package comparison now checks the signed catalog as an order-independent set; final checks are pending. | Astra reproduced `sandbox_conformance_failed` on `incus/describe` before any live I/O; the worker reran the real manifest and adapter successfully after the fix. |

The candidate verifier also supplies only `{ezConversationId}` metadata while the real Incus entrypoint requires `providerConfig`. The current static conformance fixture pins a synthetic connection and backend version. Both boundaries need a real adapter/host integration test; changing only the catalog comparison will not make the provider qualify.

The workspace audit also found local Git/PR fallback in three project brokers when a caller omitted `workspaceTarget`. Real-PGlite regressions reproduced host Git/PR effects before the fix. All three brokers now resolve durable project binding before host effects. Astra independently reran eight final workspace/broker files: **43 tests, 279 assertions, zero failures**. These checks prove safe denial; sandbox workflow resume and PR operations still need live backend support.

## Test quality and limits

Focused tests cover real PGlite rows, a real PostgreSQL controller/admission lane, file canaries, operation races, and negative authorization paths. The adapter tests still inject fake transports; they do not cross the installed v4 provider, host API, certificate, or live backend boundary. Controller restart tests mostly create a new controller against the same database process. A killed-host restart, real Incus guest, Compose workload, credential-scope test, and repeated lifecycle run are still required.

The wire envelope and size limits appear in both SDK and runner code. Keep one authoritative shared definition before adding more provider methods to avoid drift.

The adapter's declared `POST /api/sandbox-providers/incus/transport` is absent from `src/api-registry.ts`; `validateHostApiRequest` returns `api_route_denied`. This was reproduced against the current worktree. The matching Infisical host integration is also unfinished. The implementation plan records the host transport, connection, server setup, and live qualification work.

The final pinned Bun 1.3.14 repository run is green: **26,021 pass, zero fail, 1,670 files**. Root typecheck, lint, production build, source-lock check, and `git diff --check` also pass. Lint reports eight informational notices and no errors. The web build script now uses `bun x`, so it follows the repository's pinned Bun instead of the system `bunx`.

Earlier full runs exposed 43 executor/chat fixtures that did not model the new durable admission, three project-root fixtures affected by Git ancestors in this environment, and a stale source lock after those example-test edits. Sol repaired the fixtures; Astra rejected two initially unrealistic null-project mocks, then independently approved their schema-valid replacements and reran the nine affected tests. The repository's lock generator changed only the two example source digests. An earlier managed-sandbox run had unrelated `EPERM` pipe failures because the runner uses `setsid`; the final unrestricted run supersedes it.
