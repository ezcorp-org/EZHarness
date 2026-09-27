import { expect, test } from "bun:test";
import type { FactoryAttemptAuthority } from "./executions";
import type { FactoryInbox } from "./inbox";
import {
  FactoryUsageReconciliation,
  FactoryUsageSettlements,
  buildFactoryUsageSettlement,
  factoryUsageSettlementAdvance,
  factoryUsageSettlementDigest,
  factoryUsageSettlementEventId,
  factoryUsageSettlementIsIntact,
  FACTORY_USAGE_NO_OPERATIONS_BASIS,
  FACTORY_USAGE_OPERATIONS_BASIS,
  FACTORY_USAGE_PROVIDER_ERROR_BASIS,
  factoryJournalStopSettlement,
  FACTORY_USAGE_SETTLEMENT_CODES,
  FACTORY_USAGE_SETTLEMENT_SCHEMA_VERSION,
  FactoryUsageSettlementError,
  type FactoryUsageSettlementInput,
} from "./usage-settlement";

const authority: FactoryAttemptAuthority = {
  attemptId: "attempt-1", tenantId: "tenant", projectId: "project", runId: "run", nodeInstanceId: "node",
  candidateGeneration: 2, attemptNumber: 3, grantRevision: 4, reservationGeneration: 5, executionEpoch: 6,
  cancellationEpoch: 0, requestDigest: "a".repeat(64), deadlineAt: new Date(1_000),
};

const receipt = "b".repeat(64);

function input(overrides: Partial<FactoryUsageSettlementInput> = {}): FactoryUsageSettlementInput {
  return { reservationId: "reservation-1", attemptId: "attempt-1", authority, revision: 1, source: "stop", knownCostMicros: "1200", settledAtMs: 1_700_000_000_000, ...overrides };
}

function rejection(overrides: Partial<FactoryUsageSettlementInput>): string {
  try { buildFactoryUsageSettlement(input(overrides)); }
  catch (error) { return (error as FactoryUsageSettlementError).code; }
  throw new Error("Expected the settlement builder to reject this input.");
}

test("seals one settlement whose event carries the same amounts and id", () => {
  const settlement = buildFactoryUsageSettlement(input({ unknownCostMicros: "300" }));
  expect(settlement.schemaVersion).toBe(FACTORY_USAGE_SETTLEMENT_SCHEMA_VERSION);
  expect(settlement.event).toEqual({
    kind: "usage-settled", id: "reservation-1:usage:1", atMs: 1_700_000_000_000, nodeId: "node", commandId: "attempt-1",
    candidateGeneration: 2, attempt: 3, revision: 1, knownCostMicros: "1200", unknownCostMicros: "300",
  });
  expect(settlement.settlementDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(factoryUsageSettlementIsIntact(settlement)).toBe(true);
  const { settlementDigest, ...body } = settlement;
  expect(settlementDigest).toBe(factoryUsageSettlementDigest(body));
  expect(buildFactoryUsageSettlement(input({ unknownCostMicros: "300" }))).toEqual(settlement);
});

test("omits a held cost only when nothing is held and keeps a reconciliation receipt", () => {
  const settled = buildFactoryUsageSettlement(input());
  expect("unknownCostMicros" in settled).toBe(false);
  expect(settled.event.unknownCostMicros).toBeUndefined();
  const reconciled = buildFactoryUsageSettlement(input({ source: "reconciliation", revision: 2, providerReceiptDigest: receipt, knownCostMicros: "0" }));
  expect(reconciled.providerReceiptDigest).toBe(receipt);
  expect(reconciled.knownCostMicros).toBe("0");
  expect(reconciled.event.id).toBe("reservation-1:usage:2");
  expect(factoryUsageSettlementIsIntact(reconciled)).toBe(true);
});

test("rejects every malformed amount, identity, clock, and receipt", () => {
  expect(rejection({ reservationId: "" })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ reservationId: "badid" })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ attemptId: "" })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ attemptId: "other-attempt" })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ revision: 0 })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ revision: 1.5 })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ settledAtMs: -1 })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ source: "guessed" as never })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ knownCostMicros: 1200 as never })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ knownCostMicros: "-1" })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ knownCostMicros: "1.2" })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ unknownCostMicros: "-1" })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ unknownCostMicros: 5 as never })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ providerReceiptDigest: "short" })).toBe("factory_usage_settlement_receipt_invalid");
  // The prefixed form is the one the C02 surfaces cannot read. It is refused
  // outright rather than stripped, so neither side can drift back to it.
  expect(rejection({ providerReceiptDigest: `sha256:${receipt}` })).toBe("factory_usage_settlement_receipt_invalid");
  expect(rejection({ providerReceiptDigest: receipt.toUpperCase() })).toBe("factory_usage_settlement_receipt_invalid");
  expect(rejection({ providerReceiptDigest: `${receipt}0` })).toBe("factory_usage_settlement_receipt_invalid");
  expect(rejection({ source: "reconciliation" })).toBe("factory_usage_settlement_receipt_invalid");
  expect(() => factoryUsageSettlementEventId("", 1)).toThrow("factory_usage_settlement_invalid");
  expect(() => factoryUsageSettlementEventId("reservation-1", 0)).toThrow("factory_usage_settlement_invalid");
});

test("detects a settlement whose stored bytes no longer match its own digest", () => {
  const settlement = buildFactoryUsageSettlement(input({ unknownCostMicros: "300" }));
  expect(factoryUsageSettlementIsIntact({ ...settlement, knownCostMicros: "1201" })).toBe(false);
  expect(factoryUsageSettlementIsIntact({ ...settlement, settlementDigest: `sha256:${"0".repeat(64)}` })).toBe(false);
  expect(factoryUsageSettlementIsIntact({ ...settlement, schemaVersion: "factory.usage-settlement.v2" as never })).toBe(false);
  expect(factoryUsageSettlementIsIntact({ ...settlement, event: { ...settlement.event, id: "reservation-1:usage:9" } })).toBe(false);
  expect(factoryUsageSettlementIsIntact({ ...settlement, event: { ...settlement.event, revision: 9 } })).toBe(false);
  expect(factoryUsageSettlementIsIntact({ ...settlement, event: { ...settlement.event, knownCostMicros: "9" } })).toBe(false);
  expect(factoryUsageSettlementIsIntact({ ...settlement, event: { ...settlement.event, unknownCostMicros: "9" } })).toBe(false);
  expect(factoryUsageSettlementIsIntact({ ...settlement, event: { ...settlement.event, atMs: 1 } })).toBe(false);
});

test("advances a revision only on a real change and never on a regression", () => {
  expect(factoryUsageSettlementAdvance(undefined, { knownCostMicros: "0" })).toBe("first");
  expect(factoryUsageSettlementAdvance({ knownCostMicros: "5", unknownCostMicros: "2" }, { knownCostMicros: "5", unknownCostMicros: "2" })).toBe("unchanged");
  expect(factoryUsageSettlementAdvance({ knownCostMicros: "5", unknownCostMicros: "2" }, { knownCostMicros: "5" })).toBe("advanced");
  expect(factoryUsageSettlementAdvance({ knownCostMicros: "5" }, { knownCostMicros: "9007199254740993" })).toBe("advanced");
  expect(() => factoryUsageSettlementAdvance({ knownCostMicros: "9007199254740993" }, { knownCostMicros: "9007199254740992" })).toThrow("factory_usage_settlement_regressed");
});

test("names every settlement error code once for the W14 status mapping", () => {
  expect(new Set(FACTORY_USAGE_SETTLEMENT_CODES).size).toBe(FACTORY_USAGE_SETTLEMENT_CODES.length);
  for (const code of FACTORY_USAGE_SETTLEMENT_CODES) {
    const error = new FactoryUsageSettlementError(code);
    expect({ name: error.name, code: error.code, message: error.message }).toEqual({ name: "FactoryUsageSettlementError", code, message: code });
  }
});

test("binds the settlement store and its reconciler to one tenant", () => {
  const database = { async transaction() { throw new Error("unused"); } } as never;
  const inbox = { tenantId: "tenant" } as unknown as FactoryInbox;
  expect(() => new FactoryUsageSettlements(database, "tenant", { tenantId: "other" } as unknown as FactoryInbox)).toThrow("factory_usage_settlement_scope");
  expect(() => new FactoryUsageSettlements(database, "", inbox)).toThrow();
  const settlements = new FactoryUsageSettlements(database, "tenant", inbox);
  expect(settlements.tenantId).toBe("tenant");
  expect(settlements.transactionalDatabase).toBe(database);
  const scopes = { async readSettlementScopeInTransaction() { return undefined; }, async clearResolvedStopInTransaction() { return undefined; } };
  const journal = { async reconcileLate(): Promise<never> { throw new Error("unused"); }, async operations(): Promise<never> { throw new Error("unused"); } };
  const budgets = { async settleInTransaction() { throw new Error("unused"); } };
  expect(() => new FactoryUsageReconciliation(database, "other-tenant", scopes, journal, budgets, settlements)).toThrow("factory_usage_settlement_scope");
  expect(new FactoryUsageReconciliation(database, "tenant", scopes, journal, budgets, settlements).tenantId).toBe("tenant");
});

test("seals a no-operations zero bound to its signed stop, and nothing else under that source", () => {
  const stopReceiptDigest = `sha256:${"c".repeat(64)}`;
  const settlement = buildFactoryUsageSettlement(input({ source: "no-operations", knownCostMicros: "0", stopReceiptDigest }));
  expect(settlement).toMatchObject({ source: "no-operations", knownCostMicros: "0", stopReceiptDigest, revision: 1, basis: FACTORY_USAGE_NO_OPERATIONS_BASIS });
  expect(FACTORY_USAGE_NO_OPERATIONS_BASIS).toBe("no-operations: compute at reserved bound");
  // The basis is derived from the source: no other settlement carries one.
  expect(buildFactoryUsageSettlement(input()).basis).toBeUndefined();
  expect(settlement.unknownCostMicros).toBeUndefined();
  expect(settlement.providerReceiptDigest).toBeUndefined();
  expect(settlement.event).toMatchObject({ kind: "usage-settled", knownCostMicros: "0" });
  expect(settlement.event.unknownCostMicros).toBeUndefined();
  expect(factoryUsageSettlementIsIntact(settlement)).toBe(true);
  // The stop receipt is part of the sealed body: swapping it breaks the digest.
  expect(factoryUsageSettlementIsIntact({ ...settlement, stopReceiptDigest: `sha256:${"d".repeat(64)}` })).toBe(false);
  // So is the basis: a record that drops it no longer hashes to its own body.
  const { basis: _dropped, ...withoutBasis } = settlement;
  expect(factoryUsageSettlementIsIntact(withoutBasis)).toBe(false);
  // Only a zero, only with its stop, and never with a held cost or a provider receipt.
  expect(rejection({ source: "no-operations", knownCostMicros: "0" })).toBe("factory_usage_settlement_receipt_invalid");
  expect(rejection({ source: "no-operations", knownCostMicros: "0", stopReceiptDigest: "c".repeat(64) })).toBe("factory_usage_settlement_receipt_invalid");
  expect(rejection({ source: "no-operations", knownCostMicros: "0", stopReceiptDigest: 7 as never })).toBe("factory_usage_settlement_receipt_invalid");
  expect(rejection({ source: "no-operations", knownCostMicros: "1", stopReceiptDigest })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ source: "no-operations", knownCostMicros: "0", unknownCostMicros: "5", stopReceiptDigest })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ source: "no-operations", knownCostMicros: "0", providerReceiptDigest: receipt, stopReceiptDigest })).toBe("factory_usage_settlement_invalid");
  // A stop receipt never rides on a measured or reconciled settlement.
  expect(rejection({ source: "stop", stopReceiptDigest })).toBe("factory_usage_settlement_receipt_invalid");
  expect(rejection({ source: "reconciliation", providerReceiptDigest: receipt, stopReceiptDigest })).toBe("factory_usage_settlement_receipt_invalid");
  expect(rejection({ source: "estimate" as never })).toBe("factory_usage_settlement_invalid");
});

test("W03f: seals an operations settlement with its stop and one of its two bases, and nothing else under that source", () => {
  const stopReceiptDigest = `sha256:${"c".repeat(64)}`;
  for (const [knownCostMicros, basis] of [["0", FACTORY_USAGE_PROVIDER_ERROR_BASIS], ["1200", FACTORY_USAGE_PROVIDER_ERROR_BASIS], ["31", FACTORY_USAGE_OPERATIONS_BASIS]] as const) {
    const settlement = buildFactoryUsageSettlement(input({ source: "operations", knownCostMicros, stopReceiptDigest, basis }));
    expect(settlement).toMatchObject({ source: "operations", knownCostMicros, stopReceiptDigest, basis });
    expect(settlement.event).toMatchObject({ kind: "usage-settled", knownCostMicros });
    expect(factoryUsageSettlementIsIntact(settlement)).toBe(true);
    expect(factoryUsageSettlementIsIntact({ ...settlement, basis: basis === FACTORY_USAGE_OPERATIONS_BASIS ? FACTORY_USAGE_PROVIDER_ERROR_BASIS : FACTORY_USAGE_OPERATIONS_BASIS })).toBe(false);
  }
  expect([FACTORY_USAGE_PROVIDER_ERROR_BASIS, FACTORY_USAGE_OPERATIONS_BASIS]).toEqual(["provider-error: model usage measured, compute at reserved bound", "operations: model usage measured, compute at reserved bound"]);
  // Proven only by its stop, with a basis of its own, and never with a held cost or a provider receipt.
  expect(rejection({ source: "operations", knownCostMicros: "0", basis: FACTORY_USAGE_PROVIDER_ERROR_BASIS })).toBe("factory_usage_settlement_receipt_invalid");
  expect(rejection({ source: "operations", knownCostMicros: "0", stopReceiptDigest })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ source: "operations", knownCostMicros: "0", stopReceiptDigest, basis: FACTORY_USAGE_NO_OPERATIONS_BASIS })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ source: "operations", knownCostMicros: "0", stopReceiptDigest, basis: "provider-error: refunded" as never })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ source: "operations", knownCostMicros: "0", unknownCostMicros: "5", stopReceiptDigest, basis: FACTORY_USAGE_OPERATIONS_BASIS })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ source: "operations", knownCostMicros: "0", providerReceiptDigest: receipt, stopReceiptDigest, basis: FACTORY_USAGE_OPERATIONS_BASIS })).toBe("factory_usage_settlement_invalid");
  // A caller cannot put a basis on a settlement whose source has none, or change the one no-operations derives.
  expect(rejection({ source: "stop", basis: FACTORY_USAGE_OPERATIONS_BASIS })).toBe("factory_usage_settlement_invalid");
  expect(rejection({ source: "no-operations", knownCostMicros: "0", stopReceiptDigest, basis: FACTORY_USAGE_PROVIDER_ERROR_BASIS })).toBe("factory_usage_settlement_invalid");
  expect(buildFactoryUsageSettlement(input({ source: "no-operations", knownCostMicros: "0", stopReceiptDigest, basis: FACTORY_USAGE_NO_OPERATIONS_BASIS })).basis).toBe(FACTORY_USAGE_NO_OPERATIONS_BASIS);
});

test("W03f: a stop settles from the journal alone: no operation, every operation measured, or held", () => {
  const measured = (costMicros: string, inputTokens: number, outputTokens: number) => ({ kind: "measured", inputTokens, outputTokens, computeMs: 999, costMicros });
  const receiptDigest = "d".repeat(64);
  expect(factoryJournalStopSettlement([])).toEqual({ kind: "no-operations" });
  // A provider refused before consuming anything: a measured zero, named as a provider error.
  expect(factoryJournalStopSettlement([{ state: "failed", usage: measured("0", 0, 0), providerReceiptDigest: receiptDigest }]))
    .toEqual({ kind: "operations", costMicros: "0", tokens: 0, basis: FACTORY_USAGE_PROVIDER_ERROR_BASIS });
  // Partial consumption settles the measured sum, never zero; compute is not summed here at all.
  expect(factoryJournalStopSettlement([
    { state: "completed", usage: measured("1200", 11, 7), providerReceiptDigest: receiptDigest },
    { state: "failed", usage: measured("18446744073709551615", 3, 0), providerReceiptDigest: receiptDigest },
  ])).toEqual({ kind: "operations", costMicros: "18446744073709552815", tokens: 21, basis: FACTORY_USAGE_PROVIDER_ERROR_BASIS });
  // Settled calls and no provider error: the operations basis.
  expect(factoryJournalStopSettlement([{ state: "completed", usage: measured("31", 2, 2), providerReceiptDigest: receiptDigest }]))
    .toEqual({ kind: "operations", costMicros: "31", tokens: 4, basis: FACTORY_USAGE_OPERATIONS_BASIS });
  // Anything the journal cannot price keeps the hold, fail closed.
  for (const unpriced of [
    { state: "failed" },
    { state: "failed", usage: { kind: "unknown", reason: "lost", heldCostMicros: "5" } },
    { state: "dispatched" },
    { state: "prepared" },
    { state: "uncertain", usage: { kind: "unknown", reason: "record failed", heldCostMicros: "5" }, providerReceiptDigest: receiptDigest },
  ] as const) {
    expect(factoryJournalStopSettlement([{ state: "completed", usage: measured("1", 1, 1) }, unpriced as never])).toEqual({ kind: "held" });
  }
  expect(() => factoryJournalStopSettlement([{ state: "failed", usage: { kind: "measured", inputTokens: -1, outputTokens: 0, computeMs: 0, costMicros: "0" } }])).toThrow("factory_usage_settlement_corrupt");
});
