# Remote Testability Contract

> _EZCorp is remotely controllable and deterministically testable: a hand-maintained API registry drives an OpenAPI contract, a fail-closed `/api/__test/**` surface scripts a mock LLM over the OpenAI wire, and a CI meta-test ratchets the whole thing so new features stay drivable from an external harness._

## Intent

An external runner — a Playwright suite, a CI script, or another agent — must be able to **configure**, **control**, **use**, and **deterministically test** a live EZCorp instance without coupling to SvelteKit internals or cookies. This feature is the contract that makes that possible: a single source-of-truth registry of every documented HTTP route, a generated OpenAPI spec derived from it, a fail-closed determinism surface that fakes only the LLM's HTTP boundary (so the real tool loop, permission gates, persistence, and runtime SSE all execute), an `@ezcorp/harness-client` package that wraps it, and a governance meta-test that fails CI when a new route, test surface, or runtime event would silently break remote testability.

## How it works

The contract has **two tiers** with different gating:

| Tier | What | Gating | Reaches prod? |
|---|---|---|---|
| **Control** | Drive + observe a live instance | API-key **scope** only | Yes |
| **Determinism** | Deterministic LLM + seed/reset state for tests | `isTestSurfaceEnabled()` (+ loopback for the mock LLM) | No (fail-closed) |

### Registry → OpenAPI → /api/docs

- `src/api-registry.ts` hand-maintains `apiRegistry: ApiRouteEntry[]` — currently ~110 entries, each `{ method, path, description, category, scope?, harness?, schemaKey?, responseDescription? }`. `scope` is `read | chat | extensions | admin | public`; `harness: { controllable: true }` marks routes an external harness is expected to drive. Zod schemas are deliberately **not** imported here (cross-workspace Zod instance issues) — only a `schemaKey` string.
- `src/openapi.ts`'s `buildOpenApiSpec()` derives an OpenAPI 3.0.3 document from the registry: it templates `:id` → `{id}`, emits one operation per entry, tags by `category`, and attaches `security: [{ bearerAuth: [scope] }]` for any non-`public` scope. This is the external contract a harness generates a client against.
- `web/src/routes/api/docs/+server.ts` (`GET /api/docs`, `read`-scoped) serves a richer JSON view: it re-imports the registry and resolves each `schemaKey` to its real Zod schema at serve time (via `z.toJSONSchema`), so request bodies are documented without polluting the registry with schema imports.

### Control tier — driving a live instance

The control tier is plain authenticated REST + SSE, gated by API-key **scope** only, so it works in production:

- `POST /api/conversations` (`chat`) → create; `POST /api/conversations/:id/messages` (`chat`) → send a message and mint a `runId`.
- `GET /api/runs/:id?wait=1&timeoutMs=` (`read`) → **run-to-completion**: block server-side until the run reaches a terminal state. This route enforces per-user run ownership (`callerOwnsRun` → `getRunOwnership` + `resolveRootConversationForOwnership`), caps concurrent `?wait=1` long-polls (`EZCORP_MAX_RUN_WAITS`, default 200), and bounds the wait so a stuck run can't pin a thread.
- `GET /api/runtime-events` → the runtime SSE stream the harness consumes with `runId` correlation.
- `PUT /api/settings/:key` → configure; `POST /api/tool-calls/:id/permission` → approve/deny a permission gate mid-run.

### Determinism tier — the deterministic mock LLM

The `/api/__test/**` surface is **fail-closed**. `src/test-surface.ts`'s `isTestSurfaceEnabled()` requires **all three** of:

1. `EZCORP_ALLOW_TEST_SURFACE === "1"` — the conscious operator opt-in (default-OFF; the PRIMARY gate that makes the predicate fail-closed).
2. `PI_E2E_REAL === "1"` — the test-harness flag.
3. `NODE_ENV !== "production"` — belt-and-braces (the prod image pins `NODE_ENV=production`).

When closed, every `/api/__test/**` route returns `404` (indistinguishable from an unrouted path) and the `ezcorp-mock` provider does not resolve. Because the operator opt-in is required, copying `PI_E2E_REAL=1` from an e2e config onto a public/staging box does **not** open the destructive seed/reset surface.

The deterministic-run data path:

1. The harness seeds an ordered list of turns under a key via `POST /api/__test/mock-llm/script` (`{ scriptKey, turns: MockTurn[] }`) — this is called **externally**, so it goes through normal `chat`-scoped auth. `web/src/lib/server/mock-llm.ts`'s `setMockScript` stores them in a per-process `Map`.
2. The harness drives a message selecting `provider: "ezcorp-mock"`, `model: "mock:<key>"`.
3. The backend provider layer (gated by the same `isTestSurfaceEnabled()`) resolves the mock model; pi-ai's HTTP client POSTs to the in-process `POST /api/__test/mock-llm/v1/chat/completions` over loopback (`mockLlmBaseUrl()`, default `http://127.0.0.1:<port>/api/__test/mock-llm/v1`).
4. That completions handler pulls the next scripted turn (`mockScriptKeyFromModel(model)` → `dequeueMockTurn`) and replays it as a standard OpenAI **streaming** response (`buildMockStreamResponse` → `mockTurnToSseFrames`/`mockTurnToChunks`, including tool-call deltas and `finish_reason`). An unseeded key returns a clear sentinel stop-turn so an unscripted run is debuggable rather than hanging.
5. Only the LLM's HTTP boundary is faked — the pi-agent tool loop, permission gates, runtime SSE, and persistence all run unchanged.

### Loopback auth-bypass (the one unauthenticated path)

The completions endpoint is called server-internally with a dummy bearer token, so it can't satisfy normal auth. `web/src/lib/server/test-surface.ts`'s `isLoopbackTestBypass` lets **only** `/api/__test/mock-llm/v1` through unauthenticated — and even then, only when the test surface is enabled, the peer is genuine loopback (`isLoopbackAddress`), and no proxy-forwarding headers are present. It **fails closed on an unknown peer** (an empty/undefined remote address does NOT pass, unlike internal-auth's Unix-socket handling). The `/script` seed sub-path is deliberately excluded — it is called externally and must go through API-key auth.

### Seed / reset / cleanup

Other `/api/__test/**` routes give a spec a clean, owned slate, each gated by `isTestSurfaceEnabled()` + `chat`-scoped auth + ownership:

- `POST /api/__test/seed` → create a known project + conversation owned by the caller; optionally relax global rate limits (`rateLimitPerMin` writes `limits:rateLimit`). 201.
- `POST /api/__test/reset` → delete a conversation the caller owns (cascades messages/runs/tool-call state); idempotent; non-admin can only reset their own (`403` otherwise).
- `POST /api/__test/cleanup-extension`, `POST /api/__test/seed-extension-author-draft` → extension-author e2e fixtures.

### Runtime events — one canonical list

Client-facing runtime event names live in **one** place: `web/src/lib/runtime-event-names.ts` (`RUNTIME_EVENT_NAMES`). The server SSE endpoint's `BUS_EVENTS` and `ws.ts` both derive from it; the standalone harness package can't import app source, so `packages/@ezcorp/harness-client/src/events.ts` keeps an identical mirror kept honest by a parity test in `packages/@ezcorp/harness-client/src/index.test.ts` (which imports the app's `RUNTIME_EVENT_NAMES` and asserts `toEqual`). Server-only events (`obs:turn`, `briefing:delivered`) are intentionally excluded.

### The standing rule — governance meta-test

`web/src/__tests__/route-contract.test.ts` is a CI meta-test that keeps the contract from rotting. It scans `web/src/routes/api/**/+server.ts` on disk and asserts:

1. **Test-surface gating** — every `/api/__test/**` route literally invokes the negated guard `if (!isTestSurfaceEnabled())` (a comment or unused import won't satisfy it).
2. **Admin-gate pairing** — every route gating on the `admin` *scope* also gates on *role* (`requireRole`/`requireAdmin`), since `requireScope(admin)` is allow-all for cookie sessions. A frozen `KNOWN_SCOPE_ONLY_ADMIN` baseline captures pre-existing self-service exceptions; a *new* offender fails.
3. **Registry ⇄ filesystem parity** — registered routes must exist on disk (a frozen `KNOWN_STALE` set captures method/path drift), and the count of *unregistered* control routes must not exceed `BASELINE_UNREGISTERED` (135) — a **ratchet**: a new unregistered `/api/*` route pushes it over and fails until registered.

So when you add to the app: a new `/api/*` route must be added to `src/api-registry.ts` with a `scope`; a new `/api/__test/**` route must be gated with `isTestSurfaceEnabled()`; a new client-facing runtime event must go in `runtime-event-names.ts`; and a route an external harness should drive should be marked `harness: { controllable: true }` and given a `HarnessClient` method.

## Usage

### Getting access (auth bootstrap)

API keys are bearer tokens (`ezk_*`) with scopes `read`, `chat`, `extensions`, `admin` (`src/auth/api-key.ts`). Mint one via the CLI (`src/cli.ts` → `src/auth/mint-api-key.ts`), which enforces a scope ceiling (a key never carries authority its owner lacks):

```sh
ezcorp key mint --scopes read,chat                       # prints the raw key once
ezcorp key mint --scopes admin --user me@x.com --name ci
```

For a remote **browser** harness also set `CORS_ALLOWED_ORIGINS`; behind a proxy set `TRUSTED_PROXY_COUNT`; over HTTPS set `FORCE_SECURE_COOKIES=true`.

### The client (`@ezcorp/harness-client`)

Transport-agnostic (`baseUrl` + `apiKey` + injectable `fetch`, no SvelteKit/cookie coupling). It refuses to follow 3xx redirects (`redirect: "error"`) so a cross-origin redirect can't replay the bearer header to an attacker host.

```ts
import { HarnessClient } from "@ezcorp/harness-client";
const ez = new HarnessClient({ baseUrl, apiKey });

// Real run, blocking for the terminal result (server-side ?wait=1):
const r = await ez.runToCompletion(convoId, "hi", { provider, model });

// Deterministic run (test-mode instance) — scripts the LLM incl. tool calls:
await ez.runScripted(convoId, "read it", [
  { toolCalls: [{ name: "read_file", arguments: { path: "/x" } }] },
  { text: "done" },
]);

// Observe the SSE stream with runId correlation:
for await (const evt of ez.streamEvents({ conversationId })) { /* ... */ }
```

`HarnessClient` methods: `getSetting`/`setSetting`, `createConversation`, `sendMessage`, `getRun`/`awaitRun`/`runToCompletion`, `resolveToolPermission`, `scriptLlm`/`clearLlmScripts`/`runScripted`, and the `streamEvents` async iterator. `runScripted` defaults `permissionMode: "yolo"` so tool turns auto-approve unless overridden.

### Key API routes

| Method & path | Scope / gate | Purpose |
|---|---|---|
| `GET /api/docs` | `read` | Route catalog + resolved request JSON Schemas. |
| `POST /api/conversations` | `chat` | Create a conversation (`controllable`). |
| `POST /api/conversations/:id/messages` | `chat` | Send + mint `runId` (`controllable`). |
| `GET /api/runs/:id?wait=1&timeoutMs=` | `read` | Run-to-completion blocking poll (`controllable`, ownership-gated). |
| `GET /api/runtime-events` | auth | Runtime SSE stream. |
| `PUT /api/settings/:key` | auth | Configure a setting. |
| `POST /api/tool-calls/:id/permission` | auth | Approve/deny a permission gate. |
| `POST /api/__test/mock-llm/script` | test-surface + `chat` | Seed scripted LLM turns. |
| `DELETE /api/__test/mock-llm/script` | test-surface + `chat` | Clear all scripts. |
| `POST /api/__test/mock-llm/v1/chat/completions` | test-surface + **loopback** | In-process OpenAI-wire replay (internal only). |
| `POST /api/__test/seed` | test-surface + `chat` | Seed an owned project + conversation; relax rate limits. |
| `POST /api/__test/reset` | test-surface + `chat` | Delete an owned conversation (clean slate). |

### Env vars

- `EZCORP_ALLOW_TEST_SURFACE=1` — operator opt-in for the determinism tier (default OFF).
- `PI_E2E_REAL=1` — harness flag for the determinism tier.
- `NODE_ENV` — must be non-`production` for the determinism tier.
- `EZCORP_MOCK_LLM_BASE_URL` — override the loopback mock-LLM base URL when the bound port isn't in `PORT`/`EZCORP_PORT` (e.g. the e2e `vite preview` on :4173).
- `EZCORP_MAX_RUN_WAITS` — admission cap on concurrent `?wait=1` long-polls (default 200).
- `CORS_ALLOWED_ORIGINS`, `TRUSTED_PROXY_COUNT`, `FORCE_SECURE_COOKIES` — browser-harness / proxy / HTTPS knobs.

The real-auth Playwright harness sets the three determinism flags in `web/playwright.real.config.ts`'s preview server env.

## Key files

- `src/api-registry.ts` — hand-maintained `apiRegistry` (the single source of truth for the documented HTTP surface); `ApiRouteEntry` type with `scope` + `harness.controllable`.
- `src/openapi.ts` — `buildOpenApiSpec()`: derives OpenAPI 3.0.3 from the registry (scope-based `bearerAuth` security, path params, tags).
- `web/src/routes/api/docs/+server.ts` — `GET /api/docs` (`read`); serves the registry + resolves `schemaKey` → Zod → JSON Schema at serve time.
- `src/test-surface.ts` — backend `isTestSurfaceEnabled()` (the three-condition fail-closed gate), `MOCK_PROVIDER`, `mockLlmBaseUrl()`. Shared by web routes and the provider layer.
- `web/src/lib/server/test-surface.ts` — re-exports the gate + adds `isLoopbackTestBypass` / `LOOPBACK_TEST_BYPASS_PREFIXES` for `hooks.server.ts`.
- `web/src/lib/server/mock-llm.ts` — the deterministic mock-LLM store + OpenAI-wire emitter: `MockTurn`/`MockToolCall`, per-process script `Map`, `setMockScript`/`dequeueMockTurn`/`clearMockScripts`, `mockScriptKeyFromModel`, `mockTurnToChunks`/`mockTurnToSseFrames`/`buildMockStreamResponse`.
- `web/src/routes/api/__test/mock-llm/script/+server.ts` — `POST`/`DELETE` script seeding (external, `chat`-scoped).
- `web/src/routes/api/__test/mock-llm/v1/chat/completions/+server.ts` — in-process OpenAI-wire replay (loopback-bypass auth).
- `web/src/routes/api/__test/seed/+server.ts` — seed an owned project + conversation; optional rate-limit relaxation.
- `web/src/routes/api/__test/reset/+server.ts` — delete an owned conversation; idempotent, ownership-gated.
- `web/src/routes/api/__test/cleanup-extension/+server.ts`, `web/src/routes/api/__test/seed-extension-author-draft/+server.ts` — extension-author e2e fixtures.
- `web/src/lib/runtime-event-names.ts` — canonical `RUNTIME_EVENT_NAMES` (SSE `BUS_EVENTS` + `ws.ts` derive from it).
- `packages/@ezcorp/harness-client/src/index.ts` — `HarnessClient` (configure / drive / run-to-completion / permission / mock-LLM / SSE).
- `packages/@ezcorp/harness-client/src/events.ts` — mirror of the runtime-event names + `RuntimeEvent` shape (parity-tested).
- `packages/@ezcorp/harness-client/src/sse.ts` — `SseDataBuffer` SSE frame reassembler.
- `web/src/__tests__/route-contract.test.ts` — governance meta-test (test-surface gating, admin-gate pairing, registry⇄FS parity ratchet).
- `src/auth/api-key.ts` — `ezk_*` key primitives + `ApiKeyScope` (`read`/`chat`/`extensions`/`admin`).
- `src/cli.ts` / `src/auth/mint-api-key.ts` — `ezcorp key mint` (scope-ceiling enforced).
- `docs/harness-contract.md` — the prose contract this doc expands on.

## Features it touches

- [[developer-api-keys]] — `ezk_*` keys + scopes are the control-tier auth; `ezcorp key mint` bootstraps a harness.
- [[api-security]] — every route is gated by `requireAuth` + `requireScope`; the registry's `scope` field documents the requirement and the OpenAPI security block surfaces it.
- [[rbac-and-permission-modes]] — the meta-test's admin-gate pairing enforces role-gating on `admin`-scope routes; `runScripted` defaults to `yolo` permission mode.
- [[runs-lifecycle]] — run-to-completion (`GET /api/runs/:id?wait=1`) is the blocking primitive a harness awaits; it enforces run ownership.
- [[streaming-runtime]] — the mock LLM replays over the OpenAI wire so the real tool loop / SSE / persistence run; `/api/runtime-events` is the observed stream.
- [[providers-and-models]] — `ezcorp-mock` is a synthetic provider that only resolves under the test-surface gate.
- [[conversations]] — the harness drives conversations + messages; `seed`/`reset` create and tear down owned conversations.
- [[ask-user]] / [[permissions-and-grants]] — `resolveToolPermission` answers permission gates mid-run from the harness.
- [[audit-and-observability]] — runtime events the harness consumes are the same SSE substrate as observability.
- [[dev-lifecycle-and-gates]] — the route-contract meta-test is one of the CI gates that keeps the contract honest.
- [[deployment-and-releases]] — the prod image pins `NODE_ENV=production`, the third (belt-and-braces) condition keeping the determinism tier sealed in prod.

## Related docs

- [harness-contract](../../harness-contract.md) — the canonical prose contract: two tiers, auth bootstrap, the standing rule, the meta-test baselines. This doc is the in-tree expansion of it.

## Notes & gotchas

- **Determinism tier is fail-closed, three independent conditions.** All of `EZCORP_ALLOW_TEST_SURFACE=1`, `PI_E2E_REAL=1`, and non-`production` `NODE_ENV` are required. The operator opt-in is the one that makes it fail-closed: copying `PI_E2E_REAL=1` onto a staging box does not open `seed`/`reset`. When closed, `/api/__test/**` returns `404` and `ezcorp-mock` won't resolve.
- **Only the mock-completions path is unauthenticated, and only over loopback.** `isLoopbackTestBypass` covers exactly `/api/__test/mock-llm/v1` and **fails closed on an unknown/empty peer** — distinct from internal-auth, which treats an empty address as a Unix-socket signal. The `/script` seed path is NOT bypassed; it requires `chat`-scoped auth.
- **The registry is a curated, partial mirror.** It does not yet list every route on disk (~110 registered vs. a `BASELINE_UNREGISTERED` of 135 known gaps). The meta-test only *ratchets* — it forbids the gap *growing*; it does not require backfilling existing gaps. `scope` and the `KNOWN_STALE` method/path baselines are likewise being tightened over time, not exhaustively correct today.
- **`requireScope(admin)` is allow-all for cookie sessions.** It only gates API-key principals (`locals.apiKeyScopes` is undefined for a cookie), so any logged-in member would pass an `admin`-scope-only route. The meta-test's admin-gate-pairing scan exists precisely to force a *role* check alongside the scope; the `KNOWN_SCOPE_ONLY_ADMIN` baseline captures intentional self-service exceptions.
- **Active-run IDOR is a separate, OPEN finding.** `GET`/`POST /api/conversations/:id/active-run` only call `requireAuth` + `requireScope` with **no** conversation-ownership check (SvelteKit does not wrap child `+server.ts` in a parent guard), so any authenticated user can poll or cancel another user's live run cross-tenant. Note that `GET /api/runs/:id` (the harness run-to-completion route) *does* enforce ownership via `callerOwnsRun` — the gap is the per-conversation active-run route, not the runs route.
- **Mock-LLM script state is per-process and global, not per-conversation.** `setMockScript` writes a process-local `Map` keyed by `scriptKey`; `runScripted` defaults the key to the conversation id to keep concurrent specs isolated. A spec sharing a key (or the `default` bucket) shares the queue. `dequeueMockTurn` is FIFO and consuming.
- **Run-to-completion is bounded and admission-capped.** `?wait=1` is bounded server-side (a stuck run can't pin a thread) and capped by `EZCORP_MAX_RUN_WAITS` (default 200) to prevent a long-poll DoS; over the cap returns `429`.
- **The harness client never follows redirects.** Both `request()` and `streamEvents()` use `redirect: "error"` so a cross-origin 3xx can't replay the `Authorization: Bearer ezk_*` header to an attacker-controlled host.
