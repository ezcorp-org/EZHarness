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
import { parseFactoryStartupConfig, type FactoryStartupRunnerProfile } from "../startup-config";
import { SQL } from "bun";
import { FactoryComposeHostTarget, FactoryComposeTarget, FactoryComposeUpgradeTarget, factorySpawnExecutor, type FactoryCommandExecutor, type FactoryComposeCommand } from "./compose-profile";
import { FactoryFleetUpgrades, type FactoryBuild } from "./fleet-upgrade";
import { FactoryDatabaseStep } from "./database";
import { FactoryDeploymentStep, factoryInstallationPorts, type FactoryDeploymentSettings, type FactoryDeploymentTarget } from "./deployment";
import { FactoryFleetHost, type FactoryFleetHostRuntime } from "./host";
import { FactoryIngressStep, factoryHttpsIngressProbe } from "./ingress";
import type { FactoryInstallationContext } from "./installation";
import { FactoryInvitationStep } from "./invitation";
import { LocalFactoryProvisioner } from "./local";
import { ensureFactoryPlatformMaterial, factoryPlatformPaths, factoryPodmanIngressReloader, type FactoryPlatformPaths } from "./platform";
import { readFactoryPrivatePath } from "./secret-files";
import { FactorySecretsStep } from "./secrets";
import { FactorySeededStorageIssuer, FactoryStorageStep, factoryDatabaseStorageClaims, factoryS3ScopeProbe, type FactoryStorageCredentialIssuer } from "./storage";
import { FactoryProvisioningError } from "./steps";
import { FactoryTemporalStep, factoryTemporalCertificateIssuer } from "./temporal";
import { factoryTemporalAccessProbe, factoryTemporalNamespaceAdmin } from "./temporal-client";

export const FACTORY_FLEET_SCHEMA = "factory.fleet.v1";

export interface FactoryFleetStorageDomain {
  readonly endpoint: string;
  readonly prefix: string;
  readonly issuer: { readonly kind: "seeded"; readonly serverIdentityPath: string };
}

export interface FactoryFleetSettings {
  readonly schemaVersion: typeof FACTORY_FLEET_SCHEMA;
  readonly fleetId: string;
  readonly profile: "compose" | "kubernetes";
  readonly roots: { readonly operator: string; readonly secrets: string; readonly runtime: string };
  readonly control: { readonly databaseUrlPath: string };
  readonly database: { readonly adminUrlPath: string; readonly serviceHost: string; readonly servicePort: number };
  readonly storage: { readonly ordinary: FactoryFleetStorageDomain; readonly archive: FactoryFleetStorageDomain; readonly failureDomain: string };
  readonly temporal: { readonly port: number; readonly serverName: string };
  readonly ingress: { readonly address: string; readonly port: number; readonly domain: string };
  readonly installations: {
    readonly portBase: number;
    readonly cpuCapacity: number;
    readonly interpreterCompatibility: string;
    readonly runnerProfiles: { readonly brokerAudience: string; readonly profiles: readonly FactoryStartupRunnerProfile[] };
  };
  readonly image: { readonly reference: string; readonly revision: string };
  readonly release: { readonly directory: string; readonly bun: string; readonly path: string };
}

function absolute(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4_096 && resolve(value) === value; }
function port(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1_024 && (value as number) <= 65_535; }
function url(value: unknown): value is string { try { return typeof value === "string" && ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } }
function keys(value: unknown, expected: string): boolean { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).sort().join(",") === expected; }

/**
 * Validate the whole document and name every bad field at once, in the startup
 * document's style: an operator with three mistakes fixes three things once.
 */
export function parseFactoryFleetSettings(value: unknown): FactoryFleetSettings {
  const settings = value as FactoryFleetSettings;
  const invalid: string[] = [];
  const check = (field: string, ok: boolean) => { if (!ok) invalid.push(field); };
  check("document", keys(value, "control,database,fleetId,image,ingress,installations,profile,release,roots,schemaVersion,storage,temporal") && settings.schemaVersion === FACTORY_FLEET_SCHEMA);
  if (invalid.length > 0) throw new FactoryProvisioningError("fleet_settings_invalid", `Fleet settings are invalid: ${invalid.join(", ")}.`);
  check("fleetId", typeof settings.fleetId === "string" && /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(settings.fleetId));
  check("profile", settings.profile === "compose" || settings.profile === "kubernetes");
  check("roots", keys(settings.roots, "operator,runtime,secrets") && absolute(settings.roots.operator) && absolute(settings.roots.secrets) && absolute(settings.roots.runtime));
  check("control", keys(settings.control, "databaseUrlPath") && absolute(settings.control.databaseUrlPath));
  check("database", keys(settings.database, "adminUrlPath,serviceHost,servicePort") && absolute(settings.database.adminUrlPath) && typeof settings.database.serviceHost === "string" && port(settings.database.servicePort));
  for (const domain of ["ordinary", "archive"] as const) {
    const entry = settings.storage?.[domain];
    check(`storage.${domain}`, keys(entry, "endpoint,issuer,prefix") && url(entry.endpoint) && /^[a-z][a-z0-9-]{0,62}$/.test(entry.prefix) && keys(entry.issuer, "kind,serverIdentityPath") && entry.issuer.kind === "seeded" && absolute(entry.issuer.serverIdentityPath));
  }
  check("storage", keys(settings.storage, "archive,failureDomain,ordinary") && typeof settings.storage.failureDomain === "string" && settings.storage.failureDomain.length > 0);
  check("temporal", keys(settings.temporal, "port,serverName") && port(settings.temporal.port) && typeof settings.temporal.serverName === "string");
  check("ingress", keys(settings.ingress, "address,domain,port") && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(settings.ingress.address) && port(settings.ingress.port) && /^[a-z0-9.-]{1,200}$/.test(settings.ingress.domain));
  check("installations", keys(settings.installations, "cpuCapacity,interpreterCompatibility,portBase,runnerProfiles") && port(settings.installations.portBase) && Number.isSafeInteger(settings.installations.cpuCapacity) && settings.installations.cpuCapacity > 0 && typeof settings.installations.interpreterCompatibility === "string");
  check("image", keys(settings.image, "reference,revision") && /^[^@\s]+@sha256:[a-f0-9]{64}$/.test(settings.image.reference) && /^[a-f0-9]{40}$/.test(settings.image.revision));
  check("release", keys(settings.release, "bun,directory,path") && absolute(settings.release.directory) && absolute(settings.release.bun) && typeof settings.release.path === "string");
  if (invalid.length > 0) throw new FactoryProvisioningError("fleet_settings_invalid", `Fleet settings are invalid: ${invalid.join(", ")}.`);
  // The runner profiles must be exactly what the startup document admits.
  try { parseFactoryStartupConfig(runnerProbeDocument(settings.installations.runnerProfiles)); }
  catch { throw new FactoryProvisioningError("fleet_settings_invalid", "Fleet settings are invalid: installations.runnerProfiles."); }
  return Object.freeze(JSON.parse(JSON.stringify(settings)) as FactoryFleetSettings);
}

/** A minimal startup document carrying only the runner profiles, so the startup parser judges them. */
function runnerProbeDocument(runnerProfiles: FactoryFleetSettings["installations"]["runnerProfiles"]): unknown {
  const tls = { caPath: "/probe/ca.crt", certificatePath: "/probe/c.crt", privateKeyPath: "/probe/c.key" };
  return {
    schemaVersion: "factory.startup.v1", installationId: "probe", tenantId: "probe", poolId: "probe", hostId: "probe", temporalNamespace: "probe",
    orchestrationReadinessFilePath: "/probe/o.json", poolReadinessFilePath: "/probe/p.json", supervisorReadinessFilePath: "/probe/s.json", orphanSweepIntervalMs: 30_000,
    gateway: { hostname: "127.0.0.1", port: 1_025, tls }, privateService: { hostname: "127.0.0.1", port: 1_026, certificateIdentity: "probe", tls },
    pool: { baseUrl: "https://127.0.0.1:1027", serviceTokenPath: "/probe/t", tls },
    storage: { ordinary: { endpoint: "http://127.0.0.1:1", bucket: "b", prefix: "p", credentialSet: "ordinary", credentialsPath: "/probe/o" }, archive: { endpoint: "http://127.0.0.1:2", bucket: "b", prefix: "p", credentialSet: "archive", credentialsPath: "/probe/a" } },
    keys: { masterKeyFilePath: "/probe/keys/m", masterKeyId: "m", wrappedKeyFilePath: "/probe/keys/w", grantableRoots: ["/probe/projects"] },
    runnerProfiles,
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

export interface FactoryComposedFleet {
  readonly provisioner: LocalFactoryProvisioner;
  readonly upgrades: FactoryFleetUpgrades;
  readonly platform: FactoryPlatformPaths;
  readonly settings: FactoryFleetSettings;
  readonly database: FactoryDatabaseStep;
  readonly deployment: FactoryDeploymentStep;
  readonly ingress: FactoryIngressStep;
  readonly deploymentSettings: FactoryDeploymentSettings;
  /** The fleet host: the shared pool and supervisor every installation is admitted to. */
  readonly host: FactoryFleetHost;
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
    admin: temporalAdmin,
    access: factoryTemporalAccessProbe(endpoint),
    certificates: factoryTemporalCertificateIssuer(),
  });
  await temporal.load();
  const secrets = new FactorySecretsStep({ registry: { conflicts: (tenantId, digests) => provisioner!.ledger.digestConflicts(tenantId, digests) }, grantableRoots: () => ["/var/lib/ezcorp/projects"] });
  const upgradeSql = new SQL(controlUrl, { max: 2 });
  let upgrades: FactoryFleetUpgrades | undefined;
  const hostTarget = runtime.hostTarget ?? new FactoryComposeHostTarget({
    compose: runtime.compose, templatePath: resolve(settings.release.directory, "deploy/factory/compose/host.yml"), execute,
    supervisor: { bun: settings.release.bun, releaseDirectory: settings.release.directory, path: settings.release.path },
    databasePort: settings.database.servicePort, uid: runtime.uid, gid: runtime.gid,
  });
  host = new FactoryFleetHost({
    settings: {
      fleetId: settings.fleetId, secretsRoot: settings.roots.secrets, operatorRoot: settings.roots.operator, runtimeRoot: settings.roots.runtime,
      portBase: settings.installations.portBase, cpuCapacity: settings.installations.cpuCapacity,
      database: { host: settings.database.serviceHost, port: settings.database.servicePort },
      build: { image: settings.image.reference, revision: settings.image.revision, release: settings.release.directory },
    },
    runtime: hostTarget, database: hostDatabase,
    locked: (work) => provisioner!.ledger.lockedOn(`factory-host:${settings.fleetId}`, work),
  });
  const fleetHost = host;
  const deploymentSettings: FactoryDeploymentSettings = {
    network: {
      databaseHost: settings.database.serviceHost, databasePort: settings.database.servicePort,
      ordinaryEndpoint: settings.storage.ordinary.endpoint, archiveEndpoint: settings.storage.archive.endpoint,
      temporalAddress: `127.0.0.1:${settings.temporal.port}`, temporalServerName: settings.temporal.serverName,
      publicOrigin: (installation) => factoryInstallationPublicOrigin(settings, installation),
      portBase: settings.installations.portBase,
    },
    image: settings.image,
    runtimeRoot: settings.roots.runtime,
    runnerProfiles: settings.installations.runnerProfiles,
    host: fleetHost.facts(),
    interpreterCompatibility: settings.installations.interpreterCompatibility,
    builds: (installation) => upgrades!.builds(installation.tenantId),
  };
  const storagePorts = [settings.storage.ordinary.endpoint, settings.storage.archive.endpoint].map((endpointUrl) => Number(new URL(endpointUrl).port));
  const composeTarget = new FactoryComposeTarget({
    compose: runtime.compose, templatePath: resolve(settings.release.directory, "deploy/factory/compose/installation.yml"), execute,
    databasePort: settings.database.servicePort, storagePorts, temporalPort: settings.temporal.port, uid: runtime.uid, gid: runtime.gid,
  });
  const target = runtime.target ?? composeTarget;
  const deployment = new FactoryDeploymentStep({ settings: deploymentSettings, target, host: fleetHost });
  const ingress = new FactoryIngressStep({
    paths: { root: platform.ingress.root, mountedRoot: "/etc/ezcorp-ingress", listenAddress: settings.ingress.address, listenPort: settings.ingress.port },
    authority: { certificatePath: platform.ingress.caCertificatePath, keyPath: platform.ingress.caKeyPath },
    exclusive: (work) => provisioner!.ledger.lockedOn(`factory-ingress:${settings.fleetId}`, work),
    reloader: factoryPodmanIngressReloader(settings.fleetId, execute),
    probe: factoryHttpsIngressProbe(settings.ingress.address, settings.ingress.port, await secretText(platform.ingress.caCertificatePath) + "\n"),
    upstreamPort: (installation) => factoryInstallationPorts(installation.tenantId, settings.installations.portBase).harness,
  });
  const invitation = new FactoryInvitationStep();
  provisioner = new LocalFactoryProvisioner({
    fleetId: settings.fleetId, controlDatabaseUrl: controlUrl, secretsRoot: settings.roots.secrets, operatorRoot: settings.roots.operator,
    drivers: { database, storage, temporal, secrets, deployment, ingress, invitation },
  });
  const composed = provisioner;
  await composed.setup();
  upgrades = new FactoryFleetUpgrades(upgradeSql, new FactoryComposeUpgradeTarget((installation) => deployment.bundle(installation), composeTarget, fleetHost), async (tenantId) => {
    const record = await composed.ledger.installation(tenantId);
    if (!record) throw new FactoryProvisioningError("provisioning_unknown_tenant", `No installation is recorded for ${tenantId}.`);
    const { raw: _raw, phase: _phase, planLimits: _limits, membershipRefs: _refs, ...context } = record;
    return context;
  });
  await upgrades.setup();
  await upgrades.register(factoryFleetDefaultBuild(settings));
  const fleetUpgrades = upgrades;
  return Object.freeze({ provisioner: composed, upgrades: fleetUpgrades, platform, settings, database, deployment, ingress, deploymentSettings, host: fleetHost, platformServes: async () => (await temporalAdmin.owner("temporal-system")) !== undefined, close: async () => { await composed.close(); await database.close(); await hostDatabase.close(); await upgradeSql.close(); } });
}

export { factoryPlatformPaths };
