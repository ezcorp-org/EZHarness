import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { FactoryBudgets, FACTORY_BUDGET_SCAN_MAX_LIMIT, type FactoryBudgetRequest, type FactoryUncertainHold } from "../../factory/budgets";
import { FactoryRecords } from "../../factory/records";
import { FactoryCommandOutbox } from "../../factory/outbox";
import { FactoryInbox } from "../../factory/inbox";
import { buildFactoryUsageSettlement } from "../../factory/usage-settlement";
import type { FactoryAttemptAuthority } from "../../factory/executions";
import { encodeFactoryPayload } from "../../factory/records";
import { digestObject } from "../../extensions/v4/blobs";
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
  const delayedTransactions = () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const delayed = Object.create(fixture.db, { transaction: { value: async <Result>(work: (transaction: MigrationDb) => Promise<Result>) => { await gate; return fixture.db.transaction(work); } } }) as TransactionalDb;
    return { release, captured: new FactoryBudgets(delayed, tenantId, async () => { if (!authorized) throw new Error("grant revoked"); }, () => now) };
  };

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

  test("measured settlement and child envelope closure commit with their terminal receipt", async () => {
    await open();
    await open("child", 7, "root");
    const request = reserve("child-terminal", 5, "child");
    await budgets.reserve(request, enqueue);
    await budgets.markUncertain(request, "runner-stopped-usage-pending");
    await expect(fixture.db.transaction(async transaction => {
      await budgets.settleInTransaction(transaction, request, amount(3), receipt);
      await budgets.closeEnvelopeInTransaction(transaction, key("child"));
      throw new Error("terminal receipt failed");
    })).rejects.toThrow("terminal receipt failed");
    expect(await budgets.inspect(key("child"))).toMatchObject({ state: "open", allocated: { costMicros: "5" }, spent: { costMicros: "0" } });
    expect(await budgets.inspect(key())).toMatchObject({ allocated: { costMicros: "7" }, spent: { costMicros: "0" } });
    await expect(budgets.closeEnvelope(key("child"))).rejects.toMatchObject({ code: "factory_budget_pending" });
    authorized = false;
    for (let replay = 0; replay < 2; replay++) await fixture.db.transaction(async transaction => {
      await budgets.settleInTransaction(transaction, request, amount(3), receipt);
      await budgets.closeEnvelopeInTransaction(transaction, key("child"));
    });
    expect(await budgets.inspect(key("child"))).toMatchObject({ state: "closed", allocated: { costMicros: "0" }, spent: { costMicros: "3" } });
    expect(await budgets.inspect(key())).toMatchObject({ allocated: { costMicros: "0" }, spent: { costMicros: "3" } });
    await expect(budgets.settle(request, amount(2), receipt)).rejects.toMatchObject({ code: "factory_budget_conflict" });
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
    const { captured, release } = delayedTransactions();
    const mutable = { projectId, runId, reservationId: first.reservationId };
    const allocation = { allocationToken: "snapshot-allocation", reservationGeneration: 1 };
    const pending = captured.markRunning(mutable, allocation);
    mutable.reservationId = second.reservationId;
    release();
    await pending;
    await expect(budgets.markRunning(first, { ...allocation, allocationToken: "changed" })).rejects.toMatchObject({ code: "factory_budget_conflict" });
    await budgets.markRunning(second, { ...allocation, allocationToken: "second-allocation" });
  });

  test("terminal settlement and closure capture their caller-owned scope before waiting", async () => {
    await open();
    await open("first", 4, "root");
    await open("second", 4, "root");
    const first = reserve("settle-first", 2, "first");
    const second = reserve("settle-second", 2, "second");
    await budgets.reserve(first, enqueue);
    await budgets.reserve(second, enqueue);
    const settlement = delayedTransactions();
    const mutable = { projectId, runId, reservationId: first.reservationId };
    const usage = amount(1);
    const pending = settlement.captured.settle(mutable, usage, receipt);
    mutable.reservationId = second.reservationId;
    usage.costMicros = "2"; usage.tokens = 2; usage.computeMs = 2;
    settlement.release();
    await pending;
    expect(await budgets.inspect(key("first"))).toMatchObject({ allocated: { tokens: "0" }, spent: { tokens: "1" } });
    expect(await budgets.inspect(key("second"))).toMatchObject({ allocated: { tokens: "2" }, spent: { tokens: "0" } });
    const closure = delayedTransactions();
    const mutableEnvelope = key("first");
    const closing = closure.captured.closeEnvelope(mutableEnvelope);
    mutableEnvelope.envelopeId = "second";
    closure.release();
    await closing;
    expect(await budgets.inspect(key("first"))).toMatchObject({ state: "closed" });
    expect(await budgets.inspect(key("second"))).toMatchObject({ state: "open" });
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

  test("a settled stop enqueues attempt-stopped and usage-settled in the same transaction", async () => {
    await open();
    const request = reserve("usage-settled", 6);
    await budgets.reserve(request, enqueue);
    await budgets.markRunning(request, { allocationToken: "usage-allocation", reservationGeneration: 1 });
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    const inboxKey = { projectId, runId, interpreterId: "root" };
    const authority = { attemptId: "usage-attempt", tenantId, projectId, runId, nodeInstanceId: "usage-node", candidateGeneration: 1, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, requestDigest: "a".repeat(64), deadlineAt: new Date(now + 1000) } satisfies FactoryAttemptAuthority;
    const settlement = buildFactoryUsageSettlement({ reservationId: request.reservationId, attemptId: authority.attemptId, authority, revision: 1, source: "stop", knownCostMicros: "4", settledAtMs: now });
    const stopped = { kind: "attempt-stopped" as const, id: `${authority.attemptId}:stopped`, atMs: now, nodeId: authority.nodeInstanceId, commandId: authority.attemptId, candidateGeneration: 1, attempt: 1 };
    const commit = async (transaction: MigrationDb) => {
      await budgets.settleInTransaction(transaction, request, amount(4), receipt);
      await inbox.enqueueInTransaction(transaction, inboxKey, stopped);
      await inbox.enqueueInTransaction(transaction, inboxKey, settlement.event);
      await transaction.execute(sql`INSERT INTO factory_usage_settlements (tenant_id,project_id,run_id,reservation_id,revision,attempt_id,source,known_cost_micros,settled_at_ms,settlement_digest,event_json,event_digest) VALUES (${tenantId},${projectId},${runId},${request.reservationId},${settlement.revision},${settlement.attemptId},${settlement.source},${settlement.knownCostMicros},${settlement.settledAtMs},${settlement.settlementDigest},${encodeFactoryPayload(settlement.event)},${`sha256:${digestObject(settlement.event)}`}) ON CONFLICT DO NOTHING`);
    };
    await expect(fixture.db.transaction(async transaction => { await commit(transaction); throw new Error("stop settlement failed"); })).rejects.toThrow("stop settlement failed");
    expect(await budgets.inspect(key())).toMatchObject({ allocated: { costMicros: "6" }, spent: { costMicros: "0" } });
    expect(rows(await fixture.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${runId}`))).toEqual([]);
    expect(rows(await fixture.db.execute(sql`SELECT revision FROM factory_usage_settlements WHERE run_id=${runId}`))).toEqual([]);
    for (let replay = 0; replay < 2; replay++) await fixture.db.transaction(commit);
    expect(await budgets.inspect(key())).toMatchObject({ allocated: { costMicros: "0" }, spent: { costMicros: "4" } });
    const enqueued = rows<{ event_id: string; sequence: number | string }>(await fixture.db.execute(sql`SELECT event_id,sequence FROM factory_inbox_events WHERE run_id=${runId} ORDER BY sequence`));
    expect(enqueued.map(row => row.event_id)).toEqual([`${authority.attemptId}:stopped`, `${request.reservationId}:usage:1`]);
    const stored = rows<{ revision: number | string; known_cost_micros: string; unknown_cost_micros: string | null; event_json: string }>(await fixture.db.execute(sql`SELECT revision,known_cost_micros,unknown_cost_micros,event_json FROM factory_usage_settlements WHERE run_id=${runId}`));
    expect(stored).toHaveLength(1);
    expect({ revision: Number(stored[0]!.revision), known: stored[0]!.known_cost_micros, unknown: stored[0]!.unknown_cost_micros }).toEqual({ revision: 1, known: "4", unknown: null });
    expect(JSON.parse(stored[0]!.event_json)).toEqual(settlement.event);
    const conflicting = buildFactoryUsageSettlement({ reservationId: request.reservationId, attemptId: authority.attemptId, authority, revision: 1, source: "stop", knownCostMicros: "5", settledAtMs: now });
    await expect(inbox.enqueue(inboxKey, conflicting.event)).rejects.toMatchObject({ code: "factory_inbox_conflict" });
  });

  test("lists exactly the uncertain holds reconciliation must still resolve", async () => {
    const list = (options?: { limit?: number; after?: FactoryUncertainHold["cursor"] }) =>
      fixture.db.transaction(transaction => budgets.listUncertainWithCostInTransaction(transaction, options));
    await open("root", 40);

    // Nothing is uncertain yet, so the work list is empty.
    expect(await list()).toEqual([]);

    // A held reservation is not uncertain, and a running one is not either.
    await budgets.reserve(reserve("scan-held", 3), enqueue);
    await budgets.reserve(reserve("scan-running", 3), enqueue);
    await budgets.markRunning({ projectId, runId, reservationId: "scan-running" }, { allocationToken: "scan-allocation", reservationGeneration: 1 });
    expect(await list()).toEqual([]);

    // Three uncertain holds with a real cost are the work.
    for (const reservationId of ["scan-c", "scan-a", "scan-b"]) {
      await budgets.reserve(reserve(reservationId, 3), enqueue);
      await budgets.markRunning({ projectId, runId, reservationId }, { allocationToken: `allocation-${reservationId}`, reservationGeneration: 1 });
      await budgets.markUncertain({ projectId, runId, reservationId }, `held-${reservationId}`);
    }
    // A zero-cost hold is not money anyone is holding, so it is not work.
    await budgets.reserve({ ...reserve("scan-zero", 0), amount: { costMicros: "0", tokens: 1, computeMs: 1 } }, enqueue);
    await budgets.markRunning({ projectId, runId, reservationId: "scan-zero" }, { allocationToken: "allocation-zero", reservationGeneration: 1 });
    await budgets.markUncertain({ projectId, runId, reservationId: "scan-zero" }, "held-zero");

    const all = await list();
    expect(all.map(entry => entry.reservationId)).toEqual(["scan-a", "scan-b", "scan-c"]);
    expect(all.every(entry => entry.heldCostMicros === "3" && entry.projectId === projectId && entry.runId === runId && entry.envelopeId === "root")).toBe(true);
    expect(all.map(entry => entry.uncertainty)).toEqual(["held-scan-a", "held-scan-b", "held-scan-c"]);
    expect(all[0]!.cursor).toEqual({ createdAtMs: all[0]!.cursor.createdAtMs, runId, reservationId: "scan-a" });

    // Pages partition the work with no repeat and no gap.
    const pageOne = await list({ limit: 2 });
    expect(pageOne.map(entry => entry.reservationId)).toEqual(["scan-a", "scan-b"]);
    const pageTwo = await list({ limit: 2, after: pageOne[1]!.cursor });
    expect(pageTwo.map(entry => entry.reservationId)).toEqual(["scan-c"]);
    expect(await list({ limit: 2, after: pageTwo[0]!.cursor })).toEqual([]);

    // Concurrent scans take no locks and agree.
    expect(await Promise.all([list(), list()])).toEqual([all, all]);

    // A settlement that still holds a cost leaves the hold on the list; one
    // that resolves it takes the reservation out of `uncertain` entirely.
    const digest = (fill: string) => `sha256:${fill.repeat(64)}`;
    // A provider receipt digest is the C02 bare form; the digests this process
    // seals itself stay prefixed. Coordinator ruling, 2026-09-20.
    const providerReceipt = "d".repeat(64);
    await fixture.db.execute(sql`INSERT INTO factory_usage_settlements (tenant_id,project_id,run_id,reservation_id,revision,attempt_id,source,known_cost_micros,unknown_cost_micros,settled_at_ms,settlement_digest,event_json,event_digest) VALUES (${tenantId},${projectId},${runId},'scan-a',1,'scan-attempt','stop','0','3',1,${digest("b")},'{}',${digest("c")})`);
    expect((await list()).map(entry => entry.reservationId)).toEqual(["scan-a", "scan-b", "scan-c"]);
    await fixture.db.execute(sql`INSERT INTO factory_usage_settlements (tenant_id,project_id,run_id,reservation_id,revision,attempt_id,source,known_cost_micros,provider_receipt_digest,settled_at_ms,settlement_digest,event_json,event_digest) VALUES (${tenantId},${projectId},${runId},'scan-a',2,'scan-attempt','reconciliation','3',${providerReceipt},2,${digest("e")},'{}',${digest("f")})`);
    expect((await list()).map(entry => entry.reservationId)).toEqual(["scan-b", "scan-c"]);
    // Settling the reservation itself removes it for the same reason.
    await budgets.settle({ projectId, runId, reservationId: "scan-b" }, amount(3), receipt);
    expect((await list()).map(entry => entry.reservationId)).toEqual(["scan-c"]);

    // Bounds and a malformed cursor are refused rather than scanned.
    for (const limit of [0, -1, 1.5, FACTORY_BUDGET_SCAN_MAX_LIMIT + 1]) await expect(list({ limit })).rejects.toMatchObject({ code: "factory_budget_invalid" });
    await expect(list({ after: { createdAtMs: -1, runId, reservationId: "scan-c" } })).rejects.toMatchObject({ code: "factory_budget_invalid" });
    await expect(list({ after: { createdAtMs: 1, runId: "", reservationId: "scan-c" } })).rejects.toBeInstanceOf(Error);

    // A non-canonical amount reaches the decoder and is refused, rather than
    // being dropped from a worker's list without anyone noticing.
    await fixture.db.execute(sql`UPDATE factory_budget_reservations SET amount='{"costMicros":"x","tokens":"1","computeMs":"1"}' WHERE run_id=${runId} AND reservation_id='scan-c'`);
    await expect(list()).rejects.toMatchObject({ code: "factory_budget_corrupt" });
    await fixture.db.execute(sql`UPDATE factory_budget_reservations SET amount='{"computeMs":"3","costMicros":"3","tokens":"3"}' WHERE run_id=${runId} AND reservation_id='scan-c'`);
    // An uncertain hold with no recorded reason is corrupt, not silently listed.
    await fixture.db.execute(sql`UPDATE factory_budget_reservations SET uncertainty=NULL WHERE run_id=${runId} AND reservation_id='scan-c'`);
    await expect(list()).rejects.toMatchObject({ code: "factory_budget_corrupt" });
    await fixture.db.execute(sql`UPDATE factory_budget_reservations SET uncertainty='held-scan-c' WHERE run_id=${runId} AND reservation_id='scan-c'`);
    expect((await list()).map(entry => entry.reservationId)).toEqual(["scan-c"]);
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
