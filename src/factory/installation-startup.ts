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
import { FactoryChildRuns, FACTORY_CHILD_SETTLEMENT_SCAN_LIMIT, type FactorySettleableChild } from "./child-runs";
import { FactoryCommandAuthority } from "./command-authority";
import { FactoryComputeAdmissions } from "./compute-admissions";
import { FactoryInbox } from "./inbox";
import { createPoolAdmissionClient } from "./pool/client";
import { FactoryRecords } from "./records";
import { FactoryRunTransitionProjector } from "./run-transition-projector";
import { FactoryTransitionArtifacts } from "./transition-artifacts";
import { loadFactoryStartupConfig, type FactoryStartupConfig } from "./startup-config";
import { startFactoryRuntime, type FactoryRuntime, type FactoryRuntimeDependencies } from "./runtime-composition";
import type { FactoryStorageProbeTarget } from "./service-probes";
import { factoryPageDriver, type FactoryItemDisposition } from "./role-drivers";
import type { FactoryApplicationOptions } from "./application";
import type { TrustedFactoryServiceIdentity } from "./trusted-command-gateway";
import type { FactoryRoleDriver } from "./runtime-seams";

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

/**
 * What the host process supplies that is not in the document.
 *
 * The object store is NOT here. It is `storage.ordinary` in the startup
 * document, built below from that endpoint and its credential set. An earlier
 * version took a host-supplied `FileBlobStore` rooted at `getDbPath()`, which
 * returns the literal string `"external"` for an external database — so the
 * product object store was created as a relative directory inside the server's
 * working tree. A configured store cannot land somewhere by accident.
 */
export interface FactoryInstallationHost {
  readonly database: TransactionalDb;
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
  /** Overridden in tests so the product store is not a real S3 dependency. */
  readonly blobs?: BlobStore;
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

/**
 * The product object store this installation is configured to use.
 *
 * The credential set is read at composition and never travels further: only the
 * set's NAME reaches a record, which is what the archive failure-domain
 * classifier is built from.
 */
async function productObjectStore(config: FactoryStartupConfig): Promise<BlobStore> {
  const { S3BlobStore } = await import("../extensions/v4/blobs");
  const { loadFactoryStorageCredentials } = await import("./release-composition");
  return new S3BlobStore({
    endpoint: config.storage.ordinary.endpoint,
    bucket: config.storage.ordinary.bucket,
    prefix: config.storage.ordinary.prefix,
    // A copy, because the AWS client attaches its own marker to this object.
    credentials: { ...await loadFactoryStorageCredentials(config.storage.ordinary, config.tenantId) },
  }) as unknown as BlobStore;
}

/**
 * The one settlement failure a child-settlement pass retries.
 *
 * W06 published the complete reachable vocabulary of `FactoryChildRuns.settle`
 * (`tasks/factory/w06-GATES.md` at `8a83dff4a`), and exactly one code means
 * "not yet": a child still holding an unsettled reservation, an open grandchild
 * envelope, or a non-zero allocation. It clears when the hold reconciles.
 *
 * Two entries are worth naming because the obvious reading is wrong, and I had
 * one of them wrong:
 *
 * - `factory_child_conflict` is a FAULT for this caller specifically. Read on
 *   its own it looks like a race worth retrying, and in another caller it would
 *   be. But this driver only ever reaches `settle` through a scan that already
 *   filters on terminal status, so a conflict means the lifecycle and the
 *   binding genuinely disagree. My first draft had it as transient, which would
 *   have retried a real disagreement forever and reported it as backpressure.
 * - `factory_budget_scope` is a FAULT, not contention. `lockFactoryScope` takes
 *   `FOR SHARE`, so it blocks rather than returning, and it returns null only
 *   when the project or installation row is genuinely absent. Deferring it
 *   would retry forever against a row that is not coming back.
 *
 * A child another worker already settled raises nothing at all, so the
 * concurrent path never reaches this function.
 */
export const FACTORY_CHILD_SETTLEMENT_TRANSIENT_CODES: readonly string[] = Object.freeze(["factory_budget_pending"]);

/**
 * Classify one child-settlement failure.
 *
 * Unknown codes are faults. A classifier that guessed "transient" for something
 * it had not seen would convert a new integrity failure into silent, endless
 * retrying — the exact outcome the disposition split exists to prevent.
 *
 * It accepts anything, including `null`, because a classifier that threw would
 * turn one item's failure into the whole role's failure — which is the
 * behaviour the page driver exists to prevent, reintroduced one layer down.
 */
export function factoryChildSettlementDisposition(error: unknown): FactoryItemDisposition {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && FACTORY_CHILD_SETTLEMENT_TRANSIENT_CODES.includes(code) ? "transient" : "fault";
}

/**
 * The child-settlement step, composed from W06's scan and W06's `settle`.
 *
 * The two halves come apart deliberately. `listSettleableInTransaction` takes
 * no lock and is read-only, while `settle` takes the run lock and the budget
 * locks root-to-leaf, so holding the scan's transaction open across the
 * settlements would hold a read transaction for the length of a whole page and
 * invite a lock-order inversion with the very rows it is about to take. The
 * page transaction therefore closes before the first `settle`.
 *
 * Nothing re-checks an item between scan and settle. It does not need to: a
 * child another worker settled in the gap raises nothing at all, and every
 * other disagreement the scan could not have seen is exactly what the
 * disposition split is for.
 */
export function factoryChildSettlementDriver(
  database: TransactionalDb,
  children: Pick<FactoryChildRuns, "listSettleableInTransaction" | "settle">,
  service: TrustedFactoryServiceIdentity,
  report: (role: string, error: unknown) => void,
  limit: number = FACTORY_CHILD_SETTLEMENT_SCAN_LIMIT,
): FactoryRoleDriver {
  return factoryPageDriver<FactorySettleableChild>({
    page: (_signal) => database.transaction((transaction) => children.listSettleableInTransaction(transaction, limit)),
    settle: (item, _signal) => children.settle(service, { projectId: item.projectId, childRunId: item.childRunId }),
    classify: factoryChildSettlementDisposition,
    // The disposition reaches the operator's stream in the role name, because
    // a not-yet and an integrity fault need different responses and an
    // undifferentiated "child-settlement failed" cannot be triaged.
    report: (item, error, disposition) => { report(`child-settlement:${disposition}:${item.projectId}/${item.childRunId}`, error); },
  });
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

  // Bind this installation to this tenant before anything else touches the
  // factory tables.
  //
  // `factory_projects.tenant_id` is a foreign key to
  // `factory_installation(tenant_id)`, and `bindInstallation` had no production
  // caller anywhere in the tree — so on a flag-on installation the FIRST
  // project a human created answered 500, with the failing INSERT in the server
  // log and nothing in the product to explain it. The real-server proof found
  // it by creating a project through the ordinary HTTP route, which is the only
  // way it could have been found: every test seeded the row itself.
  //
  // It is idempotent, and it fails closed on the one case that matters. A
  // database already bound to a different tenant raises
  // `factory_installation_mismatch` here, at boot, instead of letting this
  // process serve another installation's records.
  await new FactoryRecords(host.database, config.tenantId).bindInstallation();

  // The stores the roles read through. `createFactoryApplication` builds the
  // same ones again inside `startFactoryRuntime`; these are the collaborators
  // the background roles need and the application does not expose.
  const blobs = options.blobs ?? await productObjectStore(config);
  const artifacts = new FactoryArtifacts(host.database, blobs, config.tenantId);
  const transitions = new FactoryTransitionArtifacts(artifacts);

  const supplied = options.dependencies ?? {};
  const composed = supplied.workers === undefined
    ? await installationCollaborators(config, host, blobs, transitions)
    : undefined;
  const storage = supplied.storage ?? factoryStorageProbeTarget(blobs);
  const gateway = supplied.gateway ?? factoryGatewayProbeTarget(config);

  const dependencies: FactoryRuntimeDependencies = {
    database: host.database,
    application: {
      blobs,
      runOptions: host.runOptions,
      availableResourceClasses: host.availableResourceClasses,
    },
    // C02 puts every other role in its own process. This one starts no listener.
    listeners: [],
    storage,
    gateway,
    service: { subject: config.privateService.certificateIdentity, tenantId: config.tenantId },
    workers: supplied.workers ?? composed?.workers ?? {},
    // What this process composed, then what the caller supplied. The caller
    // wins so a test can replace a real collaborator with a fake one, and so a
    // host that composes a role this process cannot is not overruled by it.
    seams: { ...composed?.seams, ...options.seams },
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
 *
 * Seams are composed here too, and for the same reason the workers are: this is
 * the one place that holds both the tenant's stores and the startup document,
 * so it is the only place that can build a seam's step without either half
 * reaching past its owner. A seam this process cannot compose is simply absent,
 * and its role holds by name.
 */
async function installationCollaborators(
  config: FactoryStartupConfig,
  host: FactoryInstallationHost,
  blobs: BlobStore,
  transitions: FactoryTransitionArtifacts,
): Promise<{ readonly workers: FactoryRuntimeDependencies["workers"]; readonly seams: FactoryRuntimeDependencies["seams"] }> {
  const { createFactoryApplication } = await import("./application");
  // A throwaway application only to reach the lifecycle the roles read. The
  // one the runtime configures is built inside `startFactoryRuntime`; both are
  // pure store wrappers over the same database, so neither owns state.
  const stores = createFactoryApplication({
    database: host.database,
    tenantId: config.tenantId,
    blobs,
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
  const service: TrustedFactoryServiceIdentity = { subject: config.privateService.certificateIdentity, tenantId: config.tenantId };
  const children = new FactoryChildRuns(host.database, config.tenantId, authority, stores.runs, transitions);

  return {
    workers: { projections, ...(compute === undefined ? {} : { compute }) },
    seams: {
      childSettlement: factoryChildSettlementDriver(host.database, children, service, host.report),
    },
  };
}
