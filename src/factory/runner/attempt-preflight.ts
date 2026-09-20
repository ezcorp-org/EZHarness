/**
 * The dispatch preflight: what an attempt already holds, read back, never built.
 *
 * `createFactoryAttemptDispatchDriver` takes a `FactoryIsolatedRunnerPreflight`
 * and no production one existed; W01b's own end-to-end supplies a literal. This
 * is that collaborator, and the single rule it follows is why it is short: an
 * attempt's allocation identity is a durable fact somebody else recorded, so
 * this file READS it and maps it. It never derives a reservation id, never asks
 * the pool for status, and never assembles a lease from parts.
 *
 * That rule has teeth. A reservation id is a digest of the run scope and the
 * node identity (`factoryReservationIdForOrigin`), so re-deriving one here would
 * be a second implementation of an identity — and a second implementation that
 * drifted would fence the wrong allocation, which is the failure a lease exists
 * to prevent. The queue already recorded the reservation when it admitted the
 * attempt, so the reservation comes from `FactoryAttemptQueue.readInTransaction`
 * and the allocation from
 * `FactoryComputeAdmissions.readRetainedAdmittedInTransaction`, both inside one
 * transaction so the two cannot disagree.
 *
 * `readRetainedAdmittedInTransaction` rather than `readAdmittedInTransaction`:
 * a reservation that has reached `uncertain` keeps its capacity, and a
 * dispatcher recovering such an attempt still has to name the holder it fences.
 *
 * **The one field that is not a copy, and why it is still not an invention.**
 * `PoolLease.hostId` is optional and `FactoryAttemptLease.hostId` is required.
 * The pool pins a host when the allocation is physical — a GPU grant names the
 * machine that holds the card — and leaves it unset for an ordinary CPU
 * allocation, which runs on the installation's own configured host. So an
 * absent host falls back to the configured `hostId` from the startup document,
 * which is a stated deployment fact, and a GPU allocation with no pinned host
 * is REFUSED rather than sent to a host that does not hold the device.
 */
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import type { FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import type { FactoryAttemptQueue } from "../attempt-queue";
import type { FactoryComputeAdmissions } from "../compute-admissions";
import type { FactoryRunnerDispatchReadiness } from "../package-preparation";
import type { FactoryAttemptLease, FactoryIsolatedRunnerPreflight } from "./attempt-runtime";

export type FactoryAttemptPreflightCode =
  | "factory_preflight_not_queued"
  | "factory_preflight_not_admitted"
  | "factory_preflight_host_missing";

export class FactoryAttemptPreflightError extends Error {
  constructor(readonly code: FactoryAttemptPreflightCode, message: string) {
    super(message);
    this.name = "FactoryAttemptPreflightError";
  }
}

export interface FactoryAttemptPreflightOptions {
  readonly database: TransactionalDb;
  /** W03's durable queue; it recorded this attempt's reservation when it admitted it. */
  readonly queue: Pick<FactoryAttemptQueue, "readInTransaction">;
  /** W03's compute-admission ledger; it holds the pool lease this attempt was admitted on. */
  readonly admissions: Pick<FactoryComputeAdmissions, "readRetainedAdmittedInTransaction">;
  readonly readiness: FactoryRunnerDispatchReadiness;
  /** This installation's host, for an allocation the pool did not pin. */
  readonly hostId: string;
}

/** `gpu-host` on the admitted vector, when the pool recorded one. */
function gpuHosts(resources: unknown): number {
  const vector = resources as { readonly "gpu-host"?: unknown } | null | undefined;
  const requested = vector?.["gpu-host"];
  return typeof requested === "number" && Number.isFinite(requested) ? requested : 0;
}

export function factoryAttemptPreflight(options: FactoryAttemptPreflightOptions): FactoryIsolatedRunnerPreflight {
  if (typeof options.hostId !== "string" || options.hostId.length === 0) {
    throw new FactoryAttemptPreflightError("factory_preflight_host_missing", "A dispatch preflight needs this installation's host id.");
  }

  async function leaseInTransaction(transaction: MigrationDb, request: FactoryRunnerRequest): Promise<FactoryAttemptLease> {
    const { projectId, runId, attemptId } = request.authority;
    const delivery = await options.queue.readInTransaction(transaction, projectId, attemptId);
    if (!delivery) {
      throw new FactoryAttemptPreflightError("factory_preflight_not_queued", `Factory attempt ${attemptId} has no durable queue record to read its reservation from.`);
    }
    const reservationId = delivery.reference.reservationId;
    const material = await options.admissions.readRetainedAdmittedInTransaction(transaction, { projectId, runId, reservationId });
    const lease = material.receipt.lease;
    if (lease.reservationId !== reservationId) {
      throw new FactoryAttemptPreflightError("factory_preflight_not_admitted", `Factory reservation ${reservationId} is admitted under a different reservation.`);
    }
    // A physical allocation names its machine. Falling back to the configured
    // host for a GPU grant would dispatch to a host that does not hold the card.
    if (lease.hostId === undefined && gpuHosts(lease.resources) > 0) {
      throw new FactoryAttemptPreflightError("factory_preflight_host_missing", `Factory reservation ${reservationId} holds a GPU allocation with no pinned host.`);
    }
    return Object.freeze({
      reservationId: lease.reservationId,
      grantRevision: lease.grantRevision,
      allocationGeneration: lease.allocationGeneration,
      holderGeneration: lease.holderGeneration,
      allocationToken: lease.allocationToken,
      hostId: lease.hostId ?? options.hostId,
    });
  }

  return Object.freeze({
    lease: (request) => options.database.transaction((transaction) => leaseInTransaction(transaction, request)),
    preparedPackage: (request) => options.readiness.assertDispatchReady(request),
  });
}
