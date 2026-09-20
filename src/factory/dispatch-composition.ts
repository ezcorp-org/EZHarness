/**
 * The four role drivers the product process assembles from stores that exist.
 *
 * Each is a bounded step over a durable scan somebody else owns, and none of
 * them adds a queue or a second state machine (C13). They live together because
 * they share one shape — page, act, classify, report — and because keeping them
 * out of `installation-startup.ts` leaves that file about WHICH roles this
 * process can drive rather than about how each one works.
 *
 * The rule every one of them follows: settle only on a fact the owning package
 * produced. A stop settles against the cancel reference its own scan returned;
 * a reconciliation settles only when the resolver answers `resolved`, never on
 * a cost this file inferred; a release dispatches to the provider the
 * operation's persisted destination names, never to a default.
 */
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { factoryPageDriver, type FactoryItemDisposition } from "./role-drivers";
import type { FactoryRoleDriver } from "./runtime-seams";
import type { TrustedFactoryServiceIdentity } from "./trusted-command-gateway";
import type { FactoryTaskStops, FactoryStoppableAttempt } from "./task-stops";
import type { FactoryBudgets, FactoryUncertainHold } from "./budgets";
import type { FactoryUsageReconciliation } from "./usage-settlement";
import type { FactoryClaimableRelease, FactoryReleaseOperation, FactoryReleaseProvider, FactoryReleases } from "./releases";
import type { FactoryReleaseProviderResolver } from "./release-application";
import type { FactoryPrincipal } from "./grants";

/**
 * Settle the next accepted cancellation against a signed physical-stop receipt.
 *
 * The scan takes no row lock by design: exclusion belongs to `stop`, which
 * locks the row it settles, so two workers may list the same cancellation and
 * only one commits it. A conflict is therefore ordinary contention here, not a
 * fault — which is the opposite of the child-settlement classifier, where a
 * conflict means two records genuinely disagree. The difference is the scan:
 * this one does not filter on terminal state, that one does.
 *
 * Durable uncertainty is not an error at all. `stop` returns a receipt whose
 * state is `uncertain` when the host could not be reached in the bounded
 * window, the row stays listed, and a later pass retries it. Nothing here has
 * to know that; it simply settles what it can and steps over the rest.
 */
export const FACTORY_STOP_SETTLEMENT_TRANSIENT_CODES: readonly string[] = Object.freeze([
  "factory_task_stop_conflict",
  "factory_task_stop_not_found",
]);

export function factoryStopSettlementDisposition(error: unknown): FactoryItemDisposition {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && FACTORY_STOP_SETTLEMENT_TRANSIENT_CODES.includes(code) ? "transient" : "fault";
}

export function factoryStopSettlementDriver(
  database: TransactionalDb,
  stops: Pick<FactoryTaskStops, "listStoppableInTransaction" | "stop">,
  service: TrustedFactoryServiceIdentity,
  report: (role: string, error: unknown) => void,
  limit?: number,
): FactoryRoleDriver {
  return factoryPageDriver<FactoryStoppableAttempt>({
    page: (_signal) => database.transaction((transaction) => stops.listStoppableInTransaction(transaction, limit === undefined ? {} : { limit })),
    // The scan returns the cancel command reference `stop` itself takes, so the
    // settle half needs nothing this file derived.
    settle: (item, _signal) => stops.stop(service, item.reference).then(() => undefined),
    classify: factoryStopSettlementDisposition,
    report: (item, error, disposition) => { report(`stop-settlement:${disposition}:${item.attemptId}`, error); },
  });
}

/**
 * Settle one uncertain hold, and only when its four facts are known.
 *
 * This is the role where the tempting shortcut is the forbidden one. A hold
 * carries a retained cost and no attempt, operation, provider receipt, or
 * measured usage; W03c's resolver either produces all four from the sealed
 * receipt the journal holds, or answers `unknown`. Settling on anything else
 * would put a number on work whose real cost nobody measured, which is exactly
 * what "an unknown cost is never settled as zero" forbids.
 *
 * So `unknown` is not a failure and not progress: the hold stays uncertain, the
 * reason is reported, and a later pass tries again once the receipt lands.
 */
export class FactoryUnresolvedHoldError extends Error {
  readonly code = "factory_usage_hold_unresolved";
  constructor(readonly reason: string) {
    super(`factory_usage_hold_unresolved: ${reason}`);
    this.name = "FactoryUnresolvedHoldError";
  }
}

export function factoryUsageReconciliationDisposition(error: unknown): FactoryItemDisposition {
  // A hold whose receipt has not landed is backpressure, not an integrity
  // fault; anything else needs a person.
  return error instanceof FactoryUnresolvedHoldError ? "transient" : "fault";
}

export function factoryUsageReconciliationDriver(
  database: TransactionalDb,
  budgets: Pick<FactoryBudgets, "listUncertainWithCostInTransaction">,
  reconciler: Pick<FactoryUsageReconciliation, "resolve" | "reconcile">,
  report: (role: string, error: unknown) => void,
  limit?: number,
): FactoryRoleDriver {
  return factoryPageDriver<FactoryUncertainHold>({
    page: (_signal) => database.transaction((transaction) => budgets.listUncertainWithCostInTransaction(transaction, limit === undefined ? {} : { limit })),
    settle: async (hold, signal) => {
      const resolution = await reconciler.resolve(hold, signal);
      if (resolution.kind !== "resolved") throw new FactoryUnresolvedHoldError(resolution.reason);
      await reconciler.reconcile({
        reservationId: resolution.reservationId,
        attemptId: resolution.attemptId,
        operationId: resolution.operationId,
        providerReceiptDigest: resolution.providerReceiptDigest,
        usage: resolution.usage,
      }, signal);
    },
    classify: factoryUsageReconciliationDisposition,
    report: (hold, error, disposition) => { report(`usage-reconciliation:${disposition}:${hold.reservationId}`, error); },
  });
}

/**
 * Which provider publishes one operation, decided by its persisted destination.
 *
 * Selection always reads the destination the operation already carries, never a
 * caller's argument and never a default: a release that fell back to some other
 * provider would publish to a place nobody approved. An unknown provider is a
 * refusal, not a guess.
 */
export class FactoryUnknownReleaseProviderError extends Error {
  readonly code = "factory_release_provider_unknown";
  constructor(provider: string) {
    super(`factory_release_provider_unknown: ${provider}`);
    this.name = "FactoryUnknownReleaseProviderError";
  }
}

export function factoryReleaseProviderResolver(
  providers: Readonly<Record<string, FactoryReleaseProvider>>,
): FactoryReleaseProviderResolver {
  const available = Object.freeze({ ...providers });
  if (Object.keys(available).length === 0) throw new FactoryUnknownReleaseProviderError("(none configured)");
  const resolver: FactoryReleaseProviderResolver = {
    resolve(operation: FactoryReleaseOperation): FactoryReleaseProvider {
      const provider = available[operation.destination.provider];
      if (!provider) throw new FactoryUnknownReleaseProviderError(operation.destination.provider);
      return provider;
    },
  };
  return Object.freeze(resolver);
}

/**
 * Claim and dispatch the next claimable release, across the tenant's projects.
 *
 * `listClaimableInTransaction` is per project, so the installation-wide shape is
 * that scan plus the project enumerator. One pass stops at the first project
 * that had work, which keeps a pass bounded and stops a busy project starving
 * the rest for the length of its backlog.
 */
export function factoryReleaseOutcomeDriver(
  database: TransactionalDb,
  releases: Pick<FactoryReleases, "listClaimableInTransaction" | "claim" | "dispatch">,
  projectIds: () => Promise<readonly string[]>,
  providers: FactoryReleaseProviderResolver,
  requester: FactoryPrincipal,
  consent: (claimable: FactoryClaimableRelease) => Parameters<FactoryReleases["claim"]>[3],
  report: (role: string, error: unknown) => void,
  limit?: number,
): FactoryRoleDriver {
  return factoryPageDriver<FactoryClaimableRelease>({
    async page(_signal) {
      for (const projectId of await projectIds()) {
        const claimable = await database.transaction((transaction: MigrationDb) =>
          releases.listClaimableInTransaction(transaction, projectId, limit));
        if (claimable.length > 0) return claimable;
      }
      return [];
    },
    settle: async (claimable, _signal) => {
      const claim = await releases.claim(requester, claimable.projectId, claimable.operationId, consent(claimable));
      // A claim IS the operation (`FactoryReleaseClaim extends
      // FactoryReleaseOperation`), so the destination the resolver reads is the
      // one already persisted against this release.
      await releases.dispatch(claim, await providers.resolve(claim));
    },
    report: (claimable, error, disposition) => { report(`release-outcome:${disposition}:${claimable.operationId}`, error); },
  });
}
