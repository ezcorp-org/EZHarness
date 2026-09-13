import { createHash } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { canonicalJson } from "@ezcorp/extension-contract";
import { S3BlobStore, digestBytes, s3ObjectKey, type S3BlobStoreOptions } from "../extensions/v4/blobs";
import { FactoryReleaseError, type FactoryArchiveObject, type FactoryProviderReceipt, type FactoryReleaseArchive, type FactoryReleaseClaim, type FactoryReleaseOperation, type FactoryReleaseProvider } from "./releases";

interface S3ResponseBody { transformToByteArray(): Promise<Uint8Array> }
type ArchiveS3ClientLike = Pick<S3Client, "send">;
interface S3ClientLike { send(command: unknown, options?: { readonly abortSignal?: AbortSignal }): Promise<unknown> }

export interface FactoryS3ArchiveOptions extends Omit<S3BlobStoreOptions, "prefix" | "client"> {
  readonly prefix: string;
  readonly client?: ArchiveS3ClientLike;
}

function archiveSegment(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.includes("\0")) throw new FactoryReleaseError("factory_release_archive_path");
  return Buffer.from(value).toString("base64url");
}

function sha256(value: Uint8Array): string { return `sha256:${digestBytes(value)}`; }

function status(error: unknown): number | undefined { return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode; }
function missing(error: unknown): boolean { return status(error) === 404 || ["NoSuchKey", "NoSuchVersion", "NotFound"].includes((error as { name?: string }).name ?? ""); }
function conflict(error: unknown): boolean { return status(error) === 409 || status(error) === 412 || ["PreconditionFailed", "ConditionalRequestConflict"].includes((error as { name?: string }).name ?? ""); }

function makeClient(options: FactoryS3ArchiveOptions): ArchiveS3ClientLike {
  return options.client ?? new S3Client({ endpoint: options.endpoint, region: options.region ?? "us-east-1", forcePathStyle: true, credentials: options.credentials, maxAttempts: 1 });
}

/** Conditional immutable release archive built on the shared digest-verifying S3 blob store. */
export class S3FactoryReleaseArchive implements FactoryReleaseArchive {
  private readonly client: ArchiveS3ClientLike;
  private readonly root: string;
  constructor(private readonly options: FactoryS3ArchiveOptions) {
    this.root = options.prefix.replace(/^\/+|\/+$/g, "");
    s3ObjectKey(this.root, "0".repeat(64));
    this.client = makeClient(options);
  }

  private store(prefix: string): S3BlobStore { return new S3BlobStore({ ...this.options, prefix, client: this.client }); }

  async writeImmutable(tenantId: string, operationId: string, name: "intent" | "material" | "receipt" | "reconciliation", bytes: Uint8Array): Promise<FactoryArchiveObject> {
    const prefix = `${this.root}/${archiveSegment(tenantId)}/${archiveSegment(operationId)}/${name}`;
    const rawDigest = await this.store(prefix).put(bytes);
    const key = s3ObjectKey(prefix, rawDigest);
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key, ChecksumMode: "ENABLED" })) as { VersionId?: string; ChecksumSHA256?: string };
    const expectedChecksum = createHash("sha256").update(bytes).digest("base64");
    if (head.ChecksumSHA256 && head.ChecksumSHA256 !== expectedChecksum) throw new FactoryReleaseError("factory_release_archive_corrupt");
    if (!head.VersionId) throw new FactoryReleaseError("factory_release_archive_version_missing");
    return { key, digest: `sha256:${rawDigest}`, versionId: head.VersionId };
  }

  async read(reference: FactoryArchiveObject): Promise<Uint8Array> {
    if (!reference.key.startsWith(`${this.root}/`) || !/^sha256:[a-f0-9]{64}$/.test(reference.digest)) throw new FactoryReleaseError("factory_release_archive_foreign");
    const suffix = `/${reference.digest.slice(7)}`;
    if (!reference.key.endsWith(suffix)) throw new FactoryReleaseError("factory_release_archive_foreign");
    const prefix = reference.key.slice(0, -suffix.length);
    if (!reference.versionId) throw new FactoryReleaseError("factory_release_archive_version_missing");
    const bytes = await this.store(prefix).getVersion(reference.digest.slice(7), reference.versionId);
    if (sha256(bytes) !== reference.digest) throw new FactoryReleaseError("factory_release_archive_corrupt");
    return bytes;
  }
}

export interface FactoryS3PublicationOptions {
  readonly endpoint: string;
  readonly bucket: string;
  readonly account: string;
  readonly prefix?: string;
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string };
  readonly region?: string;
  readonly client?: S3ClientLike;
}

interface S3PublicationRequest { readonly bytesBase64: string; readonly contentType?: string }

function publicationRequest(value: unknown): S3PublicationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FactoryReleaseError("factory_s3_request_invalid");
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every(key => key === "bytesBase64" || key === "contentType") || typeof record.bytesBase64 !== "string" || record.bytesBase64.length > 16 * 1024 * 1024 || record.contentType !== undefined && (typeof record.contentType !== "string" || record.contentType.length > 255)) throw new FactoryReleaseError("factory_s3_request_invalid");
  const bytes = Buffer.from(record.bytesBase64, "base64");
  if (bytes.toString("base64") !== record.bytesBase64) throw new FactoryReleaseError("factory_s3_request_invalid");
  return record as unknown as S3PublicationRequest;
}

async function responseBytes(body: unknown): Promise<Uint8Array> {
  if (!body || typeof (body as Partial<S3ResponseBody>).transformToByteArray !== "function") throw new FactoryReleaseError("factory_s3_receipt_unreadable");
  return (body as S3ResponseBody).transformToByteArray();
}

/** The broker-owned real S3 publisher uses a conditional target write and verifies the returned object version before issuing a receipt. */
export class S3FactoryReleaseProvider implements FactoryReleaseProvider {
  private readonly client: S3ClientLike;
  private readonly prefix: string;
  constructor(private readonly options: FactoryS3PublicationOptions) {
    if (!options.bucket || !options.account || !options.credentials.accessKeyId || !options.credentials.secretAccessKey) throw new FactoryReleaseError("factory_s3_configuration_invalid");
    this.prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.client = options.client ?? new S3Client({ endpoint: options.endpoint, region: options.region ?? "us-east-1", forcePathStyle: true, credentials: options.credentials, maxAttempts: 1 }) as unknown as S3ClientLike;
  }

  private key(operation: FactoryReleaseOperation): string {
    if (operation.destination.provider !== "s3" || operation.destination.account !== this.options.account || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,900}$/.test(operation.destination.object) || operation.destination.object.includes("//") || operation.destination.object.split("/").some(part => part === "." || part === "..")) throw new FactoryReleaseError("factory_s3_foreign_target");
    return this.prefix ? `${this.prefix}/${operation.destination.object}` : operation.destination.object;
  }

  async publish(claim: FactoryReleaseClaim): Promise<FactoryProviderReceipt> {
    const key = this.key(claim);
    const request = publicationRequest(claim.request);
    const bytes = Buffer.from(request.bytesBase64, "base64");
    if (claim.destination.expectedVersion !== undefined) throw new FactoryReleaseError("factory_s3_immutable_target");
    let current: { VersionId?: string } | undefined;
    try { current = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key })) as { VersionId?: string; ETag?: string }; }
    catch (error) { if (!missing(error)) throw error; }
    if (current) throw new FactoryReleaseError("factory_s3_version_changed");
    let written: { VersionId?: string };
    try {
      written = await this.client.send(new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: bytes, ContentType: request.contentType, ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"), IfNoneMatch: "*" })) as { VersionId?: string };
    } catch (error) {
      if (conflict(error)) throw new FactoryReleaseError("factory_s3_version_changed");
      throw error;
    }
    const version = written.VersionId;
    if (!version) throw new FactoryReleaseError("factory_s3_receipt_missing");
    return this.readReceipt(claim, version);
  }

  private async readReceipt(operation: FactoryReleaseOperation, version: string, signal?: AbortSignal): Promise<FactoryProviderReceipt> {
    const key = this.key(operation);
    const request = publicationRequest(operation.request);
    const restored = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key, VersionId: version }), signal ? { abortSignal: signal } : undefined) as { Body?: unknown; VersionId?: string; ContentType?: string };
    const restoredBytes = await responseBytes(restored.Body);
    const expectedDigest = sha256(Buffer.from(request.bytesBase64, "base64"));
    if (restored.VersionId !== version || sha256(restoredBytes) !== expectedDigest || request.contentType !== undefined && restored.ContentType !== request.contentType) throw new FactoryReleaseError("factory_s3_receipt_corrupt");
    return { provider: "s3", account: this.options.account, object: operation.destination.object, requestDigest: operation.requestDigest, operationId: operation.operationId, dispatchGeneration: operation.dispatchGeneration, providerReceiptId: `s3:${this.options.bucket}:${key}:${version}`, version, effectDigest: expectedDigest };
  }

  async verifyReceipt(operation: FactoryReleaseOperation, receipt: FactoryProviderReceipt, _evidence: unknown, signal?: AbortSignal): Promise<boolean> {
    [operation, receipt] = structuredClone([operation, receipt]);
    if (typeof receipt.version !== "string" || !receipt.version || receipt.version.length > 512) return false;
    try { return canonicalJson(await this.readReceipt(operation, receipt.version, signal)) === canonicalJson(receipt); }
    catch (error) { if (missing(error)) return false; throw error; }
  }

  async proveNoEffect(operation: FactoryReleaseOperation, evidence: unknown, signal?: AbortSignal): Promise<boolean> {
    if (!evidence || typeof evidence !== "object" || (evidence as { operationId?: unknown }).operationId !== operation.operationId || (evidence as { reason?: unknown }).reason === undefined) return false;
    const key = this.key(operation);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }), signal ? { abortSignal: signal } : undefined);
      return false;
    } catch (error) { return missing(error) && operation.destination.expectedVersion === undefined; }
  }
}

export function s3ReleaseRequest(bytes: Uint8Array, contentType?: string): S3PublicationRequest {
  return { bytesBase64: Buffer.from(bytes).toString("base64"), ...(contentType ? { contentType } : {}) };
}

export function canonicalProviderReceipt(receipt: FactoryProviderReceipt): string { return canonicalJson(receipt); }
