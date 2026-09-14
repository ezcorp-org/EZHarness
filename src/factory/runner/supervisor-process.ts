/**
 * The host supervisor process entry, and the readiness it publishes.
 *
 * C09 lists the host supervisor among the services that must be live before
 * product admission opens, and nothing published that fact: the orchestration
 * and pool processes each write a readiness record and the supervisor wrote
 * none, so the seventh probe had no producer and a flag-on installation could
 * never reach `ready`.
 *
 * What this process holds is exactly what C01 allows it to hold: its own host
 * identity and its own signing key. No tenant identity, no product database, no
 * object-store credential. It observes two facts about itself and publishes
 * them — the host key loads, and the container runner answers — and it
 * republishes on a heartbeat so a stopped supervisor stops reading as ready
 * within three windows.
 *
 * It is shaped like the other two host process entries (`pool/process.ts`,
 * `orchestration-process.ts`): a strict config parser, an abort-aware loop, and
 * a `finally` that records why it stopped.
 */
import { createPrivateKey } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateDirectory, readPrivateBounded } from "../private-files";
import {
  createFactoryServiceReadinessWriter,
  factorySupervisorReadinessOptions,
  type FactoryServiceReadinessWriter,
} from "../service-readiness";

const CONFIG_SCHEMA = "factory.supervisor-process.v1";
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_KEY_BYTES = 64 * 1024;

export interface FactorySupervisorProcessConfig {
  readonly schemaVersion: typeof CONFIG_SCHEMA;
  readonly installationId: string;
  readonly hostId: string;
  /** The host signing key. The only credential this process holds. */
  readonly hostKeyPath: string;
  readonly hostKeyId: string;
  /** The container runner's artifact store root on this host. */
  readonly runnerRoot: string;
  readonly readinessFilePath: string;
  readonly readinessHeartbeatMs?: number;
}

export interface FactorySupervisorProcessDependencies {
  /** Proves the host key loads. It is never returned, logged, or published. */
  readonly loadHostKey: (path: string) => Promise<void>;
  /** Proves the container runner answers on this host. */
  readonly probeRunner: (config: FactorySupervisorProcessConfig, signal: AbortSignal) => Promise<void>;
  readonly createReadiness: (config: FactorySupervisorProcessConfig) => FactoryServiceReadinessWriter;
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface FactorySupervisorMainDependencies {
  readonly runConfigured: (configPath: string, signal: AbortSignal) => Promise<void>;
  readonly once: (event: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly removeListener: (event: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly fail: () => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !value.includes("\0");
}

function integer(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

/** Strict parser. The document names paths and identities, never a key value. */
export function parseFactorySupervisorProcessConfig(value: unknown): FactorySupervisorProcessConfig {
  const required = ["schemaVersion", "installationId", "hostId", "hostKeyPath", "hostKeyId", "runnerRoot", "readinessFilePath"];
  const allowed = new Set([...required, "readinessHeartbeatMs"]);
  if (!record(value) || required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))
    || value.schemaVersion !== CONFIG_SCHEMA
    || !text(value.installationId) || !text(value.hostId) || !text(value.hostKeyPath) || !text(value.hostKeyId)
    || !text(value.runnerRoot) || !text(value.readinessFilePath)
    || (value.readinessHeartbeatMs !== undefined && !integer(value.readinessHeartbeatMs, 1_000, 60_000))) {
    throw new Error("factory supervisor config is invalid");
  }
  return value as unknown as FactorySupervisorProcessConfig;
}

async function readPrivatePath(path: string, maximum: number): Promise<Uint8Array> {
  const absolute = resolve(path);
  const directory = await privateDirectory(dirname(absolute));
  try {
    return await readPrivateBounded(directory, basename(absolute), maximum);
  } finally {
    await directory.close();
  }
}

/** Loads and discards the host key: the fact published is that it loads. */
export async function loadFactoryHostKey(path: string): Promise<void> {
  const bytes = await readPrivatePath(path, MAX_KEY_BYTES);
  createPrivateKey(Buffer.from(bytes));
}

/** The container runner the host supervisor probes, loaded on demand. */
export type FactoryHostRunnerLoader = () => Promise<new (options: { root: string }) => { initialize(): Promise<void> }>;

const loadPodmanRunner: FactoryHostRunnerLoader = async () => (await import("@ezcorp/extension-runner")).PodmanRunner as never;

/**
 * Prove the container runner answers on this host.
 *
 * `initialize()` is the one public entry that runs the fail-closed kernel probe
 * — rootless, seccomp, cgroup v2 controllers, deny-by-default profile. It is
 * also the only path W01 permits to sweep orphans, and a daemon startup is
 * exactly the caller that lesson names. `prepare` memoises inside the runner,
 * so a later heartbeat re-probes only after a failure rather than sweeping a
 * surviving guest again.
 *
 * The loader is a parameter so this is provable without a live container: the
 * fact under test is that the supervisor refuses to publish `ready` unless the
 * runner it is configured with initializes.
 */
export async function probeFactoryHostRunner(
  config: FactorySupervisorProcessConfig,
  loadRunner: FactoryHostRunnerLoader = loadPodmanRunner,
): Promise<void> {
  const Runner = await loadRunner();
  await new Runner({ root: config.runnerRoot }).initialize();
}

export const factorySupervisorProductionDependencies: FactorySupervisorProcessDependencies = {
  loadHostKey: loadFactoryHostKey,
  probeRunner: (config) => probeFactoryHostRunner(config),
  createReadiness: (config) => createFactoryServiceReadinessWriter(factorySupervisorReadinessOptions({
    installationId: config.installationId,
    hostId: config.hostId,
    readinessFilePath: config.readinessFilePath,
    ...(config.readinessHeartbeatMs === undefined ? {} : { readinessHeartbeatMs: config.readinessHeartbeatMs }),
  })),
  wait: (milliseconds, signal) => new Promise<void>((resolve_) => {
    if (signal.aborted) return resolve_();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve_();
    };
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
  }),
};

/**
 * Observe, publish, heartbeat, and record why it stopped.
 *
 * A failed observation publishes `degraded` with its own code rather than
 * simply not writing: a reader must be able to tell a supervisor that is down
 * from one that never started.
 */
export async function runConfiguredFactorySupervisor(
  configPath: string,
  signal: AbortSignal,
  dependencies: FactorySupervisorProcessDependencies = factorySupervisorProductionDependencies,
): Promise<void> {
  const bytes = await readPrivatePath(configPath, MAX_CONFIG_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("factory supervisor config is invalid");
  }
  const config = parseFactorySupervisorProcessConfig(parsed);
  const readiness = dependencies.createReadiness(config);
  const heartbeatMs = config.readinessHeartbeatMs ?? 5_000;
  let facts = { hostKeyReady: false, runnerReady: false };
  await readiness.write({ lifecycle: "starting", facts });

  try {
    while (!signal.aborted) {
      try {
        await dependencies.loadHostKey(config.hostKeyPath);
        facts = { ...facts, hostKeyReady: true };
        await dependencies.probeRunner(config, signal);
        facts = { hostKeyReady: true, runnerReady: true };
        await readiness.write({ lifecycle: "ready", facts });
      } catch {
        facts = { hostKeyReady: facts.hostKeyReady, runnerReady: false };
        await readiness.write({
          lifecycle: "degraded",
          facts,
          errorCode: facts.hostKeyReady ? "runner_unavailable" : "host_key_unavailable",
        });
      }
      await dependencies.wait(heartbeatMs, signal);
    }
  } finally {
    await readiness.write({ lifecycle: "stopped", facts: { hostKeyReady: false, runnerReady: false } });
  }
}

const productionMainDependencies: FactorySupervisorMainDependencies = {
  runConfigured: runConfiguredFactorySupervisor,
  once: (event, listener) => { process.once(event, listener); },
  removeListener: (event, listener) => { process.removeListener(event, listener); },
  fail: () => { process.exitCode = 1; },
};

export async function runFactorySupervisorMain(
  argv: readonly string[],
  dependencies: FactorySupervisorMainDependencies = productionMainDependencies,
): Promise<void> {
  const path = argv[2];
  if (!path || argv.length !== 3) throw new Error("factory supervisor config path is required");
  const controller = new AbortController();
  const stop = () => { controller.abort(new Error("factory supervisor received a stop signal")); };
  dependencies.once("SIGINT", stop);
  dependencies.once("SIGTERM", stop);
  try {
    await dependencies.runConfigured(path, controller.signal);
  } finally {
    dependencies.removeListener("SIGINT", stop);
    dependencies.removeListener("SIGTERM", stop);
  }
}

export function startFactorySupervisorMain(
  argv: readonly string[],
  moduleUrl: string,
  dependencies: FactorySupervisorMainDependencies = productionMainDependencies,
): void {
  if (argv[1] && resolve(argv[1]) === fileURLToPath(moduleUrl)) {
    void runFactorySupervisorMain(argv, dependencies).catch(dependencies.fail);
  }
}

startFactorySupervisorMain(process.argv, import.meta.url);
