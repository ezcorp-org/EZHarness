/**
 * The release fence reader, which the freeze assigns to the composition.
 *
 * `FactoryAssurance` takes a `FactoryReleaseFenceReader` and the interface's own
 * comment says the record is "returned only by the composition-owned reader
 * after it takes project, installation, run, and lifecycle locks". No package
 * ships one, and that is not an oversight: the locks it must take belong to the
 * run lifecycle, and the interface belongs to assurance, so the only place that
 * may hold both is the composition root. Every implementation in the tree
 * before this one is a test double.
 *
 * It adds no query of its own. `FactoryRunLifecycle.authorizeRunInTransaction`
 * already takes exactly those four locks — the project scope lock, the
 * `factory_runs` row `FOR UPDATE`, the `factory_run_lifecycle` row `FOR UPDATE`,
 * and an equality check against the installation's execution epoch — and
 * returns the epochs, deadline, and status a fence carries. Re-deriving any of
 * that here would be a second implementation of one concept (C13) and, worse,
 * one that could disagree with the authority it is supposed to fence against.
 *
 * Two decisions worth stating, because the alternatives look reasonable.
 *
 * **A cancelling run is returned, not refused.** The reader passes
 * `allowCancelling`, so a run whose operator cancellation is still settling
 * comes back as a fence with `status: "cancelling"`. Assurance then refuses it
 * in its own vocabulary (`factory_assurance_stale`), which is strictly more
 * informative than the lifecycle refusing it first. C02 keeps a cancelling
 * attempt's stop authority until its stop event commits, so the record exists
 * and the caller is entitled to see it.
 *
 * **A run the lifecycle refuses raises the lifecycle's own typed error.** The
 * tempting alternative is to catch `factory_run_stopped` and hand back a fence
 * carrying the terminal status. That would mean reading the status a second
 * time, from this file, against a table this file does not own — and the only
 * thing assurance can do with a terminal fence is refuse it anyway. Both paths
 * fail closed; one of them invents a second reader of `factory_run_lifecycle`.
 * So the refusal propagates as `FactoryRunLifecycleError`, a code the product's
 * API layer already maps, and no fact is fabricated to produce a nicer one.
 */
import type { MigrationDb } from "../db/migrations/types";
import type { FactoryReleaseFence, FactoryReleaseFenceReader } from "./assurance";
import type { FactoryRunFence, FactoryRunLifecycle } from "./run-lifecycle";

export class FactoryReleaseFenceError extends Error {
  readonly code = "factory_release_fence_scope";
  constructor(message: string) {
    super(message);
    this.name = "FactoryReleaseFenceError";
  }
}

/** Exactly the part of the lifecycle this reader uses, so a test needs no more. */
export interface FactoryReleaseFenceAuthority {
  readonly tenantId: string;
  authorizeRunInTransaction(transaction: MigrationDb, key: { readonly projectId: string; readonly runId: string }, allowCancelling?: boolean): Promise<FactoryRunFence>;
}

/**
 * Read one run's live fence for a release decision.
 *
 * The tenant is fixed at composition and compared against the one the caller
 * passes: assurance is per-tenant, the lifecycle is per-tenant, and a reader
 * that quietly served a foreign tenant would defeat both. The lifecycle's own
 * answer is checked the same way rather than trusted, because the fence is the
 * thing a release is fenced against.
 */
export function factoryReleaseFenceReader(lifecycle: FactoryReleaseFenceAuthority | FactoryRunLifecycle): FactoryReleaseFenceReader {
  const authority = lifecycle as FactoryReleaseFenceAuthority;
  if (typeof authority?.authorizeRunInTransaction !== "function" || typeof authority.tenantId !== "string" || authority.tenantId.length === 0) {
    throw new FactoryReleaseFenceError("A release fence reader needs a tenant-scoped run lifecycle.");
  }
  return Object.freeze({
    async readCurrentInTransaction(transaction: MigrationDb, tenantId: string, projectId: string, runId: string): Promise<FactoryReleaseFence> {
      if (tenantId !== authority.tenantId) throw new FactoryReleaseFenceError("The release fence reader is bound to one tenant.");
      const fence = await authority.authorizeRunInTransaction(transaction, { projectId, runId }, true);
      if (fence.tenantId !== tenantId || fence.projectId !== projectId || fence.runId !== runId) {
        throw new FactoryReleaseFenceError("The run lifecycle answered for a different run.");
      }
      return Object.freeze({
        runId: fence.runId,
        executionEpoch: fence.executionEpoch,
        cancellationEpoch: fence.cancellationEpoch,
        status: fence.status,
        deadlineMs: fence.deadlineAtMs,
      });
    },
  });
}
