import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { ImmutableObjectReference, FactoryIdentity } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { insertTransactionalAuditEntry } from "../db/queries/audit-log";
import { digestBytes, digestObject } from "../extensions/v4/blobs";
import type { FactoryArtifactKind } from "./artifacts";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import { FactoryMutations } from "./mutations";
import { assertFactoryIdentity } from "./records";

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

type ArtifactRecord = {
  readonly object_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly kind: string;
  readonly digest: string;
  readonly encoded_bytes: string | number;
  readonly storage_version: string;
};
type GrantRecord = {
  readonly source_project_id: string;
  readonly source_run_id: string;
  readonly source_artifact_id: string;
  readonly target_project_id: string;
  readonly artifact_digest: string;
  readonly artifact_bytes: string | number;
  readonly artifact_kind: string;
  readonly storage_version: string;
  readonly media_type: string;
  readonly issuer_id: string;
  readonly issuer_grant_revision: string | number;
  readonly protected_digest: string;
  readonly revoked_at: unknown;
};
type SharedGrantRecord = GrantRecord & {
  readonly host_object_id: string;
  readonly host_project_id: string;
  readonly host_run_id: string;
  readonly host_kind: string;
  readonly host_digest: string;
  readonly host_encoded_bytes: string | number;
  readonly host_storage_version: string;
};

export interface FactoryArtifactTransactionReader {
  loadInTransaction(
    transaction: MigrationDb,
    identity: Pick<FactoryIdentity, "tenantId" | "projectId" | "logicalRunId" | "interpreterId">,
    reference: ImmutableObjectReference,
    kinds: readonly FactoryArtifactKind[],
    interpreterScoped?: boolean,
  ): Promise<{ readonly reference: ImmutableObjectReference; readonly kind: FactoryArtifactKind; readonly content: Uint8Array }>;
}

export interface FactoryArtifactReadGrantInput {
  readonly sourceProjectId: string;
  readonly sourceRunId: string;
  readonly targetProjectId: string;
  readonly artifact: FactoryArtifactReference;
  readonly mediaType: string;
}

export interface FactoryArtifactReadGrant extends FactoryArtifactReadGrantInput {
  readonly artifactKind: string;
  readonly issuerId: string;
  readonly issuerGrantRevision: number;
  readonly storageVersion: string;
  readonly protectedDigest: string;
  readonly revoked: boolean;
}

export interface FactorySharedArtifact {
  readonly artifact: FactoryArtifactReference;
  readonly mediaType: string;
  readonly content: Uint8Array;
}

export class FactoryArtifactAccessError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FactoryArtifactAccessError";
  }
}

function unavailable(): never { throw new FactoryArtifactAccessError("factory_artifact_unavailable"); }
function validMediaType(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u.test(value); }
function reference(value: FactoryArtifactReference): FactoryArtifactReference {
  if (!value || typeof value.artifactId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.digest) || !Number.isSafeInteger(value.encodedBytes) || value.encodedBytes < 1 || value.encodedBytes > MAX_ARTIFACT_BYTES) throw new FactoryArtifactAccessError("factory_artifact_reference_invalid");
  assertFactoryIdentity(value.artifactId);
  return Object.freeze({ artifactId: value.artifactId, digest: value.digest, encodedBytes: value.encodedBytes });
}
function sealed(tenantId: string, input: Omit<FactoryArtifactReadGrant, "protectedDigest" | "revoked">): string {
  return `sha256:${digestObject({ tenantId, sourceProjectId: input.sourceProjectId, sourceRunId: input.sourceRunId, targetProjectId: input.targetProjectId, artifact: input.artifact, artifactKind: input.artifactKind, mediaType: input.mediaType, issuerId: input.issuerId, issuerGrantRevision: input.issuerGrantRevision, storageVersion: input.storageVersion })}`;
}
function asGrant(tenantId: string, row: GrantRecord): FactoryArtifactReadGrant {
  const artifact = reference({ artifactId: row.source_artifact_id, digest: row.artifact_digest, encodedBytes: Number(row.artifact_bytes) });
  const value: Omit<FactoryArtifactReadGrant, "protectedDigest" | "revoked"> = { sourceProjectId: row.source_project_id, sourceRunId: row.source_run_id, targetProjectId: row.target_project_id, artifact, artifactKind: row.artifact_kind, mediaType: row.media_type, issuerId: row.issuer_id, issuerGrantRevision: Number(row.issuer_grant_revision), storageVersion: row.storage_version };
  if (!validMediaType(value.mediaType) || !value.artifactKind || value.artifactKind.length > 128 || !Number.isSafeInteger(value.issuerGrantRevision) || value.issuerGrantRevision < 1 || row.protected_digest !== sealed(tenantId, value)) unavailable();
  return { ...value, protectedDigest: row.protected_digest, revoked: row.revoked_at !== null };
}

/** Specific human cross-project reads. They carry no acceptance, trust, or release authority. */
export class FactoryArtifactAccess {
  private readonly mutations: FactoryMutations;

  constructor(database: TransactionalDb, readonly tenantId: string, private readonly grants: FactoryGrants, private readonly artifacts: FactoryArtifactTransactionReader) {
    assertFactoryIdentity(tenantId);
    if (grants.tenantId !== tenantId) throw new FactoryArtifactAccessError("factory_scope_mismatch");
    this.mutations = new FactoryMutations(database, tenantId, grants);
  }

  grant(actor: FactoryPrincipal, input: FactoryArtifactReadGrantInput, idempotencyKey: string): Promise<FactoryArtifactReadGrant> {
    const principal = { ...actor };
    const snapshot = { sourceProjectId: input.sourceProjectId, sourceRunId: input.sourceRunId, targetProjectId: input.targetProjectId, artifact: reference(input.artifact), mediaType: input.mediaType };
    this.input(snapshot);
    if (principal.kind !== "user" || principal.authentication !== "session") throw new FactoryArtifactAccessError("factory_human_required");
    return this.mutations.execute(
      { principal, projectId: snapshot.sourceProjectId, action: "factory.operate", idempotencyKey, input: { kind: "artifact.read.grant", ...snapshot } },
      transaction => this.grantInTransaction(transaction, principal, snapshot),
    );
  }

  revoke(actor: FactoryPrincipal, input: Pick<FactoryArtifactReadGrantInput, "sourceProjectId" | "targetProjectId" | "artifact">, idempotencyKey: string): Promise<FactoryArtifactReadGrant> {
    const principal = { ...actor };
    const snapshot = { sourceProjectId: input.sourceProjectId, targetProjectId: input.targetProjectId, artifact: reference(input.artifact) };
    assertFactoryIdentity(snapshot.sourceProjectId, snapshot.targetProjectId);
    if (principal.kind !== "user" || principal.authentication !== "session") throw new FactoryArtifactAccessError("factory_human_required");
    return this.mutations.execute(
      { principal, projectId: snapshot.sourceProjectId, action: "factory.operate", idempotencyKey, input: { kind: "artifact.read.revoke", ...snapshot } },
      transaction => this.revokeInTransaction(transaction, principal, snapshot),
    );
  }

  /** Loads exact verified bytes in the caller transaction. Reader denials intentionally disclose no source detail. */
  async loadSharedInTransaction(transaction: MigrationDb, targetProjectId: string, artifactValue: FactoryArtifactReference, mediaType: string): Promise<FactorySharedArtifact> {
    let artifact: FactoryArtifactReference;
    try {
      artifact = reference(artifactValue);
      assertFactoryIdentity(targetProjectId);
      if (!validMediaType(mediaType)) unavailable();
    } catch { unavailable(); }
    const found = rows<SharedGrantRecord>(await transaction.execute(sql`SELECT share.source_project_id, share.source_run_id, share.source_artifact_id, share.target_project_id,
      share.artifact_digest, share.artifact_bytes, share.artifact_kind, share.storage_version, share.media_type, share.issuer_id, share.issuer_grant_revision, share.protected_digest, share.revoked_at,
      artifact.object_id AS host_object_id, artifact.project_id AS host_project_id, artifact.run_id AS host_run_id, artifact.kind AS host_kind, artifact.digest AS host_digest, artifact.encoded_bytes AS host_encoded_bytes, artifact.storage_version AS host_storage_version
      FROM factory_artifact_read_grants AS share JOIN factory_artifacts AS artifact
        ON artifact.tenant_id=share.tenant_id AND artifact.project_id=share.source_project_id AND artifact.object_id=share.source_artifact_id
      WHERE share.tenant_id=${this.tenantId} AND share.target_project_id=${targetProjectId} AND share.source_artifact_id=${artifact.artifactId}
        AND share.artifact_digest=${artifact.digest} AND share.artifact_bytes=${artifact.encodedBytes} AND share.revoked_at IS NULL
      FOR SHARE`));
    if (found.length !== 1) unavailable();
    const grant = asGrant(this.tenantId, found[0]!);
    const host = found[0]!;
    if (grant.mediaType !== mediaType || host.host_project_id !== grant.sourceProjectId || host.host_run_id !== grant.sourceRunId || host.host_object_id !== grant.artifact.artifactId || host.host_kind !== grant.artifactKind || host.host_kind !== host.artifact_kind || host.host_digest !== grant.artifact.digest || Number(host.host_encoded_bytes) !== grant.artifact.encodedBytes || host.host_storage_version !== grant.storageVersion) unavailable();
    try {
      const loaded = await this.artifacts.loadInTransaction(transaction, { tenantId: this.tenantId, projectId: grant.sourceProjectId, logicalRunId: grant.sourceRunId, interpreterId: "root" }, { objectId: grant.artifact.artifactId, digest: grant.artifact.digest, encodedBytes: grant.artifact.encodedBytes }, [host.artifact_kind as FactoryArtifactKind]);
      if (loaded.reference.objectId !== grant.artifact.artifactId || loaded.reference.digest !== grant.artifact.digest || loaded.reference.encodedBytes !== grant.artifact.encodedBytes || loaded.kind !== host.artifact_kind || loaded.content.byteLength !== grant.artifact.encodedBytes || `sha256:${digestBytes(loaded.content)}` !== grant.artifact.digest) unavailable();
      return { artifact: grant.artifact, mediaType: grant.mediaType, content: Uint8Array.from(loaded.content) };
    } catch { unavailable(); }
  }

  private async grantInTransaction(transaction: MigrationDb, actor: FactoryPrincipal, input: FactoryArtifactReadGrantInput): Promise<FactoryArtifactReadGrant> {
    const authorization = await this.grants.authorizeInTransaction(transaction, actor, input.sourceProjectId, "factory.operate");
    const source = rows<ArtifactRecord>(await transaction.execute(sql`SELECT object_id, project_id, run_id, kind, digest, encoded_bytes, storage_version FROM factory_artifacts
      WHERE tenant_id=${this.tenantId} AND project_id=${input.sourceProjectId} AND run_id=${input.sourceRunId} AND object_id=${input.artifact.artifactId} FOR SHARE`))[0];
    const target = rows(await transaction.execute(sql`SELECT project_id FROM factory_projects WHERE tenant_id=${this.tenantId} AND project_id=${input.targetProjectId} FOR SHARE`))[0];
    if (!source || !target || source.digest !== input.artifact.digest || Number(source.encoded_bytes) !== input.artifact.encodedBytes) throw new FactoryArtifactAccessError("factory_artifact_not_found");
    const value: Omit<FactoryArtifactReadGrant, "protectedDigest" | "revoked"> = { ...input, artifact: input.artifact, artifactKind: source.kind, mediaType: input.mediaType, issuerId: actor.id, issuerGrantRevision: authorization.revision, storageVersion: source.storage_version };
    const protectedDigest = sealed(this.tenantId, value);
    const existing = rows<GrantRecord>(await transaction.execute(sql`SELECT source_project_id, source_run_id, source_artifact_id, target_project_id, artifact_digest, artifact_bytes, artifact_kind, storage_version, media_type, issuer_id, issuer_grant_revision, protected_digest, revoked_at
      FROM factory_artifact_read_grants WHERE tenant_id=${this.tenantId} AND source_project_id=${input.sourceProjectId} AND source_artifact_id=${input.artifact.artifactId} AND target_project_id=${input.targetProjectId} FOR UPDATE`))[0];
    if (existing) throw new FactoryArtifactAccessError("factory_artifact_grant_conflict");
    await transaction.execute(sql`INSERT INTO factory_artifact_read_grants
      (tenant_id, source_project_id, source_run_id, source_artifact_id, target_project_id, artifact_digest, artifact_bytes, artifact_kind, storage_version, media_type, issuer_id, issuer_grant_revision, protected_digest)
      VALUES (${this.tenantId}, ${input.sourceProjectId}, ${input.sourceRunId}, ${input.artifact.artifactId}, ${input.targetProjectId}, ${input.artifact.digest}, ${input.artifact.encodedBytes}, ${source.kind}, ${source.storage_version}, ${input.mediaType}, ${actor.id}, ${authorization.revision}, ${protectedDigest})`);
    await insertTransactionalAuditEntry(transaction, `factory-artifact-read:${protectedDigest}`, actor.id, "factory.artifact.read.granted", input.artifact.artifactId, { tenantId: this.tenantId, sourceProjectId: input.sourceProjectId, targetProjectId: input.targetProjectId, digest: input.artifact.digest, mediaType: input.mediaType });
    return { ...value, protectedDigest, revoked: false };
  }

  private async revokeInTransaction(transaction: MigrationDb, actor: FactoryPrincipal, input: Pick<FactoryArtifactReadGrantInput, "sourceProjectId" | "targetProjectId" | "artifact">): Promise<FactoryArtifactReadGrant> {
    const row = rows<GrantRecord>(await transaction.execute(sql`SELECT source_project_id, source_run_id, source_artifact_id, target_project_id, artifact_digest, artifact_bytes, artifact_kind, storage_version, media_type, issuer_id, issuer_grant_revision, protected_digest, revoked_at
      FROM factory_artifact_read_grants WHERE tenant_id=${this.tenantId} AND source_project_id=${input.sourceProjectId} AND source_artifact_id=${input.artifact.artifactId} AND target_project_id=${input.targetProjectId} FOR UPDATE`))[0];
    if (!row) throw new FactoryArtifactAccessError("factory_artifact_grant_not_found");
    const grant = asGrant(this.tenantId, row);
    if (grant.artifact.digest !== input.artifact.digest || grant.artifact.encodedBytes !== input.artifact.encodedBytes) throw new FactoryArtifactAccessError("factory_artifact_grant_conflict");
    if (!grant.revoked) {
      await transaction.execute(sql`UPDATE factory_artifact_read_grants SET revoked_at=NOW() WHERE tenant_id=${this.tenantId} AND source_project_id=${input.sourceProjectId} AND source_artifact_id=${input.artifact.artifactId} AND target_project_id=${input.targetProjectId}`);
      await insertTransactionalAuditEntry(transaction, `factory-artifact-read-revoke:${grant.protectedDigest}`, actor.id, "factory.artifact.read.revoked", input.artifact.artifactId, { tenantId: this.tenantId, sourceProjectId: input.sourceProjectId, targetProjectId: input.targetProjectId, digest: input.artifact.digest });
    }
    return { ...grant, revoked: true };
  }

  private input(input: FactoryArtifactReadGrantInput): void {
    assertFactoryIdentity(input.sourceProjectId, input.sourceRunId, input.targetProjectId);
    if (input.sourceProjectId === input.targetProjectId || !validMediaType(input.mediaType)) throw new FactoryArtifactAccessError("factory_artifact_grant_invalid");
  }
}
