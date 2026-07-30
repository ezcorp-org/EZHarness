/**
 * `getRoutingStats` against a REAL PGlite — the SQL is the thing under test.
 *
 * A chainable DB stub (the style the older analytics.test.ts uses) can only
 * prove the row→object mapping; it cannot prove `jsonb_exists` separates a
 * routed turn from a legacy one, that `LAG` partitions per conversation, or
 * that the window filter holds. So this suite seeds one fixture graph and
 * asserts every reported number against it.
 *
 * The fixture deliberately contains, in ONE conversation: pinned turns, routed
 * turns, three kinds of mid-conversation switch (escalation / downgrade /
 * lateral), an A/B retry sibling trio with a continued-through branch, a
 * failover turn, an UNPRICED (subscription) model, and two shapes of legacy
 * row — usage jsonb with NO provenance keys, and no usage at all. A second
 * conversation (interleaved in time) proves the per-conversation partitioning,
 * and one 60-day-old row proves the window filter.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { users, projects, conversations, messages } from "../db/schema";
import { modelPrices } from "../providers/registry";
import { getRoutingStats, type RoutingSpendSegment } from "../db/queries/analytics";

const USER_ID = "u-routing";
const PROJECT_ID = "p-routing";
const CONV_A = "conv-a-routing";
const CONV_B = "conv-b-routing";

// One minute apart, an hour ago — comfortably inside every window under test
// and deterministic to order by.
const BASE = Date.now() - 60 * 60 * 1000;
const at = (minutes: number) => new Date(BASE + minutes * 60_000);
const OUT_OF_WINDOW = new Date(BASE - 60 * 24 * 60 * 60 * 1000);

/** A million input tokens prices to exactly the model's per-1M input rate, so
 *  every expected dollar figure below is a rate, not an arithmetic puzzle. */
const ONE_M = 1_000_000;

type SeedUsage = Record<string, unknown> | null;

const seeded: {
  id: string;
  conversationId: string;
  role: string;
  parentMessageId: string | null;
  model: string | null;
  provider: string | null;
  usage: SeedUsage;
  createdAt: Date;
}[] = [];

function seedMessage(row: {
  id: string;
  conversationId: string;
  role: string;
  parentMessageId?: string | null;
  model?: string | null;
  provider?: string | null;
  usage?: SeedUsage;
  createdAt: Date;
}) {
  seeded.push({
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    parentMessageId: row.parentMessageId ?? null,
    model: row.model ?? null,
    provider: row.provider ?? null,
    usage: row.usage ?? null,
    createdAt: row.createdAt,
  });
}

/** A turn the USER pinned: `requestedModel` present and a string. */
function pinned(model: string, provider: string, usage: Record<string, unknown> = {}) {
  return {
    inputTokens: ONE_M,
    outputTokens: 0,
    requestedModel: model,
    requestedProvider: provider,
    failover: false,
    ...usage,
  };
}

/** A turn the ROUTER chose: `requestedModel` present and JSON null. */
function routed(tier: string, usage: Record<string, unknown> = {}) {
  return {
    inputTokens: ONE_M,
    outputTokens: 0,
    requestedModel: null,
    requestedProvider: null,
    routedTier: tier,
    failover: false,
    ...usage,
  };
}

beforeAll(async () => {
  await setupTestDb();
  const db = getTestDb();

  await db.insert(users).values({
    id: USER_ID, email: "r@x.com", passwordHash: "x", name: "R", role: "admin",
  } as any);
  await db.insert(projects).values({ id: PROJECT_ID, name: "r", path: "/tmp/r" } as any);
  for (const id of [CONV_A, CONV_B]) {
    await db.insert(conversations).values({
      id, projectId: PROJECT_ID, userId: USER_ID,
      model: "claude-opus-4-5", provider: "anthropic",
    } as any);
  }

  // ── conv-a: every case, in one thread ──
  // Each assistant turn answers its own user turn, except the retry trio.
  for (let i = 1; i <= 11; i++) {
    seedMessage({
      id: `u${i}`, conversationId: CONV_A, role: "user",
      // u10 hangs off the a9b RETRY SIBLING — that is what makes a9b the
      // sibling the branch continued through.
      parentMessageId: i === 10 ? "a9b" : null,
      createdAt: at(i - 1),
    });
  }

  seedMessage({ id: "a1", conversationId: CONV_A, role: "assistant", parentMessageId: "u1",
    model: "claude-haiku-4-5", provider: "anthropic",
    usage: pinned("claude-haiku-4-5", "anthropic"), createdAt: at(0) });
  seedMessage({ id: "a2", conversationId: CONV_A, role: "assistant", parentMessageId: "u2",
    model: "claude-opus-4-5", provider: "anthropic",
    usage: pinned("claude-opus-4-5", "anthropic"), createdAt: at(1) });
  // conv-b's first turn lands BETWEEN two conv-a turns: if the switch query
  // ever loses `PARTITION BY conversation_id`, these interleavings break it.
  seedMessage({ id: "b1", conversationId: CONV_B, role: "assistant", parentMessageId: "ub1",
    model: "claude-opus-4-5", provider: "anthropic",
    usage: pinned("claude-opus-4-5", "anthropic"), createdAt: at(2) });
  seedMessage({ id: "a3", conversationId: CONV_A, role: "assistant", parentMessageId: "u3",
    model: "gemini-2.5-flash", provider: "google",
    usage: pinned("gemini-2.5-flash", "google"), createdAt: at(3) });
  seedMessage({ id: "a4", conversationId: CONV_A, role: "assistant", parentMessageId: "u4",
    model: "claude-haiku-4-5", provider: "anthropic",
    usage: pinned("claude-haiku-4-5", "anthropic"), createdAt: at(4) });
  seedMessage({ id: "a5", conversationId: CONV_A, role: "assistant", parentMessageId: "u5",
    model: "claude-haiku-4-5", provider: "anthropic",
    usage: routed("fast"), createdAt: at(5) });
  // The failover turn, and the only turn with output + cache tokens (so the
  // 1h-write premium is exercised end to end).
  seedMessage({ id: "a6", conversationId: CONV_A, role: "assistant", parentMessageId: "u6",
    model: "claude-opus-4-5", provider: "anthropic",
    usage: routed("powerful", {
      outputTokens: ONE_M,
      cacheReadTokens: ONE_M,
      cacheWriteTokens: ONE_M,
      cacheWrite1hTokens: 400_000,
      failover: true,
    }), createdAt: at(6) });
  // LEGACY shape 1: usage jsonb with tokens but NO provenance key at all.
  seedMessage({ id: "a7", conversationId: CONV_A, role: "assistant", parentMessageId: "u7",
    model: "claude-sonnet-4-5", provider: "anthropic",
    usage: { inputTokens: ONE_M, outputTokens: 0 }, createdAt: at(7) });
  // LEGACY shape 2: no usage jsonb at all.
  seedMessage({ id: "a8", conversationId: CONV_A, role: "assistant", parentMessageId: "u8",
    model: "claude-sonnet-4-5", provider: "anthropic",
    usage: null, createdAt: at(8) });
  // A/B retry: three assistant siblings under one user turn.
  seedMessage({ id: "a9a", conversationId: CONV_A, role: "assistant", parentMessageId: "u9",
    model: "claude-sonnet-4-5", provider: "anthropic",
    usage: pinned("claude-sonnet-4-5", "anthropic"), createdAt: at(9) });
  seedMessage({ id: "a9b", conversationId: CONV_A, role: "assistant", parentMessageId: "u9",
    model: "claude-sonnet-4-5", provider: "anthropic",
    usage: pinned("claude-sonnet-4-5", "anthropic"), createdAt: at(10) });
  seedMessage({ id: "b2", conversationId: CONV_B, role: "assistant", parentMessageId: "ub2",
    model: "claude-haiku-4-5", provider: "anthropic",
    usage: pinned("claude-haiku-4-5", "anthropic"), createdAt: at(11) });
  seedMessage({ id: "a9c", conversationId: CONV_A, role: "assistant", parentMessageId: "u9",
    model: "claude-sonnet-4-5", provider: "anthropic",
    usage: pinned("claude-sonnet-4-5", "anthropic"), createdAt: at(12) });
  // UNPRICED: a token-plan (subscription) provider — every rate is 0, exactly
  // the shape an OAuth subscription login produces. Dollars are meaningless
  // here; tokens are the only honest unit.
  seedMessage({ id: "a10", conversationId: CONV_A, role: "assistant", parentMessageId: "u10",
    model: "deepseek-v3.2", provider: "qwen-token-plan",
    usage: routed("balanced"), createdAt: at(13) });
  // A routed turn stamped with a tier OUTSIDE the current vocabulary (what a
  // renamed tier would look like in an old row) and no served model.
  seedMessage({ id: "a11", conversationId: CONV_A, role: "assistant", parentMessageId: "u11",
    usage: routed("turbo", { inputTokens: 0 }), createdAt: at(14) });

  // ── conv-b users + a row OUTSIDE the window ──
  seedMessage({ id: "ub1", conversationId: CONV_B, role: "user", createdAt: at(2) });
  seedMessage({ id: "ub2", conversationId: CONV_B, role: "user", createdAt: at(11) });
  seedMessage({ id: "ub0", conversationId: CONV_B, role: "user", createdAt: OUT_OF_WINDOW });
  seedMessage({ id: "b0", conversationId: CONV_B, role: "assistant", parentMessageId: "ub0",
    model: "claude-opus-4-5", provider: "anthropic",
    usage: pinned("claude-opus-4-5", "anthropic"), createdAt: OUT_OF_WINDOW });

  // `messages.parent_message_id` carries a real FK (added by migration, not
  // visible on the Drizzle column), so rows must land parent-before-child.
  // The fixture is authored in TIME order for readability, which is not the
  // same order — insert by repeatedly taking whatever is now satisfiable.
  const pending = [...seeded];
  const inserted = new Set<string>();
  while (pending.length > 0) {
    const next = pending.findIndex(
      (r) => r.parentMessageId === null || inserted.has(r.parentMessageId),
    );
    if (next === -1) throw new Error("fixture has an unresolvable parentMessageId cycle");
    const [row] = pending.splice(next, 1);
    await db.insert(messages).values({ ...row, content: row!.id } as any);
    inserted.add(row!.id);
  }
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

/** Look a spend segment up by its grouping key (SQL orders ties arbitrarily). */
function segment(
  segments: RoutingSpendSegment[],
  provider: string,
  model: string,
  provenance: string,
): RoutingSpendSegment {
  const found = segments.find(
    (s) => s.provider === provider && s.model === model && s.provenance === provenance,
  );
  if (!found) throw new Error(`no segment for ${provider}/${model}/${provenance}`);
  return found;
}

describe("getRoutingStats — fixture preconditions", () => {
  // The expected dollar figures below are pi-ai's per-1M rates. Asserting them
  // here means a pi-ai catalog change fails as a stated fixture assumption
  // rather than masquerading as a bug in the cost math.
  test("pi-ai still prices the fixture's models at the assumed rates", () => {
    expect(modelPrices("anthropic", "claude-haiku-4-5")).toEqual({
      input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25,
    });
    expect(modelPrices("anthropic", "claude-sonnet-4-5")).toEqual({
      input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75,
    });
    expect(modelPrices("anthropic", "claude-opus-4-5")).toEqual({
      input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25,
    });
    expect(modelPrices("google", "gemini-2.5-flash").input).toBe(0.3);
  });

  test("the subscription model really is UNPRICED (every rate 0)", () => {
    const p = modelPrices("qwen-token-plan", "deepseek-v3.2");
    expect(p.input).toBe(0);
    expect(p.output).toBe(0);
    expect(p.cacheRead).toBe(0);
    expect(p.cacheWrite).toBe(0);
  });
});

describe("getRoutingStats — routed share and provenance", () => {
  test("splits provenance three ways; legacy rows are neither routed nor pinned", async () => {
    const s = await getRoutingStats(30);
    expect(s.days).toBe(30);
    // 15 assistant turns in the window; the 60-day-old row is excluded.
    expect(s.turns.total).toBe(15);
    expect(s.turns.routed).toBe(4);   // a5, a6, a10, a11
    expect(s.turns.pinned).toBe(9);   // a1-a4, a9a-a9c, b1, b2
    expect(s.turns.legacy).toBe(2);   // a7 (no provenance key), a8 (no usage)
    expect(s.turns.routed + s.turns.pinned + s.turns.legacy).toBe(s.turns.total);
  });

  test("routedShare divides by provenance-carrying turns only", async () => {
    const s = await getRoutingStats(30);
    // 4 routed / 13 with provenance — NOT 4/15, and emphatically not the
    // 6/15 a naive `requestedModel IS NULL` would report by folding the two
    // legacy rows in with the routed ones.
    expect(s.routedShare).toBeCloseTo(4 / 13, 10);
    expect(s.routedShare).not.toBeCloseTo(6 / 15, 5);
  });

  test("tier mix covers routed turns and DROPS an unknown tier", async () => {
    const s = await getRoutingStats(30);
    const mix = Object.fromEntries(s.tierMix.map((t) => [t.tier, t.count]));
    expect(mix).toEqual({ fast: 1, powerful: 1, balanced: 1 });
    // a11 stamped "turbo": counted as a routed turn, absent from the mix.
    expect(s.tierMix).toHaveLength(3);
  });

  test("failover rate is over provenance-carrying turns", async () => {
    const s = await getRoutingStats(30);
    expect(s.failover.count).toBe(1);
    expect(s.failover.rate).toBeCloseTo(1 / 13, 10);
  });
});

describe("getRoutingStats — mid-conversation switches", () => {
  test("counts only adjacent pin→pin pairs, per conversation", async () => {
    const s = await getRoutingStats(30);
    // conv-a: (a1,a2) (a2,a3) (a3,a4) (a9a,a9b) (a9b,a9c) = 5
    // conv-b: (b1,b2) = 1.  A cross-conversation pair would push this higher.
    expect(s.switches.pairs).toBe(6);
    expect(s.switches.total).toBe(4);
    expect(s.switches.rate).toBeCloseTo(4 / 6, 10);
  });

  test("classifies escalation, downgrade and lateral via the tier ladder", async () => {
    const s = await getRoutingStats(30);
    expect(s.switches.escalations).toBe(1);
    expect(s.switches.downgrades).toBe(2);
    expect(s.switches.lateral).toBe(1);
  });

  test("each sample carries the turn index the switch took effect on", async () => {
    const s = await getRoutingStats(30);
    expect(s.switches.samples).toHaveLength(4);

    const [first, second, third, fourth] = s.switches.samples;
    // haiku (fast) → opus (powerful) on conv-a's 2nd assistant turn.
    expect(first).toMatchObject({
      conversationId: CONV_A, turnIndex: 2,
      fromModel: "claude-haiku-4-5", fromTier: "fast",
      toModel: "claude-opus-4-5", toTier: "powerful",
      kind: "escalation",
    });
    // opus (powerful) → gemini flash (fast): a downgrade, and the requested
    // PROVIDER changes with it.
    expect(second).toMatchObject({
      conversationId: CONV_A, turnIndex: 3,
      fromProvider: "anthropic", fromModel: "claude-opus-4-5",
      toProvider: "google", toModel: "gemini-2.5-flash",
      kind: "downgrade",
    });
    // Two different fast-tier models: a lateral move, not an escalation.
    expect(third).toMatchObject({
      conversationId: CONV_A, turnIndex: 4,
      fromModel: "gemini-2.5-flash", fromTier: "fast",
      toModel: "claude-haiku-4-5", toTier: "fast",
      kind: "lateral",
    });
    // conv-b's own switch, indexed within conv-b (not globally).
    expect(fourth).toMatchObject({
      conversationId: CONV_B, turnIndex: 2, kind: "downgrade",
    });
  });
});

describe("getRoutingStats — A/B retries", () => {
  test("reports retried turns, extra siblings and the rate", async () => {
    const s = await getRoutingStats(30);
    expect(s.retries.answeredTurns).toBe(13); // u1-u11 + ub1 + ub2
    expect(s.retries.retriedTurns).toBe(1);   // only u9 got more than one answer
    expect(s.retries.extraSiblings).toBe(2);  // 3 siblings - 1 first answer
    expect(s.retries.rate).toBeCloseTo(1 / 13, 10);
  });

  test("identifies the sibling the branch continued through", async () => {
    const s = await getRoutingStats(30);
    expect(s.retries.samples).toEqual([
      {
        conversationId: CONV_A,
        parentMessageId: "u9",
        siblingCount: 3,
        // u10 hangs off a9b; a9a and a9c are dead branches.
        continuedThroughMessageId: "a9b",
      },
    ]);
  });
});

describe("getRoutingStats — priced spend", () => {
  test("segments by provider + model + provenance", async () => {
    const s = await getRoutingStats(30);
    // a8 (no usage) and a11 (no served model) carry no spend; b0 is out of window.
    expect(s.spend.segments).toHaveLength(8);

    // Pinned haiku spans BOTH conversations (a1, a4, b2) — spend groups by
    // model, not by thread.
    const haikuPinned = segment(s.spend.segments, "anthropic", "claude-haiku-4-5", "pinned");
    expect(haikuPinned.turnCount).toBe(3);
    expect(haikuPinned.tokens.input).toBe(3 * ONE_M);
    expect(haikuPinned.cost?.total).toBeCloseTo(3.0, 10);

    // The legacy row is priced but attributed to NEITHER routed nor pinned.
    const legacy = segment(s.spend.segments, "anthropic", "claude-sonnet-4-5", "legacy");
    expect(legacy.turnCount).toBe(1);
    expect(legacy.cost?.total).toBeCloseTo(3.0, 10);
  });

  test("prices output + cache reads + the 1h cache-write premium", async () => {
    const s = await getRoutingStats(30);
    const opusRouted = segment(s.spend.segments, "anthropic", "claude-opus-4-5", "routed");
    expect(opusRouted.turnCount).toBe(1);
    expect(opusRouted.tokens).toEqual({
      input: ONE_M, output: ONE_M, cacheRead: ONE_M,
      cacheWrite: ONE_M, cacheWrite1h: 400_000,
    });
    // 400k written at 1h retention bills at 2× the $5 input rate ($4.00); the
    // remaining 600k at the $6.25 5m-write rate ($3.75).
    expect(opusRouted.cost?.cacheWrite1h).toBeCloseTo(4.0, 10);
    expect(opusRouted.cost?.cacheWrite).toBeCloseTo(7.75, 10);
    // $5 input + $25 output + $0.50 cache read + $7.75 cache write.
    expect(opusRouted.cost?.total).toBeCloseTo(38.25, 10);
  });

  test("an UNPRICED model reports null cost and its tokens, never $0.00", async () => {
    const s = await getRoutingStats(30);
    const sub = segment(s.spend.segments, "qwen-token-plan", "deepseek-v3.2", "routed");
    expect(sub.cost).toBeNull();
    expect(sub.tokens.input).toBe(ONE_M);
    // Its turns/tokens are reported on their own axis and kept OUT of the
    // dollar totals, so a subscription turn neither inflates nor zero-dilutes
    // the spend figures.
    expect(s.spend.unpricedTurns).toBe(1);
    expect(s.spend.unpricedTokens).toBe(ONE_M);
  });

  test("splits routed vs pinned spend and costs per resolved conversation", async () => {
    const s = await getRoutingStats(30);
    expect(s.spend.routedUsd).toBeCloseTo(39.25, 10); // haiku $1 + opus $38.25
    expect(s.spend.pinnedUsd).toBeCloseTo(22.30, 10); // $3 + $10 + $0.30 + $9
    expect(s.spend.legacyUsd).toBeCloseTo(3.0, 10);
    expect(s.spend.totalUsd).toBeCloseTo(64.55, 10);
    // Per CONVERSATION, not per call: 15 turns landed across 2 conversations.
    expect(s.spend.conversations).toBe(2);
    expect(s.spend.usdPerConversation).toBeCloseTo(64.55 / 2, 10);
  });
});

describe("getRoutingStats — empty window and hostile input", () => {
  test("an empty window reports zeros and a NULL cost-per-conversation", async () => {
    // days=0 ⇒ `NOW() - INTERVAL '0 days'`, so every seeded row is older.
    const s = await getRoutingStats(0);
    expect(s.turns).toEqual({ total: 0, routed: 0, pinned: 0, legacy: 0 });
    expect(s.routedShare).toBe(0);
    expect(s.tierMix).toEqual([]);
    expect(s.failover).toEqual({ count: 0, rate: 0 });
    expect(s.switches.pairs).toBe(0);
    expect(s.switches.rate).toBe(0);
    expect(s.switches.samples).toEqual([]);
    expect(s.retries.answeredTurns).toBe(0);
    expect(s.retries.rate).toBe(0);
    expect(s.retries.samples).toEqual([]);
    expect(s.spend.segments).toEqual([]);
    expect(s.spend.totalUsd).toBe(0);
    // The honest answer to "what does a conversation cost?" with no data is
    // "unknown", not "$0.00".
    expect(s.spend.usdPerConversation).toBeNull();
  });

  test("non-finite days falls back to the default window instead of throwing", async () => {
    // `safeIntervalCount` rejects any non-finite value outright (Infinity is
    // NOT clamped to its 3650 ceiling), so both land on the 30-day default.
    const nan = await getRoutingStats(Number.NaN);
    expect(nan.turns.total).toBe(15);
    const inf = await getRoutingStats(Number.POSITIVE_INFINITY);
    expect(inf.turns.total).toBe(15);
  });

  test("a wide window pulls in the row the 30-day window excluded", async () => {
    // Proves the 15-vs-16 difference above is the WINDOW FILTER doing its job,
    // not a row that failed to seed.
    const s = await getRoutingStats(3650);
    expect(s.turns.total).toBe(16);
    expect(s.turns.pinned).toBe(10);
    expect(s.spend.conversations).toBe(2);
  });
});
