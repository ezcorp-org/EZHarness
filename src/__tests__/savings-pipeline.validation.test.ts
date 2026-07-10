/**
 * V2 seeded end-to-end PIPELINE validation for the savings-analytics feature.
 *
 * Mandate: prove that what `getSavingsForUser` / `getSavingsForProject` RETURN
 * is EXACTLY what the seeded DB implies — every number hand-computed row-by-row
 * (arithmetic in comments, in micro-dollars = $×1e6) against FIXED DI prices via
 * the `deps` seam — and hunt scoping/filtering bugs adversarially.
 *
 * This suite writes its OWN world (distinct from savings-analytics.test.ts) and
 * targets the adversarial angles:
 *   - range filter keys on messages.createdAt, NOT conversations.createdAt
 *     (a RECENT message inside an OLD-created conversation still counts; an OLD
 *     message inside a RECENT conversation does not);
 *   - a P1 conversation owned by another user does NOT leak into member B's
 *     project slice;
 *   - a NULL-userId conversation counts for the admin/unscoped project view but
 *     for NO user report and NO member slice (fail-closed);
 *   - jsonb usage stored as STRINGS ("123") coerces to 0 tokens (num() garbage
 *     rule) without NaN-poisoning the aggregate, yet the row stays cache-eligible
 *     because the key is present;
 *   - a served model unknown to pricing (zero-cost path) contributes $0 but its
 *     tokens/hit-rate still count;
 *   - a turn whose write premiums dominate yields NEGATIVE net cache savings;
 *   - hit-rate is null when a scope has rows but none are cache-eligible;
 *   - legacy rows (usage without any cache/routing fields) count in turnsTotal
 *     yet are excluded from hit-rate.
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

import { users, projects, conversations, messages } from "../db/schema";
import {
  getSavingsForUser,
  getSavingsForProject,
  type SavingsPricingDeps,
  type SavingsReport,
} from "../db/queries/savings-analytics";
import type { ModelCostLike } from "../runtime/usage/savings";

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

// ── Fixed price sheets ($/1M tokens) — deterministic $ assertions ──────
// CF (counterfactual = balanced) also doubles as the served BAL sheet.
const CF: ModelCostLike = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const POW: ModelCostLike = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };
const FAST: ModelCostLike = { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 0.3125 };

// Cost keyed by MODEL id; "m-unknown" is intentionally absent ⇒ null (zero-cost).
const FIXED_COSTS: Record<string, ModelCostLike> = {
  "m-bal": CF,
  "m-pow": POW,
  "m-fast": FAST,
  "m-noreg-pow": POW,
};

const fixedDeps: SavingsPricingDeps = {
  getModelCost: (_provider, model) => FIXED_COSTS[model] ?? null,
  // "noreg" has no balanced counterfactual ⇒ null ⇒ routing contributes 0.
  getCounterfactualCost: (provider) => (provider === "noreg" ? null : CF),
  // Only "subprov" is subscription-billed in this world.
  isSubscriptionProvider: async (p) => p === "subprov",
};

// ── Principals / projects / conversations ──────────────────────────────
const ADMIN = "v2-admin";
const USER_B = "v2-b";
const USER_D = "v2-d"; // no-cache-eligible scope (hit-rate null)
const P1 = "v2-p1";
const P2 = "v2-p2";
const C_ADMIN_P1 = "v2-c-admin-p1";
const C_ADMIN_P2 = "v2-c-admin-p2"; // conversation CREATED old, holds a RECENT msg
const C_B_P1 = "v2-c-b-p1";
const C_B_P2 = "v2-c-b-p2";
const C_NULL_P1 = "v2-c-null-p1"; // userId NULL
const C_D_P2 = "v2-c-d-p2";

const NOW = Date.now();
const RECENT = new Date(NOW - 60 * 60 * 1000); // 1h ago (in every window ≥1d)
const MID = new Date(NOW - 2 * 24 * 60 * 60 * 1000); // 2d ago (out at days=1)
const OLD = new Date(NOW - 100 * 24 * 60 * 60 * 1000); // 100d ago (out at ≤365? in at 365)

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
    { id: ADMIN, email: "admin@v2.com", passwordHash: "x", name: "Admin", role: "admin" },
    { id: USER_B, email: "b@v2.com", passwordHash: "x", name: "B", role: "member" },
    { id: USER_D, email: "d@v2.com", passwordHash: "x", name: "D", role: "member" },
  ] as any);
  await db.insert(projects).values([
    { id: P1, name: "p1", path: "/tmp/v2p1" },
    { id: P2, name: "p2", path: "/tmp/v2p2" },
  ] as any);
  await db.insert(conversations).values([
    { id: C_ADMIN_P1, projectId: P1, title: "admin-p1", userId: ADMIN, createdAt: RECENT },
    // Conversation CREATED 100d ago but its message (M9) is RECENT — proves the
    // range filter keys on messages.createdAt, not conversations.createdAt.
    { id: C_ADMIN_P2, projectId: P2, title: "admin-p2", userId: ADMIN, createdAt: OLD },
    { id: C_B_P1, projectId: P1, title: "b-p1", userId: USER_B, createdAt: RECENT },
    { id: C_B_P2, projectId: P2, title: "b-p2", userId: USER_B, createdAt: RECENT },
    // Orphaned conversation (NULL owner) living inside P1.
    { id: C_NULL_P1, projectId: P1, title: "null-p1", userId: null, createdAt: RECENT },
    { id: C_D_P2, projectId: P2, title: "d-p2", userId: USER_D, createdAt: RECENT },
  ] as any);

  const rows = [
    // ═══ C_ADMIN_P1 (admin, P1) ═══════════════════════════════════════
    // M1 — PINNED anthropic turn, full cache incl. 1h. read=2000, long=300,
    //   short=800-300=500. readSaved=2000*(3-.3)=5400µ; write5m=500*(3.75-3)=375µ;
    //   write1h=300*3=900µ; net=5400-375-900=4125µ. prompt=1000+2000+800=3800.
    msgRow("v2-m1", C_ADMIN_P1, {
      provider: "anthropic",
      model: "m-bal",
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 2000,
        cacheWriteTokens: 800,
        cacheWrite1hTokens: 300,
        requestedModel: "m-bal", // pinned ⇒ NOT routed
      },
    }),
    // M2 — routed POWERFUL (Auto). routing = servedCF - servedPOW.
    //   CF=(3*1000+15*200)=6000µ; POW=(15*1000+75*200)=30000µ; routing=-24000µ.
    msgRow("v2-m2", C_ADMIN_P1, {
      provider: "anthropic",
      model: "m-pow",
      usage: { inputTokens: 1000, outputTokens: 200, requestedModel: null, routedTier: "powerful" },
    }),
    // M2b — routed POWERFUL on a provider with NO balanced counterfactual ⇒
    //   getCounterfactualCost("noreg")=null ⇒ routing contributes 0.
    msgRow("v2-m2b", C_ADMIN_P1, {
      provider: "noreg",
      model: "m-noreg-pow",
      usage: { inputTokens: 1000, outputTokens: 100, requestedModel: null, routedTier: "powerful" },
    }),
    // M3 — routed FAST on subscription provider, with FAILOVER. read=1000.
    //   readSaved=1000*(.25-.025)=225µ; net=225µ.
    //   CF=(3*2000+15*400+.3*1000)=12300µ; FAST=(.25*2000+1.25*400+.025*1000)=1025µ;
    //   routing=12300-1025=11275µ. prompt=2000+1000+0=3000.
    msgRow("v2-m3", C_ADMIN_P1, {
      provider: "subprov",
      model: "m-fast",
      usage: {
        inputTokens: 2000,
        outputTokens: 400,
        cacheReadTokens: 1000,
        cacheWriteTokens: 0,
        requestedModel: null,
        routedTier: "fast",
        failover: true,
      },
    }),
    // M4 — PINNED, write premiums DOMINATE ⇒ NEGATIVE net. read=100, all 4000
    //   writes are 1h (short=0). readSaved=100*2.7=270µ; write1h=4000*3=12000µ;
    //   net=270-12000=-11730µ. prompt=100+100+4000=4200.
    msgRow("v2-m4", C_ADMIN_P1, {
      provider: "anthropic",
      model: "m-bal",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 100,
        cacheWriteTokens: 4000,
        cacheWrite1hTokens: 4000,
        requestedModel: "m-bal", // pinned ⇒ NOT routed
      },
    }),
    // M5 — LEGACY (no cache/routing fields): counts in turnsTotal, NOT eligible.
    msgRow("v2-m5", C_ADMIN_P1, {
      provider: "anthropic",
      model: "m-bal",
      usage: { inputTokens: 5000, outputTokens: 1000 },
    }),
    // M6 — role=user with cache fields ⇒ EXCLUDED from everything.
    msgRow("v2-m6", C_ADMIN_P1, {
      role: "user",
      provider: "anthropic",
      model: "m-bal",
      usage: { inputTokens: 9999, cacheReadTokens: 9999 },
    }),
    // M7 — served model UNKNOWN to pricing (zero-cost path): $0 but read=500
    //   still counts to tokens + hit-rate. prompt=1000+500+200=1700.
    msgRow("v2-m7", C_ADMIN_P1, {
      provider: "anthropic",
      model: "m-unknown",
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 500,
        cacheWriteTokens: 200,
        requestedModel: "m-unknown",
      },
    }),
    // M8 — OLD (100d): excluded at days≤30, included at 365. read=1000.
    //   readSaved=1000*2.7=2700µ; net=2700µ. prompt=1000+1000=2000.
    msgRow("v2-m8", C_ADMIN_P1, {
      provider: "anthropic",
      model: "m-bal",
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0 },
      createdAt: OLD,
    }),
    // M12 — MID (2d), LEGACY: excluded at days=1, included at days≥30. $0, +1 turn.
    msgRow("v2-m12", C_ADMIN_P1, {
      provider: "anthropic",
      model: "m-bal",
      usage: { inputTokens: 100, outputTokens: 10 },
      createdAt: MID,
    }),

    // ═══ C_ADMIN_P2 (admin, P2 — conv created OLD, msg RECENT) ═════════
    // M9 — RECENT msg in an OLD-created conversation ⇒ counts at days=30
    //   (proves message-based range). read=1000; net=2700µ; prompt=100+1000=1100.
    msgRow("v2-m9", C_ADMIN_P2, {
      provider: "anthropic",
      model: "m-bal",
      usage: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 0 },
    }),

    // ═══ C_B_P1 (member B, P1) ════════════════════════════════════════
    // M10 — read=500 of 500 prompt ⇒ net=500*2.7=1350µ; hit-rate 1.0.
    msgRow("v2-m10", C_B_P1, {
      provider: "anthropic",
      model: "m-bal",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 500, cacheWriteTokens: 0 },
    }),
    // M11 — jsonb usage as STRINGS ⇒ num() coerces to 0 tokens (no NaN), yet
    //   the cacheReadTokens KEY is present ⇒ still cache-eligible (0/0).
    msgRow("v2-m11", C_B_P1, {
      provider: "anthropic",
      model: "m-bal",
      usage: { inputTokens: "123", outputTokens: "45", cacheReadTokens: "678" },
    }),

    // ═══ C_B_P2 (member B, P2) ════════════════════════════════════════
    // M14 — read=200 of 300 prompt ⇒ net=200*2.7=540µ. Makes B's USER report
    //   (spans P1+P2) differ from B's P1-project slice.
    msgRow("v2-m14", C_B_P2, {
      provider: "anthropic",
      model: "m-bal",
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 200, cacheWriteTokens: 0 },
    }),

    // ═══ C_NULL_P1 (NULL owner, P1) ═══════════════════════════════════
    // M13 — read=300 of 400 prompt ⇒ net=300*2.7=810µ. Only the unscoped/admin
    //   project view may see this; no user report, no member slice.
    msgRow("v2-m13", C_NULL_P1, {
      provider: "anthropic",
      model: "m-bal",
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 300, cacheWriteTokens: 0 },
    }),

    // ═══ C_D_P2 (member D, P2) — a scope with NO cache-eligible rows ═══
    // M15 — LEGACY (turnsTotal only). M16 — routed powerful, no cache fields.
    //   M16 routing: CF=(3*500+15*50)=2250µ; POW=(15*500+75*50)=11250µ; = -9000µ.
    msgRow("v2-m15", C_D_P2, {
      provider: "anthropic",
      model: "m-bal",
      usage: { inputTokens: 1000, outputTokens: 100 },
    }),
    msgRow("v2-m16", C_D_P2, {
      provider: "anthropic",
      model: "m-pow",
      usage: { inputTokens: 500, outputTokens: 50, requestedModel: null, routedTier: "powerful" },
    }),
  ];
  await db.insert(messages).values(rows as any);
}, 30_000);

// ── Deep-equality helper (float-tolerant) ──────────────────────────────
interface ExpModel {
  provider: string;
  model: string;
  turns: number;
  cacheSavedUsd: number;
  routingSavedUsd: number;
  tokensCachedRead: number;
  cacheHitRate: number | null;
  estimated: boolean;
}
interface ExpReport {
  rangeDays: number;
  stats: {
    cacheSavedUsd: number;
    cacheReadSavedUsd: number;
    cacheWriteSurchargeUsd: number;
    write1hPremiumUsd: number;
    routingSavedUsd: number;
    tokensCachedRead: number;
    tokensCacheWritten: number;
    cacheHitRate: number | null;
    turnsTotal: number;
    turnsRouted: number;
    turnsFailover: number;
  };
  perModel: ExpModel[];
  subscriptionProviders: string[];
}

function closeOrNull(actual: number | null, expected: number | null) {
  if (expected === null) {
    expect(actual).toBeNull();
  } else {
    expect(actual).not.toBeNull();
    expect(Number.isFinite(actual as number)).toBe(true);
    expect(actual as number).toBeCloseTo(expected, 12);
  }
}

const KEY = (m: { provider: string; model: string }) => `${m.provider}/${m.model}`;

function assertReport(actual: SavingsReport, e: ExpReport) {
  expect(actual.estimated).toBe(true);
  expect(actual.rangeDays).toBe(e.rangeDays);

  // Exact contract key-set (no extra / missing keys).
  expect(Object.keys(actual).sort()).toEqual(
    ["estimated", "perModel", "rangeDays", "stats", "subscriptionProviders"].sort(),
  );
  expect(Object.keys(actual.stats).sort()).toEqual(
    [
      "cacheSavedUsd",
      "cacheReadSavedUsd",
      "cacheWriteSurchargeUsd",
      "write1hPremiumUsd",
      "routingSavedUsd",
      "tokensCachedRead",
      "tokensCacheWritten",
      "cacheHitRate",
      "turnsTotal",
      "turnsRouted",
      "turnsFailover",
    ].sort(),
  );

  const s = actual.stats;
  expect(s.turnsTotal).toBe(e.stats.turnsTotal);
  expect(s.turnsRouted).toBe(e.stats.turnsRouted);
  expect(s.turnsFailover).toBe(e.stats.turnsFailover);
  expect(s.tokensCachedRead).toBe(e.stats.tokensCachedRead);
  expect(s.tokensCacheWritten).toBe(e.stats.tokensCacheWritten);
  for (const k of [
    "cacheSavedUsd",
    "cacheReadSavedUsd",
    "cacheWriteSurchargeUsd",
    "write1hPremiumUsd",
    "routingSavedUsd",
  ] as const) {
    expect(Number.isFinite(s[k])).toBe(true);
    expect(s[k]).toBeCloseTo(e.stats[k], 12);
  }
  closeOrNull(s.cacheHitRate, e.stats.cacheHitRate);

  expect(actual.subscriptionProviders).toEqual(e.subscriptionProviders);

  // perModel — order is not guaranteed (no ORDER BY); compare key-sorted.
  const a = [...actual.perModel].sort((x, y) => KEY(x).localeCompare(KEY(y)));
  const ex = [...e.perModel].sort((x, y) => KEY(x).localeCompare(KEY(y)));
  expect(a.map(KEY)).toEqual(ex.map(KEY));
  for (let i = 0; i < ex.length; i++) {
    const am = a[i]!;
    const em = ex[i]!;
    expect(Object.keys(am).sort()).toEqual(
      [
        "provider",
        "model",
        "turns",
        "cacheSavedUsd",
        "routingSavedUsd",
        "tokensCachedRead",
        "cacheHitRate",
        "estimated",
      ].sort(),
    );
    expect(am.turns).toBe(em.turns);
    expect(am.tokensCachedRead).toBe(em.tokensCachedRead);
    expect(am.estimated).toBe(em.estimated);
    expect(am.cacheSavedUsd).toBeCloseTo(em.cacheSavedUsd, 12);
    expect(am.routingSavedUsd).toBeCloseTo(em.routingSavedUsd, 12);
    closeOrNull(am.cacheHitRate, em.cacheHitRate);
  }
}

const U = 1e6; // micro-dollar → dollar

// Shared per-model rows that recur across scopes.
const M_POW: ExpModel = {
  provider: "anthropic", model: "m-pow", turns: 1,
  cacheSavedUsd: 0, routingSavedUsd: -24000 / U, tokensCachedRead: 0, cacheHitRate: null, estimated: true,
};
const M_UNKNOWN: ExpModel = {
  provider: "anthropic", model: "m-unknown", turns: 1,
  cacheSavedUsd: 0, routingSavedUsd: 0, tokensCachedRead: 500, cacheHitRate: 500 / 1700, estimated: true,
};
const M_NOREG: ExpModel = {
  provider: "noreg", model: "m-noreg-pow", turns: 1,
  cacheSavedUsd: 0, routingSavedUsd: 0, tokensCachedRead: 0, cacheHitRate: null, estimated: true,
};
const M_FAST: ExpModel = {
  provider: "subprov", model: "m-fast", turns: 1,
  cacheSavedUsd: 225 / U, routingSavedUsd: 11275 / U, tokensCachedRead: 1000, cacheHitRate: 1000 / 3000, estimated: true,
};

// ══════════════════════════ getSavingsForUser ══════════════════════════
describe("getSavingsForUser — admin (spans P1 + P2), fixed prices", () => {
  // Rows at days=30: M1,M2,M2b,M3,M4,M5,M7,M12 (C_ADMIN_P1) + M9 (C_ADMIN_P2).
  // M6 (user role) and M8 (old) excluded.
  const EXP_30: ExpReport = {
    rangeDays: 30,
    stats: {
      cacheSavedUsd: -4680 / U, //  4125 +225 -11730 +2700
      cacheReadSavedUsd: 8595 / U, // 5400 +225 +270 +2700
      cacheWriteSurchargeUsd: 13275 / U, // (375+900) + 12000
      write1hPremiumUsd: 12900 / U, // 900 + 12000
      routingSavedUsd: -12725 / U, // -24000 + 11275 + 0
      tokensCachedRead: 4600, // 2000+1000+100+500+1000
      tokensCacheWritten: 5000, // 800+4000+200
      cacheHitRate: 4600 / 13800, // Σread / Σprompt over eligible (M1,M3,M4,M7,M9)
      turnsTotal: 9,
      turnsRouted: 3,
      turnsFailover: 1,
    },
    perModel: [
      {
        provider: "anthropic", model: "m-bal", turns: 5, // M1,M4,M5,M9,M12
        cacheSavedUsd: -4905 / U, // 4125 -11730 +2700
        routingSavedUsd: 0, tokensCachedRead: 3100, // 2000+100+1000
        cacheHitRate: 3100 / 9100, estimated: false, // elig M1,M4,M9
      },
      M_POW, M_UNKNOWN, M_NOREG, M_FAST,
    ],
    subscriptionProviders: ["subprov"],
  };

  test("days=30 (default): full response equals the hand-computed DB implication", async () => {
    assertReport(await getSavingsForUser(ADMIN, 30, fixedDeps), EXP_30);
  });

  test("days omitted defaults to 30", async () => {
    assertReport(await getSavingsForUser(ADMIN, undefined, fixedDeps), EXP_30);
  });

  test("days=1 drops the 2-day-old legacy row (range boundary), else identical", async () => {
    const EXP_1: ExpReport = {
      ...EXP_30,
      rangeDays: 1,
      stats: { ...EXP_30.stats, turnsTotal: 8 }, // M12 gone; $ + tokens unchanged
      perModel: [
        { ...EXP_30.perModel[0]!, turns: 4 }, // m-bal loses M12
        M_POW, M_UNKNOWN, M_NOREG, M_FAST,
      ],
    };
    assertReport(await getSavingsForUser(ADMIN, 1, fixedDeps), EXP_1);
  });

  test("days=365 pulls in the 100-day-old cache row (M8) and re-derives hit-rate", async () => {
    const EXP_365: ExpReport = {
      rangeDays: 365,
      stats: {
        cacheSavedUsd: -1980 / U, // -4680 + 2700
        cacheReadSavedUsd: 11295 / U, // 8595 + 2700
        cacheWriteSurchargeUsd: 13275 / U,
        write1hPremiumUsd: 12900 / U,
        routingSavedUsd: -12725 / U,
        tokensCachedRead: 5600, // + 1000
        tokensCacheWritten: 5000,
        cacheHitRate: 5600 / 15800, // + M8 (1000/2000)
        turnsTotal: 10,
        turnsRouted: 3,
        turnsFailover: 1,
      },
      perModel: [
        {
          provider: "anthropic", model: "m-bal", turns: 6, // + M8
          cacheSavedUsd: -2205 / U, // -4905 + 2700
          routingSavedUsd: 0, tokensCachedRead: 4100, // + 1000
          cacheHitRate: 4100 / 11100, estimated: false,
        },
        M_POW, M_UNKNOWN, M_NOREG, M_FAST,
      ],
      subscriptionProviders: ["subprov"],
    };
    assertReport(await getSavingsForUser(ADMIN, 365, fixedDeps), EXP_365);
  });

  test("RANGE keys on messages.createdAt: RECENT msg in an OLD-created conv (M9) IS counted", async () => {
    // M9 lives in C_ADMIN_P2 (conversation created 100d ago) but is a RECENT
    // message. Its 1000 cached-read tokens appear at days=30 ⇒ the filter is on
    // the MESSAGE timestamp, not the conversation's.
    const r = await getSavingsForUser(ADMIN, 30, fixedDeps);
    expect(r.stats.tokensCachedRead).toBe(4600); // includes M9's 1000
    // And the OLD message M8 (in a RECENT conv) is excluded at 30, present at 365.
    const r365 = await getSavingsForUser(ADMIN, 365, fixedDeps);
    expect(r365.stats.tokensCachedRead).toBe(5600);
  });
});

describe("getSavingsForUser — member B (spans P1 + P2) and user D (no cache-eligible rows)", () => {
  test("member B: user report spans both projects; string usage coerces to 0 (no NaN)", async () => {
    const EXP_B: ExpReport = {
      rangeDays: 30,
      stats: {
        cacheSavedUsd: 1890 / U, // M10 1350 + M11 0 + M14 540
        cacheReadSavedUsd: 1890 / U,
        cacheWriteSurchargeUsd: 0,
        write1hPremiumUsd: 0,
        routingSavedUsd: 0,
        tokensCachedRead: 700, // 500 + 0(strings) + 200
        tokensCacheWritten: 0,
        cacheHitRate: 700 / 800, // elig M10(500/500)+M11(0/0)+M14(200/300)
        turnsTotal: 3, // M11 (strings) still counts
        turnsRouted: 0,
        turnsFailover: 0,
      },
      perModel: [
        {
          provider: "anthropic", model: "m-bal", turns: 3,
          cacheSavedUsd: 1890 / U, routingSavedUsd: 0, tokensCachedRead: 700,
          cacheHitRate: 700 / 800, estimated: false,
        },
      ],
      subscriptionProviders: [],
    };
    assertReport(await getSavingsForUser(USER_B, 30, fixedDeps), EXP_B);
  });

  test("user D: legacy + no-cache routed rows ⇒ hit-rate NULL, but turnsTotal still counts them", async () => {
    const EXP_D: ExpReport = {
      rangeDays: 30,
      stats: {
        cacheSavedUsd: 0,
        cacheReadSavedUsd: 0,
        cacheWriteSurchargeUsd: 0,
        write1hPremiumUsd: 0,
        routingSavedUsd: -9000 / U, // M16 routed powerful
        tokensCachedRead: 0,
        tokensCacheWritten: 0,
        cacheHitRate: null, // NO cache-eligible rows in scope
        turnsTotal: 2, // legacy M15 + routed M16 both count
        turnsRouted: 1,
        turnsFailover: 0,
      },
      perModel: [
        {
          provider: "anthropic", model: "m-bal", turns: 1,
          cacheSavedUsd: 0, routingSavedUsd: 0, tokensCachedRead: 0,
          cacheHitRate: null, estimated: false,
        },
        {
          provider: "anthropic", model: "m-pow", turns: 1,
          cacheSavedUsd: 0, routingSavedUsd: -9000 / U, tokensCachedRead: 0,
          cacheHitRate: null, estimated: true,
        },
      ],
      subscriptionProviders: [],
    };
    assertReport(await getSavingsForUser(USER_D, 30, fixedDeps), EXP_D);
  });

  test("NULL-userId conversation counts for NO user report", async () => {
    // C_NULL_P1's M13 (300 cached-read tokens) must not surface in any user's
    // report — SQL `user_id = $x` is never true for NULL.
    for (const uid of [ADMIN, USER_B, USER_D]) {
      const r = await getSavingsForUser(uid, 30, fixedDeps);
      // 300 is M13's unique read count; assert it never inflates a user total.
      expect(r.stats.tokensCachedRead).not.toBe(300);
    }
  });
});

// ═══════════════════════ getSavingsForProject ══════════════════════════
describe("getSavingsForProject — P1 admin/unscoped vs member-scoped", () => {
  test("unscoped (admin): whole project incl. the NULL-owner conversation; P2 excluded", async () => {
    // Rows: C_ADMIN_P1 in-range (M1,M2,M2b,M3,M4,M5,M7,M12) + C_B_P1 (M10,M11)
    // + C_NULL_P1 (M13). M9 (P2) excluded; M8 (old) excluded.
    const EXP: ExpReport = {
      rangeDays: 30,
      stats: {
        cacheSavedUsd: -5220 / U, // (4125+225-11730) + 1350 + 810
        cacheReadSavedUsd: 8055 / U, // 5400+225+270 + 1350 + 810
        cacheWriteSurchargeUsd: 13275 / U,
        write1hPremiumUsd: 12900 / U,
        routingSavedUsd: -12725 / U,
        tokensCachedRead: 4400, // 2000+1000+100+500 + 500 + 300
        tokensCacheWritten: 5000,
        cacheHitRate: 4400 / 13600, // elig M1,M3,M4,M7,M10,M11,M13
        turnsTotal: 11,
        turnsRouted: 3,
        turnsFailover: 1,
      },
      perModel: [
        {
          provider: "anthropic", model: "m-bal", turns: 7, // M1,M4,M5,M12,M10,M11,M13
          cacheSavedUsd: -5445 / U, // 4125 -11730 +1350 +810
          routingSavedUsd: 0, tokensCachedRead: 2900, // 2000+100+500+300
          cacheHitRate: 2900 / 8900, estimated: false,
        },
        M_POW, M_UNKNOWN, M_NOREG, M_FAST,
      ],
      subscriptionProviders: ["subprov"],
    };
    assertReport(await getSavingsForProject(P1, 30, undefined, fixedDeps), EXP);
  });

  test("scoped to admin: NULL-owner (M13) and member B's rows are EXCLUDED", async () => {
    // scopeToUserId=ADMIN ⇒ only C_ADMIN_P1. Proves NULL-userId conv does not
    // count in a user-scoped project slice (fail-closed).
    const EXP: ExpReport = {
      rangeDays: 30,
      stats: {
        cacheSavedUsd: -7380 / U, // 4125 +225 -11730
        cacheReadSavedUsd: 5895 / U, // 5400 +225 +270
        cacheWriteSurchargeUsd: 13275 / U,
        write1hPremiumUsd: 12900 / U,
        routingSavedUsd: -12725 / U,
        tokensCachedRead: 3600, // 2000+1000+100+500 (no M13/M10)
        tokensCacheWritten: 5000,
        cacheHitRate: 3600 / 12700,
        turnsTotal: 8,
        turnsRouted: 3,
        turnsFailover: 1,
      },
      perModel: [
        {
          provider: "anthropic", model: "m-bal", turns: 4, // M1,M4,M5,M12
          cacheSavedUsd: -7605 / U, // 4125 -11730
          routingSavedUsd: 0, tokensCachedRead: 2100, // 2000+100
          cacheHitRate: 2100 / 8000, estimated: false,
        },
        M_POW, M_UNKNOWN, M_NOREG, M_FAST,
      ],
      subscriptionProviders: ["subprov"],
    };
    assertReport(await getSavingsForProject(P1, 30, ADMIN, fixedDeps), EXP);
  });

  test("scoped to member B: only B's OWN P1 conversation — no foreign/NULL leak", async () => {
    // C_B_P1 only (M10,M11). Admin's 8 rows and the NULL-owner row do NOT leak.
    const EXP_B_P1: ExpReport = {
      rangeDays: 30,
      stats: {
        cacheSavedUsd: 1350 / U,
        cacheReadSavedUsd: 1350 / U,
        cacheWriteSurchargeUsd: 0,
        write1hPremiumUsd: 0,
        routingSavedUsd: 0,
        tokensCachedRead: 500,
        tokensCacheWritten: 0,
        cacheHitRate: 1, // 500/500 (M11 contributes 0/0)
        turnsTotal: 2,
        turnsRouted: 0,
        turnsFailover: 0,
      },
      perModel: [
        {
          provider: "anthropic", model: "m-bal", turns: 2,
          cacheSavedUsd: 1350 / U, routingSavedUsd: 0, tokensCachedRead: 500,
          cacheHitRate: 1, estimated: false,
        },
      ],
      subscriptionProviders: [],
    };
    assertReport(await getSavingsForProject(P1, 30, USER_B, fixedDeps), EXP_B_P1);
  });

  test("NULL-owner accounting: unscoped(4400) = adminSlice(3600) + Bslice(500) + null(300)", async () => {
    const unscoped = await getSavingsForProject(P1, 30, undefined, fixedDeps);
    const adminSlice = await getSavingsForProject(P1, 30, ADMIN, fixedDeps);
    const bSlice = await getSavingsForProject(P1, 30, USER_B, fixedDeps);
    expect(unscoped.stats.tokensCachedRead).toBe(4400);
    expect(adminSlice.stats.tokensCachedRead).toBe(3600);
    expect(bSlice.stats.tokensCachedRead).toBe(500);
    // The 300-token remainder is exactly the orphaned (NULL-owner) conversation,
    // visible ONLY in the unscoped/admin project view.
    expect(
      unscoped.stats.tokensCachedRead -
        adminSlice.stats.tokensCachedRead -
        bSlice.stats.tokensCachedRead,
    ).toBe(300);
  });

  test("member B's project-P1 slice ⊊ B's cross-project user report (scoping narrows)", async () => {
    const slice = await getSavingsForProject(P1, 30, USER_B, fixedDeps);
    const userReport = await getSavingsForUser(USER_B, 30, fixedDeps);
    expect(slice.stats.tokensCachedRead).toBe(500); // P1 only
    expect(userReport.stats.tokensCachedRead).toBe(700); // P1 + P2
    expect(slice.stats.turnsTotal).toBeLessThan(userReport.stats.turnsTotal);
  });

  test("unknown project ⇒ empty, all-zero report (no throw)", async () => {
    const r = await getSavingsForProject("no-such-project-v2", 30, undefined, fixedDeps);
    expect(r.stats.turnsTotal).toBe(0);
    expect(r.stats.cacheHitRate).toBeNull();
    expect(r.perModel).toEqual([]);
    expect(r.subscriptionProviders).toEqual([]);
    expect(r.estimated).toBe(true);
  });
});
