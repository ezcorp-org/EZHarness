import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mock DB layer ────────────────────────────────────────────────────

let queryResults: any[][] = [];
let queryIndex = 0;

function resetMockState() {
  queryResults = [];
  queryIndex = 0;
}

/** Returns the next result from queryResults queue on each terminal operation */
function nextResult() {
  const result = queryResults[queryIndex] ?? [];
  queryIndex++;
  return result;
}

function createChainableDb() {
  const chain: any = {
    select: (_cols?: any) => chain,
    from: (_table: any) => chain,
    where: (..._args: any[]) => chain,
    groupBy: (..._args: any[]) => chain,
    leftJoin: (_table: any, _on: any) => chain,
    innerJoin: (_table: any, _on: any) => chain,
    orderBy: (..._args: any[]) => chain,
    limit: (_n: any) => chain,
    offset: (_o: any) => chain,
    then: (resolve: any, reject?: any) => {
      return Promise.resolve(nextResult()).then(resolve, reject);
    },
  };
  return chain;
}

let mockSqlResult: any = { rows: [] };

mock.module("../db/connection", () => ({
  getDb: () => {
    const db = createChainableDb();
    db.execute = (_query: any) => Promise.resolve(mockSqlResult);
    return db;
  },
}));

// Mock error-logs for getErrorSummary
let mockListErrors: any[] = [];
mock.module("../db/queries/error-logs", () => ({
  listErrors: async (_opts?: any) => mockListErrors,
}));

// ── Import subject after mocks ───────────────────────────────────────

import {
  getChatActivity,
  getModelUsage,
  getAgentStats,
  getExtensionStats,
  getUserStats,
  getSystemHealth,
  getActivityFeed,
  getErrorSummary,
  getToolUsageByTool,
  getToolUsageByAgent,
  getToolUsageByUser,
  getToolUsageByModel,
} from "../db/queries/analytics";

// ── Tests ─────────────────────────────────────────────────────────────

describe("analytics queries", () => {
  beforeEach(() => {
    resetMockState();
    mockSqlResult = { rows: [] };
    mockListErrors = [];
  });

  describe("getChatActivity", () => {
    test("returns array with date, messageCount, conversationCount", async () => {
      queryResults = [
        [
          { date: "2026-03-23", messageCount: 10, conversationCount: 3 },
          { date: "2026-03-22", messageCount: 5, conversationCount: 2 },
        ],
      ];

      const result = await getChatActivity(30);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(result[0]).toHaveProperty("date");
      expect(result[0]).toHaveProperty("messageCount");
      expect(result[0]).toHaveProperty("conversationCount");
    });

    test("accepts days parameter", async () => {
      queryResults = [[]];
      const result = await getChatActivity(7);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getModelUsage", () => {
    test("returns array with model, provider, count", async () => {
      queryResults = [
        [
          { model: "gpt-4", provider: "openai", count: 50 },
          { model: "claude-3", provider: "anthropic", count: 30 },
        ],
      ];

      const result = await getModelUsage(30);
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]).toHaveProperty("model");
      expect(result[0]).toHaveProperty("provider");
      expect(result[0]).toHaveProperty("count");
    });
  });

  describe("getAgentStats", () => {
    test("returns array with name, conversationCount", async () => {
      queryResults = [
        [{ name: "Test Agent", conversationCount: 15 }],
      ];

      const result = await getAgentStats();
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]).toHaveProperty("name");
      expect(result[0]).toHaveProperty("conversationCount");
    });
  });

  describe("getExtensionStats", () => {
    test("returns array with name, installCount", async () => {
      queryResults = [
        [{ name: "markdown-utils", installCount: 8 }],
      ];

      const result = await getExtensionStats();
      expect(Array.isArray(result)).toBe(true);
      expect(result[0]).toHaveProperty("name");
      expect(result[0]).toHaveProperty("installCount");
    });
  });

  describe("getUserStats", () => {
    test("returns totalUsers, activeUsers30d, signupsLast30d", async () => {
      // getUserStats makes 3 sequential queries:
      // 1. total users count
      // 2. active users count
      // 3. signups by date
      queryResults = [
        [{ totalUsers: 10 }],
        [{ activeUsers: 7 }],
        [{ date: "2026-03-23", count: 2 }],
      ];

      const result = await getUserStats();
      expect(result).toHaveProperty("totalUsers");
      expect(result).toHaveProperty("activeUsers30d");
      expect(result).toHaveProperty("signupsLast30d");
      expect(typeof result.totalUsers).toBe("number");
      expect(typeof result.activeUsers30d).toBe("number");
      expect(Array.isArray(result.signupsLast30d)).toBe(true);
    });
  });

  describe("getSystemHealth", () => {
    test("returns dbSizeBytes, uptimeSeconds, tableRowCounts", async () => {
      mockSqlResult = { rows: [{ size: 1024000 }] };
      // getSystemHealth queries count for each of 5 tables
      queryResults = [
        [{ count: 500 }],
        [{ count: 100 }],
        [{ count: 10 }],
        [{ count: 5 }],
        [{ count: 3 }],
      ];

      const result = await getSystemHealth();
      expect(result).toHaveProperty("dbSizeBytes");
      expect(result).toHaveProperty("uptimeSeconds");
      expect(result).toHaveProperty("tableRowCounts");
      expect(typeof result.dbSizeBytes).toBe("number");
      expect(typeof result.uptimeSeconds).toBe("number");
      expect(typeof result.tableRowCounts).toBe("object");
    });
  });

  describe("getActivityFeed", () => {
    test("returns recent audit entries with user info", async () => {
      queryResults = [
        [
          {
            id: "a1",
            action: "user.login",
            userId: "u1",
            userName: "John",
            userEmail: "john@test.com",
            metadata: null,
            createdAt: new Date(),
          },
        ],
      ];

      const result = await getActivityFeed(50);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);
    });

    test("defaults to limit 50", async () => {
      queryResults = [[]];
      const result = await getActivityFeed();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getErrorSummary", () => {
    test("returns totalErrors, errorRate, recentErrors", async () => {
      // getErrorSummary makes 1 query (errorRate by date) + calls listErrors
      queryResults = [
        [{ date: "2026-03-23", count: 3 }],
      ];
      mockListErrors = [
        { id: "e1", level: "error", message: "test", createdAt: new Date() },
      ];

      const result = await getErrorSummary(7);
      expect(result).toHaveProperty("totalErrors");
      expect(result).toHaveProperty("errorRate");
      expect(result).toHaveProperty("recentErrors");
      expect(typeof result.totalErrors).toBe("number");
      expect(Array.isArray(result.errorRate)).toBe(true);
      expect(Array.isArray(result.recentErrors)).toBe(true);
    });
  });

  // ── Tool-Call Usage ──────────────────────────────────────────────

  describe("getToolUsageByTool", () => {
    test("projects count, successCount, and derives errorCount", async () => {
      queryResults = [
        [
          { toolName: "read_file", extensionId: "builtin", count: 20, successCount: 18 },
          { toolName: "search",    extensionId: "ext-1",   count: 5,  successCount: 5 },
        ],
      ];

      const result = await getToolUsageByTool(30);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        toolName: "read_file",
        extensionId: "builtin",
        count: 20,
        successCount: 18,
        errorCount: 2,
      });
      expect(result[1]!.errorCount).toBe(0);
    });

    test("treats null successCount as zero (all errors)", async () => {
      queryResults = [[{ toolName: "t", extensionId: "e", count: 3, successCount: null }]];
      const r = await getToolUsageByTool(30);
      expect(r[0]).toEqual({
        toolName: "t", extensionId: "e", count: 3, successCount: 0, errorCount: 3,
      });
    });

    test("coerces missing fields to safe strings / zero", async () => {
      queryResults = [[{ toolName: null, extensionId: null, count: 0, successCount: 0 }]];
      const r = await getToolUsageByTool(30);
      expect(r[0]!.toolName).toBe("");
      expect(r[0]!.extensionId).toBe("");
      expect(r[0]!.errorCount).toBe(0);
    });

    test("returns empty array for no rows", async () => {
      queryResults = [[]];
      const r = await getToolUsageByTool(30);
      expect(r).toEqual([]);
    });

    test("accepts days parameter and clamps to at least 1", async () => {
      queryResults = [[]];
      expect(await getToolUsageByTool(0)).toEqual([]);
      queryResults = [[]];
      expect(await getToolUsageByTool(-5)).toEqual([]);
    });
  });

  describe("getToolUsageByAgent", () => {
    test("projects agent + tool pair counts with successCount and derives errorCount", async () => {
      queryResults = [
        [
          { agentConfigId: "a1", agentName: "Researcher", toolName: "read_file", count: 12, successCount: 10 },
          { agentConfigId: "a2", agentName: null,          toolName: "search",    count: 4,  successCount: 4 },
        ],
      ];

      const r = await getToolUsageByAgent(30);
      expect(r).toHaveLength(2);
      expect(r[0]!.agentName).toBe("Researcher");
      expect(r[0]!.errorCount).toBe(2);
      expect(r[0]!.successCount).toBe(10);
      expect(r[1]!.agentName).toBe("Unknown");
      expect(r[1]!.count).toBe(4);
      expect(r[1]!.errorCount).toBe(0);
    });

    test("treats null successCount as zero (all errors)", async () => {
      queryResults = [[{ agentConfigId: "a1", agentName: "x", toolName: "t", count: 3, successCount: null }]];
      const r = await getToolUsageByAgent(30);
      expect(r[0]!.successCount).toBe(0);
      expect(r[0]!.errorCount).toBe(3);
    });

    test("returns [] when no rows", async () => {
      queryResults = [[]];
      expect(await getToolUsageByAgent(30)).toEqual([]);
    });
  });

  describe("getToolUsageByUser", () => {
    test("projects user + tool pair counts with name/email, successCount, errorCount", async () => {
      queryResults = [
        [
          { userId: "u1", userName: "Alice", userEmail: "a@x.com", toolName: "read_file", count: 9, successCount: 7 },
          { userId: "u2", userName: null,    userEmail: null,       toolName: "search",    count: 2, successCount: 2 },
        ],
      ];

      const r = await getToolUsageByUser(30);
      expect(r[0]).toEqual({
        userId: "u1", userName: "Alice", userEmail: "a@x.com",
        toolName: "read_file", count: 9, successCount: 7, errorCount: 2,
      });
      expect(r[1]!.userName).toBe("Unknown");
      expect(r[1]!.userEmail).toBe("");
      expect(r[1]!.errorCount).toBe(0);
    });

    test("treats null successCount as zero (all errors)", async () => {
      queryResults = [[{ userId: "u1", userName: "x", userEmail: "x@x", toolName: "t", count: 5, successCount: null }]];
      const r = await getToolUsageByUser(30);
      expect(r[0]!.errorCount).toBe(5);
    });

    test("returns [] when no rows", async () => {
      queryResults = [[]];
      expect(await getToolUsageByUser(30)).toEqual([]);
    });
  });

  describe("getToolUsageByModel", () => {
    test("projects model + provider + tool counts with successCount and errorCount", async () => {
      queryResults = [
        [
          { model: "claude-opus-4-7",    provider: "anthropic", toolName: "read_file", count: 15, successCount: 13 },
          { model: "claude-sonnet-4-6",  provider: "anthropic", toolName: "search",    count: 6,  successCount: 6 },
        ],
      ];

      const r = await getToolUsageByModel(30);
      expect(r[0]!.model).toBe("claude-opus-4-7");
      expect(r[0]!.provider).toBe("anthropic");
      expect(r[0]!.count).toBe(15);
      expect(r[0]!.errorCount).toBe(2);
      expect(r[1]!.errorCount).toBe(0);
    });

    test("falls back to 'unknown' when model/provider are null", async () => {
      queryResults = [[{ model: null, provider: null, toolName: "t", count: 1, successCount: 1 }]];
      const r = await getToolUsageByModel(30);
      expect(r[0]!.model).toBe("unknown");
      expect(r[0]!.provider).toBe("unknown");
      expect(r[0]!.errorCount).toBe(0);
    });

    test("treats null successCount as zero (all errors)", async () => {
      queryResults = [[{ model: "m", provider: "p", toolName: "t", count: 2, successCount: null }]];
      const r = await getToolUsageByModel(30);
      expect(r[0]!.errorCount).toBe(2);
    });

    test("returns [] when no rows", async () => {
      queryResults = [[]];
      expect(await getToolUsageByModel(30)).toEqual([]);
    });
  });
});
