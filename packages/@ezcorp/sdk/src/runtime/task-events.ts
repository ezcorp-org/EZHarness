// ── TaskEvents — typed client for ezcorp/emit-task-event reverse RPC ──
//
// Emits the two task-panel bus events (`task:snapshot`,
// `task:assignment_update`) from an extension subprocess. The host
// (`src/extensions/task-events-handler.ts`) FORCES the emitted event's
// `conversationId` to its own `currentConversationId` — anything the
// caller sets here is ignored, so there's no cross-conversation vector.
//
// Gated on `taskEvents: true` + conversation-wiring; over-rate returns
// -32029 (no client retry — the 50 ops/sec ceiling is a hard contract).

import { getChannel } from "./channel";

// Mirror the host's Type definitions from src/types.ts / task-tracking.ts.
// Kept narrow on purpose — SDK callers shouldn't need to import the
// entire runtime type graph just to emit a snapshot.

export type TaskStatus = "pending" | "active" | "completed" | "failed";
export type AssignmentStatus = "assigned" | "running" | "completed" | "failed";

export interface TaskAssignment {
  id: string;
  agentConfigId: string;
  agentName: string;
  isTeam: boolean;
  status: AssignmentStatus;
  assignedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  subConversationId?: string;
  agentRunId?: string;
  resultPreview?: string;
}

export interface TrackedSubtask {
  id: string;
  title: string;
  completed: boolean;
  position: number;
}

export interface TrackedTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  agentId?: string;
  agentName?: string;
  assignments: TaskAssignment[];
  subtasks: TrackedSubtask[];
  priority: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  failureReason?: string;
  completionSummary?: string;
}

export class TaskEvents {
  async emitSnapshot(tasks: TrackedTask[], activeTaskId?: string): Promise<void> {
    const payload: { tasks: TrackedTask[]; activeTaskId?: string } = { tasks };
    if (activeTaskId !== undefined) payload.activeTaskId = activeTaskId;
    await getChannel().request<{ ok: true }>("ezcorp/emit-task-event", {
      v: 1,
      type: "snapshot",
      payload,
    });
  }

  async emitAssignmentUpdate(taskId: string, assignment: TaskAssignment): Promise<void> {
    await getChannel().request<{ ok: true }>("ezcorp/emit-task-event", {
      v: 1,
      type: "assignment_update",
      payload: { taskId, assignment },
    });
  }
}
