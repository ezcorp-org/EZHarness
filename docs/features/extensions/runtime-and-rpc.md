# Extension Runtime & Reverse-RPC

> _How EZCorp runs every extension as a sandboxed JSON-RPC-over-stdio subprocess: the host dispatches `tools/call` into it, the child calls back via ~24 permission-gated `ezcorp/*` reverse-RPC methods, and the registry manages the process lifecycle (idle-kill, crash auto-disable, fs-violation disable)._

## Intent

Extensions are untrusted code. EZCorp never loads them in-process; each extension runs as its own Bun subprocess speaking JSON-RPC over stdin/stdout, spawned under a sandbox preload (and, where the kernel supports it, an OS-level jail). The host pushes LLM tool calls **down** into the child as `tools/call`, and the child reaches **back up** for every host capability it needs (filesystem, storage, memory, LLM completion, spawning sub-agents, …) via a fixed set of `ezcorp/*` reverse-RPC methods — each one routed through the permission engine (PDP) before it touches host state. This split is what lets EZCorp give an extension real power (read files, call models, spawn agents) without ever trusting its process with the DB, secrets, or another user's data.

## How it works

### The two directions of RPC

1. **Forward (host → child): `tools/call`.** `ToolExecutor.executeToolCall` (`src/extensions/tool-executor.ts`) is the single entry point for every extension tool. It looks the namespaced tool name up in the registry, enforces the per-turn cap, runs the PDP gate, then calls `ExtensionProcess.callTool(originalName, args, meta)` (`src/extensions/subprocess.ts`), which frames a `tools/call` JSON-RPC request and awaits the child's response (default 30s per-call timeout).
2. **Reverse (child → host): `ezcorp/*`.** The subprocess emits JSON-RPC *requests* back up the same stdio channel. `ToolExecutor.ensureSubprocessRpcWired` installs the `setRequestHandler` that routes those by exact method string to a handler (`handlePiFsRead`, `handlePiStorage`, `handlePiInvoke`, …). The wired handler is wrapped in `dispatchReverseRpcWithTimeout` so a stalled host op fails fast instead of wedging the chat.

### Forward dispatch — `executeToolCall`

In order, for every call:

- **Per-turn cap.** A process-singleton `toolCallsThisTurn` Map counts calls per conversation; the `MAX_TOOL_CALLS_PER_TURN`'th+1 call throws `MaxToolCallsExceededError`. Default 100, overridable via `EZCORP_MAX_TOOL_CALLS_PER_TURN`. The counter increments **before** the PDP gate (a denied call still counts) and is reset on `run:complete` / `run:cancel` / `run:error` by a bus listener wired in the constructor.
- **Arg resolution.** `argsResolver` substitutes symbolic handles (e.g. `ez-attachment://<id>`) **before** the PDP sees the args, so a pre-resolver scheme can't launder into `file://`.
- **Capability set.** The tool's required `Capability[]` is computed from its (v3-migrated) manifest declaration. The bundled `extension-author` tools `install_draft` / `modify_extension` get a sensitive `ezcorp:extension:install` / `:modify` cap injected so they **always** prompt.
- **PDP gate.** `engine.authorize(...)` returns `allow` / `deny` / `prompt`. `deny` throws `PermissionDeniedError`; `prompt` emits `tool:permission_request`, registers a pending-permission entry (so the watchdog doesn't kill the run as "hung"), awaits the user's in-chat Allow/Deny via `createExtensionPermissionGate`, and persists the chosen always-allow scope through `engine.resolvePrompt`. Engine throws are converted to `PermissionDeniedError` (fail-closed).
- **Dispatch.** Three branches:
  - **Entity (SDK-served):** tools tagged `entityKind`+`entityType` route to the SDK's auto-generated CRUD handler (`buildEntityToolHandlers` + `createHostEntityStore`) — no subprocess at all.
  - **MCP:** `registry.getMcpClient(extensionId).callTool(...)`.
  - **Subprocess (default):** `registry.getProcess` → `ensureSubprocessRpcWired` → `proc.callTool`. The host threads server-only context into the JSON-RPC `_meta` side-channel — `ezOnBehalfOf`, `ezConversationId`, `ezModel`, `ezProvider`, `ezPublicUrl`, resolved per-extension `settings`, and a per-call **`ezCallId`** provenance token. The token is the only identity the child can echo back on reverse-RPC; the host resolves real `{onBehalfOf, conversationId, runId}` from it via `registerCallProvenance` / `resolveCallProvenance`, never from mutable singletons.
- **Audit + bus.** Every call (success or error) is persisted via `persistToolCall` and emits `tool:start` → `tool:complete`/`tool:error` on the bus.

### Reverse-RPC method table (`route()` in `ensureSubprocessRpcWired`)

24 exact-match `ezcorp/*` methods, each gated independently (a missing registry grant → `-32603`):

| Method(s) | Handler | Gate / notes |
|---|---|---|
| `ezcorp/invoke` | `handlePiInvoke` | Cross-extension call. Per-CHAIN depth cap `MAX_CALL_DEPTH=10` + per-CONVERSATION cap `MAX_CALL_DEPTH_PER_CONVERSATION=50`. Caller∩callee cap **intersection by default** (confused-deputy defense); opt out only via callee grant's `acceptsCallerCaps: true`. `runtime.<area>.<verb>` methods route to `handleRuntimeInvoke` first. **Timeout-exempt.** |
| `ezcorp/fs.{read,write,list,stat,exists,mkdir,unlink}` | `handlePiFs*` → `fs-handler.ts` | Host-mediated fs; provenance from `ezCallId`. Path allowlist = extension grant + install path (`checkFilesystemPermission`). |
| `ezcorp/fs` (legacy shim) | `handlePiFs` | Deprecated path-check shim; one-time `console.warn` per extension; removed in v2. |
| `ezcorp/storage` | `handlePiStorage` → `storage-handler.ts` | Conversation/user-scoped KV. |
| `ezcorp/memory` | `handlePiMemory` → `memory-handler.ts` | `ctx.memory.*`. |
| `ezcorp/lessons` | `handlePiLessons` → `lessons-handler.ts` | `ctx.lessons.*`. |
| `ezcorp/search` | `handlePiSearch` → `search-handler.ts` | `ctx.search.{web,read}`; provider chain + SSRF guard host-side. |
| `ezcorp/llm-complete` | `handlePiLlmComplete` → `llm-handler.ts` | `ctx.llm.complete()`; the token never crosses the boundary. **Timeout-exempt.** |
| `ezcorp/schedule` | `handlePiSchedule` → `schedule-handler.ts` | `ctx.schedule.fire-now` (rest is manifest cron). |
| `ezcorp/agent-configs` | `handlePiAgentConfigs` | Read-only access to the user's agent configs. |
| `ezcorp/spawn-assignment` | `handlePiSpawnAssignment` | Spawn a sub-agent conversation; needs executor+bus+quota wired (else fail-closed). |
| `ezcorp/cancel-run` | `handlePiCancelRun` | Cancel a previously-spawned sub-run. |
| `ezcorp/emit-task-event` | `handlePiEmitTaskEvent` | Emitted `conversationId` is **forced** to the host's value (forged params ignored). |
| `ezcorp/append-message` | `handlePiAppendMessage` | Inserts an `extension`-role, `excluded:true` turn; emits `run:turn_saved`. |
| `ezcorp/finalize-tool-call` | `handlePiFinalizeToolCall` | Flips a `running` tool-call row to terminal. |
| `ezcorp/network.internal` | `handlePiNetworkInternal` → `network-handler.ts` | Loopback / RFC-1918 fetch SSRF-gated host-side (10MB cap). |
| `ezcorp/drafts` | `handlePiDrafts` → `drafts-handler.ts` | Bundled-only (`BUNDLED_DRAFTS_ALLOWLIST` by manifest **name**); `verify`/`install` actions are timeout-exempt. |
| `ezcorp/rbac-check` | `handlePiRbacCheck` | `ctx.rbac.check(scope)` — asks the host whether the acting user holds a per-project/per-extension RBAC scope. Extension identity is the **registry**-resolved name (wire params naming another extension are ignored); user + project come from `ezCallId` provenance + the conversation. Core verbs are always checkable; a custom scope must be declared in `permissions.rbacScopes` else `-32602`. No grant / no admin → `{granted:false}` (not an error). See [[rbac-and-permission-modes]]. |

Anything else → `-32601 Method not found`.

### Reverse-RPC handler timeout

`dispatchReverseRpcWithTimeout` races each handler against `HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS` (default 20s, env `EZCORP_HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS`). On timeout it replies `-32603` so the child's `request()` **rejects fast** rather than hanging until the 90s executor watchdog (the "stuck chat" defect). `ezcorp/invoke` + `ezcorp/llm-complete` (and `ezcorp/drafts` `verify`/`install`) are exempt — they legitimately run long and are bounded by their own caps.

### Subprocess lifecycle (`ExtensionProcess`)

- **Spawn.** `getSpawnArgs()` → `prlimit --rss=<mem> bun run --preload <sandbox-preload.ts> <entrypoint>`, optionally wrapped by an OS isolation prefix (`buildSandboxArgv`, landlock/bwrap tier). Env is an **explicit allowlist** (`buildAllowedEnv` in `registry.ts`, merged with the sandbox permission flags by `ExtensionProcess.buildSpawnEnv` in `subprocess.ts`), never `process.env` — only PATH/HOME/NODE_ENV/TMPDIR plus manifest-declared-AND-granted env. `EZCORP_NETWORK_ALLOWED` / `EZCORP_SHELL_ALLOWED` are consumed by the preload (the no-network / no-shell deniers leave the modules intact when set). `EZCORP_FS_ALLOWED` is **informational only** — the preload's FS deniers fire regardless of it; it is read by the SDK's `@ezcorp/sdk/runtime` fs helpers to fast-fail before round-tripping to `ezcorp/fs.*`.
- **Idle timeout.** Non-persistent processes self-kill after `DEFAULT_IDLE_TIMEOUT_MS` (5 min) of no calls; every `call()` resets the timer. `persistent: true` (manifest) disables the idle timer entirely.
- **Per-call timeout.** `DEFAULT_CALL_TIMEOUT_MS` (30s), overridable per-manifest via `resources.callTimeoutMs`. On timeout the process is **killed**. `requiresUserInput` tools pass `skipTimeout` (human-in-the-loop waits are bounded by the user, not the clock).
- **Crash detection.** On unexpected exit (not a deliberate `kill()`), `incrementFailures`; at `AUTO_DISABLE_THRESHOLD` (3) consecutive crashes the extension is `disableExtension`'d. A successful call resets the counter. A bounded stderr tail (16KB) is logged so `--preload` / module-load failures are diagnosable instead of a silent watchdog hang.
- **FS violation.** The legacy `ezcorp/fs` shim (and `checkFilesystemPermission` denials) call `denyAndDisable` → the extension is disabled **immediately**, not after 3 strikes.
- **Re-wiring.** `wiredProcs` is a `WeakSet` keyed by the `ExtensionProcess` **instance** (not extensionId): the registry hands back a fresh process object after any idle-kill/crash/respawn, and the new instance must get its own `setRequestHandler` or its reverse-RPC silently drops (the stuck-chat root cause).

### Boot & auto-wire

`web/src/lib/server/context.ts` is the production boot site, in order:

1. `ensureBundledExtensions()` installs/refreshes the 24 `BUNDLED_EXTENSIONS` (`src/extensions/bundled.ts`) — clamping each to the bundled ceiling, running S6 drift detection, the S9 version-bump re-approval gate, and grant self-heal.
2. `registry.loadFromDb()` rebuilds the in-memory tool/manifest/grant maps and dep routes.
3. `LifecycleHookDispatcher` (`lifecycle-dispatcher.ts`) and `EventSubscriptionDispatcher` (`event-subscription-dispatcher.ts`) are constructed, every extension's hooks/subscriptions registered, then `.start()` wires the bus listeners.
4. `bootSpawnFlaggedBundledExtensions` spawns the event-ONLY bundled extensions (`bootSpawn: true` — `lessons-distiller`, `memory-extractor`) and pre-wires their reverse-RPC via a boot-only `eventDriven: true` `ToolExecutor`. Without this, `EventSubscriptionDispatcher.dispatch` would silently drop their `run:complete` events (`getProcessIfRunning` never starts a sleeping process).

`autoWireBundledExtensions` (`auto-wire-bundled.ts`) inserts a `conversation_extensions` row for `AUTO_WIRE_BUNDLED_EXTENSION_NAMES` (`lessons-distiller`, `memory-extractor`) at conversation-create time, since event delivery is **always** gated on that wiring.

## Usage

Extensions never call these methods directly — they go through the `@ezcorp/sdk/runtime` helpers, which frame the `ezcorp/*` reverse-RPC under the hood (`ctx.fs.read`, `ctx.storage`, `ctx.llm.complete`, `ctx.memory`, `ctx.search`, `ctx.schedule`, …). The forward side is invoked when the LLM (or a code-agent via `ctx.tools.invoke`) calls a namespaced extension tool (`<ext-name>__<tool>`).

Operator / developer knobs:

- `EZCORP_MAX_TOOL_CALLS_PER_TURN` — per-conversation per-turn tool-call cap (default 100).
- `EZCORP_HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS` — bounded reverse-RPC handler timeout (default 20000).
- `EZCORP_NETWORK_ALLOWED` / `EZCORP_SHELL_ALLOWED` — preload permission flags (set by the host from grants, **not** by operators); they unblock the network / shell module deniers. `EZCORP_FS_ALLOWED` is also host-set from grants but is **informational only** (read by the SDK fs helpers, not the preload — see Spawn above).
- `EZCORP_PERMITTED_HOSTS`, `EZCORP_TOOL_NETWORK_CAPS`, `EZCORP_PROJECT_ROOT`, `EZCORP_EXTENSION_DATA_ROOT` — env injected into the subprocess by `buildAllowedEnv`.
- `EZCORP_DISABLE_AI_KIT` — per-bundled opt-out (`DISABLE_FLAGS`).
- `EZCORP_DISABLE_CAPABILITY_TOOLS` — kill-switch that prevents `EventSubscriptionDispatcher.start()` from wiring any delivery.
- Manifest `resources.{memory, callTimeoutMs}`, `persistent`, `bootSpawn` tune a single extension's process.

## Key files

- `src/extensions/tool-executor.ts` — `ToolExecutor`: forward `executeToolCall` (caps, PDP gate, dispatch, audit) + the `ensureSubprocessRpcWired` reverse-RPC router and all `handlePi*` handlers + `resolveReverseRpcMeta` (provenance).
- `src/extensions/subprocess.ts` — `ExtensionProcess`: spawn args, sandbox-preload resolution, JSON-RPC transport, idle/call timeouts, crash→auto-disable, `setRequestHandler` re-wiring.
- `src/extensions/registry.ts` — `ExtensionRegistry` singleton: tool/manifest/grant maps, `getProcess` (lazy spawn + integrity check), `buildAllowedEnv`, dep-route resolution, MCP client + per-MCP proxy lifecycle.
- `src/extensions/bundled.ts` — `BUNDLED_EXTENSIONS` (24 entries), `ensureBundledExtensions` (install/refresh/ceiling-clamp/drift/S9 gate), `getProjectRoot`, `bootSpawnFlaggedBundledExtensions`.
- `src/extensions/auto-wire-bundled.ts` — `autoWireBundledExtensions` — per-conversation wiring rows for event-only bundled extensions.
- `src/extensions/lifecycle-dispatcher.ts` — `LifecycleHookDispatcher`: the 4 `ALLOWED_LIFECYCLE_HOOKS`, sanitized fire-and-forget notifications.
- `src/extensions/event-subscription-dispatcher.ts` — `EventSubscriptionDispatcher`: direct-carrier bus events → wired subscribers, rate-limited, provenance-stamped, kill-switch-gated.
- `src/extensions/call-provenance.ts` — `registerCallProvenance` / `resolveCallProvenance` / `registerFireCallProvenance` — the `ezCallId` token store.
- `src/extensions/fs-handler.ts`, `storage-handler.ts`, `network-handler.ts`, `drafts-handler.ts`, `llm-handler.ts`, `memory-handler.ts`, `lessons-handler.ts`, `search-handler.ts`, `schedule-handler.ts`, `agent-configs-handler.ts`, `task-events-handler.ts` (`ezcorp/emit-task-event`), `spawn-assignment-handler.ts`, `cancel-run-handler.ts`, `append-message-handler.ts`, `finalize-tool-call-handler.ts`, `runtime-invoke-handler.ts` — the per-method reverse-RPC handler implementations.
- `web/src/lib/server/context.ts` — production boot: `ensureBundledExtensions` → `loadFromDb` → dispatchers → `bootSpawnFlaggedBundledExtensions`.
- `src/runtime/sse-conversation-filter.ts` — `DIRECT_CARRIER_EVENT_TYPES` (the only events the subscription dispatcher can deliver).

## Features it touches

- [[sandbox-and-isolation]] — the subprocess is spawned under `sandbox-preload.ts` + an optional landlock/bwrap jail; `buildSandboxArgv` builds the wrap.
- [[permissions-and-grants]] — every forward call and reverse-RPC method is gated by the PDP (`engine.authorize`) against the extension's grant.
- [[rbac-and-permission-modes]] — sensitive caps (`shell`, `fs.write`) trigger the in-chat permission `prompt` gate and always-allow scoping.
- [[builtin-file-tools]] — `ezcorp/fs.*` mirrors the built-in file tools but is keyed on the extension's declared grant + install path; note the lexical-vs-realpath asymmetry (gotchas).
- [[overview-and-authoring]] — extension authors write against the `@ezcorp/sdk/runtime` surface that these methods back.
- [[bundled-catalog]] — `BUNDLED_EXTENSIONS` + `ensureBundledExtensions` is the boot-time install of first-party extensions.
- [[marketplace]] — user-installed extensions get the full integrity check (bundled extensions skip it).
- [[mcp-servers]] — MCP-kind extensions dispatch through `registry.getMcpClient` instead of the subprocess, but share the same `executeToolCall` gate.
- [[scheduling-and-loops]] — `ezcorp/schedule` (`fire-now`) and manifest crons fire extension subprocesses via the schedule daemon.
- [[persistent-memory]] — `ezcorp/memory` + the bundled `memory-extractor` run-complete consumer.
- [[lessons]] — `ezcorp/lessons` + the bundled `lessons-distiller`.
- [[web-search]] — `ezcorp/search` forwards to the host `ctx.search` provider chain.
- [[agents]] — `ezcorp/spawn-assignment` / `ezcorp/cancel-run` spawn and cancel sub-agent conversations.
- [[teams]] — multi-agent orchestration uses the spawn-assignment reverse-RPC.
- [[streaming-runtime]] — forward calls emit `tool:start`/`tool:complete`/`tool:error` onto the SSE stream; the watchdog bounds hung calls.
- [[ask-user]] — `requiresUserInput` tools take the `skipTimeout` path; the bundled `ask-user` extension is the human-in-the-loop primitive.
- [[message-toolbar]] — `kokoro-tts` uses `ezcorp/append-message` from a `messageToolbar` event.
- [[hub-pages]] — bundled extensions like `file-organizer` / `ez-code` render Hub pages from the subprocess.
- [[canvas-cards]] — extension-declared events (`<ext>:<event>`) round-trip through `EventSubscriptionDispatcher`.
- [[audit-and-observability]] — `persistToolCall`, PDP audit rows, and sampled `ext:sdk-event-delivered` rows.

## Related docs

- [Extensions overview / README](../../extensions/README.md)
- [Authoring guide](../../extensions/AUTHORING.md)
- [API reference](../../extensions/api-reference.md) — the `@ezcorp/sdk/runtime` surface that fronts these reverse-RPC methods.
- [Security model](../../extensions/security.md)
- [Data storage convention](../../extensions/data-storage.md) — `.ezcorp/extension-data/<name>/`.
- [Loops](../../extensions/loops.md), [Pages](../../extensions/pages.md), [Settings](../../extensions/settings.md), [Message toolbar](../../extensions/message-toolbar.md), [Canvas cards](../../extensions/canvas-cards.md).

## Notes & gotchas

- **Provenance is token-based, not singleton-based.** Reverse-RPC handlers that need the acting user/conversation (`fs.*`, `drafts`, `llm-complete`, `memory`, `lessons`, `search`, `schedule`, `append-message`) resolve them from the host-issued `ezCallId` via `resolveReverseRpcMeta` — correct under concurrency and for background fires. An unresolved token → `-32602` (fail fast); an ownerless background fire → `-32106` (clean soft-fail). A handful of older handlers (`storage`, `agent-configs`, `emit-task-event`, `spawn-assignment`, `cancel-run`, `finalize-tool-call`) still read `this.currentConversationId` / `this.currentUserId` singletons.
- **The actor-extension tripwire is NOT enforced.** If the resolved token's `actorExtensionId` ≠ the resolving extension, the host logs a warning and **proceeds** — it does not hard-reject, to avoid breaking legitimate `ezcorp/invoke` chains. Defense-in-depth, not a gate.
- **`isBundled` trust comes from the DB row, not the manifest name.** The integrity-check skip and the `extension-author` install-prompt scoping read `registry.isBundled(extensionId)` (the `is_bundled` column), so an attacker-installed extension named `ai-kit` can't inherit bundled trust.
- **"Examples on disk" ≠ "bundled at boot."** `docs/extensions/examples/` has ~39 directories (incl. `test-*` fixtures and example-only extensions); only the 24 entries in `BUNDLED_EXTENSIONS` are installed at boot. `ai-kit` lives under `packages/@ezcorp/`; `lessons-distiller` / `memory-extractor` under `extensions/`.
- **fs path-containment asymmetry.** The built-in file-tool path (`src/runtime/tools/validate.ts` `validatePath`) is **lexical** (no realpath), while the FS scanner / `@`-autocomplete (`src/runtime/fs/scan-fs.ts` `realpathInsideRoot`) resolves symlinks. The extension `ezcorp/fs.*` path uses `checkFilesystemPermission` against the declared grant + install path. Keep the distinction in mind when reasoning about symlink-escape.
- **Re-wire on every fresh process.** `wiredProcs` MUST stay keyed by the `ExtensionProcess` instance. An extensionId-keyed Set would early-return on a respawned child and leave its `transport.onRequest` null — every reverse-RPC silently dropped, `tools/call` hangs until the 90s watchdog.
- **Event delivery is double-gated.** A bus event only reaches an extension if (a) its type is in `DIRECT_CARRIER_EVENT_TYPES`, (b) the extension is wired into the event's `conversationId` via `conversation_extensions`, (c) it's under its 50 ops/sec budget, AND (d) its subprocess is already running. No admin bypass, no queueing — drops are silent (rate-limit drops are audited, throttled).
- **Event-only extensions need `bootSpawn`.** Because `getProcessIfRunning` never starts a sleeping process, an event-only bundled extension with no `bootSpawn` flag silently drops every event it subscribes to.
- **`callTimeoutMs` ≠ the watchdog.** The per-call 30s subprocess timeout kills the child; the 90s executor watchdog kills the whole run. The 20s reverse-RPC handler timeout sits below both so a stalled host op surfaces as a normal `tool:error` card. Don't add methods to the timeout-exempt set without re-checking this layering.
- **`DEFAULT_PERMISSION_MODE = "yolo"`** (`src/runtime/tools/permissions.ts`) is an intentional, permanent product decision — not a finding. Extension tool calls still pass through the PDP regardless of permission mode.
- **Memory floor.** `MIN_MEMORY_LIMIT_MB` (512) is the hard minimum; a manifest requesting less is raised to it.
