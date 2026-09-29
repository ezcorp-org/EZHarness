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
import { FactoryTaskStops, type FactoryPhysicalStopper, type FactoryStoppableAttempt } from "./task-stops";
import { FactoryStopCompositionError, loadFactoryStopHostKeys } from "./stop-host-keys";
import type { FactoryBudgets, FactoryUncertainHold } from "./budgets";
import { FactoryRunEpochStaleError } from "./executions";
import { FactoryUsageReconciliation } from "./usage-settlement";
import { FactoryReleaseOutcomeBackoff } from "./release-outcome-backoff";
import { FACTORY_RELEASE_STOP_OUTCOME_UNKNOWN, FactoryReleaseError, type FactoryClaimableRelease, type FactoryReleaseConsentAbsence, type FactoryReleaseOperation, type FactoryReleaseProvider, type FactoryReleases, type FactoryStoppedRelease } from "./releases";
import type { FactoryReleaseProviderResolver } from "./release-application";
import type { FactoryReleaseOutcomeDelivery, FactoryUndeliveredReleaseOutcome } from "./release-outcome-delivery";
import type { FactoryRunLifecycle } from "./run-lifecycle";
import { createFactoryHostStopClient } from "./host-stop-client";
import { FactoryDispatchRefusedStops, factoryNothingLaunchedSettle, type FactoryDispatchRefusedStop } from "./dispatch-refused-stops";
import type { PoolAdmissionClient } from "./pool/client";
import type { FactoryInstallationStores } from "./installation-stores";
import type { FactoryStartupConfig } from "./startup-config";

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

/**
 * A stop the host would not confirm inside its bounded window.
 *
 * Carries the cause the stop store kept, so the operator's stream says which
 * fact refused rather than only that the stop is still open.
 */
export class FactoryUncertainStopError extends Error {
  readonly code = "factory_task_stop_uncertain";
  constructor(readonly attemptId: string, override readonly cause: unknown) {
    super(`factory_task_stop_uncertain: ${attemptId}`);
    this.name = "FactoryUncertainStopError";
  }
}

/**
 * A stop whose durable facts no longer verify, taken out of settlement for an
 * operator (W01h fix round). Raised once, when the stop is marked; the scan
 * never lists it again, so it cannot become a hot loop.
 */
export class FactoryStopReconciliationError extends Error {
  readonly code = "factory_task_stop_reconciliation";
  // Explicit fields, not parameter properties, so Node's type stripping can run this file.
  readonly attemptId: string;
  readonly cancelCommandId: string;
  constructor(attemptId: string, cancelCommandId: string, override readonly cause: unknown) {
    super(`factory_task_stop_reconciliation: stop ${cancelCommandId} of attempt ${attemptId} no longer verifies and is taken out of settlement for an operator: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "FactoryStopReconciliationError";
    this.attemptId = attemptId;
    this.cancelCommandId = cancelCommandId;
  }
}

export function factoryStopSettlementDisposition(error: unknown): FactoryItemDisposition {
  // Durable uncertainty is backpressure: the row stays listed and a later pass
  // retries it against the same sealed request.
  if (error instanceof FactoryUncertainStopError) return "transient";
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && FACTORY_STOP_SETTLEMENT_TRANSIENT_CODES.includes(code) ? "transient" : "fault";
}

export function factoryStopSettlementDriver(
  database: TransactionalDb,
  stops: Pick<FactoryTaskStops, "listStoppableInTransaction" | "stop" | "markForReconciliation">,
  service: TrustedFactoryServiceIdentity,
  report: (role: string, error: unknown) => void,
  limit?: number,
  refused?: Pick<FactoryDispatchRefusedStops, "listInTransaction" | "stop">,
): FactoryRoleDriver {
  return factoryPageDriver<FactoryStoppableAttempt | (FactoryDispatchRefusedStop & { readonly refused: true })>({
    // A refused dispatch's stop (W02d R8) rides on the same page: the same host, the same pool, the same role.
    page: (_signal) => database.transaction(async (transaction) => [
      ...await stops.listStoppableInTransaction(transaction, limit === undefined ? {} : { limit }),
      ...(refused === undefined ? [] : (await refused.listInTransaction(transaction, limit)).map((item) => ({ ...item, refused: true as const }))),
    ]),
    // The scan returns the cancel command reference `stop` itself takes, so the
    // settle half needs nothing this file derived.
    //
    // An UNCERTAIN receipt is not progress. It is the host declining to confirm,
    // the row stays listed, and a later pass retries it — so raising it here is
    // what puts it in the deferred column and, with it, the reason. Counting it
    // as settled is how a run can sit in `stopping` while every pass reports
    // success.
    settle: async (item, _signal) => {
      if ("refused" in item) { await refused!.stop(item); return; }
      let receipt: Awaited<ReturnType<typeof stops.stop>>;
      try { receipt = await stops.stop(service, item.reference); }
      catch (error) {
        // No retry can succeed on facts that no longer verify: mark the stop
        // once and say so loudly, instead of failing it again every pass.
        if ((error as { code?: unknown } | null | undefined)?.code !== "factory_task_stop_corrupt") throw error;
        await stops.markForReconciliation(service, item.reference, error);
        throw new FactoryStopReconciliationError(item.attemptId, item.reference.commandId, error);
      }
      if (receipt.state !== "stopped") throw new FactoryUncertainStopError(item.attemptId, receipt.cause);
    },
    classify: factoryStopSettlementDisposition,
    report: (item, error, disposition) => {
      report(`stop-settlement:${disposition}:${"refused" in item ? item.dispatchCommandId : item.attemptId}`, error instanceof FactoryUncertainStopError ? (error.cause ?? error) : error);
    },
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

/**
 * An uncertain hold whose attempt belongs to an execution epoch a restore has
 * left (W15f). Its authority can never pass the run fence in this epoch, so the
 * role marks the hold once and says so here, naming both epochs; the scan then
 * skips it until the epoch moves again. It stays a fault: the money is still
 * held, and a person decides what the old epoch's hold is worth.
 */
export class FactoryUsageHoldEpochStaleError extends Error {
  readonly code = "factory_usage_hold_epoch_stale";
  constructor(readonly reservationId: string, override readonly cause: FactoryRunEpochStaleError) {
    super(`factory_usage_hold_epoch_stale: reservation ${reservationId} of run ${cause.runId} is held by attempt ${cause.attemptId} of execution epoch ${cause.attemptEpoch}; the installation is at epoch ${cause.installationEpoch}, so it cannot be reconciled here. Marked once; not retried until the epoch moves.`);
    this.name = "FactoryUsageHoldEpochStaleError";
  }
}

/**
 * A marked hold whose attempt has ended (a signed restore superseded it) and
 * whose signed deadline has passed: it is offered to settlement again, and until
 * a bound settlement can price it, that is backpressure with a name, not a
 * fault (W15f, with W03f's bound settlement).
 */
export class FactoryUsageHoldAwaitingBoundError extends Error {
  readonly code = "factory_usage_hold_awaiting_bound";
  constructor(readonly reservationId: string, override readonly cause: FactoryRunEpochStaleError) {
    super(`factory_usage_hold_awaiting_bound: reservation ${reservationId} of run ${cause.runId} belongs to ended attempt ${cause.attemptId} of execution epoch ${cause.attemptEpoch}; it waits for a settlement at the reserved bound.`);
    this.name = "FactoryUsageHoldAwaitingBoundError";
  }
}

export function factoryUsageReconciliationDisposition(error: unknown): FactoryItemDisposition {
  // A hold whose receipt has not landed, or that waits for its bound
  // settlement, is backpressure, not an integrity fault; anything else needs a person.
  return error instanceof FactoryUnresolvedHoldError || error instanceof FactoryUsageHoldAwaitingBoundError ? "transient" : "fault";
}

export function factoryUsageReconciliationDriver(
  database: TransactionalDb,
  budgets: Pick<FactoryBudgets, "listUncertainWithCostInTransaction" | "markEpochStaleInTransaction">,
  reconciler: Pick<FactoryUsageReconciliation, "resolve" | "reconcile">,
  report: (role: string, error: unknown) => void,
  limit?: number,
  now: () => number = Date.now,
): FactoryRoleDriver {
  return factoryPageDriver<FactoryUncertainHold>({
    page: (_signal) => database.transaction((transaction) => budgets.listUncertainWithCostInTransaction(transaction, limit === undefined ? {} : { limit })),
    settle: async (hold, signal) => {
      try {
        const resolution = await reconciler.resolve(hold, signal);
        if (resolution.kind !== "resolved") throw new FactoryUnresolvedHoldError(resolution.reason);
        await reconciler.reconcile({
          reservationId: resolution.reservationId,
          attemptId: resolution.attemptId,
          operationId: resolution.operationId,
          providerReceiptDigest: resolution.providerReceiptDigest,
          usage: resolution.usage,
        }, signal);
      } catch (error) {
        if (!(error instanceof FactoryRunEpochStaleError)) throw error;
        // Mark once, then say so once. A hold that settled meanwhile is not
        // marked, and its refusal is reported as it came; one whose attempt has
        // ended waits for its bound settlement.
        const outcome = await database.transaction((transaction) => budgets.markEpochStaleInTransaction(transaction, hold, {
          attemptId: error.attemptId, attemptEpoch: error.attemptEpoch, installationEpoch: error.installationEpoch, markedAtMs: now(),
        }));
        if (outcome === "settled") throw error;
        if (outcome === "terminal") throw new FactoryUsageHoldAwaitingBoundError(hold.reservationId, error);
        throw new FactoryUsageHoldEpochStaleError(hold.reservationId, error);
      }
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
 * One claimable operation cannot be claimed on this pass, and exactly why.
 *
 * W07b's reader answers a typed absence rather than raising, and an absence is
 * an ORDINARY state: nobody has approved this release yet, or the human
 * authority that covered it has lapsed. So no claim is attempted, the
 * operation is left exactly as it was, and the reason is reported by name.
 *
 * It is carried as a thrown value because that is what the page driver reads:
 * a `settle` that returns counts as progress, and counting a release nobody
 * consented to as work done is how a role spins on a page it can never move.
 * Raising puts it in the deferred column with its reason attached, which is
 * the same shape `FactoryUnresolvedHoldError` and `FactoryUncertainStopError`
 * already use in this file. It never escapes the driver.
 */
export type FactoryReleaseUnclaimableReason = FactoryReleaseConsentAbsence | "operation_absent";

export class FactoryReleaseConsentAbsentError extends Error {
  readonly code = "factory_release_consent_absent";
  constructor(readonly reason: FactoryReleaseUnclaimableReason) {
    super(`factory_release_consent_absent: ${reason}`);
    this.name = "FactoryReleaseConsentAbsentError";
  }
}

/**
 * Two absences need a person; every other one clears itself.
 *
 * `policy_ambiguous` is two human-created authorities matching one operation,
 * which only an operator can resolve by revoking one — W07b refuses to pick
 * and so does this. `approval_foreign_decision` is an approval row paired with
 * a decision that is not its operation's, which W07b records as a corrupt
 * pairing rather than an ordinary state. The rest — nothing approved yet, an
 * expired approval, a revoked or exhausted policy — are the authority simply
 * not being there, and a later pass finds it or does not.
 */
export const FACTORY_RELEASE_CONSENT_FAULT_REASONS: readonly FactoryReleaseUnclaimableReason[] =
  Object.freeze(["policy_ambiguous", "approval_foreign_decision"]);

/**
 * A claim the other worker won, and a run that ended, are contention rather
 * than faults. `listClaimableInTransaction` takes no row lock, so two workers
 * routinely list the same operation and exactly one of them commits it.
 */
export const FACTORY_RELEASE_OUTCOME_TRANSIENT_CODES: readonly string[] =
  Object.freeze(["factory_release_claim_lost", "factory_release_not_claimable", "factory_run_stopped", FACTORY_RELEASE_STOP_OUTCOME_UNKNOWN, "factory_release_stop_settlement_stale"]);

/**
 * A release that waits for a person: consent that is not there yet. Named apart from other transients (W09e
 * R5). An operation that left the work list waits for nobody, and the two faults need an operator.
 */
function awaitingConsent(error: unknown): boolean {
  return error instanceof FactoryReleaseConsentAbsentError && error.reason !== "operation_absent" && !FACTORY_RELEASE_CONSENT_FAULT_REASONS.includes(error.reason);
}

/** The failures that leave a release where it was, so trying it again at once cannot help: it waits (W09e R5). */
function waitsBeforeRetry(error: unknown): boolean {
  return awaitingConsent(error) || (error as { code?: unknown } | null | undefined)?.code === FACTORY_RELEASE_STOP_OUTCOME_UNKNOWN;
}

export function factoryReleaseOutcomeDisposition(error: unknown): FactoryItemDisposition {
  if (error instanceof FactoryReleaseConsentAbsentError) {
    return FACTORY_RELEASE_CONSENT_FAULT_REASONS.includes(error.reason) ? "fault" : "transient";
  }
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && FACTORY_RELEASE_OUTCOME_TRANSIENT_CODES.includes(code) ? "transient" : "fault";
}

/** A stopped release whose effect the driver asks its provider about, once per pass (W09e R3). */
export interface FactoryPendingReleaseStop extends FactoryStoppedRelease {
  readonly stopOnly: true;
}

/** A settled operation the driver still owes its run an event for. */
export interface FactoryPendingReleaseDelivery extends FactoryUndeliveredReleaseOutcome {
  readonly deliverOnly: true;
}

/**
 * Claim and dispatch the next claimable release, across the tenant's projects.
 *
 * `listClaimableInTransaction` is per project, so the installation-wide shape is
 * that scan plus the project enumerator. One pass stops at the first project
 * that had work, which keeps a pass bounded and stops a busy project starving
 * the rest for the length of its backlog.
 *
 * **The consent is READ, never chosen.** W07b's
 * `readConsentInTransaction` returns the one consent that already exists —
 * the approved approval, or the automatic policy — or a typed reason there is
 * none. This driver takes whatever it says and nothing else; an earlier
 * revision took the consent as an injected function, which is a hole a caller
 * could fill with a release nobody approved.
 *
 * **The requester is the run's own initiator, re-derived live.** A background
 * role holds no authority of its own, and inventing an installation principal
 * would be an authority nobody granted. `readExecutionPlanInTransaction` is
 * the platform's existing answer for exactly this — "private command admission
 * uses the exact published plan and the live initiator" — and it is the same
 * principal `FactoryProtectedCommandEffects.requestRelease` prepared the
 * operation under. It confers nothing either: `claim` re-authorizes that
 * principal for `factory.release` inside its own transaction, and a policy is
 * keyed by the principal it was created for.
 *
 * **What is in one transaction, and what cannot be.** The initiator and the
 * consent are read in ONE transaction, which is what stops two workers reading
 * different consents and then disagreeing about why a claim failed (W07b's
 * recorded answer). `claim` opens its own transaction — it is W07's method and
 * takes no transaction argument — and re-derives acceptance, trust, the
 * destination reservation and the consent itself there. So the read half
 * mutates nothing and the mutating half is exactly one transaction: a failure
 * anywhere between them leaves the operation untouched rather than half done.
 *
 * **A settled release goes back to its run.** With `delivery`, a claim that
 * settles is delivered in the same pass, and when nothing is claimable the
 * page is the settled operations whose event is still missing. That second
 * source is what makes delivery survive a crash between settlement and
 * enqueue: the operation is found again and delivered once.
 *
 * **A release that cannot move waits (W09e R5).** A release waiting for consent, and a stopped release whose
 * provider has not answered, are tried once and then left alone for a doubling wait
 * (`FactoryReleaseOutcomeBackoff`), so each reports one line per wait rather than one per pass. A waiting
 * release is off the page, so it never keeps another from its turn. Consent that is not there yet is
 * reported as `awaiting_consent`, apart from other transients.
 */
export function factoryReleaseOutcomeDriver(
  database: TransactionalDb,
  releases: Pick<FactoryReleases, "listClaimableInTransaction" | "listStoppedInTransaction" | "inspect" | "readConsentInTransaction" | "claim" | "dispatch" | "settleStopped">,
  runs: Pick<FactoryRunLifecycle, "readExecutionPlanInTransaction">,
  projectIds: () => Promise<readonly string[]>,
  providers: FactoryReleaseProviderResolver,
  report: (role: string, error: unknown) => void,
  limit?: number,
  delivery?: Pick<FactoryReleaseOutcomeDelivery, "deliver" | "undelivered">,
  now: () => number = Date.now,
): FactoryRoleDriver {
  const backoff = new FactoryReleaseOutcomeBackoff(now);
  const key = (item: { readonly projectId: string; readonly operationId: string }) => `${item.projectId}\u0000${item.operationId}`;
  const settleStopped = async (item: FactoryPendingReleaseStop) => {
    const operation = await releases.inspect(item.projectId, item.operationId);
    if (operation === null) throw new FactoryReleaseError("factory_release_stop_settlement_stale");
    await releases.settleStopped(item.projectId, item.operationId, await providers.resolve(operation));
  };
  const claimAndDispatch = async (claimable: FactoryClaimableRelease) => {
    // The operation the consent is read against. `readConsentInTransaction`
    // re-validates every byte of it and `claim` re-reads it under a lock, so
    // an operation that moved between the scan and here costs a refusal by
    // name rather than a wrong claim.
    const operation = await releases.inspect(claimable.projectId, claimable.operationId);
    if (operation === null) throw new FactoryReleaseConsentAbsentError("operation_absent");
    const { requester, consent } = await database.transaction(async (transaction: MigrationDb) => {
      const { initiator } = await runs.readExecutionPlanInTransaction(transaction, { projectId: claimable.projectId, runId: claimable.runId });
      return { requester: initiator, consent: await releases.readConsentInTransaction(transaction, initiator, operation) };
    });
    if (consent.kind === "none") throw new FactoryReleaseConsentAbsentError(consent.reason);
    const claim = await releases.claim(requester, claimable.projectId, claimable.operationId, consent.consent);
    // A claim IS the operation (`FactoryReleaseClaim extends
    // FactoryReleaseOperation`), so the destination the resolver reads is the
    // one already persisted against this release.
    const settled = await releases.dispatch(claim, await providers.resolve(claim));
    if (delivery !== undefined) await delivery.deliver(settled.projectId, settled.operationId);
  };
  return factoryPageDriver<FactoryClaimableRelease | FactoryPendingReleaseDelivery | FactoryPendingReleaseStop>({
    async page(_signal) {
      for (const projectId of await projectIds()) {
        // A project's stopped releases ride on the same page as its claimable ones, so a release that cannot be
        // claimed on this pass never keeps a stopped one from its question (W09e R3). A waiting one is off it.
        const [claimable, stopped] = await database.transaction(async (transaction: MigrationDb) =>
          [await releases.listClaimableInTransaction(transaction, projectId, limit), await releases.listStoppedInTransaction(transaction, projectId, limit)] as const);
        const page = [...claimable, ...stopped.map((item) => ({ ...item, stopOnly: true as const }))].filter((item) => !backoff.waiting(key(item)));
        if (page.length > 0) return page;
      }
      return delivery === undefined ? [] : (await delivery.undelivered()).map((item) => ({ ...item, deliverOnly: true as const }));
    },
    settle: async (item, _signal) => {
      if ("deliverOnly" in item) {
        await delivery!.deliver(item.projectId, item.operationId);
        return;
      }
      try {
        await ("stopOnly" in item ? settleStopped(item) : claimAndDispatch(item));
        backoff.moved(key(item));
      } catch (error) {
        if (waitsBeforeRetry(error)) backoff.defer(key(item));
        throw error;
      }
    },
    classify: factoryReleaseOutcomeDisposition,
    report: (item, error, disposition) => { report(`release-outcome:${awaitingConsent(error) ? "awaiting_consent" : disposition}:${item.operationId}`, error); },
  });
}

export { FactoryStopCompositionError, loadFactoryStopHostKeys } from "./stop-host-keys";

/** What both settlement roles need beyond the stores they share. */
export interface FactorySettlementCompositionOptions {
  readonly database: TransactionalDb;
  readonly config: FactoryStartupConfig;
  readonly stores: FactoryInstallationStores & Required<Pick<FactoryInstallationStores, "compute" | "outcomes">>;
  readonly pool: Pick<PoolAdmissionClient, "confirmStopped">;
  readonly service: TrustedFactoryServiceIdentity;
  readonly report: (role: string, error: unknown) => void;
  /**
   * The host stop transport, already built.
   *
   * Supplied rather than created here so this installation opens ONE mutual-TLS
   * session to its host: the attempt runtime's post-result stop and this role's
   * cancellation settlement address the same endpoint, and two clients would be
   * two sessions that can disagree about which of them is current.
   */
  readonly stopper?: FactoryPhysicalStopper;
}

export interface FactorySettlementComposition {
  /** Also the settlement-scope authority the usage reconciler reads through. */
  readonly stops: FactoryTaskStops;
  readonly stopSettlement: FactoryRoleDriver;
  readonly usageReconciliation: FactoryRoleDriver;
}

/**
 * Compose both settlement roles, which share one `FactoryTaskStops`.
 *
 * They are composed together because they are not independent:
 * `FactoryUsageReconciliation` takes a `FactoryUsageSettlementAuthority`, and
 * the only production implementation of it is `FactoryTaskStops`. Building two
 * would give the two roles different views of the same reservation scope.
 *
 * The stop transport is the host launch endpoint. The launch service and the
 * stop service run in the same supervisor process and their paths do not
 * collide (`/v1/host/launches` against `/v1/host/stops`), so one base URL and
 * one client certificate serve both; a second endpoint would be a second
 * deployment fact for no gain.
 */
export async function composeFactorySettlement(options: FactorySettlementCompositionOptions): Promise<FactorySettlementComposition> {
  const { config, stores } = options;
  if (config.hostLaunch === undefined) {
    throw new FactoryStopCompositionError("factory_stop_transport_missing",
      "Settling a stop needs the host launch endpoint to reach the host stop service.");
  }
  const stopper = options.stopper ?? await createFactoryHostStopClient({
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
  const hostKeys = await loadFactoryStopHostKeys(config.hostStopKeys ?? []);
  const stops = new FactoryTaskStops(
    options.database,
    stores.authority,
    stores.compute,
    stores.journal,
    stores.outcomes,
    stores.queue,
    stores.budgets,
    stores.inbox,
    stores.settlements,
    stopper,
    options.pool,
    hostKeys,
  );
  const refused = new FactoryDispatchRefusedStops(options.database, config.tenantId, stopper, options.pool, hostKeys, factoryNothingLaunchedSettle(stores));
  const reconciliation = new FactoryUsageReconciliation(
    options.database,
    config.tenantId,
    stops,
    stores.journal,
    stores.budgets,
    stores.settlements,
  );
  return Object.freeze({
    stops,
    stopSettlement: factoryStopSettlementDriver(options.database, stops, options.service, options.report, undefined, refused),
    usageReconciliation: factoryUsageReconciliationDriver(options.database, stores.budgets, reconciliation, options.report),
  });
}
