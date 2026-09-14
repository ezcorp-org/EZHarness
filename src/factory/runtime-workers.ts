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
import { factoryReleaseSeamsPresent, type FactoryRuntimeSeams } from "./runtime-seams";
import type { TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

/** What the compute-admission primitives report; only `idle` means no work. */
export interface FactoryComputeAdmissionDriver {
  dispatchNext(service: TrustedFactoryServiceIdentity, signal?: AbortSignal): Promise<{ readonly status: string }>;
  pollNext(service: TrustedFactoryServiceIdentity, signal?: AbortSignal): Promise<{ readonly status: string }>;
}

export interface FactoryAttemptDispatchDriver {
  dispatchOne(): Promise<{ readonly kind: string }>;
}

export interface FactoryProjectionDriver {
  projectPending(options?: { readonly runs?: number; readonly batchesPerRun?: number }): Promise<{ readonly applied: number }>;
}

/** One bounded delivery of the durable in-app release notification inbox. */
export interface FactoryNotificationInboxDriver {
  deliverNextAcrossProjects(signal: AbortSignal): Promise<boolean>;
}

export interface FactoryRuntimeWorkerCollaborators {
  readonly service: TrustedFactoryServiceIdentity;
  readonly seams: FactoryRuntimeSeams;
  readonly compute: FactoryComputeAdmissionDriver;
  readonly attempts: FactoryAttemptDispatchDriver;
  readonly projections: FactoryProjectionDriver;
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

  // Drains the `pool` destination of the durable command outbox and settles
  // each delivery through the existing state machine.
  define("compute-admission-dispatch", async (signal) =>
    progress((await collaborators.compute.dispatchNext(collaborators.service, signal)).status === "idle"));

  // Advances a reservation the pool has not yet decided. `busy` and `retry`
  // are progress: the reservation moved and the next pass may move it again.
  define("compute-admission-poll", async (signal) =>
    progress((await collaborators.compute.pollNext(collaborators.service, signal)).status === "idle"));

  define("attempt-dispatch", async () => progress((await collaborators.attempts.dispatchOne()).kind === "idle"));

  define("run-projection", async () => progress((await collaborators.projections.projectPending({ runs: projectionRuns })).applied === 0));

  if (collaborators.notificationInbox) {
    const inbox = collaborators.notificationInbox;
    define("notification-inbox-delivery", async (signal) => progress(!(await inbox.deliverNextAcrossProjects(signal))));
  } else {
    hold("notification-inbox-delivery", "destination-reservations", "W07/W08",
      "the release store cannot be composed until its destination reservation and sender fence land");
  }

  // No scan exists for a child run whose parent has not settled it:
  // `FactoryChildRuns` exposes `resolve` and `settle`, both keyed by an exact
  // child, and nothing lists the settleable set. Inventing a scan here would
  // put a lifecycle query in the composition root and duplicate the owner's.
  hold("child-settlement", "current-candidate", "W05",
    "FactoryChildRuns has no settleable-child scan; the run lifecycle owner must expose one");

  // Held for one of two distinct reasons, and the operator needs to know which:
  // either the release store itself cannot be built, or it can and still has no
  // way to enumerate the operations an outcome loop would claim.
  hold("release-outcome", "release-providers", "W07/W08", factoryReleaseSeamsPresent(collaborators.seams)
    ? "the release store composes, but no claimable-operation scan exists to drive an outcome loop"
    : "a release outcome needs the provider resolver, the destination reservation, and the sender fence");

  if (!collaborators.seams.usageReconciler.present) {
    hold("usage-reconciliation", "usage-reconciler", "W03",
      "an uncertain reservation is never settled as zero; reconciliation needs the trusted reconciler");
  }

  if (!collaborators.seams.notificationSender.present) {
    hold("notification-send", "notification-sender", "W17",
      "a notification is not delivered until a sender confirms it left this host");
  }

  if (!collaborators.seams.physicalStopper.present) {
    hold("stop-settlement", "physical-stopper", "W03",
      "a stop is settled only against a signed physical-stop receipt, never against an API answer");
  }

  return Object.freeze({ workers, held: Object.freeze(held) });
}
