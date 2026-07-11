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
  /** Parent run id — the orchestrator run that is spawning this sub-agent.
   *  When set, the host registers the spawned run (and each of its
   *  auto-continue / autonomous cycles) as a child of this run, so
   *  cancelling the parent cascades the cancel down to this sub-agent
   *  instead of leaving it running. Supplied by the host at tool-invoke
   *  time (via `invocationMetadata`), not by extension authors directly. */
  parentRunId?: string;
  /** Opt-in autonomous self-continuation. When set, the spawned
   *  sub-agent re-prompts itself toward its pinned objective until it
   *  emits a `<<TASK_DONE>>` / `<<TASK_BLOCKED>>` sentinel or hits
   *  `maxCycles`. Default OFF. Callers that opt in should also widen
   *  their own completion-wait timeout — a looping sub-agent will not
   *  reach a terminal `task:assignment_update` for much longer than a
   *  single run. */
  autonomousContinuation?: { maxCycles?: number };
  /** Optional JSON Schema (object schemas only) the sub-agent's FINAL
   *  answer must satisfy. When set, the host appends an output-format
   *  instruction to the child's first message, validates the child's
   *  final output against the schema, and re-prompts it (bounded) on a
   *  validation failure; the terminal `task:assignment_update` then
   *  carries the validated `structuredResult` (or a `structuredResultError`
   *  summary if the re-prompt budget is exhausted). Supplied by the host
   *  at tool-invoke time from the `outputSchema` tool argument, not by
   *  extension authors directly. */
  outputSchema?: Record<string, unknown>;
  /** Background-spawn opt-in: when true, the host emits `agent:complete`
   *  AND enqueues a completion-notify pending message for the PARENT
   *  conversation when the spawned run reaches a terminal state, so an
   *  orchestrator that dispatched this child without blocking can react on
   *  its next turn. Set by the orchestration extension for `background: true`
   *  invocations; a blocking (synchronous) invoke never sets it because the
   *  caller is already awaiting the result inline. Default OFF. */
  notifyParentOnTerminal?: boolean;
  /** Detached (background) spawn: the child legitimately OUTLIVES the parent
   *  run. When set, a later cycle-boundary re-registration that finds the
   *  parent already terminal degrades gracefully — the child continues
   *  streaming UNPARENTED instead of being force-failed with a false
   *  "parent ended" terminal (it is still supervised by its own idle watchdog
   *  + the task-panel Stop). A synchronous (blocking) spawn never sets this:
   *  its result must be consumed by a live parent, so an ownerless cycle IS a
   *  failure. Orthogonal to `notifyParentOnTerminal` (the parent-nudge signal),
   *  though the orchestration extension currently sets both together for
   *  background invokes / continuations. Default OFF. */
  detached?: boolean;
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
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    ...(input.autonomousContinuation
      ? { autonomousContinuation: input.autonomousContinuation }
      : {}),
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    ...(input.notifyParentOnTerminal ? { notifyParentOnTerminal: true } : {}),
    ...(input.detached ? { detached: true } : {}),
  });
  return {
    subConversationId: result.subConversationId,
    agentRunId: result.agentRunId,
    taskId: result.taskId,
    assignmentId: result.assignmentId,
  };
}

// ── queueAgentMessage — steer a RUNNING sub-agent (Phase B3) ─────────
//
// Thin type-safe wrapper over the `ezcorp/queue-agent-message` reverse RPC.
// Enqueues a steering message onto a still-running child's sub-conversation
// queue (the host-internal `pending-messages` module). The child's
// `run:complete` drain (start-assignment.ts) delivers it as the next turn, so
// the orchestrator can course-correct an in-flight agent — the counterpart to
// Claude-Code's SendMessage for a live sub-agent.
//
// Permission: reuses `spawnAgents` (same trust envelope — steering a child you
// spawned is the same boundary as spawning/cancelling it). The host validates
// the sub-conversation is a child of the CALLER's conversation and fails closed
// (`{ queued: false, reason: "not-found" }`) otherwise, so one conversation
// cannot steer another's sub-agent.
//
// Error codes the host can raise (surfaced as `JsonRpcError`):
//   -32001  spawnAgents permission not granted / quota config invalid
//   -32602  Invalid params (empty subConversationId/message, or message too long)

export interface QueueAgentMessageResult {
  /** True iff the host accepted the message — either steered into the child's
   *  live run (`delivery: "steered"`) or enqueued onto its sub-conversation for
   *  next-turn delivery (`delivery` absent). */
  queued: boolean;
  /** Only present when `queued === true`. `"steered"` = the message was injected
   *  into the child's CURRENT run at its next turn boundary (best-effort — the
   *  host shadow-tracks it and falls back to next-run delivery if the run ends
   *  first). Absent = it was enqueued for delivery when the current run
   *  completes (the pre-steer path, still used when no live Agent is registered
   *  yet). Lets the caller word its result honestly. */
  delivery?: "steered";
  /** Only present when `queued === false`.
   *  `"not-found"` = the sub-conversation is not a child of the caller's
   *  conversation (or no longer exists) — the same fail-closed response used for
   *  a cross-conversation target so the caller can't probe another
   *  conversation's sub-agents.
   *  `"not-running"` = the child IS owned but has no LIVE run to drain the
   *  queue, so steering would sit forever; the caller should continue it on a
   *  fresh run instead. */
  reason?: "not-found" | "not-running";
}

/**
 * Enqueue a steering message onto a RUNNING sub-agent's sub-conversation. The
 * message is delivered as the child's next turn when its current run completes.
 * Resolves `{ queued: true }` on success, `{ queued: false, reason }` when the
 * sub-conversation isn't owned by the caller (`not-found`) or has no live run
 * (`not-running`). Protocol-level failures (permission, malformed input) throw
 * `JsonRpcError`.
 */
export async function queueAgentMessage(
  subConversationId: string,
  message: string,
): Promise<QueueAgentMessageResult> {
  if (typeof subConversationId !== "string" || !subConversationId.trim()) {
    throw new Error("queueAgentMessage: 'subConversationId' must be a non-empty string");
  }
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("queueAgentMessage: 'message' must be a non-empty string");
  }
  const result = await getChannel().request<{
    v: 1;
    queued: boolean;
    reason?: "not-found" | "not-running";
  }>("ezcorp/queue-agent-message", {
    v: 1,
    subConversationId,
    message,
  });
  return {
    queued: result.queued,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}
