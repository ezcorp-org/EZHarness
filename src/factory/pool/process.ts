import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { createSecureContext } from "node:tls";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { privateDirectory, readPrivateBounded } from "../private-files";
import { type FactoryPoolReadinessWriter, createFactoryPoolReadinessWriter } from "./readiness";
import type { PoolResourceClass, PoolSql } from "./ledger";
import { PoolAdmissionService, type PoolAdmissionIdentityConfig } from "./service";
import { startBunPoolAdmissionHttps, type BunPoolAdmissionHttpsOptions } from "./service-server";

const CONFIG_SCHEMA = "factory.pool-process.v1";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_PRIVATE_BYTES = 1024 * 1024;
const CAPACITY_CLASSES = ["cpu", "memory", "provider"] as const;

interface PoolDatabase extends PoolSql { close(): Promise<void> }
interface PoolListener { readonly url: string; stop(): void }

export interface FactoryPoolProcessConfig {
  readonly schemaVersion: typeof CONFIG_SCHEMA;
  readonly installationId: string;
  readonly poolId: string;
  readonly hostname: string;
  readonly port: number;
  readonly database: { readonly credentialsPath: string; readonly expectedDatabase: string; readonly expectedRole: string };
  readonly tls: { readonly privateKeyPath: string; readonly certificatePath: string; readonly caPath: string };
  readonly tokens: { readonly issuer: string; readonly audience: string; readonly publicKeyPaths: Readonly<Record<string, string>> };
  readonly identities: PoolAdmissionIdentityConfig;
  readonly resources: {
    readonly capacities: Readonly<Partial<Record<Exclude<PoolResourceClass, "gpu-host">, number>>>;
    readonly gpuHosts: readonly string[];
    /**
     * Hosts this pool's supervisors manage that are not whole-host allocations.
     *
     * The ledger records a host only for an allocation that binds a whole one,
     * so a CPU reservation has none and the pool tracks no such host. But C03
     * still settles a CPU stop only on a trusted supervisor's word, and that
     * supervisor must be authorized for the host it names — so without a place
     * to declare an ordinary host, a CPU-only installation could register no
     * supervisor at all and no CPU stop could ever settle. Measured end to end,
     * where every signed stop was refused with "cannot be acknowledged before a
     * supervisor confirms it".
     *
     * Declaring a host here grants nothing and allocates nothing. It only says
     * this host exists, so a supervisor may be authorized for it and a typo
     * still cannot be.
     */
    readonly hosts?: readonly string[];
  };
  readonly readinessFilePath: string;
  readonly readinessHeartbeatMs?: number;
}

export interface FactoryPoolProcessDependencies {
  readonly connect: (databaseUrl: string) => PoolDatabase;
  readonly start: (options: BunPoolAdmissionHttpsOptions) => Promise<PoolListener>;
  readonly readiness: (config: FactoryPoolProcessConfig) => FactoryPoolReadinessWriter;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface FactoryPoolMainDependencies {
  readonly runConfigured: (configPath: string, signal: AbortSignal) => Promise<void>;
  readonly once: (event: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly removeListener: (event: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly fail: () => void;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: object, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
}
function text(value: unknown, maximum = 512): value is string { return typeof value === "string" && value.length > 0 && value.length <= maximum && ![...value].some(character => character.codePointAt(0)! < 32); }
function integer(value: unknown, minimum: number, maximum: number): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum; }
function textRecord(value: unknown): value is Record<string, string> {
  return record(value) && Object.keys(value).length > 0 && Object.keys(value).length <= 256 && Object.entries(value).every(([key, item]) => text(key, 256) && text(item, 4_096));
}
function absolutePath(value: unknown): value is string { return text(value, 4_096) && resolve(value) === value; }
function identityConfig(value: unknown, knownHosts: ReadonlySet<string>): value is PoolAdmissionIdentityConfig {
  if (!record(value) || !exact(value, ["tenants", "supervisors"]) || !record(value.tenants) || !record(value.supervisors) || Object.keys(value.tenants).length < 1 || Object.keys(value.tenants).length > 10_000 || Object.keys(value.supervisors).length > 10_000) return false;
  const certificateNames = [...Object.keys(value.tenants), ...Object.keys(value.supervisors)];
  if (new Set(certificateNames).size !== certificateNames.length || certificateNames.some(name => !text(name, 256))) return false;
  const tenants = Object.values(value.tenants);
  if (tenants.some(item => !record(item) || !exact(item, ["tenantId", "tokenSubject"]) || !text(item.tenantId, 256) || !text(item.tokenSubject, 256))) return false;
  return Object.values(value.supervisors).every(item => record(item) && exact(item, ["supervisorId", "tokenSubject", "hostIds"]) && text(item.supervisorId, 256) && text(item.tokenSubject, 256) && Array.isArray(item.hostIds) && item.hostIds.length <= 10_000 && new Set(item.hostIds).size === item.hostIds.length && item.hostIds.every(host => typeof host === "string" && knownHosts.has(host)));
}

/** Strict reference-only configuration parser. */
export function parseFactoryPoolProcessConfig(value: unknown): FactoryPoolProcessConfig {
  const required = ["schemaVersion", "installationId", "poolId", "hostname", "port", "database", "tls", "tokens", "identities", "resources", "readinessFilePath"];
  if (!record(value) || !exact(value, required, ["readinessHeartbeatMs"]) || value.schemaVersion !== CONFIG_SCHEMA || !text(value.installationId) || !text(value.poolId) || !text(value.hostname, 253) || !integer(value.port, 1, 65_535) || !absolutePath(value.readinessFilePath) || value.readinessHeartbeatMs !== undefined && !integer(value.readinessHeartbeatMs, 1_000, 60_000)) throw new Error("factory pool config is invalid");
  const database = value.database;
  if (!record(database) || !exact(database, ["credentialsPath", "expectedDatabase", "expectedRole"]) || !absolutePath(database.credentialsPath) || !text(database.expectedDatabase, 256) || !text(database.expectedRole, 256)) throw new Error("factory pool config is invalid");
  const tls = value.tls;
  if (!record(tls) || !exact(tls, ["privateKeyPath", "certificatePath", "caPath"]) || Object.values(tls).some(path => !absolutePath(path))) throw new Error("factory pool config is invalid");
  const tokens = value.tokens;
  if (!record(tokens) || !exact(tokens, ["issuer", "audience", "publicKeyPaths"]) || !text(tokens.issuer, 512) || !text(tokens.audience, 512) || !textRecord(tokens.publicKeyPaths) || Object.values(tokens.publicKeyPaths).some(path => !absolutePath(path))) throw new Error("factory pool config is invalid");
  const resources = value.resources;
  if (!record(resources) || !exact(resources, ["capacities", "gpuHosts"], ["hosts"]) || !record(resources.capacities) || Object.keys(resources.capacities).some(key => !(CAPACITY_CLASSES as readonly string[]).includes(key)) || Object.values(resources.capacities).some(capacity => !integer(capacity, 0, 1_000_000)) || !Array.isArray(resources.gpuHosts) || resources.gpuHosts.length > 10_000 || resources.gpuHosts.some(host => !text(host, 256)) || new Set(resources.gpuHosts).size !== resources.gpuHosts.length || Object.values(resources.capacities).every(value => value === 0) && resources.gpuHosts.length === 0) throw new Error("factory pool config is invalid");
  const ordinaryHosts = resources.hosts;
  if (ordinaryHosts !== undefined && (!Array.isArray(ordinaryHosts) || ordinaryHosts.length > 10_000 || ordinaryHosts.some(host => !text(host, 256)) || new Set(ordinaryHosts).size !== ordinaryHosts.length)) throw new Error("factory pool config is invalid");
  const gpuHosts = new Set(resources.gpuHosts as string[]);
  // One host is either a whole-host allocation or an ordinary one, never both:
  // the first binds capacity and the second binds none, and a host declared as
  // each would be two different things under one name.
  if ((ordinaryHosts as string[] | undefined)?.some(host => gpuHosts.has(host))) throw new Error("factory pool config is invalid");
  const knownHosts = new Set([...gpuHosts, ...(ordinaryHosts as string[] | undefined ?? [])]);
  if (!identityConfig(value.identities, knownHosts)) throw new Error("factory pool config is invalid");
  return JSON.parse(JSON.stringify(value)) as FactoryPoolProcessConfig;
}

async function readPrivatePath(path: string, maximum: number): Promise<Uint8Array> {
  const absolute = resolve(path);
  const directory = await privateDirectory(dirname(absolute));
  try { return await readPrivateBounded(directory, basename(absolute), maximum); }
  finally { await directory.close(); }
}

function utf8(bytes: Uint8Array): string { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
function rows<Result>(value: unknown): Result[] {
  if (Array.isArray(value)) return value as Result[];
  if (record(value) && Array.isArray(value.rows)) return value.rows as Result[];
  throw new Error("factory pool database response is invalid");
}

async function databaseCredential(path: string): Promise<string> {
  try {
    const value = JSON.parse(utf8(await readPrivatePath(path, 16 * 1024))) as unknown;
    if (!record(value) || !exact(value, ["databaseUrl"]) || !text(value.databaseUrl, 8_192)) throw new Error();
    const url = new URL(value.databaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.pathname.length < 2) throw new Error();
    return value.databaseUrl;
  } catch { throw new Error("factory pool database credential is invalid"); }
}

async function loadMaterial(config: FactoryPoolProcessConfig): Promise<{ readonly databaseUrl: string; readonly tls: { key: string; cert: string; ca: string }; readonly publicKeys: Readonly<Record<string, string>> }> {
  try {
    const [databaseUrl, keyBytes, certBytes, caBytes, publicKeyEntries] = await Promise.all([
      databaseCredential(config.database.credentialsPath),
      readPrivatePath(config.tls.privateKeyPath, MAX_PRIVATE_BYTES),
      readPrivatePath(config.tls.certificatePath, MAX_PRIVATE_BYTES),
      readPrivatePath(config.tls.caPath, MAX_PRIVATE_BYTES),
      Promise.all(Object.entries(config.tokens.publicKeyPaths).map(async ([kid, path]) => [kid, utf8(await readPrivatePath(path, MAX_PRIVATE_BYTES))] as const)),
    ]);
    const tls = { key: utf8(keyBytes), cert: utf8(certBytes), ca: utf8(caBytes) };
    const certificate = new X509Certificate(tls.cert);
    if (!certificate.checkPrivateKey(createPrivateKey(tls.key))) throw new Error();
    if (!new X509Certificate(tls.ca).ca) throw new Error();
    createSecureContext(tls);
    const publicKeys = Object.fromEntries(publicKeyEntries);
    for (const key of Object.values(publicKeys)) {
      const parsed = createPublicKey(key);
      if (parsed.asymmetricKeyType !== "rsa" || (parsed.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048) throw new Error();
    }
    return { databaseUrl, tls, publicKeys: Object.freeze(publicKeys) };
  } catch { throw new Error("factory pool private material is invalid"); }
}

async function verifyDatabase(database: PoolDatabase, config: FactoryPoolProcessConfig): Promise<void> {
  const identity = rows<{ database: string; role: string }>(await database.unsafe("SELECT current_database()::text AS database, current_user::text AS role"))[0];
  if (!identity || identity.database !== config.database.expectedDatabase || identity.role !== config.database.expectedRole) throw new Error("factory pool database identity is invalid");
}

async function bindPoolIdentity(database: PoolDatabase, config: FactoryPoolProcessConfig): Promise<void> {
  await database.begin(async transaction => {
    await transaction.unsafe("SELECT pg_advisory_xact_lock(hashtext('factory-pool-process-identity-v1'))");
    await transaction.unsafe("CREATE TABLE IF NOT EXISTS factory_pool_identity(singleton boolean PRIMARY KEY DEFAULT TRUE CHECK(singleton), installation_id text NOT NULL, pool_id text NOT NULL)");
    await transaction.unsafe("INSERT INTO factory_pool_identity(singleton,installation_id,pool_id) VALUES(TRUE,$1,$2) ON CONFLICT(singleton) DO NOTHING", [config.installationId, config.poolId]);
    const identity = rows<{ installation_id: string; pool_id: string }>(await transaction.unsafe("SELECT installation_id,pool_id FROM factory_pool_identity WHERE singleton=TRUE FOR UPDATE"))[0];
    if (!identity || identity.installation_id !== config.installationId || identity.pool_id !== config.poolId) throw new Error("factory pool database identity is invalid");
  });
}

async function configureResources(database: PoolDatabase, service: PoolAdmissionService, config: FactoryPoolProcessConfig): Promise<void> {
  const existingResources = rows<{ resource_class: string }>(await database.unsafe("SELECT resource_class FROM factory_pool_resources ORDER BY resource_class"));
  const configuredResources = new Set([...Object.keys(config.resources.capacities), ...(config.resources.gpuHosts.length ? ["gpu-host"] : [])]);
  if (existingResources.some(row => !configuredResources.has(row.resource_class))) throw new Error("factory pool resource configuration conflicts with durable state");
  const existingHosts = rows<{ host_id: string }>(await database.unsafe("SELECT host_id FROM factory_pool_hosts ORDER BY host_id"));
  const configuredHosts = new Set(config.resources.gpuHosts);
  if (existingHosts.some(row => !configuredHosts.has(row.host_id))) throw new Error("factory pool resource configuration conflicts with durable state");
  for (const resourceClass of CAPACITY_CLASSES) {
    const total = config.resources.capacities[resourceClass];
    if (total !== undefined) await service.ledger.configureCapacity(resourceClass, total);
  }
  for (const hostId of config.resources.gpuHosts) await service.ledger.registerGpuHost({ hostId });
  const finalHosts = rows<{ host_id: string }>(await database.unsafe("SELECT host_id FROM factory_pool_hosts ORDER BY host_id"));
  if (finalHosts.length !== configuredHosts.size || finalHosts.some(row => !configuredHosts.has(row.host_id))) throw new Error("factory pool resource configuration conflicts with durable state");
}

function waitForHeartbeat(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, milliseconds);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}

const productionDependencies: FactoryPoolProcessDependencies = {
  connect: databaseUrl => new SQL(databaseUrl, { max: 8 }),
  start: startBunPoolAdmissionHttps,
  readiness: config => createFactoryPoolReadinessWriter(config),
  wait: waitForHeartbeat,
};

/** Runs the existing pool service from one private, reference-only config. */
export async function runConfiguredFactoryPoolProcess(configPath: string, signal: AbortSignal, dependencies: FactoryPoolProcessDependencies = productionDependencies): Promise<void> {
  let config: FactoryPoolProcessConfig;
  try { config = parseFactoryPoolProcessConfig(JSON.parse(utf8(await readPrivatePath(configPath, MAX_CONFIG_BYTES)))); }
  catch { throw new Error("factory pool config is unavailable"); }
  const readiness = dependencies.readiness(config);
  const heartbeatMs = config.readinessHeartbeatMs ?? 5_000;
  let database: PoolDatabase | undefined;
  let listener: PoolListener | undefined;
  let databaseReady = false;
  let schemaReady = false;
  let failureCode: string | undefined;
  let phase = "configuration_unavailable";
  await readiness.write({ lifecycle: "starting", databaseReady, schemaReady, listenerReady: false });
  try {
    const material = await loadMaterial(config);
    phase = "database_unavailable";
    database = dependencies.connect(material.databaseUrl);
    await verifyDatabase(database, config); databaseReady = true;
    await readiness.write({ lifecycle: "starting", databaseReady, schemaReady, listenerReady: false });
    await bindPoolIdentity(database, config);
    phase = "schema_unavailable";
    const service = new PoolAdmissionService(database);
    await service.setup();
    await configureResources(database, service, config); schemaReady = true;
    await readiness.write({ lifecycle: "starting", databaseReady, schemaReady, listenerReady: false });
    if (signal.aborted) return;
    phase = "listener_unavailable";
    listener = await dependencies.start({ hostname: config.hostname, port: config.port, tls: material.tls, identities: config.identities, tokens: { issuer: config.tokens.issuer, audience: config.tokens.audience, publicKeys: material.publicKeys }, service });
    await readiness.write({ lifecycle: "ready", databaseReady, schemaReady, listenerReady: true });
    while (!signal.aborted) {
      await (dependencies.wait ?? waitForHeartbeat)(heartbeatMs, signal);
      if (signal.aborted) break;
      try { await verifyDatabase(database, config); }
      catch { databaseReady = false; failureCode = "database_unavailable"; throw new Error(); }
      await readiness.write({ lifecycle: "ready", databaseReady, schemaReady, listenerReady: true });
    }
  } catch {
    failureCode ??= phase;
  } finally {
    try { listener?.stop(); } catch { failureCode ??= "listener_close_failed"; }
    try { await database?.close(); } catch { failureCode ??= "database_close_failed"; }
    if (failureCode === undefined) await readiness.write({ lifecycle: "stopped", databaseReady: false, schemaReady: false, listenerReady: false });
    else await readiness.write({ lifecycle: "degraded", databaseReady: false, schemaReady, listenerReady: false, errorCode: failureCode });
  }
  if (failureCode !== undefined) throw new Error(`factory pool process failed: ${failureCode}`);
}

const productionMainDependencies: FactoryPoolMainDependencies = {
  runConfigured: runConfiguredFactoryPoolProcess,
  once: (event, listener) => process.once(event, listener),
  removeListener: (event, listener) => process.removeListener(event, listener),
  fail: () => { process.exitCode = 1; },
};

export async function runFactoryPoolMain(argv: readonly string[], dependencies: FactoryPoolMainDependencies = productionMainDependencies): Promise<void> {
  const configPath = argv[2];
  if (!configPath || argv.length !== 3) throw new Error("factory pool config path is required");
  const controller = new AbortController();
  const stop = () => controller.abort();
  dependencies.once("SIGINT", stop); dependencies.once("SIGTERM", stop);
  try { await dependencies.runConfigured(configPath, controller.signal); }
  finally { dependencies.removeListener("SIGINT", stop); dependencies.removeListener("SIGTERM", stop); }
}

export function startFactoryPoolMain(argv: readonly string[], moduleUrl: string, dependencies: FactoryPoolMainDependencies = productionMainDependencies): void {
  if (argv[1] && resolve(argv[1]) === fileURLToPath(moduleUrl)) void runFactoryPoolMain(argv, dependencies).catch(dependencies.fail);
}

startFactoryPoolMain(process.argv, import.meta.url);
