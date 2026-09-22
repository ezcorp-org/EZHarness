/**
 * One installation's private service mesh: the certificates and tokens its own
 * processes present to each other.
 *
 * Each installation gets its own mesh authority, so nothing issued for one
 * installation is accepted by another's listeners. The identities, by client
 * certificate common name:
 *
 *   - `harness.<tenant>`       the product process, calling the pool, the
 *                              supervisor's launch/stop services, the gateway
 *   - `orchestrator.<tenant>`  the Node orchestrator, calling the product's
 *                              private service
 *   - `supervisor.<tenant>`    the host supervisor, calling the pool to confirm
 *                              a stop
 *
 * Every listener presents the one server certificate (`localhost`, 127.0.0.1),
 * because every listener binds loopback. Tokens are RS256 under a mesh key the
 * operator holds; listeners get only its public half.
 *
 * The host SIGNING key is separate from all of this: it belongs to the
 * supervisor alone and signs physical-stop receipts, and the product holds only
 * its public half to verify them.
 */
import { createPrivateKey, createPublicKey, createSign, generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { createFactoryCertificateAuthority, issueFactoryCertificate, type FactoryCommandRunner } from "./certificates";
import type { FactoryInstallationContext } from "./installation";
import { ensureFactoryPrivateCertificatePair, ensureFactoryPrivateFile, factoryPrivatePath, openFactoryPrivateDirectory, readFactoryPrivateText, replaceFactoryPrivateFile } from "./secret-files";
import { FactoryProvisioningError } from "./steps";

export const FACTORY_MESH_TOKEN_KEY_ID = "mesh-1";
export const FACTORY_POOL_AUDIENCE = "factory-pool";
export const FACTORY_PRIVATE_SERVICE_AUDIENCE = "factory-private-service";
export const FACTORY_HOST_KEY_ID = "host-key-1";
const MESH_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

export const FACTORY_MESH_FILES = Object.freeze({
  caCertificate: "mesh-ca.crt",
  serverCertificate: "mesh-server.crt", serverKey: "mesh-server.key",
  harnessCertificate: "mesh-harness.crt", harnessKey: "mesh-harness.key",
  orchestratorCertificate: "mesh-orchestrator.crt", orchestratorKey: "mesh-orchestrator.key",
  supervisorCertificate: "mesh-supervisor.crt", supervisorKey: "mesh-supervisor.key",
  tokenPublicKey: "mesh-token.pub",
  harnessPoolToken: "mesh-harness-pool.token",
  supervisorPoolToken: "mesh-supervisor-pool.token",
  orchestratorToken: "mesh-orchestrator.token",
  attemptTokenSecret: "attempt-token-secret",
  hostKey: "host-signing.key", hostPublicKey: "host-signing.pub", hostKeyId: "host-signing.kid",
});
/** Operator-only: never delivered to any process. */
export const FACTORY_MESH_OPERATOR_FILES = Object.freeze({ caCertificate: "mesh-ca.crt", caKey: "mesh-ca.key", tokenKey: "mesh-token.key" });

export interface FactoryMeshIdentities {
  readonly harness: string;
  readonly orchestrator: string;
  readonly supervisor: string;
  readonly hostId: string;
  readonly issuer: string;
}

export function factoryMeshIdentities(installation: FactoryInstallationContext): FactoryMeshIdentities {
  return Object.freeze({
    harness: `harness.${installation.tenantId}`,
    orchestrator: `orchestrator.${installation.tenantId}`,
    supervisor: `supervisor.${installation.tenantId}`,
    hostId: `host.${installation.tenantId}.${installation.fleetId}`,
    issuer: `factory-mesh:${installation.installationId}`,
  });
}

export function factoryMeshToken(input: { readonly subject: string; readonly issuer: string; readonly audience: string; readonly scope: readonly string[]; readonly keyPem: string; readonly nowSeconds: number }): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "RS256", kid: FACTORY_MESH_TOKEN_KEY_ID, typ: "JWT" })}.${encode({ sub: input.subject, iss: input.issuer, aud: input.audience, scope: [...input.scope], iat: input.nowSeconds, exp: input.nowSeconds + MESH_TOKEN_LIFETIME_SECONDS, jti: randomBytes(16).toString("hex") })}`;
  const signer = createSign("RSA-SHA256"); signer.update(body); signer.end();
  return `${body}.${signer.sign(createPrivateKey(input.keyPem)).toString("base64url")}`;
}

export interface FactoryMeshOptions {
  readonly run?: FactoryCommandRunner;
  readonly now?: () => number;
}

function meshAuthority(installation: FactoryInstallationContext) {
  return { certificatePath: factoryPrivatePath(installation.operatorDirectory, FACTORY_MESH_OPERATOR_FILES.caCertificate), keyPath: factoryPrivatePath(installation.operatorDirectory, FACTORY_MESH_OPERATOR_FILES.caKey) };
}

/** The four leaf certificates every installation's processes present, with their key files. */
function meshLeaves(installation: FactoryInstallationContext) {
  const identities = factoryMeshIdentities(installation);
  return [
    [FACTORY_MESH_FILES.serverCertificate, FACTORY_MESH_FILES.serverKey, { subject: "localhost", usage: "server" as const, dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"] }],
    [FACTORY_MESH_FILES.harnessCertificate, FACTORY_MESH_FILES.harnessKey, { subject: identities.harness, usage: "client" as const }],
    [FACTORY_MESH_FILES.orchestratorCertificate, FACTORY_MESH_FILES.orchestratorKey, { subject: identities.orchestrator, usage: "client" as const }],
    [FACTORY_MESH_FILES.supervisorCertificate, FACTORY_MESH_FILES.supervisorKey, { subject: identities.supervisor, usage: "client" as const }],
  ] as const;
}

/** The three service tokens, each as its file and the text a fresh mint writes. */
function meshTokens(installation: FactoryInstallationContext, keyPem: string, nowSeconds: number): ReadonlyArray<readonly [string, () => string]> {
  const identities = factoryMeshIdentities(installation);
  const token = (subject: string, audience: string, scope: readonly string[]) => () => `${factoryMeshToken({ subject, issuer: identities.issuer, audience, scope, keyPem, nowSeconds })}\n`;
  return [
    [FACTORY_MESH_FILES.harnessPoolToken, token(installation.tenantId, FACTORY_POOL_AUDIENCE, [`pool:tenant:${installation.tenantId}`, `pool:grant:${installation.tenantId}:factory`])],
    [FACTORY_MESH_FILES.supervisorPoolToken, token(identities.supervisor, FACTORY_POOL_AUDIENCE, [`pool:supervisor:${identities.supervisor}`])],
    [FACTORY_MESH_FILES.orchestratorToken, token(identities.orchestrator, FACTORY_PRIVATE_SERVICE_AUDIENCE, ["factory:orchestrate"])],
  ];
}

export interface FactoryMeshState {
  /** The earliest expiry among the service tokens. Rotate before it. */
  readonly tokensExpireAtMs: number;
}

/**
 * Create the installation's mesh material, or prove what exists is intact.
 *
 * Write-once like every provisioned file: a rerun never replaces a certificate
 * a running process already trusts. `rotateFactoryMesh` is the replacement path.
 */
export async function ensureFactoryMesh(installation: FactoryInstallationContext, options: FactoryMeshOptions = {}): Promise<FactoryMeshState> {
  const operator = await openFactoryPrivateDirectory(installation.operatorDirectory);
  const secrets = await openFactoryPrivateDirectory(installation.secretDirectory);
  try {
    await ensureFactoryPrivateCertificatePair(operator, { key: FACTORY_MESH_OPERATOR_FILES.caKey, certificate: FACTORY_MESH_OPERATOR_FILES.caCertificate }, () => createFactoryCertificateAuthority(`mesh.${installation.tenantId}`, options.run));
    const caPem = await readFactoryPrivateText(operator, FACTORY_MESH_OPERATOR_FILES.caCertificate);
    await ensureFactoryPrivateFile(secrets, FACTORY_MESH_FILES.caCertificate, () => caPem);
    for (const [certificateFile, keyFile, request] of meshLeaves(installation)) await ensureFactoryPrivateCertificatePair(secrets, { key: keyFile, certificate: certificateFile }, () => issueFactoryCertificate(meshAuthority(installation), request, options.run));
    await ensureFactoryPrivateFile(operator, FACTORY_MESH_OPERATOR_FILES.tokenKey, () => generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const tokenKeyPem = await readFactoryPrivateText(operator, FACTORY_MESH_OPERATOR_FILES.tokenKey);
    await ensureFactoryPrivateFile(secrets, FACTORY_MESH_FILES.tokenPublicKey, () => createPublicKey(createPrivateKey(tokenKeyPem)).export({ type: "spki", format: "pem" }).toString());
    for (const [file, mint] of meshTokens(installation, tokenKeyPem, Math.floor((options.now ?? Date.now)() / 1_000))) await ensureFactoryPrivateFile(secrets, file, mint);
    await ensureFactoryPrivateFile(secrets, FACTORY_MESH_FILES.attemptTokenSecret, () => `${randomBytes(32).toString("hex")}\n`);
    let hostKeyPem: string | undefined;
    try { hostKeyPem = await readFactoryPrivateText(secrets, FACTORY_MESH_FILES.hostKey); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const generated = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      await ensureFactoryPrivateFile(secrets, FACTORY_MESH_FILES.hostKey, () => generated);
      hostKeyPem = generated;
    }
    await ensureFactoryPrivateFile(secrets, FACTORY_MESH_FILES.hostPublicKey, () => createPublicKey(createPrivateKey(hostKeyPem!)).export({ type: "spki", format: "pem" }).toString());
    await ensureFactoryPrivateFile(secrets, FACTORY_MESH_FILES.hostKeyId, () => FACTORY_HOST_KEY_ID);
    return await verifyFactoryMesh(installation, secrets, caPem, (options.now ?? Date.now)());
  } finally { await operator.close(); await secrets.close(); }
}

/**
 * New leaf certificates and service tokens under the same mesh authority.
 *
 * Each key is replaced before its certificate, each atomically; a crash between
 * the two leaves a pair whose key does not match, which `verifyFactoryMesh`
 * names (`mesh_certificate_invalid`) and a rerun of the rotation repairs. The
 * authority, the token key, the attempt-token secret, and the host signing key
 * are not rotated here.
 */
export async function rotateFactoryMesh(installation: FactoryInstallationContext, options: FactoryMeshOptions = {}): Promise<FactoryMeshState> {
  const operator = await openFactoryPrivateDirectory(installation.operatorDirectory);
  const secrets = await openFactoryPrivateDirectory(installation.secretDirectory);
  try {
    const caPem = await readFactoryPrivateText(operator, FACTORY_MESH_OPERATOR_FILES.caCertificate);
    for (const [certificateFile, keyFile, request] of meshLeaves(installation)) {
      const issued = await issueFactoryCertificate(meshAuthority(installation), request, options.run);
      await replaceFactoryPrivateFile(factoryPrivatePath(installation.secretDirectory, keyFile), issued.privateKeyPem);
      await replaceFactoryPrivateFile(factoryPrivatePath(installation.secretDirectory, certificateFile), issued.certificatePem);
    }
    const tokenKeyPem = await readFactoryPrivateText(operator, FACTORY_MESH_OPERATOR_FILES.tokenKey);
    for (const [file, mint] of meshTokens(installation, tokenKeyPem, Math.floor((options.now ?? Date.now)() / 1_000))) await replaceFactoryPrivateFile(factoryPrivatePath(installation.secretDirectory, file), mint());
    return await verifyFactoryMesh(installation, secrets, caPem, (options.now ?? Date.now)());
  } finally { await operator.close(); await secrets.close(); }
}

/**
 * Every leaf is CN-correct, signed by this installation's authority, and pairs
 * with its own key; every service token has an expiry still in the future. An
 * expired token fails here, loudly, instead of failing every pool admission
 * later: the remedy is `rotate <tenant> deployment`.
 */
async function verifyFactoryMesh(installation: FactoryInstallationContext, secrets: Parameters<typeof readFactoryPrivateText>[0], caPem: string, nowMs: number): Promise<FactoryMeshState> {
  const ca = new X509Certificate(caPem);
  for (const [file, keyFile, request] of meshLeaves(installation)) {
    const certificate = new X509Certificate(await readFactoryPrivateText(secrets, file));
    if (certificate.subject !== `CN=${request.subject}` || !certificate.verify(ca.publicKey) || !certificate.checkPrivateKey(createPrivateKey(await readFactoryPrivateText(secrets, keyFile)))) {
      throw new FactoryProvisioningError("mesh_certificate_invalid", `Mesh certificate ${file} is not CN=${request.subject} under this installation's authority with its own key.`);
    }
  }
  let tokensExpireAtMs = Number.MAX_SAFE_INTEGER;
  for (const [file] of meshTokens(installation, "", 0)) {
    let claims: { exp?: unknown } | null;
    try { claims = JSON.parse(Buffer.from((await readFactoryPrivateText(secrets, file)).trim().split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown } | null; }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      claims = null;
    }
    if (!Number.isSafeInteger(claims?.exp)) throw new FactoryProvisioningError("mesh_token_invalid", `Mesh token ${file} has no expiry.`);
    const expiresAtMs = (claims!.exp as number) * 1_000;
    if (expiresAtMs <= nowMs) throw new FactoryProvisioningError("mesh_token_expired", `Mesh token ${file} has expired; rotate the installation's deployment step.`);
    tokensExpireAtMs = Math.min(tokensExpireAtMs, expiresAtMs);
  }
  return Object.freeze({ tokensExpireAtMs });
}
