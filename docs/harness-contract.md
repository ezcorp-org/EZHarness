# Remote harness contract

How an external harness — a Playwright suite, a CI script, or another agent —
connects to a running EZCorp instance to **configure**, **control**, **use**,
and **deterministically test** it; and the rules that keep this capability
working as the app grows.

## Two tiers

| Tier | What | Gating | Examples |
|---|---|---|---|
| **Control** | Drive + observe a live instance | API-key **scope** (+ admin **role** for `requireRole` routes) — works in production | `POST /api/conversations/:id/messages`, `GET /api/runs/:id?wait=1`, `/api/runtime-events`, `/api/settings/:key` (admin role), `/api/tool-calls/:id/permission` |
| **Determinism** | Deterministic LLM + state for tests | `isTestSurfaceEnabled()` (operator opt-in + harness flag + non-prod) **and**, for the mock LLM, loopback | `/api/__test/mock-llm/**`, `/api/__test/seed`, `/api/__test/reset` |

The determinism tier is **fail-CLOSED**: `isTestSurfaceEnabled()` requires
**all three** of `EZCORP_ALLOW_TEST_SURFACE=1` (a conscious operator opt-in,
default-OFF), `PI_E2E_REAL=1` (the harness flag), and a non-production
`NODE_ENV`. Because the operator opt-in is required, copying `PI_E2E_REAL=1`
from an e2e config onto a public/staging box (where `NODE_ENV` is unset or
non-`production`) does **not** open the destructive `seed`/`reset` surface.
The prod image additionally pins `NODE_ENV=production`. The real-auth
Playwright harness sets all three in its preview server's env (see
`web/playwright.real.config.ts`). See
[`src/test-surface.ts`](../src/test-surface.ts).

## Getting access (auth bootstrap)

API keys are bearer tokens (`ezk_*`) authorized along **two independent
axes**:

- **Scope** (`read`, `write`, `chat`, `extensions`, `admin`) — gates WHICH surfaces a
  key can touch, via `requireScope`. Works in production. Scopes are **FLAT**:
  none implies another, so `read` does not admit a `write` route and `admin`
  admits none of the others. `write` was added 2026-08 — before it, `read` was
  the gate on 18 mutating handlers including several deletes
  ([audit](audit/2026-08-read-scope-mutation-inventory.md)).
- **Role** (`member` | `admin`, default `member`) — gates whether the key is
  a full **admin principal**, via `requireRole`/`checkRole`. An `admin`-role
  key is an explicit opt-in.

The two **compose**: an admin route needs a key that is an admin **principal**
(role `admin`) **and** carries the `admin` **scope**. Role alone is not enough
(a key minted `--scopes read --role admin` is refused for lack of scope), and
scope alone is not enough (a member-role key holding the admin scope is refused
for lack of role). The admin routes are **`/api/settings/:key`, the extension
lifecycle (install/activate/enable/disable/uninstall + permission editing), MCP
servers, users/teams, and audit** — mint with `--scopes admin --role admin` to
reach them.

The refusal *shape* differs by handler. The routes converted to `checkRole`
return a **clean 403** on either axis. That set is `/api/settings/:key`, the
extension install/activate/permission-editing routes, the webhook-rotate
route, and (as of F2) `POST`/`DELETE /api/providers`, all of
`/api/search/backend`, `POST`/`PUT /api/mcp-servers[/:id]` +
`POST /api/mcp-servers/:id/refresh`, `POST /api/providers/local/{models,test}`
and `POST /api/extensions/:id/modifiable`.

Routes still gated by bare `requireRole` (users/teams, audit, …) enforce only
the **role** axis and **throw** their denial, which SvelteKit surfaces as a
**500** rather than the intended 403 (a known rough edge, not a leak).
Providing both axes avoids it.

**Anti-escalation:** minting an `admin`-role key requires the actor/owner to
already hold admin role. Over HTTP the actor mints for itself, so an
admin-role mint needs an admin cookie session or an admin-role key — a
member-role key holding only the `admin` SCOPE is refused `role=admin` (it can
still mint member-role keys). The CLI (`--role admin --user <email>`) applies
the same ceiling to the target OWNER: an admin-role key can only be minted for
a currently-admin user.

**Mint-time warning (role without scope):** because the axes are independent,
`--scopes read --role admin` is accepted — and produces a key whose ROLE
implies instance administration but which every admin route refuses on the
SCOPE axis. `ezcorp key mint` prints a warning to stderr naming that exact
consequence and the fixing command. It is a warning, not a refusal: a
deliberately narrow admin-role key is legitimate now that the scope is
enforced. The predicate is `adminRoleScopeWarning`
([src/auth/api-key.ts](../src/auth/api-key.ts)), shared so the CLI and HTTP
mint paths cannot drift.

**Live re-validation (keys die with their owner).** Role is snapshotted at
mint, but it is re-checked on **every** request: the owner is re-loaded and
- if the owner is missing or not `active` (disabled/deleted), the key is
  **rejected outright (401)** — revoking a user revokes their keys;
- the effective role is **clamped down to the owner's current role**, so a
  since-demoted admin's key silently degrades to `member`.

Scopes are not re-clamped (their ceiling is enforced at mint). There is no
"admin revokes another user's keys" endpoint yet — disable/demote the owner
to kill their keys. The `apikey:`/`apikeyhash:` settings rows are deny-listed
from the generic `/api/settings/:key` API so a key row can't be forged there.

Cold-start without a UI session:

```sh
ezcorp key mint --scopes read,write,chat                     # member key, prints raw once
ezcorp key mint --scopes admin --role admin --user me@x.com --name ci  # admin-role key
```

**Embedded-PGlite instances:** the datadir is single-writer, so run `key mint`
while the server is **stopped** — against a running server the CLI refuses
(fail-loud `DbInUseError` from the live-holder guard,
`src/db/live-holder-guard.ts`) because a second process's writes would be
invisible to the server and risk corrupting the datadir. On a live instance,
mint through the server instead: Settings → Developer → API keys, or
`POST /api/settings/developer/api-keys` with an admin session. External
Postgres (`DATABASE_URL`) has no such restriction.

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
  { toolCalls: [{ name: "readFile", arguments: { path: "README.md" } }] },
  { text: "done" },
]);
```

Deterministic runs select `provider: "ezcorp-mock", model: "mock:<key>"`; only
the LLM's HTTP boundary is faked — the real tool loop, permission gates,
persistence, and runtime SSE all execute. The generated OpenAPI contract
(`buildOpenApiSpec()` in [`src/openapi.ts`](../src/openapi.ts)) is derived from
the registry below.

#### Scripted usage + fault injection (cache / failover harness)

A scripted `MockTurn` carries two optional fields so tests can assert cache
behaviour and provider failures **without real keys** (both go through the
existing per-key FIFO — no extra route, no global flag):

- **`usage`** — synthetic token counts reported on the turn:
  `{ input?, cacheRead?, cacheWrite?, output? }`. These map 1:1 onto pi-ai's
  parsed `AssistantMessage.usage` (`cacheRead` → `prompt_tokens_details.cached_tokens`,
  `cacheWrite` → `…cache_write_tokens`), so they flow through `ctx.totalUsage`
  and the `run:usage` event. A plain turn keeps the historic `input:0,
  output:1` (cache-miss) shape.
- **`fault`** — fail the turn deterministically **before the first token**
  (so a retry/failover loop can be exercised): `{ status }` (400–599) replies
  with an OpenAI-shaped error body at that HTTP status (429 rate-limit / 5xx
  server error), and `{ kind: "connection" }` aborts the response body (a
  transport-style connection drop). Because faults are just FIFO turns, a
  `[{ fault }, { text }]` script fails the first attempt and succeeds on the
  retry.

```ts
await ez.scriptLlm("conv-cache", [
  { text: "cached reply", usage: { input: 200, cacheRead: 800, cacheWrite: 0 } },
]);
await ez.scriptLlm("conv-failover", [
  { fault: { status: 429 } },          // first attempt: rate-limited
  { text: "served by the fallback" },  // retry: succeeds
]);
```

### Extension control

Extensions are wired **per conversation**. A harness lists the installed set,
wires extensions to a conversation, then invokes their tools directly — via
`listExtensions`, `wireExtensions`, `listWiredExtensions`, and
`invokeExtensionTool`:

```ts
await ez.listExtensions();                         // installed set (read scope)
await ez.wireExtensions(convoId, ["scratchpad"]);  // extensions scope
await ez.listWiredExtensions(convoId);             // read scope
const r = await ez.invokeExtensionTool(convoId, "scratchpad", "scratchpad_write", { key, value });
```

- **Wiring is required.** An extension's storage-scoped tools fail with
  "Extension not wired to this conversation" until it is wired — via
  `POST /api/conversations/:id/extensions` (the client's `wireExtensions`) or an
  `![ext:name]` chat mention. Wiring is idempotent and all-or-nothing: an
  unknown name 404s and wires nothing.
- **Scopes.** `read` lists (installed set + a conversation's wired set);
  `extensions` is required to wire (`POST /api/conversations/:id/extensions`)
  and to invoke (`POST /api/tool-invoke`). A tool-level failure RESOLVES with
  `{ success: false, error }` (HTTP 200) — only an unknown tool, a bad body, or
  a scope/ownership rejection is a non-2xx (thrown `HarnessApiError`).
- **Some extensions are not yours to wire, and the refusal looks like a typo.**
  An MCP-kind extension may be wired (and invoked) only by an admin, by the
  key owner who installed it, or by a holder of the `mcp-wire` RBAC grant —
  see [permissions-and-grants](features/extensions/permissions-and-grants.md).
  A refusal deliberately reuses the *unknown* vocabulary so the installed MCP
  set stays unenumerable, which means an integrator sees:
  - `wireExtensions()` → `404 {error: "Unknown extension(s)", unknown: ["<name>"]}`
  - `invokeExtensionTool()` → `404 {success: false, error: "Tool not found: <ext>__<tool>"}`

  Both are the SAME response you get for a name that does not exist. If a name
  you read from `GET /api/extensions` comes back "unknown", it is an
  authorization refusal, not a typo — ask an admin for an `mcp-wire` grant on
  that extension rather than retrying.
- **`POST /api/tool-invoke` requires you to own the conversation.** The
  `conversationId` is authorization input, not a label: a conversation you do
  not own (walking to the root of the parent chain) is `404
  {success: false, error: "Conversation not found"}`, and nothing is
  dispatched. Admin-role keys are exempt, as everywhere else.
- **`GET /api/extensions/:name/tools` reads the LIVE registry** and 404s until
  the extension is loaded, so it is not a reliable discovery source in v1. Use
  the `manifest` (incl. `tools[]`) embedded in each `GET /api/extensions`
  record instead.

### Extension lifecycle (admin-role key)

Beyond wiring, a harness can manage the installed set itself. Install lands an
extension **disabled with no permissions**; `activate` enables it and grants
its manifest-clamped permissions. These are `requireRole(admin)` routes — an
`admin`-**role** key is required (a scope-only key gets a clean 403):

```ts
const ext = await ez.installExtension({ source: "local", path: "/srv/my-ext" }); // admin role
await ez.activateExtension(ext.id, { storage: true });   // enable + grant (admin role)
await ez.updateExtensionPermissions(ext.id, { network: true }); // clamp to manifest (admin role)
await ez.setExtensionEnabled(ext.id, false);             // disable (admin role + extensions scope)
await ez.uninstallExtension(ext.id);                     // remove (admin role + extensions scope)
```

| Method | Route | Auth |
|---|---|---|
| `installExtension` | `POST /api/extensions` | admin role |
| `activateExtension` | `POST /api/extensions/:id/activate` | admin role |
| `setExtensionEnabled` | `PATCH /api/extensions/:id` | admin role + `extensions` scope — **disable-only** (`enabled:false`); enable via `activateExtension` |
| `uninstallExtension` | `DELETE /api/extensions/:id` | admin role + `extensions` scope |
| `updateExtensionPermissions` | `PUT /api/extensions/:id/permissions` | admin role |
| `setExtensionSecret` / `deleteExtensionSecret` | `POST`/`DELETE /api/extensions/:id/secrets` | `extensions` scope + per-extension `secrets` RBAC grant (admins hold every scope) |

- **`activateExtension` is the only enable path.** `setExtensionEnabled(id, true)`
  is refused (400) — enabling must run the manifest-clamped permission review in
  `/activate`. `updateExtensionPermissions` also clamps to the manifest: anything
  the author didn't declare is dropped silently.
- **Secrets** are scope-isolated per extension + project; the plaintext `value`
  is never echoed back. `projectId` omitted/`null` = the instance-wide scope.

### Hub actions + run control

```ts
await ez.triggerHubAction(pageId, "refresh", { since: 5 }); // core Hub page action (chat scope)
await ez.cancelRun(runId);                                  // cancel in-flight run (chat scope, ownership-gated)
```

Hub-action `payload` values must be scalars (string / number / boolean). A
handler may return a freshly rendered `page` tree in the result. `cancelRun` is
ownership-gated — a non-owner sees a 404, never a leak.

### Webhook delivery (Loops EZ Mode Phase 4)

```ts
await ez.deliverHook("webhook-ticket-loop", "tickets", {
  body: JSON.stringify({ id: "T-1", priority: "high" }),
  contentType: "application/json",
  token: hookSecret,          // OR: signature: "sha256=<hmac>"
});                            // → { accepted, deliveryId } (202)
```

`deliverHook` drives the PUBLIC `POST /api/hooks/:extensionId/:slug` route. Its
auth is the **per-hook token / HMAC**, NOT the harness API key — the method
sends its own `Authorization` (or `X-Hub-Signature-256`) and never attaches
`ezk_*`. Obtain a token from the admin rotate route
`POST /api/extensions/:name/webhooks/:slug/rotate` (shown once). Non-2xx
(`401`/`404`/`413`/`429`) throws `HarnessApiError`. See
[docs/extensions/loops.md § Webhook triggers](extensions/loops.md#webhook-triggers).

## The standing rule — keep new features remotely testable

A CI meta-test ([`web/src/__tests__/route-contract.test.ts`](../web/src/__tests__/route-contract.test.ts))
enforces these. When you add to the app:

1. **New `/api/*` route** → add it to [`src/api-registry.ts`](../src/api-registry.ts)
   with a `scope` (`read` / `write` / `chat` / `extensions` / `admin` / `public`),
   set to what the handler actually ENFORCES — never what it ought to. The
   meta-test enforces both halves, but not equally: registration is **absolute**
   (an unregistered route fails, no allowance), while the `scope` half is a
   **ratchet** against a frozen list of the 93 pre-existing entries that declare
   none, because `scope` is still optional on `ApiRouteEntry`. A new entry
   without one fails by name. Registering documents the route and puts it in the
   OpenAPI spec.
2. **New `/api/__test/**` route** → gate it with `isTestSurfaceEnabled()` from
   `$lib/server/test-surface`. The meta-test fails any ungated test route.
3. **New runtime event** that clients should see → add it to the single
   canonical list [`web/src/lib/runtime-event-names.ts`](../web/src/lib/runtime-event-names.ts)
   (the SSE endpoint's `BUS_EVENTS` and `ws.ts` both derive from it; the
   harness-client mirror is parity-tested).
4. **Route an external harness should drive** → mark it `harness: { controllable: true }`
   in the registry and expose a method for it on `HarnessClient`.

The registry is no longer a partial mirror. The frozen baselines that used to
carry the gap — 75 unregistered routes and 4 stale entries — were paid off in
2026-08 and **deleted**, so both parity directions are now absolute: every
control route on disk is registered, and every registered entry exists on disk.
Neither carve-out remains for a new gap to hide in.

One frozen baseline does remain, and only one: `KNOWN_SCOPELESS`, the 93 entries
that predate the `scope` requirement. It may only SHRINK. Retiring it means
backfilling those entries, making `scope` **required** on `ApiRouteEntry` so the
compiler enforces it, and deleting the ratchet as redundant.
