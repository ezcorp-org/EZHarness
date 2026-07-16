import { test, expect, describe } from "bun:test";
import {
  RELAY_DIRECTIVE,
  crossCheckFindingIds,
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
    expect(enforceNamedApproval("approve", ["f1"], false, 1).ok).toBe(true);
  });

  test("fix with explicit findingIds is allowed", () => {
    expect(enforceNamedApproval("fix", ["f1", "f2"], undefined, 1).ok).toBe(true);
  });

  test("approve of a gate WITH ask-user findings + NO findingIds + no consent is REJECTED", () => {
    const g = enforceNamedApproval("approve", [], false, 2);
    expect(g.ok).toBe(false);
    expect(g.error).toContain("must name the explicit findingIds");
    // The error names how many ask-user findings are still awaiting a decision.
    expect(g.error).toContain("2 ask-user finding");
  });

  test("approve with undefined findingIds and no consent is REJECTED when ask-user findings exist", () => {
    const g = enforceNamedApproval("approve", undefined, undefined, 1);
    expect(g.ok).toBe(false);
  });

  test("fix with empty findingIds and no consent is REJECTED (fix always needs a target)", () => {
    // A fix must know WHAT to fix — a clean gate does not relax it.
    expect(enforceNamedApproval("fix", [], false, 1).ok).toBe(false);
    expect(enforceNamedApproval("fix", [], false, 0).ok).toBe(false);
  });

  // ── de-normalization: a CLEAN gate approves ids-free (no consent needed) ──

  test("CLEAN gate (0 ask-user findings) accepts an ids-free approve WITHOUT consent", () => {
    const g = enforceNamedApproval("approve", [], false, 0);
    expect(g.ok).toBe(true);
    expect(g.consentAllUsed).toBeFalsy();
  });

  test("CLEAN gate ids-free approve does not flag consentAll even if consent was passed", () => {
    // The clean-gate path wins before the consent path → no bypass to audit.
    const g = enforceNamedApproval("approve", [], true, 0);
    expect(g.ok).toBe(true);
    expect(g.consentAllUsed).toBeFalsy();
  });

  test("a gate WITH ask-user findings still requires named ids for an ids-free approve", () => {
    expect(enforceNamedApproval("approve", [], false, 3).ok).toBe(false);
    expect(enforceNamedApproval("approve", ["a1"], false, 3).ok).toBe(true);
  });

  // ── audit: standing consent that actually bypassed is flagged ──

  test("standing consent over a gate WITH ask-user findings is allowed AND flagged consentAllUsed", () => {
    const g = enforceNamedApproval("approve", [], true, 2);
    expect(g.ok).toBe(true);
    expect(g.consentAllUsed).toBe(true);
  });

  test("standing consent allows a blanket fix (no ids) AND flags consentAllUsed", () => {
    const g = enforceNamedApproval("fix", undefined, true, 0);
    expect(g.ok).toBe(true);
    expect(g.consentAllUsed).toBe(true);
  });

  test("skip and abort approve nothing → always allowed even with no ids", () => {
    expect(enforceNamedApproval("skip", [], false, 5).ok).toBe(true);
    expect(enforceNamedApproval("abort", undefined, false, 5).ok).toBe(true);
  });
});

// ── (b2) cross-check named ids against the parked step's REAL findings ──

describe("crossCheckFindingIds", () => {
  test("a named id that exists on the parked step is allowed", () => {
    expect(crossCheckFindingIds("approve", ["a1"], ["a1", "n1"]).ok).toBe(true);
  });

  test("a named id that does NOT exist is rejected (junk id)", () => {
    const g = crossCheckFindingIds("approve", ["ghost"], ["a1", "n1"]);
    expect(g.ok).toBe(false);
    expect(g.error).toContain("ghost");
    expect(g.error).toContain("not in the parked");
  });

  test("only the unknown ids are named in the error", () => {
    const g = crossCheckFindingIds("fix", ["a1", "bogus"], new Set(["a1", "n1"]));
    expect(g.ok).toBe(false);
    expect(g.error).toContain("bogus");
    expect(g.error).not.toContain("a1]"); // a1 is real → not listed as unknown
  });

  test("an ids-free approve/fix is not cross-checked here (empty list → ok)", () => {
    expect(crossCheckFindingIds("approve", [], ["a1"]).ok).toBe(true);
    expect(crossCheckFindingIds("fix", undefined, ["a1"]).ok).toBe(true);
  });

  test("skip and abort are never cross-checked", () => {
    expect(crossCheckFindingIds("skip", ["ghost"], []).ok).toBe(true);
    expect(crossCheckFindingIds("abort", ["ghost"], []).ok).toBe(true);
  });
});
