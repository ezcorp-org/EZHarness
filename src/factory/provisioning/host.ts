/**
 * The fleet host: the ONE pool and the ONE host supervisor every installation
 * of a fleet shares (C12; coordinator ruling 2026-09-22).
 *
 * Each shared service names its own identity — `pool.<fleet>` and
 * `host.<fleet>` — and every installation's startup document names those same
 * identities, so each installation's product proves the shared services ready
 * without either service knowing any one installation. Tenant scoping stays
 * where it was: the pool maps each client-certificate name to one tenant, and
 * each installation's pool token carries only its own tenant's scopes.
 *
 * Trust, per direction:
 *
 *   - the pool and the supervisor present a server certificate from the HOST
 *     authority; each installation's harness trusts that authority alone for
 *     them (`host-ca.crt`), and its own authority for its own listeners;
 *   - the pool and the supervisor accept a client certificate from each
 *     ADMITTED installation's own authority, and the pool also the host's own
 *     supervisor certificate; an installation that leaves is removed from both;
 *   - pool tokens are minted by the host key: an installation's harness token
 *     names only its own tenant (`pool:tenant`, `pool:grant`, `pool:restore`).
 *
 * The host's signing key belongs to the supervisor alone; installations get its
 * public half to verify physical-stop receipts.
 *
 * Admission and release re-render both services and restart them onto the new
 * trust set, under the fleet's host lock, so two provisions cannot lose each
 * other's admission.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import { parseFactoryPoolProcessConfig } from "../pool/process";
import { parseFactorySupervisorProcessConfig } from "../runner/supervisor-process";
import { createFactoryCertificateAuthority, issueFactoryCertificate, type FactoryCommandRunner } from "./certificates";
import type { FactoryDatabaseCredential, FactoryDatabaseStep } from "./database";
import { factoryDatabasePairs } from "./database";
import { factoryFleetResourceName, type FactoryInstallationContext, type FactoryStepResources } from "./installation";
import { FACTORY_HOST_KEY_ID, FACTORY_MESH_FILES, FACTORY_MESH_TOKEN_KEY_ID, FACTORY_POOL_AUDIENCE, factoryMeshIdentities, factoryMeshToken, factoryMeshTokenExpiry } from "./mesh";
import { ensureFactoryPrivateCertificatePair, ensureFactoryPrivateFile, factoryPrivatePath, openFactoryPrivateDirectory, readFactoryPrivateJson, readFactoryPrivatePath, readFactoryPrivateText, removeFactoryPrivateDirectory, replaceFactoryPrivateFile } from "./secret-files";
import { FactoryProvisioningError } from "./steps";

/** Files the host keeps. Server and supervisor material in the host's secret directory; authority and token key operator-only. */
export const FACTORY_HOST_FILES = Object.freeze({
  caCertificate: "host-ca.crt",
  serverCertificate: "host-server.crt", serverKey: "host-server.key",
  supervisorCertificate: "host-supervisor.crt", supervisorKey: "host-supervisor.key",
  tokenPublicKey: "host-token.pub",
  supervisorPoolToken: "host-supervisor-pool.token",
  trustBundle: "host-trust.crt",
  hostKey: "host-signing.key", hostPublicKey: "host-signing.pub", hostKeyId: "host-signing.kid",
  state: "host-state.json",
});
export const FACTORY_HOST_OPERATOR_FILES = Object.freeze({ caCertificate: "host-ca.crt", caKey: "host-ca.key", tokenKey: "host-token.key" });

/** An installation's pool token is re-minted when it has less than this left. */
const TOKEN_REFRESH_MS = 7 * 24 * 60 * 60 * 1_000;

export interface FactoryFleetHostIdentity {
  readonly poolId: string;
  readonly hostId: string;
  readonly supervisor: string;
  readonly issuer: string;
  readonly ports: { readonly pool: number; readonly supervisor: number };
}

export function factoryFleetHostIdentity(fleetId: string, portBase: number): FactoryFleetHostIdentity {
  if (!Number.isSafeInteger(portBase) || portBase < 1_024 || portBase + 1_010 > 65_535) throw new FactoryProvisioningError("deployment_ports_invalid", "Host ports cannot be derived.");
  return Object.freeze({
    poolId: `pool.${fleetId}`, hostId: `host.${fleetId}`, supervisor: `supervisor.${fleetId}`, issuer: `factory-host:${fleetId}`,
    ports: Object.freeze({ pool: portBase + 1_002, supervisor: portBase + 1_003 }),
  });
}

/** The host's paths. It is modelled as one more context so the database step can own its pool pair. */
export interface FactoryFleetHostPaths {
  readonly context: FactoryInstallationContext;
  readonly runtimeDirectory: string;
  readonly readinessDirectory: string;
  readonly runnerRoot: string;
  readonly poolDelivery: string;
  readonly supervisorDelivery: string;
}

export function factoryFleetHostPaths(fleetId: string, roots: { readonly secretsRoot: string; readonly operatorRoot: string; readonly runtimeRoot: string }): FactoryFleetHostPaths {
  const secretDirectory = resolve(roots.secretsRoot, "host");
  const runtimeDirectory = resolve(roots.runtimeRoot, "host");
  return Object.freeze({
    context: Object.freeze({
      tenantId: "host", hostname: "host.invalid", administratorEmail: "operator@host.invalid", fleetId,
      installationId: `host:${fleetId}`, invitationId: "none",
      productDatabase: factoryFleetResourceName("factory_hostnone", fleetId, "host"), productRole: factoryFleetResourceName("factory_hostnone", fleetId, "host"),
      temporalNamespace: "none", secretDirectory, operatorDirectory: resolve(roots.operatorRoot, "host"),
    }),
    runtimeDirectory, readinessDirectory: resolve(runtimeDirectory, "readiness"), runnerRoot: resolve(runtimeDirectory, "runner"),
    poolDelivery: resolve(secretDirectory, "deliver", "pool"), supervisorDelivery: resolve(secretDirectory, "deliver", "supervisor"),
  });
}

/** What a harness needs from the host: identities, ports, and the paths of the host's public material. */
export interface FactoryFleetHostFacts extends FactoryFleetHostIdentity {
  readonly caCertificatePath: string;
  readonly hostPublicKeyPath: string;
  readonly poolReadinessDirectory: string;
  readonly supervisorReadinessDirectory: string;
}

export interface FactoryFleetHostAdmission {
  readonly installationId: string;
  readonly tenantId: string;
  readonly harnessIdentity: string;
  readonly caCertificatePath: string;
}

/** The build the host's pool and supervisor run: the pool's image, and the host checkout the supervisor runs. */
export interface FactoryFleetHostBuild {
  readonly image: string;
  readonly revision: string;
  readonly release: string;
}

interface FactoryFleetHostState {
  readonly schemaVersion: "factory.host-state.v1";
  readonly database: FactoryStepResources | null;
  readonly admitted: Readonly<Record<string, FactoryFleetHostAdmission>>;
  /** Absent until a fleet upgrade moves the host; the fleet's default build meanwhile. */
  readonly build?: FactoryFleetHostBuild;
}

/** The rendered host: both services' deliveries and the documents in them. */
export interface FactoryFleetHostBundle {
  readonly identity: FactoryFleetHostIdentity;
  readonly paths: FactoryFleetHostPaths;
  readonly admitted: readonly FactoryFleetHostAdmission[];
  readonly build: FactoryFleetHostBuild;
  readonly pool: unknown;
  readonly supervisor: unknown;
  readonly deliveries: { readonly pool: Readonly<Record<string, string>>; readonly supervisor: Readonly<Record<string, string>> };
}

/** How the host's two services run. The Compose profile implements it. */
export interface FactoryFleetHostRuntime {
  /** Start or restart both services onto the delivered configuration. */
  apply(bundle: FactoryFleetHostBundle): Promise<void>;
  /** Resolves once both services publish a fresh ready record. */
  ready(bundle: FactoryFleetHostBundle): Promise<void>;
  /** Stop both services. Idempotent. */
  remove(paths: FactoryFleetHostPaths): Promise<void>;
  /** Stop both services and remove the host's runtime directory. */
  purge(paths: FactoryFleetHostPaths): Promise<void>;
}

export interface FactoryFleetHostSettings {
  readonly fleetId: string;
  readonly secretsRoot: string;
  readonly operatorRoot: string;
  readonly runtimeRoot: string;
  readonly portBase: number;
  readonly cpuCapacity: number;
  /** How the pool reaches the database cluster, from inside its container. */
  readonly database: { readonly host: string; readonly port: number };
  /** The fleet's default build, until an upgrade moves the host. */
  readonly build: FactoryFleetHostBuild;
}

export interface FactoryFleetHostOptions {
  readonly settings: FactoryFleetHostSettings;
  readonly runtime: FactoryFleetHostRuntime;
  /** A database step that owns only the pool pair. */
  readonly database: Pick<FactoryDatabaseStep, "ensure" | "purge">;
  /** Serialize admission and release across processes (the fleet's advisory lock). */
  readonly locked: <Result>(work: () => Promise<Result>) => Promise<Result>;
  readonly run?: FactoryCommandRunner;
  readonly now?: () => number;
}

const containerSecret = (name: string) => `/run/ezcorp/secrets/${name}`;

export class FactoryFleetHost {
  readonly identity: FactoryFleetHostIdentity;
  readonly paths: FactoryFleetHostPaths;
  private readonly now: () => number;
  constructor(private readonly options: FactoryFleetHostOptions) {
    this.identity = factoryFleetHostIdentity(options.settings.fleetId, options.settings.portBase);
    this.paths = factoryFleetHostPaths(options.settings.fleetId, options.settings);
    this.now = options.now ?? Date.now;
  }

  /** The facts every installation's bundle names. */
  facts(): FactoryFleetHostFacts {
    return Object.freeze({
      ...this.identity,
      caCertificatePath: factoryPrivatePath(this.paths.context.secretDirectory, FACTORY_HOST_FILES.caCertificate),
      hostPublicKeyPath: factoryPrivatePath(this.paths.context.secretDirectory, FACTORY_HOST_FILES.hostPublicKey),
      poolReadinessDirectory: resolve(this.paths.readinessDirectory, "pool"),
      supervisorReadinessDirectory: resolve(this.paths.readinessDirectory, "supervisor"),
    });
  }

  private async state(): Promise<FactoryFleetHostState> {
    const operator = await openFactoryPrivateDirectory(this.paths.context.operatorDirectory);
    try {
      const value = await readFactoryPrivateJson<FactoryFleetHostState>(operator, FACTORY_HOST_FILES.state).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (value === undefined) return { schemaVersion: "factory.host-state.v1", database: null, admitted: {} };
      if (value.schemaVersion !== "factory.host-state.v1" || typeof value.admitted !== "object" || value.admitted === null) throw new FactoryProvisioningError("host_state_corrupt", "The fleet host's state file is not a host state document.");
      return value;
    } finally { await operator.close(); }
  }

  private async saveState(state: FactoryFleetHostState): Promise<void> {
    await replaceFactoryPrivateFile(factoryPrivatePath(this.paths.context.operatorDirectory, FACTORY_HOST_FILES.state), `${JSON.stringify(state)}\n`);
  }

  /**
   * The host's own material, created once: authority, the server and
   * supervisor leaves, the token key, the host signing key. The supervisor's
   * pool token is re-minted when it nears expiry.
   */
  async ensureMaterial(): Promise<void> {
    const { context } = this.paths;
    const operator = await openFactoryPrivateDirectory(context.operatorDirectory);
    const secrets = await openFactoryPrivateDirectory(context.secretDirectory);
    try {
      await ensureFactoryPrivateCertificatePair(operator, { key: FACTORY_HOST_OPERATOR_FILES.caKey, certificate: FACTORY_HOST_OPERATOR_FILES.caCertificate }, () => createFactoryCertificateAuthority(`host.${this.options.settings.fleetId}`, this.options.run));
      const caPem = await readFactoryPrivateText(operator, FACTORY_HOST_OPERATOR_FILES.caCertificate);
      await ensureFactoryPrivateFile(secrets, FACTORY_HOST_FILES.caCertificate, () => caPem);
      const authority = { certificatePath: factoryPrivatePath(context.operatorDirectory, FACTORY_HOST_OPERATOR_FILES.caCertificate), keyPath: factoryPrivatePath(context.operatorDirectory, FACTORY_HOST_OPERATOR_FILES.caKey) };
      await ensureFactoryPrivateCertificatePair(secrets, { key: FACTORY_HOST_FILES.serverKey, certificate: FACTORY_HOST_FILES.serverCertificate }, () => issueFactoryCertificate(authority, { subject: "localhost", usage: "server", dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"] }, this.options.run));
      await ensureFactoryPrivateCertificatePair(secrets, { key: FACTORY_HOST_FILES.supervisorKey, certificate: FACTORY_HOST_FILES.supervisorCertificate }, () => issueFactoryCertificate(authority, { subject: this.identity.supervisor, usage: "client" }, this.options.run));
      await ensureFactoryPrivateFile(operator, FACTORY_HOST_OPERATOR_FILES.tokenKey, () => generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString());
      const tokenKey = await readFactoryPrivateText(operator, FACTORY_HOST_OPERATOR_FILES.tokenKey);
      await ensureFactoryPrivateFile(secrets, FACTORY_HOST_FILES.tokenPublicKey, () => createPublicKey(createPrivateKey(tokenKey)).export({ type: "spki", format: "pem" }).toString());
      await ensureFactoryPrivateFile(secrets, FACTORY_HOST_FILES.hostKey, () => generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString());
      const hostKey = await readFactoryPrivateText(secrets, FACTORY_HOST_FILES.hostKey);
      await ensureFactoryPrivateFile(secrets, FACTORY_HOST_FILES.hostPublicKey, () => createPublicKey(createPrivateKey(hostKey)).export({ type: "spki", format: "pem" }).toString());
      await ensureFactoryPrivateFile(secrets, FACTORY_HOST_FILES.hostKeyId, () => FACTORY_HOST_KEY_ID);
      await this.refreshToken(factoryPrivatePath(context.secretDirectory, FACTORY_HOST_FILES.supervisorPoolToken), tokenKey, this.identity.supervisor, [`pool:supervisor:${this.identity.supervisor}`]);
    } finally { await operator.close(); await secrets.close(); }
  }

  /** Write `path` with a fresh token unless the one there has more than a week left. */
  private async refreshToken(path: string, keyPem: string, subject: string, scope: readonly string[], force = false): Promise<void> {
    if (!force) {
      const current = await readFactoryPrivatePath(path).then((bytes) => new TextDecoder().decode(bytes), (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      const expiry = current === undefined ? undefined : factoryMeshTokenExpiry(current);
      if (expiry !== undefined && expiry - this.now() > TOKEN_REFRESH_MS) return;
    }
    await replaceFactoryPrivateFile(path, `${factoryMeshToken({ subject, issuer: this.identity.issuer, audience: FACTORY_POOL_AUDIENCE, scope, keyPem, nowSeconds: Math.floor(this.now() / 1_000) })}\n`);
  }

  /**
   * Mint the installation's pool token into its own secret directory: its own
   * tenant's scopes only, including the restore scope W15's recovery path needs.
   * `force` re-mints (a deployment rotation); otherwise a token with more than
   * a week left is kept.
   */
  async mintInstallationToken(installation: FactoryInstallationContext, force = false): Promise<number> {
    const tokenKey = await this.operatorText(FACTORY_HOST_OPERATOR_FILES.tokenKey);
    const path = factoryPrivatePath(installation.secretDirectory, FACTORY_MESH_FILES.harnessPoolToken);
    const tenant = installation.tenantId;
    await this.refreshToken(path, tokenKey, tenant, [`pool:tenant:${tenant}`, `pool:grant:${tenant}:factory`, `pool:restore:${tenant}`], force);
    return factoryMeshTokenExpiry(new TextDecoder().decode(await readFactoryPrivatePath(path)))!;
  }

  private async operatorText(name: string): Promise<string> {
    const operator = await openFactoryPrivateDirectory(this.paths.context.operatorDirectory);
    try { return await readFactoryPrivateText(operator, name); } finally { await operator.close(); }
  }

  /**
   * The database step's progress, merged into the host's state as it happens,
   * so a crash between two DDL statements is recognised on the rerun rather
   * than refused as a foreign resource.
   */
  async recordDatabaseProgress(resources: FactoryStepResources): Promise<void> {
    const state = await this.state();
    await this.saveState({ ...state, database: { ...(state.database ?? {}), ...resources } });
  }

  /**
   * Admit an installation: mint its pool token, add its authority and harness
   * identity to both services' trust, and restart them onto it. Idempotent.
   */
  async admit(installation: FactoryInstallationContext): Promise<FactoryFleetHostFacts> {
    return this.options.locked(async () => {
      await this.ensureMaterial();
      await this.mintInstallationToken(installation);
      const state = await this.state();
      // The shared pool database, created once and re-verified on every admission.
      const database = await this.options.database.ensure(this.paths.context, state.database ?? undefined);
      const admission: FactoryFleetHostAdmission = {
        installationId: installation.installationId, tenantId: installation.tenantId, harnessIdentity: factoryMeshIdentities(installation).harness,
        caCertificatePath: factoryPrivatePath(installation.secretDirectory, FACTORY_MESH_FILES.caCertificate),
      };
      const existing = state.admitted[installation.tenantId];
      if (existing && existing.installationId !== installation.installationId) throw new FactoryProvisioningError("host_admission_conflict", `Tenant ${installation.tenantId} is admitted under another installation.`);
      const next: FactoryFleetHostState = { ...state, database, admitted: { ...state.admitted, [installation.tenantId]: admission } };
      await this.saveState(next);
      await this.publish(next);
      return this.facts();
    });
  }

  /** Release an installation: its authority and identity leave both services' trust. Idempotent. */
  async release(installation: Pick<FactoryInstallationContext, "tenantId" | "installationId">): Promise<void> {
    await this.options.locked(async () => {
      const state = await this.state();
      const existing = state.admitted[installation.tenantId];
      if (!existing) return;
      if (existing.installationId !== installation.installationId) throw new FactoryProvisioningError("host_admission_conflict", `Tenant ${installation.tenantId} is admitted under another installation.`);
      const { [installation.tenantId]: _released, ...rest } = state.admitted;
      const next: FactoryFleetHostState = { ...state, admitted: rest };
      await this.saveState(next);
      if (Object.keys(rest).length === 0) await this.options.runtime.remove(this.paths);
      else await this.publish(next);
    });
  }

  /** Re-render and restart the host onto its current state, then wait for both services. */
  private async publish(state: FactoryFleetHostState): Promise<void> {
    const bundle = await this.render(state);
    await this.writeDeliveries(bundle);
    await this.options.runtime.apply(bundle);
    await this.options.runtime.ready(bundle);
  }

  /** The admitted installations, from the host's own record. */
  async admitted(): Promise<readonly FactoryFleetHostAdmission[]> {
    return Object.values((await this.state()).admitted).sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  }

  /** Render both services for a state. Every document passes its process's own parser. */
  async render(state?: FactoryFleetHostState): Promise<FactoryFleetHostBundle> {
    const current = state ?? await this.state();
    const admitted = Object.values(current.admitted).sort((a, b) => a.tenantId.localeCompare(b.tenantId));
    if (admitted.length === 0) throw new FactoryProvisioningError("host_nothing_admitted", "The fleet host serves no installation yet.");
    const [, poolPair] = factoryDatabasePairs(this.paths.context);
    const pool = parseFactoryPoolProcessConfig({
      // The parser still requires an installation field; the shared pool names its fleet. Readiness keys on poolId.
      schemaVersion: "factory.pool-process.v1", installationId: this.paths.context.installationId, poolId: this.identity.poolId,
      hostname: "0.0.0.0", port: this.identity.ports.pool,
      database: { credentialsPath: containerSecret("pool-database.json"), expectedDatabase: poolPair!.database, expectedRole: poolPair!.role },
      tls: { privateKeyPath: containerSecret(FACTORY_HOST_FILES.serverKey), certificatePath: containerSecret(FACTORY_HOST_FILES.serverCertificate), caPath: containerSecret(FACTORY_HOST_FILES.trustBundle) },
      tokens: { issuer: this.identity.issuer, audience: FACTORY_POOL_AUDIENCE, publicKeyPaths: { [FACTORY_MESH_TOKEN_KEY_ID]: containerSecret(FACTORY_HOST_FILES.tokenPublicKey) } },
      identities: {
        tenants: Object.fromEntries(admitted.map((entry) => [entry.harnessIdentity, { tenantId: entry.tenantId, tokenSubject: entry.tenantId }])),
        supervisors: { [this.identity.supervisor]: { supervisorId: this.identity.supervisor, tokenSubject: this.identity.supervisor, hostIds: [this.identity.hostId] } },
      },
      resources: { capacities: { cpu: this.options.settings.cpuCapacity }, gpuHosts: [], hosts: [this.identity.hostId] },
      readinessFilePath: "/run/ezcorp/readiness/pool/pool.json", readinessHeartbeatMs: 4_000,
    });
    const hostSecret = (name: string) => resolve(this.paths.supervisorDelivery, name);
    const supervisor = parseFactorySupervisorProcessConfig({
      schemaVersion: "factory.supervisor-process.v1", installationId: this.paths.context.installationId, hostId: this.identity.hostId,
      hostKeyPath: hostSecret(FACTORY_HOST_FILES.hostKey), hostKeyId: FACTORY_HOST_KEY_ID,
      runnerRoot: this.paths.runnerRoot, readinessFilePath: resolve(this.paths.readinessDirectory, "supervisor", "supervisor.json"), readinessHeartbeatMs: 4_000,
      services: {
        hostname: "127.0.0.1", port: this.identity.ports.supervisor, allowedPeers: admitted.map((entry) => entry.harnessIdentity),
        hostKeyIdPath: hostSecret(FACTORY_HOST_FILES.hostKeyId),
        tls: { caPath: hostSecret(FACTORY_HOST_FILES.trustBundle), certificatePath: hostSecret(FACTORY_HOST_FILES.serverCertificate), privateKeyPath: hostSecret(FACTORY_HOST_FILES.serverKey) },
        pool: {
          baseUrl: `https://127.0.0.1:${this.identity.ports.pool}`, serviceTokenPath: hostSecret(FACTORY_HOST_FILES.supervisorPoolToken),
          tls: { caPath: hostSecret(FACTORY_HOST_FILES.caCertificate), certificatePath: hostSecret(FACTORY_HOST_FILES.supervisorCertificate), privateKeyPath: hostSecret(FACTORY_HOST_FILES.supervisorKey) },
        },
      },
    });
    const source = (name: string) => factoryPrivatePath(this.paths.context.secretDirectory, name);
    return Object.freeze({
      identity: this.identity, paths: this.paths, admitted, build: current.build ?? this.options.settings.build, pool, supervisor,
      deliveries: {
        pool: { [FACTORY_HOST_FILES.serverCertificate]: source(FACTORY_HOST_FILES.serverCertificate), [FACTORY_HOST_FILES.serverKey]: source(FACTORY_HOST_FILES.serverKey), [FACTORY_HOST_FILES.tokenPublicKey]: source(FACTORY_HOST_FILES.tokenPublicKey) },
        supervisor: {
          [FACTORY_HOST_FILES.caCertificate]: source(FACTORY_HOST_FILES.caCertificate), [FACTORY_HOST_FILES.serverCertificate]: source(FACTORY_HOST_FILES.serverCertificate), [FACTORY_HOST_FILES.serverKey]: source(FACTORY_HOST_FILES.serverKey),
          [FACTORY_HOST_FILES.supervisorCertificate]: source(FACTORY_HOST_FILES.supervisorCertificate), [FACTORY_HOST_FILES.supervisorKey]: source(FACTORY_HOST_FILES.supervisorKey),
          [FACTORY_HOST_FILES.supervisorPoolToken]: source(FACTORY_HOST_FILES.supervisorPoolToken),
          [FACTORY_HOST_FILES.hostKey]: source(FACTORY_HOST_FILES.hostKey), [FACTORY_HOST_FILES.hostKeyId]: source(FACTORY_HOST_FILES.hostKeyId),
        },
      },
    });
  }

  /**
   * Write both deliveries in place: the pool's database URL and config, the
   * supervisor's config, and each service's trust bundle — the host authority
   * plus every admitted installation's authority.
   */
  private async writeDeliveries(bundle: FactoryFleetHostBundle): Promise<void> {
    const [, poolPair] = factoryDatabasePairs(this.paths.context);
    const secrets = await openFactoryPrivateDirectory(this.paths.context.secretDirectory);
    const trust: string[] = [];
    let credential: FactoryDatabaseCredential;
    try {
      trust.push(await readFactoryPrivateText(secrets, FACTORY_HOST_FILES.caCertificate));
      credential = await readFactoryPrivateJson<FactoryDatabaseCredential>(secrets, poolPair!.credentialFile);
    } finally { await secrets.close(); }
    for (const entry of bundle.admitted) trust.push(await readFactoryPrivatePath(entry.caCertificatePath).then((bytes) => new TextDecoder().decode(bytes)));
    const bundleText = `${trust.map((pem) => pem.trim()).join("\n")}\n`;
    const url = new URL("postgres://placeholder");
    url.hostname = this.options.settings.database.host; url.port = String(this.options.settings.database.port); url.pathname = `/${poolPair!.database}`;
    url.username = credential.role; url.password = credential.password;
    const write = async (directory: string, files: Readonly<Record<string, string>>, documents: Readonly<Record<string, string>>) => {
      await openFactoryPrivateDirectory(directory).then((handle) => handle.close());
      for (const [name, from] of Object.entries(files)) await replaceFactoryPrivateFile(resolve(directory, name), await readFactoryPrivatePath(from));
      for (const [name, text] of Object.entries(documents)) await replaceFactoryPrivateFile(resolve(directory, name), text);
    };
    await write(this.paths.poolDelivery, bundle.deliveries.pool, { [FACTORY_HOST_FILES.trustBundle]: bundleText, "pool-database.json": `${JSON.stringify({ databaseUrl: url.toString() })}\n`, "pool.json": `${JSON.stringify(bundle.pool)}\n` });
    await write(this.paths.supervisorDelivery, bundle.deliveries.supervisor, { [FACTORY_HOST_FILES.trustBundle]: bundleText, "supervisor.json": `${JSON.stringify(bundle.supervisor)}\n` });
    for (const writer of ["pool", "supervisor"]) await openFactoryPrivateDirectory(resolve(this.paths.readinessDirectory, writer)).then((handle) => handle.close());
    await openFactoryPrivateDirectory(this.paths.runnerRoot).then((handle) => handle.close());
  }

  /**
   * Move the shared pool and supervisor onto a build: a fleet upgrade's host
   * component, or its walk-back. A build already running is left alone, so
   * every installation after the first in a wave moves nothing here.
   */
  async useBuild(build: FactoryFleetHostBuild): Promise<void> {
    await this.options.locked(async () => {
      const state = await this.state();
      const current = state.build ?? this.options.settings.build;
      if (current.image === build.image && current.revision === build.revision && current.release === build.release) return;
      const next: FactoryFleetHostState = { ...state, build };
      await this.saveState(next);
      if (Object.keys(next.admitted).length > 0) await this.publish(next);
    });
  }

  /**
   * Stop the host and drop its pool database and role, leaving nothing of the
   * fleet on the cluster. Refused while any installation is admitted.
   */
  async decommission(): Promise<void> {
    await this.options.locked(async () => {
      const state = await this.state();
      if (Object.keys(state.admitted).length > 0) throw new FactoryProvisioningError("host_in_use", "The fleet host still serves installations; release them first.");
      await this.options.runtime.purge(this.paths);
      if (state.database) await this.options.database.purge(this.paths.context, state.database);
      await this.saveState({ ...state, database: null });
      await removeFactoryPrivateDirectory(this.paths.context.secretDirectory);
    });
  }
}
