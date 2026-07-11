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

import {
  createToolDispatcher,
  getChannel,
  AgentConfigs,
  registerEventHandler,
  spawnAssignment,
  cancelRun,
  toolResult,
  type SpawnAssignmentInput,
  type SpawnAssignmentHandle,
  type CancelRunResult,
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

let agentConfigs: AgentConfigsLike = new AgentConfigs();
let spawn: SpawnFn = spawnAssignment;
let registerEventHandlerImpl: RegisterEventHandlerFn = registerEventHandler;
let cancelRunImpl: CancelRunFn = cancelRun;

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
/** Test-only: restore real SDK bindings. */
export function _resetBindingsForTests(): void {
  agentConfigs = new AgentConfigs();
  spawn = spawnAssignment;
  registerEventHandlerImpl = registerEventHandler;
  cancelRunImpl = cancelRun;
}

// ── Timeouts (injectable for tests) ────────────────────────────────
//
// The base give-up timeout is resolved per call (see `invokeAgent`):
//   1. a valid per-call `timeoutSeconds` arg (30..3600s) wins, else
//   2. the host-threaded `invokeTimeoutMs` metadata (from the operator's
//      `orchestration:invokeTimeoutMs` setting; host default 300s), else
//   3. this module `defaultTimeoutMs` floor.
// The wait is ALSO activity-aware: every non-terminal
// `task:assignment_update` for a live invocation resets the timer (sliding
// deadline), so a long multi-cycle child survives as long as it shows
// lifecycle activity. `defaultTimeoutMs` was raised 60s→300s to align the
// floor with the host's own idle watchdog (90s / 300s / 900s), so the tool
// no longer gives up BEFORE the platform considers the child idle.
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

/** Test-only: shrink the default 60s timeout so the timeout branch can
 *  be exercised without waiting a real minute. */
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
}

const pendingInvocations = new Map<string, PendingInvocation>();

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
  const { agentConfigId, task, autonomous, maxCycles, timeoutSeconds } = args as {
    agentConfigId: string;
    task: string;
    autonomous?: boolean;
    maxCycles?: number;
    timeoutSeconds?: number;
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
      const reapAndReject = async () => {
        const seconds = Math.round(timeoutMs / 1000);
        // Best-effort reap: cancel the child so it stops running (Phase A1's
        // cascade-cancel also tears down any grandchildren) and its quota
        // slot frees BEFORE the orchestrator can re-dispatch. Awaited so the
        // slot release lands; a cancel failure must NOT mask the timeout —
        // it is folded into the error text instead.
        let reapNote: string;
        try {
          const res = await cancelRunImpl(handle.agentRunId);
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
      // the entry, making this a no-op.
      const fireTimeout = () => {
        if (!pendingInvocations.has(handle.assignmentId)) return;
        pendingInvocations.delete(handle.assignmentId);
        void reapAndReject();
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
  };
  /** Wave 1: the sub-agent's FULL final text (sentinel-stripped, capped
   *  host-side). Preferred over `resultPreview` for the orchestrator's
   *  tool result; falls back to the preview for older host builds. */
  resultFull?: string;
}

async function handleAssignmentUpdate(
  payload: IncomingAssignmentUpdate,
): Promise<void> {
  const pending = pendingInvocations.get(payload.assignment.id);
  // Miss = either a foreign assignment (another extension's update — the map
  // is keyed on globally-unique assignmentIds) OR a terminal update arriving
  // for an invocation we already gave up on and reaped. The latter is a
  // deliberate silent no-op: the timeout path cancels the child before
  // rejecting, so a late terminal update for a reaped invocation is
  // near-impossible, and if one still arrives there is no pending waiter to
  // resolve — dropping it is correct, not a lost result.
  if (!pending) return;

  const status = payload.assignment.status;
  if (status !== "completed" && status !== "failed") {
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

  // Prefer the full result; fall back to the panel preview, then a
  // placeholder. This is what the orchestrator LLM synthesizes from —
  // the 200-char clip was the biggest functional gap vs Claude Code.
  const result =
    payload.resultFull ?? payload.assignment.resultPreview ?? "(no result)";
  // Both terminal statuses resolve (not reject) — timeout is the only
  // reject path. Success flag distinguishes for the tool-result builder.
  pending.resolve({
    result,
    success: status === "completed",
  });
}

export const tools: Record<string, ToolHandler> = {
  invoke_agent: invokeAgent,
};

// Expose internals for tests that want to drive the subscription
// handler directly without routing through the real event dispatcher.
export const _internals = {
  pendingInvocations,
  handleAssignmentUpdate,
  DEFAULT_AGENT_TIMEOUT_MS,
};

// Production wiring — gated on `import.meta.main` so test imports don't
// open stdin. Same pattern as scratchpad / task-tracking.
if (import.meta.main) {
  const ch = getChannel();
  createToolDispatcher(tools);
  registerEventHandlerImpl("task:assignment_update", handleAssignmentUpdate);
  ch.start();
}
