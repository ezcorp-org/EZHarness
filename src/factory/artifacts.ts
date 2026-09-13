import { FACTORY_PAGE_BYTES_LIMIT } from "@ezcorp/factory-sdk/page-bytes";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@ezcorp/extension-contract";
import { digestBytes, S3BlobStore } from "../extensions/v4/blobs";
import type { BlobStore } from "../extensions/v4/types";
import type { BoundBlobStore } from "./encryption";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows } from "../db/queries/extension-releases";
import { assertFactoryIdentity } from "./records";
import type { FactoryIdentity, ImmutableObjectReference } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";

export const FACTORY_ARTIFACT_MAX_BYTES = FACTORY_PAGE_BYTES_LIMIT;
export const FACTORY_CANDIDATE_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
export type FactoryArtifactKind = "definition_page" | "definition_manifest" | "transition_page" | "transition_manifest" | "execution_manifest" | "partition" | "candidate_output";

export interface FactoryArtifactStageOptions {
  readonly definitionDigest?: string;
  readonly sourceSequence?: number;
  readonly pageIndex?: number;
  /** Exact compiler identity for a partition artifact. */
  readonly partitionId?: string;
  readonly interpreterScoped?: boolean;
  /** Exact runner node/generation slot. Valid only for candidate_output. */
  readonly candidateNodeInstanceId?: string;
  readonly candidateGeneration?: number;
}

type ArtifactRow = { object_id: string; tenant_id: string; project_id: string; run_id: string; interpreter_id: string | null; kind: FactoryArtifactKind; definition_digest: string | null; source_sequence: number | string | null; page_index: number | null; partition_id: string | null; candidate_node_instance_id: string | null; candidate_generation: number | string | null; digest: string; blob_digest: string; storage_version: string; encoded_bytes: number | string };
type FactoryArtifactScope = Pick<FactoryIdentity, "tenantId" | "projectId" | "logicalRunId"> & Partial<Pick<FactoryIdentity, "interpreterId">>;

export class FactoryArtifactError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryArtifactError"; }
}

function digest(raw: string): string { return `sha256:${raw}`; }
function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function text(value: Uint8Array): string { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
function maximumBytes(kind: FactoryArtifactKind): number { return kind === "candidate_output" ? FACTORY_CANDIDATE_OUTPUT_MAX_BYTES : FACTORY_ARTIFACT_MAX_BYTES; }
function bounded(value: Uint8Array, kind: FactoryArtifactKind): void { if (value.byteLength < 1 || value.byteLength > maximumBytes(kind)) throw new FactoryArtifactError("factory_artifact_size_invalid"); }
function sourceSequence(value: number | undefined): number | null { if (value === undefined) return null; if (!Number.isSafeInteger(value) || value < 1) throw new FactoryArtifactError("factory_artifact_identity_invalid"); return value; }
function pageIndex(value: number | undefined): number | null { if (value === undefined) return null; if (!Number.isSafeInteger(value) || value < 0) throw new FactoryArtifactError("factory_artifact_identity_invalid"); return value; }
function identity(value: Pick<FactoryIdentity, "tenantId" | "projectId" | "logicalRunId">): void { assertFactoryIdentity(value.tenantId, value.projectId, value.logicalRunId); }
function reference(row: ArtifactRow): ImmutableObjectReference { return { objectId: row.object_id, digest: row.digest, encodedBytes: Number(row.encoded_bytes) }; }
type ArtifactBlobStore = BlobStore | BoundBlobStore;
function supportsBoundBlobs(value: ArtifactBlobStore): value is BoundBlobStore { return "putBound" in value && "getBound" in value; }
function supportsVersions(value: ArtifactBlobStore): value is BlobStore & { version(digest: string): Promise<string>; getVersion(digest: string, version: string): Promise<Uint8Array> } { return value instanceof S3BlobStore || (!supportsBoundBlobs(value) && "version" in value && "getVersion" in value && typeof value.version === "function" && typeof value.getVersion === "function"); }
function supportsBoundVersions(value: ArtifactBlobStore): value is BoundBlobStore & { version(digest: string): Promise<string>; getVersion(binding: { tenantId: string; objectId: string }, digest: string, version: string): Promise<Uint8Array> } { return supportsBoundBlobs(value) && "version" in value && "getVersion" in value && typeof value.version === "function" && typeof value.getVersion === "function"; }

/** Product-side immutable pointers. Blob digests are never an authorization handle. */
export class FactoryArtifacts {
  constructor(readonly database: TransactionalDb, private readonly blobs: ArtifactBlobStore, private readonly tenantId: string) { assertFactoryIdentity(tenantId); }

  async stage(identityValue: FactoryArtifactScope, kind: FactoryArtifactKind, content: Uint8Array, options: FactoryArtifactStageOptions = {}): Promise<ImmutableObjectReference> {
    const snapshot = { identity: { ...identityValue }, kind, content: Uint8Array.from(content), options: { ...options } };
    return this.database.transaction(transaction => this.stageInTransaction(transaction, snapshot.identity, snapshot.kind, snapshot.content, snapshot.options));
  }

  /** Stages a reference within the caller's durable product transaction. */
  async stageInTransaction(transaction: MigrationDb, identityValue: FactoryArtifactScope, kind: FactoryArtifactKind, content: Uint8Array, options: FactoryArtifactStageOptions = {}): Promise<ImmutableObjectReference> {
    identityValue = { ...identityValue };
    content = Uint8Array.from(content);
    options = { ...options };
    identity(identityValue);
    if (identityValue.tenantId !== this.tenantId) throw new FactoryArtifactError("factory_artifact_tenant_denied");
    bounded(content, kind);
    const sequence = sourceSequence(options.sourceSequence);
    const index = pageIndex(options.pageIndex);
    const partitionId = options.partitionId ?? null;
    if ((kind === "partition") !== (partitionId !== null)) throw new FactoryArtifactError("factory_artifact_identity_invalid");
    if (partitionId !== null) assertFactoryIdentity(partitionId);
    const candidateNodeInstanceId = options.candidateNodeInstanceId ?? null;
    const candidateGeneration = options.candidateGeneration ?? null;
    if ((kind === "candidate_output") !== (candidateNodeInstanceId !== null && candidateGeneration !== null)) throw new FactoryArtifactError("factory_artifact_identity_invalid");
    if (candidateNodeInstanceId !== null) assertFactoryIdentity(candidateNodeInstanceId);
    if (candidateGeneration !== null && (!Number.isSafeInteger(candidateGeneration) || candidateGeneration < 0)) throw new FactoryArtifactError("factory_artifact_identity_invalid");
    const interpreterId = options.interpreterScoped === false ? null : identityValue.interpreterId ?? null;
    if (options.interpreterScoped !== false && interpreterId === null) throw new FactoryArtifactError("factory_artifact_identity_invalid");
    if (interpreterId !== null) assertFactoryIdentity(interpreterId);
    const rawDigest = digestBytes(content);
    const artifactDigest = digest(rawDigest);
    if (options.definitionDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(options.definitionDigest)) throw new FactoryArtifactError("factory_artifact_digest_invalid");
    const existing = releaseRows<ArtifactRow>(await transaction.execute(sql`SELECT object_id, tenant_id, project_id, run_id, interpreter_id, kind, definition_digest, source_sequence, page_index, partition_id, candidate_node_instance_id, candidate_generation, digest, blob_digest, storage_version, encoded_bytes FROM factory_artifacts WHERE tenant_id=${identityValue.tenantId} AND project_id=${identityValue.projectId} AND run_id=${identityValue.logicalRunId} AND interpreter_id IS NOT DISTINCT FROM ${interpreterId} AND kind=${kind} AND source_sequence IS NOT DISTINCT FROM ${sequence} AND page_index IS NOT DISTINCT FROM ${index} AND partition_id IS NOT DISTINCT FROM ${partitionId} AND candidate_node_instance_id IS NOT DISTINCT FROM ${candidateNodeInstanceId} AND candidate_generation IS NOT DISTINCT FROM ${candidateGeneration} FOR SHARE`))[0];
    if (existing) {
      if (existing.digest !== artifactDigest || existing.definition_digest !== (options.definitionDigest ?? null) || existing.partition_id !== partitionId || Number(existing.encoded_bytes) !== content.byteLength) throw new FactoryArtifactError("factory_artifact_conflict");
      await this.verify(existing);
      return reference(existing);
    }
    const objectId = `factory-artifact-${randomUUID()}`;
    const stored = supportsBoundBlobs(this.blobs)
      ? await this.blobs.putBound({ tenantId: identityValue.tenantId, objectId }, content)
      : await this.blobs.put(content);
    if (!/^[a-f0-9]{64}$/.test(stored)) throw new FactoryArtifactError("factory_artifact_corrupt");
    const storageVersion = supportsBoundVersions(this.blobs) ? await this.blobs.version(stored) : supportsVersions(this.blobs) ? await this.blobs.version(stored) : stored;
    const row: ArtifactRow = { object_id: objectId, tenant_id: identityValue.tenantId, project_id: identityValue.projectId, run_id: identityValue.logicalRunId, interpreter_id: interpreterId, kind, definition_digest: options.definitionDigest ?? null, source_sequence: sequence, page_index: index, partition_id: partitionId, candidate_node_instance_id: candidateNodeInstanceId, candidate_generation: candidateGeneration, digest: artifactDigest, blob_digest: stored, storage_version: storageVersion, encoded_bytes: content.byteLength };
    await transaction.execute(sql`INSERT INTO factory_artifacts(object_id, tenant_id, project_id, run_id, interpreter_id, kind, definition_digest, source_sequence, page_index, partition_id, candidate_node_instance_id, candidate_generation, digest, blob_digest, storage_version, encoded_bytes) VALUES (${row.object_id}, ${row.tenant_id}, ${row.project_id}, ${row.run_id}, ${row.interpreter_id}, ${row.kind}, ${row.definition_digest}, ${row.source_sequence}, ${row.page_index}, ${row.partition_id}, ${row.candidate_node_instance_id}, ${row.candidate_generation}, ${row.digest}, ${row.blob_digest}, ${row.storage_version}, ${row.encoded_bytes}) ON CONFLICT DO NOTHING`);
    const admitted = releaseRows<ArtifactRow>(await transaction.execute(sql`SELECT object_id, tenant_id, project_id, run_id, interpreter_id, kind, definition_digest, source_sequence, page_index, partition_id, candidate_node_instance_id, candidate_generation, digest, blob_digest, storage_version, encoded_bytes FROM factory_artifacts WHERE tenant_id=${identityValue.tenantId} AND project_id=${identityValue.projectId} AND run_id=${identityValue.logicalRunId} AND interpreter_id IS NOT DISTINCT FROM ${interpreterId} AND kind=${kind} AND source_sequence IS NOT DISTINCT FROM ${sequence} AND page_index IS NOT DISTINCT FROM ${index} AND partition_id IS NOT DISTINCT FROM ${partitionId} AND candidate_node_instance_id IS NOT DISTINCT FROM ${candidateNodeInstanceId} AND candidate_generation IS NOT DISTINCT FROM ${candidateGeneration} FOR SHARE`))[0];
    if (!admitted) throw new FactoryArtifactError("factory_artifact_admission_failed");
    if (admitted.digest !== artifactDigest || admitted.definition_digest !== (options.definitionDigest ?? null) || admitted.partition_id !== partitionId || Number(admitted.encoded_bytes) !== content.byteLength) throw new FactoryArtifactError("factory_artifact_conflict");
    return reference(admitted);
  }

  async load(identityValue: FactoryArtifactScope, object: ImmutableObjectReference, kinds: readonly FactoryArtifactKind[], interpreterScoped = false): Promise<{ reference: ImmutableObjectReference; kind: FactoryArtifactKind; definitionDigest: string | null; sourceSequence: number | null; pageIndex: number | null; candidateNodeInstanceId: string | null; candidateGeneration: number | null; content: Uint8Array }> {
    const identitySnapshot = { ...identityValue };
    const objectSnapshot = { ...object };
    const kindsSnapshot = [...kinds];
    return this.database.transaction(transaction => this.loadInTransaction(transaction, identitySnapshot, objectSnapshot, kindsSnapshot, interpreterScoped));
  }

  /** Reads and digest-verifies a reference while the caller holds its product locks. */
  async loadInTransaction(transaction: MigrationDb, identityValue: FactoryArtifactScope, object: ImmutableObjectReference, kinds: readonly FactoryArtifactKind[], interpreterScoped = false): Promise<{ reference: ImmutableObjectReference; kind: FactoryArtifactKind; definitionDigest: string | null; sourceSequence: number | null; pageIndex: number | null; candidateNodeInstanceId: string | null; candidateGeneration: number | null; content: Uint8Array }> {
    identityValue = { ...identityValue };
    object = { ...object };
    kinds = [...kinds];
    identity(identityValue);
    if (identityValue.tenantId !== this.tenantId) throw new FactoryArtifactError("factory_artifact_tenant_denied");
    if (!object?.objectId || !/^sha256:[0-9a-f]{64}$/.test(object.digest) || !Number.isSafeInteger(object.encodedBytes) || object.encodedBytes < 1 || object.encodedBytes > FACTORY_CANDIDATE_OUTPUT_MAX_BYTES) throw new FactoryArtifactError("factory_artifact_reference_invalid");
    const row = releaseRows<ArtifactRow>(await transaction.execute(sql`SELECT object_id, tenant_id, project_id, run_id, interpreter_id, kind, definition_digest, source_sequence, page_index, partition_id, candidate_node_instance_id, candidate_generation, digest, blob_digest, storage_version, encoded_bytes FROM factory_artifacts WHERE object_id=${object.objectId} AND tenant_id=${identityValue.tenantId} AND project_id=${identityValue.projectId} AND run_id=${identityValue.logicalRunId} ${interpreterScoped ? sql`AND interpreter_id=${identityValue.interpreterId}` : sql``} FOR SHARE`))[0];
    if (!row || !kinds.includes(row.kind) || row.digest !== object.digest || Number(row.encoded_bytes) !== object.encodedBytes || object.encodedBytes > maximumBytes(row.kind)) throw new FactoryArtifactError("factory_artifact_not_found");
    const content = await this.verify(row);
    return { reference: reference(row), kind: row.kind, definitionDigest: row.definition_digest, sourceSequence: row.source_sequence === null ? null : Number(row.source_sequence), pageIndex: row.page_index, candidateNodeInstanceId: row.candidate_node_instance_id, candidateGeneration: row.candidate_generation === null ? null : Number(row.candidate_generation), content };
  }

  /** Stages one canonical runner output for an exact candidate generation. */
  async stageCandidateOutputInTransaction(transaction: MigrationDb, identityValue: FactoryArtifactScope, nodeInstanceId: string, candidateGeneration: number, content: Uint8Array): Promise<FactoryArtifactReference> {
    assertFactoryIdentity(nodeInstanceId);
    if (!Number.isSafeInteger(candidateGeneration) || candidateGeneration < 0) throw new FactoryArtifactError("factory_artifact_identity_invalid");
    const stored = await this.stageInTransaction(transaction, identityValue, "candidate_output", content, { interpreterScoped: false, candidateNodeInstanceId: nodeInstanceId, candidateGeneration });
    return { artifactId: stored.objectId, digest: stored.digest, encodedBytes: stored.encodedBytes };
  }

  private async verify(row: ArtifactRow): Promise<Uint8Array> {
    if (!/^sha256:[a-f0-9]{64}$/.test(row.digest) || !row.storage_version || !Number.isSafeInteger(Number(row.encoded_bytes))) throw new FactoryArtifactError("factory_artifact_corrupt");
    const content = supportsBoundBlobs(this.blobs)
      ? (supportsBoundVersions(this.blobs) ? await this.blobs.getVersion({ tenantId: row.tenant_id, objectId: row.object_id }, row.blob_digest, row.storage_version) : await this.blobs.getBound({ tenantId: row.tenant_id, objectId: row.object_id }, row.blob_digest))
      : (supportsVersions(this.blobs) ? await this.blobs.getVersion(row.blob_digest, row.storage_version) : await this.blobs.get(row.blob_digest));
    if (content.byteLength !== Number(row.encoded_bytes) || digestBytes(content) !== row.digest.slice("sha256:".length)) throw new FactoryArtifactError("factory_artifact_corrupt");
    return content;
  }
}

export const artifactJson = { bytes, text, canonical: (value: unknown) => bytes(canonicalJson(value)) };
