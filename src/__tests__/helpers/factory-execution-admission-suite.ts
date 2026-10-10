import { expect } from "bun:test";
import { sql } from "drizzle-orm";
import { factoryRunnerRequestIdentity } from "@ezcorp/factory-sdk/compiler";
import type { JsonValue } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows } from "../../db/queries/extension-releases";
import type { FactoryAttemptAdmission, FactoryExecutionJournal } from "../../factory/executions";

interface FactoryExecutionAdmissionFixture {
  readonly db: TransactionalDb;
  readonly journal: FactoryExecutionJournal;
  readonly admission: (input?: JsonValue) => FactoryAttemptAdmission;
  readonly foreignAuthority: FactoryAttemptAdmission;
}

/** Shared transactional admission proof for PGlite and real PostgreSQL. */
export async function verifyFactoryExecutionAdmission(fixture: FactoryExecutionAdmissionFixture): Promise<void> {
  const rollback = fixture.admission({ case: "rollback" });
  await expect(fixture.db.transaction(async transaction => {
    const durable = { ...rollback, request: JSON.parse(JSON.stringify(factoryRunnerRequestIdentity(rollback.request))) as ReturnType<typeof factoryRunnerRequestIdentity> };
    const admission = fixture.journal.admitDurableInTransaction(transaction, durable);
    if (durable.request.input.kind !== "inline" || typeof durable.request.input.value !== "object" || durable.request.input.value === null || Array.isArray(durable.request.input.value)) throw new Error("fixture request input is not an object");
    Object.assign(durable.request.input.value, { case: "mutated-after-call" });
    expect(await admission).toEqual({ requestHash: rollback.requestDigest, reused: false });
    expect(await fixture.journal.nextOperationIndexInTransaction(transaction, rollback)).toBe(0);
    throw new Error("attempt queue enqueue failed");
  })).rejects.toThrow("attempt queue enqueue failed");
  expect(releaseRows(await fixture.db.execute(sql`SELECT attempt_id FROM factory_executions WHERE attempt_id=${rollback.attemptId}`))).toHaveLength(0);
  expect(releaseRows(await fixture.db.execute(sql`SELECT tenant_id FROM factory_execution_operation_cursors WHERE tenant_id=${rollback.tenantId} AND project_id=${rollback.projectId} AND run_id=${rollback.runId} AND node_instance_id=${rollback.nodeInstanceId} AND candidate_generation=${rollback.candidateGeneration}`))).toHaveLength(0);

  const exact = fixture.admission({ case: "concurrent", order: [2, 1] });
  const retry = { ...exact, request: { ...exact.request, broker: { ...exact.request.broker, attemptToken: "fresh-retry-token" } } };
  const admitted = await Promise.all([fixture.journal.admit(exact), fixture.journal.admit(retry)]);
  expect(admitted.map(result => result.reused).sort()).toEqual([false, true]);
  expect(releaseRows(await fixture.db.execute(sql`SELECT attempt_id FROM factory_executions WHERE attempt_id=${exact.attemptId}`))).toHaveLength(1);
  expect(await fixture.journal.request(exact)).toEqual(factoryRunnerRequestIdentity(exact.request));
  expect(await fixture.db.transaction(transaction => fixture.journal.requestInTransaction(transaction, exact))).toEqual(factoryRunnerRequestIdentity(exact.request));
  expect(await fixture.db.transaction(transaction => fixture.journal.admitDurableInTransaction(transaction, { ...exact, request: factoryRunnerRequestIdentity(exact.request) }))).toEqual({ requestHash: exact.requestDigest, reused: true });
  expect(await fixture.db.transaction(transaction => fixture.journal.nextOperationIndexInTransaction(transaction, exact))).toBe(0);

  const changed = fixture.admission({ case: "changed" });
  await expect(fixture.journal.admit(changed)).rejects.toThrow("conflicts with a different canonical request");
  await expect(fixture.journal.request({ ...exact, requestDigest: "f".repeat(64) })).rejects.toThrow("stale, cancelled, or expired");
  await expect(fixture.journal.request(fixture.foreignAuthority)).rejects.toThrow("epoch is stale");

  await fixture.db.execute(sql`UPDATE factory_executions SET request_json=${JSON.stringify({ corrupt: true })}::jsonb WHERE attempt_id=${exact.attemptId}`);
  await expect(fixture.journal.admit(retry)).rejects.toThrow("conflicts with a different canonical request");
  await expect(fixture.journal.request(exact)).rejects.toThrow("durable runner request is corrupt");
}
