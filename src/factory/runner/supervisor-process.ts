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
import type { Runner } from "@ezcorp/extension-contract";
import { privateDirectory, readPrivateBounded } from "../private-files";
import { startFactoryHostServices } from "./supervisor-services";
import { createFactorySupervisorPoolClient } from "./supervisor-pool-client";
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
  /**
   * Where this host publishes its launch and stop services.
   *
   * Optional, because a deployment whose container runner lives in the product
   * process runs the in-process runtime and this host publishes nothing. When
   * present every part is required: a port with no certificate cannot terminate
   * mutual TLS, and a stop route with no key id file cannot sign what it
   * observed. `hostKeyIdPath` is a FILE rather than the literal `hostKeyId`
   * above because the stop route reloads the pair per signature, which is what
   * makes key rotation work without restarting this process.
   */
  readonly services?: {
    readonly hostname: string;
    readonly port: number;
    /** mTLS peer identities allowed to launch or stop on this host. */
    readonly allowedPeers: readonly string[];
    readonly hostKeyIdPath: string;
    readonly tls: { readonly caPath: string; readonly certificatePath: string; readonly privateKeyPath: string };
    /**
     * The pool this supervisor tells that a guest's process group is gone.
     *
     * C03 releases a host's capacity only on a trusted supervisor's word, so a
     * signed stop receipt that never leaves this process is one the pool will
     * never honour and the product's own confirmation fails closed forever.
     * Optional because an installation may run this host against no pool at
     * all; when it is absent the stop route still signs, and the product still
     * reports its own refusal by name rather than looping in silence.
     */
    readonly pool?: {
      readonly baseUrl: string;
      readonly serviceTokenPath: string;
      readonly tls: { readonly caPath: string; readonly certificatePath: string; readonly privateKeyPath: string };
    };
  };
}

export interface FactorySupervisorProcessDependencies {
  /** Proves the host key loads. It is never returned, logged, or published. */
  readonly loadHostKey: (path: string) => Promise<void>;
  /**
   * Builds the runner probe this run owns. Called once, closed in the run's
   * `finally`, so the store lease is taken once and released once.
   */
  readonly createRunnerProbe: () => FactoryHostRunnerProbe;
  readonly createReadiness: (config: FactorySupervisorProcessConfig) => FactoryServiceReadinessWriter;
  /**
   * Binds the launch and stop listener this host publishes.
   *
   * A dependency rather than a direct call so a test can exercise the whole
   * lifecycle — bind after the first good probe, degrade when the bind fails,
   * release on stop — without a real certificate and a real port.
   */
  readonly startServices: (config: FactorySupervisorProcessConfig, runner: FactoryHostRunner) => Promise<{ stop(): void }>;
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly now: () => number;
}

export interface FactorySupervisorMainDependencies {
  readonly runConfigured: (configPath: string, signal: AbortSignal) => Promise<void>;
  readonly once: (event: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly removeListener: (event: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly fail: (error: unknown) => void;
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

/**
 * The host service section, exactly complete or entirely absent.
 *
 * Half a listener is not a listener: a port with no certificate refuses every
 * connection, and a peer list of length zero authorizes nobody, so both are
 * parse failures rather than a service that starts and turns everything away.
 */
function serviceSection(value: unknown): boolean {
  if (!record(value)) return false;
  const required = ["hostname", "port", "allowedPeers", "hostKeyIdPath", "tls"];
  const allowed = [...required, "pool"];
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.includes(key))) return false;
  if (!text(value.hostname) || !integer(value.port, 1, 65_535) || !text(value.hostKeyIdPath)) return false;
  if (!Array.isArray(value.allowedPeers) || value.allowedPeers.length < 1 || value.allowedPeers.length > 64
    || value.allowedPeers.some((peer) => !text(peer))) return false;
  if (value.pool !== undefined && !poolSection(value.pool)) return false;
  return tlsSection(value.tls);
}

const TLS_KEYS = ["caPath", "certificatePath", "privateKeyPath"];

function tlsSection(value: unknown): boolean {
  return record(value) && TLS_KEYS.every((key) => text(value[key])) && Object.keys(value).every((key) => TLS_KEYS.includes(key));
}

/** The supervisor's own pool credential: a base URL, a token file, and mutual TLS. */
function poolSection(value: unknown): boolean {
  if (!record(value)) return false;
  const required = ["baseUrl", "serviceTokenPath", "tls"];
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key))) return false;
  return text(value.baseUrl) && text(value.serviceTokenPath) && tlsSection(value.tls);
}

/** Strict parser. The document names paths and identities, never a key value. */
export function parseFactorySupervisorProcessConfig(value: unknown): FactorySupervisorProcessConfig {
  const required = ["schemaVersion", "installationId", "hostId", "hostKeyPath", "hostKeyId", "runnerRoot", "readinessFilePath"];
  const allowed = new Set([...required, "readinessHeartbeatMs", "services"]);
  if (!record(value) || required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))
    || value.schemaVersion !== CONFIG_SCHEMA
    || !text(value.installationId) || !text(value.hostId) || !text(value.hostKeyPath) || !text(value.hostKeyId)
    || !text(value.runnerRoot) || !text(value.readinessFilePath)
    || (value.readinessHeartbeatMs !== undefined && !integer(value.readinessHeartbeatMs, 1_000, 60_000))
    || (value.services !== undefined && !serviceSection(value.services))) {
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

/**
 * The container runner this process holds, and everything it is used for.
 *
 * It was `initialize`/`close` while the probe was the only caller. The host
 * launch and stop services run in this process now, so the same ONE instance
 * also starts, inspects, aborts, and cancels guests — which is why the probe
 * below hands the instance out rather than keeping it private. A second
 * instance would take the store lease again and fail `runner_store_busy`.
 */
export type FactoryHostRunner = Runner & {
  initialize(): Promise<void>;
  close(): Promise<void>;
};

export type FactoryHostRunnerLoader = () => Promise<new (options: { root: string }) => FactoryHostRunner>;

const loadPodmanRunner: FactoryHostRunnerLoader = async () => (await import("@ezcorp/extension-runner")).PodmanRunner as never;

/**
 * The host's runner, held for the process lifetime, and probed repeatedly.
 *
 * ONE instance, not one per heartbeat. `PodmanRunner.prepareStore` ends in
 * `acquireLease()`, which spawns a `flock --exclusive --nonblock` child that
 * holds the store lock for the instance's life. A second instance on the same
 * root therefore fails `runner_store_busy` deterministically from the second
 * probe onward, and every successful construction leaks one `flock` child.
 *
 * The first version built a runner per call and so did both: the supervisor
 * degraded on its second heartbeat and leaked a process per heartbeat before
 * that. Decoupling the heartbeat from the probe did not touch it, because the
 * fault is in the probe rather than in its latency, and a single-run proof
 * never observed the second call.
 *
 * Holding one instance makes the repeat a no-op by the runner's own design:
 * `prepare()` memoises with `this.ready ??= …`. A FAILED probe is not memoised
 * — the runner closes itself and clears `ready` — so a transient failure still
 * retries on the next heartbeat against the same instance.
 */
export interface FactoryHostRunnerProbe {
  /** Prove the runner answers. Real work once; a no-op after that. */
  probe(config: FactorySupervisorProcessConfig): Promise<void>;
  /**
   * The initialized instance, once a probe has succeeded.
   *
   * Undefined before the first successful probe, which is deliberate: the host
   * services must not be published by a process whose runner has not answered,
   * because a launch accepted by a broken runner is an attempt that reports a
   * start it never made.
   */
  instance(): FactoryHostRunner | undefined;
  /** Release the store lease, so the process leaves no `flock` child behind. */
  close(): Promise<void>;
}

export function factoryHostRunnerProbe(loadRunner: FactoryHostRunnerLoader = loadPodmanRunner): FactoryHostRunnerProbe {
  let runner: FactoryHostRunner | undefined;
  let answered: FactoryHostRunner | undefined;
  return {
    instance: () => answered,
    async probe(config: FactorySupervisorProcessConfig): Promise<void> {
      if (!runner) {
        const Runner = await loadRunner();
        runner = new Runner({ root: config.runnerRoot });
      }
      // `initialize()` is the one public entry that runs the fail-closed kernel
      // probe — rootless, seccomp, cgroup v2 controllers, deny-by-default
      // profile. It is also the only path W01 permits to sweep orphans, and a
      // daemon startup is exactly the caller that lesson names.
      await runner.initialize();
      answered = runner;
    },
    async close(): Promise<void> {
      const current = runner;
      runner = undefined;
      answered = undefined;
      await current?.close();
    },
  };
}

/**
 * Bind the host services from the configured material.
 *
 * The certificate, key, and CA are read through the same bounded private reader
 * the host key uses, so a world-readable server key is refused here rather than
 * becoming a listener anybody can impersonate.
 */
export async function startFactoryConfiguredHostServices(
  config: FactorySupervisorProcessConfig,
  runner: FactoryHostRunner,
): Promise<{ stop(): void }> {
  const services = config.services;
  if (services === undefined) throw new Error("factory supervisor host services are not configured");
  const [ca, cert, key] = await Promise.all([
    readPrivatePath(services.tls.caPath, MAX_KEY_BYTES),
    readPrivatePath(services.tls.certificatePath, MAX_KEY_BYTES),
    readPrivatePath(services.tls.privateKeyPath, MAX_KEY_BYTES),
  ]);
  const utf8 = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // Built before the listener binds, so an unreachable pool is a bind failure
  // that degrades this host by name rather than a listener that accepts stops
  // it cannot get honoured.
  const pool = services.pool === undefined ? undefined : await createFactorySupervisorPoolClient({
    hostId: config.hostId,
    baseUrl: services.pool.baseUrl,
    tls: {
      caPath: services.pool.tls.caPath,
      certificatePath: services.pool.tls.certificatePath,
      privateKeyPath: services.pool.tls.privateKeyPath,
      serviceTokenPath: services.pool.serviceTokenPath,
    },
  });
  return startFactoryHostServices({
    hostId: config.hostId,
    allowedPeers: services.allowedPeers,
    runner,
    signingKey: { hostId: config.hostId, privateKeyPath: config.hostKeyPath, keyIdPath: services.hostKeyIdPath },
    tls: { ca: utf8(ca), cert: utf8(cert), key: utf8(key) },
    hostname: services.hostname,
    port: services.port,
    ...(pool === undefined ? {} : { pool }),
  });
}

export const factorySupervisorProductionDependencies: FactorySupervisorProcessDependencies = {
  loadHostKey: loadFactoryHostKey,
  createRunnerProbe: () => factoryHostRunnerProbe(),
  startServices: startFactoryConfiguredHostServices,
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
  /** The launch and stop listener, bound. False when this host publishes none. */
  hostServicesReady: boolean;
  /** Whether this host is configured to publish them at all. */
  servicesConfigured: boolean;
  /** When every required fact was last observed TRUE. Zero means never. */
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
  runnerProbe: FactoryHostRunnerProbe,
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
      runnerProbe.probe(config).then(() => "observed" as const),
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
  const facts = { hostKeyReady: observation.hostKeyReady, runnerReady: observation.runnerReady, hostServicesReady: observation.hostServicesReady };
  if (!observation.attempted) return { lifecycle: "starting", facts };
  if (observation.errorCode !== undefined) return { lifecycle: "degraded", facts, errorCode: observation.errorCode };
  // A host that says it publishes launch and stop, and does not, is the exact
  // false readiness that lets a product open admission for guests nobody can
  // start. Configured-and-unbound degrades; configured-at-all is what makes the
  // fact required, so a host that publishes none is unaffected.
  if (observation.servicesConfigured && !observation.hostServicesReady) return { lifecycle: "degraded", facts, errorCode: "host_services_unavailable" };
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
  const servicesConfigured = config.services !== undefined;
  const observation: SupervisorObservation = { attempted: false, hostKeyReady: false, runnerReady: false, hostServicesReady: false, servicesConfigured, observedAtMs: 0 };
  const runnerProbe = dependencies.createRunnerProbe();
  let services: { stop(): void } | undefined;
  await readiness.write({ lifecycle: "starting", facts: { hostKeyReady: false, runnerReady: false, hostServicesReady: false } });

  const observing = (async () => {
    while (!signal.aborted) {
      const seen = await observeHost(config, dependencies, runnerProbe, timeoutMs, signal);
      if (signal.aborted) break;
      observation.attempted = true;
      observation.hostKeyReady = seen.hostKeyReady;
      observation.runnerReady = seen.runnerReady;
      observation.errorCode = seen.errorCode;
      // The listener is bound once, after the runner has answered, and it stays
      // bound: rebinding on every heartbeat would drop live connections, and
      // binding before the first good probe would publish a host that accepts
      // launches its runner cannot serve.
      const runner = runnerProbe.instance();
      if (servicesConfigured && services === undefined && seen.runnerReady && runner !== undefined) {
        try {
          services = await dependencies.startServices(config, runner);
        } catch {
          // Named, not swallowed: the record degrades with this code and the
          // next heartbeat tries again, because a port held by a dying sibling
          // frees itself and a certificate an operator fixes needs no restart.
          observation.errorCode = "host_services_unavailable";
        }
      }
      observation.hostServicesReady = services !== undefined;
      if (seen.hostKeyReady && seen.runnerReady && (!servicesConfigured || observation.hostServicesReady)) observation.observedAtMs = dependencies.now();
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
    // Release every held resource before recording the stop, so a supervisor
    // that has said `stopped` really is holding nothing: the listener first, so
    // no launch arrives for a runner that is closing, then the store lease.
    services?.stop();
    services = undefined;
    await runnerProbe.close();
    await readiness.write({ lifecycle: "stopped", facts: { hostKeyReady: false, runnerReady: false, hostServicesReady: false } });
  }
}

const productionMainDependencies: FactorySupervisorMainDependencies = {
  runConfigured: runConfiguredFactorySupervisor,
  once: (event, listener) => { process.once(event, listener); },
  removeListener: (event, listener) => { process.removeListener(event, listener); },
  // Printed BEFORE the exit code is set, because an empty log is the one
  // symptom a reader cannot act on. A silent exit 1 here cost a full
  // debugging round: the process refused its own configuration and said
  // nothing at all.
  fail: (error: unknown) => {
    console.error("[factory-supervisor] failed to start:", error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  },
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
