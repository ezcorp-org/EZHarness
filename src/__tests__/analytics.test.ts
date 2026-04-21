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
});
