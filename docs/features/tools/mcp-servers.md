# MCP Server Integration

> _Connect external Model Context Protocol servers (stdio / streamable-HTTP / SSE), cache their tool lists, and surface them to the LLM as namespaced extension tools — with stdio servers spawned inside a layered network + filesystem sandbox._

## Intent

EZCorp lets an admin plug any external [Model Context Protocol](https://modelcontextprotocol.io) server into the platform so its tools become callable by the chat LLM exactly like a first-party extension tool. An MCP server is stored as an extension row with `kind: "mcp"`; the install flow verifies connectivity, pulls the live `tools/list`, and caches it so the registry can hydrate the tool catalog at boot without re-connecting. Because an external MCP `stdio` server is an arbitrary binary (Python/Go/Rust — the SDK's process-poisoning sandbox does **not** apply to it), the hardest part of this feature is not the wire protocol but the sandbox envelope that confines it: a forward proxy for outbound HTTP, kernel namespaces, seccomp, resource limits, and a filesystem jail.

## How it works

### Wire client (`src/mcp/client.ts`)

`McpClient` is a thin wrapper around `@modelcontextprotocol/sdk`'s `Client`. One instance ≙ one `kind:"mcp"` extension row. It speaks one of three transports, chosen from the spec's discriminant:

- `stdio` → `StdioClientTransport` (or `HookedStdioClientTransport` when a Stage-2 veth `onChildSpawned` hook is present).
- `http` → `StreamableHTTPClientTransport`.
- `sse` → `SSEClientTransport`.

It exposes only the app's own shapes: `listTools()` maps the SDK's `tools/list` response into `ToolDefinition[]`, and `callTool(name, args)` maps the SDK's content blocks into a `ToolCallResult` (`text` blocks pass through; anything else is `JSON.stringify`'d). `getChildProcess()` is an SDK escape-hatch (`transport._process` via cast) used by the seccomp soak reader and the Stage-2 veth teardown; it degrades-soft to `null` if the SDK shape changes.

### Install / verify / cache (`POST /api/mcp-servers`)

1. `requireRole(locals, "admin")` — admin only.
2. Body parsed against `installMcpServerSchema` (a discriminated union on `transport`). Validation failure → 400.
3. A **throwaway** `McpClient` opens (`connect()`), lists tools (`listTools()`), then `close()`s in a `finally`. Any failure → **502** `MCP connect failed: …` so the UI can explain — nothing is persisted.
4. On success, `installMcpExtension(...)` (`src/db/queries/extensions.ts`) writes an `ExtensionManifestV2` with `kind: "mcp"`, `mcpServers: [server]`, and `tools: cachedTools`, then `createExtension(...)` persists the row (`source: "mcp:<transport>"`, `enabled: true`). The cached `tools` array is what the registry reads at boot — **no** connection happens on cold start.
5. `ExtensionRegistry.getInstance().reload()` rebuilds the in-memory maps; returns the row with **201**.

### Edit-after-install (`PUT /api/mcp-servers/[id]`)

Mirrors install: admin-gated, `updateMcpServerSchema`, throwaway-client verify (502 on failure leaves the stored config untouched), then `updateMcpExtension(...)`. The extension **name is immutable** (it's the identity); only `description`, the `mcpServers` connection config, the cached `tools`, and the `source` slug change. For `http`/`sse`, `mergeHeaders` treats a **blank header value as "keep the existing secret"** — secrets are never echoed back to the edit form, so blank means unchanged.

### Refresh cached tools (`POST /api/mcp-servers/[id]/refresh`)

Admin-gated. Calls `ExtensionRegistry.refreshMcpTools(id)`, which `getMcpClient(...)` (connecting through the full sandbox path for stdio), re-runs `listTools()`, rewrites the in-memory `toolMap` / `extensionTools` under the `<name>__<tool>` namespace, and persists the new manifest. Returns `{ id, tools }`; connection failure → 502.

### Namespacing & dispatch (`src/extensions/registry.ts`, `src/extensions/tool-executor.ts`)

- At `loadFromDb()`, every manifest tool is registered as `` `${manifest.name}__${t.name}` `` (double-underscore — Anthropic's tool-name pattern `^[a-zA-Z0-9_-]+$` rejects dots) with `originalName` retained. MCP tools share this namespace with hand-rolled and entity tools, so the LLM and composer treat them identically.
- When the LLM calls one, `tool-executor.ts:executeToolCall` runs the **per-tool-call PDP gate** (`engine.authorize(...)`, fail-closed) first, then branches on `manifest.kind === "mcp"`: it lazily resolves the `McpClient` via `registry.getMcpClient(extensionId)` and calls `client.callTool(originalName, resolvedInput)`. The same `recordToolCall` audit path runs as for subprocess tools.

### stdio sandbox envelope (`src/extensions/mcp-sandbox.ts`, `src/extensions/mcp-proxy.ts`)

`http`/`sse` transports are plain network clients — nothing to sandbox; `buildSandboxedMcpSpec` returns them unchanged. For **stdio**, the spawn is wrapped in layers (all built host-side; the actual `Bun.spawn` happens downstream in the transport):

1. **Resource limits** — always wrapped in `prlimit --rss=<mem> --as=<≥4GiB>` (RSS caps physical memory; `--as` keeps a *finite* virtual ceiling with headroom so JIT runtimes don't segfault).
2. **Bounded env** — `buildAllowedEnv(...)` so the child never inherits the web server's `process.env` (no leaking `EZCORP_PERMITTED_HOSTS`, operator secrets, etc.). `spec.env` is merged, but host-computed vars (`EZCORP_PROJECT_ROOT`, the data-dir mask, the jail/seccomp flags) are set **after** the merge so a manifest can't override them.
3. **Per-MCP forward proxy** (`createMcpProxy`) — bound on host loopback (`127.0.0.1:0`, OS-assigned port); `HTTPS_PROXY`/`HTTP_PROXY` (+ lowercase) injected so all outbound HTTPS routes through it. The proxy speaks HTTP/1.1 `CONNECT` only and enforces, per CONNECT: **(a)** constant-time bearer-token auth (`timingSafeEqual`; token embedded in the proxy URL); **(b)** an internal-host hard deny (localhost / RFC-1918 / link-local refused outright, regardless of grant); **(c)** a DNS-rebind recheck (resolved A/AAAA records re-checked against internal ranges); **(d)** a per-host PDP gate (`engine.authorize` for the `network` capability); **(e)** byte + connection quotas (100 MB/min rx+tx, 10 concurrent CONNECTs). Denies → 403/407/429/503 + an `MCP_HOST_BLOCKED` audit row with a `reason` discriminator. After `200 Connection Established` the proxy is a transparent byte-pump — TLS is end-to-end, never terminated.
4. **Namespace isolation** — on Linux, `unshare -U -m` (user + mount namespace) via a launcher script that drops `CAP_SYS_ADMIN` before exec. (`-n` was dropped: a full netns made the loopback proxy unreachable.) Audited as `MCP_NETNS_CREATED` / `MCP_NETNS_FALLBACK`.
5. **seccomp BPF** — a compiled syscall filter passed to `bwrap` via FD 3 (`EZCORP_MCP_BWRAP_SECCOMP_FD=3`). A post-shutdown soak reader (`runMcpSeccompSoakReader`) scans `journalctl -k` for `type=1326` violations matching the child PID and emits `MCP_SECCOMP_VIOLATION` rows.
6. **Filesystem jail** — tier-gated and now **unconditional** when a usable tier exists. `bwrap` tier → minimal-bind argv (`buildMcpJailBwrapArgs`: one rw extension-data work dir, ro system dirs, private `/tmp`, **no** `--bind / /`, nothing under `.ezcorp/data`). `landlock` tier (the Docker container, where unprivileged userns is blocked) → wrap the inner command with the Landlock shim. `advisory` tier → legacy masked `--bind / /` with the DB+secret dir masked by a private tmpfs (`EZCORP_MCP_DATA_DIR`, computed from `getDbMaskDirs()`).
7. **Stage-2 veth** (`EZCORP_MCP_STAGE2_VETH`, Phase 58) — when the host supports it (`ip` + `nft` + `CAP_NET_ADMIN` + a free slot out of 60), a veth pair is created, attached to the `br-ezcorp-mcp` bridge, and (post-spawn, via `onChildSpawned`) moved into the child's netns for kernel-level network isolation. Slot + host-side veth are released on child exit (and on connect failure). Audited `MCP_VETH_CREATED`.
8. **Pre-spawn conntrack guard** — if `nf_conntrack_count > 0.7 * nf_conntrack_max`, the spawn is **refused** with `MCP_CONNTRACK_HIGH`.

**Fail-open vs fail-closed:** by default every isolation layer **degrades open** (weaker stage + a fallback audit row) because on many Docker hosts netns/veth can't be set up even `--privileged`. Setting `EZCORP_MCP_REQUIRE_SANDBOX=1` flips this: any degradation below full isolation **refuses** the spawn (`MCP_SANDBOX_REQUIRED_REFUSAL`) instead.

## Usage

### REST API (all admin-only)

| Method & path | Purpose |
|---|---|
| `POST /api/mcp-servers` | Install: verify connectivity, cache `tools/list`, persist a `kind:"mcp"` extension. Body: `{ name, description?, server }`. 201 on success; **502** if the server won't connect. |
| `PUT /api/mcp-servers/[id]` | Edit-after-install: re-point at a new connection config, re-verify, re-cache tools. `name` immutable; blank header = keep existing secret. 502 leaves stored config untouched. |
| `POST /api/mcp-servers/[id]/refresh` | Re-list tools from the live server and rewrite the cached snapshot + registry maps. Returns `{ id, tools }`. |

`server` is a discriminated union on `transport`:

```jsonc
// stdio
{ "transport": "stdio", "name": "...", "command": "uvx", "args": ["mcp-server-foo"], "env": { } }
// http (streamable)
{ "transport": "http", "name": "...", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } }
// sse
{ "transport": "sse",  "name": "...", "url": "https://example.com/sse", "headers": { } }
```

There is **no** `GET` or `DELETE` on `/api/mcp-servers/[id]`. MCP extensions are listed and deleted through the general extension surface (`GET /api/extensions`, `DELETE /api/extensions/[id]`).

### UI entry points

- **Extensions page** (`web/src/routes/(app)/extensions/+page.svelte`): an "MCP Server" install mode (transport selector + command/args or URL/headers form, guided confirmation showing the discovered tool count), a dedicated **MCP** filter tab (`kind === "mcp"`), an `MCP · <transport>` badge, and a per-row "Refresh tools" action.
- **API helpers** (`web/src/lib/api.ts`): `updateMcpServer(id, { description?, server })`. (Install + refresh are called via raw `fetch` from the page.)

### Env vars / flags

- `EZCORP_MCP_REQUIRE_SANDBOX=1` — fail-closed: refuse any stdio spawn that can't reach full isolation.
- `EZCORP_MCP_STAGE1_TMPFS=0` / `EZCORP_MCP_STAGE1_SECCOMP=0` / `EZCORP_MCP_STAGE1_DNS_RECHECK=0` / `EZCORP_MCP_STAGE2_VETH=0` — operator kill-switches; each emits one `MCP_NETNS_FALLBACK` boot row per process.
- `EZCORP_PROJECT_ROOT` / `EZCORP_DB_PATH` — host-resolved; drive the data-dir exclusion mask (never overridable by a manifest's `spec.env`).

## Key files

- `src/mcp/client.ts` — `McpClient`: SDK wrapper, 3-transport selection, `listTools`/`callTool`/`getChildProcess`, `HookedStdioClientTransport`.
- `web/src/routes/api/mcp-servers/+server.ts` — `POST` install: throwaway-verify, cache tools, persist, reload registry.
- `web/src/routes/api/mcp-servers/[id]/+server.ts` — `PUT` edit-after-install: re-verify, `mergeHeaders` secret-preservation.
- `web/src/routes/api/mcp-servers/[id]/refresh/+server.ts` — `POST` refresh: `registry.refreshMcpTools(id)`.
- `web/src/routes/api/mcp-servers/schema.ts` — Zod discriminated union (`stdio`/`http`/`sse`) + install/update schemas.
- `src/extensions/mcp-sandbox.ts` — `buildSandboxedMcpSpec` (prlimit + namespace + proxy + jail + seccomp + Stage-2 veth) and `runMcpSeccompSoakReader`.
- `src/extensions/mcp-proxy.ts` — `createMcpProxy`: loopback CONNECT proxy with bearer auth, internal-host deny, DNS-rebind recheck, per-host PDP, quotas.
- `src/extensions/registry.ts` — `getMcpClient`, `refreshMcpTools`, `<name>__<tool>` namespacing, proxy/veth/soak lifecycle.
- `src/extensions/tool-executor.ts` — `executeToolCall` MCP branch: per-call PDP gate → `getMcpClient` → `callTool`.
- `src/db/queries/extensions.ts` — `installMcpExtension` / `updateMcpExtension` (build the `kind:"mcp"` manifest, store `cachedTools`).
- `src/extensions/types.ts` — `McpServerStdio`/`Http`/`Sse`, `McpServerDefinition`, `ExtensionManifestV2.kind`/`mcpServers`.
- `web/src/routes/(app)/extensions/+page.svelte` — MCP install form, MCP filter tab, refresh action.

## Features it touches

- [[permissions-and-grants]] — every MCP tool call and every outbound proxy CONNECT is gated by the PDP (`engine.authorize`) against the extension's `network` / tool grants.
- [[sandbox-and-isolation]] — stdio MCP servers reuse the same tier-gated jail / namespace / seccomp machinery as subprocess extensions.
- [[runtime-and-rpc]] — MCP tools are dispatched through the same `tool-executor` path and audit pipeline as subprocess and entity tools.
- [[overview-and-authoring]] — MCP servers are `kind:"mcp"` extension rows; they live in the same registry and UI as authored extensions.
- [[audit-and-observability]] — `MCP_HOST_BLOCKED`, `MCP_NETNS_CREATED/FALLBACK`, `MCP_VETH_CREATED`, `MCP_SECCOMP_VIOLATION`, `MCP_CONNTRACK_HIGH`, `MCP_SANDBOX_REQUIRED_REFUSAL` rows land in `/audit`.
- [[admin-surfaces]] — install / edit / refresh are all `requireRole(admin)`; the install UI lives on the admin-facing extensions page.
- [[rbac-and-permission-modes]] — the per-tool-call PDP gate runs under the active permission mode before any `callTool`.
- [[api-security]] — MCP management routes are admin-gated; deletion flows through the scope-gated `/api/extensions/[id]` route.
- [[mention-grammar]] — installed MCP tools surface under the `!ext` mention namespace alongside other extension tools.

## Related docs

- [Sandbox & isolation](../extensions/sandbox-and-isolation.md) — the namespace / bwrap / Landlock tiers MCP stdio spawns reuse.
- [Permissions & grants](../extensions/permissions-and-grants.md) — the PDP and `network` grant the proxy and tool dispatch enforce.
- [Runtime & RPC](../extensions/runtime-and-rpc.md) — extension tool dispatch and the `<name>__<tool>` namespace.
- [Manifest schema](../../extensions/manifest-schema.md) — `kind` / `mcpServers` manifest fields.
- [Deployment](../../deployment.md) — `EZCORP_MCP_REQUIRE_SANDBOX` and the fail-closed sandbox enforcement section.

## Notes & gotchas

- **`http`/`sse` transports are unsandboxed by design.** `buildSandboxedMcpSpec` returns them untouched — they are network clients, not spawns, so there is no namespace/proxy/jail. The outbound traffic of a remote MCP server is the operator's responsibility (the URL is trusted at install time). Only `stdio` (a local binary) gets the full envelope.
- **External stdio binaries bypass the SDK's process-poisoning.** Unlike first-party subprocess extensions, an external MCP binary (Python/Go/Rust) does not honor the SDK's `node:fs`/`child_process` poisoning. This is precisely why the bwrap/Landlock filesystem jail (masking `.ezcorp/data` — the PGlite DB + JWT secret) is the load-bearing containment, not the SDK preload.
- **Default posture fails OPEN.** Without `EZCORP_MCP_REQUIRE_SANDBOX=1`, a host that can't set up netns/veth (common under Docker even `--privileged`) silently runs the MCP at a weaker stage with only a fallback audit row. Operators who need guaranteed isolation must set the flag.
- **Cached tools can drift.** The tool list is a snapshot taken at install / edit / refresh time and persisted in `manifest.tools`; boot does **not** re-connect. If the upstream server changes its tools, the cached list is stale until an admin hits refresh.
- **DNS-rebind recheck has a documented TOCTOU.** The proxy re-resolves the hostname and rejects internal IPs, but the window between that lookup and `Bun.connect` is a known gap (deferred — would require pinning the connect to the validated IP with SNI plumbing).
- **No dedicated GET/DELETE.** Don't look for `GET`/`DELETE /api/mcp-servers/[id]`; only `PUT` + the `refresh` subroute exist. Listing and deletion go through the general `/api/extensions` surface, where `DELETE /api/extensions/[id]` (`requireScope("extensions")` + `requireAuth` + admin) calls `registry.killAll()` then `registry.reload()` — `reload()` is what stops the now-deleted extension's per-MCP proxy/client (any id no longer live).
- **`getChildProcess()` reaches into SDK internals.** The seccomp soak reader and Stage-2 veth teardown depend on the undocumented `transport._process` field. A future `@modelcontextprotocol/sdk` rename makes these degrade-soft to no-ops (audit signal goes quiet; nothing in production breaks).
