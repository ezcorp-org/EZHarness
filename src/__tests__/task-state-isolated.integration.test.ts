import { afterAll, beforeAll, expect, test } from "bun:test";
import { buildFirstPartyRelease } from "./helpers/first-party-release";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import { handleEmitTaskEventRpc } from "../extensions/task-events-handler";
import { addConversationExtensions } from "../db/queries/conversation-extensions";
import { getTaskSnapshotForConversation, _resetTaskTrackingExtensionIdCache } from "../runtime/task-tracking-host";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { createPermissionEngine } from "../extensions/permission-engine";

mockDbConnection();
let release: Awaited<ReturnType<typeof buildFirstPartyRelease>>;
let session: Awaited<ReturnType<Awaited<ReturnType<typeof buildFirstPartyRelease>>["session"]>>;
const bus = new EventBus<AgentEvents>();
const revisions: string[] = [];

beforeAll(async () => {
  await setupTestDb();
  _resetTaskTrackingExtensionIdCache();
  release = await buildFirstPartyRelease("task-tracking");
  session = await release.session({ persistRelease: true, handler: async request => {
    if (request.method !== "ezcorp/emit-task-event") return undefined;
    const payload = request.params?.payload as { expectedRevision?: string };
    expect(payload.expectedRevision).toMatch(/^[a-f0-9]{64}$/);
    revisions.push(payload.expectedRevision!);
    const installed = await session.installed();
    return handleEmitTaskEventRpc(session.id, request, { conversationId: session.conversationId, userId: session.userId, bus, grantedPermissions: installed!.grantedPermissions, engine: createPermissionEngine({ registry: session.registry, bus, db: getTestDb() }) });
  } });
  await addConversationExtensions(session.conversationId, [{ extensionId: session.id }]);
}, 120_000);

afterAll(async () => { await session?.close(); await release?.close(); await closeTestDb(); });

test("fresh isolated task workers serialize host-locked snapshots without lost updates", async () => {
  const first = await session.tool("task_plan", { tasks: [{ title: "Initial task" }] });
  expect(first.isError, JSON.stringify({ first, failures: session.failures })).not.toBe(true);
  expect((await getTaskSnapshotForConversation(session.conversationId))?.tasks).toHaveLength(1);
  const results = await Promise.allSettled([session.tool("task_add", { title: "Choice A" }), session.tool("task_add", { title: "Choice B" })]);
  expect(revisions).toHaveLength(3);
  expect(revisions[1]).not.toBe(revisions[2]);
  expect(results.filter(result => result.status === "fulfilled" && result.value.isError !== true)).toHaveLength(2);
  const failures = results.filter(result => result.status === "rejected" || result.value.isError === true);
  expect(failures).toHaveLength(0);
  expect(session.failures).toEqual([]);
  const snapshot = await getTaskSnapshotForConversation(session.conversationId);
  expect(snapshot?.tasks).toHaveLength(3);
  expect(snapshot?.tasks.map(task => task.title)).toContain("Choice A");
  expect(snapshot?.tasks.map(task => task.title)).toContain("Choice B");
  expect(snapshot?.tasks[0]?.title).toBe("Initial task");
  expect(session.starts()).toBe(3);
}, 90_000);
