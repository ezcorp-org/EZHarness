import type {
  AgentContext,
  AgentDefinition,
  AgentEvents,
  AgentLog,
  AgentRun,
  ShellProvider,
  FileProvider,
  LogLevel,
} from "../types";
import type { EventBus } from "./events";
import type { Agent } from "@mariozechner/pi-agent-core";
import { createStreamChatContext } from "./stream-chat/context";
import type { PendingPermissionInfo, StreamChatHost } from "./stream-chat/host";
import {
  finalizeSuccess,
  finalizeError,
  finalizeCleanup,
  finalizeSetupError,
} from "./stream-chat/finalize";
import { loadHistory } from "./stream-chat/load-history";
import { subscribeBridge } from "./stream-chat/subscribe-bridge";
import { setupTools } from "./stream-chat/setup-tools";
import { applyAutoSpinUp } from "./stream-chat/auto-spin-up";
import { buildPiAgent } from "./stream-chat/build-pi-agent";
import { buildPromptInput } from "./stream-chat/build-prompt";
import { ToolExecutor } from "../extensions/tool-executor";
import type { ExtensionStateMediator } from "../extensions/state-mediator";
import { createSpawnQuota, type SpawnQuota } from "../extensions/spawn-quota";
import { getPermissionEngine } from "../extensions/permission-engine";
import { createShellProvider } from "../providers/shell";
import { createFileProvider } from "../providers/file";
import { getProject } from "../db/queries/projects";
import { getAllSettings, getSetting } from "../db/queries/settings";
import type { CompactionConfig } from "./stream-chat/context-compaction";
import * as dbRuns from "../db/queries/runs";
import { getConversation } from "../db/queries/conversations";
import { ExtensionRegistry } from "../extensions/registry";
import { startCollector } from "../observability/collector";
import { logger } from "../logger";
const log = logger.child("executor");
import * as activeRunsDb from "../db/queries/active-runs";
import { WatchdogManager } from "./executor-watchdog";
import { createPiLlmAdapter, persistErrorMessage } from "./executor-helpers";

export interface ExecutorOptions {
  shell?: ShellProvider;
  file?: FileProvider;
  persist?: boolean;
}

// ── AgentExecutor ───────────────────────────────────────────────────

const MAX_RUNS = 100;

/**
 * Resolve per-turn history-compaction overrides from settings. Mirrors
 * the `getDefaultTier`/`getPreferenceOrder` pattern in providers/router:
 * each key is optional and falls back to the compaction module DEFAULTS
 * when unset or malformed. `compaction:strategy = "none"` disables it.
 */
async function resolveCompactionConfig(): Promise<Partial<CompactionConfig>> {
  const out: Partial<CompactionConfig> = {};

  const strategy = await getSetting("compaction:strategy");
  if (typeof strategy === "string" && strategy.trim().length > 0) {
    out.strategy = strategy.trim();
  }

  const numeric: Array<[string, keyof CompactionConfig]> = [
    ["compaction:responseReserveCap", "responseReserveCap"],
    ["compaction:responseReserveFloor", "responseReserveFloor"],
    ["compaction:safetyFraction", "safetyFraction"],
  ];
  for (const [key, field] of numeric) {
    const v = await getSetting(key);
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      (out as Record<string, number>)[field] = v;
    }
  }
  return out;
}

export class AgentExecutor {
  private runs = new Map<string, AgentRun>();
  private controllers = new Map<string, AbortController>();
  private activeAgents = new Map<string, Agent>();
  private runConversations = new Map<string, string>();
  private pendingPermissions = new Map<string, PendingPermissionInfo>();
  // Per-run "an assistant error message has been persisted" guard,
  // shared by the watchdog trip branch and the streamChat finalize
  // paths so exactly ONE visible error message lands per run even when
  // both fire (watchdog kill, then the unblocked await's finalizeError).
  // Cleared on watchdog `clearRun` (run teardown).
  private errorMessagePersisted = new Set<string>();
  private shell: ShellProvider;
  private file: FileProvider;
  private persist: boolean;
  private bus: EventBus<AgentEvents>;
  // Activity-based liveness: heartbeat refresh, idle detection, orphan cleanup.
  // Owns its own state; this class holds the reference and delegates.
  // Constructed with a WatchdogHost view that exposes only the maps the
  // watchdog needs to read — no state duplication, surface unchanged.
  private watchdog: WatchdogManager;
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
    bus: EventBus<AgentEvents>,
    opts?: ExecutorOptions,
  ) {
    this.bus = bus;
    this.shell = opts?.shell ?? createShellProvider();
    this.file = opts?.file ?? createFileProvider();
    this.persist = opts?.persist ?? false;
    this._spawnQuota = createSpawnQuota(this.bus);
    startCollector(this.bus);

    // Per-run liveness + orphan cleanup are delegated to WatchdogManager.
    // It reads our maps by reference (single shared state) and owns its
    // own timer/activity state — see src/runtime/executor-watchdog.ts.
    // The host view is the *only* surface the watchdog uses; we expose
    // it inline rather than making instance fields public.
    this.watchdog = new WatchdogManager({
      runs: this.runs,
      controllers: this.controllers,
      activeAgents: this.activeAgents,
      runConversations: this.runConversations,
      pendingPermissions: this.pendingPermissions,
      bus: this.bus,
      persist: this.persist,
      errorMessagePersisted: this.errorMessagePersisted,
    });
    this.watchdog.startOrphanCleanup();
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
    userId?: string,
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
      // Thread the initiating user so an agent/CLI run is attributable for
      // /api/runs/[id] ownership. Undefined (e.g. nested ctx.run spawns)
      // inserts NULL user_id ⇒ admin-only (fail closed) — never cross-tenant
      // readable. Nested spawns inherit the parent's userId so a sub-agent
      // run stays owned by the principal who started the top-level run.
      await dbRuns.insertRun(run, projectId, input, undefined, userId);
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
    const piLlm = createPiLlmAdapter();

    const ctx: AgentContext = {
      input: resolvedInput,
      llm: piLlm as any,
      shell: this.shell,
      file: this.file,
      log: appendLog,
      signal: controller.signal,
      run: async (agentName, childInput) => {
        const childRun = await this.runAgent(agentName, childInput, projectId, userId);
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
          const engine = getPermissionEngine({
            registry,
            bus: this.bus,
            db: { _token: "executor" },
          });
          const toolExec = new ToolExecutor(registry, engine, { bus: this.bus });
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
      // Don't overwrite if cancelRun() already set status — an agent that
      // resolves normally on abort (rather than throwing) would otherwise
      // flip "cancelled" back to "success". When the success branch fires
      // on a cancelled run, override cancelRun()'s "cancelled" discriminator
      // with "swallowed_abort" so consumers can distinguish a well-behaved
      // abort (agent threw on ctx.signal) from a misbehaving one.
      if (run.status !== "cancelled") {
        run.status = "success";
        run.result = result;
        run.finishedAt = Date.now();
        this.bus.emit("run:complete", { run });
      } else {
        run.result = {
          success: false,
          output: null,
          error: {
            code: "swallowed_abort",
            message: "agent resolved after cancel was requested",
          },
        };
        log.warn("agent resolved after cancel was requested", {
          runId: run.id,
          agentName: name,
        });
      }
    } catch (err) {
      // Don't overwrite if already cancelled — cancelRun() populated
      // result.error = { code: "cancelled", ... }; leaving it in place
      // is the well-behaved-abort signal for downstream consumers.
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

  // `userId`, when set, scopes the listing to that user's runs (non-admin
  // ownership guard for GET /api/runs). Admin callers omit it to see all.
  async listRuns(projectId?: string, userId?: string): Promise<AgentRun[]> {
    if (this.persist) {
      const dbResults = (await dbRuns.listRuns(projectId, userId)).map(dbRuns.toAgentRun);
      if (userId) {
        // Ownership-scoped: the DB rows are already filtered to the caller.
        // Don't merge unpersisted in-memory active runs — they can't be
        // safely attributed yet, and runs are persisted at creation so they
        // surface here immediately. Fail closed (never leak another tenant's
        // in-flight run through the merge).
        return dbResults.sort((a, b) => b.startedAt - a.startedAt);
      }
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

  /** Owning conversation id for a run (active map first, then the persisted
   *  row). Undefined for agent/CLI runs with no conversation. Drives run
   *  ownership enforcement on /api/runs/[id]. */
  async getRunConversationId(id: string): Promise<string | undefined> {
    const mem = this.runConversations.get(id);
    if (mem) return mem;
    if (this.persist) return dbRuns.getRunConversationId(id);
    return undefined;
  }

  /**
   * Run-ownership attributes for /api/runs/[id]: the initiating `userId`
   * (authoritative) and the owning `conversationId`. `userId` lives only on
   * the persisted row, so an in-memory-only run (persist=false, or a row not
   * yet flushed) reports `userId: null` and falls back to the conversation
   * check. `conversationId` prefers the live `runConversations` map (set
   * before the row is written) so an in-flight chat run is still attributable.
   * Returns `{ userId: null, conversationId: null }` for a run with no
   * attribution — the route denies that for non-admins (fail closed).
   */
  async getRunOwnership(id: string): Promise<{ userId: string | null; conversationId: string | null }> {
    const memConv = this.runConversations.get(id) ?? null;
    if (this.persist) {
      const row = await dbRuns.getRunOwnership(id);
      if (row) return { userId: row.userId, conversationId: row.conversationId ?? memConv };
    }
    return { userId: null, conversationId: memConv };
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
    // Single source of truth for the cancel terminal state. The runAgent
    // success branch overrides this with `swallowed_abort` when an agent
    // resolves despite ctx.signal abort; the error branch leaves this in
    // place (well-behaved abort that threw on the signal). Mirrors the
    // shape parity established in stream-chat/finalize.ts:104-105.
    run.result = {
      success: false,
      output: null,
      error: { code: "cancelled", message: "run cancelled" },
    };
    run.finishedAt = Date.now();
    const conversationId = this.runConversations.get(id);
    this.bus.emit("run:cancel", { run, conversationId });
    // Safety net for the leaked-promise case: if the aborted await never
    // unblocks, streamChat stays suspended and its `finally →
    // finalizeCleanup` (the only caller of dbRuns.updateRun) never runs,
    // so the `runs` row would stay `status='running'` forever while the
    // user already cancelled. Persist a terminal state directly here.
    // Fire-and-forget (cancelRun is sync + widely called) and idempotent
    // — finalizeRunRow only transitions a still-`running` row, so the
    // healthy path that DOES reach finalizeCleanup is unaffected.
    if (this.persist) {
      dbRuns.finalizeRunRow(id, "cancelled").catch((err) => {
        log.error("cancelRun finalizeRunRow failed", { error: String(err) });
      });
    }
    return true;
  }

  async streamChat(
    conversationId: string,
    userMessage: string,
    options: { projectId?: string; provider?: string; model?: string; system?: string; runId?: string; parentMessageId?: string; agentConfigId?: string; permissionMode?: import("./tools/types").PermissionMode; thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"; modeId?: string; orchestrationDepth?: number; toolRestriction?: "all" | "read-only" | "none"; allowedTools?: string[]; deniedTools?: string[]; readOnlyAllowedTools?: string[]; memberOverrides?: Map<string, import("../types").TeamMemberOverrides>; subAgentMembers?: import("../types").TeamMember[]; attachments?: import("../chat/attachments/content-builder").StagedAttachment[]; commandResolver?: import("./mention-wiring").CommandResolver },
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

    // Per-call context bundle. Closures below capture `ctx` (one ref) instead
    // of 10+ individual locals so phase modules under stream-chat/ can be
    // pure functions taking (ctx, host, …) without a wide param list. See
    // StreamChatContext for the field map.
    const ctx = createStreamChatContext(run, controller, options.parentMessageId);

    // Composition seam for phase modules. Mirrors the WatchdogHost pattern
    // in executor-watchdog.ts: a single read-only view onto the executor's
    // shared state. Phase modules under stream-chat/ never import the
    // executor class directly.
    const host: StreamChatHost = {
      bus: this.bus,
      persist: this.persist,
      pendingPermissions: this.pendingPermissions,
      controllers: this.controllers,
      runConversations: this.runConversations,
      activeAgents: this.activeAgents,
      runs: this.runs,
      watchdog: this.watchdog,
      errorMessagePersisted: this.errorMessagePersisted,
      stateMediator: this._stateMediator,
      spawnQuota: this._spawnQuota,
      executor: this,
      // Phase 1 PDP. Singleton — initialized on first call with the
      // shared registry + bus. Every per-turn ToolExecutor in the
      // setup-tools phase consumes this same instance so the
      // always-allow cache is shared.
      permissionEngine: getPermissionEngine({
        registry: ExtensionRegistry.getInstance(),
        bus: this.bus,
        db: { _token: "executor" },
      }),
    };

    if (this.persist) {
      await dbRuns.insertRun(run, options.projectId, undefined, conversationId);
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

    const { history, allPastAttachments } = await loadHistory(ctx, conversationId, options);

    // ── Credential context: sub-conversations inherit parent's credentials ──
    const convRecord = await getConversation(conversationId);
    const credentialConversationId = convRecord?.parentConversationId ?? conversationId;

    const resolvedModel = await setupTools(
      ctx,
      host,
      conversationId,
      userMessage,
      options,
      allPastAttachments,
      convRecord ?? null,
      credentialConversationId,
    );

    // Stash the resolved endpoint so the error-finalize path can name the
    // unreachable host in a friendly provider-connection error instead of
    // leaking the runtime's raw "Was there a typo in the url or port?" text.
    ctx.modelBaseUrl = resolvedModel.resolved.piModel?.baseUrl;

    // Start the activity-based watchdog. Replaces the dumb setInterval heartbeat — it only
    // refreshes last_heartbeat while progress signals are bumping activity, and auto-cancels
    // the run if it stays idle for WATCHDOG_IDLE_MS (90s) with no pending permission.
    // The closure reads `ctx.allTurnsText` lazily so it captures the latest partial response.
    //
    // The persistError closure lets the watchdog-trip branch write a
    // SINGLE visible assistant error message (Defect 2) — it closes
    // over this run's options for model/provider and uses the latest
    // saved message id as the parent so the bubble threads correctly.
    // Re-checks the shared guard so it's idempotent even if invoked
    // after a finalize path already claimed the slot.
    this.watchdog.startWatchdog(
      run.id,
      conversationId,
      () => ctx.allTurnsText,
      async (convId, errorContent) => {
        await persistErrorMessage(
          convId,
          errorContent,
          {
            model: options.model,
            provider: options.provider,
            parentMessageId: ctx.lastSavedMessageId ?? options.parentMessageId,
          },
          run.id,
          this.persist,
        );
      },
    );

    // Auto-spin-up team members (if setupTools flagged the run) and inject
    // the orchestrator prompt onto ctx.system. Done AFTER Promise.all so the
    // model is resolved + tools are ready.
    await applyAutoSpinUp(ctx, host, userMessage);

    // Apply mode tool restrictions (filter tools by category + allowlist).
    // Phase 48 extends the contract: when a mode declares
    // toolRestriction='allowlist' it also sets mode.allowedTools to the
    // exact set of permitted tool names (orchestration tools always
    // survive). The Ez concierge uses this path; legacy modes pass through
    // with toolRestriction in {'all','read-only','none'} and a NULL
    // allowedTools — applyToolFilters treats that as a no-op for the
    // allow-step.
    //
    // Mode-extensions extension: when mode.extensionIds is non-empty, the
    // mode authors declared its tool surface via attached extensions. We
    // resolve those IDs to the union of tool names and feed them as an
    // allowlist (toolRestriction='allowlist'), which supersedes any legacy
    // toolRestriction/allowedTools values for that mode. Built-in modes
    // with extensionIds=null/empty (e.g. seeded Ez mode) keep their
    // existing toolRestriction='allowlist' + allowedTools behaviour.
    const { applyToolFilters } = await import("./tools/filter");
    try {
      const { computeModeToolScope } = await import("./tools/mode-tool-scope");
      let mode = null;
      if (options.modeId) {
        const { getMode } = await import("../db/queries/modes");
        mode = (await getMode(options.modeId)) ?? null;
      }
      // Shared with the /api/tools listing endpoint — the header badge
      // shows exactly the surface this filter grants. Allowlist union +
      // per-extension subset + per-conversation narrow-only intersection
      // all live in computeModeToolScope. Runs even without a mode: the
      // conversation's extensionTools map (the composer's Tools toggles)
      // narrows the loaded set on its own.
      const scope = computeModeToolScope(
        mode,
        convRecord?.extensionTools ?? null,
        ExtensionRegistry.getInstance(),
      );
      if (scope) {
        ctx.agentTools = applyToolFilters(ctx.agentTools, ctx.builtinToolDefsMap, scope);
      }
    } catch { /* Mode lookup failure is non-fatal — keep all tools */ }

    // Apply invocation-level scoping (member override restriction + team-level
    // allow/deny). Takes precedence over mode restriction. allowedTools /
    // deniedTools carry the team-level TeamToolScope when set.
    if (options.toolRestriction || options.allowedTools?.length || options.deniedTools?.length) {
      ctx.agentTools = applyToolFilters(ctx.agentTools, ctx.builtinToolDefsMap, {
        toolRestriction: options.toolRestriction,
        allowedTools: options.allowedTools,
        deniedTools: options.deniedTools,
        // Host-vouched read-safe extension tools (Daily Briefing passes
        // the web-search names so watchlist research survives the
        // unattended run's read-only restriction — see tools/filter.ts).
        readOnlyAllowedTools: options.readOnlyAllowedTools,
      });
    }

    // Wire tool:kill handler to abort running tools
    ctx.unsubKill = this.bus.on("tool:kill", ({ toolCallId }) => {
      const ctrl = ctx.toolAbortControllers.get(toolCallId);
      if (ctrl) ctrl.abort();
    });

    const compaction = await resolveCompactionConfig();
    const piAgent = buildPiAgent(
      ctx,
      history,
      { ...options, compaction },
      resolvedModel,
      credentialConversationId,
    );
    this.activeAgents.set(run.id, piAgent);

    // Streaming state lives entirely on the per-call context. Re-zero
    // allTurnsText here — the watchdog already captured the closure
    // earlier and reads it lazily on each tick.
    ctx.allTurnsText = "";
    ctx.turnStart = Date.now();

    // Bridge pi-agent-core events into the local EventBus + persist tool
    // calls / per-turn assistant messages. Sub-agent events are also wired
    // back to the watchdog so multi-minute auto-spin-up turns aren't killed.
    // Note: the watchdog started earlier (before auto-spin-up) already
    // handles heartbeat refresh + partial-response persistence via its
    // closure over allTurnsText. The activity-based tick covers both.
    subscribeBridge(ctx, host, piAgent, conversationId, options, convRecord ?? null);

    try {
      this.bus.emit("run:status", { runId: run.id, status: "Generating response..." });

      const { text: promptInput, images: attachmentImages } = await buildPromptInput(userMessage, {
        ...options,
        conversationId,
        // ownerId drives `%[lesson:…]` visibility scoping inside
        // buildPromptInput. Falls back to undefined when convRecord is
        // missing or the row has no userId — the lesson block silently
        // no-ops in that case (mirrors the projectId-missing path).
        ownerId: convRecord?.userId ?? undefined,
      });
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

      // Scratchpad cleanup is no longer needed — Phase 1 moved the
      // scratchpad to a bundled extension whose entries auto-expire via
      // TTL (24h) in extension_storage. Per-run isolation was traded
      // for conversation-scoped sharing (Plan-agent recommendation; the
      // previous built-in had zero production consumers).
      await finalizeSuccess(ctx, host, conversationId, options);
    } catch (err) {
      await finalizeError(ctx, host, conversationId, options, err);
    } finally {
      await finalizeCleanup(ctx, host);
    }

    } catch (setupErr) {
      // Safety net: handle errors that escape before the inner try-catch
      // (e.g. credential failures, model resolution errors, OAuth errors)
      await finalizeSetupError(ctx, host, conversationId, options, setupErr);
    }

    return run;
  }

  private storeRun(run: AgentRun): void {
    this.runs.set(run.id, run);

    if (this.runs.size > MAX_RUNS) {
      const oldest = this.runs.keys().next().value!;
      this.runs.delete(oldest);
    }
  }

  /**
   * Release process-level resources owned by this executor:
   * - the periodic orphan-cleanup interval (only set when persist=true)
   * - any per-run watchdog/heartbeat intervals (defensive — these are
   *   normally cleared in the run-completion finally block at ~line 1527)
   * - all in-flight AbortControllers, so streaming runs unwind cleanly
   *
   * Safe to call multiple times. Intended for test teardown and (eventually)
   * graceful process shutdown — SIGTERM/SIGINT wiring is deliberately NOT
   * added here; that lives one layer up.
   */
  destroy(): void {
    this.watchdog.destroy();
    for (const ctrl of this.controllers.values()) {
      if (!ctrl.signal.aborted) ctrl.abort();
    }
  }
}
