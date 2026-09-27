import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import type { MigrateDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows } from "../../db/queries/extension-releases";
import { FactoryBudgets } from "../../factory/budgets";
import { factoryUsageReconciliationDriver } from "../../factory/dispatch-composition";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../factory/executions";
import { FactoryInbox } from "../../factory/inbox";
import { FactoryRestore, factoryRestoreReportDigest, type FactoryRestoreReport } from "../../factory/restore";
import { clearResolvedSupersessionInTransaction, FactoryAttemptNotSupersededError, readAttemptSupersessionInTransaction, readSupersededOperationsInTransaction, supersedeEpochAttemptsInTransaction } from "../../factory/attempt-supersessions";
import { FactoryUsageReconciliation, FactoryUsageSettlements } from "../../factory/usage-settlement";
import { FACTORY_TEST_DIGEST, factoryTestAuthority, factoryTestRunnerRequest } from "./factory-attempt-fixtures";

/**
 * W15f: a hold whose attempt belongs to an execution epoch a restore has left.
 *
 * W01i's real lane (and W14's baseline lane) reported "Factory run epoch is
 * stale or unavailable." fifteen times per run: the console's restore case opens
 * a restore epoch, which moves the installation's execution epoch; a hold left
 * uncertain by an attempt of the old epoch then fails the run fence on every
 * usage-reconciliation pass, forever, because the attempt's authority can never
 * name the new epoch. The lane's order is reproduced here with the real journal,
 * the real budgets scan, the real reconciler, and the real role driver; the
 * epoch moves exactly as `FactoryRestore` moves it (installation first, runs when
 * a restore is signed).
 */

const TENANT = "usage-epoch-tenant";
const PROJECT = "usage-epoch-project";
const ENVELOPE = "usage-epoch-envelope";

interface HeldAttempt { readonly runId: string; readonly reservationId: string; readonly sealed: FactoryAttemptAuthority }

export interface FactoryUsageEpochFixture {
  db: MigrateDb & TransactionalDb;
  close(): Promise<void>;
}

export function factoryUsageEpochConformance(createFixture: () => Promise<FactoryUsageEpochFixture>): void {
  let fixture: FactoryUsageEpochFixture;
  const held = new Map<string, HeldAttempt>();

  /** One run at `epoch`, one admitted attempt of it, and one uncertain hold with a cost. */
  async function holdIn(name: string, epoch: number): Promise<HeldAttempt> {
    const db = fixture.db;
    const runId = `${name}-run`, reservationId = `${name}-reservation`;
    await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${TENANT}, ${PROJECT}, ${runId}, ${FACTORY_TEST_DIGEST}, 'test', ${epoch}, 'request', '{}')`);
    await db.execute(sql`INSERT INTO factory_budget_envelopes(tenant_id, project_id, run_id, envelope_id, request_digest, limits, allocated, spent, deadline_ms, state) VALUES (${TENANT}, ${PROJECT}, ${runId}, ${ENVELOPE}, ${FACTORY_TEST_DIGEST}, '{}', '{}', '{}', 2000000000000, 'open')`);
    await db.execute(sql`INSERT INTO factory_budget_reservations(tenant_id, project_id, run_id, reservation_id, envelope_id, request_digest, amount, state, uncertainty) VALUES (${TENANT}, ${PROJECT}, ${runId}, ${reservationId}, ${ENVELOPE}, ${FACTORY_TEST_DIGEST}, '{"computeMs":"0","costMicros":"1000","tokens":"0"}', 'uncertain', 'provider outcome lost')`);
    const attempt = factoryTestAuthority({ attemptId: `${name}-attempt`, tenantId: TENANT, projectId: PROJECT, runId, nodeInstanceId: `${name}-node` }, { executionEpoch: epoch });
    const request = factoryTestRunnerRequest(attempt);
    const sealed: FactoryAttemptAuthority = { ...attempt, requestDigest: factoryRunnerRequestDigest(request) };
    await new FactoryExecutionJournal(db, async () => {}).admit({ ...sealed, request });
    const hold = { runId, reservationId, sealed };
    held.set(reservationId, hold);
    return hold;
  }

  /** A fresh role driver over the real store, as a newly started process builds it. */
  function driver(reports: { role: string; error: unknown }[], resolved: string[] = []) {
    const db = fixture.db;
    const journal = new FactoryExecutionJournal(db, async () => {});
    const reconciler = new FactoryUsageReconciliation(db, TENANT, {
      readSettlementScopeInTransaction: async (_transaction, reservationId) => {
        const hold = held.get(reservationId);
        return hold && { projectId: PROJECT, runId: hold.runId, interpreterId: "root", reservationId, authority: hold.sealed };
      },
      clearResolvedStopInTransaction: async () => {},
    }, journal, { settleInTransaction: async () => {} }, new FactoryUsageSettlements(db, TENANT, new FactoryInbox(db, TENANT)));
    const budgets = new FactoryBudgets(db, TENANT, async () => {});
    const seen = { resolve: (hold: Parameters<typeof reconciler.resolve>[0], signal?: AbortSignal) => { resolved.push(hold.reservationId); return reconciler.resolve(hold, signal); }, reconcile: reconciler.reconcile.bind(reconciler) };
    return factoryUsageReconciliationDriver(db, budgets, seen, (role, error) => { reports.push({ role, error }); });
  }

  async function passes(count: number, reports: { role: string; error: unknown }[], role: { step(signal: AbortSignal): Promise<boolean> } = driver(reports)): Promise<void> {
    for (let pass = 0; pass < count; pass++) await role.step(new AbortController().signal);
  }

  const staleReports = (reports: readonly { role: string; error: unknown }[]) => reports.filter(report => report.role === "usage-reconciliation:fault:stale-reservation");
  const liveReports = (reports: readonly { role: string; error: unknown }[]) => reports.filter(report => report.role.endsWith(":live-reservation"));

  /** The operator signs a restore that moved the installation from `previous` to `next`, as FactoryRestore.sign does it. */
  async function signRestore(restoreId: string, previous: number, next: number) {
    const report = { schemaVersion: "factory.recovery-report.v1", tenantId: TENANT, installationId: "usage-epoch-installation", restoreId, mode: "tenant", checkpointId: "checkpoint-1", manifestDigest: FACTORY_TEST_DIGEST, previousEpoch: previous, executionEpoch: next, findings: [], blockedChecks: [], blockedRuns: [], blockedSubjects: [], releaseIdentities: { archived: 0, recovered: 0, blocked: 0 } } as unknown as FactoryRestoreReport;
    const digest = factoryRestoreReportDigest(report);
    await fixture.db.execute(sql`INSERT INTO factory_restore_epochs (tenant_id, restore_id, mode, checkpoint_id, manifest_digest, previous_epoch, execution_epoch, state, started_at_ms, opened_state_json, report_json, report_digest)
      VALUES (${TENANT}, ${restoreId}, 'tenant', 'checkpoint-1', ${FACTORY_TEST_DIGEST}, ${previous}, ${next}, 'awaiting_signature', 1, '{}', ${JSON.stringify(report)}, ${digest})`);
    await fixture.db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES ('usage-epoch-admin','usage-epoch@example.test','x','Usage Epoch','admin') ON CONFLICT (id) DO NOTHING`);
    const restore = new FactoryRestore({ database: fixture.db, tenantId: TENANT, installationId: "usage-epoch-installation", hostKeys: new Map(), providers: () => null } as never);
    const signed = await restore.sign(restoreId, { kind: "user", id: "usage-epoch-admin", authentication: "session" } as never, digest);
    return { signed, digest };
  }

  async function installationEpoch(): Promise<number> {
    return Number(releaseRows<{ execution_epoch: number | string }>(await fixture.db.execute(sql`SELECT execution_epoch FROM factory_installation WHERE tenant_id = ${TENANT}`))[0]!.execution_epoch);
  }

  beforeAll(async () => {
    fixture = await createFixture();
    await fixture.db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${PROJECT}, 'Usage Epoch', '/tmp/usage-epoch')`);
    await fixture.db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${TENANT}, 1)`);
    await fixture.db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${TENANT}, ${PROJECT})`);
  });

  afterAll(async () => { await fixture?.close(); });

  test("a hold left in an epoch a restore moved past is reported once, naming both epochs, and never retried until the epoch moves again", async () => {
    const stale = await holdIn("stale", 1);
    // A restore opens: the installation moves to the next epoch (FactoryRestore.openEpoch).
    await fixture.db.execute(sql`UPDATE factory_installation SET execution_epoch = 2 WHERE tenant_id = ${TENANT}`);
    const live = await holdIn("live", 2);

    const reports: { role: string; error: unknown }[] = [];
    await passes(3, reports);
    // A restarted process scans the same store.
    await passes(1, reports);

    const once = staleReports(reports);
    expect(once).toHaveLength(1);
    const error = once[0]!.error as Error & { code?: string };
    expect(error.name).toBe("FactoryUsageHoldEpochStaleError");
    expect(error.code).toBe("factory_usage_hold_epoch_stale");
    for (const fact of [stale.runId, stale.sealed.attemptId, stale.reservationId, "epoch 1", "epoch 2"]) expect(error.message).toContain(fact);
    // The live hold is backpressure: it is not ready and is retried every pass.
    expect(liveReports(reports).map(report => report.role)).toEqual(Array(4).fill(`usage-reconciliation:transient:${live.reservationId}`));
    // The stale hold still holds its money: the mark changes no state, it only stops the retries.
    // The mark must be a JSON object in the store, as the scan reads it, never a JSON string.
    const markOf = async () => releaseRows<{ state: string; mark_type: string; attempt_epoch: string; installation_epoch: string; attempt_id: string }>(await fixture.db.execute(sql`SELECT state, jsonb_typeof(epoch_stale_json) AS mark_type,
      epoch_stale_json->>'attemptEpoch' AS attempt_epoch, epoch_stale_json->>'installationEpoch' AS installation_epoch, epoch_stale_json->>'attemptId' AS attempt_id
      FROM factory_budget_reservations WHERE tenant_id = ${TENANT} AND reservation_id = ${stale.reservationId}`))[0]!;
    const row = await markOf();
    expect(row.state).toBe("uncertain");
    // The durable mark names the attempt and both epochs.
    expect(row).toMatchObject({ mark_type: "object", attempt_id: stale.sealed.attemptId, attempt_epoch: "1", installation_epoch: "2" });

    // The restore is signed: the run is rebound into the new epoch, but the
    // attempt's authority is still the old epoch's, so nothing changes for it.
    await fixture.db.execute(sql`UPDATE factory_runs SET execution_epoch = 2 WHERE tenant_id = ${TENANT} AND run_id = ${stale.runId}`);
    const afterSign: { role: string; error: unknown }[] = [];
    await passes(2, afterSign);
    expect(staleReports(afterSign)).toEqual([]);

    // A second restore moves the epoch again: the hold is looked at once more and reported once more.
    await fixture.db.execute(sql`UPDATE factory_installation SET execution_epoch = 3 WHERE tenant_id = ${TENANT}`);
    const again: { role: string; error: unknown }[] = [];
    await passes(3, again);
    const second = staleReports(again);
    expect(second).toHaveLength(1);
    for (const fact of ["epoch 1", "epoch 3"]) expect((second[0]!.error as Error).message).toContain(fact);
    expect(await markOf()).toMatchObject({ mark_type: "object", attempt_epoch: "1", installation_epoch: "3" });
  });

  test("the mark refuses a malformed epoch, time, or identity, and never marks a hold that is no longer uncertain", async () => {
    const budgets = new FactoryBudgets(fixture.db, TENANT, async () => {});
    const settled = await holdIn("settled", 3);
    const key = { projectId: PROJECT, runId: settled.runId, reservationId: settled.reservationId };
    const mark = { attemptId: settled.sealed.attemptId, attemptEpoch: 1, installationEpoch: 3, markedAtMs: 1 };
    const refused = async (change: Record<string, unknown>) => {
      await expect(fixture.db.transaction(transaction => budgets.markEpochStaleInTransaction(transaction, key, { ...mark, ...change } as typeof mark)))
        .rejects.toMatchObject({ code: "factory_budget_invalid" });
    };
    for (const change of [{ attemptEpoch: 0 }, { installationEpoch: 1.5 }, { markedAtMs: -1 }]) await refused(change);
    await expect(fixture.db.transaction(transaction => budgets.markEpochStaleInTransaction(transaction, { ...key, reservationId: "" }, mark))).rejects.toThrow();
    await fixture.db.execute(sql`UPDATE factory_budget_reservations SET state = 'settled' WHERE tenant_id = ${TENANT} AND reservation_id = ${settled.reservationId}`);
    expect(await fixture.db.transaction(transaction => budgets.markEpochStaleInTransaction(transaction, key, mark))).toBe("settled");
    const [row] = releaseRows<{ epoch_stale_json: unknown }>(await fixture.db.execute(sql`SELECT epoch_stale_json FROM factory_budget_reservations WHERE tenant_id = ${TENANT} AND reservation_id = ${settled.reservationId}`));
    expect(row?.epoch_stale_json).toBeNull();
  });

  test("a mark the scan cannot read is retried and reported, never skipped in silence", async () => {
    const unreadable = await holdIn("unreadable", 3);
    // A mark stored as a JSON string (what a text parameter can become on a real
    // server) that claims the epoch the installation is about to reach: read as
    // text it would hide the hold forever.
    await fixture.db.execute(sql`UPDATE factory_budget_reservations SET epoch_stale_json = to_jsonb(${JSON.stringify({ installationEpoch: 4 })}::text) WHERE tenant_id = ${TENANT} AND reservation_id = ${unreadable.reservationId}`);
    await fixture.db.execute(sql`UPDATE factory_installation SET execution_epoch = 4 WHERE tenant_id = ${TENANT}`);
    const reports: { role: string; error: unknown }[] = [];
    await passes(2, reports);
    expect(reports.filter(report => report.role === `usage-reconciliation:fault:${unreadable.reservationId}`)).toHaveLength(1);
    const [row] = releaseRows<{ mark_type: string; installation_epoch: string }>(await fixture.db.execute(sql`SELECT jsonb_typeof(epoch_stale_json) AS mark_type, epoch_stale_json->>'installationEpoch' AS installation_epoch FROM factory_budget_reservations WHERE tenant_id = ${TENANT} AND reservation_id = ${unreadable.reservationId}`));
    expect(row).toEqual({ mark_type: "object", installation_epoch: "4" });
  });

  test("a signed restore supersedes the old epoch's attempts, records the proof, tells the kernel, and offers the marked hold to settlement once the deadline passes", async () => {
    const [current] = releaseRows<{ execution_epoch: number | string }>(await fixture.db.execute(sql`SELECT execution_epoch FROM factory_installation WHERE tenant_id = ${TENANT}`));
    const previous = Number(current!.execution_epoch), next = previous + 1;
    const held = await holdIn("superseded", previous);
    // The dispatch queue row the attempt came from names its interpreter and reservation. It is stored as a
    // JSON string, as a real server holds the queue's reference, so both engines prove the supersession unwraps it.
    const reference = { attemptId: held.sealed.attemptId, reservationId: held.reservationId, command: { tenantId: TENANT, projectId: PROJECT, logicalRunId: held.runId, interpreterId: "superseded-interpreter", commandId: held.sealed.attemptId } };
    await fixture.db.execute(sql`INSERT INTO factory_attempt_queue (tenant_id, project_id, attempt_id, run_id, deduplication_id, input_hash, state, attempts, max_attempts, available_at, lease_until, reference_json)
      VALUES (${TENANT}, ${PROJECT}, ${held.sealed.attemptId}, ${held.runId}, ${`dedup-${held.sealed.attemptId}`}, ${FACTORY_TEST_DIGEST}, 'delivered', 1, 3, 0, 0, to_jsonb(${JSON.stringify(reference)}::text))`);
    // A restore opens: the installation moves on, and the hold is marked once.
    await fixture.db.execute(sql`UPDATE factory_installation SET execution_epoch = ${next} WHERE tenant_id = ${TENANT}`);
    const marking: { role: string; error: unknown }[] = [];
    await passes(1, marking);
    expect(marking.filter(report => report.role === `usage-reconciliation:fault:${held.reservationId}`)).toHaveLength(1);

    // The operator signs the restore.
    const restoreId = "restore-supersession";
    const { signed, digest } = await signRestore(restoreId, previous, next);
    expect(signed).toMatchObject({ enabled: true, superseded: expect.any(Number) });

    // The old attempt is terminal, superseded, with the signed restore as its proof.
    const [execution] = releaseRows<{ status: string }>(await fixture.db.execute(sql`SELECT status FROM factory_executions WHERE attempt_id = ${held.sealed.attemptId}`));
    expect(execution?.status).toBe("superseded");
    const [record] = releaseRows<{ reservation_id: string; interpreter_id: string; superseded_epoch: string | number; execution_epoch: string | number; restore_id: string; restore_digest: string; event_type: string; event_kind: string; event_uncertain: string }>(await fixture.db.execute(sql`SELECT reservation_id, interpreter_id, superseded_epoch, execution_epoch, restore_id, restore_digest,
      jsonb_typeof(event_json) AS event_type, event_json->>'kind' AS event_kind, event_json->>'uncertain' AS event_uncertain FROM factory_attempt_supersessions WHERE tenant_id = ${TENANT} AND attempt_id = ${held.sealed.attemptId}`));
    expect(record).toMatchObject({ reservation_id: held.reservationId, interpreter_id: "superseded-interpreter", restore_id: restoreId, restore_digest: digest, event_type: "object", event_kind: "attempt-stopped", event_uncertain: "true" });
    expect([Number(record!.superseded_epoch), Number(record!.execution_epoch)]).toEqual([previous, next]);
    // The kernel learns the attempt ended, in the same transaction.
    const inbox = releaseRows<{ event_id: string }>(await fixture.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE tenant_id = ${TENANT} AND run_id = ${held.runId} AND interpreter_id = 'superseded-interpreter'`));
    expect(inbox.map(row => row.event_id)).toEqual([`${restoreId}:${held.sealed.attemptId}:superseded`]);

    // Before the signed deadline the hold stays skipped; after it, the hold is offered to settlement every pass.
    const early: { role: string; error: unknown }[] = [], earlySeen: string[] = [];
    await passes(1, early, driver(early, earlySeen));
    expect(earlySeen).not.toContain(held.reservationId);
    await fixture.db.execute(sql`UPDATE factory_executions SET deadline_at = NOW() - INTERVAL '1 minute' WHERE attempt_id = ${held.sealed.attemptId}`);
    const late: { role: string; error: unknown }[] = [], lateSeen: string[] = [];
    await passes(2, late, driver(late, lateSeen));
    expect(lateSeen.filter(id => id === held.reservationId)).toHaveLength(2);
    // Until the bound settlement lands (W03f) it is backpressure, named, never a fault storm.
    const awaiting = late.filter(entry => entry.role.endsWith(`:${held.reservationId}`));
    expect(awaiting.map(entry => entry.role)).toEqual(Array(2).fill(`usage-reconciliation:transient:${held.reservationId}`));
    expect((awaiting[0]!.error as Error).name).toBe("FactoryUsageHoldAwaitingBoundError");
  });

  test("an attempt its dispatch named no interpreter for is superseded without a kernel event, and malformed inputs are refused", async () => {
    const [current] = releaseRows<{ execution_epoch: number | string }>(await fixture.db.execute(sql`SELECT execution_epoch FROM factory_installation WHERE tenant_id = ${TENANT}`));
    const epoch = Number(current!.execution_epoch);
    const bare = await holdIn("bare", epoch);
    const inbox = new FactoryInbox(fixture.db, TENANT);
    const input = { tenantId: TENANT, previousEpoch: epoch, executionEpoch: epoch + 1, restoreId: "restore-bare", restoreDigest: `sha256:${"b".repeat(64)}`, atMs: 5 };
    for (const change of [{ previousEpoch: 0 }, { executionEpoch: epoch }, { restoreDigest: "sha256:short" }, { atMs: -1 }]) {
      await expect(fixture.db.transaction(transaction => supersedeEpochAttemptsInTransaction(transaction, inbox, { ...input, ...change }))).rejects.toThrow("factory_supersession_invalid");
    }
    expect(await fixture.db.transaction(transaction => supersedeEpochAttemptsInTransaction(transaction, inbox, input))).toBeGreaterThanOrEqual(1);
    const [execution] = releaseRows<{ status: string }>(await fixture.db.execute(sql`SELECT status FROM factory_executions WHERE attempt_id = ${bare.sealed.attemptId}`));
    expect(execution?.status).toBe("superseded");
    const [record] = releaseRows<{ reservation_id: string | null; interpreter_id: string | null; event_json: unknown }>(await fixture.db.execute(sql`SELECT reservation_id, interpreter_id, event_json FROM factory_attempt_supersessions WHERE tenant_id = ${TENANT} AND attempt_id = ${bare.sealed.attemptId}`));
    expect(record).toEqual({ reservation_id: null, interpreter_id: null, event_json: null });
    // No reservation to find it by, and nothing to re-send.
    expect(await fixture.db.transaction(transaction => readAttemptSupersessionInTransaction(transaction, TENANT, bare.reservationId))).toBeUndefined();
    expect(await fixture.db.transaction(transaction => clearResolvedSupersessionInTransaction(transaction, inbox, TENANT, bare.reservationId, 6))).toBeUndefined();
    await expect(fixture.db.transaction(transaction => clearResolvedSupersessionInTransaction(transaction, inbox, TENANT, bare.reservationId, -1))).rejects.toThrow("factory_supersession_invalid");
    // A second pass finds nothing live to supersede.
    expect(await fixture.db.transaction(transaction => supersedeEpochAttemptsInTransaction(transaction, inbox, input))).toBe(0);
  });

  test("the superseded epoch's operations are read only with the supersession as proof, never for a live attempt", async () => {
    const previous = await installationEpoch(), next = previous + 1;
    const journaled = await holdIn("journaled", previous);
    const live = await holdIn("still-live", previous);
    // The old attempt journaled one model operation before the restore.
    const journal = new FactoryExecutionJournal(fixture.db, async () => {});
    const operation = { operationId: `${journaled.runId}:journaled-node:0:0`, operationIndex: 0, kind: "model" as const, requestDigest: "a".repeat(64) };
    await journal.prepare(journaled.sealed, operation);
    await journal.dispatch(journaled.sealed, operation.operationId);

    // Before any restore, a live attempt has no proof: refused by name.
    await expect(fixture.db.transaction(transaction => readSupersededOperationsInTransaction(transaction, TENANT, live.reservationId))).rejects.toBeInstanceOf(FactoryAttemptNotSupersededError);
    await expect(fixture.db.transaction(transaction => readSupersededOperationsInTransaction(transaction, TENANT, "no-such-reservation"))).rejects.toMatchObject({ code: "factory_attempt_not_superseded", reason: "no-supersession" });

    await fixture.db.execute(sql`UPDATE factory_installation SET execution_epoch = ${next} WHERE tenant_id = ${TENANT}`);
    const { digest } = await signRestore("restore-journaled", previous, next);
    // Record the attempt's reservation on its supersession, as a dispatch-queued attempt has it.
    await fixture.db.execute(sql`UPDATE factory_attempt_supersessions SET reservation_id = ${journaled.reservationId} WHERE tenant_id = ${TENANT} AND attempt_id = ${journaled.sealed.attemptId}`);

    const read = await fixture.db.transaction(transaction => readSupersededOperationsInTransaction(transaction, TENANT, journaled.reservationId));
    expect(read).toMatchObject({ attemptId: journaled.sealed.attemptId, supersededEpoch: previous, restoreDigest: digest, journalCursor: -1 });
    expect(read.operations).toEqual([expect.objectContaining({ operationId: operation.operationId, operationIndex: 0, kind: "model", state: "dispatched", requestDigest: operation.requestDigest })]);
    // The live journal read of the same attempt is still refused by the epoch fence.
    await expect(journal.operations(journaled.sealed)).rejects.toThrow("Factory run epoch is stale or unavailable.");

    // A record whose execution is no longer superseded is not proof.
    await fixture.db.execute(sql`UPDATE factory_executions SET status = 'running' WHERE attempt_id = ${journaled.sealed.attemptId}`);
    await expect(fixture.db.transaction(transaction => readSupersededOperationsInTransaction(transaction, TENANT, journaled.reservationId))).rejects.toMatchObject({ code: "factory_attempt_not_superseded", reason: "attempt-not-superseded" });
    await fixture.db.execute(sql`UPDATE factory_executions SET status = 'superseded' WHERE attempt_id = ${journaled.sealed.attemptId}`);
  });
}
