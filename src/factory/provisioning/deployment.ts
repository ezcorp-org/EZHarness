/**
 * C12 step 5: the installation's harness, orchestration process, gateway, pool,
 * and supervisor, each given exactly the secrets it needs.
 *
 * This module renders WHAT runs and WHAT each process receives. A deployment
 * target (`compose-profile.ts`, `kubernetes-profile.ts`) decides HOW. The split
 * is what lets one provisioner produce both profiles from one code path, which
 * C12 requires.
 *
 * Scoped delivery is the rule, and it is enforced by construction: each service
 * has its own private delivery directory holding copies of only the files its
 * process reads, and nothing else is mounted into it. So:
 *
 *   - the wrapped data key and the operator master key reach the ORCHESTRATOR
 *     only, as C12 step 5 requires;
 *   - the host signing key reaches the SUPERVISOR only, which C05 makes the one
 *     holder of host identity; the product gets its public half;
 *   - the SUPERVISOR receives no tenant secret: no database credential, no
 *     application secret, no storage key, no attempt-token secret;
 *   - no service receives another installation's anything, because nothing in
 *     a delivery is shared across installations.
 *
 * Every rendered document is parsed by the SAME parser its process runs before
 * it is written, so the provisioner cannot deliver a configuration the process
 * would refuse.
 */
import { resolve } from "node:path";
import { parseFactoryPoolProcessConfig } from "../pool/process";
import { parseFactorySupervisorProcessConfig } from "../runner/supervisor-process";
import { parseFactoryStartupConfig, type FactoryStartupRunnerProfile } from "../startup-config";
import { factoryDatabasePairs, type FactoryDatabaseCredential } from "./database";
import { factoryDeliveryDirectory, type FactoryInstallationContext, type FactoryProvisioningDriver, type FactoryStepResources } from "./installation";
import { FACTORY_BOOTSTRAP_INVITATION_FILE } from "./invitation";
import { FACTORY_INGRESS_PROOF_FILE } from "./ingress";
import { FACTORY_HOST_KEY_ID, FACTORY_MESH_FILES, FACTORY_MESH_TOKEN_KEY_ID, FACTORY_POOL_AUDIENCE, FACTORY_PRIVATE_SERVICE_AUDIENCE, ensureFactoryMesh, factoryMeshIdentities, rotateFactoryMesh } from "./mesh";
import { FACTORY_APPLICATION_SECRET_FILES, FACTORY_KEY_FILES, factoryMasterKeyId } from "./secrets";
import { factoryPrivatePath, openFactoryPrivateDirectory, readFactoryPrivateBytes, readFactoryPrivateJson, removeFactoryPrivateDirectory, removeFactoryPrivateFile, replaceFactoryPrivateFile } from "./secret-files";
import { readdir } from "node:fs/promises";
import { FactoryProvisioningError } from "./steps";
import { factoryTemporalOwnerMarker } from "./temporal";
import type { FactoryInstallationBuilds } from "./fleet-upgrade";

export const FACTORY_CONTAINER_SERVICES = ["pool", "gateway", "harness", "orchestrator"] as const;
export const FACTORY_DEPLOYED_SERVICES = [...FACTORY_CONTAINER_SERVICES, "supervisor"] as const;
export type FactoryDeployedService = typeof FACTORY_DEPLOYED_SERVICES[number];

/** Where things live INSIDE a container. The host supervisor uses host paths instead. */
export const FACTORY_CONTAINER_PATHS = Object.freeze({
  secrets: "/run/ezcorp/secrets",
  readiness: "/run/ezcorp/readiness",
  data: "/var/lib/ezcorp",
  projects: "/var/lib/ezcorp/projects",
});

export interface FactoryInstallationPorts {
  readonly harness: number;
  readonly privateService: number;
  readonly gateway: number;
  readonly pool: number;
  readonly supervisor: number;
}

/** How services reach the fleet's shared infrastructure, as seen from inside a service. */
export interface FactoryDeploymentNetwork {
  readonly databaseHost: string;
  readonly databasePort: number;
  readonly ordinaryEndpoint: string;
  readonly archiveEndpoint: string;
  readonly temporalAddress: string;
  readonly temporalServerName: string;
  /** The public origin a browser uses for this installation, e.g. `https://tenant-01.fleet.test:30443`. */
  readonly publicOrigin: (installation: FactoryInstallationContext) => string;
  readonly portBase: number;
}

export interface FactoryDeploymentImage {
  /** `registry/name@sha256:<digest>`. A tag is refused: the profile is pinned. */
  readonly reference: string;
  /** The source revision the image and the host supervisor were built from. */
  readonly revision: string;
}

export interface FactoryDeploymentSettings {
  readonly network: FactoryDeploymentNetwork;
  readonly image: FactoryDeploymentImage;
  /** Host directory holding each installation's runtime state (readiness, runner root). */
  readonly runtimeRoot: string;
  /** The runner profiles this installation declares: a deployment fact, not a definition fact. */
  readonly runnerProfiles: { readonly brokerAudience: string; readonly profiles: readonly FactoryStartupRunnerProfile[] };
  /** CPU slots this installation's pool offers. */
  readonly cpuCapacity: number;
  readonly interpreterCompatibility: string;
  /**
   * The builds this installation currently runs, per component, once a fleet
   * upgrade has recorded any. Absent, every component runs `image`.
   */
  readonly builds?: (installation: FactoryInstallationContext) => Promise<FactoryInstallationBuilds | undefined>;
}

/** The image each container service runs, and the release the host supervisor runs. */
export interface FactoryServiceImages {
  readonly pool: string;
  readonly gateway: string;
  readonly harness: string;
  readonly orchestrator: string;
  /** The host checkout the supervisor unit runs; absent means the fleet's default release. */
  readonly supervisorRelease?: string;
}

export interface FactoryServiceDelivery {
  readonly service: FactoryDeployedService;
  /** Host path of this service's private delivery directory. */
  readonly directory: string;
  /** File name in the delivery -> host path of its source, or inline document. */
  /** An `optional` source is delivered when it exists: a later step (ingress, invitation) creates it and publishes it itself. */
  readonly files: Readonly<Record<string, { readonly source: string; readonly optional?: boolean } | { readonly document: unknown } | { readonly text: string }>>;
}

/** What stopping and removing an installation needs: names and paths, never a credential. */
export interface FactoryDeploymentHandle {
  readonly installation: FactoryInstallationContext;
  readonly runtimeDirectory: string;
  readonly readinessDirectory: string;
  readonly runnerRoot: string;
}

export function factoryDeploymentHandle(installation: FactoryInstallationContext, runtimeRoot: string): FactoryDeploymentHandle {
  const runtimeDirectory = resolve(runtimeRoot, installation.tenantId);
  return Object.freeze({ installation, runtimeDirectory, readinessDirectory: resolve(runtimeDirectory, "readiness"), runnerRoot: resolve(runtimeDirectory, "runner") });
}

export interface FactoryInstallationBundle extends FactoryDeploymentHandle {
  readonly installation: FactoryInstallationContext;
  readonly ports: FactoryInstallationPorts;
  readonly image: FactoryDeploymentImage;
  readonly images: FactoryServiceImages;
  readonly hostId: string;
  readonly runtimeDirectory: string;
  readonly readinessDirectory: string;
  readonly runnerRoot: string;
  /** The harness's writable data directory, owned by the installation's uid. */
  readonly dataDirectory: string;
  readonly deliveries: Readonly<Record<FactoryDeployedService, FactoryServiceDelivery>>;
  /** Non-secret environment per container service. Secrets arrive through the delivery only. */
  readonly environment: Readonly<Record<(typeof FACTORY_CONTAINER_SERVICES)[number], Readonly<Record<string, string>>>>;
  readonly publicOrigin: string;
}

/** Runs a bundle somewhere. The Compose target and the Kubernetes renderer implement it. */
export interface FactoryDeploymentTarget {
  readonly profile: "compose" | "kubernetes";
  apply(bundle: FactoryInstallationBundle): Promise<FactoryStepResources>;
  /** Resolves only when every service reports ready; throws with the first service that did not. */
  ready(bundle: FactoryInstallationBundle): Promise<void>;
  /** Stop and remove every service this installation runs. Idempotent. Needs no credential. Data is kept until `purge`. */
  remove(handle: FactoryDeploymentHandle): Promise<void>;
  purge(handle: FactoryDeploymentHandle): Promise<void>;
}

const TENANT_NUMBER = /^tenant-(\d{2})$/;

export function factoryInstallationPorts(tenantId: string, portBase: number): FactoryInstallationPorts {
  const match = TENANT_NUMBER.exec(tenantId);
  if (!match || !Number.isSafeInteger(portBase) || portBase < 1_024 || portBase + 100 * 10 > 65_535) throw new FactoryProvisioningError("deployment_ports_invalid", "Installation ports cannot be derived.");
  const base = portBase + Number(match[1]) * 10;
  return Object.freeze({ harness: base, privateService: base + 1, gateway: base + 2, pool: base + 3, supervisor: base + 4 });
}

function databaseUrl(network: FactoryDeploymentNetwork, database: string, credential: FactoryDatabaseCredential): string {
  const url = new URL("postgres://placeholder");
  url.hostname = network.databaseHost; url.port = String(network.databasePort); url.pathname = `/${database}`;
  url.username = credential.role; url.password = credential.password;
  return url.toString();
}

const secretPath = (name: string) => `${FACTORY_CONTAINER_PATHS.secrets}/${name}`;
/** Each readiness writer has its own directory, so no process can overwrite another's record. */
const readinessPath = (writer: "pool" | "orchestration" | "supervisor") => `${FACTORY_CONTAINER_PATHS.readiness}/${writer}/${writer}.json`;

/**
 * Render the whole installation: documents, deliveries, environment.
 *
 * Pure apart from reading the two database credentials, which it needs to
 * build the URLs the pool and the harness connect with.
 */
export async function renderFactoryInstallationBundle(installation: FactoryInstallationContext, settings: FactoryDeploymentSettings): Promise<FactoryInstallationBundle> {
  if (!/^[^@\s]+@sha256:[a-f0-9]{64}$/.test(settings.image.reference)) throw new FactoryProvisioningError("deployment_image_unpinned", "The deployment image must be pinned by digest.");
  const ports = factoryInstallationPorts(installation.tenantId, settings.network.portBase);
  const identities = factoryMeshIdentities(installation);
  const { runtimeDirectory, readinessDirectory, runnerRoot } = factoryDeploymentHandle(installation, settings.runtimeRoot);
  const dataDirectory = resolve(runtimeDirectory, "harness-data");
  const source = (name: string) => ({ source: factoryPrivatePath(installation.secretDirectory, name) });
  const [productPair, poolPair] = factoryDatabasePairs(installation);
  const secrets = await openFactoryPrivateDirectory(installation.secretDirectory);
  let productCredential: FactoryDatabaseCredential, poolCredential: FactoryDatabaseCredential;
  try {
    productCredential = await readFactoryPrivateJson<FactoryDatabaseCredential>(secrets, productPair!.credentialFile);
    poolCredential = await readFactoryPrivateJson<FactoryDatabaseCredential>(secrets, poolPair!.credentialFile);
  } finally { await secrets.close(); }
  const clientTls = (certificate: string, key: string) => ({ caPath: secretPath(FACTORY_MESH_FILES.caCertificate), certificatePath: secretPath(certificate), privateKeyPath: secretPath(key) });
  const serverTls = clientTls(FACTORY_MESH_FILES.serverCertificate, FACTORY_MESH_FILES.serverKey);
  const harnessTls = clientTls(FACTORY_MESH_FILES.harnessCertificate, FACTORY_MESH_FILES.harnessKey);
  const poolId = `pool.${installation.tenantId}`;
  const masterKeyId = factoryMasterKeyId(installation);

  const startup = parseFactoryStartupConfig({
    schemaVersion: "factory.startup.v1",
    installationId: installation.installationId, tenantId: installation.tenantId, poolId, hostId: identities.hostId,
    temporalNamespace: installation.temporalNamespace,
    orphanSweepIntervalMs: 30_000,
    orchestrationReadinessFilePath: readinessPath("orchestration"),
    poolReadinessFilePath: readinessPath("pool"),
    supervisorReadinessFilePath: readinessPath("supervisor"),
    readinessHeartbeatMs: 5_000,
    readinessRetry: { delayMs: 2_000, windowMs: 300_000 },
    gateway: { hostname: "127.0.0.1", port: ports.gateway, tls: harnessTls },
    privateService: {
      hostname: "0.0.0.0", port: ports.privateService, certificateIdentity: identities.orchestrator, tls: serverTls,
      tokens: { issuer: identities.issuer, audience: FACTORY_PRIVATE_SERVICE_AUDIENCE, publicKeyPaths: { [FACTORY_MESH_TOKEN_KEY_ID]: secretPath(FACTORY_MESH_FILES.tokenPublicKey) } },
    },
    pool: { baseUrl: `https://127.0.0.1:${ports.pool}`, serviceTokenPath: secretPath(FACTORY_MESH_FILES.harnessPoolToken), tls: harnessTls },
    hostLaunch: {
      baseUrl: `https://127.0.0.1:${ports.supervisor}`, serverName: "localhost",
      attemptTokenSecretPath: secretPath(FACTORY_MESH_FILES.attemptTokenSecret),
      tls: { ...harnessTls, serviceTokenPath: secretPath(FACTORY_MESH_FILES.harnessPoolToken) },
    },
    hostStopKeys: [{ hostId: identities.hostId, hostKeyId: FACTORY_HOST_KEY_ID, publicKeyPath: secretPath(FACTORY_MESH_FILES.hostPublicKey) }],
    runnerProfiles: settings.runnerProfiles,
    storage: {
      ordinary: { endpoint: settings.network.ordinaryEndpoint, bucket: installation.tenantId, prefix: "ordinary", credentialSet: "ordinary", credentialsPath: secretPath("ordinary-storage.json") },
      archive: { endpoint: settings.network.archiveEndpoint, bucket: installation.tenantId, prefix: "archive", credentialSet: "archive", credentialsPath: secretPath("archive-storage.json") },
    },
    // The harness is told WHERE the orchestrator's key material lives so the
    // boot check can prove it sits outside every grantable root. The file
    // itself is never mounted into the harness.
    keys: { masterKeyFilePath: `/run/ezcorp/orchestrator-only/${FACTORY_KEY_FILES.master}`, masterKeyId, wrappedKeyFilePath: `/run/ezcorp/orchestrator-only/${FACTORY_KEY_FILES.wraps}`, grantableRoots: [FACTORY_CONTAINER_PATHS.projects] },
    workers: { idleDelayMs: 1_000, batch: 4 },
  });

  const orchestrator = {
    schemaVersion: "factory.orchestrator-process.v1",
    installationId: installation.installationId, tenantId: installation.tenantId,
    temporal: {
      address: settings.network.temporalAddress, namespace: installation.temporalNamespace, serverName: settings.network.temporalServerName,
      caPath: secretPath("temporal-ca.crt"), certificatePath: secretPath("temporal-client.crt"), privateKeyPath: secretPath("temporal-client.key"), apiKeyPath: secretPath("temporal-token"),
    },
    gateway: {
      baseUrl: `https://127.0.0.1:${ports.privateService}`, serverName: "localhost",
      tls: { ...clientTls(FACTORY_MESH_FILES.orchestratorCertificate, FACTORY_MESH_FILES.orchestratorKey), serviceTokenPath: secretPath(FACTORY_MESH_FILES.orchestratorToken) },
    },
    codec: { wrappedKeyFilePath: secretPath(FACTORY_KEY_FILES.wraps), masterKeyFilePath: secretPath(FACTORY_KEY_FILES.master), masterKeyId, grantableRoots: [FACTORY_CONTAINER_PATHS.projects] },
    readinessFilePath: readinessPath("orchestration"), readinessHeartbeatMs: 5_000,
  };

  const pool = parseFactoryPoolProcessConfig({
    schemaVersion: "factory.pool-process.v1", installationId: installation.installationId, poolId,
    hostname: "0.0.0.0", port: ports.pool,
    database: { credentialsPath: secretPath("pool-database.json"), expectedDatabase: poolPair!.database, expectedRole: poolPair!.role },
    tls: { privateKeyPath: serverTls.privateKeyPath, certificatePath: serverTls.certificatePath, caPath: serverTls.caPath },
    tokens: { issuer: identities.issuer, audience: FACTORY_POOL_AUDIENCE, publicKeyPaths: { [FACTORY_MESH_TOKEN_KEY_ID]: secretPath(FACTORY_MESH_FILES.tokenPublicKey) } },
    identities: {
      tenants: { [identities.harness]: { tenantId: installation.tenantId, tokenSubject: installation.tenantId } },
      supervisors: { [identities.supervisor]: { supervisorId: identities.supervisor, tokenSubject: identities.supervisor, hostIds: [identities.hostId] } },
    },
    resources: { capacities: { cpu: settings.cpuCapacity }, gpuHosts: [], hosts: [identities.hostId] },
    // Heartbeats sized for ten installations on one host: each supervisor beat
    // probes the container runtime, and the product tolerates a record up to
    // several of its own 5 s heartbeats old.
    readinessFilePath: readinessPath("pool"), readinessHeartbeatMs: 4_000,
  });

  const supervisorDirectory = factoryDeliveryDirectory(installation, "supervisor");
  const hostSecret = (name: string) => resolve(supervisorDirectory, name);
  const supervisor = parseFactorySupervisorProcessConfig({
    schemaVersion: "factory.supervisor-process.v1", installationId: installation.installationId, hostId: identities.hostId,
    hostKeyPath: hostSecret(FACTORY_MESH_FILES.hostKey), hostKeyId: FACTORY_HOST_KEY_ID,
    runnerRoot, readinessFilePath: resolve(readinessDirectory, "supervisor", "supervisor.json"), readinessHeartbeatMs: 4_000,
    services: {
      hostname: "127.0.0.1", port: ports.supervisor, allowedPeers: [identities.harness],
      hostKeyIdPath: hostSecret(FACTORY_MESH_FILES.hostKeyId),
      tls: { caPath: hostSecret(FACTORY_MESH_FILES.caCertificate), certificatePath: hostSecret(FACTORY_MESH_FILES.serverCertificate), privateKeyPath: hostSecret(FACTORY_MESH_FILES.serverKey) },
      pool: {
        baseUrl: `https://127.0.0.1:${ports.pool}`, serviceTokenPath: hostSecret(FACTORY_MESH_FILES.supervisorPoolToken),
        tls: { caPath: hostSecret(FACTORY_MESH_FILES.caCertificate), certificatePath: hostSecret(FACTORY_MESH_FILES.supervisorCertificate), privateKeyPath: hostSecret(FACTORY_MESH_FILES.supervisorKey) },
      },
    },
  });

  const gateway = {
    schemaVersion: "factory.gateway-process.v1", installationId: installation.installationId, tenantId: installation.tenantId,
    hostname: "0.0.0.0", port: ports.gateway,
    tls: serverTls,
    attemptTokenSecretPath: secretPath(FACTORY_MESH_FILES.attemptTokenSecret),
    databaseUrlPath: secretPath("gateway-database-url"),
    interpreterCompatibility: settings.interpreterCompatibility,
  };

  const mesh = (...names: string[]) => Object.fromEntries(names.map((name) => [name, source(name)]));
  const deliveries: Record<FactoryDeployedService, FactoryServiceDelivery> = {
    pool: { service: "pool", directory: factoryDeliveryDirectory(installation, "pool"), files: {
      ...mesh(FACTORY_MESH_FILES.caCertificate, FACTORY_MESH_FILES.serverCertificate, FACTORY_MESH_FILES.serverKey, FACTORY_MESH_FILES.tokenPublicKey),
      "pool-database.json": { document: { databaseUrl: databaseUrl(settings.network, poolPair!.database, poolCredential) } },
      "pool.json": { document: pool },
    } },
    gateway: { service: "gateway", directory: factoryDeliveryDirectory(installation, "gateway"), files: {
      ...mesh(FACTORY_MESH_FILES.caCertificate, FACTORY_MESH_FILES.serverCertificate, FACTORY_MESH_FILES.serverKey, FACTORY_MESH_FILES.attemptTokenSecret),
      "gateway-database-url": { text: `${databaseUrl(settings.network, productPair!.database, productCredential)}\n` },
      "gateway.json": { document: gateway },
    } },
    harness: { service: "harness", directory: factoryDeliveryDirectory(installation, "harness"), files: {
      ...mesh(FACTORY_MESH_FILES.caCertificate, FACTORY_MESH_FILES.serverCertificate, FACTORY_MESH_FILES.serverKey, FACTORY_MESH_FILES.harnessCertificate, FACTORY_MESH_FILES.harnessKey,
        FACTORY_MESH_FILES.tokenPublicKey, FACTORY_MESH_FILES.harnessPoolToken, FACTORY_MESH_FILES.attemptTokenSecret, FACTORY_MESH_FILES.hostPublicKey,
        FACTORY_APPLICATION_SECRET_FILES.jwt, FACTORY_APPLICATION_SECRET_FILES.encryption, FACTORY_APPLICATION_SECRET_FILES.salt,
        "ordinary-storage.json", "archive-storage.json"),
      // Created by steps 6 and 7, which publish them into this delivery themselves.
      [FACTORY_BOOTSTRAP_INVITATION_FILE]: { ...source(FACTORY_BOOTSTRAP_INVITATION_FILE), optional: true },
      [FACTORY_INGRESS_PROOF_FILE]: { ...source(FACTORY_INGRESS_PROOF_FILE), optional: true },
      "harness-database-url": { text: `${databaseUrl(settings.network, productPair!.database, productCredential)}\n` },
      "factory-startup.json": { document: startup },
      "secret-env.json": { document: { schemaVersion: "factory.secret-env.v1", variables: {
        DATABASE_URL: secretPath("harness-database-url"),
        EZCORP_JWT_SECRET: secretPath(FACTORY_APPLICATION_SECRET_FILES.jwt),
        EZCORP_ENCRYPTION_SECRET: secretPath(FACTORY_APPLICATION_SECRET_FILES.encryption),
        EZCORP_ENCRYPTION_SALT: secretPath(FACTORY_APPLICATION_SECRET_FILES.salt),
      } } },
    } },
    orchestrator: { service: "orchestrator", directory: factoryDeliveryDirectory(installation, "orchestrator"), files: {
      ...mesh(FACTORY_MESH_FILES.caCertificate, FACTORY_MESH_FILES.orchestratorCertificate, FACTORY_MESH_FILES.orchestratorKey, FACTORY_MESH_FILES.orchestratorToken,
        "temporal-ca.crt", "temporal-client.crt", "temporal-client.key", "temporal-token", FACTORY_KEY_FILES.wraps),
      [FACTORY_KEY_FILES.master]: { source: factoryPrivatePath(installation.operatorDirectory, FACTORY_KEY_FILES.master) },
      "orchestrator.json": { document: orchestrator },
    } },
    supervisor: { service: "supervisor", directory: supervisorDirectory, files: {
      ...mesh(FACTORY_MESH_FILES.caCertificate, FACTORY_MESH_FILES.serverCertificate, FACTORY_MESH_FILES.serverKey, FACTORY_MESH_FILES.supervisorCertificate, FACTORY_MESH_FILES.supervisorKey,
        FACTORY_MESH_FILES.supervisorPoolToken, FACTORY_MESH_FILES.hostKey, FACTORY_MESH_FILES.hostKeyId),
      "supervisor.json": { document: supervisor },
    } },
  };

  const publicOrigin = settings.network.publicOrigin(installation);
  const builds = await settings.builds?.(installation);
  const images: FactoryServiceImages = Object.freeze({
    pool: builds?.host.image ?? settings.image.reference,
    gateway: builds?.harness.image ?? settings.image.reference,
    harness: builds?.harness.image ?? settings.image.reference,
    orchestrator: builds?.orchestrator.image ?? settings.image.reference,
    ...(builds ? { supervisorRelease: builds.host.releaseDirectory } : {}),
  });
  const environment = {
    pool: { HOME: "/tmp" },
    gateway: { HOME: "/tmp" },
    orchestrator: { HOME: "/tmp" },
    harness: {
      PORT: String(ports.harness), HOST: "0.0.0.0", ORIGIN: publicOrigin,
      HOME: `${FACTORY_CONTAINER_PATHS.data}/home`,
      EZCORP_FACTORY_ENABLED: "1",
      EZCORP_INSTALLATION_ID: installation.installationId,
      EZCORP_INSTALLATION_HOSTNAME: installation.hostname,
      EZCORP_FACTORY_STARTUP_CONFIG: secretPath("factory-startup.json"),
      EZCORP_FACTORY_BOOTSTRAP_INVITATION: secretPath(FACTORY_BOOTSTRAP_INVITATION_FILE),
      EZCORP_INGRESS_PROOF_FILE: secretPath(FACTORY_INGRESS_PROOF_FILE),
      EZCORP_SECRETS_DIR: FACTORY_CONTAINER_PATHS.secrets,
      EZCORP_PROJECT_ROOT: FACTORY_CONTAINER_PATHS.projects,
      EZCORP_DB_PATH: `${FACTORY_CONTAINER_PATHS.data}/data/ezcorp`,
      EZCORP_FACTORY_INTERPRETER_COMPATIBILITY: settings.interpreterCompatibility,
      EZCORP_PERM_SWEEP_INTERVAL_MS: String(startup.orphanSweepIntervalMs),
    },
  };
  return Object.freeze({ installation, ports, image: settings.image, images, hostId: identities.hostId, runtimeDirectory, readinessDirectory, runnerRoot, dataDirectory, deliveries, environment, publicOrigin });
}

/**
 * Write every delivery directory: private, and holding only its listed files.
 *
 * Updated IN PLACE, never recreated: a running container's bind mount pins the
 * directory's inode, so a recreated directory would leave the service reading
 * an empty ghost. Each file is replaced atomically, and a file no longer listed
 * is removed, so a delivery never lingers with something it should not hold.
 */
export async function writeFactoryDeliveries(bundle: FactoryInstallationBundle): Promise<void> {
  for (const delivery of Object.values(bundle.deliveries)) {
    const directory = await openFactoryPrivateDirectory(delivery.directory);
    try {
      const kept = new Set<string>();
      for (const [name, entry] of Object.entries(delivery.files)) {
        let bytes: Uint8Array | undefined;
        if ("source" in entry) {
          const parent = await openFactoryPrivateDirectory(resolve(entry.source, ".."));
          try { bytes = await readFactoryPrivateBytes(parent, entry.source.slice(entry.source.lastIndexOf("/") + 1)); }
          catch (error) { if (!entry.optional || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          finally { await parent.close(); }
        } else if ("document" in entry) bytes = new TextEncoder().encode(`${JSON.stringify(entry.document, null, 2)}\n`);
        else bytes = new TextEncoder().encode(entry.text);
        if (bytes === undefined) continue;
        await replaceFactoryPrivateFile(factoryPrivatePath(delivery.directory, name), bytes);
        kept.add(name);
      }
      for (const name of await readdir(delivery.directory)) if (!kept.has(name)) await removeFactoryPrivateFile(directory, name);
    } finally { await directory.close(); }
  }
  for (const directory of [bundle.runtimeDirectory, bundle.readinessDirectory, ...["pool", "orchestration", "supervisor"].map((writer) => resolve(bundle.readinessDirectory, writer)), bundle.runnerRoot, bundle.dataDirectory]) {
    const handle = await openFactoryPrivateDirectory(directory);
    await handle.close();
  }
}

export interface FactoryDeploymentStepOptions {
  readonly settings: FactoryDeploymentSettings;
  readonly target: FactoryDeploymentTarget;
  readonly mesh?: Parameters<typeof ensureFactoryMesh>[1];
}

export class FactoryDeploymentStep implements FactoryProvisioningDriver {
  readonly step = "deployment" as const;
  constructor(private readonly options: FactoryDeploymentStepOptions) {}

  bundle(installation: FactoryInstallationContext): Promise<FactoryInstallationBundle> {
    return renderFactoryInstallationBundle(installation, this.options.settings);
  }

  async ensure(installation: FactoryInstallationContext): Promise<FactoryStepResources> {
    const mesh = await ensureFactoryMesh(installation, this.options.mesh);
    const bundle = await this.bundle(installation);
    await writeFactoryDeliveries(bundle);
    const applied = await this.options.target.apply(bundle);
    await this.options.target.ready(bundle);
    return Object.freeze({
      ...applied,
      profile: this.options.target.profile,
      image: bundle.image.reference,
      revision: bundle.image.revision,
      hostId: bundle.hostId,
      temporalOwner: factoryTemporalOwnerMarker(installation),
      harnessPort: String(bundle.ports.harness),
      publicOrigin: bundle.publicOrigin,
      runtimeDirectory: bundle.runtimeDirectory,
      meshTokensExpireAtMs: String(mesh.tokensExpireAtMs),
    });
  }

  async verify(installation: FactoryInstallationContext): Promise<void> {
    await this.options.target.ready(await this.bundle(installation));
  }

  private handle(installation: FactoryInstallationContext): FactoryDeploymentHandle {
    return factoryDeploymentHandle(installation, this.options.settings.runtimeRoot);
  }

  /** Stop every service and destroy every delivery. Needs no credential, so a damaged installation still stops. Data stays until purge. */
  async teardown(installation: FactoryInstallationContext): Promise<void> {
    await this.options.target.remove(this.handle(installation));
    await removeFactoryPrivateDirectory(resolve(installation.secretDirectory, "deliver"));
  }

  /** Re-deliver after another step rotated a credential, and restart onto it. */
  async redeliver(installation: FactoryInstallationContext): Promise<void> {
    const bundle = await this.bundle(installation);
    await writeFactoryDeliveries(bundle);
    await this.options.target.remove(bundle);
    await this.options.target.apply(bundle);
    await this.options.target.ready(bundle);
  }

  /**
   * Rotate the installation's own mesh: new service tokens and leaf
   * certificates under its mesh authority. Service tokens expire, so this is
   * the scheduled rotation `status` shows the deadline for.
   */
  async rotate(installation: FactoryInstallationContext, resources: FactoryStepResources): Promise<FactoryStepResources> {
    const minted = await rotateFactoryMesh(installation, this.options.mesh);
    await this.redeliver(installation);
    return Object.freeze({ ...resources, meshTokensExpireAtMs: String(minted.tokensExpireAtMs) });
  }

  async purge(installation: FactoryInstallationContext): Promise<void> {
    await this.options.target.purge(this.handle(installation));
  }
}
