/**
 * The tenant execution gateway as its own process (C12 step 5).
 *
 * `startFactoryExecutionGateway` existed with no production caller: the
 * product's readiness probed a gateway endpoint that only a proof harness's
 * stub ever answered. This entry composes the real one over the installation's
 * own database, so the listener the harness probes is the gateway a remote
 * runner reports to.
 *
 * It serves the four execution operations and no material routes: materials
 * need the object store, and a gateway that cannot reach one must refuse them
 * rather than half-serve them. Its blob store therefore refuses every call.
 *
 * It holds: the product database URL, the attempt-token secret it verifies
 * attempt tokens with, and its own TLS material. Nothing else.
 */
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateDirectory, readPrivateBounded } from "./private-files";

export const FACTORY_GATEWAY_PROCESS_SCHEMA = "factory.gateway-process.v1";

export interface FactoryGatewayProcessConfig {
  readonly schemaVersion: typeof FACTORY_GATEWAY_PROCESS_SCHEMA;
  readonly installationId: string;
  readonly tenantId: string;
  readonly hostname: string;
  readonly port: number;
  readonly tls: { readonly caPath: string; readonly certificatePath: string; readonly privateKeyPath: string };
  readonly attemptTokenSecretPath: string;
  readonly databaseUrlPath: string;
  readonly interpreterCompatibility: string;
}

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function identity(value: unknown): value is string { return typeof value === "string" && IDENTITY.test(value); }
function absolute(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4_096 && resolve(value) === value; }

export function parseFactoryGatewayProcessConfig(value: unknown): FactoryGatewayProcessConfig {
  const record = value as Partial<FactoryGatewayProcessConfig> | null;
  const keys = record && typeof record === "object" ? Object.keys(record).sort().join(",") : "";
  const tls = record?.tls as Partial<FactoryGatewayProcessConfig["tls"]> | undefined;
  if (keys !== "attemptTokenSecretPath,databaseUrlPath,hostname,installationId,interpreterCompatibility,port,schemaVersion,tenantId,tls" || record!.schemaVersion !== FACTORY_GATEWAY_PROCESS_SCHEMA
    || !identity(record!.installationId) || !identity(record!.tenantId) || !identity(record!.interpreterCompatibility)
    || typeof record!.hostname !== "string" || !/^[A-Za-z0-9.:-]{1,253}$/.test(record!.hostname) || !Number.isSafeInteger(record!.port) || record!.port! < 1 || record!.port! > 65_535
    || !tls || Object.keys(tls).sort().join(",") !== "caPath,certificatePath,privateKeyPath" || !absolute(tls.caPath) || !absolute(tls.certificatePath) || !absolute(tls.privateKeyPath)
    || !absolute(record!.attemptTokenSecretPath) || !absolute(record!.databaseUrlPath)) {
    throw new Error("factory gateway config is invalid");
  }
  return JSON.parse(JSON.stringify(record)) as FactoryGatewayProcessConfig;
}

async function readPrivateText(path: string, limit = 64 * 1024): Promise<string> {
  const directory = await privateDirectory(dirname(resolve(path)));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(await readPrivateBounded(directory, basename(path), limit)); }
  finally { await directory.close(); }
}

export interface FactoryGatewayListener { readonly url: string; stop(): void }

export interface FactoryGatewayProcessDependencies {
  readonly readText: (path: string) => Promise<string>;
  /** Opens the product database the way the product does, and composes the journal over it. */
  readonly start: (config: FactoryGatewayProcessConfig, material: { readonly databaseUrl: string; readonly attemptTokenSecret: string; readonly tls: { key: string; cert: string; ca: string } }) => Promise<FactoryGatewayListener & { close(): Promise<void> }>;
  readonly wait: (signal: AbortSignal) => Promise<void>;
}

export async function runFactoryGatewayProcess(configPath: string, signal: AbortSignal, dependencies: FactoryGatewayProcessDependencies): Promise<void> {
  const config = parseFactoryGatewayProcessConfig(JSON.parse(await dependencies.readText(configPath)));
  const [databaseUrl, attemptTokenSecret, key, cert, ca] = await Promise.all([
    dependencies.readText(config.databaseUrlPath), dependencies.readText(config.attemptTokenSecretPath),
    dependencies.readText(config.tls.privateKeyPath), dependencies.readText(config.tls.certificatePath), dependencies.readText(config.tls.caPath),
  ]);
  const listener = await dependencies.start(config, { databaseUrl: databaseUrl.trim(), attemptTokenSecret: attemptTokenSecret.trim(), tls: { key, cert, ca } });
  try { await dependencies.wait(signal); }
  finally { listener.stop(); await listener.close(); }
}

/** Refuses every call: this gateway serves no materials, so no path may reach a store. */
const refusingBlobs = {
  put: async (): Promise<string> => { throw new Error("factory gateway holds no object store"); },
  get: async (): Promise<Uint8Array> => { throw new Error("factory gateway holds no object store"); },
};

export const factoryGatewayProductionDependencies: FactoryGatewayProcessDependencies = {
  readText: (path) => readPrivateText(path),
  async start(config, material) {
    // The product's own connection module, so this process gets the same
    // driver normalisation and JSON fixes the product runs under. It reads
    // DATABASE_URL at module load, hence the late import.
    process.env.DATABASE_URL = material.databaseUrl;
    const connection = await import("../db/connection");
    await connection.initDb();
    const { createFactoryApplication } = await import("./application");
    const { startFactoryExecutionGateway } = await import("./execution-gateway");
    const database = connection.getDb();
    const application = createFactoryApplication({
      database, tenantId: config.tenantId, blobs: refusingBlobs, availableResourceClasses: ["cpu"],
      runOptions: { interpreterBuild: "factory-interpreter-1", interpreterCompatibility: config.interpreterCompatibility, limits: { maxCostMicros: "1000000", maxTokens: 1_000_000, maxComputeMs: 3_600_000 } },
    });
    const listener = startFactoryExecutionGateway({
      journal: application.journal,
      authorizeAttempt: (authority) => database.transaction((transaction: Parameters<typeof application.runs.authorizeAttemptInTransaction>[0]) => application.runs.authorizeAttemptInTransaction(transaction, authority)),
      jwtSecret: material.attemptTokenSecret, installationId: config.installationId,
      tls: material.tls, hostname: config.hostname, port: config.port,
    });
    return { url: listener.url, stop: () => listener.stop(), close: () => connection.closeDb() };
  },
  wait: (signal) => new Promise<void>((settle) => { if (signal.aborted) settle(); else signal.addEventListener("abort", () => settle(), { once: true }); }),
};

export async function startFactoryGatewayMain(argv: readonly string[], moduleUrl: string, dependencies: FactoryGatewayProcessDependencies = factoryGatewayProductionDependencies, fail: (error: unknown) => void = (error) => { console.error(`[gateway] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }): Promise<void> {
  if (!argv[1] || resolve(argv[1]) !== fileURLToPath(moduleUrl)) return;
  const configPath = argv[2];
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    if (!configPath || argv.length !== 3) throw new Error("factory gateway config path is required");
    await runFactoryGatewayProcess(configPath, controller.signal, dependencies);
  } catch (error) { fail(error); }
  finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}

void startFactoryGatewayMain(process.argv, import.meta.url);
