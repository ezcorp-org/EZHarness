import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { BlobStore } from "../extensions/v4/types";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DATA_KEY_BYTES = 32;
const FORMAT = "factory.encrypted.v1";

export type EncryptedPayloadKind = "history" | "archive" | "snapshot" | "backup" | "blob";
/** Structural copy of Temporal's PayloadCodec so this Bun-owned module never imports the Node SDK. */
export interface TemporalPayload { readonly metadata?: Record<string, Uint8Array> | null; readonly data?: Uint8Array | null; }
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
  readonly code: "factory_key_missing" | "factory_key_unsafe" | "factory_key_invalid" | "factory_decryption_failed" | "factory_encryption_binding_invalid";
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
  let canonical: string;
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new FactoryEncryptionError("factory_key_unsafe");
    canonical = await realpath(path);
  } catch (error) {
    if (error instanceof FactoryEncryptionError) throw error;
    throw new FactoryEncryptionError("factory_key_missing");
  }
  try {
    const roots = await Promise.all(grantableRoots.map(root => realpath(resolve(root))));
    if (roots.some(root => canonical === root || canonical.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))) throw new FactoryEncryptionError("factory_key_unsafe");
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const [stat, bytes] = await Promise.all([handle.stat(), handle.readFile()]);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || bytes.byteLength !== DATA_KEY_BYTES) throw new FactoryEncryptionError("factory_key_unsafe");
      return { id, bytes };
    } finally { await handle.close(); }
  } catch (error) { if (error instanceof FactoryEncryptionError) throw error; throw new FactoryEncryptionError("factory_key_unsafe"); }
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
    const wrapVersion = this.wrapVersion + 1;
    await wraps.save({ installationId: this.installationId, wrapVersion, masterKeyId: master.id, wrappedDataKey: encryptBytes(this.value, master.bytes, wrapBinding(this.installationId, wrapVersion, master.id)) });
    return new InstallationDataKey(this.installationId, this.value, wrapVersion);
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

/** Node-compatible Temporal codec. It binds every payload to one workflow object identity. */
export class FactoryTemporalPayloadCodec implements TemporalPayloadCodec {
  private readonly records: EncryptedRecordCodec;
  private readonly tenantId: string;
  private readonly workflowId: string;
  constructor(records: EncryptedRecordCodec, tenantId: string, workflowId: string) { this.records = records; this.tenantId = tenantId; this.workflowId = workflowId; }
  async encode(payloads: TemporalPayload[]): Promise<TemporalPayload[]> { return payloads.map((payload, index) => ({ metadata: { encoding: Buffer.from("binary/factory-encrypted") }, data: this.records.encode({ tenantId: this.tenantId, objectId: `${this.workflowId}:${index}` }, Buffer.from(JSON.stringify({ metadata: Object.fromEntries(Object.entries(payload.metadata ?? {}).map(([name, value]) => [name, Buffer.from(value).toString("base64")])), data: Buffer.from(payload.data ?? []).toString("base64") }))) })); }
  async decode(payloads: TemporalPayload[]): Promise<TemporalPayload[]> { return payloads.map((payload, index) => {
    if (Buffer.from(payload.metadata?.encoding ?? []).toString() !== "binary/factory-encrypted") throw new FactoryEncryptionError("factory_decryption_failed");
    try { const value = JSON.parse(Buffer.from(this.records.decode({ tenantId: this.tenantId, objectId: `${this.workflowId}:${index}` }, payload.data ?? new Uint8Array())).toString()) as { metadata: Record<string, string>; data: string }; return { metadata: Object.fromEntries(Object.entries(value.metadata).map(([name, encoded]) => [name, Uint8Array.from(Buffer.from(encoded, "base64"))])), data: Uint8Array.from(Buffer.from(value.data, "base64")) }; } catch (error) { if (error instanceof FactoryEncryptionError) throw error; throw new FactoryEncryptionError("factory_decryption_failed"); }
  }); }
}
