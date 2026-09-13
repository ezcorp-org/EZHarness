import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, link, unlink, realpath, lstat, type FileHandle } from "node:fs/promises";
import { resolve, join } from "node:path";
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { canonicalJson, validateArtifactFiles, validateWorkspaceFiles, validateWorkspacePath, type WorkspaceFiles } from "@ezcorp/extension-contract";
import { LifecycleError, type BlobStore } from "./types";

export { canonicalJson } from "@ezcorp/extension-contract";

export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const MAX_BLOB_BYTES = 192 * 1024 * 1024;
const S3_MIN_PART_BYTES = 5 * 1024 * 1024;

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

function validatedDigest(digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new LifecycleError("invalid_digest", "Invalid content digest.");
  return digest;
}

export function s3ObjectKey(prefix: string, digest: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized) || normalized.includes("//") || normalized.split("/").some((part) => part === "." || part === "..")) {
    throw new LifecycleError("invalid_path", "S3 object storage needs a bounded relative prefix.");
  }
  return `${normalized}/${validatedDigest(digest)}`;
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
  return statusCode(error) === 404 || name === "NoSuchKey" || name === "NotFound";
}

function bytesFromBody(body: unknown): Promise<Uint8Array> {
  if (body && typeof (body as Partial<S3ResponseBody>).transformToByteArray === "function") return (body as S3ResponseBody).transformToByteArray();
  throw new LifecycleError("artifact_corrupt", "Stored S3 content has no readable response body.");
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
    if (this.multipartThresholdBytes < S3_MIN_PART_BYTES || this.multipartPartBytes < S3_MIN_PART_BYTES) throw new LifecycleError("artifact_corrupt", "S3 multipart limits must be at least five MiB.");
    this.client = options.client ?? new S3Client({ endpoint: options.endpoint, region: options.region ?? "us-east-1", forcePathStyle: true, credentials: options.credentials });
  }

  private key(digest: string): string {
    return s3ObjectKey(this.prefix, digest);
  }

  private async verifyExisting(digest: string): Promise<void> {
    const bytes = await this.get(digest);
    if (digestBytes(bytes) !== digest) throw new LifecycleError("artifact_corrupt", "Stored S3 content does not match its digest.");
  }

  private async putSingle(key: string, bytes: Uint8Array, checksum: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, IfNoneMatch: "*", ChecksumSHA256: checksum }));
  }

  private async putMultipart(key: string, bytes: Uint8Array, checksum: string): Promise<void> {
    const created = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ChecksumAlgorithm: "SHA256" }));
    if (!created.UploadId) throw new LifecycleError("artifact_corrupt", "S3 did not create a multipart upload.");
    try {
      const parts: Array<{ ETag: string; PartNumber: number }> = [];
      for (let offset = 0, partNumber = 1; offset < bytes.byteLength; offset += this.multipartPartBytes, partNumber += 1) {
        const part = bytes.subarray(offset, Math.min(bytes.byteLength, offset + this.multipartPartBytes));
        const uploaded = await this.client.send(new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: created.UploadId, PartNumber: partNumber, Body: part, ChecksumSHA256: sha256Base64(part) }));
        if (!uploaded.ETag) throw new LifecycleError("artifact_corrupt", "S3 did not return a multipart part identity.");
        parts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
      }
      await this.client.send(new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: created.UploadId, MultipartUpload: { Parts: parts }, IfNoneMatch: "*", ChecksumSHA256: checksum }));
    } catch (error) {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: created.UploadId })).catch(() => undefined);
      throw error;
    }
  }

  async put(bytes: Uint8Array): Promise<string> {
    if (bytes.byteLength > MAX_BLOB_BYTES) throw new LifecycleError("artifact_corrupt", "Stored content exceeds the artifact byte limit.");
    const digest = digestBytes(bytes);
    const key = this.key(digest);
    try {
      if (bytes.byteLength >= this.multipartThresholdBytes) await this.putMultipart(key, bytes, sha256Base64(bytes));
      else await this.putSingle(key, bytes, sha256Base64(bytes));
    } catch (error) {
      if (!isConditionalConflict(error)) throw error;
      await this.verifyExisting(digest);
    }
    return digest;
  }

  async get(digest: string): Promise<Uint8Array> {
    const key = this.key(digest);
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: "ENABLED" }));
      const bytes = await bytesFromBody(result.Body);
      if (digestBytes(bytes) !== digest) throw new LifecycleError("artifact_corrupt", "Stored S3 content does not match its digest.");
      return bytes;
    } catch (error) {
      if (isMissing(error)) throw new LifecycleError("artifact_missing", "Stored extension files are missing. Restore extension release storage from backup.");
      throw error;
    }
  }

  async getVersion(digest: string, versionId: string): Promise<Uint8Array> {
    if (!versionId) throw new LifecycleError("invalid_digest", "S3 version identity is required.");
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(digest), VersionId: versionId, ChecksumMode: "ENABLED" }));
    const bytes = await bytesFromBody(result.Body);
    if (digestBytes(bytes) !== digest) throw new LifecycleError("artifact_corrupt", "Stored S3 version does not match its digest.");
    return bytes;
  }

  async checksum(digest: string): Promise<string | undefined> {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(digest), ChecksumMode: "ENABLED" }));
    return result.ChecksumSHA256;
  }
}

export function digestObject(value: unknown): string {
  return digestBytes(new TextEncoder().encode(canonicalJson(value)));
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

  async get(digest: string): Promise<Uint8Array> {
    validatedDigest(digest);
    await this.directory();
    let handle: FileHandle;
    try {
      handle = await open(join(this.root, digest), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new LifecycleError("artifact_missing", "Stored extension files are missing. Restore extension release storage from backup.");
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
