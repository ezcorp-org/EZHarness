import { expect } from "bun:test";
import { sql } from "drizzle-orm";
import type { FactoryRunnerRequest, JsonValue } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest, factoryRunnerRequestIdentity } from "@ezcorp/factory-sdk/compiler";
import type { MigrateDb, TransactionalDb } from "../../db/migrations/types";
import { migrate } from "../../db/migrate";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { FactoryAttemptQueue } from "../../factory/attempt-queue";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../factory/executions";
import { FactoryGrantError } from "../../factory/grants";

export interface AttemptQueueFixture { readonly db: MigrateDb & TransactionalDb; readonly migrated?: boolean; close(): Promise<void> }

function runnerRequest(authority: FactoryAttemptAuthority, input: JsonValue): FactoryRunnerRequest {
  return { schemaVersion: "factory.runner.request.v1", authority: { attemptId: authority.attemptId, tenantId: authority.tenantId, projectId: authority.projectId, runId: authority.runId, nodeInstanceId: authority.nodeInstanceId, candidateGeneration: authority.candidateGeneration, attemptNumber: authority.attemptNumber, grantRevision: authority.grantRevision, reservationGeneration: authority.reservationGeneration, executionEpoch: authority.executionEpoch, cancellationEpoch: authority.cancellationEpoch, deadlineAtMs: authority.deadlineAt.getTime(), nextOperationIndex: 0 }, runner: { package: "runner", version: "1", digest: `sha256:${"a".repeat(64)}`, export: "run" }, input: { kind: "inline", value: input }, grants: [], resources: {}, tools: [], broker: { attemptToken: `token-${authority.attemptId}`, audience: "factory-gateway" } };
}

/** Shared durable attempt queue proof for PGlite and real PostgreSQL. */
export async function verifyFactoryAttemptQueue(createFixture: () => Promise<AttemptQueueFixture>): Promise<void> {
  const fixture = await createFixture();
  let now = Date.now();
  const revoked = new Set<string>();
  const infrastructureFailures = new Set<string>();

  function admission(attemptId: string, input: JsonValue = { attemptId }) {
    const authority: FactoryAttemptAuthority = { attemptId, tenantId: "attempt-tenant", projectId: "attempt-project", runId: "attempt-run", nodeInstanceId: `node-${attemptId}`, candidateGeneration: 1, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, requestDigest: "a".repeat(64), deadlineAt: new Date(now + 60_000) };
    const request = runnerRequest(authority, input);
    return { ...authority, requestDigest: factoryRunnerRequestDigest(request), request };
  }

  try {
    if (!fixture.migrated) await migrate(fixture.db);
    await fixture.db.execute(sql`INSERT INTO projects(id,name,path) VALUES ('attempt-project','Attempts','/tmp/attempts')`);
    await fixture.db.execute(sql`INSERT INTO factory_installation(singleton,tenant_id,execution_epoch) VALUES (1,'attempt-tenant',1)`);
    await fixture.db.execute(sql`INSERT INTO factory_projects(tenant_id,project_id) VALUES ('attempt-tenant','attempt-project')`);
    await fixture.db.execute(sql`INSERT INTO factory_runs(tenant_id,project_id,run_id,definition_digest,interpreter_build,execution_epoch,request_digest,request_payload) VALUES ('attempt-tenant','attempt-project','attempt-run',${`sha256:${"b".repeat(64)}`},'attempt-test',1,'run-request','{}')`);
    const journal = new FactoryExecutionJournal(fixture.db, async (_transaction, authority) => {
      if (infrastructureFailures.has(authority.attemptId)) throw new Error("database unavailable");
      if (revoked.has(authority.attemptId)) throw new FactoryGrantError("factory_grant_stale");
    }, () => new Date(now));
    const queue = new FactoryAttemptQueue(fixture.db, journal, "attempt-tenant", () => now);

    const rollback = admission("rollback-attempt", { immutable: true });
    await expect(fixture.db.transaction(async transaction => {
      await queue.enqueueInTransaction(transaction, rollback);
      throw new Error("attempt enqueue failed");
    })).rejects.toThrow("attempt enqueue failed");
    expect(rows(await fixture.db.execute(sql`SELECT attempt_id FROM factory_executions WHERE attempt_id=${rollback.attemptId}`))).toHaveLength(0);
    expect(rows(await fixture.db.execute(sql`SELECT attempt_id FROM factory_attempt_queue WHERE attempt_id=${rollback.attemptId}`))).toHaveLength(0);
    expect((await queue.enqueue(rollback)).state).toBe("queued");
    const retry = { ...rollback, request: { ...rollback.request, broker: { ...rollback.request.broker, attemptToken: "fresh-token" } } };
    expect((await queue.enqueue(retry)).id).toBe(rollback.attemptId);
    const changedRequest = runnerRequest(rollback, { immutable: false });
    await expect(queue.enqueue({ ...rollback, request: changedRequest, requestDigest: factoryRunnerRequestDigest(changedRequest) })).rejects.toThrow("conflicts with a different canonical request");
    const stored = rows<{ reference: string }>(await fixture.db.execute(sql`SELECT reference_json::text AS reference FROM factory_attempt_queue WHERE attempt_id=${rollback.attemptId}`))[0]?.reference ?? "";
    expect(stored).not.toContain("fresh-token");
    expect(stored).not.toContain("immutable");
    const admitted = await queue.claim();
    expect(admitted?.delivery.id).toBe(rollback.attemptId);
    if (!admitted) throw new Error("Expected the admitted rollback attempt.");
    await queue.settle(admitted, "delivered");

    const concurrent = admission("concurrent-attempt", { stable: [2, 1] });
    await queue.enqueue(concurrent);
    const claims = await Promise.all([queue.claim(100), queue.claim(100)]);
    const claim = claims.find(value => value !== null);
    expect(claims.filter(value => value !== null)).toHaveLength(1);
    expect(claim?.request).toEqual(factoryRunnerRequestIdentity(concurrent.request));
    expect(await queue.claim(100)).toBeNull();
    if (!claim) throw new Error("Expected one factory attempt claim.");
    expect((await queue.settle(claim, "retry", "pre_execution_unavailable")).state).toBe("queued");
    await expect(queue.settle(claim, "delivered")).rejects.toMatchObject({ code: "delivery_lease_lost" });
    now += 1_000;
    const retried = await queue.claim(100);
    expect(retried?.delivery.attempts).toBe(2);
    if (!retried) throw new Error("Expected the known pre-execution retry.");
    expect((await queue.settle(retried, "delivered")).state).toBe("delivered");

    const expired = admission("a-expired-attempt");
    const healthyAfterExpiry = admission("z-healthy-after-expiry");
    await queue.enqueue(expired);
    const original = await queue.claim(100);
    expect(original?.delivery.id).toBe(expired.attemptId);
    await queue.enqueue(healthyAfterExpiry);
    now += 101;
    const restarted = new FactoryAttemptQueue(fixture.db, journal, "attempt-tenant", () => now);
    const next = await restarted.claim(100);
    expect(next?.delivery.id).toBe(healthyAfterExpiry.attemptId);
    expect(await restarted.read("attempt-project", expired.attemptId)).toMatchObject({ state: "outcome_unknown", failureCode: "worker_lease_expired", attempts: 1 });
    if (!original || !next) throw new Error("Expected both attempt claims.");
    await expect(restarted.settle(original, "delivered")).rejects.toMatchObject({ code: "delivery_lease_lost" });
    expect((await restarted.settle(next, "outcome_unknown", "runner_receipt_lost")).state).toBe("outcome_unknown");

    const corrupt = admission("a-corrupt-attempt");
    const denied = admission("b-revoked-attempt");
    const cancelled = admission("c-cancelled-attempt");
    const healthy = admission("z-healthy-attempt");
    for (const input of [corrupt, denied, cancelled, healthy]) await queue.enqueue(input);
    await fixture.db.execute(sql`UPDATE factory_attempt_queue SET reference_json='{}'::jsonb WHERE attempt_id=${corrupt.attemptId}`);
    revoked.add(denied.attemptId);
    expect(await journal.cancel(cancelled)).toBe(true);
    const healthyClaim = await queue.claim(100);
    expect(healthyClaim?.delivery.id).toBe(healthy.attemptId);
    expect(rows<{ state: string; failure_code: string }>(await fixture.db.execute(sql`SELECT state,failure_code FROM factory_attempt_queue WHERE attempt_id=${corrupt.attemptId}`))[0]).toEqual({ state: "outcome_unknown", failure_code: "queue_record_corrupt" });
    expect(await queue.read("attempt-project", denied.attemptId)).toMatchObject({ state: "cancelled", failureCode: "authority_rejected" });
    expect(await queue.read("attempt-project", cancelled.attemptId)).toMatchObject({ state: "cancelled", failureCode: "authority_rejected" });
    if (!healthyClaim) throw new Error("Expected healthy work after rejected candidates.");
    await queue.settle(healthyClaim, "delivered");

    const unavailable = admission("infrastructure-failure-attempt");
    await queue.enqueue(unavailable);
    infrastructureFailures.add(unavailable.attemptId);
    await expect(queue.claim()).rejects.toThrow("database unavailable");
    expect(await queue.read("attempt-project", unavailable.attemptId)).toMatchObject({ state: "queued", attempts: 0 });
    infrastructureFailures.delete(unavailable.attemptId);

    expect(await new FactoryAttemptQueue(fixture.db, journal, "foreign-tenant", () => now).read("attempt-project", rollback.attemptId)).toBeNull();
    await expect(new FactoryAttemptQueue(fixture.db, journal, "foreign-tenant", () => now).enqueue(admission("foreign-enqueue"))).rejects.toMatchObject({ code: "factory_attempt_scope_mismatch" });
    await expect(queue.read("", "attempt")).rejects.toMatchObject({ code: "factory_attempt_identity_invalid" });
  } finally {
    await fixture.close();
  }
}
