/**
 * The `attempt-dispatch` role, assembled from collaborators that all exist.
 *
 * W09 held this role through three rounds and the last round proved the hold
 * was no longer a gap: the preflight was built, W01b's driver and host launch
 * transport had landed, and what remained was putting the objects together.
 * This is that assembly, and it makes exactly one deployment decision, which
 * the coordinator settled: the guest runs in the supervisor process, so the
 * runtime is `FactoryRemoteAttemptRuntime` over the host launch transport and
 * this process holds no container runner for an attempt.
 *
 * Three choices in here are worth stating, because each one had a tempting
 * wrong answer.
 *
 * **Package readiness uses the shared v4 runner client, not a stub.**
 * `FactoryPackagePreparations` takes a container runner, and the product
 * process does not hold one for attempts. The tempting shape is a local stub
 * whose `build` throws. The correct one is the runner the product already
 * holds: `createLazyExtensionRunner` resolves the configured runner socket per
 * call and refuses by name when none is configured, which is the same seam the
 * extension lifecycle uses (C13 — no second runner path). Nothing on the
 * dispatch path calls it: `assertDispatchReady` is a database read.
 *
 * **The attempt token secret is read, never generated.** A generated secret
 * would mint tokens the execution gateway of a restarted process cannot verify,
 * which turns a restart into a fleet of guests holding dead credentials.
 *
 * **The physical stop carries only physical coordinates.** See
 * `factoryIntentPhysicalStop` below.
 */
import { basename, dirname, resolve } from "node:path";
import type { FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import { buildLimits } from "@ezcorp/extension-runner";
import type { TransactionalDb } from "../db/migrations/types";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { createLazyExtensionRunner } from "../extensions/runner-connection";
import type { BlobStore } from "../extensions/v4/types";
import { signFactoryAttemptToken } from "./attempt-token";
import type { FactoryAttemptQueue } from "./attempt-queue";
import type { FactoryComputeAdmissions } from "./compute-admissions";
import type { FactoryGrants } from "./grants";
import { createFactoryHostLaunchClient } from "./host-launch-client";
import type { FactoryPhysicalStopExpectation } from "./journal-validation";
import { FactoryPackagePreparations, FactoryPackageTrusts, FactoryV4PackageCatalog, type FactoryRunnerDispatchReadiness } from "./package-preparation";
import { privateDirectory, readPrivateBounded } from "./private-files";
import type { PoolAdmissionClient } from "./pool/client";
import { createFactoryAttemptDispatchDriver, type FactoryAttemptDispatchDriver } from "./runner/attempt-dispatch-driver";
import { FactoryDatabaseAttemptLaunchStore, type FactoryAttemptLaunchIntent, type FactoryPhysicalStopReason, type FactoryPhysicalStopReceipt } from "./runner/attempt-runtime";
import { factoryAttemptPreflight } from "./runner/attempt-preflight";
import { FactoryRemoteAttemptRuntime } from "./runner/remote-attempt-runtime";
import type { FactoryStartupConfig } from "./startup-config";
import type { FactoryTaskCompletions } from "./task-completions";
import type { FactoryTaskOutcomes } from "./task-outcomes";
import type { TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

/** Long enough to cross one launch and short enough that a leaked copy expires. */
export const FACTORY_ATTEMPT_TOKEN_LIFETIME_SECONDS = 900;
const MAX_ATTEMPT_TOKEN_BYTES = 4 * 1024;
/** `signInstallationToken` needs real entropy; a short file is a misconfiguration. */
const MIN_ATTEMPT_TOKEN_SECRET_LENGTH = 32;

export class FactoryAttemptCompositionError extends Error {
  constructor(readonly code: "factory_attempt_token_secret_invalid", message: string) {
    super(message);
    this.name = "FactoryAttemptCompositionError";
  }
}

/**
 * Read the installation's attempt token secret from its private file.
 *
 * Through the same bounded private reader the rest of the startup material uses,
 * so a world-readable secret is refused rather than loaded. The value is
 * returned to exactly one caller and never logged, recorded, or published.
 */
export async function loadFactoryAttemptTokenSecret(path: string): Promise<string> {
  const absolute = resolve(path);
  const directory = await privateDirectory(dirname(absolute));
  let bytes: Uint8Array;
  try {
    bytes = await readPrivateBounded(directory, basename(absolute), MAX_ATTEMPT_TOKEN_BYTES);
  } finally {
    await directory.close();
  }
  const secret = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  if (secret.length < MIN_ATTEMPT_TOKEN_SECRET_LENGTH) {
    throw new FactoryAttemptCompositionError("factory_attempt_token_secret_invalid",
      `The factory attempt token secret must be at least ${MIN_ATTEMPT_TOKEN_SECRET_LENGTH} characters.`);
  }
  return secret;
}

/**
 * Current package readiness for this installation, as a database read.
 *
 * The runner client is the shared configured one rather than a local stub,
 * because `prepare` is a real operation this process may legitimately be asked
 * to perform and a stub would answer it falsely. `assertDispatchReady`, the only
 * method the dispatch path calls, never reaches it.
 */
export function factoryPackageReadiness(
  database: TransactionalDb,
  tenantId: string,
  grants: FactoryGrants,
  blobs: BlobStore,
): FactoryPackagePreparations {
  return new FactoryPackagePreparations(
    database,
    tenantId,
    grants,
    new FactoryPackageTrusts(database, tenantId, grants),
    new FactoryV4PackageCatalog(new DatabaseLifecycleRepository(database as never), blobs),
    createLazyExtensionRunner(),
    buildLimits,
  );
}

/**
 * The attempt token this process mints for one launch.
 *
 * The digest is recomputed from the request rather than carried alongside it,
 * which is what makes the token unforgeable against a modified request: the
 * execution gateway verifies the token's `requestDigest` against the request
 * body it is handed, so a token minted over a different request cannot admit it.
 */
export function factoryAttemptTokenMinter(secret: string, installationId: string, lifetimeSeconds = FACTORY_ATTEMPT_TOKEN_LIFETIME_SECONDS) {
  return async (request: FactoryRunnerRequest): Promise<string> => {
    const authority = request.authority;
    return signFactoryAttemptToken({
      attemptId: authority.attemptId,
      tenantId: authority.tenantId,
      projectId: authority.projectId,
      runId: authority.runId,
      nodeInstanceId: authority.nodeInstanceId,
      candidateGeneration: authority.candidateGeneration,
      attemptNumber: authority.attemptNumber,
      grantRevision: authority.grantRevision,
      reservationGeneration: authority.reservationGeneration,
      executionEpoch: authority.executionEpoch,
      cancellationEpoch: authority.cancellationEpoch,
      requestDigest: factoryRunnerRequestDigest(request),
      deadlineAt: new Date(authority.deadlineAtMs),
    }, secret, installationId, lifetimeSeconds);
  };
}

/** What a host stop actually needs on the wire, and all of it. */
export type FactoryHostPhysicalStopper = (
  expectation: FactoryPhysicalStopExpectation,
  signal: AbortSignal,
) => Promise<FactoryPhysicalStopReceipt>;

/**
 * The runtime's post-result stop, addressed to the host that ran the guest.
 *
 * `FactoryRemoteAttemptRuntime` stops a guest whose result is already durable.
 * There is no cancellation behind it, so there is no cancel command — and
 * `FactoryTaskStopRequest`, which W03 shaped for its cancelling caller, requires
 * a `cancelReference` and a `source` this caller genuinely does not have.
 * Inventing them would be the class of substitute this package has been
 * corrected for twice, so the dependency is declared as the coordinates the
 * transport actually puts on the wire — exactly `FactoryPhysicalStopExpectation`,
 * which is what `createFactoryHostStopClient` reads and all it reads.
 *
 * Filed with W03 as an interface question: either make those two fields optional
 * on `FactoryTaskStopRequest`, or publish a physical-only client. Until then the
 * adapter is here, in the composition, where the narrowing is visible.
 */
export function factoryIntentPhysicalStop(stopper: FactoryHostPhysicalStopper, hostId: string) {
  return async (intent: FactoryAttemptLaunchIntent, reason: FactoryPhysicalStopReason): Promise<FactoryPhysicalStopReceipt> => {
    const controller = new AbortController();
    return stopper(Object.freeze({
      attemptId: intent.request.authority.attemptId,
      reservationId: intent.lease.reservationId,
      workerId: intent.workerId,
      holderGeneration: intent.lease.holderGeneration,
      allocationGeneration: intent.lease.allocationGeneration,
      // The lease names the machine that ran the guest; the configured host is
      // the fallback the preflight already applied when the pool pinned none.
      hostId: intent.lease.hostId || hostId,
      reason,
    }), controller.signal);
  };
}

export interface FactoryAttemptDispatchCompositionOptions {
  readonly database: TransactionalDb;
  readonly config: FactoryStartupConfig & { readonly hostLaunch: NonNullable<FactoryStartupConfig["hostLaunch"]> };
  readonly service: TrustedFactoryServiceIdentity;
  readonly queue: FactoryAttemptQueue;
  readonly completions: Pick<FactoryTaskCompletions, "completeInTransaction" | "readInTransaction">;
  readonly outcomes: Pick<FactoryTaskOutcomes, "recordInTransaction" | "readInTransaction">;
  readonly admissions: Pick<FactoryComputeAdmissions, "readRetainedAdmittedInTransaction">;
  readonly readiness: FactoryRunnerDispatchReadiness;
  readonly pool: Pick<PoolAdmissionClient, "acknowledgeStart">;
  readonly stopper: FactoryHostPhysicalStopper;
}

/**
 * Compose the role: durable records here, the container over the wire.
 *
 * Every argument is a collaborator somebody else owns, which is the point. The
 * dispatcher claims, revalidates, mints, launches, and records; the preflight
 * reads back the allocation the attempt already holds; the remote runtime keeps
 * the launch intent, the one-winner claim, and the terminal result in this
 * database and sends only the physical launch across the mutual-TLS boundary.
 */
export async function composeFactoryAttemptDispatch(
  options: FactoryAttemptDispatchCompositionOptions,
): Promise<FactoryAttemptDispatchDriver> {
  const { config } = options;
  const transport = await createFactoryHostLaunchClient({
    baseUrl: config.hostLaunch.baseUrl,
    serverName: config.hostLaunch.serverName,
    hostId: config.hostId,
    tls: {
      caPath: config.hostLaunch.tls.caPath,
      certificatePath: config.hostLaunch.tls.certificatePath,
      privateKeyPath: config.hostLaunch.tls.privateKeyPath,
      serviceTokenPath: config.hostLaunch.tls.serviceTokenPath,
    },
  });
  const attemptTokenSecret = await loadFactoryAttemptTokenSecret(config.hostLaunch.attemptTokenSecretPath);
  return createFactoryAttemptDispatchDriver({
    database: options.database,
    service: options.service,
    installationId: config.installationId,
    attemptTokenSecret,
    attemptTokenLifetimeSeconds: FACTORY_ATTEMPT_TOKEN_LIFETIME_SECONDS,
    queue: options.queue,
    completions: options.completions,
    outcomes: options.outcomes,
    readiness: options.readiness,
    runtime: new FactoryRemoteAttemptRuntime({
      launches: new FactoryDatabaseAttemptLaunchStore(options.database),
      transport,
      readiness: options.readiness,
      mintAttemptToken: factoryAttemptTokenMinter(attemptTokenSecret, config.installationId),
      pool: options.pool,
      stop: factoryIntentPhysicalStop(options.stopper, config.hostId),
    }),
    preflight: factoryAttemptPreflight({
      database: options.database,
      queue: options.queue,
      admissions: options.admissions,
      readiness: options.readiness,
      hostId: config.hostId,
    }),
  });
}
