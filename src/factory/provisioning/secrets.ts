/**
 * C12 step 4: the installation's application secrets and its wrapped data key.
 *
 * Three kinds of material, kept apart on purpose:
 *
 *   - APPLICATION secrets (`EZCORP_JWT_SECRET`, `EZCORP_ENCRYPTION_SECRET`,
 *     `EZCORP_ENCRYPTION_SALT`): text, generated per installation, delivered to
 *     the harness. C01 makes a shared or templated one an F01 failure, so each
 *     is recorded by DIGEST and a digest already held by another installation
 *     in the same fleet is refused.
 *   - The OPERATOR MASTER KEY: exactly 32 random bytes, in the operator's own
 *     directory, never under any grantable root and never in the harness's
 *     delivery. It is not text and it is not derived from an application
 *     secret: a base64 application secret is 43 characters, and the master-key
 *     reader requires 32 raw bytes, so the two cannot be confused without the
 *     check below failing by name.
 *   - The WRAPPED DATA KEY: the installation's data key encrypted under the
 *     master key, in the `factory.key-wraps.v1` file the Node process reads.
 *     Written through `InstallationDataKey.loadOrCreate`, then re-read through
 *     the same read-only loader the Node process uses, so a wrap that verifies
 *     here is a wrap that boots there.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FactoryEncryptionError, InstallationDataKey, StaticMasterKeyProvider, readOperatorMasterKey, type InstallationKeyWrap, type InstallationKeyWrapStore } from "../encryption";
import { loadFactoryTemporalPayloadCodec, parseFactoryKeyWrapFile } from "../file-key-wraps";
import type { FactoryInstallationContext, FactoryProvisioningDriver, FactoryStepResources } from "./installation";
import { ensureFactoryPrivateFile, factoryPrivatePath, openFactoryPrivateDirectory, readFactoryPrivateBytes, readFactoryPrivatePath, readFactoryPrivateText, removeFactoryPrivateDirectory, removeFactoryPrivateFile, replaceFactoryPrivateFile } from "./secret-files";
import { FactoryProvisioningError } from "./steps";

export const FACTORY_APPLICATION_SECRET_FILES = Object.freeze({ jwt: "application-jwt-secret", encryption: "application-encryption-secret", salt: "application-encryption-salt" });
export const FACTORY_KEY_FILES = Object.freeze({ master: "master.key", wraps: "wraps.json" });
export const FACTORY_ESCROW_WRAPS = `escrow-${FACTORY_KEY_FILES.wraps}`;
const APPLICATION_SECRET = /^[A-Za-z0-9_-]{43}$/;
const SALT = /^[a-f0-9]{32}$/;
const MASTER_KEY_BYTES = 32;

export interface FactorySecretDigestRegistry {
  /** Tenants other than `tenantId` in this fleet already holding one of these digests. */
  conflicts(tenantId: string, digests: readonly string[]): Promise<readonly string[]>;
}

export interface FactorySecretsStepOptions {
  readonly registry: FactorySecretDigestRegistry;
  /** Roots a harness may grant to an extension. The master key must sit outside all of them. */
  readonly grantableRoots: (installation: FactoryInstallationContext) => readonly string[];
}

export function factoryMasterKeyId(installation: FactoryInstallationContext, version = 1): string {
  return `master-${installation.installationId}-v${version}`;
}

/** The operator master key's file, named by its version. Version 1 keeps the name every existing installation has. */
export function factoryMasterKeyFile(version: number): string {
  return version === 1 ? FACTORY_KEY_FILES.master : `master-v${version}.key`;
}

/** The wraps under a superseded master key, kept beside it in the operator's directory until that key is revoked. */
export function factoryRetainedWrapsFile(version: number): string {
  return `retained-wraps-v${version}.json`;
}

/** The staging file a rotation writes the next wrap to before it replaces the live one. */
const NEXT_WRAPS = "wraps.next.json";

export interface FactoryCurrentMasterKey {
  readonly version: number;
  readonly id: string;
  /** The operator's file holding this version. */
  readonly path: string;
}

function currentMasterKey(installation: FactoryInstallationContext, version: number): FactoryCurrentMasterKey {
  return Object.freeze({ version, id: factoryMasterKeyId(installation, version), path: factoryPrivatePath(installation.operatorDirectory, factoryMasterKeyFile(version)) });
}

/** The version a master key id of this installation names; undefined for any other id. */
function masterKeyVersion(installation: FactoryInstallationContext, id: unknown): number | undefined {
  const prefix = `master-${installation.installationId}-v`;
  if (typeof id !== "string" || !id.startsWith(prefix) || !/^[1-9][0-9]{0,5}$/.test(id.slice(prefix.length))) return undefined;
  return Number(id.slice(prefix.length));
}

/** Read for the version only: the private loader that opens the key checks the file's safety and refuses it by its own code. */
async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/**
 * The installation's current master key: the one its wrap file is under. The
 * live wrap file decides; after teardown, its escrow copy does; before step 4
 * wrote anything, it is version 1. The wrap file is the one source, so a
 * rotation interrupted before it replaced the wrap file leaves the old key
 * current, and one interrupted after leaves the new one current.
 */
export async function readFactoryCurrentMasterKey(installation: FactoryInstallationContext): Promise<FactoryCurrentMasterKey> {
  const text = await readOptional(factoryPrivatePath(installation.secretDirectory, FACTORY_KEY_FILES.wraps))
    ?? await readOptional(factoryPrivatePath(installation.operatorDirectory, FACTORY_ESCROW_WRAPS));
  if (text === undefined) return currentMasterKey(installation, 1);
  let version: number | undefined;
  try { version = masterKeyVersion(installation, (JSON.parse(text) as { wraps?: Array<{ masterKeyId?: unknown }> }).wraps?.[0]?.masterKeyId); }
  catch { version = undefined; }
  // The loader's own refusal for a wrap file it cannot read: one code for every unreadable wrap file.
  if (version === undefined) throw new FactoryEncryptionError("factory_key_invalid");
  return currentMasterKey(installation, version);
}

function digest(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function text(value: string): string { return `${value}\n`; }

/**
 * The file-backed wrap store the provisioner creates the FIRST wrap through.
 *
 * It only ever writes one wrap: rewrapping under a new master key is
 * `InstallationDataKey.rotate` against the orchestrator's own store, not this.
 * `loadOrCreate` re-reads what `save` wrote, so the round trip goes through the
 * file, exactly as the Node process will read it.
 */
class ProvisionerKeyWrapFile implements InstallationKeyWrapStore {
  constructor(private readonly path: string, private readonly installationId: string, private readonly masterKeyId: string) {}
  async load(installationId: string): Promise<readonly InstallationKeyWrap[]> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return parseFactoryKeyWrapFile(JSON.parse(text), installationId, this.masterKeyId);
  }
  async save(wrap: InstallationKeyWrap): Promise<void> {
    await replaceFactoryPrivateFile(this.path, `${JSON.stringify({
      schemaVersion: "factory.key-wraps.v1",
      installationId: this.installationId,
      wraps: [{ installationId: wrap.installationId, wrapVersion: wrap.wrapVersion, masterKeyId: wrap.masterKeyId, wrappedDataKey: Buffer.from(wrap.wrappedDataKey).toString("base64") }],
    })}\n`);
  }
}

/**
 * Refuse a master key that is really an application secret.
 *
 * The reader already requires 32 bytes. This names the specific mistake a
 * deployment makes — pointing the master-key path at a base64 or hex secret
 * file — so the failure says what to fix rather than "wrong size".
 */
export function assertFactoryMasterKeyIsRaw(masterKey: Uint8Array, applicationSecrets: readonly string[]): void {
  if (masterKey.byteLength !== MASTER_KEY_BYTES) throw new FactoryProvisioningError("master_key_invalid", `The operator master key must be exactly ${MASTER_KEY_BYTES} raw bytes.`);
  const asText = new TextDecoder("utf-8", { fatal: false }).decode(masterKey).trim();
  for (const secret of applicationSecrets) {
    const trimmed = secret.trim();
    if (asText === trimmed || Buffer.from(trimmed, "base64url").equals(Buffer.from(masterKey)) || Buffer.from(trimmed, "base64").equals(Buffer.from(masterKey)) || Buffer.from(trimmed, "hex").equals(Buffer.from(masterKey))) {
      throw new FactoryProvisioningError("master_key_is_application_secret", "The operator master key is an application secret; generate it separately as raw key material.");
    }
  }
  // Raw random bytes are essentially never all printable; an encoded secret always is.
  if (masterKey.every((byte) => (byte >= 0x20 && byte < 0x7f) || byte === 0x0a || byte === 0x0d)) throw new FactoryProvisioningError("master_key_is_text", "The operator master key is printable text; it must be raw random bytes, not an encoded secret.");
}

/** Step 4's master-key life, beside the driver's own ensure, verify, teardown and rotate. */
export interface FactoryMasterKeyDriver {
  rotateMasterKey(installation: FactoryInstallationContext, recorded: FactoryStepResources): Promise<FactoryStepResources>;
  revokeMasterKey(installation: FactoryInstallationContext, recorded: FactoryStepResources, version: number): Promise<void>;
}

export class FactorySecretsStep implements FactoryProvisioningDriver, FactoryMasterKeyDriver {
  readonly step = "secrets" as const;
  constructor(private readonly options: FactorySecretsStepOptions) {}

  async ensure(installation: FactoryInstallationContext): Promise<FactoryStepResources> {
    const current = await readFactoryCurrentMasterKey(installation);
    const secrets = await openFactoryPrivateDirectory(installation.secretDirectory);
    const operator = await openFactoryPrivateDirectory(installation.operatorDirectory);
    try {
      await ensureFactoryPrivateFile(secrets, FACTORY_APPLICATION_SECRET_FILES.jwt, () => text(randomBytes(32).toString("base64url")));
      await ensureFactoryPrivateFile(secrets, FACTORY_APPLICATION_SECRET_FILES.encryption, () => text(randomBytes(32).toString("base64url")));
      await ensureFactoryPrivateFile(secrets, FACTORY_APPLICATION_SECRET_FILES.salt, () => text(randomBytes(16).toString("hex")));
      // Only the first key is created here; a later version is created by its rotation, and a revoked one never again.
      if (current.version === 1) await ensureFactoryPrivateFile(operator, FACTORY_KEY_FILES.master, () => randomBytes(MASTER_KEY_BYTES));
    } finally { await secrets.close(); await operator.close(); }
    const master = await readOperatorMasterKey(current.path, current.id, this.options.grantableRoots(installation));
    await InstallationDataKey.loadOrCreate(installation.installationId, this.wrapFile(installation, current.id), new StaticMasterKeyProvider(master));
    const resources = await this.resources(installation);
    await this.verify(installation, resources);
    return resources;
  }

  async verify(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<void> {
    const secrets = await openFactoryPrivateDirectory(installation.secretDirectory);
    let applicationSecrets: string[];
    let salt: string;
    try {
      applicationSecrets = [await readFactoryPrivateText(secrets, FACTORY_APPLICATION_SECRET_FILES.jwt), await readFactoryPrivateText(secrets, FACTORY_APPLICATION_SECRET_FILES.encryption)].map((value) => value.trim());
      salt = (await readFactoryPrivateText(secrets, FACTORY_APPLICATION_SECRET_FILES.salt)).trim();
    } finally { await secrets.close(); }
    if (applicationSecrets.some((value) => !APPLICATION_SECRET.test(value)) || !SALT.test(salt)) throw new FactoryProvisioningError("application_secret_invalid", "An application secret has an invalid format.");
    if (applicationSecrets[0] === applicationSecrets[1]) throw new FactoryProvisioningError("application_secret_shared", "The JWT and encryption secrets must differ.");
    const current = await readFactoryCurrentMasterKey(installation);
    if (resources.masterKeyId !== current.id || resources.masterKeyFilePath !== current.path) throw new FactoryProvisioningError("secrets_resource_mismatch", "The recorded master key is not the one the wrap file is under.");
    const masterBytes = await readFactoryPrivatePath(current.path, 4 * 1024);
    assertFactoryMasterKeyIsRaw(masterBytes, applicationSecrets);
    const grantableRoots = this.options.grantableRoots(installation);
    for (const root of grantableRoots.map((value) => resolve(value))) {
      if (installation.operatorDirectory === root || installation.secretDirectory === root || installation.operatorDirectory.startsWith(`${root}/`) || installation.secretDirectory.startsWith(`${root}/`)) {
        throw new FactoryProvisioningError("secrets_inside_grantable_root", "Installation secrets must sit outside every grantable root.");
      }
    }
    // The read-only loader the Node process runs: no database, no key creation.
    await loadFactoryTemporalPayloadCodec({
      installationId: installation.installationId, tenantId: installation.tenantId,
      wrappedKeyFilePath: resources.wrappedKeyFilePath!, masterKeyFilePath: resources.masterKeyFilePath!, masterKeyId: resources.masterKeyId!,
      grantableRoots,
    });
    const digests = [digest(applicationSecrets[0]!), digest(applicationSecrets[1]!), digest(salt), digest(masterBytes)];
    if (resources.jwtSecretDigest !== digests[0] || resources.encryptionSecretDigest !== digests[1] || resources.saltDigest !== digests[2] || resources.masterKeyDigest !== digests[3]) {
      throw new FactoryProvisioningError("secrets_resource_mismatch", "The recorded secret digests do not match the files on disk.");
    }
    const shared = await this.options.registry.conflicts(installation.tenantId, digests);
    if (shared.length > 0) throw new FactoryProvisioningError("application_secret_shared", `A secret of this installation is also held by ${shared.join(", ")}.`);
  }

  /**
   * Destroy the application secrets. The wrap moves into the operator's escrow
   * FIRST, beside the master key, so an archive written under this
   * installation's data key stays decryptable until a human purges it.
   */
  async teardown(installation: FactoryInstallationContext): Promise<void> {
    await escrowFactoryWraps(installation);
    const secrets = await openFactoryPrivateDirectory(installation.secretDirectory);
    try {
      for (const name of [...Object.values(FACTORY_APPLICATION_SECRET_FILES), FACTORY_KEY_FILES.wraps]) await removeFactoryPrivateFile(secrets, name);
    } finally { await secrets.close(); }
  }

  /**
   * New application secrets. Existing sessions stop verifying, which is the
   * point of rotating a JWT secret; the encryption secret is NOT rotated here,
   * because rows encrypted under it would become unreadable. A data-key rewrap
   * under a new master key is `rotateMasterKey`, not this.
   */
  async rotate(installation: FactoryInstallationContext): Promise<FactoryStepResources> {
    await replaceFactoryPrivateFile(factoryPrivatePath(installation.secretDirectory, FACTORY_APPLICATION_SECRET_FILES.jwt), text(randomBytes(32).toString("base64url")));
    const resources = await this.resources(installation);
    await this.verify(installation, resources);
    return resources;
  }

  /**
   * Rotate the operator master key (C12 "Key rotation and revocation").
   *
   * `recorded` is what the ledger holds. If the wrap file is already under a
   * later key, an earlier run was interrupted after it replaced the wrap file:
   * this completes that rotation and makes no further version. Otherwise the
   * next key is written once (a rerun reuses it), checked as raw key material,
   * the live wraps are kept beside the old key, and the same data key is
   * wrapped under the next key into a staging file that then replaces the wrap
   * file atomically. The data key, and every object encrypted under it, do not
   * change.
   */
  async rotateMasterKey(installation: FactoryInstallationContext, recorded: FactoryStepResources): Promise<FactoryStepResources> {
    const from = masterKeyVersion(installation, recorded.masterKeyId);
    const current = await readFactoryCurrentMasterKey(installation);
    if (from === undefined || current.version < from) throw new FactoryProvisioningError("secrets_resource_mismatch", "The recorded master key is not one this installation's wrap file has been under.");
    if (current.version === from) await this.rewrap(installation, current);
    const resources = await this.resources(installation);
    await this.verify(installation, resources);
    return resources;
  }

  private async rewrap(installation: FactoryInstallationContext, current: FactoryCurrentMasterKey): Promise<void> {
    const next = currentMasterKey(installation, current.version + 1);
    const operator = await openFactoryPrivateDirectory(installation.operatorDirectory);
    const secrets = await openFactoryPrivateDirectory(installation.secretDirectory);
    let live: Uint8Array;
    try {
      await ensureFactoryPrivateFile(operator, factoryMasterKeyFile(next.version), () => randomBytes(MASTER_KEY_BYTES));
      const applicationSecrets = [await readFactoryPrivateText(secrets, FACTORY_APPLICATION_SECRET_FILES.jwt), await readFactoryPrivateText(secrets, FACTORY_APPLICATION_SECRET_FILES.encryption)].map((value) => value.trim());
      assertFactoryMasterKeyIsRaw(await readFactoryPrivateBytes(operator, factoryMasterKeyFile(next.version), 4 * 1024), applicationSecrets);
      live = await readFactoryPrivateBytes(secrets, FACTORY_KEY_FILES.wraps);
      await removeFactoryPrivateFile(secrets, NEXT_WRAPS);
    } finally { await operator.close(); await secrets.close(); }
    const roots = this.options.grantableRoots(installation);
    const dataKey = await InstallationDataKey.loadExisting(installation.installationId, this.wrapFile(installation, current.id), new StaticMasterKeyProvider(await readOperatorMasterKey(current.path, current.id, roots)));
    await replaceFactoryPrivateFile(factoryPrivatePath(installation.operatorDirectory, factoryRetainedWrapsFile(current.version)), live);
    const staging = factoryPrivatePath(installation.secretDirectory, NEXT_WRAPS);
    await dataKey.rotate(new ProvisionerKeyWrapFile(staging, installation.installationId, next.id), new StaticMasterKeyProvider(await readOperatorMasterKey(next.path, next.id, roots)));
    await replaceFactoryPrivateFile(factoryPrivatePath(installation.secretDirectory, FACTORY_KEY_FILES.wraps), await readFactoryPrivatePath(staging));
    const directory = await openFactoryPrivateDirectory(installation.secretDirectory);
    try { await removeFactoryPrivateFile(directory, NEXT_WRAPS); } finally { await directory.close(); }
  }

  /**
   * Revoke a superseded master key: remove it and the wraps kept under it. Only
   * a version older than the current one can go, so every wrap the
   * installation reads is already under the current key. Absent is success: a
   * rerun changes nothing.
   */
  async revokeMasterKey(installation: FactoryInstallationContext, recorded: FactoryStepResources, version: number): Promise<void> {
    if (!Number.isSafeInteger(version) || version < 1) throw new FactoryProvisioningError("master_key_revocation_invalid", "A master key version is a positive integer.");
    const current = await readFactoryCurrentMasterKey(installation);
    if (recorded.masterKeyId !== current.id) throw new FactoryProvisioningError("secrets_resource_mismatch", "The recorded master key is not the one the wrap file is under.");
    if (version >= current.version) throw new FactoryProvisioningError("master_key_revocation_current", `Master key version ${version} is not older than the current version ${current.version}; rotate first.`);
    const operator = await openFactoryPrivateDirectory(installation.operatorDirectory);
    try {
      await removeFactoryPrivateFile(operator, factoryMasterKeyFile(version));
      await removeFactoryPrivateFile(operator, factoryRetainedWrapsFile(version));
    } finally { await operator.close(); }
  }

  private wrapFile(installation: FactoryInstallationContext, masterKeyId: string): ProvisionerKeyWrapFile {
    return new ProvisionerKeyWrapFile(factoryPrivatePath(installation.secretDirectory, FACTORY_KEY_FILES.wraps), installation.installationId, masterKeyId);
  }

  private async resources(installation: FactoryInstallationContext): Promise<FactoryStepResources> {
    const current = await readFactoryCurrentMasterKey(installation);
    const secrets = await openFactoryPrivateDirectory(installation.secretDirectory);
    try {
      return Object.freeze({
        jwtSecretPath: factoryPrivatePath(installation.secretDirectory, FACTORY_APPLICATION_SECRET_FILES.jwt),
        encryptionSecretPath: factoryPrivatePath(installation.secretDirectory, FACTORY_APPLICATION_SECRET_FILES.encryption),
        saltPath: factoryPrivatePath(installation.secretDirectory, FACTORY_APPLICATION_SECRET_FILES.salt),
        wrappedKeyFilePath: factoryPrivatePath(installation.secretDirectory, FACTORY_KEY_FILES.wraps),
        masterKeyFilePath: current.path,
        masterKeyId: current.id,
        jwtSecretDigest: digest((await readFactoryPrivateText(secrets, FACTORY_APPLICATION_SECRET_FILES.jwt)).trim()),
        encryptionSecretDigest: digest((await readFactoryPrivateText(secrets, FACTORY_APPLICATION_SECRET_FILES.encryption)).trim()),
        saltDigest: digest((await readFactoryPrivateText(secrets, FACTORY_APPLICATION_SECRET_FILES.salt)).trim()),
        masterKeyDigest: digest(await readFactoryPrivatePath(current.path, 4 * 1024)),
      });
    } finally { await secrets.close(); }
  }
}


/**
 * Copy the installation's wrap into the operator's escrow. The live wrap wins
 * when it exists; once teardown has removed it, the escrow copy must already be
 * there. Neither existing means the archive key is lost, and that is refused
 * loudly rather than recorded as a successful escrow.
 */
export async function escrowFactoryWraps(installation: FactoryInstallationContext): Promise<void> {
  const operator = await openFactoryPrivateDirectory(installation.operatorDirectory);
  try {
    let live: Uint8Array | undefined;
    try {
      const secrets = await openFactoryPrivateDirectory(installation.secretDirectory);
      try { live = await readFactoryPrivateBytes(secrets, FACTORY_KEY_FILES.wraps); }
      finally { await secrets.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (live) { await replaceFactoryPrivateFile(factoryPrivatePath(installation.operatorDirectory, FACTORY_ESCROW_WRAPS), live); return; }
    try { await readFactoryPrivateBytes(operator, FACTORY_ESCROW_WRAPS); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new FactoryProvisioningError("secrets_escrow_missing", "Neither the installation's key wrap nor its escrow copy exists; the archive key cannot be kept.");
    }
  } finally { await operator.close(); }
}

/**
 * Keep the archive readable after purge: the wrap is in escrow beside the
 * master key in the operator's own directory, and every other delivered
 * secret goes.
 */
export async function escrowFactoryArchiveKey(installation: FactoryInstallationContext): Promise<void> {
  await escrowFactoryWraps(installation);
  const current = await readFactoryCurrentMasterKey(installation);
  const operator = await openFactoryPrivateDirectory(installation.operatorDirectory);
  try {
    await readFactoryPrivateBytes(operator, factoryMasterKeyFile(current.version), 4 * 1024);
    await removeFactoryPrivateFile(operator, "first-admin-invitation.json");
  } finally { await operator.close(); }
  await removeFactoryPrivateDirectory(installation.secretDirectory);
}
