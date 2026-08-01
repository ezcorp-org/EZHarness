/**
 * The spend TOTALS must not be truncated by the display cap.
 *
 * `getRoutingStats` returns at most `ROUTING_SAMPLE_CAP` (50) spend segments so
 * the payload stays bounded. The dollar totals beside that table are summed in
 * JS from the same rows, so if the cap were applied in SQL — as a `LIMIT` on
 * the aggregate — every USD figure would silently omit whatever the query
 * dropped. `ORDER BY turn_count DESC` drops the lowest-VOLUME groups, and
 * volume does not track cost: a handful of opus turns outweighs thousands of
 * nano ones. The result would be a number the admin panel labels "total" that
 * isn't one.
 *
 * The sibling suite (`routing-analytics.test.ts`) seeds 8 spend segments, so it
 * can never exercise the cap. This one seeds 60 groups (20 priced models × 3
 * provenances) with the MOST EXPENSIVE model deliberately placed at the
 * LOWEST volume, so it falls outside the displayed 50 and its dollars can only
 * appear in `totalUsd` if the totals are aggregated uncapped.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { users, projects, conversations, messages } from "../db/schema";
import { modelPrices } from "../providers/registry";
import { getRoutingStats } from "../db/queries/analytics";

const USER_ID = "u-trunc";
const PROJECT_ID = "p-trunc";
const CONV = "conv-trunc";

/** Matches `ROUTING_SAMPLE_CAP` in src/db/queries/analytics.ts (not exported —
 *  asserting the literal is the point: a silent bump should fail here). */
const CAP = 50;

/** One million input tokens prices to exactly the per-1M input rate, so a
 *  group's cost is `turnCount × rate` with no arithmetic puzzle. */
const ONE_M = 1_000_000;

/**
 * Ordered CHEAPEST-ish first, most expensive LAST. Group volume decreases with
 * position (see `turnCountFor`), so the tail models are the low-volume,
 * high-price ones the cap would drop — exactly the case that breaks a
 * SQL-capped total.
 */
const MODELS: readonly (readonly [string, string])[] = [
  ["google", "gemini-2.0-flash-lite"],
  ["google", "gemini-2.0-flash"],
  ["openai", "gpt-4.1-nano"],
  ["google", "gemini-2.5-flash-lite"],
  ["openai", "gpt-4o-mini"],
  ["openai", "gpt-5-mini"],
  ["google", "gemini-2.5-flash"],
  ["openai", "gpt-4.1-mini"],
  ["anthropic", "claude-haiku-4-5"],
  ["openai", "gpt-5"],
  ["google", "gemini-2.5-pro"],
  ["openai", "o4-mini"],
  ["openai", "o3"],
  ["openai", "gpt-4.1"],
  ["openai", "gpt-4o"],
  ["anthropic", "claude-sonnet-4-5"],
  ["openai", "gpt-5.5"],
  ["anthropic", "claude-opus-4-5"],
  ["openai", "gpt-4-turbo"],
  ["anthropic", "claude-opus-4-1"], // $15/1M in — the priciest, and the rarest
] as const;

const PROVENANCES = ["pinned", "routed", "legacy"] as const;

/** Group index → turn count, strictly descending so `ORDER BY 4 DESC` is
 *  deterministic and the tail is unambiguously outside the top `CAP`. */
const TOTAL_GROUPS = MODELS.length * PROVENANCES.length;
const turnCountFor = (index: number) => TOTAL_GROUPS - index;
const groupIndex = (modelIdx: number, provIdx: number) => modelIdx * PROVENANCES.length + provIdx;

/** The usage jsonb shape that makes `PROVENANCE` classify a turn three ways:
 *  `requestedModel` a string = pinned, JSON null = routed, absent = legacy. */
function usageFor(provenance: string, provider: string, model: string) {
  const base = { inputTokens: ONE_M, outputTokens: 0, failover: false };
  if (provenance === "pinned") {
    return { ...base, requestedModel: model, requestedProvider: provider };
  }
  if (provenance === "routed") {
    return { ...base, requestedModel: null, requestedProvider: null, routedTier: "fast" };
  }
  return { inputTokens: ONE_M, outputTokens: 0 }; // legacy: no provenance keys
}

const BASE = Date.now() - 60 * 60 * 1000;

beforeAll(async () => {
  await setupTestDb();
  const db = getTestDb();

  await db.insert(users).values({
    id: USER_ID, email: "t@x.com", passwordHash: "x", name: "T", role: "admin",
  } as any);
  await db.insert(projects).values({ id: PROJECT_ID, name: "t", path: "/tmp/t" } as any);
  await db.insert(conversations).values({
    id: CONV, projectId: PROJECT_ID, userId: USER_ID,
    model: "claude-opus-4-5", provider: "anthropic",
  } as any);

  const rows: Record<string, unknown>[] = [];
  let seq = 0;
  MODELS.forEach(([provider, model], modelIdx) => {
    PROVENANCES.forEach((provenance, provIdx) => {
      const turns = turnCountFor(groupIndex(modelIdx, provIdx));
      for (let t = 0; t < turns; t++) {
        const id = `a-${modelIdx}-${provIdx}-${t}`;
        rows.push({
          id,
          content: id, // NOT NULL; content is irrelevant to every assertion here
          conversationId: CONV,
          role: "assistant",
          parentMessageId: null,
          provider,
          model,
          usage: usageFor(provenance, provider, model),
          createdAt: new Date(BASE + seq++ * 1000),
        });
      }
    });
  });
  // Chunked: 60 groups with strictly-descending counts needs 1830 rows, and a
  // single multi-row INSERT that wide exceeds the driver's bind-parameter
  // ceiling.
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(messages).values(rows.slice(i, i + CHUNK) as any);
  }
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

/** Independent expected total: every group's turns × its real per-1M input
 *  rate. Computed from the SAME catalog the query prices against, but summed
 *  here over ALL groups — never from the returned segments, which is the thing
 *  under test. */
function expectedTotalUsd(): number {
  let total = 0;
  MODELS.forEach(([provider, model], modelIdx) => {
    const rate = modelPrices(provider, model)?.input ?? 0;
    PROVENANCES.forEach((_p, provIdx) => {
      total += turnCountFor(groupIndex(modelIdx, provIdx)) * rate;
    });
  });
  return total;
}

describe("getRoutingStats — spend totals vs the display cap", () => {
  test("the fixture really does exceed the cap, and every model is priced", () => {
    expect(TOTAL_GROUPS).toBeGreaterThan(CAP);
    for (const [provider, model] of MODELS) {
      const p = modelPrices(provider, model);
      expect(p, `${provider}/${model} must be priced for this fixture to mean anything`).toBeTruthy();
      expect(p!.input).toBeGreaterThan(0);
    }
  });

  test("the segment TABLE is capped and says so", async () => {
    const s = await getRoutingStats(30);
    expect(s.spend.segments).toHaveLength(CAP);
    expect(s.spend.segmentsTruncated).toBe(true);
  });

  test("the priciest model is dropped from the table — the case that breaks a SQL LIMIT", async () => {
    const s = await getRoutingStats(30);
    const [provider, model] = MODELS[MODELS.length - 1]!;
    const shown = s.spend.segments.some((seg) => seg.provider === provider && seg.model === model);
    expect(shown, `${model} is the lowest-volume group; it must fall outside the top ${CAP}`).toBe(false);
  });

  test("totalUsd covers ALL groups, including the ones the table drops", async () => {
    const s = await getRoutingStats(30);
    expect(s.spend.totalUsd).toBeCloseTo(expectedTotalUsd(), 6);

    // The regression this suite exists for: with the cap applied in SQL the
    // total would equal the sum of the DISPLAYED rows. It must be strictly
    // greater, by exactly the dropped groups' dollars.
    const shownUsd = s.spend.segments.reduce((n, seg) => n + (seg.cost?.total ?? 0), 0);
    expect(s.spend.totalUsd).toBeGreaterThan(shownUsd);

    const [provider, model] = MODELS[MODELS.length - 1]!;
    const rate = modelPrices(provider, model)!.input;
    const droppedTurns = PROVENANCES.reduce(
      (n, _p, provIdx) => n + turnCountFor(groupIndex(MODELS.length - 1, provIdx)),
      0,
    );
    expect(s.spend.totalUsd - shownUsd).toBeGreaterThanOrEqual(droppedTurns * rate);
  });

  test("the routed/pinned/legacy split is uncapped too, and reconciles to the total", async () => {
    const s = await getRoutingStats(30);
    expect(s.spend.routedUsd + s.spend.pinnedUsd + s.spend.legacyUsd).toBeCloseTo(
      s.spend.totalUsd,
      6,
    );
    for (const bucket of [s.spend.routedUsd, s.spend.pinnedUsd, s.spend.legacyUsd]) {
      expect(bucket).toBeGreaterThan(0);
    }
  });

  test("turn counts and cost-per-conversation are drawn from the uncapped totals", async () => {
    const s = await getRoutingStats(30);
    const seededTurns = Array.from({ length: TOTAL_GROUPS }, (_v, i) => turnCountFor(i)).reduce(
      (a, b) => a + b,
      0,
    );
    expect(s.turns.total).toBe(seededTurns);
    // Everything here is priced, so nothing lands on the unpriced axis.
    expect(s.spend.unpricedTurns).toBe(0);
    expect(s.spend.conversations).toBe(1);
    expect(s.spend.usdPerConversation).toBeCloseTo(expectedTotalUsd(), 6);
  });
});
