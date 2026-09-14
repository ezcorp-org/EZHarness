import { createHash } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import { isUnsignedDecimal } from "@ezcorp/factory-sdk";
import type { FactoryMeasuredUsage } from "@ezcorp/factory-sdk";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryAttemptAuthority, FactoryJournalOperationEvidence } from "./executions";
import type { FactoryUncertainHold } from "./budgets";
import { validateFactoryOperationUsage } from "./journal-validation";
import type { FactoryInbox } from "./inbox";
import { lockFactoryScope } from "./locks";
import { assertFactoryIdentity, encodeFactoryPayload } from "./records";

export const FACTORY_USAGE_SETTLEMENT_SCHEMA_VERSION = "factory.usage-settlement.v1" as const;

export type FactoryUsageSettlementSource = "stop" | "reconciliation";

export type FactoryUsageSettlementCode =
  | "factory_usage_settlement_invalid"
  | "factory_usage_settlement_receipt_invalid"
  | "factory_usage_settlement_regressed"
  | "factory_usage_settlement_conflict"
  | "factory_usage_settlement_state"
  | "factory_usage_settlement_corrupt"
  | "factory_usage_settlement_not_found"
  | "factory_usage_settlement_scope";

/** Every member, so W14 can prove its HTTP mapping is total. */
export const FACTORY_USAGE_SETTLEMENT_CODES: readonly FactoryUsageSettlementCode[] = Object.freeze([
  "factory_usage_settlement_invalid",
  "factory_usage_settlement_receipt_invalid",
  "factory_usage_settlement_regressed",
  "factory_usage_settlement_conflict",
  "factory_usage_settlement_state",
  "factory_usage_settlement_corrupt",
  "factory_usage_settlement_not_found",
  "factory_usage_settlement_scope",
]);

export class FactoryUsageSettlementError extends Error {
  constructor(readonly code: FactoryUsageSettlementCode) { super(code); this.name = "FactoryUsageSettlementError"; }
}

export type FactoryUsageSettledEvent = Extract<KernelEvent, { readonly kind: "usage-settled" }>;

export interface FactoryUsageSettlement {
  readonly schemaVersion: typeof FACTORY_USAGE_SETTLEMENT_SCHEMA_VERSION;
  readonly reservationId: string;
  readonly attemptId: string;
  /** Monotonic per reservation. Starts at 1. */
  readonly revision: number;
  readonly source: FactoryUsageSettlementSource;
  /** Unsigned decimal string. Never a number. */
  readonly knownCostMicros: string;
  /** Omitted only when nothing is held. An unknown cost is never settled as zero. */
  readonly unknownCostMicros?: string;
  /** Required when source is "reconciliation". */
  readonly providerReceiptDigest?: string;
  readonly settledAtMs: number;
  /** `sha256:` over the canonical settlement, excluding this field. */
  readonly settlementDigest: string;
  readonly event: FactoryUsageSettledEvent;
}

export interface FactoryUsageSettlementInput {
  readonly reservationId: string;
  readonly attemptId: string;
  readonly authority: FactoryAttemptAuthority;
  readonly revision: number;
  readonly source: FactoryUsageSettlementSource;
  readonly knownCostMicros: string;
  readonly unknownCostMicros?: string;
  readonly providerReceiptDigest?: string;
  readonly settledAtMs: number;
}

/** Why a listed hold still cannot be reconciled. Never a reason to invent a cost. */
export type FactoryUncertainHoldUnknownReason =
  | "no-sealed-attempt"
  | "no-operation-receipt"
  | "usage-still-unknown";

/**
 * What a listed hold resolves to.
 *
 * `resolved` carries exactly the four facts `FactoryUsageReconciler.reconcile`
 * needs, every one of them read from evidence the journal already sealed.
 * `unknown` is a first-class answer: the hold stays held, and the caller waits.
 */
export type FactoryUncertainHoldResolution =
  | {
      readonly kind: "resolved";
      readonly reservationId: string;
      readonly attemptId: string;
      readonly operationId: string;
      readonly providerReceiptDigest: string;
      readonly usage: FactoryMeasuredUsage;
    }
  | { readonly kind: "unknown"; readonly reservationId: string; readonly reason: FactoryUncertainHoldUnknownReason };

/** Trusted later reconciliation of an operation whose cost was unknown. */
export interface FactoryUsageReconciler {
  reconcile(
    input: {
      readonly reservationId: string;
      readonly attemptId: string;
      readonly operationId: string;
      readonly providerReceiptDigest: string;
      readonly usage: FactoryMeasuredUsage;
    },
    signal?: AbortSignal,
  ): Promise<FactoryUsageSettlement>;
}

const RECEIPT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function opaqueText(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && ![...value].some(character => (character.codePointAt(0) ?? 0) < 0x20);
}

function settlementCounter(value: unknown, minimum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

/** One idempotent event per revision. The id never varies with the amount. */
export function factoryUsageSettlementEventId(reservationId: string, revision: number): string {
  if (!opaqueText(reservationId) || !settlementCounter(revision, 1)) throw new FactoryUsageSettlementError("factory_usage_settlement_invalid");
  return `${reservationId}:usage:${revision}`;
}

/** The canonical digest identifies the settlement body, never the stored row. */
export function factoryUsageSettlementDigest(settlement: Omit<FactoryUsageSettlement, "settlementDigest">): string {
  return `sha256:${createHash("sha256").update(canonicalJson(settlement)).digest("hex")}`;
}

/**
 * Builds the sealed settlement and its one kernel event together, so a caller
 * cannot enqueue an event whose amounts differ from the record it stores.
 */
export function buildFactoryUsageSettlement(input: FactoryUsageSettlementInput): FactoryUsageSettlement {
  if (!opaqueText(input.reservationId) || !opaqueText(input.attemptId) || !settlementCounter(input.revision, 1) || !settlementCounter(input.settledAtMs, 0)) throw new FactoryUsageSettlementError("factory_usage_settlement_invalid");
  if (input.source !== "stop" && input.source !== "reconciliation") throw new FactoryUsageSettlementError("factory_usage_settlement_invalid");
  if (typeof input.knownCostMicros !== "string" || !isUnsignedDecimal(input.knownCostMicros)) throw new FactoryUsageSettlementError("factory_usage_settlement_invalid");
  if (input.unknownCostMicros !== undefined && (typeof input.unknownCostMicros !== "string" || !isUnsignedDecimal(input.unknownCostMicros))) throw new FactoryUsageSettlementError("factory_usage_settlement_invalid");
  if (input.providerReceiptDigest !== undefined && !RECEIPT_DIGEST_PATTERN.test(input.providerReceiptDigest)) throw new FactoryUsageSettlementError("factory_usage_settlement_receipt_invalid");
  if (input.source === "reconciliation" && input.providerReceiptDigest === undefined) throw new FactoryUsageSettlementError("factory_usage_settlement_receipt_invalid");
  if (input.attemptId !== input.authority.attemptId) throw new FactoryUsageSettlementError("factory_usage_settlement_invalid");
  const event: FactoryUsageSettledEvent = Object.freeze({
    kind: "usage-settled" as const,
    id: factoryUsageSettlementEventId(input.reservationId, input.revision),
    atMs: input.settledAtMs,
    nodeId: input.authority.nodeInstanceId,
    commandId: input.authority.attemptId,
    candidateGeneration: input.authority.candidateGeneration,
    attempt: input.authority.attemptNumber,
    revision: input.revision,
    knownCostMicros: input.knownCostMicros,
    ...(input.unknownCostMicros === undefined ? {} : { unknownCostMicros: input.unknownCostMicros }),
  });
  const body = {
    schemaVersion: FACTORY_USAGE_SETTLEMENT_SCHEMA_VERSION,
    reservationId: input.reservationId,
    attemptId: input.attemptId,
    revision: input.revision,
    source: input.source,
    knownCostMicros: input.knownCostMicros,
    ...(input.unknownCostMicros === undefined ? {} : { unknownCostMicros: input.unknownCostMicros }),
    ...(input.providerReceiptDigest === undefined ? {} : { providerReceiptDigest: input.providerReceiptDigest }),
    settledAtMs: input.settledAtMs,
    event,
  } as const;
  return Object.freeze({ ...body, settlementDigest: factoryUsageSettlementDigest(body) });
}

/** A stored settlement must still hash to its own body and carry its own event id. */
export function factoryUsageSettlementIsIntact(settlement: FactoryUsageSettlement): boolean {
  const { settlementDigest, ...body } = settlement;
  return settlementDigest === factoryUsageSettlementDigest(body)
    && settlement.schemaVersion === FACTORY_USAGE_SETTLEMENT_SCHEMA_VERSION
    && settlement.event.id === `${settlement.reservationId}:usage:${settlement.revision}`
    && settlement.event.revision === settlement.revision
    && settlement.event.knownCostMicros === settlement.knownCostMicros
    && settlement.event.unknownCostMicros === settlement.unknownCostMicros
    && settlement.event.atMs === settlement.settledAtMs;
}

/**
 * A revision advances only when the settled amount really changed. A repeat of
 * the same amounts is the same settlement, and a lower known cost is a regression.
 */
export function factoryUsageSettlementAdvance(
  previous: Pick<FactoryUsageSettlement, "knownCostMicros" | "unknownCostMicros"> | undefined,
  next: Pick<FactoryUsageSettlement, "knownCostMicros" | "unknownCostMicros">,
): "first" | "unchanged" | "advanced" {
  if (!previous) return "first";
  if (BigInt(next.knownCostMicros) < BigInt(previous.knownCostMicros)) throw new FactoryUsageSettlementError("factory_usage_settlement_regressed");
  if (previous.knownCostMicros === next.knownCostMicros && previous.unknownCostMicros === next.unknownCostMicros) return "unchanged";
  return "advanced";
}

interface SettlementRow {
  reservation_id: string;
  revision: number | string;
  attempt_id: string;
  source: FactoryUsageSettlementSource;
  known_cost_micros: string;
  unknown_cost_micros: string | null;
  provider_receipt_digest: string | null;
  settled_at_ms: number | string;
  settlement_digest: string;
  event_json: string;
  event_digest: string;
}

/** One reservation's settlement scope. The authority seals the event identity. */
export interface FactoryUsageSettlementScope {
  readonly projectId: string;
  readonly runId: string;
  readonly interpreterId: string;
  readonly reservationId: string;
  readonly authority: FactoryAttemptAuthority;
}

export interface FactoryUsageSettlementAmounts {
  readonly source: FactoryUsageSettlementSource;
  readonly knownCostMicros: string;
  readonly unknownCostMicros?: string;
  readonly providerReceiptDigest?: string;
}

/** Reservation states that can hold a settled cost. `held` never started. */
const SETTLEABLE_STATES = new Set(["running", "uncertain", "settled"]);

/**
 * Durable usage settlements. One row per reservation revision; the kernel event
 * is enqueued in the same transaction through the shared durable inbox, so a
 * settled amount and the event that reports it can never disagree.
 */
export class FactoryUsageSettlements {
  constructor(
    private readonly database: TransactionalDb,
    readonly tenantId: string,
    private readonly inbox: FactoryInbox,
    private readonly now: () => number = Date.now,
  ) {
    assertFactoryIdentity(tenantId);
    if (inbox.tenantId !== tenantId) throw new FactoryUsageSettlementError("factory_usage_settlement_scope");
  }

  get transactionalDatabase(): TransactionalDb { return this.database; }

  /** The newest settlement for one reservation, verified against its own digest. */
  async readLatestInTransaction(transaction: MigrationDb, scope: Pick<FactoryUsageSettlementScope, "projectId" | "runId" | "reservationId">): Promise<FactoryUsageSettlement | undefined> {
    const row = (await this.rows(transaction, scope, false))[0];
    return row && this.decode(row);
  }

  /** The settlement one verified provider receipt already produced, if any. */
  async readByReceiptInTransaction(transaction: MigrationDb, scope: Pick<FactoryUsageSettlementScope, "projectId" | "runId" | "reservationId">, providerReceiptDigest: string): Promise<FactoryUsageSettlement | undefined> {
    if (!RECEIPT_DIGEST_PATTERN.test(providerReceiptDigest)) throw new FactoryUsageSettlementError("factory_usage_settlement_receipt_invalid");
    return (await this.rows(transaction, scope, false)).map(row => this.decode(row)).find(entry => entry.providerReceiptDigest === providerReceiptDigest);
  }

  /**
   * Records one settlement and its single event. A repeat of the same provider
   * receipt returns the stored settlement; an unchanged amount returns the
   * current revision; neither emits a second event.
   */
  async recordInTransaction(transaction: MigrationDb, value: FactoryUsageSettlementScope, valueAmounts: FactoryUsageSettlementAmounts): Promise<FactoryUsageSettlement> {
    const scope = Object.freeze({ projectId: value.projectId, runId: value.runId, interpreterId: value.interpreterId, reservationId: value.reservationId, authority: value.authority });
    const amounts = Object.freeze({ ...valueAmounts });
    assertFactoryIdentity(scope.projectId, scope.runId, scope.interpreterId, scope.reservationId);
    if (!await lockFactoryScope(transaction, this.tenantId, scope.projectId)) throw new FactoryUsageSettlementError("factory_usage_settlement_scope");
    const reservation = rows<{ state: string }>(await transaction.execute(sql`SELECT state FROM factory_budget_reservations WHERE tenant_id=${this.tenantId} AND project_id=${scope.projectId} AND run_id=${scope.runId} AND reservation_id=${scope.reservationId} FOR UPDATE`))[0];
    if (!reservation) throw new FactoryUsageSettlementError("factory_usage_settlement_not_found");
    if (!SETTLEABLE_STATES.has(reservation.state)) throw new FactoryUsageSettlementError("factory_usage_settlement_state");
    const stored = (await this.rows(transaction, scope, true)).map(row => this.decode(row));
    if (amounts.providerReceiptDigest !== undefined) {
      const replay = stored.find(entry => entry.providerReceiptDigest === amounts.providerReceiptDigest);
      if (replay) {
        if (replay.knownCostMicros !== amounts.knownCostMicros || replay.unknownCostMicros !== amounts.unknownCostMicros || replay.source !== amounts.source) throw new FactoryUsageSettlementError("factory_usage_settlement_conflict");
        return replay;
      }
    }
    const previous = stored[0];
    const advance = factoryUsageSettlementAdvance(previous, amounts);
    if (advance === "unchanged" && previous) return previous;
    const settlement = buildFactoryUsageSettlement({
      reservationId: scope.reservationId, attemptId: scope.authority.attemptId, authority: scope.authority,
      revision: previous ? previous.revision + 1 : 1, source: amounts.source,
      knownCostMicros: amounts.knownCostMicros,
      ...(amounts.unknownCostMicros === undefined ? {} : { unknownCostMicros: amounts.unknownCostMicros }),
      ...(amounts.providerReceiptDigest === undefined ? {} : { providerReceiptDigest: amounts.providerReceiptDigest }),
      settledAtMs: this.clock(previous?.settledAtMs ?? 0),
    });
    await transaction.execute(sql`INSERT INTO factory_usage_settlements (tenant_id,project_id,run_id,reservation_id,revision,attempt_id,source,known_cost_micros,unknown_cost_micros,provider_receipt_digest,settled_at_ms,settlement_digest,event_json,event_digest) VALUES (${this.tenantId},${scope.projectId},${scope.runId},${scope.reservationId},${settlement.revision},${settlement.attemptId},${settlement.source},${settlement.knownCostMicros},${settlement.unknownCostMicros ?? null},${settlement.providerReceiptDigest ?? null},${settlement.settledAtMs},${settlement.settlementDigest},${encodeFactoryPayload(settlement.event)},${`sha256:${digestObject(settlement.event)}`})`);
    await this.inbox.enqueueInTransaction(transaction, { projectId: scope.projectId, runId: scope.runId, interpreterId: scope.interpreterId }, settlement.event);
    return settlement;
  }

  private clock(minimum: number): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0 || value < minimum) throw new FactoryUsageSettlementError("factory_usage_settlement_invalid");
    return value;
  }

  private async rows(transaction: MigrationDb, scope: Pick<FactoryUsageSettlementScope, "projectId" | "runId" | "reservationId">, lock: boolean): Promise<SettlementRow[]> {
    return rows<SettlementRow>(await transaction.execute(sql`SELECT reservation_id,revision,attempt_id,source,known_cost_micros,unknown_cost_micros,provider_receipt_digest,settled_at_ms,settlement_digest,event_json,event_digest FROM factory_usage_settlements WHERE tenant_id=${this.tenantId} AND project_id=${scope.projectId} AND run_id=${scope.runId} AND reservation_id=${scope.reservationId} ORDER BY revision DESC${lock ? sql` FOR UPDATE` : sql``}`));
  }

  private decode(row: SettlementRow): FactoryUsageSettlement {
    let event: FactoryUsageSettledEvent;
    try { event = JSON.parse(row.event_json) as FactoryUsageSettledEvent; }
    catch { throw new FactoryUsageSettlementError("factory_usage_settlement_corrupt"); }
    const body = {
      schemaVersion: FACTORY_USAGE_SETTLEMENT_SCHEMA_VERSION,
      reservationId: row.reservation_id,
      attemptId: row.attempt_id,
      revision: Number(row.revision),
      source: row.source,
      knownCostMicros: row.known_cost_micros,
      ...(row.unknown_cost_micros === null ? {} : { unknownCostMicros: row.unknown_cost_micros }),
      ...(row.provider_receipt_digest === null ? {} : { providerReceiptDigest: row.provider_receipt_digest }),
      settledAtMs: Number(row.settled_at_ms),
      event,
    } as const;
    const settlement = Object.freeze({ ...body, settlementDigest: row.settlement_digest });
    if (!factoryUsageSettlementIsIntact(settlement) || row.event_digest !== `sha256:${digestObject(event)}` || encodeFactoryPayload(event) !== row.event_json) throw new FactoryUsageSettlementError("factory_usage_settlement_corrupt");
    return settlement;
  }
}

/**
 * The sealed settlement scope for one reservation. `FactoryTaskStops`
 * implements it, so reconciliation binds the same attempt the stop sealed and
 * this module keeps no dependency on the stop store.
 */
export interface FactoryUsageSettlementAuthority {
  readSettlementScopeInTransaction(transaction: MigrationDb, reservationId: string): Promise<FactoryUsageSettlementScope | undefined>;
}

/** The journal seam a late receipt writes through. It never advances the cursor. */
export interface FactoryUsageJournal {
  reconcileLate(authority: FactoryAttemptAuthority, operationId: string, result: { readonly providerReceiptDigest: string; readonly usage: FactoryMeasuredUsage }): Promise<void>;
  /** The sealed operation evidence the journal already holds for one attempt. */
  operations(authority: FactoryAttemptAuthority): Promise<readonly FactoryJournalOperationEvidence[]>;
}

/** The budget seam a verified receipt settles through. */
export interface FactoryUsageBudgets {
  settleInTransaction(transaction: MigrationDb, key: { readonly projectId: string; readonly runId: string; readonly reservationId: string }, actual: { readonly costMicros: string; readonly tokens: number; readonly computeMs: number }, receiptDigest: string): Promise<void>;
}

/**
 * Trusted later reconciliation of an operation whose cost was unknown.
 *
 * It settles the original operation only: the reservation and attempt come
 * from the sealed stop, never from the caller, so a late receipt can never
 * re-open a reservation for different work or launch replacement work.
 */
export class FactoryUsageReconciliation implements FactoryUsageReconciler {
  constructor(
    private readonly database: TransactionalDb,
    readonly tenantId: string,
    private readonly scopes: FactoryUsageSettlementAuthority,
    private readonly journal: FactoryUsageJournal,
    private readonly budgets: FactoryUsageBudgets,
    private readonly settlements: FactoryUsageSettlements,
  ) {
    assertFactoryIdentity(tenantId);
    if (settlements.tenantId !== tenantId) throw new FactoryUsageSettlementError("factory_usage_settlement_scope");
  }

  /**
   * Maps one listed hold to the four facts reconciliation needs, or says it
   * cannot yet.
   *
   * Everything returned is read from evidence the journal already sealed. It
   * never synthesizes a usage and never treats an absent receipt as a zero
   * cost: an unresolved hold stays held, which is the whole point of C03's
   * fail-closed unknown-usage rule.
   *
   * The operation it reads is the one that caused the hold: the journal marks
   * exactly that one `uncertain`, and that state is the only one whose provider
   * receipt digest is mandatory. A receipt attached to some other operation,
   * settled or failed, is therefore never mistaken for this hold's evidence.
   */
  async resolve(hold: FactoryUncertainHold, signal?: AbortSignal): Promise<FactoryUncertainHoldResolution> {
    const reservationId = hold.reservationId;
    assertFactoryIdentity(hold.projectId, hold.runId, reservationId);
    signal?.throwIfAborted();
    const scope = await this.database.transaction(transaction => this.scopes.readSettlementScopeInTransaction(transaction, reservationId));
    if (!scope) return Object.freeze({ kind: "unknown" as const, reservationId, reason: "no-sealed-attempt" as const });
    // The hold and the sealed stop must describe the same work, or one of them
    // is about a different run and neither may fund the other.
    if (scope.projectId !== hold.projectId || scope.runId !== hold.runId) throw new FactoryUsageSettlementError("factory_usage_settlement_conflict");
    const operations = await this.journal.operations(scope.authority);
    const pending = [...operations].filter(operation => operation.state === "uncertain" && typeof operation.providerReceiptDigest === "string" && operation.providerReceiptDigest.length > 0)
      .sort((left, right) => left.operationIndex - right.operationIndex);
    const candidate = pending[0];
    if (!candidate) return Object.freeze({ kind: "unknown" as const, reservationId, reason: "no-operation-receipt" as const });
    const usage = validateFactoryOperationUsage(candidate.usage);
    if (!usage.ok) throw new FactoryUsageSettlementError("factory_usage_settlement_corrupt");
    if ((candidate.usage as { kind?: string }).kind !== "measured") return Object.freeze({ kind: "unknown" as const, reservationId, reason: "usage-still-unknown" as const });
    // A digest the reconciler would refuse is refused here, where the caller can
    // still tell a tampered row from a settlement conflict.
    if (!RECEIPT_DIGEST_PATTERN.test(candidate.providerReceiptDigest!)) throw new FactoryUsageSettlementError("factory_usage_settlement_receipt_invalid");
    return Object.freeze({
      kind: "resolved" as const, reservationId, attemptId: scope.authority.attemptId,
      operationId: candidate.operationId, providerReceiptDigest: candidate.providerReceiptDigest!,
      usage: Object.freeze({ ...(candidate.usage as unknown as FactoryMeasuredUsage) }),
    });
  }

  async reconcile(
    value: { readonly reservationId: string; readonly attemptId: string; readonly operationId: string; readonly providerReceiptDigest: string; readonly usage: FactoryMeasuredUsage },
    signal?: AbortSignal,
  ): Promise<FactoryUsageSettlement> {
    const input = Object.freeze({ ...value, usage: Object.freeze({ ...value.usage }) });
    assertFactoryIdentity(input.reservationId, input.attemptId, input.operationId);
    if (!RECEIPT_DIGEST_PATTERN.test(input.providerReceiptDigest)) throw new FactoryUsageSettlementError("factory_usage_settlement_receipt_invalid");
    if (input.usage.kind !== "measured" || !isUnsignedDecimal(input.usage.costMicros) || !settlementCounter(input.usage.inputTokens, 0) || !settlementCounter(input.usage.outputTokens, 0) || !settlementCounter(input.usage.computeMs, 0)) throw new FactoryUsageSettlementError("factory_usage_settlement_invalid");
    signal?.throwIfAborted();
    const prior = await this.database.transaction(async transaction => {
      const scope = await this.scopes.readSettlementScopeInTransaction(transaction, input.reservationId);
      if (!scope) throw new FactoryUsageSettlementError("factory_usage_settlement_not_found");
      if (scope.authority.attemptId !== input.attemptId) throw new FactoryUsageSettlementError("factory_usage_settlement_conflict");
      return { scope, settled: await this.settlements.readByReceiptInTransaction(transaction, scope, input.providerReceiptDigest) };
    });
    const { scope } = prior;
    // One verified receipt yields one settlement. A repeat returns it without
    // touching the journal; a different amount under the same receipt is a
    // conflict, not a second reconciliation.
    if (prior.settled) {
      if (prior.settled.knownCostMicros !== input.usage.costMicros) throw new FactoryUsageSettlementError("factory_usage_settlement_conflict");
      return prior.settled;
    }
    // The provider proof lands in the journal before any money moves, and the
    // journal refuses an operation that was never dispatched for this attempt.
    await this.journal.reconcileLate(scope.authority, input.operationId, { providerReceiptDigest: input.providerReceiptDigest, usage: input.usage });
    return this.database.transaction(async transaction => {
      const settlement = await this.settlements.recordInTransaction(transaction, scope, { source: "reconciliation", knownCostMicros: input.usage.costMicros, providerReceiptDigest: input.providerReceiptDigest });
      if (settlement.providerReceiptDigest === input.providerReceiptDigest && settlement.source === "reconciliation") {
        await this.budgets.settleInTransaction(transaction, { projectId: scope.projectId, runId: scope.runId, reservationId: scope.reservationId }, { costMicros: input.usage.costMicros, tokens: input.usage.inputTokens + input.usage.outputTokens, computeMs: input.usage.computeMs }, input.providerReceiptDigest);
      }
      return settlement;
    });
  }
}
