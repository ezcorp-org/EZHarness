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
  toolResult,
  type SpawnAssignmentInput,
  type SpawnAssignmentHandle,
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

let agentConfigs: AgentConfigsLike = new AgentConfigs();
let spawn: SpawnFn = spawnAssignment;
let registerEventHandlerImpl: RegisterEventHandlerFn = registerEventHandler;

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
/** Test-only: restore real SDK bindings. */
export function _resetBindingsForTests(): void {
  agentConfigs = new AgentConfigs();
  spawn = spawnAssignment;
  registerEventHandlerImpl = registerEventHandler;
}

// ── Timeouts (injectable for tests) ────────────────────────────────

const DEFAULT_AGENT_TIMEOUT_MS = 60_000;
let defaultTimeoutMs = DEFAULT_AGENT_TIMEOUT_MS;

// Autonomous-mode wait budget. A looping sub-agent does NOT reach a
// terminal `task:assignment_update` until it self-reports done/blocked
// or exhausts its cycle cap, so the synchronous `invoke_agent` wait
// must be widened from the bounded 60s default. Per-cycle budget is
// generous (each cycle is itself a full run guarded by the host's 90s
// idle watchdog); +1 covers the final terminal cycle.
const AUTONOMOUS_PER_CYCLE_MS = 120_000;
const ORCH_DEFAULT_MAX_CYCLES = 8;

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
  resolve: (result: { resultPreview: string; success: boolean }) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  agentName: string;
  agentConfigId: string;
  subConversationId: string;
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
  const { agentConfigId, task, autonomous, maxCycles } = args as {
    agentConfigId: string;
    task: string;
    autonomous?: boolean;
    maxCycles?: number;
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
  const timeoutMs = autonomousCfg
    ? AUTONOMOUS_PER_CYCLE_MS * (effectiveMaxCycles + 1)
    : defaultTimeoutMs;

  // Build spawn input from ctx.invocationMetadata (set by the host at
  // tool-invoke time in commit 4). Spread each field optionally — only
  // include when metadata has it.
  const md = ctx?.invocationMetadata ?? {};
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
  // resolves this with `{ resultPreview, success }` when it sees a
  // matching `task:assignment_update` with a terminal status. Timeout
  // is the only reject path — both `completed` and `failed` resolve,
  // differentiated by the `success` flag, so callers only have one
  // branch for "terminal" vs "timeout".
  const completion = new Promise<{ resultPreview: string; success: boolean }>(
    (resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        if (pendingInvocations.has(handle.assignmentId)) {
          pendingInvocations.delete(handle.assignmentId);
          reject(
            new Error(
              `Agent "${config.name}" timed out after ${Math.round(timeoutMs / 1000)}s`,
            ),
          );
        }
      }, timeoutMs);
      pendingInvocations.set(handle.assignmentId, {
        resolve,
        reject,
        timeoutHandle,
        agentName: config.name,
        agentConfigId,
        subConversationId: handle.subConversationId,
      });
    },
  );

  try {
    const { resultPreview, success } = await completion;
    return toolResult(resultPreview, {
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
}

async function handleAssignmentUpdate(
  payload: IncomingAssignmentUpdate,
): Promise<void> {
  const pending = pendingInvocations.get(payload.assignment.id);
  if (!pending) return;

  const status = payload.assignment.status;
  if (status !== "completed" && status !== "failed") return;

  clearTimeout(pending.timeoutHandle);
  pendingInvocations.delete(payload.assignment.id);

  const resultPreview = payload.assignment.resultPreview ?? "(no result)";
  // Both terminal statuses resolve (not reject) — timeout is the only
  // reject path. Success flag distinguishes for the tool-result builder.
  pending.resolve({
    resultPreview,
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
