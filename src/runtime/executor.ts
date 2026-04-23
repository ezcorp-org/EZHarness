import type {
  AgentContext,
  AgentDefinition,
  AgentEvents,
  AgentLog,
  AgentRun,
  ShellProvider,
  FileProvider,
  LogLevel,
  Message,
  UserMessage,
  AssistantMessage,
  Usage,
} from "../types";
import type { EventBus } from "./events";
import { Agent, type AgentTool, type AgentEvent } from "@mariozechner/pi-agent-core";
import { stream, complete, type Context } from "@mariozechner/pi-ai";
import { resolveModel, ProviderUnavailableError } from "../providers/router";
import { resolveOAuthModel } from "../providers/registry";
import { getCredential } from "../providers/credentials";
import { extensionToAgentTool, ToolExecutor } from "../extensions/tool-executor";
import type { ExtensionStateMediator } from "../extensions/state-mediator";
import { createSpawnQuota, type SpawnQuota } from "../extensions/spawn-quota";
import { createShellProvider } from "../providers/shell";
import { createFileProvider } from "../providers/file";
import { getProject } from "../db/queries/projects";
import { getAllSettings } from "../db/queries/settings";
import * as dbRuns from "../db/queries/runs";
import { getConversation, getConversationPath, getLatestLeaf, resolveSystemPrompt } from "../db/queries/conversations";
import { ExtensionRegistry } from "../extensions/registry";
import { startCollector } from "../observability/collector";
import { logger } from "../logger";
const log = logger.child("executor");
import { getDb } from "../db/connection";
import { toolCalls, conversations } from "../db/schema";
import { persistToolCall } from "../db/queries/tool-calls";
import { and, eq, isNull } from "drizzle-orm";
import * as activeRunsDb from "../db/queries/active-runs";

export interface ExecutorOptions {
  shell?: ShellProvider;
  file?: FileProvider;
  persist?: boolean;
}

// ── AgentExecutor ───────────────────────────────────────────────────

const MAX_RUNS = 100;

// Watchdog thresholds (activity-based heartbeat).
// - WATCHDOG_TICK_MS: how often the watchdog polls activity
// - WATCHDOG_IDLE_MS: if no progress signal for this long (and no pending permission), kill the run
// - HEARTBEAT_REFRESH_MS: how often the watchdog refreshes active_runs.last_heartbeat while alive
const WATCHDOG_TICK_MS = 15_000;
const WATCHDOG_IDLE_MS = 90_000;
const HEARTBEAT_REFRESH_MS = 30_000;

interface PendingPermissionInfo {
  conversationId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  cardType?: string;
  category?: string;
}

export class AgentExecutor {
  private runs = new Map<string, AgentRun>();
  private controllers = new Map<string, AbortController>();
  private activeAgents = new Map<string, Agent>();
  private runConversations = new Map<string, string>();
  private heartbeats = new Map<string, ReturnType<typeof setInterval>>();
  // Last time a run emitted a real progress signal (token, tool event, agent event, turn).
  // Used by the watchdog to distinguish "actually working" from "leaked promise".
  private lastActivityAt = new Map<string, number>();
  // Last time the watchdog wrote active_runs.last_heartbeat for a run, so we can
  // throttle DB writes to HEARTBEAT_REFRESH_MS while still running the tick at WATCHDOG_TICK_MS.
  private lastHeartbeatWriteAt = new Map<string, number>();
  private pendingPermissions = new Map<string, PendingPermissionInfo>();
  private orphanInterval: ReturnType<typeof setInterval> | undefined;
  private shell: ShellProvider;
  private file: FileProvider;
  private persist: boolean;
  private _stateMediator?: ExtensionStateMediator;
  /** Process-wide spawn quota shared across all ToolExecutor instances
   *  spawned from this executor. Tracks hourly / concurrent caps per
   *  extension so `ezcorp/spawn-assignment` enforcement persists across
   *  the many short-lived ToolExecutor instances created per turn. */
  private _spawnQuota: SpawnQuota;

  /** Set the extension state mediator for routing UI state notifications. */
  setStateMediator(mediator: ExtensionStateMediator): void {
    this._stateMediator = mediator;
  }

  constructor(
    private agents: Map<string, AgentDefinition>,
    private bus: EventBus<AgentEvents>,
    opts?: ExecutorOptions,
  ) {
    this.shell = opts?.shell ?? createShellProvider();
    this.file = opts?.file ?? createFileProvider();
    this.persist = opts?.persist ?? false;
    this._spawnQuota = createSpawnQuota(this.bus);
    startCollector(this.bus);

    if (this.persist) {
      // Clean up orphaned runs on startup and periodically.
      // Also cancel any in-memory runs whose DB record was marked interrupted.
      // On fresh startup, ALL "running" DB entries are orphaned — interrupt them immediately
      activeRunsDb.interruptAllRuns().then((count) => {
        if (count > 0) log.info("Interrupted orphaned runs from previous process", { count });
      }).catch((err) => {
        log.error("interruptAllRuns on startup failed", { error: String(err) });
      });

      const cleanupOrphans = async () => {
        const cleaned = await activeRunsDb.cleanupOrphanedRuns(5);
        if (cleaned > 0) {
          log.info("Cleaned up orphaned runs", { count: cleaned });
          // Cancel in-memory controllers for cleaned-up runs
          for (const [runId, ctrl] of this.controllers) {
            if (!ctrl.signal.aborted) {
              const convId = this.runConversations.get(runId);
              if (convId) {
                const dbRun = await activeRunsDb.getActiveRun(convId);
                if (!dbRun || dbRun.status !== "running") {
                  log.info("Aborting orphaned in-memory run", { runId });
                  ctrl.abort();
                }
              }
            }
          }
        }
      };
      cleanupOrphans().catch((err) => {
        log.error("Orphan cleanup on startup failed", { error: String(err) });
      });
      this.orphanInterval = setInterval(() => {
        cleanupOrphans().catch((err) => {
          log.error("Periodic orphan cleanup failed", { error: String(err) });
        });
      }, 60_000);
    }
  }

  async resolveInput(
    input: Record<string, unknown>,
    projectId?: string,
  ): Promise<Record<string, unknown>> {
    const accountDefaults = this.persist ? await getAllSettings() : {};
    const project = projectId && this.persist ? await getProject(projectId) : undefined;
    const projectVars = (project?.variables as Record<string, unknown>) ?? {};
    const projectPath = project?.path ? { cwd: project.path } : {};
    return { ...accountDefaults, ...projectPath, ...projectVars, ...input };
  }

  async runAgent(
    name: string,
    input: Record<string, unknown>,
    projectId?: string,
  ): Promise<AgentRun> {
    const agent = this.agents.get(name);
    if (!agent) throw new Error(`Agent not found: ${name}`);

    const resolvedInput = await this.resolveInput(input, projectId);

    const run: AgentRun = {
      id: crypto.randomUUID(),
      agentName: name,
      projectId,
      status: "running",
      startedAt: Date.now(),
      logs: [],
    };

    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    this.storeRun(run);

    if (this.persist) {
      await dbRuns.insertRun(run, projectId, input);
    }

    const appendLog = (message: string, level: LogLevel = "info"): void => {
      const entry: AgentLog = { timestamp: Date.now(), level, message };
      run.logs.push(entry);
      this.bus.emit("run:log", { runId: run.id, log: entry });
      if (this.persist) {
        dbRuns.insertLog(run.id, entry).catch((err) => {
          log.error("insertLog failed", { error: String(err) });
        });
      }
    };

    // Build a pi-ai-backed LLM wrapper for code-based agents
    const piLlm = {
      async complete(messages: any[], options?: any) {
        const resolved = await resolveModel(options?.provider, options?.model);
        const cred = await getCredential(resolved.provider);
        const context: Context = {
          systemPrompt: options?.system,
          messages: messages.map((m: any) => ({ role: m.role, content: m.content, timestamp: Date.now() })),
        };
        const result = await complete(resolved.piModel, context, { apiKey: cred.token });
        const text = result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        return { text, usage: { inputTokens: result.usage.input, outputTokens: result.usage.output } };
      },
      async *stream(messages: any[], options?: any) {
        const resolved = await resolveModel(options?.provider, options?.model);
        const cred = await getCredential(resolved.provider);
        const context: Context = {
          systemPrompt: options?.system,
          messages: messages.map((m: any) => ({ role: m.role, content: m.content, timestamp: Date.now() })),
        };
        const s = stream(resolved.piModel, context, { apiKey: cred.token, signal: options?.signal });
        for await (const event of s) {
          if (event.type === "text_delta") yield { type: "token", text: event.delta };
          if (event.type === "done") yield { type: "done", usage: { inputTokens: event.message.usage.input, outputTokens: event.message.usage.output } };
          if (event.type === "error") yield { type: "error", error: event.error.content?.map((c: any) => c.type === "text" ? c.text : "").join("") ?? "Stream error" };
        }
      },
    };

    const ctx: AgentContext = {
      input: resolvedInput,
      llm: piLlm as any,
      shell: this.shell,
      file: this.file,
      log: appendLog,
      signal: controller.signal,
      run: async (agentName, childInput) => {
        const childRun = await this.runAgent(agentName, childInput, projectId);
        return childRun.result ?? { success: false, output: null, error: "No result" };
      },
    };

    // Wire tools for code-based agents with extensions
    const agentConfigId = input.agentConfigId as string | undefined;
    if (agentConfigId) {
      try {
        const registry = ExtensionRegistry.getInstance();
        const extTools = await registry.getToolsForAgent(agentConfigId);
        if (extTools.length > 0) {
          const toolExec = new ToolExecutor(registry, { bus: this.bus });
          if (this._stateMediator) toolExec.setStateMediator(this._stateMediator);
          ctx.tools = toolExec.createToolsContext(run.id, run.id);
        }
      } catch {
        // Extension loading failure is non-fatal for code-based agents
      }
    }

    this.bus.emit("run:start", { run });

    try {
      const result = await agent.execute(ctx);
      run.status = "success";
      run.result = result;
      run.finishedAt = Date.now();
      this.bus.emit("run:complete", { run });
    } catch (err) {
      // Don't overwrite if already cancelled
      if (run.status !== "cancelled") {
        const message = err instanceof Error ? err.message : String(err);
        run.status = "error";
        run.result = { success: false, output: null, error: message };
        run.finishedAt = Date.now();
        this.bus.emit("run:error", { run, error: message });
      }
    } finally {
      this.controllers.delete(run.id);
      if (this.persist) {
        await dbRuns.updateRun(run);
      }
    }

    return run;
  }

  registerAgent(def: AgentDefinition): void {
    this.agents.set(def.name, def);
  }

  unregisterAgent(name: string): boolean {
    return this.agents.delete(name);
  }

  listAgents(): AgentDefinition[] {
    return [...this.agents.values()];
  }

  async listRuns(projectId?: string): Promise<AgentRun[]> {
    if (this.persist) {
      const dbResults = (await dbRuns.listRuns(projectId)).map(dbRuns.toAgentRun);
      const active = [...this.runs.values()].filter((r) => r.status === "running");
      const dbIds = new Set(dbResults.map((r) => r.id));
      const merged = [...dbResults];
      for (const r of active) {
        if (!dbIds.has(r.id)) merged.unshift(r);
      }
      return merged.sort((a, b) => b.startedAt - a.startedAt);
    }
    const all = [...this.runs.values()];
    if (projectId) return all.filter(() => false);
    return all.sort((a, b) => b.startedAt - a.startedAt);
  }

  async getRun(id: string): Promise<AgentRun | undefined> {
    const memRun = this.runs.get(id);
    if (memRun) return memRun;

    if (this.persist) {
      const dbRun = await dbRuns.getRunWithLogs(id);
      if (dbRun) return dbRuns.toAgentRun(dbRun);
    }
    return undefined;
  }

  getActiveRunForConversation(conversationId: string): AgentRun | undefined {
    for (const [runId, convId] of this.runConversations) {
      if (convId === conversationId) {
        const run = this.runs.get(runId);
        if (run && run.status === "running") return run;
      }
    }
    return undefined;
  }

  listActiveAgentRuns(projectId?: string): { run: AgentRun; conversationId: string }[] {
    const out: { run: AgentRun; conversationId: string }[] = [];
    for (const [runId, convId] of this.runConversations) {
      const run = this.runs.get(runId);
      if (!run || run.status !== "running") continue;
      if (projectId && run.projectId !== projectId) continue;
      out.push({ run, conversationId: convId });
    }
    return out.sort((a, b) => b.run.startedAt - a.run.startedAt);
  }

  getPendingPermissions(conversationId: string): PendingPermissionInfo[] {
    return [...this.pendingPermissions.values()].filter(p => p.conversationId === conversationId);
  }

  cancelRun(id: string): boolean {
    const run = this.runs.get(id);
    const controller = this.controllers.get(id);
    if (!run || !controller) return false;

    controller.abort();
    this.activeAgents.get(id)?.abort();
    run.status = "cancelled";
    run.finishedAt = Date.now();
    const conversationId = this.runConversations.get(id);
    this.bus.emit("run:cancel", { run, conversationId });
    return true;
  }

  /** Bump the last-activity timestamp for a run. Called on every real progress signal
   *  (token, tool start/complete/error, agent spawn/complete, turn boundaries). The watchdog
   *  uses this to distinguish "actually working" from "leaked promise that keeps the run alive". */
  private bumpActivity(runId: string): void {
    this.lastActivityAt.set(runId, Date.now());
  }

  /** Start the activity-based watchdog for a run. Replaces the old setInterval-based heartbeat.
   *  Ticks every WATCHDOG_TICK_MS. If idle > WATCHDOG_IDLE_MS (with no pending permission),
   *  marks the run interrupted in the DB and emits run:error. Otherwise refreshes
   *  active_runs.last_heartbeat at most once per HEARTBEAT_REFRESH_MS and optionally writes
   *  the latest partial response. */
  private startWatchdog(
    runId: string,
    conversationId: string,
    getPartialResponse: () => string,
  ): void {
    if (!this.persist) return;
    this.bumpActivity(runId);
    this.lastHeartbeatWriteAt.set(runId, Date.now());
    const tick = async () => {
      const run = this.runs.get(runId);
      if (!run || run.status !== "running") return;
      const last = this.lastActivityAt.get(runId) ?? run.startedAt;
      const idleMs = Date.now() - last;
      const hasPendingPermission = [...this.pendingPermissions.values()].some(
        (p) => p.conversationId === conversationId,
      );
      if (hasPendingPermission) {
        // Permission gates are legitimate idle — keep the run alive and don't count as stuck.
        this.bumpActivity(runId);
        await activeRunsDb.updateHeartbeat(runId).catch(() => {});
        this.lastHeartbeatWriteAt.set(runId, Date.now());
        return;
      }
      if (idleMs >= WATCHDOG_IDLE_MS) {
        const reason = `Watchdog: no activity for ${Math.round(idleMs / 1000)}s`;
        log.error("Watchdog tripped, interrupting run", { runId, conversationId, idleMs });
        try {
          await activeRunsDb.markInterrupted(runId);
        } catch (err) {
          log.error("Watchdog markInterrupted failed", { error: String(err) });
        }
        run.status = "error";
        run.result = { success: false, output: null, error: reason };
        run.finishedAt = Date.now();
        this.bus.emit("run:error", { run, error: reason, conversationId });
        // Abort the in-memory controller so any remaining awaits unblock.
        const controller = this.controllers.get(runId);
        if (controller && !controller.signal.aborted) controller.abort();
        this.activeAgents.get(runId)?.abort();
        return;
      }
      // Still making progress — refresh heartbeat + partial response at the throttled cadence.
      const lastWrite = this.lastHeartbeatWriteAt.get(runId) ?? 0;
      if (Date.now() - lastWrite >= HEARTBEAT_REFRESH_MS) {
        await activeRunsDb.updateHeartbeat(runId).catch(() => {});
        const partial = getPartialResponse();
        if (partial) {
          await activeRunsDb.updatePartialResponse(runId, partial).catch(() => {});
        }
        this.lastHeartbeatWriteAt.set(runId, Date.now());
      }
    };
    const timer = setInterval(() => {
      tick().catch((err) => log.error("Watchdog tick failed", { runId, error: String(err) }));
    }, WATCHDOG_TICK_MS);
    this.heartbeats.set(runId, timer);
  }

  async streamChat(
    conversationId: string,
    userMessage: string,
    options: { projectId?: string; provider?: string; model?: string; system?: string; runId?: string; parentMessageId?: string; agentConfigId?: string; permissionMode?: import("./tools/types").PermissionMode; thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"; modeId?: string; orchestrationDepth?: number; toolRestriction?: "all" | "read-only" | "none"; allowedTools?: string[]; deniedTools?: string[]; memberOverrides?: Map<string, import("../types").TeamMemberOverrides>; subAgentMembers?: import("../types").TeamMember[]; attachments?: import("../chat/attachments/content-builder").StagedAttachment[]; commandResolver?: import("./mention-wiring").CommandResolver },
  ): Promise<AgentRun> {
    const run: AgentRun = {
      id: options.runId ?? crypto.randomUUID(),
      agentName: "chat",
      projectId: options.projectId,
      status: "running",
      startedAt: Date.now(),
      logs: [],
    };

    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    this.storeRun(run);
    this.runConversations.set(run.id, conversationId);

    if (this.persist) {
      await dbRuns.insertRun(run, options.projectId);
    }

    this.bus.emit("run:start", { run });
    this.bus.emit("run:status", { runId: run.id, status: "Loading conversation history..." });

    // Persist active run to DB for crash recovery (fire-and-forget — not on critical path)
    if (this.persist) {
      activeRunsDb.createActiveRun(run.id, conversationId).catch(err => {
        log.error("createActiveRun failed", { error: String(err) });
      });
    }

    // Top-level safety net: ensures run:error is emitted and active_run is cleaned up
    // for ANY error (e.g. credential failures that happen before the inner try-catch).
    try {

    // Load history and resolve system prompt in parallel (they're independent)
    const [branchMessages, resolvedSystem] = await Promise.all([
      // Gather branch-aware conversation history
      (async () => {
        if (options.parentMessageId) {
          return getConversationPath(options.parentMessageId, conversationId);
        }
        const leaf = await getLatestLeaf(conversationId);
        return leaf ? getConversationPath(leaf.id, conversationId) : [];
      })(),
      // Resolve system prompt (conversation > project > global)
      (async () => {
        if (options.system) return options.system;
        if (options.projectId) return resolveSystemPrompt(conversationId, options.projectId, options.modeId);
        return undefined;
      })(),
    ]);

    // Rehydrate past-turn attachments into history so images uploaded on
    // earlier turns (and their `ez-attachment://` handles) remain visible +
    // resolvable on the current turn. Server-only code path — storagePath
    // never leaks past the pi-ai call below.
    const { loadPastAttachments, rehydrateUserMessageContent } =
      await import("../chat/attachments/history-rehydrate");
    const pastCaps = options.provider && options.model
      ? (await import("../providers/model-capabilities")).getCapabilities(options.provider, options.model)
      : null;
    const { byMessage: pastByMessage, all: allPastAttachments } = pastCaps
      ? await loadPastAttachments(branchMessages).catch(() => ({ byMessage: new Map(), all: [] }))
      : { byMessage: new Map(), all: [] };

    const history: Message[] = await Promise.all(branchMessages.map(async (m): Promise<Message> => {
      if (m.role === "assistant") {
        return {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: m.content }],
          api: "unknown" as any,
          provider: "unknown",
          model: "unknown",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        } satisfies AssistantMessage;
      }
      const attsForMsg = pastByMessage.get(m.id) ?? [];
      const content = pastCaps
        ? await rehydrateUserMessageContent(m.content, attsForMsg, pastCaps)
        : m.content;
      return {
        role: "user" as const,
        content,
        timestamp: Date.now(),
      } satisfies UserMessage;
    }));

    let system = resolvedSystem;

    // ── Credential context: sub-conversations inherit parent's credentials ──
    const convRecord = await getConversation(conversationId);
    const credentialConversationId = convRecord?.parentConversationId ?? conversationId;

    // ── Parallel setup: memory/KB, tools, model resolution all run concurrently ──
    this.bus.emit("run:status", { runId: run.id, status: "Preparing..." });

    let agentTools: AgentTool[] = [];
    const toolAbortControllers = new Map<string, AbortController>();

    // Build the attachment-handle resolver for this turn. The content-builder
    // emits `ez-attachment://<id>` handles in the LLM-visible text; when the
    // LLM echoes them back in tool args, this resolver substitutes the real
    // `data:<mime>;base64,<bytes>` URI before the extension subprocess sees
    // them. Includes BOTH this turn's staged attachments AND all attachments
    // from earlier user messages in the branch, so handles emitted on any
    // prior turn remain resolvable in a later tool call.
    const attachmentArgsResolver = await (async () => {
      const currentTurn = options.attachments ?? [];
      if (currentTurn.length === 0 && allPastAttachments.length === 0) return null;
      const { buildAttachmentHandleResolver, toResolvableAttachments } =
        await import("../chat/attachments/handle-resolver");
      // Dedupe by id so we don't double-read bytes when the current turn's
      // attachment is also present in history (can happen if the caller
      // resends the same files verbatim).
      const byId = new Map<string, typeof allPastAttachments[number]>();
      for (const a of allPastAttachments) byId.set(a.id, a);
      for (const a of currentTurn) byId.set(a.id, a);
      return buildAttachmentHandleResolver(toResolvableAttachments(Array.from(byId.values())));
    })();
    let builtinToolDefsMap = new Map<string, import("./tools/types").BuiltinToolDef>();
    let unsubModeChange: (() => void) | undefined;

    const [, , resolvedModel] = await Promise.all([
      // 1. Memory/KB injection (non-fatal) — skip entirely if project has no data
      (async () => {
        if (!options.projectId) return;
        try {
          // Fast-path: skip expensive embedding if project has no memories or KB
          let hasMem = true, hasKB = true; // default to true (assume data exists) if check fails
          try {
            const [{ hasMemories }, { hasKBChunks }] = await Promise.all([
              import("../db/queries/memories"),
              import("../db/queries/knowledge-base"),
            ]);
            [hasMem, hasKB] = await Promise.all([
              hasMemories(options.projectId!),
              hasKBChunks(options.projectId!),
            ]);
          } catch { /* check failed — proceed with full pipeline */ }
          if (!hasMem && !hasKB) return; // No data to search — skip embedding entirely

          const { generateEmbedding } = await import("../memory/embeddings");
          const queryEmbedding = await generateEmbedding(userMessage, (status) => {
            this.bus.emit("run:status", { runId: run.id, status });
          });
          const [injectionModule, kbChunks] = await Promise.all([
            import("../memory/injection"),
            (async (): Promise<any[] | undefined> => {
              if (!hasKB) return undefined;
              try {
                const { searchKBChunksForQuery } = await import("../memory/retrieval");
                return await searchKBChunksForQuery(userMessage, queryEmbedding, options.projectId!, 5);
              } catch { return undefined; }
            })(),
          ]);
          const injection = await injectionModule.buildSystemPromptWithMemories(system, userMessage, options.projectId!, { kbChunks, queryEmbedding });
          system = injection.systemPrompt;
          if (injection.memoriesUsed.length > 0) run.memoriesUsed = injection.memoriesUsed;
        } catch {
          this.bus.emit("run:status", {
            runId: run.id, status: "memory_unavailable", degraded: true,
            message: "Memory is currently unavailable. Responses won't include past context.",
          } as any);
        }
      })(),

      // 2. Tool loading (builtin + extensions + mentions — all non-fatal)
      (async () => {
        // 2a. Built-in project file tools
        if (options.projectId) {
          try {
            const project = await getProject(options.projectId);
            if (project?.path) {
              const { getBuiltinToolDefs } = await import("./tools");
              const { needsApproval, getPermissionMode, createPermissionGate } = await import("./tools/permissions");
              const toolDefs = getBuiltinToolDefs(project.path);
              for (const def of toolDefs) builtinToolDefsMap.set(def.name, def);
              const projectId = options.projectId;

              // Bus-driven override — only set when user explicitly switches mode mid-run
              let busOverrideMode: import("./tools/permissions").PermissionMode | undefined;
              // Pre-cache permission mode to avoid DB hit on every tool call
              getPermissionMode(projectId).then(mode => {
                if (!busOverrideMode) busOverrideMode = mode;
              }).catch(() => {});
              unsubModeChange = this.bus.on("tool:permission_mode_change" as any, (data: any) => {
                if (data.conversationId === conversationId) busOverrideMode = data.mode;
              });

              const wrappedTools: AgentTool[] = toolDefs.map((def) => ({
                name: def.name, label: def.label, description: def.description, parameters: def.parameters,
                execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
                  const toolController = new AbortController();
                  toolAbortControllers.set(toolCallId, toolController);
                  const combinedSignal = signal ? AbortSignal.any([signal, toolController.signal]) : toolController.signal;
                  try {
                    const permissionMode = options.permissionMode ?? busOverrideMode ?? await getPermissionMode(projectId);
                    if (needsApproval(def.category, permissionMode)) {
                      const permInfo: PendingPermissionInfo = {
                        conversationId, toolCallId, toolName: def.name,
                        input: params, cardType: def.cardType, category: def.category,
                      };
                      this.pendingPermissions.set(toolCallId, permInfo);
                      this.bus.emit("tool:permission_request", {
                        conversationId, toolCallId, toolName: def.name,
                        input: params, cardType: def.cardType, category: def.category,
                      });
                      try { await createPermissionGate(toolCallId, conversationId); }
                      catch { return { content: [{ type: "text" as const, text: "Permission denied by user" }], details: { isError: true } }; }
                      finally { this.pendingPermissions.delete(toolCallId); }
                    }
                    return await def.execute(toolCallId, params, combinedSignal, onUpdate);
                  } finally { toolAbortControllers.delete(toolCallId); }
                },
              }));
              agentTools.push(...wrappedTools);
            }
          } catch { /* Built-in tool loading failure is non-fatal */ }
        }

        // 2b. Extension tools
        if (options.agentConfigId) {
          try {
            const registry = ExtensionRegistry.getInstance();
            const extTools = await registry.getToolsForAgent(options.agentConfigId);
            if (extTools.length > 0) {
              const toolExec = new ToolExecutor(registry, { bus: this.bus });
              if (this._stateMediator) toolExec.setStateMediator(this._stateMediator);
              toolExec.setExecutor(this);
              toolExec.setSpawnQuota(this._spawnQuota);
              if (attachmentArgsResolver) toolExec.setArgsResolver(attachmentArgsResolver);
              // Thread the conversation owner's id into the tool executor
              // so bundled extensions (ai-kit) can act on-behalf-of the
              // real user when they call back into this server.
              if (convRecord?.userId) toolExec.setCurrentUserId(convRecord.userId);
              // Thread the model + provider so sibling chats spawned by
              // ai-kit inherit them. PREFER `options.model` (the model
              // the user picked in the UI for THIS turn) over
              // `convRecord.model` (the conversation's stored default at
              // creation time). The UI's model picker updates per-turn,
              // not on the conversation row, so falling back to
              // convRecord would send stale values.
              toolExec.setCurrentModel(options.model ?? convRecord?.model);
              toolExec.setCurrentProvider(options.provider ?? convRecord?.provider);
              toolExec.setCurrentAgentConfigId(options.agentConfigId ?? convRecord?.agentConfigId);
              try {
                const { checkSensitiveConfirmation } = await import("../extensions/permissions");
                toolExec.setPermissionChecker(async (extensionId, _toolName, _input) => {
                  const shellCheck = await checkSensitiveConfirmation(extensionId, "shell");
                  const fsCheck = await checkSensitiveConfirmation(extensionId, "filesystem");
                  return shellCheck === "allowed" && fsCheck === "allowed";
                });
              } catch { /* permissions.ts not available yet */ }
              agentTools = extTools.map((t) => extensionToAgentTool(
                { name: t.name, description: t.description, inputSchema: t.inputSchema },
                toolExec, conversationId, run.id,
              ));
            }
          } catch { /* Extension loading failure is non-fatal */ }
        }

        // 2c. Mentioned extensions
        try {
          const { wireMentionedExtensions } = await import("./mention-wiring");
          const { getConversationExtensionIds } = await import("../db/queries/conversation-extensions");
          // Phase 3 intended task-tracking as wire-on-first-use, but its
          // `/api/tool-invoke` hook only fires for MANUAL UI tool clicks —
          // LLM-driven tool calls go through the in-process agentTools
          // pipeline instead. Without this the LLM never sees task_plan /
          // task_add / task_list and can't plan tasks when asked to. Match
          // the orchestration extension's auto-wire pattern at line 787 so
          // path 3 below picks up the 12 task tools for every turn.
          try {
            const { ensureTaskTrackingWired } = await import("./task-tracking-host");
            await ensureTaskTrackingWired(conversationId);
          } catch (taskWireErr) {
            log.warn("Task-tracking wire failed — task tools unavailable this turn", {
              error: String(taskWireErr),
            });
          }
          await wireMentionedExtensions(conversationId, userMessage, options.parentMessageId ?? run.id);
          const convExtIds = await getConversationExtensionIds(conversationId);
          if (convExtIds.length > 0) {
            const registry = ExtensionRegistry.getInstance();
            const toolExec = new ToolExecutor(registry, { bus: this.bus });
            if (this._stateMediator) toolExec.setStateMediator(this._stateMediator);
            toolExec.setExecutor(this);
            toolExec.setSpawnQuota(this._spawnQuota);
            if (attachmentArgsResolver) toolExec.setArgsResolver(attachmentArgsResolver);
            // See comment above — ai-kit and friends need the conversation
            // owner's id to create rows on their behalf, plus the CURRENT
            // TURN's model + provider (options.*, falling back to the
            // conversation default) so sibling chats inherit the user's
            // active selection.
            if (convRecord?.userId) toolExec.setCurrentUserId(convRecord.userId);
            toolExec.setCurrentModel(options.model ?? convRecord?.model);
            toolExec.setCurrentProvider(options.provider ?? convRecord?.provider);
            toolExec.setCurrentAgentConfigId(options.agentConfigId ?? convRecord?.agentConfigId);
            for (const extId of convExtIds) {
              for (const t of registry.getToolsForExtension(extId)) {
                if (!agentTools.some(at => at.name === t.name)) {
                  agentTools.push(extensionToAgentTool(
                    { name: t.name, description: t.description, inputSchema: t.inputSchema },
                    toolExec, conversationId, run.id,
                  ));
                }
              }
            }
          }
        } catch { /* Dynamic tool wiring failure is non-fatal */ }

        // 2d. Multi-agent orchestration: resolve mentions, auto-wire references, inject tools
        // NOTE: system prompt injection is deferred until after Promise.all to avoid race with memory injection
        try {
          const depth = options.orchestrationDepth ?? 0;
          const MAX_ORCHESTRATION_DEPTH = 3;

          if (depth < MAX_ORCHESTRATION_DEPTH && options.projectId) {
            const { resolveMentionedAgents, resolveMentionedTeams } = await import("./mention-wiring");
            const allAvailableAgents: Array<{ id: string; name: string; description: string }> = [];
            const seenIds = new Set<string>();

            // 2d-i. Resolve @agent mentions
            const mentionedAgents = await resolveMentionedAgents(userMessage);
            for (const a of mentionedAgents) {
              if (!seenIds.has(a.id)) { seenIds.add(a.id); allAvailableAgents.push(a); }
            }

            // 2d-ii. Resolve ![team:…] mentions → store team info for prompt injection
            // Only resolve team mentions at depth 0 — sub-conversations must NOT re-expand the
            // parent's team mention, otherwise auto-spin-up causes exponential recursive spawning
            // (each sub-agent sees ![team:...] in the task, resolves it, spins up all members again).
            const mentionedTeams = depth === 0
              ? await resolveMentionedTeams(userMessage)
              : [];
            for (const t of mentionedTeams) {
              for (const m of t.members) {
                if (!seenIds.has(m.id)) { seenIds.add(m.id); allAvailableAgents.push(m); }
              }
            }

            // 2d-iii. Auto-wire references.agents from agent config (teams & supervisor agents)
            // If subAgentMembers is provided (nested invocation), use it directly
            if (options.subAgentMembers?.length) {
              try {
                const { getAgentConfig } = await import("../db/queries/agent-configs");
                await Promise.all(options.subAgentMembers.map(async (member) => {
                  if (seenIds.has(member.agentConfigId)) return;
                  const cfg = await getAgentConfig(member.agentConfigId);
                  if (cfg) {
                    seenIds.add(cfg.id);
                    allAvailableAgents.push({ id: cfg.id, name: cfg.name, description: cfg.description });
                  } else {
                    log.warn(`Sub-agent member ${member.agentConfigId} not found in DB — skipped`);
                  }
                }));
              } catch { /* Sub-agent member wiring failure is non-fatal */ }
            } else if (options.agentConfigId) {
              try {
                const { getAgentConfig } = await import("../db/queries/agent-configs");
                const config = await getAgentConfig(options.agentConfigId);
                const refs = config?.references as { agents?: string[]; extensions?: string[]; members?: import("../types").TeamMember[]; autoSpinUp?: boolean; teamToolScope?: import("../types").TeamToolScope } | null;
                if (refs?.agents?.length) {
                  await Promise.all(refs.agents.map(async (agentId) => {
                    if (seenIds.has(agentId)) return;
                    const member = await getAgentConfig(agentId);
                    if (member) {
                      seenIds.add(member.id);
                      allAvailableAgents.push({ id: member.id, name: member.name, description: member.description });
                    }
                  }));
                  // If config is a team, store for team prompt injection
                  if (config?.category === "team" && mentionedTeams.length === 0) {
                    (run as any)._teamConfig = { name: config.name, prompt: config.prompt, autoSpinUp: refs?.autoSpinUp ?? false };
                  }
                }
                // Build memberOverrides from team config members
                if (refs?.members?.length) {
                  const overridesMap = new Map<string, import("../types").TeamMemberOverrides>();
                  for (const m of refs.members) {
                    if (m.overrides) overridesMap.set(m.agentConfigId, m.overrides);
                  }
                  if (overridesMap.size > 0) {
                    (run as any)._memberOverrides = overridesMap;
                    (run as any)._subAgentMembers = refs.members;
                  }
                }
                // Team-level tool scope (overrides per-member tool lists)
                const scope = refs?.teamToolScope;
                if (scope && ((scope.allowedTools?.length ?? 0) > 0 || (scope.deniedTools?.length ?? 0) > 0)) {
                  (run as any)._teamToolScope = scope;
                }
              } catch { /* Agent config ref wiring failure is non-fatal */ }
            }

            log.info("Agent orchestration resolution", {
              userMessage: userMessage.slice(0, 100),
              agents: allAvailableAgents.map(a => a.name),
              teams: mentionedTeams.map(t => t.team.name),
              depth,
            });

            if (allAvailableAgents.length > 0) {
              // Resolve memberOverrides: from options (nested call) or from team config refs
              const resolvedMemberOverrides = options.memberOverrides ?? (run as any)._memberOverrides as Map<string, import("../types").TeamMemberOverrides> | undefined;
              const resolvedSubAgentMembers = options.subAgentMembers ?? (run as any)._subAgentMembers as import("../types").TeamMember[] | undefined;
              // Team-level tool scope — from team-mention (depth 0) or from team config refs.
              // Cascades to all invoked sub-members, overriding any per-member tool lists.
              const firstMentionedTeam = mentionedTeams[0];
              const resolvedTeamToolScope =
                firstMentionedTeam?.team.teamToolScope
                ?? (run as any)._teamToolScope as import("../types").TeamToolScope | undefined;

              // Orchestration extension (Phase 4 commit-5): wire-on-first-use for
              // invoke_agent. The legacy built-in was deleted; the same tool
              // surface is now served by the bundled `orchestration` extension
              // (docs/extensions/examples/orchestration/). Mirrors the Phase 3
              // `ensureTaskTrackingWired` pattern.
              try {
                const { ensureOrchestrationWired, wireOrchestrationToolsForTurn } =
                  await import("./orchestration-host");
                const wired = await ensureOrchestrationWired(conversationId);
                if (wired) {
                  await wireOrchestrationToolsForTurn({
                    agentTools,
                    conversationId,
                    runId: run.id,
                    availableAgents: allAvailableAgents,
                    parentModel: options.model,
                    parentProvider: options.provider,
                    parentMessageId: options.parentMessageId,
                    depth,
                    memberOverrides: resolvedMemberOverrides
                      ? Object.fromEntries(resolvedMemberOverrides)
                      : undefined,
                    subAgentMembers: resolvedSubAgentMembers,
                    teamToolScope: resolvedTeamToolScope,
                    registry: ExtensionRegistry.getInstance(),
                    executor: this,
                    stateMediator: this._stateMediator,
                    spawnQuota: this._spawnQuota,
                    userId: convRecord?.userId ?? undefined,
                  });
                }
              } catch (orchWireErr) {
                log.warn("Orchestration extension wire failed — agent orchestration unavailable this turn", {
                  error: String(orchWireErr),
                });
              }
              if (resolvedTeamToolScope) {
                (run as any)._teamToolScope = resolvedTeamToolScope;
              }

              // Phase 5 commit 4: ask_human is now wired alongside
              // invoke_agent inside `wireOrchestrationToolsForTurn`
              // above — the legacy ask-human built-in factory was
              // deleted with this commit. See
              // `src/runtime/orchestration-host.ts` for the injection
              // and `docs/extensions/examples/orchestration/` for the
              // handler + subscription.

              // Auto-wire the bundled `scratchpad` extension for this
              // conversation. Fail-closed on three independent gates (S7):
              //   (1) extension row exists — required so the DB-backed
              //       grant is discoverable;
              //   (2) extension is enabled — operator/admin may have
              //       disabled it through the admin UI or failure-counter;
              //   (3) `storage` permission is granted — required by
              //       src/extensions/storage-handler.ts:117 on every
              //       write/read, so without it the tools would be
              //       visible-but-useless.
              // Any gate miss → log + skip. Tools simply don't appear
              // in this turn's toolset; nothing breaks.
              try {
                const { getExtensionByName } = await import("../db/queries/extensions");
                const scratchpadExt = await getExtensionByName("scratchpad");
                const storageGranted = (scratchpadExt?.grantedPermissions as { storage?: boolean } | undefined)?.storage === true;
                if (!scratchpadExt || !scratchpadExt.enabled || !storageGranted) {
                  log.info("Scratchpad auto-wire skipped: not enabled or storage not granted", {
                    exists: !!scratchpadExt,
                    enabled: scratchpadExt?.enabled ?? false,
                    storageGranted,
                  });
                } else {
                  const { addConversationExtensions } = await import("../db/queries/conversation-extensions");
                  await addConversationExtensions(conversationId, [{ extensionId: scratchpadExt.id }]);
                  const registry = ExtensionRegistry.getInstance();
                  const toolExec = new ToolExecutor(registry, { bus: this.bus });
                  if (this._stateMediator) toolExec.setStateMediator(this._stateMediator);
                  toolExec.setExecutor(this);
                  toolExec.setSpawnQuota(this._spawnQuota);
                  if (attachmentArgsResolver) toolExec.setArgsResolver(attachmentArgsResolver);
                  if (convRecord?.userId) toolExec.setCurrentUserId(convRecord.userId);
                  toolExec.setCurrentModel(options.model ?? convRecord?.model);
                  toolExec.setCurrentProvider(options.provider ?? convRecord?.provider);
                  toolExec.setCurrentAgentConfigId(options.agentConfigId ?? convRecord?.agentConfigId);
                  for (const t of registry.getToolsForExtension(scratchpadExt.id)) {
                    if (!agentTools.some(at => at.name === t.name)) {
                      agentTools.push(extensionToAgentTool(
                        { name: t.name, description: t.description, inputSchema: t.inputSchema },
                        toolExec, conversationId, run.id,
                      ));
                    }
                  }
                }
              } catch (scratchpadWireErr) {
                log.warn("Scratchpad auto-wire failed — proceeding without it", { error: String(scratchpadWireErr) });
              }

              // Store metadata for system prompt injection after Promise.all
              (run as any)._mentionedAgents = allAvailableAgents;
              const firstTeam = mentionedTeams[0];
              if (firstTeam) {
                (run as any)._teamConfig = { name: firstTeam.team.name, prompt: firstTeam.team.prompt, autoSpinUp: firstTeam.team.autoSpinUp };
              }
              log.info("Injected orchestration tools", { agents: allAvailableAgents.map(a => a.name), toolCount: agentTools.length });

              // Store flag for auto-spin-up (executed after Promise.all to avoid blocking tool loading)
              if (((run as any)._teamConfig as any)?.autoSpinUp) {
                (run as any)._pendingAutoSpinUp = true;
              }
            }
          }
        } catch (agentWireErr) {
          log.error("Agent orchestration wiring failed", { error: String(agentWireErr), stack: agentWireErr instanceof Error ? agentWireErr.stack : undefined });
        }

        // Phase 3 commit-5: task-tracking moved to a bundled extension.
        // Tools flow through the ExtensionRegistry path like every other
        // extension; wire-on-first-use is handled by
        // task-tracking-host.ensureTaskTrackingWired at the tool-invoke
        // boundary, so no per-streamChat wiring needed here.
      })(),

      // 3. Model resolution + credential pre-validation (runs in parallel with 1 & 2)
      (async () => {
        const r = await resolveModel(options.provider, options.model);
        run.provider = r.provider;
        const cred = await getCredential(r.provider, credentialConversationId);
        return { resolved: r, initialCred: cred };
      })(),
    ]);

    // Auto-spin-up: pre-invoke all members AFTER Promise.all (model is resolved, tools are ready)
    // Lifted here (from ~line 958 below) so the watchdog closure can read the latest partial
    // response during long-running turns. Mutated by the piAgent.subscribe message_update handler.
    let allTurnsText = "";

    // Start the activity-based watchdog. Replaces the dumb setInterval heartbeat — it only
    // refreshes last_heartbeat while progress signals are bumping activity, and auto-cancels
    // the run if it stays idle for WATCHDOG_IDLE_MS (90s) with no pending permission.
    this.startWatchdog(run.id, conversationId, () => allTurnsText);

    const pendingAutoSpinUp = (run as any)._pendingAutoSpinUp;
    const mentionedAgents = (run as any)._mentionedAgents as Array<{ name: string; id: string; description: string }> | undefined;
    const teamConfig = (run as any)._teamConfig as { name: string; prompt: string; autoSpinUp?: boolean } | undefined;
    let autoSpinUpResults: Array<{ name: string; output: string }> | undefined;

    if (pendingAutoSpinUp && mentionedAgents?.length) {
      const invokeAgentTool = agentTools.find(t => t.name === "invoke_agent");
      if (invokeAgentTool) {
        try {
          log.info("Auto-spin-up: pre-invoking all members", { members: mentionedAgents.map(a => a.name) });
          this.bus.emit("run:status", { runId: run.id, status: "Auto-invoking all team members..." });
          const spinResults = await Promise.allSettled(
            mentionedAgents.map(agent =>
              invokeAgentTool.execute(crypto.randomUUID(), { agentConfigId: agent.id, task: userMessage }, controller.signal)
            )
          );
          autoSpinUpResults = [];
          spinResults.forEach((r, i) => {
            const agentName = mentionedAgents[i]?.name ?? "Unknown";
            if (r.status === "fulfilled") {
              autoSpinUpResults!.push({ name: agentName, output: (r.value as any)?.content?.[0]?.text ?? "" });
            } else {
              log.error("Auto-spin-up agent failed", { agentName, error: String(r.reason) });
              autoSpinUpResults!.push({ name: agentName, output: `[Error: ${r.reason?.message ?? "Unknown error"}]` });
            }
          });
          log.info("Auto-spin-up complete", { resultCount: autoSpinUpResults.length });
        } catch (spinErr) {
          log.error("Auto-spin-up failed", { error: String(spinErr), stack: spinErr instanceof Error ? spinErr.stack : undefined });
        }
      }
      delete (run as any)._pendingAutoSpinUp;
    }

    // Inject orchestrator prompt AFTER auto-spin-up (results available for prompt)
    if (mentionedAgents && mentionedAgents.length > 0) {
      const { buildOrchestratorPrompt, buildTeamOrchestratorPrompt } = await import("./orchestrator-prompt");
      const teamToolScopeForPrompt = (run as any)._teamToolScope as import("../types").TeamToolScope | undefined;
      const orchestratorBlock = teamConfig
        ? buildTeamOrchestratorPrompt(teamConfig.name, teamConfig.prompt, mentionedAgents, autoSpinUpResults, teamToolScopeForPrompt)
        : buildOrchestratorPrompt(mentionedAgents);
      system = system ? `${orchestratorBlock}\n\n${system}` : orchestratorBlock;
      delete (run as any)._mentionedAgents;
      delete (run as any)._teamConfig;
      delete (run as any)._memberOverrides;
      delete (run as any)._subAgentMembers;
      delete (run as any)._teamToolScope;
    } else {
      // Non-orchestrator runs: still inject task tracking instructions so single agents
      // can decompose complex work into visible tasks.
      try {
        const { buildTaskTrackingInstructions } = await import("./orchestrator-prompt");
        const taskBlock = buildTaskTrackingInstructions();
        system = system ? `${system}\n\n${taskBlock}` : taskBlock;
      } catch { /* non-fatal */ }
    }

    // Apply mode tool restrictions (filter tools by category)
    const { applyToolFilters } = await import("./tools/filter");
    if (options.modeId) {
      try {
        const { getMode } = await import("../db/queries/modes");
        const mode = await getMode(options.modeId);
        if (mode?.toolRestriction) {
          agentTools = applyToolFilters(agentTools, builtinToolDefsMap, {
            toolRestriction: mode.toolRestriction,
          });
        }
      } catch { /* Mode lookup failure is non-fatal — keep all tools */ }
    }

    // Apply invocation-level scoping (member override restriction + team-level
    // allow/deny). Takes precedence over mode restriction. allowedTools /
    // deniedTools carry the team-level TeamToolScope when set.
    if (options.toolRestriction || options.allowedTools?.length || options.deniedTools?.length) {
      agentTools = applyToolFilters(agentTools, builtinToolDefsMap, {
        toolRestriction: options.toolRestriction,
        allowedTools: options.allowedTools,
        deniedTools: options.deniedTools,
      });
    }

    // Wire tool:kill handler to abort running tools
    const unsubKill = this.bus.on("tool:kill", ({ toolCallId }) => {
      const ctrl = toolAbortControllers.get(toolCallId);
      if (ctrl) ctrl.abort();
    });

    // Unpack model resolution results
    const resolved = resolvedModel!.resolved;
    const initialCred = resolvedModel!.initialCred;

    // When using OAuth, the standard API endpoints (google-generative-ai, openai-responses)
    // use API key auth which is incompatible with OAuth tokens. Resolve the actual
    // OAuth-compatible Model object so the correct API + endpoint + metadata is used.
    let model = resolved.piModel;
    if (initialCred.type === "oauth") {
      const oauthModel = resolveOAuthModel(resolved.provider, model.id);
      if (oauthModel) {
        // Keep the original provider name so credential lookups (getApiKey callback)
        // resolve against "openai"/"google", not "openai-codex"/"google-gemini-cli"
        model = { ...oauthModel, provider: resolved.provider as any };
      } else if (resolved.provider === "google" || resolved.provider === "openai") {
        throw new Error(
          `Model "${model.id}" is not supported with ${resolved.provider} OAuth. ` +
          `Only subscription-eligible models are available with OAuth authentication.`,
        );
      }
    }

    const piAgent = new Agent({
      initialState: {
        systemPrompt: system ?? "",
        model,
        tools: agentTools,
        messages: history,
        thinkingLevel: options.thinkingLevel ?? (model.reasoning ? "medium" : "off"),
      },
      convertToLlm: (messages) => {
        return messages.filter((m) =>
          "role" in m && (m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
        ) as Message[];
      },
      getApiKey: async (provider) => {
        const freshCred = await getCredential(provider, credentialConversationId);
        return freshCred.token;
      },
      onPayload: async (body: any) => {
        // Force reasoning summaries so thinking text is visible to the user
        if (body?.reasoning && body.reasoning.summary === "auto") {
          body.reasoning.summary = "detailed";
        }
        return body;
      },
    });

    this.activeAgents.set(run.id, piAgent);

    let turnText = "";           // current turn only (for cancel fallback)
    let turnThinking = "";       // thinking content for current turn
    // allTurnsText is declared earlier (near the watchdog start) so its closure can
    // read partial responses for crash recovery. We only reset it here for clarity.
    allTurnsText = "";
    let lastSavedMessageId: string | null = options.parentMessageId ?? null;
    let turnHasToolCalls = false;
    const turnStart = Date.now();
    let totalUsage: Usage = {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    // Serialize async DB operations from the sync subscribe callback
    let dbQueue = Promise.resolve();
    const queueDb = (fn: () => Promise<void>) => {
      dbQueue = dbQueue.then(fn).catch(err => log.error("DB error", { error: String(err) }));
    };

    // Subscribe to AgentEvents and bridge to local EventBus
    const pendingToolArgs = new Map<string, Record<string, unknown>>();
    const unsub = piAgent.subscribe((event: AgentEvent) => {
      // Any pi-agent-core event counts as progress for the watchdog — LLM is actively producing output.
      this.bumpActivity(run.id);
      switch (event.type) {
        case "turn_start":
          turnText = "";
          turnThinking = "";
          turnHasToolCalls = false;
          this.bus.emit("run:status", { runId: run.id, status: "Thinking..." });
          break;
        case "message_update": {
          const ame = event.assistantMessageEvent;
          if (ame.type === "text_delta") {
            turnText += ame.delta;
            allTurnsText += ame.delta;
            this.bus.emit("run:token", { runId: run.id, token: ame.delta, kind: "text" });
          } else if (ame.type === "thinking_delta") {
            turnThinking += ame.delta;
            this.bus.emit("run:token", { runId: run.id, token: ame.delta, kind: "thinking" });
          }
          break;
        }
        case "tool_execution_start": {
          turnHasToolCalls = true;
          const args = (event.args ?? {}) as Record<string, unknown>;
          pendingToolArgs.set(event.toolCallId, args);
          // invoke_agent has its own agent:spawn/agent:complete events — skip tool:start
          if (event.toolName === "invoke_agent") break;
          // Build descriptive status from tool name + primary arg
          const primaryArg = args.file_path ?? args.path ?? args.pattern ?? args.command ?? args.query ?? args.url;
          const statusDetail = primaryArg ? `: ${String(primaryArg).slice(0, 60)}` : '';
          this.bus.emit("run:status", { runId: run.id, status: `Running ${event.toolName}${statusDetail}...` });
          const toolDef = builtinToolDefsMap.get(event.toolName);
          this.bus.emit("tool:start", {
            conversationId, extensionId: "", toolName: event.toolName,
            input: event.args, timestamp: Date.now(),
            cardType: toolDef?.cardType, category: toolDef?.category,
            // Propagate the pi-agent tool call id so the client can correlate
            // this start with the later complete/error event (and with the
            // persisted DB row — see the DB insert in tool_execution_end).
            invocationId: event.toolCallId,
          });
          break;
        }
        case "tool_execution_end": {
          // invoke_agent uses agent:spawn/agent:complete — skip tool:complete/error WS events
          // but still persist to DB below
          if (event.toolName !== "invoke_agent") {
            const endToolDef = builtinToolDefsMap.get(event.toolName);
            if (event.isError) {
              this.bus.emit("tool:error", {
                conversationId, extensionId: "", toolName: event.toolName,
                error: typeof event.result === 'string' ? event.result : JSON.stringify(event.result), duration: 0,
                cardType: endToolDef?.cardType,
                invocationId: event.toolCallId,
              });
            } else {
              this.bus.emit("tool:complete", {
                conversationId, extensionId: "", toolName: event.toolName,
                output: event.result, duration: 0, success: true,
                cardType: endToolDef?.cardType,
                invocationId: event.toolCallId,
              });
            }
          }
          // Persist built-in tool calls to DB so diff panel survives page refresh.
          // Use event.toolCallId as the row id so streaming events and hydrated
          // DB rows share the same key — lets the client dedupe without fuzzy
          // matching when a page reload overlaps an in-flight run.
          if (this.persist) {
            const args = pendingToolArgs.get(event.toolCallId) ?? {};
            pendingToolArgs.delete(event.toolCallId);
            // Anchored to turn message in turn_end handler (messageId: null here).
            // persistToolCall is the single insert site for tool_calls — keeps
            // the four analytics dimensions (user/agent/model/provider) in
            // lockstep with the extension-tool write path.
            queueDb(() => persistToolCall({
              id: event.toolCallId,
              conversationId,
              messageId: null,
              extensionId: "builtin",
              toolName: event.toolName,
              input: args,
              output: { content: event.result?.content ?? [] },
              success: !event.isError,
              durationMs: 0,
              userId: convRecord?.userId ?? null,
              agentConfigId: options.agentConfigId ?? convRecord?.agentConfigId ?? null,
              model: options.model ?? convRecord?.model ?? null,
              provider: options.provider ?? convRecord?.provider ?? null,
            }));
          }
          break;
        }
        case "turn_end": {
          const msg = event.message;
          if (msg && "role" in msg && msg.role === "assistant") {
            const am = msg as AssistantMessage;
            totalUsage = am.usage;
            this.bus.emit("run:usage", { runId: run.id, usage: am.usage });

            // Persist this turn as its own assistant message
            // Extract text and thinking separately from the final AssistantMessage content array
            const textContent = am.content
              .filter((c: { type: string }) => c.type === "text")
              .map((c: { type: string; text?: string }) => c.text ?? "")
              .join("");
            const thinkingContent = am.content
              .filter((c: { type: string }) => c.type === "thinking")
              .map((c: { type: string; thinking?: string }) => c.thinking ?? "")
              .join("");
            // Fallback: use accumulated streaming text if the final message lacks text blocks
            // (some providers stream text_delta but don't include text in the final message)
            const resolvedText = textContent || turnText;
            const resolvedThinking = thinkingContent || turnThinking;

            if (!textContent && turnText) {
              log.warn("turn_end message missing text blocks but turnText has content", { turnTextPreview: turnText.slice(0, 100), contentTypes: am.content.map((c: { type: string }) => c.type).join(", ") });
            }
            if (!resolvedText && !turnHasToolCalls) {
              log.warn("turn_end with no text and no tool calls", { contentTypes: am.content.map((c: { type: string }) => c.type).join(", ") });
            }

            if (this.persist && (resolvedText || turnHasToolCalls)) {
              const capturedText = resolvedText;
              const capturedThinking = resolvedThinking || undefined;
              const capturedParent = lastSavedMessageId;
              queueDb(async () => {
                const { createMessage } = await import("../db/queries/conversations");
                const turnMsg = await createMessage(conversationId, {
                  role: "assistant",
                  content: capturedText,
                  thinkingContent: capturedThinking,
                  model: options.model,
                  provider: options.provider,
                  usage: { inputTokens: am.usage.input, outputTokens: am.usage.output },
                  runId: run.id,
                  parentMessageId: capturedParent ?? undefined,
                });

                // Anchor unanchored tool calls to this turn's message
                await getDb()
                  .update(toolCalls)
                  .set({ messageId: turnMsg.id })
                  .where(and(
                    eq(toolCalls.conversationId, conversationId),
                    isNull(toolCalls.messageId),
                  ));
                // Also handle extension tools that used run.id as placeholder
                await getDb()
                  .update(toolCalls)
                  .set({ messageId: turnMsg.id })
                  .where(and(
                    eq(toolCalls.conversationId, conversationId),
                    eq(toolCalls.messageId, run.id),
                  ));

                // Anchor agent sub-conversations created during this turn to the assistant message
                await getDb()
                  .update(conversations)
                  .set({ parentMessageId: turnMsg.id })
                  .where(and(
                    eq(conversations.parentConversationId, conversationId),
                    isNull(conversations.parentMessageId),
                  ));

                lastSavedMessageId = turnMsg.id;

                this.bus.emit("run:turn_saved", {
                  runId: run.id,
                  conversationId,
                  messageId: turnMsg.id,
                  parentMessageId: capturedParent,
                  content: capturedText,
                });
                this.bus.emit("run:turn_text_reset", { runId: run.id });
              });
            }
          }
          if (turnHasToolCalls) {
            this.bus.emit("run:status", { runId: run.id, status: "Analyzing results..." });
          }
          turnText = "";
          break;
        }
      }
    });

    // Sub-agent events also count as parent-run progress for the watchdog. invoke_agent
    // emits agent:spawn/agent:status/agent:complete with the parent's runId, so when a
    // multi-minute auto-spin-up is running, the parent watchdog sees these as liveness
    // signals and won't kill the outer turn.
    const unsubAgentActivity = [
      this.bus.on("agent:spawn", (data) => {
        if ((data as { runId?: string }).runId === run.id) this.bumpActivity(run.id);
      }),
      this.bus.on("agent:status", (data) => {
        if ((data as { runId?: string }).runId === run.id) this.bumpActivity(run.id);
      }),
      this.bus.on("agent:complete", (data) => {
        if ((data as { runId?: string }).runId === run.id) this.bumpActivity(run.id);
      }),
    ];

    // Note: the watchdog started earlier (before auto-spin-up) already handles heartbeat
    // refresh + partial-response persistence via its closure over allTurnsText. We no longer
    // need a separate setInterval here — the activity-based tick does both.

    try {
      this.bus.emit("run:status", { runId: run.id, status: "Generating response..." });

      // Resolve @[file:…] mentions against the active project and prepend a
      // lazy system note so the agent knows which files the user referenced.
      // The agent can read them on demand via the readFile tool.
      let promptInput = userMessage;

      // Slash-command expansion runs against the raw userMessage and
      // produces the text that goes to the LLM. The persisted message
      // (stored upstream) keeps the raw `/[cmd:name]` tokens so edit /
      // replay semantics remain stable. Expansion is literal — we do
      // NOT re-parse the expanded text for other mention kinds (see
      // expand-command-mentions.test.ts for the injection guards).
      if (options.commandResolver) {
        try {
          const { applyCommandExpansion } = await import("./mention-wiring");
          promptInput = await applyCommandExpansion(userMessage, options.commandResolver);
        } catch { /* Slash-command expansion failure is non-fatal */ }
      }

      if (options.projectId) {
        try {
          const { resolveFileMentions, formatFileMentionSystemNotes } = await import("./mention-wiring");
          const project = await getProject(options.projectId);
          const fileMentions = await resolveFileMentions(userMessage, project?.path);
          const note = formatFileMentionSystemNotes(fileMentions);
          if (note) promptInput = `${note}\n\n${promptInput}`;
        } catch { /* File mention resolution failure is non-fatal */ }
      }

      // Multi-modal attachments for the current turn: convert to pi-ai parts.
      // Images go through the prompt(text, images) overload; text/pdf content
      // is inlined into the prompt string. Incompatible attachments throw
      // UnsupportedAttachmentError, which the endpoint should have prevented —
      // if we reach here, the user provided a model that can't accept them and
      // we surface the error rather than silently dropping content.
      let attachmentImages: import("@mariozechner/pi-ai").ImageContent[] = [];
      if (options.attachments && options.attachments.length > 0 && options.provider && options.model) {
        const { getCapabilities } = await import("../providers/model-capabilities");
        const { buildUserContent } = await import("../chat/attachments/content-builder");
        const caps = getCapabilities(options.provider, options.model);
        const built = await buildUserContent(promptInput, options.attachments, caps);
        if (Array.isArray(built)) {
          const textBits: string[] = [];
          for (const part of built) {
            if (part.type === "text") textBits.push(part.text);
            else if (part.type === "image") attachmentImages.push(part);
          }
          promptInput = textBits.join("\n\n");
        }
      }

      if (attachmentImages.length > 0) {
        await piAgent.prompt(promptInput, attachmentImages);
      } else {
        await piAgent.prompt(promptInput);
      }

      // pi-agent-core catches LLM errors internally (stopReason: "error")
      // without rethrowing. Surface agent errors so they reach the UI.
      if (piAgent.state.error) {
        throw new Error(piAgent.state.error);
      }

      run.status = "success";
      run.result = { success: true, output: { fullText: allTurnsText, memoriesUsed: run.memoriesUsed } };
      run.finishedAt = Date.now();

      this.bus.emit("run:status", { runId: run.id, status: "Saving response..." });
      // Wait for all queued per-turn DB operations to complete
      await dbQueue;

      // Fallback: if no turns were saved (edge case), save allTurnsText as single message
      if (this.persist && allTurnsText && lastSavedMessageId === (options.parentMessageId ?? null)) {
        try {
          const { createMessage } = await import("../db/queries/conversations");
          const fallbackMsg = await createMessage(conversationId, {
            role: "assistant",
            content: allTurnsText,
            model: options.model,
            provider: options.provider,
            runId: run.id,
            parentMessageId: options.parentMessageId,
          });
          await getDb()
            .update(toolCalls)
            .set({ messageId: fallbackMsg.id })
            .where(and(
              eq(toolCalls.conversationId, conversationId),
              isNull(toolCalls.messageId),
            ));
          lastSavedMessageId = fallbackMsg.id;
        } catch (err) {
          log.error("Failed to persist fallback assistant message", { error: String(err) });
        }
      }

      // Scratchpad cleanup is no longer needed — Phase 1 moved the
      // scratchpad to a bundled extension whose entries auto-expire via
      // TTL (24h) in extension_storage. Per-run isolation was traded
      // for conversation-scoped sharing (Plan-agent recommendation; the
      // previous built-in had zero production consumers).

      this.bus.emit("run:complete", { run, conversationId });
      this.bus.emit("obs:turn", {
        conversationId,
        llmDurationMs: Date.now() - turnStart,
        toolDurationMs: 0,
        totalDurationMs: Date.now() - turnStart,
        tokenUsage: { input: totalUsage.input, output: totalUsage.output },
      });
    } catch (err) {
      if (run.status !== "cancelled") {
        if (err instanceof DOMException && err.name === "AbortError") {
          run.status = "cancelled";
          run.result = { success: true, output: { fullText: allTurnsText, partial: true } };
          run.finishedAt = Date.now();
          // Wait for queued turn saves to complete, then save current partial turn
          await dbQueue;
          if (this.persist && turnText) {
            try {
              const { createMessage } = await import("../db/queries/conversations");
              const partialMsg = await createMessage(conversationId, {
                role: "assistant",
                content: turnText,
                model: options.model,
                provider: options.provider,
                runId: run.id,
                parentMessageId: lastSavedMessageId ?? undefined,
              });
              await getDb()
                .update(toolCalls)
                .set({ messageId: partialMsg.id })
                .where(and(
                  eq(toolCalls.conversationId, conversationId),
                  isNull(toolCalls.messageId),
                ));
            } catch (persistErr) {
              log.error("Failed to persist partial response", { error: String(persistErr) });
            }
          }
          this.bus.emit("run:cancel", { run, conversationId });
        } else if (err instanceof ProviderUnavailableError) {
          run.status = "error";
          const errorPayload = JSON.stringify({
            type: "provider_unavailable",
            failedProvider: err.failedProvider,
            failedModel: err.failedModel,
            suggestion: err.suggestion,
            message: err.message,
          });
          run.result = { success: false, output: null, error: errorPayload };
          run.finishedAt = Date.now();
          await this.persistErrorMessage(conversationId, `Error: ${errorPayload}`, { ...options, parentMessageId: lastSavedMessageId ?? options.parentMessageId }, run.id);
          this.bus.emit("run:error", { run, error: errorPayload, conversationId });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          run.status = "error";
          run.result = { success: false, output: null, error: message };
          run.finishedAt = Date.now();
          await this.persistErrorMessage(conversationId, `Error: ${message}`, { ...options, parentMessageId: lastSavedMessageId ?? options.parentMessageId }, run.id);
          this.bus.emit("run:error", { run, error: message, conversationId });
        }
      }
    } finally {
      unsub();
      unsubKill();
      unsubModeChange?.();
      for (const off of unsubAgentActivity) off();
      toolAbortControllers.clear();
      // Clear watchdog interval + activity tracking
      const hb = this.heartbeats.get(run.id);
      if (hb) { clearInterval(hb); this.heartbeats.delete(run.id); }
      this.lastActivityAt.delete(run.id);
      this.lastHeartbeatWriteAt.delete(run.id);
      this.controllers.delete(run.id);
      this.activeAgents.delete(run.id);
      this.runConversations.delete(run.id);
      if (this.persist) {
        await dbRuns.updateRun(run);
        // Clean up active run row (or mark interrupted on error)
        try {
          if (run.status === "success" || run.status === "cancelled") {
            await activeRunsDb.deleteActiveRun(run.id);
          } else {
            await activeRunsDb.markInterrupted(run.id);
          }
        } catch (err) {
          log.error("Active run cleanup failed", { error: String(err) });
        }
      }
    }

    } catch (setupErr) {
      // Safety net: handle errors that escape before the inner try-catch
      // (e.g. credential failures, model resolution errors, OAuth errors)
      if (run.status === "running") {
        const message = setupErr instanceof Error ? setupErr.message : String(setupErr);
        run.status = "error";
        run.result = { success: false, output: null, error: message };
        run.finishedAt = Date.now();
        await this.persistErrorMessage(conversationId, `Error: ${message}`, options, run.id);
        this.bus.emit("run:error", { run, error: message, conversationId });
      }
      // Abort the controller so any in-flight sub-agents (auto-spin-up) get cancelled
      const ctrl = this.controllers.get(run.id);
      if (ctrl && !ctrl.signal.aborted) ctrl.abort();
      this.controllers.delete(run.id);
      this.runConversations.delete(run.id);
      if (this.persist) {
        try {
          await dbRuns.updateRun(run);
          await activeRunsDb.markInterrupted(run.id);
        } catch { /* cleanup failure is non-fatal */ }
      }
    }

    return run;
  }

  private async persistErrorMessage(
    conversationId: string,
    errorContent: string,
    options: { model?: string; provider?: string; parentMessageId?: string },
    runId: string,
  ): Promise<void> {
    if (!this.persist) return;
    try {
      const { createMessage } = await import("../db/queries/conversations");
      const errorMsg = await createMessage(conversationId, {
        role: "assistant",
        content: errorContent,
        model: options.model,
        provider: options.provider,
        runId,
        parentMessageId: options.parentMessageId,
      });

      // Fix tool call anchoring for error messages too
      await getDb()
        .update(toolCalls)
        .set({ messageId: errorMsg.id })
        .where(and(
          eq(toolCalls.conversationId, conversationId),
          eq(toolCalls.messageId, runId),
        ));
      await getDb()
        .update(toolCalls)
        .set({ messageId: errorMsg.id })
        .where(and(
          eq(toolCalls.conversationId, conversationId),
          isNull(toolCalls.messageId),
        ));
    } catch (err) {
      log.error("Failed to persist error message", { error: String(err) });
    }
  }

  private storeRun(run: AgentRun): void {
    this.runs.set(run.id, run);

    if (this.runs.size > MAX_RUNS) {
      const oldest = this.runs.keys().next().value!;
      this.runs.delete(oldest);
    }
  }
}
