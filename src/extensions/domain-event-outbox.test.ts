import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { validateManifest } from "@ezcorp/extension-contract";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../__tests__/helpers/test-pglite";
import { releaseRuntimeFixture } from "../__tests__/helpers/release-runtime";
import { DatabaseLifecycleRepository, releaseRows } from "../db/queries/extension-releases";
import { users, projects, conversations, conversationExtensions, extensions, runs, toolCalls } from "../db/schema";
import { up } from "../db/migrations/add-extension-releases";
import { createExtension } from "../db/queries/extensions";
import { insertRun, updateRun } from "../db/queries/runs";
import { persistToolCall } from "../db/queries/tool-calls";
import { buildFullGrantFromManifest } from "./install-grant";
import { ExtensionDeliveryQueue } from "./v4/deliveries";
import { publishDomainEvent, emitPersistedDomainEvent, isPersistedDomainEvent, sanitizeDomainEvent, type DomainExtensionEvent } from "./domain-event-outbox";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun } from "../types";
import { emitTerminalRun } from "../runtime/domain-events";

mockDbConnection();
beforeEach(setupTestDb);
afterAll(closeTestDb);

async function fixture(full = false) {
  const database = getTestDb();
  await up(database);
  const [owner] = await database.insert(users).values({ email: `${crypto.randomUUID()}@example.test`, passwordHash: "unused", name: "Owner", status: "active" }).returning();
  const [project] = await database.insert(projects).values({ name: "Event project", path: `/tmp/${crypto.randomUUID()}` }).returning();
  const [conversation] = await database.insert(conversations).values({ userId: owner!.id, projectId: project!.id, title: "Event" }).returning();
  const manifest = validateManifest({ schemaVersion: 4, name: "outbox-fixture", version: "1.0.0", description: "Fixture", author: { name: "Test" }, permissions: { eventSubscriptions: full ? { events: ["run:complete", "tool:complete", "tool:error"], includeFullPayload: true } : ["run:complete", "tool:complete", "tool:error"] } });
  const runtime = releaseRuntimeFixture(crypto.randomUUID(), manifest, { ownerId: owner!.id });
  const repository = new DatabaseLifecycleRepository(database);
  await repository.create({ installation: runtime.snapshot.installation, releases: { [runtime.snapshot.release.id]: runtime.snapshot.release }, revisions: {}, workspaces: {}, approvals: {}, operations: {} });
  const id = runtime.snapshot.installation.id;
  await createExtension({ id, name: manifest.name, version: manifest.version, manifest, grantedPermissions: buildFullGrantFromManifest(manifest), enabled: true, source: "release-v4", creatorUserId: owner!.id });
  await database.insert(conversationExtensions).values({ conversationId: conversation!.id, extensionId: id });
  const event: DomainExtensionEvent = { id: crypto.randomUUID(), type: "tool:complete", conversationId: conversation!.id, payload: { conversationId: "forged", input: { secret: "private" }, output: { secret: "private" }, toolName: "probe", _meta: { ezCallId: "forged" } } };
  const queue = new ExtensionDeliveryQueue(database);
  return { database, repository, id, owner: owner!, conversation: conversation!, event, queue };
}

test("rollback before commit removes both domain mutation and every queued recipient", async () => {
  const context = await fixture();
  await expect(context.database.transaction(async transaction => {
    await transaction.update(conversations).set({ title: "uncommitted" }).where(eq(conversations.id, context.conversation.id));
    await publishDomainEvent(transaction, context.event);
    throw new Error("simulated process failure before commit");
  })).rejects.toThrow("before commit");
  expect((await context.database.select().from(conversations).where(eq(conversations.id, context.conversation.id)))[0]?.title).toBe("Event");
  expect(await context.queue.claim()).toBeNull();
});

test("commit survives publisher loss before bus emit and a new queue instance recovers once", async () => {
  const context = await fixture();
  const [delivery] = await context.database.transaction(async transaction => {
    await transaction.update(conversations).set({ title: "committed" }).where(eq(conversations.id, context.conversation.id));
    return publishDomainEvent(transaction, context.event);
  });
  const restarted = new ExtensionDeliveryQueue(context.database);
  let effects = 0;
  expect((await restarted.dispatch(async record => { effects++; expect(record.id).toBe(delivery!.id); }))?.state).toBe("delivered");
  expect(await restarted.dispatch(async () => { effects++; })).toBeNull();
  expect(effects).toBe(1);
});

test("concurrent replay deduplicates and changed immutable payload rolls back", async () => {
  const context = await fixture();
  const results = await Promise.all([1, 2].map(() => context.database.transaction(transaction => publishDomainEvent(transaction, context.event))));
  expect(results[0]![0]!.id).toBe(results[1]![0]!.id);
  await expect(context.database.transaction(transaction => publishDomainEvent(transaction, { ...context.event, payload: { toolName: "different" } }))).rejects.toMatchObject({ code: "delivery_conflict" });
  await expect(context.database.transaction(transaction => publishDomainEvent(transaction, { ...context.event, payload: { ...context.event.payload, input: { secret: "different" } } }))).rejects.toMatchObject({ code: "delivery_conflict" });
});

test("bounded queue backpressure fails the source transaction instead of silently dropping its event", async () => {
  const context = await fixture();
  await context.database.execute(sql`INSERT INTO extension_release_deliveries(id, installation_id, deduplication_id, generation, state, available_at, lease_until, payload) SELECT 'full-' || generate_series, ${context.id}, 'full-' || generate_series, 1, 'queued', 0, 0, '{}' FROM generate_series(1,10000)`);
  await expect(context.database.transaction(async transaction => {
    await transaction.update(conversations).set({ title: "must roll back" }).where(eq(conversations.id, context.conversation.id));
    await publishDomainEvent(transaction, context.event);
  })).rejects.toMatchObject({ code: "event_queue_full" });
  expect((await context.database.select().from(conversations).where(eq(conversations.id, context.conversation.id)))[0]?.title).toBe("Event");
});

test("database ownership replaces payload identity and default grants remove sensitive tool fields", async () => {
  const context = await fixture();
  const [delivery] = await context.database.transaction(transaction => publishDomainEvent(transaction, context.event));
  expect(delivery!.input).toMatchObject({ params: { conversationId: context.conversation.id, toolName: "probe" }, provenance: { onBehalfOf: context.owner.id, actorExtensionId: context.id, ownerless: false } });
  expect((delivery!.input as { params: object }).params).not.toHaveProperty("output");
  expect((delivery!.input as { params: object }).params).not.toHaveProperty("input");
  expect((delivery!.input as { params: object }).params).not.toHaveProperty("_meta");
});

test("full payload needs sealed approval and current event grant", async () => {
  const context = await fixture(true);
  const [delivery] = await context.database.transaction(transaction => publishDomainEvent(transaction, context.event));
  expect((delivery!.input as { params: object }).params).toHaveProperty("output");
  await context.database.update(extensions).set({ grantedPermissions: { grantedAt: {} } }).where(eq(extensions.id, context.id));
  expect(await context.database.transaction(transaction => publishDomainEvent(transaction, { ...context.event, id: "after-revoke" }))).toEqual([]);
});

test("unwired or inactive owners and revoked sealed grants never receive events", async () => {
  const context = await fixture();
  await context.repository.transact(context.id, state => { state.installation.grants = []; });
  expect(await context.database.transaction(transaction => publishDomainEvent(transaction, context.event))).toEqual([]);
  await context.database.delete(conversationExtensions).where(eq(conversationExtensions.extensionId, context.id));
  expect(await context.database.transaction(transaction => publishDomainEvent(transaction, context.event))).toEqual([]);
  await context.database.update(users).set({ status: "inactive" }).where(eq(users.id, context.owner.id));
  expect(await context.database.transaction(transaction => publishDomainEvent(transaction, context.event))).toEqual([]);
});

test("invalid identities and oversized payloads cannot commit", async () => {
  const context = await fixture();
  for (const invalid of [{ ...context.event, id: "" }, { ...context.event, type: "run:token" as const }, { ...context.event, conversationId: "" }]) await expect(context.database.transaction(transaction => publishDomainEvent(transaction, invalid))).rejects.toMatchObject({ code: "invalid_event" });
  await expect(context.database.transaction(transaction => publishDomainEvent(transaction, { ...context.event, payload: { body: "x".repeat(1024 * 1024) } }))).rejects.toMatchObject({ code: "event_payload_limit" });
  expect(await context.queue.claim()).toBeNull();
});

test("UI bus sees the unchanged event only after durable commit and dispatcher marker cannot be forged", async () => {
  const context = await fixture();
  const bus = new EventBus<AgentEvents>();
  let seen = 0;
  bus.on("tool:complete", payload => { seen++; expect(payload === context.event.payload).toBe(true); expect(isPersistedDomainEvent(payload)).toBe(true); });
  expect(isPersistedDomainEvent({ durable: true })).toBe(false);
  expect(isPersistedDomainEvent(null)).toBe(false);
  expect(isPersistedDomainEvent("event")).toBe(false);
  await context.database.transaction(transaction => publishDomainEvent(transaction, context.event));
  expect(seen).toBe(0);
  emitPersistedDomainEvent(bus, context.event);
  emitPersistedDomainEvent(undefined, context.event);
  expect(seen).toBe(1);
  expect(sanitizeDomainEvent("run:complete", { run: {}, _meta: {} }, false)).toEqual({ run: {} });
});

test("terminal run and outbox commit together; replay does not fan out again", async () => {
  const context = await fixture();
  const run: AgentRun = { id: crypto.randomUUID(), agentName: "probe", status: "running", startedAt: Date.now(), logs: [] };
  await insertRun(run, undefined, undefined, context.conversation.id, context.owner.id);
  run.status = "success"; run.result = { success: true, output: "done" }; run.finishedAt = Date.now();
  const bus = new EventBus<AgentEvents>();
  let seen = 0;
  bus.on("run:complete", () => { seen++; });
  await emitTerminalRun({ persist: true, bus }, run, "run:complete", { run, conversationId: context.conversation.id });
  await emitTerminalRun({ persist: true, bus }, run, "run:complete", { run, conversationId: context.conversation.id });
  expect((await context.database.select().from(runs).where(eq(runs.id, run.id)))[0]?.status).toBe("success");
  expect(releaseRows(await context.database.execute(sql`SELECT id FROM extension_release_deliveries`))).toHaveLength(1);
  expect(seen).toBe(2);
  await expect(updateRun({ ...run, result: { success: true, output: "changed" } }, { ...context.event, id: `run:${run.id}:success`, type: "run:complete" })).rejects.toThrow("conflicts");
});

test("terminal publication failure leaves no success row or success bus event", async () => {
  const context = await fixture();
  const run: AgentRun = { id: crypto.randomUUID(), agentName: "probe", status: "running", startedAt: Date.now(), logs: [] };
  await insertRun(run, undefined, undefined, context.conversation.id, context.owner.id);
  run.status = "success"; run.result = { success: true, output: "x".repeat(1024 * 1024) };
  const bus = new EventBus<AgentEvents>();
  let seen = 0; bus.on("run:complete", () => { seen++; });
  await expect(emitTerminalRun({ persist: true, bus }, run, "run:complete", { run, conversationId: context.conversation.id })).rejects.toMatchObject({ code: "event_payload_limit" });
  expect((await context.database.select().from(runs).where(eq(runs.id, run.id)))[0]?.status).toBe("running");
  expect(seen).toBe(0);
});

test("non-persistent and unscoped runtime events retain the existing UI bus behavior", async () => {
  const bus = new EventBus<AgentEvents>();
  const run: AgentRun = { id: "transient", agentName: "probe", status: "success", startedAt: 1, logs: [] };
  let events = 0;
  bus.on("run:complete", payload => { events++; expect(isPersistedDomainEvent(payload)).toBe(false); });
  await emitTerminalRun({ persist: false, bus }, run, "run:complete", { run, conversationId: "transient" });
  await emitTerminalRun({ persist: true, bus }, run, "run:complete", { run });
  expect(events).toBe(2);
});

test("tool persistence and event share one transaction, including failed inserts", async () => {
  const context = await fixture();
  const row = { conversationId: context.conversation.id, messageId: null, extensionId: context.id, toolName: "probe", input: {}, output: { content: [] }, success: true, durationMs: 1 };
  await persistToolCall(row, context.event);
  expect((await context.database.select().from(toolCalls))[0]?.id).toBe(context.event.id);
  expect(await context.queue.claim()).not.toBeNull();
  await expect(persistToolCall({ ...row, messageId: "missing" }, { ...context.event, id: crypto.randomUUID() })).rejects.toMatchObject({ code: "event_persist_failed" });
  expect(await context.database.select().from(toolCalls)).toHaveLength(1);
});
