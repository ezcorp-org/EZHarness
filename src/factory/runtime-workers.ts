/**
 * The background roles W09 registers, and the ones it holds by name.
 *
 * Every registered role drives a durable primitive that already exists and has
 * no production driver today: the compute-admission outbox and poll, the
 * attempt dispatcher, the run-transition projector, and the release
 * notification inbox. None of them adds a queue (C13) — each is the loop the
 * existing primitive was written to be driven by and never was.
 *
 * A role whose collaborator a later package owns is NOT registered as a loop
 * that returns a plausible answer. It is held, with the seam and the owning
 * package named in the runtime's state, because a stop that reports `stopped`
 * without a stopped process or a release that reports `completed` without a
 * receipt is a durable false fact — exactly what the plan forbids.
 *
 * One destination is deliberately absent: the Temporal command outbox. The
 * Node orchestration process already claims it through the private service
 * (`packages/@ezcorp/factory-orchestrator/src/process.ts` `runDispatcher`), and
 * a second in-process drainer would contend with it for the same leases. Only
 * the `pool` destination is drained here.
 */
import { FactoryBackgroundWorkers, type FactoryWorkerProgress } from "./background-workers";
import type { FactoryWorkerTuning } from "./startup-config";
import { factoryReleaseSeamsPresent, type FactoryRoleDriver, type FactoryRuntimeSeams } from "./runtime-seams";
import type { TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

/** What the compute-admission primitives report; only `idle` means no work. */
export interface FactoryComputeAdmissionDriver {
  dispatchNext(service: TrustedFactoryServiceIdentity, signal?: AbortSignal): Promise<{ readonly status: string }>;
  pollNext(service: TrustedFactoryServiceIdentity, signal?: AbortSignal): Promise<{ readonly status: string }>;
}

export interface FactoryAttemptDispatchDriver {
  dispatchOne(): Promise<{ readonly kind: string; readonly attemptId?: string; readonly cause?: unknown }>;
}

/**
 * `projectPending` answers with the runs it visited, each carrying its own
 * progress. A pass did work when at least one run applied a transition; an
 * empty page and a page where every run applied nothing are both no work.
 */
export interface FactoryProjectionDriver {
  projectPending(options: { readonly runs?: number; readonly batchesPerRun?: number }): Promise<{
    readonly runs: readonly { readonly progress?: { readonly applied: number } }[];
  }>;
}

/**
 * One bounded delivery of the durable in-app release notification inbox.
 *
 * The collaborator is per project — `FactoryNotificationDelivery.deliverNext` —
 * so this installation-wide shape is the composition's, built from that call
 * and the project enumerator in `tenant-projects.ts`. It stayed unimplemented
 * for a while precisely because nothing could enumerate a tenant's projects,
 * which is worth remembering: the shape a ROLE needs is not evidence that a
 * producer exists, and the gap between the two lived in this interface's name.
 */
export interface FactoryNotificationInboxDriver {
  deliverNextAcrossProjects(signal: AbortSignal): Promise<boolean>;
}

export interface FactoryRuntimeWorkerCollaborators {
  readonly service: TrustedFactoryServiceIdentity;
  readonly seams: FactoryRuntimeSeams;
  /** Absent when this process cannot build it; the role then holds by name. */
  readonly compute?: FactoryComputeAdmissionDriver;
  readonly attempts?: FactoryAttemptDispatchDriver;
  readonly projections?: FactoryProjectionDriver;
  /** Present only once the release store is composable. */
  readonly notificationInbox?: FactoryNotificationInboxDriver;
  readonly tuning?: FactoryWorkerTuning;
  readonly report: (role: string, error: unknown) => void;
  /** Runs per projector pass. Bounded so one pass cannot hold the pool. */
  readonly projectionRuns?: number;
}

export interface FactoryHeldWorker {
  readonly role: string;
  readonly seam: string;
  readonly workPackage: string;
  readonly reason: string;
}

export interface FactoryRuntimeWorkerSet {
  readonly workers: FactoryBackgroundWorkers;
  /** Roles that exist in the plan and cannot run yet, each naming its owner. */
  readonly held: readonly FactoryHeldWorker[];
}

/** The plan's roles, in start order. Stop order is its reverse. */
export const FACTORY_WORKER_ROLES = Object.freeze([
  "compute-admission-dispatch",
  "compute-admission-poll",
  "attempt-dispatch",
  "run-projection",
  "notification-inbox-delivery",
  "child-settlement",
  "release-outcome",
  "usage-reconciliation",
  "notification-send",
  "stop-settlement",
] as const);

export type FactoryWorkerRole = (typeof FACTORY_WORKER_ROLES)[number];

function progress(idle: boolean): FactoryWorkerProgress {
  return idle ? "idle" : "worked";
}

/**
 * Register every role the composition can drive, and name every role it cannot.
 *
 * Start order matters: admission runs before dispatch so a reservation exists
 * before an attempt claims it, and projection runs before notification so the
 * inbox observes a projected run rather than an in-flight one. Stopping in
 * reverse then drains consumers before their producers.
 */
export function registerFactoryRuntimeWorkers(collaborators: FactoryRuntimeWorkerCollaborators): FactoryRuntimeWorkerSet {
  const workers = new FactoryBackgroundWorkers();
  const held: FactoryHeldWorker[] = [];
  const tuning = collaborators.tuning ?? {};
  const projectionRuns = collaborators.projectionRuns ?? 8;

  const define = (role: FactoryWorkerRole, step: (signal: AbortSignal) => Promise<FactoryWorkerProgress>) => {
    workers.register({
      name: role,
      step,
      report: (error) => { collaborators.report(role, error); },
      ...(tuning.batch === undefined ? {} : { batch: tuning.batch }),
      ...(tuning.idleDelayMs === undefined ? {} : { idleDelayMs: tuning.idleDelayMs }),
      ...(tuning.errorDelayMs === undefined ? {} : { errorDelayMs: tuning.errorDelayMs }),
      ...(tuning.maxErrorDelayMs === undefined ? {} : { maxErrorDelayMs: tuning.maxErrorDelayMs }),
    });
  };

  const hold = (role: FactoryWorkerRole, seam: string, workPackage: string, reason: string) => {
    held.push(Object.freeze({ role, seam, workPackage, reason }));
  };

  /** A role runs when its driver exists, and holds by name when it does not. */
  const role = (
    name: FactoryWorkerRole,
    driver: ((signal: AbortSignal) => Promise<FactoryWorkerProgress>) | undefined,
    seam: string,
    workPackage: string,
    reason: string,
  ) => {
    if (driver) define(name, driver);
    else hold(name, seam, workPackage, reason);
  };

  // Drains the `pool` destination of the durable command outbox and settles
  // each delivery through the existing state machine.
  const compute = collaborators.compute;
  role("compute-admission-dispatch",
    compute && (async (signal) => progress((await compute.dispatchNext(collaborators.service, signal)).status === "idle")),
    "compute-admissions", "W09",
    "the composition could not build FactoryComputeAdmissions; it needs a pool admission client");

  // Advances a reservation the pool has not yet decided. `busy` and `retry`
  // are progress: the reservation moved and the next pass may move it again.
  role("compute-admission-poll",
    compute && (async (signal) => progress((await compute.pollNext(collaborators.service, signal)).status === "idle")),
    "compute-admissions", "W09",
    "the composition could not build FactoryComputeAdmissions; it needs a pool admission client");

  // Claims a durable attempt and dispatches it to a trusted runner.
  //
  // An earlier version of this comment said the product process could not build
  // this because `FactoryPackagePreparations` requires a container `Runner`.
  // W01b corrected that and the correction matters: the constructor takes a
  // runner, but `assertDispatchReady` — the only method the dispatch path calls
  // — is a database read that never touches it. A runner is needed to PREPARE a
  // package and to run a guest, not to answer whether one is ready.
  //
  // What the product process actually needs is a `FactoryAttemptRuntime`, and
  // that is the deployment choice: `FactoryRemoteAttemptRuntime` over W01b's
  // host launch transport when the runner lives in the supervisor process, or
  // `IsolatedFactoryAttemptRuntime` when it lives here. The role registers the
  // moment `createFactoryAttemptDispatchDriver` is supplied either way.
  const attempts = collaborators.attempts;
  role("attempt-dispatch",
    attempts && (async () => {
      const dispatched = await attempts.dispatchOne();
      // An attempt whose outcome the product refused to record is the one case
      // a pass can move an attempt and leave nothing to read. It is not the
      // role failing — the pass did work — so it is reported rather than
      // thrown, and the report carries the cause the dispatcher now keeps.
      if (dispatched.kind === "outcome_unknown") {
        collaborators.report(`attempt-dispatch:outcome-unknown:${dispatched.attemptId ?? "unknown"}`, dispatched.cause ?? new Error("the attempt settled with an unknown outcome"));
      }
      return progress(dispatched.kind === "idle");
    }),
    "attempt-dispatcher", "W09",
    "this installation declares no hostLaunch endpoint, or its pool admission client could not be built, so no attempt can be launched or its completion recorded");

  const projections = collaborators.projections;
  role("run-projection",
    projections && (async () => {
      const page = await projections.projectPending({ runs: projectionRuns });
      return progress(!page.runs.some((visited) => (visited.progress?.applied ?? 0) > 0));
    }),
    "run-projector", "W09",
    "the composition could not build FactoryRunTransitionProjector");

  const inbox = collaborators.notificationInbox;
  role("notification-inbox-delivery",
    inbox && (async (signal) => progress(!(await inbox.deliverNextAcrossProjects(signal)))),
    "destination-reservations", "W07/W08",
    "the release store did not compose; the composition reports the exact cause under the release-store role");

  // The remaining four are seam-driven. Each seam is a bounded step the owning
  // package composes from its own collaborator and its own scan, so supplying it
  // registers the role rather than merely lifting the hold.
  const seamRole = (name: FactoryWorkerRole, key: keyof typeof collaborators.seams, reason: string) => {
    const seam = collaborators.seams[key];
    const driver = seam.optional() as FactoryRoleDriver | undefined;
    role(name, driver && (async (signal) => progress(!(await driver.step(signal)))), seam.seam, seam.workPackage, reason);
  };

  seamRole("child-settlement", "childSettlement",
    "the installation composes this from W06's scan and settle; it holds only where neither is reachable");
  // `release-outcome` is the one role still held, and the reason moved again —
  // forward, to the LAST collaborator.
  //
  // The consent is no longer it. W07b landed
  // `FactoryReleases.readConsentInTransaction`, the driver reads it, and the
  // requester is the run's own live initiator rather than an invented
  // background principal. The claimable scan, the project enumerator and the
  // provider resolver function were already built.
  //
  // What is left is a declaration, not code. Every provider binds a
  // destination and its credentials — `S3FactoryManifestReleaseProvider`
  // refuses any account but its own, `FactoryGitHubReleaseProvider` takes a
  // repository and a token reader — and the startup document's `release`
  // section is where an installation says which bucket or repository it owns.
  // Declare one and this process composes the providers, the resolver and the
  // profile set, and the role runs. Declare none and it holds here, because
  // picking a destination would publish to a place nobody chose.
  //
  // Which of the two reasons applies is decided by whether the release STORE
  // composed, and the inbox driver is the honest witness of that: the
  // installation builds both from the same `FactoryReleases`, so an inbox
  // means the store is there. `factoryReleaseSeamsPresent` answers the other
  // half — a caller that supplies the store's five collaborators rather than
  // letting this process compose it. A store that did not compose reports its
  // exact cause under the `release-store` role already, and repeating a guess
  // at it here would be a second, worse answer.
  seamRole("release-outcome", "releaseProviders", inbox !== undefined || factoryReleaseSeamsPresent(collaborators.seams)
    ? "the startup document declares no release destination, so there is nowhere to publish; declare one under `release.destinations` and `release.profiles` and this process composes the providers, the resolver and the profile set"
    : "a release outcome needs the release store itself, which did not compose; the composition reports the exact cause under the release-store role");
  seamRole("usage-reconciliation", "usageReconciler",
    "the reconciler composes with the stop settlement it shares a settlement authority with; both need the pool, the hostLaunch endpoint, and the configured hostStopKeys");
  seamRole("notification-send", "notificationSender",
    "a notification is not delivered until a sender confirms it left this host");
  seamRole("stop-settlement", "physicalStopper",
    "FactoryTaskStops needs the pool admission client, this installation's hostLaunch endpoint to reach the host stop service, and at least one configured hostStopKeys entry");

  return Object.freeze({ workers, held: Object.freeze(held) });
}
