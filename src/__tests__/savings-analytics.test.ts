/**
 * Real-PGlite integration tests for src/db/queries/savings-analytics.ts.
 *
 * Seeds users/projects/conversations/messages (incl. legacy rows without the
 * cache/provenance usage fields, routed rows, a failover row, an out-of-range
 * row and a non-assistant row) and asserts hand-computed USD values, scope
 * isolation, range filtering, per-model grouping, hit-rate legacy exclusion,
 * memoized cost lookups, and the subscription-provider detection (both the
 * injected-deps seam and the REAL registry/settings-backed defaults).
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  setupTestDb,
  getTestDb,
  closeTestDb,
  mockDbConnection,
  mockRealSettings,
} from "./helpers/test-pglite";

mockDbConnection();
mockRealSettings();

import { getModel, getModels, type Model } from "@earendil-works/pi-ai";
import { users, projects, conversations, messages } from "../db/schema";
import { upsertSetting } from "../db/queries/settings";
import { findModelForProviderInTier } from "../providers/registry";
import {
  getSavingsForUser,
  getSavingsForProject,
  type SavingsPricingDeps,
} from "../db/queries/savings-analytics";
import {
  computeRowCacheSavings,
  computeServedCostUsd,
  type ModelCostLike,
} from "../runtime/usage/savings";

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

// ── Fixed price sheets for deterministic $ assertions ────────────────
const BAL: ModelCostLike = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const POW: ModelCostLike = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };
const FAST: ModelCostLike = { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 0.3125 };

const FIXED_COSTS: Record<string, ModelCostLike> = { "m-bal": BAL, "m-pow": POW, "m-fast": FAST };

let modelCostCalls: string[] = [];
let counterfactualCalls: string[] = [];

const fixedDeps: SavingsPricingDeps = {
  getModelCost(provider, model) {
    modelCostCalls.push(`${provider}/${model}`);
    return FIXED_COSTS[model] ?? null;
  },
  getCounterfactualCost(provider) {
    counterfactualCalls.push(provider);
    return BAL;
  },
  isSubscriptionProvider: async (p) => p === "subprov",
};

// ── Seed fixtures ────────────────────────────────────────────────────
const USER_A = "u-sav-a";
const USER_B = "u-sav-b";
const USER_C = "u-sav-c"; // default-deps (real registry) section
const P1 = "p-sav-1";
const P2 = "p-sav-2";
const CONV_A1 = "conv-sav-a1";
const CONV_A2 = "conv-sav-a2";
const CONV_B1 = "conv-sav-b1";
const CONV_C1 = "conv-sav-c1";

const NOW = Date.now();
const RECENT = new Date(NOW - 60 * 60 * 1000); // 1h ago
const OLD = new Date(NOW - 100 * 24 * 60 * 60 * 1000); // 100 days ago

// A real, fully-priced Anthropic model + its balanced-tier counterfactual,
// resolved from the live registry so the default-deps test tracks real prices.
let realServed: Model<any>;
let realCounterfactualCost: ModelCostLike;

function msgRow(
  id: string,
  conversationId: string,
  opts: {
    role?: string;
    provider?: string | null;
    model?: string | null;
    usage?: Record<string, unknown> | null;
    createdAt?: Date;
  },
) {
  return {
    id,
    conversationId,
    role: opts.role ?? "assistant",
    content: "x",
    provider: opts.provider ?? null,
    model: opts.model ?? null,
    usage: opts.usage ?? null,
    createdAt: opts.createdAt ?? RECENT,
  };
}

beforeAll(async () => {
  await setupTestDb();
  const db = getTestDb();

  await db.insert(users).values([
    { id: USER_A, email: "a@sav.com", passwordHash: "x", name: "A", role: "member" } as any,
    { id: USER_B, email: "b@sav.com", passwordHash: "x", name: "B", role: "member" } as any,
    { id: USER_C, email: "c@sav.com", passwordHash: "x", name: "C", role: "member" } as any,
  ]);
  await db.insert(projects).values([
    { id: P1, name: "p1", path: "/tmp/p1" } as any,
    { id: P2, name: "p2", path: "/tmp/p2" } as any,
  ]);
  await db.insert(conversations).values([
    { id: CONV_A1, projectId: P1, title: "a1", userId: USER_A } as any,
    { id: CONV_A2, projectId: P2, title: "a2", userId: USER_A } as any,
    { id: CONV_B1, projectId: P1, title: "b1", userId: USER_B } as any,
    { id: CONV_C1, projectId: P2, title: "c1", userId: USER_C } as any,
  ]);

  await db.insert(messages).values([
    // r1 — cache-eligible turn: 800 read of 1000 prompt, 100 written @5m.
    msgRow("sav-r1", CONV_A1, {
      provider: "prov",
      model: "m-bal",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 100 },
    }),
    // r2 — LEGACY row (pre-cache-meter): must not drag hit-rate down.
    msgRow("sav-r2", CONV_A1, {
      provider: "prov",
      model: "m-bal",
      usage: { inputTokens: 1000, outputTokens: 200 },
    }),
    // r3 — routed to POWERFUL (Auto): routing savings are NEGATIVE.
    msgRow("sav-r3", CONV_A1, {
      provider: "prov",
      model: "m-pow",
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        requestedProvider: null,
        requestedModel: null,
        routedTier: "powerful",
      },
    }),
    // r4 — routed to FAST on a subscription provider, with failover.
    msgRow("sav-r4", CONV_A1, {
      provider: "subprov",
      model: "m-fast",
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        requestedProvider: null,
        requestedModel: null,
        routedTier: "fast",
        failover: true,
      },
    }),
    // r5 — routed to BALANCED: counted as routed, contributes $0.
    msgRow("sav-r5", CONV_A1, {
      provider: "prov",
      model: "m-bal",
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        requestedProvider: null,
        requestedModel: null,
        routedTier: "balanced",
      },
    }),
    // r6 — assistant row with NO usage at all (crash-orphaned turn).
    msgRow("sav-r6", CONV_A1, { provider: "prov", model: "m-bal", usage: null }),
    // r7 — user-role row: excluded from everything.
    msgRow("sav-r7", CONV_A1, { role: "user", usage: { inputTokens: 5, outputTokens: 5 } }),
    // r8 — OUT OF RANGE at 30 days (100 days old), included at 365.
    msgRow("sav-r8", CONV_A1, {
      provider: "prov",
      model: "m-bal",
      usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 },
      createdAt: OLD,
    }),
    // r9 — user A, DIFFERENT project (P2): user scope sees it, P1 scope must not.
    msgRow("sav-r9", CONV_A2, {
      provider: "prov",
      model: "m-bal",
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    // r10 — user B in P1: project scope sees it, user-A scope must not.
    msgRow("sav-r10", CONV_B1, {
      provider: "prov",
      model: "m-bal",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 500, cacheWriteTokens: 0 },
    }),
  ]);

  // ── Default-deps (real registry) fixtures under USER_C / CONV_C1 ──
  const priced = getModels("anthropic").filter(
    (m) => m.cost.input > 0 && m.cost.output > 0 && m.cost.cacheRead > 0 && m.cost.cacheWrite > 0,
  );
  expect(priced.length).toBeGreaterThan(0);
  realServed = priced[0]!;
  const cfEntry = findModelForProviderInTier("anthropic", "balanced");
  expect(cfEntry).not.toBeNull();
  realCounterfactualCost = getModel("anthropic", cfEntry!.id as never)!.cost;

  await db.insert(messages).values([
    // d1 — real Anthropic model, cache mix incl. 1h split, routed powerful.
    msgRow("sav-d1", CONV_C1, {
      provider: "anthropic",
      model: realServed.id,
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 2000,
        cacheWriteTokens: 500,
        cacheWrite1hTokens: 200,
        requestedProvider: null,
        requestedModel: null,
        routedTier: "powerful",
      },
    }),
    // d2 — unknown model id: cost lookup misses ⇒ contributes $0.
    msgRow("sav-d2", CONV_C1, {
      provider: "anthropic",
      model: "no-such-model-xyz",
      usage: { inputTokens: 100, outputTokens: 10 },
    }),
    // d3 — routed on a provider with NO registry models ⇒ counterfactual null.
    msgRow("sav-d3", CONV_C1, {
      provider: "unknownprov",
      model: "whatever",
      usage: { inputTokens: 10, outputTokens: 1, requestedProvider: null, requestedModel: null, routedTier: "fast" },
    }),
    // d4/d5/d6 — one row per provider for subscription detection.
    msgRow("sav-d4", CONV_C1, { provider: "openai-codex", model: "gpt-5.5", usage: { inputTokens: 10, outputTokens: 1 } }),
    msgRow("sav-d5", CONV_C1, { provider: "google", model: "gemini-x", usage: { inputTokens: 10, outputTokens: 1 } }),
    msgRow("sav-d6", CONV_C1, { provider: "openai", model: "gpt-x", usage: { inputTokens: 10, outputTokens: 1 } }),
  ]);

  // Current credential configuration for the REAL subscription detector.
  await upsertSetting("provider:accessMode:google", "oauth"); // explicit oauth ⇒ subscription
  await upsertSetting("provider:accessMode:anthropic", "apikey"); // explicit apikey ⇒ billed
  await upsertSetting("provider:oauth:openai", "encrypted-oauth-blob"); // stored creds ⇒ subscription
}, 30_000);

// Hand-computed expectations for the fixed price sheets.
const R1_READ_SAVED = (800 * (3 - 0.3)) / 1e6; // 0.00216
const R1_5M_SURCHARGE = (100 * (3.75 - 3)) / 1e6; // 0.000075
const R1_NET = R1_READ_SAVED - R1_5M_SURCHARGE; // 0.002085
const R3_ROUTING = (3 * 1000 + 15 * 100) / 1e6 - (15 * 1000 + 75 * 100) / 1e6; // −0.018
const R4_ROUTING = (3 * 1000 + 15 * 100) / 1e6 - (0.25 * 1000 + 1.25 * 100) / 1e6; // +0.004125

describe("getSavingsForUser (fixed prices)", () => {
  test("aggregates only the user's assistant turns in range, with honest negatives", async () => {
    modelCostCalls = [];
    counterfactualCalls = [];
    const report = await getSavingsForUser(USER_A, 30, fixedDeps);

    expect(report.rangeDays).toBe(30);
    expect(report.estimated).toBe(true);
    // r1..r6 in CONV_A1 + r9 in CONV_A2. r7 (user role) and r8 (old) excluded.
    expect(report.stats.turnsTotal).toBe(7);
    expect(report.stats.turnsRouted).toBe(3);
    expect(report.stats.turnsFailover).toBe(1);
    expect(report.stats.tokensCachedRead).toBe(800);
    expect(report.stats.tokensCacheWritten).toBe(100);
    expect(report.stats.cacheReadSavedUsd).toBeCloseTo(R1_READ_SAVED, 12);
    expect(report.stats.cacheWriteSurchargeUsd).toBeCloseTo(R1_5M_SURCHARGE, 12);
    expect(report.stats.write1hPremiumUsd).toBe(0);
    expect(report.stats.cacheSavedUsd).toBeCloseTo(R1_NET, 12);
    // Routing nets NEGATIVE: the powerful re-route dominates the fast one.
    expect(report.stats.routingSavedUsd).toBeCloseTo(R3_ROUTING + R4_ROUTING, 12);
    expect(report.stats.routingSavedUsd).toBeLessThan(0);
    // Hit-rate counts ONLY the cache-eligible r1 (legacy/null-usage excluded).
    expect(report.stats.cacheHitRate).toBeCloseTo(0.8, 12);
    // Only the subscription provider is annotated.
    expect(report.subscriptionProviders).toEqual(["subprov"]);
  });

  test("groups per served provider+model with per-group hit-rate and estimated flags", async () => {
    const report = await getSavingsForUser(USER_A, 30, fixedDeps);
    const byModel = new Map(report.perModel.map((g) => [`${g.provider}/${g.model}`, g]));
    expect(byModel.size).toBe(3);

    const bal = byModel.get("prov/m-bal")!;
    expect(bal.turns).toBe(5); // r1, r2, r5, r6, r9
    expect(bal.cacheSavedUsd).toBeCloseTo(R1_NET, 12);
    expect(bal.routingSavedUsd).toBe(0); // r5 routed balanced ⇒ $0
    expect(bal.tokensCachedRead).toBe(800);
    expect(bal.cacheHitRate).toBeCloseTo(0.8, 12);
    expect(bal.estimated).toBe(true); // contains a routed turn (r5)

    const pow = byModel.get("prov/m-pow")!;
    expect(pow.turns).toBe(1);
    expect(pow.routingSavedUsd).toBeCloseTo(R3_ROUTING, 12);
    expect(pow.routingSavedUsd).toBeLessThan(0);
    expect(pow.cacheHitRate).toBeNull(); // no cache fields on the routed row
    expect(pow.estimated).toBe(true);

    const fast = byModel.get("subprov/m-fast")!;
    expect(fast.turns).toBe(1);
    expect(fast.routingSavedUsd).toBeCloseTo(R4_ROUTING, 12);
    expect(fast.routingSavedUsd).toBeGreaterThan(0);
    expect(fast.estimated).toBe(true);
  });

  test("memoizes cost lookups per distinct provider+model / provider", async () => {
    modelCostCalls = [];
    counterfactualCalls = [];
    await getSavingsForUser(USER_A, 30, fixedDeps);
    // 5 m-bal rows + 1 m-pow + 1 m-fast ⇒ exactly one lookup per pair.
    expect(modelCostCalls.sort()).toEqual(["prov/m-bal", "prov/m-pow", "subprov/m-fast"]);
    // r3 + r5 share provider "prov"; r4 is "subprov" ⇒ one lookup each.
    expect(counterfactualCalls.sort()).toEqual(["prov", "subprov"]);
  });

  test("range filtering: 365 days pulls in the old row and re-derives hit-rate", async () => {
    const report = await getSavingsForUser(USER_A, 365, fixedDeps);
    expect(report.rangeDays).toBe(365);
    expect(report.stats.turnsTotal).toBe(8); // + r8
    expect(report.stats.tokensCachedRead).toBe(900);
    // eligible: r1 (800/1000) + r8 (100/150) ⇒ 900/1150.
    expect(report.stats.cacheHitRate).toBeCloseTo(900 / 1150, 12);
    expect(report.stats.cacheReadSavedUsd).toBeCloseTo((900 * 2.7) / 1e6, 12);
  });

  test("days defaults to 30 when omitted", async () => {
    const report = await getSavingsForUser(USER_A, undefined, fixedDeps);
    expect(report.rangeDays).toBe(30);
    expect(report.stats.turnsTotal).toBe(7);
  });

  test("user isolation: user B sees only their own rows", async () => {
    const report = await getSavingsForUser(USER_B, 30, fixedDeps);
    expect(report.stats.turnsTotal).toBe(1);
    expect(report.stats.tokensCachedRead).toBe(500);
    expect(report.stats.cacheHitRate).toBeCloseTo(1, 12); // 500 read of 500 prompt
    expect(report.stats.cacheSavedUsd).toBeCloseTo((500 * 2.7) / 1e6, 12);
  });
});

describe("getSavingsForProject (fixed prices)", () => {
  test("unscoped (admin view): whole project across users, other projects excluded", async () => {
    const report = await getSavingsForProject(P1, 30, undefined, fixedDeps);
    // r1..r6 (user A) + r10 (user B); r9 lives in P2.
    expect(report.stats.turnsTotal).toBe(7);
    expect(report.stats.tokensCachedRead).toBe(1300);
    // eligible: r1 (800/1000) + r10 (500/500) ⇒ 1300/1500.
    expect(report.stats.cacheHitRate).toBeCloseTo(1300 / 1500, 12);
    expect(report.stats.cacheReadSavedUsd).toBeCloseTo((1300 * 2.7) / 1e6, 12);
    expect(report.subscriptionProviders).toEqual(["subprov"]);
  });

  test("member scope: only the scoped user's slice of the project", async () => {
    const asB = await getSavingsForProject(P1, 30, USER_B, fixedDeps);
    expect(asB.stats.turnsTotal).toBe(1);
    expect(asB.stats.tokensCachedRead).toBe(500);
    expect(asB.stats.cacheSavedUsd).toBeCloseTo((500 * 2.7) / 1e6, 12);

    const asA = await getSavingsForProject(P1, 30, USER_A, fixedDeps);
    expect(asA.stats.turnsTotal).toBe(6); // r1..r6, no r10
    expect(asA.stats.tokensCachedRead).toBe(800);
  });

  test("unknown project yields an empty (all-zero) report, not an error", async () => {
    const report = await getSavingsForProject("no-such-project", 30, undefined, fixedDeps);
    expect(report.stats.turnsTotal).toBe(0);
    expect(report.stats.cacheHitRate).toBeNull();
    expect(report.perModel).toEqual([]);
    expect(report.subscriptionProviders).toEqual([]);
  });
});

describe("default deps (real pi-ai registry + settings-backed subscription detection)", () => {
  test("prices real models, tolerates unknown models/providers, detects subscriptions", async () => {
    const report = await getSavingsForUser(USER_C, 30); // defaultSavingsDeps

    expect(report.stats.turnsTotal).toBe(6);
    expect(report.stats.turnsRouted).toBe(2); // d1 + d3

    // d1 cache math against the REAL registry price sheet (cross-checked
    // through the pure module, which itself is pinned to pi-ai calculateCost).
    const d1Usage = {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 2000,
      cacheWriteTokens: 500,
      cacheWrite1hTokens: 200,
    };
    const expectedCache = computeRowCacheSavings(realServed.cost, d1Usage);
    expect(report.stats.cacheSavedUsd).toBeCloseTo(expectedCache.cacheSavedUsd, 12);
    expect(report.stats.write1hPremiumUsd).toBeCloseTo(expectedCache.write1hPremiumUsd, 12);
    expect(report.stats.write1hPremiumUsd).toBeGreaterThan(0);

    // d1 routing vs the balanced-tier counterfactual; d3's provider has no
    // registry models ⇒ counterfactual null ⇒ contributes 0.
    const expectedRouting =
      computeServedCostUsd(realCounterfactualCost, d1Usage) -
      computeServedCostUsd(realServed.cost, d1Usage);
    expect(report.stats.routingSavedUsd).toBeCloseTo(expectedRouting, 12);

    // Hit-rate: only d1 carries cache fields ⇒ 2000 / (1000+2000+500).
    expect(report.stats.cacheHitRate).toBeCloseTo(2000 / 3500, 12);

    const byModel = new Map(report.perModel.map((g) => [`${g.provider}/${g.model}`, g]));
    expect(byModel.get(`anthropic/${realServed.id}`)!.estimated).toBe(true); // routed
    expect(byModel.get("anthropic/no-such-model-xyz")!.estimated).toBe(true); // unknown cost
    expect(byModel.get("anthropic/no-such-model-xyz")!.cacheSavedUsd).toBe(0);
    expect(byModel.get("unknownprov/whatever")!.routingSavedUsd).toBe(0);

    // Subscription detection: openai-codex (OAuth-native), google (explicit
    // oauth accessMode), openai (stored OAuth creds). anthropic is explicit
    // apikey; unknownprov has no credential config at all.
    expect(report.subscriptionProviders).toEqual(["google", "openai", "openai-codex"]);
  });
});
