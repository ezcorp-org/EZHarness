import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { FactoryBudgets, type FactoryBudgetRequest } from "../../factory/budgets";
import { FactoryRecords } from "../../factory/records";
import { FactoryCommandOutbox } from "../../factory/outbox";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { up } from "../../db/migrations/add-factory-budgets";

export function factoryBudgetsConformance(createFixture: () => Promise<{ db: TransactionalDb; close(): Promise<void> }>): void {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  let budgets: FactoryBudgets;
  let records: FactoryRecords;
  let now = Date.UTC(2030, 0, 1);
  let authorized = true;
  let sequence = 0;
  let runId: string;
  const projectId = "budget-project";
  const tenantId = "budget-tenant";
  const receipt = `sha256:${"a".repeat(64)}`;
  const makeBudgets = () => new FactoryBudgets(fixture.db, tenantId, async () => { if (!authorized) throw new Error("grant revoked"); }, () => now);
  const key = (envelopeId = "root") => ({ projectId, runId, envelopeId });
  const bounds = (value: number) => ({ maxCostMicros: String(value), maxTokens: value, maxComputeMs: value });
  const amount = (value: number) => ({ costMicros: String(value), tokens: value, computeMs: value });
  const reserve = (reservationId: string, value: number, envelopeId = "root"): FactoryBudgetRequest => ({ ...key(envelopeId), reservationId, amount: amount(value), computeRequest: { cpu: 1 } });
  const open = (envelopeId = "root", value = 10, parentId?: string) => budgets.openEnvelope({ ...key(envelopeId), limits: bounds(value), deadlineAtMs: now + 100, ...(parentId === undefined ? {} : { parentId }) });
  const enqueue = (transaction: MigrationDb, request: FactoryBudgetRequest) => new FactoryCommandOutbox(fixture.db, tenantId, projectId, () => now, "pool").enqueueInTransaction(transaction, { kind: "compute_admission", projectId, logicalRunId: request.runId, reservationId: request.reservationId, body: request.computeRequest }).then(() => undefined);

  beforeAll(async () => {
    fixture = await createFixture();
    await up(fixture.db);
    records = new FactoryRecords(fixture.db, tenantId);
    await records.bindInstallation();
    await fixture.db.execute(sql`INSERT INTO projects (id, name, path) VALUES (${projectId}, 'Budget project', '/tmp/budget-project')`);
    await fixture.db.execute(sql`INSERT INTO users (id, email, password_hash, name) VALUES ('budget-human', 'budget@example.test', 'not-a-login', 'Budget human')`);
    await records.bindProject(projectId);
  });
  afterAll(async () => { await fixture?.close(); });
  beforeEach(async () => {
    now = Date.UTC(2030, 0, 1);
    authorized = true;
    runId = `budget-run-${++sequence}`;
    budgets = makeBudgets();
    await records.createRun({ projectId, runId, definitionDigest: receipt, interpreterBuild: "v1", executionEpoch: 1, principalId: "budget-human", input: {} }, async () => {});
  });

  test("budget admission and compute outbox commit once; competing children cannot overspend", async () => {
    expect(await open()).toEqual({ created: true });
    expect(await open()).toEqual({ created: false });
    await expect(open("root", 11)).rejects.toMatchObject({ code: "factory_budget_conflict" });
    const raced = await Promise.allSettled([budgets.reserve(reserve("left", 7), enqueue), budgets.reserve(reserve("right", 7), enqueue)]);
    expect(raced.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter(value => value.status === "rejected")).toHaveLength(1);
    const held = rows<{ reservation_id: string }>(await fixture.db.execute(sql`SELECT reservation_id FROM factory_budget_reservations WHERE run_id=${runId}`));
    expect(held).toHaveLength(1);
    expect(await budgets.reserve(reserve(held[0]!.reservation_id, 7), enqueue)).toEqual({ created: false });
    await expect(budgets.reserve(reserve(held[0]!.reservation_id, 8), enqueue)).rejects.toMatchObject({ code: "factory_budget_conflict" });
    expect(rows(await fixture.db.execute(sql`SELECT id FROM factory_command_outbox WHERE logical_run_id=${runId}`))).toHaveLength(1);
    const temporal = new FactoryCommandOutbox(fixture.db, tenantId, projectId, () => now);
    expect(await temporal.claim()).toBeNull();
    const pool = new FactoryCommandOutbox(fixture.db, tenantId, projectId, () => now, "pool");
    expect((await pool.claim())?.command.kind).toBe("compute_admission");
    expect((await budgets.inspect(key())).allocated.tokens).toBe("7");
  });

  test("outbox and audit failures roll back the budget hold", async () => {
    await open();
    await expect(budgets.reserve(reserve("outbox-error", 5), async (transaction, request) => { await enqueue(transaction, request); throw new Error("outbox failure"); })).rejects.toThrow("outbox failure");
    expect((await budgets.inspect(key())).allocated.tokens).toBe("0");
    expect(rows(await fixture.db.execute(sql`SELECT id FROM factory_command_outbox WHERE logical_run_id=${runId}`))).toHaveLength(0);
    await fixture.db.execute(sql`ALTER TABLE audit_log RENAME TO budget_hidden_audit`);
    try {
      await expect(budgets.reserve(reserve("audit-error", 5), enqueue)).rejects.toThrow();
      expect((await budgets.inspect(key())).allocated.tokens).toBe("0");
    } finally { await fixture.db.execute(sql`ALTER TABLE budget_hidden_audit RENAME TO audit_log`); }
    expect(await budgets.reserve(reserve("audit-error", 5), enqueue)).toEqual({ created: true });
  });

  test("compute allocation and its admission event share one rollback boundary", async () => {
    await open();
    const request = reserve("atomic-allocation", 5);
    await budgets.reserve(request, enqueue);
    const allocation = { allocationToken: "first-allocation", reservationGeneration: 1 };
    await expect(fixture.db.transaction(async transaction => {
      await budgets.markRunningInTransaction(transaction, request, allocation);
      throw new Error("admission event unavailable");
    })).rejects.toThrow("admission event unavailable");
    await budgets.markRunning(request, { ...allocation, allocationToken: "replacement-allocation" });
    await expect(budgets.markRunning(request, allocation)).rejects.toMatchObject({ code: "factory_budget_conflict" });
    expect((await budgets.inspect(key())).allocated.tokens).toBe("5");
  });

  test("an allocation keeps its requested reservation while the transaction waits", async () => {
    await open();
    const first = reserve("snapshot-first", 2);
    const second = reserve("snapshot-second", 2);
    await budgets.reserve(first, enqueue);
    await budgets.reserve(second, enqueue);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const delayed = Object.create(fixture.db, { transaction: { value: async <Result>(work: (transaction: MigrationDb) => Promise<Result>) => { await gate; return fixture.db.transaction(work); } } }) as TransactionalDb;
    const captured = new FactoryBudgets(delayed, tenantId, async () => { if (!authorized) throw new Error("grant revoked"); }, () => now);
    const mutable = { projectId, runId, reservationId: first.reservationId };
    const allocation = { allocationToken: "snapshot-allocation", reservationGeneration: 1 };
    const pending = captured.markRunning(mutable, allocation);
    mutable.reservationId = second.reservationId;
    release();
    await pending;
    await expect(budgets.markRunning(first, { ...allocation, allocationToken: "changed" })).rejects.toMatchObject({ code: "factory_budget_conflict" });
    await budgets.markRunning(second, { ...allocation, allocationToken: "second-allocation" });
  });

  test("unknown usage keeps its full hold across restart, deadline and revocation", async () => {
    await open();
    const request = reserve("unknown", 10);
    await budgets.reserve(request, enqueue);
    const allocation = { allocationToken: "opaque-pool-allocation", reservationGeneration: 1 };
    await budgets.markRunning(request, allocation);
    await budgets.markRunning(request, allocation);
    await expect(budgets.markRunning(request, { ...allocation, allocationToken: "changed" })).rejects.toMatchObject({ code: "factory_budget_conflict" });
    await budgets.markUncertain(request, "provider-response-lost");
    await budgets.markUncertain(request, "provider-response-lost");
    await expect(budgets.markUncertain(request, "different" )).rejects.toMatchObject({ code: "factory_budget_conflict" });
    budgets = makeBudgets();
    await expect(budgets.reserve(reserve("extra", 1), enqueue)).rejects.toMatchObject({ code: "factory_budget_exhausted" });
    await expect(budgets.closeEnvelope(key())).rejects.toMatchObject({ code: "factory_budget_pending" });
    now += 100;
    authorized = false;
    await expect(budgets.reserve(reserve("revoked", 0), enqueue)).rejects.toThrow("grant revoked");
    expect((await budgets.inspect(key())).allocated.tokens).toBe("10");
    await Promise.all([budgets.settle(request, amount(6), receipt), budgets.settle(request, amount(6), receipt)]);
    await expect(budgets.settle(request, amount(5), receipt)).rejects.toMatchObject({ code: "factory_budget_conflict" });
    expect(await budgets.inspect(key())).toMatchObject({ allocated: { tokens: "0" }, spent: { tokens: "6", costMicros: "6" } });
    await budgets.closeEnvelope(key());
    await budgets.closeEnvelope(key());
    expect((await budgets.inspect(key())).state).toBe("closed");
  });

  test("child envelopes return unused allowance once and cannot widen their deadline", async () => {
    await open();
    await open("child", 7, "root");
    await expect(open("other", 4, "root")).rejects.toMatchObject({ code: "factory_budget_exhausted" });
    await expect(budgets.openEnvelope({ ...key("late"), parentId: "root", limits: bounds(1), deadlineAtMs: now + 101 })).rejects.toMatchObject({ code: "factory_budget_widening" });
    await expect(budgets.closeEnvelope(key())).rejects.toMatchObject({ code: "factory_budget_pending" });
    const request = reserve("nested", 7, "child");
    await budgets.reserve(request, enqueue);
    await budgets.settle(request, amount(3), receipt);
    await budgets.closeEnvelope(key("child"));
    await budgets.closeEnvelope(key("child"));
    expect(await budgets.inspect(key())).toMatchObject({ allocated: { tokens: "0" }, spent: { tokens: "3" } });
    await expect(budgets.reserve(reserve("closed", 0, "child"), enqueue)).rejects.toMatchObject({ code: "factory_budget_deadline" });
    expect(await budgets.reserve(reserve("remaining", 7), enqueue)).toEqual({ created: true });
    await expect(open("second-root", 100)).rejects.toThrow();
  });

  test("unexpected actual overspend is recorded and stops admission throughout the run", async () => {
    await open();
    await open("child", 2, "root");
    const request = reserve("overdrawn", 2, "child");
    await budgets.reserve(request, enqueue);
    await budgets.settle(request, amount(12), receipt);
    expect(await budgets.inspect(key("child"))).toMatchObject({ admissionBlocked: true, spent: { tokens: "12" } });
    await expect(budgets.reserve(reserve("sibling", 1), enqueue)).rejects.toMatchObject({ code: "factory_budget_reconciliation_required" });
    await budgets.closeEnvelope(key("child"));
    expect((await budgets.inspect(key())).spent.tokens).toBe("12");
    await budgets.closeEnvelope(key());
  });

  test("money beyond binary integer precision is reserved and charged exactly", async () => {
    await budgets.openEnvelope({ ...key(), limits: { maxCostMicros: "9007199254740993", maxTokens: 0, maxComputeMs: 0 }, deadlineAtMs: now + 100 });
    const request = { ...reserve("large-money", 0), amount: { costMicros: "9007199254740992", tokens: 0, computeMs: 0 } };
    await budgets.reserve(request, enqueue);
    await expect(budgets.reserve({ ...reserve("excess-money", 0), amount: { costMicros: "2", tokens: 0, computeMs: 0 } }, enqueue)).rejects.toMatchObject({ code: "factory_budget_exhausted" });
    await budgets.settle(request, { costMicros: "9007199254740991", tokens: 0, computeMs: 0 }, receipt);
    expect((await budgets.inspect(key())).spent.costMicros).toBe("9007199254740991");
    await fixture.db.execute(sql`UPDATE factory_budget_envelopes SET allocated='{"costMicros":"-1","tokens":"0","computeMs":"0"}' WHERE run_id=${runId}`);
    await expect(budgets.inspect(key())).rejects.toMatchObject({ code: "factory_budget_corrupt" });
  });

  test("invalid, stale and foreign requests fail without durable allocation", async () => {
    await expect(budgets.openEnvelope({ ...key(), limits: bounds(1), deadlineAtMs: now })).rejects.toMatchObject({ code: "factory_budget_deadline" });
    await open();
    for (const invalid of [{ costMicros: "01", tokens: 0, computeMs: 0 }, { costMicros: "0", tokens: -1, computeMs: 0 }]) await expect(budgets.reserve({ ...reserve("bad", 1), amount: invalid }, enqueue)).rejects.toMatchObject({ code: "factory_budget_invalid" });
    await expect(budgets.inspect({ ...key(), projectId: "foreign" })).rejects.toMatchObject({ code: "factory_budget_scope" });
    await expect(budgets.inspect(key("missing"))).rejects.toMatchObject({ code: "factory_budget_not_found" });
    await expect(budgets.markUncertain({ projectId, runId, reservationId: "missing" }, "lost")).rejects.toMatchObject({ code: "factory_budget_not_found" });
    await expect(budgets.markRunning(reserve("invalid", 0), { allocationToken: "token", reservationGeneration: 0 })).rejects.toMatchObject({ code: "factory_budget_invalid" });
    await expect(budgets.settle(reserve("invalid", 0), amount(0), "unverified")).rejects.toMatchObject({ code: "factory_budget_receipt_invalid" });
    now += 100;
    await expect(budgets.reserve(reserve("expired", 1), enqueue)).rejects.toMatchObject({ code: "factory_budget_deadline" });
  });
}
