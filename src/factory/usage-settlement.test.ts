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
  const scopes = { async readSettlementScopeInTransaction() { return undefined; } };
  const journal = { async reconcileLate(): Promise<never> { throw new Error("unused"); }, async operations(): Promise<never> { throw new Error("unused"); } };
  const budgets = { async settleInTransaction() { throw new Error("unused"); } };
  expect(() => new FactoryUsageReconciliation(database, "other-tenant", scopes, journal, budgets, settlements)).toThrow("factory_usage_settlement_scope");
  expect(new FactoryUsageReconciliation(database, "tenant", scopes, journal, budgets, settlements).tenantId).toBe("tenant");
});
