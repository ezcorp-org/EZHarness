import { sql } from "drizzle-orm";
import { lockFactoryScope } from "./locks";
import { canonicalJson, type JsonValue } from "@ezcorp/extension-contract";
import { validateFactoryRunnerResult, type FactoryMeasuredUsage, type FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestIdentity } from "@ezcorp/factory-sdk/compiler";
import type { FactoryRunnerRequest, FactoryRunnerRequestIdentity } from "@ezcorp/factory-sdk";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows } from "../db/queries/extension-releases";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { digestObject } from "../extensions/v4/blobs";
import { artifactJson, type FactoryArtifacts } from "./artifacts";

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
  cancellationEpoch: number;
  /** Canonical C02 request identity, excluding only the ephemeral broker token. */
  requestDigest: string;
  deadlineAt: Date;
}

export interface FactoryAttemptAdmission extends FactoryAttemptAuthority {
  request: FactoryRunnerRequest;
}

/** Exact durable runner request. A fresh short-lived broker token is added only at dispatch. */
export type FactoryDurableRunnerRequest = FactoryRunnerRequestIdentity;

export interface FactoryDurableAttemptAdmission extends FactoryAttemptAuthority {
  request: FactoryDurableRunnerRequest;
}

export interface FactoryAttemptCursorKey {
  tenantId: string;
  projectId: string;
  runId: string;
  nodeInstanceId: string;
  candidateGeneration: number;
  executionEpoch: number;
}

interface FactoryAttemptAdmissionSnapshot {
  readonly authority: FactoryAttemptAuthority;
  readonly requestHash: string;
  readonly requestJson: string;
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
  /** Exact JSON result, retained so recovery never repeats a completed effect. */
  result?: JsonValue;
  usage?: unknown;
  workspaceCheckpoint?: unknown;
}

export interface FactoryJournalOperationStatus {
  state: FactoryOperationState;
  result?: JsonValue;
}

export interface FactoryExecutionTerminalFact {
  readonly attemptId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly candidateGeneration: number;
  readonly candidateDigest: string;
  readonly requestDigest: string;
  readonly resultDigest: string;
  readonly terminalResultDigest: string;
  readonly outputArtifactId: string;
  readonly outputBytes: number;
  readonly executionEpoch: number;
  readonly cancellationEpoch: number;
  readonly terminalFactDigest: string;
}

/** Exact journal proof shared by successful and non-successful terminal adapters. */
export interface FactoryExecutionResultEvidence {
  readonly resultJson: string;
  readonly terminalResultDigest: string;
  readonly evidenceDigest: string;
  readonly operations: readonly FactoryJournalOperationEvidence[];
  readonly journalCursor: number;
}

/** Durable evidence used to reconstruct a C02 result without replaying effects. */
export interface FactoryJournalOperationEvidence extends FactoryJournalOperation {
  state: FactoryOperationState;
  resultDigest?: string;
  providerReceiptDigest?: string;
  usage?: JsonValue;
  workspaceCheckpoint?: JsonValue;
}

/** Runs under the journal row locks immediately before an effect can dispatch. */
export type FactoryAttemptAuthorizer = (database: MigrationDb, authority: FactoryAttemptAuthority) => Promise<void>;

function assertIdentity(value: FactoryAttemptAuthority): void {
  const counters = [value.attemptNumber, value.grantRevision, value.reservationGeneration, value.cancellationEpoch];
  if (!value.attemptId || !/^[a-f0-9]{64}$/.test(value.requestDigest) || counters.some(counter => !Number.isSafeInteger(counter) || counter < 0) || !(value.deadlineAt instanceof Date) || !Number.isFinite(value.deadlineAt.getTime())) {
    throw new Error("Factory attempt authority is incomplete.");
  }
  assertCursorKey(value);
}

function assertCursorKey(value: FactoryAttemptCursorKey): void {
  if (!value.tenantId || !value.projectId || !value.runId || !value.nodeInstanceId || !Number.isSafeInteger(value.candidateGeneration) || value.candidateGeneration < 0 || !Number.isSafeInteger(value.executionEpoch) || value.executionEpoch < 0) throw new Error("Factory attempt authority is incomplete.");
}

function assertOperation(authority: FactoryAttemptAuthority, operation: FactoryJournalOperation): void {
  if (!Number.isSafeInteger(operation.operationIndex) || operation.operationIndex < 0 || !/^[a-f0-9]{64}$/.test(operation.requestDigest)) throw new Error("Factory operation is malformed.");
  const expected = `${authority.runId}:${authority.nodeInstanceId}:${authority.candidateGeneration}:${operation.operationIndex}`;
  if (operation.operationId !== expected) throw new Error("Factory operation id does not match its attempt identity.");
}

/** Copy mutable caller input before any transaction await can observe a later mutation. */
function snapshotAuthority(value: FactoryAttemptAuthority): FactoryAttemptAuthority {
  assertIdentity(value);
  return Object.freeze({ attemptId: value.attemptId, tenantId: value.tenantId, projectId: value.projectId, runId: value.runId, nodeInstanceId: value.nodeInstanceId, candidateGeneration: value.candidateGeneration, attemptNumber: value.attemptNumber, grantRevision: value.grantRevision, reservationGeneration: value.reservationGeneration, executionEpoch: value.executionEpoch, cancellationEpoch: value.cancellationEpoch, requestDigest: value.requestDigest, deadlineAt: new Date(value.deadlineAt.getTime()) });
}

function snapshotOperation(value: FactoryJournalOperation): FactoryJournalOperation {
  return Object.freeze({ operationId: value.operationId, operationIndex: value.operationIndex, kind: value.kind, requestDigest: value.requestDigest });
}

function snapshotSettlement(value: FactoryOperationSettlement): FactoryOperationSettlement {
  const copy = (item: unknown): JsonValue | undefined => item === undefined ? undefined : JSON.parse(canonicalJson(item)) as JsonValue;
  return Object.freeze({ ...(value.providerReceiptDigest === undefined ? {} : { providerReceiptDigest: value.providerReceiptDigest }), ...(value.resultDigest === undefined ? {} : { resultDigest: value.resultDigest }), ...(value.result === undefined ? {} : { result: copy(value.result) }), ...(value.usage === undefined ? {} : { usage: copy(value.usage) }), ...(value.workspaceCheckpoint === undefined ? {} : { workspaceCheckpoint: copy(value.workspaceCheckpoint) }) });
}

function snapshotAdmission(value: FactoryAttemptAdmission): FactoryAttemptAdmissionSnapshot {
  const authority = snapshotAuthority(value);
  const callerRequest = value.request;
  const request = factoryRunnerRequestIdentity(callerRequest);
  const requestHash = digestObject(request);
  if (requestHash !== authority.requestDigest) throw new Error("Factory signed attempt does not match the canonical runner request.");
  assertRequestAuthority(authority, request);
  return Object.freeze({ authority, requestHash, requestJson: canonicalJson(request) });
}

function snapshotDurableAdmission(value: FactoryDurableAttemptAdmission): FactoryAttemptAdmissionSnapshot {
  const authority = snapshotAuthority(value);
  const request = durableRunnerRequest(JSON.parse(canonicalJson(value.request)), authority.requestDigest);
  assertRequestAuthority(authority, request);
  return Object.freeze({ authority, requestHash: authority.requestDigest, requestJson: canonicalJson(request) });
}

function assertRequestAuthority(authority: FactoryAttemptAuthority, request: FactoryDurableRunnerRequest): void {
  if (request.authority.attemptId !== authority.attemptId || request.authority.tenantId !== authority.tenantId || request.authority.projectId !== authority.projectId || request.authority.runId !== authority.runId || request.authority.nodeInstanceId !== authority.nodeInstanceId || request.authority.candidateGeneration !== authority.candidateGeneration || request.authority.attemptNumber !== authority.attemptNumber || request.authority.grantRevision !== authority.grantRevision || request.authority.reservationGeneration !== authority.reservationGeneration || request.authority.executionEpoch !== authority.executionEpoch || request.authority.cancellationEpoch !== authority.cancellationEpoch || request.authority.deadlineAtMs !== authority.deadlineAt.getTime()) throw new Error("Factory signed attempt does not match the canonical runner request.");
}

function durableRunnerRequest(value: unknown, requestHash: string): FactoryDurableRunnerRequest {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid durable request");
    const broker = (value as { broker?: unknown }).broker;
    if (!broker || typeof broker !== "object" || Array.isArray(broker) || Object.hasOwn(broker, "attemptToken")) throw new Error("invalid durable broker");
    const request = factoryRunnerRequestIdentity({ ...(value as FactoryDurableRunnerRequest), broker: { ...(broker as FactoryDurableRunnerRequest["broker"]), attemptToken: "durable-request-validation" } });
    if (digestObject(request) !== requestHash || canonicalJson(request) !== canonicalJson(value)) throw new Error("durable request digest mismatch");
    return request;
  } catch {
    throw new Error("Factory durable runner request is corrupt.");
  }
}

/** Durable C02 journal; the gateway authenticates and supplies its authority. */
export class FactoryExecutionJournal {
  constructor(private readonly db: TransactionalDb, private readonly authorizeInTransaction: FactoryAttemptAuthorizer, private readonly now: () => Date = () => new Date()) {}
  get database(): TransactionalDb { return this.db; }

  async admit(input: FactoryAttemptAdmission): Promise<{ requestHash: string; reused: boolean }> {
    const snapshot = snapshotAdmission(input);
    return this.db.transaction(database => this.admitSnapshotInTransaction(database, snapshot));
  }

  /** Admit inside the caller's product transaction, so an attempt and its queue row commit together. */
  async admitInTransaction(database: MigrationDb, input: FactoryAttemptAdmission): Promise<{ requestHash: string; reused: boolean }> {
    return this.admitSnapshotInTransaction(database, snapshotAdmission(input));
  }

  /** Admit a request that never carried an attempt token. Dispatch mints that token later. */
  async admitDurableInTransaction(database: MigrationDb, input: FactoryDurableAttemptAdmission): Promise<{ requestHash: string; reused: boolean }> {
    return this.admitSnapshotInTransaction(database, snapshotDurableAdmission(input));
  }

  /** Read and lock the next operation index while the caller's product transaction remains open. */
  async nextOperationIndexInTransaction(database: MigrationDb, key: FactoryAttemptCursorKey): Promise<number> {
    assertCursorKey(key);
    const installation = await lockFactoryScope(database, key.tenantId, key.projectId);
    if (installation?.executionEpoch !== key.executionEpoch) throw new Error("Factory run epoch is stale or unavailable.");
    const run = releaseRows(await database.execute(sql`SELECT run_id FROM factory_runs WHERE tenant_id=${key.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND execution_epoch=${key.executionEpoch} FOR UPDATE`));
    if (!run.length) throw new Error("Factory run epoch is stale or unavailable.");
    return this.operationCursorInTransaction(database, key);
  }

  /** Load the exact committed request identity after current authority and lifecycle checks. */
  async request(authority: FactoryAttemptAuthority): Promise<FactoryDurableRunnerRequest> {
    authority = snapshotAuthority(authority);
    return this.db.transaction(database => this.requestInTransaction(database, authority));
  }

  /** Transactional form used by restart and retry queues before they mint a new broker token. */
  async requestInTransaction(database: MigrationDb, authority: FactoryAttemptAuthority): Promise<FactoryDurableRunnerRequest> {
    authority = snapshotAuthority(authority);
    this.assertLiveInput(authority);
    await this.lockLive(database, authority);
    const stored = releaseRows<{ request_hash: string; request_json: unknown }>(await database.execute(sql`SELECT request_hash,request_json FROM factory_executions WHERE attempt_id=${authority.attemptId}`))[0];
    if (stored?.request_hash !== authority.requestDigest) throw new Error("Factory durable runner request is corrupt.");
    return durableRunnerRequest(this.storedJson(stored.request_json), stored.request_hash);
  }

  async prepare(authority: FactoryAttemptAuthority, operation: FactoryJournalOperation): Promise<void> {
    authority = snapshotAuthority(authority);
    operation = snapshotOperation(operation);
    this.assertLiveInput(authority);
    assertOperation(authority, operation);
    return this.db.transaction(async (database) => {
      await this.lockLive(database, authority);
      const existing = releaseRows<{ operation_index: number; kind: string; state: string; request_digest: string }>(await database.execute(sql`SELECT operation_index, kind, state, request_digest FROM factory_execution_operations WHERE attempt_id=${authority.attemptId} AND operation_id=${operation.operationId}`))[0];
      if (existing) {
        if (Number(existing.operation_index) !== operation.operationIndex || existing.kind !== operation.kind || existing.request_digest !== operation.requestDigest) throw new Error("Factory operation conflicts with its durable journal entry.");
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
    authority = snapshotAuthority(authority);
    this.assertLiveInput(authority);
    return this.db.transaction(async (database) => {
      await this.lockLive(database, authority);
      const updated = releaseRows(await database.execute(sql`UPDATE factory_execution_operations SET state='dispatched', updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId} AND state='prepared' RETURNING operation_id`));
      if (updated.length) {
        await database.execute(sql`UPDATE factory_executions SET status='running', updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND status='admitted'`);
        return { claimed: true };
      }
      const existing = releaseRows<{ state: string }>(await database.execute(sql`SELECT state FROM factory_execution_operations WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId}`))[0];
      if (!existing || !["dispatched", "completed", "failed", "uncertain"].includes(existing.state)) throw new Error("Factory operation is not prepared for dispatch.");
      return { claimed: false };
    });
  }

  async settle(authority: FactoryAttemptAuthority, operationId: string, state: Extract<FactoryOperationState, "completed" | "failed" | "uncertain">, result: FactoryOperationSettlement): Promise<void> {
    authority = snapshotAuthority(authority);
    result = snapshotSettlement(result);
    this.assertLiveInput(authority);
    if (state === "completed" && (!result.resultDigest || result.result === undefined || result.usage === undefined || result.workspaceCheckpoint === undefined)) throw new Error("A completed factory operation needs result, usage, and workspace checkpoint evidence.");
    if (state === "failed" && !result.resultDigest) throw new Error("A failed factory operation needs a result digest.");
    await this.db.transaction(async (database) => {
      await this.lockLive(database, authority);
      const operation = releaseRows<{ operation_index: number }>(await database.execute(sql`UPDATE factory_execution_operations SET state=${state}, provider_receipt_digest=${result.providerReceiptDigest ?? null}, result_digest=${result.resultDigest ?? null}, result_json=${result.result === undefined ? null : canonicalJson(result.result)}::jsonb, usage_json=${result.usage === undefined ? null : canonicalJson(result.usage)}::jsonb, workspace_checkpoint=${result.workspaceCheckpoint === undefined ? null : canonicalJson(result.workspaceCheckpoint)}::jsonb, updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId} AND state='dispatched' RETURNING operation_index`))[0];
      if (!operation || !Number.isSafeInteger(Number(operation.operation_index))) {
        const existing = releaseRows<{ state: FactoryOperationState; provider_receipt_digest: string | null; result_digest: string | null; result_json: unknown; usage_json: unknown; workspace_checkpoint: unknown }>(await database.execute(sql`SELECT state, provider_receipt_digest, result_digest, result_json, usage_json, workspace_checkpoint FROM factory_execution_operations WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId}`))[0];
        if (!existing || !this.sameEvidence(existing, state, result)) throw new Error("Factory operation cannot settle from its current state.");
        return;
      }
      await database.execute(sql`UPDATE factory_executions SET journal_cursor = COALESCE((SELECT MIN(operation_index) - 1 FROM factory_execution_operations WHERE attempt_id=${authority.attemptId} AND state IN ('prepared', 'dispatched')), (SELECT COALESCE(MAX(operation_index), -1) FROM factory_execution_operations WHERE attempt_id=${authority.attemptId})), updated_at=NOW() WHERE attempt_id=${authority.attemptId}`);
    });
  }

  /** Reads recorded effect state and a completed result without issuing an effect. */
  async operation(authority: FactoryAttemptAuthority, operationId: string): Promise<FactoryJournalOperationStatus> {
    authority = snapshotAuthority(authority);
    return this.db.transaction(async (database) => {
      await this.lockScopedRead(database, authority);
      const stored = releaseRows<{ state: FactoryOperationState; result_json: unknown }>(await database.execute(sql`SELECT state, result_json FROM factory_execution_operations WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId}`))[0];
      if (!stored) throw new Error("Factory operation is unavailable to this tenant.");
      if (stored.state === "completed") return { state: stored.state, result: this.storedJson(stored.result_json) as JsonValue };
      return { state: stored.state };
    });
  }

  /** Ordered durable evidence for a completed runner result. This is read-only. */
  async operations(authority: FactoryAttemptAuthority): Promise<FactoryJournalOperationEvidence[]> {
    return (await this.evidence(authority)).operations;
  }

  /** Trusted completion boundary: verify one successful runner result against the journal and exact stored output bytes. */
  async recordCompletedTerminalInTransaction(database: MigrationDb, authority: FactoryAttemptAuthority, result: FactoryRunnerResult, artifacts: FactoryArtifacts): Promise<FactoryExecutionTerminalFact> {
    authority = snapshotAuthority(authority);
    result = JSON.parse(canonicalJson(result)) as FactoryRunnerResult;
    const validation = validateFactoryRunnerResult(result);
    if (!validation.ok || result.status !== "completed" || result.usage.kind !== "measured") throw new Error(`Factory terminal result is invalid: ${validation.ok ? "not_completed" : validation.issues[0]?.code ?? "unknown"}.`);
    const attempt = await this.lockTerminalCompletion(database, authority);
    if (!attempt) throw new Error("Factory terminal attempt is unavailable.");
    const { resultJson, terminalResultDigest, terminalFactDigest } = await this.verifyCompletedEvidence(database, authority, result, artifacts);
    await database.execute(sql`INSERT INTO factory_execution_terminals (tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_id,request_digest,result_digest,terminal_result_digest,result_json,output_artifact_id,output_digest,output_bytes,execution_epoch,cancellation_epoch,terminal_fact_digest) VALUES (${authority.tenantId},${authority.projectId},${authority.runId},${authority.nodeInstanceId},${authority.candidateGeneration},${authority.attemptId},${authority.requestDigest},${result.resultDigest},${terminalResultDigest},${resultJson},${result.output.artifactId},${result.output.digest},${result.output.encodedBytes},${authority.executionEpoch},${authority.cancellationEpoch},${terminalFactDigest}) ON CONFLICT (attempt_id) DO NOTHING`);
    const saved = releaseRows<{ tenant_id: string; project_id: string; run_id: string; node_instance_id: string; candidate_generation: number | string; request_digest: string; result_digest: string; terminal_result_digest: string; result_json: string; output_artifact_id: string; output_digest: string; output_bytes: number | string; execution_epoch: number | string; cancellation_epoch: number | string; terminal_fact_digest: string }>(await database.execute(sql`SELECT tenant_id,project_id,run_id,node_instance_id,candidate_generation,request_digest,result_digest,terminal_result_digest,result_json,output_artifact_id,output_digest,output_bytes,execution_epoch,cancellation_epoch,terminal_fact_digest FROM factory_execution_terminals WHERE attempt_id=${authority.attemptId} FOR SHARE`))[0];
    if (!saved || saved.terminal_fact_digest !== terminalFactDigest || saved.result_json !== resultJson || saved.output_digest !== result.output.digest) throw new Error("Factory terminal fact conflicts with durable evidence.");
    const completed = releaseRows(await database.execute(sql`UPDATE factory_executions SET status='completed',updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND status IN ('admitted','running') RETURNING attempt_id`));
    if (attempt.status !== "completed" && completed.length !== 1) throw new Error("Factory terminal attempt is stale, cancelled, or expired.");
    await insertTransactionalAuditEntry(database, `factory-execution-terminal:${authority.attemptId}`, null, "factory.execution.terminal.completed", authority.runId, { tenantId: authority.tenantId, projectId: authority.projectId, runId: authority.runId, nodeInstanceId: authority.nodeInstanceId, candidateGeneration: authority.candidateGeneration, attemptId: authority.attemptId, terminalFactDigest });
    return { attemptId: authority.attemptId, tenantId: saved.tenant_id, projectId: saved.project_id, runId: saved.run_id, nodeInstanceId: saved.node_instance_id, candidateGeneration: Number(saved.candidate_generation), candidateDigest: saved.output_digest, requestDigest: saved.request_digest, resultDigest: saved.result_digest, terminalResultDigest: saved.terminal_result_digest, outputArtifactId: saved.output_artifact_id, outputBytes: Number(saved.output_bytes), executionEpoch: Number(saved.execution_epoch), cancellationEpoch: Number(saved.cancellation_epoch), terminalFactDigest: saved.terminal_fact_digest };
  }

  /** Read a historical completion without admitting effects or changing its terminal timestamp. */
  async readCompletedTerminalInTransaction(database: MigrationDb, value: FactoryAttemptAuthority, artifacts: FactoryArtifacts): Promise<{ terminal: FactoryExecutionTerminalFact; result: Extract<FactoryRunnerResult, { status: "completed" }>; createdAtMs: number }> {
    const authority = snapshotAuthority(value);
    if (artifacts.tenantId !== authority.tenantId || artifacts.database !== this.db) throw new Error("Factory terminal artifact scope is invalid.");
    const attempt = releaseRows<{ request_hash: string; request_json: unknown; status: string }>(await database.execute(sql`SELECT request_hash,request_json,status FROM factory_executions WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch} AND cancellation_epoch=${authority.cancellationEpoch} AND request_hash=${authority.requestDigest} AND deadline_at=${authority.deadlineAt} FOR SHARE`))[0];
    if (attempt?.status !== "completed") throw new Error("Factory terminal receipt is unavailable.");
    const row = releaseRows<{ tenant_id: string; project_id: string; run_id: string; node_instance_id: string; candidate_generation: number | string; request_digest: string; result_digest: string; terminal_result_digest: string; result_json: string; output_artifact_id: string; output_digest: string; output_bytes: number | string; execution_epoch: number | string; cancellation_epoch: number | string; terminal_fact_digest: string; created_at: Date | string }>(await database.execute(sql`SELECT * FROM factory_execution_terminals WHERE attempt_id=${authority.attemptId} FOR SHARE`))[0];
    if (!row) throw new Error("Factory terminal receipt is unavailable.");
    const parsed: unknown = JSON.parse(row.result_json);
    if (!validateFactoryRunnerResult(parsed).ok || (parsed as FactoryRunnerResult).status !== "completed") throw new Error("Factory terminal receipt is corrupt.");
    const result = parsed as Extract<FactoryRunnerResult, { status: "completed" }>;
    const checked = await this.verifyCompletedEvidence(database, authority, result, artifacts);
    const terminal: FactoryExecutionTerminalFact = { attemptId: authority.attemptId, tenantId: row.tenant_id, projectId: row.project_id, runId: row.run_id, nodeInstanceId: row.node_instance_id, candidateGeneration: Number(row.candidate_generation), candidateDigest: row.output_digest, requestDigest: row.request_digest, resultDigest: row.result_digest, terminalResultDigest: row.terminal_result_digest, outputArtifactId: row.output_artifact_id, outputBytes: Number(row.output_bytes), executionEpoch: Number(row.execution_epoch), cancellationEpoch: Number(row.cancellation_epoch), terminalFactDigest: row.terminal_fact_digest };
    const expected: FactoryExecutionTerminalFact = { attemptId: authority.attemptId, tenantId: authority.tenantId, projectId: authority.projectId, runId: authority.runId, nodeInstanceId: authority.nodeInstanceId, candidateGeneration: authority.candidateGeneration, candidateDigest: result.output.digest, requestDigest: authority.requestDigest, resultDigest: result.resultDigest, terminalResultDigest: checked.terminalResultDigest, outputArtifactId: result.output.artifactId, outputBytes: result.output.encodedBytes, executionEpoch: authority.executionEpoch, cancellationEpoch: authority.cancellationEpoch, terminalFactDigest: checked.terminalFactDigest };
    const createdAtMs = new Date(row.created_at).getTime();
    if (canonicalJson(terminal) !== canonicalJson(expected) || row.result_json !== checked.resultJson || !Number.isSafeInteger(createdAtMs) || createdAtMs < 0) throw new Error("Factory terminal receipt is corrupt.");
    return { terminal, result, createdAtMs };
  }

  private async verifyCompletedEvidence(database: MigrationDb, authority: FactoryAttemptAuthority, result: Extract<FactoryRunnerResult, { status: "completed" }>, artifacts: FactoryArtifacts) {
    const evidence = await this.verifyRunnerResultInTransaction(database, authority, result);
    if (evidence.operations.some(operation => operation.state === "prepared" || operation.state === "dispatched" || operation.state === "uncertain" || operation.usage === undefined || (operation.usage as { kind?: string }).kind !== "measured") || result.output.digest !== `sha256:${result.resultDigest}`) throw new Error("Factory terminal result does not match measured usage or output digest.");
    const output = await artifacts.loadInTransaction(database, { tenantId: authority.tenantId, projectId: authority.projectId, logicalRunId: authority.runId }, { objectId: result.output.artifactId, digest: result.output.digest, encodedBytes: result.output.encodedBytes }, ["candidate_output"]);
    if (output.reference.digest !== result.output.digest || output.reference.encodedBytes !== result.output.encodedBytes || output.candidateNodeInstanceId !== authority.nodeInstanceId || output.candidateGeneration !== authority.candidateGeneration) throw new Error("Factory terminal output is unavailable.");
    artifactJson.parse(output.content);
    const { resultJson, terminalResultDigest } = evidence;
    const terminalFactDigest = `sha256:${digestObject({ attemptId: authority.attemptId, tenantId: authority.tenantId, projectId: authority.projectId, runId: authority.runId, nodeInstanceId: authority.nodeInstanceId, candidateGeneration: authority.candidateGeneration, requestDigest: authority.requestDigest, resultDigest: result.resultDigest, terminalResultDigest, output: result.output, executionEpoch: authority.executionEpoch, cancellationEpoch: authority.cancellationEpoch })}`;
    return { resultJson, terminalResultDigest, terminalFactDigest };
  }

  /** Verify a canonical runner result against the immutable request and operation journal. */
  async verifyRunnerResultInTransaction(database: MigrationDb, value: FactoryAttemptAuthority, valueResult: FactoryRunnerResult): Promise<FactoryExecutionResultEvidence> {
    const authority = snapshotAuthority(value);
    const result = JSON.parse(canonicalJson(valueResult)) as FactoryRunnerResult;
    const validation = validateFactoryRunnerResult(result);
    if (!validation.ok) throw new Error(`Factory terminal result is invalid: ${validation.issues[0]?.code ?? "unknown"}.`);
    const attempt = releaseRows<{ request_hash: string; request_json: unknown }>(await database.execute(sql`SELECT request_hash,request_json FROM factory_executions WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch} AND cancellation_epoch=${authority.cancellationEpoch} AND request_hash=${authority.requestDigest} AND deadline_at=${authority.deadlineAt} FOR SHARE`))[0];
    if (!attempt) throw new Error("Factory terminal receipt is unavailable.");
    durableRunnerRequest(this.storedJson(attempt.request_json), attempt.request_hash);
    const evidence = await this.operationEvidenceInTransaction(database, authority.attemptId);
    if (evidence.journalCursor !== result.journalCursor || canonicalJson(evidence.operations) !== canonicalJson(result.operations) || evidence.operations.some(operation => operation.state === "prepared" || operation.state === "dispatched")) throw new Error("Factory terminal result does not match settled journal evidence.");
    if (result.usage?.kind === "measured") {
      const measured = result.operations.map(operation => operation.usage).filter((usage): usage is FactoryMeasuredUsage => usage?.kind === "measured");
      if (measured.length !== result.operations.length) throw new Error("Factory terminal result does not match measured usage or output digest.");
      const aggregate = { kind: "measured", inputTokens: measured.reduce((sum, usage) => sum + usage.inputTokens, 0), outputTokens: measured.reduce((sum, usage) => sum + usage.outputTokens, 0), computeMs: measured.reduce((sum, usage) => sum + usage.computeMs, 0), costMicros: measured.reduce((sum, usage) => sum + BigInt(usage.costMicros), 0n).toString() };
      if (canonicalJson(aggregate) !== canonicalJson(result.usage)) throw new Error("Factory terminal result does not match measured usage or output digest.");
    }
    const resultJson = canonicalJson(result);
    const terminalResultDigest = `sha256:${digestObject(result)}`;
    const evidenceDigest = `sha256:${digestObject({ authority: { ...authority, deadlineAt: authority.deadlineAt.getTime() }, requestDigest: authority.requestDigest, terminalResultDigest, journalCursor: evidence.journalCursor, operations: evidence.operations })}`;
    return Object.freeze({ resultJson, terminalResultDigest, evidenceDigest, operations: Object.freeze(evidence.operations), journalCursor: evidence.journalCursor });
  }

  /** Read operation facts and their committed cursor under the same attempt lock. */
  async evidence(authority: FactoryAttemptAuthority): Promise<{ operations: FactoryJournalOperationEvidence[]; journalCursor: number }> {
    authority = snapshotAuthority(authority);
    return this.db.transaction(async (database) => {
      await this.lockScopedRead(database, authority);
      return this.operationEvidenceInTransaction(database, authority.attemptId);
    });
  }

  /** Record a late receipt for reconciliation without advancing the run cursor. */
  async reconcileLate(authority: FactoryAttemptAuthority, operationId: string, result: FactoryOperationSettlement): Promise<void> {
    authority = snapshotAuthority(authority);
    result = snapshotSettlement(result);
    if (!result.providerReceiptDigest) throw new Error("Late factory receipts need a digest.");
    await this.db.transaction(async (database) => {
      await this.lockScopedRead(database, authority);
      const updated = releaseRows(await database.execute(sql`UPDATE factory_execution_operations SET state='uncertain', provider_receipt_digest=${result.providerReceiptDigest}, result_digest=${result.resultDigest ?? null}, result_json=${result.result === undefined ? null : canonicalJson(result.result)}::jsonb, usage_json=${result.usage === undefined ? null : canonicalJson(result.usage)}::jsonb, workspace_checkpoint=${result.workspaceCheckpoint === undefined ? null : canonicalJson(result.workspaceCheckpoint)}::jsonb, updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId} AND state='dispatched' AND EXISTS (SELECT 1 FROM factory_executions WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch} AND cancellation_epoch=${authority.cancellationEpoch} AND request_hash=${authority.requestDigest}) RETURNING operation_id`));
      if (updated.length) return;
      const existing = releaseRows<{ state: FactoryOperationState; provider_receipt_digest: string | null; result_digest: string | null; result_json: unknown; usage_json: unknown; workspace_checkpoint: unknown }>(await database.execute(sql`SELECT state, provider_receipt_digest, result_digest, result_json, usage_json, workspace_checkpoint FROM factory_execution_operations WHERE attempt_id=${authority.attemptId} AND operation_id=${operationId}`))[0];
      if (!existing || !this.sameEvidence(existing, "uncertain", result)) throw new Error("Late factory receipt does not match a dispatched operation.");
    });
  }

  async cancel(authority: FactoryAttemptAuthority): Promise<boolean> {
    authority = snapshotAuthority(authority);
    return this.db.transaction(async (database) => {
      await this.lockRunFence(database, authority);
      const updated = releaseRows(await database.execute(sql`UPDATE factory_executions SET status='cancel_accepted', cancel_accepted_at=COALESCE(cancel_accepted_at, NOW()), updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch} AND cancellation_epoch=${authority.cancellationEpoch} AND request_hash=${authority.requestDigest} AND status IN ('admitted', 'running') RETURNING attempt_id`));
      return Boolean(updated.length);
    });
  }

  async confirmStopped(authority: FactoryAttemptAuthority): Promise<boolean> {
    authority = snapshotAuthority(authority);
    return this.db.transaction(async (database) => {
      await this.lockRunFence(database, authority);
      const updated = releaseRows(await database.execute(sql`UPDATE factory_executions SET status='stopped', stopped_at=COALESCE(stopped_at, NOW()), updated_at=NOW() WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch} AND cancellation_epoch=${authority.cancellationEpoch} AND request_hash=${authority.requestDigest} AND status='cancel_accepted' RETURNING attempt_id`));
      return Boolean(updated.length);
    });
  }

  async status(authority: FactoryAttemptAuthority): Promise<{ status: string; journalCursor: number; cancelAcceptedAt: Date | null; stoppedAt: Date | null; workspaceCheckpoint?: unknown; terminalResult?: JsonValue }> {
    authority = snapshotAuthority(authority);
    return this.db.transaction(async (database) => {
      await this.lockScopedRead(database, authority);
      const row = releaseRows<{ status: string; journal_cursor: number; cancel_accepted_at: Date | null; stopped_at: Date | null }>(await database.execute(sql`SELECT status, journal_cursor, cancel_accepted_at, stopped_at FROM factory_executions WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch} AND cancellation_epoch=${authority.cancellationEpoch} AND request_hash=${authority.requestDigest}`))[0];
      const cursor = Number(row?.journal_cursor);
      if (!row?.status || !Number.isSafeInteger(cursor)) throw new Error("Factory attempt is unavailable to this tenant.");
      const terminal = releaseRows<{ result_json: unknown; workspace_checkpoint: unknown }>(await database.execute(sql`SELECT result_json, workspace_checkpoint FROM factory_execution_operations WHERE attempt_id=${authority.attemptId} AND state='completed' ORDER BY operation_index DESC LIMIT 1`))[0];
      return {
        status: row.status,
        journalCursor: cursor,
        cancelAcceptedAt: row.cancel_accepted_at ?? null,
        stoppedAt: row.stopped_at ?? null,
        ...(terminal ? { workspaceCheckpoint: this.storedJson(terminal.workspace_checkpoint), terminalResult: this.storedJson(terminal.result_json) as JsonValue } : {}),
      };
    });
  }

  private async admitSnapshotInTransaction(database: MigrationDb, snapshot: FactoryAttemptAdmissionSnapshot): Promise<{ requestHash: string; reused: boolean }> {
    const { authority, requestHash, requestJson } = snapshot;
    this.assertLiveInput(authority);
    await this.lockRunFence(database, authority);
    await this.authorizeInTransaction(database, authority);
    const prior = releaseRows<{ request_hash: string; request_json: unknown }>(await database.execute(sql`SELECT request_hash,request_json FROM factory_executions WHERE attempt_id=${authority.attemptId} FOR UPDATE`))[0];
    if (prior) {
      if (prior.request_hash !== requestHash || this.canonicalStoredJson(prior.request_json) !== requestJson) throw new Error("Factory attempt id conflicts with a different canonical request.");
      return { requestHash, reused: true };
    }
    const initialIndex = await this.operationCursorInTransaction(database, authority);
    const inserted = releaseRows(await database.execute(sql`INSERT INTO factory_executions(attempt_id, tenant_id, project_id, run_id, node_instance_id, candidate_generation, attempt_number, grant_revision, reservation_generation, execution_epoch, cancellation_epoch, deadline_at, request_hash, request_json, operation_initial_index, status) VALUES (${authority.attemptId}, ${authority.tenantId}, ${authority.projectId}, ${authority.runId}, ${authority.nodeInstanceId}, ${authority.candidateGeneration}, ${authority.attemptNumber}, ${authority.grantRevision}, ${authority.reservationGeneration}, ${authority.executionEpoch}, ${authority.cancellationEpoch}, ${authority.deadlineAt}, ${requestHash}, ${requestJson}::jsonb, ${initialIndex}, 'admitted') ON CONFLICT (attempt_id) DO NOTHING RETURNING attempt_id`));
    if (inserted.length) return { requestHash, reused: false };
    const raced = releaseRows<{ request_hash: string; request_json: unknown }>(await database.execute(sql`SELECT request_hash,request_json FROM factory_executions WHERE attempt_id=${authority.attemptId} FOR UPDATE`))[0];
    if (raced?.request_hash === requestHash && this.canonicalStoredJson(raced.request_json) === requestJson) return { requestHash, reused: true };
    throw new Error("Factory attempt admission did not persist.");
  }

  private sameEvidence(stored: { state: FactoryOperationState; provider_receipt_digest: string | null; result_digest: string | null; result_json: unknown; usage_json: unknown; workspace_checkpoint: unknown }, state: FactoryOperationState, result: FactoryOperationSettlement): boolean {
    return stored.state === state
      && stored.provider_receipt_digest === (result.providerReceiptDigest ?? null)
      && stored.result_digest === (result.resultDigest ?? null)
      && this.canonicalStoredJson(stored.result_json) === canonicalJson(result.result ?? null)
      && this.canonicalStoredJson(stored.usage_json) === canonicalJson(result.usage ?? null)
      && this.canonicalStoredJson(stored.workspace_checkpoint) === canonicalJson(result.workspaceCheckpoint ?? null);
  }

  private async operationCursorInTransaction(database: MigrationDb, key: FactoryAttemptCursorKey): Promise<number> {
    await database.execute(sql`INSERT INTO factory_execution_operation_cursors(tenant_id, project_id, run_id, node_instance_id, candidate_generation) VALUES (${key.tenantId}, ${key.projectId}, ${key.runId}, ${key.nodeInstanceId}, ${key.candidateGeneration}) ON CONFLICT DO NOTHING`);
    const cursor = releaseRows<{ next_operation_index: number | string }>(await database.execute(sql`SELECT next_operation_index FROM factory_execution_operation_cursors WHERE tenant_id=${key.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND node_instance_id=${key.nodeInstanceId} AND candidate_generation=${key.candidateGeneration} FOR UPDATE`))[0];
    const next = Number(cursor?.next_operation_index);
    if (!Number.isSafeInteger(next) || next < 0) throw new Error("Factory operation cursor is invalid.");
    return next;
  }

  private async operationEvidenceInTransaction(database: MigrationDb, attemptId: string): Promise<{ operations: FactoryJournalOperationEvidence[]; journalCursor: number }> {
    const stored = releaseRows<{ operation_id: string; operation_index: number | string; kind: "model" | "tool"; state: FactoryOperationState; request_digest: string; result_digest: string | null; provider_receipt_digest: string | null; usage_json: unknown; workspace_checkpoint: unknown }>(await database.execute(sql`SELECT operation_id,operation_index,kind,state,request_digest,result_digest,provider_receipt_digest,usage_json,workspace_checkpoint FROM factory_execution_operations WHERE attempt_id=${attemptId} ORDER BY operation_index`));
    const operations = stored.map(operation => ({ operationId: operation.operation_id, operationIndex: Number(operation.operation_index), kind: operation.kind, state: operation.state, requestDigest: operation.request_digest, ...(operation.result_digest === null ? {} : { resultDigest: operation.result_digest }), ...(operation.provider_receipt_digest === null ? {} : { providerReceiptDigest: operation.provider_receipt_digest }), ...(operation.usage_json === null ? {} : { usage: this.storedJson(operation.usage_json) as JsonValue }), ...(operation.workspace_checkpoint === null ? {} : { workspaceCheckpoint: this.storedJson(operation.workspace_checkpoint) as JsonValue }) } satisfies FactoryJournalOperationEvidence));
    const row = releaseRows<{ journal_cursor: number | string }>(await database.execute(sql`SELECT journal_cursor FROM factory_executions WHERE attempt_id=${attemptId}`))[0];
    const journalCursor = Number(row?.journal_cursor);
    if (!Number.isSafeInteger(journalCursor) || journalCursor < -1) throw new Error("Factory journal cursor is corrupt.");
    return { operations, journalCursor };
  }

  private canonicalStoredJson(value: unknown): string {
    if (typeof value !== "string") return canonicalJson(value ?? null);
    try { return canonicalJson(JSON.parse(value)); } catch { return canonicalJson(value); }
  }

  private storedJson(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { throw new Error("Factory operation result is corrupt."); }
  }

  private assertLiveInput(authority: FactoryAttemptAuthority): void {
    assertIdentity(authority);
    if (authority.deadlineAt.getTime() <= this.now().getTime()) throw new Error("Factory attempt authority is stale or expired.");
  }

  private async lockLive(database: MigrationDb, authority: FactoryAttemptAuthority): Promise<void> {
    await this.lockRunFence(database, authority);
    await this.authorizeInTransaction(database, authority);
    const locked = releaseRows(await database.execute(sql`UPDATE factory_executions SET updated_at=updated_at WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch} AND cancellation_epoch=${authority.cancellationEpoch} AND request_hash=${authority.requestDigest} AND deadline_at > NOW() AND status IN ('admitted', 'running') RETURNING attempt_id`));
    if (!locked.length) throw new Error("Factory attempt is stale, cancelled, or expired.");
  }

  private async lockTerminalCompletion(database: MigrationDb, authority: FactoryAttemptAuthority): Promise<{ request_hash: string; request_json: unknown; status: string }> {
    await this.lockRunFence(database, authority);
    await this.authorizeInTransaction(database, authority);
    const attempt = releaseRows<{ request_hash: string; request_json: unknown; status: string }>(await database.execute(sql`SELECT request_hash,request_json,status FROM factory_executions WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch} AND cancellation_epoch=${authority.cancellationEpoch} AND request_hash=${authority.requestDigest} AND deadline_at>NOW() FOR UPDATE`))[0];
    if (!attempt || !["admitted", "running", "completed"].includes(attempt.status)) throw new Error("Factory terminal attempt is stale, cancelled, or expired.");
    return attempt;
  }

  private async lockScopedRead(database: MigrationDb, authority: FactoryAttemptAuthority): Promise<void> {
    await this.lockRunFence(database, authority);
    const stored = releaseRows(await database.execute(sql`SELECT attempt_id FROM factory_executions WHERE attempt_id=${authority.attemptId} AND tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND node_instance_id=${authority.nodeInstanceId} AND candidate_generation=${authority.candidateGeneration} AND attempt_number=${authority.attemptNumber} AND grant_revision=${authority.grantRevision} AND reservation_generation=${authority.reservationGeneration} AND execution_epoch=${authority.executionEpoch} AND cancellation_epoch=${authority.cancellationEpoch} AND request_hash=${authority.requestDigest} FOR UPDATE`));
    if (!stored.length) throw new Error("Factory attempt is unavailable to this tenant.");
  }

  private async lockRunFence(database: MigrationDb, authority: FactoryAttemptAuthority): Promise<void> {
    // Every Factory product transaction follows this order. Project authority
    // comes first, then the installation epoch, then the run; rows below a
    // run (lifecycle, budget, journal) are locked only after this fence.
    const installation = await lockFactoryScope(database, authority.tenantId, authority.projectId);
    if (installation?.executionEpoch !== authority.executionEpoch) throw new Error("Factory run epoch is stale or unavailable.");
    const run = releaseRows(await database.execute(sql`SELECT run_id FROM factory_runs WHERE tenant_id=${authority.tenantId} AND project_id=${authority.projectId} AND run_id=${authority.runId} AND execution_epoch=${authority.executionEpoch} FOR UPDATE`));
    if (!run.length) throw new Error("Factory run epoch is stale or unavailable.");
  }

}
