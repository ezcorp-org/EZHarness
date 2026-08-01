/**
 * WS7 — `scripts/routing-sweep.ts`, the retroactive threshold sweep.
 *
 * The load-bearing assertion is that today's thresholds are ONE OF THE CANDIDATE
 * POINTS and that replaying them reproduces the tier stored on every turn. Without
 * that, "candidate X is cheaper than today" is an unverified claim about a
 * reimplementation rather than a measurement against production behaviour — and
 * the sweep reports the mismatch count itself so a future drift is audible.
 *
 * Also pinned: the metric is COST AT A FIXED ESCALATION RATE, not accuracy (the
 * degenerate "keep the current tier" policy is asserted to look good on
 * agreement while saving nothing); unpriced (subscription) models never
 * contribute a fake $0.00; and turns decided by a declared tier / hint / scorer
 * are held fixed rather than replayed into changes that could not have happened.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { users, projects, conversations, messages } from "../db/schema";
import {
  DEFAULT_TIER_THRESHOLDS,
  FAST_MAX_TOKENS,
  POWERFUL_MIN_TOKENS,
  type RoutingTier,
} from "../runtime/tier-classifier";
import type { StoredRoutingSignals } from "../runtime/routing/labels";

const {
  DEFAULT_FAST_CANDIDATES,
  DEFAULT_POWERFUL_CANDIDATES,
  candidateGrid,
  evaluateCandidate,
  loadSweepTurns,
  main,
  observedTierRates,
  parseSweepArgs,
  replayTier,
  sweep,
} = await import("../../scripts/routing-sweep");

type SweepTurn = {
  signals: StoredRoutingSignals;
  servedTier: RoutingTier;
  totalTokens: number;
  usd: number | null;
};

const USER_ID = "u-sweep";
const PROJECT_ID = "p-sweep";
const CONV = "conv-sweep";
const BASE = Date.now() - 60 * 60 * 1000;
const at = (m: number) => new Date(BASE + m * 60_000);
const ONE_M = 1_000_000;

function sig(over: Partial<StoredRoutingSignals> = {}): StoredRoutingSignals {
  return {
    promptChars: 40,
    historyChars: 0,
    historyMessageCount: 0,
    hasToolMessages: false,
    systemChars: 0,
    attachmentCount: 0,
    toolCount: 0,
    hasComplexTools: false,
    estTokens: 100,
    tier: "fast",
    reason: "short-turn",
    ...over,
  };
}

/**
 * A turn whose stored signals are SELF-CONSISTENT: `promptChars` produces
 * `estTokens`, and `tier`/`reason` are what today's thresholds actually yield for
 * it. That consistency is exactly what the baseline-reproduction check verifies,
 * so the fixtures must not fake it.
 */
function turnOf(promptChars: number, usd: number | null, over: Partial<StoredRoutingSignals> = {}): SweepTurn {
  const estTokens = Math.ceil(promptChars / 4);
  const tier: RoutingTier =
    estTokens >= POWERFUL_MIN_TOKENS ? "powerful" : estTokens <= FAST_MAX_TOKENS ? "fast" : "balanced";
  const reason =
    estTokens >= POWERFUL_MIN_TOKENS ? "context-size" : estTokens <= FAST_MAX_TOKENS ? "short-turn" : "midsize-turn";
  return {
    signals: sig({ promptChars, estTokens, tier, reason, ...over }),
    servedTier: (over.tier as RoutingTier) ?? tier,
    totalTokens: 1_000,
    usd,
  };
}

/** fast is $0.001/1k tokens, balanced 10×, powerful 100× — a realistic ladder
 *  so a cost DELTA between candidates is unmistakable. */
const FIXTURE: SweepTurn[] = [
  turnOf(400, 0.001), // 100 est tokens  → fast
  turnOf(800, 0.001), // 200            → fast
  turnOf(8_000, 0.01), // 2 000          → balanced
  turnOf(12_000, 0.01), // 3 000         → balanced
  turnOf(40_000, 0.1), // 10 000         → powerful
];

beforeAll(async () => {
  await setupTestDb();
  const db = getTestDb();
  await db.insert(users).values({
    id: USER_ID, email: "s@x.com", passwordHash: "x", name: "S", role: "admin",
  } as any);
  await db.insert(projects).values({ id: PROJECT_ID, name: "s", path: "/tmp/s" } as any);
  await db.insert(conversations).values({ id: CONV, projectId: PROJECT_ID, userId: USER_ID } as any);
  await db.insert(messages).values([
    // A routed turn with signals — the only shape the sweep replays. The model
    // is one the registry actually PRICES, so `usd` comes out non-null.
    {
      id: "s-a1", conversationId: CONV, role: "assistant", content: "x",
      provider: "anthropic", model: "claude-sonnet-4-5",
      usage: {
        inputTokens: ONE_M, outputTokens: 0, requestedModel: null,
        routedTier: "balanced",
        routingSignals: sig({ promptChars: 8_000, estTokens: 2_000, tier: "balanced", reason: "midsize-turn" }),
      },
      createdAt: at(1),
    },
    // A routed turn served by an UNPRICED (subscription) model.
    {
      id: "s-a2", conversationId: CONV, role: "assistant", content: "x",
      provider: "anthropic", model: "claude-sonnet-4-5-subscription-only",
      usage: {
        inputTokens: 500, outputTokens: 100, requestedModel: null,
        routingSignals: sig({ estTokens: 200 }),
      },
      createdAt: at(2),
    },
    // A PINNED turn: no routingSignals ⇒ nothing to replay, must be skipped.
    {
      id: "s-a3", conversationId: CONV, role: "assistant", content: "x",
      provider: "anthropic", model: "claude-opus-4-5",
      usage: { inputTokens: 10, outputTokens: 10, requestedModel: "claude-opus-4-5" },
      createdAt: at(3),
    },
    // A legacy row with no usage at all.
    {
      id: "s-a4", conversationId: CONV, role: "assistant", content: "x",
      provider: "anthropic", model: "claude-opus-4-5", createdAt: at(4),
    },
    // A user turn — never a sweep turn.
    { id: "s-u1", conversationId: CONV, role: "user", content: "hi", createdAt: at(0) },
  ] as any);
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("parseSweepArgs", () => {
  test("defaults bracket today's thresholds", () => {
    const parsed = parseSweepArgs([]);
    expect(parsed).toEqual({
      days: 30,
      fast: [...DEFAULT_FAST_CANDIDATES],
      powerful: [...DEFAULT_POWERFUL_CANDIDATES],
    });
    expect(DEFAULT_FAST_CANDIDATES).toContain(FAST_MAX_TOKENS);
    expect(DEFAULT_POWERFUL_CANDIDATES).toContain(POWERFUL_MIN_TOKENS);
  });

  test("accepts explicit grids and a target rate", () => {
    expect(parseSweepArgs(["--days", "7", "--fast", "100, 200", "--powerful", "1000", "--target-escalation-rate", "0.3"]))
      .toEqual({ days: 7, fast: [100, 200], powerful: [1000], targetEscalationRate: 0.3 });
  });

  test("rejects bad numbers instead of guessing", () => {
    expect(parseSweepArgs(["--days", "-1"])).toEqual({ error: "--days needs a positive number" });
    expect(parseSweepArgs(["--fast", "100,0"])).toEqual({ error: '--fast has a non-positive value "0"' });
    expect(parseSweepArgs(["--powerful", "x"])).toEqual({ error: '--powerful has a non-positive value "x"' });
    expect(parseSweepArgs(["--fast"])).toEqual({ error: "--fast needs a comma-separated list of numbers" });
    expect(parseSweepArgs(["--powerful"])).toEqual({ error: "--powerful needs a comma-separated list of numbers" });
    expect(parseSweepArgs(["--target-escalation-rate", "2"]))
      .toEqual({ error: "--target-escalation-rate needs a number in [0,1]" });
    expect(parseSweepArgs(["--wat"])).toEqual({ error: 'unknown flag "--wat"' });
  });
});

describe("candidateGrid", () => {
  test("today's thresholds are always the FIRST point, even if the grid omits them", () => {
    const grid = candidateGrid([123], [4_567]);
    expect(grid[0]).toEqual(DEFAULT_TIER_THRESHOLDS);
    expect(grid).toContainEqual({ fastMaxTokens: 123, powerfulMinTokens: 4_567 });
  });

  test("duplicates collapse, so today's point is never listed twice", () => {
    const grid = candidateGrid([FAST_MAX_TOKENS], [POWERFUL_MIN_TOKENS]);
    expect(grid).toEqual([DEFAULT_TIER_THRESHOLDS]);
  });

  test("a non-ladder candidate (fast ceiling ≥ powerful floor) is dropped", () => {
    // With fast=9000 and powerful=8000 the powerful check fires first and `fast`
    // is unreachable — reporting it would be a misleadingly cheap phantom point.
    const grid = candidateGrid([9_000], [8_000]);
    expect(grid).toEqual([DEFAULT_TIER_THRESHOLDS]);
  });
});

describe("replayTier — through the REAL classifier", () => {
  test("today's thresholds reproduce the tier stored on the row", () => {
    for (const turn of FIXTURE) {
      expect(replayTier(turn, DEFAULT_TIER_THRESHOLDS)).toBe(turn.signals.tier);
    }
  });

  test("a lower powerful floor moves balanced turns up", () => {
    const balanced = FIXTURE[2]!;
    expect(replayTier(balanced, { fastMaxTokens: 500, powerfulMinTokens: 1_000 })).toBe("powerful");
  });

  test("a declared / hint / scorer turn is HELD FIXED, whatever the thresholds", () => {
    for (const reason of ["declared", "hint", "scorer"]) {
      const turn = turnOf(40_000, 0.1, { tier: "fast", reason });
      // Today's thresholds would say `powerful` from the size alone.
      expect(replayTier(turn, DEFAULT_TIER_THRESHOLDS)).toBe("fast");
      expect(replayTier(turn, { fastMaxTokens: 10, powerfulMinTokens: 20 })).toBe("fast");
    }
  });
});

describe("observedTierRates", () => {
  test("derives USD/token per tier from the deployment's own priced spend", () => {
    const rates = observedTierRates(FIXTURE);
    // fast: 2 turns × $0.001 over 2 000 tokens.
    expect(rates.get("fast")).toBeCloseTo(0.000001, 12);
    expect(rates.get("balanced")).toBeCloseTo(0.00001, 12);
    expect(rates.get("powerful")).toBeCloseTo(0.0001, 12);
  });

  test("an UNPRICED tier is ABSENT, never rate 0", () => {
    const rates = observedTierRates([turnOf(400, null)]);
    expect(rates.has("fast")).toBe(false);
    expect(rates.size).toBe(0);
  });

  test("a zero-token turn contributes no rate", () => {
    const rates = observedTierRates([{ ...turnOf(400, 5), totalTokens: 0 }]);
    expect(rates.size).toBe(0);
  });
});

describe("evaluateCandidate", () => {
  const rates = observedTierRates(FIXTURE);

  test("the baseline candidate reports zero mismatches against stored tiers", () => {
    const result = evaluateCandidate(FIXTURE, DEFAULT_TIER_THRESHOLDS, rates);
    expect(result.isBaseline).toBe(true);
    expect(result.baselineMismatches).toBe(0);
    expect(result.tierMix).toEqual({ fast: 2, balanced: 2, powerful: 1 });
    expect(result.escalationRate).toBeCloseTo(0.2, 10);
    // 2×1000×1e-6 + 2×1000×1e-5 + 1×1000×1e-4 = 0.002 + 0.02 + 0.1... over the
    // per-tier rates above.
    expect(result.projectedUsd).toBeCloseTo(0.002 + 0.02 + 0.1, 10);
    expect(result.unprojectable).toBe(0);
  });

  test("a non-baseline candidate reports no mismatch field at all", () => {
    const result = evaluateCandidate(FIXTURE, { fastMaxTokens: 1_000, powerfulMinTokens: 4_000 }, rates);
    expect(result.isBaseline).toBe(false);
    expect("baselineMismatches" in result).toBe(false);
  });

  test("routing everything up costs strictly more", () => {
    const cheap = evaluateCandidate(FIXTURE, { fastMaxTokens: 20_000, powerfulMinTokens: 40_000 }, rates);
    const dear = evaluateCandidate(FIXTURE, { fastMaxTokens: 1, powerfulMinTokens: 2 }, rates);
    expect(dear.escalationRate).toBe(1);
    expect(cheap.escalationRate).toBe(0);
    expect(dear.projectedUsd).toBeGreaterThan(cheap.projectedUsd);
  });

  test("a tier with no observed rate is counted UNPROJECTABLE, not free", () => {
    // Only `fast` was ever priced here, so a candidate that routes turns to
    // `powerful` cannot be priced for them.
    const partial: SweepTurn[] = [turnOf(400, 0.001), turnOf(40_000, null)];
    const result = evaluateCandidate(partial, { fastMaxTokens: 1, powerfulMinTokens: 2 }, observedTierRates(partial));
    expect(result.unprojectable).toBe(1);
    expect(result.projectedUsd).toBe(0);
  });

  test("an empty turn list yields a zero escalation rate, not a division by zero", () => {
    const result = evaluateCandidate([], DEFAULT_TIER_THRESHOLDS, rates);
    expect(result.escalationRate).toBe(0);
    expect(Number.isFinite(result.escalationRate)).toBe(true);
  });
});

describe("sweep — cost at a fixed escalation rate", () => {
  test("reproduces today's thresholds as one candidate point, with zero mismatches", () => {
    const report = sweep(parseSweepArgs([]) as any, FIXTURE);
    const baseline = report.candidates.find((c) => c.isBaseline);
    expect(baseline).toBeDefined();
    expect(baseline).toMatchObject({
      fastMaxTokens: FAST_MAX_TOKENS,
      powerfulMinTokens: POWERFUL_MIN_TOKENS,
      baselineMismatches: 0,
    });
  });

  test("the default target rate is today's own escalation rate", () => {
    const report = sweep(parseSweepArgs([]) as any, FIXTURE);
    const baseline = report.candidates.find((c) => c.isBaseline)!;
    expect(report.targetEscalationRate).toBe(baseline.escalationRate);
  });

  test("the recommendation is the CHEAPEST candidate at or under the target rate", () => {
    const report = sweep({ days: 30, fast: [250, 500, 1_000, 4_000], powerful: [4_000, 8_000, 32_000] }, FIXTURE);
    expect(report.recommended).not.toBeNull();
    expect(report.recommended!.escalationRate).toBeLessThanOrEqual(report.targetEscalationRate);
    for (const c of report.candidates) {
      if (c.escalationRate <= report.targetEscalationRate) {
        expect(report.recommended!.projectedUsd).toBeLessThanOrEqual(c.projectedUsd);
      }
    }
    // Cheaper than today ⇒ a negative delta.
    expect(report.deltaVsBaselineUsd).toBeLessThan(0);
  });

  test("a target rate of 0 still finds the no-escalation candidate", () => {
    const report = sweep(
      { days: 30, fast: [20_000], powerful: [40_000], targetEscalationRate: 0 },
      FIXTURE,
    );
    expect(report.recommended!.escalationRate).toBe(0);
  });

  test("no candidate under the target ⇒ recommended null and no delta", () => {
    // Every candidate escalates at least one turn; the target forbids any.
    const report = sweep(
      { days: 30, fast: [1], powerful: [2], targetEscalationRate: 0 },
      [turnOf(40_000, 0.1)],
    );
    expect(report.recommended).toBeNull();
    expect(report.deltaVsBaselineUsd).toBeNull();
  });

  test("ACCURACY would be the wrong metric — the do-nothing policy proves it", () => {
    // "Keep whatever tier we already chose" agrees with every stored tier (100%
    // agreement) while saving exactly $0. That is why the report ranks on cost at
    // a fixed escalation rate instead.
    const baseline = sweep(parseSweepArgs([]) as any, FIXTURE).candidates.find((c) => c.isBaseline)!;
    const agreement = (FIXTURE.length - (baseline.baselineMismatches ?? 0)) / FIXTURE.length;
    expect(agreement).toBe(1);
    const cheaper = sweep(
      { days: 30, fast: [20_000], powerful: [40_000], targetEscalationRate: 1 },
      FIXTURE,
    ).recommended!;
    expect(cheaper.projectedUsd).toBeLessThan(baseline.projectedUsd);
  });

  test("unpriced and threshold-immune turns are reported, never hidden", () => {
    const turns: SweepTurn[] = [
      ...FIXTURE,
      turnOf(400, null),
      turnOf(40_000, 0.1, { tier: "fast", reason: "declared" }),
    ];
    const report = sweep(parseSweepArgs([]) as any, turns);
    expect(report.turns).toBe(7);
    expect(report.unpricedTurns).toBe(1);
    expect(report.fixedTurns).toBe(1);
    expect(Object.keys(report.observedRates).sort()).toEqual(["balanced", "fast", "powerful"]);
  });

  test("an empty window yields a well-formed, all-zero report", () => {
    const report = sweep(parseSweepArgs([]) as any, []);
    expect(report).toMatchObject({ turns: 0, fixedTurns: 0, unpricedTurns: 0, observedRates: {} });
    expect(report.recommended).not.toBeNull();
    expect(report.recommended!.projectedUsd).toBe(0);
  });
});

describe("loadSweepTurns + main against the seeded DB", () => {
  test("loads only ROUTED turns carrying signals, pricing each honestly", async () => {
    const turns = await loadSweepTurns(30);
    expect(turns).toHaveLength(2);
    // 1M input tokens on a priced model → a real dollar figure.
    expect(turns[0]?.totalTokens).toBe(ONE_M);
    expect(turns[0]?.usd).toBeGreaterThan(0);
    expect(turns[0]?.servedTier).toBe("balanced");
    // The unpriced (subscription) model yields null, NOT 0.
    expect(turns[1]?.usd).toBeNull();
    // A row that predates `routedTier` falls back to the classifier's verdict.
    expect(turns[1]?.servedTier).toBe("fast");
  });

  test("main prints one JSON report and exits 0", async () => {
    const realOut = process.stdout.write.bind(process.stdout);
    let out = "";
    process.stdout.write = ((c: string) => {
      out += c;
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await main(["--days", "30"]);
    } finally {
      process.stdout.write = realOut;
    }
    expect(code).toBe(0);
    const report = JSON.parse(out);
    expect(report).toMatchObject({ days: 30, turns: 2, unpricedTurns: 1 });
    expect(report.candidates.find((c: { isBaseline: boolean }) => c.isBaseline).baselineMismatches).toBe(0);
  });

  test("a bad flag exits 2 without touching the DB", async () => {
    const realErr = process.stderr.write.bind(process.stderr);
    let err = "";
    process.stderr.write = ((c: string) => {
      err += c;
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await main(["--nope"]);
    } finally {
      process.stderr.write = realErr;
    }
    expect(code).toBe(2);
    expect(err).toContain('unknown flag "--nope"');
  });
});
