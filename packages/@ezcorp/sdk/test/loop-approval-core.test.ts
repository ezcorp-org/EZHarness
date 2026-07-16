// loop-approval-core.test.ts — pure state-machine additions for Phase 2
// approvals: contract-state injection, parked-run predicates, staleness,
// proposal + act-result validation. Zero I/O (clock injected).

import { describe, expect, test } from "bun:test";

import {
  APPROVAL_STATES,
  APPROVAL_TERMINAL_STATES,
  APPROVED,
  AWAITING_APPROVAL,
  DECLINED,
  DEFAULT_STALE_AFTER_DAYS,
  FINALIZING,
  countActiveRuns,
  isParked,
  isProposalStale,
  resolveContract,
  validateActResult,
  validateProposal,
} from "../src/runtime/loop-core";
import type {
  ActResult,
  LoopProposal,
  LoopRunState,
} from "../src/runtime/loop-types";

const PROPOSAL: LoopProposal = {
  title: "Draft PR",
  summary: "Updates the README",
  kind: "pr",
  ref: "https://example/pr/1",
};

function run(
  partial: Partial<LoopRunState> & { status: string; createdAt: string },
): LoopRunState {
  return {
    id: "r",
    loopId: "l",
    scope: "global",
    events: [],
    updatedAt: partial.createdAt,
    ...partial,
  };
}

// ── resolveContract: approval-state injection ────────────────────────

describe("resolveContract — approval", () => {
  test("no approval → states unchanged, no approval block, configVersion 0", () => {
    const c = resolveContract({ states: ["done"], terminal: ["done"] });
    expect(c.states).toEqual(["done"]);
    expect(c.approval).toBeUndefined();
    expect(c.configVersion).toBe("0");
  });

  test("approval present → injects the four owned states + terminal subset", () => {
    const c = resolveContract({
      states: ["dispatched", "completed"],
      terminal: ["completed"],
      approval: {},
    });
    for (const s of APPROVAL_STATES) expect(c.states).toContain(s);
    // approved + declined are terminal; awaiting_approval + finalizing are NOT.
    expect(c.terminal).toContain(APPROVED);
    expect(c.terminal).toContain(DECLINED);
    expect(c.terminal).not.toContain(AWAITING_APPROVAL);
    expect(c.terminal).not.toContain(FINALIZING);
    // Declared terminal preserved + comes first (mapAssignmentStatus fallback).
    expect(c.terminal[0]).toBe("completed");
  });

  test("mode defaults to proactive; staleAfterDays defaults; both overridable", () => {
    const dflt = resolveContract({ approval: {} });
    expect(dflt.approval).toEqual({
      mode: "proactive",
      staleAfterDays: DEFAULT_STALE_AFTER_DAYS,
    });
    const custom = resolveContract({
      approval: { mode: "proactive", staleAfterDays: 3 },
      configVersion: "v2",
    });
    expect(custom.approval).toEqual({ mode: "proactive", staleAfterDays: 3 });
    expect(custom.configVersion).toBe("v2");
  });

  test("de-dupes when a declared state already names an owned approval state", () => {
    const c = resolveContract({
      states: [AWAITING_APPROVAL, "done"],
      terminal: ["done"],
      approval: {},
    });
    // awaiting_approval appears exactly once despite being declared + injected.
    expect(c.states.filter((s) => s === AWAITING_APPROVAL)).toHaveLength(1);
  });

  test("APPROVAL_TERMINAL_STATES is exactly approved + declined", () => {
    expect([...APPROVAL_TERMINAL_STATES]).toEqual([APPROVED, DECLINED]);
  });
});

// ── parked-run predicates ────────────────────────────────────────────

describe("isParked / countActiveRuns", () => {
  test("isParked true for awaiting_approval + finalizing, false otherwise", () => {
    expect(isParked({ status: AWAITING_APPROVAL })).toBe(true);
    expect(isParked({ status: FINALIZING })).toBe(true);
    expect(isParked({ status: "running" })).toBe(false);
    expect(isParked({ status: APPROVED })).toBe(false);
  });

  test("countActiveRuns excludes parked AND terminal runs", () => {
    const c = resolveContract({
      states: ["running", "done"],
      terminal: ["done"],
      approval: {},
    });
    const runs = [
      run({ status: "running", createdAt: "2026-01-01T00:00:00Z" }),
      run({ status: AWAITING_APPROVAL, createdAt: "2026-01-01T00:00:00Z" }),
      run({ status: FINALIZING, createdAt: "2026-01-01T00:00:00Z" }),
      run({ status: "done", createdAt: "2026-01-01T00:00:00Z" }),
      run({ status: APPROVED, createdAt: "2026-01-01T00:00:00Z" }),
    ];
    // Only the single "running" run counts toward concurrency.
    expect(countActiveRuns(runs, c)).toBe(1);
  });
});

// ── staleness ────────────────────────────────────────────────────────

describe("isProposalStale", () => {
  const day = 24 * 60 * 60 * 1000;
  const created = "2026-07-01T00:00:00.000Z";
  const createdMs = Date.parse(created);

  test("staleAfterDays <= 0 disables the sweep", () => {
    expect(isProposalStale(run({ status: AWAITING_APPROVAL, createdAt: created }), 0, createdMs + 100 * day)).toBe(false);
    expect(isProposalStale(run({ status: AWAITING_APPROVAL, createdAt: created }), -1, createdMs + 100 * day)).toBe(false);
  });

  test("only awaiting_approval runs are candidates", () => {
    expect(isProposalStale(run({ status: FINALIZING, createdAt: created }), 1, createdMs + 100 * day)).toBe(false);
    expect(isProposalStale(run({ status: "running", createdAt: created }), 1, createdMs + 100 * day)).toBe(false);
  });

  test("age >= horizon → stale; age < horizon → fresh", () => {
    expect(isProposalStale(run({ status: AWAITING_APPROVAL, createdAt: created }), 7, createdMs + 7 * day)).toBe(true);
    expect(isProposalStale(run({ status: AWAITING_APPROVAL, createdAt: created }), 7, createdMs + 6 * day)).toBe(false);
  });

  test("unparseable createdAt is never stale (fail-safe)", () => {
    expect(isProposalStale(run({ status: AWAITING_APPROVAL, createdAt: "not-a-date" }), 1, createdMs)).toBe(false);
  });
});

// ── proposal validation ──────────────────────────────────────────────

describe("validateProposal", () => {
  test("accepts a well-formed proposal", () => {
    expect(validateProposal(PROPOSAL)).toBeNull();
    expect(validateProposal({ title: "t", summary: "", kind: "artifact" })).toBeNull();
  });

  test("rejects non-object / null", () => {
    expect(validateProposal(null)).toMatch(/must be an object/);
    expect(validateProposal("x")).toMatch(/must be an object/);
  });

  test("rejects empty/absent title", () => {
    expect(validateProposal({ summary: "s", kind: "pr" })).toMatch(/title/);
    expect(validateProposal({ title: "", summary: "s", kind: "pr" })).toMatch(/title/);
  });

  test("rejects non-string summary", () => {
    expect(validateProposal({ title: "t", summary: 1, kind: "pr" })).toMatch(/summary/);
  });

  test("rejects an unknown kind", () => {
    expect(validateProposal({ title: "t", summary: "s", kind: "nope" })).toMatch(/kind/);
  });

  test("rejects a non-string ref when present", () => {
    expect(validateProposal({ title: "t", summary: "s", kind: "pr", ref: 5 })).toMatch(/ref/);
  });
});

// ── validateActResult: proposal branch ───────────────────────────────

describe("validateActResult — proposal", () => {
  const withApproval = resolveContract({ states: ["done"], approval: {} });
  const noApproval = resolveContract({ states: ["done"] });

  const proposalResult: ActResult = {
    kind: "proposal",
    status: "pr_drafted",
    proposal: PROPOSAL,
    finalize: async () => ({}),
  };

  test("proposal without contract.approval is a misconfiguration", () => {
    expect(validateActResult(proposalResult, noApproval)).toMatch(/approval is not declared/);
  });

  test("proposal without a finalize function is rejected", () => {
    const bad = { kind: "proposal", status: "x", proposal: PROPOSAL } as unknown as ActResult;
    expect(validateActResult(bad, withApproval)).toMatch(/finalize\(\)/);
  });

  test("proposal with a malformed descriptor is rejected", () => {
    const bad: ActResult = {
      kind: "proposal",
      status: "x",
      proposal: { title: "", summary: "s", kind: "pr" },
      finalize: async () => ({}),
    };
    expect(validateActResult(bad, withApproval)).toMatch(/title/);
  });

  test("a valid proposal passes (status is NOT checked against states)", () => {
    expect(validateActResult(proposalResult, withApproval)).toBeNull();
  });
});
