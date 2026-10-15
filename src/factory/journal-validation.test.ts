import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, type KeyLike } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { FactoryRunnerResult } from "@ezcorp/factory-sdk";
import type { FactoryAttemptAuthority, FactoryJournalOperationEvidence } from "./executions";
import {
  factoryUnsignedStopReceipt,
  firstFactoryJournalIssue,
  isFactoryProviderReceiptDigest,
  validateFactoryOperationSettlement,
  validateFactoryOperationUsage,
  validateFactoryStopReceipt,
  validateFactoryTaskOutcome,
  validateFactoryTerminalUsage,
  type FactoryJournalHostKey,
  type FactoryPhysicalStopExpectation,
} from "./journal-validation";
import { signFactoryPhysicalStopReceipt, type FactoryPhysicalStopReceipt } from "./runner/attempt-runtime";
import type { FactoryNonSuccessfulRunnerResult, FactoryTaskOutcomeReceipt } from "./task-outcomes";

const host = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherHost = generateKeyPairSync("rsa", { modulusLength: 2048 });

function codes(result: ReturnType<typeof validateFactoryOperationUsage>): readonly string[] {
  return result.ok ? [] : result.issues.map(issue => issue.code);
}

function measured(overrides: Record<string, unknown> = {}) {
  return { kind: "measured", inputTokens: 2, outputTokens: 3, computeMs: 5, costMicros: "7", ...overrides };
}

function unknownUsage(overrides: Record<string, unknown> = {}) {
  return { kind: "unknown", reason: "provider-cap-absent", heldCostMicros: "900", ...overrides };
}

function checkpoint(journalCursor: number) {
  return { artifactId: `checkpoint-${journalCursor}`, digest: `sha256:${"b".repeat(64)}`, encodedBytes: 4, journalCursor };
}

function operationEvidence(index: number, usage: unknown): FactoryJournalOperationEvidence {
  return { operationId: `run:node:0:${index}`, operationIndex: index, kind: "model", requestDigest: "a".repeat(64), state: "completed", resultDigest: `${index}`.repeat(4), usage: usage as never, workspaceCheckpoint: checkpoint(index) as never };
}

function completedResult(operations: readonly unknown[], usage: unknown): FactoryRunnerResult {
  return {
    schemaVersion: "factory.runner.result.v1",
    status: "completed",
    journalCursor: operations.length - 1,
    operations: operations as never,
    resultDigest: "c".repeat(64),
    output: { artifactId: "output", digest: `sha256:${"c".repeat(64)}`, encodedBytes: 9 },
    usage: usage as never,
    workspaceCheckpoint: checkpoint(operations.length - 1),
  } as FactoryRunnerResult;
}

function resultOperation(index: number, usage: unknown) {
  return { operationId: `run:node:0:${index}`, operationIndex: index, kind: "model" as const, requestDigest: "a".repeat(64), state: "completed" as const, resultDigest: `${index}`.repeat(4), usage, workspaceCheckpoint: checkpoint(index) };
}

const authority: FactoryAttemptAuthority = {
  attemptId: "attempt-1", tenantId: "tenant", projectId: "project", runId: "run", nodeInstanceId: "node",
  candidateGeneration: 2, attemptNumber: 3, grantRevision: 4, reservationGeneration: 5, executionEpoch: 6,
  cancellationEpoch: 0, requestDigest: "d".repeat(64), deadlineAt: new Date(1_000_000),
};

function outcomeReceipt(overrides: Partial<FactoryTaskOutcomeReceipt> = {}): FactoryTaskOutcomeReceipt {
  return {
    reservationId: "reservation",
    resultStatus: "failed",
    terminalResultDigest: `sha256:${"e".repeat(64)}`,
    evidenceDigest: `sha256:${"f".repeat(64)}`,
    usageDisposition: "measured_pending_stop",
    event: { kind: "node-failed", id: "attempt-1:failed", atMs: 5, nodeId: "node", commandId: "attempt-1", candidateGeneration: 2, attempt: 3, error: "BOOM", failureKind: "execution" },
    ...overrides,
  } as FactoryTaskOutcomeReceipt;
}

const failedResult = { schemaVersion: "factory.runner.result.v1", status: "failed", journalCursor: -1, operations: [], resultDigest: "a".repeat(64), error: { code: "BOOM", message: "boom", retryable: false }, usage: measured() } as unknown as FactoryNonSuccessfulRunnerResult;

const expectation: FactoryPhysicalStopExpectation = {
  attemptId: "attempt-1", reservationId: "reservation", workerId: "factory_worker", holderGeneration: 4, allocationGeneration: 9, hostId: "host-a", reason: "cancelled",
};

function signed(overrides: Partial<FactoryPhysicalStopReceipt> = {}, key: KeyLike = host.privateKey, keyId = "host-a-key-1"): FactoryPhysicalStopReceipt {
  const unsigned = {
    schemaVersion: "factory.physical-stop.v1" as const,
    attemptId: expectation.attemptId,
    reservationId: expectation.reservationId,
    workerId: expectation.workerId,
    holderGeneration: expectation.holderGeneration,
    allocationGeneration: expectation.allocationGeneration,
    processGroupAbsent: true as const,
    stoppedAtMs: 1_700_000_000_000,
    reason: expectation.reason,
    hostId: expectation.hostId,
    ...overrides,
  };
  const signature = signFactoryPhysicalStopReceipt(unsigned, keyId, key);
  return Object.freeze({ ...unsigned, ...signature, receiptDigest: `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}`, ...("receiptDigest" in overrides ? { receiptDigest: overrides.receiptDigest! } : {}) }) as FactoryPhysicalStopReceipt;
}

const keys: ReadonlyMap<string, FactoryJournalHostKey> = new Map([["host-a-key-1", { hostId: "host-a", publicKey: host.publicKey }]]);

test("accepts both usage kinds and rejects every malformed field", () => {
  expect(validateFactoryOperationUsage(measured())).toEqual({ ok: true });
  expect(validateFactoryOperationUsage(unknownUsage())).toEqual({ ok: true });
  expect(codes(validateFactoryOperationUsage(null))).toEqual(["factory_usage_not_an_object"]);
  expect(codes(validateFactoryOperationUsage([measured()]))).toEqual(["factory_usage_not_an_object"]);
  expect(codes(validateFactoryOperationUsage({ kind: "estimated" }))).toEqual(["factory_usage_kind_unsupported"]);
  expect(codes(validateFactoryOperationUsage(measured({ inputTokens: -1 })))).toEqual(["factory_usage_input_tokens_invalid"]);
  expect(codes(validateFactoryOperationUsage(measured({ outputTokens: 1.5 })))).toEqual(["factory_usage_output_tokens_invalid"]);
  expect(codes(validateFactoryOperationUsage(measured({ computeMs: "3" })))).toEqual(["factory_usage_compute_ms_invalid"]);
  expect(codes(validateFactoryOperationUsage(measured({ costMicros: 7 })))).toEqual(["factory_usage_cost_micros_invalid"]);
  expect(codes(validateFactoryOperationUsage(measured({ costMicros: "-7" })))).toEqual(["factory_usage_cost_micros_invalid"]);
  expect(codes(validateFactoryOperationUsage(unknownUsage({ reason: "" })))).toEqual(["factory_usage_reason_missing"]);
  expect(codes(validateFactoryOperationUsage(unknownUsage({ heldCostMicros: "1.5" })))).toEqual(["factory_usage_held_cost_micros_invalid"]);
  const located = validateFactoryOperationUsage(measured({ costMicros: "x" }), ["operations", 2, "usage"]);
  expect(located.ok ? [] : located.issues[0]!.path).toEqual(["operations", 2, "usage", "costMicros"]);
  expect(firstFactoryJournalIssue({ ok: true })).toBeUndefined();
  expect(firstFactoryJournalIssue(located)).toBe("factory_usage_cost_micros_invalid");
});

test("holds each settlement state to the evidence C02 requires", () => {
  const complete = { resultDigest: "a".repeat(64), result: { ok: true }, usage: measured() as never, workspaceCheckpoint: checkpoint(0) as never };
  expect(validateFactoryOperationSettlement("completed", complete)).toEqual({ ok: true });
  expect(codes(validateFactoryOperationSettlement("completed", { resultDigest: "a".repeat(64) }))).toEqual([
    "factory_operation_result_missing", "factory_operation_usage_missing", "factory_operation_workspace_checkpoint_missing",
  ]);
  expect(codes(validateFactoryOperationSettlement("completed", { ...complete, resultDigest: undefined }))).toEqual(["factory_operation_result_digest_missing"]);
  expect(validateFactoryOperationSettlement("failed", { resultDigest: "a".repeat(64) })).toEqual({ ok: true });
  expect(codes(validateFactoryOperationSettlement("failed", {}))).toEqual(["factory_operation_result_digest_missing"]);
  expect(validateFactoryOperationSettlement("uncertain", { providerReceiptDigest: "a".repeat(64), usage: unknownUsage() as never })).toEqual({ ok: true });
  expect(codes(validateFactoryOperationSettlement("uncertain", {}))).toEqual(["factory_operation_provider_receipt_missing"]);
  expect(codes(validateFactoryOperationSettlement("failed", { resultDigest: "a".repeat(64), usage: { kind: "guessed" } as never }))).toEqual(["factory_usage_kind_unsupported"]);
});

// The prefixed form was the collision: the journal took it, the SDK result
// validator and the generated schema never could, so the row was unsettleable
// and the attempt uncompletable. Refusing it here keeps the surfaces together.
test("takes an operation receipt only in the C02 bare form", () => {
  const bare = "a".repeat(64);
  expect(isFactoryProviderReceiptDigest(bare)).toBe(true);
  for (const wrong of [`sha256:${bare}`, bare.toUpperCase(), "a".repeat(63), "a".repeat(65), "g".repeat(64), ` ${bare}`, "", 64, undefined, null]) {
    expect(isFactoryProviderReceiptDigest(wrong)).toBe(false);
  }
  for (const state of ["completed", "failed", "uncertain"] as const) {
    const settlement = { resultDigest: bare, result: { ok: true }, usage: measured() as never, workspaceCheckpoint: checkpoint(0) as never, providerReceiptDigest: `sha256:${bare}` };
    expect(codes(validateFactoryOperationSettlement(state, settlement))).toEqual(["factory_operation_provider_receipt_invalid"]);
    expect(validateFactoryOperationSettlement(state, { ...settlement, providerReceiptDigest: bare })).toEqual({ ok: true });
  }
});

test("compares terminal usage with its operations as BigInt cost, not as a number", () => {
  const operations = [resultOperation(0, measured({ costMicros: "9007199254740993" })), resultOperation(1, measured({ costMicros: "1" }))];
  const evidence = [operationEvidence(0, operations[0]!.usage), operationEvidence(1, operations[1]!.usage)];
  const aggregate = measured({ inputTokens: 4, outputTokens: 6, computeMs: 10, costMicros: "9007199254740994" });
  expect(validateFactoryTerminalUsage(completedResult(operations, aggregate), evidence)).toEqual({ ok: true });
  const drifted = measured({ inputTokens: 4, outputTokens: 6, computeMs: 10, costMicros: "9007199254740995" });
  expect(codes(validateFactoryTerminalUsage(completedResult(operations, drifted), evidence))).toEqual(["factory_terminal_usage_mismatch"]);
});

test("rejects a completed terminal whose operation usage is unknown or malformed", () => {
  const unknownOperations = [resultOperation(0, unknownUsage())];
  const evidence = [operationEvidence(0, unknownUsage())];
  expect(codes(validateFactoryTerminalUsage(completedResult(unknownOperations, measured()), evidence))).toEqual([
    "factory_terminal_operation_usage_not_measured", "factory_terminal_operation_usage_not_measured",
  ]);
  expect(codes(validateFactoryTerminalUsage(completedResult(unknownOperations, measured()), [operationEvidence(0, { kind: "guessed" })]))).toEqual(["factory_usage_kind_unsupported"]);
  const cancelled = { schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: -1, operations: [] } as unknown as FactoryRunnerResult;
  expect(validateFactoryTerminalUsage(cancelled, [])).toEqual({ ok: true });
  const heldTerminal = { ...cancelled, usage: unknownUsage() } as unknown as FactoryRunnerResult;
  expect(validateFactoryTerminalUsage(heldTerminal, [])).toEqual({ ok: true });
  const evidenceWithoutUsage: FactoryJournalOperationEvidence = { operationId: "run:node:0:0", operationIndex: 0, kind: "tool", requestDigest: "a".repeat(64), state: "failed" };
  expect(validateFactoryTerminalUsage(heldTerminal, [evidenceWithoutUsage])).toEqual({ ok: true });
});

test("binds a non-success outcome receipt to its result and its attempt authority", () => {
  expect(validateFactoryTaskOutcome(outcomeReceipt(), failedResult, authority)).toEqual({ ok: true });
  const held = { ...failedResult, usage: unknownUsage() } as FactoryNonSuccessfulRunnerResult;
  expect(validateFactoryTaskOutcome(outcomeReceipt({ usageDisposition: "unknown_held" }), held, authority)).toEqual({ ok: true });
  const absent = { ...failedResult, usage: undefined } as FactoryNonSuccessfulRunnerResult;
  expect(validateFactoryTaskOutcome(outcomeReceipt({ usageDisposition: "unknown_held" }), absent, authority)).toEqual({ ok: true });
  expect(codes(validateFactoryTaskOutcome(outcomeReceipt({ resultStatus: "cancelled" }), failedResult, authority))).toEqual(["factory_outcome_result_status_mismatch"]);
  expect(codes(validateFactoryTaskOutcome(outcomeReceipt({ terminalResultDigest: "sha256:short" }), failedResult, authority))).toEqual(["factory_outcome_terminal_digest_invalid"]);
  expect(codes(validateFactoryTaskOutcome(outcomeReceipt({ evidenceDigest: "e".repeat(64) }), failedResult, authority))).toEqual(["factory_outcome_evidence_digest_invalid"]);
  expect(codes(validateFactoryTaskOutcome(outcomeReceipt({ usageDisposition: "unknown_held" }), failedResult, authority))).toEqual(["factory_outcome_usage_disposition_mismatch"]);
  expect(codes(validateFactoryTaskOutcome(outcomeReceipt(), { ...failedResult, usage: measured({ costMicros: "-1" }) } as FactoryNonSuccessfulRunnerResult, authority))).toEqual(["factory_usage_cost_micros_invalid"]);
  expect(codes(validateFactoryTaskOutcome(outcomeReceipt(), failedResult, { ...authority, nodeInstanceId: "other" }))).toEqual(["factory_outcome_event_node_mismatch"]);
  expect(codes(validateFactoryTaskOutcome(outcomeReceipt(), failedResult, { ...authority, attemptId: "other" }))).toEqual(["factory_outcome_event_command_mismatch"]);
  expect(codes(validateFactoryTaskOutcome(outcomeReceipt(), failedResult, { ...authority, candidateGeneration: 8 }))).toEqual(["factory_outcome_event_generation_mismatch"]);
  expect(codes(validateFactoryTaskOutcome(outcomeReceipt(), failedResult, { ...authority, attemptNumber: 8 }))).toEqual(["factory_outcome_event_attempt_mismatch"]);
});

test("accepts only a configured host key signing the exact sealed stop facts", () => {
  expect(validateFactoryStopReceipt(expectation, signed(), keys)).toEqual({ ok: true });
  expect(codes(validateFactoryStopReceipt(expectation, signed({}, host.privateKey, "unknown-key"), keys))).toEqual(["factory_stop_receipt_key_unknown"]);
  expect(codes(validateFactoryStopReceipt(expectation, signed({}, otherHost.privateKey), keys))).toEqual(["factory_stop_receipt_signature_invalid"]);
  expect(codes(validateFactoryStopReceipt({ ...expectation, hostId: "host-b" }, signed({ hostId: "host-b" }), keys))).toEqual(["factory_stop_receipt_host_mismatch"]);
  expect(codes(validateFactoryStopReceipt(expectation, { ...signed(), extra: 1 } as unknown as FactoryPhysicalStopReceipt, keys))).toEqual(["factory_stop_receipt_fields_unsupported"]);
  const { hostSignature: _omitted, ...withoutSignature } = signed();
  expect(codes(validateFactoryStopReceipt(expectation, withoutSignature as FactoryPhysicalStopReceipt, keys))).toEqual(["factory_stop_receipt_fields_unsupported"]);
});

test("rejects every stop fact that differs from the sealed request", () => {
  const cases: readonly (readonly [Partial<FactoryPhysicalStopReceipt>, string])[] = [
    [{ schemaVersion: "factory.physical-stop.v2" as never }, "factory_stop_receipt_schema_unsupported"],
    [{ attemptId: "other" }, "factory_stop_receipt_attempt_mismatch"],
    [{ reservationId: "other" }, "factory_stop_receipt_reservation_mismatch"],
    [{ workerId: "other" }, "factory_stop_receipt_worker_mismatch"],
    [{ holderGeneration: 5 }, "factory_stop_receipt_holder_generation_mismatch"],
    [{ allocationGeneration: 10 }, "factory_stop_receipt_allocation_generation_mismatch"],
    [{ reason: "failed" }, "factory_stop_receipt_reason_mismatch"],
    [{ processGroupAbsent: false as never }, "factory_stop_receipt_process_group_present"],
    [{ stoppedAtMs: -1 }, "factory_stop_receipt_clock_invalid"],
  ];
  for (const [overrides, code] of cases) expect(codes(validateFactoryStopReceipt(expectation, signed(overrides), keys))).toContain(code);
});

test("rejects a receipt whose digest or signature encoding was rewritten", () => {
  const rewritten = { ...signed(), receiptDigest: `sha256:${"0".repeat(64)}` } as FactoryPhysicalStopReceipt;
  expect(codes(validateFactoryStopReceipt(expectation, rewritten, keys))).toEqual(["factory_stop_receipt_digest_mismatch"]);
  const shortDigest = { ...signed(), receiptDigest: "sha256:beef" } as FactoryPhysicalStopReceipt;
  expect(codes(validateFactoryStopReceipt(expectation, shortDigest, keys))).toEqual(["factory_stop_receipt_digest_mismatch"]);
  const base = signed();
  expect(codes(validateFactoryStopReceipt(expectation, { ...base, hostSignature: "not base64url!" } as FactoryPhysicalStopReceipt, keys))).toEqual(["factory_stop_receipt_signature_encoding"]);
  expect(codes(validateFactoryStopReceipt(expectation, { ...base, hostSignature: `${base.hostSignature}=` } as FactoryPhysicalStopReceipt, keys))).toEqual(["factory_stop_receipt_signature_encoding"]);
  expect(codes(validateFactoryStopReceipt(expectation, { ...base, hostSignature: 4 as never } as FactoryPhysicalStopReceipt, keys))).toEqual(["factory_stop_receipt_signature_encoding"]);
  expect(factoryUnsignedStopReceipt(base)).toEqual({
    schemaVersion: "factory.physical-stop.v1", attemptId: "attempt-1", reservationId: "reservation", workerId: "factory_worker",
    holderGeneration: 4, allocationGeneration: 9, processGroupAbsent: true, stoppedAtMs: 1_700_000_000_000, reason: "cancelled", hostId: "host-a",
  });
});

test("bounds a stop clock between acceptance and the observed instant", () => {
  const bounds = { acceptedAtMs: 1_699_999_000_000, observedAtMs: 1_700_000_000_000, toleranceMs: 5_000 };
  expect(validateFactoryStopReceipt(expectation, signed(), keys, bounds)).toEqual({ ok: true });
  expect(codes(validateFactoryStopReceipt(expectation, signed({ stoppedAtMs: bounds.acceptedAtMs - 1 }), keys, bounds))).toEqual(["factory_stop_receipt_clock_out_of_bounds"]);
  expect(codes(validateFactoryStopReceipt(expectation, signed({ stoppedAtMs: bounds.observedAtMs + bounds.toleranceMs + 1 }), keys, bounds))).toEqual(["factory_stop_receipt_clock_out_of_bounds"]);
  expect(codes(validateFactoryStopReceipt(expectation, signed({ stoppedAtMs: -5 }), keys, bounds))).toEqual(["factory_stop_receipt_clock_invalid"]);
});
