import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  getTestDb,
} from "../../__tests__/helpers/test-pglite";

mockDbConnection();

const {
  computeToolPriors,
  deriveExtensionPriors,
  getUserToolPriors,
  clearToolPriorsCache,
  PRIOR_HALF_LIFE_DAYS,
} = await import("../user-tool-priors");
const { users, toolCalls } = await import("../../db/schema");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-01T00:00:00Z");

describe("computeToolPriors (pure)", () => {
  test("empty history → empty record", () => {
    expect(computeToolPriors([], NOW)).toEqual({});
  });

  test("most-used recent tool normalizes to 1", () => {
    const priors = computeToolPriors(
      [
        { toolName: "a__x", uses: 10, lastUsedAt: new Date(NOW) },
        { toolName: "b__y", uses: 5, lastUsedAt: new Date(NOW) },
      ],
      NOW,
    );
    expect(priors["a__x"]).toBe(1);
    expect(priors["b__y"]).toBeCloseTo(0.5);
  });

  test("recency decay: a tool last used one half-life ago counts half", () => {
    const priors = computeToolPriors(
      [
        { toolName: "fresh", uses: 4, lastUsedAt: new Date(NOW) },
        { toolName: "stale", uses: 4, lastUsedAt: new Date(NOW - PRIOR_HALF_LIFE_DAYS * DAY_MS) },
      ],
      NOW,
    );
    expect(priors["stale"]).toBeCloseTo(0.5);
  });

  test("future timestamps clamp to zero age (no boost beyond 1)", () => {
    const priors = computeToolPriors(
      [{ toolName: "clock-skew", uses: 2, lastUsedAt: new Date(NOW + DAY_MS) }],
      NOW,
    );
    expect(priors["clock-skew"]).toBe(1);
  });

  test("invalid timestamps and non-positive counts are skipped", () => {
    expect(
      computeToolPriors(
        [
          { toolName: "bad-date", uses: 3, lastUsedAt: "not-a-date" },
          { toolName: "zero", uses: 0, lastUsedAt: new Date(NOW) },
        ],
        NOW,
      ),
    ).toEqual({});
  });
});

describe("deriveExtensionPriors (pure)", () => {
  test("per extension: MAX over its `<name>__`-prefixed tool keys", () => {
    const priors = { "a__x": 0.4, "a__y": 0.9, "b__z": 0.5 };
    expect(deriveExtensionPriors(priors, ["a", "b"])).toEqual({ a: 0.9, b: 0.5 });
  });

  test("built-in (un-namespaced) keys are ignored", () => {
    const priors = { search_web: 1, read_page: 0.8, "a__x": 0.3 };
    expect(deriveExtensionPriors(priors, ["a"])).toEqual({ a: 0.3 });
  });

  test("unrequested extensions are omitted; empty names → {}", () => {
    const priors = { "a__x": 1, "b__y": 0.6 };
    expect(deriveExtensionPriors(priors, ["a"])).toEqual({ a: 1 });
    expect(deriveExtensionPriors(priors, [])).toEqual({});
  });

  test("empty priors → {}", () => {
    expect(deriveExtensionPriors({}, ["a", "b"])).toEqual({});
  });

  test("keeps the [0,1] normalization (max, not sum, of many tools)", () => {
    const priors = { "multi__a": 0.6, "multi__b": 0.6, "multi__c": 0.6 };
    expect(deriveExtensionPriors(priors, ["multi"])).toEqual({ multi: 0.6 });
  });
});

describe("getUserToolPriors (DB)", () => {
  beforeEach(async () => {
    await setupTestDb();
    clearToolPriorsCache();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  async function seedUser(id: string): Promise<void> {
    await getTestDb().insert(users).values({
      id,
      email: `${id}@test.dev`,
      passwordHash: "x",
      name: id,
    });
  }

  async function seedCall(userId: string, toolName: string, at: Date): Promise<void> {
    // The 'builtin' extension row is seeded by migrate.ts.
    await getTestDb().insert(toolCalls).values({
      extensionId: "builtin",
      toolName,
      success: true,
      durationMs: 5,
      userId,
      createdAt: at,
    });
  }

  test("aggregates per-tool usage for the user only", async () => {
    await seedUser("u1");
    await seedUser("u2");
    const now = Date.now();
    await seedCall("u1", "analyzer__scan", new Date(now - DAY_MS));
    await seedCall("u1", "analyzer__scan", new Date(now - DAY_MS));
    await seedCall("u1", "websearch__search", new Date(now - DAY_MS));
    await seedCall("u2", "other__tool", new Date(now - DAY_MS));

    const priors = await getUserToolPriors("u1", now);
    expect(priors["analyzer__scan"]).toBe(1);
    expect(priors["websearch__search"]).toBeCloseTo(0.5);
    expect(priors["other__tool"]).toBeUndefined();
  });

  test("usage outside the window is excluded entirely", async () => {
    await seedUser("u1");
    const now = Date.now();
    await seedCall("u1", "ancient__tool", new Date(now - 120 * DAY_MS));
    expect(await getUserToolPriors("u1", now)).toEqual({});
  });

  test("TTL cache: repeat call within TTL skips the query", async () => {
    await seedUser("u1");
    const now = Date.now();
    await seedCall("u1", "analyzer__scan", new Date(now));
    const first = await getUserToolPriors("u1", now);
    await seedCall("u1", "newer__tool", new Date(now));
    // Same nowMs → cached result, the new row is invisible.
    const second = await getUserToolPriors("u1", now + 1000);
    expect(second).toBe(first);
    // clearing the cache re-queries.
    clearToolPriorsCache();
    const third = await getUserToolPriors("u1", now + 1000);
    expect(third["newer__tool"]).toBeDefined();
  });
});
