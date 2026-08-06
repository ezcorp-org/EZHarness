/**
 * The operator scan, against a REAL migrated database.
 *
 * `dropped-models.test.ts` proves the detection RULE. This proves the thing
 * an operator actually runs: that the SQL matches this repo's schema, that a
 * conversation pinned to one of the ids pi-ai 0.83.0 retired is found and
 * NAMED, and that a live pin and a local/custom pin are not reported.
 *
 * Without this, the scan is a query nobody has ever executed — and a
 * mis-typed column name would only surface the day someone needed the answer.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { collectPins } = await import("../../scripts/scan-catalog-gaps");
const { findCatalogGaps } = await import("../runtime/routing/dropped-models");
const { isKnownCatalogModel } = await import("../providers/registry");

/** One id from each provider's retired set, verified in dropped-models.test.ts. */
const RETIRED_OPENAI = "gpt-5.1-codex";
const RETIRED_OPENROUTER = "poolside/laguna-m.1";

async function seedConversation(id: string, provider: string, model: string): Promise<void> {
  const db = getTestDb();
  await db.execute(
    sql`INSERT INTO conversations (id, project_id, title, provider, model)
        VALUES (${id}, 'p1', ${id}, ${provider}, ${model})`,
  );
}

describe("scan-catalog-gaps against a real migrated schema", () => {
  beforeEach(async () => {
    await setupTestDb();
    await getTestDb().execute(
      sql`INSERT INTO projects (id, name, path) VALUES ('p1','P','/tmp/p') ON CONFLICT (id) DO NOTHING`,
    );
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  test("the queries run against this schema and report nothing on an empty database", async () => {
    // The cheapest thing this test buys: a column rename anywhere in
    // PIN_SOURCES fails HERE instead of in front of an operator.
    const pins = await collectPins();
    expect(Array.isArray(pins)).toBe(true);
    expect(findCatalogGaps(pins, isKnownCatalogModel)).toEqual([]);
  });

  test("a conversation pinned to a RETIRED id is found and named", async () => {
    await seedConversation("c-retired", "openai", RETIRED_OPENAI);
    const gaps = findCatalogGaps(await collectPins(), isKnownCatalogModel);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      provider: "openai",
      modelId: RETIRED_OPENAI,
      source: "conversations.model",
      reason: "not-in-catalog",
    });
  });

  test("counts the affected ROWS, which is the number that decides a migration", async () => {
    await seedConversation("c1", "openrouter", RETIRED_OPENROUTER);
    await seedConversation("c2", "openrouter", RETIRED_OPENROUTER);
    await seedConversation("c3", "openrouter", RETIRED_OPENROUTER);
    const pins = await collectPins();
    const pin = pins.find((p) => p.modelId === RETIRED_OPENROUTER);
    expect(pin?.rows).toBe(3);
    // …while the GAP report collapses them to one actionable line.
    expect(findCatalogGaps(pins, isKnownCatalogModel)).toHaveLength(1);
  });

  test("a live model and a local/custom pin are NOT reported", async () => {
    await seedConversation("c-live", "anthropic", "claude-opus-5");
    await seedConversation("c-local", "ollama", "qwen3:1.7b");
    expect(findCatalogGaps(await collectPins(), isKnownCatalogModel)).toEqual([]);
  });

  test("retired pins across two providers are reported separately", async () => {
    await seedConversation("c-a", "openai", RETIRED_OPENAI);
    await seedConversation("c-b", "openrouter", RETIRED_OPENROUTER);
    const gaps = findCatalogGaps(await collectPins(), isKnownCatalogModel);
    expect(gaps.map((g) => `${g.provider}/${g.modelId}`).sort()).toEqual(
      [`openai/${RETIRED_OPENAI}`, `openrouter/${RETIRED_OPENROUTER}`].sort(),
    );
  });
});
