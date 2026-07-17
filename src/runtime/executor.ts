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
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import { createStreamChatContext } from "./stream-chat/context";
import type { PendingPermissionInfo, StreamChatHost } from "./stream-chat/host";
import {
  finalizeSuccess,
  finalizeError,
  finalizeCleanup,
  finalizeSetupError,
} from "./stream-chat/finalize";
import { loadHistory } from "./stream-chat/load-history";
import { isSessionHistoryProducerEnabled } from "../db/session-sync";
import { subscribeBridge } from "./stream-chat/subscribe-bridge";
import { setupTools } from "./stream-chat/setup-tools";
import { applyAutoSpinUp } from "./stream-chat/auto-spin-up";
import { buildPiAgent } from "./stream-chat/build-pi-agent";
import { runWithFailover } from "./stream-chat/failover";
import { buildPromptInput } from "./stream-chat/build-prompt";
import { suggestFallback } from "../providers/router";
import { ToolExecutor } from "../extensions/tool-executor";
import type { ExtensionStateMediator } from "../extensions/state-mediator";
import { createSpawnQuota, type SpawnQuota } from "../extensions/spawn-quota";
import { getPermissionEngine } from "../extensions/permission-engine";
import { createShellProvider } from "../providers/shell";
import { createFileProvider } from "../providers/file";
import { getProject } from "../db/queries/projects";
import { getAllSettings, getSetting } from "../db/queries/settings";
import type { CompactionConfig } from "./stream-chat/context-compaction";
import {
  resolveCacheRetentionSetting,
  type CacheRetention,
} from "./stream-chat/cache-retention";
import * as dbRuns from "../db/queries/runs";
import { getConversation } from "../db/queries/conversations";
import { ExtensionRegistry } from "../extensions/registry";
import { startCollector } from "../observability/collector";
import { logger } from "../logger";
const log = logger.child("executor");
import * as activeRunsDb from "../db/queries/active-runs";
import { WatchdogManager } from "./executor-watchdog";
import { createPiLlmAdapter, persistErrorMessage, resolveFailoverAttempt } from "./executor-helpers";

export interface ExecutorOptions {
  shell?: ShellProvider;
  file?: FileProvider;
  persist?: boolean;
}

/**
 * Discriminated outcome of {@link AgentExecutor.steerConversation}. P1 is
 * plumbing only — nothing calls it yet; P2 builds the atomic
 * steer-vs-enqueue decision on top of these variants (a non-`steered`
 * result is the signal to fall back to the pending-messages mailbox).
 *
 * - `steered`   — a live run + its live pi Agent existed and the message was
 *                 accepted into the run's steering queue (best-effort, NOT a
 *                 delivery guarantee — see {@link AgentExecutor.steerConversation}
 *                 for the drop conditions and the P2 shadow-track requirement).
 * - `no-live-run` — no running run owns this conversation (idle conversation,
 *                 or the run reached a terminal state before this call).
 * - `no-agent`  — a run is live but no Agent instance is registered for it yet
 *                 (the pre-first-token window before failover's first
 *                 `buildAgent`); `runId` is returned for the caller's fallback.
 * - `guarded`   — a live run owns the conversation but its registered
 *                 {@link RunMode} forbids mid-run steering (autonomous
 *                 continuation / structured-output correction). The message is
 *                 NOT steered; the caller routes it to the pending-messages
 *                 mailbox so start-assignment's run-boundary drain delivers it
 *                 at the next cycle (P4 — see {@link AgentExecutor.registerRunMode}
 *                 and the guard in {@link AgentExecutor.steerConversation}).
 */
export type SteerResult =
  | { status: "steered"; runId: string }
  | { status: "no-live-run" }
  | { status: "no-agent"; runId: string }
  | { status: "guarded"; runId: string; reason: "autonomous" | "schema" };

/**
 * Steer eligibility a run carries (P4). Recorded by start-assignment at each
 * cycle's `startRun` (the initial run AND every auto-continue / autonomous /
 * schema-retry cycle mints a new run id, so every cycle re-registers, mirroring
 * {@link AgentExecutor.registerChildRun}). A run whose mode is `autonomous` or
 * `schema` is refused by {@link AgentExecutor.steerConversation} and routed to
 * pending-messages instead of being mid-run-steered — this keeps
 * start-assignment's run-boundary "user steering wins / abandons the in-flight
 * schema correction" invariant intact (the `schemaRepromptInFlight` gate assumes
 * a correction run reaches terminal before the next user turn; a mid-run steer
 * would interleave with it). Plain runs (both false, or simply unregistered —
 * direct chat / idle sends) stay steerable.
 */
export interface RunMode {
  /** `autonomousContinuation` is opted in — the child self-continues across
   *  multiple run cycles; a mid-run steer would interleave with a cycle. */
  autonomous: boolean;
  /** An `outputSchema` is set — the child may run bounded schema-correction
   *  cycles whose run-boundary invariant a mid-run steer would break. */
  schema: boolean;
}

/**
 * Per-steer tracking entry (P2) — see {@link AgentExecutor.steerConversation}.
 * Shadow-tracks a `steered` message so the executor can re-offer it to the
 * caller's fallback if the run terminates without delivering it. Kept in a
 * `runId → SteerShadow[]` map and settled by {@link AgentExecutor.flushSteerShadows}
 * on the run's terminal bus event.
 */
interface SteerShadow {
  /** Identity key — the exact UserMessage object handed to `agent.steer`. pi
   *  emits `message_start` carrying THIS object when it drains the steer, so
   *  an identity match confirms delivery. */
  message: UserMessage;
  /** The Agent instance this steer was queued into. A pre-first-token failover
   *  swaps the run's Agent (failover.ts:220) and rebuilds the retry's context
   *  from the DB — which never held the steer — so a steer "delivered" to an
   *  instance that is no longer the run's live one was actually lost. Compared
   *  against the live instance at terminal (see flushSteerShadows). */
  agent: Agent;
  /** Fired at most once, iff this steer reaches its run's terminal undelivered. */
  onUndelivered: () => void;
  /** Set when the delivery `message_start` for {@link message} is observed. */
  delivered: boolean;
  /** Detaches the delivery listener from the Agent. */
  unsubscribe: () => void;
  /** P4 §1.2 — the id of the DB row the caller persisted for this steer at
   *  request time (agent-chat persists the user row up-front for immediate feed
   *  visibility). When present, the persistence layer re-parents this row to the
   *  actual injection position at delivery so the NEXT run's loadHistory rebuilds
   *  the sequence the LLM saw. `undefined` for a steer with no persisted row
   *  (send_to_agent injects an ephemeral prompt, like every other sub-agent
   *  prompt — nothing to reconcile). See {@link AgentExecutor.consumeSteerPersistedId}. */
  persistedMessageId?: string;
  /** Latch so the reconciliation runs at most once even if pi re-emits the
   *  delivery `message_start` for {@link message}. */
  reconciled: boolean;
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
    ["compaction:cacheAnchorFraction", "cacheAnchorFraction"],
    ["compaction:summarizeMaxTokens", "summarizeMaxTokens"],
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
  // Per-run shadow copies of steered messages (P2). Lets a run's terminal
  // event re-offer any steer that was accepted but never delivered — see
  // steerConversation / flushSteerShadows.
  private steerShadows = new Map<string, SteerShadow[]>();
  // Per-run steer mode (P4). Recorded by start-assignment at each cycle's
  // startRun; read by steerConversation's guard to refuse mid-run steering of
  // autonomous / structured-output runs. Cleared on the run's terminal bus
  // event alongside steerShadows / childRuns hygiene — see registerRunMode.
  private runModes = new Map<string, RunMode>();
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

  /** Read-only accessor so out-of-turn wirers (the extension-events route,
   *  hub render-pull) can build a FULLY-wired ToolExecutor. Each wirer's
   *  `ensureSubprocessRpcWired` replaces the subprocess's single request
   *  handler, so an under-wired instance (no executor/spawnQuota) silently
   *  breaks `ezcorp/spawn-assignment` for every later call on that proc. */
  get spawnQuota(): SpawnQuota {
    return this._spawnQuota;
  }

  /** Parent-run id → live child-run ids. Populated by
   *  {@link registerChildRun} (called from start-assignment when a spawn
   *  carries a `parentRunId`) so {@link cancelRun} can cascade a cancel
   *  down the whole spawn tree. Without this link, cancelling an
   *  orchestrator run left every `invoke_agent` child running and burning
   *  tokens (the "Stop doesn't stop the work" P1). In-memory only — no DB
   *  migration; entries self-clean on each run's terminal bus event. */
  private childRuns = new Map<string, Set<string>>();
  /** Unsubscribe handles for the terminal-event listeners that keep
   *  {@link childRuns} bounded. Detached in {@link destroy}. */
  private childRunUnsubs: Array<() => void> = [];

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

    // Deregister a run from the child-run registry the moment it reaches a
    // terminal state. The three terminal bus events are the most reliable
    // seam: EVERY terminal path (runAgent success/error, streamChat's
    // finalizeSuccess/finalizeError, cancelRun, the watchdog trip) emits
    // exactly one of these, so this single wiring bounds the registry for
    // all of them — no per-finalize instrumentation to keep in sync — and
    // it's idempotent (a delete is a no-op if a cascade already dropped the
    // id). Runs that were never registered as children are a cheap Map miss.
    //
    // On a parent's run:error the children are cascade-cancelled BEFORE
    // deregistration: the parent's invoke_agent awaits died with it, so
    // nobody will ever consume the children's results — letting them
    // stream on just burns tokens. This is the seam that gives the
    // watchdog trip and finalizeError cascade semantics for free (they
    // emit run:error; they never call cancelRun). The re-entrancy is
    // safe: cascading emits run:cancel (not run:error), so this listener
    // cannot re-trigger itself.
    //
    // run:cancel deliberately does NOT cascade here — cancelRun's own
    // explicit cascade already covered the tree (it snapshots children
    // BEFORE self-cancel precisely so this listener's deregistration
    // can't starve the recursion), and a listener-side cascade would
    // re-enter with a fresh visited set on every emitted run:cancel,
    // producing unbounded duplicate cancels in cyclic registrations.
    //
    // run:complete does not cascade either: a cleanly-completing parent's
    // awaited children are already terminal, and future background-mode
    // children must survive their parent's completion.
    const deregister = (runId: string): void => this.deregisterRun(runId);
    // P4: a run's steer mode is meaningless once it is terminal — drop it in the
    // same terminal seam as steerShadows / childRuns so the map can't leak
    // across the many short-lived cycle runs a long autonomous/schema
    // assignment mints (the same map-eviction discipline as registerChildRun).
    const clearMode = (runId: string): void => { this.runModes.delete(runId); };
    const cancelOrphanedChildren = (runId: string): void => {
      const children = [...(this.childRuns.get(runId) ?? [])];
      if (children.length === 0) return;
      const visited = new Set<string>([runId]);
      for (const childId of children) this.cancelRunInternal(childId, visited);
      this.childRuns.delete(runId);
    };
    // flushSteerShadows runs FIRST in each terminal handler: this listener is
    // registered at construction (a process-wide singleton), ahead of any
    // per-assignment run:complete drainer in start-assignment. So when an
    // undelivered steer is re-enqueued to pending-messages on a clean
    // run:complete, branch (1)'s drainer — which fires later in the same emit
    // — still picks it up this cycle (EventBus fires listeners in
    // registration order).
    this.childRunUnsubs = [
      this.bus.on("run:complete", ({ run }) => {
        this.flushSteerShadows(run.id);
        clearMode(run.id);
        deregister(run.id);
      }),
      this.bus.on("run:error", ({ run }) => {
        this.flushSteerShadows(run.id);
        clearMode(run.id);
        cancelOrphanedChildren(run.id);
        deregister(run.id);
      }),
      this.bus.on("run:cancel", ({ run }) => {
        this.flushSteerShadows(run.id);
        clearMode(run.id);
        deregister(run.id);
      }),
    ];
  }

  /**
   * Register `childRunId` as a live child of `parentRunId` so a cancel of
   * the parent cascades to it. Called per-cycle from start-assignment (the
   * initial run AND every auto-continue / autonomous cycle re-registers,
   * because each cycle is a NEW run id). Idempotent within a Set.
   *
   * Returns `false` — and does NOT register — when the parent is missing
   * from the run map or already terminal. start-assignment awaits several
   * DB reads between the spawn RPC and this call, so a user's Stop can
   * cancel the parent inside that window; the cascade would have snapshot
   * an empty child set and the new child would stream ownerless forever.
   * Callers must treat `false` as "do not start this child".
   */
  registerChildRun(parentRunId: string, childRunId: string): boolean {
    const parent = this.runs.get(parentRunId);
    if (!parent || parent.status !== "running") return false;
    let set = this.childRuns.get(parentRunId);
    if (!set) {
      set = new Set<string>();
      this.childRuns.set(parentRunId, set);
    }
    set.add(childRunId);
    return true;
  }

  /**
   * Record the steer {@link RunMode} for a run (P4). Called from start-assignment
   * for the initial run AND every auto-continue / autonomous / schema-retry cycle
   * (each mints a new run id), mirroring {@link registerChildRun}'s per-cycle
   * re-registration. A run whose mode is autonomous or schema is refused by
   * {@link steerConversation} (returns `guarded`) and routed to pending-messages
   * instead of being mid-run-steered. Overwrites any prior entry for the same id
   * (idempotent). The entry is dropped on the run's terminal bus event, so a
   * later plain run that recycles a conversation steers normally again.
   */
  registerRunMode(runId: string, mode: RunMode): void {
    this.runModes.set(runId, mode);
  }

  /** The recorded steer {@link RunMode} for a run, or undefined for an
   *  unregistered run (plain chat / idle sends — always steerable). Read-only
   *  observability + guard-test seam. */
  getRunMode(runId: string): RunMode | undefined {
    return this.runModes.get(runId);
  }

  /**
   * Drop a terminated run from the registry — both its own children-set
   * (it can no longer spawn) and its membership in any parent's set. Empty
   * parent sets are deleted so the map can't grow unbounded across a long
   * orchestrator run that spawns many sequential children.
   */
  private deregisterRun(runId: string): void {
    this.childRuns.delete(runId);
    for (const [parentId, set] of this.childRuns) {
      if (set.delete(runId) && set.size === 0) this.childRuns.delete(parentId);
    }
  }

  /** Live child-run ids currently registered under a parent (empty when
   *  none / already cleared). Read-only observability + cascade-cancel
   *  test seam. */
  getRegisteredChildRunIds(parentRunId: string): string[] {
    return [...(this.childRuns.get(parentRunId) ?? [])];
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

    this.bus.emit("run:start", { run, runId: run.id });

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
        this.bus.emit("run:error", { run, runId: run.id, error: message });
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

  /**
   * Offer a user message to the live pi Agent serving `conversationId` for
   * best-effort delivery at the next steering poll of the in-flight run (pi
   * `steer()`).
   *
   * A `steered` result means the message was ACCEPTED into the live run's
   * steering queue — it is NOT a delivery guarantee. pi's runLoop polls the
   * steering queue at loop start and after each tool round, but does NOT
   * re-poll before `agent_end` (`agent-loop.js:159-171`), and a
   * pre-first-token failover discards the Agent that holds the queue
   * (`failover.ts:220`). So if the run finishes — abort, a subsequent failover
   * swap, or the loop already past its final steering poll — before the queue
   * is next drained, the queued message is dropped. **P2 callers MUST
   * shadow-track each steered message and fall back to the pending-messages
   * mailbox on any non-complete terminal.**
   *
   * Callers make an ATOMIC steer-vs-enqueue decision on the discriminated
   * {@link SteerResult}: `steered` → do NOT enqueue; `no-live-run` / `no-agent`
   * → enqueue to the pending-messages mailbox exactly as before. To honor the
   * best-effort caveat WITHOUT silent loss, a `steered` caller passes
   * `onUndelivered` — the executor shadow-tracks the message and invokes that
   * callback at most once if (and only if) the run reaches its terminal without
   * a delivery `message_start` for it (see {@link flushSteerShadows}). A
   * delivered steer never fires it (no double-delivery). The wired consumer is
   * the agent-chat route's active-run branch (P2); `send_to_agent` is P3.
   *
   * P4 — run-mode guard (both P2 and the P3 caller honor it via the shared
   * "non-`steered` → enqueue" fallback): a live run whose registered
   * {@link RunMode} is autonomous or schema is NOT steered — this returns
   * `guarded` (with the reason) and the caller routes the message to the
   * pending-messages mailbox, so start-assignment's run-boundary drain delivers
   * it at the next cycle. This preserves the "user steering wins / abandons the
   * in-flight schema correction" invariant (the `schemaRepromptInFlight` gate
   * assumes a correction run reaches terminal before the next user turn; a
   * mid-run steer would interleave with it). start-assignment records the mode
   * per cycle via {@link registerRunMode}; a plain (unregistered) run steers
   * normally. The guard runs BEFORE the Agent lookup so an autonomous/schema run
   * is guarded even in its pre-first-token window.
   *
   * P4 §1.2 — steered-row reconciliation: when the caller persisted a DB row for
   * this steer up-front (agent-chat, for immediate feed visibility) it passes
   * `persistedMessageId`; the executor shadow-tracks it and the persistence layer
   * re-parents that row to the injection position at delivery (see
   * {@link consumeSteerPersistedId} and subscribe-bridge's `message_start` seam)
   * so the next run's loadHistory rebuilds the sequence the LLM saw.
   *
   * `activeAgents` is read fresh on each call (never cached across calls):
   * `failover.ts:220` re-runs `activeAgents.set(runId, agent)` on every
   * attempt, so only the entry live AT CALL TIME is the instance that will
   * actually serve the next turn — a reference captured on an earlier call
   * could point at a discarded instance whose queue is dropped on abort. The
   * method itself is fully synchronous (no intra-method interleaving), so
   * `no-live-run` and `no-agent` are the states OBSERVED AT CALL TIME, not an
   * async race: `no-agent` is the pre-first-token window (a running run exists
   * but no Agent is registered yet). Both are returned, never thrown, for P2's
   * fallback to treat as "enqueue instead".
   */
  steerConversation(
    conversationId: string,
    message: string,
    onUndelivered: () => void = () => {},
    persistedMessageId?: string,
  ): SteerResult {
    const run = this.getActiveRunForConversation(conversationId);
    if (!run) return { status: "no-live-run" };
    // P4 guard — refuse to mid-run-steer an autonomous / structured-output run.
    // Runs BEFORE the Agent lookup so the pre-first-token window is guarded too.
    // The caller routes `guarded` to pending-messages (same fallback as
    // no-live-run / no-agent), and start-assignment's run-boundary drain then
    // preserves the "user steering wins / abandons in-flight schema correction"
    // invariant. Autonomous takes precedence in the reason when both hold (the
    // autonomous loop runs before schema validation each cycle).
    const mode = this.runModes.get(run.id);
    if (mode && (mode.autonomous || mode.schema)) {
      return { status: "guarded", runId: run.id, reason: mode.autonomous ? "autonomous" : "schema" };
    }
    const agent = this.activeAgents.get(run.id);
    if (!agent) return { status: "no-agent", runId: run.id };

    // The exact object we enqueue is the delivery-signal identity key: pi
    // emits `message_start` carrying THIS object when it drains the steer into
    // the run (agent-loop.js:94-99), so an identity match confirms delivery
    // and never false-matches the prompt / tool-result message_start events.
    const userMessage: UserMessage = {
      role: "user",
      content: message,
      timestamp: Date.now(),
    };
    const shadow: SteerShadow = {
      message: userMessage,
      agent,
      onUndelivered,
      delivered: false,
      unsubscribe: () => {},
      persistedMessageId,
      reconciled: false,
    };
    shadow.unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === "message_start" && event.message === userMessage) {
        shadow.delivered = true;
        shadow.unsubscribe();
      }
    });
    const shadows = this.steerShadows.get(run.id);
    if (shadows) shadows.push(shadow);
    else this.steerShadows.set(run.id, [shadow]);

    agent.steer(userMessage);
    return { status: "steered", runId: run.id };
  }

  /**
   * Settle every steer shadow-tracked for a run at its terminal (P2). A steer
   * is truly delivered ONLY if its delivery `message_start` was observed AND
   * the Agent it was queued into is still the run's live instance. Any other
   * case is re-offered via `onUndelivered` (the route re-enqueues it to
   * pending-messages):
   *   - never drained (loop finished past its final steering poll, or the run
   *     aborted before the next poll) — `!delivered`;
   *   - drained into an Agent that a pre-first-token failover then swapped out
   *     (failover.ts:220): the retry rebuilds context from the DB, which never
   *     held the steer, so it was lost even though `delivered` is set —
   *     `shadow.agent !== live`. No double-delivery: failover only swaps
   *     PRE-first-token, so the swapped-out attempt produced no user-visible
   *     response to the steer.
   * `activeAgents[runId]` is still populated here because finalize emits the
   * terminal event BEFORE finalizeCleanup deletes it (finalize.ts). This is
   * what makes `steered` best-effort-but-not-lossy: NO silent loss, NO
   * double-delivery. Idempotent — the run's entry is removed, so a second
   * terminal event is a no-op.
   */
  private flushSteerShadows(runId: string): void {
    const shadows = this.steerShadows.get(runId);
    if (!shadows) return;
    this.steerShadows.delete(runId);
    const live = this.activeAgents.get(runId);
    for (const shadow of shadows) {
      shadow.unsubscribe();
      if (!shadow.delivered || shadow.agent !== live) shadow.onUndelivered();
    }
  }

  /**
   * P4 §1.2 — persistence-layer reconciliation seam. subscribe-bridge calls this
   * on a `message_start` for a user message: if that exact object is a steer
   * shadow-tracked for `runId` and carries a caller-persisted DB row id, return
   * the id ONCE so the persistence layer can re-parent that row to the injection
   * position (the current branch leaf) and thread subsequent turns through it —
   * making the NEXT run's loadHistory rebuild the sequence the LLM saw. Matches
   * on object identity (the SAME UserMessage pi drained into the run), so it never
   * fires for the prompt or an unrelated turn, and the `reconciled` latch means a
   * re-emitted `message_start` can't double-reparent. Returns undefined for a
   * steer with no persisted row (send_to_agent injects an ephemeral prompt —
   * nothing to reconcile) or a non-steer message.
   *
   * `message` is `unknown`: the match is pure reference identity against the
   * exact objects we handed `agent.steer`, so the caller passes whatever its
   * `message_start` event carried (pi-agent-core's `AgentMessage` union) without
   * a type-coupling cast.
   */
  consumeSteerPersistedId(runId: string, message: unknown): string | undefined {
    const shadows = this.steerShadows.get(runId);
    if (!shadows) return undefined;
    const shadow = shadows.find((s) => s.message === message);
    if (!shadow || shadow.persistedMessageId === undefined || shadow.reconciled) {
      return undefined;
    }
    shadow.reconciled = true;
    return shadow.persistedMessageId;
  }

  /**
   * Cancel a run AND every descendant it spawned via `invoke_agent`
   * (the P1 fix: cancelling an orchestrator must stop the work its
   * children are doing, not just the parent). Depth-first and cycle-safe.
   * A child that already finished is a no-op — {@link cancelRunSelf}
   * returns false for an unknown id, and cascading still clears its stale
   * registry entry. The return value is the SELF cancel result (true iff
   * this run existed and was cancellable), preserving the pre-cascade
   * contract callers rely on.
   */
  cancelRun(id: string): boolean {
    return this.cancelRunInternal(id, new Set<string>());
  }

  private cancelRunInternal(id: string, visited: Set<string>): boolean {
    // Cycle guard: a (defensive) A→B→A registration must not loop forever.
    if (visited.has(id)) return false;
    visited.add(id);

    // Snapshot children BEFORE cancelling self — cancelRunSelf emits
    // run:cancel, whose terminal-event listener deregisters THIS id
    // (dropping the very set we're about to iterate).
    const children = [...(this.childRuns.get(id) ?? [])];

    const cancelled = this.cancelRunSelf(id);

    // Cascade regardless of the self result: a parent whose own run
    // already finished can still have live children to stop.
    for (const childId of children) this.cancelRunInternal(childId, visited);

    // Belt-and-suspenders: clear this parent's entry even when self was an
    // unknown id (no run:cancel emitted, so the listener never fired).
    this.childRuns.delete(id);

    return cancelled;
  }

  private cancelRunSelf(id: string): boolean {
    const run = this.runs.get(id);
    const controller = this.controllers.get(id);
    if (!run || !controller) return false;
    // Emission idempotency: a run can be reached twice in quick succession
    // (explicit cascade + a user's second Stop click) while its controller
    // is still in the map (finalizeCleanup deletes it later). Re-cancelling
    // an already-non-running run must not re-emit run:cancel — duplicate
    // terminal events would re-trigger quota releases and SSE cards.
    if (run.status !== "running") return false;

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
    options: { projectId?: string; provider?: string; model?: string; tier?: import("./tier-classifier").RoutingTier; system?: string; runId?: string; parentMessageId?: string; agentConfigId?: string; permissionMode?: import("./tools/types").PermissionMode; thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"; modeId?: string; orchestrationDepth?: number; toolRestriction?: "all" | "read-only" | "none"; allowedTools?: string[]; deniedTools?: string[]; readOnlyAllowedTools?: string[]; memberOverrides?: Map<string, import("../types").TeamMemberOverrides>; subAgentMembers?: import("../types").TeamMember[]; attachments?: import("../chat/attachments/content-builder").StagedAttachment[]; commandResolver?: import("./mention-wiring").CommandResolver },
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

    this.bus.emit("run:start", { run, runId: run.id });
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
    const cacheRetention: CacheRetention | undefined = resolveCacheRetentionSetting(
      await getSetting("compaction:cacheRetention"),
    );
    // Resolve the history-producer kill-switch ONCE per run. When on, the
    // subscribe seam live-appends each saved turn to the pi session tree
    // (design §5) — the read path (loadHistory) already synced/created the
    // session for this conversation. Off ⇒ the append seam is a strict no-op.
    const sessionHistoryProducer = await isSessionHistoryProducerEnabled();
    // Streaming state lives entirely on the per-call context. Re-zero
    // allTurnsText here — the watchdog already captured the closure
    // earlier and reads it lazily on each tick. runWithFailover also resets
    // it per attempt, so a failed pre-token attempt leaves nothing behind.
    ctx.allTurnsText = "";
    ctx.turnStart = Date.now();

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

      // WS2 — pre-stream provider failover. runWithFailover builds the
      // pi-agent, wires the event bridge, and prompts it; if the FIRST token
      // never streams and the provider fails with an availability error
      // (429/5xx/connection), it feeds the provider's circuit breaker,
      // asks the router for a fallback, rebuilds the agent on it, and
      // retries. Once a token/tool card has reached the client it rethrows
      // and the `catch` below (existing error handling) takes over —
      // mid-stream failover is a documented follow-up (see
      // docs/plans/2026-07-07-pi-caching-routing-integration.md §5).
      // The initial (already-resolved) attempt. Captured as a stable
      // reference so `subscribe` can distinguish it from a fallback attempt.
      const initialAttempt = {
        provider: resolvedModel.resolved.provider,
        model: resolvedModel.resolved.model,
        resolved: resolvedModel,
      };
      await runWithFailover({
        ctx,
        host,
        runId: run.id,
        // Fallback quality tier: the tier that actually produced this turn's
        // model (setup-tools). A pinned model carries its OWN inferred tier
        // (a pinned Opus fails over to a powerful-tier peer, never silently
        // to "balanced"); a routed turn carries the classifier/default tier.
        // The failover loop re-passes this tier to suggestFallback on every
        // iteration, so a chained 2nd failover stays in-tier too.
        tier: resolvedModel.effectiveTier,
        // Scope circuit-breaker state to the conversation owner's credentials
        // so one user's provider outage never degrades another's routing.
        credentialScope: convRecord?.userId ?? undefined,
        initial: initialAttempt,
        buildAgent: (resolved) =>
          buildPiAgent(ctx, history, { ...options, compaction, cacheRetention }, resolved, credentialConversationId, conversationId),
        // Bridge pi-agent-core events into the local EventBus + persist tool
        // calls / per-turn assistant messages. EVERY attempt (initial AND
        // fallback) passes the attempt's own provider/model — the SERVED
        // identity — so a routed turn persists the model that actually
        // served it (previously the initial attempt passed options verbatim
        // and routed turns persisted undefined + metered as "unknown").
        // The requested*/routedTier/failover fields are provenance for the
        // messages.usage JSONB (requested pin vs served, and whether a
        // pre-stream failover rebuilt the agent).
        subscribe: (agent, attempt) =>
          subscribeBridge(
            ctx,
            host,
            agent,
            conversationId,
            {
              ...options,
              provider: attempt.provider,
              model: attempt.model,
              requestedProvider: options.provider ?? null,
              requestedModel: options.model ?? null,
              routedTier: options.model ? undefined : resolvedModel.effectiveTier,
              failover: attempt !== initialAttempt,
              sessionHistoryProducer,
            },
            convRecord ?? null,
          ),
        runPrompt: (agent) =>
          attachmentImages.length > 0
            ? agent.prompt(promptInput, attachmentImages)
            : agent.prompt(promptInput),
        suggestFallback,
        resolveAttempt: async (suggestion) => {
          const attempt = await resolveFailoverAttempt(suggestion, credentialConversationId);
          run.provider = attempt.provider;
          return attempt;
        },
      });

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
      // Evict the oldest TERMINAL run, never a still-`running` one. The
      // old code evicted strictly by insertion order, so a fan-out of
      // >100 concurrent sub-runs (spawn quota is 25 concurrent × nested
      // depth) could evict a live run's record — after which the
      // watchdog tick early-returns on the missing map entry and
      // liveness monitoring silently stops (the run wedges with no
      // supervisor). Walk insertion order for the first non-running
      // entry; if every retained run is still running (pathological
      // burst), skip eviction this call and let the map grow — a live
      // run's record is never sacrificed to a soft cap.
      for (const [id, r] of this.runs) {
        if (r.status !== "running") {
          this.runs.delete(id);
          break;
        }
      }
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
    // Detach every steer delivery-listener BEFORE dropping the terminal
    // listeners below (which would otherwise strand them, leaking Agent
    // subscriptions). No re-enqueue on shutdown: the pending-messages mailbox
    // is in-memory and dies with the process, so re-offering would be a no-op.
    for (const shadows of this.steerShadows.values()) {
      for (const shadow of shadows) shadow.unsubscribe();
    }
    this.steerShadows.clear();
    this.runModes.clear();
    for (const unsub of this.childRunUnsubs) unsub();
    this.childRunUnsubs = [];
    this.childRuns.clear();
    for (const ctrl of this.controllers.values()) {
      if (!ctrl.signal.aborted) ctrl.abort();
    }
  }
}
