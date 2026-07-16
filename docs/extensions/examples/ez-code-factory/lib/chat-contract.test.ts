import { test, expect, describe } from "bun:test";
import {
  RELAY_DIRECTIVE,
  enforceNamedApproval,
  formatGateRelay,
} from "./chat-contract";
import type { Finding, Findings } from "./runs";

// ── fixtures ────────────────────────────────────────────────────────

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    severity: "warning",
    file: "src/a.ts",
    line: 12,
    description: "possible null deref",
    action: "no-op",
    source: "agent",
    userInstructions: "",
    category: "review",
    ...over,
  };
}

function findings(items: Finding[]): Findings {
  return {
    items,
    summary: "s",
    tested: [],
    testingSummary: "",
    artifacts: [],
    riskLevel: "low",
    riskRationale: "",
  };
}

// ── (a) verbatim ask-user relay ─────────────────────────────────────

describe("formatGateRelay", () => {
  test("an ask-user finding is wrapped with stop + the verbatim relay directive", () => {
    const relay = formatGateRelay(
      findings([finding({ id: "a1", action: "ask-user", description: "confirm deleting user rows?" })]),
    );
    expect(relay.stop).toBe(true);
    expect(relay.directive).toBe(RELAY_DIRECTIVE);
    expect(relay.askUser).toHaveLength(1);
    // The finding is carried VERBATIM — description not rewritten.
    expect(relay.askUser[0]!.description).toBe("confirm deleting user rows?");
    expect(relay.askUser[0]!.id).toBe("a1");
    expect(relay.askUser[0]!.action).toBe("ask-user");
    expect(relay.agentDiscretion).toHaveLength(0);
  });

  test("auto-fix / no-op findings go to agentDiscretion with NO stop signal", () => {
    const relay = formatGateRelay(
      findings([finding({ id: "n1", action: "no-op" }), finding({ id: "x1", action: "auto-fix" })]),
    );
    expect(relay.stop).toBe(false);
    expect(relay.directive).toBeNull();
    expect(relay.askUser).toHaveLength(0);
    expect(relay.agentDiscretion.map((f) => f.id)).toEqual(["n1", "x1"]);
  });

  test("mixed findings — ask-user set carries the stop, the rest are discretion", () => {
    const relay = formatGateRelay(
      findings([
        finding({ id: "n1", action: "no-op" }),
        finding({ id: "a1", action: "ask-user", severity: "error", line: null }),
        finding({ id: "x1", action: "auto-fix" }),
      ]),
    );
    expect(relay.stop).toBe(true);
    expect(relay.askUser.map((f) => f.id)).toEqual(["a1"]);
    expect(relay.askUser[0]!.line).toBeNull();
    expect(relay.agentDiscretion.map((f) => f.id)).toEqual(["n1", "x1"]);
  });

  test("empty findings → no stop, no directive, both lists empty", () => {
    const relay = formatGateRelay(findings([]));
    expect(relay.stop).toBe(false);
    expect(relay.directive).toBeNull();
    expect(relay.askUser).toHaveLength(0);
    expect(relay.agentDiscretion).toHaveLength(0);
  });

  test("relay projects every surfaced field verbatim (userInstructions + category)", () => {
    const relay = formatGateRelay(
      findings([finding({ id: "a1", action: "ask-user", userInstructions: "note", category: "security" })]),
    );
    expect(relay.askUser[0]!.userInstructions).toBe("note");
    expect(relay.askUser[0]!.category).toBe("security");
  });
});

// ── (b) no blanket approval ─────────────────────────────────────────

describe("enforceNamedApproval", () => {
  test("approve with explicit findingIds is allowed", () => {
    expect(enforceNamedApproval("approve", ["f1"], false).ok).toBe(true);
  });

  test("fix with explicit findingIds is allowed", () => {
    expect(enforceNamedApproval("fix", ["f1", "f2"], undefined).ok).toBe(true);
  });

  test("approve with NO findingIds and no consent is REJECTED", () => {
    const g = enforceNamedApproval("approve", [], false);
    expect(g.ok).toBe(false);
    expect(g.error).toContain("must name the explicit findingIds");
  });

  test("approve with undefined findingIds and no consent is REJECTED", () => {
    const g = enforceNamedApproval("approve", undefined, undefined);
    expect(g.ok).toBe(false);
  });

  test("fix with empty findingIds and no consent is REJECTED", () => {
    expect(enforceNamedApproval("fix", [], false).ok).toBe(false);
  });

  test("the standing-consent flag allows a blanket approve/fix", () => {
    expect(enforceNamedApproval("approve", [], true).ok).toBe(true);
    expect(enforceNamedApproval("fix", undefined, true).ok).toBe(true);
  });

  test("skip and abort approve nothing → always allowed even with no ids", () => {
    expect(enforceNamedApproval("skip", [], false).ok).toBe(true);
    expect(enforceNamedApproval("abort", undefined, false).ok).toBe(true);
  });
});
