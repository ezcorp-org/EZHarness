import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { validateManifest } from "@ezcorp/extension-contract";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { users, projects, conversations, conversationExtensions } from "../db/schema";
import { up as releaseTables } from "../db/migrations/add-extension-releases";
import { up as receiptTables } from "../db/migrations/add-extension-event-receipts";
import { releaseRuntimeFixture } from "./helpers/release-runtime";
import { DatabaseLifecycleRepository, releaseRows } from "../db/queries/extension-releases";
import { createExtension } from "../db/queries/extensions";
import { buildFullGrantFromManifest } from "../extensions/install-grant";
import { handleEmitLoopEventRpc } from "../extensions/loop-events-handler";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { isPersistedDomainEvent } from "../extensions/domain-event-outbox";
import { registerCallProvenance, releaseCallProvenance } from "../extensions/call-provenance";

mockDbConnection();
beforeEach(setupTestDb);
afterAll(closeTestDb);

async function fixture() {
  const database = getTestDb();
  await releaseTables(database);
  await receiptTables(database);
  const [owner] = await database.insert(users).values({ email: `${crypto.randomUUID()}@test.local`, name: "Owner", passwordHash: "fixture", status: "active" }).returning();
  const [project] = await database.insert(projects).values({ name: "Loop notices", path: `/tmp/${crypto.randomUUID()}` }).returning();
  const [conversation] = await database.insert(conversations).values({ userId: owner!.id, projectId: project!.id }).returning();
  const manifest = validateManifest({ schemaVersion: 4, name: "loop-notice", version: "1.0.0", description: "Notice fixture", author: { name: "Tests" }, permissions: { loopEvents: true, eventSubscriptions: ["loops:approval_pending", "loops:approval_resolved", "loops:auto_disabled"] } });
  const runtime = releaseRuntimeFixture(crypto.randomUUID(), manifest, { ownerId: owner!.id });
  await new DatabaseLifecycleRepository(database).create({ installation: runtime.snapshot.installation, releases: { [runtime.snapshot.release.id]: runtime.snapshot.release }, revisions: {}, workspaces: {}, approvals: {}, operations: {} });
  const extensionId = runtime.snapshot.installation.id;
  const grants = buildFullGrantFromManifest(manifest);
  await createExtension({ id: extensionId, name: manifest.name, version: manifest.version, manifest, grantedPermissions: grants, enabled: true, source: "release-v4", creatorUserId: owner!.id });
  await database.insert(conversationExtensions).values({ conversationId: conversation!.id, extensionId });
  const bus = new EventBus<AgentEvents>();
  const events: unknown[] = [];
  bus.on("loops:approval_pending", event => events.push(event));
  bus.on("loops:approval_resolved", event => events.push(event));
  bus.on("loops:auto_disabled", event => events.push(event));
  const context = { bus, userId: owner!.id, conversationId: conversation!.id, grantedPermissions: grants };
  const emit = (payload: Record<string, unknown> = {}, type = "approval_pending", token?: string) => handleEmitLoopEventRpc(extensionId, { jsonrpc: "2.0", id: crypto.randomUUID(), method: "ezcorp/emit-loop-event", params: { v: 1, type, payload: { loopId: "docs", runId: "loop-run", ...payload }, ...(token ? { _meta: { ezCallId: token } } : {}) } }, context);
  const counts = async () => releaseRows<{ receipts: number; audits: number; deliveries: number }>(await database.execute(sql`SELECT (SELECT COUNT(*)::int FROM extension_event_receipts) AS receipts, (SELECT COUNT(*)::int FROM audit_log WHERE action = 'ext:loop-event-emitted') AS audits, (SELECT COUNT(*)::int FROM extension_release_deliveries) AS deliveries`))[0];
  return { database, extensionId, owner: owner!, conversation: conversation!, context, events, emit, counts };
}

test("a child cannot redirect a loop notice to a different conversation", async () => {
  const context = await fixture();
  const response = await context.emit({ conversationId: "another-conversation" });
  expect(response.error).toBeDefined();
  expect(context.events).toHaveLength(0);
  expect(await context.counts()).toEqual({ receipts: 0, audits: 0, deliveries: 0 });
});

test("audit failure cannot publish or acknowledge a scoped loop notice", async () => {
  const context = await fixture();
  await context.database.execute(sql.raw("CREATE FUNCTION reject_loop_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'ext:loop-event-emitted' THEN RAISE EXCEPTION 'fixture audit unavailable'; END IF; RETURN NEW; END $$"));
  await context.database.execute(sql.raw("CREATE TRIGGER reject_loop_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_loop_audit()"));
  const response = await context.emit();
  expect(response.error).toBeDefined();
  expect(context.events).toHaveLength(0);
  expect(await context.counts()).toEqual({ receipts: 0, audits: 0, deliveries: 0 });
});

test("scoped admission commits audit and delivery once and preserves host scope", async () => {
  const context = await fixture();
  const responses = await Promise.all([context.emit(), context.emit()]);
  expect(responses.map(response => response.error)).toEqual([undefined, undefined]);
  expect(responses.map(response => (response.result as { duplicate: boolean }).duplicate).sort()).toEqual([false, true]);
  expect((responses[0]!.result as { receiptId: string }).receiptId).toBe((responses[1]!.result as { receiptId: string }).receiptId);
  expect(await context.counts()).toEqual({ receipts: 1, audits: 1, deliveries: 1 });
  expect(context.events).toHaveLength(1);
  expect(context.events[0]).toMatchObject({ conversationId: context.conversation.id, runId: "loop-run" });
  expect(isPersistedDomainEvent(context.events[0])).toBe(true);
  expect((await context.emit({ conversationId: "" })).result).toMatchObject({ duplicate: true });
  expect(context.events).toHaveLength(1);
});

test("a changed decision conflicts rather than rewriting accepted approval notice evidence", async () => {
  const context = await fixture();
  expect((await context.emit({ decision: "approved" }, "approval_resolved")).result).toMatchObject({ durable: true });
  expect((await context.emit({ decision: "declined" }, "approval_resolved")).error?.message).toContain("different payload");
  expect(await context.counts()).toEqual({ receipts: 1, audits: 1, deliveries: 1 });
  expect(context.events).toHaveLength(1);
});

test("revoked conversation ownership or inactive principal blocks retry and new admission", async () => {
  const context = await fixture();
  await context.database.update(users).set({ status: "inactive" }).where(eq(users.id, context.owner.id));
  expect((await context.emit()).error).toBeDefined();
  await context.database.update(users).set({ status: "active" }).where(eq(users.id, context.owner.id));
  context.context.userId = "not-the-owner";
  expect((await context.emit()).error).toBeDefined();
  expect(await context.counts()).toEqual({ receipts: 0, audits: 0, deliveries: 0 });
  expect(context.events).toHaveLength(0);
});

test("queue insertion failure rolls back receipt and audit before emission", async () => {
  const context = await fixture();
  await context.database.execute(sql.raw("CREATE FUNCTION reject_loop_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture queue unavailable'; END $$"));
  await context.database.execute(sql.raw("CREATE TRIGGER reject_loop_delivery BEFORE INSERT ON extension_release_deliveries FOR EACH ROW EXECUTE FUNCTION reject_loop_delivery()"));
  expect((await context.emit()).error).toBeDefined();
  expect(await context.counts()).toEqual({ receipts: 0, audits: 0, deliveries: 0 });
  expect(context.events).toHaveLength(0);
  await context.database.execute(sql.raw("DROP TRIGGER reject_loop_delivery ON extension_release_deliveries"));
  expect((await context.emit()).result).toMatchObject({ durable: true, duplicate: false });
  expect(await context.counts()).toEqual({ receipts: 1, audits: 1, deliveries: 1 });
});

test("scoped auto-disable requires a live host run and deduplicates only that run", async () => {
  const context = await fixture();
  expect((await context.emit({ consecutiveErrors: 3 }, "auto_disabled")).error).toBeDefined();
  for (const runId of ["host-run-1", "host-run-2"]) {
    const token = registerCallProvenance({ onBehalfOf: context.owner.id, actorExtensionId: context.extensionId, conversationId: context.conversation.id, runId, parentCallId: null, kind: "tool", ownerless: false });
    try {
      expect((await context.emit({ consecutiveErrors: 3 }, "auto_disabled", token)).result).toMatchObject({ durable: true, duplicate: false });
      expect((await context.emit({ consecutiveErrors: 3 }, "auto_disabled", token)).result).toMatchObject({ duplicate: true });
    } finally { releaseCallProvenance(token); }
    expect((await context.emit({ consecutiveErrors: 3 }, "auto_disabled", token)).error).toBeDefined();
  }
  expect(context.events).toHaveLength(2);
  expect(await context.counts()).toEqual({ receipts: 2, audits: 2, deliveries: 2 });
});

test("global notices are explicitly ephemeral and cannot enqueue extension subscribers", async () => {
  const context = await fixture();
  context.context.conversationId = "unknown";
  expect((await context.emit()).result).toEqual({ ok: true, durable: false });
  expect(context.events).toHaveLength(1);
  expect(context.events[0]).not.toHaveProperty("conversationId");
  expect(await context.counts()).toEqual({ receipts: 0, audits: 1, deliveries: 0 });
});
