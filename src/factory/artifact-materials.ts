import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import { FACTORY_PAGE_BYTES_LIMIT } from "@ezcorp/factory-sdk/page-bytes";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestBytes, digestObject, S3BlobStore } from "../extensions/v4/blobs";
import type { BlobStore } from "../extensions/v4/types";
import { relativePath } from "../../packages/@ezcorp/extension-runner/src/core";
import type { FactoryArtifacts } from "./artifacts";
import type { BoundBlobStore } from "./encryption";
import type { FactoryAttemptAuthority, FactoryExecutionJournal } from "./executions";
import { assertFactoryIdentity } from "./records";

/**
 * Auxiliary immutable material records that live beside the terminal candidate
 * artifact. Chunks move over the private gateway envelope, never inside a
 * Temporal argument, so the C08 payload and recorded-page limits are unaffected.
 */
export const FACTORY_MATERIAL_LIMITS = Object.freeze({
  maxChunkBytes: 8 * 1024 * 1024,
  maxChunks: 64,
  maxTotalBytes: 256 * 1024 * 1024,
  maxObjectsPerOperation: 256,
  maxNameLength: 512,
});

/** The shared 16 MiB ceiling every artifact reference path already used. */
export const FACTORY_ARTIFACT_SHARED_MAX_BYTES = 16 * 1024 * 1024;

/** A material manifest is an ordinary bounded artifact page. */
export const FACTORY_MATERIAL_MANIFEST_MAX_BYTES = FACTORY_PAGE_BYTES_LIMIT;

export const FACTORY_MATERIAL_SCHEMA_VERSION = "factory.material.v1";
export const FACTORY_MATERIAL_MANIFEST_SCHEMA_VERSION = "factory.material-manifest.v1";
/** Reserved object-name prefix for C02 copy-on-write workspace checkpoints. */
export const FACTORY_WORKSPACE_MATERIAL_PREFIX = "workspace/";

export interface FactoryMaterialScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly operationId: string;
}

export interface FactoryMaterialIdentity extends FactoryMaterialScope {
  /** Author-chosen stable name, unique within the scope. */
  readonly objectName: string;
  /** Monotonic per (scope, objectName). Starts at 1. */
  readonly version: number;
}

export interface FactoryMaterialChunk {
  /** 0-based and contiguous. */
  readonly index: number;
  readonly digest: string;
  readonly encodedBytes: number;
}

export interface FactoryMaterialRecord extends FactoryMaterialIdentity {
  readonly schemaVersion: "factory.material.v1";
  readonly mediaType: string;
  /** `sha256:` + 64 hex over the assembled bytes. */
  readonly digest: string;
  readonly totalBytes: number;
  readonly chunkCount: number;
  readonly storageVersion: string;
  readonly sealed: boolean;
  readonly createdAtMs: number;
  /** Present only after seal. */
  readonly artifact?: FactoryArtifactReference;
}

export interface FactoryMaterialService {
  /** Commits the operation row before any upload. */
  begin(identity: FactoryMaterialIdentity, mediaType: string, totalBytes: number, chunkCount: number, signal?: AbortSignal): Promise<FactoryMaterialRecord>;
  writeChunk(identity: FactoryMaterialIdentity, chunk: FactoryMaterialChunk, content: Uint8Array, signal?: AbortSignal): Promise<FactoryMaterialRecord>;
  /** Verifies the assembled digest, then issues the immutable handle. */
  seal(identity: FactoryMaterialIdentity, digest: string, signal?: AbortSignal): Promise<FactoryArtifactReference>;
  list(scope: FactoryMaterialScope, signal?: AbortSignal): Promise<readonly FactoryMaterialRecord[]>;
}

/** The one reader for validators, release profiles, and previews. */
export interface FactoryScopedArtifactReader {
  read(scope: FactoryMaterialScope, artifactReference: FactoryArtifactReference, signal?: AbortSignal): Promise<Uint8Array>;
  readChunk(scope: FactoryMaterialScope, artifactReference: FactoryArtifactReference, index: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/**
 * Shared artifact denial. Every cross-scope, missing, and corrupt outcome funnels
 * to one code so a reader cannot learn whether an object exists.
 */
export class FactoryArtifactAccessError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FactoryArtifactAccessError";
  }
}

export function unavailable(): never { throw new FactoryArtifactAccessError("factory_artifact_unavailable"); }

export class FactoryMaterialError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FactoryMaterialError";
  }
}

/**
 * One object-store adapter for every factory artifact and material byte. The
 * shared v4 `BlobStore` keeps plaintext content digests, the encrypted bound
 * store adds an object binding, and an S3-backed store adds an immutable
 * version. Each caller would otherwise repeat the same four-way branch.
 */
export type FactoryArtifactBlobStore = BlobStore | BoundBlobStore;

export interface FactoryArtifactBlobBinding {
  readonly tenantId: string;
  readonly objectId: string;
}

export interface FactoryStoredBlob {
  /** Raw lowercase hex, never the `sha256:` namespace an artifact digest uses. */
  readonly blobDigest: string;
  readonly storageVersion: string;
}

type VersionedBlobStore = BlobStore & { version(digest: string): Promise<string>; getVersion(digest: string, version: string): Promise<Uint8Array> };
type VersionedBoundBlobStore = BoundBlobStore & { version(digest: string): Promise<string>; getVersion(binding: FactoryArtifactBlobBinding, digest: string, version: string): Promise<Uint8Array> };

export function supportsBoundBlobs(value: FactoryArtifactBlobStore): value is BoundBlobStore { return "putBound" in value && "getBound" in value; }
function supportsVersions(value: FactoryArtifactBlobStore): value is VersionedBlobStore { return value instanceof S3BlobStore || (!supportsBoundBlobs(value) && "version" in value && "getVersion" in value && typeof value.version === "function" && typeof value.getVersion === "function"); }
function supportsBoundVersions(value: FactoryArtifactBlobStore): value is VersionedBoundBlobStore { return supportsBoundBlobs(value) && "version" in value && "getVersion" in value && typeof value.version === "function" && typeof value.getVersion === "function"; }

/** Stores bytes and returns the exact durable identity a later read must quote. */
export async function putFactoryArtifactBlob(blobs: FactoryArtifactBlobStore, binding: FactoryArtifactBlobBinding, content: Uint8Array): Promise<FactoryStoredBlob> {
  const blobDigest = supportsBoundBlobs(blobs) ? await blobs.putBound(binding, content) : await blobs.put(content);
  if (!/^[a-f0-9]{64}$/.test(blobDigest)) throw new FactoryMaterialError("factory_artifact_blob_corrupt");
  const storageVersion = supportsBoundVersions(blobs) || supportsVersions(blobs) ? await blobs.version(blobDigest) : blobDigest;
  return Object.freeze({ blobDigest, storageVersion });
}

/** Reads the exact stored object version. The caller still verifies its digest. */
export async function getFactoryArtifactBlob(blobs: FactoryArtifactBlobStore, binding: FactoryArtifactBlobBinding, stored: FactoryStoredBlob): Promise<Uint8Array> {
  if (supportsBoundVersions(blobs)) return blobs.getVersion(binding, stored.blobDigest, stored.storageVersion);
  if (supportsBoundBlobs(blobs)) return blobs.getBound(binding, stored.blobDigest);
  if (supportsVersions(blobs)) return blobs.getVersion(stored.blobDigest, stored.storageVersion);
  return blobs.get(stored.blobDigest);
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u;

/**
 * The one artifact-reference validator. It replaces the three near-identical
 * copies that `artifacts.ts`, `artifact-access.ts`, and `input-artifacts.ts`
 * each carried with a different constant and a different digest regex.
 */
export function assertFactoryArtifactReference(value: FactoryArtifactReference, maximumBytes: number): FactoryArtifactReference {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new FactoryMaterialError("factory_artifact_reference_invalid");
  if (!value || typeof value.artifactId !== "string" || typeof value.digest !== "string" || !DIGEST.test(value.digest)
    || !Number.isSafeInteger(value.encodedBytes) || value.encodedBytes < 1 || value.encodedBytes > maximumBytes) throw new FactoryMaterialError("factory_artifact_reference_invalid");
  try { assertFactoryIdentity(value.artifactId); }
  catch { throw new FactoryMaterialError("factory_artifact_reference_invalid"); }
  return Object.freeze({ artifactId: value.artifactId, digest: value.digest, encodedBytes: value.encodedBytes });
}

/** The one artifact media-type grammar, shared with cross-project read grants. */
export function isFactoryArtifactMediaType(value: unknown): value is string { return typeof value === "string" && MEDIA_TYPE.test(value); }

export function assertFactoryMaterialMediaType(value: unknown): string {
  if (!isFactoryArtifactMediaType(value)) throw new FactoryMaterialError("factory_material_media_type_invalid");
  return value;
}

/**
 * Object names are bounded relative paths, so an archive or code tree stored as
 * named objects cannot carry an entry that traverses outside its root. The
 * traversal rule is the v4 dependency fetcher's; only the bound is ours.
 */
export function assertFactoryMaterialName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > FACTORY_MATERIAL_LIMITS.maxNameLength) throw new FactoryMaterialError("factory_material_name_invalid");
  try { relativePath(value); }
  catch { throw new FactoryMaterialError("factory_material_name_invalid"); }
  return value;
}

/** A material digest is always the namespaced hash of the assembled bytes. */
export function factoryMaterialDigest(content: Uint8Array): string { return `sha256:${digestBytes(content)}`; }

export function assertFactoryMaterialDigest(value: unknown): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new FactoryMaterialError("factory_material_digest_invalid");
  return value;
}

/** Copies caller identity before any await can observe a later mutation. */
export function snapshotFactoryMaterialScope(value: FactoryMaterialScope): FactoryMaterialScope {
  try { assertFactoryIdentity(value.tenantId, value.projectId, value.runId, value.attemptId, value.operationId); }
  catch { throw new FactoryMaterialError("factory_material_scope_invalid"); }
  return Object.freeze({ tenantId: value.tenantId, projectId: value.projectId, runId: value.runId, attemptId: value.attemptId, operationId: value.operationId });
}

export function snapshotFactoryMaterialIdentity(value: FactoryMaterialIdentity): FactoryMaterialIdentity {
  const scope = snapshotFactoryMaterialScope(value);
  if (!Number.isSafeInteger(value.version) || value.version < 1) throw new FactoryMaterialError("factory_material_version_invalid");
  return Object.freeze({ ...scope, objectName: assertFactoryMaterialName(value.objectName), version: value.version });
}

/**
 * Distinguishes one material from every other artifact of the same run. The
 * shared admission index keys artifacts by their identity dimensions and a
 * material fills none of the page, partition, or candidate slots, so it carries
 * its own bounded dimension instead.
 */
export function factoryMaterialKey(identity: FactoryMaterialIdentity): string {
  return `sha256:${digestObject({ attemptId: identity.attemptId, operationId: identity.operationId, objectName: identity.objectName, version: identity.version })}`;
}


/** Reserved values for a material that has begun but has no assembled bytes yet. */
export const FACTORY_MATERIAL_UNSEALED = Object.freeze({ digest: `sha256:${"0".repeat(64)}`, storageVersion: "pending" });

/**
 * One material row joined to its sealed manifest artifact. The artifact row
 * stays authoritative for the handle's digest and byte count, so no fact is
 * stored twice.
 */
const MATERIAL_SELECT = sql`SELECT material.tenant_id, material.project_id, material.run_id, material.attempt_id, material.operation_id,
  material.object_name, material.version, material.media_type, material.digest, material.total_bytes, material.chunk_count,
  material.storage_version, material.sealed, material.object_id, material.created_at,
  artifact.digest AS artifact_digest, artifact.encoded_bytes AS artifact_bytes, artifact.kind AS artifact_kind, artifact.storage_version AS artifact_storage_version
  FROM factory_artifact_materials AS material
  LEFT JOIN factory_artifacts AS artifact
    ON artifact.tenant_id = material.tenant_id AND artifact.project_id = material.project_id AND artifact.object_id = material.object_id`;

type MaterialRow = {
  tenant_id: string; project_id: string; run_id: string; attempt_id: string; operation_id: string;
  object_name: string; version: number | string; media_type: string; digest: string;
  total_bytes: number | string; chunk_count: number | string; storage_version: string;
  sealed: boolean; object_id: string | null; created_at: Date | string;
  artifact_digest: string | null; artifact_bytes: number | string | null; artifact_kind: string | null; artifact_storage_version: string | null;
};
const CHUNK_SELECT = sql`chunk_index, chunk_digest, encoded_bytes, blob_digest, storage_version`;

type ChunkRow = { chunk_index: number | string; chunk_digest: string; encoded_bytes: number | string; blob_digest: string; storage_version: string };

function counter(value: number | string | null): number {
  if (value === null || value === undefined || value === "") throw new FactoryMaterialError("factory_material_corrupt");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new FactoryMaterialError("factory_material_corrupt");
  return parsed;
}

function materialRecord(row: MaterialRow): FactoryMaterialRecord {
  const createdAtMs = new Date(row.created_at).getTime();
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) throw new FactoryMaterialError("factory_material_corrupt");
  if (row.sealed !== (row.object_id !== null)) throw new FactoryMaterialError("factory_material_corrupt");
  const artifact = row.object_id === null ? undefined
    : assertFactoryArtifactReference({ artifactId: row.object_id, digest: row.artifact_digest ?? "", encodedBytes: counter(row.artifact_bytes) }, FACTORY_ARTIFACT_SHARED_MAX_BYTES);
  if (row.object_id !== null && (row.artifact_kind !== "material" || row.storage_version !== row.artifact_storage_version)) throw new FactoryMaterialError("factory_material_corrupt");
  return Object.freeze({
    schemaVersion: FACTORY_MATERIAL_SCHEMA_VERSION, tenantId: row.tenant_id, projectId: row.project_id, runId: row.run_id,
    attemptId: row.attempt_id, operationId: row.operation_id, objectName: row.object_name, version: counter(row.version),
    mediaType: assertFactoryMaterialMediaType(row.media_type), digest: assertFactoryMaterialDigest(row.digest),
    totalBytes: counter(row.total_bytes), chunkCount: counter(row.chunk_count), storageVersion: row.storage_version,
    sealed: row.sealed, createdAtMs, ...(artifact === undefined ? {} : { artifact }),
  });
}

function chunkFact(row: ChunkRow): FactoryMaterialChunkFact {
  return Object.freeze({ index: counter(row.chunk_index), digest: assertFactoryMaterialDigest(row.chunk_digest), encodedBytes: counter(row.encoded_bytes), blobDigest: row.blob_digest, storageVersion: row.storage_version });
}

/** The blob binding for one chunk, derived from identity so no column stores it. */
export function factoryMaterialChunkObjectId(identity: FactoryMaterialIdentity, index: number): string {
  return `factory-material-chunk-${factoryMaterialKey(identity).slice("sha256:".length)}-${index}`;
}

function assertMaterialPlan(totalBytes: number, chunkCount: number): void {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > FACTORY_MATERIAL_LIMITS.maxTotalBytes) throw new FactoryMaterialError("factory_material_bytes_invalid");
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > FACTORY_MATERIAL_LIMITS.maxChunks) throw new FactoryMaterialError("factory_material_chunk_count_invalid");
  if (chunkCount > totalBytes || chunkCount * FACTORY_MATERIAL_LIMITS.maxChunkBytes < totalBytes) throw new FactoryMaterialError("factory_material_chunk_count_invalid");
}

function assertChunkInput(chunk: FactoryMaterialChunk, chunkCount: number, content: Uint8Array): FactoryMaterialChunk {
  if (!Number.isSafeInteger(chunk.index) || chunk.index < 0 || chunk.index >= chunkCount) throw new FactoryMaterialError("factory_material_chunk_index_invalid");
  if (content.byteLength < 1 || content.byteLength > FACTORY_MATERIAL_LIMITS.maxChunkBytes || chunk.encodedBytes !== content.byteLength) throw new FactoryMaterialError("factory_material_chunk_bytes_invalid");
  if (assertFactoryMaterialDigest(chunk.digest) !== factoryMaterialDigest(content)) throw new FactoryMaterialError("factory_material_chunk_digest_mismatch");
  return Object.freeze({ index: chunk.index, digest: chunk.digest, encodedBytes: chunk.encodedBytes });
}

/** The manifest artifact bytes. One format, shaped like the transition manifest. */
export interface FactoryMaterialManifest extends FactoryMaterialIdentity {
  readonly schemaVersion: "factory.material-manifest.v1";
  readonly mediaType: string;
  readonly digest: string;
  readonly totalBytes: number;
  readonly chunks: readonly FactoryMaterialChunk[];
}

export function factoryMaterialManifestBytes(record: FactoryMaterialRecord, chunks: readonly FactoryMaterialChunk[]): Uint8Array {
  const manifest: FactoryMaterialManifest = {
    schemaVersion: FACTORY_MATERIAL_MANIFEST_SCHEMA_VERSION, tenantId: record.tenantId, projectId: record.projectId, runId: record.runId,
    attemptId: record.attemptId, operationId: record.operationId, objectName: record.objectName, version: record.version,
    mediaType: record.mediaType, digest: record.digest, totalBytes: record.totalBytes,
    chunks: chunks.map(chunk => ({ index: chunk.index, digest: chunk.digest, encodedBytes: chunk.encodedBytes })),
  };
  const bytes = new TextEncoder().encode(canonicalJson(manifest));
  if (bytes.byteLength > FACTORY_MATERIAL_MANIFEST_MAX_BYTES) throw new FactoryMaterialError("factory_material_manifest_oversized");
  return bytes;
}

/** Parses manifest bytes and proves they describe exactly the expected material. */
export function parseFactoryMaterialManifest(content: Uint8Array, expected: FactoryMaterialRecord): FactoryMaterialManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)); }
  catch { throw new FactoryMaterialError("factory_material_manifest_invalid"); }
  const manifest = parsed as FactoryMaterialManifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || canonicalJson(manifest) !== new TextDecoder().decode(content)) throw new FactoryMaterialError("factory_material_manifest_invalid");
  if (manifest.schemaVersion !== FACTORY_MATERIAL_MANIFEST_SCHEMA_VERSION || manifest.tenantId !== expected.tenantId || manifest.projectId !== expected.projectId
    || manifest.runId !== expected.runId || manifest.attemptId !== expected.attemptId || manifest.operationId !== expected.operationId
    || manifest.objectName !== expected.objectName || manifest.version !== expected.version || manifest.mediaType !== expected.mediaType
    || manifest.digest !== expected.digest || manifest.totalBytes !== expected.totalBytes
    || !Array.isArray(manifest.chunks) || manifest.chunks.length !== expected.chunkCount) throw new FactoryMaterialError("factory_material_manifest_invalid");
  let total = 0;
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (!chunk || chunk.index !== index || typeof chunk.digest !== "string" || !DIGEST.test(chunk.digest)
      || !Number.isSafeInteger(chunk.encodedBytes) || chunk.encodedBytes < 1 || chunk.encodedBytes > FACTORY_MATERIAL_LIMITS.maxChunkBytes) throw new FactoryMaterialError("factory_material_manifest_invalid");
    total += chunk.encodedBytes;
  }
  if (total !== expected.totalBytes) throw new FactoryMaterialError("factory_material_manifest_invalid");
  return manifest;
}

export interface FactoryMaterialStoreOptions {
  readonly database: TransactionalDb;
  readonly artifacts: FactoryArtifacts;
  readonly blobs: FactoryArtifactBlobStore;
}

/** Shared scope resolution, chunk assembly, and verification. */
abstract class FactoryMaterialStore {
  protected readonly database: TransactionalDb;
  protected readonly artifacts: FactoryArtifacts;
  protected readonly blobs: FactoryArtifactBlobStore;

  constructor(options: FactoryMaterialStoreOptions) {
    if (options.artifacts.database !== options.database) throw new FactoryMaterialError("factory_material_scope_invalid");
    this.database = options.database;
    this.artifacts = options.artifacts;
    this.blobs = options.blobs;
  }

  get tenantId(): string { return this.artifacts.tenantId; }

  protected async materialInTransaction(transaction: MigrationDb, identity: FactoryMaterialIdentity, lock: "share" | "update"): Promise<FactoryMaterialRecord | undefined> {
    const found = rows<MaterialRow>(await transaction.execute(sql`${MATERIAL_SELECT}
      WHERE material.tenant_id=${identity.tenantId} AND material.project_id=${identity.projectId} AND material.run_id=${identity.runId}
        AND material.attempt_id=${identity.attemptId} AND material.operation_id=${identity.operationId}
        AND material.object_name=${identity.objectName} AND material.version=${identity.version}
      ${lock === "update" ? sql`FOR UPDATE OF material` : sql`FOR SHARE OF material`}`));
    return found.length === 1 ? materialRecord(found[0]!) : undefined;
  }

  protected async chunksInTransaction(transaction: MigrationDb, identity: FactoryMaterialIdentity): Promise<readonly FactoryMaterialChunkFact[]> {
    return rows<ChunkRow>(await transaction.execute(sql`SELECT ${CHUNK_SELECT} FROM factory_artifact_material_chunks
      WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND run_id=${identity.runId}
        AND attempt_id=${identity.attemptId} AND operation_id=${identity.operationId}
        AND object_name=${identity.objectName} AND version=${identity.version}
      ORDER BY chunk_index FOR SHARE`)).map(chunkFact);
  }

  /**
   * Reads every chunk of a complete material, proves each stored blob still
   * matches its recorded digest, and proves the assembly matches the record.
   * Seal and read share this one path, so no unverified loader exists.
   */
  protected async assemble(stored: FactoryMaterialRecord, chunks: readonly FactoryMaterialChunkFact[], signal?: AbortSignal): Promise<Uint8Array> {
    if (chunks.length !== stored.chunkCount) throw new FactoryMaterialError("factory_material_incomplete");
    const assembled = new Uint8Array(stored.totalBytes);
    let offset = 0;
    for (const [index, chunk] of chunks.entries()) {
      signal?.throwIfAborted();
      if (chunk.index !== index) throw new FactoryMaterialError("factory_material_incomplete");
      const content = await this.readChunkBytes(stored, chunk);
      if (offset + content.byteLength > assembled.byteLength) throw new FactoryMaterialError("factory_material_bytes_changed");
      assembled.set(content, offset);
      offset += content.byteLength;
    }
    if (offset !== stored.totalBytes) throw new FactoryMaterialError("factory_material_bytes_changed");
    return assembled;
  }

  protected async readChunkBytes(stored: FactoryMaterialRecord, chunk: FactoryMaterialChunkFact): Promise<Uint8Array> {
    const binding = { tenantId: stored.tenantId, objectId: factoryMaterialChunkObjectId(stored, chunk.index) };
    const content = await getFactoryArtifactBlob(this.blobs, binding, chunk);
    if (content.byteLength !== chunk.encodedBytes || factoryMaterialDigest(content) !== chunk.digest) throw new FactoryMaterialError("factory_material_bytes_changed");
    return content;
  }
}

type FactoryMaterialChunkFact = FactoryMaterialChunk & FactoryStoredBlob;
type FactoryChunkPlacement = FactoryMaterialRecord | { readonly material: FactoryMaterialRecord; readonly chunk: FactoryMaterialChunk };
type FactorySealPreparation = { readonly sealed: FactoryArtifactReference } | { readonly material: FactoryMaterialRecord; readonly chunks: readonly FactoryMaterialChunkFact[] };

export interface FactoryAttemptMaterialsOptions extends FactoryMaterialStoreOptions {
  readonly journal: FactoryExecutionJournal;
  /** Verified attempt authority. It never comes from a transport request body. */
  readonly authority: FactoryAttemptAuthority;
}

/**
 * The attempt-authenticated write path. Every call commits its operation row
 * before an upload and rechecks current authority before it issues a handle,
 * so an expired, cancelled, or superseded attempt cannot advance a material.
 */
export class FactoryAttemptMaterials extends FactoryMaterialStore implements FactoryMaterialService {
  private readonly journal: FactoryExecutionJournal;
  private readonly authority: FactoryAttemptAuthority;

  constructor(options: FactoryAttemptMaterialsOptions) {
    super(options);
    if (options.authority.tenantId !== options.artifacts.tenantId) throw new FactoryMaterialError("factory_material_scope_invalid");
    this.journal = options.journal;
    this.authority = options.authority;
  }

  /** The scope this attempt may write. An operation id is the caller's choice. */
  scope(operationId: string): FactoryMaterialScope {
    return snapshotFactoryMaterialScope({ tenantId: this.authority.tenantId, projectId: this.authority.projectId, runId: this.authority.runId, attemptId: this.authority.attemptId, operationId });
  }

  async begin(value: FactoryMaterialIdentity, mediaTypeValue: string, totalBytes: number, chunkCount: number, signal?: AbortSignal): Promise<FactoryMaterialRecord> {
    const identity = this.assertOwnScope(value);
    const mediaType = assertFactoryMaterialMediaType(mediaTypeValue);
    assertMaterialPlan(totalBytes, chunkCount);
    signal?.throwIfAborted();
    return this.database.transaction(async transaction => {
      await this.journal.authorizeMaterialWriteInTransaction(transaction, this.authority);
      const existing = await this.materialInTransaction(transaction, identity, "update");
      if (existing) {
        if (existing.mediaType !== mediaType || existing.totalBytes !== totalBytes || existing.chunkCount !== chunkCount) throw new FactoryMaterialError("factory_material_conflict");
        return existing;
      }
      const latest = rows<{ version: number | string }>(await transaction.execute(sql`SELECT version FROM factory_artifact_materials
        WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND run_id=${identity.runId}
          AND attempt_id=${identity.attemptId} AND operation_id=${identity.operationId} AND object_name=${identity.objectName}
        ORDER BY version DESC LIMIT 1 FOR UPDATE`))[0];
      if (counter(latest?.version ?? 0) + 1 !== identity.version) throw new FactoryMaterialError("factory_material_version_conflict");
      const held = counter(rows<{ count: number | string }>(await transaction.execute(sql`SELECT COUNT(*) AS count FROM factory_artifact_materials
        WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND run_id=${identity.runId}
          AND attempt_id=${identity.attemptId} AND operation_id=${identity.operationId}`))[0]?.count ?? 0);
      if (held >= FACTORY_MATERIAL_LIMITS.maxObjectsPerOperation) throw new FactoryMaterialError("factory_material_operation_full");
      await transaction.execute(sql`INSERT INTO factory_artifact_materials
        (tenant_id, project_id, run_id, attempt_id, operation_id, object_name, version, media_type, digest, total_bytes, chunk_count, storage_version, sealed, object_id)
        VALUES (${identity.tenantId}, ${identity.projectId}, ${identity.runId}, ${identity.attemptId}, ${identity.operationId}, ${identity.objectName}, ${identity.version},
          ${mediaType}, ${FACTORY_MATERIAL_UNSEALED.digest}, ${totalBytes}, ${chunkCount}, ${FACTORY_MATERIAL_UNSEALED.storageVersion}, FALSE, NULL)`);
      const admitted = await this.materialInTransaction(transaction, identity, "update");
      if (!admitted) throw new FactoryMaterialError("factory_material_admission_failed");
      return admitted;
    });
  }

  async writeChunk(value: FactoryMaterialIdentity, chunkValue: FactoryMaterialChunk, contentValue: Uint8Array, signal?: AbortSignal): Promise<FactoryMaterialRecord> {
    const identity = this.assertOwnScope(value);
    const content = Uint8Array.from(contentValue);
    signal?.throwIfAborted();
    const stored = await this.database.transaction<FactoryChunkPlacement>(async transaction => {
      await this.journal.authorizeMaterialWriteInTransaction(transaction, this.authority);
      const material = await this.materialInTransaction(transaction, identity, "update");
      if (!material) throw new FactoryMaterialError("factory_material_not_found");
      if (material.sealed) throw new FactoryMaterialError("factory_material_sealed");
      const chunk = assertChunkInput(chunkValue, material.chunkCount, content);
      const current = rows<ChunkRow>(await transaction.execute(sql`SELECT ${CHUNK_SELECT} FROM factory_artifact_material_chunks
        WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND run_id=${identity.runId}
          AND attempt_id=${identity.attemptId} AND operation_id=${identity.operationId}
          AND object_name=${identity.objectName} AND version=${identity.version} AND chunk_index=${chunk.index} FOR UPDATE`))[0];
      if (current) {
        const fact = chunkFact(current);
        if (fact.digest !== chunk.digest || fact.encodedBytes !== chunk.encodedBytes) throw new FactoryMaterialError("factory_material_chunk_conflict");
        await this.readChunkBytes(material, fact);
        return material;
      }
      return { material, chunk };
    });
    if (!("chunk" in stored)) return stored;
    const { material, chunk } = stored;
    const blob = await putFactoryArtifactBlob(this.blobs, { tenantId: identity.tenantId, objectId: factoryMaterialChunkObjectId(identity, chunk.index) }, content);
    signal?.throwIfAborted();
    return this.database.transaction(async transaction => {
      await this.journal.authorizeMaterialWriteInTransaction(transaction, this.authority);
      const live = await this.materialInTransaction(transaction, identity, "update");
      if (!live || live.sealed || live.chunkCount !== material.chunkCount || live.digest !== material.digest) throw new FactoryMaterialError("factory_material_conflict");
      await transaction.execute(sql`INSERT INTO factory_artifact_material_chunks
        (tenant_id, project_id, run_id, attempt_id, operation_id, object_name, version, chunk_index, chunk_digest, encoded_bytes, blob_digest, storage_version)
        VALUES (${identity.tenantId}, ${identity.projectId}, ${identity.runId}, ${identity.attemptId}, ${identity.operationId}, ${identity.objectName}, ${identity.version},
          ${chunk.index}, ${chunk.digest}, ${chunk.encodedBytes}, ${blob.blobDigest}, ${blob.storageVersion})
        ON CONFLICT DO NOTHING`);
      const committed = rows<ChunkRow>(await transaction.execute(sql`SELECT ${CHUNK_SELECT} FROM factory_artifact_material_chunks
        WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND run_id=${identity.runId}
          AND attempt_id=${identity.attemptId} AND operation_id=${identity.operationId}
          AND object_name=${identity.objectName} AND version=${identity.version} AND chunk_index=${chunk.index} FOR SHARE`))[0];
      if (!committed || chunkFact(committed).digest !== chunk.digest) throw new FactoryMaterialError("factory_material_chunk_conflict");
      await transaction.execute(sql`UPDATE factory_artifact_materials SET updated_at=NOW()
        WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND run_id=${identity.runId}
          AND attempt_id=${identity.attemptId} AND operation_id=${identity.operationId}
          AND object_name=${identity.objectName} AND version=${identity.version}`);
      return live;
    });
  }

  async seal(value: FactoryMaterialIdentity, digestValue: string, signal?: AbortSignal): Promise<FactoryArtifactReference> {
    const identity = this.assertOwnScope(value);
    const digest = assertFactoryMaterialDigest(digestValue);
    if (digest === FACTORY_MATERIAL_UNSEALED.digest) throw new FactoryMaterialError("factory_material_digest_invalid");
    signal?.throwIfAborted();
    const prepared = await this.database.transaction<FactorySealPreparation>(async transaction => {
      await this.journal.authorizeMaterialWriteInTransaction(transaction, this.authority);
      const material = await this.materialInTransaction(transaction, identity, "share");
      if (!material) throw new FactoryMaterialError("factory_material_not_found");
      if (material.sealed) {
        if (material.digest !== digest || material.artifact === undefined) throw new FactoryMaterialError("factory_material_conflict");
        return { sealed: material.artifact };
      }
      const chunks = await this.chunksInTransaction(transaction, identity);
      return { material, chunks };
    });
    if ("sealed" in prepared) return prepared.sealed;
    const { material, chunks } = prepared;
    const assembled = await this.assemble(material, chunks, signal);
    if (factoryMaterialDigest(assembled) !== digest) throw new FactoryMaterialError("factory_material_digest_mismatch");
    const complete: FactoryMaterialRecord = { ...material, digest };
    const manifest = factoryMaterialManifestBytes(complete, chunks);
    signal?.throwIfAborted();
    return this.database.transaction(async transaction => {
      await this.journal.authorizeMaterialWriteInTransaction(transaction, this.authority);
      const live = await this.materialInTransaction(transaction, identity, "update");
      if (!live) throw new FactoryMaterialError("factory_material_not_found");
      if (live.sealed) {
        if (live.digest !== digest || live.artifact === undefined) throw new FactoryMaterialError("factory_material_conflict");
        return live.artifact;
      }
      if (live.chunkCount !== material.chunkCount || live.totalBytes !== material.totalBytes || live.mediaType !== material.mediaType) throw new FactoryMaterialError("factory_material_conflict");
      const object = await this.artifacts.stageInTransaction(transaction, { tenantId: identity.tenantId, projectId: identity.projectId, logicalRunId: identity.runId },
        "material", manifest, { interpreterScoped: false, materialKey: factoryMaterialKey(identity) });
      const objectStorageVersion = rows<{ storage_version: string }>(await transaction.execute(sql`SELECT storage_version FROM factory_artifacts
        WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND object_id=${object.objectId} FOR SHARE`))[0]?.storage_version;
      if (!objectStorageVersion) throw new FactoryMaterialError("factory_material_conflict");
      const updated = rows(await transaction.execute(sql`UPDATE factory_artifact_materials
        SET sealed=TRUE, object_id=${object.objectId}, digest=${digest}, storage_version=${objectStorageVersion}, updated_at=NOW()
        WHERE tenant_id=${identity.tenantId} AND project_id=${identity.projectId} AND run_id=${identity.runId}
          AND attempt_id=${identity.attemptId} AND operation_id=${identity.operationId}
          AND object_name=${identity.objectName} AND version=${identity.version} AND sealed=FALSE RETURNING object_id`));
      if (updated.length !== 1) throw new FactoryMaterialError("factory_material_conflict");
      const committed = await this.materialInTransaction(transaction, identity, "share");
      if (!committed?.artifact || committed.digest !== digest || committed.artifact.artifactId !== object.objectId) throw new FactoryMaterialError("factory_material_conflict");
      return committed.artifact;
    });
  }

  async list(value: FactoryMaterialScope, signal?: AbortSignal): Promise<readonly FactoryMaterialRecord[]> {
    const scope = this.assertOwnScopeOnly(value);
    signal?.throwIfAborted();
    return this.database.transaction(async transaction => {
      await this.journal.authorizeMaterialReadInTransaction(transaction, this.authority);
      return rows<MaterialRow>(await transaction.execute(sql`${MATERIAL_SELECT}
        WHERE material.tenant_id=${scope.tenantId} AND material.project_id=${scope.projectId} AND material.run_id=${scope.runId}
          AND material.attempt_id=${scope.attemptId} AND material.operation_id=${scope.operationId}
        ORDER BY material.object_name, material.version
        LIMIT ${FACTORY_MATERIAL_LIMITS.maxObjectsPerOperation} FOR SHARE OF material`)).map(materialRecord);
    });
  }

  /** Committed chunk facts, so a restarted writer resumes by identity. */
  async chunks(value: FactoryMaterialIdentity, signal?: AbortSignal): Promise<readonly FactoryMaterialChunk[]> {
    const identity = this.assertOwnScope(value);
    signal?.throwIfAborted();
    return this.database.transaction(async transaction => {
      await this.journal.authorizeMaterialReadInTransaction(transaction, this.authority);
      if (!await this.materialInTransaction(transaction, identity, "share")) throw new FactoryMaterialError("factory_material_not_found");
      return (await this.chunksInTransaction(transaction, identity)).map(chunk => Object.freeze({ index: chunk.index, digest: chunk.digest, encodedBytes: chunk.encodedBytes }));
    });
  }

  /**
   * Reads one committed chunk of this attempt's own material. It works before a
   * seal, so a restarted writer can compare what landed instead of re-uploading.
   */
  async readChunk(value: FactoryMaterialIdentity, index: number, signal?: AbortSignal): Promise<Uint8Array> {
    const identity = this.assertOwnScope(value);
    signal?.throwIfAborted();
    const found = await this.database.transaction(async transaction => {
      await this.journal.authorizeMaterialReadInTransaction(transaction, this.authority);
      const material = await this.materialInTransaction(transaction, identity, "share");
      if (!material) throw new FactoryMaterialError("factory_material_not_found");
      const chunk = (await this.chunksInTransaction(transaction, identity)).find(value => value.index === index);
      if (!chunk) throw new FactoryMaterialError("factory_material_chunk_not_found");
      return { material, chunk };
    });
    signal?.throwIfAborted();
    return this.readChunkBytes(found.material, found.chunk);
  }

  private assertOwnScope(value: FactoryMaterialIdentity): FactoryMaterialIdentity {
    const identity = snapshotFactoryMaterialIdentity(value);
    this.assertOwnScopeOnly(identity);
    return identity;
  }

  private assertOwnScopeOnly(value: FactoryMaterialScope): FactoryMaterialScope {
    const scope = snapshotFactoryMaterialScope(value);
    if (scope.tenantId !== this.authority.tenantId || scope.projectId !== this.authority.projectId
      || scope.runId !== this.authority.runId || scope.attemptId !== this.authority.attemptId) throw new FactoryMaterialError("factory_material_scope_denied");
    return scope;
  }
}

/**
 * The one scoped reader for validators, release profiles, and previews. It
 * verifies bytes against the stored digest and storage version on every read,
 * and denies a cross-scope reference without disclosing whether it exists.
 *
 * It does not replace `loadSharedInTransaction`. A cross-project read grant is
 * a separate authority with its own sealed grant digest; these must not merge.
 */
export class FactoryScopedMaterials extends FactoryMaterialStore implements FactoryScopedArtifactReader {
  async read(scope: FactoryMaterialScope, artifactReference: FactoryArtifactReference, signal?: AbortSignal): Promise<Uint8Array> {
    const { stored, chunks } = await this.resolve(scope, artifactReference, signal);
    try {
      const assembled = await this.assemble(stored, chunks, signal);
      if (factoryMaterialDigest(assembled) !== stored.digest) unavailable();
      return assembled;
    } catch (error) { throw abortOr(error); }
  }

  async readChunk(scope: FactoryMaterialScope, artifactReference: FactoryArtifactReference, index: number, signal?: AbortSignal): Promise<Uint8Array> {
    const { stored, chunks } = await this.resolve(scope, artifactReference, signal);
    try {
      if (!Number.isSafeInteger(index) || index < 0 || index >= chunks.length) unavailable();
      return await this.readChunkBytes(stored, chunks[index]!);
    } catch (error) { throw abortOr(error); }
  }

  /** Resolves one sealed material and proves its manifest still describes it. */
  private async resolve(scopeValue: FactoryMaterialScope, artifactReference: FactoryArtifactReference, signal?: AbortSignal): Promise<{ stored: FactoryMaterialRecord; chunks: readonly FactoryMaterialChunkFact[] }> {
    let scope: FactoryMaterialScope;
    let reference: FactoryArtifactReference;
    try {
      scope = snapshotFactoryMaterialScope(scopeValue);
      reference = assertFactoryArtifactReference(artifactReference, FACTORY_MATERIAL_MANIFEST_MAX_BYTES);
      if (scope.tenantId !== this.tenantId) unavailable();
    } catch (error) { throw abortOr(error); }
    signal?.throwIfAborted();
    try {
      return await this.database.transaction(async transaction => {
        const found = rows<MaterialRow>(await transaction.execute(sql`${MATERIAL_SELECT}
          WHERE material.tenant_id=${scope.tenantId} AND material.project_id=${scope.projectId} AND material.run_id=${scope.runId}
            AND material.attempt_id=${scope.attemptId} AND material.operation_id=${scope.operationId}
            AND material.object_id=${reference.artifactId} AND material.sealed=TRUE FOR SHARE OF material`));
        if (found.length !== 1) unavailable();
        const stored = materialRecord(found[0]!);
        if (!stored.artifact || stored.artifact.artifactId !== reference.artifactId || stored.artifact.digest !== reference.digest || stored.artifact.encodedBytes !== reference.encodedBytes) unavailable();
        const manifestObject = await this.artifacts.loadInTransaction(transaction, { tenantId: stored.tenantId, projectId: stored.projectId, logicalRunId: stored.runId },
          { objectId: stored.artifact.artifactId, digest: stored.artifact.digest, encodedBytes: stored.artifact.encodedBytes }, ["material"]);
        const manifest = parseFactoryMaterialManifest(manifestObject.content, stored);
        const chunks = await this.chunksInTransaction(transaction, stored);
        if (chunks.length !== manifest.chunks.length) unavailable();
        for (const [index, chunk] of chunks.entries()) {
          const declared = manifest.chunks[index]!;
          if (chunk.index !== declared.index || chunk.digest !== declared.digest || chunk.encodedBytes !== declared.encodedBytes) unavailable();
        }
        return { stored, chunks };
      });
    } catch (error) { throw abortOr(error); }
  }
}

/** Keeps a cancellation distinguishable while every other denial stays opaque. */
function abortOr(error: unknown): unknown {
  if (error instanceof DOMException && error.name === "AbortError") return error;
  if (error instanceof FactoryArtifactAccessError) return error;
  try { unavailable(); } catch (denied) { return denied; }
  return error;
}
