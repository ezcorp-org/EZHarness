import { sql } from "drizzle-orm";
import { canonicalJson, assertJson } from "@ezcorp/extension-contract";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { digestObject } from "../extensions/v4/blobs";

export interface FactoryRunKey {
  readonly projectId: string;
  readonly runId: string;
}

export interface FactoryRunRequest extends FactoryRunKey {
  readonly definitionDigest: string;
  readonly interpreterBuild: string;
  readonly executionEpoch: number;
  readonly input: unknown;
  readonly principalId: string;
}

export interface FactoryAuditInput extends FactoryRunKey {
  readonly interpreterId: string;
  readonly sourceSequence: number;
  readonly predecessorDigest: string | null;
  readonly payload: unknown;
}

export interface FactoryAuditBatch extends FactoryAuditInput {
  readonly tenantId: string;
  readonly sequence: number;
  readonly digest: string;
}

export interface FactoryProjection {
  readonly sequence: number;
  readonly digest: string;
  readonly payload: unknown;
}

export class FactoryRecordError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FactoryRecordError";
  }
}

function identity(...values: readonly string[]): void {
  if (values.some((value) => typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0"))) throw new FactoryRecordError("factory_identity_invalid");
}

function positive(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new FactoryRecordError("factory_sequence_invalid");
}

function boundedPayload(value: unknown): string {
  assertJson(value);
  const payload = canonicalJson(value);
  if (new TextEncoder().encode(payload).byteLength > 64 * 1024) throw new FactoryRecordError("factory_payload_too_large");
  return payload;
}

function auditId(tenantId: string, projectId: string, runId: string, kind: string, identity: unknown): string {
  return `factory:${digestObject({ tenantId, projectId, runId, kind, identity })}`;
}

type AuditRow = { interpreter_id: string; source_sequence: string | number; sequence: string | number; predecessor_digest: string | null; digest: string; payload: string };

function batchFromRow(tenantId: string, key: FactoryRunKey, row: AuditRow): FactoryAuditBatch {
  const input = { tenantId, projectId: key.projectId, runId: key.runId, interpreterId: row.interpreter_id, sourceSequence: Number(row.source_sequence), predecessorDigest: row.predecessor_digest, payload: JSON.parse(row.payload) };
  const sequence = Number(row.sequence);
  positive(input.sourceSequence);
  positive(sequence);
  if (digestObject(input) !== row.digest) throw new FactoryRecordError("factory_audit_corrupt");
  return { ...input, sequence, digest: row.digest };
}

/** Product facts and recoverable projections. This repository does not schedule work. */
export class FactoryRecords {
  constructor(private readonly database: TransactionalDb, readonly tenantId: string) {
    identity(tenantId);
  }

  async bindInstallation(): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`INSERT INTO factory_installation (singleton, tenant_id) VALUES (1, ${this.tenantId}) ON CONFLICT (singleton) DO NOTHING`);
      const installation = rows<{ tenant_id: string }>(await transaction.execute(sql`SELECT tenant_id FROM factory_installation WHERE singleton = 1 FOR UPDATE`))[0]!;
      if (installation.tenant_id !== this.tenantId) throw new FactoryRecordError("factory_installation_mismatch");
    });
  }

  async bindProject(projectId: string): Promise<void> {
    identity(projectId);
    await this.database.execute(sql`INSERT INTO factory_projects (tenant_id, project_id) VALUES (${this.tenantId}, ${projectId}) ON CONFLICT (tenant_id, project_id) DO NOTHING`);
  }

  async createRun(input: FactoryRunRequest, enqueue: (transaction: MigrationDb, request: FactoryRunRequest) => Promise<void>): Promise<{ readonly created: boolean }> {
    const payload = boundedPayload(input);
    const request = JSON.parse(payload) as FactoryRunRequest;
    identity(request.projectId, request.runId, request.interpreterBuild, request.principalId);
    positive(request.executionEpoch);
    if (!/^sha256:[a-f0-9]{64}$/.test(request.definitionDigest)) throw new FactoryRecordError("factory_definition_digest_invalid");
    const digest = digestObject(request);
    return this.database.transaction(async (transaction) => {
      const installation = rows<{ execution_epoch: number }>(await transaction.execute(sql`SELECT execution_epoch FROM factory_installation WHERE tenant_id = ${this.tenantId} FOR UPDATE`))[0];
      if (!installation || installation.execution_epoch !== request.executionEpoch) throw new FactoryRecordError("factory_epoch_changed");
      const inserted = rows(await transaction.execute(sql`INSERT INTO factory_runs
        (tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload)
        VALUES (${this.tenantId}, ${request.projectId}, ${request.runId}, ${request.definitionDigest}, ${request.interpreterBuild}, ${request.executionEpoch}, ${digest}, ${payload})
        ON CONFLICT (tenant_id, project_id, run_id) DO NOTHING RETURNING run_id`));
      if (inserted.length === 0) {
        const existing = rows<{ request_digest: string }>(await transaction.execute(sql`SELECT request_digest FROM factory_runs WHERE tenant_id = ${this.tenantId} AND project_id = ${request.projectId} AND run_id = ${request.runId}`))[0]!;
        if (existing.request_digest !== digest) throw new FactoryRecordError("factory_run_conflict");
        return { created: false };
      }
      await insertTransactionalAuditEntry(transaction, auditId(this.tenantId, request.projectId, request.runId, "start", digest), request.principalId, "factory.run.requested", request.runId, { tenantId: this.tenantId, projectId: request.projectId, definitionDigest: request.definitionDigest, executionEpoch: request.executionEpoch });
      await enqueue(transaction, request);
      return { created: true };
    });
  }

  async appendAudit(request: FactoryAuditInput): Promise<FactoryAuditBatch> {
    const input = JSON.parse(boundedPayload(request)) as FactoryAuditInput;
    identity(input.projectId, input.runId, input.interpreterId);
    positive(input.sourceSequence);
    const payload = boundedPayload(input.payload);
    const digest = digestObject({ tenantId: this.tenantId, ...input });
    return this.database.transaction(async (transaction) => {
      const run = await this.lockRun(transaction, input);
      const existing = rows<AuditRow>(await transaction.execute(sql`SELECT interpreter_id, source_sequence, sequence, predecessor_digest, digest, payload FROM factory_audit_batches
        WHERE tenant_id = ${this.tenantId} AND project_id = ${input.projectId} AND run_id = ${input.runId} AND interpreter_id = ${input.interpreterId} AND source_sequence = ${input.sourceSequence}`))[0];
      if (existing) {
        if (existing.digest !== digest) throw new FactoryRecordError("factory_audit_conflict");
        return batchFromRow(this.tenantId, input, existing);
      }
      const predecessor = rows<{ source_sequence: string | number; digest: string }>(await transaction.execute(sql`SELECT source_sequence, digest FROM factory_audit_batches
        WHERE tenant_id = ${this.tenantId} AND project_id = ${input.projectId} AND run_id = ${input.runId} AND interpreter_id = ${input.interpreterId} ORDER BY source_sequence DESC LIMIT 1`))[0];
      if (input.sourceSequence !== Number(predecessor?.source_sequence ?? 0) + 1 || input.predecessorDigest !== (predecessor?.digest ?? null)) throw new FactoryRecordError("factory_audit_gap");
      const sequence = Number(run.next_sequence);
      positive(sequence);
      positive(sequence + 1);
      await transaction.execute(sql`INSERT INTO factory_audit_batches (tenant_id, project_id, run_id, interpreter_id, source_sequence, sequence, predecessor_digest, digest, payload)
        VALUES (${this.tenantId}, ${input.projectId}, ${input.runId}, ${input.interpreterId}, ${input.sourceSequence}, ${sequence}, ${input.predecessorDigest}, ${digest}, ${payload})`);
      await insertTransactionalAuditEntry(transaction, auditId(this.tenantId, input.projectId, input.runId, "transition", { interpreterId: input.interpreterId, sourceSequence: input.sourceSequence }), null, "factory.run.transition", input.runId, { tenantId: this.tenantId, projectId: input.projectId, digest, sequence });
      await transaction.execute(sql`UPDATE factory_runs SET next_sequence = ${sequence + 1} WHERE tenant_id = ${this.tenantId} AND project_id = ${input.projectId} AND run_id = ${input.runId}`);
      return { tenantId: this.tenantId, ...input, payload: JSON.parse(payload), sequence, digest };
    });
  }

  async readAudit(key: FactoryRunKey, after = 0, limit = 50): Promise<readonly FactoryAuditBatch[]> {
    identity(key.projectId, key.runId);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new FactoryRecordError("factory_page_invalid");
    const result = rows<AuditRow>(await this.database.execute(sql`SELECT interpreter_id, source_sequence, sequence, predecessor_digest, digest, payload FROM factory_audit_batches
      WHERE tenant_id = ${this.tenantId} AND project_id = ${key.projectId} AND run_id = ${key.runId} AND sequence > ${after} ORDER BY sequence LIMIT ${limit}`));
    return result.map((row) => batchFromRow(this.tenantId, key, row));
  }

  async project(request: FactoryAuditBatch, consumerId: string, reduce: (current: unknown, batch: FactoryAuditBatch) => unknown): Promise<FactoryProjection> {
    const batch = JSON.parse(boundedPayload(request)) as FactoryAuditBatch;
    identity(batch.projectId, batch.runId, consumerId);
    positive(batch.sequence);
    if (batch.tenantId !== this.tenantId) throw new FactoryRecordError("factory_scope_mismatch");
    return this.database.transaction(async (transaction) => {
      await this.lockRun(transaction, batch);
      const source = rows<AuditRow>(await transaction.execute(sql`SELECT interpreter_id, source_sequence, sequence, predecessor_digest, digest, payload FROM factory_audit_batches
        WHERE tenant_id = ${this.tenantId} AND project_id = ${batch.projectId} AND run_id = ${batch.runId} AND sequence = ${batch.sequence}`))[0];
      if (!source || source.digest !== batch.digest || canonicalJson(batchFromRow(this.tenantId, batch, source)) !== canonicalJson(batch)) throw new FactoryRecordError("factory_projection_source_conflict");
      const current = rows<{ sequence: string | number; digest: string; payload: string }>(await transaction.execute(sql`SELECT sequence, digest, payload FROM factory_run_projections
        WHERE tenant_id = ${this.tenantId} AND project_id = ${batch.projectId} AND run_id = ${batch.runId} AND consumer_id = ${consumerId}`))[0];
      if (current && Number(current.sequence) >= batch.sequence) return { sequence: Number(current.sequence), digest: current.digest, payload: JSON.parse(current.payload) };
      if (batch.sequence !== Number(current?.sequence ?? 0) + 1) throw new FactoryRecordError("factory_projection_gap");
      const payload = boundedPayload(reduce(current ? JSON.parse(current.payload) : null, batch));
      await transaction.execute(sql`INSERT INTO factory_run_projections (tenant_id, project_id, run_id, consumer_id, sequence, digest, payload)
        VALUES (${this.tenantId}, ${batch.projectId}, ${batch.runId}, ${consumerId}, ${batch.sequence}, ${batch.digest}, ${payload})
        ON CONFLICT (tenant_id, project_id, run_id, consumer_id) DO UPDATE SET sequence = EXCLUDED.sequence, digest = EXCLUDED.digest, payload = EXCLUDED.payload, updated_at = NOW()`);
      return { sequence: batch.sequence, digest: batch.digest, payload: JSON.parse(payload) };
    });
  }

  private async lockRun(transaction: MigrationDb, key: FactoryRunKey): Promise<{ next_sequence: string | number }> {
    const run = rows<{ next_sequence: string | number }>(await transaction.execute(sql`SELECT next_sequence FROM factory_runs WHERE tenant_id = ${this.tenantId} AND project_id = ${key.projectId} AND run_id = ${key.runId} FOR UPDATE`))[0];
    if (!run) throw new FactoryRecordError("factory_run_not_found");
    return run;
  }
}
