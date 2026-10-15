import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { digestBytes, digestObject } from "../../extensions/v4/blobs";
import { FACTORY_CANDIDATE_OUTPUT_MAX_BYTES, type FactoryArtifacts } from "../artifacts";
import { assertFactoryIdentity, encodeFactoryPayload } from "../records";
import { FactoryLegacyWorkflowError, type FactoryLegacyAttemptKey, type FactoryLegacyWorkflows } from "./adapter";

export const LEGACY_WORKFLOW_IMPORT_SCHEMA_VERSION = "factory.legacy-import.v1" as const;

/** The bundled extension whose job store is install-wide and ownerless. */
export const EZ_FACTORY_EXTENSION_NAME = "ez-factory";

/**
 * The key layout of the ownerless ez-factory job store (C10).
 *
 * Mirrored here rather than imported: `extensions/ez-factory` is a bundled
 * v4 extension built into an immutable release, and importing it would pull
 * the whole extension into the host process to read four string constants.
 * `legacy-import-parity.test.ts` reads that module as TEXT and fails if these
 * spellings ever diverge from the ones the extension actually writes.
 *
 * The store lives in the SDK's `global` storage bucket, which has no project
 * dimension at all. That is precisely why nothing under it may ever be
 * surfaced inside a factory project: every installation shares one namespace,
 * so a key that resolved would cross every tenant boundary at once.
 */
export const EZ_FACTORY_JOB_STORE_SCOPE = "global";
export const EZ_FACTORY_JOB_STORE_EXACT_KEYS: readonly string[] = Object.freeze(["meta", "job-index"]);
export const EZ_FACTORY_JOB_STORE_PREFIXES: readonly string[] = Object.freeze(["job:", "run:", "run-index:"]);

/** Whether a name addresses the install-wide, ownerless ez-factory job store. */
export function isEzFactoryJobStoreKey(name: string): boolean {
  return EZ_FACTORY_JOB_STORE_EXACT_KEYS.includes(name)
    || EZ_FACTORY_JOB_STORE_PREFIXES.some(prefix => name.startsWith(prefix));
}

/** A bounded leaf name. No separator, so no path and no traversal. */
const SOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface FactoryLegacyImportSource {
  /** Author-chosen leaf name, unique within the attempt. */
  readonly name: string;
  /** The legacy run that produced it. Must be the one this attempt journaled. */
  readonly legacyRunId: string;
  /** `sha256:` plus 64 hex, as the producer declared it. */
  readonly declaredDigest: string;
  readonly bytes: Uint8Array;
}

export interface FactoryLegacyImportRecord extends FactoryLegacyAttemptKey {
  readonly schemaVersion: typeof LEGACY_WORKFLOW_IMPORT_SCHEMA_VERSION;
  readonly sourceName: string;
  readonly legacyRunId: string;
  readonly declaredDigest: string;
  /** Recomputed from the bytes that were written. Equal to `declaredDigest` by construction. */
  readonly verifiedDigest: string;
  readonly byteCount: number;
  readonly artifact: FactoryArtifactReference;
  readonly importDigest: string;
}

interface ImportRow {
  project_id: string; run_id: string; node_instance_id: string; candidate_generation: number | string; attempt_id: string;
  source_name: string; legacy_run_id: string; declared_digest: string; verified_digest: string;
  byte_count: number | string; object_id: string; import_digest: string;
}

const importColumns = sql.raw("project_id,run_id,node_instance_id,candidate_generation,attempt_id,source_name,legacy_run_id,declared_digest,verified_digest,byte_count,object_id,import_digest");

function importDigestOf(value: Omit<FactoryLegacyImportRecord, "importDigest">): string {
  return `sha256:${digestObject(value)}`;
}

function importRecord(row: ImportRow): FactoryLegacyImportRecord {
  const record: Omit<FactoryLegacyImportRecord, "importDigest"> = {
    schemaVersion: LEGACY_WORKFLOW_IMPORT_SCHEMA_VERSION,
    projectId: row.project_id,
    runId: row.run_id,
    nodeInstanceId: row.node_instance_id,
    candidateGeneration: Number(row.candidate_generation),
    attemptId: row.attempt_id,
    sourceName: row.source_name,
    legacyRunId: row.legacy_run_id,
    declaredDigest: row.declared_digest,
    verifiedDigest: row.verified_digest,
    byteCount: Number(row.byte_count),
    artifact: { artifactId: row.object_id, digest: row.verified_digest, encodedBytes: Number(row.byte_count) },
  };
  const digest = importDigestOf(record);
  if (digest !== row.import_digest) throw new FactoryLegacyWorkflowError("factory_legacy_corrupt");
  return Object.freeze({ ...record, importDigest: digest });
}

/**
 * The one way a legacy output becomes readable inside a factory project.
 *
 * A legacy output and an ez-factory `emit_artifact` file are not factory
 * artifacts. This class makes a recorded copy whose digest is verified on
 * write, from the exact legacy run this attempt journaled, and refuses every
 * other source. There is no path that surfaces the install-wide, ownerless
 * job store: a source name that addresses it is refused by name before any
 * byte is read, and the store has no project dimension to scope it by.
 */
export class FactoryLegacyImports {
  constructor(
    private readonly database: TransactionalDb,
    readonly tenantId: string,
    private readonly journals: FactoryLegacyWorkflows,
    private readonly artifacts: FactoryArtifacts,
  ) {
    assertFactoryIdentity(tenantId);
    if (journals.tenantId !== tenantId || artifacts.tenantId !== tenantId) throw new FactoryLegacyWorkflowError("factory_legacy_scope");
  }

  /**
   * Copies one legacy output into the factory store, by digest.
   *
   * The order is deliberate: refuse the name, prove the source run is the one
   * this attempt started, recompute the digest from the bytes, and only then
   * write. A declared digest is never trusted as the artifact's identity — it
   * is compared against the recomputation and the write uses the latter.
   */
  async importOutput(key: FactoryLegacyAttemptKey, source: FactoryLegacyImportSource): Promise<FactoryLegacyImportRecord> {
    const name = source.name;
    if (!SOURCE_NAME.test(name)) throw new FactoryLegacyWorkflowError("factory_legacy_invalid");
    if (isEzFactoryJobStoreKey(name)) throw new FactoryLegacyWorkflowError("factory_legacy_scope");
    if (!/^sha256:[0-9a-f]{64}$/.test(source.declaredDigest)) throw new FactoryLegacyWorkflowError("factory_legacy_invalid");
    const content = Uint8Array.from(source.bytes);
    if (content.byteLength < 1 || content.byteLength > FACTORY_CANDIDATE_OUTPUT_MAX_BYTES) throw new FactoryLegacyWorkflowError("factory_legacy_invalid");
    const verifiedDigest = `sha256:${digestBytes(content)}`;
    if (verifiedDigest !== source.declaredDigest) throw new FactoryLegacyWorkflowError("factory_legacy_corrupt");
    const journal = await this.journals.read(key);
    if (!journal || journal.legacyRunId === null) throw new FactoryLegacyWorkflowError("factory_legacy_not_found");
    if (journal.legacyRunId !== source.legacyRunId) throw new FactoryLegacyWorkflowError("factory_legacy_scope");

    return this.database.transaction(async transaction => {
      const existing = await this.importInTransaction(transaction, key, name);
      if (existing) {
        if (existing.verifiedDigest !== verifiedDigest) throw new FactoryLegacyWorkflowError("factory_legacy_conflict");
        return existing;
      }
      const artifact = await this.artifacts.stageCandidateOutputInTransaction(
        transaction,
        { tenantId: this.tenantId, projectId: key.projectId, logicalRunId: key.runId },
        `${key.nodeInstanceId}/legacy/${name}`,
        key.candidateGeneration,
        content,
      );
      const record: Omit<FactoryLegacyImportRecord, "importDigest"> = {
        schemaVersion: LEGACY_WORKFLOW_IMPORT_SCHEMA_VERSION,
        projectId: key.projectId,
        runId: key.runId,
        nodeInstanceId: key.nodeInstanceId,
        candidateGeneration: key.candidateGeneration,
        attemptId: key.attemptId,
        sourceName: name,
        legacyRunId: source.legacyRunId,
        declaredDigest: source.declaredDigest,
        verifiedDigest,
        byteCount: content.byteLength,
        artifact,
      };
      const digest = importDigestOf(record);
      await transaction.execute(sql`INSERT INTO factory_legacy_imports (tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_id,source_name,legacy_run_id,declared_digest,verified_digest,byte_count,object_id,import_digest) VALUES (${this.tenantId},${key.projectId},${key.runId},${key.nodeInstanceId},${key.candidateGeneration},${key.attemptId},${name},${source.legacyRunId},${source.declaredDigest},${verifiedDigest},${content.byteLength},${artifact.artifactId},${digest})`);
      return Object.freeze({ ...record, importDigest: digest });
    });
  }

  /** Every recorded copy for one attempt, in name order. */
  async list(key: FactoryLegacyAttemptKey): Promise<readonly FactoryLegacyImportRecord[]> {
    const captured = JSON.parse(encodeFactoryPayload(key)) as FactoryLegacyAttemptKey;
    assertFactoryIdentity(captured.projectId, captured.runId, captured.nodeInstanceId, captured.attemptId);
    const found = rows<ImportRow>(await this.database.execute(sql`SELECT ${importColumns} FROM factory_legacy_imports WHERE tenant_id=${this.tenantId} AND project_id=${captured.projectId} AND run_id=${captured.runId} AND node_instance_id=${captured.nodeInstanceId} AND candidate_generation=${captured.candidateGeneration} AND attempt_id=${captured.attemptId} ORDER BY source_name`));
    return Object.freeze(found.map(importRecord));
  }

  private async importInTransaction(transaction: MigrationDb, key: FactoryLegacyAttemptKey, name: string): Promise<FactoryLegacyImportRecord | null> {
    const found = rows<ImportRow>(await transaction.execute(sql`SELECT ${importColumns} FROM factory_legacy_imports WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND node_instance_id=${key.nodeInstanceId} AND candidate_generation=${key.candidateGeneration} AND attempt_id=${key.attemptId} AND source_name=${name} FOR UPDATE`))[0];
    return found ? importRecord(found) : null;
  }
}
