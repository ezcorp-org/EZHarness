import { expect } from "bun:test";
import { canonicalJson, sha256 } from "@ezcorp/extension-contract";
import type { PersistedSnapshot, TaskAssignment, TrackedTask } from "../../runtime/task-tracking-host";

export class TaskEventStorageFixture {
  snapshots: Array<{ tasks: TrackedTask[]; activeTaskId?: string }> = [];
  assignmentUpdates: Array<{ taskId: string; assignment: TaskAssignment }> = [];
  constructor(private readonly storage: { get<Value>(key: string): Promise<{ value: Value | null; exists: boolean }>; set<Value>(key: string, value: Value): Promise<unknown> }) {}
  async emitSnapshot(tasks: TrackedTask[], activeTaskId?: string, options?: { expectedRevision?: string; assignments?: { taskId: string; assignment: TaskAssignment }[] }): Promise<void> {
    const previous = await this.storage.get<PersistedSnapshot>("tasks");
    expect(options?.expectedRevision).toBe(await sha256(canonicalJson(previous.value ?? null)));
    const snapshot = { tasks: structuredClone(tasks), ...(activeTaskId !== undefined ? { activeTaskId } : {}) };
    await this.storage.set("tasks", { ...snapshot, schemaVersion: 1 });
    this.snapshots.push(snapshot);
    for (const update of options?.assignments ?? []) this.assignmentUpdates.push(structuredClone(update));
  }
  async emitAssignmentUpdate(taskId: string, assignment: TaskAssignment): Promise<void> {
    this.assignmentUpdates.push({ taskId, assignment: structuredClone(assignment) });
  }
}
