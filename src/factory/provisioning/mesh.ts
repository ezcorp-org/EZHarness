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
import { ensureFactoryPrivateFile, factoryPrivatePath, openFactoryPrivateDirectory, readFactoryPrivateText } from "./secret-files";
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

/**
 * Create the installation's mesh material, or prove what exists is intact.
 *
 * Write-once like every provisioned file: a rerun never replaces a certificate
 * a running process already trusts. Rotation replaces through `rotateFactoryMesh`.
 */
export async function ensureFactoryMesh(installation: FactoryInstallationContext, options: FactoryMeshOptions = {}): Promise<void> {
  const operator = await openFactoryPrivateDirectory(installation.operatorDirectory);
  const secrets = await openFactoryPrivateDirectory(installation.secretDirectory);
  try {
    let authority: { certificatePem: string; privateKeyPem: string } | undefined;
    try { await readFactoryPrivateText(operator, FACTORY_MESH_OPERATOR_FILES.caKey); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      authority = await createFactoryCertificateAuthority(`mesh.${installation.tenantId}`, options.run);
    }
    if (authority) {
      await ensureFactoryPrivateFile(operator, FACTORY_MESH_OPERATOR_FILES.caKey, () => authority!.privateKeyPem);
      await ensureFactoryPrivateFile(operator, FACTORY_MESH_OPERATOR_FILES.caCertificate, () => authority!.certificatePem);
    }
    const caPem = await readFactoryPrivateText(operator, FACTORY_MESH_OPERATOR_FILES.caCertificate);
    await ensureFactoryPrivateFile(secrets, FACTORY_MESH_FILES.caCertificate, () => caPem);
    const ca = { certificatePath: factoryPrivatePath(installation.operatorDirectory, FACTORY_MESH_OPERATOR_FILES.caCertificate), keyPath: factoryPrivatePath(installation.operatorDirectory, FACTORY_MESH_OPERATOR_FILES.caKey) };
    const identities = factoryMeshIdentities(installation);
    const leaves = [
      [FACTORY_MESH_FILES.serverCertificate, FACTORY_MESH_FILES.serverKey, { subject: "localhost", usage: "server" as const, dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"] }],
      [FACTORY_MESH_FILES.harnessCertificate, FACTORY_MESH_FILES.harnessKey, { subject: identities.harness, usage: "client" as const }],
      [FACTORY_MESH_FILES.orchestratorCertificate, FACTORY_MESH_FILES.orchestratorKey, { subject: identities.orchestrator, usage: "client" as const }],
      [FACTORY_MESH_FILES.supervisorCertificate, FACTORY_MESH_FILES.supervisorKey, { subject: identities.supervisor, usage: "client" as const }],
    ] as const;
    for (const [certificateFile, keyFile, request] of leaves) {
      try { await readFactoryPrivateText(secrets, certificateFile); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const issued = await issueFactoryCertificate(ca, request, options.run);
      await ensureFactoryPrivateFile(secrets, keyFile, () => issued.privateKeyPem);
      await ensureFactoryPrivateFile(secrets, certificateFile, () => issued.certificatePem);
    }
    await ensureFactoryPrivateFile(operator, FACTORY_MESH_OPERATOR_FILES.tokenKey, () => generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const tokenKeyPem = await readFactoryPrivateText(operator, FACTORY_MESH_OPERATOR_FILES.tokenKey);
    await ensureFactoryPrivateFile(secrets, FACTORY_MESH_FILES.tokenPublicKey, () => createPublicKey(createPrivateKey(tokenKeyPem)).export({ type: "spki", format: "pem" }).toString());
    const nowSeconds = Math.floor((options.now ?? Date.now)() / 1_000);
    const token = (subject: string, audience: string, scope: readonly string[]) => () => `${factoryMeshToken({ subject, issuer: identities.issuer, audience, scope, keyPem: tokenKeyPem, nowSeconds })}\n`;
    await ensureFactoryPrivateFile(secrets, FACTORY_MESH_FILES.harnessPoolToken, token(installation.tenantId, FACTORY_POOL_AUDIENCE, [`pool:tenant:${installation.tenantId}`, `pool:grant:${installation.tenantId}:factory`]));
    await ensureFactoryPrivateFile(secrets, FACTORY_MESH_FILES.supervisorPoolToken, token(identities.supervisor, FACTORY_POOL_AUDIENCE, [`pool:supervisor:${identities.supervisor}`]));
    await ensureFactoryPrivateFile(secrets, FACTORY_MESH_FILES.orchestratorToken, token(identities.orchestrator, FACTORY_PRIVATE_SERVICE_AUDIENCE, ["factory:orchestrate"]));
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
    await verifyFactoryMesh(installation, secrets, caPem);
  } finally { await operator.close(); await secrets.close(); }
}

async function verifyFactoryMesh(installation: FactoryInstallationContext, secrets: Parameters<typeof readFactoryPrivateText>[0], caPem: string): Promise<void> {
  const ca = new X509Certificate(caPem);
  const identities = factoryMeshIdentities(installation);
  const expected: ReadonlyArray<readonly [string, string]> = [
    [FACTORY_MESH_FILES.serverCertificate, "CN=localhost"],
    [FACTORY_MESH_FILES.harnessCertificate, `CN=${identities.harness}`],
    [FACTORY_MESH_FILES.orchestratorCertificate, `CN=${identities.orchestrator}`],
    [FACTORY_MESH_FILES.supervisorCertificate, `CN=${identities.supervisor}`],
  ];
  for (const [file, subject] of expected) {
    const certificate = new X509Certificate(await readFactoryPrivateText(secrets, file));
    if (certificate.subject !== subject || !certificate.verify(ca.publicKey)) throw new FactoryProvisioningError("mesh_certificate_invalid", `Mesh certificate ${file} is not ${subject} under this installation's authority.`);
  }
}
