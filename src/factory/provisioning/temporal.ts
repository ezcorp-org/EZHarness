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
import { ensureFactoryPrivateCertificatePair, ensureFactoryPrivateFile, factoryPrivatePath, openFactoryPrivateDirectory, readFactoryPrivateJson, readFactoryPrivatePath, removeFactoryPrivateFile, replaceFactoryPrivateFile } from "./secret-files";
import { FactoryProvisioningError } from "./steps";

export const FACTORY_TEMPORAL_ISSUER = "ezcorp-factory-local";
export const FACTORY_TEMPORAL_AUDIENCE = "ezcorp-temporal";
export const FACTORY_TEMPORAL_CONTROL_SUBJECT = "factory-control";
/**
 * A namespace token expires 30 days after it is minted. Nothing refreshes it
 * on a timer: the operator must run `rotate <tenant> temporal` inside that
 * window, or the installation's orchestrator and gateway lose Temporal at the
 * deadline. `docs/factory-deployment.md` states the same deadline.
 */
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
  /** Superseded tokens, by `jti`: the gateway refuses them on either route. */
  readonly tokenIds: readonly string[];
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
  /**
   * The gateway's read-token directory (`platform/temporal/http-tokens`). When
   * set, each namespace gets a `read:<namespace>` token, `<namespace>.token`,
   * which the gateway injects on the read-only Temporal HTTP route; the
   * installation itself never holds it.
   */
  readonly httpTokensDirectory?: string;
  readonly now?: () => number;
  /** Fault injection: throw after the rotation is staged, or after its files are swapped. Tests only. */
  readonly rotationFault?: (point: "staged" | "swapped") => Promise<void>;
}

const FILES = Object.freeze({ key: "temporal-client.key", certificate: "temporal-client.crt", ca: "temporal-ca.crt", token: "temporal-token" });
/**
 * A rotation in progress: the new key, certificate, and token, and the hash to
 * revoke, written as ONE file before any live file changes. Its presence means
 * the swap may be incomplete; `finishRotation` completes it idempotently.
 */
const PENDING = "temporal-rotation.pending";
interface FactoryTemporalPendingRotation { readonly privateKeyPem: string; readonly certificatePem: string; readonly token: string; readonly supersededHash?: string }

export function factoryTemporalOwnerMarker(installation: FactoryInstallationContext): string {
  return `factory-provisioner:${installation.fleetId}:${installation.installationId}`;
}

/** SHA-256 over the certificate's DER bytes, lowercase hex: the `Hash=` the gateway forwards. */
export function factoryCertificateHash(certificatePem: string): string {
  return createHash("sha256").update(new X509Certificate(certificatePem).raw).digest("hex");
}

/** A token's claims, or undefined when the text is not a token. Reads only; verification is the gateway's. */
export function factoryTemporalTokenClaims(token: string): { readonly sub?: string; readonly permissions?: readonly string[]; readonly exp?: number; readonly jti?: string } | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token.trim().split(".")[1] ?? "", "base64url").toString("utf8")) as unknown;
    return claims !== null && typeof claims === "object" ? claims as ReturnType<typeof factoryTemporalTokenClaims> : undefined;
  } catch { return undefined; }
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
  const tokenIds = record?.tokenIds ?? [];
  if (record?.schemaVersion !== "factory.temporal-revocations.v1" || !Array.isArray(record.subjects) || !Array.isArray(record.certificateHashes) || !Array.isArray(tokenIds)
    || record.subjects.some((subject) => typeof subject !== "string") || record.certificateHashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
    || tokenIds.some((id) => typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))) {
    throw new FactoryProvisioningError("temporal_revocations_corrupt", "The Temporal revocation list is corrupt.");
  }
  return { schemaVersion: record.schemaVersion, subjects: [...record.subjects], certificateHashes: [...record.certificateHashes], tokenIds: [...tokenIds] };
}

async function readRevocations(path: string): Promise<FactoryTemporalRevocations> {
  let text: string;
  try { text = new TextDecoder().decode(await readFactoryPrivatePath(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: "factory.temporal-revocations.v1", subjects: [], certificateHashes: [], tokenIds: [] };
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new FactoryProvisioningError("temporal_revocations_corrupt", "The Temporal revocation list is corrupt."); }
  return parseFactoryTemporalRevocations(parsed);
}

/**
 * Add entries to the revocation list, atomically.
 *
 * The file is the gateway authorizer's input, so it is replaced whole rather
 * than edited, and a reader never sees half a list.
 */
export async function revokeFactoryTemporalIdentity(path: string, entry: { readonly subject?: string; readonly certificateHash?: string; readonly tokenId?: string }): Promise<void> {
  const current = await readRevocations(path);
  const next: FactoryTemporalRevocations = {
    schemaVersion: "factory.temporal-revocations.v1",
    subjects: [...new Set([...current.subjects, ...(entry.subject ? [entry.subject] : [])])].sort(),
    certificateHashes: [...new Set([...current.certificateHashes, ...(entry.certificateHash ? [entry.certificateHash] : [])])].sort(),
    tokenIds: [...new Set([...current.tokenIds, ...(entry.tokenId ? [entry.tokenId] : [])])].sort(),
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
    await this.finishRotation(installation);
    const directory = await openFactoryPrivateDirectory(installation.secretDirectory);
    try {
      const caPem = new TextDecoder().decode(await readFactoryPrivatePath(this.options.authority.caCertificatePath));
      await ensureFactoryPrivateCertificatePair(directory, { key: FILES.key, certificate: FILES.certificate }, () => this.options.certificates.issue(installation.temporalNamespace, this.options.authority));
      await ensureFactoryPrivateFile(directory, FILES.ca, () => caPem);
      await ensureFactoryPrivateFile(directory, FILES.token, () => this.token(installation));
    } finally { await directory.close(); }
    if (this.options.httpTokensDirectory !== undefined) {
      const tokens = await openFactoryPrivateDirectory(this.options.httpTokensDirectory);
      try { await ensureFactoryPrivateFile(tokens, this.readTokenName(installation), () => this.readToken(installation)); }
      finally { await tokens.close(); }
    }
    if (existing === undefined) await this.options.admin.register(installation.temporalNamespace, marker);
    const resources = await this.resources(installation);
    await this.verify(installation, resources);
    return resources;
  }

  async verify(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<void> {
    // The ledger still names the superseded certificate, so the operator must rerun the rotation to record the new one.
    if (await this.finishRotation(installation)) throw new FactoryProvisioningError("temporal_rotation_interrupted", "An interrupted Temporal rotation was completed; rerun `rotate temporal` to record its certificate.");
    if (await this.options.admin.owner(installation.temporalNamespace) !== factoryTemporalOwnerMarker(installation)) throw new FactoryProvisioningError("temporal_namespace_missing", `Temporal namespace ${installation.temporalNamespace} is missing or foreign.`);
    const certificatePem = new TextDecoder().decode(await readFactoryPrivatePath(this.credential(installation).certificatePath));
    const certificate = new X509Certificate(certificatePem);
    if (certificate.subject !== `CN=${installation.temporalNamespace}`) throw new FactoryProvisioningError("temporal_certificate_subject", "The namespace certificate names the wrong subject.");
    if (resources.certificateHash !== factoryCertificateHash(certificatePem)) throw new FactoryProvisioningError("temporal_resource_mismatch", "The recorded namespace certificate is not the one on disk.");
    if (this.options.httpTokensDirectory !== undefined) {
      const claims = await this.readTokenClaims(installation);
      if (claims?.sub !== installation.temporalNamespace || !claims.permissions?.includes(`read:${installation.temporalNamespace}`) || !Number.isSafeInteger(claims.exp) || claims.exp! * 1_000 <= this.now()) {
        throw new FactoryProvisioningError("temporal_read_token_invalid", "The namespace's gateway read token is missing its scope or has expired; rotate the temporal step.");
      }
    }
    if (!await this.options.access.describe(installation.temporalNamespace, this.credential(installation))) throw new FactoryProvisioningError("temporal_access_denied", `The namespace credential cannot reach ${installation.temporalNamespace}.`);
  }

  /** Revoke the namespace identity at the gateway and destroy the private copies. The namespace history is kept until purge. */
  async teardown(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<void> {
    await revokeFactoryTemporalIdentity(this.options.authority.revocationsPath, { subject: installation.temporalNamespace, ...(resources.certificateHash ? { certificateHash: resources.certificateHash } : {}) });
    const directory = await openFactoryPrivateDirectory(installation.secretDirectory);
    try { for (const name of [...Object.values(FILES), PENDING]) await removeFactoryPrivateFile(directory, name); }
    finally { await directory.close(); }
    await this.retireReadToken(installation);
  }

  /**
   * A fresh key, certificate, and token; the superseded certificate is revoked by hash.
   *
   * The three new files are staged together in one pending file first, so a
   * crash can never leave a key beside a certificate it does not match: the
   * next ensure, verify, or rotate finishes the swap and the revocation.
   */
  async rotate(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<FactoryStepResources> {
    await this.finishRotation(installation);
    const issued = await this.options.certificates.issue(installation.temporalNamespace, this.options.authority);
    const staged: FactoryTemporalPendingRotation = { privateKeyPem: issued.privateKeyPem, certificatePem: issued.certificatePem, token: this.token(installation), ...(resources.certificateHash ? { supersededHash: resources.certificateHash } : {}) };
    await replaceFactoryPrivateFile(factoryPrivatePath(installation.secretDirectory, PENDING), `${JSON.stringify(staged)}\n`);
    await this.options.rotationFault?.("staged");
    await this.finishRotation(installation);
    await this.rotateReadToken(installation);
    const next = await this.resources(installation);
    await this.verify(installation, next);
    return next;
  }

  /** Complete a staged rotation, if one is on disk. Every action is idempotent. Returns whether one was found. */
  private async finishRotation(installation: FactoryInstallationContext): Promise<boolean> {
    const directory = await openFactoryPrivateDirectory(installation.secretDirectory);
    try {
      let staged: FactoryTemporalPendingRotation;
      try { staged = await readFactoryPrivateJson<FactoryTemporalPendingRotation>(directory, PENDING); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      const credential = this.credential(installation);
      await replaceFactoryPrivateFile(credential.privateKeyPath, staged.privateKeyPem);
      await replaceFactoryPrivateFile(credential.certificatePath, staged.certificatePem);
      await replaceFactoryPrivateFile(credential.tokenPath, staged.token);
      await this.options.rotationFault?.("swapped");
      if (staged.supersededHash) await revokeFactoryTemporalIdentity(this.options.authority.revocationsPath, { certificateHash: staged.supersededHash });
      await removeFactoryPrivateFile(directory, PENDING);
      return true;
    } finally { await directory.close(); }
  }

  private readTokenName(installation: FactoryInstallationContext): string {
    return `${installation.temporalNamespace}.token`;
  }

  /** The gateway's read-only token for one namespace: the only permission is `read:<namespace>`. */
  private readToken(installation: FactoryInstallationContext): string {
    return `${factoryTemporalToken(installation.temporalNamespace, [`read:${installation.temporalNamespace}`], this.tokenKey(), this.options.authority.tokenKeyId, Math.floor(this.now() / 1_000))}\n`;
  }

  /**
   * Replace the read token, then revoke the one it replaces: the gateway's next
   * call injects the new token, and a call carrying the old one is refused.
   */
  private async rotateReadToken(installation: FactoryInstallationContext): Promise<void> {
    if (this.options.httpTokensDirectory === undefined) return;
    const previous = (await this.readTokenClaims(installation))?.jti;
    await replaceFactoryPrivateFile(factoryPrivatePath(this.options.httpTokensDirectory, this.readTokenName(installation)), this.readToken(installation));
    if (previous) await revokeFactoryTemporalIdentity(this.options.authority.revocationsPath, { tokenId: previous });
  }

  /** At teardown: revoke the read token by ID and remove its file. Idempotent. */
  private async retireReadToken(installation: FactoryInstallationContext): Promise<void> {
    if (this.options.httpTokensDirectory === undefined) return;
    const previous = (await this.readTokenClaims(installation))?.jti;
    if (previous) await revokeFactoryTemporalIdentity(this.options.authority.revocationsPath, { tokenId: previous });
    const tokens = await openFactoryPrivateDirectory(this.options.httpTokensDirectory);
    try { await removeFactoryPrivateFile(tokens, this.readTokenName(installation)); } finally { await tokens.close(); }
  }

  /** The namespace's read-token claims, or undefined when none is on file. Only called with a token directory set. */
  private async readTokenClaims(installation: FactoryInstallationContext): Promise<ReturnType<typeof factoryTemporalTokenClaims>> {
    try { return factoryTemporalTokenClaims(new TextDecoder().decode(await readFactoryPrivatePath(factoryPrivatePath(this.options.httpTokensDirectory!, this.readTokenName(installation))))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
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
