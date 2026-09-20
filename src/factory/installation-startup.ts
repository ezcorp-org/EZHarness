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
 *   - It does NOT host the host supervisor, the pool, or the Node orchestrator.
 *     C02 makes each of those a separate process with different credentials,
 *     and C01 says the supervisor holds host identity and no tenant state. So
 *     this process reads each one's published readiness or asks it over its own
 *     transport; it never starts one.
 *   - It DOES drive the attempt dispatcher, with the guest running in the
 *     supervisor process across the host launch transport. Every durable record
 *     — the launch intent, its one-winner claim, the terminal result, the
 *     completion and the outcome — stays here, and only the physical launch
 *     crosses the wire. An earlier version of this comment said the role held
 *     here because `FactoryPackagePreparations` requires a container runner;
 *     W01b corrected that, and the correction is why the role now runs:
 *     `assertDispatchReady` is a database read.
 *
 * Every failure is named and fails closed: a flag-on installation whose factory
 * cannot compose must not serve factory routes, and must not claim readiness.
 */
import type { TransactionalDb } from "../db/migrations/types";
import type { BlobStore } from "../extensions/v4/types";
import { factoryBootConfig, type FactoryBootConfig } from "./boot";
import { FactoryArtifacts } from "./artifacts";
import { type FactoryChildRuns, FACTORY_CHILD_SETTLEMENT_SCAN_LIMIT, type FactorySettleableChild } from "./child-runs";
import { createPoolAdmissionClient, type PoolAdmissionClient } from "./pool/client";
import { FactoryAssurance } from "./assurance";
import { FactoryScopedMaterials } from "./artifact-materials";
import { composeFactoryArchiveWriter, loadFactoryStorageCredentials } from "./release-composition";
import { FactoryDestinationReservations, FactoryStoreSenderFence } from "./release-destinations";
import { factoryReleaseFenceReader } from "./release-fence";
import { FactoryS3PublicationProvenance } from "./release-s3-scope";
import { FactoryReleases } from "./releases";
import { FactoryNotificationDelivery } from "./notification-delivery";
import { FactoryTrustedValidators } from "./validator-materials";
import { factoryTenantProjectIds, factoryTenantProjects } from "./tenant-projects";
import { FactoryRecords } from "./records";
import { createFactoryProviderBroker, factoryProviderReadiness, factoryProviderReadinessRecord, type FactoryProviderPin } from "../providers/factory-broker";
import type { FactoryBroker } from "../runtime/factory-execution";
import { FactoryTransitionArtifacts } from "./transition-artifacts";
import { loadFactoryStartupConfig, type FactoryStartupConfig } from "./startup-config";
import { factoryInstallationStores, type FactoryInstallationStores } from "./installation-stores";
import { composeFactoryAttemptDispatch, factoryPackageReadiness, type FactoryHostPhysicalStopper } from "./attempt-composition";
import { composeFactorySettlement } from "./dispatch-composition";
import { startFactoryRuntime, type FactoryRuntime, type FactoryRuntimeDependencies } from "./runtime-composition";
import type { FactoryStorageProbeTarget } from "./service-probes";
import { factoryPageDriver, type FactoryItemDisposition } from "./role-drivers";
import type { FactoryRuntimeWorkerCollaborators } from "./runtime-workers";
import type { FactoryApplication, FactoryApplicationOptions } from "./application";
import type { TrustedFactoryServiceIdentity } from "./trusted-command-gateway";
import type { FactoryRoleDriver } from "./runtime-seams";
import type { FactoryStartedListener } from "./runtime-composition";
import type { FactoryTaskStops } from "./task-stops";

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
  /** Overridden in tests so provider readiness is not a real credential lookup. */
  readonly providerReadiness?: Parameters<typeof factoryProviderReadiness>[1];
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

/**
 * The release store, composed from the startup document alone.
 *
 * Every collaborator here landed with the wave-2 integration, and the last one
 * this package was waiting on is the project enumerator above. The pieces and
 * why each is the production one, not a stand-in:
 *
 * - `FactoryTrustedValidators` satisfies BOTH of assurance's validator seams —
 *   the gateway and the current-candidate resolver — so it is constructed once
 *   and passed twice rather than duplicated.
 * - The runtimes iterable is empty because a trusted validator runtime is a
 *   pinned deployment fact and the startup document declares none. An empty set
 *   is not a weakened check: `resolveValidatorInTransaction` then finds no
 *   runtime and refuses, which is the correct answer for an installation that
 *   has pinned none.
 * - The release fence reader is the composition-owned one, which is where the
 *   freeze puts it.
 * - The archive writer's publication set comes from `FactoryS3PublicationProvenance`,
 *   the S3 derivation, because the startup document configures S3 for both the
 *   ordinary and the archive store. An installation publishing to git would
 *   supply `FactoryGitPublicationMembers` instead; that is a configured choice
 *   and it is the one this document's storage section already makes.
 *
 * Returning `undefined` rather than throwing is deliberate. A factory whose
 * release store cannot be composed must still serve runs; the two release roles
 * hold by name, which is visible in the readiness report, instead of taking the
 * whole installation down with them.
 */
async function installationReleases(
  config: FactoryStartupConfig,
  database: TransactionalDb,
  blobs: BlobStore,
  artifacts: FactoryArtifacts,
  stores: Pick<FactoryApplication, "grants" | "runs" | "journal" | "releaseAuthority">,
  report: (role: string, error: unknown) => void,
): Promise<{ readonly releases: FactoryReleases; readonly assurance: FactoryAssurance } | undefined> {
  try {
    const validators = new FactoryTrustedValidators(database, config.tenantId, stores.runs, stores.journal, artifacts, stores.releaseAuthority, []);
    const assurance = new FactoryAssurance(database, config.tenantId, stores.grants, validators, factoryReleaseFenceReader(stores.runs), validators);
    const provenance = new FactoryS3PublicationProvenance({ database, tenantId: config.tenantId });
    const archive = composeFactoryArchiveWriter({
      tenantId: config.tenantId,
      ordinary: config.storage.ordinary,
      archive: config.storage.archive,
      reader: new FactoryScopedMaterials({ database, artifacts, blobs }),
      resolveMembers: (tenantId, operationId, material, signal) => provenance.sourcesFor(tenantId, operationId, material, signal),
      archiveCredentials: await loadFactoryStorageCredentials(config.storage.archive, config.tenantId),
    });
    const releases = new FactoryReleases(
      database, config.tenantId, stores.grants, assurance, stores.releaseAuthority, stores.releaseAuthority,
      new FactoryDestinationReservations({ database, tenantId: config.tenantId }),
      archive,
      new FactoryStoreSenderFence({ database, tenantId: config.tenantId }),
    );
    // The assurance travels with the store: `FactoryProtectedCommandEffects`
    // takes both, and a second assurance built over the same tables would
    // evaluate a claim by one instance's validator set and consume the approval
    // through another's.
    return Object.freeze({ releases, assurance });
  } catch (error) {
    // Never silently. A release store that cannot compose holds two roles, and
    // an operator who can see the roles held but not the reason has to guess
    // between a missing credential, an unreachable store, and a scope
    // mismatch. The first version of this catch returned `undefined` and said
    // nothing, which is the failure this comment exists to prevent.
    report("release-store", error);
    return undefined;
  }
}

/**
 * One bounded delivery of the release notification inbox, across the tenant.
 *
 * `FactoryNotificationDelivery.deliverNext` is per project, so the role's
 * installation-wide shape is this walk plus the project enumerator. It stops at
 * the first project that delivered, which keeps one pass bounded and lets the
 * worker's own idle delay govern the rate; a pass that drained every project
 * would let one busy project starve the rest for the length of its backlog.
 */
export function factoryNotificationInboxDriver(
  database: TransactionalDb,
  delivery: Pick<FactoryNotificationDelivery, "deliverNext">,
  tenantId: string,
  scan: { readonly limit?: number; readonly pages?: number } = {},
): { deliverNextAcrossProjects(signal: AbortSignal): Promise<boolean> } {
  const projects = factoryTenantProjects(tenantId);
  return {
    async deliverNextAcrossProjects(signal: AbortSignal): Promise<boolean> {
      for (const projectId of await factoryTenantProjectIds(database, projects, scan)) {
        signal.throwIfAborted();
        if (await delivery.deliverNext(projectId) !== null) return true;
      }
      return false;
    },
  };
}

export interface FactoryProviderComposition {
  /** The secret-free readiness record, for `/api/ready` and for an evidence file. */
  readonly readiness: Record<string, unknown>;
  /** Present only when the pin is genuinely usable. Absent is never a stand-in. */
  readonly broker?: FactoryBroker;
}

/**
 * The model broker this installation pins, and the readiness row that says so.
 *
 * W10 reported that nothing constructed the broker and handed it to a runner.
 * This constructs it, from validated configuration only, and the shape of the
 * answer is the point: a pin whose credential is missing produces a readiness
 * row with `ready: false` and a NAMED failure, and no broker at all. It never
 * produces a broker that would resolve a credential later, or fall back to a
 * host setting, or accept a call and answer plausibly. Those are the three
 * substitutes the rule forbids, and each of them turns a missing credential
 * into a guest's wrong answer instead of an operator's readiness row.
 *
 * An installation with no pin gets no row and no broker, which is correct: an
 * installation that runs no model-calling guest needs neither, and inventing a
 * default pin would be a fourth substitute.
 *
 * The record carries the provider, the model, the named failures, and the KIND
 * of credential resolved — never its value.
 */
export async function composeFactoryProviderBroker(
  pin: FactoryProviderPin | undefined,
  options: Parameters<typeof factoryProviderReadiness>[1] = {},
): Promise<FactoryProviderComposition | undefined> {
  if (pin === undefined) return undefined;
  const readiness = await factoryProviderReadiness(pin, options);
  const record = factoryProviderReadinessRecord(readiness);
  if (!readiness.ready) return Object.freeze({ readiness: record });
  return Object.freeze({ readiness: record, broker: createFactoryProviderBroker({ pin, ...options }) });
}

export interface FactoryInstallationStartup {
  readonly runtime: FactoryRuntime;
  /** The pinned model broker, when one is configured AND ready. */
  readonly provider?: FactoryProviderComposition;
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
  // Before anything is composed, so a half-configured model pin is a readiness
  // row rather than a surprise at the first guest call.
  const provider = await composeFactoryProviderBroker(config.modelProvider, options.providerReadiness ?? {});
  if (provider !== undefined && provider.broker === undefined) host.report("model-provider", new Error(`factory_provider_not_ready: ${JSON.stringify(provider.readiness.failures)}`));
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
    // The private worker API, and only that. The pool, the supervisor, and the
    // Node orchestrator each bind their own in their own process; this one binds
    // the endpoint the orchestrator calls back on, because every route it
    // serves needs the product database those processes must not hold.
    listeners: composed?.listeners ?? [],
    storage,
    gateway,
    service: { subject: config.privateService.certificateIdentity, tenantId: config.tenantId },
    workers: supplied.workers ?? composed?.workers ?? {},
    // What this process composed, then what the caller supplied. The caller
    // wins so a test can replace a real collaborator with a fake one, and so a
    // host that composes a role this process cannot is not overruled by it.
    seams: { ...composed?.seams, ...options.seams },
    ...(config.readinessRetry === undefined ? {} : { readinessRetry: config.readinessRetry }),
    // The daemon's own reader, so the check compares the document against the
    // value that will really govern the sweep rather than against the env var
    // read a second way.
    orphanSweepIntervalMs: (await import("../extensions/host-maintenance-daemon")).getSweepIntervalMs(),
    ...(supplied.extraProbes === undefined ? {} : { extraProbes: supplied.extraProbes }),
    ...(provider === undefined ? {} : { providerReadiness: provider.readiness }),
    report: host.report,
  };

  const runtime = await startFactoryRuntime(config, options.databaseUrl, dependencies, options.signal, boot);
  return Object.freeze({ runtime, ...(provider === undefined ? {} : { provider }), stop: () => runtime.stop() });
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
): Promise<{
  readonly workers: FactoryRuntimeDependencies["workers"];
  readonly seams: FactoryRuntimeDependencies["seams"];
  readonly listeners: readonly FactoryStartedListener[];
}> {
  const { createFactoryApplication } = await import("./application");
  // A throwaway application only to reach the lifecycle the roles read. The
  // one the runtime configures is built inside `startFactoryRuntime`; both are
  // pure store wrappers over the same database, so neither owns state.
  const application = createFactoryApplication({
    database: host.database,
    tenantId: config.tenantId,
    blobs,
    runOptions: host.runOptions,
    availableResourceClasses: host.availableResourceClasses,
  });

  // One pool client, shared by admission, settlement, and the attempt runtime's
  // start acknowledgement. Three clients would open three mutual-TLS sessions
  // to the same endpoint and, worse, could disagree about which of them holds a
  // lease when one of them is rotated.
  let pool: PoolAdmissionClient | undefined;
  try {
    pool = await createPoolAdmissionClient({
      tenantId: config.tenantId,
      baseUrl: config.pool.baseUrl,
      tls: {
        caPath: config.pool.tls.caPath,
        certificatePath: config.pool.tls.certificatePath,
        privateKeyPath: config.pool.tls.privateKeyPath,
        serviceTokenPath: config.pool.serviceTokenPath,
      },
    });
  } catch (error) {
    host.report("pool-admission-client", error);
    pool = undefined;
  }

  const service: TrustedFactoryServiceIdentity = { subject: config.privateService.certificateIdentity, tenantId: config.tenantId };
  const stores = factoryInstallationStores({
    database: host.database,
    tenantId: config.tenantId,
    blobs,
    application,
    transitions,
    serviceSubject: config.privateService.certificateIdentity,
    ...(pool === undefined ? {} : { pool }),
  });

  const attempts = await composeAttemptDispatch(config, host, blobs, stores, application.grants, pool);
  const settlement = await composeSettlement(config, host, stores, service, pool);

  // The release store, and the one role it unblocks here. `release-outcome`
  // needs a second half this process still cannot build — see its held reason.
  const release = await installationReleases(config, host.database, blobs, application.artifacts, application, host.report);
  const notificationInbox = release === undefined ? undefined
    : factoryNotificationInboxDriver(host.database, new FactoryNotificationDelivery(release.releases), config.tenantId);

  const privateService = await composePrivateService(config, host, stores, transitions, application, release, settlement?.stops);

  return {
    workers: {
      projections: stores.projections,
      ...(stores.compute === undefined ? {} : { compute: stores.compute }),
      ...(attempts === undefined ? {} : { attempts }),
      ...(notificationInbox === undefined ? {} : { notificationInbox }),
    },
    seams: {
      childSettlement: factoryChildSettlementDriver(host.database, stores.children, service, host.report),
      ...(settlement === undefined ? {} : {
        physicalStopper: settlement.stopSettlement,
        usageReconciler: settlement.usageReconciliation,
      }),
    },
    listeners: privateService === undefined ? [] : [privateService],
  };
}

/**
 * The private worker API, when this installation is configured to be commanded.
 *
 * It is the one listener the product process binds. A failure to compose is
 * reported under its own role rather than taken as fatal: a factory whose
 * orchestrator cannot reach it still serves reads, and the orchestrator's own
 * readiness probe fails, which keeps admission closed through the path the
 * readiness gate already owns.
 */
async function composePrivateService(
  config: FactoryStartupConfig,
  host: FactoryInstallationHost,
  stores: FactoryInstallationStores,
  transitions: FactoryTransitionArtifacts,
  application: FactoryApplication,
  release: { readonly releases: FactoryReleases; readonly assurance: FactoryAssurance } | undefined,
  stops: FactoryTaskStops | undefined,
): Promise<FactoryStartedListener | undefined> {
  if (config.privateService.tokens === undefined) return undefined;
  try {
    const { composeFactoryPrivateService } = await import("./private-service-composition");
    return await composeFactoryPrivateService({
      database: host.database,
      config,
      application,
      stores,
      transitions,
      ...(release === undefined ? {} : { releases: release.releases, assurance: release.assurance }),
      ...(stops === undefined ? {} : { stops }),
    });
  } catch (error) {
    host.report("private-service", error);
    return undefined;
  }
}

/**
 * The `attempt-dispatch` collaborator, when this installation can reach a host.
 *
 * Three facts have to hold and each absence is reported rather than silently
 * dropping the role: the startup document declares a host launch endpoint, the
 * pool client exists, and the task stores that record a completion or an
 * outcome could be built. Missing any one of them, the role holds by name with
 * the reason visible on `/api/ready`.
 */
async function composeAttemptDispatch(
  config: FactoryStartupConfig,
  host: FactoryInstallationHost,
  blobs: BlobStore,
  stores: FactoryInstallationStores,
  grants: FactoryApplication["grants"],
  pool: PoolAdmissionClient | undefined,
): Promise<FactoryRuntimeWorkerCollaborators["attempts"]> {
  const hostLaunch = config.hostLaunch;
  if (hostLaunch === undefined || pool === undefined || stores.compute === undefined || stores.completions === undefined || stores.outcomes === undefined) return undefined;
  try {
    const stopper = await factoryHostStopper(config);
    return await composeFactoryAttemptDispatch({
      database: host.database,
      config: { ...config, hostLaunch },
      service: { subject: config.privateService.certificateIdentity, tenantId: config.tenantId },
      queue: stores.queue,
      completions: stores.completions,
      outcomes: stores.outcomes,
      admissions: stores.compute,
      readiness: factoryPackageReadiness(host.database, config.tenantId, grants, blobs),
      pool,
      stopper,
    });
  } catch (error) {
    host.report("attempt-dispatch-composition", error);
    return undefined;
  }
}

/**
 * The host stop transport, as the narrow physical call the wire carries.
 *
 * See `factoryIntentPhysicalStop`: the runtime's post-result stop has no cancel
 * command behind it, so it addresses the host with the physical coordinates
 * alone. The cast is the whole narrowing and it is here, in one line, rather
 * than spread through the runtime.
 */
async function factoryHostStopper(config: FactoryStartupConfig): Promise<FactoryHostPhysicalStopper> {
  const { createFactoryHostStopClient } = await import("./host-stop-client");
  const hostLaunch = config.hostLaunch;
  if (hostLaunch === undefined) throw new FactoryInstallationStartupError("factory-startup-config-missing", "A host stop transport needs the host launch endpoint.");
  const client = await createFactoryHostStopClient({
    baseUrl: hostLaunch.baseUrl,
    serverName: hostLaunch.serverName,
    hostId: config.hostId,
    tls: {
      caPath: hostLaunch.tls.caPath,
      certificatePath: hostLaunch.tls.certificatePath,
      privateKeyPath: hostLaunch.tls.privateKeyPath,
      serviceTokenPath: hostLaunch.tls.serviceTokenPath,
    },
  });
  return (expectation, signal) => client.stop(expectation as Parameters<typeof client.stop>[0], signal);
}

/**
 * The two settlement roles, when the host keys and the pool are both present.
 *
 * They compose together or not at all, because the usage reconciler reads its
 * settlement scope through the very `FactoryTaskStops` the stop role drives.
 */
async function composeSettlement(
  config: FactoryStartupConfig,
  host: FactoryInstallationHost,
  stores: FactoryInstallationStores,
  service: TrustedFactoryServiceIdentity,
  pool: PoolAdmissionClient | undefined,
): Promise<{ readonly stopSettlement: FactoryRoleDriver; readonly usageReconciliation: FactoryRoleDriver; readonly stops: FactoryTaskStops } | undefined> {
  if (pool === undefined || config.hostLaunch === undefined || config.hostStopKeys === undefined
    || stores.compute === undefined || stores.outcomes === undefined) return undefined;
  try {
    const composed = await composeFactorySettlement({
      database: host.database,
      config,
      stores: { ...stores, compute: stores.compute, outcomes: stores.outcomes },
      pool,
      service,
      report: host.report,
    });
    return Object.freeze({ stopSettlement: composed.stopSettlement, usageReconciliation: composed.usageReconciliation, stops: composed.stops });
  } catch (error) {
    host.report("settlement-composition", error);
    return undefined;
  }
}
