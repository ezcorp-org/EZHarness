import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runFactoryOrchestratorProcess,
  type FactoryOrchestratorProcessOptions,
  type FactoryTemporalProcessOptions,
  type TemporalCredentials,
} from "../../packages/@ezcorp/factory-orchestrator/src/process.ts";
import type { GatewayTransportOptions } from "../../packages/@ezcorp/factory-transport/src/index.ts";
import type { TemporalPayloadCodec as PayloadCodec } from "./encryption.ts";
import { loadFactoryTemporalPayloadCodec, type FactoryTemporalPayloadCodecFileConfig } from "./file-key-wraps.ts";
import { createFactoryOrchestrationReadinessWriter } from "./orchestration-readiness-writer.ts";
import { privateDirectory, readPrivateBounded } from "./private-files.ts";

const CONFIG_SCHEMA = "factory.orchestrator-process.v1";
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_CREDENTIAL_BYTES = 1024 * 1024;

export interface FactoryOrchestratorProcessConfig {
  readonly schemaVersion: typeof CONFIG_SCHEMA;
  readonly installationId: string;
  readonly tenantId: string;
  readonly temporal: FactoryTemporalProcessOptions;
  readonly gateway: GatewayTransportOptions;
  readonly codec: Omit<FactoryTemporalPayloadCodecFileConfig, "installationId" | "tenantId">;
  readonly readinessFilePath: string;
  readonly readinessHeartbeatMs?: number;
  readonly dispatchEmptyDelayMs?: number;
}

export interface FactoryOrchestratorLauncherDependencies {
  readonly loadCodec: (config: FactoryTemporalPayloadCodecFileConfig) => Promise<PayloadCodec>;
  readonly run: (options: FactoryOrchestratorProcessOptions) => Promise<void>;
}

export interface FactoryOrchestratorMainDependencies {
  readonly runConfigured: (configPath: string, signal: AbortSignal) => Promise<void>;
  readonly once: (event: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly removeListener: (event: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly fail: (error: unknown) => void;
}

function exact(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalKeys(value: object, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\0");
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

/** Strict config parser. The document contains references and no credential values. */
export function parseFactoryOrchestratorProcessConfig(value: unknown): FactoryOrchestratorProcessConfig {
  const rootRequired = ["schemaVersion", "installationId", "tenantId", "temporal", "gateway", "codec", "readinessFilePath"];
  if (!record(value) || !optionalKeys(value, rootRequired, ["readinessHeartbeatMs", "dispatchEmptyDelayMs"])
    || value.schemaVersion !== CONFIG_SCHEMA || !text(value.installationId) || !text(value.tenantId) || !text(value.readinessFilePath)
    || (value.readinessHeartbeatMs !== undefined && !integer(value.readinessHeartbeatMs, 1_000, 60_000))
    || (value.dispatchEmptyDelayMs !== undefined && !integer(value.dispatchEmptyDelayMs, 10, 5_000))) throw new Error("factory orchestrator config is invalid");

  const temporal = value.temporal;
  const temporalRequired = ["address", "namespace", "serverName", "caPath", "certificatePath", "privateKeyPath", "apiKeyPath"];
  if (!record(temporal) || !optionalKeys(temporal, temporalRequired, ["credentialRefreshMs", "pollingProbeTimeoutMs"])
    || temporalRequired.some((key) => !text(temporal[key]))
    || (temporal.credentialRefreshMs !== undefined && !integer(temporal.credentialRefreshMs, 1_000, 60_000))
    || (temporal.pollingProbeTimeoutMs !== undefined && !integer(temporal.pollingProbeTimeoutMs, 1_000, 60_000))) throw new Error("factory orchestrator config is invalid");

  const gateway = value.gateway;
  if (!record(gateway) || !optionalKeys(gateway, ["baseUrl", "tls"], ["serverName", "requestTimeoutMs"])
    || !text(gateway.baseUrl) || (gateway.serverName !== undefined && !text(gateway.serverName))
    || (gateway.requestTimeoutMs !== undefined && !integer(gateway.requestTimeoutMs, 100, 60_000)) || !record(gateway.tls)
    || !exact(gateway.tls, ["caPath", "certificatePath", "privateKeyPath", "serviceTokenPath"])
    || Object.values(gateway.tls).some((item) => !text(item))) throw new Error("factory orchestrator config is invalid");

  const codec = value.codec;
  if (!record(codec) || !exact(codec, ["wrappedKeyFilePath", "masterKeyFilePath", "masterKeyId", "grantableRoots"])
    || !text(codec.wrappedKeyFilePath) || !text(codec.masterKeyFilePath) || !text(codec.masterKeyId)
    || !Array.isArray(codec.grantableRoots) || codec.grantableRoots.length < 1 || codec.grantableRoots.length > 32
    || codec.grantableRoots.some((item) => !text(item))) throw new Error("factory orchestrator config is invalid");
  return value as unknown as FactoryOrchestratorProcessConfig;
}

async function readPrivatePath(path: string, maximum: number): Promise<Uint8Array> {
  const absolute = resolve(path);
  const directory = await privateDirectory(dirname(absolute));
  try { return await readPrivateBounded(directory, basename(absolute), maximum); }
  finally { await directory.close(); }
}

export async function loadFactoryTemporalCredentials(options: FactoryTemporalProcessOptions): Promise<TemporalCredentials> {
  const [ca, certificate, privateKey, apiKeyBytes] = await Promise.all([
    readPrivatePath(options.caPath, MAX_CREDENTIAL_BYTES),
    readPrivatePath(options.certificatePath, MAX_CREDENTIAL_BYTES),
    readPrivatePath(options.privateKeyPath, MAX_CREDENTIAL_BYTES),
    readPrivatePath(options.apiKeyPath, 16 * 1024),
  ]);
  const apiKey = new TextDecoder("utf-8", { fatal: true }).decode(apiKeyBytes).trim();
  if (!apiKey || apiKey.includes("\0")) throw new Error("factory temporal API key is invalid");
  const tlsFingerprint = createHash("sha256").update(ca).update(certificate).update(privateKey).digest("hex");
  return { ca: Buffer.from(ca), certificate: Buffer.from(certificate), privateKey: Buffer.from(privateKey), apiKey, tlsFingerprint };
}

export async function runConfiguredFactoryOrchestrator(
  configPath: string,
  signal: AbortSignal,
  dependencies: FactoryOrchestratorLauncherDependencies = { loadCodec: loadFactoryTemporalPayloadCodec, run: runFactoryOrchestratorProcess },
): Promise<void> {
  const bytes = await readPrivatePath(configPath, MAX_CONFIG_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("factory orchestrator config is invalid"); }
  const config = parseFactoryOrchestratorProcessConfig(parsed);
  const payloadCodec = await dependencies.loadCodec({ installationId: config.installationId, tenantId: config.tenantId, ...config.codec });
  const readiness = createFactoryOrchestrationReadinessWriter({
    installationId: config.installationId, tenantId: config.tenantId, namespace: config.temporal.namespace,
    taskQueue: "factory-orchestrator", readinessFilePath: config.readinessFilePath, readinessHeartbeatMs: config.readinessHeartbeatMs,
  });
  await dependencies.run({
    installationId: config.installationId, tenantId: config.tenantId, temporal: config.temporal, gateway: config.gateway,
    payloadCodec, loadTemporalCredentials: () => loadFactoryTemporalCredentials(config.temporal), readiness,
    readinessHeartbeatMs: config.readinessHeartbeatMs, dispatchEmptyDelayMs: config.dispatchEmptyDelayMs, signal,
  });
}

const productionMainDependencies: FactoryOrchestratorMainDependencies = {
  runConfigured: runConfiguredFactoryOrchestrator,
  once: (event, listener) => process.once(event, listener),
  removeListener: (event, listener) => process.removeListener(event, listener),
  // Printed BEFORE the exit code is set, because an empty log is the one
  // symptom a reader cannot act on. A silent exit 1 here cost a full
  // debugging round: the process refused its own configuration and said
  // nothing at all.
  fail: (error: unknown) => {
    console.error("[factory-orchestrator] failed to start:", error instanceof Error ? (error.stack ?? error.message) : String(error));
    const cause = (error as { cause?: unknown } | undefined)?.cause;
    if (cause !== undefined) console.error("[factory-orchestrator] caused by:", cause instanceof Error ? (cause.stack ?? cause.message) : String(cause));
    process.exitCode = 1;
  },
};

export async function runFactoryOrchestratorMain(
  argv: readonly string[],
  dependencies: FactoryOrchestratorMainDependencies = productionMainDependencies,
): Promise<void> {
  const path = argv[2];
  if (!path || argv.length !== 3) throw new Error("factory orchestrator config path is required");
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("factory orchestrator received a stop signal"));
  dependencies.once("SIGINT", stop);
  dependencies.once("SIGTERM", stop);
  try { await dependencies.runConfigured(path, controller.signal); }
  finally { dependencies.removeListener("SIGINT", stop); dependencies.removeListener("SIGTERM", stop); }
}

export function startFactoryOrchestratorMain(
  argv: readonly string[],
  moduleUrl: string,
  dependencies: FactoryOrchestratorMainDependencies = productionMainDependencies,
): void {
  if (argv[1] && resolve(argv[1]) === fileURLToPath(moduleUrl)) {
    void runFactoryOrchestratorMain(argv, dependencies).catch(dependencies.fail);
  }
}

startFactoryOrchestratorMain(process.argv, import.meta.url);
