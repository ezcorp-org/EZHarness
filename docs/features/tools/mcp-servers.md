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
3. A **throwaway** `McpClient` opens (`connect()`), lists tools (`listTools()`), then `close()`s in a `finally`. `connect()` runs the [outbound target guard](#outbound-target-guard-ssrf) first, so an `http`/`sse` URL aimed at an internal address never reaches a socket. Any failure — guard rejection, DNS failure, refused connection, timeout, protocol error — returns the **same 502 body** (see [the failure contract](#the-uniform-failure-contract)); nothing is persisted.
4. On success, `installMcpExtension(...)` (`src/db/queries/extensions.ts`) writes an `ExtensionManifestV2` with `kind: "mcp"`, `mcpServers: [server]`, and `tools: cachedTools`, then `createExtension(...)` persists the row (`source: "mcp:<transport>"`, `enabled: true`). The cached `tools` array is what the registry reads at boot — **no** connection happens on cold start.
5. `ExtensionRegistry.getInstance().reload()` rebuilds the in-memory maps; returns the row with **201**.
6. One `ext:mcp:server-installed` audit row is written (after the row exists, so the trail never claims an install that failed). Metadata is built by `src/extensions/mcp-audit.ts` — see [Audit trail](#audit-trail-mcp-lifecycle) below.

### Declared capabilities & the install-time grant (`src/extensions/mcp-capabilities.ts`)

An MCP row is synthesized straight into the DB, so it never passes through the disk loader's `migrateManifestV2ToV3` — the one place a v2 manifest normally acquires its per-tool `capabilities`. `mcp-capabilities.ts` is the derivation that replaces it, and it reads the hosts off the operator's own server definition:

- **`http` / `sse`** — the target `url`'s hostname. Every tool call opens an HTTPS connection from the HOST process to exactly that host, so `network:<host>` literally describes the call. These transports are never sandboxed, so the per-dispatch PDP gate is their only governance.
- **`stdio`** — every `://` URL on the server's `command` / `args` (e.g. `npx -y mcp-remote https://mcp.example.com/mcp` → `mcp.example.com`). A command line that names no host derives nothing and is **deny-by-default**: the forward proxy refuses every CONNECT because there is no granted host to match.

Every MCP row additionally declares **`mcpInvoke`** → the valueless `ezcorp:mcp:invoke` capability, and that one is not optional. `deriveCapsFromExtensionPerms` SKIPS an empty host array, so a hostless stdio server would otherwise declare `capabilities: {}`, which flattens to an empty needed set — and `firstMissingCapability([], granted)` is `null` for *any* grant. Without the sentinel the PDP was still inert for the most common stdio shape, and an admin's revocation was a silent no-op. It is deliberately **not** in `SENSITIVE_KINDS`: MCP tools are dispatched from cron fires, webhook deliveries and workflow steps, where a `prompt` decision is unanswerable and would park the run at `awaiting_approval` forever.

Three things are written from that one derivation:

1. `manifest.permissions.network` — the CEILING `clampExtensionPermissions` intersects an admin's `PUT /api/extensions/[id]/permissions` submission against, and the source of the "Network Access" checkbox row on the extension detail page.
2. `manifest.tools[*].capabilities` — the declaration `tool-executor/executor.ts` turns into the needed-cap set at dispatch. Re-derived at read time by the registry (`normalizeMcpManifest`), because `refreshMcpTools` rewrites `manifest.tools` from a fresh wire `tools/list` that carries none.
3. The install-time grant, recorded as BOTH `grantedPermissions` and `installedPermissions` (the same pairing `activateExtension` writes) so the reapprove flow clamps against the consent collected at install.

`mcpInvoke` is clamped three-state (`clamp-permissions.ts`): the manifest must declare it, an explicit `mcpInvoke: false` revokes, and an **absent** key falls back to the ceiling. That last rule is deliberate — the extension detail page's Save posts a fixed six-key body and cannot express this field, so the usual "omitted key revokes" default would let an admin editing an unrelated host list silently brick every tool on the server. `search` resolves the same tension the same way. It also sits **outside** the `capabilityToolsDisabled()` guard and is absent from `CAPABILITY_PERMISSION_FIELDS`: the cap is on the *needed* side of every dispatch, so dropping it under the kill-switch would deny every MCP tool call rather than disable a feature.

`updateMcpExtension` re-issues the grant only when the derived ceiling actually changed — a description-only edit preserves a deliberate admin revocation. Rows installed before this landed are healed once by `backfillMcpManifestCapabilities` (`migrate.ts`).

**What that backfill changes, precisely.** The declared config is untouched (every host comes from the row's own stored definition), but *enforced* behaviour moves in both directions: stdio **egress widens** — `mcp-proxy.ts` authorizes each CONNECT against `grantedPermissions`, which was empty for a legacy row, so all egress was denied and no admin action could allow it (the manifest declared no ceiling, so the clamp dropped every submitted host); and **dispatch tightens** — legacy MCP tools authorized against an empty needed set and are now gated. Net: a capability the operator had already configured becomes reachable, and one that was ungoverned becomes revocable. A row the backfill *misses* (migrate circuit breaker open, or an UPDATE that threw) fails **closed** and is reported once per boot by `registry.loadFromDb`; deriving the grant at read time was rejected because a revocation writes only `grantedPermissions`, so a read-time grant could not tell "never consented" from "consented then revoked" and would silently re-grant a revoked row.

### Edit-after-install (`PUT /api/mcp-servers/[id]`)

Mirrors install: admin-gated, `updateMcpServerSchema`, throwaway-client verify (502 on failure leaves the stored config untouched), then `updateMcpExtension(...)`. The extension **name is immutable** (it's the identity); only `description`, the `mcpServers` connection config, the cached `tools`, and the `source` slug change. `mergeMcpServerSecrets` treats **any blank credential value as "keep the existing secret"** — header keys, stdio env vars, URL query parameters and argv flags alike, matched BY NAME so an inserted flag can never shift one secret into another's slot. Secrets are never echoed to the edit form, so blank means unchanged; the previous values are rehydrated from the store first, or "blank = keep" would preserve an empty credential and the re-connect would authenticate with nothing. On success it writes one `ext:mcp:server-updated` row carrying BOTH sides, so a re-pointed connection is diffable.

### Credential isolation at rest (`src/extensions/mcp-secret-redaction.ts`)

An MCP server definition is the richest credential carrier in the extension surface, and the row it lives in is broadly readable. So **no credential VALUE is ever persisted in `extensions.manifest`**. Four carriers, one classifier, one rule — every NAME survives, every VALUE is blanked:

| Carrier | At rest | Notes |
|---|---|---|
| http/sse `headers` | `{"Authorization": ""}` | every value, including innocuous ones like `Accept` |
| stdio `env` | `{"GITHUB_TOKEN": ""}` | same rule |
| URL query values | `?api_key=` | `?api_key=…` is a real MCP convention; the URL's **password** goes too (`svc:pw@h` → `svc:@h`), the username stays |
| stdio argv | `--token=` , `GITHUB_TOKEN=` | any `NAME=VALUE` token loses its VALUE — the flag form, `-D`-style, and `docker run -e NAME=VALUE` |

The real values go to the AAD-bound `extension_secrets` store under one `mcp:auth` blob per extension (global scope), and are rehydrated **only** server-side: `registry.getMcpClient` calls `rehydrateMcpServerSecrets` BEFORE `buildSandboxedMcpSpec`, so the URL the client dials and the argv it spawns are the real ones. Each whole-value substitution (`url` / `command` / `args`) is guarded by one equality — the stored value is used only when redacting it reproduces what is at rest — so a blob left over from a config the manifest has moved past can never dial a stale host or paste one server's token into another's argv.

Two shapes cannot be blanked by rule and are handled explicitly:

- **The space-separated pair form (`--token SECRET`)** needs a name list, because the token after a flag is indistinguishable from a positional operand — blanking every one would eat `npx -y <package>`. `isSecretFlagName` matches whole `-`/`_`/`.`-separated words (`--gh-pat`, `--api-key`, `--auth-header` match; `--path`, `--pattern`, `--author` deliberately do not).
- **A URL anywhere in a token** keeps its host and path and loses only its query values, because `mcpNetworkHosts` derives the `network` ceiling from the STORED definition — blanking a host would silently shrink a live grant and deny the connect the admin just authorised.

**Stated residuals.**

- A BARE positional secret (`npx srv MY-SECRET`) is not redacted: nothing distinguishes it from a package name or a path, and every credential convention in the wild attaches a name.
- An admin who genuinely retypes the argv field, leaving a pair-form value blank, may have to re-enter it — the edit form joins argv on spaces, so a `""` slot disappears. The *unedited* prefill is restored whole by an equality check, and the inline `--flag=` form round-trips in every case.
- The scrub is gated on `manifest.kind === "mcp"`, so an `mcpServers` block declared by a **local**-kind manifest is served verbatim. That is deliberate: the host never launches those entries (there is no `persistMcpSecret` / rehydrate for them either), and the one in-tree example — `docs/extensions/examples/substack-pilot` — declares `${env.…}` PLACEHOLDERS as documentation of an external dependency, which blanking would destroy for no security gain. A local-kind manifest must not put a live credential there.
- A **disk-installed** `kind:"mcp"` manifest (`installer.ts` → `createExtension`, not `installMcpExtension`) is persisted verbatim, so its plaintext sits at rest until the next boot's backfill. No read surface exposes it in the meantime — every one of them scrubs — and installing an extension is admin-only. Nothing in-tree takes that path.

**Legacy rows** are healed once by `backfillMcpManifestSecrets` (awaited inside `migrate()`, so it completes before the server serves traffic): the plaintext moves to the store and the manifest is rewritten blanked. Its idempotency predicate IS the redactor (`mcpServerHasPlaintextSecret` is `redactMcpServer(s) !== s`), so there is no second definition of "already clean" to drift. A row healed of its `headers`/`env` by an earlier build and re-migrated for its `url`/`args` **merges** into the stored blob rather than replacing it — rebuilding from a manifest that now holds only blanks would delete the auth map it cannot reconstruct. Rows the pass fails on are warned by name and stay plaintext at rest, which is why every row-serving route ALSO scrubs on the way out (`redactExtensionSecrets`): `GET /api/extensions`, `GET /api/extensions/[id]`, the `/extensions` SSR loader, `POST /api/extensions/[id]/reapprove` (deliberately non-admin) and the three admin write routes that echo the row (`permissions`, `activate`, `modifiable`).

### Refresh cached tools (`POST /api/mcp-servers/[id]/refresh`)

Admin-gated. Calls `ExtensionRegistry.refreshMcpTools(id)`, which `getMcpClient(...)` (connecting through the full sandbox path for stdio), re-runs `listTools()`, rewrites the in-memory `toolMap` / `extensionTools` under the `<name>__<tool>` namespace, and persists the new manifest. Returns `{ id, tools }`; any failure → the uniform 502. Because refresh re-connects to the **stored** config, it re-runs the target guard too: a config whose hostname has since been rebound to an internal address is refused here, not just at install. On success it writes one `ext:mcp:server-refreshed` row whose before/after differ only in the tool snapshot — the pre-refresh manifest is read **before** `refreshMcpTools` writes the new one back, or both sides would show the new list.

### Outbound target guard (SSRF)

`src/mcp/target-guard.ts` validates every `http`/`sse` target before the transport opens. `stdio` is exempt — it spawns a process rather than dialing an address, and its egress is governed by the sandbox envelope below.

The guard is enforced in the backend, not in the route handlers, so there is one policy rather than one per call site. There are two enforcement points and the difference matters:

| Where | Runs | Covers |
|---|---|---|
| `McpClient.connect()` | once per **client** — `connect()` returns early on `this.connected`, and `getMcpClient` on `isConnected`, so on a long-lived registry client this is effectively once per process | fail-fast before a transport is built |
| `src/mcp/guarded-fetch.ts` | on **every HTTP request** the `http`/`sse` transport makes, and on **every redirect hop** | install, edit, refresh, registry reload, `tools/list`, and every `tools/call` on an already-connected client |

The second is the load-bearing one. Do not read "guarded at connect" as "guarded once per install" — nor as "re-validated on every lazy tool dispatch by `connect()`", which it is not; the *fetch* is what covers dispatch.

#### Redirects (`src/mcp/guarded-fetch.ts`)

Validating the configured URL was **not** enough on its own, and this was a real, reproduced bypass rather than a theoretical one. The MCP SDK owns the socket and its `fetch` followed redirects with default semantics, so a server we were allowed to reach could answer:

```
307 Location: http://169.254.169.254/latest/meta-data/iam/security-credentials/
```

and the platform dialed it — on install, edit, refresh, **and every lazy tool dispatch**. Measured against real local servers before the fix: with `302` the method downgrades to GET and the request still lands on the blocked address; with `307` method and body are preserved and a full bidirectional MCP session runs, whose `tools/list` flows back into the platform and therefore into the LLM turn. The attacker is the operator of any configured remote MCP server — exactly the party this guard exists to distrust. It also re-opened the port-scan oracle, via redirect-target timing.

Both transports accept a custom `fetch` (`opts.fetch`), and both route *every* request through it — the streamable POST/GET/DELETE, the SSE stream, and the SSE endpoint POST. So `McpClient` hands them one that:

- sets `redirect: "manual"` and re-runs the full target policy on each `Location` hop, resolving relative and protocol-relative values against the current URL;
- caps the chain at `MCP_MAX_REDIRECTS` (3), refusing with reason `redirect-limit`;
- applies standard method/body downgrade (`301`/`302`/`303` → GET, `307`/`308` preserve) so legitimate same-origin redirects keep working;
- **strips `Authorization` / `Cookie` on a cross-origin hop**, so a vendor cannot harvest its own bearer token by redirecting us to a host it controls;
- returns the terminal response with its body **unread**, so an MCP `text/event-stream` keeps streaming.

That last point is why `guardedFetch` from `src/search/egress.ts` is not reused wholesale: its `enforceBodyCap` reads the response to completion, which would hang a live MCP event stream forever, and its IP-pinning rewrites the URL host, which breaks TLS SNI for a vendor https endpoint. The address **policy** is still shared — every hop goes through `assertMcpTargetUrlAllowed`, i.e. the same `isBlockedIp` block-list.

The SSE transport's own endpoint-event origin check (`sdk/…/client/sse.js`) already rejects an endpoint whose origin differs from the connection, so that path is not duplicated here.

Policy:

1. The URL must parse and be `http:` or `https:`.
2. The hostname resolves to **every** address (`dns.lookup({ all: true })`). An IP literal is classified directly, never handed to the resolver.
3. If **any** resolved address is loopback, RFC-1918, link-local (`169.254.0.0/16` — the cloud metadata address), CGNAT (`100.64.0.0/10`), unspecified/`0.0.0.0/8`, or an IPv6 equivalent (`::1`, `::`, `fc00::/7`, `fe80::/10`, `fec0::/10`, and every v4-in-v6 transition encoding: v4-mapped, v4-compatible, 6to4, NAT64), the connect is refused. **All** addresses must clear, so a hostname with a mixed public/private A-record set is denied and round-robin DNS cannot smuggle an internal target past a lucky first answer.

Address classification is **not** re-implemented: `isBlockedIp` (plus the `parseIpv4` / `ipv6ToBytes` primitives) comes from `src/search/egress.ts`, which already owns the repo's block-list for host-side `read-url` fetches. One block-list, two callers.

> **Note on the web-tree guard.** `web/src/lib/server/security/url-validation.ts` (`isPrivateOrLoopback`) is a *different*, older guard used by the local-provider routes. It is a strict subset — it does **not** cover CGNAT, 6to4, NAT64, v4-compatible, or `fec0::/10` — and it lives in the web tree, which backend code under `src/` must never import. MCP uses the `src/search/egress.ts` classifier for both reasons.

#### The escape hatch — `EZCORP_MCP_TARGET_ALLOW`

EZCorp is self-hosted, so an MCP server on `127.0.0.1:3000` or on the LAN is a first-class deployment. A comma/whitespace-separated allowlist of hosts and/or CIDRs re-opens specific targets:

```sh
EZCORP_MCP_TARGET_ALLOW=127.0.0.1,::1,192.168.1.50,10.0.0.0/8,mcp.lan
```

An allowlist rather than a single `allow private` boolean, because a boolean is all-or-nothing: an operator who just wants their LAN MCP box would have to re-open `169.254.169.254` — the highest-value SSRF target on a cloud host — to get it.

Two entry kinds, and they are **not** equivalent:

| Entry | Matched against | Notes |
|---|---|---|
| IP or CIDR (`10.0.0.0/8`, `::1`) | each **resolved address** | The safe form — DNS cannot move the target out from under it. A v4 CIDR also covers the v4-mapped spelling of the same host. |
| Hostname (`mcp.lan`) | the **URL host** | Skips address validation entirely: "I vouch for this name, wherever it resolves". Whoever controls DNS for that name controls the target. Prefer the IP/CIDR form. |

Malformed entries are dropped, which can only make the guard stricter. Default posture with the var unset: **metadata and every private range denied**.

#### The uniform failure contract

All three routes previously echoed the raw transport error (`` `MCP connect failed: ${message}` ``). That was a **port-scan oracle**: `ECONNREFUSED` (port closed), a timeout (filtered/no host) and a protocol error (port open, not speaking MCP) are three distinguishable answers, so an admin-scoped key could sweep `http://10.0.0.x:<port>` and map the internal network from the response bodies.

Every failure now collapses to one status and one body (`src/mcp/connect-failure.ts`):

```
502  {"error":"MCP server unreachable or invalid. If the target is on a private network, allow it with EZCORP_MCP_TARGET_ALLOW."}
```

- A **guard rejection is indistinguishable from a connect failure**. A separate "blocked by policy" answer would rebuild the oracle across exactly the private/public boundary the guard defends.
- The message names the env var, and that text is **constant** — returned verbatim for a refused connection to a public host too — so it carries zero bits about the target while still telling a self-hosting admin why their LAN server won't install.
- **One uniform 502, not 400-for-invalid-URL.** Splitting the status by failure class is the same oracle in a different field. Zod validation errors keep their **400**: those are computed purely from the request body, with no DNS and no socket, so they leak nothing.
- Diagnosis is not lost — `reportMcpConnectFailure` writes the real cause to the server log **and** to `error_logs` via `persistError`, with `blocked` / `reason` / `target` metadata, so an SSRF attempt is greppable on the admin observability surface even though the HTTP response cannot say so.

### Audit trail (MCP lifecycle)

Install, edit and refresh each write exactly one `audit_log` row; uninstall (via the generic `DELETE /api/extensions/[id]`) writes `ext:uninstalled`. Until 2026-08 all four were silent, which made configuring a credentialed connection to a third-party server the one privileged extension mutation with no trail.

A row is written only after the mutation it describes has succeeded, so a guard rejection or any other connect failure leaves **no** audit row and **no** extension row — the uniform 502 above is the whole response.

`src/extensions/mcp-audit.ts` owns the projection from `McpServerDefinition` to metadata, and it is deliberately narrow: **transport**, a **target** that is the executable (stdio, itself URL-query-redacted) or the URL's **origin only** (http/sse — path, query and fragment are all dropped, because `?api_key=…` AND `/services/<opaque-token>` are both real MCP conventions), a **`pathDepth`** that preserves enough shape to tell two endpoints on one host apart without carrying a path byte, the **argv COUNT** rather than the argv, the **NAMES** of the transport auth entries (stdio `env` / http/sse `headers`), and the **tool count + names**. No header value, env value, argv value, path segment or URL query string ever reaches the row. `insertAuditEntry`'s `redactForAudit` is the second net, not the first.

This module's reasoning was correct and the layer beside it was not: until #205 the API served the very `?api_key=…` and `--token=…` values the audit refuses to log. Both carriers are now blanked at rest by the shared classifier (see [Credential isolation at rest](#credential-isolation-at-rest-srcextensionsmcp-secret-redactionts)), so "audited without the credential" and "readable without the credential" finally describe the same system.

| Action | Written by | `oldValue` → `newValue` |
|---|---|---|
| `ext:mcp:server-installed` | `POST /api/mcp-servers` | `null` → post-install facts |
| `ext:mcp:server-updated` | `PUT /api/mcp-servers/[id]` | pre-edit facts → post-edit facts |
| `ext:mcp:server-refreshed` | `POST /api/mcp-servers/[id]/refresh` | facts w/ old tools → facts w/ new tools |
| `ext:uninstalled` | `DELETE /api/extensions/[id]` | `{version, source, isBundled}` → `null` |

### Namespacing & dispatch (`src/extensions/registry.ts`, `src/extensions/tool-executor/executor.ts`)

- At `loadFromDb()`, every manifest tool is registered as `` `${manifest.name}__${t.name}` `` (double-underscore — Anthropic's tool-name pattern `^[a-zA-Z0-9_-]+$` rejects dots) with `originalName` retained. MCP tools share this namespace with hand-rolled and entity tools, so the LLM and composer treat them identically.
- When the LLM calls one, `tool-executor/executor.ts:executeToolCall` runs the **per-tool-call PDP gate** (`engine.authorize(...)`, fail-closed) first, then branches on `manifest.kind === "mcp"`: it lazily resolves the `McpClient` via `registry.getMcpClient(extensionId)` and calls `client.callTool(originalName, resolvedInput)`. The same `recordToolCall` audit path runs as for subprocess tools.
- That gate is only real because the tool carries a capability declaration. Until 2026-08 MCP tools carried none, so the PDP authorized every call against an EMPTY needed set — `firstMissingCapability([], granted)` is always `null` — and allowed it unconditionally. See "Declared capabilities & the install-time grant" above; an ungranted host now raises `PermissionDeniedError` with an `ext:perm:denied` audit row before the wire client is touched.

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
| `POST /api/mcp-servers` | Install: verify connectivity, cache `tools/list`, persist a `kind:"mcp"` extension. Body: `{ name, description?, server }`. 201 on success; **502** (uniform body) if the target is refused by the guard or won't connect. |
| `PUT /api/mcp-servers/[id]` | Edit-after-install: re-point at a new connection config, re-verify, re-cache tools. `name` immutable; blank header = keep existing secret. 502 leaves stored config untouched. |
| `POST /api/mcp-servers/[id]/refresh` | Re-list tools from the live server and rewrite the cached snapshot + registry maps. Returns `{ id, tools }`; 502 on any failure. |

All three 502s share **one constant body** and never echo the underlying error — see [the uniform failure contract](#the-uniform-failure-contract).

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

- `EZCORP_MCP_TARGET_ALLOW` — comma/whitespace-separated hosts and/or CIDRs the [outbound target guard](#the-escape-hatch--ezcorp_mcp_target_allow) may dial despite being loopback/private. Unset = metadata + every private range denied.
- `EZCORP_MCP_REQUIRE_SANDBOX=1` — fail-closed: refuse any stdio spawn that can't reach full isolation.
- `EZCORP_MCP_STAGE1_TMPFS=0` / `EZCORP_MCP_STAGE1_SECCOMP=0` / `EZCORP_MCP_STAGE1_DNS_RECHECK=0` / `EZCORP_MCP_STAGE2_VETH=0` — operator kill-switches; each emits one `MCP_NETNS_FALLBACK` boot row per process.
- `EZCORP_PROJECT_ROOT` / `EZCORP_DB_PATH` — host-resolved; drive the data-dir exclusion mask (never overridable by a manifest's `spec.env`).

## Key files

- `src/mcp/client.ts` — `McpClient`: SDK wrapper, 3-transport selection, `listTools`/`callTool`/`getChildProcess`, `HookedStdioClientTransport`. `connect()` fail-fasts the guard; `buildTransport()` injects the guarded fetch.
- `src/mcp/guarded-fetch.ts` — `createMcpGuardedFetch`: `redirect: "manual"`, per-hop revalidation, hop cap, cross-origin credential stripping, streaming preserved.
- `src/mcp/target-guard.ts` — `assertMcpTargetAllowed` / `parseMcpTargetAllowlist`: the outbound target policy + `EZCORP_MCP_TARGET_ALLOW` parsing.
- `src/mcp/connect-failure.ts` — `MCP_CONNECT_FAILED_MESSAGE` / `reportMcpConnectFailure`: the uniform 502 body and the server-side diagnosis it replaces.
- `web/src/routes/api/mcp-servers/+server.ts` — `POST` install: throwaway-verify, cache tools, persist, reload registry.
- `web/src/routes/api/mcp-servers/[id]/+server.ts` — `PUT` edit-after-install: re-verify, `mergeMcpServerSecrets` secret-preservation.
- `web/src/routes/api/mcp-servers/[id]/refresh/+server.ts` — `POST` refresh: `registry.refreshMcpTools(id)`.
- `web/src/routes/api/mcp-servers/schema.ts` — Zod discriminated union (`stdio`/`http`/`sse`) + install/update schemas.
- `src/extensions/mcp-sandbox.ts` — `buildSandboxedMcpSpec` (prlimit + namespace + proxy + jail + seccomp + Stage-2 veth) and `runMcpSeccompSoakReader`.
- `src/extensions/mcp-proxy.ts` — `createMcpProxy`: loopback CONNECT proxy with bearer auth, internal-host deny, DNS-rebind recheck, per-host PDP, quotas.
- `src/extensions/registry.ts` — `getMcpClient`, `refreshMcpTools`, `<name>__<tool>` namespacing, proxy/veth/soak lifecycle.
- `src/extensions/tool-executor/executor.ts` — `executeToolCall` MCP branch: per-call PDP gate → `getMcpClient` → `callTool`.
- `src/db/queries/extensions.ts` — `installMcpExtension` / `updateMcpExtension` (build the `kind:"mcp"` manifest, store `cachedTools`, record the install-time grant), `persistMcpSecret` / `rehydrateMcpServerSecrets` (the `extension_secrets` round trip) + `backfillMcpManifestSecrets` / `backfillMcpManifestCapabilities` (one-shot legacy heals).
- `src/extensions/mcp-secret-redaction.ts` — the ONE credential classifier: `redactMcpServer` / `redactExtensionSecrets` (at rest + on every read), `redactUrlSecrets` / `redactMcpArgv` / `isSecretFlagName` (the rules), `buildMcpSecretBlob` / `applyMcpSecretBlob` (the guarded store round trip), `mergeMcpServerSecrets` (the edit form's "blank = keep"). Pure — no DB, no fs, no env.
- `src/extensions/mcp-capabilities.ts` — `mcpNetworkHosts` / `mcpManifestPermissions` / `mcpInstallGrant` / `withMcpToolCapabilities` / `normalizeMcpManifest`: the pure derivation shared by the install path, the registry's read-time normalization and the backfill.
- `src/extensions/mcp-audit.ts` — `describeMcpServerForAudit` (credential-free `McpServerFacts`) + `buildMcpAuditMetadata`; the projection the four lifecycle audit rows share.
- `src/auth/extension-wire-authz.ts` — `canWireExtension` / `partitionWirableExtensions`: the fail-closed gate deciding who may attach an MCP extension to a conversation.
- `src/extensions/types.ts` — `McpServerStdio`/`Http`/`Sse`, `McpServerDefinition`, `ExtensionManifestV2.kind`/`mcpServers`.
- `web/src/routes/(app)/extensions/+page.svelte` — MCP install form, MCP filter tab, refresh action.

## Features it touches

- [[permissions-and-grants]] — every MCP tool call and every outbound proxy CONNECT is gated by the PDP (`engine.authorize`) against the extension's `network` / tool grants.
- [[sandbox-and-isolation]] — stdio MCP servers reuse the same tier-gated jail / namespace / seccomp machinery as subprocess extensions.
- [[runtime-and-rpc]] — MCP tools are dispatched through the same `tool-executor` path and audit pipeline as subprocess and entity tools.
- [[overview-and-authoring]] — MCP servers are `kind:"mcp"` extension rows; they live in the same registry and UI as authored extensions.
- [[audit-and-observability]] — `MCP_HOST_BLOCKED`, `MCP_NETNS_CREATED/FALLBACK`, `MCP_VETH_CREATED`, `MCP_SECCOMP_VIOLATION`, `MCP_CONNTRACK_HIGH`, `MCP_SANDBOX_REQUIRED_REFUSAL` rows land in `/audit`, alongside the four lifecycle rows above.
- [[admin-surfaces]] — install / edit / refresh are all `requireRole(admin)`; the install UI lives on the admin-facing extensions page.
- [[rbac-and-permission-modes]] — the per-tool-call PDP gate runs under the active permission mode before any `callTool`.
- [[api-security]] — MCP management routes are admin-gated; deletion flows through the scope-gated `/api/extensions/[id]` route.
- [[mention-grammar]] — installed MCP tools surface under the `!ext` mention namespace alongside other extension tools. A `![ext:…]` mention the caller may not wire is dropped **silently**, exactly like an unknown target.
- [[rbac-and-permission-modes]] — §5's `extension_rbac_grants` `use` verb is the finer grant that lets a non-admin member wire one named MCP server in one project.

## Related docs

- [Sandbox & isolation](../extensions/sandbox-and-isolation.md) — the namespace / bwrap / Landlock tiers MCP stdio spawns reuse.
- [Permissions & grants](../extensions/permissions-and-grants.md) — the PDP and `network` grant the proxy and tool dispatch enforce.
- [Runtime & RPC](../extensions/runtime-and-rpc.md) — extension tool dispatch and the `<name>__<tool>` namespace.
- [Manifest schema](../../extensions/manifest-schema.md) — `kind` / `mcpServers` manifest fields.
- [Deployment](../../deployment.md) — `EZCORP_MCP_REQUIRE_SANDBOX` and the fail-closed sandbox enforcement section.

## Notes & gotchas

- **`http`/`sse` transports get no sandbox ENVELOPE, but they are no longer trusted targets.** `buildSandboxedMcpSpec` returns them untouched — they are network clients, not spawns, so there is no namespace/proxy/jail; only `stdio` (a local binary) gets the full envelope. The URL itself is **not** trusted, though: it goes through the [outbound target guard](#outbound-target-guard-ssrf) on every connect. (Before that guard existed, an admin-scoped caller could point install/edit/refresh at `http://169.254.169.254/…` or any internal service and the server would dial it.) Once a target IS reached, the per-dispatch PDP gate is the only remaining control, which is why the manifest declares the URL's host as a `network` capability.
- **Two egress directions, two policies — on purpose.** `mcp-proxy.ts` governs an MCP *server's own* outbound traffic (an arbitrary third-party binary), where internal hosts are a **hard deny regardless of grant** because nothing it asks for is trusted. `target-guard.ts` governs the platform reaching *in* to an admin-configured endpoint, where the target is operator intent — hence the env allowlist. Don't "unify" them by giving the proxy an allowlist or the guard a hard deny.
- **The guard and the derivation disagree about private hosts on purpose, and that is not a contradiction.** `mcp-capabilities.ts` derives whatever host the stored definition names — including `127.0.0.1` or a LAN address — because the needed-cap set must never be empty (an empty set is an unconditional PDP allow). The guard is what decides whether that host may be *dialed* at all. So a private target is refused at connect unless `EZCORP_MCP_TARGET_ALLOW` covers it; once allowlisted, install succeeds and the derived grant is what lets dispatch through the PDP. Derivation describes, the guard admits.
- **A hostless stdio server is gated by the sentinel, not by a host.** `npx -y @modelcontextprotocol/server-github` names no host, so it declares (and is granted) no `network` cap and its egress stays proxy-denied. Its *dispatch* is gated by `ezcorp:mcp:invoke` alone. This is the case that made the whole sentinel necessary: an empty declaration flattens to an empty needed set, `firstMissingCapability([], granted)` is always `null`, and the PDP allowed every call from the most common stdio shape no matter what the admin had revoked.
- **External stdio binaries bypass the SDK's process-poisoning.** Unlike first-party subprocess extensions, an external MCP binary (Python/Go/Rust) does not honor the SDK's `node:fs`/`child_process` poisoning. This is precisely why the bwrap/Landlock filesystem jail (masking `.ezcorp/data` — the PGlite DB + JWT secret) is the load-bearing containment, not the SDK preload.
- **Default posture fails OPEN.** Without `EZCORP_MCP_REQUIRE_SANDBOX=1`, a host that can't set up netns/veth (common under Docker even `--privileged`) silently runs the MCP at a weaker stage with only a fallback audit row. Operators who need guaranteed isolation must set the flag.
- **Installing an MCP server is admin-only, and so is WIRING one.** Attaching an extension to a conversation is what makes its tools callable by an LLM turn, and an MCP extension's credential is spent by every such call. Both wiring surfaces (`POST /api/conversations/[id]/extensions` and `![ext:…]` / `![agent:…]` mentions) therefore run `canWireExtension`: admin, the row's `creatorUserId`, or a `use` grant — anything else is refused. A refusal is shaped as a MISS (the route's unknown-name 404; a silent drop in the mention path) so a member cannot enumerate installed MCP servers by probing names. `requireScope(locals,"extensions")` is NOT a second line of defence here: it is a no-op for cookie sessions.
- **A NULL `creatorUserId` matches nobody.** Every MCP row installed before the creator stamp existed has `creator_user_id = NULL`, and those are admin-only. The comparison is against the actor's id (a non-empty string), so a null-equals-null accident cannot open them to everyone.
- **Cached tools can drift.** The tool list is a snapshot taken at install / edit / refresh time and persisted in `manifest.tools`; boot does **not** re-connect. If the upstream server changes its tools, the cached list is stale until an admin hits refresh.
- **DNS-rebind recheck has a documented TOCTOU.** The proxy re-resolves the hostname and rejects internal IPs, but the window between that lookup and `Bun.connect` is a known gap (deferred — would require pinning the connect to the validated IP with SNI plumbing). The `http`/`sse` target guard has the **same** residual, at per-REQUEST granularity: we resolve, then the SDK's socket resolves again, and we cannot IP-pin (it would break TLS SNI for a vendor https endpoint). Re-validating every request *and* every redirect hop is what bounds it; closing it entirely needs a pinned-dispatcher transport.
- **The DNS lookup is deadline-bounded (5s).** `dns.lookup` has no timeout of its own — against a blackholed nameserver a single lookup was measured at ~24s, which is an API handler occupied for half a minute and a visibly stalled chat turn on the first tool dispatch. A timeout is reported as `no-address`, i.e. the same uniform 502.
- **A mistyped allowlist entry is only visible in the log.** A denied target returns the same opaque 502 as an unreachable one, by design — so if an operator's entry is not understood, the *only* signal is the `mcp-target-guard` warning naming the offending value. `192.168.1.50:8080`, `http://192.168.1.50` and a `/`-with-spaces CIDR are all rejected there rather than silently reclassified.
- **At tool-dispatch time the raw block reason DOES reach the chat tool card** (e.g. `MCP target blocked (private-address): 127.0.0.1 → 127.0.0.1`), because that path is not the admin API and has no oracle to protect — the caller already controls the target. The uniform-502 contract applies to install/edit/refresh only.
- **No dedicated GET/DELETE.** Don't look for `GET`/`DELETE /api/mcp-servers/[id]`; only `PUT` + the `refresh` subroute exist. Listing and deletion go through the general `/api/extensions` surface, where `DELETE /api/extensions/[id]` (`requireScope("extensions")` + `requireAuth` + admin) calls `registry.killAll()` then `registry.reload()` — `reload()` is what stops the now-deleted extension's per-MCP proxy/client (any id no longer live).
- **`getChildProcess()` reaches into SDK internals.** The seccomp soak reader and Stage-2 veth teardown depend on the undocumented `transport._process` field. A future `@modelcontextprotocol/sdk` rename makes these degrade-soft to no-ops (audit signal goes quiet; nothing in production breaks).
