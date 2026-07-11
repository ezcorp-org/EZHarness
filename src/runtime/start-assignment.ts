/**
 * Extracted start-assignment logic — shared between the SvelteKit
 * manual-start route and the Phase 2d `ezcorp/spawn-assignment` reverse
 * RPC (which the bundled `task-tracking` extension drives from inside
 * the subprocess).
 *
 * Phase 3 commit-5 removed the dynamic imports of
 * `./tools/task-tracking`. After the cutover this file owns NONE of
 * the task-state bookkeeping — that moved inside the bundled extension
 * and is driven by its `task:assignment_update` subscription (see
 * docs/extensions/examples/task-tracking/index.ts). This file's only
 * remaining job around task state is emitting `task:snapshot` +
 * `task:assignment_update` bus events so the extension (and SSE) see
 * the lifecycle transitions.
 *
 * Responsibilities: create/reuse a sub-conversation, mutate the
 * assignment record the caller passed in to "running", emit lifecycle
 * events, fire streamChat non-blocking, and wire run:complete /
 * run:error listeners that handle pending-message auto-continue and
 * terminal-state emission.
 */
import type { AgentExecutor } from "./executor";
import type { EventBus } from "./events";
import type { AgentEvents, TeamMemberOverrides, TeamToolScope } from "../types";
import { CURRENT_MODEL_SENTINEL } from "../types";
import {
  createSubConversation,
  getSubConversations,
  resolveConversationOwnerUserId,
} from "../db/queries/conversations";
import { getSetting } from "../db/queries/settings";
import { dequeue } from "./pending-messages";
import {
  TASK_DONE_RE,
  TASK_BLOCKED_RE,
  TASK_DONE_RE_G,
  TASK_BLOCKED_RE_G,
} from "./sentinels";
import { logger } from "../logger";
import type {
  TaskAssignment,
  TaskSnapshot,
  TrackedTask,
} from "./task-tracking-host";

const log = logger.child("start-assignment");

// ── Autonomous self-continuation primitives ────────────────────────
//
// A sub-agent has no native "I'm done" signal (it's told NOT to call
// task_complete — see the taskDescription guardrail below). When
// autonomous continuation is opted in, the agent self-reports via an
// output sentinel; the cycle cap is the hard backstop if it never does.

const DEFAULT_MAX_AUTONOMOUS_CYCLES = 8;

/**
 * Cap for the FULL sub-agent result returned to the orchestrator LLM
 * (Wave 1 — replaces the 200-char preview as the orchestrator's input).
 * 30KB (~7-8k tokens) is generous for a worker's final message while
 * bounding the bus/SSE payload and the parent's context growth; longer
 * outputs are truncated with an explicit marker so the orchestrator
 * knows to fetch the sub-conversation for the remainder.
 */
export const ASSIGNMENT_RESULT_FULL_CAP = 30_000;

/** Cap a full result to {@link ASSIGNMENT_RESULT_FULL_CAP}, appending a
 *  visible truncation marker when clipped. Empty input → undefined so a
 *  no-output run omits the field entirely. */
export function capFullResult(text: string): string | undefined {
  if (!text) return undefined;
  if (text.length <= ASSIGNMENT_RESULT_FULL_CAP) return text;
  return (
    text.slice(0, ASSIGNMENT_RESULT_FULL_CAP) +
    `\n\n[... truncated ${text.length - ASSIGNMENT_RESULT_FULL_CAP} more characters — open the sub-conversation for the full output]`
  );
}

const CONTINUATION_PROMPT =
  "Continue working toward the Pinned Objective in your system prompt. " +
  "When the objective is fully met, output `<<TASK_DONE>>` on its own line. " +
  "If you are blocked and cannot proceed, output " +
  "`<<TASK_BLOCKED: reason>>` and stop.";

/** Normalize a run result's `output` (string | `{ fullText }` | other)
 *  into plain text. Mirrors the legacy resultPreview extraction. */
export function extractFullText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "fullText" in output) {
    const t = (output as { fullText: unknown }).fullText;
    return typeof t === "string" ? t : "";
  }
  return "";
}

/** Detect the sub-agent's self-reported terminal signal. `done` wins
 *  over `blocked` if both somehow appear. */
export function detectDoneSignal(
  text: string,
): { kind: "done" } | { kind: "blocked"; reason: string } | null {
  if (TASK_DONE_RE.test(text)) return { kind: "done" };
  const m = text.match(TASK_BLOCKED_RE);
  if (m) return { kind: "blocked", reason: (m[1] ?? "").trim() };
  return null;
}

/** Strip every sentinel occurrence so the user-facing preview is clean. */
export function stripSignals(text: string): string {
  return text.replace(TASK_DONE_RE_G, "").replace(TASK_BLOCKED_RE_G, "").trim();
}

export interface StartAssignmentAgentConfig {
  id: string;
  name: string;
  prompt: string;
  model?: string | null;
  provider?: string | null;
}

export interface StartAssignmentOpts {
  executor: AgentExecutor;
  bus: EventBus<AgentEvents>;
  conversationId: string;
  taskId: string;
  assignment: TaskAssignment; // mutated in place
  task: TrackedTask;
  snapshot: TaskSnapshot;
  projectId: string;
  agentConfig: StartAssignmentAgentConfig;
  /** Fallback model from the parent conversation (used for CURRENT_MODEL_SENTINEL). */
  parentModel?: string;
  /** Fallback provider from the parent conversation (used for CURRENT_MODEL_SENTINEL). */
  parentProvider?: string;
  /** When provided, skip the reuse-by-agentConfigId lookup and treat this
   *  id as the sub-conversation. Useful when the caller already resolved
   *  the target sub-conv (e.g. the spawn-assignment handler's
   *  `reuseSubConversationFor` branch). */
  reuseSubConversationId?: string;
  /** Parent message id to anchor a newly-created sub-conversation to. */
  parentMessageId?: string;
  /** Per-member override bundle forwarded to `streamChat`. */
  overrides?: TeamMemberOverrides;
  /** Team-level allow/deny list forwarded to `streamChat`. When active,
   *  wins over `overrides.toolRestriction` / `overrides.allowedTools` /
   *  `overrides.deniedTools`. */
  teamToolScope?: TeamToolScope;
  /** Orchestration depth forwarded to `streamChat.options.orchestrationDepth`. */
  orchestrationDepth?: number;
  /** Parent orchestrator run id. When set, EVERY run this assignment
   *  starts (the initial task run AND each auto-continue / autonomous
   *  cycle) is registered on the executor as a child of this run, so a
   *  cancel of the parent cascades down and stops the sub-agent. */
  parentRunId?: string;
  /** Opt-in autonomous self-continuation. When set, a finished run with
   *  no pending user message and no done/blocked sentinel re-prompts the
   *  sub-agent toward the pinned objective until it signals completion
   *  or `maxCycles` is reached. Default OFF; default `maxCycles` is
   *  {@link DEFAULT_MAX_AUTONOMOUS_CYCLES}. */
  autonomousContinuation?: { maxCycles?: number };
}

export interface StartAssignmentResult {
  subConversationId: string;
  agentRunId: string;
}

function emitTaskSnapshot(
  bus: EventBus<AgentEvents>,
  snapshot: TaskSnapshot,
): void {
  bus.emit("task:snapshot", {
    conversationId: snapshot.conversationId,
    tasks: snapshot.tasks,
    ...(snapshot.activeTaskId !== undefined ? { activeTaskId: snapshot.activeTaskId } : {}),
  });
}

function emitAssignmentUpdate(
  bus: EventBus<AgentEvents>,
  conversationId: string,
  taskId: string,
  assignment: TaskAssignment,
  resultFull?: string,
): void {
  bus.emit("task:assignment_update", {
    conversationId,
    taskId,
    assignment,
    ...(resultFull !== undefined ? { resultFull } : {}),
  });
}

/**
 * Start an assignment: create its sub-conversation (or reuse an existing
 * one for the same agent), mutate the assignment to "running", emit the
 * required bus events, and fire streamChat in the background with
 * lifecycle listeners that mark the assignment completed/failed when
 * the run ends.
 *
 * The caller owns the task-tracking storage row — this function only
 * mutates the passed-in assignment/task/snapshot objects and emits bus
 * events. The bundled task-tracking extension's
 * `task:assignment_update` subscription picks up those events and
 * persists the merged state back to its own storage row (two-hop
 * bridge, plan §4.2).
 */
export async function startAssignment(opts: StartAssignmentOpts): Promise<StartAssignmentResult> {
  const {
    executor, bus, conversationId, taskId, assignment, task, snapshot,
    projectId, agentConfig, parentModel, parentProvider,
    reuseSubConversationId, parentMessageId, overrides, teamToolScope,
    orchestrationDepth, autonomousContinuation, parentRunId,
  } = opts;

  // Master kill-switch (Advanced Settings → "Agent goal pinning &
  // autonomous continuation"). Default-true: absent / null / non-boolean
  // ⇒ enabled. When OFF, behavior reverts to pre-feature: no pinned
  // objective in the system prompt and no autonomous self-continuation,
  // regardless of any per-spawn opt-in. Gating here covers EVERY spawn
  // path (manual route, spawn-assignment reverse-RPC, future callers).
  const autonomyFeatureEnabled =
    (await getSetting("global:agentAutonomyEnabled")) !== false;

  const autonomousEnabled = autonomyFeatureEnabled && !!autonomousContinuation;
  const maxAutoCycles =
    autonomousContinuation?.maxCycles ?? DEFAULT_MAX_AUTONOMOUS_CYCLES;
  let autoCycle = 0;

  // Reuse an existing sub-conversation for this agent, or create one.
  // If the caller pre-resolved a reuse id, honor it verbatim and skip the
  // by-agentConfigId lookup. Otherwise preserve legacy reuse semantics.
  let subConversationId: string;
  if (reuseSubConversationId) {
    subConversationId = reuseSubConversationId;
  } else {
    const existingSubConvos = await getSubConversations(conversationId);
    const existingAgentConv = existingSubConvos.find(
      (sc) => sc.agentConfigId === assignment.agentConfigId,
    );
    if (existingAgentConv) {
      subConversationId = existingAgentConv.id;
    } else {
      // Wave 0: persist the owning user on the sub-conversation so
      // conversation-scoped authorization (SSE filter, /api/runs
      // ownership) works without walking the parent chain. Inherited
      // from the nearest ancestor with an owner; legacy null-owner
      // rows are covered by the filter's parent walk.
      const ownerUserId = await resolveConversationOwnerUserId(conversationId);
      const subConv = await createSubConversation(projectId, {
        parentConversationId: conversationId,
        agentConfigId: assignment.agentConfigId,
        systemPrompt: agentConfig.prompt,
        title: agentConfig.name,
        ...(ownerUserId ? { userId: ownerUserId } : {}),
        ...(parentMessageId ? { parentMessageId } : {}),
      });
      subConversationId = subConv.id;
    }
  }
  const teamScopeActive = !!(
    teamToolScope &&
    ((teamToolScope.allowedTools?.length ?? 0) > 0 ||
      (teamToolScope.deniedTools?.length ?? 0) > 0)
  );

  const agentRunId = crypto.randomUUID();
  const now = new Date().toISOString();

  assignment.status = "running";
  assignment.startedAt = now;
  assignment.subConversationId = subConversationId;
  assignment.agentRunId = agentRunId;

  emitTaskSnapshot(bus, snapshot);
  emitAssignmentUpdate(bus, conversationId, taskId, assignment);
  bus.emit("agent:spawn", {
    runId: agentRunId,
    agentRunId,
    subConversationId,
    agentName: agentConfig.name,
    agentConfigId: assignment.agentConfigId,
    task: task.title,
    parentConversationId: conversationId,
  });

  // Build the task prompt with full plan context so the sub-agent
  // understands the broader goal and what other agents are working on.
  const planContext = [...snapshot.tasks]
    .sort((a, b) => a.priority - b.priority)
    .map((t) => {
      const status = t.id === task.id ? ">> THIS TASK" : t.status.toUpperCase();
      const agents = t.assignments
        .map((a) => `@${a.agentName}${a.status === "running" ? " (running)" : a.status === "completed" ? " (done)" : ""}`)
        .join(", ");
      return `- [${status}] ${t.title}${agents ? ` — ${agents}` : ""}`;
    })
    .join("\n");

  const taskBody = task.description ? `${task.title}\n\n${task.description}` : task.title;
  // Goal pinning: the objective rides in the system prompt so it is
  // re-anchored on EVERY chat cycle (initial run, user-driven
  // auto-continue, and autonomous continuation) — not just the first
  // message, which otherwise drifts out of context on long runs.
  const objectiveBlock =
    `## Pinned Objective\n${taskBody}\n\n` +
    `Stay focused on this objective for the duration of this assignment.`;
  const taskDescription =
    `## Your Task\n${taskBody}\n\n## Full Plan Context\nThis task is part of a larger plan. Here are all tasks:\n${planContext}\n\nFocus on completing YOUR task. If you need information from other tasks, note it in your output.\n\nIMPORTANT: Do NOT call task_complete, task_fail, or task_plan in this run. Your parent conversation tracks your completion automatically when this run ends — calling those tools here only writes to your own (empty) sub-conversation storage and wastes turns. Just finish the work and stop.`;

  const resolveSentinel = (value: string | undefined | null, fallback: string | undefined): string | undefined =>
    value === CURRENT_MODEL_SENTINEL ? fallback : value ?? undefined;
  const resolveModel = () =>
    resolveSentinel(overrides?.model as string | undefined, parentModel)
    ?? resolveSentinel(agentConfig.model, parentModel)
    ?? parentModel;
  const resolveProvider = () =>
    resolveSentinel(overrides?.provider as string | undefined, parentProvider)
    ?? resolveSentinel(agentConfig.provider, parentProvider)
    ?? parentProvider;
  const resolveSystem = () => {
    const base = overrides?.systemPromptAppend
      ? `${agentConfig.prompt}\n\n${overrides.systemPromptAppend}`
      : agentConfig.prompt;
    return autonomyFeatureEnabled ? `${base}\n\n${objectiveBlock}` : base;
  };

  /**
   * Start a run and register lifecycle listeners. Called for the
   * initial task and recursively for auto-continue when the user
   * injects messages via the agent-chat endpoint while the agent is
   * running.
   */
  function startRun(runId: string, message: string, runParentMessageId?: string) {
    // Link this run to the parent orchestrator BEFORE it streams, so a
    // cancel racing the spawn still cascades. Done inside startRun (not
    // once outside) because auto-continue + autonomous cycles call startRun
    // again with a NEW run id — each cycle's run must be registered or a
    // mid-cycle cancel would orphan the live child.
    //
    // registerChildRun returns false when the parent is already terminal:
    // startAssignment awaits several DB reads before reaching here, so a
    // user's Stop can kill the orchestrator inside that window — its cancel
    // cascade snapshot saw no child, and starting one now would stream
    // ownerless with nobody to consume the result. Fail the assignment
    // instead of starting dead work; the terminal assignment_update also
    // releases the parent's (already-rejected) invoke_agent gate cleanly.
    if (parentRunId && !executor.registerChildRun(parentRunId, runId)) {
      assignment.status = "failed";
      assignment.failedAt = new Date().toISOString();
      assignment.resultPreview = "Parent run ended before this agent could start";
      emitTaskSnapshot(bus, snapshot);
      emitAssignmentUpdate(
        bus, conversationId, taskId, assignment,
        "Parent run ended before this agent could start — child was not started.",
      );
      log.info("Refused to start child of terminal parent run", {
        conversationId, taskId, parentRunId, runId,
      });
      return;
    }
    const streamPromise = executor.streamChat(subConversationId, message, {
      projectId,
      agentConfigId: assignment.agentConfigId,
      runId,
      model: resolveModel() ?? undefined,
      provider: resolveProvider() ?? undefined,
      system: resolveSystem(),
      ...(runParentMessageId ? { parentMessageId: runParentMessageId } : {}),
      ...(typeof orchestrationDepth === "number" ? { orchestrationDepth } : {}),
      ...(overrides?.permissionMode ? { permissionMode: overrides.permissionMode } : {}),
      ...(overrides?.modeId ? { modeId: overrides.modeId } : {}),
      ...(teamScopeActive
        ? {
            ...(teamToolScope!.allowedTools ? { allowedTools: teamToolScope!.allowedTools } : {}),
            ...(teamToolScope!.deniedTools ? { deniedTools: teamToolScope!.deniedTools } : {}),
          }
        : {
            ...(overrides?.toolRestriction ? { toolRestriction: overrides.toolRestriction } : {}),
            ...(overrides?.allowedTools ? { allowedTools: overrides.allowedTools as string[] } : {}),
            ...(overrides?.deniedTools ? { deniedTools: overrides.deniedTools as string[] } : {}),
          }),
    });

    let unsubComplete: () => void = () => {};
    let unsubError: () => void = () => {};
    let unsubCancel: () => void = () => {};
    const cleanup = () => { unsubComplete(); unsubError(); unsubCancel(); };

    unsubComplete = bus.on("run:complete", (data) => {
      if (data.run.id !== runId) return;
      cleanup();

      // (1) User steering always wins: a queued user message re-prompts
      // the sub-agent verbatim, regardless of autonomous mode.
      const pending = dequeue(subConversationId);
      if (pending) {
        const newRunId = crypto.randomUUID();
        assignment.agentRunId = newRunId;
        emitTaskSnapshot(bus, snapshot);
        emitAssignmentUpdate(bus, conversationId, taskId, assignment);

        bus.emit("agent:spawn", {
          runId: newRunId, agentRunId: newRunId, subConversationId,
          agentName: agentConfig.name, agentConfigId: assignment.agentConfigId,
          task: pending.content, parentConversationId: conversationId,
        });

        startRun(newRunId, pending.content, pending.messageId);
        log.info("Auto-continue with pending message", {
          conversationId, taskId, newRunId,
        });
        return;
      }

      // (2) Autonomous self-continuation (opt-in). The `status ===
      // "running"` guard makes this interruptible for free: the Stop
      // endpoint flips the assignment to "assigned" before cancelling,
      // and run:cancel/run:error already unsubscribed via cleanup(), so
      // a stopped/cancelled run never re-loops. The objective is
      // re-pinned each cycle via resolveSystem(), so CONTINUATION_PROMPT
      // stays terse.
      let autonomousNote: string | undefined;
      if (autonomousEnabled && assignment.status === "running") {
        const signal = detectDoneSignal(
          extractFullText(data.run.result?.output),
        );
        if (signal === null && autoCycle < maxAutoCycles) {
          autoCycle++;
          assignment.autonomousCycle = autoCycle;
          assignment.autonomousMaxCycles = maxAutoCycles;
          const newRunId = crypto.randomUUID();
          assignment.agentRunId = newRunId;
          emitTaskSnapshot(bus, snapshot);
          emitAssignmentUpdate(bus, conversationId, taskId, assignment);

          bus.emit("agent:spawn", {
            runId: newRunId, agentRunId: newRunId, subConversationId,
            agentName: agentConfig.name, agentConfigId: assignment.agentConfigId,
            task: CONTINUATION_PROMPT, parentConversationId: conversationId,
          });

          startRun(newRunId, CONTINUATION_PROMPT);
          log.info("Autonomous continuation", {
            conversationId, taskId, newRunId,
            cycle: autoCycle, maxCycles: maxAutoCycles,
          });
          return;
        }
        if (signal?.kind === "blocked") {
          autonomousNote = signal.reason
            ? `[blocked] ${signal.reason}`
            : "[blocked]";
        } else if (signal === null) {
          autonomousNote =
            `[stopped after ${autoCycle} autonomous cycle${autoCycle === 1 ? "" : "s"}]`;
        }
        // signal.kind === "done" → no note; normal completion below.
      }

      // (3) Terminal completion. stripSignals keeps the preview clean;
      // for non-autonomous runs the output never carries a sentinel so
      // this branch is byte-for-byte the legacy behavior.
      assignment.status = "completed";
      assignment.completedAt = new Date().toISOString();

      const rawOutput = data.run.result?.output;
      const previewable =
        typeof rawOutput === "string" ||
        (!!rawOutput && typeof rawOutput === "object" && "fullText" in rawOutput);
      // Full result carried to the orchestrator LLM (Wave 1). The panel
      // still shows the 200-char preview; `resultFull` rides the
      // assignment_update event only and feeds the invoke_agent return.
      let resultFull: string | undefined;
      if (previewable || autonomousNote) {
        const cleaned = stripSignals(extractFullText(rawOutput));
        let preview = cleaned.length > 200 ? cleaned.slice(0, 200) + "..." : cleaned;
        let full = cleaned;
        if (autonomousNote) {
          preview = preview ? `${autonomousNote} ${preview}` : autonomousNote;
          full = full ? `${autonomousNote} ${full}` : autonomousNote;
        }
        assignment.resultPreview = preview;
        resultFull = capFullResult(full);
      }

      emitTaskSnapshot(bus, snapshot);
      emitAssignmentUpdate(bus, conversationId, taskId, assignment, resultFull);
    });

    unsubError = bus.on("run:error", (data) => {
      if (data.run.id !== runId) return;
      cleanup();

      assignment.status = "failed";
      assignment.failedAt = new Date().toISOString();
      const errorMsg = typeof data.error === "string" ? data.error : String(data.error ?? "Unknown error");
      assignment.resultPreview = errorMsg.slice(0, 200);

      emitTaskSnapshot(bus, snapshot);
      // Return the full error to the orchestrator so it can diagnose and
      // retry/route, not just the truncated panel preview.
      emitAssignmentUpdate(bus, conversationId, taskId, assignment, capFullResult(errorMsg));
    });

    // Cancellation lifecycle. `executor.cancelRun` AND streamChat's own
    // AbortError branch both emit `run:cancel` (never `run:error`) — so
    // without this listener a cancelled sub-agent leaves the assignment
    // stuck in "running" forever. That's the "agent is stuck" bug in
    // the task panel: watchdog kills → run:error (handled); anything
    // else aborts → run:cancel (was unhandled).
    //
    // Idempotency: the task panel's Stop endpoint (/stop/+server.ts)
    // and task_stop tool both mutate the assignment DIRECTLY to
    // "assigned" before calling cancelRun. If the status is no longer
    // "running" by the time this listener fires, an earlier handler
    // already transitioned it — leave it alone to preserve the
    // resumable state.
    unsubCancel = bus.on("run:cancel", (data) => {
      if (data.run.id !== runId) return;
      cleanup();

      if (assignment.status !== "running") return;

      assignment.status = "failed";
      assignment.failedAt = new Date().toISOString();
      assignment.resultPreview = "Run was cancelled";

      emitTaskSnapshot(bus, snapshot);
      emitAssignmentUpdate(bus, conversationId, taskId, assignment, "Run was cancelled");
    });

    streamPromise.catch((err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("streamChat error", { error: errorMsg });
      assignment.status = "failed";
      assignment.failedAt = new Date().toISOString();
      assignment.resultPreview = errorMsg.slice(0, 200);
      emitTaskSnapshot(bus, snapshot);
      emitAssignmentUpdate(bus, conversationId, taskId, assignment, capFullResult(errorMsg));
    });
  }

  startRun(agentRunId, taskDescription);

  log.info("Started assignment", {
    conversationId,
    taskId,
    assignmentId: assignment.id,
    agentConfigId: assignment.agentConfigId,
    agentName: agentConfig.name,
    subConversationId,
    agentRunId,
  });

  return { subConversationId, agentRunId };
}
