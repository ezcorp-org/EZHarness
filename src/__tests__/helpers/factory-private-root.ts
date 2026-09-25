import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createFactoryCertificateAuthority } from "../../factory/provisioning/certificates";
import { factoryDatabasePairs } from "../../factory/provisioning/database";
import type { FactoryDeploymentSettings } from "../../factory/provisioning/deployment";
import { FACTORY_HOST_FILES, factoryFleetHostIdentity, factoryFleetHostPaths, type FactoryFleetHostFacts } from "../../factory/provisioning/host";
import type { FactoryInstallationContext } from "../../factory/provisioning/installation";

/**
 * A 0700 temp root the private reader accepts. It lives under
 * XDG_RUNTIME_DIR or $HOME, never /tmp: /tmp is a world-writable ancestor,
 * and the private reader refuses it.
 */
export async function makeFactoryPrivateRoot(): Promise<string> {
  const root = await mkdtemp(join(process.env.XDG_RUNTIME_DIR ?? homedir(), "w16-test-"));
  await chmod(root, 0o700);
  return root;
}

export async function removeFactoryPrivateRoot(root: string | undefined): Promise<void> {
  if (root) await rm(root, { recursive: true, force: true });
}

/** Write one file with an explicit mode (chmod after write, so umask cannot widen or narrow it). */
export async function writeModeFile(path: string, content: string | Uint8Array, mode = 0o600): Promise<string> {
  await writeFile(path, content, { mode });
  await chmod(path, mode);
  return path;
}

/** One installation context whose secret and operator directories sit under `root`. */
export function makeFactoryTestInstallation(root: string, overrides: Partial<FactoryInstallationContext> = {}): FactoryInstallationContext {
  const tenantId = overrides.tenantId ?? "tenant-01";
  const fleetId = overrides.fleetId ?? "fleet-a";
  return {
    tenantId,
    hostname: `${tenantId}.factory.example`,
    administratorEmail: "first.admin@example.com",
    fleetId,
    installationId: `inst-${tenantId}`,
    invitationId: `invite-${tenantId}`,
    productDatabase: `factory_product_${tenantId}`,
    productRole: `factory_role_${tenantId}`,
    temporalNamespace: `${tenantId}.${fleetId}`,
    secretDirectory: join(root, "secrets", tenantId),
    operatorDirectory: join(root, "operator", tenantId),
    ...overrides,
  };
}

/** The error `work` rejects with. Fails the test when `work` resolves. */
export async function factoryRejection(work: Promise<unknown>): Promise<Error & { code?: string }> {
  try { await work; }
  catch (error) { return error as Error & { code?: string }; }
  throw new Error("expected a rejection");
}

/** A runner-profile section the startup parser admits. */
export const FACTORY_TEST_RUNNER_PROFILES = Object.freeze({
  brokerAudience: "factory-gateway",
  profiles: [{
    runner: { package: "@ezcorp/minimal", manifestName: "minimal", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, export: "run" },
    resourceClass: "cpu",
    allocation: { resources: { cpu: 1 }, memoryBytes: 1_073_741_824, budget: { costMicros: "1000000", tokens: 1_000, computeMs: 600_000 } },
    allowedCapabilities: [],
  }],
});

export const FACTORY_TEST_IMAGE = `registry.test/ezcorp@sha256:${"b".repeat(64)}`;

/** Deployment settings for an installation whose runtime state lives under `runtimeRoot`. */
/**
 * The fleet host's facts for a test fleet whose runtime root is `runtimeRoot`:
 * its secrets and operator directories sit beside it, under the same private
 * root. `writeFactoryTestHostMaterial` writes the two public files a harness
 * delivery copies from it.
 */
export function makeFactoryTestHostFacts(runtimeRoot: string, portBase = 40_000): FactoryFleetHostFacts {
  const paths = factoryFleetHostPaths("fleet-a", { secretsRoot: join(dirname(runtimeRoot), "host-secrets"), operatorRoot: join(dirname(runtimeRoot), "host-operator"), runtimeRoot });
  return Object.freeze({
    ...factoryFleetHostIdentity("fleet-a", portBase),
    caCertificatePath: join(paths.context.secretDirectory, FACTORY_HOST_FILES.caCertificate),
    hostPublicKeyPath: join(paths.context.secretDirectory, FACTORY_HOST_FILES.hostPublicKey),
    tokenPublicKeyPath: join(paths.context.secretDirectory, FACTORY_HOST_FILES.tokenPublicKey),
    poolReadinessDirectory: join(paths.readinessDirectory, "pool"),
    supervisorReadinessDirectory: join(paths.readinessDirectory, "supervisor"),
  });
}

/** Write the host's authority, stop-receipt public key, and token public key where `facts` names them, as private marker files. */
export async function writeFactoryTestHostMaterial(facts: FactoryFleetHostFacts): Promise<void> {
  const directory = dirname(facts.caCertificatePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeModeFile(facts.caCertificatePath, `marker:${FACTORY_HOST_FILES.caCertificate}\n`);
  await writeModeFile(facts.hostPublicKeyPath, `marker:${FACTORY_HOST_FILES.hostPublicKey}\n`);
  await writeModeFile(facts.tokenPublicKeyPath, `marker:${FACTORY_HOST_FILES.tokenPublicKey}\n`);
}

export function makeFactoryTestDeploymentSettings(runtimeRoot: string, overrides: Partial<FactoryDeploymentSettings> = {}): FactoryDeploymentSettings {
  return {
    network: {
      databaseHost: "127.0.0.1", databasePort: 55432,
      ordinaryEndpoint: "http://127.0.0.1:59000", archiveEndpoint: "http://127.0.0.1:59001",
      temporalAddress: "127.0.0.1:57233", temporalServerName: "temporal.test", temporalHttpEndpoint: "https://127.0.0.1:57244",
      publicOrigin: (installation) => `https://${installation.hostname}:30443`,
      portBase: 40_000,
    },
    image: { reference: FACTORY_TEST_IMAGE, revision: "c".repeat(40) },
    runtimeRoot,
    runnerProfiles: FACTORY_TEST_RUNNER_PROFILES,
    host: makeFactoryTestHostFacts(runtimeRoot),
    interpreterCompatibility: "factory-interpreter-1",
    ...overrides,
  };
}

/** The two database credentials `renderFactoryInstallationBundle` reads, as the database step writes them. */
export async function writeFactoryTestDatabaseCredentials(installation: FactoryInstallationContext): Promise<{ readonly product: string; readonly pool: string }> {
  await mkdir(installation.secretDirectory, { recursive: true, mode: 0o700 });
  await chmod(installation.secretDirectory, 0o700);
  const product = randomBytes(32).toString("base64url");
  const pool = randomBytes(32).toString("base64url");
  const [productPair, poolPair] = factoryDatabasePairs(installation);
  await writeModeFile(join(installation.secretDirectory, productPair!.credentialFile), `${JSON.stringify({ role: productPair!.role, password: product })}\n`);
  await writeModeFile(join(installation.secretDirectory, poolPair!.credentialFile), `${JSON.stringify({ role: poolPair!.role, password: pool })}\n`);
  return { product, pool };
}

/** A real openssl certificate authority written 0600 into `directory` as ca.crt / ca.key. */
export async function makeFactoryTestAuthority(directory: string, subject = "test-authority"): Promise<{ readonly certificatePath: string; readonly keyPath: string; readonly certificatePem: string }> {
  const authority = await createFactoryCertificateAuthority(subject);
  const certificatePath = await writeModeFile(join(directory, "ca.crt"), authority.certificatePem);
  const keyPath = await writeModeFile(join(directory, "ca.key"), authority.privateKeyPem);
  return { certificatePath, keyPath, certificatePem: authority.certificatePem };
}
