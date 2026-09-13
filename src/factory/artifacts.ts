import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@ezcorp/extension-contract";
import { digestBytes, S3BlobStore } from "../extensions/v4/blobs";
import type { BlobStore } from "../extensions/v4/types";
import type { TransactionalDb } from "../db/migrations/types";
import { releaseRows } from "../db/queries/extension-releases";
import { assertFactoryIdentity } from "./records";
import type { FactoryIdentity, ImmutableObjectReference } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";

export const FACTORY_ARTIFACT_MAX_BYTES = 32 * 1024;
export type FactoryArtifactKind = "definition_page" | "definition_manifest" | "transition_page" | "transition_manifest" | "execution_manifest" | "partition";

type ArtifactRow = { object_id: string; tenant_id: string; project_id: string; run_id: string; interpreter_id: string | null; kind: FactoryArtifactKind; definition_digest: string | null; source_sequence: number | string | null; page_index: number | null; digest: string; blob_digest: string; storage_version: string; encoded_bytes: number | string };

export class FactoryArtifactError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryArtifactError"; }
}

function digest(raw: string): string { return `sha256:${raw}`; }
function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function text(value: Uint8Array): string { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
function bounded(value: Uint8Array): void { if (value.byteLength < 1 || value.byteLength > FACTORY_ARTIFACT_MAX_BYTES) throw new FactoryArtifactError("factory_artifact_size_invalid"); }
function sourceSequence(value: number | undefined): number | null { if (value === undefined) return null; if (!Number.isSafeInteger(value) || value < 1) throw new FactoryArtifactError("factory_artifact_identity_invalid"); return value; }
function pageIndex(value: number | undefined): number | null { if (value === undefined) return null; if (!Number.isSafeInteger(value) || value < 0) throw new FactoryArtifactError("factory_artifact_identity_invalid"); return value; }
function identity(value: Pick<FactoryIdentity, "tenantId" | "projectId" | "logicalRunId">): void { assertFactoryIdentity(value.tenantId, value.projectId, value.logicalRunId); }
function reference(row: ArtifactRow): ImmutableObjectReference { return { objectId: row.object_id, digest: row.digest, encodedBytes: Number(row.encoded_bytes) }; }

/** Product-side immutable pointers. Blob digests are never an authorization handle. */
export class FactoryArtifacts {
  constructor(readonly database: TransactionalDb, private readonly blobs: BlobStore) {}

  async stage(identityValue: Pick<FactoryIdentity, "tenantId" | "projectId" | "logicalRunId" | "interpreterId">, kind: FactoryArtifactKind, content: Uint8Array, options: { definitionDigest?: string; sourceSequence?: number; pageIndex?: number; interpreterScoped?: boolean } = {}): Promise<ImmutableObjectReference> {
    identity(identityValue);
    bounded(content);
    const sequence = sourceSequence(options.sourceSequence);
    const index = pageIndex(options.pageIndex);
    const interpreterId = options.interpreterScoped === false ? null : identityValue.interpreterId;
    if (interpreterId !== null) assertFactoryIdentity(interpreterId);
    const rawDigest = digestBytes(content);
    const artifactDigest = digest(rawDigest);
    if (options.definitionDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(options.definitionDigest)) throw new FactoryArtifactError("factory_artifact_digest_invalid");
    return this.database.transaction(async transaction => {
      const existing = releaseRows<ArtifactRow>(await transaction.execute(sql`SELECT object_id, tenant_id, project_id, run_id, interpreter_id, kind, definition_digest, source_sequence, page_index, digest, blob_digest, storage_version, encoded_bytes FROM factory_artifacts WHERE tenant_id=${identityValue.tenantId} AND project_id=${identityValue.projectId} AND run_id=${identityValue.logicalRunId} AND interpreter_id IS NOT DISTINCT FROM ${interpreterId} AND kind=${kind} AND source_sequence IS NOT DISTINCT FROM ${sequence} AND page_index IS NOT DISTINCT FROM ${index} FOR SHARE`))[0];
      if (existing) {
        if (existing.digest !== artifactDigest || existing.definition_digest !== (options.definitionDigest ?? null) || Number(existing.encoded_bytes) !== content.byteLength) throw new FactoryArtifactError("factory_artifact_conflict");
        await this.verify(existing);
        return reference(existing);
      }
      const stored = await this.blobs.put(content);
      if (stored !== rawDigest) throw new FactoryArtifactError("factory_artifact_corrupt");
      const storageVersion = this.blobs instanceof S3BlobStore ? await this.blobs.version(rawDigest) : rawDigest;
      const row: ArtifactRow = { object_id: `factory-artifact-${randomUUID()}`, tenant_id: identityValue.tenantId, project_id: identityValue.projectId, run_id: identityValue.logicalRunId, interpreter_id: interpreterId, kind, definition_digest: options.definitionDigest ?? null, source_sequence: sequence, page_index: index, digest: artifactDigest, blob_digest: rawDigest, storage_version: storageVersion, encoded_bytes: content.byteLength };
      await transaction.execute(sql`INSERT INTO factory_artifacts(object_id, tenant_id, project_id, run_id, interpreter_id, kind, definition_digest, source_sequence, page_index, digest, blob_digest, storage_version, encoded_bytes) VALUES (${row.object_id}, ${row.tenant_id}, ${row.project_id}, ${row.run_id}, ${row.interpreter_id}, ${row.kind}, ${row.definition_digest}, ${row.source_sequence}, ${row.page_index}, ${row.digest}, ${row.blob_digest}, ${row.storage_version}, ${row.encoded_bytes})`);
      return reference(row);
    });
  }

  async load(identityValue: Pick<FactoryIdentity, "tenantId" | "projectId" | "logicalRunId" | "interpreterId">, object: ImmutableObjectReference, kinds: readonly FactoryArtifactKind[], interpreterScoped = false): Promise<{ reference: ImmutableObjectReference; kind: FactoryArtifactKind; definitionDigest: string | null; sourceSequence: number | null; pageIndex: number | null; content: Uint8Array }> {
    identity(identityValue);
    if (!object?.objectId || !/^sha256:[0-9a-f]{64}$/.test(object.digest) || !Number.isSafeInteger(object.encodedBytes) || object.encodedBytes < 1 || object.encodedBytes > FACTORY_ARTIFACT_MAX_BYTES) throw new FactoryArtifactError("factory_artifact_reference_invalid");
    const row = releaseRows<ArtifactRow>(await this.database.execute(sql`SELECT object_id, tenant_id, project_id, run_id, interpreter_id, kind, definition_digest, source_sequence, page_index, digest, blob_digest, storage_version, encoded_bytes FROM factory_artifacts WHERE object_id=${object.objectId} AND tenant_id=${identityValue.tenantId} AND project_id=${identityValue.projectId} AND run_id=${identityValue.logicalRunId} ${interpreterScoped ? sql`AND interpreter_id=${identityValue.interpreterId}` : sql``} FOR SHARE`))[0];
    if (!row || !kinds.includes(row.kind) || row.digest !== object.digest || Number(row.encoded_bytes) !== object.encodedBytes) throw new FactoryArtifactError("factory_artifact_not_found");
    const content = await this.verify(row);
    return { reference: reference(row), kind: row.kind, definitionDigest: row.definition_digest, sourceSequence: row.source_sequence === null ? null : Number(row.source_sequence), pageIndex: row.page_index, content };
  }

  private async verify(row: ArtifactRow): Promise<Uint8Array> {
    if (row.digest !== digest(row.blob_digest) || !row.storage_version || !Number.isSafeInteger(Number(row.encoded_bytes))) throw new FactoryArtifactError("factory_artifact_corrupt");
    const content = this.blobs instanceof S3BlobStore ? await this.blobs.getVersion(row.blob_digest, row.storage_version) : await this.blobs.get(row.blob_digest);
    if (content.byteLength !== Number(row.encoded_bytes) || digestBytes(content) !== row.blob_digest) throw new FactoryArtifactError("factory_artifact_corrupt");
    return content;
  }
}

export const artifactJson = { bytes, text, canonical: (value: unknown) => bytes(canonicalJson(value)) };
