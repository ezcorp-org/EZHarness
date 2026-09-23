import { EncryptedRecordCodec, FactoryEncryptionError, FactoryTemporalPayloadCodec, InstallationDataKey, StaticMasterKeyProvider, readOperatorMasterKey, type InstallationKeyWrap, type InstallationKeyWrapStore } from "./encryption.ts";
import { readPrivateFileBounded } from "./private-files.ts";

const KEY_WRAP_SCHEMA_VERSION = "factory.key-wraps.v1";
const MAX_KEY_WRAP_FILE_BYTES = 16 * 1024;
const MAX_KEY_WRAPS = 32;
/** A KMS wrap is larger than an operator-key wrap: an AWS KMS ciphertext blob, or a transit `vault:v1:` string. */
const MAX_WRAPPED_DATA_KEY_BYTES = 1_024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
/** A wrapping key id: an operator key id, a KMS key ARN, or a transit `transit:<mount>/<name>` id. */
const WRAPPING_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export interface FactoryKeyWrapFile {
  readonly schemaVersion: typeof KEY_WRAP_SCHEMA_VERSION;
  readonly installationId: string;
  readonly wraps: readonly {
    readonly installationId: string;
    readonly wrapVersion: number;
    readonly masterKeyId: string;
    readonly wrappedDataKey: string;
  }[];
}

/** Secrets supplied to the standalone Node Temporal process. No database, S3, or raw data key is exposed. */
export interface FactoryTemporalPayloadCodecFileConfig {
  readonly installationId: string;
  readonly tenantId: string;
  readonly wrappedKeyFilePath: string;
  readonly masterKeyFilePath: string;
  readonly masterKeyId: string;
  readonly grantableRoots: readonly string[];
}

function keyInvalid(): never { throw new FactoryEncryptionError("factory_key_invalid"); }
function validIdentifier(value: unknown): value is string { return typeof value === "string" && IDENTIFIER.test(value); }
function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}
function canonicalBase64(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength > 0 && bytes.byteLength <= MAX_WRAPPED_DATA_KEY_BYTES && bytes.toString("base64") === value ? bytes : undefined;
}

/** Parse only the immutable private secret format delivered to the Node process. */
export function parseFactoryKeyWrapFile(value: unknown, expectedInstallationId: string, expectedMasterKeyId: string): readonly InstallationKeyWrap[] {
  if (!validIdentifier(expectedInstallationId) || typeof expectedMasterKeyId !== "string" || !WRAPPING_KEY_ID.test(expectedMasterKeyId) || typeof value !== "object" || value === null
    || !exactKeys(value, ["installationId", "schemaVersion", "wraps"])) keyInvalid();
  const file = value as FactoryKeyWrapFile;
  if (file.schemaVersion !== KEY_WRAP_SCHEMA_VERSION || file.installationId !== expectedInstallationId || !Array.isArray(file.wraps)
    || file.wraps.length < 1 || file.wraps.length > MAX_KEY_WRAPS) keyInvalid();
  const versions = new Set<number>();
  return file.wraps.map((wrap) => {
    if (typeof wrap !== "object" || wrap === null || !exactKeys(wrap, ["installationId", "masterKeyId", "wrapVersion", "wrappedDataKey"])
      || wrap.installationId !== expectedInstallationId || wrap.masterKeyId !== expectedMasterKeyId
      || !Number.isSafeInteger(wrap.wrapVersion) || wrap.wrapVersion < 1 || versions.has(wrap.wrapVersion)) keyInvalid();
    const wrappedDataKey = canonicalBase64(wrap.wrappedDataKey);
    if (!wrappedDataKey) keyInvalid();
    versions.add(wrap.wrapVersion);
    return Object.freeze({ installationId: wrap.installationId, wrapVersion: wrap.wrapVersion, masterKeyId: wrap.masterKeyId, wrappedDataKey: Uint8Array.from(wrappedDataKey) });
  });
}

async function readPrivateKeyWrapFile(path: string): Promise<Uint8Array> {
  try { return await readPrivateFileBounded(path, MAX_KEY_WRAP_FILE_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FactoryEncryptionError("factory_key_missing");
    throw new FactoryEncryptionError("factory_key_unsafe");
  }
}

/**
 * The installation's wraps from its private wrap file, as a read-only store:
 * every wrap must be under `wrappingKeyId`. Shared by the orchestrator's codec
 * and the restore's key check.
 */
export async function readFactoryKeyWrapFile(path: string, installationId: string, wrappingKeyId: string): Promise<InstallationKeyWrapStore> {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readPrivateKeyWrapFile(path))); }
  catch (error) { if (error instanceof FactoryEncryptionError) throw error; throw new FactoryEncryptionError("factory_key_invalid"); }
  return new ReadonlyFileKeyWrapStore(parseFactoryKeyWrapFile(parsed, installationId, wrappingKeyId));
}

class ReadonlyFileKeyWrapStore implements InstallationKeyWrapStore {
  private readonly wraps: readonly InstallationKeyWrap[];
  constructor(wraps: readonly InstallationKeyWrap[]) { this.wraps = wraps; }
  async load(installationId: string): Promise<readonly InstallationKeyWrap[]> {
    if (this.wraps.some((wrap) => wrap.installationId !== installationId)) throw new FactoryEncryptionError("factory_key_invalid");
    return this.wraps.map((wrap) => ({ ...wrap, wrappedDataKey: Uint8Array.from(wrap.wrappedDataKey) }));
  }
  async save(): Promise<void> { throw new FactoryEncryptionError("factory_key_unsafe"); }
}

/**
 * Builds the worker codec from pre-provisioned private files. This intentionally
 * reads no database, has no S3 credentials, creates no key, and cannot rotate.
 */
export async function loadFactoryTemporalPayloadCodec(config: FactoryTemporalPayloadCodecFileConfig): Promise<FactoryTemporalPayloadCodec> {
  if (!validIdentifier(config.installationId) || !validIdentifier(config.tenantId) || !validIdentifier(config.masterKeyId)
    || !Array.isArray(config.grantableRoots) || config.grantableRoots.some(root => typeof root !== "string" || root.length === 0)
    || typeof config.wrappedKeyFilePath !== "string" || config.wrappedKeyFilePath.length === 0
    || typeof config.masterKeyFilePath !== "string" || config.masterKeyFilePath.length === 0) keyInvalid();
  const wraps = await readFactoryKeyWrapFile(config.wrappedKeyFilePath, config.installationId, config.masterKeyId);
  const master = await readOperatorMasterKey(config.masterKeyFilePath, config.masterKeyId, config.grantableRoots);
  const key = await InstallationDataKey.loadExisting(config.installationId, wraps, new StaticMasterKeyProvider(master));
  return new FactoryTemporalPayloadCodec(new EncryptedRecordCodec(key, "history"), config.tenantId);
}
