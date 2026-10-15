import type { TransactionalDb } from "../../db/migrations/types";
import type { FactoryAttemptQueue } from "../attempt-queue";
import { FactoryAttemptDispatcher, type FactoryAttemptDispatchResult } from "../attempt-dispatcher";
import { factoryPackageDispatchDisposition, type FactoryRunnerDispatchReadiness } from "../package-preparation";
import type { FactoryTaskCompletions } from "../task-completions";
import type { FactoryTaskOutcomes } from "../task-outcomes";
import type { TrustedFactoryServiceIdentity } from "../trusted-command-gateway";
import { IsolatedFactoryTrustedRunner, type FactoryAttemptRuntime, type FactoryIsolatedRunnerPreflight } from "./attempt-runtime";

/**
 * What W09's `registerFactoryRuntimeWorkers` expects for the `attempt-dispatch`
 * role. `idle` is the only result that means no work; everything else, including
 * a retry, moved the attempt.
 */
export interface FactoryAttemptDispatchDriver {
  dispatchOne(): Promise<FactoryAttemptDispatchResult>;
}

export interface FactoryAttemptDispatchDriverOptions {
  readonly database: TransactionalDb;
  readonly service: TrustedFactoryServiceIdentity;
  readonly installationId: string;
  readonly attemptTokenSecret: string;
  readonly attemptTokenLifetimeSeconds?: number;
  readonly leaseMs?: number;
  readonly queue: FactoryAttemptQueue;
  readonly completions: Pick<FactoryTaskCompletions, "completeInTransaction" | "readInTransaction">;
  readonly outcomes: Pick<FactoryTaskOutcomes, "recordInTransaction" | "readInTransaction">;
  /**
   * Current package readiness. In the product process this is
   * `FactoryPackagePreparations`, whose `assertDispatchReady` is a database read
   * and needs no container runner; only its `prepare` does.
   */
  readonly readiness: FactoryRunnerDispatchReadiness;
  /**
   * Where a guest physically runs. The in-process isolated runtime when this
   * process holds a container runner, or the host launch transport when the
   * runner lives in a separate supervisor.
   */
  readonly runtime: FactoryAttemptRuntime;
  /** Supplies the held compute lease and the prepared package for one request. */
  readonly preflight: FactoryIsolatedRunnerPreflight;
}

/**
 * Composes the `attempt-dispatch` role from collaborators that already exist.
 *
 * Every step the role needs is already implemented and was never driven:
 * `FactoryAttemptQueue` claims a durable attempt, `FactoryAttemptDispatcher`
 * revalidates readiness, mints the attempt token, dispatches outside every
 * database lock, and records the completion or outcome, and
 * `IsolatedFactoryTrustedRunner` binds the launch intent and returns the
 * canonical result. This adds no queue and no second state machine (C13); it is
 * the wiring that was missing, which is why W09 could hold the role by name.
 *
 * `runtime` is the one deployment choice. Supplying the in-process isolated
 * runtime runs the guest here; supplying the host launch transport runs it in
 * the supervisor process that holds the container runner. The dispatcher cannot
 * tell the difference, which is the point.
 */
export function createFactoryAttemptDispatchDriver(options: FactoryAttemptDispatchDriverOptions): FactoryAttemptDispatchDriver {
  const runner = new IsolatedFactoryTrustedRunner(options.runtime, options.preflight, options.readiness);
  const dispatcher = new FactoryAttemptDispatcher(
    options.database,
    options.queue,
    runner,
    options.completions,
    options.outcomes,
    options.readiness,
    factoryPackageDispatchDisposition,
    {
      service: options.service,
      installationId: options.installationId,
      attemptTokenSecret: options.attemptTokenSecret,
      ...(options.attemptTokenLifetimeSeconds === undefined ? {} : { attemptTokenLifetimeSeconds: options.attemptTokenLifetimeSeconds }),
      ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    },
  );
  return Object.freeze({ dispatchOne: () => dispatcher.dispatchOne() });
}
