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
  dispatchOne(): Promise<{ readonly kind: string }>;
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
 * Nothing implements this today, and the reason is worth stating exactly
 * because the method name hides it. The collaborator that exists is
 * `FactoryNotificationDelivery.deliverNext(projectId)`, which is PER PROJECT,
 * and there is no way to enumerate a tenant's projects: `FactoryRecords` binds
 * a project row and never lists one. So an installation-wide delivery loop is
 * missing its other half, exactly as the release-outcome loop is.
 *
 * This shape is kept rather than narrowed to the per-project call because it is
 * what the ROLE needs; narrowing it would move the same gap into the composition
 * without closing it. The role holds by name until a project enumerator exists.
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
  // The product process cannot build this one from the stores alone.
  // `FactoryAttemptDispatcher` takes a `TrustedFactoryRunner` and a dispatch
  // readiness, and the only production readiness is `FactoryPackagePreparations`,
  // whose constructor requires a container `Runner` (`build`/`collectArtifacts`).
  // That is a deployment fact about which process holds a runner, not a missing
  // collaborator: the role registers the moment a dispatcher is supplied.
  const attempts = collaborators.attempts;
  role("attempt-dispatch",
    attempts && (async () => progress((await attempts.dispatchOne()).kind === "idle")),
    "attempt-dispatcher", "W09",
    "FactoryAttemptDispatcher needs a TrustedFactoryRunner and FactoryPackagePreparations, which requires a container runner this process does not hold");

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
    "every release collaborator has landed; the delivery is per project and nothing enumerates a tenant's projects");

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
  seamRole("release-outcome", "releaseProviders", factoryReleaseSeamsPresent(collaborators.seams)
    ? "FactoryReleases.listClaimableInTransaction is per project and nothing enumerates a tenant's projects"
    : "a release outcome needs the provider resolver, the destination reservation, and the sender fence");
  seamRole("usage-reconciliation", "usageReconciler",
    "W03 shipped FactoryUsageReconciler; no scan enumerates the uncertain reservations that hold a cost");
  seamRole("notification-send", "notificationSender",
    "a notification is not delivered until a sender confirms it left this host");
  seamRole("stop-settlement", "physicalStopper",
    "W03 shipped FactoryPhysicalStopper; no scan finds the next stoppable attempt to settle against its receipt");

  return Object.freeze({ workers, held: Object.freeze(held) });
}
