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
import { basename, dirname, resolve as resolvePath } from "node:path";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { factoryPageDriver, type FactoryItemDisposition } from "./role-drivers";
import type { FactoryRoleDriver } from "./runtime-seams";
import type { TrustedFactoryServiceIdentity } from "./trusted-command-gateway";
import { FactoryTaskStops, type FactoryPhysicalStopper, type FactoryStopHostKey, type FactoryStoppableAttempt } from "./task-stops";
import type { FactoryBudgets, FactoryUncertainHold } from "./budgets";
import { FactoryUsageReconciliation } from "./usage-settlement";
import type { FactoryClaimableRelease, FactoryReleaseOperation, FactoryReleaseProvider, FactoryReleases } from "./releases";
import type { FactoryReleaseProviderResolver } from "./release-application";
import type { FactoryPrincipal } from "./grants";
import { createFactoryHostStopClient } from "./host-stop-client";
import { privateDirectory, readPrivateBounded } from "./private-files";
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

export function factoryStopSettlementDisposition(error: unknown): FactoryItemDisposition {
  // Durable uncertainty is backpressure: the row stays listed and a later pass
  // retries it against the same sealed request.
  if (error instanceof FactoryUncertainStopError) return "transient";
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
    //
    // An UNCERTAIN receipt is not progress. It is the host declining to confirm,
    // the row stays listed, and a later pass retries it — so raising it here is
    // what puts it in the deferred column and, with it, the reason. Counting it
    // as settled is how a run can sit in `stopping` while every pass reports
    // success.
    settle: async (item, _signal) => {
      const receipt = await stops.stop(service, item.reference);
      if (receipt.state !== "stopped") throw new FactoryUncertainStopError(item.attemptId, receipt.cause);
    },
    classify: factoryStopSettlementDisposition,
    report: (item, error, disposition) => {
      report(`stop-settlement:${disposition}:${item.attemptId}`, error instanceof FactoryUncertainStopError ? (error.cause ?? error) : error);
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

/** A host public key file. Not a secret, read through the same bounded reader. */
const MAX_HOST_PUBLIC_KEY_BYTES = 16 * 1024;

export class FactoryStopCompositionError extends Error {
  constructor(readonly code: "factory_stop_host_keys_missing" | "factory_stop_transport_missing", message: string) {
    super(message);
    this.name = "FactoryStopCompositionError";
  }
}

/**
 * The host public keys a physical-stop receipt is verified against.
 *
 * By reference in the document and by value only here, for the length of one
 * composition. `FactoryTaskStops` takes the PEM text and calls
 * `createPublicKey` itself, so this reads bytes and decides nothing: a key that
 * is not a key fails there, by name, rather than being silently skipped and
 * leaving a host whose receipts can never verify.
 */
export async function loadFactoryStopHostKeys(
  configured: readonly { readonly hostId: string; readonly hostKeyId: string; readonly publicKeyPath: string }[],
): Promise<readonly FactoryStopHostKey[]> {
  if (configured.length === 0) {
    throw new FactoryStopCompositionError("factory_stop_host_keys_missing",
      "Settling a stop needs at least one configured host public key.");
  }
  const keys = await Promise.all(configured.map(async (entry) => {
    const absolute = resolvePath(entry.publicKeyPath);
    const directory = await privateDirectory(dirname(absolute));
    let bytes: Uint8Array;
    try {
      bytes = await readPrivateBounded(directory, basename(absolute), MAX_HOST_PUBLIC_KEY_BYTES);
    } finally {
      await directory.close();
    }
    return Object.freeze({ hostId: entry.hostId, hostKeyId: entry.hostKeyId, publicKey: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
  }));
  return Object.freeze(keys);
}

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
    await loadFactoryStopHostKeys(config.hostStopKeys ?? []),
  );
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
    stopSettlement: factoryStopSettlementDriver(options.database, stops, options.service, options.report),
    usageReconciliation: factoryUsageReconciliationDriver(options.database, stores.budgets, reconciliation, options.report),
  });
}
