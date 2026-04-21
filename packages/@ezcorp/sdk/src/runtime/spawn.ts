// ── spawnAssignment — Phase 2d SDK wrapper ──────────────────────────
//
// Thin type-safe wrapper over the `ezcorp/spawn-assignment` reverse RPC.
// The host (src/extensions/spawn-assignment-handler.ts) starts a sub-
// agent run against a caller-chosen agent config with a caller-supplied
// task body and returns the `{ subConversationId, agentRunId, taskId,
// assignmentId }` handle **immediately** — the run executes in the
// background and the extension observes completion via a Phase 2c
// event subscription (e.g. `registerEventHandler("task:assignment_update", …)`).
//
// Surface is a SINGLE function, not a class, because spawn is
// structurally one operation — "dispatch a run and return its handle".
// A class would add ceremony (`new AgentSpawner().spawn(...)`) without
// grouping anything. If a future phase adds sibling ops
// (`cancelAssignment`, `listMyActiveSpawns`) we refactor to a class
// then — not before.
//
// The host ignores any `conversationId` override in params — the
// sub-conversation is always parented on the extension's currently
// wired conversation, mirroring Phase 2b `emit-task-event`.
//
// Error codes the host can raise. The SDK channel surfaces these as
// `JsonRpcError` (from `@ezcorp/sdk/runtime`) with `.code`, `.message`,
// and `.data` preserved end-to-end — callers can branch on structure
// without string-matching:
//   -32001  spawnAgents permission not granted / not wired to conv
//   -32029  Rate limited
//   -32000  Spawn quota exceeded — `data.reason` is
//           `"hourly-exceeded"` | `"concurrent-exceeded"` | `"depth-exceeded"`
//   -32602  Invalid params (missing task, unknown agent, etc.)
//   -32603  Spawn failed at the dispatch boundary

import { getChannel } from "./channel";

export interface SpawnAssignmentInput {
  /** User-facing assignment prompt — sent verbatim as the sub-run's
   *  initial message. Required; empty/whitespace-only rejected
   *  synchronously by this wrapper. */
  task: string;
  /** Exact agent-config id. Takes precedence over `agentName` if both
   *  are provided. One of `agentConfigId` / `agentName` is required. */
  agentConfigId?: string;
  /** Case-insensitive, whitespace-trimmed name match against the
   *  caller's visible agent configs. Use when the extension only
   *  knows the agent by name. */
  agentName?: string;
  /** Optional sub-conversation title. Defaults to the agent's name
   *  on the host. */
  title?: string;
  /** Optional caller-supplied task id. When provided, the host uses it
   *  verbatim in the returned handle and in the emitted
   *  `task:snapshot` / `task:assignment_update` payloads. When absent,
   *  the host generates a fresh UUID. Intended for extensions that
   *  maintain their own task state and need the handle to carry IDs
   *  they already own. */
  taskId?: string;
  /** Optional caller-supplied assignment id. Same semantics as
   *  `taskId` — threaded verbatim when provided, generated otherwise. */
  assignmentId?: string;
  /** If set, the host queries existing sub-conversations of the current
   *  conversation for one whose `agentConfigId` matches. If found, it's
   *  reused (persistent context across invocations); otherwise a fresh
   *  sub-conversation is created. Mirrors the legacy
   *  `invoke-agent.ts:100-117` reuse semantics. */
  reuseSubConversationFor?: string;
  /** Anchors the sub-conversation to a specific parent message for
   *  historical display after refresh. Mirrors `invoke-agent.ts:110`. */
  parentMessageId?: string;
  /** Per-member override bundle — `model`, `provider`, `systemPromptAppend`,
   *  `permissionMode`, `toolRestriction`, `allowedTools`, `deniedTools`,
   *  `modeId`. Shape mirrors `TeamMemberOverrides` in the host's `types.ts`.
   *  Handler forwards onto `startAssignment` → `streamChat`. */
  overrides?: Record<string, unknown>;
  /** Team-level allow/deny list that overrides per-member `overrides`.
   *  Shape mirrors `TeamToolScope`. */
  teamToolScope?: { allowedTools?: string[]; deniedTools?: string[] };
  /** Current orchestration depth. Defaults to 0. Handler forwards as
   *  `options.orchestrationDepth` to `startAssignment`, which becomes the
   *  starting depth for `streamChat`. */
  orchestrationDepth?: number;
}

export interface SpawnAssignmentHandle {
  /** Id of the newly created sub-conversation parented on the calling
   *  extension's current conversation. */
  subConversationId: string;
  /** Id of the agent run dispatched into the sub-conversation —
   *  matches the `run:complete` / `run:error` / `run:cancel` bus
   *  event's `run.id` for quota release and completion tracking. */
  agentRunId: string;
  /** Host-generated task id. Persistable; appears in
   *  `task:snapshot` / `task:assignment_update` payloads. */
  taskId: string;
  /** Host-generated assignment id inside the snapshot's first
   *  task. */
  assignmentId: string;
}

/**
 * Dispatch a sub-agent run and return its handle immediately.
 *
 * The returned promise resolves as soon as the host has enqueued the
 * run — it does NOT wait for the sub-agent to finish. To observe
 * completion, subscribe to `task:assignment_update` (or another
 * direct-carrier event allowed by the host's Phase 2c allowlist) via
 * `registerEventHandler`.
 */
export async function spawnAssignment(
  input: SpawnAssignmentInput,
): Promise<SpawnAssignmentHandle> {
  if (!input.agentConfigId && !input.agentName) {
    throw new Error(
      "spawnAssignment: one of 'agentConfigId' or 'agentName' is required",
    );
  }
  if (typeof input.task !== "string" || !input.task.trim()) {
    throw new Error(
      "spawnAssignment: 'task' must be a non-empty string",
    );
  }
  const result = await getChannel().request<{
    v: 1;
    subConversationId: string;
    agentRunId: string;
    taskId: string;
    assignmentId: string;
  }>("ezcorp/spawn-assignment", {
    v: 1,
    task: input.task,
    ...(input.agentConfigId ? { agentConfigId: input.agentConfigId } : {}),
    ...(input.agentName ? { agentName: input.agentName } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
    ...(input.reuseSubConversationFor
      ? { reuseSubConversationFor: input.reuseSubConversationFor }
      : {}),
    ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
    ...(input.overrides ? { overrides: input.overrides } : {}),
    ...(input.teamToolScope ? { teamToolScope: input.teamToolScope } : {}),
    ...(typeof input.orchestrationDepth === "number"
      ? { orchestrationDepth: input.orchestrationDepth }
      : {}),
  });
  return {
    subConversationId: result.subConversationId,
    agentRunId: result.agentRunId,
    taskId: result.taskId,
    assignmentId: result.assignmentId,
  };
}
