import { createHash, verify, type KeyLike } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import { isUnsignedDecimal } from "@ezcorp/factory-sdk";
import type { FactoryMeasuredUsage, FactoryRunnerResult, FactoryUsage } from "@ezcorp/factory-sdk";
import type { FactoryAttemptAuthority, FactoryJournalOperationEvidence } from "./executions";
import type { FactoryPhysicalStopReason, FactoryPhysicalStopReceipt } from "./runner/attempt-runtime";
import type { FactoryNonSuccessfulRunnerResult, FactoryTaskOutcomeReceipt } from "./task-outcomes";

/** The three journal facts whose shape rules used to live inline in four modules. */
export type FactoryJournalFact = "outcome" | "stop" | "usage";

export interface FactoryJournalValidationIssue {
  readonly fact: FactoryJournalFact;
  readonly code: string;
  readonly path: readonly (string | number)[];
}

export type FactoryJournalValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly FactoryJournalValidationIssue[] };

/**
 * The sealed facts a signed physical-stop receipt must reproduce exactly.
 * `FactoryTaskStopRequest` extends this, so the stop service passes its whole
 * sealed request and this module keeps no dependency on the stop store.
 */
export interface FactoryPhysicalStopExpectation {
  readonly attemptId: string;
  readonly reservationId: string;
  readonly workerId: string;
  readonly holderGeneration: number;
  readonly allocationGeneration: number;
  readonly hostId: string;
  readonly reason: FactoryPhysicalStopReason;
}

/** One host certificate the product trusts for physical observations. */
export interface FactoryJournalHostKey {
  readonly hostId: string;
  readonly publicKey: KeyLike;
}

/** Bounds a stop clock so a host cannot seal a fact outside the sealed window. */
export interface FactoryStopClockBounds {
  readonly acceptedAtMs: number;
  readonly observedAtMs: number;
  readonly toleranceMs: number;
}

const RECEIPT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const USAGE_KINDS = new Set(["measured", "unknown"]);
const RECEIPT_FIELDS = Object.freeze([
  "schemaVersion", "attemptId", "reservationId", "workerId", "holderGeneration", "allocationGeneration",
  "processGroupAbsent", "stoppedAtMs", "reason", "hostId", "hostKeyId", "hostSignature", "receiptDigest",
] as const);

const OK: FactoryJournalValidationResult = Object.freeze({ ok: true as const });

class IssueList {
  private readonly issues: FactoryJournalValidationIssue[] = [];
  constructor(private readonly fact: FactoryJournalFact) {}

  /** Records one issue when `condition` holds. Returns the condition so callers can stop early. */
  when(condition: boolean, code: string, path: readonly (string | number)[] = []): boolean {
    if (condition) this.issues.push(Object.freeze({ fact: this.fact, code, path: Object.freeze([...path]) }));
    return condition;
  }

  verdict(): FactoryJournalValidationResult {
    return this.issues.length === 0 ? OK : Object.freeze({ ok: false as const, issues: Object.freeze([...this.issues]) });
  }
}

function isCounter(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** `unknown` from the journal boundary, narrowed to the SDK usage union. */
export function validateFactoryOperationUsage(usage: unknown, path: readonly (string | number)[] = ["usage"]): FactoryJournalValidationResult {
  const issues = new IssueList("usage");
  if (issues.when(!usage || typeof usage !== "object" || Array.isArray(usage), "factory_usage_not_an_object", path)) return issues.verdict();
  const value = usage as Record<string, unknown>;
  if (issues.when(typeof value.kind !== "string" || !USAGE_KINDS.has(value.kind), "factory_usage_kind_unsupported", [...path, "kind"])) return issues.verdict();
  if (value.kind === "measured") {
    issues.when(!isCounter(value.inputTokens), "factory_usage_input_tokens_invalid", [...path, "inputTokens"]);
    issues.when(!isCounter(value.outputTokens), "factory_usage_output_tokens_invalid", [...path, "outputTokens"]);
    issues.when(!isCounter(value.computeMs), "factory_usage_compute_ms_invalid", [...path, "computeMs"]);
    issues.when(typeof value.costMicros !== "string" || !isUnsignedDecimal(value.costMicros), "factory_usage_cost_micros_invalid", [...path, "costMicros"]);
  } else {
    issues.when(typeof value.reason !== "string" || value.reason.length === 0, "factory_usage_reason_missing", [...path, "reason"]);
    issues.when(typeof value.heldCostMicros !== "string" || !isUnsignedDecimal(value.heldCostMicros), "factory_usage_held_cost_micros_invalid", [...path, "heldCostMicros"]);
  }
  return issues.verdict();
}

/** Every settlement precondition C02.9 states for one journal operation. */
export function validateFactoryOperationSettlement(
  state: "completed" | "failed" | "uncertain",
  settlement: { readonly resultDigest?: string; readonly result?: unknown; readonly usage?: FactoryUsage; readonly workspaceCheckpoint?: unknown; readonly providerReceiptDigest?: string },
): FactoryJournalValidationResult {
  const issues = new IssueList("usage");
  if (state === "completed") {
    issues.when(!settlement.resultDigest, "factory_operation_result_digest_missing", ["resultDigest"]);
    issues.when(settlement.result === undefined, "factory_operation_result_missing", ["result"]);
    issues.when(settlement.usage === undefined, "factory_operation_usage_missing", ["usage"]);
    issues.when(settlement.workspaceCheckpoint === undefined, "factory_operation_workspace_checkpoint_missing", ["workspaceCheckpoint"]);
  }
  if (state === "failed") issues.when(!settlement.resultDigest, "factory_operation_result_digest_missing", ["resultDigest"]);
  if (state === "uncertain") issues.when(!settlement.providerReceiptDigest, "factory_operation_provider_receipt_missing", ["providerReceiptDigest"]);
  if (settlement.usage !== undefined) {
    const usage = validateFactoryOperationUsage(settlement.usage);
    if (!usage.ok) return usage;
  }
  return issues.verdict();
}

function summedMeasuredUsage(operations: readonly { readonly usage?: unknown }[]): FactoryMeasuredUsage | undefined {
  const measured: FactoryMeasuredUsage[] = [];
  for (const operation of operations) {
    if ((operation.usage as { kind?: string } | undefined)?.kind !== "measured") return undefined;
    measured.push(operation.usage as FactoryMeasuredUsage);
  }
  return {
    kind: "measured",
    inputTokens: measured.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: measured.reduce((sum, usage) => sum + usage.outputTokens, 0),
    computeMs: measured.reduce((sum, usage) => sum + usage.computeMs, 0),
    costMicros: measured.reduce((sum, usage) => sum + BigInt(usage.costMicros), 0n).toString(),
  };
}

/**
 * A measured terminal usage must equal the summed operation usage exactly,
 * with `costMicros` compared as a `BigInt` rather than as a number.
 */
export function validateFactoryTerminalUsage(result: FactoryRunnerResult, operations: readonly FactoryJournalOperationEvidence[]): FactoryJournalValidationResult {
  const issues = new IssueList("usage");
  for (const [index, operation] of operations.entries()) {
    if (operation.usage === undefined) continue;
    const usage = validateFactoryOperationUsage(operation.usage, ["operations", index, "usage"]);
    if (!usage.ok) return usage;
  }
  if (result.status === "completed") {
    issues.when(operations.some(operation => (operation.usage as { kind?: string } | undefined)?.kind !== "measured"), "factory_terminal_operation_usage_not_measured", ["operations"]);
  }
  if (result.usage?.kind !== "measured") return issues.verdict();
  const aggregate = summedMeasuredUsage(result.operations);
  if (issues.when(aggregate === undefined, "factory_terminal_operation_usage_not_measured", ["operations"])) return issues.verdict();
  issues.when(canonicalJson(aggregate) !== canonicalJson(result.usage), "factory_terminal_usage_mismatch", ["usage"]);
  return issues.verdict();
}

/** The sealed non-success outcome receipt must bind its result and its attempt authority. */
export function validateFactoryTaskOutcome(
  receipt: FactoryTaskOutcomeReceipt,
  result: FactoryNonSuccessfulRunnerResult,
  authority: FactoryAttemptAuthority,
): FactoryJournalValidationResult {
  const issues = new IssueList("outcome");
  issues.when(receipt.resultStatus !== result.status, "factory_outcome_result_status_mismatch", ["resultStatus"]);
  issues.when(!RECEIPT_DIGEST_PATTERN.test(receipt.terminalResultDigest), "factory_outcome_terminal_digest_invalid", ["terminalResultDigest"]);
  issues.when(!RECEIPT_DIGEST_PATTERN.test(receipt.evidenceDigest), "factory_outcome_evidence_digest_invalid", ["evidenceDigest"]);
  const measured = result.usage?.kind === "measured";
  issues.when(receipt.usageDisposition !== (measured ? "measured_pending_stop" : "unknown_held"), "factory_outcome_usage_disposition_mismatch", ["usageDisposition"]);
  if (result.usage !== undefined) {
    const usage = validateFactoryOperationUsage(result.usage, ["result", "usage"]);
    if (!usage.ok) return usage;
  }
  issues.when(receipt.event.nodeId !== authority.nodeInstanceId, "factory_outcome_event_node_mismatch", ["event", "nodeId"]);
  issues.when(receipt.event.commandId !== authority.attemptId, "factory_outcome_event_command_mismatch", ["event", "commandId"]);
  issues.when(receipt.event.candidateGeneration !== authority.candidateGeneration, "factory_outcome_event_generation_mismatch", ["event", "candidateGeneration"]);
  issues.when(receipt.event.attempt !== authority.attemptNumber, "factory_outcome_event_attempt_mismatch", ["event", "attempt"]);
  return issues.verdict();
}

/** The exact unsigned body a host signs. Its digest identifies these bytes only. */
export function factoryUnsignedStopReceipt(receipt: FactoryPhysicalStopReceipt) {
  return Object.freeze({
    schemaVersion: receipt.schemaVersion,
    attemptId: receipt.attemptId,
    reservationId: receipt.reservationId,
    workerId: receipt.workerId,
    holderGeneration: receipt.holderGeneration,
    allocationGeneration: receipt.allocationGeneration,
    processGroupAbsent: receipt.processGroupAbsent,
    stoppedAtMs: receipt.stoppedAtMs,
    reason: receipt.reason,
    hostId: receipt.hostId,
  });
}

/**
 * A physical observation is admissible only when a configured host key signs the
 * exact sealed facts. A gateway callback can ask for a stop; it can never assert one.
 */
export function validateFactoryStopReceipt(
  request: FactoryPhysicalStopExpectation,
  receipt: FactoryPhysicalStopReceipt,
  keys: ReadonlyMap<string, FactoryJournalHostKey>,
  clock?: FactoryStopClockBounds,
): FactoryJournalValidationResult {
  const issues = new IssueList("stop");
  const present = new Set(Object.keys(receipt));
  if (issues.when(present.size !== RECEIPT_FIELDS.length || RECEIPT_FIELDS.some(field => !present.has(field)), "factory_stop_receipt_fields_unsupported")) return issues.verdict();
  const key = keys.get(receipt.hostKeyId);
  if (issues.when(key === undefined, "factory_stop_receipt_key_unknown", ["hostKeyId"])) return issues.verdict();
  issues.when(key!.hostId !== request.hostId || receipt.hostId !== request.hostId, "factory_stop_receipt_host_mismatch", ["hostId"]);
  issues.when(receipt.schemaVersion !== "factory.physical-stop.v1", "factory_stop_receipt_schema_unsupported", ["schemaVersion"]);
  issues.when(receipt.attemptId !== request.attemptId, "factory_stop_receipt_attempt_mismatch", ["attemptId"]);
  issues.when(receipt.reservationId !== request.reservationId, "factory_stop_receipt_reservation_mismatch", ["reservationId"]);
  issues.when(receipt.workerId !== request.workerId, "factory_stop_receipt_worker_mismatch", ["workerId"]);
  issues.when(receipt.holderGeneration !== request.holderGeneration, "factory_stop_receipt_holder_generation_mismatch", ["holderGeneration"]);
  issues.when(receipt.allocationGeneration !== request.allocationGeneration, "factory_stop_receipt_allocation_generation_mismatch", ["allocationGeneration"]);
  issues.when(receipt.reason !== request.reason, "factory_stop_receipt_reason_mismatch", ["reason"]);
  issues.when(receipt.processGroupAbsent !== true, "factory_stop_receipt_process_group_present", ["processGroupAbsent"]);
  issues.when(!isCounter(receipt.stoppedAtMs), "factory_stop_receipt_clock_invalid", ["stoppedAtMs"]);
  const unsigned = factoryUnsignedStopReceipt(receipt);
  issues.when(!RECEIPT_DIGEST_PATTERN.test(receipt.receiptDigest) || receipt.receiptDigest !== `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}`, "factory_stop_receipt_digest_mismatch", ["receiptDigest"]);
  if (clock && isCounter(receipt.stoppedAtMs)) {
    issues.when(receipt.stoppedAtMs < clock.acceptedAtMs || receipt.stoppedAtMs > clock.observedAtMs + clock.toleranceMs, "factory_stop_receipt_clock_out_of_bounds", ["stoppedAtMs"]);
  }
  if (issues.when(typeof receipt.hostSignature !== "string" || !BASE64URL_PATTERN.test(receipt.hostSignature), "factory_stop_receipt_signature_encoding", ["hostSignature"])) return issues.verdict();
  const signature = Buffer.from(receipt.hostSignature, "base64url");
  if (issues.when(signature.toString("base64url") !== receipt.hostSignature, "factory_stop_receipt_signature_encoding", ["hostSignature"])) return issues.verdict();
  issues.when(!verify("RSA-SHA256", Buffer.from(canonicalJson(unsigned)), key!.publicKey, signature), "factory_stop_receipt_signature_invalid", ["hostSignature"]);
  return issues.verdict();
}

/** The first issue code, for error classes that carry one code rather than a list. */
export function firstFactoryJournalIssue(result: FactoryJournalValidationResult): string | undefined {
  return result.ok ? undefined : result.issues[0]?.code;
}
