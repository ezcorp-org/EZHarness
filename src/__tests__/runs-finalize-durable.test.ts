import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { validateManifest } from "@ezcorp/extension-contract";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import { releaseRuntimeFixture } from "./helpers/release-runtime";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { createExtension } from "../db/queries/extensions";
import { finalizeRunRow, terminalizeOrphanedRuns, updateRun } from "../db/queries/runs";
import { emitTerminalRun } from "../runtime/domain-events";
import { EventBus } from "../runtime/events";
import { registerBriefingCompletionIntent } from "../runtime/briefing/completion-intents";
import type { AgentEvents, AgentRun } from "../types";
import { up } from "../db/migrations/add-extension-releases";
import { users, projects, conversations, conversationExtensions, runs, activeRuns, messages, runDomainEventIntents } from "../db/schema";
import { buildFullGrantFromManifest } from "../extensions/install-grant";
import { ExtensionDeliveryQueue } from "../extensions/v4/deliveries";

mockDbConnection();
beforeEach(setupTestDb);
afterAll(closeTestDb);

async function fixture() {
  const database = getTestDb();
  await up(database);
  const [owner] = await database.insert(users).values({ email: `${crypto.randomUUID()}@test.local`, passwordHash: "unused", name: "Owner", role: "admin" }).returning();
  const [project] = await database.insert(projects).values({ name: "Terminal fixture", path: `/tmp/${crypto.randomUUID()}` }).returning();
  const [conversation] = await database.insert(conversations).values({ userId: owner!.id, projectId: project!.id, title: "Terminal recovery" }).returning();
  const manifest = validateManifest({ schemaVersion: 4, name: "terminal-observer", version: "1.0.0", description: "Terminal events", author: { name: "Test" }, permissions: { eventSubscriptions: ["run:cancel", "run:error", "conversation:created", "briefing:delivered"] } });
  const { snapshot } = releaseRuntimeFixture(crypto.randomUUID(), manifest, { ownerId: owner!.id });
  await new DatabaseLifecycleRepository(database).create({ installation: snapshot.installation, releases: { [snapshot.release.id]: snapshot.release }, revisions: {}, workspaces: {}, approvals: {}, operations: {} });
  await createExtension({ id: snapshot.installation.id, name: manifest.name, version: manifest.version, manifest, grantedPermissions: buildFullGrantFromManifest(manifest), enabled: true, source: "release-v4", creatorUserId: owner!.id });
  await database.insert(conversationExtensions).values({ conversationId: conversation!.id, extensionId: snapshot.installation.id });
  const runId = crypto.randomUUID();
  await database.insert(runs).values({ id: runId, agentName: "chat", userId: owner!.id, conversationId: conversation!.id, status: "running", startedAt: new Date() });
  await database.insert(activeRuns).values({ id: runId, conversationId: conversation!.id });
  return { database, runId, conversation: conversation!, queue: new ExtensionDeliveryQueue(database) };
}

for (const status of ["cancelled", "error"] as const) test(`${status} commits its event and both run representations before recovery`, async () => {
  const context = await fixture();
  expect(await finalizeRunRow(context.runId, status, "Stopped by host")).toBe(1);
  const [stored] = await context.database.select().from(runs).where(eq(runs.id, context.runId));
  expect(stored).toMatchObject({ status, result: { success: false, output: null, error: "Stopped by host" } });
  expect(stored!.finishedAt).toBeInstanceOf(Date);
  expect((await context.database.select().from(activeRuns))[0]?.status).toBe("interrupted");
  const recovered = new ExtensionDeliveryQueue(context.database);
  const delivery = await recovered.claim();
  expect(delivery?.input).toMatchObject({ method: `ezcorp/event/${status === "cancelled" ? "run:cancel" : "run:error"}`, params: { conversationId: context.conversation.id, run: { id: context.runId, status } } });
  expect(await finalizeRunRow(context.runId, "error", "late competing error")).toBe(0);
  expect(await recovered.claim()).toBeNull();
});

test("queue failure rolls back terminal state and active-run status", async () => {
  const context = await fixture();
  await context.database.execute(sql`DROP TABLE extension_release_deliveries`);
  await expect(finalizeRunRow(context.runId, "error", "must roll back")).rejects.toThrow();
  expect((await context.database.select().from(runs))[0]).toMatchObject({ status: "running", finishedAt: null });
  expect((await context.database.select().from(activeRuns))[0]?.status).toBe("running");
});

test("restart repair queues each terminal event once and preserves completed runs", async () => {
  const context = await fixture();
  const successId = crypto.randomUUID();
  await context.database.insert(runs).values({ id: successId, agentName: "chat", conversationId: context.conversation.id, status: "success", startedAt: new Date(), finishedAt: new Date(), result: { success: true, output: "keep" } });
  expect(await terminalizeOrphanedRuns()).toBe(1);
  const delivery = await context.queue.claim();
  expect(delivery?.input).toMatchObject({ method: "ezcorp/event/run:error", params: { run: { id: context.runId, status: "error" } } });
  expect(await terminalizeOrphanedRuns()).toBe(0);
  expect(await context.queue.claim()).toBeNull();
  expect((await context.database.select().from(runs).where(eq(runs.id, successId)))[0]?.result).toEqual({ success: true, output: "keep" });
});

test("concurrent cancellation and watchdog finalization have one terminal winner", async () => {
  const context = await fixture();
  const counts = await Promise.all([finalizeRunRow(context.runId, "cancelled"), finalizeRunRow(context.runId, "error", "watchdog")]);
  expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
  expect(await context.queue.claim()).not.toBeNull();
  expect(await context.queue.claim()).toBeNull();
});

function terminalEvent(context: Awaited<ReturnType<typeof fixture>>) {
  const run: AgentRun = { id: context.runId, agentName: "chat", status: "error", startedAt: Date.now(), finishedAt: Date.now(), logs: [], result: { success: false, output: "partial", error: "stopped" } };
  return { id: `run:${run.id}:error`, type: "run:error" as const, conversationId: context.conversation.id, payload: { run, runId: run.id, conversationId: context.conversation.id, error: "stopped" } };
}

async function registerCompletion(context: Awaited<ReturnType<typeof fixture>>) {
  await registerBriefingCompletionIntent({ runId: context.runId, conversationId: context.conversation.id, userId: context.conversation.userId!, projectId: context.conversation.projectId });
  await context.database.insert(messages).values({ conversationId: context.conversation.id, role: "assistant", content: "Your daily briefing." });
}

for (const withRunEvent of [true, false]) test(`successful terminal transaction consumes briefing intent with run event=${withRunEvent}`, async () => {
  const context = await fixture();
  await registerCompletion(context);
  const run: AgentRun = { ...terminalEvent(context).payload.run, status: "success", result: { success: true, output: "delivered" } };
  const event = { id: `run:${run.id}:success`, type: "run:complete" as const, conversationId: context.conversation.id, payload: { run, conversationId: context.conversation.id } };
  await updateRun(run, withRunEvent ? event : undefined);
  expect(await context.database.select().from(runDomainEventIntents)).toHaveLength(0);
  expect(await context.database.select().from(activeRuns)).toHaveLength(0);
  const delivered = [await context.queue.claim(), await context.queue.claim()].map(item => item?.input);
  expect(delivered).toEqual(expect.arrayContaining([expect.objectContaining({ method: "ezcorp/event/briefing:delivered" }), expect.objectContaining({ method: "ezcorp/event/conversation:created" })]));
  await updateRun(run, withRunEvent ? event : undefined);
  expect(await context.queue.claim()).toBeNull();
});

for (const status of ["error", "cancelled"] as const) test(`${status} consumes briefing intent without publishing delivery`, async () => {
  const context = await fixture();
  await registerCompletion(context);
  expect(await finalizeRunRow(context.runId, status)).toBe(1);
  expect(await context.database.select().from(runDomainEventIntents)).toHaveLength(0);
  expect((await context.queue.claim())?.input).toMatchObject({ method: `ezcorp/event/run:${status === "error" ? "error" : "cancel"}` });
  expect(await context.queue.claim()).toBeNull();
});

test("failed briefing admission rolls back terminal state, active row and consumed intent", async () => {
  const context = await fixture();
  await registerCompletion(context);
  await context.database.execute(sql`DROP TABLE extension_release_deliveries`);
  const run: AgentRun = { ...terminalEvent(context).payload.run, status: "success", result: { success: true, output: "delivered" } };
  await expect(updateRun(run)).rejects.toThrow();
  expect((await context.database.select().from(runs))[0]?.status).toBe("running");
  expect((await context.database.select().from(activeRuns))[0]?.status).toBe("running");
  expect(await context.database.select().from(runDomainEventIntents)).toHaveLength(1);
});

test("nonterminal updates retain pending intent and active row", async () => {
  const context = await fixture();
  await registerCompletion(context);
  await updateRun({ ...terminalEvent(context).payload.run, status: "running" });
  expect(await context.database.select().from(runDomainEventIntents)).toHaveLength(1);
  expect((await context.database.select().from(activeRuns))[0]?.status).toBe("running");
  expect(await context.queue.claim()).toBeNull();
});

test("normal completion removes its active row in the terminal transaction", async () => {
  const context = await fixture();
  const event = terminalEvent(context);
  await updateRun(event.payload.run, event);
  expect(await context.database.select().from(activeRuns)).toHaveLength(0);
  expect((await context.database.select().from(runs))[0]?.status).toBe("error");
  expect(await context.queue.claim()).not.toBeNull();
});

test("normal completion refuses a cross-conversation active row atomically", async () => {
  const context = await fixture();
  const [other] = await context.database.insert(conversations).values({ userId: context.conversation.userId, projectId: context.conversation.projectId, title: "Other" }).returning();
  await context.database.update(activeRuns).set({ conversationId: other!.id });
  const event = terminalEvent(context);
  await expect(updateRun(event.payload.run, event)).rejects.toThrow("another conversation");
  expect((await context.database.select().from(runs))[0]?.status).toBe("running");
  expect(await context.queue.claim()).toBeNull();
});

test("unscoped abnormal runs commit before local emission and reject nonterminal status", async () => {
  const context = await fixture();
  await context.database.delete(activeRuns);
  await context.database.update(runs).set({ conversationId: null });
  const event = terminalEvent(context);
  const bus = new EventBus<AgentEvents>();
  let calls = 0;
  bus.on("run:error", () => calls++);
  expect(await emitTerminalRun({ persist: true, bus }, event.payload.run, "run:error", { run: event.payload.run }, "abnormal")).toBe(true);
  expect(calls).toBe(1);
  await expect(emitTerminalRun({ persist: true, bus }, { ...event.payload.run, status: "running" }, "run:error", {}, "abnormal")).rejects.toThrow("requires an error or cancellation");
  expect(calls).toBe(1);
});

test("active-only recovery creates its mirror and commits one durable terminal event", async () => {
  const context = await fixture();
  await context.database.delete(runs).where(eq(runs.id, context.runId));
  const event = terminalEvent(context);
  expect(await finalizeRunRow(context.runId, "error", "stopped", event, true)).toBe(1);
  expect((await context.database.select().from(runs))[0]).toMatchObject({ id: context.runId, conversationId: context.conversation.id, status: "error", result: event.payload.run.result });
  expect(await finalizeRunRow(context.runId, "error", "stopped", event, true)).toBe(0);
  expect(await context.queue.claim()).not.toBeNull();
  expect(await context.queue.claim()).toBeNull();
});

test("active-only recovery rejects missing identity and does not revive interrupted rows", async () => {
  const context = await fixture();
  await expect(finalizeRunRow(context.runId, "error", undefined, undefined, true)).rejects.toThrow("exact terminal event");
  await context.database.delete(runs).where(eq(runs.id, context.runId));
  await context.database.update(activeRuns).set({ status: "interrupted" });
  expect(await finalizeRunRow(context.runId, "error", undefined, terminalEvent(context), true)).toBe(0);
  expect(await context.database.select().from(runs)).toHaveLength(0);
  await context.database.delete(activeRuns);
  expect(await finalizeRunRow(context.runId, "error", undefined, terminalEvent(context), true)).toBe(0);
});

test("mismatched event identity rolls back both rows", async () => {
  const context = await fixture();
  const event = terminalEvent(context);
  for (const changed of [{ ...event, id: "wrong" }, { ...event, payload: { ...event.payload, runId: "wrong" } }, { ...event, conversationId: crypto.randomUUID() }]) {
    await expect(finalizeRunRow(context.runId, "error", undefined, changed)).rejects.toThrow("does not match");
    expect((await context.database.select().from(runs))[0]?.status).toBe("running");
    expect((await context.database.select().from(activeRuns))[0]?.status).toBe("running");
  }
  expect(await context.queue.claim()).toBeNull();
});

test("active run from another conversation cannot be overwritten or recovered", async () => {
  const context = await fixture();
  const [other] = await context.database.insert(conversations).values({ userId: context.conversation.userId, projectId: context.conversation.projectId, title: "Other" }).returning();
  await context.database.update(activeRuns).set({ conversationId: other!.id });
  await expect(finalizeRunRow(context.runId, "error")).rejects.toThrow("another conversation");
  expect((await context.database.select().from(runs))[0]?.status).toBe("running");
  await context.database.delete(runs);
  await expect(finalizeRunRow(context.runId, "error", undefined, terminalEvent(context), true)).rejects.toThrow("another conversation");
  expect(await context.database.select().from(runs)).toHaveLength(0);
});

test("terminal bus follows commit, stays silent on failure, and late cleanup preserves the winner", async () => {
  const context = await fixture();
  const event = terminalEvent(context);
  const bus = new EventBus<AgentEvents>();
  const seen: string[] = [];
  bus.on("run:error", () => seen.push("committed"));
  const pending = emitTerminalRun({ persist: true, bus }, event.payload.run, event.type, event.payload, "abnormal");
  expect(seen).toEqual([]);
  expect(await pending).toBe(true);
  expect(seen).toEqual(["committed"]);
  await updateRun({ ...event.payload.run, status: "success", result: { success: true, output: "late" } });
  expect((await context.database.select().from(runs))[0]?.result).toEqual(event.payload.run.result!);
  expect(await emitTerminalRun({ persist: true, bus }, event.payload.run, event.type, event.payload, "abnormal")).toBe(false);
  expect(seen).toHaveLength(1);
  await context.database.update(runs).set({ status: "running" });
  await context.database.execute(sql`DROP TABLE extension_release_deliveries`);
  await expect(emitTerminalRun({ persist: true, bus }, event.payload.run, event.type, event.payload, "abnormal")).rejects.toThrow();
  expect(seen).toHaveLength(1);
});
