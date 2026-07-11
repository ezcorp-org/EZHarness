#!/usr/bin/env bun
// orchestration — multi-agent orchestration primitives extension.
//
// Phase 4 §1-§4: provides `invoke_agent` as a bundled extension, porting
// the legacy built-in formerly at src/runtime/tools/invoke-agent.ts
// (deleted in commit 5). The handler dispatches via the Phase 2d
// `spawnAssignment` reverse-RPC and bridges the async handle into the
// synchronous-to-the-LLM tool return via a `task:assignment_update`
// subscription (Phase 2c / same two-hop pattern the task-tracking
// extension shipped in Phase 3).
//
// Permission contract: requires `agentConfig: "read"`,
// `spawnAgents: { maxPerHour, maxConcurrent }`, and
// `eventSubscriptions: ["task:assignment_update"]`. No storage —
// the tool has no persistent state. Pending invocations live in a
// process-local map keyed on `assignmentId`; the subprocess is
// `persistent: true` so the map survives across calls.
//
// Phase B2 — Claude-Code-style background sub-agents. `invoke_agent`
// gains an optional `background: true` flag: instead of blocking the
// orchestrator's tool loop until the child terminates, it dispatches the
// child and returns IMMEDIATELY with a handle. Background spawns are
// tracked in a SECOND process-local map (`backgroundSpawns`, bounded) so a
// later `collect_agent_result` tool call can fetch (or wait for) the
// child's result. A background child is supervised by its own watchdog +
// the parent→child cascade-cancel; it legitimately OUTLIVES the parent RUN
// (the orchestrator's turn usually ends before the child finishes, and
// run:complete cascade-cancel deliberately does NOT fire for it). The host
// emits `agent:complete` + enqueues a completion-notify pending message on
// the parent conversation when the child terminates (see
// `notifyParentOnTerminal` in the SDK + start-assignment.ts). The SAME
// `task:assignment_update` subscription drives both maps — no new
// subscription is required.

import {
  createToolDispatcher,
  getChannel,
  AgentConfigs,
  registerEventHandler,
  spawnAssignment,
  cancelRun,
  queueAgentMessage,
  toolResult,
  type SpawnAssignmentInput,
  type SpawnAssignmentHandle,
  type CancelRunResult,
  type QueueAgentMessageResult,
  type ToolHandler,
  type ToolHandlerContext,
} from "@ezcorp/sdk/runtime";

// ── Capability bindings (swappable for tests) ──────────────────────

interface AgentConfigsLike {
  list(): Promise<
    Array<{ id: string; name: string; description: string; isTeam: boolean; ownerUserId: string | null }>
  >;
  resolve(
    idOrName: string,
  ): Promise<{ id: string; name: string; description: string; isTeam: boolean; ownerUserId: string | null } | null>;
}

type SpawnFn = (input: SpawnAssignmentInput) => Promise<SpawnAssignmentHandle>;
type RegisterEventHandlerFn = typeof registerEventHandler;
type CancelRunFn = (agentRunId: string) => Promise<CancelRunResult>;
type QueueAgentMessageFn = (
  subConversationId: string,
  message: string,
) => Promise<QueueAgentMessageResult>;

let agentConfigs: AgentConfigsLike = new AgentConfigs();
let spawn: SpawnFn = spawnAssignment;
let registerEventHandlerImpl: RegisterEventHandlerFn = registerEventHandler;
let cancelRunImpl: CancelRunFn = cancelRun;
let queueAgentMessageImpl: QueueAgentMessageFn = queueAgentMessage;

/** Test-only: inject a fake AgentConfigs resolver. */
export function _setAgentConfigsForTests(fake: AgentConfigsLike): void {
  agentConfigs = fake;
}
/** Test-only: inject a fake spawnAssignment. */
export function _setSpawnForTests(fake: SpawnFn): void {
  spawn = fake;
}
/** Test-only: inject a fake registerEventHandler. Defaults to the SDK's
 *  real implementation, which opens the channel; tests that want to
 *  drive the subscription manually (via `_internals.handleAssignmentUpdate`)
 *  can swap in a no-op. */
export function _setRegisterEventHandlerForTests(fake: RegisterEventHandlerFn): void {
  registerEventHandlerImpl = fake;
}
/** Test-only: inject a fake cancel-run client. The give-up path reaps the
 *  child through this seam; the real SDK `cancelRun` talks to the host over
 *  the channel, so unit tests that exercise the timeout branch MUST inject a
 *  stub or the reap would block on an absent host. */
export function _setCancelRunForTests(fake: CancelRunFn): void {
  cancelRunImpl = fake;
}
/** Test-only: inject a fake queue-agent-message client (the `send_to_agent`
 *  running-child steering seam). The real SDK `queueAgentMessage` talks to the
 *  host over the channel, so unit tests MUST inject a stub. */
export function _setQueueAgentMessageForTests(fake: QueueAgentMessageFn): void {
  queueAgentMessageImpl = fake;
}
/** Test-only: restore real SDK bindings. */
export function _resetBindingsForTests(): void {
  agentConfigs = new AgentConfigs();
  spawn = spawnAssignment;
  registerEventHandlerImpl = registerEventHandler;
  cancelRunImpl = cancelRun;
  queueAgentMessageImpl = queueAgentMessage;
}

// ── Timeouts (injectable for tests) ────────────────────────────────
//
// The base give-up timeout is resolved per call (see `invokeAgent`):
//   1. a valid per-call `timeoutSeconds` arg (30..3600s) wins, else
//   2. the host-threaded `invokeTimeoutMs` metadata (from the operator's
//      `orchestration:invokeTimeoutMs` setting; host default 300s), else
//   3. this module `defaultTimeoutMs` fallback.
// In the non-autonomous path the resolved base IS the give-up timeout; in
// the autonomous path it acts as a FLOOR under the per-cycle budget (see the
// `Math.max` at the resolution site). The wait is ALSO activity-aware: every
// non-terminal `task:assignment_update` for a live invocation resets the
// timer (sliding deadline), so a long multi-cycle child survives as long as
// it shows lifecycle activity. `defaultTimeoutMs` was raised 60s→300s to
// align the base with the host's own idle watchdog (90s / 300s / 900s), so
// the tool no longer gives up BEFORE the platform considers the child idle.
const DEFAULT_AGENT_TIMEOUT_MS = 300_000;
let defaultTimeoutMs = DEFAULT_AGENT_TIMEOUT_MS;

// Autonomous-mode wait budget. A looping sub-agent does NOT reach a
// terminal `task:assignment_update` until it self-reports done/blocked
// or exhausts its cycle cap, so the synchronous `invoke_agent` wait
// must be widened. Per-cycle budget is generous (each cycle is itself a
// full run guarded by the host's idle watchdog); +1 covers the final
// terminal cycle. The resolved base is a FLOOR — a larger operator /
// per-call timeout still wins (see `Math.max` at the resolution site).
const AUTONOMOUS_PER_CYCLE_MS = 120_000;
const ORCH_DEFAULT_MAX_CYCLES = 8;

/** Per-call `timeoutSeconds` bounds — mirror the manifest inputSchema
 *  (`minimum` / `maximum`). A value outside this window is ignored and the
 *  metadata/base timeout applies instead. */
const MIN_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 3600;

/** Test-only: shrink the default 300s timeout so the timeout branch can
 *  be exercised without waiting minutes. */
export function _setDefaultTimeoutMsForTests(ms: number): void {
  defaultTimeoutMs = ms;
}

// ── Pending-invocation tracking ────────────────────────────────────
//
// Keyed on `assignmentId` — the handle returned by `spawnAssignment`
// carries it through, and the host's `task:assignment_update` payload
// echoes it back. Resolved / rejected by the subscription handler
// registered at module load. Subprocess is `persistent: true`, so this
// map survives across tool calls.

interface PendingInvocation {
  resolve: (result: { result: string; success: boolean }) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  /** Duration used to (re-)arm the give-up timer. The sliding-deadline path
   *  in `handleAssignmentUpdate` re-arms with this same duration on activity. */
  timeoutMs: number;
  /** Bound give-up handler — reaps the child then rejects. Re-armed by the
   *  subscription handler on each non-terminal activity update. */
  fireTimeout: () => void;
  agentName: string;
  agentConfigId: string;
  subConversationId: string;
  /** Sub-agent run id — used to reap (cancel) the child on give-up so it
   *  stops burning tokens and its quota slot frees for re-dispatch. */
  agentRunId: string;
  /** The conversation that spawned this (sync) invocation. `send_to_agent`
   *  authorizes running-child steering against it, mirroring the
   *  backgroundSpawns owner check — the maps are process-global across every
   *  conversation on the shared subprocess. Undefined only when the host set no
   *  conversation id (fail-closed: an entry with no owner is un-steerable). */
  ownerConversationId?: string;
}

const pendingInvocations = new Map<string, PendingInvocation>();

// ── Background-spawn tracking (Phase B2) ───────────────────────────
//
// A `background: true` invoke returns immediately; the child's result is
// fetched later via `collect_agent_result`. This map REMEMBERS every
// background spawn across tool calls (the subprocess is `persistent: true`)
// keyed on `assignmentId`. The same `task:assignment_update` subscription
// that resolves synchronous invocations updates these entries: it tracks the
// LIVE cycle run id on activity and, on the terminal transition, stores the
// shaped result and resolves any `collect_agent_result` gates waiting on it.
//
// Bounded to the last {@link MAX_BACKGROUND_SPAWNS} entries; when full, the
// OLDEST TERMINAL entry is evicted first so an in-flight child (which a later
// collect may still query) is never dropped.

/** A `collect_agent_result` call waiting for a not-yet-terminal background
 *  spawn. Resolved by the terminal `task:assignment_update`, or by its own
 *  sliding-deadline timer (which returns a NON-error "still running" status
 *  — a collect timeout never reaps the child). */
interface CollectWaiter {
  /** Resolve the gate with the terminal result. */
  resolveTerminal: (result: { result: string; success: boolean }) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  /** Wait budget used to (re-)arm the sliding deadline on child activity. */
  timeoutMs: number;
  /** Bound expiry handler — removes the waiter and resolves "still running".
   *  Re-armed on each non-terminal activity update (mirrors the sync
   *  invoke_agent sliding deadline). */
  fireTimeout: () => void;
}

interface BackgroundSpawn {
  agentName: string;
  agentConfigId: string;
  subConversationId: string;
  /** Sub-agent run id — updated to the LIVE cycle run on every non-terminal
   *  activity update (the spawn handle's id is frozen at cycle 1). */
  agentRunId: string;
  /** F3 (caller authorization): the conversation that SPAWNED this background
   *  agent. The map is process-GLOBAL across every user/conversation on the
   *  shared orchestration subprocess, so `collect_agent_result` must reject a
   *  call whose conversation id doesn't match this — otherwise conversation A
   *  could read (or confirm the existence of) conversation B's results by
   *  guessing an assignmentId. Undefined only for spawns registered without a
   *  host-set conversation id (fail-closed: such an entry is uncollectable). */
  ownerConversationId?: string;
  /** Set once a terminal `task:assignment_update` lands. */
  terminal: boolean;
  /** F5: set once a `collect_agent_result` has RETURNED this spawn's terminal
   *  result. Eviction prefers collected-terminal entries (their result has been
   *  read) over terminal-but-uncollected ones. */
  collected: boolean;
  /** Shaped { result, success } — present iff `terminal`. Uses the SAME
   *  resultFull / structuredResult / structuredResultError precedence as the
   *  synchronous path (see {@link shapeTerminalResult}). */
  result?: { result: string; success: boolean };
  /** Live `collect_agent_result` gates awaiting this spawn's terminal. */
  waiters: Set<CollectWaiter>;
}

/** Max background spawns retained. In-flight entries are never evicted; only
 *  terminal ones are, so the effective ceiling is 50 + in-flight (in-flight is
 *  itself capped by the extension's `maxConcurrent` quota). */
const MAX_BACKGROUND_SPAWNS = 50;

const backgroundSpawns = new Map<string, BackgroundSpawn>();

/** Register a background spawn, evicting to stay within
 *  {@link MAX_BACKGROUND_SPAWNS}. Eviction order (Map iteration is
 *  insertion-ordered, so "first found" == oldest): (F5) the oldest
 *  COLLECTED-terminal entry (its result has already been read), then the oldest
 *  terminal-but-uncollected entry. An in-flight entry is NEVER evicted (a live
 *  collect may still be waiting on it) — the map may briefly run over the soft
 *  cap in the pathological all-in-flight case. */
function registerBackgroundSpawn(
  handle: SpawnAssignmentHandle,
  agentName: string,
  agentConfigId: string,
  ownerConversationId?: string,
): void {
  while (backgroundSpawns.size >= MAX_BACKGROUND_SPAWNS) {
    let evictKey: string | undefined;
    for (const [key, val] of backgroundSpawns) {
      if (val.terminal && val.collected) { evictKey = key; break; }
    }
    if (evictKey === undefined) {
      for (const [key, val] of backgroundSpawns) {
        if (val.terminal) { evictKey = key; break; }
      }
    }
    if (evictKey === undefined) break; // all in-flight — don't drop a live one
    backgroundSpawns.delete(evictKey);
  }
  backgroundSpawns.set(handle.assignmentId, {
    agentName,
    agentConfigId,
    subConversationId: handle.subConversationId,
    agentRunId: handle.agentRunId,
    ...(ownerConversationId ? { ownerConversationId } : {}),
    terminal: false,
    collected: false,
    waiters: new Set(),
  });
}

// ── invoke_agent tool handler ──────────────────────────────────────
//
// Mirrors the legacy built-in (formerly at
// `src/runtime/tools/invoke-agent.ts`, deleted in Phase 4 commit 5)
// surface: same JSON schema, same error strings, same `_agentMeta`
// in the details. Overrides / teamToolScope / parentMessageId /
// orchestrationDepth ride in on `ctx.invocationMetadata` — the host's
// `wireOrchestrationToolsForTurn` (commit 4) binds them at tool-wiring
// time via `extensionToAgentTool`'s `invocationMetadata` seam.

const invokeAgent: ToolHandler = async (args, ctx?: ToolHandlerContext) => {
  const { agentConfigId, task, autonomous, maxCycles, timeoutSeconds, outputSchema, background } = args as {
    agentConfigId: string;
    task: string;
    autonomous?: boolean;
    maxCycles?: number;
    timeoutSeconds?: number;
    outputSchema?: Record<string, unknown>;
    background?: boolean;
  };

  // Validate: agent must exist and be visible to this user. Legacy
  // built-in returned "Error: Unknown agent "${id}"" when the id wasn't
  // in the per-turn allowlist. The extension path has a single error
  // string for both "not in allowlist" and "config not found in DB"
  // because the `ezcorp/agent-configs` reverse RPC returns null for
  // both cases — the SDK never distinguishes them.
  const config = await agentConfigs.resolve(agentConfigId);
  if (!config) {
    return toolResult(`Error: Unknown agent "${agentConfigId}".`, {
      isError: true,
    });
  }

  // Build spawn input from ctx.invocationMetadata (set by the host at
  // tool-invoke time in commit 4). Spread each field optionally — only
  // include when metadata has it.
  const md = ctx?.invocationMetadata ?? {};

  // Resolve the base give-up timeout (see the Timeouts block for the
  // precedence ladder). A per-call `timeoutSeconds` in the accepted window
  // overrides the host-threaded `invokeTimeoutMs` metadata, which in turn
  // overrides the module `defaultTimeoutMs`.
  const metaTimeoutMs =
    typeof md.invokeTimeoutMs === "number" &&
    Number.isFinite(md.invokeTimeoutMs) &&
    md.invokeTimeoutMs > 0
      ? md.invokeTimeoutMs
      : defaultTimeoutMs;
  const perCallTimeoutMs =
    typeof timeoutSeconds === "number" &&
    Number.isFinite(timeoutSeconds) &&
    timeoutSeconds >= MIN_TIMEOUT_SECONDS &&
    timeoutSeconds <= MAX_TIMEOUT_SECONDS
      ? timeoutSeconds * 1000
      : undefined;
  const resolvedBaseMs = perCallTimeoutMs ?? metaTimeoutMs;

  // Autonomous opt-in: presence of `autonomous: true` enables the
  // host-side self-continuation loop. A positive finite `maxCycles`
  // overrides the runtime default; otherwise the runtime default
  // applies (mirrored here only for the timeout computation).
  const autonomousCfg = autonomous === true
    ? (typeof maxCycles === "number" && Number.isFinite(maxCycles) && maxCycles > 0
        ? { maxCycles }
        : {})
    : undefined;
  const effectiveMaxCycles = autonomousCfg?.maxCycles ?? ORCH_DEFAULT_MAX_CYCLES;
  // Autonomous mode widens the wait to cover every self-continuation cycle,
  // but never shrinks below the resolved base — a large operator/per-call
  // timeout still wins.
  const timeoutMs = autonomousCfg
    ? Math.max(AUTONOMOUS_PER_CYCLE_MS * (effectiveMaxCycles + 1), resolvedBaseMs)
    : resolvedBaseMs;
  const spawnInput: SpawnAssignmentInput = {
    task,
    agentConfigId,
    reuseSubConversationFor: agentConfigId,
    title: config.name,
    ...(typeof md.parentMessageId === "string"
      ? { parentMessageId: md.parentMessageId }
      : {}),
    ...(md.overrides && typeof md.overrides === "object"
      ? { overrides: md.overrides as Record<string, unknown> }
      : {}),
    ...(md.teamToolScope && typeof md.teamToolScope === "object"
      ? { teamToolScope: md.teamToolScope as { allowedTools?: string[]; deniedTools?: string[] } }
      : {}),
    ...(typeof md.orchestrationDepth === "number"
      ? { orchestrationDepth: md.orchestrationDepth }
      : {}),
    // Parent orchestrator run id (host-set) → registers this spawn as a
    // child so a Stop on the orchestrator cascades to the sub-agent.
    ...(typeof md.parentRunId === "string" ? { parentRunId: md.parentRunId } : {}),
    ...(autonomousCfg ? { autonomousContinuation: autonomousCfg } : {}),
    // Structured output: forward the caller's JSON Schema so the host
    // validates the child's final output against it (and re-prompts on
    // failure). Only a plain object is threaded — arrays/primitives are
    // dropped here and would also be rejected host-side.
    ...(outputSchema && typeof outputSchema === "object" && !Array.isArray(outputSchema)
      ? { outputSchema }
      : {}),
    // Background spawns ask the host to emit `agent:complete` + enqueue a
    // completion-notify pending message for the parent conversation on the
    // child's terminal transition. A synchronous invoke never sets this — the
    // orchestrator is already awaiting the result inline.
    ...(background === true ? { notifyParentOnTerminal: true } : {}),
  };

  let handle: SpawnAssignmentHandle;
  try {
    handle = await spawn(spawnInput);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolResult(
      `Agent "${config.name}" failed: ${msg}`,
      { isError: true },
    );
  }

  // ── Background spawn (Phase B2) ──────────────────────────────────
  //
  // Return IMMEDIATELY with a handle instead of blocking on completion. No
  // pending-invocation timer is armed (no timeout, no reap): the child is
  // supervised by its own idle watchdog + the parent→child cascade-cancel,
  // and it legitimately OUTLIVES the parent RUN — the orchestrator's turn
  // usually ends before the child finishes, and run:complete cascade-cancel
  // does NOT fire for a background child by design. It stays cancellable via
  // a Stop on the assignment/task panel. The result is fetched later via
  // `collect_agent_result`.
  //
  // F4 (honest notify): on terminal the host emits `agent:complete` (UI chip +
  // observability) AND enqueues a pending-message nudge on the parent
  // conversation — but that pending message is only DRAINED when the parent is
  // itself a sub-agent whose run later ends (nested teams) or a goal-host loop.
  // A TOP-LEVEL orchestrator (the user's main chat) has no idle-queue drainer,
  // so it is NOT auto-notified in-conversation. The returned text therefore does
  // NOT promise notification: the orchestrator must POLL with collect_agent_result.
  if (background === true) {
    const ownerConversationId =
      typeof md.conversationId === "string" ? md.conversationId : undefined;
    registerBackgroundSpawn(handle, config.name, agentConfigId, ownerConversationId);
    return toolResult(
      `Agent "${config.name}" started in the background (assignmentId: ${handle.assignmentId}, ` +
        `subConversation: ${handle.subConversationId}). Its progress and completion show in the ` +
        `task panel. To get its result, call collect_agent_result with this assignmentId (it ` +
        `blocks up to waitSeconds, or returns a non-error "still running" status) — do NOT assume ` +
        `you will be auto-notified in this conversation. Note: a background agent holds a ` +
        `concurrent spawn slot until it reaches a terminal state, so many parallel background ` +
        `agents can exhaust the spawn quota.`,
      {
        details: {
          _agentMeta: {
            subConversationId: handle.subConversationId,
            agentName: config.name,
            agentConfigId,
            assignmentId: handle.assignmentId,
          },
        },
      },
    );
  }

  // Wait-for-completion promise gate. The subscription handler below
  // resolves this with `{ result, success }` when it sees a matching
  // `task:assignment_update` with a terminal status. Timeout is the
  // only reject path — both `completed` and `failed` resolve,
  // differentiated by the `success` flag, so callers only have one
  // branch for "terminal" vs "timeout". Wave 1: `result` is the FULL
  // sub-agent output (event `resultFull`), not the 200-char preview.
  const completion = new Promise<{ result: string; success: boolean }>(
    (resolve, reject) => {
      // Give-up path: reap the still-running child, THEN reject with an
      // actionable error. On timeout the child would otherwise keep
      // running (orphaned, burning tokens) and the orchestrator would get
      // a non-actionable error and often re-dispatch (double execution).
      //
      // `liveAgentRunId` is the CURRENTLY-live run id, captured from the
      // pending entry at fire time — NOT `handle.agentRunId`, which is frozen
      // at cycle 1. A multi-cycle child's live run id is updated by the
      // sliding-deadline branch of `handleAssignmentUpdate` on each cycle
      // boundary, so the reap cancels the run the host still owns.
      const reapAndReject = async (liveAgentRunId: string) => {
        const seconds = Math.round(timeoutMs / 1000);
        // Best-effort reap: cancel the child so it stops running (Phase A1's
        // cascade-cancel also tears down any grandchildren) and its quota
        // slot frees BEFORE the orchestrator can re-dispatch. Awaited so the
        // slot release lands; a cancel failure must NOT mask the timeout —
        // it is folded into the error text instead.
        let reapNote: string;
        try {
          const res = await cancelRunImpl(liveAgentRunId);
          reapNote = res.cancelled
            ? "the child run was cancelled"
            : `the child run could not be cancelled (${res.reason ?? "unknown"})`;
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          reapNote = `the child run could not be cancelled (${m})`;
        }
        reject(
          new Error(
            `Agent "${config.name}" timed out after ${seconds}s; ${reapNote}. ` +
              `Open sub-conversation ${handle.subConversationId} to inspect or ` +
              `resume the sub-agent.`,
          ),
        );
      };
      // `fireTimeout` is stored on the pending entry so the sliding-deadline
      // path can re-arm the exact same behavior on each activity update.
      // First-fire-wins: a terminal update that raced in already removed
      // the entry, making this a no-op. Read the live run id off the entry
      // before deleting it so the reap targets the current cycle's run.
      const fireTimeout = () => {
        const entry = pendingInvocations.get(handle.assignmentId);
        if (!entry) return;
        pendingInvocations.delete(handle.assignmentId);
        void reapAndReject(entry.agentRunId);
      };
      pendingInvocations.set(handle.assignmentId, {
        resolve,
        reject,
        timeoutHandle: setTimeout(fireTimeout, timeoutMs),
        timeoutMs,
        fireTimeout,
        agentName: config.name,
        agentConfigId,
        subConversationId: handle.subConversationId,
        agentRunId: handle.agentRunId,
        ...(typeof md.conversationId === "string"
          ? { ownerConversationId: md.conversationId }
          : {}),
      });
    },
  );

  try {
    const { result, success } = await completion;
    return toolResult(result, {
      ...(success ? {} : { isError: true }),
      details: {
        _agentMeta: {
          subConversationId: handle.subConversationId,
          agentName: config.name,
          agentConfigId,
        },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolResult(message, {
      isError: true,
      details: {
        _agentMeta: {
          subConversationId: handle.subConversationId,
          agentName: config.name,
          agentConfigId,
        },
      },
    });
  }
};

// ── task:assignment_update subscription (two-hop bridge) ───────────
//
// §4.2 of the plan: Phase 2c delivers `task:assignment_update` to every
// wired extension in the conversation, which means the orchestration
// extension will see assignment updates that belong to task-tracking
// (and vice versa). Guard: assignmentIds are globally unique UUIDs, so
// bailing out fast when the id isn't in our pending map keeps the
// handler a no-op for foreign updates.

interface IncomingAssignmentUpdate {
  conversationId: string;
  taskId: string;
  assignment: {
    id: string;
    status: string;
    resultPreview?: string;
    /** The run id of the assignment's CURRENTLY-live run. The host mutates
     *  this to a fresh id on every auto-continue / autonomous cycle
     *  transition and emits the update, so the reap can re-target the live
     *  cycle run instead of the stale cycle-1 id from the spawn handle. */
    agentRunId?: string;
  };
  /** Wave 1: the sub-agent's FULL final text (sentinel-stripped, capped
   *  host-side). Preferred over `resultPreview` for the orchestrator's
   *  tool result; falls back to the preview for older host builds. */
  resultFull?: string;
  /** Phase B1: the host-validated structured output (parsed value) when
   *  the invocation carried an `outputSchema` and the child satisfied it.
   *  Preferred over resultFull — returned to the orchestrator as
   *  pretty-printed JSON. */
  structuredResult?: unknown;
  /** Phase B1: set instead of `structuredResult` when the child completed
   *  but never produced schema-valid JSON within the re-prompt budget — a
   *  summary of the violations. Surfaced as an error carrying the raw
   *  output so the orchestrator can salvage. */
  structuredResultError?: string;
  /** Set alongside `structuredResultError` when the output DID validate
   *  but its compact form exceeded the host's 30KB structured cap — framed
   *  as an oversized SUCCESS (raw text result), not a schema violation. */
  structuredResultOverCap?: boolean;
}

/** Mirrors the host's `ASSIGNMENT_RESULT_FULL_CAP` (30KB). The host bounds
 *  the COMPACT structuredResult to this cap; we additionally avoid
 *  pretty-printing past it. Kept as a local literal — extension code must
 *  not value-import from src/**. */
const STRUCTURED_RESULT_PRETTY_CAP = 30_000;

/**
 * Shape a TERMINAL assignment update into the `{ result, success }` a tool
 * returns. Shared by the synchronous invoke_agent gate and the background
 * `collect_agent_result` path so both apply IDENTICAL resultFull /
 * structuredResult / structuredResultError precedence:
 *   - a host-validated `structuredResult` → pretty-printed JSON, success;
 *   - a `structuredResultError` (schema failure) → error carrying the
 *     violation summary AND the raw output so the orchestrator can salvage;
 *   - otherwise the full result (falling back to the panel preview, then a
 *     placeholder) with success keyed on the terminal status.
 */
function shapeTerminalResult(
  payload: IncomingAssignmentUpdate,
): { result: string; success: boolean } {
  const status = payload.assignment.status;
  const rawText =
    payload.resultFull ?? payload.assignment.resultPreview ?? "(no result)";
  if (payload.structuredResult !== undefined) {
    // The host already bounded the COMPACT structuredResult to 30KB
    // (over-cap validated output arrives as structuredResultError instead).
    // Pretty-print only when the pretty form is ALSO within the cap;
    // otherwise return compact so whitespace inflation can't push the
    // orchestrator's tool result past the cap.
    const compact = JSON.stringify(payload.structuredResult);
    const pretty = JSON.stringify(payload.structuredResult, null, 2);
    return {
      result: pretty.length <= STRUCTURED_RESULT_PRETTY_CAP ? pretty : compact,
      success: true,
    };
  }
  if (
    typeof payload.structuredResultError === "string" &&
    payload.structuredResultError
  ) {
    // Validated-but-oversized is NOT a schema violation: the child's JSON
    // satisfied the schema but its compact form blew the 30KB structured
    // cap, so the host shipped the (capped) raw text instead. Frame it as
    // an oversized success — the orchestrator can still consume the text.
    if (payload.structuredResultOverCap === true) {
      return {
        result:
          `Structured output validated against the schema but exceeded the 30KB structured cap — ` +
          `returning the (capped) raw output instead:\n${rawText}`,
        success: true,
      };
    }
    return {
      result:
        `Structured output did not satisfy the schema: ${payload.structuredResultError}\n\n` +
        `Raw output:\n${rawText}`,
      success: false,
    };
  }
  return { result: rawText, success: status === "completed" };
}

/** Dispatch a `task:assignment_update` to whichever map owns its assignment.
 *  An assignmentId lives in AT MOST one map (sync invocations vs. background
 *  spawns); a miss on both = a foreign update (another extension's — the maps
 *  are keyed on globally-unique assignmentIds) or a late update for an entry
 *  already resolved/evicted, both silent no-ops. */
async function handleAssignmentUpdate(
  payload: IncomingAssignmentUpdate,
): Promise<void> {
  const id = payload.assignment.id;
  const pending = pendingInvocations.get(id);
  if (pending) {
    handleSyncUpdate(pending, payload);
    return;
  }
  const bg = backgroundSpawns.get(id);
  if (bg) {
    handleBackgroundUpdate(bg, payload);
    return;
  }
  // Miss on both maps → foreign / already-resolved update. Dropping it is
  // correct, not a lost result (the sync reap cancels before deleting; a
  // terminal background entry keeps its result for later collect).
}

/** Synchronous invoke_agent gate (unchanged behavior). Non-terminal updates
 *  re-target the reap to the live cycle run and re-arm the sliding deadline;
 *  a terminal update resolves the promise with the shaped result. */
function handleSyncUpdate(
  pending: PendingInvocation,
  payload: IncomingAssignmentUpdate,
): void {
  const status = payload.assignment.status;
  if (status !== "completed" && status !== "failed") {
    // Re-target the reap to the LIVE cycle run. Auto-continue / autonomous
    // continuation mints a new run id per cycle (the spawn handle's
    // `agentRunId` is frozen at cycle 1), and the host stamps the current run
    // id onto every cycle-boundary update. Without this, a timeout would try
    // to cancel the stale cycle-1 run — which the host no longer owns, so the
    // cancel-run ownership gate would reject it and the live child would keep
    // running. Update before re-arming so a subsequent give-up reaps the
    // right run.
    if (
      typeof payload.assignment.agentRunId === "string" &&
      payload.assignment.agentRunId
    ) {
      pending.agentRunId = payload.assignment.agentRunId;
    }
    // Sliding (activity-aware) deadline: a non-terminal lifecycle update for
    // a tracked invocation proves the child is still alive. The host emits
    // one on every auto-continue / autonomous cycle transition, so reset the
    // give-up timer (same duration) instead of ignoring the update — this
    // keeps a long, legitimately-active multi-cycle child from being reaped
    // mid-run while still bounding a genuinely-stuck child to one idle window.
    clearTimeout(pending.timeoutHandle);
    pending.timeoutHandle = setTimeout(pending.fireTimeout, pending.timeoutMs);
    return;
  }

  clearTimeout(pending.timeoutHandle);
  pendingInvocations.delete(payload.assignment.id);
  // Both terminal statuses resolve (not reject) — timeout is the only reject
  // path. The success flag distinguishes for the tool-result builder.
  pending.resolve(shapeTerminalResult(payload));
}

/** Background-spawn tracker. Non-terminal updates track the live cycle run id
 *  and slide any waiting `collect_agent_result` deadlines; a terminal update
 *  stores the shaped result and resolves every collect gate awaiting it. */
function handleBackgroundUpdate(
  bg: BackgroundSpawn,
  payload: IncomingAssignmentUpdate,
): void {
  const status = payload.assignment.status;
  if (status !== "completed" && status !== "failed") {
    if (
      typeof payload.assignment.agentRunId === "string" &&
      payload.assignment.agentRunId
    ) {
      bg.agentRunId = payload.assignment.agentRunId;
    }
    // Activity → slide every waiting collect gate's deadline (same duration),
    // mirroring the sync path: an actively-cycling child keeps a bounded
    // `collect_agent_result(waitSeconds)` alive instead of expiring it.
    for (const w of bg.waiters) {
      clearTimeout(w.timeoutHandle);
      w.timeoutHandle = setTimeout(w.fireTimeout, w.timeoutMs);
    }
    return;
  }

  // Terminal: memoize the shaped result for later collects and resolve every
  // waiting gate. The entry is RETAINED (not deleted) so a `collect` issued
  // after the terminal still returns the result — it's evicted only by the
  // map's bounded-capacity policy.
  bg.terminal = true;
  bg.result = shapeTerminalResult(payload);
  for (const w of [...bg.waiters]) {
    clearTimeout(w.timeoutHandle);
    w.resolveTerminal(bg.result);
  }
  bg.waiters.clear();
}

// ── collect_agent_result tool handler (Phase B2) ───────────────────
//
// Fetch (or wait for) the result of a background `invoke_agent`. Terminal →
// return the shaped result immediately (resultFull / structuredResult-aware,
// identical to the sync path). Still running + `waitSeconds > 0` → register a
// gate resolved by the terminal `task:assignment_update` (with the same
// sliding-deadline reset on activity as the sync invoke). On wait expiry →
// return a NON-error "still running" status so the orchestrator can keep
// waiting or move on (a collect timeout NEVER reaps the child). Unknown
// assignmentId → a clear error.

/** Per-call `waitSeconds` bounds — mirror the manifest inputSchema. */
const MIN_COLLECT_WAIT_SECONDS = 0;
const MAX_COLLECT_WAIT_SECONDS = 600;

function clampWaitSeconds(waitSeconds: unknown): number {
  if (typeof waitSeconds !== "number" || !Number.isFinite(waitSeconds)) return 0;
  if (waitSeconds <= MIN_COLLECT_WAIT_SECONDS) return MIN_COLLECT_WAIT_SECONDS;
  if (waitSeconds >= MAX_COLLECT_WAIT_SECONDS) return MAX_COLLECT_WAIT_SECONDS;
  return Math.floor(waitSeconds);
}

interface CollectMeta {
  subConversationId: string;
  agentName: string;
  agentConfigId: string;
  assignmentId: string;
}

function terminalToolResult(
  result: { result: string; success: boolean },
  meta: CollectMeta,
) {
  return toolResult(result.result, {
    ...(result.success ? {} : { isError: true }),
    details: { _agentMeta: meta },
  });
}

function stillRunningToolResult(bg: BackgroundSpawn, meta: CollectMeta) {
  return toolResult(
    `Background agent "${bg.agentName}" is still running (assignmentId: ${meta.assignmentId}, ` +
      `subConversation: ${bg.subConversationId}). No terminal result yet — call ` +
      `collect_agent_result again (optionally with a larger waitSeconds) to keep waiting, ` +
      `or move on and check back later.`,
    { details: { _agentMeta: { ...meta, status: "running" } } },
  );
}

const collectAgentResult: ToolHandler = async (args, ctx?: ToolHandlerContext) => {
  const { assignmentId, waitSeconds } = args as {
    assignmentId: string;
    waitSeconds?: number;
  };

  if (typeof assignmentId !== "string" || !assignmentId.trim()) {
    return toolResult(
      `Error: collect_agent_result requires a non-empty 'assignmentId' (the id returned by a background invoke_agent call).`,
      { isError: true },
    );
  }

  // F3: caller authorization. The backgroundSpawns map is process-GLOBAL across
  // every conversation on the shared subprocess, so a collect is only honored
  // when the CALLING conversation (host-set `conversationId` in the _meta
  // side-channel — never LLM-visible/spoofable) owns the spawn. An unknown id,
  // a cross-conversation owner, OR a missing caller conversation id all return
  // the SAME not-found error — the handler never confirms another conversation's
  // assignment exists (fail closed against cross-tenant probing).
  const callerConversationId = (
    (ctx?.invocationMetadata ?? {}) as { conversationId?: unknown }
  ).conversationId;
  const bg = backgroundSpawns.get(assignmentId);
  if (
    !bg ||
    typeof callerConversationId !== "string" ||
    bg.ownerConversationId !== callerConversationId
  ) {
    return toolResult(
      `Error: no background agent is tracked for assignmentId "${assignmentId}" in this ` +
        `conversation. It may have been started synchronously (without background: true), never ` +
        `started, started in a different conversation, or evicted after many later background ` +
        `spawns. Re-dispatch it if you still need the work.`,
      { isError: true },
    );
  }

  const meta: CollectMeta = {
    subConversationId: bg.subConversationId,
    agentName: bg.agentName,
    agentConfigId: bg.agentConfigId,
    assignmentId,
  };

  // Already terminal → return the memoized shaped result.
  if (bg.terminal && bg.result) {
    bg.collected = true; // F5: this entry is now eviction-preferred.
    return terminalToolResult(bg.result, meta);
  }

  const wait = clampWaitSeconds(waitSeconds);
  if (wait <= 0) {
    return stillRunningToolResult(bg, meta);
  }

  // Register a gate resolved by the terminal update (below), by activity-
  // sliding, or by wait expiry. First-settle-wins. (Type kept as a named
  // alias on one line — bun's per-line coverage counts a wrapped generic
  // annotation as an executable line, which the patch gate can never hit.)
  type CollectOutcome = { done: true; result: { result: string; success: boolean } } | { done: false };
  const outcome = await new Promise<CollectOutcome>((resolve) => {
    const waitMs = wait * 1000;
    const fireTimeout = () => {
      bg.waiters.delete(waiter);
      resolve({ done: false });
    };
    const waiter: CollectWaiter = {
      resolveTerminal: (result) => {
        // The terminal handler already removed us from the set + cleared the
        // timer; just settle the gate.
        resolve({ done: true, result });
      },
      timeoutHandle: setTimeout(fireTimeout, waitMs),
      timeoutMs: waitMs,
      fireTimeout,
    };
    bg.waiters.add(waiter);
  });

  if (!outcome.done) {
    return stillRunningToolResult(bg, meta);
  }
  bg.collected = true; // F5: this entry is now eviction-preferred.
  return terminalToolResult(outcome.result, meta);
};

// ── send_to_agent tool handler (Phase B3) ──────────────────────────
//
// Claude-Code SendMessage parity. Targets a child THIS conversation already
// invoked (exactly one of assignmentId / agentConfigId), then:
//   • RUNNING child → enqueue the message onto its sub-conversation (steering);
//     the host's run:complete drain delivers it as the child's next turn.
//   • TERMINAL background child → start a NEW background run on the SAME
//     (reused) sub-conversation so it continues with full prior context; the
//     caller collects the new result later via collect_agent_result.
//   • Unknown / cross-conversation → fail-closed not-found (same owner check as
//     collect_agent_result — the tracking maps are process-global across every
//     conversation on the shared subprocess).

/** Char cap on a steered/continued message — mirrors the manifest
 *  `send_to_agent.message.maxLength` and the host handler's cap. */
const MAX_SEND_MESSAGE_CHARS = 8000;

interface SendTarget {
  subConversationId: string;
  agentName: string;
  agentConfigId: string;
  assignmentId: string;
  /** True once the child reached a terminal state (continue, not steer). */
  terminal: boolean;
}

/** Resolve a `send_to_agent` target from the tracking maps, OWNER-checked
 *  against the caller conversation. A caller with no conversation id (or a
 *  non-owned / unknown target) resolves to undefined → fail-closed not-found.
 *  For an agentConfigId target the LAST-registered owned entry wins (the reused
 *  sub-conversation is per agentConfigId, so every owned entry points at the
 *  same sub-conversation; most-recent is the intended thread). */
function resolveSendTarget(opts: {
  assignmentId?: string;
  agentConfigId?: string;
  callerConv?: string;
}): SendTarget | undefined {
  const { assignmentId, agentConfigId, callerConv } = opts;
  if (!callerConv) return undefined;
  if (assignmentId) {
    const pending = pendingInvocations.get(assignmentId);
    if (pending && pending.ownerConversationId === callerConv) {
      return {
        subConversationId: pending.subConversationId,
        agentName: pending.agentName,
        agentConfigId: pending.agentConfigId,
        assignmentId,
        terminal: false,
      };
    }
    const bg = backgroundSpawns.get(assignmentId);
    if (bg && bg.ownerConversationId === callerConv) {
      return {
        subConversationId: bg.subConversationId,
        agentName: bg.agentName,
        agentConfigId: bg.agentConfigId,
        assignmentId,
        terminal: bg.terminal,
      };
    }
    return undefined;
  }
  let match: SendTarget | undefined;
  for (const [id, bg] of backgroundSpawns) {
    if (bg.agentConfigId === agentConfigId && bg.ownerConversationId === callerConv) {
      match = {
        subConversationId: bg.subConversationId,
        agentName: bg.agentName,
        agentConfigId: bg.agentConfigId,
        assignmentId: id,
        terminal: bg.terminal,
      };
    }
  }
  if (match) return match;
  for (const [id, p] of pendingInvocations) {
    if (p.agentConfigId === agentConfigId && p.ownerConversationId === callerConv) {
      match = {
        subConversationId: p.subConversationId,
        agentName: p.agentName,
        agentConfigId: p.agentConfigId,
        assignmentId: id,
        terminal: false,
      };
    }
  }
  return match;
}

const sendToAgent: ToolHandler = async (args, ctx?: ToolHandlerContext) => {
  const { assignmentId, agentConfigId, message } = args as {
    assignmentId?: string;
    agentConfigId?: string;
    message: string;
  };

  if (typeof message !== "string" || !message.trim()) {
    return toolResult(`Error: send_to_agent requires a non-empty 'message'.`, {
      isError: true,
    });
  }
  if (message.length > MAX_SEND_MESSAGE_CHARS) {
    return toolResult(
      `Error: 'message' too long (${message.length} > ${MAX_SEND_MESSAGE_CHARS} chars).`,
      { isError: true },
    );
  }
  const hasAssignment = typeof assignmentId === "string" && assignmentId.trim() !== "";
  const hasAgentConfig = typeof agentConfigId === "string" && agentConfigId.trim() !== "";
  if (hasAssignment === hasAgentConfig) {
    return toolResult(
      `Error: send_to_agent requires EXACTLY ONE of 'assignmentId' or 'agentConfigId'.`,
      { isError: true },
    );
  }

  const callerConversationId = (
    (ctx?.invocationMetadata ?? {}) as { conversationId?: unknown }
  ).conversationId;
  const callerConv =
    typeof callerConversationId === "string" ? callerConversationId : undefined;
  const targetLabel = hasAssignment
    ? `assignmentId "${assignmentId}"`
    : `agentConfigId "${agentConfigId}"`;

  const target = resolveSendTarget({
    assignmentId: hasAssignment ? assignmentId : undefined,
    agentConfigId: hasAgentConfig ? agentConfigId : undefined,
    callerConv,
  });
  const notFound = () =>
    toolResult(
      `Error: no sub-agent is tracked for ${targetLabel} in this conversation. It may have never ` +
        `been invoked here, been started in a different conversation, or (for a background spawn) ` +
        `been evicted after many later spawns. Invoke it fresh with invoke_agent if you still need the work.`,
      { isError: true },
    );
  if (!target) return notFound();

  const meta = {
    subConversationId: target.subConversationId,
    agentName: target.agentName,
    agentConfigId: target.agentConfigId,
    assignmentId: target.assignmentId,
  };

  // ── RUNNING child → steer via enqueue ────────────────────────────
  if (!target.terminal) {
    let res: QueueAgentMessageResult;
    try {
      res = await queueAgentMessageImpl(target.subConversationId, message);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return toolResult(
        `Failed to queue message for "${target.agentName}": ${m}`,
        { isError: true, details: { _agentMeta: meta } },
      );
    }
    // Host fail-closed (sub-conversation not a child of the caller conv) →
    // surface the same not-found as an unknown target.
    if (!res.queued) return notFound();
    return toolResult(
      `Message queued for "${target.agentName}" — will be delivered when its current cycle completes.`,
      { details: { _agentMeta: { ...meta, status: "queued" } } },
    );
  }

  // ── TERMINAL child → continue on the reused sub-conversation ──────
  const config = await agentConfigs.resolve(target.agentConfigId);
  if (!config) {
    return toolResult(`Error: Unknown agent "${target.agentConfigId}".`, {
      isError: true,
    });
  }
  const md = ctx?.invocationMetadata ?? {};
  const spawnInput: SpawnAssignmentInput = {
    task: message,
    agentConfigId: target.agentConfigId,
    reuseSubConversationFor: target.agentConfigId,
    title: config.name,
    // Continuation runs background-style: no blocking wait here, the caller
    // collects later. Ask the host to notify the parent on terminal (same as
    // invoke_agent background).
    notifyParentOnTerminal: true,
    ...(typeof md.parentMessageId === "string"
      ? { parentMessageId: md.parentMessageId }
      : {}),
    ...(md.overrides && typeof md.overrides === "object"
      ? { overrides: md.overrides as Record<string, unknown> }
      : {}),
    ...(md.teamToolScope && typeof md.teamToolScope === "object"
      ? { teamToolScope: md.teamToolScope as { allowedTools?: string[]; deniedTools?: string[] } }
      : {}),
    ...(typeof md.orchestrationDepth === "number"
      ? { orchestrationDepth: md.orchestrationDepth }
      : {}),
    ...(typeof md.parentRunId === "string" ? { parentRunId: md.parentRunId } : {}),
  };
  let handle: SpawnAssignmentHandle;
  try {
    handle = await spawn(spawnInput);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return toolResult(`Agent "${config.name}" failed to continue: ${m}`, {
      isError: true,
    });
  }
  registerBackgroundSpawn(handle, config.name, target.agentConfigId, callerConv);
  return toolResult(
    `Agent "${config.name}" is continuing on its existing sub-conversation with full prior context ` +
      `(new assignmentId: ${handle.assignmentId}, subConversation: ${handle.subConversationId}). It runs ` +
      `in the background — get its result with collect_agent_result using the new assignmentId.`,
    {
      details: {
        _agentMeta: {
          subConversationId: handle.subConversationId,
          agentName: config.name,
          agentConfigId: target.agentConfigId,
          assignmentId: handle.assignmentId,
        },
      },
    },
  );
};

export const tools: Record<string, ToolHandler> = {
  invoke_agent: invokeAgent,
  collect_agent_result: collectAgentResult,
  send_to_agent: sendToAgent,
};

// Expose internals for tests that want to drive the subscription
// handler directly without routing through the real event dispatcher.
export const _internals = {
  pendingInvocations,
  backgroundSpawns,
  registerBackgroundSpawn,
  handleAssignmentUpdate,
  resolveSendTarget,
  clampWaitSeconds,
  DEFAULT_AGENT_TIMEOUT_MS,
  MAX_BACKGROUND_SPAWNS,
  MAX_COLLECT_WAIT_SECONDS,
  MAX_SEND_MESSAGE_CHARS,
};

// Production wiring — gated on `import.meta.main` so test imports don't
// open stdin. Same pattern as scratchpad / task-tracking.
if (import.meta.main) {
  const ch = getChannel();
  createToolDispatcher(tools);
  registerEventHandlerImpl("task:assignment_update", handleAssignmentUpdate);
  ch.start();
}
