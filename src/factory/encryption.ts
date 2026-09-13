import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { BlobStore } from "../extensions/v4/types";
import { privateDirectory, readPrivate } from "./private-files.ts";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DATA_KEY_BYTES = 32;
const FORMAT = "factory.encrypted.v1";
const TEMPORAL_ENVELOPE_VERSION = 1;
const TEMPORAL_CRYPTO_OVERHEAD = Buffer.byteLength(FORMAT) + IV_BYTES + TAG_BYTES;
export const FACTORY_TEMPORAL_ENCRYPTED_PAYLOAD_LIMIT = 64 * 1024;

export type EncryptedPayloadKind = "history" | "archive" | "snapshot" | "backup" | "blob";
/** Structural copy of Temporal's PayloadCodec so this Bun-owned module never imports the Node SDK. */
export interface TemporalPayload { readonly metadata?: Record<string, Uint8Array> | null; readonly data?: Uint8Array | null; }
export interface TemporalSerializationContext {
  readonly type: "workflow" | "activity";
  readonly namespace: string;
  readonly workflowId?: string;
  readonly activityId?: string;
  readonly isLocal?: boolean;
}
export interface TemporalPayloadCodec { encode(payloads: TemporalPayload[], context?: TemporalSerializationContext): Promise<TemporalPayload[]>; decode(payloads: TemporalPayload[], context?: TemporalSerializationContext): Promise<TemporalPayload[]>; }

export interface EncryptionBinding {
  readonly installationId: string;
  readonly tenantId: string;
  readonly objectId: string;
  readonly payloadKind: EncryptedPayloadKind;
  readonly version: number;
}

export interface MasterKey {
  readonly id: string;
  readonly bytes: Uint8Array;
}

export interface MasterKeyProvider {
  current(): Promise<MasterKey>;
  get(id: string): Promise<MasterKey | undefined>;
}

export interface InstallationKeyWrap {
  readonly installationId: string;
  readonly wrapVersion: number;
  readonly masterKeyId: string;
  readonly wrappedDataKey: Uint8Array;
}

export interface InstallationKeyWrapStore {
  load(installationId: string): Promise<readonly InstallationKeyWrap[]>;
  save(wrap: InstallationKeyWrap): Promise<void>;
}

export class FactoryEncryptionError extends Error {
  readonly code: "factory_key_missing" | "factory_key_unsafe" | "factory_key_invalid" | "factory_key_conflict" | "factory_payload_too_large" | "factory_decryption_failed" | "factory_encryption_binding_invalid";
  constructor(code: FactoryEncryptionError["code"]) {
    super(code);
    this.code = code;
    this.name = "FactoryEncryptionError";
  }
}

function requireId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new FactoryEncryptionError("factory_encryption_binding_invalid");
}

function key(bytes: Uint8Array): Buffer {
  if (bytes.byteLength !== DATA_KEY_BYTES) throw new FactoryEncryptionError("factory_key_invalid");
  return Buffer.from(bytes);
}

function aad(binding: EncryptionBinding): Buffer {
  requireId(binding.installationId); requireId(binding.tenantId); requireId(binding.objectId);
  if (!Number.isSafeInteger(binding.version) || binding.version < 1) throw new FactoryEncryptionError("factory_encryption_binding_invalid");
  return Buffer.from(`${FORMAT}|${binding.installationId}|${binding.tenantId}|${binding.objectId}|${binding.payloadKind}|${binding.version}`);
}

function encryptBytes(plain: Uint8Array, secret: Uint8Array, binding: EncryptionBinding): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(secret), iv);
  cipher.setAAD(aad(binding));
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from(FORMAT), iv, cipher.getAuthTag(), encrypted]);
}

function decryptBytes(value: Uint8Array, secret: Uint8Array, binding: EncryptionBinding): Uint8Array {
  const prefix = Buffer.from(FORMAT);
  if (value.byteLength < prefix.byteLength + IV_BYTES + TAG_BYTES || !Buffer.from(value.subarray(0, prefix.byteLength)).equals(prefix)) throw new FactoryEncryptionError("factory_decryption_failed");
  const start = prefix.byteLength;
  try {
    const decipher = createDecipheriv(ALGORITHM, key(secret), value.subarray(start, start + IV_BYTES));
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(value.subarray(start + IV_BYTES, start + IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(value.subarray(start + IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch { throw new FactoryEncryptionError("factory_decryption_failed"); }
}

function wrapBinding(installationId: string, version: number, masterKeyId: string): EncryptionBinding {
  return { installationId, tenantId: "installation", objectId: masterKeyId, payloadKind: "backup", version };
}

/** Stable in-memory provider useful for injected KMS adapters and tests. */
export class StaticMasterKeyProvider implements MasterKeyProvider {
  private readonly active: MasterKey;
  private readonly keys: readonly MasterKey[];
  constructor(active: MasterKey, keys: readonly MasterKey[] = [active]) { this.active = active; this.keys = keys; key(active.bytes); requireId(active.id); }
  async current(): Promise<MasterKey> { return this.active; }
  async get(id: string): Promise<MasterKey | undefined> { return this.keys.find(candidate => candidate.id === id); }
}

/** Strict self-hosted master-key reader. The path must be a non-symlink private file with exactly 32 raw bytes. */
export async function readOperatorMasterKey(path: string, id: string, grantableRoots: readonly string[]): Promise<MasterKey> {
  requireId(id);
  try {
    const requested = resolve(path);
    const roots = await Promise.all(grantableRoots.map(async root => realpath(resolve(root)).catch(() => resolve(root))));
    if (roots.some(root => requested === root || requested.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))) throw new FactoryEncryptionError("factory_key_unsafe");
    const directory = await privateDirectory(resolve(requested, ".."));
    try {
      return { id, bytes: await readPrivate(directory, requested.slice(requested.lastIndexOf(sep) + 1), DATA_KEY_BYTES) };
    } finally { await directory.close(); }
  } catch (error) {
    if (error instanceof FactoryEncryptionError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FactoryEncryptionError("factory_key_missing");
    throw new FactoryEncryptionError("factory_key_unsafe");
  }
}

export class InstallationDataKey {
  readonly installationId: string;
  private readonly value: Uint8Array;
  readonly wrapVersion: number;
  /** Wrap rotation never changes the data-key encryption version or object bytes. */
  readonly dataKeyVersion = 1;
  private constructor(installationId: string, value: Uint8Array, wrapVersion: number) { this.installationId = installationId; this.value = value; this.wrapVersion = wrapVersion; }
  static async loadOrCreate(installationId: string, wraps: InstallationKeyWrapStore, masters: MasterKeyProvider): Promise<InstallationDataKey> {
    requireId(installationId);
    const resolveExisting = async (existing: readonly InstallationKeyWrap[]): Promise<InstallationDataKey | undefined> => {
      for (const candidate of existing) {
        const master = await masters.get(candidate.masterKeyId);
        if (!master) continue;
        try { return new InstallationDataKey(installationId, decryptBytes(candidate.wrappedDataKey, master.bytes, wrapBinding(installationId, candidate.wrapVersion, candidate.masterKeyId)), candidate.wrapVersion); } catch { /* try retained wrapping versions */ }
      }
      return undefined;
    };
    const existing = await wraps.load(installationId);
    const resolved = await resolveExisting(existing);
    if (resolved) return resolved;
    if (existing.length > 0) throw new FactoryEncryptionError("factory_key_missing");
    const master = await masters.current(); key(master.bytes);
    const wrapVersion = 1;
    const dataKey = randomBytes(DATA_KEY_BYTES);
    await wraps.save({ installationId, wrapVersion, masterKeyId: master.id, wrappedDataKey: encryptBytes(dataKey, master.bytes, wrapBinding(installationId, wrapVersion, master.id)) });
    const persisted = await resolveExisting(await wraps.load(installationId));
    if (!persisted) throw new FactoryEncryptionError("factory_key_missing");
    return persisted;
  }
  async rotate(wraps: InstallationKeyWrapStore, masters: MasterKeyProvider): Promise<InstallationDataKey> {
    const master = await masters.current(); key(master.bytes);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const rows = await wraps.load(this.installationId);
      const wrapVersion = Math.max(this.wrapVersion, ...rows.map(row => row.wrapVersion)) + 1;
      const candidate = { installationId: this.installationId, wrapVersion, masterKeyId: master.id, wrappedDataKey: encryptBytes(this.value, master.bytes, wrapBinding(this.installationId, wrapVersion, master.id)) };
      await wraps.save(candidate);
      const persisted = (await wraps.load(this.installationId)).find(row => row.wrapVersion === wrapVersion);
      if (persisted && persisted.masterKeyId === candidate.masterKeyId && Buffer.from(persisted.wrappedDataKey).equals(Buffer.from(candidate.wrappedDataKey))) return new InstallationDataKey(this.installationId, this.value, wrapVersion);
    }
    throw new FactoryEncryptionError("factory_key_conflict");
  }
  encrypt(bytes: Uint8Array, binding: Omit<EncryptionBinding, "installationId" | "version">): Uint8Array { return encryptBytes(bytes, this.value, { ...binding, installationId: this.installationId, version: this.dataKeyVersion }); }
  decrypt(bytes: Uint8Array, binding: Omit<EncryptionBinding, "installationId" | "version">): Uint8Array { return decryptBytes(bytes, this.value, { ...binding, installationId: this.installationId, version: this.dataKeyVersion }); }
}

/** Explicit object-bound adapter. It deliberately is not BlobStore: BlobStore digests remain plaintext-content hashes. */
export interface BoundBlobStore {
  putBound(binding: Omit<EncryptionBinding, "installationId" | "version" | "payloadKind">, bytes: Uint8Array): Promise<string>;
  getBound(binding: Omit<EncryptionBinding, "installationId" | "version" | "payloadKind">, digest: string): Promise<Uint8Array>;
}

/** Reuses v4 BlobStore/S3BlobStore; only the stored bytes are encrypted. */
export class EncryptedBlobStore implements BoundBlobStore {
  private readonly store: BlobStore;
  private readonly dataKey: InstallationDataKey;
  private readonly tenantId: string;
  constructor(store: BlobStore, dataKey: InstallationDataKey, tenantId: string) { this.store = store; this.dataKey = dataKey; this.tenantId = tenantId; requireId(tenantId); }
  private bound(binding: Omit<EncryptionBinding, "installationId" | "version" | "payloadKind">): Omit<EncryptionBinding, "installationId" | "version"> { if (binding.tenantId !== this.tenantId) throw new FactoryEncryptionError("factory_encryption_binding_invalid"); return { ...binding, payloadKind: "blob" }; }
  async putBound(binding: Omit<EncryptionBinding, "installationId" | "version" | "payloadKind">, bytes: Uint8Array): Promise<string> { return this.store.put(this.dataKey.encrypt(bytes, this.bound(binding))); }
  async getBound(binding: Omit<EncryptionBinding, "installationId" | "version" | "payloadKind">, digest: string): Promise<Uint8Array> { return this.dataKey.decrypt(await this.store.get(digest), this.bound(binding)); }
  async version(digest: string): Promise<string> {
    if (!("version" in this.store) || typeof this.store.version !== "function") return digest;
    return this.store.version(digest);
  }
  async getVersion(binding: Omit<EncryptionBinding, "installationId" | "version" | "payloadKind">, digest: string, version: string): Promise<Uint8Array> {
    if (!("getVersion" in this.store) || typeof this.store.getVersion !== "function") return this.getBound(binding, digest);
    return this.dataKey.decrypt(await this.store.getVersion(digest, version), this.bound(binding));
  }
}

/** One adapter shape for C06 history, archive, snapshot, and backup records. */
export class EncryptedRecordCodec {
  private readonly dataKey: InstallationDataKey;
  private readonly kind: Exclude<EncryptedPayloadKind, "blob">;
  constructor(dataKey: InstallationDataKey, kind: Exclude<EncryptedPayloadKind, "blob">) { this.dataKey = dataKey; this.kind = kind; }
  encode(binding: Omit<EncryptionBinding, "installationId" | "version" | "payloadKind">, bytes: Uint8Array): Uint8Array { return this.dataKey.encrypt(bytes, { ...binding, payloadKind: this.kind }); }
  decode(binding: Omit<EncryptionBinding, "installationId" | "version" | "payloadKind">, bytes: Uint8Array): Uint8Array { return this.dataKey.decrypt(bytes, { ...binding, payloadKind: this.kind }); }
}

function temporalObjectId(context: TemporalSerializationContext | undefined): string {
  if (!context || (context.type !== "workflow" && context.type !== "activity") || typeof context.namespace !== "string" || context.namespace.length === 0) throw new FactoryEncryptionError("factory_encryption_binding_invalid");
  if (context.type === "workflow" && (typeof context.workflowId !== "string" || context.workflowId.length === 0)) throw new FactoryEncryptionError("factory_encryption_binding_invalid");
  if (context.type === "activity" && context.workflowId !== undefined && typeof context.workflowId !== "string") throw new FactoryEncryptionError("factory_encryption_binding_invalid");
  if (context.type === "activity" && context.activityId !== undefined && typeof context.activityId !== "string") throw new FactoryEncryptionError("factory_encryption_binding_invalid");
  if (context.type === "activity" && typeof context.isLocal !== "boolean") throw new FactoryEncryptionError("factory_encryption_binding_invalid");
  if (context.type === "activity" && !context.workflowId && !context.activityId) throw new FactoryEncryptionError("factory_encryption_binding_invalid");
  const identity = context.type === "workflow"
    ? ["workflow", context.namespace, context.workflowId]
    : ["activity", context.namespace, context.workflowId ?? null, context.activityId ?? null, context.isLocal];
  return `temporal:${createHash("sha256").update(JSON.stringify(identity)).digest("base64url")}`;
}

function temporalEnvelope(payload: TemporalPayload): Buffer {
  const metadata = Object.entries(payload.metadata ?? {});
  if (metadata.length > 0xffff) throw new FactoryEncryptionError("factory_encryption_binding_invalid");
  const data = Buffer.from(payload.data ?? []);
  const chunks = [Buffer.allocUnsafe(7)];
  chunks[0]!.writeUInt8(TEMPORAL_ENVELOPE_VERSION, 0);
  chunks[0]!.writeUInt16BE(metadata.length, 1);
  chunks[0]!.writeUInt32BE(data.byteLength, 3);
  for (const [name, value] of metadata) {
    const key = Buffer.from(name), bytes = Buffer.from(value);
    if (key.byteLength > 0xffff) throw new FactoryEncryptionError("factory_encryption_binding_invalid");
    const header = Buffer.allocUnsafe(6); header.writeUInt16BE(key.byteLength, 0); header.writeUInt32BE(bytes.byteLength, 2);
    chunks.push(header, key, bytes);
  }
  chunks.push(data);
  return Buffer.concat(chunks);
}

function temporalPayload(envelope: Uint8Array): TemporalPayload {
  const bytes = Buffer.from(envelope);
  if (bytes.byteLength < 7 || bytes.readUInt8(0) !== TEMPORAL_ENVELOPE_VERSION) throw new FactoryEncryptionError("factory_decryption_failed");
  const count = bytes.readUInt16BE(1), dataLength = bytes.readUInt32BE(3); let offset = 7;
  const metadata: Array<[string, Uint8Array]> = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 6 > bytes.byteLength) throw new FactoryEncryptionError("factory_decryption_failed");
    const keyLength = bytes.readUInt16BE(offset), valueLength = bytes.readUInt32BE(offset + 2); offset += 6;
    if (offset + keyLength + valueLength > bytes.byteLength) throw new FactoryEncryptionError("factory_decryption_failed");
    const key = bytes.subarray(offset, offset + keyLength).toString(); offset += keyLength;
    if (!key || metadata.some(([name]) => name === key)) throw new FactoryEncryptionError("factory_decryption_failed");
    metadata.push([key, Uint8Array.from(bytes.subarray(offset, offset + valueLength))]); offset += valueLength;
  }
  if (offset + dataLength !== bytes.byteLength) throw new FactoryEncryptionError("factory_decryption_failed");
  return { metadata: Object.fromEntries(metadata), data: Uint8Array.from(bytes.subarray(offset)) };
}

function varintBytes(value: number): number {
  let bytes = 1;
  while (value >= 0x80) { value = Math.floor(value / 0x80); bytes += 1; }
  return bytes;
}

function encryptedTemporalDataBytes(payload: TemporalPayload): number { return temporalEnvelope(payload).byteLength + TEMPORAL_CRYPTO_OVERHEAD; }

/** Byte length of the post-codec Temporal protobuf Payload. The fixed metadata is the encrypted codec marker. */
export function factoryTemporalPayloadWireBytes(payload: TemporalPayload): number {
  const dataBytes = encryptedTemporalDataBytes(payload);
  // Payload.metadata["encoding"] map entry is 38 bytes; Payload.data is field 2.
  return 38 + 1 + varintBytes(dataBytes) + dataBytes;
}

/** Byte length of the post-codec Temporal protobuf Payloads message. */
export function factoryTemporalPayloadsWireBytes(payloads: readonly TemporalPayload[]): number {
  return payloads.reduce((total, payload) => {
    const payloadBytes = factoryTemporalPayloadWireBytes(payload);
    return total + 1 + varintBytes(payloadBytes) + payloadBytes;
  }, 0);
}

/** Raw-data allowance for one payload under the C08 64 KiB post-codec Payloads protobuf bound. */
export function factoryTemporalPayloadDataBytesLimit(metadata: TemporalPayload["metadata"]): number {
  let lower = 0, upper = FACTORY_TEMPORAL_ENCRYPTED_PAYLOAD_LIMIT;
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    if (factoryTemporalPayloadsWireBytes([{ metadata, data: new Uint8Array(candidate) }]) <= FACTORY_TEMPORAL_ENCRYPTED_PAYLOAD_LIMIT) lower = candidate;
    else upper = candidate - 1;
  }
  return lower;
}

/** Node-compatible Temporal codec. It binds each payload to the SDK-provided serialization context. */
export class FactoryTemporalPayloadCodec implements TemporalPayloadCodec {
  private readonly records: EncryptedRecordCodec;
  private readonly tenantId: string;
  constructor(records: EncryptedRecordCodec, tenantId: string) { this.records = records; this.tenantId = tenantId; }
  async encode(payloads: TemporalPayload[], context?: TemporalSerializationContext): Promise<TemporalPayload[]> {
    const objectId = temporalObjectId(context);
    if (factoryTemporalPayloadsWireBytes(payloads) > FACTORY_TEMPORAL_ENCRYPTED_PAYLOAD_LIMIT) throw new FactoryEncryptionError("factory_payload_too_large");
    return payloads.map((payload, index) => ({ metadata: { encoding: Buffer.from("binary/factory-encrypted") }, data: this.records.encode({ tenantId: this.tenantId, objectId: `${objectId}:${index}` }, temporalEnvelope(payload)) }));
  }
  async decode(payloads: TemporalPayload[], context?: TemporalSerializationContext): Promise<TemporalPayload[]> { const objectId = temporalObjectId(context); return payloads.map((payload, index) => {
    if (Buffer.from(payload.metadata?.encoding ?? []).toString() !== "binary/factory-encrypted") throw new FactoryEncryptionError("factory_decryption_failed");
    try { return temporalPayload(this.records.decode({ tenantId: this.tenantId, objectId: `${objectId}:${index}` }, payload.data ?? new Uint8Array())); } catch (error) { if (error instanceof FactoryEncryptionError) throw error; throw new FactoryEncryptionError("factory_decryption_failed"); }
  }); }
}
