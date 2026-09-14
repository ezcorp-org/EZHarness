/**
 * The factory composition root: validated configuration in, a started runtime
 * or a named refusal out.
 *
 * Before this file, `createFactoryApplication` and `assertFactoryBootReadiness`
 * both existed and neither was ever called by production code. The factory had
 * a composition root shaped hole: stores that nothing built, a readiness gate
 * whose service list nothing produced, and a set of durable primitives that
 * nothing drove. This is that root.
 *
 * The order is the whole point, so it is stated once here and enforced below:
 *
 *   1. Refuse early when the flag is off. No service starts, and the API
 *      answers C09's documented 404 through `factoryBootConfig` alone.
 *   2. Validate the configuration, naming every missing dependency at once.
 *   3. Validate the boot prerequisites — external PostgreSQL, installation
 *      identity, a secrets directory outside every grantable root.
 *   4. Build the encrypted stores and the roles, but open nothing to product
 *      traffic.
 *   5. Probe every required service for real.
 *   6. Only then call `configureFactoryApplication`, which is the moment
 *      admission opens. A probe failure leaves it null and the API answers 503.
 *   7. Start the background roles, each owning its own stop signal.
 *
 * Teardown is the reverse, and it awaits each step: workers first so no step
 * is abandoned mid-lease, then the listeners, then the application handle.
 */
import { setReadiness } from "../readiness";
import type { TransactionalDb } from "../db/migrations/types";
import { assertFactoryBootConfiguration, assertFactoryBootReadiness, factoryBootConfig, FactoryBootError, type FactoryBootConfig, type FactoryService } from "./boot";
import { configureFactoryApplication, createFactoryApplication, type FactoryApplication, type FactoryApplicationOptions } from "./application";
import { parseFactoryStartupConfig, type FactoryStartupConfig } from "./startup-config";
import {
  availableFactoryServices,
  factoryGatewayProbe,
  factoryOrchestrationProbes,
  factoryPoolProbe,
  factorySandboxProbe,
  factoryStorageProbe,
  factorySupervisorProbe,
  factorySupervisorReadinessProbe,
  probeFactoryServices,
  unavailableFactoryServices,
  type FactoryListenerProbeTarget,
  type FactoryServiceProbe,
  type FactoryServiceProbeResult,
  type FactoryStorageProbeTarget,
  type FactorySupervisorProbeTarget,
} from "./service-probes";
import { factoryRuntimeSeams, factorySeamStates, type FactoryRuntimeSeamInputs, type FactoryRuntimeSeams, type FactorySeamState } from "./runtime-seams";
import { registerFactoryRuntimeWorkers, type FactoryHeldWorker, type FactoryRuntimeWorkerCollaborators } from "./runtime-workers";
import type { FactoryBackgroundWorkers, FactoryBackgroundWorkerState } from "./background-workers";

/** A started listener the composition owns and must stop. */
export interface FactoryStartedListener {
  readonly url: string;
  stop(): void;
}

/**
 * Everything the composition needs that is not in the configuration document:
 * the already-open database, the already-built roles, and the probe targets.
 *
 * Passed in rather than constructed here because each one belongs to another
 * owner — the database to the host process, the gateway and supervisor to W01,
 * the storage to W04/W04a — and a composition root that reached into those
 * files would own them by accident.
 */
export interface FactoryRuntimeDependencies {
  readonly database: TransactionalDb;
  readonly application: Omit<FactoryApplicationOptions, "database" | "tenantId">;
  readonly listeners: readonly FactoryStartedListener[];
  readonly storage: FactoryStorageProbeTarget;
  readonly gateway: FactoryListenerProbeTarget;
  /** Present only when this process holds the container runner. */
  readonly supervisor?: FactorySupervisorProbeTarget;
  readonly workers: Omit<FactoryRuntimeWorkerCollaborators, "service" | "seams" | "tuning" | "report">;
  readonly service: FactoryRuntimeWorkerCollaborators["service"];
  readonly seams?: FactoryRuntimeSeamInputs;
  readonly report: (role: string, error: unknown) => void;
  /** Additional probes a deployment adds. Never replaces a required one. */
  readonly extraProbes?: readonly FactoryServiceProbe[];
  /**
   * The model pin's secret-free readiness record, when this installation pins
   * one. It rides on `/api/ready` rather than on the seven required services,
   * because a model pin is not a service every installation must have: an
   * installation that runs no model-calling guest needs none, and making it
   * required would fail a correct deployment.
   */
  readonly providerReadiness?: Record<string, unknown>;
}

export interface FactoryRuntimeReport {
  readonly tenantId: string;
  readonly installationId: string;
  readonly admissionOpen: boolean;
  readonly probes: readonly FactoryServiceProbeResult[];
  readonly seams: readonly FactorySeamState[];
  readonly heldWorkers: readonly FactoryHeldWorker[];
  readonly workers: readonly FactoryBackgroundWorkerState[];
}

export interface FactoryRuntime {
  readonly application: FactoryApplication;
  readonly config: FactoryStartupConfig;
  readonly seams: FactoryRuntimeSeams;
  /**
   * The registered roles, so an operator surface can inspect one and a test can
   * drive a single bounded pass without waiting on a timer.
   */
  readonly workers: FactoryBackgroundWorkers;
  report(): FactoryRuntimeReport;
  /** Reverse of startup, awaiting every step. Idempotent. */
  stop(): Promise<void>;
}

/** The flag is off, so no factory service exists and the API answers 404. */
export class FactoryDisabledError extends Error {
  readonly code = "factory-disabled";
  constructor() {
    super("Factories are disabled; no factory service starts.");
    this.name = "FactoryDisabledError";
  }
}

function requiredProbes(config: FactoryStartupConfig, dependencies: FactoryRuntimeDependencies, boot: FactoryBootConfig): readonly FactoryServiceProbe[] {
  const identity = {
    installationId: config.installationId,
    tenantId: config.tenantId,
    poolId: config.poolId,
    temporalNamespace: config.temporalNamespace,
    orchestrationReadinessFilePath: config.orchestrationReadinessFilePath,
    poolReadinessFilePath: config.poolReadinessFilePath,
    supervisorReadinessFilePath: config.supervisorReadinessFilePath,
    hostId: config.hostId,
    ...(config.readinessHeartbeatMs === undefined ? {} : { readinessHeartbeatMs: config.readinessHeartbeatMs }),
  };
  return Object.freeze([
    ...factoryOrchestrationProbes(identity),
    factoryPoolProbe(identity),
    factoryStorageProbe(dependencies.storage, `${config.storage.ordinary.prefix}/readiness/${config.installationId}`),
    factoryGatewayProbe(dependencies.gateway),
    // A deployment that holds a runner in this process can preflight it; every
    // other deployment reads the record the host supervisor publishes.
    dependencies.supervisor ? factorySupervisorProbe(dependencies.supervisor) : factorySupervisorReadinessProbe(identity),
    factorySandboxProbe(boot),
    ...(dependencies.extraProbes ?? []),
  ]);
}

/**
 * Compose, probe, and start. Admission opens on the last line, never earlier.
 *
 * Every failure path stops what it already started. A composition that threw
 * with a listener still bound would leak exactly the processes the pass
 * sentence requires it not to leak.
 */
export async function startFactoryRuntime(
  document: unknown,
  databaseUrl: string | undefined,
  dependencies: FactoryRuntimeDependencies,
  signal: AbortSignal,
  boot: FactoryBootConfig = factoryBootConfig,
): Promise<FactoryRuntime> {
  if (!boot.enabled) throw new FactoryDisabledError();

  // Configuration first: a missing dependency is named before anything binds a
  // port or opens a credential file.
  const config = parseFactoryStartupConfig(document);
  // Then the boot prerequisites, which name PGlite, the installation identity,
  // and a secrets directory inside a grantable root. Only the CONFIGURATION
  // half runs here: the readiness half needs a probe result, and calling it
  // with an empty available set would report every service as down before a
  // single probe had run.
  assertFactoryBootConfiguration(databaseUrl, { ...boot, installationId: config.installationId });

  const seams = factoryRuntimeSeams(dependencies.seams);
  const probes = requiredProbes(config, dependencies, boot);
  const results = await probeFactoryServices(probes, signal);
  const available = availableFactoryServices(results);

  const workerSet = registerFactoryRuntimeWorkers({
    ...dependencies.workers,
    service: dependencies.service,
    seams,
    ...(config.workers === undefined ? {} : { tuning: config.workers }),
    report: dependencies.report,
  });

  let admissionOpen = false;
  const stopListeners = () => { for (const listener of dependencies.listeners) listener.stop(); };
  const report = (): FactoryRuntimeReport => Object.freeze({
    tenantId: config.tenantId,
    installationId: config.installationId,
    admissionOpen,
    probes: results,
    seams: factorySeamStates(seams),
    heldWorkers: workerSet.held,
    workers: workerSet.workers.states(),
  });

  try {
    // Admission stays closed until every required probe passed. This is the
    // call the readiness gate was written for and never received.
    assertFactoryBootReadiness(databaseUrl, available, { ...boot, installationId: config.installationId });
  } catch (error) {
    stopListeners();
    await workerSet.workers.stop();
    if (error instanceof FactoryBootError) {
      setReadiness({ state: "degraded", reason: error.code, detail: { unavailable: unavailableFactoryServices(results) } });
    }
    throw error;
  }

  const application = createFactoryApplication({
    ...dependencies.application,
    database: dependencies.database,
    tenantId: config.tenantId,
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // Reverse of startup. Admission closes first so no new work arrives while
    // the roles drain, then the roles drain, then the listeners close.
    configureFactoryApplication(null);
    admissionOpen = false;
    try {
      await workerSet.workers.stop();
    } finally {
      stopListeners();
    }
  };

  configureFactoryApplication(application);
  admissionOpen = true;
  workerSet.workers.start(signal);
  // Readiness carries which roles are running and which are held, so "the
  // background work is live" is an answer an operator can read off `/api/ready`
  // rather than a claim they have to take from a log line. Names and reasons
  // only: no endpoint, no identity beyond the tenant, no credential.
  setReadiness({
    state: "ready",
    detail: {
      factory: {
        tenantId: config.tenantId,
        running: workerSet.workers.names(),
        held: workerSet.held.map((worker) => ({ role: worker.role, workPackage: worker.workPackage })),
        ...(dependencies.providerReadiness === undefined ? {} : { providerReadiness: dependencies.providerReadiness }),
      },
    },
  });

  return Object.freeze({ application, config, seams, workers: workerSet.workers, report, stop });
}

export type { FactoryService };
