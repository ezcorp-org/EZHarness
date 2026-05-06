import type { ExtensionRegistry } from "./registry";
import type { ExtensionProcess } from "./subprocess";
import type { ToolCallResult, JsonRpcRequest, JsonRpcResponse } from "./types";
import type { ExtensionStateMediator } from "./state-mediator";
import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import type { AgentExecutor } from "../runtime/executor";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { checkFilesystemPermission } from "./permissions";
import { resolveSharedVariables } from "./shared-variables";
import { denyAndDisable } from "./security";
import { handleStorageRpc, type StorageContext } from "./storage-handler";
import { handleAgentConfigsRpc, type AgentConfigsContext } from "./agent-configs-handler";
import { handleEmitTaskEventRpc, type TaskEventsContext } from "./task-events-handler";
import { handleSpawnAssignmentRpc, type SpawnAssignmentContext } from "./spawn-assignment-handler";
import { handleCancelRunRpc, type CancelRunContext } from "./cancel-run-handler";
import { handleAppendMessageRpc, type AppendMessageContext } from "./append-message-handler";
import { handleFinalizeToolCallRpc, type FinalizeToolCallContext } from "./finalize-tool-call-handler";
import type { SpawnQuota } from "./spawn-quota";
import { getConversation, getConversationSpawnDepth } from "../db/queries/conversations";
import { persistToolCall } from "../db/queries/tool-calls";
import { resolveExtensionSettings } from "../db/queries/extension-settings";

export const MAX_TOOL_CALLS_PER_TURN = 10;

/**
 * Wraps a pi extension tool definition + ToolExecutor into an AgentTool
 * compatible with pi-agent-core's Agent class.
 *
 * Uses Type.Unsafe() to bridge JSON Schema (from extension manifests) to
 * TypeBox schemas (required by AgentTool.parameters).
 *
 * Optional Phase 4 args (§5.1a) — back-compat with 4-arg callers:
 *  - `schemaOverride`: when set, replaces `extTool.inputSchema` in the
 *    wrapper's `parameters`. Used by the orchestration extension to inject
 *    a turn-specific enum of available agent ids.
 *  - `invocationMetadata`: opaque per-turn data closed over by the wrapper
 *    and forwarded as a trailing arg to `toolExecutor.executeToolCall`,
 *    which surfaces it to the subprocess via the JSON-RPC `_meta` channel.
 */
export function extensionToAgentTool(
  extTool: { name: string; description: string; inputSchema: Record<string, unknown> },
  toolExecutor: ToolExecutor,
  conversationId: string,
  messageId: string,
  schemaOverride?: Record<string, unknown>,
  invocationMetadata?: Record<string, unknown>,
): AgentTool {
  return {
    name: extTool.name,
    label: extTool.name,
    description: extTool.description,
    parameters: Type.Unsafe(schemaOverride ?? extTool.inputSchema),
    execute: async (toolCallId, params, _signal) => {
      // Per-call merge: thread the host-minted `toolCallId` into the
      // invocation metadata so handlers can use it as a stable gate
      // key (e.g. `ask-user`'s pending-answer map). Additive —
      // extensions that don't read the field ignore it.
      const callMetadata = { ...invocationMetadata, toolCallId };
      // Pass `toolCallId` as `invocationId` on the `tool:start` bus
      // event too, so the chat UI's tool-card stream (stores.svelte.ts
      // `case "tool:start"`) can correlate this call with later
      // tool:complete / tool:error events. Without this the executor's
      // own emit at `executeToolCall` would carry no invocationId,
      // forcing the UI to depend on the parallel pi-agent stream emit
      // — which carries no `cardType`, breaking specialized cards
      // like AskUserQuestionCard.
      const result = await toolExecutor.executeToolCall(
        extTool.name, params as Record<string, unknown>, conversationId, messageId,
        { metadata: { invocationId: toolCallId } }, callMetadata,
      );
      return {
        content: result.content.map(c => ({ type: "text" as const, text: c.text })),
        details: { isError: result.isError },
      };
    },
  };
}

export type PermissionChecker = (
  extensionId: string,
  toolName: string,
  input: Record<string, unknown>,
) => Promise<boolean>;

export class PermissionDeniedError extends Error {
  constructor(
    public readonly extensionId: string,
    public readonly toolName: string,
  ) {
    super(`Permission denied for tool "${toolName}" from extension "${extensionId}"`);
    this.name = "PermissionDeniedError";
  }
}

/**
 * Orchestrates tool calls between LLM and extension subprocesses.
 * Permission checking is injectable (not hard-imported from permissions.ts).
 */
export type ArgsResolver = (
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export class ToolExecutor {
  private permissionChecker?: PermissionChecker;
  private bus?: EventBus<AgentEvents>;
  private stateMediator?: ExtensionStateMediator;
  private wiredExtensions = new Set<string>();
  private currentUserId?: string;
  private currentConversationId?: string;
  private currentModel?: string;
  private currentProvider?: string;
  private currentAgentConfigId?: string;
  private executor?: AgentExecutor;
  private spawnQuota?: SpawnQuota;
  private argsResolver?: ArgsResolver;

  constructor(
    private registry: ExtensionRegistry,
    options?: { permissionChecker?: PermissionChecker; bus?: EventBus<AgentEvents> },
  ) {
    this.permissionChecker = options?.permissionChecker;
    this.bus = options?.bus;
  }

  /** Set or update the permission checker (for deferred wiring). */
  setPermissionChecker(checker: PermissionChecker): void {
    this.permissionChecker = checker;
  }

  /** Set the state mediator for routing extension notifications. */
  setStateMediator(mediator: ExtensionStateMediator): void {
    this.stateMediator = mediator;
  }

  /** Set the current user ID for storage scope resolution. */
  setCurrentUserId(userId: string): void {
    this.currentUserId = userId;
  }

  /** Set the calling conversation's model + provider so bundled extensions
   *  (ai-kit) can inherit them when spawning sibling conversations. This
   *  is ONLY a default — the LLM's explicit `model` / `provider` args
   *  always win over these values at the ai-kit client layer. */
  setCurrentModel(model: string | null | undefined): void {
    this.currentModel = model ?? undefined;
  }

  /** Set the calling agent's config id so tool_calls rows carry it for
   *  admin analytics. `null`/`undefined` clear it (top-level chat with no
   *  bound agent). */
  setCurrentAgentConfigId(agentConfigId: string | null | undefined): void {
    this.currentAgentConfigId = agentConfigId ?? undefined;
  }

  setCurrentProvider(provider: string | null | undefined): void {
    this.currentProvider = provider ?? undefined;
  }

  /** Wire the owning AgentExecutor so `ezcorp/spawn-assignment` can call
   *  `startAssignment`, which in turn calls back into `executor.streamChat`. */
  setExecutor(executor: AgentExecutor): void {
    this.executor = executor;
  }

  /** Wire the shared spawn-quota tracker. One instance lives on the
   *  AgentExecutor; every ToolExecutor in the same process shares it
   *  so hourly/concurrent caps apply across all of a user's turns. */
  setSpawnQuota(quota: SpawnQuota): void {
    this.spawnQuota = quota;
  }

  /** Register a pre-call transformer for tool args. Used to substitute
   *  symbolic references (e.g. `ez-attachment://<id>` handles) with their
   *  concrete values before the extension subprocess receives them. */
  setArgsResolver(fn: ArgsResolver): void {
    this.argsResolver = fn;
  }

  /** Execute a tool call through the extension subprocess.
   *
   *  `invocationMetadata` (Phase 4 §5.1a) is opaque per-turn data threaded
   *  onto the JSON-RPC `_meta` channel alongside `params`. Subprocess
   *  handlers surface it on the tool-handler ctx as `invocationMetadata`
   *  — the orchestration extension uses it to receive overrides /
   *  teamToolScope / parentMessageId bound by the host at
   *  wire-orchestration-tools-for-turn time. */
  async executeToolCall(
    toolName: string,
    input: Record<string, unknown>,
    conversationId: string,
    messageId: string | null,
    _opts?: { callerExtensionId?: string; _callDepth?: number; metadata?: { invocationId?: string; source?: 'inline' | 'agent-run' } },
    invocationMetadata?: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const registered = this.registry.getRegisteredTool(toolName);
    if (!registered) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }

    const extensionId = registered.extensionId;
    const originalName = registered.originalName;

    // Resolve symbolic arg references (e.g. attachment handles → data URIs)
    // before permission checks + subprocess dispatch. A resolver failure
    // should not silently drop args, so any error propagates.
    if (this.argsResolver) {
      input = await this.argsResolver(input);
    }

    // Permission check (if checker is set)
    if (this.permissionChecker) {
      const allowed = await this.permissionChecker(extensionId, toolName, input);
      if (!allowed) {
        throw new PermissionDeniedError(extensionId, toolName);
      }
    }

    // Track current call context for reverse RPC handlers (e.g. ezcorp/storage)
    this.currentConversationId = conversationId;

    const startTime = Date.now();
    const meta = _opts?.metadata;
    this.bus?.emit("tool:start", { conversationId, extensionId, toolName, input, timestamp: startTime, ...(registered.cardType && { cardType: registered.cardType }), ...(meta?.source && { source: meta.source }), ...(meta?.invocationId && { invocationId: meta.invocationId }) });

    try {
      // Resolve shared variables (x-shared) before dispatching to either
      // subprocess or MCP client.
      const resolvedInput = resolveSharedVariables(
        registered.inputSchema,
        input,
      );

      const manifest = this.registry.getManifest(extensionId);
      const isMcp = manifest?.kind === "mcp";

      let result;
      if (isMcp) {
        const client = await this.registry.getMcpClient(extensionId);
        result = await client.callTool(originalName, resolvedInput);
      } else {
        const proc = await this.registry.getProcess(extensionId);

        // Wire handlers if not already wired for this extension
        await this.ensureSubprocessRpcWired(extensionId, proc);

        // Use originalName for RPC call to subprocess, not the namespaced name
        const callArgs = _opts?._callDepth != null && _opts._callDepth > 0
          ? { ...resolvedInput, _depth: _opts._callDepth }
          : resolvedInput;
        // Propagate the acting-user id through the JSON-RPC `_meta`
        // side-channel. The subprocess sees it in `extra._meta.ezOnBehalfOf`
        // and bundled extensions (like ai-kit) forward it as the
        // X-Ezcorp-On-Behalf-Of header on any outbound call back into
        // this server. This is the ONLY path by which the conversation
        // owner's id reaches a tool handler — it is never part of the
        // LLM-visible arguments (see bearer-auth.ts for the reason).
        const meta: Record<string, unknown> = {};
        if (this.currentUserId) meta.ezOnBehalfOf = this.currentUserId;
        if (conversationId) meta.ezConversationId = conversationId;
        if (this.currentModel) meta.ezModel = this.currentModel;
        if (this.currentProvider) meta.ezProvider = this.currentProvider;
        // Public origin of the EZCorp UI — bundled MCP tools (ai-kit)
        // use it to build clickable deep-links in tool responses. Safe
        // to pass to every subprocess; non-URL-building tools ignore it.
        const publicUrl = process.env.EZCORP_PUBLIC_URL;
        if (publicUrl) meta.ezPublicUrl = publicUrl;
        // Phase 4 §5.1a: opaque per-turn invocation metadata rides in
        // `_meta.invocationMetadata`. The SDK's tools/call dispatcher
        // surfaces it on the handler ctx.
        //
        // Per-extension user/global settings (lazy-foraging-hammock):
        // when the manifest declares a `settings` schema, resolve the
        // effective values for the acting user and merge them under
        // `invocationMetadata.settings`. Caller-supplied settings win
        // over resolved values (the host orchestrator may pre-bind
        // overrides at wire time); resolved values fill the gaps.
        let mergedInvocationMetadata = invocationMetadata;
        if (manifest?.settings) {
          const resolved = await resolveExtensionSettings(extensionId, this.currentUserId ?? null);
          const callerSettings = (invocationMetadata?.settings ?? undefined) as
            | Record<string, unknown>
            | undefined;
          mergedInvocationMetadata = {
            ...invocationMetadata,
            settings: { ...resolved, ...(callerSettings ?? {}) },
          };
        }
        if (mergedInvocationMetadata && Object.keys(mergedInvocationMetadata).length > 0) {
          meta.invocationMetadata = mergedInvocationMetadata;
        }
        result = await proc.callTool(originalName, callArgs, meta);
      }

      // Record to tool_calls table
      await this.recordToolCall(conversationId, messageId, extensionId, toolName, input, result, startTime, registered.cardType);

      const duration = Date.now() - startTime;
      this.bus?.emit("tool:complete", {
        conversationId,
        extensionId,
        toolName,
        output: result,
        duration,
        success: !result.isError,
        ...(registered.cardType && { cardType: registered.cardType }),
        ...(meta?.source && { source: meta.source }),
        ...(meta?.invocationId && { invocationId: meta.invocationId }),
      });

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : (typeof error === 'string' ? error : JSON.stringify(error));
      const errorResult: ToolCallResult = {
        content: [{ type: "text", text: errorMsg }],
        isError: true,
      };

      // Record error to tool_calls table
      await this.recordToolCall(conversationId, messageId, extensionId, toolName, input, errorResult, startTime, registered.cardType);

      const duration = Date.now() - startTime;
      this.bus?.emit("tool:error", {
        conversationId,
        extensionId,
        toolName,
        error: errorMsg,
        duration,
        ...(registered.cardType && { cardType: registered.cardType }),
        ...(meta?.source && { source: meta.source }),
        ...(meta?.invocationId && { invocationId: meta.invocationId }),
      });

      return errorResult;
    }
  }

  /**
   * Handle a ezcorp/fs reverse RPC request from a subprocess.
   * Mediates filesystem operations through checkFilesystemPermission.
   * Calls denyAndDisable on violations, disabling the extension.
   */
  async handlePiFs(
    extensionId: string,
    req: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const operation = params.operation as string;
    const path = params.path as string;

    if (!path || !operation) {
      return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "Missing path or operation" } };
    }

    const granted = this.registry.getGrantedPermissions(extensionId);
    const installPath = this.registry.getInstallPath(extensionId);

    if (!granted || !installPath) {
      return { jsonrpc: "2.0", id: req.id, error: { code: -32603, message: "Extension not found in registry" } };
    }

    const result = await checkFilesystemPermission(path, granted, installPath);

    if (!result.allowed) {
      await denyAndDisable(extensionId, `Filesystem access denied: ${operation} on ${path} (resolved: ${result.resolvedPath})`, result.resolvedPath);
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32001, message: `Filesystem access denied: ${path} is outside declared permission paths. Extension has been disabled.` },
      };
    }

    return {
      jsonrpc: "2.0",
      id: req.id,
      result: { allowed: true, resolvedPath: result.resolvedPath },
    };
  }

  /**
   * Handle a ezcorp/invoke reverse RPC request from a subprocess.
   * Routes cross-extension calls through executeToolCall with caller context.
   */
  async handlePiInvoke(
    callerExtId: string,
    req: import("./types").JsonRpcRequest,
  ): Promise<import("./types").JsonRpcResponse> {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const tool = params.tool as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const depth = (params._depth as number) ?? 0;

    const MAX_CALL_DEPTH = 10;
    if (depth >= MAX_CALL_DEPTH) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: `Cross-extension call depth limit exceeded (max ${MAX_CALL_DEPTH})` },
      };
    }

    const resolved = this.registry.resolveDepTool(callerExtId, tool);
    // `tool` is a namespaced name like `foo__bar`; the package prefix is
    // everything before the first `__` (see registry's namespace separator).
    if (!resolved) {
      const pkgName = tool.includes("__") ? tool.split("__")[0] : tool;
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32001, message: `Dependency not declared: ${pkgName}` },
      };
    }

    try {
      const result = await this.executeToolCall(
        resolved.name,
        args,
        "cross-ext",
        `cross-ext-${req.id}`,
        { callerExtensionId: callerExtId, _callDepth: depth + 1 },
      );

      return {
        jsonrpc: "2.0",
        id: req.id,
        result,
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /**
   * Create the `tools` object for AgentContext.
   * Code-based agents can call ctx.tools.invoke("tool_name", {input}).
   */
  createToolsContext(conversationId: string, messageId: string) {
    return {
      invoke: async (toolName: string, input: Record<string, unknown>): Promise<unknown> => {
        const result = await this.executeToolCall(toolName, input, conversationId, messageId);
        if (result.isError) {
          throw new Error(result.content.map((c) => c.text).join("\n"));
        }
        // Return the text content as the result
        return result.content.map((c) => c.text).join("\n");
      },
    };
  }

  /**
   * Handle a ezcorp/storage reverse RPC request from a subprocess.
   * Delegates to the storage handler with proper context isolation.
   */
  async handlePiStorage(
    extensionId: string,
    req: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const granted = this.registry.getGrantedPermissions(extensionId);
    const manifest = this.registry.getManifest(extensionId);

    if (!granted || !manifest) {
      return { jsonrpc: "2.0", id: req.id, error: { code: -32603, message: "Extension not found in registry" } };
    }

    const ctx: StorageContext = {
      conversationId: this.currentConversationId ?? "unknown",
      userId: this.currentUserId ?? "unknown",
      manifest,
      grantedPermissions: granted,
    };

    return handleStorageRpc(extensionId, req, ctx);
  }

  /**
   * Handle a `ezcorp/agent-configs` reverse RPC request. Read-only access
   * to the calling user's agent configs, gated on the `agentConfig: "read"`
   * permission. See agent-configs-handler.ts for the full contract.
   */
  async handlePiAgentConfigs(
    extensionId: string,
    req: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const granted = this.registry.getGrantedPermissions(extensionId);
    if (!granted) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "Extension not found in registry" },
      };
    }
    const ctx: AgentConfigsContext = {
      userId: this.currentUserId ?? "unknown",
      grantedPermissions: granted,
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
  async handlePiEmitTaskEvent(
    extensionId: string,
    req: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const granted = this.registry.getGrantedPermissions(extensionId);
    if (!granted) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "Extension not found in registry" },
      };
    }
    const ctx: TaskEventsContext = {
      conversationId: this.currentConversationId ?? "unknown",
      userId: this.currentUserId ?? "unknown",
      grantedPermissions: granted,
      bus: this.bus,
    };
    return handleEmitTaskEventRpc(extensionId, req, ctx);
  }

  /**
   * Handle a `ezcorp/spawn-assignment` reverse RPC request (Phase 2d).
   * Dispatches a caller-chosen agent config against a caller-supplied
   * task body in a new sub-conversation parented on the current one.
   * Gated on the `spawnAgents` permission + conversation-wiring + quota.
   * See spawn-assignment-handler.ts for the full enforcement ladder.
   */
  async handlePiSpawnAssignment(
    extensionId: string,
    req: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const granted = this.registry.getGrantedPermissions(extensionId);
    if (!granted) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "Extension not found in registry" },
      };
    }
    // Spawn requires the full runtime wiring — executor + bus + quota.
    // Executor-less test contexts or processes that skipped the
    // AgentExecutor boot (e.g. tool-only unit tests) fail closed here
    // rather than later in the handler's dispatch phase.
    if (!this.executor || !this.bus || !this.spawnQuota) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "Spawn path unavailable in this context" },
      };
    }

    // Resolve parent conversation metadata for scope + depth gates.
    const convId = this.currentConversationId ?? "unknown";
    let projectId: string | null = null;
    let spawnDepth = 0;
    if (convId && convId !== "unknown") {
      const conv = await getConversation(convId);
      projectId = conv?.projectId ?? null;
      spawnDepth = await getConversationSpawnDepth(convId);
    }

    const ctx: SpawnAssignmentContext = {
      conversationId: convId,
      userId: this.currentUserId ?? "unknown",
      projectId,
      grantedPermissions: granted,
      executor: this.executor,
      bus: this.bus,
      quota: this.spawnQuota,
      spawnDepth,
      ...(this.currentModel !== undefined ? { parentModel: this.currentModel } : {}),
      ...(this.currentProvider !== undefined ? { parentProvider: this.currentProvider } : {}),
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
  async handlePiCancelRun(
    extensionId: string,
    req: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const granted = this.registry.getGrantedPermissions(extensionId);
    if (!granted) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "Extension not found in registry" },
      };
    }
    if (!this.executor || !this.spawnQuota) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "Cancel path unavailable in this context" },
      };
    }
    const ctx: CancelRunContext = {
      userId: this.currentUserId ?? "unknown",
      grantedPermissions: granted,
      executor: this.executor,
      quota: this.spawnQuota,
    };
    return handleCancelRunRpc(extensionId, req, ctx);
  }

  /**
   * Install the reverse-RPC request handler + state-mediator
   * notification handler on this extension's subprocess. Idempotent:
   * `wiredExtensions` is consulted first.
   *
   * Public so the messageToolbar event route can pre-wire the
   * subprocess BEFORE the bus emit. Without that, an extension that
   * never receives a tool call (e.g. `kokoro-tts`, which is purely
   * event-driven) would have no `transport.onRequest` set when its
   * subprocess sends `ezcorp/append-message` — the request would be
   * silently dropped at `json-rpc.ts:67` and the subprocess's call
   * would hang forever. The user sees a "Generating speech…" toast
   * with no follow-up.
   *
   * The closures capture `this`, but every handler reads from
   * `this.registry` / static helpers — no per-turn state is
   * required. So if a fresh ToolExecutor instance later re-wires the
   * same proc (per-turn), the new closure overwrites the old; both
   * do the same thing.
   */
  async ensureSubprocessRpcWired(
    extensionId: string,
    proc: ExtensionProcess,
  ): Promise<void> {
    if (this.wiredExtensions.has(extensionId)) return;
    this.wiredExtensions.add(extensionId);

    if (this.stateMediator) {
      const mediator = this.stateMediator;
      proc.setNotificationHandler((notification) => {
        mediator.handleNotification(extensionId, notification);
      });
    }

    proc.setRequestHandler(async (req) => {
      if (req.method === "ezcorp/invoke") {
        return this.handlePiInvoke(extensionId, req);
      }
      if (req.method === "ezcorp/fs") {
        return this.handlePiFs(extensionId, req);
      }
      if (req.method === "ezcorp/emit-task-event") {
        return this.handlePiEmitTaskEvent(extensionId, req);
      }
      if (req.method === "ezcorp/agent-configs") {
        return this.handlePiAgentConfigs(extensionId, req);
      }
      if (req.method === "ezcorp/spawn-assignment") {
        return this.handlePiSpawnAssignment(extensionId, req);
      }
      if (req.method === "ezcorp/cancel-run") {
        return this.handlePiCancelRun(extensionId, req);
      }
      if (req.method === "ezcorp/append-message") {
        return this.handlePiAppendMessage(extensionId, req);
      }
      if (req.method === "ezcorp/finalize-tool-call") {
        return this.handlePiFinalizeToolCall(extensionId, req);
      }
      if (req.method === "ezcorp/storage") {
        return this.handlePiStorage(extensionId, req);
      }
      return {
        jsonrpc: "2.0" as const,
        id: req.id,
        error: { code: -32601, message: "Method not found" },
      };
    });
  }

  /**
   * Handle a `ezcorp/append-message` reverse RPC request. Creates an
   * extension-authored turn (role:"extension", excluded:true) plus
   * inline tool-call rows, and reattributes any pre-uploaded
   * attachments to the new message id. Conversation scope is FORCED
   * by the host — see append-message-handler.ts for the full
   * enforcement ladder.
   */
  async handlePiAppendMessage(
    extensionId: string,
    req: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const granted = this.registry.getGrantedPermissions(extensionId);
    if (!granted) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "Extension not found in registry" },
      };
    }
    const ctx: AppendMessageContext = {
      conversationId: this.currentConversationId ?? "unknown",
      userId: this.currentUserId ?? "unknown",
      grantedPermissions: granted,
    };
    const response = await handleAppendMessageRpc(extensionId, req, ctx);

    // On success, broadcast `run:turn_saved` so the chat UI's
    // existing `ez:turn_saved` listener picks up the new turn. Without
    // this, the row sits in the DB but the user never sees it — the
    // frontend only re-hydrates messages on initial page load and on
    // run completion. The conversationId comes from the same source
    // the handler uses (params if ctx is unbound, otherwise ctx).
    if (this.bus && "result" in response && response.result) {
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
          this.bus.emit("run:turn_saved", {
            // No host-driven run for extension-authored turns. Use a
            // synthetic id so SSE consumers that key on runId don't
            // collide with a real run.
            runId: `ext:${extensionId}:${result.messageId}`,
            conversationId: convId,
            messageId: result.messageId,
            parentMessageId: parentId,
            content,
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
  async handlePiFinalizeToolCall(
    extensionId: string,
    req: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const granted = this.registry.getGrantedPermissions(extensionId);
    if (!granted) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "Extension not found in registry" },
      };
    }
    const ctx: FinalizeToolCallContext = {
      conversationId: this.currentConversationId ?? "unknown",
      userId: this.currentUserId ?? "unknown",
      grantedPermissions: granted,
    };
    return handleFinalizeToolCallRpc(extensionId, req, ctx);
  }

  private async recordToolCall(
    conversationId: string,
    messageId: string | null,
    extensionId: string,
    toolName: string,
    input: Record<string, unknown>,
    result: ToolCallResult,
    startTime: number,
    cardType?: string,
  ): Promise<void> {
    // Route through the shared persist helper — single insert site for
    // tool_calls across the extension-tool path here and the built-in
    // path in executor.ts. The helper swallows DB errors itself so tool
    // execution is never blocked by a DB glitch.
    await persistToolCall({
      conversationId,
      messageId,
      extensionId,
      toolName,
      input,
      output: result,
      success: !result.isError,
      durationMs: Date.now() - startTime,
      cardType: cardType ?? null,
      userId: this.currentUserId ?? null,
      agentConfigId: this.currentAgentConfigId ?? null,
      model: this.currentModel ?? null,
      provider: this.currentProvider ?? null,
    });
  }
}
