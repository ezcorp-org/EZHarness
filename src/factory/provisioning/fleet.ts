/**
 * One fleet's settings, and the composition of every provisioning driver from
 * them.
 *
 * The settings document carries REFERENCES only, in the idiom of the startup
 * document: roots, ports, endpoints, the pinned image, and the PATHS of the two
 * operator credentials (the control database URL and the product cluster's
 * admin URL). Nothing here is a secret, so the document itself can be kept in
 * version control by an operator.
 *
 * Both deployment profiles compose through `composeFactoryProvisioner`, which
 * is what makes C12's "one code path" literal: the only difference between the
 * self-hosted and hosted provisioner is the deployment target passed in.
 */
import { resolve } from "node:path";
import { parseFactoryStartupConfig, type FactoryStartupConfig, type FactoryStartupRunnerProfile } from "../startup-config";
import { openBunSql } from "../../db/bun-sql-pipelining";
import { factorySpawnExecutor, type FactoryCommandExecutor, type FactoryComposeCommand } from "./compose-profile";
import { factoryFleetProfile } from "./fleet-profile";
import { FactoryFleetUpgrades, FactoryProfileUpgradeTarget, type FactoryBuild } from "./fleet-upgrade";
import { FactoryDatabaseStep } from "./database";
import { FactoryDeploymentStep, factoryDeploymentHandle, factoryInstallationReleaseBlock, type FactoryDeploymentRelease, type FactoryDeploymentSettings, type FactoryDeploymentTarget } from "./deployment";
import { FactoryFleetHost, type FactoryFleetHostRuntime } from "./host";
import { FactoryIngressStep, factoryHttpsIngressProbe } from "./ingress";
import type { FactoryInstallationContext } from "./installation";
import { FactoryInvitationStep } from "./invitation";
import { LocalFactoryProvisioner } from "./local";
import { ensureFactoryPlatformMaterial, factoryPlatformPaths, stopFactoryPlatform, type FactoryPlatformPaths, type FactoryPlatformSettings } from "./platform";
import { readFactoryPrivatePath } from "./secret-files";
import { FactorySecretsStep } from "./secrets";
import { FactorySeededStorageIssuer, FactoryStorageStep, factoryDatabaseStorageClaims, factoryS3ScopeProbe, type FactoryStorageCredentialIssuer } from "./storage";
import { FactoryProvisioningError, type FactoryInstallationPhase } from "./steps";
import { FactoryTemporalStep, factoryTemporalCertificateIssuer } from "./temporal";
import { factoryTemporalAccessProbe, factoryTemporalNamespaceAdmin } from "./temporal-client";
import { factoryImagePinned } from "./image-pin";

export const FACTORY_FLEET_SCHEMA = "factory.fleet.v1";

export interface FactoryFleetStorageDomain {
  readonly endpoint: string;
  readonly prefix: string;
  readonly issuer: { readonly kind: "seeded"; readonly serverIdentityPath: string };
}

/**
 * The fleet's attempt resource profile (C12 "Attempt resource profiles"). The
 * pool is shared by the fleet, so every installation inherits this profile.
 * Under `gpu`, the fleet host is the one GPU host the pool offers, and the
 * private profile file declares its devices (`gpu-host-profiles.ts`).
 */
export type FactoryFleetResources =
  | { readonly profile: "cpu-only"; readonly cpuCapacity: number }
  | { readonly profile: "gpu"; readonly cpuCapacity: number; readonly gpuProfilesPath: string };

/**
 * The hosted profile's cluster (C12 rows "Kubernetes deployment target" and
 * "Shared-service readiness and address", W4H-35). The cluster is named by a
 * private kubeconfig file, never by its content. `services` is how a pod sees
 * the fleet's database, stores and Temporal; the provisioner itself keeps using
 * the fleet's own addresses.
 */
export interface FactoryFleetKubernetes {
  readonly kubectl: string;
  readonly kubeconfigPath: string;
  readonly systemNamespace: string;
  readonly runAsUser: number;
  readonly runtimeSocketPath: string;
  /** Where the supervisor DaemonSet runs; under a `gpu` resource profile, the GPU nodes, so it may not be empty. */
  readonly nodeSelector: Readonly<Record<string, string>>;
  readonly ingress: { readonly listenPort: number; readonly nodePort: number };
  readonly egressCidrs: readonly string[];
  readonly egressPorts: readonly number[];
  readonly services: {
    readonly databaseHost: string; readonly databasePort: number;
    readonly ordinaryEndpoint: string; readonly archiveEndpoint: string;
    readonly temporalAddress: string; readonly temporalHttpEndpoint: string;
  };
}

export interface FactoryFleetSettings {
  readonly schemaVersion: typeof FACTORY_FLEET_SCHEMA;
  readonly fleetId: string;
  readonly profile: "compose" | "kubernetes";
  /** Present exactly when `profile` is `kubernetes`. */
  readonly kubernetes?: FactoryFleetKubernetes;
  readonly roots: { readonly operator: string; readonly secrets: string; readonly runtime: string };
  readonly control: { readonly databaseUrlPath: string };
  readonly database: { readonly adminUrlPath: string; readonly serviceHost: string; readonly servicePort: number };
  readonly storage: { readonly ordinary: FactoryFleetStorageDomain; readonly archive: FactoryFleetStorageDomain; readonly failureDomain: string };
  /** `port`: the gateway's gRPC route; `httpPort`: its read-only HTTP route for W15's checkpoint barrier. */
  readonly temporal: { readonly port: number; readonly httpPort: number; readonly serverName: string };
  readonly ingress: { readonly address: string; readonly port: number; readonly domain: string };
  readonly resources: FactoryFleetResources;
  readonly installations: {
    readonly portBase: number;
    readonly interpreterCompatibility: string;
    readonly runnerProfiles: { readonly brokerAudience: string; readonly profiles: readonly FactoryStartupRunnerProfile[] };
    /** Where every installation may release; the deployer writes it into each startup document. */
    readonly release?: FactoryDeploymentRelease;
    /** Every installation's pinned model (W4H-28); a pinned runner profile must name it. */
    readonly modelProvider?: FactoryStartupConfig["modelProvider"];
  };
  readonly image: { readonly reference: string; readonly revision: string };
  readonly release: { readonly directory: string; readonly bun: string; readonly path: string };
}

function absolute(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4_096 && resolve(value) === value; }
function port(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1_024 && (value as number) <= 65_535; }
function url(value: unknown): value is string { try { return typeof value === "string" && ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } }
function keys(value: unknown, expected: string): boolean { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).sort().join(",") === expected; }

function storageDomainValid(entry: FactoryFleetStorageDomain | undefined): boolean {
  return keys(entry, "endpoint,issuer,prefix") && url(entry!.endpoint) && /^[a-z][a-z0-9-]{0,62}$/.test(entry!.prefix)
    && keys(entry!.issuer, "kind,serverIdentityPath") && entry!.issuer.kind === "seeded" && absolute(entry!.issuer.serverIdentityPath);
}

const NAMESPACE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CIDR = /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
function servicesValid(value: unknown): boolean {
  const services = value as FactoryFleetKubernetes["services"];
  return keys(value, "archiveEndpoint,databaseHost,databasePort,ordinaryEndpoint,temporalAddress,temporalHttpEndpoint") && typeof services.databaseHost === "string" && services.databaseHost.length > 0
    && port(services.databasePort) && url(services.ordinaryEndpoint) && url(services.archiveEndpoint) && /^[A-Za-z0-9.-]+:\d{2,5}$/.test(services.temporalAddress) && url(services.temporalHttpEndpoint);
}

/** Present exactly for the hosted profile, every field well formed; a GPU fleet names the nodes its supervisor runs on. */
function kubernetesValid({ profile, kubernetes, resources }: FactoryFleetSettings): boolean {
  if (profile !== "kubernetes") return kubernetes === undefined;
  const k = kubernetes as FactoryFleetKubernetes | undefined;
  const nodeSelector = k?.nodeSelector as unknown;
  return keys(k, "egressCidrs,egressPorts,ingress,kubeconfigPath,kubectl,nodeSelector,runAsUser,runtimeSocketPath,services,systemNamespace")
    && absolute(k!.kubectl) && absolute(k!.kubeconfigPath) && absolute(k!.runtimeSocketPath) && NAMESPACE.test(k!.systemNamespace)
    && Number.isSafeInteger(k!.runAsUser) && k!.runAsUser > 0
    && typeof nodeSelector === "object" && nodeSelector !== null && !Array.isArray(nodeSelector) && Object.values(nodeSelector).every((value) => typeof value === "string")
    && (resources?.profile !== "gpu" || Object.keys(nodeSelector).length > 0)
    && keys(k!.ingress, "listenPort,nodePort") && port(k!.ingress.listenPort) && Number.isSafeInteger(k!.ingress.nodePort) && k!.ingress.nodePort >= 30_000 && k!.ingress.nodePort <= 32_767
    && Array.isArray(k!.egressCidrs) && k!.egressCidrs.every((cidr) => typeof cidr === "string" && CIDR.test(cidr))
    && Array.isArray(k!.egressPorts) && k!.egressPorts.every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 65_535)
    && servicesValid(k!.services);
}

/** A runner profile that asks for a whole GPU host. */
function asksForGpuHost(profile: unknown): boolean {
  const resources = (profile as { allocation?: { resources?: unknown } } | null)?.allocation?.resources;
  return typeof resources === "object" && resources !== null && Object.hasOwn(resources, "gpu-host");
}

/** The profile's own shape, and under `cpu-only` no runner profile that asks for a GPU host. */
function resourcesValid({ resources, installations }: FactoryFleetSettings): boolean {
  const capacity = Number.isSafeInteger(resources?.cpuCapacity) && resources.cpuCapacity > 0;
  if (resources?.profile === "gpu") return keys(resources, "cpuCapacity,gpuProfilesPath,profile") && capacity && absolute(resources.gpuProfilesPath);
  const profiles = (installations as { runnerProfiles?: { profiles?: unknown } } | undefined)?.runnerProfiles?.profiles;
  return keys(resources, "cpuCapacity,profile") && resources.profile === "cpu-only" && capacity && !(Array.isArray(profiles) && profiles.some(asksForGpuHost));
}

/** Each field after the document's own shape, in the order an operator reads the error. */
const FLEET_FIELD_CHECKS: readonly (readonly [string, (settings: FactoryFleetSettings) => boolean])[] = [
  ["fleetId", (settings) => typeof settings.fleetId === "string" && /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(settings.fleetId)],
  ["profile", (settings) => settings.profile === "compose" || settings.profile === "kubernetes"],
  ["kubernetes", (settings) => kubernetesValid(settings)],
  ["roots", ({ roots }) => keys(roots, "operator,runtime,secrets") && absolute(roots.operator) && absolute(roots.secrets) && absolute(roots.runtime)],
  ["control", ({ control }) => keys(control, "databaseUrlPath") && absolute(control.databaseUrlPath)],
  ["database", ({ database }) => keys(database, "adminUrlPath,serviceHost,servicePort") && absolute(database.adminUrlPath) && typeof database.serviceHost === "string" && port(database.servicePort)],
  ["storage.ordinary", (settings) => storageDomainValid(settings.storage?.ordinary)],
  ["storage.archive", (settings) => storageDomainValid(settings.storage?.archive)],
  ["storage", ({ storage }) => keys(storage, "archive,failureDomain,ordinary") && typeof storage.failureDomain === "string" && storage.failureDomain.length > 0],
  ["temporal", ({ temporal }) => keys(temporal, "httpPort,port,serverName") && port(temporal.port) && port(temporal.httpPort) && temporal.httpPort !== temporal.port && typeof temporal.serverName === "string"],
  ["ingress", ({ ingress }) => keys(ingress, "address,domain,port") && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ingress.address) && port(ingress.port) && /^[a-z0-9.-]{1,200}$/.test(ingress.domain)],
  ["resources", (settings) => resourcesValid(settings)],
  ["installations", ({ installations }) => installationKeys(installations) && port(installations.portBase)
    && typeof installations.interpreterCompatibility === "string"],
  ["image", ({ image }) => keys(image, "reference,revision") && factoryImagePinned(image.reference) && /^[a-f0-9]{40}$/.test(image.revision)],
  ["release", ({ release }) => keys(release, "bun,directory,path") && absolute(release.directory) && absolute(release.bun) && typeof release.path === "string"],
];

/** The installation keys: the four every fleet declares, and the optional release block and model pin. */
function installationKeys(installations: unknown): boolean {
  if (!installations || typeof installations !== "object" || Array.isArray(installations)) return false;
  const present = Object.keys(installations);
  const required = ["interpreterCompatibility", "portBase", "runnerProfiles"];
  return required.every((key) => present.includes(key)) && present.every((key) => required.includes(key) || key === "release" || key === "modelProvider");
}

function fleetSettingsInvalid(invalid: readonly string[]): FactoryProvisioningError {
  return new FactoryProvisioningError("fleet_settings_invalid", `Fleet settings are invalid: ${invalid.join(", ")}.`);
}

/**
 * Validate the whole document and name every bad field at once, in the startup
 * document's style: an operator with three mistakes fixes three things once.
 */
export function parseFactoryFleetSettings(value: unknown): FactoryFleetSettings {
  const settings = value as FactoryFleetSettings;
  const fields = "control,database,fleetId,image,ingress,installations,profile,release,resources,roots,schemaVersion,storage,temporal";
  const withKubernetes = "control,database,fleetId,image,ingress,installations,kubernetes,profile,release,resources,roots,schemaVersion,storage,temporal";
  if ((!keys(value, fields) && !keys(value, withKubernetes)) || settings.schemaVersion !== FACTORY_FLEET_SCHEMA) throw fleetSettingsInvalid(["document"]);
  const invalid = FLEET_FIELD_CHECKS.filter(([, valid]) => !valid(settings)).map(([field]) => field);
  if (invalid.length > 0) throw fleetSettingsInvalid(invalid);
  // The runner profiles, and the release block the deployer will write, must be exactly what the startup document admits.
  parseFactoryFleetRunnerProfiles(settings.installations.runnerProfiles, settings.installations.modelProvider);
  if (settings.installations.release !== undefined) {
    const release = settings.installations.release;
    const shaped = keys(release, "profiles") || (keys(release, "github,profiles") && keys(release.github, "repository,tokenPath") && absolute(release.github!.tokenPath));
    try {
      // A declaration with no profile, or of the wrong shape, declares nothing: refused rather than dropped.
      const block = shaped ? factoryInstallationReleaseBlock(release, { tenantId: "probe", ordinaryEndpoint: settings.storage.ordinary.endpoint }) : undefined;
      if (block === undefined) throw new Error("no release block");
      parseFactoryStartupConfig({ ...startupProbeDocument(settings.installations.runnerProfiles, settings.installations.modelProvider) as object, release: block });
    } catch { throw new FactoryProvisioningError("fleet_settings_invalid", "Fleet settings are invalid: installations.release."); }
  }
  return Object.freeze(JSON.parse(JSON.stringify(settings)) as FactoryFleetSettings);
}

/**
 * The runner profiles (and the model pin a pinned profile names) must be exactly what the startup
 * document admits; refused by the one name otherwise.
 */
export function parseFactoryFleetRunnerProfiles(runnerProfiles: FactoryFleetSettings["installations"]["runnerProfiles"], modelProvider?: FactoryFleetSettings["installations"]["modelProvider"]): void {
  try { parseFactoryStartupConfig(startupProbeDocument(runnerProfiles, modelProvider)); }
  catch { throw new FactoryProvisioningError("fleet_settings_invalid", "Fleet settings are invalid: installations.runnerProfiles."); }
}

/** A minimal startup document carrying only the runner profiles and the model pin, so the startup parser judges them (and, beside them, a release block). */
function startupProbeDocument(runnerProfiles: FactoryFleetSettings["installations"]["runnerProfiles"], modelProvider?: FactoryFleetSettings["installations"]["modelProvider"]): unknown {
  const tls = { caPath: "/probe/ca.crt", certificatePath: "/probe/c.crt", privateKeyPath: "/probe/c.key" };
  return {
    schemaVersion: "factory.startup.v1", installationId: "probe", tenantId: "probe", poolId: "probe", hostId: "probe", temporalNamespace: "probe",
    orchestrationReadinessFilePath: "/probe/o.json", poolReadinessFilePath: "/probe/p.json", supervisorReadinessFilePath: "/probe/s.json", orphanSweepIntervalMs: 30_000,
    gateway: { hostname: "127.0.0.1", port: 1_025, tls }, privateService: { hostname: "127.0.0.1", port: 1_026, certificateIdentity: "probe", tls },
    pool: { baseUrl: "https://127.0.0.1:1027", serviceTokenPath: "/probe/t", tls },
    storage: { ordinary: { endpoint: "http://127.0.0.1:1", bucket: "b", prefix: "p", credentialSet: "ordinary", credentialsPath: "/probe/o" }, archive: { endpoint: "http://127.0.0.1:2", bucket: "b", prefix: "p", credentialSet: "archive", credentialsPath: "/probe/a" } },
    keys: { masterKeyFilePath: "/probe/keys/m", masterKeyId: "m", wrappedKeyFilePath: "/probe/keys/w", grantableRoots: ["/probe/projects"] },
    runnerProfiles,
    ...(modelProvider === undefined ? {} : { modelProvider }),
  };
}

export async function loadFactoryFleetSettings(path: string): Promise<FactoryFleetSettings> {
  let parsed: unknown;
  try { parsed = JSON.parse(await Bun.file(path).text()); }
  catch { throw new FactoryProvisioningError("fleet_settings_invalid", `Fleet settings at ${path} are not readable JSON.`); }
  return parseFactoryFleetSettings(parsed);
}

export function factoryInstallationHostname(settings: FactoryFleetSettings, tenantId: string): string {
  return `${tenantId}.${settings.ingress.domain}`;
}

export function factoryInstallationPublicOrigin(settings: FactoryFleetSettings, installation: Pick<FactoryInstallationContext, "hostname">): string {
  return settings.ingress.port === 443 ? `https://${installation.hostname}` : `https://${installation.hostname}:${settings.ingress.port}`;
}

export interface FactoryFleetRuntime {
  readonly compose: FactoryComposeCommand;
  readonly execute?: FactoryCommandExecutor;
  readonly uid: number;
  readonly gid: number;
  /** Supplied by the hosted profile; the Compose target is built otherwise. */
  readonly target?: FactoryDeploymentTarget;
  /** Supplied by the hosted profile or a test; the Compose host target is built otherwise. */
  readonly hostTarget?: FactoryFleetHostRuntime;
}

/** The build every installation is first deployed with: the fleet's pinned image at its revision. */
export function factoryFleetDefaultBuild(settings: FactoryFleetSettings): FactoryBuild {
  return Object.freeze({ buildId: `rev-${settings.image.revision.slice(0, 12)}`, image: settings.image.reference, revision: settings.image.revision, releaseDirectory: settings.release.directory });
}

/**
 * The fleet's running services, for the operator's `stop` and `up`: containers
 * are stopped and kept, never removed, so `up` restarts exactly what ran.
 */
export interface FactoryFleetServices {
  /** Every installation of this fleet not torn down, in tenant order: `stop` stops whatever of them runs. */
  stoppable(): Promise<readonly string[]>;
  /** Every installation of this fleet that reached `deployment_ready`, in tenant order: `up` starts and waits for these. */
  startable(): Promise<readonly string[]>;
  stopInstallation(tenantId: string): Promise<void>;
  /** Start the installation's kept containers and wait until every service and the harness say ready. */
  startInstallation(tenantId: string): Promise<void>;
  stopHost(): Promise<void>;
  startHost(): Promise<void>;
  stopPlatform(): Promise<void>;
}

const FACTORY_GONE_PHASES: readonly FactoryInstallationPhase[] = ["torn_down", "purged"];
const FACTORY_DEPLOYED_PHASES: readonly FactoryInstallationPhase[] = ["deployment_ready", "invitation_issued", "bootstrap_complete"];

export interface FactoryComposedFleet {
  readonly provisioner: LocalFactoryProvisioner;
  readonly upgrades: FactoryFleetUpgrades;
  readonly platform: FactoryPlatformPaths;
  /** How the operator's `platform` and `up` start the fleet's platform: the profile decides where its ingress runs. */
  readonly platformSettings: FactoryPlatformSettings;
  readonly settings: FactoryFleetSettings;
  readonly database: FactoryDatabaseStep;
  readonly deployment: FactoryDeploymentStep;
  readonly ingress: FactoryIngressStep;
  readonly deploymentSettings: FactoryDeploymentSettings;
  /** The fleet host: the shared pool and supervisor every installation is admitted to. */
  readonly host: FactoryFleetHost;
  readonly services: FactoryFleetServices;
  /** Whether Temporal serves through the gateway: the control identity can describe the system namespace. */
  platformServes(): Promise<boolean>;
  close(): Promise<void>;
}

async function secretText(path: string): Promise<string> { return new TextDecoder().decode(await readFactoryPrivatePath(path)).trim(); }

/** Build the provisioner and every driver for one fleet. */
export async function composeFactoryProvisioner(settings: FactoryFleetSettings, runtime: FactoryFleetRuntime): Promise<FactoryComposedFleet> {
  const execute = runtime.execute ?? factorySpawnExecutor;
  const platform = await ensureFactoryPlatformMaterial(settings.roots.operator);
  const adminUrl = await secretText(settings.database.adminUrlPath);
  const controlUrl = await secretText(settings.control.databaseUrlPath);
  let provisioner: LocalFactoryProvisioner | undefined;
  // Each installation owns its product database; the fleet host owns the one shared pool database.
  const database = new FactoryDatabaseStep({ adminUrl, kinds: ["product"], progress: (installation, resources) => provisioner!.ledger.stepProgress(installation.tenantId, "database", resources) });
  let host: FactoryFleetHost | undefined;
  const hostDatabase = new FactoryDatabaseStep({ adminUrl, kinds: ["pool"], progress: (_host, resources) => host!.recordDatabaseProgress(resources) });
  const issuer = (domain: "ordinary" | "archive"): FactoryStorageCredentialIssuer => new FactorySeededStorageIssuer(settings.storage[domain].issuer.serverIdentityPath);
  const storage = new FactoryStorageStep({
    claims: factoryDatabaseStorageClaims(adminUrl),
    ordinary: { endpoint: settings.storage.ordinary.endpoint, prefix: settings.storage.ordinary.prefix, issuer: issuer("ordinary"), failureDomain: settings.storage.failureDomain },
    archive: { endpoint: settings.storage.archive.endpoint, prefix: settings.storage.archive.prefix, issuer: issuer("archive"), failureDomain: settings.storage.failureDomain },
    probe: factoryS3ScopeProbe,
    foreignBucket: (installation) => installation.tenantId === "tenant-01" ? "tenant-02" : "tenant-01",
  });
  const endpoint = { address: `127.0.0.1:${settings.temporal.port}`, serverName: settings.temporal.serverName, caCertificatePath: platform.temporal.caCertificatePath };
  const temporalAdmin = factoryTemporalNamespaceAdmin(endpoint, platform.temporal, platform.temporal);
  const temporal = new FactoryTemporalStep({
    authority: platform.temporal,
    httpTokensDirectory: platform.temporal.httpTokensDirectory,
    admin: temporalAdmin,
    access: factoryTemporalAccessProbe(endpoint),
    certificates: factoryTemporalCertificateIssuer(),
  });
  await temporal.load();
  const secrets = new FactorySecretsStep({ registry: { conflicts: (tenantId, digests) => provisioner!.ledger.digestConflicts(tenantId, digests) }, grantableRoots: () => ["/var/lib/ezcorp/projects"] });
  const upgradeSql = openBunSql(controlUrl, { max: 2 });
  let upgrades: FactoryFleetUpgrades | undefined;
  // What differs between the two deployment profiles, and only that (`fleet-profile.ts`).
  const profile = await factoryFleetProfile(settings, { execute, compose: runtime.compose, uid: runtime.uid, gid: runtime.gid, ingressRoot: platform.ingress.root });
  const hostTarget = runtime.hostTarget ?? profile.hostTarget;
  host = new FactoryFleetHost({
    settings: {
      fleetId: settings.fleetId, secretsRoot: settings.roots.secrets, operatorRoot: settings.roots.operator, runtimeRoot: settings.roots.runtime,
      portBase: settings.installations.portBase, resources: settings.resources, ...(profile.hosted === undefined ? {} : { hosted: profile.hosted }),
      database: { host: settings.database.serviceHost, port: settings.database.servicePort },
      build: { image: settings.image.reference, revision: settings.image.revision, release: settings.release.directory },
    },
    runtime: hostTarget, database: hostDatabase,
    locked: (work) => provisioner!.ledger.lockedOn(`factory-host:${settings.fleetId}`, work),
  });
  const fleetHost = host;
  const deploymentSettings: FactoryDeploymentSettings = {
    network: {
      ...profile.network, temporalServerName: settings.temporal.serverName,
      publicOrigin: (installation) => factoryInstallationPublicOrigin(settings, installation),
      portBase: settings.installations.portBase,
    },
    image: settings.image,
    runtimeRoot: settings.roots.runtime,
    runnerProfiles: settings.installations.runnerProfiles,
    ...(settings.installations.release === undefined ? {} : { release: settings.installations.release }),
    ...(settings.installations.modelProvider === undefined ? {} : { modelProvider: settings.installations.modelProvider }),
    host: fleetHost.facts(),
    interpreterCompatibility: settings.installations.interpreterCompatibility,
    builds: (installation) => upgrades!.builds(installation.tenantId),
  };
  const target = runtime.target ?? profile.target;
  const deployment = new FactoryDeploymentStep({ settings: deploymentSettings, target, host: fleetHost });
  const ingress = new FactoryIngressStep({
    paths: { root: platform.ingress.root, mountedRoot: "/etc/ezcorp-ingress", listenAddress: profile.ingress.listenAddress, listenPort: profile.ingress.listenPort },
    authority: { certificatePath: platform.ingress.caCertificatePath, keyPath: platform.ingress.caKeyPath },
    exclusive: (work) => provisioner!.ledger.lockedOn(`factory-ingress:${settings.fleetId}`, work),
    reloader: profile.ingress.reloader,
    probe: factoryHttpsIngressProbe(settings.ingress.address, settings.ingress.port, await secretText(platform.ingress.caCertificatePath) + "\n"),
    upstreamPort: profile.ingress.upstreamPort,
    ...(profile.ingress.upstreamHost === undefined ? {} : { upstreamHost: profile.ingress.upstreamHost }),
  });
  const invitation = new FactoryInvitationStep();
  provisioner = new LocalFactoryProvisioner({
    fleetId: settings.fleetId, controlDatabaseUrl: controlUrl, secretsRoot: settings.roots.secrets, operatorRoot: settings.roots.operator,
    drivers: { database, storage, temporal, secrets, deployment, ingress, invitation },
  });
  const composed = provisioner;
  await composed.setup();
  upgrades = new FactoryFleetUpgrades(upgradeSql, new FactoryProfileUpgradeTarget((installation) => deployment.bundle(installation), profile.upgrades, fleetHost), (tenantId) => composed.installation(tenantId));
  await upgrades.setup();
  await upgrades.register(factoryFleetDefaultBuild(settings));
  const fleetUpgrades = upgrades;
  const tenants = async (phases: (phase: FactoryInstallationPhase) => boolean) => (await composed.ledger.directory()).filter((entry) => entry.fleetId === settings.fleetId && phases(entry.phase)).map((entry) => entry.tenantId);
  const services: FactoryFleetServices = Object.freeze({
    stoppable: () => tenants((phase) => !FACTORY_GONE_PHASES.includes(phase)),
    startable: () => tenants((phase) => FACTORY_DEPLOYED_PHASES.includes(phase)),
    stopInstallation: async (tenantId: string) => profile.target.stop(factoryDeploymentHandle(await composed.installation(tenantId), settings.roots.runtime)),
    startInstallation: async (tenantId: string) => profile.target.start(await deployment.bundle(await composed.installation(tenantId))),
    stopHost: () => fleetHost.stop(),
    startHost: () => fleetHost.start(),
    stopPlatform: () => stopFactoryPlatform({ fleetId: settings.fleetId, repositoryRoot: settings.release.directory }, platform, runtime.compose, execute),
  });
  const platformSettings: FactoryPlatformSettings = Object.freeze({
    fleetId: settings.fleetId, operatorRoot: settings.roots.operator, repositoryRoot: settings.release.directory,
    temporalPort: settings.temporal.port, temporalHttpPort: settings.temporal.httpPort, ...profile.platform,
  });
  return Object.freeze({ provisioner: composed, upgrades: fleetUpgrades, services, platform, platformSettings, settings, database, deployment, ingress, deploymentSettings, host: fleetHost, platformServes: async () => (await temporalAdmin.owner("temporal-system")) !== undefined, close: async () => { await composed.close(); await database.close(); await hostDatabase.close(); await upgradeSql.close(); } });
}

export { factoryPlatformPaths };
