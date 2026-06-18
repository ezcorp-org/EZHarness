# Remote harness contract

How an external harness — a Playwright suite, a CI script, or another agent —
connects to a running EZCorp instance to **configure**, **control**, **use**,
and **deterministically test** it; and the rules that keep this capability
working as the app grows.

## Two tiers

| Tier | What | Gating | Examples |
|---|---|---|---|
| **Control** | Drive + observe a live instance | API-key **scope** only — works in production | `POST /api/conversations/:id/messages`, `GET /api/runs/:id?wait=1`, `/api/runtime-events`, `/api/settings/:key`, `/api/tool-calls/:id/permission` |
| **Determinism** | Deterministic LLM + state for tests | `isTestSurfaceEnabled()` (flag + non-prod) **and**, for the mock LLM, loopback | `/api/__test/mock-llm/**`, `/api/__test/seed`, `/api/__test/reset` |

The determinism tier is **inert in production**: `PI_E2E_REAL` is an explicit
default-OFF opt-in and the prod image pins `NODE_ENV=production`. See
[`src/test-surface.ts`](../src/test-surface.ts).

## Getting access (auth bootstrap)

API keys are bearer tokens (`ezk_*`) with scopes `read`, `chat`, `extensions`,
`admin`. Cold-start without a UI session:

```sh
ezcorp key mint --scopes read,chat            # prints the raw key once
ezcorp key mint --scopes admin --user me@x.com --name ci
```

In production, an operator mints a key and hands it to CI as a secret. For a
remote **browser** harness, also set `CORS_ALLOWED_ORIGINS` to the harness
origin; behind a proxy set `TRUSTED_PROXY_COUNT`; over HTTPS set
`FORCE_SECURE_COOKIES=true`.

## The client

`@ezcorp/harness-client` wraps the control + determinism surface (configurable
`baseUrl` + bearer, fetch-stream SSE consumer with runId correlation):

```ts
import { HarnessClient } from "@ezcorp/harness-client";
const ez = new HarnessClient({ baseUrl, apiKey });

// Real run, blocking for the result:
const r = await ez.runToCompletion(convoId, "hi", { provider, model });

// Deterministic run (test-mode instance) — scripts the LLM incl. tool calls:
await ez.runScripted(convoId, "read it", [
  { toolCalls: [{ name: "read_file", arguments: { path: "/x" } }] },
  { text: "done" },
]);
```

Deterministic runs select `provider: "ezcorp-mock", model: "mock:<key>"`; only
the LLM's HTTP boundary is faked — the real tool loop, permission gates,
persistence, and runtime SSE all execute. The generated OpenAPI contract
(`buildOpenApiSpec()` in [`src/openapi.ts`](../src/openapi.ts)) is derived from
the registry below.

## The standing rule — keep new features remotely testable

A CI meta-test ([`web/src/__tests__/route-contract.test.ts`](../web/src/__tests__/route-contract.test.ts))
enforces these. When you add to the app:

1. **New `/api/*` route** → add it to [`src/api-registry.ts`](../src/api-registry.ts)
   with a `scope` (`read` / `chat` / `extensions` / `admin` / `public`). The
   meta-test ratchets the count of unregistered routes — a new one fails until
   registered. Registering it documents it and puts it in the OpenAPI spec.
2. **New `/api/__test/**` route** → gate it with `isTestSurfaceEnabled()` from
   `$lib/server/test-surface`. The meta-test fails any ungated test route.
3. **New runtime event** that clients should see → add it to the single
   canonical list [`web/src/lib/runtime-event-names.ts`](../web/src/lib/runtime-event-names.ts)
   (the SSE endpoint's `BUS_EVENTS` and `ws.ts` both derive from it; the
   harness-client mirror is parity-tested).
4. **Route an external harness should drive** → mark it `harness: { controllable: true }`
   in the registry and expose a method for it on `HarnessClient`.

Pre-existing registry gaps (the registry is a partial mirror) and a handful of
stale entries are captured as frozen baselines in the meta-test — shrink them
as they're reconciled, never grow them.
