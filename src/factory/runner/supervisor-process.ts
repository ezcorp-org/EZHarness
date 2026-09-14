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
 *
 * ## The cadence contract, and why there are two loops
 *
 * The heartbeat write and the runner observation run on SEPARATE loops, and
 * that separation is the whole design. The first version awaited the Podman
 * probe between writes, so the interval between two records was
 * `probeLatency + heartbeatMs` while the reader accepts a record only within
 * `heartbeatMs * 3`. The probe creates a container, so on a loaded host it
 * could exceed the window on its own and every record arrived already stale —
 * a live supervisor that reads as dead, intermittently, depending on how busy
 * the box is.
 *
 * All four numbers are multiples of one configured heartbeat, so the margins
 * are stateable rather than coincidental:
 *
 * | Interval | Value | Why |
 * | --- | --- | --- |
 * | Heartbeat write | `heartbeatMs` | never waits for a probe |
 * | Reader freshness window | `heartbeatMs * 3` | tolerates two missed writes |
 * | Probe bound | `heartbeatMs * 4` | a probe may legitimately outlast a write |
 * | Facts go stale | `heartbeatMs * 5` | the bound plus one full cycle |
 *
 * The record therefore always says what was last actually OBSERVED: a probe
 * that hangs does not delay the heartbeat, and it does not let the heartbeat
 * keep asserting a fact nobody is still checking either — once the last
 * successful observation is older than the staleness bound, the published
 * record degrades.
 */
import { createPrivateKey } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateDirectory, readPrivateBounded } from "../private-files";
import {
  createFactoryServiceReadinessWriter,
  factorySupervisorReadinessOptions,
  type FactoryServiceReadinessUpdate,
  type FactoryServiceReadinessWriter,
} from "../service-readiness";

const CONFIG_SCHEMA = "factory.supervisor-process.v1";

/** A probe may outlast a write, but not without bound. Multiples of the heartbeat. */
export const FACTORY_SUPERVISOR_PROBE_TIMEOUT_HEARTBEATS = 4;
/** The probe bound plus one full cycle. After this the facts are not current. */
export const FACTORY_SUPERVISOR_FACT_STALENESS_HEARTBEATS = 5;
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
  readonly now: () => number;
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
  now: Date.now,
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

interface SupervisorObservation {
  /** Whether an observation has been attempted at all. */
  attempted: boolean;
  hostKeyReady: boolean;
  runnerReady: boolean;
  /** When both facts were last observed TRUE. Zero means never. */
  observedAtMs: number;
  errorCode?: string;
}

/**
 * One bounded observation of this host.
 *
 * The probe is raced against its bound rather than trusted to return. A probe
 * that wins the race is a real observation; a bound that wins it is a failed
 * one, and the derived controller cancels the probe so a hung container
 * inspection does not outlive the cycle that asked for it.
 */
async function observeHost(
  config: FactorySupervisorProcessConfig,
  dependencies: FactorySupervisorProcessDependencies,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Pick<SupervisorObservation, "hostKeyReady" | "runnerReady" | "errorCode">> {
  let hostKeyReady = false;
  const controller = new AbortController();
  const stop = () => { controller.abort(signal.reason ?? new Error("factory supervisor observation stopped")); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    await dependencies.loadHostKey(config.hostKeyPath);
    hostKeyReady = true;
    const bounded = await Promise.race([
      dependencies.probeRunner(config, controller.signal).then(() => "observed" as const),
      dependencies.wait(timeoutMs, controller.signal).then(() => "elapsed" as const),
    ]);
    // A wait that ended because the process is stopping is not a timed-out probe.
    if (bounded === "elapsed" && !signal.aborted) return { hostKeyReady, runnerReady: false, errorCode: "runner_probe_timeout" };
    if (bounded === "elapsed") return { hostKeyReady, runnerReady: false, errorCode: "runner_unavailable" };
    return { hostKeyReady, runnerReady: true };
  } catch {
    return { hostKeyReady, runnerReady: false, errorCode: hostKeyReady ? "runner_unavailable" : "host_key_unavailable" };
  } finally {
    controller.abort(new Error("factory supervisor observation finished"));
    signal.removeEventListener("abort", stop);
  }
}

/**
 * What the heartbeat publishes, given the last observation and how old it is.
 *
 * Four states, and the distinction that matters is between a supervisor that
 * has not looked yet and one that looked and did not like what it saw. A reader
 * must be able to tell those apart, so `starting` means no observation has been
 * attempted and never carries a reason.
 */
export function factorySupervisorRecord(
  observation: SupervisorObservation,
  nowMs: number,
  stalenessMs: number,
): FactoryServiceReadinessUpdate {
  const facts = { hostKeyReady: observation.hostKeyReady, runnerReady: observation.runnerReady };
  if (!observation.attempted) return { lifecycle: "starting", facts };
  if (observation.errorCode !== undefined) return { lifecycle: "degraded", facts, errorCode: observation.errorCode };
  // Both facts were observed true. A heartbeat never keeps asserting a fact
  // nobody is still checking, so an observation that ages out degrades even
  // though the last thing it saw was good.
  if (nowMs - observation.observedAtMs > stalenessMs) return { lifecycle: "degraded", facts, errorCode: "observation_stale" };
  return { lifecycle: "ready", facts };
}

/**
 * Observe on one cadence, publish on another, and record why it stopped.
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
  const timeoutMs = heartbeatMs * FACTORY_SUPERVISOR_PROBE_TIMEOUT_HEARTBEATS;
  const stalenessMs = heartbeatMs * FACTORY_SUPERVISOR_FACT_STALENESS_HEARTBEATS;
  const observation: SupervisorObservation = { attempted: false, hostKeyReady: false, runnerReady: false, observedAtMs: 0 };
  await readiness.write({ lifecycle: "starting", facts: { hostKeyReady: false, runnerReady: false } });

  const observing = (async () => {
    while (!signal.aborted) {
      const seen = await observeHost(config, dependencies, timeoutMs, signal);
      if (signal.aborted) break;
      observation.attempted = true;
      observation.hostKeyReady = seen.hostKeyReady;
      observation.runnerReady = seen.runnerReady;
      observation.errorCode = seen.errorCode;
      if (seen.hostKeyReady && seen.runnerReady) observation.observedAtMs = dependencies.now();
      await dependencies.wait(heartbeatMs, signal);
    }
  })();

  const publishing = (async () => {
    while (!signal.aborted) {
      await readiness.write(factorySupervisorRecord(observation, dependencies.now(), stalenessMs));
      await dependencies.wait(heartbeatMs, signal);
    }
  })();

  try {
    // Neither loop may outlive the other: a publisher without an observer would
    // heartbeat a fact nobody is checking, and an observer without a publisher
    // would see the host and tell nobody.
    await Promise.all([observing, publishing]);
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
