import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { FactoryCommandOutbox, FactoryOutboxError, FactoryRetryableCommandError, type FactoryCommandDelivery } from "./outbox";

let pglite: PGlite;
let database: ReturnType<typeof drizzle>;
let now = 1_000;
let outbox: FactoryCommandOutbox;

beforeAll(async () => {
  pglite = new PGlite();
  database = drizzle(pglite);
  await database.execute(sql`CREATE TABLE factory_command_outbox (
    id TEXT NOT NULL, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, logical_run_id TEXT NOT NULL,
    deduplication_id TEXT NOT NULL, input_hash TEXT NOT NULL, state TEXT NOT NULL,
    available_at BIGINT NOT NULL, lease_until BIGINT NOT NULL DEFAULT 0, payload TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, id), UNIQUE (tenant_id, project_id, deduplication_id)
  )`);
  outbox = new FactoryCommandOutbox(database, "tenant-one", "project-one", () => now);
});

afterAll(async () => { await pglite.close(); });
beforeEach(async () => {
  now = 1_000;
  await database.execute(sql`DELETE FROM factory_command_outbox`);
});

const start = (logicalRunId: string, body: unknown = { input: 1 }) => ({ kind: "start_run" as const, projectId: "project-one", logicalRunId, body });

describe("factory command outbox", () => {
  test("start enqueue is transactional, stable and conflicts on changed input", async () => {
    const first = await outbox.enqueue(start("run-one"));
    expect(first.command.workflowId).toBe("tenant-one/run-one");
    expect(first.command.requestId).toBe(first.command.commandId);
    expect(first.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await outbox.enqueue(start("run-one"))).id).toBe(first.id);
    await expect(outbox.enqueue(start("run-one", { input: 2 }))).rejects.toMatchObject({ code: "delivery_conflict" });

    await expect(database.transaction(async transaction => {
      await outbox.enqueueInTransaction(transaction, start("rolled-back"));
      throw new Error("caller failed");
    })).rejects.toThrow("caller failed");
    const rolledBackId = (await outbox.enqueue(start("rolled-back"))).id;
    expect(await outbox.inspect(rolledBackId)).not.toBeNull();
  });

  test("decision and partition notification keep stable signal identities", async () => {
    const decision = await outbox.enqueue({ kind: "decision", projectId: "project-one", logicalRunId: "signals", interpreterId: "partition-a", decisionId: "decision-1", body: { choice: "approve" } });
    const notice = await outbox.enqueue({ kind: "partition_notification", projectId: "project-one", logicalRunId: "signals", interpreterId: "partition-b", notificationId: "node-1-complete", body: { output: "artifact:1" } });
    expect(decision.command).toMatchObject({ interpreterId: "partition-a", eventId: "decision-1", kind: "decision" });
    expect(notice.command).toMatchObject({ interpreterId: "partition-b", eventId: "node-1-complete", kind: "partition_notification" });
    expect(decision.id).not.toBe(notice.id);
  });

  test("claims are tenant/project scoped and fenced by lease tokens", async () => {
    const delivery = await outbox.enqueue(start("lease"));
    const otherProject = new FactoryCommandOutbox(database, "tenant-one", "project-two", () => now);
    expect(await otherProject.claim()).toBeNull();
    const claimed = await outbox.claim(100);
    expect(claimed?.id).toBe(delivery.id);
    expect(await outbox.claim(100)).toBeNull();
    await expect(otherProject.settle(claimed!, "delivered")).rejects.toMatchObject({ code: "factory_command_scope_mismatch" });
    await expect(outbox.settle({ ...claimed!, leaseToken: "wrong" }, "delivered")).rejects.toMatchObject({ code: "delivery_lease_lost" });
    now += 101;
    expect(await outbox.claim(100)).toBeNull();
    expect((await outbox.inspect(delivery.id))?.state).toBe("outcome_unknown");
    await expect(outbox.settle(claimed!, "delivered")).rejects.toMatchObject({ code: "delivery_lease_lost" });
    await expect(outbox.settle({ ...claimed!, id: "missing" }, "delivered")).rejects.toMatchObject({ code: "not_found" });
    await expect(outbox.claim(0)).rejects.toMatchObject({ code: "invalid_lease" });
  });

  test("known failures retry with bounded backoff and dead-letter", async () => {
    const delivery = await outbox.enqueue(start("retry"));
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await outbox.dispatch(async () => { throw new FactoryRetryableCommandError("temporal_unavailable"); });
      expect(result).toMatchObject({ id: delivery.id, attempts: attempt, state: attempt === 3 ? "dead_letter" : "queued", failureCode: "temporal_unavailable" });
      now += 60_001;
    }
    expect(await outbox.claim()).toBeNull();

    const exhausted = await outbox.enqueue(start("already-exhausted"));
    const forced: FactoryCommandDelivery = { ...exhausted, attempts: 3, maxAttempts: 3 };
    await database.execute(sql`UPDATE factory_command_outbox SET payload = ${JSON.stringify(forced)} WHERE id = ${forced.id}`);
    expect(await outbox.claim()).toBeNull();
    expect((await outbox.inspect(forced.id))?.state).toBe("dead_letter");
  });

  test("dispatch records acknowledged and unknown outcomes without replay", async () => {
    const delivered = await outbox.enqueue(start("delivered"));
    expect((await outbox.dispatch(async command => { expect(command.id).toBe(delivered.id); }))?.state).toBe("delivered");
    const uncertain = await outbox.enqueue(start("uncertain"));
    let effects = 0;
    const result = await outbox.dispatch(async () => { effects += 1; throw new Error("ack lost"); });
    expect(result).toMatchObject({ id: uncertain.id, state: "outcome_unknown", failureCode: "external_outcome_unknown" });
    expect(await outbox.dispatch(async () => { effects += 1; })).toBeNull();
    expect(effects).toBe(1);

    const invalidCode = await outbox.enqueue(start("invalid-code"));
    const claimed = await outbox.claim();
    expect(claimed?.id).toBe(invalidCode.id);
    expect((await outbox.settle(claimed!, "retry", "bad code!")).failureCode).toBe("delivery_failed");
  });

  test("invalid identities and payloads fail before a write", async () => {
    expect(() => new FactoryCommandOutbox(database, "", "project")).toThrow("factory_command_identity_invalid");
    await expect(outbox.enqueue({ ...start("scope"), projectId: "other" })).rejects.toMatchObject({ code: "factory_command_scope_mismatch" });
    await expect(outbox.enqueue(start("x".repeat(513)))).rejects.toMatchObject({ code: "factory_command_identity_invalid" });
    await expect(outbox.enqueue({ kind: "decision", projectId: "project-one", logicalRunId: "run", interpreterId: "", decisionId: "decision", body: null })).rejects.toMatchObject({ code: "factory_command_identity_invalid" });
    await expect(outbox.enqueue(start("non-json", Number.POSITIVE_INFINITY))).rejects.toThrow();
    await expect(outbox.enqueue(start("large", "x".repeat(65_537)))).rejects.toMatchObject({ code: "factory_command_payload_too_large" });
    await expect(outbox.inspect("")).rejects.toMatchObject({ code: "factory_command_identity_invalid" });
    expect(new FactoryOutboxError("fixture").name).toBe("FactoryOutboxError");
  });
});
