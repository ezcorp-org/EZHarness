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
import { createShellProvider } from "../providers/shell";
import { createFileProvider } from "../providers/file";
import { getProject } from "../db/queries/projects";
import { getAllSettings } from "../db/queries/settings";
import * as dbRuns from "../db/queries/runs";
import { getConversation } from "../db/queries/conversations";
import { ExtensionRegistry } from "../extensions/registry";
import { startCollector } from "../observability/collector";
import { logger } from "../logger";
const log = logger.child("executor");
import * as activeRunsDb from "../db/queries/active-runs";
import { WatchdogManager } from "./executor-watchdog";
import { createPiLlmAdapter } from "./executor-helpers";

export interface ExecutorOptions {
  shell?: ShellProvider;
  file?: FileProvider;
  persist?: boolean;
}

// ── AgentExecutor ───────────────────────────────────────────────────

const MAX_RUNS = 100;

export class AgentExecutor {
  private runs = new Map<string, AgentRun>();
  private controllers = new Map<string, AbortController>();
  private activeAgents = new Map<string, Agent>();
  private runConversations = new Map<string, string>();
  private pendingPermissions = new Map<string, PendingPermissionInfo>();
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
    const piLlm = createPiLlmAdapter();

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
    return true;
  }

  async streamChat(
    conversationId: string,
    userMessage: string,
    options: { projectId?: string; provider?: string; model?: string; system?: string; runId?: string; parentMessageId?: string; agentConfigId?: string; permissionMode?: import("./tools/types").PermissionMode; thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"; modeId?: string; orchestrationDepth?: number; toolRestriction?: "all" | "read-only" | "none"; allowedTools?: string[]; deniedTools?: string[]; memberOverrides?: Map<string, import("../types").TeamMemberOverrides>; subAgentMembers?: import("../types").TeamMember[]; attachments?: import("../chat/attachments/content-builder").StagedAttachment[]; commandResolver?: import("./mention-wiring").CommandResolver; ezContext?: unknown },
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
      stateMediator: this._stateMediator,
      spawnQuota: this._spawnQuota,
      executor: this,
    };

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

    // Start the activity-based watchdog. Replaces the dumb setInterval heartbeat — it only
    // refreshes last_heartbeat while progress signals are bumping activity, and auto-cancels
    // the run if it stays idle for WATCHDOG_IDLE_MS (90s) with no pending permission.
    // The closure reads `ctx.allTurnsText` lazily so it captures the latest partial response.
    this.watchdog.startWatchdog(run.id, conversationId, () => ctx.allTurnsText);

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
    if (options.modeId) {
      try {
        const { getMode } = await import("../db/queries/modes");
        const mode = await getMode(options.modeId);
        if (mode) {
          const extensionIds = mode.extensionIds ?? [];
          if (extensionIds.length > 0) {
            const registry = ExtensionRegistry.getInstance();
            const allowed = new Set<string>();
            for (const extId of extensionIds) {
              for (const t of registry.getToolsForExtension(extId)) {
                allowed.add(t.name);
              }
            }
            ctx.agentTools = applyToolFilters(ctx.agentTools, ctx.builtinToolDefsMap, {
              toolRestriction: "allowlist",
              allowedTools: [...allowed],
            });
          } else if (mode.toolRestriction) {
            ctx.agentTools = applyToolFilters(ctx.agentTools, ctx.builtinToolDefsMap, {
              toolRestriction: mode.toolRestriction,
              allowedTools: mode.allowedTools ?? undefined,
            });
          }
        }
      } catch { /* Mode lookup failure is non-fatal — keep all tools */ }
    }

    // Apply invocation-level scoping (member override restriction + team-level
    // allow/deny). Takes precedence over mode restriction. allowedTools /
    // deniedTools carry the team-level TeamToolScope when set.
    if (options.toolRestriction || options.allowedTools?.length || options.deniedTools?.length) {
      ctx.agentTools = applyToolFilters(ctx.agentTools, ctx.builtinToolDefsMap, {
        toolRestriction: options.toolRestriction,
        allowedTools: options.allowedTools,
        deniedTools: options.deniedTools,
      });
    }

    // Wire tool:kill handler to abort running tools
    ctx.unsubKill = this.bus.on("tool:kill", ({ toolCallId }) => {
      const ctrl = ctx.toolAbortControllers.get(toolCallId);
      if (ctrl) ctrl.abort();
    });

    const piAgent = buildPiAgent(ctx, history, options, resolvedModel, credentialConversationId);
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

      const { text: promptInput, images: attachmentImages } = await buildPromptInput(userMessage, options);
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
