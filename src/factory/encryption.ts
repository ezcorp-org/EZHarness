import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import type { BlobStore } from "../extensions/v4/types";
import type { TransactionalDb } from "../db/migrations/types";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DATA_KEY_BYTES = 32;
const FORMAT = "factory.encrypted.v1";

export type EncryptedPayloadKind = "history" | "archive" | "snapshot" | "backup" | "blob";
/** Structural copy of Temporal's PayloadCodec so this Bun-owned module never imports the Node SDK. */
export interface TemporalPayload { readonly metadata?: Record<string, Uint8Array>; readonly data?: Uint8Array; }
export interface TemporalPayloadCodec { encode(payloads: TemporalPayload[]): Promise<TemporalPayload[]>; decode(payloads: TemporalPayload[]): Promise<TemporalPayload[]>; }

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
  constructor(readonly code: "factory_key_missing" | "factory_key_unsafe" | "factory_key_invalid" | "factory_decryption_failed" | "factory_encryption_binding_invalid") {
    super(code);
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
  constructor(private readonly active: MasterKey, private readonly keys: readonly MasterKey[] = [active]) { key(active.bytes); requireId(active.id); }
  async current(): Promise<MasterKey> { return this.active; }
  async get(id: string): Promise<MasterKey | undefined> { return this.keys.find(candidate => candidate.id === id); }
}

/** Strict self-hosted master-key reader. The path must be a non-symlink private file with exactly 32 raw bytes. */
export async function readOperatorMasterKey(path: string, id: string): Promise<MasterKey> {
  requireId(id);
  let stat: Awaited<ReturnType<typeof lstat>>; let bytes: Uint8Array;
  try { [stat, bytes] = await Promise.all([lstat(path), readFile(path)]); } catch { throw new FactoryEncryptionError("factory_key_missing"); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || bytes.byteLength !== DATA_KEY_BYTES) throw new FactoryEncryptionError("factory_key_unsafe");
  return { id, bytes };
}

/** PostgreSQL key-wrap ledger. It stores only encrypted data keys, never master material. */
export class DatabaseInstallationKeyWrapStore implements InstallationKeyWrapStore {
  constructor(private readonly database: TransactionalDb) {}
  async load(installationId: string): Promise<readonly InstallationKeyWrap[]> {
    requireId(installationId);
    const result = await this.database.execute(sql`SELECT installation_id, wrap_version, master_key_id, wrapped_data_key FROM factory_installation_key_wraps WHERE installation_id=${installationId} ORDER BY wrap_version DESC`) as unknown as { rows?: Array<{ installation_id: string; wrap_version: number | string; master_key_id: string; wrapped_data_key: Uint8Array }> } | Array<{ installation_id: string; wrap_version: number | string; master_key_id: string; wrapped_data_key: Uint8Array }>;
    const rows = Array.isArray(result) ? result : result.rows ?? [];
    return rows.map(row => ({ installationId: row.installation_id, wrapVersion: Number(row.wrap_version), masterKeyId: row.master_key_id, wrappedDataKey: new Uint8Array(row.wrapped_data_key) }));
  }
  async save(value: InstallationKeyWrap): Promise<void> {
    requireId(value.installationId); requireId(value.masterKeyId);
    if (value.wrappedDataKey.byteLength < Buffer.byteLength(FORMAT) + IV_BYTES + TAG_BYTES + DATA_KEY_BYTES) throw new FactoryEncryptionError("factory_key_invalid");
    if (!Number.isSafeInteger(value.wrapVersion) || value.wrapVersion < 1) throw new FactoryEncryptionError("factory_key_invalid");
    await this.database.execute(sql`INSERT INTO factory_installation_key_wraps(installation_id, wrap_version, master_key_id, wrapped_data_key) VALUES (${value.installationId}, ${value.wrapVersion}, ${value.masterKeyId}, ${Buffer.from(value.wrappedDataKey)}) ON CONFLICT (installation_id, wrap_version) DO NOTHING`);
  }
}

export class InstallationDataKey {
  private constructor(readonly installationId: string, private readonly value: Uint8Array, readonly wrapVersion: number) {}
  static async loadOrCreate(installationId: string, wraps: InstallationKeyWrapStore, masters: MasterKeyProvider): Promise<InstallationDataKey> {
    requireId(installationId);
    const existing = await wraps.load(installationId);
    for (const candidate of existing) {
      const master = await masters.get(candidate.masterKeyId);
      if (!master) continue;
      try { return new InstallationDataKey(installationId, decryptBytes(candidate.wrappedDataKey, master.bytes, wrapBinding(installationId, candidate.wrapVersion, candidate.masterKeyId)), candidate.wrapVersion); } catch { /* try retained wrapping versions */ }
    }
    if (existing.length > 0) throw new FactoryEncryptionError("factory_key_missing");
    const master = await masters.current(); key(master.bytes);
    const wrapVersion = 1;
    const dataKey = randomBytes(DATA_KEY_BYTES);
    await wraps.save({ installationId, wrapVersion, masterKeyId: master.id, wrappedDataKey: encryptBytes(dataKey, master.bytes, wrapBinding(installationId, wrapVersion, master.id)) });
    return new InstallationDataKey(installationId, dataKey, wrapVersion);
  }
  async rotate(wraps: InstallationKeyWrapStore, masters: MasterKeyProvider): Promise<InstallationDataKey> {
    const master = await masters.current(); key(master.bytes);
    const wrapVersion = this.wrapVersion + 1;
    await wraps.save({ installationId: this.installationId, wrapVersion, masterKeyId: master.id, wrappedDataKey: encryptBytes(this.value, master.bytes, wrapBinding(this.installationId, wrapVersion, master.id)) });
    return new InstallationDataKey(this.installationId, this.value, wrapVersion);
  }
  encrypt(bytes: Uint8Array, binding: Omit<EncryptionBinding, "installationId" | "version">): Uint8Array { return encryptBytes(bytes, this.value, { ...binding, installationId: this.installationId, version: this.wrapVersion }); }
  decrypt(bytes: Uint8Array, binding: Omit<EncryptionBinding, "installationId" | "version">): Uint8Array { return decryptBytes(bytes, this.value, { ...binding, installationId: this.installationId, version: this.wrapVersion }); }
}

export interface BoundBlobStore extends BlobStore {
  putBound(binding: Omit<EncryptionBinding, "installationId" | "version" | "payloadKind">, bytes: Uint8Array): Promise<string>;
  getBound(binding: Omit<EncryptionBinding, "installationId" | "version" | "payloadKind">, digest: string): Promise<Uint8Array>;
}

/** Reuses v4 BlobStore/S3BlobStore; only the stored bytes are encrypted. */
export class EncryptedBlobStore implements BoundBlobStore {
  constructor(private readonly store: BlobStore, private readonly dataKey: InstallationDataKey, private readonly tenantId: string) { requireId(tenantId); }
  async put(bytes: Uint8Array): Promise<string> { return this.store.put(this.dataKey.encrypt(bytes, { tenantId: this.tenantId, objectId: "unbound", payloadKind: "blob" })); }
  async get(digest: string): Promise<Uint8Array> { return this.dataKey.decrypt(await this.store.get(digest), { tenantId: this.tenantId, objectId: "unbound", payloadKind: "blob" }); }
  async putBound(binding: Omit<EncryptionBinding, "installationId" | "version" | "payloadKind">, bytes: Uint8Array): Promise<string> { return this.store.put(this.dataKey.encrypt(bytes, { ...binding, payloadKind: "blob" })); }
  async getBound(binding: Omit<EncryptionBinding, "installationId" | "version" | "payloadKind">, digest: string): Promise<Uint8Array> { return this.dataKey.decrypt(await this.store.get(digest), { ...binding, payloadKind: "blob" }); }
  async version(digest: string): Promise<string> {
    if (!("version" in this.store) || typeof this.store.version !== "function") return digest;
    return this.store.version(digest);
  }
  async getVersion(binding: Omit<EncryptionBinding, "installationId" | "version" | "payloadKind">, digest: string, version: string): Promise<Uint8Array> {
    if (!("getVersion" in this.store) || typeof this.store.getVersion !== "function") return this.getBound(binding, digest);
    return this.dataKey.decrypt(await this.store.getVersion(digest, version), { ...binding, payloadKind: "blob" });
  }
}

/** One adapter shape for C06 history, archive, snapshot, and backup records. */
export class EncryptedRecordCodec {
  constructor(private readonly dataKey: InstallationDataKey, private readonly kind: Exclude<EncryptedPayloadKind, "blob">) {}
  encode(binding: Omit<EncryptionBinding, "installationId" | "version" | "payloadKind">, bytes: Uint8Array): Uint8Array { return this.dataKey.encrypt(bytes, { ...binding, payloadKind: this.kind }); }
  decode(binding: Omit<EncryptionBinding, "installationId" | "version" | "payloadKind">, bytes: Uint8Array): Uint8Array { return this.dataKey.decrypt(bytes, { ...binding, payloadKind: this.kind }); }
}

/** Node-compatible Temporal codec. It binds every payload to one workflow object identity. */
export class FactoryTemporalPayloadCodec implements TemporalPayloadCodec {
  constructor(private readonly records: EncryptedRecordCodec, private readonly tenantId: string, private readonly workflowId: string) {}
  async encode(payloads: TemporalPayload[]): Promise<TemporalPayload[]> { return payloads.map((payload, index) => ({ metadata: { ...payload.metadata, encoding: Buffer.from("binary/factory-encrypted") }, data: this.records.encode({ tenantId: this.tenantId, objectId: `${this.workflowId}:${index}` }, payload.data ?? new Uint8Array()) })); }
  async decode(payloads: TemporalPayload[]): Promise<TemporalPayload[]> { return payloads.map((payload, index) => ({ metadata: { ...payload.metadata, encoding: Buffer.from("binary/plain") }, data: this.records.decode({ tenantId: this.tenantId, objectId: `${this.workflowId}:${index}` }, payload.data ?? new Uint8Array()) })); }
}
