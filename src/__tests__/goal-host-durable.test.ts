import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { validateManifest } from "@ezcorp/extension-contract";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import { releaseRuntimeFixture } from "./helpers/release-runtime";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { createExtension } from "../db/queries/extensions";
import { up } from "../db/migrations/add-extension-releases";
import { users, projects, conversations, conversationExtensions } from "../db/schema";
import { buildFullGrantFromManifest } from "../extensions/install-grant";
import { ExtensionDeliveryQueue } from "../extensions/v4/deliveries";
import { GoalHost, writePersistedGoal, deletePersistedGoal, readPersistedGoal, type GoalHostOptions } from "../runtime/goal-host";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";
import type { AgentExecutor } from "../runtime/executor";

mockDbConnection();
beforeEach(setupTestDb);
afterAll(closeTestDb);

async function fixture(options: Partial<GoalHostOptions> = {}) {
  const database = getTestDb();
  await up(database);
  const [owner] = await database.insert(users).values({ email: `${crypto.randomUUID()}@goal.test`, passwordHash: "unused", name: "Goal owner", role: "admin", status: "active" }).returning();
  const [project] = await database.insert(projects).values({ name: "Goal project", path: `/tmp/${crypto.randomUUID()}` }).returning();
  const [conversation] = await database.insert(conversations).values({ userId: owner!.id, projectId: project!.id, title: "Durable goal", metadata: { unrelated: "keep" } }).returning();
  const manifest = validateManifest({ schemaVersion: 4, name: "goal-observer", version: "1.0.0", description: "Goal events", author: { name: "Test" }, permissions: { eventSubscriptions: ["goal:update"] } });
  const { snapshot } = releaseRuntimeFixture(crypto.randomUUID(), manifest, { ownerId: owner!.id });
  await new DatabaseLifecycleRepository(database).create({ installation: snapshot.installation, releases: { [snapshot.release.id]: snapshot.release }, revisions: {}, workspaces: {}, approvals: {}, operations: {} });
  await createExtension({ id: snapshot.installation.id, name: manifest.name, version: manifest.version, manifest, grantedPermissions: buildFullGrantFromManifest(manifest), enabled: true, source: "release-v4", creatorUserId: owner!.id });
  await database.insert(conversationExtensions).values({ conversationId: conversation!.id, extensionId: snapshot.installation.id });
  const bus = new EventBus<AgentEvents>();
  const events: AgentEvents["goal:update"][] = [];
  bus.on("goal:update", payload => { events.push(payload); });
  const host = new GoalHost({ bus, executor: {} as AgentExecutor, createMessage: async () => ({ id: "goal-card", role: "assistant", content: "card" }) as never, ...options });
  const input = { conversationId: conversation!.id, userId: owner!.id, projectId: project!.id, userMessageId: "message" };
  return { database, conversation: conversation!, host, bus, events, input, queue: new ExtensionDeliveryQueue(database) };
}

test("goal set and clear persist recoverable events with the metadata state", async () => {
  const context = await fixture();
  await context.host.handleGoalCommand({ ...context.input, subcommand: "set", condition: "Finish the report" });
  const [armed] = await context.database.select().from(conversations).where(eq(conversations.id, context.conversation.id));
  expect(armed!.metadata).toMatchObject({ unrelated: "keep", goal: { condition: "Finish the report" } });
  const recovered = new ExtensionDeliveryQueue(context.database);
  expect((await recovered.claim())?.input).toMatchObject({ method: "ezcorp/event/goal:update", params: { state: "active", condition: "Finish the report" } });
  expect(context.events).toHaveLength(1);
  await context.host.handleGoalCommand({ ...context.input, subcommand: "clear" });
  expect((await recovered.claim())?.input).toMatchObject({ method: "ezcorp/event/goal:update", params: { state: "off" } });
  expect((await context.database.select().from(conversations))[0]!.metadata).toEqual({ unrelated: "keep" });
  expect(context.events).toHaveLength(2);
});

test("failed goal event admission rolls back metadata and does not emit success", async () => {
  const context = await fixture();
  await context.database.execute(sql`DROP TABLE extension_release_deliveries`);
  await expect(context.host.handleGoalCommand({ ...context.input, subcommand: "set", condition: "Must not commit" })).rejects.toThrow();
  expect((await context.database.select().from(conversations))[0]!.metadata).toEqual({ unrelated: "keep" });
  expect(context.events).toHaveLength(0);
  expect(context.host.getRecord(context.conversation.id)).toBeUndefined();
});

test("pause and resume persist their reason before UI and recoverable delivery", async () => {
  const context = await fixture();
  await context.host.start();
  try {
    await context.host.handleGoalCommand({ ...context.input, subcommand: "set", condition: "Keep working" });
    await context.queue.claim();
    const runId = crypto.randomUUID();
    context.bus.emit("run:error", { conversationId: context.conversation.id, runId, error: "Worker failed", run: { id: runId, conversationId: context.conversation.id, status: "error", agentName: "chat", startedAt: Date.now(), logs: [] } as AgentRun });
    const deadline = Date.now() + 5000;
    while (context.events.length < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(context.events[1]).toMatchObject({ state: "paused", lastReason: "Run failed: Worker failed" });
    expect(await readPersistedGoal(context.conversation.id)).toMatchObject({ lastReason: "Run failed: Worker failed" });
    expect((await context.queue.claim())?.input).toMatchObject({ params: { state: "paused" } });
    await context.host.ensureGoalRecordRehydrated(context.conversation.id, false);
    expect(context.host.getRecord(context.conversation.id)?.status).toBe("active");
    expect((await context.queue.claim())?.input).toMatchObject({ params: { state: "active" } });
  } finally { context.host.stop(); }
});

test("failed clear leaves the goal armed and emits no terminal notice", async () => {
  const context = await fixture();
  await context.host.handleGoalCommand({ ...context.input, subcommand: "set", condition: "Retain this goal" });
  await context.database.execute(sql`DROP TABLE extension_release_deliveries`);
  await expect(context.host.handleGoalCommand({ ...context.input, subcommand: "clear" })).rejects.toThrow();
  expect(await readPersistedGoal(context.conversation.id)).toMatchObject({ condition: "Retain this goal" });
  expect(context.host.getRecord(context.conversation.id)?.status).toBe("active");
  expect(context.events).toHaveLength(1);
});

test("goal persistence rejects foreign events, missing rows and superseded transitions", async () => {
  const context = await fixture();
  const goal = { condition: "Original", lastReason: null, createdAt: new Date().toISOString() };
  const event = { id: `goal:${crypto.randomUUID()}`, type: "goal:update" as const, conversationId: context.conversation.id, payload: { conversationId: context.conversation.id, state: "off" } };
  await expect(writePersistedGoal(context.conversation.id, goal, { ...event, conversationId: "foreign" })).rejects.toThrow("does not match");
  const missing = crypto.randomUUID();
  await expect(deletePersistedGoal(missing, { ...event, conversationId: missing })).rejects.toThrow("not found");
  await writePersistedGoal(context.conversation.id, { ...goal, condition: "Replacement" });
  await expect(deletePersistedGoal(context.conversation.id, event, goal)).rejects.toThrow("changed");
  expect(await readPersistedGoal(context.conversation.id)).toMatchObject({ condition: "Replacement" });
  expect(await context.queue.claim()).toBeNull();
});

test("failed continuation and pause admission leave the in-memory record unchanged", async () => {
  let starts = 0;
  const context = await fixture({
    executor: { streamChat: async () => { starts++; } } as unknown as AgentExecutor,
    getMessages: async () => [{ role: "assistant", content: "<<TASK_BLOCKED: keep working>>" }] as never,
  });
  await context.host.handleGoalCommand({ ...context.input, subcommand: "set", condition: "Do not lose the current run" });
  const record = context.host.getRecord(context.conversation.id)!;
  record.inFlightRunId = crypto.randomUUID();
  const before = structuredClone(record);
  await context.database.execute(sql`DROP TABLE extension_release_deliveries`);
  const run = { id: record.inFlightRunId, conversationId: context.conversation.id, agentName: "chat", status: "success", startedAt: Date.now(), logs: [] } as AgentRun;
  const handlers = context.host as unknown as {
    onRunComplete(data: AgentEvents["run:complete"]): Promise<void>;
    onRunTerminal(run: AgentRun, conversationId: string, kind: "error", error: string): Promise<void>;
  };
  await expect(handlers.onRunComplete({ run, conversationId: context.conversation.id, runId: run.id })).rejects.toThrow();
  expect(context.host.getRecord(context.conversation.id)).toEqual(before);
  expect(starts).toBe(0);
  expect(context.events).toHaveLength(1);
  await expect(handlers.onRunTerminal(run, context.conversation.id, "error", "No queue")).rejects.toThrow();
  expect(context.host.getRecord(context.conversation.id)).toEqual(before);
  expect(await readPersistedGoal(context.conversation.id)).toMatchObject({ lastReason: null });
});
