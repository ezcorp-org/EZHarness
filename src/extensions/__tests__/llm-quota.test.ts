/**
 * Per-extension LLM quota: call caps and restart resilience.
 *
 * A host restart must not reset an extension's daily budget: counters
 * flush to `extension_llm_usage` and a fresh quota hydrates from it.
 */
import { test, expect, describe, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb, closeTestDb, mockDbConnection, getTestDb,
} from "../../__tests__/helpers/test-pglite";

mockDbConnection();

import { createLlmQuota, type LlmQuota, type LlmQuotaConfig } from "../llm-quota";
import { extensions, extensionLlmUsage } from "../../db/schema";

const CFG: LlmQuotaConfig = { maxCallsPerHour: 100, maxCallsPerDay: 1000 };
let extensionId: string;
let quotas: LlmQuota[] = [];

function quota(): LlmQuota {
  const q = createLlmQuota();
  quotas.push(q);
  return q;
}

beforeAll(async () => {
  await setupTestDb();
  const [row] = await getTestDb().insert(extensions).values({
    name: "quota-ext", version: "0.0.1", description: "",
    manifest: { schemaVersion: 2, name: "quota-ext", version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as never,
    source: "test", enabled: true, grantedPermissions: {} as never,
  }).returning({ id: extensions.id });
  extensionId = row!.id;
});

beforeEach(async () => {
  await getTestDb().delete(extensionLlmUsage);
});

afterEach(() => {
  for (const q of quotas) q.dispose();
  quotas = [];
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("llm quota caps", () => {
  test("the hourly cap denies the next call and says when a slot frees up", () => {
    const q = quota();
    const cfg = { ...CFG, maxCallsPerHour: 2 };
    expect(q.consume(extensionId, cfg).ok).toBe(true);
    expect(q.consume(extensionId, cfg).ok).toBe(true);

    const denied = q.consume(extensionId, cfg);

    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe("calls-per-hour");
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(q.budget(extensionId, cfg).callsRemaining.hour).toBe(0);
  });

  test("the daily cap denies until UTC midnight", () => {
    const q = quota();
    const cfg = { ...CFG, maxCallsPerDay: 1 };
    expect(q.consume(extensionId, cfg).ok).toBe(true);

    const denied = q.consume(extensionId, cfg);

    expect(denied.reason).toBe("calls-per-day");
    expect(denied.retryAfterMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

describe("llm quota persistence", () => {
  test("flushed usage survives a restart: a new quota hydrates today's totals", async () => {
    const before = quota();
    before.consume(extensionId, CFG, { tokens: 300 });
    before.consume(extensionId, CFG, { tokens: 200 });
    before.addCost(extensionId, 7);
    await before.flush();

    const [row] = await getTestDb().select().from(extensionLlmUsage);
    expect(row).toMatchObject({ extensionId, calls: 2, totalTokens: 500, costCents: 7 });

    const after = quota();
    await after.hydrate(extensionId);
    const cfg = { ...CFG, maxCallsPerDay: 3, maxTokensPerDay: 1000, maxCostCentsPerDay: 10 };
    expect(after.budget(extensionId, cfg)).toMatchObject({
      callsRemaining: { day: 1 },
      tokensRemaining: { day: 500 },
      costCentsRemaining: { day: 3 },
    });
    expect(after.consume(extensionId, cfg).ok).toBe(true);
    expect(after.consume(extensionId, cfg).reason).toBe("calls-per-day");
  });

  test("a second flush updates the same day row instead of adding one", async () => {
    const q = quota();
    q.consume(extensionId, CFG);
    await q.flush();
    q.consume(extensionId, CFG);
    q.adjustTokens(extensionId, 40);
    await q.flush();

    const rows = await getTestDb().select().from(extensionLlmUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ calls: 2, totalTokens: 40 });
  });

  test("hydrate does not overwrite counters already in use today", async () => {
    await getTestDb().insert(extensionLlmUsage).values({
      extensionId, day: new Date().toISOString().slice(0, 10), calls: 50, totalTokens: 0, costCents: 0,
    });
    const q = quota();
    q.consume(extensionId, CFG);

    await q.hydrate(extensionId);

    expect(q.budget(extensionId, CFG).callsRemaining.day).toBe(CFG.maxCallsPerDay - 1);
  });
});
