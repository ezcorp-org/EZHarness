import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import { insertRun, updateRun } from "../db/queries/runs";
import { HostMaintenanceDaemon } from "../extensions/host-maintenance-daemon";
import { validateManifest } from "@ezcorp/extension-contract";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import { releaseRuntimeFixture } from "./helpers/release-runtime";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { createExtension } from "../db/queries/extensions";
import { users, projects, conversations, conversationExtensions } from "../db/schema";
import { buildFullGrantFromManifest } from "../extensions/install-grant";
import { ExtensionDeliveryQueue } from "../extensions/v4/deliveries";
import { isPersistedDomainEvent } from "../extensions/domain-event-outbox";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { _resetTaskTrackingExtensionIdCache, getTaskSnapshotForConversation, writeTaskAssignmentForConversation, writeTaskSnapshotForConversation, type TaskSnapshot } from "../runtime/task-tracking-host";

mockDbConnection();
beforeEach(async () => { await setupTestDb(); _resetTaskTrackingExtensionIdCache(); });
afterAll(closeTestDb);

async function fixture() {
  const database = getTestDb();
  const [owner] = await database.insert(users).values({ email: "task-state@test.local", passwordHash: "unused", name: "Owner", status: "active" }).returning();
  const [project] = await database.insert(projects).values({ name: "Tasks", path: `/tmp/${crypto.randomUUID()}` }).returning();
  const [conversation] = await database.insert(conversations).values({ userId: owner!.id, projectId: project!.id }).returning();
  const manifest = validateManifest({ schemaVersion: 4, name: "task-tracking", version: "1.0.0", description: "Task state", author: { name: "Test" }, permissions: { eventSubscriptions: ["task:snapshot", "task:assignment_update"] } });
  const runtime = releaseRuntimeFixture(crypto.randomUUID(), manifest, { ownerId: owner!.id });
  const id = runtime.snapshot.installation.id;
  await new DatabaseLifecycleRepository(database).create({ installation: runtime.snapshot.installation, releases: { [runtime.snapshot.release.id]: runtime.snapshot.release }, revisions: {}, workspaces: {}, operations: {}, approvals: {} });
  await createExtension({ id, name: manifest.name, version: manifest.version, manifest, grantedPermissions: buildFullGrantFromManifest(manifest), enabled: true, source: "release-v4", creatorUserId: owner!.id });
  await database.insert(conversationExtensions).values({ conversationId: conversation!.id, extensionId: id });
  const snapshot: TaskSnapshot = { conversationId: conversation!.id, tasks: [{ id: "task", title: "Task", description: "", status: "active", createdAt: "now", priority: 1, subtasks: [], assignments: [{ id: "assignment", agentConfigId: "agent", agentName: "Agent", isTeam: false, status: "assigned", assignedAt: "now" }] }] };
  const bus = new EventBus<AgentEvents>();
  const seen: unknown[] = [];
  for (const type of ["task:snapshot", "task:assignment_update"] as const) bus.on(type, payload => { expect(isPersistedDomainEvent(payload)).toBe(true); seen.push(payload); });
  await writeTaskSnapshotForConversation(snapshot.conversationId, snapshot);
  await database.execute(sql`DELETE FROM extension_release_deliveries`);
  return { database, snapshot, bus, seen, queue: new ExtensionDeliveryQueue(database) };
}

test("snapshot and assignment events roll back together on the second outbox write", async () => {
  const context = await fixture();
  const original = structuredClone(context.snapshot);
  context.snapshot.tasks[0]!.assignments[0]!.status = "running";
  const enqueue = ExtensionDeliveryQueue.enqueueInTransaction;
  let writes = 0;
  const failure = spyOn(ExtensionDeliveryQueue, "enqueueInTransaction").mockImplementation(async (transaction, input) => { if (++writes === 2) throw new Error("crash before state commit"); return enqueue(transaction, input); });
  try {
    await expect(writeTaskSnapshotForConversation(context.snapshot.conversationId, context.snapshot, { bus: context.bus, assignments: [{ taskId: "task", assignment: context.snapshot.tasks[0]!.assignments[0]! }] })).rejects.toThrow("before state commit");
  } finally { failure.mockRestore(); }
  expect(await getTaskSnapshotForConversation(context.snapshot.conversationId)).toEqual(original);
  expect(await context.queue.claim()).toBeNull();
  expect(context.seen).toEqual([]);
});

test("committed frozen snapshots survive restart and assignment updates preserve unrelated state", async () => {
  const context = await fixture();
  context.snapshot.tasks[0]!.title = "Frozen title";
  const writing = writeTaskSnapshotForConversation(context.snapshot.conversationId, context.snapshot, { bus: context.bus });
  context.snapshot.tasks[0]!.title = "Uncommitted mutation";
  await writing;
  expect((await getTaskSnapshotForConversation(context.snapshot.conversationId))?.tasks[0]?.title).toBe("Frozen title");
  const assignment = { ...context.snapshot.tasks[0]!.assignments[0]!, status: "completed" as const, completedAt: "done" };
  await writeTaskAssignmentForConversation(context.snapshot.conversationId, { taskId: "task", assignment, resultFull: "Full result" }, context.bus);
  const snapshot = await getTaskSnapshotForConversation(context.snapshot.conversationId);
  expect(snapshot?.tasks[0]?.title).toBe("Frozen title");
  expect(snapshot?.tasks[0]?.assignments[0]?.status).toBe("completed");
  const restarted = new ExtensionDeliveryQueue(context.database);
  const delivered: unknown[] = [];
  while (await restarted.dispatch(async delivery => { delivered.push(delivery.input); })) {}
  expect(delivered).toHaveLength(3);
  expect(context.seen).toHaveLength(3);
  expect(delivered).toContainEqual(expect.objectContaining({ params: expect.objectContaining({ resultFull: "Full result" }) }));
  await expect(writeTaskAssignmentForConversation(context.snapshot.conversationId, { taskId: "missing", assignment }, context.bus)).rejects.toHaveProperty("code", "task_not_found");
  await expect(writeTaskAssignmentForConversation(context.snapshot.conversationId, { taskId: "task", assignment: { ...assignment, id: "missing" } }, context.bus)).rejects.toHaveProperty("code", "assignment_not_found");
});

test("concurrent host readers cannot overwrite a newer committed task snapshot", async () => {
  const context = await fixture();
  const first = (await getTaskSnapshotForConversation(context.snapshot.conversationId))!;
  const second = (await getTaskSnapshotForConversation(context.snapshot.conversationId))!;
  first.tasks[0]!.title = "First change";
  second.tasks[0]!.title = "Second change";
  const outcomes = await Promise.allSettled([writeTaskSnapshotForConversation(first.conversationId, first), writeTaskSnapshotForConversation(second.conversationId, second)]);
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(result => result.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "task_conflict" }) })]);
  expect((await getTaskSnapshotForConversation(first.conversationId))?.tasks[0]?.title).toBe("First change");
  await expect(writeTaskSnapshotForConversation(first.conversationId, first, { principalId: "foreign" })).rejects.toHaveProperty("code", "event_not_found");
  await expect(writeTaskSnapshotForConversation(first.conversationId, first, { assignments: [{ taskId: "task", assignment: { ...first.tasks[0]!.assignments[0]!, status: "failed" } }] })).rejects.toHaveProperty("code", "invalid_task_update");
});

test("same-boot maintenance repairs a failed terminal assignment publication once", async () => {
  const context = await fixture();
  const assignment = context.snapshot.tasks[0]!.assignments[0]!;
  assignment.status = "running";
  assignment.agentRunId = "terminal-task-run";
  await writeTaskSnapshotForConversation(context.snapshot.conversationId, context.snapshot);
  await context.database.execute(sql`DELETE FROM extension_release_deliveries`);
  await insertRun({ id: assignment.agentRunId, agentName: "Agent", status: "running", startedAt: Date.now(), logs: [] }, undefined, undefined, context.snapshot.conversationId);
  await updateRun({ id: assignment.agentRunId, agentName: "Agent", status: "success", startedAt: Date.now(), finishedAt: Date.now(), logs: [], result: { success: true, output: "Recovered result" } });
  const failure = spyOn(ExtensionDeliveryQueue, "enqueueInTransaction").mockRejectedValueOnce(new Error("temporary queue failure"));
  try {
    await expect(writeTaskAssignmentForConversation(context.snapshot.conversationId, { taskId: "task", assignment: { ...assignment, status: "completed" }, resultFull: "Recovered result" }, context.bus)).rejects.toThrow("temporary queue failure");
  } finally { failure.mockRestore(); }
  expect((await getTaskSnapshotForConversation(context.snapshot.conversationId))?.tasks[0]?.assignments[0]?.status).toBe("running");
  const daemon = new HostMaintenanceDaemon({ skipLockfile: true, getBus: () => context.bus });
  await daemon.tickOnce();
  expect((await getTaskSnapshotForConversation(context.snapshot.conversationId))?.tasks[0]?.assignments[0]).toMatchObject({ status: "completed", resultPreview: "Recovered result" });
  expect(context.seen).toHaveLength(2);
  await daemon.tickOnce();
  expect(context.seen).toHaveLength(2);
});
