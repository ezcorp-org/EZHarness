import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@ezcorp/extension-contract";

export type FactoryOperationState = "prepared" | "dispatched" | "completed" | "failed" | "uncertain";

export interface FactoryAttemptAuthority {
  attemptId: string;
  tenantId: string;
  projectId: string;
  runId: string;
  nodeInstanceId: string;
  candidateGeneration: number;
  attemptNumber: number;
  grantRevision: number;
  reservationGeneration: number;
  executionEpoch: number;
  deadlineAt: Date;
}

export interface FactoryAttemptAdmission extends FactoryAttemptAuthority {
  request: unknown;
}

export interface FactoryJournalOperation {
  operationId: string;
  operationIndex: number;
  kind: "model" | "tool";
  requestDigest: string;
}

export interface FactoryOperationSettlement {
  providerReceiptDigest?: string;
  resultDigest?: string;
  usage?: unknown;
  workspaceCheckpoint?: unknown;
}

type SqlResult = { rows?: unknown[] };
interface SqlDb {
  execute(query: ReturnType<typeof sql>): Promise<SqlResult>;
  transaction?<T>(work: (transaction: SqlDb) => Promise<T>): Promise<T>;
}

function hashJson(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertAuthority(value: FactoryAttemptAuthority): void {
  const counters = [value.candidateGeneration, value.attemptNumber, value.grantRevision, value.reservationGeneration, value.executionEpoch];
  if (!value.attemptId || !value.tenantId || !value.projectId || !value.runId || !value.nodeInstanceId || counters.some(counter => !Number.isSafeInteger(counter) || counter < 0) || !(value.deadlineAt instanceof Date) || !Number.isFinite(value.deadlineAt.getTime()) || value.deadlineAt.getTime() <= Date.now()) {
    throw new Error("Factory attempt authority is incomplete, stale, or expired.");
  }
}

function assertOperation(authority: FactoryAttemptAuthority, operation: FactoryJournalOperation): void {
  if (!Number.isSafeInteger(operation.operationIndex) || operation.operationIndex < 0 || !/^[a-f0-9]{64}$/.test(operation.requestDigest)) throw new Error("Factory operation is malformed.");
  const expected = `${authority.runId}:${authority.nodeInstanceId}:${authority.candidateGeneration}:${operation.operationIndex}`;
  if (operation.operationId !== expected) throw new Error("Factory operation id does not match its attempt identity.");
}

async function withinTransaction<T>(database: SqlDb, work: (transaction: SqlDb) => Promise<T>): Promise<T> {
  return database.transaction ? database.transaction(work) : work(database);
}

/** Durable C02 journal; the gateway authenticates and supplies its authority. */
export class FactoryExecutionJournal {
  constructor(private readonly db: SqlDb) {}

  async admit(input: FactoryAttemptAdmission): Promise<{ requestHash: string; reused: boolean }> {
    assertAuthority(input);
    const requestJson = canonicalJson(input.request);
    const requestHash = hashJson(requestJson);
    return withinTransaction(this.db, async (database) => {
      const existing = await database.execute(sql`SELECT request_hash AS "requestHash" FROM factory_executions WHERE attempt_id=${input.attemptId}`);
      const prior = existing.rows?.[0] as { requestHash?: string } | undefined;
      if (prior) {
        if (prior.requestHash !== requestHash) throw new Error("Factory attempt id conflicts with a different canonical request.");
        return { requestHash, reused: true };
      }
      await database.execute(sql`INSERT INTO factory_tenants(tenant_id) VALUES (${input.tenantId}) ON CONFLICT (tenant_id) DO NOTHING`);
      const project = await database.execute(sql`INSERT INTO factory_project_scopes(tenant_id, project_id) SELECT ${input.tenantId}, id FROM projects WHERE id=${input.projectId} ON CONFLICT DO NOTHING RETURNING project_id`);
      if (!project.rows?.length) {
        const scope = await database.execute(sql`SELECT project_id FROM factory_project_scopes WHERE tenant_id=${input.tenantId} AND project_id=${input.projectId}`);
        if (!scope.rows?.length) throw new Error("Factory attempt project does not exist.");
      }
      const run = await database.execute(sql`INSERT INTO factory_run_scopes(tenant_id, project_id, run_id) SELECT ${input.tenantId}, ${input.projectId}, id FROM runs WHERE id=${input.runId} AND project_id=${input.projectId} ON CONFLICT DO NOTHING RETURNING run_id`);
      if (!run.rows?.length) {
        const scope = await database.execute(sql`SELECT run_id FROM factory_run_scopes WHERE tenant_id=${input.tenantId} AND project_id=${input.projectId} AND run_id=${input.runId}`);
        if (!scope.rows?.length) throw new Error("Factory attempt run is not in its project.");
      }
      const inserted = await database.execute(sql`INSERT INTO factory_executions(attempt_id, tenant_id, project_id, run_id, node_instance_id, candidate_generation, attempt_number, grant_revision, reservation_generation, execution_epoch, deadline_at, request_hash, request_json, status) VALUES (${input.attemptId}, ${input.tenantId}, ${input.projectId}, ${input.runId}, ${input.nodeInstanceId}, ${input.candidateGeneration}, ${input.attemptNumber}, ${input.grantRevision}, ${input.reservationGeneration}, ${input.executionEpoch}, ${input.deadlineAt}, ${requestHash}, ${requestJson}::jsonb, 'admitted') ON CONFLICT (attempt_id) DO NOTHING RETURNING request_hash AS "requestHash"`);
      if (inserted.rows?.length) return { requestHash, reused: false };
      const raced = await database.execute(sql`SELECT request_hash AS "requestHash" FROM factory_executions WHERE attempt_id=${input.attemptId}`);
      const row = raced.rows?.[0] as { requestHash?: string } | undefined;
      if (row?.requestHash === requestHash) return { requestHash, reused: true };
      throw new Error("Factory attempt admission did not persist.");
    });
  }

  async prepare(authority: FactoryAttemptAuthority, operation: FactoryJournalOperation): Promise<void> {
    assertAuthority(authority);
    assertOperation(authority, operation);
    await withinTransaction(this.db, async (database) => {
      await this.lockLive(database, authority);
      await database.execute(sql`INSERT INTO factory_execution_operations(attempt_id, operation_id, operation_index, kind, state, request_digest) VALUES (${authority.attemptId}, ${operation.operationId}, ${operation.operationIndex}, ${operation.kind}, 'prepared', ${operation.requestDigest}) ON CONFLICT (attempt_id, operation_id) DO NOTHING`);
      const stored = await database.execute(sql`SELECT operation_index AS "operationIndex", kind, state, request_digest AS "requestDigest" FROM factory_execution_operations WHERE attempt_id=${authority.attemptId} AND operation_id=${operation.operationId}`);
      const row = stored.rows?.[0] as { operationIndex?: number; kind?: string; state?: string; requestDigest?: string } | undefined;
      if (row?.operationIndex !== operation.operationIndex || row.kind !== operation.kind || row.requestDigest !== operation.requestDigest || row.state !== "prepared") throw new Error("Factory operation conflicts with its durable journal entry.");
    });
  }

  async dispatch(authority: FactoryAttemptAuthority, operationId: string): Promise<void> {
    assertAuthority(authority);
    await withinTransaction(this.db, async (database) => {
      await this.lockLive(database, authority);
      const updated = await database.execute(sql`UPDATE factory_execution_operations SET state='dispatched', updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId} AND state='prepared' RETURNING operation_id`);
      if (updated.rows?.length) {
        await database.execute(sql`UPDATE factory_executions SET status='running', updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND status='admitted'`);
        return;
      }
      const existing = await database.execute(sql`SELECT state FROM factory_execution_operations WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId}`);
      if ((existing.rows?.[0] as { state?: string } | undefined)?.state !== "dispatched") throw new Error("Factory operation is not prepared for dispatch.");
    });
  }

  async settle(authority: FactoryAttemptAuthority, operationId: string, state: Extract<FactoryOperationState, "completed" | "failed" | "uncertain">, result: FactoryOperationSettlement): Promise<void> {
    assertAuthority(authority);
    if (state === "completed" && (!result.resultDigest || result.usage === undefined || result.workspaceCheckpoint === undefined)) throw new Error("A completed factory operation needs result, usage, and workspace checkpoint evidence.");
    if (state === "failed" && !result.resultDigest) throw new Error("A failed factory operation needs a result digest.");
    await withinTransaction(this.db, async (database) => {
      await this.lockLive(database, authority);
      const updated = await database.execute(sql`UPDATE factory_execution_operations SET state=${state}, provider_receipt_digest=${result.providerReceiptDigest ?? null}, result_digest=${result.resultDigest ?? null}, usage_json=${result.usage === undefined ? null : canonicalJson(result.usage)}::jsonb, workspace_checkpoint=${result.workspaceCheckpoint === undefined ? null : canonicalJson(result.workspaceCheckpoint)}::jsonb, updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId} AND state='dispatched' RETURNING operation_index AS "operationIndex"`);
      const operation = updated.rows?.[0] as { operationIndex?: number } | undefined;
      if (!operation || !Number.isSafeInteger(operation.operationIndex)) throw new Error("Factory operation cannot settle from its current state.");
      await database.execute(sql`UPDATE factory_executions SET journal_cursor=GREATEST(journal_cursor, ${operation.operationIndex}), updated_at=NOW() WHERE attempt_id=${authority.attemptId}`);
    });
  }

  /** Record a late receipt for reconciliation without advancing the run cursor. */
  async reconcileLate(authority: FactoryAttemptAuthority, operationId: string, providerReceiptDigest: string): Promise<void> {
    assertAuthority(authority);
    if (!providerReceiptDigest) throw new Error("Late factory receipts need a digest.");
    const updated = await this.db.execute(sql`UPDATE factory_execution_operations SET state='uncertain', provider_receipt_digest=${providerReceiptDigest}, updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId} AND state='dispatched' AND EXISTS (SELECT 1 FROM factory_executions WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch}) RETURNING operation_id`);
    if (!updated.rows?.length) throw new Error("Late factory receipt does not match a dispatched operation.");
  }

  async cancel(authority: FactoryAttemptAuthority): Promise<boolean> {
    assertAuthority(authority);
    const updated = await this.db.execute(sql`UPDATE factory_executions SET status='cancel_accepted', cancel_accepted_at=COALESCE(cancel_accepted_at, NOW()), updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch} AND deadline_at > NOW() AND status IN ('admitted', 'running') RETURNING attempt_id`);
    return Boolean(updated.rows?.length);
  }

  async confirmStopped(authority: FactoryAttemptAuthority): Promise<boolean> {
    assertAuthority(authority);
    const updated = await this.db.execute(sql`UPDATE factory_executions SET status='stopped', stopped_at=COALESCE(stopped_at, NOW()), updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch} AND deadline_at > NOW() AND status='cancel_accepted' RETURNING attempt_id`);
    return Boolean(updated.rows?.length);
  }

  async status(authority: FactoryAttemptAuthority): Promise<{ status: string; journalCursor: number; cancelAcceptedAt: Date | null; stoppedAt: Date | null }> {
    assertAuthority(authority);
    const result = await this.db.execute(sql`SELECT status, journal_cursor AS "journalCursor", cancel_accepted_at AS "cancelAcceptedAt", stopped_at AS "stoppedAt" FROM factory_executions WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch}`);
    const row = result.rows?.[0] as { status?: string; journalCursor?: number; cancelAcceptedAt?: Date | null; stoppedAt?: Date | null } | undefined;
    if (!row?.status || typeof row.journalCursor !== "number" || !Number.isSafeInteger(row.journalCursor)) throw new Error("Factory attempt is unavailable to this tenant.");
    return { status: row.status, journalCursor: row.journalCursor, cancelAcceptedAt: row.cancelAcceptedAt ?? null, stoppedAt: row.stoppedAt ?? null };
  }

  private async lockLive(database: SqlDb, authority: FactoryAttemptAuthority): Promise<void> {
    const locked = await database.execute(sql`UPDATE factory_executions SET updated_at=updated_at WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch} AND deadline_at > NOW() AND status IN ('admitted', 'running') RETURNING attempt_id`);
    if (!locked.rows?.length) throw new Error("Factory attempt is stale, cancelled, or expired.");
  }
}
