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
import { InstallationDataKey, StaticMasterKeyProvider, readOperatorMasterKey, type InstallationKeyWrap, type InstallationKeyWrapStore } from "../encryption";
import { loadFactoryTemporalPayloadCodec, parseFactoryKeyWrapFile } from "../file-key-wraps";
import type { FactoryInstallationContext, FactoryProvisioningDriver, FactoryStepResources } from "./installation";
import { ensureFactoryPrivateFile, factoryPrivatePath, openFactoryPrivateDirectory, readFactoryPrivateBytes, readFactoryPrivateText, removeFactoryPrivateDirectory, removeFactoryPrivateFile, replaceFactoryPrivateFile } from "./secret-files";
import { FactoryProvisioningError } from "./steps";

export const FACTORY_APPLICATION_SECRET_FILES = Object.freeze({ jwt: "application-jwt-secret", encryption: "application-encryption-secret", salt: "application-encryption-salt" });
export const FACTORY_KEY_FILES = Object.freeze({ master: "master.key", wraps: "wraps.json" });
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

export class FactorySecretsStep implements FactoryProvisioningDriver {
  readonly step = "secrets" as const;
  constructor(private readonly options: FactorySecretsStepOptions) {}

  async ensure(installation: FactoryInstallationContext): Promise<FactoryStepResources> {
    const secrets = await openFactoryPrivateDirectory(installation.secretDirectory);
    const operator = await openFactoryPrivateDirectory(installation.operatorDirectory);
    try {
      await ensureFactoryPrivateFile(secrets, FACTORY_APPLICATION_SECRET_FILES.jwt, () => text(randomBytes(32).toString("base64url")));
      await ensureFactoryPrivateFile(secrets, FACTORY_APPLICATION_SECRET_FILES.encryption, () => text(randomBytes(32).toString("base64url")));
      await ensureFactoryPrivateFile(secrets, FACTORY_APPLICATION_SECRET_FILES.salt, () => text(randomBytes(16).toString("hex")));
      await ensureFactoryPrivateFile(operator, FACTORY_KEY_FILES.master, () => randomBytes(MASTER_KEY_BYTES));
    } finally { await secrets.close(); await operator.close(); }
    const wrapsPath = factoryPrivatePath(installation.secretDirectory, FACTORY_KEY_FILES.wraps);
    const masterKeyPath = factoryPrivatePath(installation.operatorDirectory, FACTORY_KEY_FILES.master);
    const masterKeyId = factoryMasterKeyId(installation);
    const master = await readOperatorMasterKey(masterKeyPath, masterKeyId, this.options.grantableRoots(installation));
    await InstallationDataKey.loadOrCreate(installation.installationId, new ProvisionerKeyWrapFile(wrapsPath, installation.installationId, masterKeyId), new StaticMasterKeyProvider(master));
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
    const operator = await openFactoryPrivateDirectory(installation.operatorDirectory);
    let masterBytes: Uint8Array;
    try { masterBytes = await readFactoryPrivateBytes(operator, FACTORY_KEY_FILES.master, 4 * 1024); }
    finally { await operator.close(); }
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
   * Destroy the application secrets and the wrap. The MASTER KEY is kept until
   * purge: an archive written under this installation's data key stays
   * decryptable by the operator until a human purges it.
   */
  async teardown(installation: FactoryInstallationContext): Promise<void> {
    const secrets = await openFactoryPrivateDirectory(installation.secretDirectory);
    try {
      for (const name of [...Object.values(FACTORY_APPLICATION_SECRET_FILES), FACTORY_KEY_FILES.wraps]) await removeFactoryPrivateFile(secrets, name);
    } finally { await secrets.close(); }
  }

  /**
   * New application secrets. Existing sessions stop verifying, which is the
   * point of rotating a JWT secret; the encryption secret is NOT rotated here,
   * because rows encrypted under it would become unreadable. A data-key rewrap
   * under a new master key is `InstallationDataKey.rotate`, not this.
   */
  async rotate(installation: FactoryInstallationContext): Promise<FactoryStepResources> {
    await replaceFactoryPrivateFile(factoryPrivatePath(installation.secretDirectory, FACTORY_APPLICATION_SECRET_FILES.jwt), text(randomBytes(32).toString("base64url")));
    const resources = await this.resources(installation);
    await this.verify(installation, resources);
    return resources;
  }

  private async resources(installation: FactoryInstallationContext): Promise<FactoryStepResources> {
    const secrets = await openFactoryPrivateDirectory(installation.secretDirectory);
    const operator = await openFactoryPrivateDirectory(installation.operatorDirectory);
    try {
      return Object.freeze({
        jwtSecretPath: factoryPrivatePath(installation.secretDirectory, FACTORY_APPLICATION_SECRET_FILES.jwt),
        encryptionSecretPath: factoryPrivatePath(installation.secretDirectory, FACTORY_APPLICATION_SECRET_FILES.encryption),
        saltPath: factoryPrivatePath(installation.secretDirectory, FACTORY_APPLICATION_SECRET_FILES.salt),
        wrappedKeyFilePath: factoryPrivatePath(installation.secretDirectory, FACTORY_KEY_FILES.wraps),
        masterKeyFilePath: factoryPrivatePath(installation.operatorDirectory, FACTORY_KEY_FILES.master),
        masterKeyId: factoryMasterKeyId(installation),
        jwtSecretDigest: digest((await readFactoryPrivateText(secrets, FACTORY_APPLICATION_SECRET_FILES.jwt)).trim()),
        encryptionSecretDigest: digest((await readFactoryPrivateText(secrets, FACTORY_APPLICATION_SECRET_FILES.encryption)).trim()),
        saltDigest: digest((await readFactoryPrivateText(secrets, FACTORY_APPLICATION_SECRET_FILES.salt)).trim()),
        masterKeyDigest: digest(await readFactoryPrivateBytes(operator, FACTORY_KEY_FILES.master, 4 * 1024)),
      });
    } finally { await secrets.close(); await operator.close(); }
  }
}

/**
 * Keep the archive readable after purge: the wrap moves beside the master key
 * in the operator's own directory, and every other delivered secret goes.
 */
export async function escrowFactoryArchiveKey(installation: FactoryInstallationContext): Promise<void> {
  const escrow = factoryPrivatePath(installation.operatorDirectory, `escrow-${FACTORY_KEY_FILES.wraps}`);
  const operator = await openFactoryPrivateDirectory(installation.operatorDirectory);
  try {
    const secrets = await openFactoryPrivateDirectory(installation.secretDirectory);
    try {
      let bytes: Uint8Array | undefined;
      try { bytes = await readFactoryPrivateBytes(secrets, FACTORY_KEY_FILES.wraps); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (bytes) await replaceFactoryPrivateFile(escrow, bytes);
    } finally { await secrets.close(); }
    await readFactoryPrivateBytes(operator, FACTORY_KEY_FILES.master, 4 * 1024);
    await removeFactoryPrivateFile(operator, "first-admin-invitation.json");
  } finally { await operator.close(); }
  await removeFactoryPrivateDirectory(installation.secretDirectory);
}
