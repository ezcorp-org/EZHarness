/**
 * C12 step 3: a Temporal namespace with namespace-scoped mutual-TLS credentials.
 *
 * The local profile's Temporal endpoint is a gateway that requires BOTH a client
 * certificate signed by the fleet's Temporal CA and a signed token, and an
 * authorizer that binds them: the token's subject must equal the certificate's
 * common name, and the token must carry `admin:<that name>`. So a namespace's
 * credential is the pair, and the pair is issued with the namespace name as the
 * certificate subject. One tenant's pair cannot address another namespace: the
 * server's own authorizer maps the permission to exactly one namespace.
 *
 * Revocation is immediate and local to the fleet: the gateway's authorizer reads
 * a revocation list on every request, keyed by certificate subject (teardown
 * revokes the whole namespace identity) and by certificate hash (rotation
 * revokes only the superseded certificate). Token expiry is a second, slower
 * bound, never the only one.
 */
import { createHash, createPrivateKey, createPublicKey, createSign, randomBytes, X509Certificate } from "node:crypto";
import { issueFactoryCertificate, type FactoryCommandRunner, type FactoryIssuedCertificate } from "./certificates";
import type { FactoryInstallationContext, FactoryProvisioningDriver, FactoryStepResources } from "./installation";
import { ensureFactoryPrivateFile, factoryPrivatePath, openFactoryPrivateDirectory, readFactoryPrivatePath, readFactoryPrivateText, removeFactoryPrivateFile, replaceFactoryPrivateFile } from "./secret-files";
import { FactoryProvisioningError } from "./steps";

export const FACTORY_TEMPORAL_ISSUER = "ezcorp-factory-local";
export const FACTORY_TEMPORAL_AUDIENCE = "ezcorp-temporal";
export const FACTORY_TEMPORAL_CONTROL_SUBJECT = "factory-control";
const TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

/** Operator-held Temporal authority files. None of these is ever delivered to an installation. */
export interface FactoryTemporalAuthorityPaths {
  readonly caCertificatePath: string;
  readonly caKeyPath: string;
  readonly tokenKeyPath: string;
  readonly tokenKeyId: string;
  readonly revocationsPath: string;
}

export interface FactoryTemporalRevocations {
  readonly schemaVersion: "factory.temporal-revocations.v1";
  readonly subjects: readonly string[];
  readonly certificateHashes: readonly string[];
}

/** Registers and describes namespaces with the operator's control identity. */
export interface FactoryTemporalNamespaceAdmin {
  register(namespace: string, ownerMarker: string): Promise<void>;
  /** The namespace's recorded owner marker, or undefined when it does not exist. */
  owner(namespace: string): Promise<string | undefined>;
}

/** Can this credential describe that namespace through the gateway? */
export interface FactoryTemporalAccessProbe {
  describe(namespace: string, credential: FactoryTemporalClientCredential): Promise<boolean>;
}

export interface FactoryTemporalClientCredential {
  readonly caCertificatePath: string;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly tokenPath: string;
}

/** Issues a client certificate for one subject. */
export interface FactoryCertificateIssuer {
  issue(subject: string, authority: FactoryTemporalAuthorityPaths): Promise<FactoryIssuedCertificate>;
}

export interface FactoryTemporalStepOptions {
  readonly authority: FactoryTemporalAuthorityPaths;
  readonly admin: FactoryTemporalNamespaceAdmin;
  readonly access: FactoryTemporalAccessProbe;
  readonly certificates: FactoryCertificateIssuer;
  readonly now?: () => number;
}

const FILES = Object.freeze({ key: "temporal-client.key", certificate: "temporal-client.crt", ca: "temporal-ca.crt", token: "temporal-token" });

export function factoryTemporalOwnerMarker(installation: FactoryInstallationContext): string {
  return `factory-provisioner:${installation.fleetId}:${installation.installationId}`;
}

/** SHA-256 over the certificate's DER bytes, lowercase hex: the `Hash=` the gateway forwards. */
export function factoryCertificateHash(certificatePem: string): string {
  return createHash("sha256").update(new X509Certificate(certificatePem).raw).digest("hex");
}

/** An RS256 token for one Temporal subject with one namespace permission. */
export function factoryTemporalToken(subject: string, permissions: readonly string[], keyPem: string, keyId: string, nowSeconds: number, lifetimeSeconds = TOKEN_LIFETIME_SECONDS): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", kid: keyId, typ: "JWT" })}.${encode({ sub: subject, iss: FACTORY_TEMPORAL_ISSUER, aud: FACTORY_TEMPORAL_AUDIENCE, permissions: [...permissions], iat: nowSeconds, exp: nowSeconds + lifetimeSeconds, jti: randomBytes(16).toString("hex") })}`;
  const signer = createSign("RSA-SHA256"); signer.update(input); signer.end();
  return `${input}.${signer.sign(createPrivateKey(keyPem)).toString("base64url")}`;
}

/** The JWKS document the gateway fetches. Public material only. */
export function factoryTemporalJwks(keyPem: string, keyId: string): { readonly keys: readonly Record<string, string>[] } {
  const jwk = createPublicKey(createPrivateKey(keyPem)).export({ format: "jwk" }) as Record<string, string>;
  return { keys: [{ kty: jwk.kty!, n: jwk.n!, e: jwk.e!, alg: "RS256", use: "sig", kid: keyId }] };
}

export function parseFactoryTemporalRevocations(value: unknown): FactoryTemporalRevocations {
  const record = value as Partial<FactoryTemporalRevocations> | null;
  if (!record || record.schemaVersion !== "factory.temporal-revocations.v1" || !Array.isArray(record.subjects) || !Array.isArray(record.certificateHashes)
    || record.subjects.some((subject) => typeof subject !== "string") || record.certificateHashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new FactoryProvisioningError("temporal_revocations_corrupt", "The Temporal revocation list is corrupt.");
  }
  return { schemaVersion: record.schemaVersion, subjects: [...record.subjects], certificateHashes: [...record.certificateHashes] };
}

async function readRevocations(path: string): Promise<FactoryTemporalRevocations> {
  try { return parseFactoryTemporalRevocations(JSON.parse(new TextDecoder().decode(await readFactoryPrivatePath(path)))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: "factory.temporal-revocations.v1", subjects: [], certificateHashes: [] };
    throw error;
  }
}

/**
 * Add entries to the revocation list, atomically.
 *
 * The file is the gateway authorizer's input, so it is replaced whole rather
 * than edited, and a reader never sees half a list.
 */
export async function revokeFactoryTemporalIdentity(path: string, entry: { readonly subject?: string; readonly certificateHash?: string }): Promise<void> {
  const current = await readRevocations(path);
  const next: FactoryTemporalRevocations = {
    schemaVersion: "factory.temporal-revocations.v1",
    subjects: [...new Set([...current.subjects, ...(entry.subject ? [entry.subject] : [])])].sort(),
    certificateHashes: [...new Set([...current.certificateHashes, ...(entry.certificateHash ? [entry.certificateHash] : [])])].sort(),
  };
  await replaceFactoryPrivateFile(path, `${JSON.stringify(next)}\n`);
}

export class FactoryTemporalStep implements FactoryProvisioningDriver {
  readonly step = "temporal" as const;
  private readonly now: () => number;
  constructor(private readonly options: FactoryTemporalStepOptions) { this.now = options.now ?? Date.now; }

  credential(installation: FactoryInstallationContext): FactoryTemporalClientCredential {
    return {
      caCertificatePath: factoryPrivatePath(installation.secretDirectory, FILES.ca),
      certificatePath: factoryPrivatePath(installation.secretDirectory, FILES.certificate),
      privateKeyPath: factoryPrivatePath(installation.secretDirectory, FILES.key),
      tokenPath: factoryPrivatePath(installation.secretDirectory, FILES.token),
    };
  }

  async ensure(installation: FactoryInstallationContext): Promise<FactoryStepResources> {
    const marker = factoryTemporalOwnerMarker(installation);
    const existing = await this.options.admin.owner(installation.temporalNamespace);
    // A namespace someone else registered under this name is never adopted.
    if (existing !== undefined && existing !== marker) throw new FactoryProvisioningError("temporal_namespace_foreign", `Temporal namespace ${installation.temporalNamespace} exists without this installation's provenance.`);
    const directory = await openFactoryPrivateDirectory(installation.secretDirectory);
    try {
      const caPem = new TextDecoder().decode(await readFactoryPrivatePath(this.options.authority.caCertificatePath));
      let issued: FactoryIssuedCertificate | undefined;
      try { await readFactoryPrivateText(directory, FILES.certificate); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        issued = await this.options.certificates.issue(installation.temporalNamespace, this.options.authority);
      }
      if (issued) {
        // Key before certificate: a certificate on disk always has its key beside it.
        await ensureFactoryPrivateFile(directory, FILES.key, () => issued!.privateKeyPem);
        await ensureFactoryPrivateFile(directory, FILES.certificate, () => issued!.certificatePem);
      }
      await ensureFactoryPrivateFile(directory, FILES.ca, () => caPem);
      await ensureFactoryPrivateFile(directory, FILES.token, () => this.token(installation));
    } finally { await directory.close(); }
    if (existing === undefined) await this.options.admin.register(installation.temporalNamespace, marker);
    const resources = await this.resources(installation);
    await this.verify(installation, resources);
    return resources;
  }

  async verify(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<void> {
    if (await this.options.admin.owner(installation.temporalNamespace) !== factoryTemporalOwnerMarker(installation)) throw new FactoryProvisioningError("temporal_namespace_missing", `Temporal namespace ${installation.temporalNamespace} is missing or foreign.`);
    const certificatePem = new TextDecoder().decode(await readFactoryPrivatePath(this.credential(installation).certificatePath));
    const certificate = new X509Certificate(certificatePem);
    if (certificate.subject !== `CN=${installation.temporalNamespace}`) throw new FactoryProvisioningError("temporal_certificate_subject", "The namespace certificate names the wrong subject.");
    if (resources.certificateHash !== factoryCertificateHash(certificatePem)) throw new FactoryProvisioningError("temporal_resource_mismatch", "The recorded namespace certificate is not the one on disk.");
    if (!await this.options.access.describe(installation.temporalNamespace, this.credential(installation))) throw new FactoryProvisioningError("temporal_access_denied", `The namespace credential cannot reach ${installation.temporalNamespace}.`);
  }

  /** Revoke the namespace identity at the gateway and destroy the private copies. The namespace history is kept until purge. */
  async teardown(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<void> {
    await revokeFactoryTemporalIdentity(this.options.authority.revocationsPath, { subject: installation.temporalNamespace, ...(resources.certificateHash ? { certificateHash: resources.certificateHash } : {}) });
    const directory = await openFactoryPrivateDirectory(installation.secretDirectory);
    try { for (const name of Object.values(FILES)) await removeFactoryPrivateFile(directory, name); }
    finally { await directory.close(); }
  }

  /** A fresh key, certificate, and token; the superseded certificate is revoked by hash. */
  async rotate(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<FactoryStepResources> {
    const issued = await this.options.certificates.issue(installation.temporalNamespace, this.options.authority);
    const credential = this.credential(installation);
    await replaceFactoryPrivateFile(credential.privateKeyPath, issued.privateKeyPem);
    await replaceFactoryPrivateFile(credential.certificatePath, issued.certificatePem);
    await replaceFactoryPrivateFile(credential.tokenPath, this.token(installation));
    if (resources.certificateHash) await revokeFactoryTemporalIdentity(this.options.authority.revocationsPath, { certificateHash: resources.certificateHash });
    const next = await this.resources(installation);
    await this.verify(installation, next);
    return next;
  }

  private token(installation: FactoryInstallationContext): string {
    return `${factoryTemporalToken(installation.temporalNamespace, [`admin:${installation.temporalNamespace}`], this.tokenKey(), this.options.authority.tokenKeyId, Math.floor(this.now() / 1_000))}\n`;
  }

  private tokenKeyPem: string | undefined;
  private tokenKey(): string {
    if (this.tokenKeyPem === undefined) throw new FactoryProvisioningError("temporal_authority_unloaded", "The Temporal token key has not been loaded.");
    return this.tokenKeyPem;
  }

  /** Load the operator's token key once. Separate from construction so a missing key fails by name. */
  async load(): Promise<void> {
    this.tokenKeyPem = new TextDecoder().decode(await readFactoryPrivatePath(this.options.authority.tokenKeyPath));
  }

  private async resources(installation: FactoryInstallationContext): Promise<FactoryStepResources> {
    const credential = this.credential(installation);
    const certificatePem = new TextDecoder().decode(await readFactoryPrivatePath(credential.certificatePath));
    return Object.freeze({
      namespace: installation.temporalNamespace,
      ownerMarker: factoryTemporalOwnerMarker(installation),
      certificatePath: credential.certificatePath,
      privateKeyPath: credential.privateKeyPath,
      caCertificatePath: credential.caCertificatePath,
      tokenPath: credential.tokenPath,
      certificateHash: factoryCertificateHash(certificatePem),
    });
  }
}

/** The local issuer: the fleet's Temporal CA, one client certificate per namespace subject. */
export function factoryTemporalCertificateIssuer(run?: FactoryCommandRunner): FactoryCertificateIssuer {
  return { issue: (subject, authority) => issueFactoryCertificate({ certificatePath: authority.caCertificatePath, keyPath: authority.caKeyPath }, { subject, usage: "client" }, run) };
}
