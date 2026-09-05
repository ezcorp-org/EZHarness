import type { writeTaskSnapshotForConversation, writeTaskAssignmentForConversation } from "$server/runtime/task-tracking-host";

export async function taskSnapshotPort(...[conversationId, snapshot, options]: Parameters<typeof writeTaskSnapshotForConversation>): Promise<void> {
  options?.bus?.emit("task:snapshot", { ...snapshot, conversationId });
  for (const update of options?.assignments ?? []) options?.bus?.emit("task:assignment_update", { ...update, conversationId });
}

export async function taskAssignmentPort(...[conversationId, update, bus]: Parameters<typeof writeTaskAssignmentForConversation>): Promise<void> {
  bus?.emit("task:assignment_update", { ...update, conversationId });
}
