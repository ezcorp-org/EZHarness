import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import type { MigrateDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows } from "../../db/queries/extension-releases";
import { FactoryBudgets } from "../../factory/budgets";
import { factoryUsageReconciliationDriver } from "../../factory/dispatch-composition";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../factory/executions";
import { FactoryInbox } from "../../factory/inbox";
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
  function driver(reports: { role: string; error: unknown }[]) {
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
    return factoryUsageReconciliationDriver(db, budgets, reconciler, (role, error) => { reports.push({ role, error }); });
  }

  async function passes(count: number, reports: { role: string; error: unknown }[], role = driver(reports)): Promise<void> {
    for (let pass = 0; pass < count; pass++) await role.step(new AbortController().signal);
  }

  const staleReports = (reports: readonly { role: string; error: unknown }[]) => reports.filter(report => report.role === "usage-reconciliation:fault:stale-reservation");
  const liveReports = (reports: readonly { role: string; error: unknown }[]) => reports.filter(report => report.role.endsWith(":live-reservation"));

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
    expect(await fixture.db.transaction(transaction => budgets.markEpochStaleInTransaction(transaction, key, mark))).toBe(false);
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
}
