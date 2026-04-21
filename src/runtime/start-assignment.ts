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
import type { AgentEvents } from "../types";
import { CURRENT_MODEL_SENTINEL } from "../types";
import { createSubConversation, getSubConversations } from "../db/queries/conversations";
import { dequeue } from "./pending-messages";
import { logger } from "../logger";
import type {
  TaskAssignment,
  TaskSnapshot,
  TrackedTask,
} from "./task-tracking-host";

const log = logger.child("start-assignment");

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
): void {
  bus.emit("task:assignment_update", { conversationId, taskId, assignment });
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
  } = opts;

  // Reuse an existing sub-conversation for this agent, or create one.
  const existingSubConvos = await getSubConversations(conversationId);
  const existingAgentConv = existingSubConvos.find(
    (sc) => sc.agentConfigId === assignment.agentConfigId,
  );

  let subConversationId: string;
  if (existingAgentConv) {
    subConversationId = existingAgentConv.id;
  } else {
    const subConv = await createSubConversation(projectId, {
      parentConversationId: conversationId,
      agentConfigId: assignment.agentConfigId,
      systemPrompt: agentConfig.prompt,
      title: agentConfig.name,
    });
    subConversationId = subConv.id;
  }

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
  const taskDescription =
    `## Your Task\n${taskBody}\n\n## Full Plan Context\nThis task is part of a larger plan. Here are all tasks:\n${planContext}\n\nFocus on completing YOUR task. If you need information from other tasks, note it in your output.`;

  const resolveModel = () =>
    agentConfig.model === CURRENT_MODEL_SENTINEL
      ? parentModel
      : (agentConfig.model ?? parentModel ?? undefined);
  const resolveProvider = () =>
    agentConfig.provider === CURRENT_MODEL_SENTINEL
      ? parentProvider
      : (agentConfig.provider ?? parentProvider ?? undefined);

  /**
   * Start a run and register lifecycle listeners. Called for the
   * initial task and recursively for auto-continue when the user
   * injects messages via the agent-chat endpoint while the agent is
   * running.
   */
  function startRun(runId: string, message: string, parentMessageId?: string) {
    const streamPromise = executor.streamChat(subConversationId, message, {
      projectId,
      agentConfigId: assignment.agentConfigId,
      runId,
      model: resolveModel() ?? undefined,
      provider: resolveProvider() ?? undefined,
      system: agentConfig.prompt,
      parentMessageId,
    });

    let unsubComplete: () => void = () => {};
    let unsubError: () => void = () => {};
    const cleanup = () => { unsubComplete(); unsubError(); };

    unsubComplete = bus.on("run:complete", (data) => {
      if (data.run.id !== runId) return;
      cleanup();

      // Check for a pending user message before marking completed.
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

      assignment.status = "completed";
      assignment.completedAt = new Date().toISOString();

      const resultOutput = data.run.result?.output;
      if (typeof resultOutput === "string") {
        assignment.resultPreview =
          resultOutput.length > 200 ? resultOutput.slice(0, 200) + "..." : resultOutput;
      } else if (resultOutput && typeof resultOutput === "object" && "fullText" in resultOutput) {
        const text = (resultOutput as { fullText: string }).fullText;
        assignment.resultPreview =
          text.length > 200 ? text.slice(0, 200) + "..." : text;
      }

      emitTaskSnapshot(bus, snapshot);
      emitAssignmentUpdate(bus, conversationId, taskId, assignment);
    });

    unsubError = bus.on("run:error", (data) => {
      if (data.run.id !== runId) return;
      cleanup();

      assignment.status = "failed";
      assignment.failedAt = new Date().toISOString();
      const errorMsg = typeof data.error === "string" ? data.error : String(data.error ?? "Unknown error");
      assignment.resultPreview = errorMsg.slice(0, 200);

      emitTaskSnapshot(bus, snapshot);
      emitAssignmentUpdate(bus, conversationId, taskId, assignment);
    });

    streamPromise.catch((err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error("streamChat error", { error: errorMsg });
      assignment.status = "failed";
      assignment.failedAt = new Date().toISOString();
      assignment.resultPreview = errorMsg.slice(0, 200);
      emitTaskSnapshot(bus, snapshot);
      emitAssignmentUpdate(bus, conversationId, taskId, assignment);
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
