import type { ExtensionRegistry } from "./registry";
import type { ExtensionProcess } from "./subprocess";
import type { ToolCallResult, JsonRpcRequest, JsonRpcResponse } from "./types";
import type { ExtensionStateMediator } from "./state-mediator";
import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import type { AgentExecutor } from "../runtime/executor";
import type { PendingPermissionInfo } from "../runtime/stream-chat/host";
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
import { handlePiLlmComplete } from "./llm-handler";
import { handlePiMemory } from "./memory-handler";
import { handlePiLessons } from "./lessons-handler";
import { handlePiSearch } from "./search-handler";
import { handlePiSchedule } from "./schedule-handler";
import { handleDraftsRpc, type DraftsContext } from "./drafts-handler";
import { rpcError } from "./json-rpc";
import {
  handleRuntimeInvoke,
  isRuntimeInvokeMethod,
} from "./runtime-invoke-handler";
import type { ScheduleDaemon } from "./schedule-daemon";
import type { SpawnQuota } from "./spawn-quota";
import { getConversation, getConversationSpawnDepth } from "../db/queries/conversations";
import { getConversationExtensionIds } from "../db/queries/conversation-extensions";
import { persistToolCall } from "../db/queries/tool-calls";
import { resolveExtensionSettings } from "../db/queries/extension-settings";
import type { Decision, PermissionEngine } from "./permission-engine";
import { AUDIT_PERM_DENIED } from "./audit-actions";
import { insertAuditEntry } from "../db/queries/audit-log";
import { capabilityDeclarationToSet, grantsToCapabilitySet, intersect, type Capability, type CapabilitySet } from "./capability-types";
import { getRuntimeToolContext, withRuntimeToolContext } from "./runtime-tool-context";
import {
  createExtensionPermissionGate,
  type ApprovalResolution,
} from "../runtime/tools/permissions";
import { handleNetworkInternalRpc, type NetworkInternalContext } from "./network-handler";
import {
  handleFsReadRpc,
  handleFsWriteRpc,
  handleFsListRpc,
  handleFsStatRpc,
  handleFsExistsRpc,
  handleFsMkdirRpc,
  handleFsUnlinkRpc,
  type FsHandlerContext,
  type FsRpcResponse,
} from "./fs-handler";
import { buildEntityToolHandlers } from "@ezcorp/sdk/entities";
import { createHostEntityStore } from "./entities/host-store";
import { logger } from "../logger";
import {
  registerCallProvenance,
  resolveCallProvenance,
  releaseCallProvenance,
  type CallProvenance,
} from "./call-provenance";

const log = logger.child("ext.tool-executor");

/**
 * Pure parser for {@link MAX_TOOL_CALLS_PER_TURN}. Mirrors
 * {@link parseHostReverseRpcTimeoutMs} so the env-parsing contract is
 * unit-testable without process.env mutation:
 *   - `undefined` (env unset) → 100 default
 *   - a finite, strictly-positive number → `Math.floor` of it
 *   - NaN / non-numeric / `Infinity` → 100 default
 *   - zero or negative → 100 default
 */
export function parseMaxToolCallsPerTurn(raw: string | undefined): number {
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 100;
}

/**
 * Per-conversation per-turn tool-call cap. Default 100 (raised from the
 * original Phase 6 floor of 10, which killed legitimate multi-step
 * agentic turns). This is a coarse runaway-loop backstop — *what* each
 * call may do is already bounded by the per-call PDP gate, the
 * per-chain `MAX_CALL_DEPTH`, and the executor watchdog — so a generous
 * count is safe. Overridable via `EZCORP_MAX_TOOL_CALLS_PER_TURN`
 * (positive integer); an invalid / non-positive value falls back to
 * the 100 default.
 */
export const MAX_TOOL_CALLS_PER_TURN: number = parseMaxToolCallsPerTurn(
  process.env.EZCORP_MAX_TOOL_CALLS_PER_TURN,
);

/**
 * Phase 6 (finding M3) — process-singleton per-conversation per-turn
 * counter. A single LLM turn that fans out more than
 * {@link MAX_TOOL_CALLS_PER_TURN} tool calls in the same conversation
 * throws on the call past the cap, preventing runaway loops in a
 * compromised or buggy extension chain.
 *
 * Reset on `run:complete` for the conversation (wired below in
 * `wireMaxToolCallsCounter`). The counter is in-memory only — process
 * restart clears it, which is fine; a runaway turn that survives a
 * restart restarts at zero anyway because `run:complete` would have
 * fired during shutdown.
 *
 * Module-level singleton because `ToolExecutor` is constructed per-turn
 * by `setup-tools.ts`; a per-instance Map would reset on every turn
 * and never trigger the cap. The bus subscription (also process
 * singleton, attached on first `wireMaxToolCallsCounter` call) clears
 * the count when the run completes.
 */
const toolCallsThisTurn = new Map<string, number>();
let toolCallsCounterWired = false;

/**
 * Bounded timeout (ms) for HOST handling of a single inbound child→host
 * reverse-RPC request (the `setRequestHandler` dispatch in
 * {@link ToolExecutor.ensureSubprocessRpcWired}).
 *
 * Why this exists: a host reverse-RPC handler that never settles (e.g.
 * `ezcorp/drafts.create`'s `getDb().insert().returning()` stalling under
 * external Postgres) leaves the child's `getChannel().request(...)`
 * un-resolved → `proc.callTool` hangs → the ONLY safety net is the 90s
 * executor watchdog, which kills the whole run with a misleading
 * "exceeded its 90000ms call timeout" reason and an empty chat bubble.
 *
 * 20_000ms is deliberately:
 *   - comfortably BELOW the 90s watchdog idle threshold
 *     (`WATCHDOG_IDLE_MS`) so the failure is fast & visible as a normal
 *     `tool:error` card instead of a watchdog kill, AND
 *   - comfortably ABOVE any legitimate host DB/fs/network op (drafts,
 *     fs.*, storage, memory, lessons, schedule, agent-configs,
 *     task-event, append-message, finalize-tool-call, cancel-run,
 *     network.internal all complete in well under a second normally).
 *
 * On timeout the host replies `rpcError(req.id, -32603, …)` so the
 * child's `request()` REJECTS (not hangs) → the calling tool's existing
 * `catch` returns a `toolError(...)` → fast `tool:error` card. No new
 * child-side code is required.
 *
 * Overridable via `EZCORP_HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS` (positive
 * integer ms) for operators on pathologically slow external DBs; an
 * invalid / non-positive value falls back to the 20s default.
 */
/**
 * Pure parser for {@link HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS}. Extracted
 * from the module-level IIFE so the env-parsing contract is unit-testable
 * without process.env mutation. Behavior is byte-for-byte identical to
 * the previous inline IIFE:
 *   - `undefined` (env unset) → 20_000 default
 *   - a finite, strictly-positive number → `Math.floor` of it
 *   - NaN / non-numeric / `Infinity` → 20_000 default
 *   - zero or negative → 20_000 default
 */
export function parseHostReverseRpcTimeoutMs(raw: string | undefined): number {
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 20_000;
}

export const HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS: number =
  parseHostReverseRpcTimeoutMs(
    process.env.EZCORP_HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS,
  );

/**
 * Reverse-RPC methods EXEMPT from {@link HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS}.
 *
 * Audit result (Phase 1, Locked decision 5 — "no behavior change on the
 * healthy path"; `requiresUserInput`/legitimately-long handlers must be
 * exempt or budgeted):
 *
 *   - `ezcorp/invoke` — recursively dispatches ANOTHER extension's tool
 *     via `executeToolCall`. That nested tool may legitimately be a slow
 *     LLM-backed / shell-build tool carrying its own large
 *     `callTimeoutMs`; it is already bounded by its own per-call
 *     watchdog budget plus the per-chain (`MAX_CALL_DEPTH`) and
 *     per-conversation (`MAX_CALL_DEPTH_PER_CONVERSATION`) caps. A flat
 *     20s cap here would wrongly kill legitimate cross-extension chains.
 *
 *   - `ezcorp/llm-complete` — a full provider LLM completion round-trip
 *     (`ctx.llm.complete()`); long generations legitimately exceed 20s.
 *     Bounded by the provider/abort-signal, not by a host DB op.
 *
 * Every other host handler is a bounded DB/fs/network op and IS subject
 * to the timeout. Keep this set MINIMAL — adding an entry re-opens the
 * stuck-chat hole for that method.
 */
const REVERSE_RPC_HANDLER_TIMEOUT_EXEMPT: ReadonlySet<string> = new Set([
  "ezcorp/invoke",
  "ezcorp/llm-complete",
]);

/**
 * Sentinel returned by the timeout arm of the bounded-dispatch race.
 * A unique object reference so a handler that legitimately resolves to
 * `undefined`/`null` can never be mistaken for a timeout.
 */
const REVERSE_RPC_TIMEOUT = Symbol("reverse-rpc-handler-timeout");

/**
 * Race a host reverse-RPC handler against
 * {@link HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS}. On timeout, resolves to a
 * `-32603` JSON-RPC error response (NOT a rejection — the caller writes
 * it back to the child verbatim so the child's `request()` rejects fast
 * instead of hanging until the 90s watchdog). Exempt methods bypass the
 * race entirely and are awaited unbounded.
 *
 * The losing arm's promise is intentionally left to settle on its own
 * (a stalled DB call may never settle — that's the whole bug); we only
 * clear the timer so a fast handler doesn't leak an active timeout.
 */
async function dispatchReverseRpcWithTimeout(
  method: string,
  extensionId: string,
  reqId: number | string,
  handler: () => Promise<JsonRpcResponse>,
  /**
   * Caller-computed exemption for methods that multiplex
   * legitimately-long actions behind one method name. `ezcorp/drafts`
   * `verify`/`install` run a sandboxed `verifyExtension` smoke-test
   * round-trip (can exceed 20s) and `install` only ever runs AFTER an
   * explicit user-approval gate — the per-call watchdog is the correct
   * backstop there, not this flat per-handler cap. The fast drafts
   * actions (create/consume/resolveDir/listForUser/discard) stay
   * bounded. Keeping this caller-scoped (vs. adding `ezcorp/drafts` to
   * the global set) preserves the "set stays minimal" invariant.
   */
  exemptOverride = false,
): Promise<JsonRpcResponse> {
  if (exemptOverride || REVERSE_RPC_HANDLER_TIMEOUT_EXEMPT.has(method)) {
    return handler();
  }
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof REVERSE_RPC_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(REVERSE_RPC_TIMEOUT), HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS);
  });
  try {
    const winner = await Promise.race([handler(), timeoutPromise]);
    if (winner === REVERSE_RPC_TIMEOUT) {
      const elapsed = Date.now() - startedAt;
      log.error("Host reverse-RPC handler timed out — replying -32603", {
        method,
        extensionId,
        elapsedMs: elapsed,
        timeoutMs: HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS,
      });
      return rpcError(
        reqId,
        -32603,
        `Host handler for "${method}" timed out after ${HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS}ms`,
      );
    }
    return winner;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Test-only: reset the per-turn counter + un-wire the bus listener. */
export function _resetToolCallsCounterForTests(): void {
  toolCallsThisTurn.clear();
  toolCallsCounterWired = false;
}

/** Read-only test peek at the per-conversation tool call count. */
export function _getToolCallsThisTurnForTests(conversationId: string): number {
  return toolCallsThisTurn.get(conversationId) ?? 0;
}

/**
 * Phase 54 SEC-03 — per-conversation cross-ext call-depth cap.
 *
 * Replaces the pre-CC3 caller-supplied `_depth` param (per-CHAIN) with a
 * server-side counter (per-CONVERSATION). 50 parallel chains can no
 * longer collectively bypass the 10-deep per-chain cap by spawning
 * sibling chains.
 *
 * The map key is the parent conversation id (`this.currentConversationId`,
 * or a `cross-ext-<reqId>` synthetic when there's truly no parent — the
 * synthetic ids are unique per request, so they don't accidentally
 * collide and trigger false caps). Increment fires before the
 * handlePiInvoke body; decrement fires in `finally` so the slot is
 * reusable after the call settles.
 *
 * See tasks/v1.3-security-review.md CC3.
 */
const MAX_CALL_DEPTH_PER_CONVERSATION = 50;
const conversationCallDepth = new Map<string, number>();

/** Test-only: drop the per-conversation depth counter. */
export function _resetConversationCallDepthForTests(): void {
  conversationCallDepth.clear();
}

/**
 * Test-only: peek at the module-scope Map's entry count so the
 * lazy-delete path (tool-executor.ts:1135 `Map.delete` when count
 * decrements to 0) can be asserted directly rather than inferred from
 * absence of growth. Locking this in prevents a future "decrement-but-
 * don't-delete" refactor from silently leaking 0-count entries.
 */
export function _peekConversationCallDepthMapSizeForTests(): number {
  return conversationCallDepth.size;
}

/**
 * Phase 6 — error type thrown when a single LLM turn exceeds the
 * `MAX_TOOL_CALLS_PER_TURN` cap. Carries the conversationId + count so
 * the audit row + UI surface name the offending conversation.
 */
export class MaxToolCallsExceededError extends Error {
  constructor(public readonly conversationId: string, public readonly count: number) {
    super(
      `Max tool calls per turn exceeded for conversation "${conversationId}" ` +
        `(count=${count}, limit=${MAX_TOOL_CALLS_PER_TURN})`,
    );
    this.name = "MaxToolCallsExceededError";
  }
}

/**
 * Phase 3: tracks which extensions have already received the
 * `ezcorp/fs` deprecation warning. The shim emits exactly ONE warn
 * per extension per process — repeat calls are silent.
 *
 * Cleared per-extension when the registry's `cleanupExtTmpDir(extId)`
 * runs (on uninstall) so a reinstalled extension gets a fresh warning
 * on its next legacy-shim call (validator nit #5 / N2). Cleared
 * wholesale by `_resetFsDeprecationWarningsForTests` for unit tests.
 */
const fsDeprecationWarned = new Set<string>();

/** Test-only: clear the deprecation-warning tracker. */
export function _resetFsDeprecationWarningsForTests(): void {
  fsDeprecationWarned.clear();
}

/**
 * Drop the deprecation-warning entry for one extension. Called from
 * `registry.cleanupExtTmpDir` (uninstall path) so a reinstalled
 * extension warns afresh on its first legacy-shim call instead of
 * staying silently in the Set forever.
 */
export function clearFsDeprecationForExtension(extensionId: string): void {
  fsDeprecationWarned.delete(extensionId);
}

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

/**
 * @deprecated Phase 6 removal. Pre-PDP per-call hook replaced by the
 * `PermissionEngine` injected at `ToolExecutor` construction. The type
 * is retained briefly for any out-of-tree caller that referenced it;
 * production wires the engine directly.
 */
export type PermissionChecker = (
  extensionId: string,
  toolName: string,
  input: Record<string, unknown>,
) => Promise<boolean>;

export class PermissionDeniedError extends Error {
  constructor(
    public readonly extensionId: string,
    public readonly toolName: string,
    public readonly reason?: string,
  ) {
    const detail = reason ? ` — ${reason}` : "";
    super(`Permission denied for tool "${toolName}" from extension "${extensionId}"${detail}`);
    this.name = "PermissionDeniedError";
  }
}

/**
 * Orchestrates tool calls between LLM and extension subprocesses.
 * Every call routes through the `PermissionEngine` (Phase 1 PDP)
 * supplied at construction time. The engine is required — fail-closed
 * by design (closes finding C6).
 */
export type ArgsResolver = (
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface ToolExecutorOptions {
  bus?: EventBus<AgentEvents>;
  /** Phase 53.7 — when true, runtime-invoke calls from this executor's
   *  wired subprocesses are treated as event-driven. The conversation-
   *  scope gate (`checkConversationGate` in `runtime-invoke-handler.ts`)
   *  falls back to a `conversation_extensions` wiring lookup when the
   *  strict `currentConversationId` match fails. Used by the boot-spawn
   *  ToolExecutor in `web/src/lib/server/context.ts`; per-turn executors
   *  default to false so cross-extension manual calls keep the strict
   *  gate. */
  eventDriven?: boolean;
}

export class ToolExecutor {
  private bus?: EventBus<AgentEvents>;
  private stateMediator?: ExtensionStateMediator;
  // Tracks which subprocess INSTANCES have had their reverse-RPC
  // request handler wired. MUST be keyed by the ExtensionProcess
  // instance, NOT by extensionId: the registry replaces a dead /
  // idle-killed / crashed subprocess with a brand-new ExtensionProcess
  // object for the same extensionId (registry.ts getProcess). An
  // extensionId-keyed Set would early-return and skip
  // `setRequestHandler` on the new instance, leaving its
  // `transport.onRequest` null — every reverse-RPC the respawned child
  // makes is then silently dropped and its `tools/call` hangs until the
  // 90s watchdog (the "stuck chat" defect). A WeakSet keyed by the proc
  // object re-wires each fresh instance and lets GC'd corpses drop.
  private wiredProcs = new WeakSet<ExtensionProcess>();
  private currentUserId?: string;
  private currentConversationId?: string;
  private currentModel?: string;
  private currentProvider?: string;
  private currentAgentConfigId?: string;
  private executor?: AgentExecutor;
  private spawnQuota?: SpawnQuota;
  private scheduleDaemon?: ScheduleDaemon;
  private argsResolver?: ArgsResolver;
  // Watchdog visibility for the extension sensitive-cap PDP-prompt gate.
  // Built-in tool gates register in the executor's `pendingPermissions`
  // map directly (setup-tools.ts); the extension gate must too, or the
  // watchdog mis-reads a user-blocked prompt as a hung in-flight tool
  // and kills the run at the callTimeoutMs ceiling (the "stuck chat"
  // defect). No-op until wired so unit tests / non-streamChat callers
  // are unaffected.
  private registerPendingPermission: (key: string, info: PendingPermissionInfo) => void = () => {};
  private deregisterPendingPermission: (key: string) => void = () => {};
  /** Phase 53.7 — see ToolExecutorOptions.eventDriven. */
  private readonly eventDriven: boolean;

  constructor(
    private registry: ExtensionRegistry,
    private engine: PermissionEngine,
    options?: ToolExecutorOptions,
  ) {
    if (!engine) {
      throw new Error(
        "ToolExecutor requires a PermissionEngine (Phase 1 fail-closed contract)",
      );
    }
    this.bus = options?.bus;
    this.eventDriven = options?.eventDriven === true;
    // Phase 6 (M3): wire the per-turn counter to reset on run:complete.
    // Idempotent — module-level flag ensures a single bus subscription
    // even though many ToolExecutor instances are constructed per-turn.
    //
    // NOTE (reviewer S2): the module-level `toolCallsCounterWired`
    // binds to the FIRST `bus` instance that gets here. Production is
    // single-bus by design (one `host.bus` lives on `setup-tools.ts`'s
    // shared host), so this is a documentation requirement, not a code
    // change. If the runtime ever transitions to multi-bus topology
    // (e.g. per-tenant or per-process buses), this single-flag pattern
    // would silently bind the counter to one bus and orphan the rest.
    // Test-only `_resetToolCallsCounterForTests` resets the flag so
    // each test's `makeBus()` rewires correctly.
    if (this.bus && !toolCallsCounterWired) {
      toolCallsCounterWired = true;
      this.bus.on("run:complete", (data) => {
        const cid = (data as { conversationId?: string } | null | undefined)?.conversationId;
        if (cid) toolCallsThisTurn.delete(cid);
      });
      // Also clear on cancel/error so a turn aborted mid-flight
      // doesn't keep its stale count tying up the next turn's budget.
      this.bus.on("run:cancel", (data) => {
        const cid = (data as { conversationId?: string } | null | undefined)?.conversationId;
        if (cid) toolCallsThisTurn.delete(cid);
      });
      this.bus.on("run:error", (data) => {
        const cid = (data as { conversationId?: string } | null | undefined)?.conversationId;
        if (cid) toolCallsThisTurn.delete(cid);
      });
    }
  }

  /** Set the state mediator for routing extension notifications. */
  setStateMediator(mediator: ExtensionStateMediator): void {
    this.stateMediator = mediator;
  }

  /** Set the current user ID for storage scope resolution. */
  setCurrentUserId(userId: string): void {
    this.currentUserId = userId;
  }

  /** Set the current conversation ID. Production code wires this via
   *  `executeToolCall` (line 599); this setter exists primarily for
   *  tests that need to pin the conversation id without dispatching a
   *  real tool call (e.g. the SEC-03 per-conversation depth tests). */
  setCurrentConversationId(conversationId: string | null | undefined): void {
    this.currentConversationId = conversationId ?? undefined;
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

  /** Wire the shared ScheduleDaemon so `ctx.schedule.fireNow()` can
   *  share its quota counters + dispatch path. The daemon is owned by
   *  `src/startup/background-timers.ts`; this setter lets the same
   *  instance be threaded into every ToolExecutor in the process. */
  setScheduleDaemon(daemon: ScheduleDaemon): void {
    this.scheduleDaemon = daemon;
  }

  /** Register a pre-call transformer for tool args. Used to substitute
   *  symbolic references (e.g. `ez-attachment://<id>` handles) with their
   *  concrete values before the extension subprocess receives them. */
  setArgsResolver(fn: ArgsResolver): void {
    this.argsResolver = fn;
  }

  /** Wire the executor's `pendingPermissions` map (the watchdog's only
   *  signal for "a run is legitimately waiting on the user, don't kill
   *  it"). The built-in tool path registers there directly in
   *  setup-tools.ts; the extension sensitive-cap PDP-prompt gate must
   *  too — otherwise the watchdog mis-classifies a user-blocked prompt
   *  as a hung in-flight tool and kills the run at the 90s callTimeoutMs
   *  ceiling with a misleading reason (the "stuck chat" defect). No-op
   *  by default so unit tests and non-streamChat callers are
   *  unaffected. */
  setPendingPermissionGate(
    register: (key: string, info: PendingPermissionInfo) => void,
    deregister: (key: string) => void,
  ): void {
    this.registerPendingPermission = register;
    this.deregisterPendingPermission = deregister;
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
    _opts?: {
      callerExtensionId?: string;
      _callDepth?: number;
      metadata?: { invocationId?: string; source?: "inline" | "agent-run" };
      /** Phase 4: caller∩callee intersected cap set for cross-ext invokes. */
      capContext?: CapabilitySet;
      /** Phase 1: parent audit row for the chain — set by `handlePiInvoke` etc. */
      parentAuditId?: string;
    },
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

    // `tool:start` MUST precede any `tool:permission_request` so the
    // streaming UI has a `tool_ref` block to anchor the PermissionGate
    // card to. The built-in path already does this (subscribe-bridge
    // emits tool:start at tool_execution_start, before its gate);
    // emitting it only AFTER the gate (the old extension behavior) made
    // a sensitive-cap prompt (e.g. extension-author.create_extension's
    // fs.write) invisible — no card, no Allow button, and the watchdog
    // suspended by the pending-permission registration → a permanent
    // "generating extension" with no error. One idempotent emitter,
    // shared by the prompt branch and the normal post-gate path; the
    // flag prevents a double-emit (which would render two cards).
    const meta = _opts?.metadata;
    let toolStartEmitted = false;
    const emitToolStart = (timestamp: number): void => {
      if (toolStartEmitted) return;
      toolStartEmitted = true;
      this.bus?.emit("tool:start", {
        conversationId,
        extensionId,
        toolName,
        input,
        timestamp,
        ...(registered.cardType && { cardType: registered.cardType }),
        ...(registered.cardLayout && { cardLayout: registered.cardLayout }),
        ...(meta?.source && { source: meta.source }),
        ...(meta?.invocationId && { invocationId: meta.invocationId }),
      });
    };

    // Phase 6 (M3) — per-conversation per-turn tool-call cap. Increment
    // BEFORE the PDP gate so a denied call still counts against the
    // budget; this prevents an attacker who keeps tripping deny from
    // exhausting the engine and stalling the turn. The bus listener in
    // the constructor resets the counter on `run:complete`/`:cancel`/
    // `:error`. Cross-ext synthetic ids (`"cross-ext"` from the legacy
    // `handlePiInvoke` path — replaced with the real parent
    // conversationId in the same Phase 6 commit, see M4) DON'T count
    // against the budget so their nested calls don't double-charge the
    // parent's quota.
    if (conversationId && conversationId !== "cross-ext") {
      const next = (toolCallsThisTurn.get(conversationId) ?? 0) + 1;
      if (next > MAX_TOOL_CALLS_PER_TURN) {
        throw new MaxToolCallsExceededError(conversationId, next);
      }
      toolCallsThisTurn.set(conversationId, next);
    }

    // Resolve symbolic arg references (e.g. attachment handles → data URIs)
    // BEFORE the PDP check. The post-resolved args are what the
    // subprocess actually receives, so the PDP sees the same shape it
    // is enforcing on. (Closes finding C5: pre-resolver schemes like
    // `ez-attachment://` cannot launder into `file://` because the PDP
    // gate runs after the resolver.)
    if (this.argsResolver) {
      input = await this.argsResolver(input);
    }

    // Compute the tool's required capability set from its manifest
    // declaration. v2 manifests run through `migrateManifestV2ToV3` at
    // load time — every tool now has a `capabilities` declaration.
    const manifest = this.registry.getManifest(extensionId);
    const tool = manifest?.tools?.find((t) => t.name === originalName);
    const needed: Capability[] = [
      ...capabilityDeclarationToSet(tool?.capabilities, input),
    ];

    // Mandatory in-chat approval for agent-driven extension install.
    // The bundled `extension-author.install_draft` tool installs
    // model-authored code that then runs with its declared
    // permissions — the strongest trust boundary in the system. We
    // inject the sensitive `ezcorp:extension:install` cap into the
    // needed set HERE (rather than via the manifest CapabilityDeclaration
    // machinery) so the existing watchdog-bounded sensitive-cap gate
    // fires at tool-call start: the PDP subset check passes
    // (extension-author is granted it via `custom.drafts.kinds`), it's
    // sensitive + carved out of the bundled auto-allow + never
    // persisted, so it ALWAYS prompts. Approve → tool body runs the
    // `ezcorp/drafts.install` RPC; Deny → PermissionDeniedError, nothing
    // installed. Scoped to the bundled extension-author so a
    // user-installed look-alike can't reach this path.
    if (
      originalName === "install_draft" &&
      manifest?.name === "extension-author" &&
      this.registry.isBundled?.(extensionId) === true
    ) {
      // Boolean cap (no value) — like `shell`. The granted side
      // (`grantsToCapabilitySet` from `custom.drafts.kinds`) is also
      // valueless, so the subset check passes (a valued needed cap
      // would FAIL `capabilityCovers` against the valueless grant).
      // The specific draftId is already audited via the tool input.
      needed.push({ kind: "ezcorp:extension:install" });
    }

    // Mandatory in-chat approval for agent-driven extension MODIFY.
    // The bundled `extension-author.modify_extension` tool re-opens an
    // installed extension for editing — the entry point to rewriting
    // model-authored code. Same trust class and injection rationale as
    // `install_draft` above: sensitive, carved out of the bundled
    // auto-allow, never persisted → ALWAYS prompts. The host
    // `ezcorp/drafts.reopen` action independently enforces owner +
    // admin-`modifiable` + not-bundled authorization (defense in
    // depth). Scoped to the bundled extension-author so a user-
    // installed look-alike can't reach this path.
    if (
      originalName === "modify_extension" &&
      manifest?.name === "extension-author" &&
      this.registry.isBundled?.(extensionId) === true
    ) {
      needed.push({ kind: "ezcorp:extension:modify" });
    }

    // Phase 1 PDP gate. Fail-closed if the engine isn't wired —
    // constructor already enforces that, but the typecheck here is
    // additional belt-and-braces.
    //
    // Runtime fail-closed: if `engine.authorize` itself throws (DB
    // blip in `getSetting`, malformed cap, transient bug), convert to
    // PermissionDeniedError so the caller still rejects rather than
    // silently allowing the dispatch on the existing try/catch's
    // success path. The thrown error propagates up the same reject
    // path as a normal deny.
    // Phase 4 §M1/M2 — chain `parentAuditId` from the upstream
    // runtime context (set by the previous authorize() in this call
    // chain) when the caller didn't supply one explicitly. Top-level
    // dispatches see `getRuntimeToolContext() === undefined` and pass
    // `parentAuditId` as undefined; nested invokes pick it up from
    // the surrounding ALS scope.
    const upstreamCtx = getRuntimeToolContext();
    const inheritedParentAuditId =
      _opts?.parentAuditId ?? upstreamCtx?.currentAuditId;

    // Explicit `Decision` (not `typeof this.engine.authorize`): the
    // `typeof this` type query is fragile under the backend-only tsc
    // graph (a new drafts-handler→author-install→registry import edge
    // exposed a resolution cycle that made `this` unresolvable here).
    // `engine.authorize` returns `Promise<Decision>`, so this is
    // semantically identical and graph-independent.
    let decision: Decision;
    try {
      decision = await this.engine.authorize(
        {
          extensionId,
          // Phase 6: null is the canonical "no user" signal — the
          // PDP serializes it as JSON null in the audit row instead
          // of the literal string "unknown".
          userId: this.currentUserId ?? null,
          conversationId: conversationId ?? null,
          toolName: originalName,
          callerExtensionId: _opts?.callerExtensionId,
          capContext: _opts?.capContext,
          ...(inheritedParentAuditId !== undefined ? { parentAuditId: inheritedParentAuditId } : {}),
        },
        needed,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PermissionDeniedError(
        extensionId,
        toolName,
        `engine error: ${msg}`,
      );
    }

    if (decision.decision === "deny") {
      throw new PermissionDeniedError(extensionId, toolName, decision.reason);
    }
    if (decision.decision === "prompt") {
      // Phase 6 — sensitive-cap UI gate. The PDP returned a `prompt`
      // decision (every needed cap is granted, but a sensitive cap
      // — `shell` or `fs.write` — lacks an always-allow row for the
      // (user, scope, scopeId, capability) tuple). We open an
      // extension-scoped permission gate, emit `tool:permission_request`
      // for the originating user's UI, and AWAIT the user's
      // `{allowed, scope}` decision. The user's chosen scope is
      // persisted via `setSensitiveAlwaysAllow` so the next call to
      // the same sensitive cap inside the same scope auto-allows.
      //
      // The PDP path also wrote a `PERM_PROMPTED` audit row before
      // returning; we don't write a second row here. On user decline
      // we throw `PermissionDeniedError` to mirror the deny path.
      const sensitive = decision.sensitive;
      const capabilityKind: "shell" | "fs.write" =
        sensitive.kind === "shell" ? "shell" : "fs.write";

      const promptStartedAt = Date.now();
      // Terminalize the (now visible) tool card on any prompt-branch
      // failure — deny, gate transport error, or resolvePrompt error.
      // Without this the card we just rendered would hang forever even
      // though the call rejects. Uses the same namespaced `toolName` as
      // tool:start so the store correlates it to the same card.
      const terminalizePromptCard = async (message: string): Promise<void> => {
        const errorResult: ToolCallResult = {
          content: [{ type: "text", text: message }],
          isError: true,
        };
        await this.recordToolCall(
          conversationId,
          messageId,
          extensionId,
          toolName,
          input,
          errorResult,
          promptStartedAt,
          registered.cardType,
          registered.cardLayout,
        );
        this.bus?.emit("tool:error", {
          conversationId,
          extensionId,
          toolName,
          error: message,
          duration: Date.now() - promptStartedAt,
          ...(registered.cardType && { cardType: registered.cardType }),
          ...(registered.cardLayout && { cardLayout: registered.cardLayout }),
          ...(meta?.source && { source: meta.source }),
          ...(meta?.invocationId && { invocationId: meta.invocationId }),
        });
      };

      // Emit tool:start FIRST so the card + tool_ref block exist before
      // the prompt arrives. Same (namespaced) `toolName` the
      // start/complete/error events use — previously this emitted
      // `originalName`, which never matched the namespaced tool:start
      // entry in the store, so even a rendered card wouldn't correlate.
      emitToolStart(promptStartedAt);

      // Surface the prompt to the originating user's UI session only.
      // `userId` is the H7-scoped delivery key — the SSE filter at
      // `sse-conversation-filter.ts:shouldDeliverEvent` enforces that
      // only the matching subscriber sees the event.
      this.bus?.emit("tool:permission_request", {
        conversationId,
        toolCallId: decision.promptId,
        toolName,
        input,
        userId: this.currentUserId,
        extensionId,
        capabilityKind,
        ...(sensitive.value !== undefined ? { capabilityValue: sensitive.value } : {}),
        promptId: decision.promptId,
      });

      // Make this gate visible to the watchdog as a legitimate
      // user-wait, exactly like the built-in tool path
      // (setup-tools.ts). Keyed by `decision.promptId` — the same key
      // `createExtensionPermissionGate` and the resolve route use, so
      // register/deregister stay aligned with no toolCallId↔promptId
      // skew. Without this the watchdog treats the wait as a hung
      // in-flight tool and kills the run at the callTimeoutMs ceiling,
      // tearing down the prompt before the user can answer it.
      this.registerPendingPermission(decision.promptId, {
        conversationId,
        toolCallId: decision.promptId,
        toolName: originalName,
        input,
        category: "extension-sensitive",
      });

      let resolution: ApprovalResolution;
      try {
        resolution = await createExtensionPermissionGate({
          promptId: decision.promptId,
          conversationId,
          userId: this.currentUserId ?? "",
          extensionId,
          toolName: originalName,
          capabilityKind,
          ...(sensitive.value !== undefined ? { capabilityValue: sensitive.value } : {}),
        });
      } catch (err) {
        // The gate's promise resolves with `{allowed: false}` on
        // decline; reaching the catch arm means a transport-level
        // failure (e.g. server restart). Treat as deny.
        const msg = err instanceof Error ? err.message : String(err);
        await terminalizePromptCard(`permission gate error: ${msg}`);
        throw new PermissionDeniedError(
          extensionId,
          toolName,
          `permission gate error: ${msg}`,
        );
      } finally {
        // Runs on every exit — gate resolved (allow/deny), gate threw
        // (catch above), or any unexpected throw. Race-safe: the key is
        // the immutable `decision.promptId`. Symmetric with the
        // built-in path's `finally` deregister (setup-tools.ts).
        this.deregisterPendingPermission(decision.promptId);
      }

      if (!resolution.allowed) {
        await terminalizePromptCard("User declined permission prompt");
        throw new PermissionDeniedError(
          extensionId,
          toolName,
          "User declined permission prompt",
        );
      }

      // Persist always-allow at the user-chosen scope (default session
      // — least surprise; the gate falls back to "session" when no
      // scope is supplied, matching the spec's locked default).
      //
      // `engine.resolvePrompt` is the single source of truth: it writes
      // the always-allow settings row AND updates the engine's in-memory
      // allow cache so the next call to the same sensitive cap in the
      // same scope auto-allows. A previous version of this code ALSO
      // called `setSensitiveAlwaysAllow` directly here, which wrote a
      // second row under a different key shape (kind-only vs kind+value)
      // — the reader's lookup never found the legacy row, so users
      // hitting Allow Forever still re-prompted on every subsequent
      // call. Collapsed to one writer to make the asymmetry impossible.
      const scope = resolution.scope ?? "session";
      const scopeId =
        scope === "conversation"
          ? conversationId
          : scope === "session"
            ? `session:${this.currentUserId ?? ""}`
            : scope === "project"
              ? // Project scopeId resolution is deferred — we use the
                // conversationId as a stable key for now; a future
                // commit can map conversation→project when the PDP
                // gains project-aware lookups (the cache key already
                // accommodates it).
                conversationId
              : "*";
      // Phase 56: forward the picker's `ttlOverrideMs` (when supplied)
      // so the engine persists the per-row override alongside the
      // always-allow row. `undefined` here means the user hit Allow
      // via a legacy path (pre-Phase-56 client) — engine falls back
      // to the existing TTL_CONFIG[kind] / foreverTtlMs lookup.
      const resolvePromptOptions =
        resolution.ttlOverrideMs !== undefined
          ? { ttlOverrideMs: resolution.ttlOverrideMs }
          : undefined;
      try {
        await this.engine.resolvePrompt(
          decision.promptId,
          true,
          scope,
          scopeId,
          resolvePromptOptions,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await terminalizePromptCard(`permission persist error: ${msg}`);
        throw err;
      }
      // Fall through to dispatch — the user authorized this call.
    }

    // Track current call context for reverse RPC handlers (e.g. ezcorp/storage)
    this.currentConversationId = conversationId;

    // Phase 4 §M1/M2 — establish the runtime tool context for the
    // remainder of this dispatch. Any nested `handlePiInvoke` reads
    // `currentCapContext` (the post-intersection set this call ran
    // with) and `currentAuditId` (this authorize's row id). Inherits
    // unspecified fields from any surrounding scope so nested
    // invocations stack chained-deputy intersections correctly.
    const runtimeCtxForCall: import("./runtime-tool-context").RuntimeToolContext = {
      ...(_opts?.capContext !== undefined ? { currentCapContext: _opts.capContext } : {}),
      currentAuditId: decision.auditId,
    };

    const startTime = Date.now();
    // Idempotent: a no-op if the prompt branch already emitted it;
    // otherwise the normal pre-dispatch tool:start (unchanged behavior).
    emitToolStart(startTime);

    return withRuntimeToolContext(runtimeCtxForCall, async () => {
    try {
      // Resolve shared variables (x-shared) before dispatching to either
      // subprocess or MCP client.
      const resolvedInput = resolveSharedVariables(
        registered.inputSchema,
        input,
      );

      const manifest = this.registry.getManifest(extensionId);
      const isMcp = manifest?.kind === "mcp";

      // Phase 3 SDK-served branch — entity CRUD tools dispatch directly
      // to the SDK's auto-generated handler (bypassing the subprocess
      // and the MCP client entirely). The registry tagged these with
      // `entityKind` + `entityType`; dispatch finds the declaration on
      // the manifest, binds an EntityStoreLike to the acting scope, and
      // returns the SDK's `ToolCallResult` directly. The audit log
      // (`recordToolCall` below) still runs uniformly so SDK-served
      // calls appear in the same row as subprocess-served ones — only
      // the bytes between PDP and audit differ.
      if (registered.entityKind && registered.entityType && manifest) {
        const decl = manifest.entities?.find(
          (e) => e.type === registered.entityType,
        );
        if (!decl) {
          throw new Error(
            `Entity declaration "${registered.entityType}" not found on manifest for extension ${extensionId}`,
          );
        }
        const scope = decl.scope ?? "user";
        // Bind the host store to the acting scope. For "user", we use
        // the acting user (currentUserId). For "conversation", we use
        // the conversation id. "project" maps onto conversation per the
        // host-store adapter (v1 has no project tier).
        const scopeId =
          scope === "user"
            ? (this.currentUserId ?? null)
            : (conversationId ?? null);
        if (!scopeId) {
          throw new Error(
            `Cannot dispatch entity tool ${toolName}: no ${scope}-scope id available`,
          );
        }
        const store = createHostEntityStore({
          extensionId,
          scope,
          scopeId,
        });
        const handlers = buildEntityToolHandlers(decl, store);
        const handler = handlers[registered.entityKind];
        const entityResult = await handler(resolvedInput);
        await this.recordToolCall(
          conversationId,
          messageId,
          extensionId,
          toolName,
          input,
          entityResult,
          startTime,
          registered.cardType,
          registered.cardLayout,
        );
        const duration = Date.now() - startTime;
        this.bus?.emit("tool:complete", {
          conversationId,
          extensionId,
          toolName,
          output: entityResult,
          duration,
          success: !entityResult.isError,
          ...(registered.cardType && { cardType: registered.cardType }),
          ...(registered.cardLayout && { cardLayout: registered.cardLayout }),
          ...(meta?.source && { source: meta.source }),
          ...(meta?.invocationId && { invocationId: meta.invocationId }),
        });
        return entityResult;
      }

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
          // Pass the in-memory schema so the resolver skips the
          // per-call `extensions.manifest` DB query — N+1 fix.
          const resolved = await resolveExtensionSettings(
            extensionId,
            this.currentUserId ?? null,
            manifest.settings,
          );
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
        // Per-call reverse-RPC provenance. The subprocess echoes ONLY
        // this opaque, host-issued token back on its capability calls;
        // the host resolves the real {onBehalfOf, conversationId, runId,
        // parentCallId} from the registry — never from mutable singleton
        // state. The snapshot is taken from THIS call's values, so it
        // stays correct under concurrency and for long-running tools.
        const im = mergedInvocationMetadata as
          | { runId?: unknown; parentCallId?: unknown }
          | undefined;
        const ezCallId = registerCallProvenance({
          onBehalfOf: this.currentUserId ?? null,
          conversationId: conversationId ?? null,
          runId: typeof im?.runId === "string" ? im.runId : null,
          parentCallId: typeof im?.parentCallId === "string" ? im.parentCallId : null,
          actorExtensionId: extensionId,
          kind: "tool",
          ownerless: !this.currentUserId,
        });
        meta.ezCallId = ezCallId;
        // Only pass the fourth `options` arg when there's something to set —
        // keeps the 3-arg call shape for the common case (tests assert with
        // strict `toHaveBeenCalledWith` arity). The token is released the
        // moment the forward call returns — all reverse-RPCs for it have
        // necessarily completed by then.
        try {
          result = registered.requiresUserInput === true
            ? await proc.callTool(originalName, callArgs, meta, { skipTimeout: true })
            : await proc.callTool(originalName, callArgs, meta);
        } finally {
          releaseCallProvenance(ezCallId);
        }
      }

      // Record to tool_calls table
      await this.recordToolCall(
        conversationId,
        messageId,
        extensionId,
        toolName,
        input,
        result,
        startTime,
        registered.cardType,
        registered.cardLayout,
      );

      const duration = Date.now() - startTime;
      this.bus?.emit("tool:complete", {
        conversationId,
        extensionId,
        toolName,
        output: result,
        duration,
        success: !result.isError,
        ...(registered.cardType && { cardType: registered.cardType }),
        ...(registered.cardLayout && { cardLayout: registered.cardLayout }),
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
      await this.recordToolCall(
        conversationId,
        messageId,
        extensionId,
        toolName,
        input,
        errorResult,
        startTime,
        registered.cardType,
        registered.cardLayout,
      );

      const duration = Date.now() - startTime;
      this.bus?.emit("tool:error", {
        conversationId,
        extensionId,
        toolName,
        error: errorMsg,
        duration,
        ...(registered.cardType && { cardType: registered.cardType }),
        ...(registered.cardLayout && { cardLayout: registered.cardLayout }),
        ...(meta?.source && { source: meta.source }),
        ...(meta?.invocationId && { invocationId: meta.invocationId }),
      });

      return errorResult;
    }
    });
  }

  /**
   * @deprecated Phase 3: replaced by `ezcorp/fs.{read,write,list,stat,
   * exists,mkdir,unlink}` host-mediated handlers (`./fs-handler.ts`).
   * The path-check shim stays for one release so existing extensions
   * keep working unchanged. Phase 6 deletes it.
   *
   * Behavior:
   *  - Validates params (path, operation).
   *  - Runs `checkFilesystemPermission` (default mode "read") for the
   *    same allow/deny decision the old handler returned.
   *  - On allow: returns `{allowed, resolvedPath}` — IDENTICAL to the
   *    pre-Phase-3 shape. The subprocess still does the actual IO,
   *    using the now-poisoned `Bun.file` / `node:fs` primitives — which
   *    means **bundled extensions still calling this shim will have to
   *    route their reads through `ezcorp/fs.read` once they're
   *    migrated**. The shim itself doesn't fail; it just prints a
   *    warning so authors know to migrate.
   *  - On deny: same `denyAndDisable` + -32001 as before.
   *  - One-time `console.warn` per extension on FIRST call only (a
   *    Set tracks which extensions have already warned). Stops noisy
   *    repeated warns at runtime; tests reset via
   *    `_resetDeprecationWarningsForTests`.
   */
  async handlePiFs(
    extensionId: string,
    req: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    if (!fsDeprecationWarned.has(extensionId)) {
      fsDeprecationWarned.add(extensionId);
      console.warn(
        `[ezcorp/fs] deprecated: extension "${extensionId}" called the path-check shim. ` +
          "Migrate to ezcorp/fs.read | write | list | stat | exists | mkdir | unlink " +
          "(host-mediated; SDK helpers in @ezcorp/sdk/runtime). " +
          "This shim is removed in milestone v2.",
      );
    }
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

  // ── Phase 3: per-operation `ezcorp/fs.*` handlers ─────────────────

  /**
   * Build the FsHandlerContext shared by every fs.* handler.
   *
   * Provenance (userId / conversationId) is resolved from the
   * host-issued `ezCallId` correlation token the subprocess echoed
   * back — IDENTICAL to `handlePiDrafts` / `handlePiAppendMessage` —
   * NOT from the process-wide `currentUserId` / `currentConversationId`
   * singletons (wrong under concurrency and for background fires; this
   * is the latent half of the reverse-RPC provenance bug). The PDP
   * (`engine.authorize`) and audit log inside `fs-handler.ts` consume
   * `ctx.userId` / `ctx.conversationId`, so they MUST be the true
   * caller. The path-allowlist (`checkFilesystemPermission`) is keyed
   * on the extension's declared grant + install path, never the user —
   * so resolving real provenance here does not weaken it.
   *
   * On an unresolved (-32602) or ownerless (-32106) token, returns the
   * resolver's verbatim error response; the caller MUST return it. A
   * background fire hitting fs.* SHOULD cleanly fail, never silently
   * act as the "unknown" user.
   */
  private buildFsHandlerCtx(
    extensionId: string,
    req: JsonRpcRequest,
  ):
    | { ok: true; ctx: FsHandlerContext }
    | { ok: false; errorResponse: JsonRpcResponse } {
    const resolved = this.resolveReverseRpcMeta(extensionId, req);
    if (!resolved.ok) return { ok: false, errorResponse: resolved.errorResponse };
    return {
      ok: true,
      ctx: {
        extensionId,
        conversationId: resolved.conversationId ?? "unknown",
        userId: resolved.onBehalfOf,
        engine: this.engine,
        registry: this.registry,
      },
    };
  }

  /** `ezcorp/fs.read` — host-mediated read. Streams >1MB responses. */
  async handlePiFsRead(extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse> {
    const built = this.buildFsHandlerCtx(extensionId, req);
    if (!built.ok) return built.errorResponse;
    return handleFsReadRpc(req, built.ctx);
  }

  /** `ezcorp/fs.write` — host-mediated write. */
  async handlePiFsWrite(extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse> {
    const built = this.buildFsHandlerCtx(extensionId, req);
    if (!built.ok) return built.errorResponse;
    return handleFsWriteRpc(req, built.ctx);
  }

  /** `ezcorp/fs.list` — host-mediated directory list. */
  async handlePiFsList(extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse> {
    const built = this.buildFsHandlerCtx(extensionId, req);
    if (!built.ok) return built.errorResponse;
    return handleFsListRpc(req, built.ctx);
  }

  /** `ezcorp/fs.stat` — host-mediated stat. */
  async handlePiFsStat(extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse> {
    const built = this.buildFsHandlerCtx(extensionId, req);
    if (!built.ok) return built.errorResponse;
    return handleFsStatRpc(req, built.ctx);
  }

  /** `ezcorp/fs.exists` — host-mediated existence check. */
  async handlePiFsExists(extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse> {
    const built = this.buildFsHandlerCtx(extensionId, req);
    if (!built.ok) return built.errorResponse;
    return handleFsExistsRpc(req, built.ctx);
  }

  /** `ezcorp/fs.mkdir` — host-mediated mkdir. */
  async handlePiFsMkdir(extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse> {
    const built = this.buildFsHandlerCtx(extensionId, req);
    if (!built.ok) return built.errorResponse;
    return handleFsMkdirRpc(req, built.ctx);
  }

  /** `ezcorp/fs.unlink` — host-mediated unlink. */
  async handlePiFsUnlink(extensionId: string, req: JsonRpcRequest): Promise<FsRpcResponse> {
    const built = this.buildFsHandlerCtx(extensionId, req);
    if (!built.ok) return built.errorResponse;
    return handleFsUnlinkRpc(req, built.ctx);
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

    // Phase 54 SEC-03 — per-CHAIN cap (preserved). The pre-CC3 cap on
    // caller-supplied `_depth` still fails fast for a single runaway
    // chain. The new per-CONVERSATION cap layers on top to bound
    // parallel fan-out (50 chains can't collectively exhaust the
    // process by each going 10 levels deep).
    const MAX_CALL_DEPTH = 10;
    if (depth >= MAX_CALL_DEPTH) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: `Cross-extension call depth limit exceeded (max ${MAX_CALL_DEPTH})` },
      };
    }

    // Phase 54 SEC-03 — per-CONVERSATION cap. Compute `parentConvId`
    // BEFORE the body (the body re-uses the same value) so the cap
    // check and the executeToolCall dispatch agree on the key.
    // `cross-ext-<reqId>` is a synthetic id used when there's no parent
    // conversation; req.id is unique per request so the synthetic ids
    // don't collide. Increment here; decrement in `finally` below so
    // the slot is reusable after the call settles.
    const parentConvId = this.currentConversationId ?? `cross-ext-${req.id}`;
    const currentConvDepth = conversationCallDepth.get(parentConvId) ?? 0;
    if (currentConvDepth >= MAX_CALL_DEPTH_PER_CONVERSATION) {
      // Re-use AUDIT_PERM_DENIED with a structured `metadata.reason`
      // so audit-drilldown UI surfaces the cap event uniformly with
      // other PDP denies — no new audit-action constant needed.
      await insertAuditEntry(
        this.currentUserId ?? null,
        AUDIT_PERM_DENIED,
        callerExtId,
        {
          reason: "Per-conversation call-depth cap exceeded",
          conversationId: parentConvId,
          capabilityKind: "ezcorp:invoke",
          cap: MAX_CALL_DEPTH_PER_CONVERSATION,
          currentDepth: currentConvDepth,
        },
      ).catch(() => {
        /* audit best-effort, do not block the deny */
      });
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: -32000,
          message: `Per-conversation call-depth cap exceeded (max ${MAX_CALL_DEPTH_PER_CONVERSATION})`,
        },
      };
    }
    conversationCallDepth.set(parentConvId, currentConvDepth + 1);

    try {
    // Phase 53 — `runtime.<area>.<verb>` invoke methods route through
    // the host-runtime dispatcher BEFORE the dep-tool table lookup.
    // These are read-only host helpers (conversation messages, lessons
    // trigger-gate, per-extension settings) that the lessons-distiller
    // bundled extension needs without the LLM-facing tool surface.
    // Cross-extension namespaced tools (`pkg__tool`) are unaffected.
    if (isRuntimeInvokeMethod(tool)) {
      const granted = this.registry.getGrantedPermissions(callerExtId);
      if (!granted) {
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32603, message: "Caller extension not found in registry" },
        };
      }
      const manifest = this.registry.getManifest(callerExtId);
      // Per-call conversation-scope auth: thread the executor's
      // current conversation id (and acting user id) into the
      // RuntimeInvokeContext so `runtime.conversations.getMessages` /
      // `runtime.lessons.triggerGate` can enforce
      // `args.conversationId === ctx.currentConversationId`. Without
      // this, any installed extension could read messages from any
      // conversation across users — `conversation_extensions` wiring
      // is NOT consulted on the runtime-invoke fast path.
      const ctx = {
        extensionId: callerExtId,
        // Phase 53.4: thread the manifest name so `runtime.memory.compact`
        // / `runtime.memory.dedupMemoryWrite` can enforce their bundled-
        // only gate. Filled from the registry; never read from the
        // calling extension's params (spoofing defense).
        ...(manifest?.name ? { extensionName: manifest.name } : {}),
        userId: this.currentUserId ?? null,
        currentConversationId: this.currentConversationId ?? null,
        granted,
        ...(manifest?.settings ? { settingsSchema: manifest.settings } : {}),
        // Phase 53.7 — boot-spawn / event-driven path. The strict
        // conversation gate fails on this executor (no per-turn
        // currentConversationId), so the gate falls back to a
        // `conversation_extensions` wiring lookup keyed on the calling
        // extension's id — the same trust source the
        // EventSubscriptionDispatcher uses to decide WHO got the event.
        // Wiring lookup is a closure over the DB query so the handler
        // stays unit-testable without PGlite.
        ...(this.eventDriven
          ? {
              eventDriven: true as const,
              wiringLookup: async (conversationId: string, extensionId: string) => {
                const ids = await getConversationExtensionIds(conversationId);
                return ids.includes(extensionId);
              },
            }
          : {}),
      };
      return handleRuntimeInvoke(tool, args, ctx, req);
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

    // Phase 4 §M1 — full-chain chained-deputy attribution.
    //
    // ── v1.3 release-readiness security review (HIGH 3, 2026-05-09) ──
    //
    // The `acceptsCallerCaps` flag was originally documented (design
    // pillar 7 in `.planning/milestones/v1.3-permission-system-original-plan.md`
    // line 27) as the OPT-OUT marker: "deputies opt out via
    // `acceptsCallerCaps: true` to keep their own caps". Intersection
    // was meant to be the DEFAULT — closing the C1 confused-deputy
    // finding for every cross-extension call.
    //
    // The shipped Phase 4 code inverted that semantic: intersection
    // ran ONLY when the callee's GRANT carried `acceptsCallerCaps:
    // true`. Practical impact — a confused-deputy attack against any
    // non-deputy callee (A with no network → B with broad network →
    // A invokes B with malicious URL) was NOT prevented at the
    // intersection layer. The PDP authorized B's call against B's
    // installed grants, which already had the wide network surface.
    //
    // This block flips back to the design's stated default:
    //   - DEFAULT (acceptsCallerCaps absent or false): compute
    //     `capContext = intersect(callerCaps, calleeCaps)` and thread
    //     it through `executeToolCall`. The PDP receives the
    //     intersection and denies callee tool calls that exceed the
    //     caller's cap envelope. This closes the C1 confused-deputy
    //     gap for the wide majority of extensions.
    //   - OPT-OUT (`acceptsCallerCaps: true` on the callee's GRANT):
    //     `capContext` stays UNDEFINED. The PDP falls back to the
    //     callee's full installed grants — appropriate for a TRUSTED
    //     SHARED SERVICE that legitimately needs its own caps when
    //     invoked by less-privileged callers (e.g. the bundled
    //     `ai-kit` orchestration deputy). The flag now carries a
    //     "trust me" semantic that requires explicit user consent at
    //     install time (clamped via `clampExtensionPermissions`'s
    //     `manifestTopLevel.acceptsCallerCaps` gate).
    //
    // Bundled-extension sweep (2026-05-09): no bundled extension
    // currently declares `acceptsCallerCaps: true` in its manifest or
    // bundled-install grant. Pre-flip behavior under the OLD
    // semantics: NO bundled extension got intersection treatment
    // (intersection was opt-in). Post-flip behavior under the NEW
    // semantics: ALL bundled extensions get intersection treatment by
    // default. For every bundled extension reviewed, the new default
    // is correct — none of them are designed to receive widening
    // calls from less-privileged callers. If a future bundled
    // extension needs the opt-out, it must (a) declare
    // `acceptsCallerCaps: true` in its manifest, AND (b) be
    // explicitly granted via the install path.
    //
    // §M1 chained-deputy semantics still hold for the OPT-OUT branch:
    // if `currentCapContext` is set in the upstream runtime context,
    // we still respect the upstream chain — the deputy doesn't get
    // to LAUNDER a chain by sitting between two callers. (See
    // `cross-ext-attribution.test.ts` "M1 critical" assertion.)
    //
    // The check is `=== true` on the callee's GRANT, not its
    // manifest — a manifest declaring the flag without user consent
    // is treated as opted-out (spec lock-in: "runtime checks consult
    // the grant").
    //
    // See `tasks/v1.3-security-review.md` HIGH 3 for the full audit.
    const calleeGrants = this.registry.getGrantedPermissions(resolved.extensionId);
    const upstreamRuntimeCtx = getRuntimeToolContext();

    let capContext: CapabilitySet | undefined;
    if (calleeGrants?.acceptsCallerCaps !== true) {
      // DEFAULT (intersection-by-default). Flag absent or explicitly
      // false → compute `intersect(callerCaps, calleeCaps)`.
      //
      // Caller side: prefer the upstream effective caps when we're
      // inside a chain; fall back to caller's installed grants for
      // top-level invokes (top-level can't be a chain by definition).
      const callerCaps: CapabilitySet =
        upstreamRuntimeCtx?.currentCapContext ??
        grantsToCapabilitySet(this.registry.getGrantedPermissions(callerExtId) ?? null);
      const calleeCaps = grantsToCapabilitySet(calleeGrants ?? null);
      capContext = intersect(callerCaps, calleeCaps);
    }
    // OPT-OUT (`acceptsCallerCaps: true`): leave `capContext`
    // undefined so the PDP falls back to the callee's installed
    // grants. The user consented to this trust-elevation at install
    // time.

    // Phase 6 (finding M4) — propagate the real parent conversationId
    // through `ezcorp/invoke`. Pre-Phase-6 we passed the synthetic
    // `"cross-ext"` sentinel, which broke conversation-scoped checks
    // (storage scope, always-allow lookups, audit lineage) for any
    // cross-ext call. The parent's conversationId is whichever scope
    // we're already wired into — `currentConversationId` (set in
    // `executeToolCall` immediately before dispatch). `parentConvId`
    // is hoisted above (Phase 54 SEC-03) so the cap check and the
    // dispatch agree on the same key.
    const messageIdForCross = `cross-ext-${req.id}`;
    try {
      const result = await this.executeToolCall(
        resolved.name,
        args,
        parentConvId,
        messageIdForCross,
        {
          callerExtensionId: callerExtId,
          _callDepth: depth + 1,
          ...(capContext !== undefined ? { capContext } : {}),
          // Phase 4 §M2 — chain the audit id from the upstream
          // authorize. The inner executeToolCall will use it as
          // `parentAuditId` if `_opts.parentAuditId` isn't set. We
          // pass it explicitly so spawn-assignment + invoke chains
          // both flow through the same audit lineage even when the
          // ALS scope is dropped between async boundaries.
          ...(upstreamRuntimeCtx?.currentAuditId !== undefined
            ? { parentAuditId: upstreamRuntimeCtx.currentAuditId }
            : {}),
        },
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
    } finally {
      // Phase 54 SEC-03 — decrement on the way out. Lazy delete when
      // the count hits 0 so the Map doesn't grow unboundedly across
      // the process lifetime.
      const after = (conversationCallDepth.get(parentConvId) ?? 1) - 1;
      if (after <= 0) conversationCallDepth.delete(parentConvId);
      else conversationCallDepth.set(parentConvId, after);
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

    // Bug B: source the acting user + conversation from the per-call
    // provenance snapshot (the `_meta.ezCallId` the subprocess echoed back),
    // NOT the racy process-wide `currentUserId`/`currentConversationId`
    // singletons — parity with `handlePiFs`. The singletons observe the
    // wrong scope under concurrency (a slow call sees a later turn's user)
    // and are unset for background fires. An unresolved token fail-fasts
    // (`-32602`); an ownerless fire is allowed through with a null user so
    // the install-wide `global` scope stays reachable from cron fires (see
    // `resolveStorageProvenance`).
    const resolved = this.resolveStorageProvenance(extensionId, req);
    if (!resolved.ok) return resolved.errorResponse;

    const ctx: StorageContext = {
      conversationId: resolved.conversationId ?? "unknown",
      userId: resolved.onBehalfOf ?? "unknown",
      manifest,
      grantedPermissions: granted,
      // Phase 6: thread the PDP so the handler delegates the
      // permission decision to `engine.authorize` (audit log + scope
      // semantics applied uniformly).
      engine: this.engine,
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
      // Phase 6: thread the PDP. The engine reuses the same audit-log
      // + always-allow infrastructure as every other dispatch.
      engine: this.engine,
      conversationId: this.currentConversationId ?? "unknown",
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
      // Phase 6: thread the PDP for the canonical permission decision.
      engine: this.engine,
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
      // Phase 4: thread the registry so the handler can compute child
      // effective grants from each shared extension's installed grants
      // + manifest, and persist them on conversation_extensions.
      registry: this.registry,
      // Phase 6: thread the PDP for the canonical permission decision.
      engine: this.engine,
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
      // Phase 6: thread the PDP for the canonical permission decision.
      engine: this.engine,
      conversationId: this.currentConversationId ?? "unknown",
    };
    return handleCancelRunRpc(extensionId, req, ctx);
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
  async handlePiNetworkInternal(
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
    const ctx: NetworkInternalContext = {
      extensionId,
      conversationId: this.currentConversationId ?? "unknown",
      userId: this.currentUserId ?? "unknown",
      // Reuse the Phase 1 PDP singleton — wired at runtime boot. The
      // ToolExecutor's own `this.engine` field already holds the same
      // reference, but referring to the singleton keeps the handler
      // independently testable.
      engine: this.engine,
      registry: this.registry,
    };
    return handleNetworkInternalRpc(req, ctx);
  }

  /**
   * Install the reverse-RPC request handler + state-mediator
   * notification handler on this extension's subprocess. Idempotent
   * PER PROCESS INSTANCE: `wiredProcs` (a WeakSet keyed by the
   * ExtensionProcess object) is consulted first.
   *
   * Keying on the instance — not extensionId — is load-bearing. The
   * registry hands back a NEW ExtensionProcess whenever the previous
   * one died (idle-kill / crash / respawn); that new instance must get
   * its own `setRequestHandler`, or its `transport.onRequest` stays
   * null and every reverse-RPC the respawned child makes is silently
   * dropped at `json-rpc.ts` — the child's `getChannel().request(...)`
   * never resolves, so it never returns its `tools/call` result and
   * the host's `proc.callTool` hangs until the 90s watchdog (the
   * "stuck chat" defect). The old extensionId-keyed Set never cleared,
   * so a respawned subprocess was permanently mis-wired.
   *
   * Public so the messageToolbar event route can pre-wire the
   * subprocess BEFORE the bus emit (purely event-driven extensions
   * like `kokoro-tts` otherwise have no `onRequest` when they send
   * `ezcorp/append-message`).
   *
   * The closures capture `this`, but every handler reads from
   * `this.registry` / static helpers — no per-turn state — so
   * re-wiring a fresh proc is always safe.
   */
  async ensureSubprocessRpcWired(
    extensionId: string,
    proc: ExtensionProcess,
  ): Promise<void> {
    if (this.wiredProcs.has(proc)) return;
    this.wiredProcs.add(proc);

    if (this.stateMediator) {
      const mediator = this.stateMediator;
      proc.setNotificationHandler((notification) => {
        mediator.handleNotification(extensionId, notification);
      });
    }

    // The raw method router. Wrapped below in
    // `dispatchReverseRpcWithTimeout` so a host handler that never
    // settles can't wedge the child's reverse-RPC `request()` until the
    // 90s watchdog (the "stuck chat" defect). Exempt methods
    // (`ezcorp/invoke`, `ezcorp/llm-complete`) bypass the bound — see
    // REVERSE_RPC_HANDLER_TIMEOUT_EXEMPT.
    const route = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      if (req.method === "ezcorp/invoke") {
        return this.handlePiInvoke(extensionId, req);
      }
      // Phase 3: per-operation fs.* handlers come BEFORE the legacy
      // path-check `ezcorp/fs` shim. Method strings are exact-match
      // (no fallthrough), so this ordering is just for readability.
      if (req.method === "ezcorp/fs.read") {
        return this.handlePiFsRead(extensionId, req) as unknown as Promise<JsonRpcResponse>;
      }
      if (req.method === "ezcorp/fs.write") {
        return this.handlePiFsWrite(extensionId, req) as unknown as Promise<JsonRpcResponse>;
      }
      if (req.method === "ezcorp/fs.list") {
        return this.handlePiFsList(extensionId, req) as unknown as Promise<JsonRpcResponse>;
      }
      if (req.method === "ezcorp/fs.stat") {
        return this.handlePiFsStat(extensionId, req) as unknown as Promise<JsonRpcResponse>;
      }
      if (req.method === "ezcorp/fs.exists") {
        return this.handlePiFsExists(extensionId, req) as unknown as Promise<JsonRpcResponse>;
      }
      if (req.method === "ezcorp/fs.mkdir") {
        return this.handlePiFsMkdir(extensionId, req) as unknown as Promise<JsonRpcResponse>;
      }
      if (req.method === "ezcorp/fs.unlink") {
        return this.handlePiFsUnlink(extensionId, req) as unknown as Promise<JsonRpcResponse>;
      }
      // Legacy path-check shim — see `handlePiFs` JSDoc for the
      // deprecation roadmap. Emits a one-time console.warn per
      // extension on first call.
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
      if (req.method === "ezcorp/network.internal") {
        return this.handlePiNetworkInternal(extensionId, req);
      }
      if (req.method === "ezcorp/storage") {
        return this.handlePiStorage(extensionId, req);
      }
      if (req.method === "ezcorp/llm-complete") {
        return this.handlePiLlmComplete(extensionId, req);
      }
      if (req.method === "ezcorp/memory") {
        return this.handlePiMemory(extensionId, req);
      }
      if (req.method === "ezcorp/lessons") {
        return this.handlePiLessons(extensionId, req);
      }
      if (req.method === "ezcorp/search") {
        return this.handlePiSearch(extensionId, req);
      }
      if (req.method === "ezcorp/schedule") {
        return this.handlePiSchedule(extensionId, req);
      }
      if (req.method === "ezcorp/drafts") {
        return this.handlePiDrafts(extensionId, req);
      }
      return {
        jsonrpc: "2.0" as const,
        id: req.id,
        error: { code: -32601, message: "Method not found" },
      };
    };

    proc.setRequestHandler((req) => {
      // `ezcorp/drafts` verify/install run a sandboxed smoke-test
      // round-trip that legitimately exceeds the 20s per-handler cap;
      // install additionally only runs post user-approval. Exempt
      // ONLY those two actions — the other drafts actions stay bounded.
      const draftsAction =
        req.method === "ezcorp/drafts"
          ? (req.params as { action?: unknown } | undefined)?.action
          : undefined;
      const exempt =
        draftsAction === "verify" || draftsAction === "install";
      return dispatchReverseRpcWithTimeout(
        req.method,
        extensionId,
        req.id,
        () => route(req),
        exempt,
      );
    });
  }

  /** Phase 51 — `ctx.llm.complete()` reverse-RPC. The token NEVER
   *  crosses the JSON-RPC boundary; the host resolves credentials and
   *  invokes pi-ai's `complete()` directly. */
  async handlePiLlmComplete(
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
    const resolved = this.resolveReverseRpcMeta(extensionId, req);
    if (!resolved.ok) return resolved.errorResponse;
    return handlePiLlmComplete(req, {
      granted,
      registeredTool: { extensionId },
    }, resolved.rpcMeta);
  }

  /** Phase 51 — `ctx.memory.*` reverse-RPC. */
  async handlePiMemory(
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
    const resolved = this.resolveReverseRpcMeta(extensionId, req);
    if (!resolved.ok) return resolved.errorResponse;
    return handlePiMemory(req, {
      granted,
      registeredTool: { extensionId },
    }, resolved.rpcMeta);
  }

  /** Phase 51 — `ctx.lessons.*` reverse-RPC. */
  async handlePiLessons(
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
    const resolved = this.resolveReverseRpcMeta(extensionId, req);
    if (!resolved.ok) return resolved.errorResponse;
    return handlePiLessons(req, {
      granted,
      registeredTool: { extensionId },
    }, resolved.rpcMeta);
  }

  /** Phase 1 (shared-search) — `ctx.search.{web,read}` reverse-RPC. The
   *  provider chain runs host-side behind the SSRF egress guard; the
   *  handler gates on the `search` grant + delegates to `src/search`. */
  async handlePiSearch(
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
    const resolved = this.resolveReverseRpcMeta(extensionId, req);
    if (!resolved.ok) return resolved.errorResponse;
    return handlePiSearch(req, {
      granted,
      registeredTool: { extensionId },
    }, resolved.rpcMeta);
  }

  /** Phase 51 — `ctx.schedule.*` reverse-RPC. Today only `fire-now`
   *  is supported (manifest-only registration handles the rest). */
  async handlePiSchedule(
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
    const resolved = this.resolveReverseRpcMeta(extensionId, req);
    if (!resolved.ok) return resolved.errorResponse;
    return handlePiSchedule(req, {
      granted,
      registeredTool: { extensionId },
      ...(this.scheduleDaemon ? { daemon: this.scheduleDaemon } : {}),
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
  async handlePiDrafts(
    extensionId: string,
    req: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const granted = this.registry.getGrantedPermissions(extensionId);
    const manifest = this.registry.getManifest(extensionId);
    if (!granted || !manifest) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "Extension not found in registry" },
      };
    }
    const resolved = this.resolveReverseRpcMeta(extensionId, req);
    if (!resolved.ok) return resolved.errorResponse;
    const ctx: DraftsContext = {
      userId: resolved.onBehalfOf,
      grantedPermissions: granted,
    };
    const response = await handleDraftsRpc(manifest.name, req, ctx);

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
      this.bus &&
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
          this.bus.emit("extensions:installed", {
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
   * Resolve reverse-RPC provenance from the host-issued correlation
   * token the subprocess echoed back on `req.params._meta.ezCallId`.
   *
   * This REPLACES the old `buildHandlerRpcMeta()` which read
   * process-wide mutable singleton state (`currentUserId` /
   * `currentConversationId`) — wrong under concurrency and for
   * background fires. Provenance now comes from the per-call snapshot
   * registered at forward-dispatch time, keyed by an opaque host-issued
   * token. The subprocess can only echo the token back; it cannot
   * manufacture identity. `actorExtensionId` still comes from the
   * registered-tool record (the spoofing anchor), never the wire.
   *
   * Returns either `{ ok:true, prov, rpcMeta }` (rpcMeta feeds
   * `deriveHandlerContext`) or `{ ok:false, errorResponse }` the caller
   * MUST return verbatim:
   *   - unresolved token → `-32602`, logged at ERROR (a regression /
   *     orphaned subprocess — fail fast, never hang)
   *   - ownerless background fire → `-32106`, logged at INFO (a clean,
   *     expected soft-fail; never the `missing onBehalfOf` throw)
   */
  private resolveReverseRpcMeta(
    extensionId: string,
    req: JsonRpcRequest,
  ):
    | {
        ok: true;
        prov: CallProvenance;
        onBehalfOf: string;
        conversationId: string | null;
        rpcMeta: Record<string, unknown>;
      }
    | { ok: false; errorResponse: JsonRpcResponse } {
    const token = this.resolveCallToken(extensionId, req);
    if (!token.ok) return token;
    const prov = token.prov;
    if (prov.ownerless || !prov.onBehalfOf) {
      log.info(
        "reverse-RPC from a background fire with no resolvable owner — capability call skipped",
        { method: req.method, extensionId, kind: prov.kind },
      );
      return {
        ok: false,
        errorResponse: {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32106, message: "No owner scope for this background fire — capability unavailable" },
        },
      };
    }
    // Defense-in-depth tripwire (NOT a hard gate). The token is opaque,
    // single-use, host-issued, and only ever delivered to the one
    // subprocess it was minted for — a different extension cannot
    // observe or guess it (independent reviewer confirmed: 122-bit
    // UUID, per-subprocess stdin). In correct operation the resolving
    // extension always equals the token's `actorExtensionId`. We do NOT
    // hard-reject a mismatch because the cross-extension `ezcorp/invoke`
    // path's exact token/extension correspondence is subtle and a false
    // reject would break legitimate chained calls. Instead we log loud
    // so any real divergence (a regression, or an actual confusion
    // attempt) is caught in observability without functional risk.
    if (prov.actorExtensionId !== extensionId) {
      log.warn(
        "reverse-RPC token actorExtensionId != resolving extension — unexpected; proceeding (tripwire, not enforced)",
        {
          method: req.method,
          resolvingExtensionId: extensionId,
          tokenActorExtensionId: prov.actorExtensionId,
          kind: prov.kind,
        },
      );
    }
    const rpcMeta: Record<string, unknown> = { ezOnBehalfOf: prov.onBehalfOf };
    if (prov.conversationId) rpcMeta.ezConversationId = prov.conversationId;
    const invocationMetadata: Record<string, unknown> = {};
    if (prov.runId) invocationMetadata.runId = prov.runId;
    if (prov.parentCallId) invocationMetadata.parentCallId = prov.parentCallId;
    if (Object.keys(invocationMetadata).length > 0) {
      rpcMeta.invocationMetadata = invocationMetadata;
    }
    return {
      ok: true,
      prov,
      onBehalfOf: prov.onBehalfOf,
      conversationId: prov.conversationId,
      rpcMeta,
    };
  }

  /**
   * Shared first step of every reverse-RPC provenance resolution: read the
   * host-issued `_meta.ezCallId` the subprocess echoed back and resolve it
   * to the per-call snapshot. An UNRESOLVED token fail-fasts (`-32602`) for
   * ALL callers — a reverse-RPC with no valid host token is a regression /
   * orphaned subprocess, never trust the wire. Callers then apply their own
   * owner-scope policy to the returned `prov` (`resolveReverseRpcMeta`
   * rejects ownerless fires; `resolveStorageProvenance` allows them for the
   * install-wide global scope).
   */
  private resolveCallToken(
    extensionId: string,
    req: JsonRpcRequest,
  ):
    | { ok: true; prov: CallProvenance }
    | { ok: false; errorResponse: JsonRpcResponse } {
    const rawMeta = (req.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
    const ezCallId = typeof rawMeta?.ezCallId === "string" ? rawMeta.ezCallId : undefined;
    const prov = resolveCallProvenance(ezCallId);
    if (!prov) {
      log.error(
        "reverse-RPC provenance unresolved — no valid host-issued ezCallId; failing fast",
        { method: req.method, extensionId, ezCallId: ezCallId ?? null },
      );
      return {
        ok: false,
        errorResponse: {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32602, message: "Reverse-RPC provenance unresolved (no valid call token)" },
        },
      };
    }
    return { ok: true, prov };
  }

  /**
   * Resolve reverse-RPC provenance for `ezcorp/storage` (parity with
   * `handlePiFs`/`resolveReverseRpcMeta`). Sources the acting user +
   * conversation from the per-call snapshot the subprocess echoed back —
   * NOT the racy process-wide `currentUserId`/`currentConversationId`
   * singletons, which observe the wrong (or another conversation's) scope
   * under concurrency and are unset for background fires.
   *
   * UNLIKE `resolveReverseRpcMeta`, an OWNERLESS background fire is NOT an
   * error here: storage's `global` scope is deliberately ownerless-reachable
   * (cron fires write install-wide state — see `storage-handler.ts`
   * `resolveScopeId`). An ownerless fire is passed through with a `null`
   * user; `handleStorageRpc` then enforces the per-scope rules itself
   * (rejecting `user`/`conversation` scope when no scopeId resolves). An
   * UNRESOLVED token still fail-fasts (`-32602`), exactly like fs.
   */
  private resolveStorageProvenance(
    extensionId: string,
    req: JsonRpcRequest,
  ):
    | { ok: true; onBehalfOf: string | null; conversationId: string | null }
    | { ok: false; errorResponse: JsonRpcResponse } {
    const token = this.resolveCallToken(extensionId, req);
    if (!token.ok) return token;
    const prov = token.prov;
    // Defense-in-depth tripwire (log, not enforced) — parity with
    // `resolveReverseRpcMeta`. See its comment for why a mismatch is logged
    // rather than rejected (the cross-ext `ezcorp/invoke` correspondence is
    // subtle and a false reject would break legitimate chained calls).
    if (prov.actorExtensionId !== extensionId) {
      log.warn(
        "reverse-RPC token actorExtensionId != resolving extension — unexpected; proceeding (tripwire, not enforced)",
        {
          method: req.method,
          resolvingExtensionId: extensionId,
          tokenActorExtensionId: prov.actorExtensionId,
          kind: prov.kind,
        },
      );
    }
    return {
      ok: true,
      onBehalfOf: prov.ownerless ? null : prov.onBehalfOf,
      conversationId: prov.conversationId,
    };
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
    const resolved = this.resolveReverseRpcMeta(extensionId, req);
    if (!resolved.ok) return resolved.errorResponse;
    const ctx: AppendMessageContext = {
      conversationId: resolved.conversationId ?? "unknown",
      userId: resolved.onBehalfOf,
      grantedPermissions: granted,
      // Phase 6: thread the PDP for the canonical permission decision.
      engine: this.engine,
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
      // Phase 6: thread the PDP for the canonical permission decision.
      engine: this.engine,
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
    cardLayout?: string,
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
      cardLayout: cardLayout === "dock" || cardLayout === "inline" ? cardLayout : null,
      userId: this.currentUserId ?? null,
      agentConfigId: this.currentAgentConfigId ?? null,
      model: this.currentModel ?? null,
      provider: this.currentProvider ?? null,
    });
  }
}
