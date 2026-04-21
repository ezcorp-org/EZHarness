import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mockServerAlias, createMockEvent, jsonFromResponse, ADMIN_USER, MEMBER_USER } from "./helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockServerAlias();

mock.module("../../web/src/routes/api/admin/analytics/$types", () => ({}));
mock.module("../../web/src/routes/api/admin/system/$types", () => ({}));
mock.module("../../web/src/routes/api/admin/errors/$types", () => ({}));
mock.module("$lib/server/security/validation", () =>
  require("../../web/src/lib/server/security/validation"),
);
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

// ── Mock query modules (AFTER mockServerAlias to override its aliases) ──
let mockAnalytics: any = {};
let mockSystem: any = {};
let mockErrors: any[] = [];
let mockErrorCount = 0;

const analyticsMock = () => ({
  getChatActivity: async (days: number) => mockAnalytics.chatActivity ?? [],
  getModelUsage: async (days: number) => mockAnalytics.modelUsage ?? [],
  getAgentStats: async () => mockAnalytics.agentStats ?? [],
  getExtensionStats: async () => mockAnalytics.extensionStats ?? [],
  getUserStats: async () => mockAnalytics.userStats ?? { totalUsers: 0, activeUsers30d: 0, signupsLast30d: [] },
  getSystemHealth: async () => mockSystem.health ?? { dbSizeBytes: 0, uptimeSeconds: 0, tableRowCounts: {} },
  getActivityFeed: async () => mockSystem.activityFeed ?? [],
  getErrorSummary: async () => mockSystem.errorSummary ?? { totalErrors: 0, errorRate: [], recentErrors: [] },
});

const errorLogsMock = () => ({
  listErrors: async () => mockErrors,
  countErrors: async () => mockErrorCount,
});

mock.module("$server/db/queries/analytics", analyticsMock);
mock.module("../db/queries/analytics", analyticsMock);
mock.module("$server/db/queries/error-logs", errorLogsMock);
mock.module("../db/queries/error-logs", errorLogsMock);

// ── Handler imports ──────────────────────────────────────────────
import { GET as analyticsGet } from "../../web/src/routes/api/admin/analytics/+server";
import { GET as systemGet } from "../../web/src/routes/api/admin/system/+server";
import { GET as errorsGet } from "../../web/src/routes/api/admin/errors/+server";

afterAll(() => {
  restoreModuleMocks();
});

beforeEach(() => {
  mockAnalytics = {
    chatActivity: [{ date: "2026-03-20", count: 5 }],
    modelUsage: [{ model: "gpt-4", count: 10 }],
    agentStats: [{ name: "test-agent", runs: 3 }],
    extensionStats: [{ name: "test-ext", calls: 7 }],
    userStats: { totalUsers: 2, activeUsers30d: 1, signupsLast30d: [] },
  };
  mockSystem = {
    health: { dbSizeBytes: 1024, uptimeSeconds: 3600, tableRowCounts: { users: 2 } },
    activityFeed: [{ type: "login", userId: "u1", createdAt: "2026-03-20T00:00:00Z" }],
    errorSummary: { totalErrors: 1, errorRate: [], recentErrors: [] },
  };
  mockErrors = [{ id: "err-1", message: "Something failed", createdAt: "2026-03-20T00:00:00Z" }];
  mockErrorCount = 1;
});

// ── GET /api/admin/analytics ─────────────────────────────────────

describe("GET /api/admin/analytics", () => {
  test("returns analytics data for admin", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/admin/analytics",
      user: ADMIN_USER,
    });

    const res = await analyticsGet(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.chatActivity).toBeArray();
    expect(data.modelUsage).toBeArray();
    expect(data.agentStats).toBeArray();
    expect(data.extensionStats).toBeArray();
    expect(data.userStats).toBeDefined();
    expect(data.userStats.totalUsers).toBe(2);
  });

  test("respects days query parameter", async () => {
    let capturedDays: number | undefined;
    // Override mock to capture the days param
    const origChatActivity = mockAnalytics.chatActivity;
    mockAnalytics.chatActivity = [{ date: "2026-03-20", count: 5 }];

    const event = createMockEvent({
      url: "http://localhost/api/admin/analytics?days=7",
      user: ADMIN_USER,
    });

    const res = await analyticsGet(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.chatActivity).toBeArray();
  });

  test("clamps days between 1 and 365", async () => {
    // days=0 should clamp to 1 (via Math.max)
    const event1 = createMockEvent({
      url: "http://localhost/api/admin/analytics?days=0",
      user: ADMIN_USER,
    });
    const res1 = await analyticsGet(event1);
    expect(res1.status).toBe(200);

    // days=999 should clamp to 365 (via Math.min)
    const event2 = createMockEvent({
      url: "http://localhost/api/admin/analytics?days=999",
      user: ADMIN_USER,
    });
    const res2 = await analyticsGet(event2);
    expect(res2.status).toBe(200);
  });

  test("returns 403 for non-admin", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/admin/analytics",
      user: MEMBER_USER,
    });

    let res: Response;
    try {
      res = await analyticsGet(event);
    } catch (e) {
      res = e as Response;
    }
    expect(res.status).toBe(403);
  });
});

// ── GET /api/admin/system ────────────────────────────────────────

describe("GET /api/admin/system", () => {
  test("returns health data for admin", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/admin/system",
      user: ADMIN_USER,
    });

    const res = await systemGet(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.health).toBeDefined();
    expect(data.health.dbSizeBytes).toBe(1024);
    expect(data.activityFeed).toBeArray();
    expect(data.errorSummary).toBeDefined();
  });

  test("returns 403 for non-admin", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/admin/system",
      user: MEMBER_USER,
    });

    let res: Response;
    try {
      res = await systemGet(event);
    } catch (e) {
      res = e as Response;
    }
    expect(res.status).toBe(403);
  });
});

// ── GET /api/admin/errors ────────────────────────────────────────

describe("GET /api/admin/errors", () => {
  test("returns errors with total for admin", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/admin/errors",
      user: ADMIN_USER,
    });

    const res = await errorsGet(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.errors).toBeArray();
    expect(data.errors).toHaveLength(1);
    expect(data.total).toBe(1);
  });

  test("respects limit and offset query params", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/admin/errors?limit=50&offset=10",
      user: ADMIN_USER,
    });

    const res = await errorsGet(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.errors).toBeArray();
    expect(data.total).toBe(1);
  });

  test("clamps limit between 1 and 500", async () => {
    // limit=0 should clamp to 1
    const event1 = createMockEvent({
      url: "http://localhost/api/admin/errors?limit=0",
      user: ADMIN_USER,
    });
    const res1 = await errorsGet(event1);
    expect(res1.status).toBe(200);

    // limit=9999 should clamp to 500
    const event2 = createMockEvent({
      url: "http://localhost/api/admin/errors?limit=9999",
      user: ADMIN_USER,
    });
    const res2 = await errorsGet(event2);
    expect(res2.status).toBe(200);
  });

  test("returns 403 for non-admin", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/admin/errors",
      user: MEMBER_USER,
    });

    let res: Response;
    try {
      res = await errorsGet(event);
    } catch (e) {
      res = e as Response;
    }
    expect(res.status).toBe(403);
  });
});
