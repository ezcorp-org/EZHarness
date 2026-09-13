import { expect, test } from "bun:test";
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { digestBytes, S3BlobStore } from "./index";
import { s3ObjectKey } from "./blobs";

class MemoryS3 {
  readonly objects = new Map<string, Uint8Array>();
  readonly versions = new Map<string, Uint8Array>();
  readonly uploads = new Map<string, Uint8Array[]>();
  private uploadNumber = 0;
  conflictOnce = false;
  corrupt = false;

  async send(command: unknown): Promise<Record<string, unknown>> {
    if (command instanceof PutObjectCommand) {
      const input = command.input;
      if (this.conflictOnce) {
        this.conflictOnce = false;
        throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
      }
      if (this.objects.has(input.Key!)) throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
      this.objects.set(input.Key!, input.Body as Uint8Array);
      return {};
    }
    if (command instanceof CreateMultipartUploadCommand) {
      const id = `upload-${this.uploadNumber++}`;
      this.uploads.set(id, []);
      return { UploadId: id };
    }
    if (command instanceof UploadPartCommand) {
      this.uploads.get(command.input.UploadId!)![command.input.PartNumber! - 1] = command.input.Body as Uint8Array;
      return { ETag: `etag-${command.input.PartNumber}` };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      if (this.objects.has(command.input.Key!)) throw { name: "ConditionalRequestConflict", $metadata: { httpStatusCode: 409 } };
      this.objects.set(command.input.Key!, Uint8Array.from(this.uploads.get(command.input.UploadId!)!.flatMap((part) => [...part])));
      return {};
    }
    if (command instanceof AbortMultipartUploadCommand) return {};
    if (command instanceof GetObjectCommand) {
      const bytes = command.input.VersionId ? this.versions.get(command.input.VersionId) : this.objects.get(command.input.Key!);
      if (!bytes) throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
      const result = this.corrupt ? new Uint8Array([0]) : bytes;
      return { Body: { async transformToByteArray() { return result; } } };
    }
    if (command instanceof HeadObjectCommand) return { ChecksumSHA256: "checksum" };
    throw new Error("Unexpected S3 command");
  }
}

function store(client = new MemoryS3(), options: Partial<{ multipartThresholdBytes: number; multipartPartBytes: number }> = {}) {
  return {
    client,
    store: new S3BlobStore({ endpoint: "http://127.0.0.1:18333", bucket: "tenant-01", prefix: "ordinary/releases", credentials: { accessKeyId: "access", secretAccessKey: "secret" }, client, ...options }),
  };
}

test("S3 blobs use a bounded prefix and conditional content address", async () => {
  const { client, store: blobs } = store();
  const bytes = new TextEncoder().encode("immutable release");
  const digest = await blobs.put(bytes);

  expect(digest).toBe(digestBytes(bytes));
  expect(client.objects.get(s3ObjectKey("ordinary/releases", digest))).toEqual(bytes);
  expect(await blobs.get(digest)).toEqual(bytes);
  expect(await blobs.checksum(digest)).toBe("checksum");

  client.conflictOnce = true;
  expect(await blobs.put(bytes)).toBe(digest);
});

test("S3 blobs abort a conflicting multipart upload after immutable content already exists", async () => {
  const { client, store: blobs } = store(undefined, { multipartThresholdBytes: 5 * 1024 * 1024, multipartPartBytes: 5 * 1024 * 1024 });
  const bytes = new Uint8Array(5 * 1024 * 1024 + 1).fill(7);
  const digest = await blobs.put(bytes);

  expect(await blobs.put(bytes)).toBe(digest);
  expect(await blobs.get(digest)).toEqual(bytes);
  expect(client.uploads.size).toBe(2);
});

test("S3 blobs reject invalid configuration, absent versions, corrupt bytes, and missing objects", async () => {
  expect(() => new S3BlobStore({ endpoint: "http://127.0.0.1", bucket: "", prefix: "ordinary", credentials: { accessKeyId: "", secretAccessKey: "" } })).toThrow();
  expect(() => s3ObjectKey("../ordinary", "0".repeat(64))).toThrow();
  expect(() => s3ObjectKey("ordinary", "invalid")).toThrow();

  const { client, store: blobs } = store();
  await expect(blobs.get("a".repeat(64))).rejects.toMatchObject({ code: "artifact_missing" });
  await expect(blobs.getVersion("a".repeat(64), "")).rejects.toMatchObject({ code: "invalid_digest" });

  const bytes = new TextEncoder().encode("versioned");
  const digest = digestBytes(bytes);
  client.versions.set("v1", bytes);
  expect(await blobs.getVersion(digest, "v1")).toEqual(bytes);
  client.objects.set(s3ObjectKey("ordinary/releases", digest), bytes);
  client.corrupt = true;
  await expect(blobs.get(digest)).rejects.toMatchObject({ code: "artifact_corrupt" });
});
