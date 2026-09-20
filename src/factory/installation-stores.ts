/**
 * One construction of every durable store the background roles share.
 *
 * Four roles were held in this composition for want of assembly, and each of
 * them reads through the same small set of stores: the command authority, the
 * execution journal, the attempt queue, the inbox, the budgets, and the usage
 * settlements. Building them once here is not tidiness. Several of these
 * classes refuse construction unless their collaborators agree on tenant and
 * database — `FactoryTaskStops` checks five such facts in its constructor, and
 * `FactoryTaskOutcomes` checks that the attempt queue holds the very same
 * transactional database — so a second construction with a different clock or a
 * different journal is a scope error waiting to happen rather than a duplicate.
 *
 * The split in the middle of this file is the pool. `FactoryComputeAdmissions`
 * needs an admission client, and the two task stores need `FactoryComputeAdmissions`,
 * so an installation whose pool is unreachable gets the base stores and nothing
 * that settles compute. That is the correct answer and not a degraded one: a
 * role whose store cannot be built holds by name, which is visible on
 * `/api/ready`, instead of draining a queue into an outcome nobody can charge.
 */
import type { TransactionalDb } from "../db/migrations/types";
import type { BlobStore } from "../extensions/v4/types";
import type { FactoryApplication } from "./application";
import { FactoryAttemptQueue } from "./attempt-queue";
import type { FactoryBudgets } from "./budgets";
import { FactoryChildRuns } from "./child-runs";
import { FactoryCommandAuthority } from "./command-authority";
import { FactoryComputeAdmissions } from "./compute-admissions";
import type { FactoryExecutionJournal } from "./executions";
import { FactoryInbox } from "./inbox";
import type { PoolAdmissionClient } from "./pool/client";
import { FactoryRunTransitionProjector } from "./run-transition-projector";
import { FactoryTaskCompletions } from "./task-completions";
import { FactoryTaskOutcomes } from "./task-outcomes";
import type { FactoryTransitionArtifacts } from "./transition-artifacts";
import { FactoryUsageSettlements } from "./usage-settlement";

/** What this process already holds before any role is composed. */
export interface FactoryInstallationStoreOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  readonly blobs: BlobStore;
  /** The stores the HTTP surface already composed; the roles read the same ones. */
  readonly application: Pick<FactoryApplication, "grants" | "runs" | "artifacts" | "journal">;
  readonly transitions: FactoryTransitionArtifacts;
  /** The private-service certificate identity this installation trusts to command. */
  readonly serviceSubject: string;
  /** Absent when the pool admission client could not be created. */
  readonly pool?: PoolAdmissionClient;
}

export interface FactoryInstallationStores {
  readonly authority: FactoryCommandAuthority;
  readonly journal: FactoryExecutionJournal;
  readonly queue: FactoryAttemptQueue;
  readonly inbox: FactoryInbox;
  readonly budgets: FactoryBudgets;
  readonly settlements: FactoryUsageSettlements;
  readonly children: FactoryChildRuns;
  readonly projections: FactoryRunTransitionProjector;
  /** Present only when a pool admission client exists. */
  readonly compute?: FactoryComputeAdmissions;
  readonly completions?: FactoryTaskCompletions;
  readonly outcomes?: FactoryTaskOutcomes;
}

/**
 * Build the store set, sharing one journal, one queue, and one inbox.
 *
 * The journal comes from the application rather than being built again. It is
 * constructed there with the run lifecycle's own attempt authorizer, and a
 * second journal built here with a different authorizer would authorize
 * attempts by one rule on the HTTP path and another in the background.
 */
export function factoryInstallationStores(options: FactoryInstallationStoreOptions): FactoryInstallationStores {
  const { database, tenantId, application } = options;
  const authority = new FactoryCommandAuthority(database, tenantId, application.runs, options.transitions, [options.serviceSubject]);
  const journal = application.journal;
  const queue = new FactoryAttemptQueue(database, journal, tenantId);
  const inbox = new FactoryInbox(database, tenantId);
  const budgets = application.runs.budgets;
  const settlements = new FactoryUsageSettlements(database, tenantId, inbox);
  const children = new FactoryChildRuns(database, tenantId, authority, application.runs, options.transitions);
  const projections = new FactoryRunTransitionProjector(database, tenantId, options.transitions, application.runs);

  const base = { authority, journal, queue, inbox, budgets, settlements, children, projections };
  if (options.pool === undefined) return Object.freeze(base);

  const compute = new FactoryComputeAdmissions(database, tenantId, authority, budgets, inbox, options.pool);
  return Object.freeze({
    ...base,
    compute,
    completions: new FactoryTaskCompletions(database, authority, compute, journal, queue, application.artifacts, budgets, inbox),
    outcomes: new FactoryTaskOutcomes(database, authority, compute, journal, queue, budgets, inbox),
  });
}
