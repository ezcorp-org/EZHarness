import { createHash } from "node:crypto";
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import { digestObject } from "../extensions/v4/blobs";
import { FACTORY_MATERIAL_LIMITS, assertFactoryArtifactReference, isFactoryArtifactMediaType, snapshotFactoryMaterialScope, type FactoryMaterialScope, type FactoryScopedArtifactReader } from "./artifact-materials";
import { s3ErrorIsConflict, s3ErrorIsMissing, type S3ClientLike } from "./release-adapters";
import { FactoryReleaseError, type FactoryProviderReceipt, type FactoryReleaseClaim, type FactoryReleaseDestination, type FactoryReleaseOperation, type FactoryReleaseProvider } from "./releases";

/**
 * C04's S3 half: one approved set of exact files published under one operation
 * directory.
 *
 * A single-object write does not publish a dataset. This provider stages every
 * member conditionally and privately, verifies each one's SHA-256, media type,
 * and returned object version, and only then writes `manifest.json`. The
 * manifest is the publication: until it exists, a partially staged directory
 * names nothing, so a reader can never observe half a release.
 *
 * Nothing here trusts an ETag. S3 returns an ETag that is an MD5 for a single
 * PUT and an opaque composite for a multipart upload, so it is not a content
 * digest for either. Every digest in the receipt is a SHA-256 this provider
 * computed over bytes it read back.
 */

export const FACTORY_S3_PUBLICATION_REQUEST_SCHEMA_VERSION = "factory.s3-publication-set.v1";
export const FACTORY_S3_PUBLICATION_MANIFEST_SCHEMA_VERSION = "factory.s3-publication-manifest.v1";
export const FACTORY_S3_PUBLICATION_RECEIPT_SCHEMA_VERSION = "factory.s3-manifest-receipt.v1";

/** The reserved member name that completes a publication. No member may take it. */
export const FACTORY_S3_MANIFEST_NAME = "manifest.json";
export const FACTORY_S3_MANIFEST_MEDIA_TYPE = "application/json";

/**
 * Bounds for one publication set.
 *
 * The member count, the per-member ceiling, and the part size come from W04's
 * material limits, so a set can hold exactly what the material service can
 * store and one W04 chunk maps onto one S3 part boundary.
 */
export const FACTORY_S3_PUBLICATION_LIMITS = Object.freeze({
  maxMembers: FACTORY_MATERIAL_LIMITS.maxObjectsPerOperation,
  maxMemberBytes: FACTORY_MATERIAL_LIMITS.maxTotalBytes,
  maxChunks: FACTORY_MATERIAL_LIMITS.maxChunks,
  /** One S3 part. At or above this size a member is exported as a real multipart upload. */
  partBytes: FACTORY_MATERIAL_LIMITS.maxChunkBytes,
  maxNameLength: 256,
  /** The S3 key ceiling, so a long directory plus a long member name is refused before the write. */
  maxKeyBytes: 1024,
});

/** User-metadata keys that bind a staged object to the exact operation that staged it. */
const META_IDENTITY = "factory-identity";
const META_DIGEST = "factory-digest";
const META_OPERATION = "factory-operation";
const META_GENERATION = "factory-generation";

const encoder = new TextEncoder();
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const OBJECT = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,900}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** One file this release publishes, pinned by the profile before the claim. */
export interface FactoryS3PublicationMember {
  /** Relative path under the operation directory. Never `manifest.json`. */
  readonly name: string;
  readonly mediaType: string;
  /** `sha256:` over the exact bytes that must appear at the key. */
  readonly digest: string;
  readonly totalBytes: number;
  /** W04 chunks to read, in order. One chunk is at most one S3 part. */
  readonly chunkCount: number;
  readonly artifact: FactoryArtifactReference;
}

/**
 * The frozen request one S3 publication carries.
 *
 * It names the producing gateway operation but never an attempt id: the attempt
 * comes from the verified protected command provenance through
 * `FactoryS3PublicationAttempts`, so a request cannot widen its own read scope.
 */
export interface FactoryS3PublicationSetRequest {
  readonly schemaVersion: typeof FACTORY_S3_PUBLICATION_REQUEST_SCHEMA_VERSION;
  /** The producing attempt's gateway operation, which scopes every member read. */
  readonly materialOperationId: string;
  /** The accepted candidate manifest, archived with the members before the claim. */
  readonly candidate: FactoryArtifactReference;
  readonly members: readonly FactoryS3PublicationMember[];
}

/** One published object, as observed after the write rather than as requested. */
export interface FactoryS3PublishedFile {
  readonly name: string;
  readonly key: string;
  readonly mediaType: string;
  /** `sha256:` recomputed from the bytes read back at `versionId`. Never an ETag. */
  readonly digest: string;
  readonly encodedBytes: number;
  readonly versionId: string;
}

/** The object `manifest.json` holds. Publishing it is what makes the set visible. */
export interface FactoryS3PublicationManifest {
  readonly schemaVersion: typeof FACTORY_S3_PUBLICATION_MANIFEST_SCHEMA_VERSION;
  readonly operationId: string;
  readonly dispatchGeneration: number;
  readonly requestDigest: string;
  readonly files: readonly FactoryS3PublishedFile[];
}

/**
 * The verified publication receipt.
 *
 * `files` carries every member's key, SHA-256 digest, media type, and object
 * version. `version` is the manifest's own object version and `effectDigest` is
 * the final manifest digest, so the one effect this operation confirmed is named
 * by exactly one digest and every member reachable from it.
 */
export interface FactoryS3ManifestReceipt extends FactoryProviderReceipt {
  readonly schemaVersion: typeof FACTORY_S3_PUBLICATION_RECEIPT_SCHEMA_VERSION;
  readonly bucket: string;
  /** The one operation directory every member and the manifest live under. */
  readonly directory: string;
  readonly manifestKey: string;
  readonly files: readonly FactoryS3PublishedFile[];
}

/**
 * The verified attempt behind one release operation.
 *
 * `release-s3-scope.ts` implements this over the stored protected command
 * receipts. It is a seam here so the provider never reaches into the product
 * database and never accepts an attempt id from its own request.
 */
export interface FactoryS3PublicationAttempts {
  attemptFor(operation: FactoryReleaseOperation, signal?: AbortSignal): Promise<string>;
}

export interface FactoryS3ManifestPublicationOptions {
  readonly endpoint: string;
  readonly bucket: string;
  readonly account: string;
  readonly prefix?: string;
  /** The destination credentials, and the only credentials this provider ever holds. */
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string };
  readonly region?: string;
  readonly client?: S3ClientLike;
  /** W04's one scoped reader. Member bytes come from it and from nothing else. */
  readonly reader: FactoryScopedArtifactReader;
  readonly attempts: FactoryS3PublicationAttempts;
}

function invalid(): never {
  throw new FactoryReleaseError("factory_s3_request_invalid");
}

function sha256Hex(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256Base64(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64");
}

function safeSize(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) invalid();
  return value as number;
}

/** A relative member path with no traversal, no reserved name, and a bounded key. */
function assertMemberName(value: unknown, directory: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > FACTORY_S3_PUBLICATION_LIMITS.maxNameLength || !NAME.test(value)) invalid();
  if (value === FACTORY_S3_MANIFEST_NAME || value.split("/").some(part => part === "." || part === "..")) invalid();
  if (encoder.encode(`${directory}/${value}`).byteLength > FACTORY_S3_PUBLICATION_LIMITS.maxKeyBytes) invalid();
  return value;
}

/**
 * The operation directory this publication owns.
 *
 * A destination naming another provider, another account, a traversing path, or
 * a trailing separator never reaches a write.
 */
export function factoryS3PublicationDirectory(destination: FactoryReleaseDestination, account: string, prefix = ""): string {
  const object = destination.object;
  if (destination.provider !== "s3" || destination.account !== account) throw new FactoryReleaseError("factory_s3_foreign_target");
  if (typeof object !== "string" || !OBJECT.test(object) || object.includes("//") || object.endsWith("/") || object.split("/").some(part => part === "." || part === "..")) throw new FactoryReleaseError("factory_s3_foreign_target");
  const root = prefix.replace(/^\/+|\/+$/g, "");
  return root ? `${root}/${object}` : object;
}

/**
 * Validates one frozen publication request.
 *
 * Member order is the request's order and it is required to be strictly
 * increasing by name, so two dispatch attempts of the same operation stage the
 * same keys in the same order and rebuild the identical manifest bytes.
 */
export function assertFactoryS3PublicationRequest(value: unknown, directory: string): FactoryS3PublicationSetRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== FACTORY_S3_PUBLICATION_REQUEST_SCHEMA_VERSION) invalid();
  if (Object.keys(record).length !== 4) invalid();
  if (typeof record.materialOperationId !== "string" || record.materialOperationId.length < 1 || record.materialOperationId.length > FACTORY_MATERIAL_LIMITS.maxNameLength || record.materialOperationId.includes("\0")) invalid();
  const candidate = assertPublicationArtifact(record.candidate);
  if (!Array.isArray(record.members) || record.members.length < 1 || record.members.length > FACTORY_S3_PUBLICATION_LIMITS.maxMembers) invalid();
  let previous = "";
  const members: FactoryS3PublicationMember[] = record.members.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid();
    const member = entry as Record<string, unknown>;
    if (Object.keys(member).length !== 6) invalid();
    const name = assertMemberName(member.name, directory);
    if (name <= previous) invalid();
    previous = name;
    if (!isFactoryArtifactMediaType(member.mediaType)) invalid();
    if (typeof member.digest !== "string" || !DIGEST.test(member.digest)) invalid();
    const totalBytes = safeSize(member.totalBytes, FACTORY_S3_PUBLICATION_LIMITS.maxMemberBytes);
    const chunkCount = safeSize(member.chunkCount, FACTORY_S3_PUBLICATION_LIMITS.maxChunks);
    return Object.freeze({ name, mediaType: member.mediaType, digest: member.digest, totalBytes, chunkCount, artifact: assertPublicationArtifact(member.artifact) });
  });
  return Object.freeze({ schemaVersion: FACTORY_S3_PUBLICATION_REQUEST_SCHEMA_VERSION, materialOperationId: record.materialOperationId, candidate, members: Object.freeze(members) });
}

function assertPublicationArtifact(value: unknown): FactoryArtifactReference {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value as object).length !== 3) invalid();
  try { return assertFactoryArtifactReference(value as FactoryArtifactReference, FACTORY_S3_PUBLICATION_LIMITS.maxMemberBytes); }
  catch { return invalid(); }
}

/**
 * The authorized identity that may reconcile an already-present object.
 *
 * It covers the tenant, the project, the destination account, the operation, and
 * the exact request digest. Identical bytes staged under any other identity are
 * a conflict, not a resumable staging.
 */
export function factoryS3PublicationIdentity(operation: FactoryReleaseOperation): string {
  return `sha256:${digestObject({ tenantId: operation.tenantId, projectId: operation.projectId, account: operation.destination.account, operationId: operation.operationId, requestDigest: operation.requestDigest })}`;
}

/** The exact manifest bytes one publication writes. Canonical, so a retry rebuilds them. */
export function factoryS3PublicationManifestBytes(operation: FactoryReleaseOperation, files: readonly FactoryS3PublishedFile[]): Uint8Array {
  const manifest: FactoryS3PublicationManifest = {
    schemaVersion: FACTORY_S3_PUBLICATION_MANIFEST_SCHEMA_VERSION,
    operationId: operation.operationId, dispatchGeneration: operation.dispatchGeneration,
    requestDigest: operation.requestDigest, files,
  };
  return encoder.encode(canonicalJson(manifest));
}

interface S3Head { readonly VersionId?: string; readonly ContentType?: string; readonly Metadata?: Record<string, string> }
interface S3Body { readonly Body?: unknown; readonly VersionId?: string; readonly ContentType?: string }
type S3StreamBody = AsyncIterable<Uint8Array>;

/** Hashes a response body without holding it, so a 256 MiB member verifies in bounded memory. */
async function s3BodyDigest(body: unknown): Promise<string> {
  const hash = createHash("sha256");
  if (body && typeof (body as Partial<S3StreamBody>)[Symbol.asyncIterator] === "function") {
    for await (const chunk of body as S3StreamBody) hash.update(chunk);
  } else if (body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    hash.update(await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
  } else {
    throw new FactoryReleaseError("factory_s3_receipt_unreadable");
  }
  return `sha256:${hash.digest("hex")}`;
}

function concatenate(parts: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

/**
 * The broker-owned S3 manifest publisher.
 *
 * It holds one credential set — the destination's — and reads every member's
 * bytes through W04's scoped reader, so neither the archive credentials nor an
 * unverified blob path is reachable from a publication.
 */
export class S3FactoryManifestReleaseProvider implements FactoryReleaseProvider {
  private readonly client: S3ClientLike;
  private readonly prefix: string;
  private readonly reader: FactoryScopedArtifactReader;
  private readonly attempts: FactoryS3PublicationAttempts;

  constructor(private readonly options: FactoryS3ManifestPublicationOptions) {
    if (!options.bucket || !options.account || !options.credentials.accessKeyId || !options.credentials.secretAccessKey) throw new FactoryReleaseError("factory_s3_configuration_invalid");
    this.prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.reader = options.reader;
    this.attempts = options.attempts;
    this.client = options.client ?? new S3Client({ endpoint: options.endpoint, region: options.region ?? "us-east-1", forcePathStyle: true, credentials: options.credentials, maxAttempts: 1 }) as unknown as S3ClientLike;
  }

  private send<Result>(command: unknown, signal?: AbortSignal): Promise<Result> {
    return this.client.send(command, signal ? { abortSignal: signal } : undefined) as Promise<Result>;
  }

  private directory(operation: FactoryReleaseOperation): string {
    return factoryS3PublicationDirectory(operation.destination, this.options.account, this.prefix);
  }

  private manifestKey(directory: string): string {
    return `${directory}/${FACTORY_S3_MANIFEST_NAME}`;
  }

  /** The exact head, or `undefined` when the key is absent. Any other fault propagates. */
  private async head(key: string, signal?: AbortSignal): Promise<S3Head | undefined> {
    try { return await this.send<S3Head>(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }), signal); }
    catch (error) {
      if (s3ErrorIsMissing(error)) return undefined;
      throw error;
    }
  }

  private metadata(identity: string, operation: FactoryReleaseOperation, digest: string): Record<string, string> {
    return { [META_IDENTITY]: identity, [META_DIGEST]: digest, [META_OPERATION]: operation.operationId, [META_GENERATION]: String(operation.dispatchGeneration) };
  }

  private async scopeFor(operation: FactoryReleaseOperation, request: FactoryS3PublicationSetRequest, signal?: AbortSignal): Promise<FactoryMaterialScope> {
    return snapshotFactoryMaterialScope({
      tenantId: operation.tenantId, projectId: operation.projectId, runId: operation.runId,
      attemptId: await this.attempts.attemptFor(operation, signal), operationId: request.materialOperationId,
    });
  }

  /**
   * Publishes one approved set.
   *
   * Order is the whole guarantee: the manifest is refused if it already exists,
   * every member is staged and verified first, and the manifest is written last.
   */
  async publish(claim: FactoryReleaseClaim, signal?: AbortSignal): Promise<FactoryS3ManifestReceipt> {
    if (claim.destination.expectedVersion !== undefined) throw new FactoryReleaseError("factory_s3_immutable_target");
    const directory = this.directory(claim);
    const request = assertFactoryS3PublicationRequest(claim.request, directory);
    const identity = factoryS3PublicationIdentity(claim);
    if (await this.head(this.manifestKey(directory), signal)) throw new FactoryReleaseError("factory_s3_manifest_published");
    const scope = await this.scopeFor(claim, request, signal);
    const files: FactoryS3PublishedFile[] = [];
    for (const member of request.members) files.push(await this.stage(claim, directory, scope, member, identity, signal));
    const manifestBytes = factoryS3PublicationManifestBytes(claim, files);
    const version = await this.write(this.manifestKey(directory), manifestBytes, FACTORY_S3_MANIFEST_MEDIA_TYPE, this.metadata(identity, claim, sha256Hex(manifestBytes)), signal);
    await this.verify(this.manifestKey(directory), version, sha256Hex(manifestBytes), FACTORY_S3_MANIFEST_MEDIA_TYPE, "factory_s3_manifest_unverified", signal);
    return this.receipt(claim, directory, version, sha256Hex(manifestBytes), files);
  }

  private receipt(operation: FactoryReleaseOperation, directory: string, version: string, manifestDigest: string, files: readonly FactoryS3PublishedFile[]): FactoryS3ManifestReceipt {
    const manifestKey = this.manifestKey(directory);
    return {
      schemaVersion: FACTORY_S3_PUBLICATION_RECEIPT_SCHEMA_VERSION, provider: "s3", account: this.options.account,
      object: operation.destination.object, requestDigest: operation.requestDigest, operationId: operation.operationId,
      dispatchGeneration: operation.dispatchGeneration, providerReceiptId: `s3:${this.options.bucket}:${manifestKey}:${version}`,
      version, effectDigest: manifestDigest, bucket: this.options.bucket, directory, manifestKey, files,
    };
  }

  /**
   * Stages one member.
   *
   * An object already at the key is reconciled only when the staging identity and
   * the content digest both match, which is how an interrupted staging resumes
   * and how anything else stays a conflict.
   */
  private async stage(operation: FactoryReleaseOperation, directory: string, scope: FactoryMaterialScope, member: FactoryS3PublicationMember, identity: string, signal?: AbortSignal): Promise<FactoryS3PublishedFile> {
    const key = `${directory}/${member.name}`;
    const existing = await this.head(key, signal);
    let versionId: string;
    if (existing) {
      const metadata = existing.Metadata ?? {};
      if (metadata[META_IDENTITY] !== identity || metadata[META_DIGEST] !== member.digest) throw new FactoryReleaseError("factory_s3_conflicting_content");
      if (!existing.VersionId) throw new FactoryReleaseError("factory_s3_version_missing");
      versionId = existing.VersionId;
    } else {
      versionId = await this.export(operation, key, scope, member, identity, signal);
    }
    await this.verify(key, versionId, member.digest, member.mediaType, "factory_s3_member_unverified", signal);
    return { name: member.name, key, mediaType: member.mediaType, digest: member.digest, encodedBytes: member.totalBytes, versionId };
  }

  /** Reads one member's W04 chunks in order. Each chunk is at most one S3 part. */
  private async *chunks(scope: FactoryMaterialScope, member: FactoryS3PublicationMember, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    for (let index = 0; index < member.chunkCount; index += 1) {
      signal?.throwIfAborted();
      yield await this.reader.readChunk(scope, member.artifact, index, signal);
    }
  }

  private async export(operation: FactoryReleaseOperation, key: string, scope: FactoryMaterialScope, member: FactoryS3PublicationMember, identity: string, signal?: AbortSignal): Promise<string> {
    const metadata = this.metadata(identity, operation, member.digest);
    if (member.totalBytes >= FACTORY_S3_PUBLICATION_LIMITS.partBytes) return this.exportMultipart(key, scope, member, metadata, signal);
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of this.chunks(scope, member, signal)) {
      total += chunk.byteLength;
      if (total > member.totalBytes) throw new FactoryReleaseError("factory_s3_member_digest_mismatch");
      parts.push(chunk);
    }
    const bytes = concatenate(parts, total);
    if (total !== member.totalBytes || sha256Hex(bytes) !== member.digest) throw new FactoryReleaseError("factory_s3_member_digest_mismatch");
    return this.write(key, bytes, member.mediaType, metadata, signal);
  }

  /**
   * Exports one large member as a real multipart upload.
   *
   * The running SHA-256 is completed before the upload is, so a member whose
   * bytes changed under it is aborted and never becomes an object. Chunks are
   * repacked to the part size because S3 refuses a non-final part below five MiB.
   */
  private async exportMultipart(key: string, scope: FactoryMaterialScope, member: FactoryS3PublicationMember, metadata: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const created = await this.send<{ UploadId?: string }>(new CreateMultipartUploadCommand({ Bucket: this.options.bucket, Key: key, ContentType: member.mediaType, Metadata: metadata, ChecksumAlgorithm: "SHA256" }), signal);
    if (!created.UploadId) throw new FactoryReleaseError("factory_s3_multipart_unavailable");
    try {
      const hash = createHash("sha256");
      const parts: Array<{ ETag: string; PartNumber: number; ChecksumSHA256: string }> = [];
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;
      let total = 0;
      const flush = async (): Promise<void> => {
        const part = concatenate(pending, pendingBytes);
        const checksum = sha256Base64(part);
        const uploaded = await this.send<{ ETag?: string }>(new UploadPartCommand({ Bucket: this.options.bucket, Key: key, UploadId: created.UploadId, PartNumber: parts.length + 1, Body: part, ChecksumSHA256: checksum }), signal);
        if (!uploaded.ETag) throw new FactoryReleaseError("factory_s3_multipart_unavailable");
        parts.push({ ETag: uploaded.ETag, PartNumber: parts.length + 1, ChecksumSHA256: checksum });
        pending = [];
        pendingBytes = 0;
      };
      for await (const chunk of this.chunks(scope, member, signal)) {
        hash.update(chunk);
        total += chunk.byteLength;
        if (total > member.totalBytes) throw new FactoryReleaseError("factory_s3_member_digest_mismatch");
        pending.push(chunk);
        pendingBytes += chunk.byteLength;
        if (pendingBytes >= FACTORY_S3_PUBLICATION_LIMITS.partBytes) await flush();
      }
      if (pendingBytes > 0) await flush();
      if (total !== member.totalBytes || `sha256:${hash.digest("hex")}` !== member.digest) throw new FactoryReleaseError("factory_s3_member_digest_mismatch");
      const completed = await this.send<{ VersionId?: string }>(new CompleteMultipartUploadCommand({ Bucket: this.options.bucket, Key: key, UploadId: created.UploadId, MultipartUpload: { Parts: parts }, IfNoneMatch: "*" }), signal);
      if (!completed.VersionId) throw new FactoryReleaseError("factory_s3_version_missing");
      return completed.VersionId;
    } catch (error) {
      await this.send(new AbortMultipartUploadCommand({ Bucket: this.options.bucket, Key: key, UploadId: created.UploadId })).catch(() => undefined);
      if (s3ErrorIsConflict(error)) throw new FactoryReleaseError("factory_s3_version_changed");
      throw error;
    }
  }

  /** One conditional private create. A lost race is a changed version, never an overwrite. */
  private async write(key: string, bytes: Uint8Array, mediaType: string, metadata: Record<string, string>, signal?: AbortSignal): Promise<string> {
    let written: { VersionId?: string };
    try {
      written = await this.send<{ VersionId?: string }>(new PutObjectCommand({
        Bucket: this.options.bucket, Key: key, Body: bytes, ContentType: mediaType, Metadata: metadata,
        ChecksumSHA256: sha256Base64(bytes), IfNoneMatch: "*",
      }), signal);
    } catch (error) {
      if (s3ErrorIsConflict(error)) throw new FactoryReleaseError("factory_s3_version_changed");
      throw error;
    }
    if (!written.VersionId) throw new FactoryReleaseError("factory_s3_version_missing");
    return written.VersionId;
  }

  /** Reads back the exact version and proves its digest, media type, and version identity. */
  private async verify(key: string, versionId: string, digest: string, mediaType: string, code: string, signal?: AbortSignal): Promise<void> {
    const restored = await this.send<S3Body>(new GetObjectCommand({ Bucket: this.options.bucket, Key: key, VersionId: versionId }), signal);
    if (restored.VersionId !== versionId || restored.ContentType !== mediaType || await s3BodyDigest(restored.Body) !== digest) throw new FactoryReleaseError(code);
  }

  /**
   * Rebuilds the receipt this operation must have produced, from the store alone.
   *
   * It reads the manifest at the named version, re-reads every file the manifest
   * names at that file's own version, and reconciles both against the frozen
   * request. Nothing in the caller's receipt is trusted to build the answer.
   */
  private async readReceipt(operation: FactoryReleaseOperation, version: string, signal?: AbortSignal): Promise<FactoryS3ManifestReceipt> {
    const directory = this.directory(operation);
    const request = assertFactoryS3PublicationRequest(operation.request, directory);
    const restored = await this.send<S3Body>(new GetObjectCommand({ Bucket: this.options.bucket, Key: this.manifestKey(directory), VersionId: version }), signal);
    if (restored.VersionId !== version || restored.ContentType !== FACTORY_S3_MANIFEST_MEDIA_TYPE) throw new FactoryReleaseError("factory_s3_receipt_corrupt");
    const bytes = await s3ManifestBytes(restored.Body);
    const manifest = parseManifest(bytes);
    if (manifest.operationId !== operation.operationId || manifest.dispatchGeneration !== operation.dispatchGeneration || manifest.requestDigest !== operation.requestDigest || manifest.files.length !== request.members.length) throw new FactoryReleaseError("factory_s3_receipt_corrupt");
    const files: FactoryS3PublishedFile[] = [];
    for (const [index, member] of request.members.entries()) {
      const file = manifest.files[index]!;
      if (file.name !== member.name || file.key !== `${directory}/${member.name}` || file.digest !== member.digest || file.mediaType !== member.mediaType || file.encodedBytes !== member.totalBytes) throw new FactoryReleaseError("factory_s3_receipt_corrupt");
      await this.verify(file.key, file.versionId, member.digest, member.mediaType, "factory_s3_receipt_corrupt", signal);
      files.push({ name: file.name, key: file.key, mediaType: file.mediaType, digest: file.digest, encodedBytes: file.encodedBytes, versionId: file.versionId });
    }
    if (sha256Hex(factoryS3PublicationManifestBytes(operation, files)) !== sha256Hex(bytes)) throw new FactoryReleaseError("factory_s3_receipt_corrupt");
    return this.receipt(operation, directory, version, sha256Hex(bytes), files);
  }

  /**
   * The receipt this operation's live directory currently supports, or `null`
   * when no manifest is present.
   *
   * It writes nothing. Reconciliation uses it when a response was lost after the
   * manifest write but before the receipt reached the archive, so an operator
   * attaches the effect that exists instead of publishing a second one.
   */
  async describePublication(operation: FactoryReleaseOperation, signal?: AbortSignal): Promise<FactoryS3ManifestReceipt | null> {
    const head = await this.head(this.manifestKey(this.directory(operation)), signal);
    if (!head) return null;
    if (!head.VersionId) throw new FactoryReleaseError("factory_s3_version_missing");
    return this.readReceipt(operation, head.VersionId, signal);
  }

  /**
   * Verifies a receipt against the live store without writing anything.
   *
   * A receipt that names a version the store does not hold is unverified rather
   * than an error, so reconciliation can keep an operation uncertain instead of
   * settling it.
   */
  async verifyReceipt(operation: FactoryReleaseOperation, receipt: FactoryProviderReceipt, _evidence: unknown, signal?: AbortSignal): Promise<boolean> {
    [operation, receipt] = structuredClone([operation, receipt]);
    if (typeof receipt.version !== "string" || !receipt.version || receipt.version.length > 512) return false;
    try { return canonicalJson(await this.readReceipt(operation, receipt.version, signal)) === canonicalJson(receipt); }
    catch (error) {
      if (s3ErrorIsMissing(error)) return false;
      throw error;
    }
  }

  /**
   * Proves this operation published nothing.
   *
   * The manifest must be absent, and any object already staged under the
   * directory must belong to this exact operation, so a foreign write under the
   * same directory keeps the outcome uncertain rather than proving absence.
   */
  async proveNoEffect(operation: FactoryReleaseOperation, evidence: unknown, signal?: AbortSignal): Promise<boolean> {
    if (!evidence || typeof evidence !== "object" || (evidence as { operationId?: unknown }).operationId !== operation.operationId || (evidence as { reason?: unknown }).reason === undefined) return false;
    if (operation.destination.expectedVersion !== undefined) return false;
    const directory = this.directory(operation);
    const request = assertFactoryS3PublicationRequest(operation.request, directory);
    if (await this.head(this.manifestKey(directory), signal)) return false;
    const identity = factoryS3PublicationIdentity(operation);
    for (const member of request.members) {
      const staged = await this.head(`${directory}/${member.name}`, signal);
      if (staged && (staged.Metadata?.[META_IDENTITY] !== identity || staged.Metadata?.[META_DIGEST] !== member.digest)) return false;
    }
    return true;
  }
}

/** The manifest is bounded, so it is the one object this provider holds whole. */
async function s3ManifestBytes(body: unknown): Promise<Uint8Array> {
  if (body && typeof (body as Partial<S3StreamBody>)[Symbol.asyncIterator] === "function") {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of body as S3StreamBody) {
      total += chunk.byteLength;
      if (total > FACTORY_MATERIAL_LIMITS.maxChunkBytes) throw new FactoryReleaseError("factory_s3_receipt_corrupt");
      parts.push(chunk);
    }
    return concatenate(parts, total);
  }
  if (body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    if (bytes.byteLength > FACTORY_MATERIAL_LIMITS.maxChunkBytes) throw new FactoryReleaseError("factory_s3_receipt_corrupt");
    return bytes;
  }
  throw new FactoryReleaseError("factory_s3_receipt_unreadable");
}

function parseManifest(bytes: Uint8Array): FactoryS3PublicationManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new FactoryReleaseError("factory_s3_receipt_corrupt"); }
  const manifest = parsed as FactoryS3PublicationManifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.schemaVersion !== FACTORY_S3_PUBLICATION_MANIFEST_SCHEMA_VERSION || !Array.isArray(manifest.files)) throw new FactoryReleaseError("factory_s3_receipt_corrupt");
  for (const file of manifest.files) {
    if (!file || typeof file !== "object" || typeof file.name !== "string" || typeof file.key !== "string" || typeof file.mediaType !== "string" || typeof file.digest !== "string" || typeof file.versionId !== "string" || !file.versionId || !Number.isSafeInteger(file.encodedBytes)) throw new FactoryReleaseError("factory_s3_receipt_corrupt");
  }
  return manifest;
}
