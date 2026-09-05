import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import { releaseRuntimeFixture } from "./helpers/release-runtime";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { admitEventInTransaction, getEventReceipt, purgeExpiredEventReceipts, EVENT_RECEIPT_RETENTION_MS } from "../db/queries/extension-event-receipts";
import { up } from "../db/migrations/add-extension-event-receipts";
import { ExtensionDeliveryQueue } from "../extensions/v4/deliveries";
import type { MigrationDb } from "../db/migrations/types";
import { settings } from "../db/schema";

mockDbConnection();
beforeEach(setupTestDb);
afterAll(closeTestDb);

async function fixture() {
  const database = getTestDb();
  await up(database);
  const runtime = releaseRuntimeFixture("receipt-extension", { schemaVersion: 4, name: "receipt-extension", version: "1.0.0", description: "Receipt fixture", author: { name: "Test" }, permissions: {} });
  const installation = runtime.snapshot.installation;
  await new DatabaseLifecycleRepository(database).create({ installation, releases: { [runtime.snapshot.release.id]: runtime.snapshot.release }, revisions: {}, workspaces: {}, operations: {}, approvals: {} });
  const admission = { principalId: "owner", namespace: "ask-user:answer", key: "question-1", scope: "conversation-1", payload: { answer: "yes" } };
  const publish = async (transaction: MigrationDb, eventId: string) => [await ExtensionDeliveryQueue.enqueueInTransaction(transaction, {
    installationId: installation.id, releaseId: installation.activeReleaseId!, generation: installation.generation,
    principalId: installation.ownerId, scope: installation.scope, deduplicationId: eventId, kind: "event", input: admission.payload,
  })];
  return { database, admission, publish, queue: new ExtensionDeliveryQueue(database) };
}

test("failed domain transaction rolls back receipt, state and delivery together", async () => {
  const context = await fixture();
  await expect(context.database.transaction(async transaction => {
    await transaction.insert(settings).values({ key: "receipt-domain", value: "new" });
    await admitEventInTransaction(transaction, context.admission, id => context.publish(transaction, id));
    throw new Error("before commit");
  })).rejects.toThrow("before commit");
  expect(await getEventReceipt(context.database, context.admission)).toBeNull();
  expect(await context.queue.claim()).toBeNull();
  expect(await context.database.select().from(settings).where(eq(settings.key, "receipt-domain"))).toEqual([]);
});

test("concurrent admission and restart replay publish once with immutable receipt", async () => {
  const context = await fixture();
  let publications = 0;
  const admit = () => context.database.transaction(transaction => admitEventInTransaction(transaction, context.admission, async id => { publications++; return context.publish(transaction, id); }, 100));
  const results = await Promise.all([admit(), admit()]);
  expect(results.filter(result => result.accepted)).toHaveLength(1);
  expect(results[0]!.receipt).toEqual(results[1]!.receipt);
  expect(publications).toBe(1);
  expect(await getEventReceipt(context.database, context.admission)).toEqual(results[0]!.receipt);
  const restarted = new ExtensionDeliveryQueue(context.database);
  let effects = 0;
  expect((await restarted.dispatch(async () => { effects++; }))?.state).toBe("delivered");
  expect((await admit()).accepted).toBe(false);
  expect(await restarted.dispatch(async () => { effects++; })).toBeNull();
  expect(effects).toBe(1);
});

test("zero recipients remain accepted and later subscribers do not receive old actions", async () => {
  const context = await fixture();
  const original = await context.database.transaction(transaction => admitEventInTransaction(transaction, context.admission, async () => []));
  expect(original.receipt.deliveryIds).toEqual([]);
  const replay = await context.database.transaction(transaction => admitEventInTransaction(transaction, context.admission, id => context.publish(transaction, id)));
  expect(replay).toEqual({ accepted: false, receipt: original.receipt });
  expect(await context.queue.claim()).toBeNull();
});

test("same key cannot change payload or scope and another owner cannot read its receipt", async () => {
  const context = await fixture();
  const first = await context.database.transaction(transaction => admitEventInTransaction(transaction, context.admission, async () => []));
  for (const mutation of [{ payload: { answer: "no" } }, { scope: "other-conversation" }]) {
    await expect(context.database.transaction(transaction => admitEventInTransaction(transaction, { ...context.admission, ...mutation }, async () => []))).rejects.toHaveProperty("code", "event_conflict");
  }
  expect(await getEventReceipt(context.database, { ...context.admission, principalId: "other" })).toBeNull();
  for (const mutation of [{ principalId: "other" }, { key: "question-2" }, { namespace: "other:action" }]) {
    const result = await context.database.transaction(transaction => admitEventInTransaction(transaction, { ...context.admission, ...mutation }, async () => []));
    expect(result.accepted).toBe(true);
    expect(result.receipt.id).not.toBe(first.receipt.id);
  }
});

test("bounded event identities, payloads and recipients fail before commit", async () => {
  const context = await fixture();
  for (const mutation of [{ principalId: "" }, { namespace: "bad namespace" }, { key: "\n" }, { key: "x".repeat(129) }]) {
    await expect(context.database.transaction(transaction => admitEventInTransaction(transaction, { ...context.admission, ...mutation }, async () => []))).rejects.toHaveProperty("code", "invalid_event_key");
  }
  await expect(context.database.transaction(transaction => admitEventInTransaction(transaction, { ...context.admission, scope: "" }, async () => []))).rejects.toHaveProperty("code", "invalid_event_scope");
  await expect(context.database.transaction(transaction => admitEventInTransaction(transaction, context.admission, async () => [], NaN))).rejects.toHaveProperty("code", "invalid_event_scope");
  await expect(context.database.transaction(transaction => admitEventInTransaction(transaction, { ...context.admission, payload: "x".repeat(256 * 1024) }, async () => []))).rejects.toHaveProperty("code", "event_payload_limit");
  for (const deliveries of [Array.from({ length: 1001 }, () => ({ id: "event" })), [{ id: "" }]]) {
    await expect(context.database.transaction(transaction => admitEventInTransaction(transaction, context.admission, async () => deliveries))).rejects.toHaveProperty("code", "event_recipient_limit");
  }
  expect(await getEventReceipt(context.database, context.admission)).toBeNull();
});

test("retention preserves pending and uncertain deliveries and expires terminal receipts only", async () => {
  const context = await fixture();
  const { receipt } = await context.database.transaction(transaction => admitEventInTransaction(transaction, context.admission, id => context.publish(transaction, id), 0));
  expect(receipt.retainUntil).toBe(EVENT_RECEIPT_RETENTION_MS);
  expect(await context.database.transaction(transaction => purgeExpiredEventReceipts(transaction, EVENT_RECEIPT_RETENTION_MS - 1))).toBe(0);
  expect(await context.database.transaction(transaction => purgeExpiredEventReceipts(transaction, EVENT_RECEIPT_RETENTION_MS))).toBe(0);
  await context.database.execute(sql`UPDATE extension_release_deliveries SET state = 'outcome_unknown'`);
  expect(await context.database.transaction(transaction => purgeExpiredEventReceipts(transaction, EVENT_RECEIPT_RETENTION_MS))).toBe(0);
  await context.database.execute(sql`UPDATE extension_release_deliveries SET state = 'delivered'`);
  expect(await context.database.transaction(transaction => purgeExpiredEventReceipts(transaction, EVENT_RECEIPT_RETENTION_MS))).toBe(1);
  expect(await getEventReceipt(context.database, context.admission)).toBeNull();
  await expect(purgeExpiredEventReceipts(context.database, -1)).rejects.toHaveProperty("code", "invalid_event_scope");
});
