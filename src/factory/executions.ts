import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows } from "../db/queries/extension-releases";

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

function hashJson(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertIdentity(value: FactoryAttemptAuthority): void {
  const counters = [value.candidateGeneration, value.attemptNumber, value.grantRevision, value.reservationGeneration, value.executionEpoch];
  if (!value.attemptId || !value.tenantId || !value.projectId || !value.runId || !value.nodeInstanceId || counters.some(counter => !Number.isSafeInteger(counter) || counter < 0) || !(value.deadlineAt instanceof Date) || !Number.isFinite(value.deadlineAt.getTime())) {
    throw new Error("Factory attempt authority is incomplete.");
  }
}

function assertOperation(authority: FactoryAttemptAuthority, operation: FactoryJournalOperation): void {
  if (!Number.isSafeInteger(operation.operationIndex) || operation.operationIndex < 0 || !/^[a-f0-9]{64}$/.test(operation.requestDigest)) throw new Error("Factory operation is malformed.");
  const expected = `${authority.runId}:${authority.nodeInstanceId}:${authority.candidateGeneration}:${operation.operationIndex}`;
  if (operation.operationId !== expected) throw new Error("Factory operation id does not match its attempt identity.");
}

/** Durable C02 journal; the gateway authenticates and supplies its authority. */
export class FactoryExecutionJournal {
  constructor(private readonly db: TransactionalDb, private readonly now: () => Date = () => new Date()) {}

  async admit(input: FactoryAttemptAdmission): Promise<{ requestHash: string; reused: boolean }> {
    this.assertLiveInput(input);
    const requestJson = canonicalJson({ authority: this.authorityDigest(input), request: input.request });
    const requestHash = hashJson(requestJson);
    return this.db.transaction(async (database) => {
      await this.lockRunFence(database, input);
      const prior = releaseRows<{ request_hash: string }>(await database.execute(sql`SELECT request_hash FROM factory_executions WHERE attempt_id=${input.attemptId}`))[0];
      if (prior) {
        if (prior.request_hash !== requestHash) throw new Error("Factory attempt id conflicts with a different canonical request.");
        return { requestHash, reused: true };
      }
      await database.execute(sql`INSERT INTO factory_execution_operation_cursors(tenant_id, project_id, run_id, node_instance_id, candidate_generation) VALUES (${input.tenantId}, ${input.projectId}, ${input.runId}, ${input.nodeInstanceId}, ${input.candidateGeneration}) ON CONFLICT DO NOTHING`);
      const cursor = releaseRows<{ next_operation_index: number | string }>(await database.execute(sql`SELECT next_operation_index FROM factory_execution_operation_cursors WHERE tenant_id=${input.tenantId} AND project_id=${input.projectId} AND run_id=${input.runId} AND node_instance_id=${input.nodeInstanceId} AND candidate_generation=${input.candidateGeneration} FOR UPDATE`))[0];
      const initialIndex = Number(cursor?.next_operation_index);
      if (!Number.isSafeInteger(initialIndex) || initialIndex < 0) throw new Error("Factory operation cursor is invalid.");
      const inserted = releaseRows(await database.execute(sql`INSERT INTO factory_executions(attempt_id, tenant_id, project_id, run_id, node_instance_id, candidate_generation, attempt_number, grant_revision, reservation_generation, execution_epoch, deadline_at, request_hash, request_json, operation_initial_index, status) VALUES (${input.attemptId}, ${input.tenantId}, ${input.projectId}, ${input.runId}, ${input.nodeInstanceId}, ${input.candidateGeneration}, ${input.attemptNumber}, ${input.grantRevision}, ${input.reservationGeneration}, ${input.executionEpoch}, ${input.deadlineAt}, ${requestHash}, ${requestJson}::jsonb, ${initialIndex}, 'admitted') ON CONFLICT (attempt_id) DO NOTHING RETURNING attempt_id`));
      if (inserted.length) return { requestHash, reused: false };
      const raced = releaseRows<{ request_hash: string }>(await database.execute(sql`SELECT request_hash FROM factory_executions WHERE attempt_id=${input.attemptId}`))[0];
      if (raced?.request_hash === requestHash) return { requestHash, reused: true };
      throw new Error("Factory attempt admission did not persist.");
    });
  }

  async prepare(authority: FactoryAttemptAuthority, operation: FactoryJournalOperation): Promise<void> {
    this.assertLiveInput(authority);
    assertOperation(authority, operation);
    return this.db.transaction(async (database) => {
      await this.lockLive(database, authority);
      const existing = releaseRows<{ operation_index: number; kind: string; state: string; request_digest: string }>(await database.execute(sql`SELECT operation_index, kind, state, request_digest FROM factory_execution_operations WHERE attempt_id=${authority.attemptId} AND operation_id=${operation.operationId}`))[0];
      if (existing) {
        if (Number(existing.operation_index) !== operation.operationIndex || existing.kind !== operation.kind || existing.request_digest !== operation.requestDigest || existing.state !== "prepared") throw new Error("Factory operation conflicts with its durable journal entry.");
        return;
      }
      const execution = releaseRows<{ operation_initial_index: number | string }>(await database.execute(sql`SELECT operation_initial_index FROM factory_executions WHERE attempt_id=${authority.attemptId} FOR UPDATE`))[0];
      const cursor = releaseRows<{ next_operation_index: number | string }>(await database.execute(sql`SELECT next_operation_index FROM factory_execution_operation_cursors WHERE tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} FOR UPDATE`))[0];
      const initialIndex = Number(execution?.operation_initial_index);
      const nextIndex = Number(cursor?.next_operation_index);
      if (!Number.isSafeInteger(initialIndex) || !Number.isSafeInteger(nextIndex) || operation.operationIndex < initialIndex || operation.operationIndex !== nextIndex) throw new Error("Factory operation index is not contiguous.");
      await database.execute(sql`INSERT INTO factory_execution_operations(attempt_id, operation_id, operation_index, kind, state, request_digest) VALUES (${authority.attemptId}, ${operation.operationId}, ${operation.operationIndex}, ${operation.kind}, 'prepared', ${operation.requestDigest})`);
      await database.execute(sql`UPDATE factory_execution_operation_cursors SET next_operation_index=${nextIndex + 1} WHERE tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration}`);
    });
  }

  /** `claimed` is true exactly once; callers must not repeat an external effect otherwise. */
  async dispatch(authority: FactoryAttemptAuthority, operationId: string): Promise<{ claimed: boolean }> {
    this.assertLiveInput(authority);
    return this.db.transaction(async (database) => {
      await this.lockLive(database, authority);
      const updated = releaseRows(await database.execute(sql`UPDATE factory_execution_operations SET state='dispatched', updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId} AND state='prepared' RETURNING operation_id`));
      if (updated.length) {
        await database.execute(sql`UPDATE factory_executions SET status='running', updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND status='admitted'`);
        return { claimed: true };
      }
      const existing = releaseRows<{ state: string }>(await database.execute(sql`SELECT state FROM factory_execution_operations WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId}`))[0];
      if (existing?.state !== "dispatched") throw new Error("Factory operation is not prepared for dispatch.");
      return { claimed: false };
    });
  }

  async settle(authority: FactoryAttemptAuthority, operationId: string, state: Extract<FactoryOperationState, "completed" | "failed" | "uncertain">, result: FactoryOperationSettlement): Promise<void> {
    this.assertLiveInput(authority);
    if (state === "completed" && (!result.resultDigest || result.usage === undefined || result.workspaceCheckpoint === undefined)) throw new Error("A completed factory operation needs result, usage, and workspace checkpoint evidence.");
    if (state === "failed" && !result.resultDigest) throw new Error("A failed factory operation needs a result digest.");
    await this.db.transaction(async (database) => {
      await this.lockLive(database, authority);
      const operation = releaseRows<{ operation_index: number }>(await database.execute(sql`UPDATE factory_execution_operations SET state=${state}, provider_receipt_digest=${result.providerReceiptDigest ?? null}, result_digest=${result.resultDigest ?? null}, usage_json=${result.usage === undefined ? null : canonicalJson(result.usage)}::jsonb, workspace_checkpoint=${result.workspaceCheckpoint === undefined ? null : canonicalJson(result.workspaceCheckpoint)}::jsonb, updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId} AND state='dispatched' RETURNING operation_index`))[0];
      if (!operation || !Number.isSafeInteger(Number(operation.operation_index))) {
        const existing = releaseRows<{ state: FactoryOperationState; provider_receipt_digest: string | null; result_digest: string | null; usage_json: unknown; workspace_checkpoint: unknown }>(await database.execute(sql`SELECT state, provider_receipt_digest, result_digest, usage_json, workspace_checkpoint FROM factory_execution_operations WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId}`))[0];
        if (!existing || !this.sameEvidence(existing, state, result)) throw new Error("Factory operation cannot settle from its current state.");
        return;
      }
      await database.execute(sql`UPDATE factory_executions SET journal_cursor = COALESCE((SELECT MIN(operation_index) - 1 FROM factory_execution_operations WHERE attempt_id=${authority.attemptId} AND state IN ('prepared', 'dispatched')), (SELECT COALESCE(MAX(operation_index), -1) FROM factory_execution_operations WHERE attempt_id=${authority.attemptId})), updated_at=NOW() WHERE attempt_id=${authority.attemptId}`);
    });
  }

  /** Record a late receipt for reconciliation without advancing the run cursor. */
  async reconcileLate(authority: FactoryAttemptAuthority, operationId: string, result: FactoryOperationSettlement): Promise<void> {
    assertIdentity(authority);
    if (!result.providerReceiptDigest) throw new Error("Late factory receipts need a digest.");
    await this.db.transaction(async (database) => {
      await this.lockRunFence(database, authority);
      const updated = releaseRows(await database.execute(sql`UPDATE factory_execution_operations SET state='uncertain', provider_receipt_digest=${result.providerReceiptDigest}, result_digest=${result.resultDigest ?? null}, usage_json=${result.usage === undefined ? null : canonicalJson(result.usage)}::jsonb, workspace_checkpoint=${result.workspaceCheckpoint === undefined ? null : canonicalJson(result.workspaceCheckpoint)}::jsonb, updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId} AND state='dispatched' AND EXISTS (SELECT 1 FROM factory_executions WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch}) RETURNING operation_id`));
      if (updated.length) return;
      const existing = releaseRows<{ state: FactoryOperationState; provider_receipt_digest: string | null; result_digest: string | null; usage_json: unknown; workspace_checkpoint: unknown }>(await database.execute(sql`SELECT state, provider_receipt_digest, result_digest, usage_json, workspace_checkpoint FROM factory_execution_operations WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId}`))[0];
      if (!existing || !this.sameEvidence(existing, "uncertain", result)) throw new Error("Late factory receipt does not match a dispatched operation.");
    });
  }

  async cancel(authority: FactoryAttemptAuthority): Promise<boolean> {
    assertIdentity(authority);
    return this.db.transaction(async (database) => {
      await this.lockRunFence(database, authority);
      const updated = releaseRows(await database.execute(sql`UPDATE factory_executions SET status='cancel_accepted', cancel_accepted_at=COALESCE(cancel_accepted_at, NOW()), updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch} AND status IN ('admitted', 'running') RETURNING attempt_id`));
      return Boolean(updated.length);
    });
  }

  async confirmStopped(authority: FactoryAttemptAuthority): Promise<boolean> {
    assertIdentity(authority);
    return this.db.transaction(async (database) => {
      await this.lockRunFence(database, authority);
      const updated = releaseRows(await database.execute(sql`UPDATE factory_executions SET status='stopped', stopped_at=COALESCE(stopped_at, NOW()), updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch} AND status='cancel_accepted' RETURNING attempt_id`));
      return Boolean(updated.length);
    });
  }

  async status(authority: FactoryAttemptAuthority): Promise<{ status: string; journalCursor: number; cancelAcceptedAt: Date | null; stoppedAt: Date | null }> {
    assertIdentity(authority);
    return this.db.transaction(async (database) => {
      await this.lockRunFence(database, authority);
      const row = releaseRows<{ status: string; journal_cursor: number; cancel_accepted_at: Date | null; stopped_at: Date | null }>(await database.execute(sql`SELECT status, journal_cursor, cancel_accepted_at, stopped_at FROM factory_executions WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch}`))[0];
      const cursor = Number(row?.journal_cursor);
      if (!row?.status || !Number.isSafeInteger(cursor)) throw new Error("Factory attempt is unavailable to this tenant.");
      return { status: row.status, journalCursor: cursor, cancelAcceptedAt: row.cancel_accepted_at ?? null, stoppedAt: row.stopped_at ?? null };
    });
  }

  private authorityDigest(authority: FactoryAttemptAuthority): Record<string, string | number> {
    return { attemptId: authority.attemptId, tenantId: authority.tenantId, projectId: authority.projectId, runId: authority.runId, nodeInstanceId: authority.nodeInstanceId, candidateGeneration: authority.candidateGeneration, attemptNumber: authority.attemptNumber, grantRevision: authority.grantRevision, reservationGeneration: authority.reservationGeneration, executionEpoch: authority.executionEpoch, deadlineAt: authority.deadlineAt.getTime() };
  }

  private sameEvidence(stored: { state: FactoryOperationState; provider_receipt_digest: string | null; result_digest: string | null; usage_json: unknown; workspace_checkpoint: unknown }, state: FactoryOperationState, result: FactoryOperationSettlement): boolean {
    return stored.state === state
      && stored.provider_receipt_digest === (result.providerReceiptDigest ?? null)
      && stored.result_digest === (result.resultDigest ?? null)
      && this.canonicalStoredJson(stored.usage_json) === canonicalJson(result.usage ?? null)
      && this.canonicalStoredJson(stored.workspace_checkpoint) === canonicalJson(result.workspaceCheckpoint ?? null);
  }

  private canonicalStoredJson(value: unknown): string {
    if (typeof value !== "string") return canonicalJson(value ?? null);
    try { return canonicalJson(JSON.parse(value)); } catch { return canonicalJson(value); }
  }

  private assertLiveInput(authority: FactoryAttemptAuthority): void {
    assertIdentity(authority);
    if (authority.deadlineAt.getTime() <= this.now().getTime()) throw new Error("Factory attempt authority is stale or expired.");
  }

  private async lockLive(database: MigrationDb, authority: FactoryAttemptAuthority): Promise<void> {
    await this.lockRunFence(database, authority);
    const locked = releaseRows(await database.execute(sql`UPDATE factory_executions SET updated_at=updated_at WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch} AND deadline_at > NOW() AND status IN ('admitted', 'running') RETURNING attempt_id`));
    if (!locked.length) throw new Error("Factory attempt is stale, cancelled, or expired.");
  }

  private async lockRunFence(database: MigrationDb, authority: FactoryAttemptAuthority): Promise<void> {
    const run = releaseRows(await database.execute(sql`SELECT factory_runs.run_id FROM factory_runs JOIN factory_installation ON factory_installation.tenant_id = factory_runs.tenant_id WHERE factory_runs.tenant_id=${authority.tenantId} AND factory_runs.project_id=${authority.projectId} AND factory_runs.run_id=${authority.runId} AND factory_runs.execution_epoch=${authority.executionEpoch} AND factory_installation.execution_epoch=${authority.executionEpoch} FOR UPDATE`));
    if (!run.length) throw new Error("Factory run epoch is stale or unavailable.");
  }
}
