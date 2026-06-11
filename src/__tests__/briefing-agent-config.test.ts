/**
 * Daily Briefing — shared system agent-config bootstrap tests (PGlite).
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  ensureBriefingAgentConfig,
  getBriefingAgentConfigId,
  _resetBriefingAgentCacheForTests,
  BRIEFING_AGENT_NAME,
  BRIEFING_AGENT_PROMPT,
} from "../runtime/briefing/agent-config";
import { agentConfigs } from "../db/schema";

beforeAll(async () => {
  await setupTestDb();
}, 30_000);

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  _resetBriefingAgentCacheForTests();
  await getTestDb().delete(agentConfigs);
});

describe("ensureBriefingAgentConfig", () => {
  test("creates the shared system agent on first call", async () => {
    const row = await ensureBriefingAgentConfig();
    expect(row.name).toBe(BRIEFING_AGENT_NAME);
    expect(row.prompt).toBe(BRIEFING_AGENT_PROMPT);
    expect(row.category).toBe("system");
    expect(row.userId).toBeNull(); // system-owned, not per-user
    // Instance default model resolution (CURRENT_MODEL_SENTINEL).
    expect(row.model).toBeTruthy();
    expect(row.provider).toBeTruthy();
  });

  test("is idempotent — second call returns the same row, no duplicate", async () => {
    const first = await ensureBriefingAgentConfig();
    const second = await ensureBriefingAgentConfig();
    expect(second.id).toBe(first.id);
    const all = await getTestDb().select().from(agentConfigs);
    expect(all).toHaveLength(1);
  });

  test("survives a lost unique-name race by surfacing the winner", async () => {
    // Pre-insert the row directly (simulates a concurrent boot winning
    // between our SELECT-miss and INSERT) — but here we just verify the
    // find-first path: existing row short-circuits creation.
    const db = getTestDb();
    await db.insert(agentConfigs).values({
      name: BRIEFING_AGENT_NAME,
      description: "pre-existing",
      prompt: "p",
    });
    const row = await ensureBriefingAgentConfig();
    expect(row.description).toBe("pre-existing");
    const all = await db.select().from(agentConfigs);
    expect(all).toHaveLength(1);
  });

  test("concurrent ensure calls yield one row", async () => {
    const [a, b] = await Promise.all([
      ensureBriefingAgentConfig(),
      ensureBriefingAgentConfig(),
    ]);
    expect(a.id).toBe(b.id);
    const all = await getTestDb().select().from(agentConfigs);
    expect(all).toHaveLength(1);
  });
});

describe("getBriefingAgentConfigId", () => {
  test("returns null when the agent was never bootstrapped (lookup-only — never creates)", async () => {
    expect(await getBriefingAgentConfigId()).toBeNull();
    const all = await getTestDb().select().from(agentConfigs);
    expect(all).toHaveLength(0);
  });

  test("resolves and caches the id after bootstrap", async () => {
    const row = await ensureBriefingAgentConfig();
    _resetBriefingAgentCacheForTests();
    expect(await getBriefingAgentConfigId()).toBe(row.id);
    // Cached path: delete the row out from under the cache — the id
    // still resolves from cache (per-process cache semantics).
    await getTestDb().delete(agentConfigs);
    expect(await getBriefingAgentConfigId()).toBe(row.id);
    // Reset re-resolves from the DB → null again.
    _resetBriefingAgentCacheForTests();
    expect(await getBriefingAgentConfigId()).toBeNull();
  });
});
