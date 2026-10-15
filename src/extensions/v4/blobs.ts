import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, link, unlink, realpath, lstat, type FileHandle } from "node:fs/promises";
import { resolve, join } from "node:path";
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { canonicalJson, validateArtifactFiles, validateWorkspaceFiles, validateWorkspacePath, type WorkspaceFiles } from "@ezcorp/extension-contract";
import { digestBytes } from "./digest";
import { LifecycleError, type BlobOperationOptions, type BlobStore } from "./types";
import { idempotencyInputDigest } from "../../idempotency";

export { canonicalJson } from "@ezcorp/extension-contract";
// The pure digests live in `digest.ts` so a caller that needs only a hash does not pull in an S3
// client. Re-exported here because every existing caller imports them from this module.
export { digestBytes } from "./digest";

export function digestObject(value: unknown): string {
  return idempotencyInputDigest(value);
}



const MAX_BLOB_BYTES = 192 * 1024 * 1024;
const S3_MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_S3_KEY_BYTES = 1024;

export interface S3BlobStoreOptions {
  endpoint: string;
  bucket: string;
  prefix: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  region?: string;
  multipartThresholdBytes?: number;
  multipartPartBytes?: number;
  client?: Pick<S3Client, "send">;
}

interface S3ResponseBody {
  transformToByteArray(): Promise<Uint8Array>;
}

interface S3StreamBody extends AsyncIterable<Uint8Array> {}

function validatedDigest(digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new LifecycleError("invalid_digest", "Invalid content digest.");
  return digest;
}

export function s3ObjectKey(prefix: string, digest: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized) || normalized.includes("//") || normalized.split("/").some((part) => part === "." || part === "..")) {
    throw new LifecycleError("invalid_path", "S3 object storage needs a bounded relative prefix.");
  }
  const key = `${normalized}/${validatedDigest(digest)}`;
  if (new TextEncoder().encode(key).byteLength > MAX_S3_KEY_BYTES) {
    throw new LifecycleError("invalid_path", "S3 object storage key exceeds the S3 byte limit.");
  }
  return key;
}

function sha256Base64(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64");
}

function statusCode(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

function isConditionalConflict(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  return statusCode(error) === 409 || statusCode(error) === 412 || name === "PreconditionFailed" || name === "ConditionalRequestConflict";
}

function isMissing(error: unknown): boolean {
  const name = (error as { name?: string }).name;
  return statusCode(error) === 404 || name === "NoSuchKey" || name === "NoSuchVersion" || name === "NotFound";
}

function boundedS3Length(length: number | undefined): void {
  if (length !== undefined && (!Number.isSafeInteger(length) || length < 0 || length > MAX_BLOB_BYTES)) {
    throw new LifecycleError("artifact_corrupt", "Stored S3 content has an invalid or oversized length.");
  }
}

function isS3StreamBody(body: unknown): body is S3StreamBody {
  return Boolean(body && typeof (body as Partial<S3StreamBody>)[Symbol.asyncIterator] === "function");
}

async function bytesFromBody(body: unknown, contentLength: number | undefined): Promise<Uint8Array> {
  boundedS3Length(contentLength);
  if (!isS3StreamBody(body) && (!body || typeof (body as Partial<S3ResponseBody>).transformToByteArray !== "function")) {
    throw new LifecycleError("artifact_corrupt", "Stored S3 content has no readable response body.");
  }
  if (!isS3StreamBody(body)) {
    const bytes = await (body as S3ResponseBody).transformToByteArray();
    if (bytes.byteLength > MAX_BLOB_BYTES || (contentLength !== undefined && bytes.byteLength !== contentLength)) {
      throw new LifecycleError("artifact_corrupt", "Stored S3 content has an invalid length.");
    }
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of body) {
    byteLength += chunk.byteLength;
    if (byteLength > MAX_BLOB_BYTES) throw new LifecycleError("artifact_corrupt", "Stored S3 content exceeds the artifact byte limit.");
    chunks.push(chunk);
  }
  if (contentLength !== undefined && byteLength !== contentLength) {
    throw new LifecycleError("artifact_corrupt", "Stored S3 content has an invalid length.");
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The S3 client's per-request options: an abort signal when the caller gave one. */
function sendOptions(signal: AbortSignal | undefined): { abortSignal: AbortSignal } | undefined {
  return signal === undefined ? undefined : { abortSignal: signal };
}

export class S3BlobStore implements BlobStore {
  private readonly client: Pick<S3Client, "send">;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly multipartThresholdBytes: number;
  private readonly multipartPartBytes: number;

  constructor(options: S3BlobStoreOptions) {
    if (!options.bucket || !options.credentials.accessKeyId || !options.credentials.secretAccessKey) throw new LifecycleError("artifact_corrupt", "S3 blob storage needs a bucket and explicit credentials.");
    this.bucket = options.bucket;
    this.prefix = options.prefix;
    s3ObjectKey(this.prefix, "0".repeat(64));
    this.multipartThresholdBytes = options.multipartThresholdBytes ?? 8 * 1024 * 1024;
    this.multipartPartBytes = options.multipartPartBytes ?? S3_MIN_PART_BYTES;
    if (!Number.isSafeInteger(this.multipartThresholdBytes) || !Number.isSafeInteger(this.multipartPartBytes) || this.multipartThresholdBytes < S3_MIN_PART_BYTES || this.multipartPartBytes < S3_MIN_PART_BYTES || this.multipartThresholdBytes > MAX_BLOB_BYTES || this.multipartPartBytes > MAX_BLOB_BYTES) {
      throw new LifecycleError("artifact_corrupt", "S3 multipart limits must be safe whole-byte values from five MiB through the artifact limit.");
    }
    this.client = options.client ?? new S3Client({ endpoint: options.endpoint, region: options.region ?? "us-east-1", forcePathStyle: true, credentials: options.credentials });
  }

  private key(digest: string): string {
    return s3ObjectKey(this.prefix, digest);
  }

  private async verifyExisting(digest: string, signal?: AbortSignal): Promise<void> {
    const bytes = await this.get(digest, { signal });
    if (digestBytes(bytes) !== digest) throw new LifecycleError("artifact_corrupt", "Stored S3 content does not match its digest.");
  }

  private async putSingle(key: string, bytes: Uint8Array, checksum: string, signal?: AbortSignal): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, IfNoneMatch: "*", ChecksumSHA256: checksum }), sendOptions(signal));
  }

  private async putMultipart(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    const created = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ChecksumAlgorithm: "SHA256" }), sendOptions(signal));
    if (!created.UploadId) throw new LifecycleError("artifact_corrupt", "S3 did not create a multipart upload.");
    try {
      const parts: Array<{ ETag: string; PartNumber: number; ChecksumSHA256: string }> = [];
      for (let offset = 0, partNumber = 1; offset < bytes.byteLength; offset += this.multipartPartBytes, partNumber += 1) {
        const part = bytes.subarray(offset, Math.min(bytes.byteLength, offset + this.multipartPartBytes));
        const uploaded = await this.client.send(new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: created.UploadId, PartNumber: partNumber, Body: part, ChecksumSHA256: sha256Base64(part) }), sendOptions(signal));
        if (!uploaded.ETag) throw new LifecycleError("artifact_corrupt", "S3 did not return a multipart part identity.");
        parts.push({ ETag: uploaded.ETag, PartNumber: partNumber, ChecksumSHA256: sha256Base64(part) });
      }
      await this.client.send(new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: created.UploadId, MultipartUpload: { Parts: parts }, IfNoneMatch: "*" }), sendOptions(signal));
    } catch (error) {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: created.UploadId })).catch(() => undefined);
      throw error;
    }
  }

  async put(bytes: Uint8Array, options: BlobOperationOptions = {}): Promise<string> {
    if (bytes.byteLength > MAX_BLOB_BYTES) throw new LifecycleError("artifact_corrupt", "Stored content exceeds the artifact byte limit.");
    const digest = digestBytes(bytes);
    const key = this.key(digest);
    try {
      if (bytes.byteLength >= this.multipartThresholdBytes) await this.putMultipart(key, bytes, options.signal);
      else await this.putSingle(key, bytes, sha256Base64(bytes), options.signal);
    } catch (error) {
      if (!isConditionalConflict(error)) throw error;
      await this.verifyExisting(digest, options.signal);
    }
    return digest;
  }

  private async getS3Object(digest: string, versionId?: string, signal?: AbortSignal): Promise<Uint8Array> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(digest), VersionId: versionId, ChecksumMode: "ENABLED" }), sendOptions(signal));
      const bytes = await bytesFromBody(result.Body, result.ContentLength);
      if (digestBytes(bytes) !== digest) throw new LifecycleError("artifact_corrupt", "Stored S3 content does not match its digest.");
      return bytes;
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      if (isMissing(error)) throw new LifecycleError("artifact_missing", "Stored extension files are missing. Restore extension release storage from backup.");
      throw error;
    }
  }

  async get(digest: string, options: BlobOperationOptions = {}): Promise<Uint8Array> {
    return this.getS3Object(digest, undefined, options.signal);
  }

  async getVersion(digest: string, versionId: string): Promise<Uint8Array> {
    if (!versionId) throw new LifecycleError("invalid_digest", "S3 version identity is required.");
    return this.getS3Object(digest, versionId);
  }

  /** The immutable S3 version that was current after a successful put. */
  async version(digest: string): Promise<string> {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(digest) }));
    if (!result.VersionId) throw new LifecycleError("artifact_corrupt", "S3 did not return an immutable object version.");
    return result.VersionId;
  }

  async checksum(digest: string): Promise<string | undefined> {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(digest), ChecksumMode: "ENABLED" }));
    return result.ChecksumSHA256;
  }
}



export function validatePath(path: string): void {
  try { validateWorkspacePath(path); } catch { throw new LifecycleError("invalid_path", "Use a bounded relative file path without traversal."); }
}

export function validateFiles(files: WorkspaceFiles, kind: "workspace" | "artifact" = "workspace"): void {
  if (kind === "artifact") validateArtifactFiles(files);
  else validateWorkspaceFiles(files);
}

export async function putFiles(blobs: BlobStore, files: WorkspaceFiles, kind: "workspace" | "artifact" = "workspace"): Promise<string> {
  validateFiles(files, kind);
  return blobs.put(new TextEncoder().encode(canonicalJson(files)));
}

export async function getFiles(blobs: BlobStore, digest: string, kind: "workspace" | "artifact" = "workspace"): Promise<WorkspaceFiles> {
  const bytes = await blobs.get(digest);
  if (digestBytes(bytes) !== digest) throw new LifecycleError("artifact_corrupt", "Stored content does not match its digest.");
  const files: WorkspaceFiles = JSON.parse(new TextDecoder().decode(bytes));
  validateFiles(files, kind);
  return files;
}

export type ReleaseBlobAuditCondition = "healthy" | "empty" | "mostly_missing" | "single_missing" | "partially_missing";

export interface ReleaseBlobAudit {
  expected: number;
  present: number;
  missing: number;
  condition: ReleaseBlobAuditCondition;
}

export interface ReleaseBlobAuditReport extends ReleaseBlobAudit {
  partial: boolean;
}

export interface ReleaseBlobDigests {
  sourceDigest: string;
  artifactDigest: string;
}

/** Retain one sentinel record outside the audit cap to make sampling explicit. */
export function boundedReleaseBlobAuditSample<T>(records: readonly T[], limit: number): { records: readonly T[]; partial: boolean } {
  return { records: records.slice(0, limit), partial: records.length > limit };
}

/**
 * Check every immutable release object by name only. Reading and parsing all
 * stored artifacts during boot would turn a volume diagnostic into unbounded
 * startup work, and the digest filenames are already the storage contract.
 */
export async function auditReleaseBlobPresence(blobs: Pick<FileBlobStore, "has">, digests: Iterable<string>): Promise<ReleaseBlobAudit> {
  const expected = [...new Set(digests)];
  let present = 0;
  for (const digest of expected) if (await blobs.has(digest)) present++;
  const missing = expected.length - present;
  const condition: ReleaseBlobAuditCondition = missing === 0 ? "healthy"
    : present === 0 ? "empty"
      : missing === 1 ? "single_missing"
        : missing * 2 > expected.length ? "mostly_missing"
          : "partially_missing";
  return { expected: expected.length, present, missing, condition };
}

/**
 * Classify the persistent release store without logging installation ids,
 * release names, or content digests. The caller supplies the boot logger.
 */
export async function auditReleaseBlobStorage(blobs: Pick<FileBlobStore, "has">, releases: Iterable<ReleaseBlobDigests>, warn: (message: string, details: ReleaseBlobAuditReport) => void, options: { partial?: boolean } = {}): Promise<ReleaseBlobAuditReport> {
  const digests: string[] = [];
  for (const release of releases) digests.push(release.sourceDigest, release.artifactDigest);
  const audit = await auditReleaseBlobPresence(blobs, digests);
  const report = { ...audit, partial: options.partial === true };
  const scope = report.partial ? " in the audited sample" : "";
  if (report.condition === "healthy" && report.partial) warn("Extension release blob audit is partial; no blobs were missing in the audited sample.", report);
  else if (report.condition === "empty") warn(`Extension release blob storage is empty${scope}. The release volume may be renamed or unmounted; mount the expected volume or copy release blobs from the prior volume. Do not restore the database.`, report);
  else if (report.condition === "mostly_missing") warn(`Most extension release blobs are missing${scope}. The release volume may be renamed or unmounted; mount the expected volume or copy release blobs from the prior volume. Do not restore the database.`, report);
  else if (report.condition === "single_missing") warn(`One extension release blob is missing${scope}. Restore or rebuild the affected release.`, report);
  else if (report.condition === "partially_missing") warn(`Some extension release blobs are missing${scope}. Restore or rebuild the affected releases.`, report);
  return report;
}

export class FileBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private async directory(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await realpath(this.root)) !== this.root || !(await lstat(this.root)).isDirectory()) throw new LifecycleError("unsafe_blob_root", "Blob storage must be a host-owned directory without symlinks.");
  }

  async put(bytes: Uint8Array): Promise<string> {
    if (bytes.byteLength > MAX_BLOB_BYTES) throw new LifecycleError("artifact_corrupt", "Stored content exceeds the artifact byte limit.");
    await this.directory();
    const digest = digestBytes(bytes);
    const temporary = join(this.root, `.stage-${randomUUID()}`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      try {
        await link(temporary, join(this.root, digest));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.get(digest);
      }
      const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
      return digest;
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  /** True only for an existing regular blob; never reads its contents. */
  async has(digest: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new LifecycleError("invalid_digest", "Invalid content digest.");
    await this.directory();
    let handle: FileHandle;
    try {
      handle = await open(join(this.root, digest), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw cause;
    }
    try { return (await handle.stat()).isFile(); } finally { await handle.close(); }
  }

  async get(digest: string): Promise<Uint8Array> {
    validatedDigest(digest);
    await this.directory();
    let handle: FileHandle;
    try {
      handle = await open(join(this.root, digest), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new LifecycleError("artifact_missing", "One stored extension release blob is missing. Restore or rebuild the affected release.");
      throw cause;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BLOB_BYTES) throw new LifecycleError("artifact_corrupt", "Stored content is not a bounded regular file.");
      const bytes = await handle.readFile();
      if (digestBytes(bytes) !== digest) throw new LifecycleError("artifact_corrupt", "Stored content does not match its digest.");
      return bytes;
    } finally { await handle.close(); }
  }
}
