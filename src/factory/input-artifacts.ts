import { canonicalizeJson, FACTORY_LIMITS, validateIJson, type FactoryArtifactReference, type JsonValue } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { MigrationDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { FactoryArtifactAccessError, type FactoryArtifactAccess } from "./artifact-access";
import type { FactoryArtifacts, FactoryArtifactKind } from "./artifacts";
import { assertFactoryIdentity } from "./records";

export class FactoryInputArtifactError extends Error {
  readonly code = "factory_input_artifact_unavailable";
  constructor() { super("Factory input artifact is unavailable."); this.name = "FactoryInputArtifactError"; }
}

export function snapshotFactoryInputArtifact(value: FactoryArtifactReference): FactoryArtifactReference {
  if (!value || typeof value.artifactId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.digest) || !Number.isSafeInteger(value.encodedBytes) || value.encodedBytes < 1 || value.encodedBytes > FACTORY_LIMITS.maxDefinitionBytes) throw new FactoryInputArtifactError();
  assertFactoryIdentity(value.artifactId);
  return Object.freeze({ artifactId: value.artifactId, digest: value.digest, encodedBytes: value.encodedBytes });
}

interface InputArtifact {
  readonly artifact: FactoryArtifactReference;
  readonly mediaType: "application/json";
  readonly storageVersion: string;
  readonly value: JsonValue;
}

/** The caller authorizes the target run; this shared loader checks its exact local or explicitly shared immutable input. */
export class FactoryInputArtifacts {
  readonly tenantId: string;
  constructor(private readonly artifacts: FactoryArtifacts, private readonly access: FactoryArtifactAccess) {
    if (artifacts.tenantId !== access.tenantId) throw new FactoryInputArtifactError();
    this.tenantId = artifacts.tenantId;
  }

  async loadInTransaction(transaction: MigrationDb, projectId: string, input: FactoryArtifactReference): Promise<InputArtifact> {
    const artifact = snapshotFactoryInputArtifact(input);
    assertFactoryIdentity(projectId);
    const loaded = await this.load(transaction, projectId, artifact);
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(loaded.content));
      if (!validateIJson(value).ok || !Buffer.from(loaded.content).equals(Buffer.from(canonicalizeJson(value as JsonValue)))) throw new FactoryInputArtifactError();
      return { artifact, mediaType: "application/json", storageVersion: loaded.storageVersion, value: value as JsonValue };
    } catch { throw new FactoryInputArtifactError(); }
  }

  private async load(transaction: MigrationDb, projectId: string, artifact: FactoryArtifactReference): Promise<{ readonly content: Uint8Array; readonly storageVersion: string }> {
    try { return await this.access.loadSharedInTransaction(transaction, projectId, artifact, "application/json"); }
    catch (error) { if (!(error instanceof FactoryArtifactAccessError)) throw error; }
    const local = rows<{ run_id: string; kind: FactoryArtifactKind; storage_version: string }>(await transaction.execute(sql`SELECT run_id, kind, storage_version FROM factory_artifacts
      WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND object_id=${artifact.artifactId} AND digest=${artifact.digest} AND encoded_bytes=${artifact.encodedBytes} FOR SHARE`));
    if (local.length !== 1) throw new FactoryInputArtifactError();
    const row = local[0]!;
    try {
      const loaded = await this.artifacts.loadInTransaction(transaction, { tenantId: this.tenantId, projectId, logicalRunId: row.run_id, interpreterId: "root" }, { objectId: artifact.artifactId, digest: artifact.digest, encodedBytes: artifact.encodedBytes }, [row.kind], false);
      if (loaded.reference.objectId !== artifact.artifactId || loaded.reference.digest !== artifact.digest || loaded.reference.encodedBytes !== artifact.encodedBytes || loaded.content.byteLength !== artifact.encodedBytes) throw new FactoryInputArtifactError();
      return { content: loaded.content, storageVersion: row.storage_version };
    } catch { throw new FactoryInputArtifactError(); }
  }
}
