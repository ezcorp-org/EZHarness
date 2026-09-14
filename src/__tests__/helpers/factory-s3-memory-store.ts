import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";

/**
 * One in-memory S3 for every factory S3 adapter test.
 *
 * It models what the real local SeaweedFS service was measured to do
 * (`/tmp/factory-platform-evidence/w08/seaweedfs-semantics-probe.json`):
 * conditional create refuses with `PreconditionFailed`, object versions are
 * returned by both a single put and a completed multipart upload, user metadata
 * comes back lowercased, a multipart object reports no `ChecksumSHA256`, and a
 * read of an unknown version is `NoSuchVersion`.
 *
 * Faults are fields rather than subclasses so one test can turn on exactly the
 * one it is about.
 */

export interface FactoryMemoryS3Object {
  bytes: Uint8Array;
  version: string;
  etag: string;
  contentType?: string;
  metadata?: Record<string, string>;
  checksum?: string;
  multipart?: boolean;
}

interface MemoryUpload {
  key: string;
  contentType?: string;
  metadata?: Record<string, string>;
  parts: Map<number, Uint8Array>;
}

function joined(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/** A body that is both async-iterable and bufferable, as the real SDK stream is. */
function streamBody(bytes: Uint8Array, chunkBytes: number) {
  return {
    async *[Symbol.asyncIterator]() {
      for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes));
    },
    async transformToByteArray() { return bytes; },
  };
}

export class FactoryMemoryS3Store {
  private sequence = 0;
  readonly current = new Map<string, FactoryMemoryS3Object>();
  readonly versions = new Map<string, FactoryMemoryS3Object>();
  readonly uploads = new Map<string, MemoryUpload>();
  /** Every command class name this store was asked for, in order. */
  readonly calls: string[] = [];
  losePutResponse = false;
  corruptReads = false;
  omitVersions = false;
  omitUploadId = false;
  omitPartETag = false;
  failAbort = false;
  failHeadWith?: { name: string; $metadata: { httpStatusCode: number } };
  /** `"stream"` offers both surfaces, as S3 does; the others isolate one branch. */
  bodyKind: "stream" | "buffer" | "none" = "stream";
  readChunkBytes = 64 * 1024;
  lastAbortSignal?: AbortSignal;

  /** Writes one object outside the adapter, to model a foreign or doctored write. */
  put(key: string, bytes: Uint8Array, options: { contentType?: string; metadata?: Record<string, string>; multipart?: boolean } = {}): FactoryMemoryS3Object {
    const version = `version-${++this.sequence}`;
    const stored: FactoryMemoryS3Object = { bytes, version, etag: `"etag-${this.sequence}${options.multipart ? "-2" : ""}"`, contentType: options.contentType, metadata: options.metadata, multipart: options.multipart };
    this.current.set(key, stored);
    this.versions.set(`${key}:${version}`, stored);
    return stored;
  }

  async send(command: unknown, options?: unknown): Promise<Record<string, unknown>> {
    this.lastAbortSignal = typeof options === "object" && options !== null && "abortSignal" in options ? (options as { abortSignal?: AbortSignal }).abortSignal : undefined;
    this.calls.push((command as { constructor: { name: string } }).constructor.name);
    if (command instanceof HeadObjectCommand) return this.head(command);
    if (command instanceof PutObjectCommand) return this.putObject(command);
    if (command instanceof GetObjectCommand) return this.getObject(command);
    if (command instanceof CreateMultipartUploadCommand) return this.createUpload(command);
    if (command instanceof UploadPartCommand) return this.uploadPart(command);
    if (command instanceof CompleteMultipartUploadCommand) return this.completeUpload(command);
    if (command instanceof AbortMultipartUploadCommand) return this.abortUpload(command);
    throw new Error("unexpected S3 command");
  }

  private head(command: HeadObjectCommand): Record<string, unknown> {
    if (this.failHeadWith) throw this.failHeadWith;
    const item = this.current.get(command.input.Key!);
    if (!item || (command.input.VersionId && command.input.VersionId !== item.version)) throw { name: "NotFound", $metadata: { httpStatusCode: 404 } };
    return { ...(this.omitVersions ? {} : { VersionId: item.version }), ETag: item.etag, ContentType: item.contentType, Metadata: item.metadata, ...(item.multipart ? {} : { ChecksumSHA256: item.checksum }) };
  }

  private putObject(command: PutObjectCommand): Record<string, unknown> {
    const prior = this.current.get(command.input.Key!);
    if ((command.input.IfNoneMatch === "*" && prior) || (command.input.IfMatch && command.input.IfMatch !== prior?.etag)) throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
    const stored = this.put(command.input.Key!, Uint8Array.from(command.input.Body as Uint8Array), { contentType: command.input.ContentType, metadata: command.input.Metadata });
    stored.checksum = command.input.ChecksumSHA256;
    if (this.losePutResponse) throw new Error("response lost after committed write");
    return { ...(this.omitVersions ? {} : { VersionId: stored.version }), ETag: stored.etag };
  }

  private getObject(command: GetObjectCommand): Record<string, unknown> {
    const currentVersion = this.current.get(command.input.Key!)?.version;
    const version = command.input.VersionId ?? currentVersion;
    const item = this.versions.get(`${command.input.Key!}:${version}`);
    if (!item) throw { name: command.input.VersionId ? "NoSuchVersion" : "NoSuchKey", $metadata: { httpStatusCode: 404 } };
    const bytes = this.corruptReads ? new Uint8Array([0]) : item.bytes;
    const body = this.bodyKind === "none" ? {} : this.bodyKind === "buffer" ? { async transformToByteArray() { return bytes; } } : streamBody(bytes, this.readChunkBytes);
    return { Body: body, ContentLength: bytes.byteLength, VersionId: version, ContentType: item.contentType, Metadata: item.metadata };
  }

  private createUpload(command: CreateMultipartUploadCommand): Record<string, unknown> {
    if (this.omitUploadId) return {};
    const uploadId = `upload-${++this.sequence}`;
    this.uploads.set(uploadId, { key: command.input.Key!, contentType: command.input.ContentType, metadata: command.input.Metadata, parts: new Map() });
    return { UploadId: uploadId };
  }

  private uploadPart(command: UploadPartCommand): Record<string, unknown> {
    const upload = this.uploads.get(command.input.UploadId!);
    if (!upload) throw { name: "NoSuchUpload", $metadata: { httpStatusCode: 404 } };
    upload.parts.set(command.input.PartNumber!, Uint8Array.from(command.input.Body as Uint8Array));
    return this.omitPartETag ? {} : { ETag: `"part-${command.input.PartNumber}"` };
  }

  private completeUpload(command: CompleteMultipartUploadCommand): Record<string, unknown> {
    const upload = this.uploads.get(command.input.UploadId!);
    if (!upload) throw { name: "NoSuchUpload", $metadata: { httpStatusCode: 404 } };
    if (command.input.IfNoneMatch === "*" && this.current.get(upload.key)) throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
    const ordered = [...upload.parts.entries()].sort(([left], [right]) => left - right).map(([, bytes]) => bytes);
    const stored = this.put(upload.key, joined(ordered), { contentType: upload.contentType, metadata: upload.metadata, multipart: true });
    this.uploads.delete(command.input.UploadId!);
    return { ...(this.omitVersions ? {} : { VersionId: stored.version }), ETag: stored.etag };
  }

  private abortUpload(command: AbortMultipartUploadCommand): Record<string, unknown> {
    if (this.failAbort) throw new Error("abort refused");
    this.uploads.delete(command.input.UploadId!);
    return {};
  }
}
