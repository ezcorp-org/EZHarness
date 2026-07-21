import type { JsonRpcRequest, JsonRpcResponse } from "../types";
import type { ExtensionRegistry } from "../registry";
import type { PermissionEngine } from "../permission-engine";
import type { EventBus } from "../../runtime/events";
import type { AgentEvents } from "../../types";
import type { AgentExecutor } from "../../runtime/executor";
import type { ScheduleDaemon } from "../schedule-daemon";
import type { SpawnQuota } from "../spawn-quota";
import type { FsRpcResponse } from "../fs-handler";
import { handleStorageRpc, type StorageContext } from "../storage-handler";
import { handleAgentConfigsRpc, type AgentConfigsContext } from "../agent-configs-handler";
import { handleEmitTaskEventRpc, type TaskEventsContext } from "../task-events-handler";
import { handleEmitLoopEventRpc, type LoopEventsContext } from "../loop-events-handler";
import {
  handleSpawnAssignmentRpc,
  handleQueueAgentMessageRpc,
  type SpawnAssignmentContext,
  type QueueAgentMessageContext,
} from "../spawn-assignment-handler";
import { handleCancelRunRpc, type CancelRunContext } from "../cancel-run-handler";
import { handleAppendMessageRpc, type AppendMessageContext } from "../append-message-handler";
import { handleFinalizeToolCallRpc, type FinalizeToolCallContext } from "../finalize-tool-call-handler";
import { handlePiLlmComplete as handleLlmCompleteRpc } from "../llm-handler";
import { handlePiMemory as handleMemoryRpc } from "../memory-handler";
import { handlePiLessons as handleLessonsRpc } from "../lessons-handler";
import { handlePiSearch as handleSearchRpc } from "../search-handler";
import { handlePiSchedule as handleScheduleRpc } from "../schedule-handler";
import { handleDraftsRpc, type DraftsContext } from "../drafts-handler";
import {
  handleGithubProjectsRpc,
  type GithubProjectsContext,
} from "../github-projects-handler";
import { GITHUB_PROJECTS_RPC_PREFIX } from "../../integrations/github-projects/types";
import { handleNetworkInternalRpc, type NetworkInternalContext } from "../network-handler";
import { rpcError } from "../json-rpc";
import { CORE_RBAC_SCOPES } from "../rbac-scopes";
import { getConversation, getConversationSpawnDepth } from "../../db/queries/conversations";
import { logger } from "../../logger";
import {
  resolveReverseRpcMeta,
  resolveHandlerScope,
  resolveStorageProvenance,
} from "./provenance";

const log = logger.child("ext.tool-executor");

type GrantedPermissions = NonNullable<ReturnType<ExtensionRegistry["getGrantedPermissions"]>>;
type Manifest = NonNullable<ReturnType<ExtensionRegistry["getManifest"]>>;

/**
 * The `ToolExecutor` state the thin reverse-RPC delegates read. Each
 * delegate method builds this from its private fields and passes it in,
 * so the handler bodies stay free functions (independently unit-testable)
 * while the class keeps its public method surface.
 */
export interface RpcHandlerDeps {
  registry: ExtensionRegistry;
  engine: PermissionEngine;
  bus?: EventBus<AgentEvents>;
  executor?: AgentExecutor;
  spawnQuota?: SpawnQuota;
  scheduleDaemon?: ScheduleDaemon;
  currentModel?: string;
  currentProvider?: string;
  currentUserId?: string;
  currentConversationId?: string;
  /** The single decision core for the extension-RBAC axis; lives on the
   *  ToolExecutor core (shared with the pre-dispatch enforcement gate). */
  resolveExtensionScopeGrant: (
    extensionName: string,
    scope: string,
    onBehalfOf: string | null,
    conversationId: string | null,
  ) => Promise<boolean>;
}

// ── Shared preamble helpers (DRY) ──────────────────────────────────────
// Every thin handler starts by resolving the extension's granted
// permissions (and often its manifest), returning a -32603 "not found"
// response when the registry doesn't know the extension. These collapse
// that repeated boilerplate.

function requireGranted(
  registry: ExtensionRegistry,
  extensionId: string,
  req: JsonRpcRequest,
):
  | { ok: true; granted: GrantedPermissions }
  | { ok: false; errorResponse: JsonRpcResponse } {
  const granted = registry.getGrantedPermissions(extensionId);
  if (!granted) {
    return {
      ok: false,
      errorResponse: {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "Extension not found in registry" },
      },
    };
  }
  return { ok: true, granted };
}

function requireGrantedAndManifest(
  registry: ExtensionRegistry,
  extensionId: string,
  req: JsonRpcRequest,
):
  | { ok: true; granted: GrantedPermissions; manifest: Manifest }
  | { ok: false; errorResponse: JsonRpcResponse } {
  const granted = registry.getGrantedPermissions(extensionId);
  const manifest = registry.getManifest(extensionId);
  if (!granted || !manifest) {
    return {
      ok: false,
      errorResponse: {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "Extension not found in registry" },
      },
    };
  }
  return { ok: true, granted, manifest };
}

/**
 * Handle a ezcorp/storage reverse RPC request from a subprocess.
 * Delegates to the storage handler with proper context isolation.
 */
export async function handlePiStorage(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGrantedAndManifest(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;

  // Bug B: source the acting user + conversation from the per-call
  // provenance snapshot (the `_meta.ezCallId` the subprocess echoed back),
  // NOT the racy process-wide `currentUserId`/`currentConversationId`
  // singletons — parity with `handlePiFs`. The singletons observe the
  // wrong scope under concurrency (a slow call sees a later turn's user)
  // and are unset for background fires. An unresolved token fail-fasts
  // (`-32602`); an ownerless fire is allowed through with a null user so
  // the install-wide `global` scope stays reachable from cron fires (see
  // `resolveStorageProvenance`).
  const resolved = resolveStorageProvenance(extensionId, req);
  if (!resolved.ok) return resolved.errorResponse;

  const ctx: StorageContext = {
    conversationId: resolved.conversationId ?? "unknown",
    userId: resolved.onBehalfOf ?? "unknown",
    manifest: base.manifest,
    grantedPermissions: base.granted,
    // Phase 6: thread the PDP so the handler delegates the
    // permission decision to `engine.authorize` (audit log + scope
    // semantics applied uniformly).
    engine: deps.engine,
  };

  return handleStorageRpc(extensionId, req, ctx);
}

/**
 * Handle a `ezcorp/agent-configs` reverse RPC request. Read-only access
 * to the calling user's agent configs, gated on the `agentConfig: "read"`
 * permission. See agent-configs-handler.ts for the full contract.
 */
export async function handlePiAgentConfigs(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGranted(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  // Per-call provenance: token wins, singletons are the fallback.
  const scope = resolveHandlerScope(req, deps.currentUserId, deps.currentConversationId);
  const ctx: AgentConfigsContext = {
    userId: scope.userId,
    grantedPermissions: base.granted,
    // Phase 6: thread the PDP. The engine reuses the same audit-log
    // + always-allow infrastructure as every other dispatch.
    engine: deps.engine,
    conversationId: scope.conversationId,
  };
  return handleAgentConfigsRpc(extensionId, req, ctx);
}

/**
 * Handle a `ezcorp/emit-task-event` reverse RPC request. Gated on the
 * `taskEvents: true` permission + conversation-wiring. The emitted
 * event's `conversationId` is ALWAYS the host's
 * `currentConversationId` — any forged value in params is ignored.
 * See task-events-handler.ts for the full contract.
 */
export async function handlePiEmitTaskEvent(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGranted(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  // Per-call provenance: token wins, singletons are the fallback.
  const scope = resolveHandlerScope(req, deps.currentUserId, deps.currentConversationId);
  const ctx: TaskEventsContext = {
    conversationId: scope.conversationId,
    userId: scope.userId,
    grantedPermissions: base.granted,
    bus: deps.bus,
    // Phase 6: thread the PDP for the canonical permission decision.
    engine: deps.engine,
  };
  return handleEmitTaskEventRpc(extensionId, req, ctx);
}

/**
 * Handle an `ezcorp/emit-loop-event` reverse RPC request (Loops EZ Mode
 * Phase 2). Emits the three content-free approval nudges onto the host bus.
 * Gated on the `loopEvents` permission (PDP cap `ezcorp:loops:emit`) + the
 * capability-tier kill-switch + rate limit; the emitted event's `loopId` is
 * STAMPED host-side with the extension id so an extension can only emit for
 * its own loops. Unlike emit-task-event this does NOT require a conversation
 * — loops fire ownerless (cron) / global-scope. See loop-events-handler.ts.
 */
export async function handlePiEmitLoopEvent(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGranted(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  // Per-call provenance: token wins, singletons are the fallback.
  const scope = resolveHandlerScope(req, deps.currentUserId, deps.currentConversationId);
  const ctx: LoopEventsContext = {
    bus: deps.bus,
    userId: scope.userId,
    grantedPermissions: base.granted,
    // Phase 6: thread the PDP for the canonical permission decision.
    engine: deps.engine,
    conversationId: scope.conversationId,
  };
  return handleEmitLoopEventRpc(extensionId, req, ctx);
}

/**
 * Handle a `ezcorp/spawn-assignment` reverse RPC request (Phase 2d).
 * Dispatches a caller-chosen agent config against a caller-supplied
 * task body in a new sub-conversation parented on the current one.
 * Gated on the `spawnAgents` permission + conversation-wiring + quota.
 * See spawn-assignment-handler.ts for the full enforcement ladder.
 */
export async function handlePiSpawnAssignment(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGranted(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  // Spawn requires the full runtime wiring — executor + bus + quota.
  // Executor-less test contexts or processes that skipped the
  // AgentExecutor boot (e.g. tool-only unit tests) fail closed here
  // rather than later in the handler's dispatch phase.
  if (!deps.executor || !deps.bus || !deps.spawnQuota) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32603, message: "Spawn path unavailable in this context" },
    };
  }

  // Per-call provenance: token wins, singletons are the fallback.
  const scope = resolveHandlerScope(req, deps.currentUserId, deps.currentConversationId);

  // Resolve parent conversation metadata for scope + depth gates.
  const convId = scope.conversationId;
  let projectId: string | null = null;
  let spawnDepth = 0;
  if (convId && convId !== "unknown") {
    const conv = await getConversation(convId);
    projectId = conv?.projectId ?? null;
    spawnDepth = await getConversationSpawnDepth(convId);
  }

  const ctx: SpawnAssignmentContext = {
    conversationId: convId,
    userId: scope.userId,
    projectId,
    grantedPermissions: base.granted,
    executor: deps.executor,
    bus: deps.bus,
    quota: deps.spawnQuota,
    spawnDepth,
    // Phase 4: thread the registry so the handler can compute child
    // effective grants from each shared extension's installed grants
    // + manifest, and persist them on conversation_extensions.
    registry: deps.registry,
    // Phase 6: thread the PDP for the canonical permission decision.
    engine: deps.engine,
    ...(deps.currentModel !== undefined ? { parentModel: deps.currentModel } : {}),
    ...(deps.currentProvider !== undefined ? { parentProvider: deps.currentProvider } : {}),
  };
  return handleSpawnAssignmentRpc(extensionId, req, ctx);
}

/**
 * Handle a `ezcorp/cancel-run` reverse RPC request (Phase 4 §5.3).
 * Cancels a sub-run the calling extension previously originated via
 * `ezcorp/spawn-assignment`. Reuses the `spawnAgents` permission gate
 * and the spawn-quota's per-extension reservation set for ownership.
 * See cancel-run-handler.ts for the full enforcement ladder.
 */
export async function handlePiCancelRun(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGranted(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  if (!deps.executor || !deps.spawnQuota) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32603, message: "Cancel path unavailable in this context" },
    };
  }
  // Per-call provenance: token wins, singletons are the fallback.
  const scope = resolveHandlerScope(req, deps.currentUserId, deps.currentConversationId);
  const ctx: CancelRunContext = {
    userId: scope.userId,
    grantedPermissions: base.granted,
    executor: deps.executor,
    quota: deps.spawnQuota,
    // Phase 6: thread the PDP for the canonical permission decision.
    engine: deps.engine,
    conversationId: scope.conversationId,
  };
  return handleCancelRunRpc(extensionId, req, ctx);
}

/**
 * Handle a `ezcorp/queue-agent-message` reverse RPC request (Phase B3).
 * Enqueues a steering message onto a running child's sub-conversation for
 * the orchestration extension's `send_to_agent`. Reuses the `spawnAgents`
 * permission gate and fails closed unless the target sub-conversation is a
 * child of the caller's conversation. See spawn-assignment-handler.ts.
 */
export async function handlePiQueueAgentMessage(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGranted(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  // Per-call provenance: token wins, singletons are the fallback.
  const scope = resolveHandlerScope(req, deps.currentUserId, deps.currentConversationId);
  const ctx: QueueAgentMessageContext = {
    conversationId: scope.conversationId,
    userId: scope.userId,
    grantedPermissions: base.granted,
    // Phase 6: thread the PDP for the canonical permission decision.
    engine: deps.engine,
    // Liveness gate — a steer only lands if the child has a live run to drain
    // it; otherwise the handler reports `not-running` and the ext continues on
    // a fresh run instead. Undefined in executor-less contexts (gate skipped).
    ...(deps.executor ? { executor: deps.executor } : {}),
  };
  return handleQueueAgentMessageRpc(extensionId, req, ctx);
}

/**
 * Handle a `ezcorp/network.internal` reverse RPC request (Phase 2).
 *
 * The in-sandbox fetch wrapper (sandbox-preload.ts) forwards every
 * fetch to a localhost / RFC-1918 / link-local hostname here so the
 * host PDP can SSRF-gate per-host. Manifests must declare the
 * specific internal host (e.g. `localhost`) — the engine's existing
 * `network` capability check enforces that.
 *
 * The handler performs the fetch host-side and returns a JSON-shaped
 * Response (status, headers, base64 body) capped at 10MB. See
 * network-handler.ts for the full contract.
 */
export async function handlePiNetworkInternal(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGranted(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  // Per-call provenance: token wins, singletons are the fallback.
  const scope = resolveHandlerScope(req, deps.currentUserId, deps.currentConversationId);
  const ctx: NetworkInternalContext = {
    extensionId,
    conversationId: scope.conversationId,
    userId: scope.userId,
    // Reuse the Phase 1 PDP singleton — wired at runtime boot. The
    // ToolExecutor's own `this.engine` field already holds the same
    // reference, but referring to the singleton keeps the handler
    // independently testable.
    engine: deps.engine,
    registry: deps.registry,
  };
  return handleNetworkInternalRpc(req, ctx);
}

/** Phase 51 — `ctx.llm.complete()` reverse-RPC. The token NEVER
 *  crosses the JSON-RPC boundary; the host resolves credentials and
 *  invokes pi-ai's `complete()` directly. */
export async function handlePiLlmComplete(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGranted(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  const resolved = resolveReverseRpcMeta(extensionId, req);
  if (!resolved.ok) return resolved.errorResponse;
  return handleLlmCompleteRpc(req, {
    granted: base.granted,
    registeredTool: { extensionId },
  }, resolved.rpcMeta);
}

/** Phase 51 — `ctx.memory.*` reverse-RPC. */
export async function handlePiMemory(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGranted(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  const resolved = resolveReverseRpcMeta(extensionId, req);
  if (!resolved.ok) return resolved.errorResponse;
  return handleMemoryRpc(req, {
    granted: base.granted,
    registeredTool: { extensionId },
  }, resolved.rpcMeta);
}

/** Phase 51 — `ctx.lessons.*` reverse-RPC. */
export async function handlePiLessons(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGranted(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  const resolved = resolveReverseRpcMeta(extensionId, req);
  if (!resolved.ok) return resolved.errorResponse;
  return handleLessonsRpc(req, {
    granted: base.granted,
    registeredTool: { extensionId },
  }, resolved.rpcMeta);
}

/** Phase 1 (shared-search) — `ctx.search.{web,read}` reverse-RPC. The
 *  provider chain runs host-side behind the SSRF egress guard; the
 *  handler gates on the `search` grant + delegates to `src/search`. */
export async function handlePiSearch(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGranted(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  const resolved = resolveReverseRpcMeta(extensionId, req);
  if (!resolved.ok) return resolved.errorResponse;
  return handleSearchRpc(req, {
    granted: base.granted,
    registeredTool: { extensionId },
  }, resolved.rpcMeta);
}

/** Phase 51 — `ctx.schedule.*` reverse-RPC. Today only `fire-now`
 *  is supported (manifest-only registration handles the rest). */
export async function handlePiSchedule(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGranted(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  const resolved = resolveReverseRpcMeta(extensionId, req);
  if (!resolved.ok) return resolved.errorResponse;
  return handleScheduleRpc(req, {
    granted: base.granted,
    registeredTool: { extensionId },
    ...(deps.scheduleDaemon ? { daemon: deps.scheduleDaemon } : {}),
  }, resolved.rpcMeta);
}

/**
 * Handle a `ezcorp/drafts` reverse-RPC request. Bundled-only —
 * gated by `BUNDLED_DRAFTS_ALLOWLIST` checked AGAINST EXTENSION
 * NAME inside the handler. The handler resolves the calling
 * extension's name via `registry.getManifest(extensionId).name`
 * (host-owned, not RPC-derived).
 *
 * See `drafts-handler.ts` for the full contract.
 */
export async function handlePiDrafts(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGrantedAndManifest(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  const resolved = resolveReverseRpcMeta(extensionId, req);
  if (!resolved.ok) return resolved.errorResponse;
  const ctx: DraftsContext = {
    userId: resolved.onBehalfOf,
    grantedPermissions: base.granted,
  };
  const response = await handleDraftsRpc(base.manifest.name, req, ctx);

  // agent-install-ux-polish Phase 2 (D3/D6): on a successful
  // `install` action ONLY, emit a lightweight USER-SCOPED
  // `extensions:installed` so an open Extensions Library tab can
  // live-refresh without a manual reload. The handler already ran
  // `installAuthoredDraft` (which includes `registry.reload()`), so
  // by here the new row is queryable. Mirrors the post-success bus
  // emit pattern `handlePiAppendMessage` uses for `run:turn_saved`.
  //
  // D6 — best-effort: wrapped so a throw/missing-bus can NEVER fail
  // or delay the install; a dropped event degrades to today's manual
  // reload. The event carries the installing user's id only (no
  // conversationId) — `shouldDeliverEvent`'s userId branch enforces
  // single-user delivery (no broadcast, no cross-user leak).
  const params = (req.params ?? {}) as Record<string, unknown>;
  if (
    deps.bus &&
    params.action === "install" &&
    "result" in response &&
    response.result
  ) {
    try {
      const result = response.result as {
        ok?: unknown;
        extensionId?: unknown;
        name?: unknown;
      };
      if (
        result.ok === true &&
        typeof result.extensionId === "string" &&
        typeof result.name === "string"
      ) {
        deps.bus.emit("extensions:installed", {
          userId: ctx.userId,
          extensionId: result.extensionId,
          name: result.name,
        });
      }
    } catch (e) {
      log.warn(
        "extensions:installed emit failed (non-fatal — Library falls back to manual reload)",
        { extensionId, error: String(e) },
      );
    }
  }

  return response;
}

/**
 * Handle a `ezcorp/github-projects.<verb>` reverse-RPC request.
 *
 * Bundled-only — the handler gates on `BUNDLED_GITHUB_PROJECTS_ALLOWLIST`
 * checked AGAINST EXTENSION NAME (host-resolved via
 * `registry.getManifest(extensionId).name`, never the wire). The verb is the
 * method's suffix after `GITHUB_PROJECTS_RPC_PREFIX`.
 *
 * Provenance (userId / conversationId) is resolved from the host-issued
 * `ezCallId` correlation token the subprocess echoed back (parity with
 * `handlePiDrafts` / `handlePiFs`), NOT the process-wide singletons. The
 * handler derives the board's projectId from `ctx.conversationId` itself —
 * params never carry a board id (confused-deputy fix).
 *
 * See `github-projects-handler.ts` for the full contract.
 */
export async function handlePiGithubProjects(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGrantedAndManifest(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  const resolved = resolveReverseRpcMeta(extensionId, req);
  if (!resolved.ok) return resolved.errorResponse;
  const verb = req.method.slice(GITHUB_PROJECTS_RPC_PREFIX.length);
  const ctx: GithubProjectsContext = {
    extensionName: base.manifest.name,
    extensionId,
    userId: resolved.onBehalfOf,
    conversationId: resolved.conversationId,
    grantedPermissions: base.granted,
  };
  return handleGithubProjectsRpc(verb, req, ctx);
}

/**
 * Handle an `ezcorp/rbac-check` reverse-RPC request — the host side of
 * the SDK's `ctx.rbac.check(scope)` (extension-RBAC layer, user→extension
 * axis; complementary to the PDP, which governs what the EXTENSION may
 * do). Returns `{granted: boolean}`.
 *
 * Identity contract (parity with `handlePiGithubProjects`):
 *   - The USER is the host-issued provenance `onBehalfOf` resolved from
 *     the echoed `ezCallId` token — never the wire, never singletons.
 *   - The EXTENSION is the registry-resolved manifest name for the
 *     subprocess (`registry.getManifest(extensionId).name`). Any wire
 *     param naming another extension is ignored — a subprocess cannot
 *     probe or ride another extension's scopes (confused-deputy fix).
 *   - The PROJECT is derived server-side from the calling conversation
 *     (`conversation.projectId`); a background fire with no conversation
 *     checks at the "all projects" (null) coordinate, which only
 *     NULL-project grant rows cover.
 *
 * Scope allowlist: the five core verbs are checkable on every extension;
 * a custom scope must appear in the registry manifest's
 * `permissions.rbacScopes` declarations. An unknown scope is a hard
 * `-32602` naming the valid scopes (an authoring bug, not a deny).
 * A missing grant is NOT an error — deny-by-default resolves
 * `{granted: false}` (admins resolve true for everything; an unknown
 * `onBehalfOf` user fails closed the same way).
 */
export async function handlePiRbacCheck(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGrantedAndManifest(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  const resolved = resolveReverseRpcMeta(extensionId, req);
  if (!resolved.ok) return resolved.errorResponse;

  const scope = (req.params as { scope?: unknown } | undefined)?.scope;
  if (typeof scope !== "string" || scope.length === 0) {
    return rpcError(req.id, -32602, "'scope' is required and must be a non-empty string");
  }

  // Declared-scope allowlist — core verbs always; custom scopes only when
  // DECLARED by this extension's registry manifest (never the wire).
  const declaredScopes = (base.manifest.permissions?.rbacScopes ?? []).map((s) => s.name);
  const validScopes: string[] = [...CORE_RBAC_SCOPES, ...declaredScopes];
  if (!validScopes.includes(scope)) {
    return rpcError(
      req.id,
      -32602,
      `Unknown RBAC scope '${scope}' for extension '${base.manifest.name}' — valid scopes: ${validScopes.join(", ")}`,
    );
  }

  // The decision core is shared with the host-side enforcement gate in
  // `executeToolCall` (single source of truth — see
  // `resolveExtensionScopeGrant`). Identity + project come from the
  // provenance-resolved coordinates; the wire never carries them.
  const isGranted = await deps.resolveExtensionScopeGrant(
    base.manifest.name,
    scope,
    resolved.onBehalfOf,
    resolved.conversationId,
  );
  return { jsonrpc: "2.0", id: req.id, result: { granted: isGranted } };
}

/**
 * Handle a `ezcorp/append-message` reverse RPC request. Creates an
 * extension-authored turn (role:"extension", excluded:true) plus
 * inline tool-call rows, and reattributes any pre-uploaded
 * attachments to the new message id. Conversation scope is FORCED
 * by the host — see append-message-handler.ts for the full
 * enforcement ladder.
 */
export async function handlePiAppendMessage(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGranted(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  const resolved = resolveReverseRpcMeta(extensionId, req);
  if (!resolved.ok) return resolved.errorResponse;
  const ctx: AppendMessageContext = {
    conversationId: resolved.conversationId ?? "unknown",
    userId: resolved.onBehalfOf,
    grantedPermissions: base.granted,
    // Phase 6: thread the PDP for the canonical permission decision.
    engine: deps.engine,
  };
  const response = await handleAppendMessageRpc(extensionId, req, ctx);

  // On success, broadcast `run:turn_saved` so the chat UI's
  // existing `ez:turn_saved` listener picks up the new turn. Without
  // this, the row sits in the DB but the user never sees it — the
  // frontend only re-hydrates messages on initial page load and on
  // run completion. The conversationId comes from the same source
  // the handler uses (params if ctx is unbound, otherwise ctx).
  if (deps.bus && "result" in response && response.result) {
    const result = response.result as { messageId?: unknown; toolCallIds?: unknown };
    if (typeof result.messageId === "string") {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const convId =
        ctx.conversationId !== "unknown"
          ? ctx.conversationId
          : (typeof params.conversationId === "string" ? params.conversationId : null);
      const parentId = typeof params.parentMessageId === "string"
        ? params.parentMessageId
        : null;
      const content = typeof params.content === "string" ? params.content : "";
      if (convId) {
        deps.bus.emit("run:turn_saved", {
          // No host-driven run for extension-authored turns. Use a
          // synthetic id so SSE consumers that key on runId don't
          // collide with a real run.
          runId: `ext:${extensionId}:${result.messageId}`,
          conversationId: convId,
          messageId: result.messageId,
          parentMessageId: parentId,
          content,
          // Extension-authored turns are one-shot (no agent tool-loop
          // continuation) and route through handleExtensionTurnSaved on
          // the client, not the streaming-placeholder path.
          final: true,
        });
      }
    }
  }

  return response;
}

/**
 * Handle a `ezcorp/finalize-tool-call` reverse RPC request. Flips a
 * previously-`running` tool-call row into its terminal state. Caller
 * must own the row (extensionId match) and hold the same
 * `appendMessages` permission used to author it. See
 * finalize-tool-call-handler.ts for the full contract.
 */
export async function handlePiFinalizeToolCall(
  deps: RpcHandlerDeps,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const base = requireGranted(deps.registry, extensionId, req);
  if (!base.ok) return base.errorResponse;
  // Per-call provenance: token wins, singletons are the fallback.
  const scope = resolveHandlerScope(req, deps.currentUserId, deps.currentConversationId);
  const ctx: FinalizeToolCallContext = {
    conversationId: scope.conversationId,
    userId: scope.userId,
    grantedPermissions: base.granted,
    // Phase 6: thread the PDP for the canonical permission decision.
    engine: deps.engine,
  };
  return handleFinalizeToolCallRpc(extensionId, req, ctx);
}

// ── Declarative reverse-RPC dispatch table ─────────────────────────────
// Replaces the former long `if (req.method === "ezcorp/…")` chain in
// `ensureSubprocessRpcWired`. Each entry maps an exact method string to the
// ToolExecutor public method that services it; `routeReverseRpc` handles the
// one prefix-matched family (`ezcorp/github-projects.<verb>`) and the
// method-not-found fallback. Ordering is irrelevant (exact-match lookup),
// and no exact key overlaps the github-projects prefix.

/**
 * The subset of the `ToolExecutor` public method surface the dispatch table
 * invokes. Declared here (rather than importing the `ToolExecutor` class type
 * from `./executor`) so this module has NO type back-edge to the core — the
 * executor's `this` structurally satisfies it. fs.* methods keep their
 * `FsRpcResponse` return (the table casts them at the call site, as before).
 */
export interface ReverseRpcDispatch {
  handlePiInvoke(callerExtId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiFs(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiFsRead(extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse>;
  handlePiFsWrite(extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse>;
  handlePiFsList(extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse>;
  handlePiFsStat(extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse>;
  handlePiFsExists(extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse>;
  handlePiFsMkdir(extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse>;
  handlePiFsUnlink(extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse>;
  handlePiEmitTaskEvent(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiEmitLoopEvent(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiAgentConfigs(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiSpawnAssignment(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiCancelRun(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiQueueAgentMessage(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiAppendMessage(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiFinalizeToolCall(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiNetworkInternal(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiStorage(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiLlmComplete(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiMemory(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiLessons(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiSearch(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiSchedule(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiDrafts(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiRbacCheck(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
  handlePiGithubProjects(extensionId: string, req: JsonRpcRequest): Promise<JsonRpcResponse>;
}

type RouteFn = (
  self: ReverseRpcDispatch,
  extensionId: string,
  req: JsonRpcRequest,
) => Promise<JsonRpcResponse>;

export const REVERSE_RPC_ROUTES: Record<string, RouteFn> = {
  "ezcorp/invoke": (s, e, r) => s.handlePiInvoke(e, r),
  // Phase 3: per-operation fs.* handlers come BEFORE the legacy path-check
  // `ezcorp/fs` shim. Method strings are exact-match (no fallthrough).
  "ezcorp/fs.read": (s, e, r) => s.handlePiFsRead(e, r) as unknown as Promise<JsonRpcResponse>,
  "ezcorp/fs.write": (s, e, r) => s.handlePiFsWrite(e, r) as unknown as Promise<JsonRpcResponse>,
  "ezcorp/fs.list": (s, e, r) => s.handlePiFsList(e, r) as unknown as Promise<JsonRpcResponse>,
  "ezcorp/fs.stat": (s, e, r) => s.handlePiFsStat(e, r) as unknown as Promise<JsonRpcResponse>,
  "ezcorp/fs.exists": (s, e, r) => s.handlePiFsExists(e, r) as unknown as Promise<JsonRpcResponse>,
  "ezcorp/fs.mkdir": (s, e, r) => s.handlePiFsMkdir(e, r) as unknown as Promise<JsonRpcResponse>,
  "ezcorp/fs.unlink": (s, e, r) => s.handlePiFsUnlink(e, r) as unknown as Promise<JsonRpcResponse>,
  // Legacy path-check shim — see `handlePiFs` JSDoc for the deprecation
  // roadmap. Emits a one-time console.warn per extension on first call.
  "ezcorp/fs": (s, e, r) => s.handlePiFs(e, r),
  "ezcorp/emit-task-event": (s, e, r) => s.handlePiEmitTaskEvent(e, r),
  "ezcorp/emit-loop-event": (s, e, r) => s.handlePiEmitLoopEvent(e, r),
  "ezcorp/agent-configs": (s, e, r) => s.handlePiAgentConfigs(e, r),
  "ezcorp/spawn-assignment": (s, e, r) => s.handlePiSpawnAssignment(e, r),
  "ezcorp/cancel-run": (s, e, r) => s.handlePiCancelRun(e, r),
  "ezcorp/queue-agent-message": (s, e, r) => s.handlePiQueueAgentMessage(e, r),
  "ezcorp/append-message": (s, e, r) => s.handlePiAppendMessage(e, r),
  "ezcorp/finalize-tool-call": (s, e, r) => s.handlePiFinalizeToolCall(e, r),
  "ezcorp/network.internal": (s, e, r) => s.handlePiNetworkInternal(e, r),
  "ezcorp/storage": (s, e, r) => s.handlePiStorage(e, r),
  "ezcorp/llm-complete": (s, e, r) => s.handlePiLlmComplete(e, r),
  "ezcorp/memory": (s, e, r) => s.handlePiMemory(e, r),
  "ezcorp/lessons": (s, e, r) => s.handlePiLessons(e, r),
  "ezcorp/search": (s, e, r) => s.handlePiSearch(e, r),
  "ezcorp/schedule": (s, e, r) => s.handlePiSchedule(e, r),
  "ezcorp/drafts": (s, e, r) => s.handlePiDrafts(e, r),
  // `ezcorp/rbac-check` — brokered extension-RBAC scope check
  // (`ctx.rbac.check` in the SDK). Identity is provenance/registry-derived.
  "ezcorp/rbac-check": (s, e, r) => s.handlePiRbacCheck(e, r),
};

/**
 * Route a single inbound reverse-RPC request to its ToolExecutor handler.
 * Exact-method matches come from {@link REVERSE_RPC_ROUTES}; the
 * `ezcorp/github-projects.<verb>` family is prefix-matched (the FROZEN
 * `GITHUB_PROJECTS_RPC_PREFIX`); anything else is `-32601` Method not found.
 */
export async function routeReverseRpc(
  self: ReverseRpcDispatch,
  extensionId: string,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const exact = REVERSE_RPC_ROUTES[req.method];
  if (exact) return exact(self, extensionId, req);
  // `ezcorp/github-projects.<verb>` — bundled-only board control plane.
  // Method names carry the verb suffix, so match on the prefix and route
  // the verb. The handler enforces its own bundled-only allowlist by NAME.
  if (req.method.startsWith(GITHUB_PROJECTS_RPC_PREFIX)) {
    return self.handlePiGithubProjects(extensionId, req);
  }
  return {
    jsonrpc: "2.0" as const,
    id: req.id,
    error: { code: -32601, message: "Method not found" },
  };
}
