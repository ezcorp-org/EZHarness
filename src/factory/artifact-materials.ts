import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import { digestBytes, digestObject } from "../extensions/v4/blobs";
import { relativePath } from "../../packages/@ezcorp/extension-runner/src/core";
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
