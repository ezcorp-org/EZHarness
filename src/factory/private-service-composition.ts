/**
 * The private worker API this installation publishes to its Node orchestrator.
 *
 * `startFactoryPrivateService` shipped with no production caller, and the
 * composition root said so in a comment: "C02 puts every other role in its own
 * process. This one starts no listener." That was right about the pool, the
 * supervisor, and the orchestrator, and wrong about this. The private service
 * is not another process's listener — it is how the product process is reached
 * BY the orchestrator, and every one of its routes needs the product database
 * that C02 keeps out of the Node process. With nothing listening, a submitted
 * run has no path off `queued`: the `start_run` command sits in the temporal
 * destination of the outbox with no drainer, and the kernel never advances.
 *
 * What it carries, and the rule each one follows:
 *
 *   - the durable command outbox and inbox, so the orchestrator can claim a
 *     command, settle it, and confirm an inbox identity;
 *   - the artifact activities, so transitions and definition pages cross as
 *     exact immutable bytes;
 *   - the stored-command router, which is the only thing that turns a kernel
 *     command into a product effect.
 *
 * **Authorization is two independent facts.** The mutual-TLS peer identity must
 * be this installation's configured certificate identity AND the bearer token
 * must be signed by a configured key, for this issuer and audience, carrying
 * `factory:orchestrate`. Neither alone admits a request, which is why the token
 * verifier is required configuration rather than an optional hardening step.
 *
 * **The verifier reads its keys per request.** Rotating a key file rotates the
 * accepted set without restarting the product, the same property the host stop
 * route gets from reloading its signing pair per signature.
 */
import { basename, dirname, resolve as resolvePath } from "node:path";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import type { TransactionalDb } from "../db/migrations/types";
import type { FactoryApplication } from "./application";
import { createFactoryArtifactActivities } from "./artifact-activities";
import { FactoryArtifactAccess } from "./artifact-access";
import type { FactoryAssurance } from "./assurance";
import { FactoryAssuranceCommands } from "./assurance-commands";
import { FactoryDefinitionArtifacts } from "./definition-artifacts";
import { FactoryInstallationCommandOutbox } from "./outbox";
import { FactoryLazyCommands } from "./lazy-commands";
import { FactoryLazyInputReader } from "./lazy-input";
import { FactoryPartitionCommands } from "./partition-commands";
import { FactoryPrivateCommands, type FactoryPrivateCommandHandler } from "./private-commands";
import { privateDirectory, readPrivateBounded } from "./private-files";
import { startFactoryPrivateService } from "./private-service";
import { FactoryProtectedCommandEffects, type FactoryReleaseCommandProfile } from "./protected-command-effects";
import type { FactoryReleases } from "./releases";
import type { FactoryStartedListener } from "./runtime-composition";
import type { FactoryInstallationStores } from "./installation-stores";
import type { FactoryStartupConfig, FactoryStartupRunnerProfile } from "./startup-config";
import { FactoryNativeRunnerPolicy, type FactoryNativeRunnerProfile } from "./native-runner-policy";
import { FactoryTaskAdmission, type FactoryTaskResourceProfile } from "./task-admission";
import { FactoryTaskExecutionAdmission } from "./task-execution-admission";
import { FACTORY_PHYSICAL_STOP_TIMEOUT_MS, type FactoryTaskStops } from "./task-stops";
import type { FactoryTransitionArtifacts } from "./transition-artifacts";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

const MAX_PRIVATE_MATERIAL_BYTES = 64 * 1024;

/**
 * Longer than the longest effect this service serves, and measured rather than
 * chosen.
 *
 * `cancel-node` asks a host to stop a guest, and `FactoryTaskStops` bounds that
 * at `FACTORY_PHYSICAL_STOP_TIMEOUT_MS` — ten seconds of C02 cleanup grace plus
 * ten of kill-and-confirm. The private transport's own default is fifteen
 * seconds, so a real stop outlived the socket: the caller saw `socket hang up`,
 * its dispatcher treated that as the loop failing, and the run sat in
 * `stopping` while the command was retried against a host already stopping the
 * same guest. The margin is one more stop bound, so a slow host costs a wait
 * rather than a lost connection.
 */
export const FACTORY_PRIVATE_SERVICE_REQUEST_TIMEOUT_MS = FACTORY_PHYSICAL_STOP_TIMEOUT_MS * 2;

export type FactoryPrivateServiceCompositionCode =
  | "factory_private_service_tokens_missing"
  | "factory_private_service_profiles_missing"
  | "factory_private_service_stores_missing";

export class FactoryPrivateServiceCompositionError extends Error {
  constructor(readonly code: FactoryPrivateServiceCompositionCode, message: string) {
    super(message);
    this.name = "FactoryPrivateServiceCompositionError";
  }
}

async function readPrivateText(path: string): Promise<string> {
  const absolute = resolvePath(path);
  const directory = await privateDirectory(dirname(absolute));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await readPrivateBounded(directory, basename(absolute), MAX_PRIVATE_MATERIAL_BYTES));
  } finally {
    await directory.close();
  }
}

/**
 * Cancelling a node: an event only when a host confirmed the stop.
 *
 * `FactoryTaskStops.stop` returns a receipt whose `state` is `stopped` when a
 * host signed that the process group is gone, and `uncertain` when the host
 * could not be reached inside the bounded window. Both carry an
 * `attempt-stopped` event, and handing the uncertain one back to the kernel
 * would make "this attempt stopped" durable on the strength of a request
 * nobody answered — the exact durable false fact the seam rules forbid.
 *
 * So uncertainty answers `null`, which the private service returns as 204 and
 * the kernel reads as "no event yet". The row stays listed for the
 * `stop-settlement` role, which retries it against the same sealed request, and
 * the command completes when a receipt really lands.
 */
export function factoryCancelNodeEffect(stops: Pick<FactoryTaskStops, "stop">): FactoryPrivateCommandHandler {
  return async (service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference): Promise<KernelEvent | null> => {
    const receipt = await stops.stop(service, reference);
    return receipt.state === "stopped" ? receipt.event : null;
  };
}

/**
 * The declared runner profiles, in the two shapes the two collaborators take.
 *
 * One declaration, read twice: `FactoryTaskAdmission` wants a map from resource
 * class to allocation, and `FactoryNativeRunnerPolicy` wants the list with its
 * runner references. Deriving both from one section is what keeps an admission
 * that reserves a CPU second and a dispatch that spends it from disagreeing
 * about how much a CPU second is.
 */
export function factoryRunnerProfiles(config: FactoryStartupConfig): {
  readonly brokerAudience: string;
  readonly admission: Readonly<Record<string, FactoryTaskResourceProfile>>;
  readonly runners: readonly FactoryNativeRunnerProfile[];
} {
  const declared = config.runnerProfiles;
  if (declared === undefined || declared.profiles.length === 0) {
    throw new FactoryPrivateServiceCompositionError("factory_private_service_profiles_missing",
      "Admitting and dispatching a task needs at least one configured runner profile.");
  }
  const allocation = (profile: FactoryStartupRunnerProfile): FactoryTaskResourceProfile => Object.freeze({
    resources: Object.freeze({ ...profile.allocation.resources }),
    memoryBytes: profile.allocation.memoryBytes,
    budget: Object.freeze({ ...profile.allocation.budget }),
  });
  return Object.freeze({
    brokerAudience: declared.brokerAudience,
    admission: Object.freeze(Object.fromEntries(declared.profiles.map((profile) => [profile.resourceClass, allocation(profile)]))),
    runners: Object.freeze(declared.profiles.map((profile) => Object.freeze({
      runner: Object.freeze({ ...profile.runner }),
      resourceClass: profile.resourceClass,
      allocation: allocation(profile),
      allowedCapabilities: Object.freeze([...profile.allowedCapabilities]),
      tools: Object.freeze([]),
    }))),
  });
}

export interface FactoryPrivateServiceCompositionOptions {
  readonly database: TransactionalDb;
  readonly config: FactoryStartupConfig;
  readonly application: Pick<FactoryApplication, "grants" | "runs" | "artifacts" | "journal" | "releaseAuthority">;
  readonly stores: FactoryInstallationStores;
  readonly transitions: FactoryTransitionArtifacts;
  /** The release store and its assurance; both are needed by the two release effects. */
  readonly releases?: FactoryReleases;
  readonly assurance?: FactoryAssurance;
  /** The stop store the `cancel-node` effect drives. */
  readonly stops?: FactoryTaskStops;
  /**
   * The release adapters this installation trusts.
   *
   * Empty by default, and that is a refusal rather than a gap being papered
   * over: `requestRelease` answers `factory_protected_effect_untrusted` for an
   * adapter no profile names. A profile pairs a definition's release-node
   * adapter reference with the destination it publishes to, so it is a
   * per-installation declaration and the startup document has no field for one
   * yet. W05 owns `factorySynchronousReleaseProfile`; W07 owns the GitHub
   * adapter it would lift.
   */
  readonly releaseProfiles?: Iterable<FactoryReleaseCommandProfile>;
  /** The host's reporter, so a refusal this service could not classify is readable. */
  readonly report?: (role: string, error: unknown) => void;
}

/**
 * Compose and bind the private service, or refuse by name.
 *
 * Every refusal is a named code the caller reports, because the alternative —
 * quietly not listening — leaves an operator with a factory that accepts runs
 * and advances none, and nothing to read that says why.
 */
export async function composeFactoryPrivateService(options: FactoryPrivateServiceCompositionOptions): Promise<FactoryStartedListener> {
  const { config, stores, application, database } = options;
  const tokens = config.privateService.tokens;
  if (tokens === undefined) {
    throw new FactoryPrivateServiceCompositionError("factory_private_service_tokens_missing",
      "The private service needs an issuer, an audience, and at least one signing key.");
  }
  if (stores.compute === undefined || options.releases === undefined || options.assurance === undefined || options.stops === undefined) {
    throw new FactoryPrivateServiceCompositionError("factory_private_service_stores_missing",
      "The private service needs the compute ledger, the release store, and the stop store this installation could not build.");
  }
  const profiles = factoryRunnerProfiles(config);
  const service: TrustedFactoryServiceIdentity = Object.freeze({ subject: config.privateService.certificateIdentity, tenantId: config.tenantId });

  const releases = options.releases;
  const access = new FactoryArtifactAccess(database, config.tenantId, application.grants, application.artifacts);
  const protectedEffects = new FactoryProtectedCommandEffects(
    database, config.tenantId, stores.authority,
    // `FactoryTaskCompletions` is only absent when the pool client is, and the
    // guard above already refused that case.
    stores.completions!,
    application.releaseAuthority, options.assurance, releases,
    options.releaseProfiles ?? [],
  );
  const partitions = new FactoryPartitionCommands(stores.authority, stores.inbox);

  const commands = new FactoryPrivateCommands({
    service,
    authority: stores.authority,
    transitions: options.transitions,
    tasks: new FactoryTaskAdmission(database, stores.authority, stores.budgets, profiles.admission, stores.compute),
    execution: new FactoryTaskExecutionAdmission(
      stores.authority, stores.compute, stores.journal, stores.queue,
      new FactoryNativeRunnerPolicy(config.tenantId, application.grants, profiles.runners, profiles.brokerAudience),
    ),
    inputs: new FactoryLazyCommands(stores.authority, new FactoryLazyInputReader(database, config.tenantId, application.artifacts, access, application.grants)),
    children: stores.children,
    approvals: new FactoryAssuranceCommands(database, config.tenantId, application.grants, stores.authority, stores.inbox, releases, service),
    effects: {
      "cancel-node": factoryCancelNodeEffect(options.stops),
      "request-acceptance": protectedEffects.requestAcceptance,
      "request-release": protectedEffects.requestRelease,
      "invalidate-partition": partitions.execute.bind(partitions),
      "notify-partition": partitions.execute.bind(partitions),
    },
  });

  const [ca, cert, key] = await Promise.all([
    readPrivateText(config.privateService.tls.caPath),
    readPrivateText(config.privateService.tls.certificatePath),
    readPrivateText(config.privateService.tls.privateKeyPath),
  ]);

  return startFactoryPrivateService({
    tenantId: config.tenantId,
    certificateIdentity: config.privateService.certificateIdentity,
    hostname: config.privateService.hostname,
    port: config.privateService.port,
    requestTimeoutMs: FACTORY_PRIVATE_SERVICE_REQUEST_TIMEOUT_MS,
    tls: { ca, cert, key },
    // Read per request, so rotating a key file rotates the accepted set without
    // restarting the product.
    tokens: async () => ({
      issuer: tokens.issuer,
      audience: tokens.audience,
      publicKeys: Object.fromEntries(await Promise.all(
        Object.entries(tokens.publicKeyPaths).map(async ([kid, path]) => [kid, await readPrivateText(path)] as const),
      )),
    }),
    queue: new (await import("./transport-queue")).FactoryTransportQueue(
      new FactoryInstallationCommandOutbox(database, config.tenantId),
      stores.inbox,
    ),
    artifacts: createFactoryArtifactActivities(new FactoryDefinitionArtifacts(application.artifacts), options.transitions),
    commands,
    ...(options.report === undefined ? {} : {
      report: ({ method, path, error }) => { options.report!(`private-service:${method}:${path}`, error); },
    }),
  });
}
