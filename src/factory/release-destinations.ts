import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { assertFactoryIdentity } from "./records";
import { FactoryReleaseError, type FactoryDestinationReservationReader, type FactoryProviderReceipt, type FactoryReleaseOperation, type FactorySenderFence } from "./releases";

/**
 * The two seams the release store takes and nothing in production implemented.
 *
 * Both are deliberately database-only. `FactoryReleases.claim` calls the reservation reader inside
 * its product transaction, and freeze correction 1 forbids provider network I/O there, so a reader
 * that asked GitHub or S3 for the live destination would reintroduce exactly the defect this
 * package removed. The durable reservation row is the destination's authority of record: `claim`
 * writes it, `settleReceipt` confirms it, and `confirm_no_effect` releases it.
 */

/** How long after its last product write a sender is provably no longer in flight. */
export const FACTORY_SENDER_QUIET_PERIOD_MS = 120_000;

export interface FactoryDestinationReservationOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
}

/**
 * The durable destination reservation.
 *
 * `reserveInTransaction` takes the row lock that makes the reservation exclusive for the rest of
 * the product transaction, then reports the version the destination is known to hold. That version
 * comes from the confirmed receipt of whichever operation last published there, so it is a fact the
 * platform itself recorded rather than a read of the remote system inside a transaction.
 *
 * A destination nobody has published to reports `null`, which is what a git ref that does not yet
 * exist and an object-store key that has never been written both look like. `claim` then requires
 * `destination.expectedVersion` to equal it, so a first publication must declare no expected
 * version and a republication must name the exact version it expects to replace.
 */
export class FactoryDestinationReservations implements FactoryDestinationReservationReader {
  readonly tenantId: string;
  constructor(options: FactoryDestinationReservationOptions) {
    assertFactoryIdentity(options.tenantId);
    this.tenantId = options.tenantId;
  }

  async reserveInTransaction(transaction: MigrationDb, tenantId: string, operation: FactoryReleaseOperation): Promise<{ readonly currentVersion: string | null }> {
    if (tenantId !== this.tenantId || operation.tenantId !== this.tenantId) throw new FactoryReleaseError("factory_release_scope");
    const held = rows<{ operation_id: string; state: "held" | "confirmed" | "released"; dispatch_generation: number | string; receipt_json: string | null; operation_state: string | null }>(await transaction.execute(sql`
      SELECT r.operation_id,r.state,r.dispatch_generation,o.receipt_json,o.state AS operation_state
      FROM factory_release_destination_reservations r
      LEFT JOIN factory_release_operations o ON o.tenant_id=r.tenant_id AND o.project_id=r.project_id AND o.operation_id=r.operation_id
      WHERE r.tenant_id=${this.tenantId} AND r.destination_provider=${operation.destination.provider}
        AND r.destination_account=${operation.destination.account} AND r.destination_object=${operation.destination.object}
      FOR UPDATE OF r`))[0];
    if (!held || held.state !== "confirmed") return { currentVersion: null };
    if (!held.receipt_json) throw new FactoryReleaseError("factory_release_corrupt");
    let receipt: FactoryProviderReceipt;
    try { receipt = JSON.parse(held.receipt_json) as FactoryProviderReceipt; }
    catch { throw new FactoryReleaseError("factory_release_corrupt"); }
    if (receipt.operationId !== held.operation_id || receipt.provider !== operation.destination.provider || receipt.account !== operation.destination.account || receipt.object !== operation.destination.object) throw new FactoryReleaseError("factory_release_corrupt");
    if (typeof receipt.version !== "string" || receipt.version.length < 1) throw new FactoryReleaseError("factory_release_corrupt");
    return { currentVersion: receipt.version };
  }
}

export interface FactoryStoreSenderFenceOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  /** Must exceed any provider request timeout the broker can still have outstanding. */
  readonly quietPeriodMs?: number;
  readonly now?: () => number;
}

/**
 * Proves that the sender holding one token can no longer produce an effect.
 *
 * Two facts together make that true, and both are durable. The store has already refused every
 * further publish under this token, because `beginDispatch` only ever succeeds once per generation
 * and the row records `dispatch_started`. And the row has not been written for longer than the
 * quiet period, which is chosen to exceed the provider request timeout, so any request that was
 * still in flight when the response was lost has since failed at the transport.
 *
 * What it deliberately does NOT do is believe the operator. The evidence must name the operation,
 * but nothing in it can assert that the sender stopped: that conclusion is derived here from the
 * product row. An operator who wants to shorten the wait has to wait.
 */
export class FactoryStoreSenderFence implements FactorySenderFence {
  readonly tenantId: string;
  private readonly database: TransactionalDb;
  private readonly quietPeriodMs: number;
  private readonly now: () => number;

  constructor(options: FactoryStoreSenderFenceOptions) {
    assertFactoryIdentity(options.tenantId);
    this.tenantId = options.tenantId;
    this.database = options.database;
    this.quietPeriodMs = options.quietPeriodMs ?? FACTORY_SENDER_QUIET_PERIOD_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.quietPeriodMs) || this.quietPeriodMs < 1) throw new FactoryReleaseError("factory_release_invalid");
  }

  async proveStopped(operation: FactoryReleaseOperation, senderToken: string, evidence: unknown, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (operation.tenantId !== this.tenantId) throw new FactoryReleaseError("factory_release_scope");
    if (typeof senderToken !== "string" || senderToken.length < 1) return false;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || (evidence as { operationId?: unknown }).operationId !== operation.operationId) return false;
    // The comparison happens here rather than in SQL so the clock stays injectable and no driver
    // has to agree about how a millisecond parameter is typed.
    const row = rows<{ sender_token: string | null; dispatch_started: boolean; dispatch_generation: number | string; state: string; updated_at_ms: number | string }>(await this.database.execute(sql`
      SELECT sender_token,dispatch_started,dispatch_generation,state,(EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_at_ms
      FROM factory_release_operations
      WHERE tenant_id=${this.tenantId} AND project_id=${operation.projectId} AND operation_id=${operation.operationId}`))[0];
    signal?.throwIfAborted();
    if (!row || row.sender_token !== senderToken || row.sender_token !== operation.senderToken) return false;
    if (Number(row.dispatch_generation) !== operation.dispatchGeneration || !row.dispatch_started) return false;
    if (!["uncertain", "executing"].includes(row.state)) return false;
    return this.now() - Number(row.updated_at_ms) >= this.quietPeriodMs;
  }
}
