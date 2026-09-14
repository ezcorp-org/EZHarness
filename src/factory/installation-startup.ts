/**
 * The product process's factory boot, called from `ensureInitialized`.
 *
 * This is the call that was missing. `startFactoryRuntime` composed, probed,
 * and opened admission, and nothing invoked it, so a flag-on installation sat
 * at `booting / factory-services-pending` forever while every store it needed
 * was already constructible.
 *
 * What the PRODUCT process composes, and what it does not:
 *
 *   - It composes the stores and the roles that advance product state: the
 *     compute-admission outbox and poll, and the run-transition projector.
 *   - It does NOT host the execution gateway, the host supervisor, the pool, or
 *     the Node orchestrator. C02 makes each of those a separate process with
 *     different credentials, and C01 says the supervisor holds host identity
 *     and no tenant state. So this process reads each one's published readiness
 *     or asks it over its own transport; it never starts one.
 *   - It does NOT drive the attempt dispatcher. That needs a
 *     `TrustedFactoryRunner` and `FactoryPackagePreparations`, whose constructor
 *     requires a container `Runner`. The role holds by name here and registers
 *     unchanged in a process that does hold one.
 *
 * Every failure is named and fails closed: a flag-on installation whose factory
 * cannot compose must not serve factory routes, and must not claim readiness.
 */
import type { TransactionalDb } from "../db/migrations/types";
import type { BlobStore } from "../extensions/v4/types";
import { factoryBootConfig, type FactoryBootConfig } from "./boot";
import { FactoryArtifacts } from "./artifacts";
import { FactoryCommandAuthority } from "./command-authority";
import { FactoryComputeAdmissions } from "./compute-admissions";
import { FactoryInbox } from "./inbox";
import { createPoolAdmissionClient } from "./pool/client";
import { FactoryRunTransitionProjector } from "./run-transition-projector";
import { FactoryTransitionArtifacts } from "./transition-artifacts";
import { loadFactoryStartupConfig, type FactoryStartupConfig } from "./startup-config";
import { startFactoryRuntime, type FactoryRuntime, type FactoryRuntimeDependencies } from "./runtime-composition";
import type { FactoryStorageProbeTarget } from "./service-probes";
import type { FactoryApplicationOptions } from "./application";

export class FactoryInstallationStartupError extends Error {
  constructor(readonly code: "factory-startup-config-missing" | "factory-startup-blobs-missing" | "factory-startup-unreachable", message: string) {
    super(message);
    this.name = "FactoryInstallationStartupError";
  }
}

/**
 * Where the startup document lives.
 *
 * An explicit path wins; otherwise it sits beside the other private material in
 * `EZCORP_SECRETS_DIR`, which `assertFactoryBootConfiguration` already proves is
 * outside every grantable root.
 */
export function factoryStartupConfigPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  boot: FactoryBootConfig = factoryBootConfig,
): string {
  const explicit = env.EZCORP_FACTORY_STARTUP_CONFIG?.trim();
  if (explicit) return explicit;
  if (!boot.secretsDir?.trim()) {
    throw new FactoryInstallationStartupError("factory-startup-config-missing",
      "Factory startup needs EZCORP_FACTORY_STARTUP_CONFIG or EZCORP_SECRETS_DIR.");
  }
  return `${boot.secretsDir.replace(/\/+$/, "")}/factory-startup.json`;
}

/** What the host process supplies that is not in the document. */
export interface FactoryInstallationHost {
  readonly database: TransactionalDb;
  /** The product object store, already bound to this installation's data key. */
  readonly blobs: BlobStore | FactoryApplicationOptions["blobs"];
  readonly runOptions: FactoryApplicationOptions["runOptions"];
  readonly availableResourceClasses: Iterable<string>;
  readonly report: (role: string, error: unknown) => void;
}

export interface FactoryInstallationStartOptions {
  readonly host: FactoryInstallationHost;
  readonly databaseUrl: string | undefined;
  readonly signal: AbortSignal;
  readonly configPath?: string;
  readonly boot?: FactoryBootConfig;
  /** Seams a later package supplies. Each absent one holds its role by name. */
  readonly seams?: FactoryRuntimeDependencies["seams"];
  /** Overridden in tests so the pool client is not a real network dependency. */
  readonly dependencies?: Partial<Pick<FactoryRuntimeDependencies, "storage" | "gateway" | "workers" | "extraProbes">>;
}

/**
 * A byte round-trip through the product store the application will really use.
 *
 * `BlobStore` is put/get by digest rather than by key, so the probe writes its
 * own bytes and reads them back by the digest the store returned. A store that
 * accepted the write and cannot return it is not storage.
 */
export function factoryStorageProbeTarget(blobs: BlobStore): FactoryStorageProbeTarget {
  const written = new Map<string, string>();
  return {
    async put(key: string, content: Uint8Array) {
      const stored = await blobs.put(content);
      written.set(key, typeof stored === "string" ? stored : (stored as { blobDigest: string }).blobDigest);
    },
    async get(key: string) {
      const digest = written.get(key);
      if (digest === undefined) throw new FactoryInstallationStartupError("factory-startup-blobs-missing", "The probe object was never written.");
      return blobs.get(digest);
    },
  };
}

/** The gateway is live when its own listener terminates TLS and answers. */
export function factoryGatewayProbeTarget(config: FactoryStartupConfig): FactoryRuntimeDependencies["gateway"] {
  return {
    async health(signal) {
      const { createGatewayTransport } = await import("@ezcorp/factory-transport");
      const transport = await createGatewayTransport({
        baseUrl: config.gateway.tls === undefined ? "" : `https://${config.gateway.hostname}:${config.gateway.port}`,
        tls: {
          caPath: config.gateway.tls.caPath,
          certificatePath: config.gateway.tls.certificatePath,
          privateKeyPath: config.gateway.tls.privateKeyPath,
          serviceTokenPath: config.pool.serviceTokenPath,
        },
        requestTimeoutMs: 5_000,
      });
      // Any HTTP answer proves the listener is bound and terminating TLS with
      // this installation's material. A refused connection or a failed
      // handshake throws, and the probe reports the transport's own code.
      const response = await transport.request("GET", "/internal/factory/v1/health", undefined, 64 * 1024, signal);
      return response.statusCode > 0;
    },
  };
}

export interface FactoryInstallationStartup {
  readonly runtime: FactoryRuntime;
  stop(): Promise<void>;
}

/**
 * Compose and start the factory for this installation.
 *
 * Returns a handle the caller registers as a teardown. Throws with a named code
 * when the factory cannot compose, which the caller must treat as fatal for the
 * factory and non-fatal for the rest of the host.
 */
export async function startFactoryInstallation(options: FactoryInstallationStartOptions): Promise<FactoryInstallationStartup> {
  const boot = options.boot ?? factoryBootConfig;
  const config = await loadFactoryStartupConfig(options.configPath ?? factoryStartupConfigPath(process.env, boot));
  const host = options.host;

  // The stores the roles read through. `createFactoryApplication` builds the
  // same ones again inside `startFactoryRuntime`; these are the collaborators
  // the background roles need and the application does not expose.
  const artifacts = new FactoryArtifacts(host.database, host.blobs, config.tenantId);
  const transitions = new FactoryTransitionArtifacts(artifacts);

  const supplied = options.dependencies ?? {};
  const storage = supplied.storage ?? factoryStorageProbeTarget(host.blobs as BlobStore);
  const gateway = supplied.gateway ?? factoryGatewayProbeTarget(config);

  const dependencies: FactoryRuntimeDependencies = {
    database: host.database,
    application: {
      blobs: host.blobs,
      runOptions: host.runOptions,
      availableResourceClasses: host.availableResourceClasses,
    },
    // C02 puts every other role in its own process. This one starts no listener.
    listeners: [],
    storage,
    gateway,
    service: { subject: config.privateService.certificateIdentity, tenantId: config.tenantId },
    workers: supplied.workers ?? await installationWorkers(config, host, transitions),
    ...(options.seams === undefined ? {} : { seams: options.seams }),
    ...(supplied.extraProbes === undefined ? {} : { extraProbes: supplied.extraProbes }),
    report: host.report,
  };

  const runtime = await startFactoryRuntime(config, options.databaseUrl, dependencies, options.signal, boot);
  return Object.freeze({ runtime, stop: () => runtime.stop() });
}

/**
 * The roles this process can drive, built from the stores it already has.
 *
 * A pool client that cannot be created leaves the two compute roles without a
 * driver, and they hold by name rather than pretending the pool is reachable.
 */
async function installationWorkers(
  config: FactoryStartupConfig,
  host: FactoryInstallationHost,
  transitions: FactoryTransitionArtifacts,
): Promise<FactoryRuntimeDependencies["workers"]> {
  const { createFactoryApplication } = await import("./application");
  // A throwaway application only to reach the lifecycle the roles read. The
  // one the runtime configures is built inside `startFactoryRuntime`; both are
  // pure store wrappers over the same database, so neither owns state.
  const stores = createFactoryApplication({
    database: host.database,
    tenantId: config.tenantId,
    blobs: host.blobs,
    runOptions: host.runOptions,
    availableResourceClasses: host.availableResourceClasses,
  });
  const projections = new FactoryRunTransitionProjector(host.database, config.tenantId, transitions, stores.runs);

  const authority = new FactoryCommandAuthority(host.database, config.tenantId, stores.runs, transitions, [config.privateService.certificateIdentity]);
  let compute: FactoryComputeAdmissions | undefined;
  try {
    const pool = await createPoolAdmissionClient({
      tenantId: config.tenantId,
      baseUrl: config.pool.baseUrl,
      tls: {
        caPath: config.pool.tls.caPath,
        certificatePath: config.pool.tls.certificatePath,
        privateKeyPath: config.pool.tls.privateKeyPath,
        serviceTokenPath: config.pool.serviceTokenPath,
      },
    });
    compute = new FactoryComputeAdmissions(host.database, config.tenantId, authority, stores.runs.budgets, new FactoryInbox(host.database, config.tenantId), pool);
  } catch {
    compute = undefined;
  }
  return { projections, ...(compute === undefined ? {} : { compute }) };
}
