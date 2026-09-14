import { createHash } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import { isUnsignedDecimal } from "@ezcorp/factory-sdk";
import type { FactoryMeasuredUsage } from "@ezcorp/factory-sdk";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import type { FactoryAttemptAuthority } from "./executions";

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
