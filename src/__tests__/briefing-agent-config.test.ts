/**
 * Daily Briefing — shared system agent-config bootstrap tests (PGlite).
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

// In-file snapshot for the lost-insert-race tests below (≥2-mocks
// rule: capture the real exports once, re-register the SAME object in
// afterAll; the path is also in mock-cleanup's MODULE_PATHS).
const realAgentConfigQueries = { ...(await import("../db/queries/agent-configs")) };

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
  mock.module("../db/queries/agent-configs", () => realAgentConfigQueries);
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
    // Cached hit: the verified id keeps resolving while the row lives.
    expect(await getBriefingAgentConfigId()).toBe(row.id);
  });

  test("stale cache: deleting the row invalidates the cached id (no dead id served)", async () => {
    const row = await ensureBriefingAgentConfig();
    expect(await getBriefingAgentConfigId()).toBe(row.id); // cache primed
    // Delete out from under the cache — the dead id must NOT be served
    // (it would silently break prior-briefing exclusion + the
    // setup-tools wiring gate until restart).
    await getTestDb().delete(agentConfigs);
    expect(await getBriefingAgentConfigId()).toBeNull();
  });

  test("stale cache: a deleted-then-recreated row re-resolves to the fresh id", async () => {
    const first = await ensureBriefingAgentConfig();
    expect(await getBriefingAgentConfigId()).toBe(first.id); // cache primed
    await getTestDb().delete(agentConfigs);
    // Re-bootstrap (e.g. another boot path recreated the agent) — the
    // cache miss must fall through to the name lookup and serve the
    // NEW row's id, not the dead cached one.
    const second = await ensureBriefingAgentConfig();
    expect(second.id).not.toBe(first.id);
    _resetBriefingAgentCacheForTests();
    expect(await getBriefingAgentConfigId()).toBe(second.id);
  });
});

// ── lost-insert race (the catch in ensureBriefingAgentConfig) ──────

describe("ensureBriefingAgentConfig — lost insert race", () => {
  test("createAgentConfig throwing after a concurrent winner → the winner row is surfaced", async () => {
    mock.module("../db/queries/agent-configs", () => ({
      ...realAgentConfigQueries,
      // Simulate losing the unique-name race: the concurrent boot's row
      // lands BEFORE our insert throws the unique violation.
      createAgentConfig: async () => {
        await getTestDb().insert(agentConfigs).values({
          name: BRIEFING_AGENT_NAME,
          description: "race winner",
          prompt: "w",
        });
        throw new Error('duplicate key value violates unique constraint "agent_configs_name_unique"');
      },
    }));
    try {
      const row = await ensureBriefingAgentConfig();
      expect(row.description).toBe("race winner");
      expect(await getBriefingAgentConfigId()).toBe(row.id); // cache picked up the winner
      const all = await getTestDb().select().from(agentConfigs);
      expect(all).toHaveLength(1);
    } finally {
      mock.module("../db/queries/agent-configs", () => realAgentConfigQueries);
    }
  });

  test("createAgentConfig throwing with NO winner → the original error is rethrown", async () => {
    mock.module("../db/queries/agent-configs", () => ({
      ...realAgentConfigQueries,
      createAgentConfig: async () => {
        throw new Error("disk full");
      },
    }));
    try {
      await expect(ensureBriefingAgentConfig()).rejects.toThrow("disk full");
      expect(await getBriefingAgentConfigId()).toBeNull();
    } finally {
      mock.module("../db/queries/agent-configs", () => realAgentConfigQueries);
    }
  });
});
