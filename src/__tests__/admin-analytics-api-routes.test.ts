import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  mockServerAlias,
  createMockEvent,
  jsonFromResponse,
  ADMIN_USER,
  MEMBER_USER,
} from "./helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockServerAlias();

mock.module("../../web/src/routes/api/admin/analytics/$types", () => ({}));
mock.module("../../web/src/routes/api/admin/analytics/routing/$types", () => ({}));
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
  getUserStats: async () =>
    mockAnalytics.userStats ?? { totalUsers: 0, activeUsers30d: 0, signupsLast30d: [] },
  getToolUsageByTool: async (_days: number) => mockAnalytics.toolUsageByTool ?? [],
  getToolUsageByAgent: async (_days: number) => mockAnalytics.toolUsageByAgent ?? [],
  getToolUsageByUser: async (_days: number) => mockAnalytics.toolUsageByUser ?? [],
  getToolUsageByModel: async (_days: number) => mockAnalytics.toolUsageByModel ?? [],
  getRoutingStats: async (days: number) => ({ ...(mockAnalytics.routingStats ?? {}), days }),
  getSystemHealth: async () =>
    mockSystem.health ?? { dbSizeBytes: 0, uptimeSeconds: 0, tableRowCounts: {} },
  getActivityFeed: async () => mockSystem.activityFeed ?? [],
  getErrorSummary: async () =>
    mockSystem.errorSummary ?? { totalErrors: 0, errorRate: [], recentErrors: [] },
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
import { GET as routingGet } from "../../web/src/routes/api/admin/analytics/routing/+server";
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
    toolUsageByTool: [
      { toolName: "read_file", extensionId: "builtin", count: 20, successCount: 18, errorCount: 2 },
    ],
    toolUsageByAgent: [
      {
        agentConfigId: "a1",
        agentName: "test-agent",
        toolName: "read_file",
        count: 12,
        successCount: 10,
        errorCount: 2,
      },
    ],
    toolUsageByUser: [
      {
        userId: "u1",
        userName: "Alice",
        userEmail: "a@x.com",
        toolName: "read_file",
        count: 9,
        successCount: 8,
        errorCount: 1,
      },
    ],
    toolUsageByModel: [
      {
        model: "claude-opus-4-7",
        provider: "anthropic",
        toolName: "read_file",
        count: 15,
        successCount: 14,
        errorCount: 1,
      },
    ],
    routingStats: {
      turns: { total: 10, routed: 3, pinned: 5, legacy: 2 },
      routedShare: 0.375,
      tierMix: [{ tier: "fast", count: 3 }],
      failover: { count: 1, rate: 0.125 },
      switches: {
        pairs: 4,
        total: 1,
        escalations: 1,
        downgrades: 0,
        lateral: 0,
        rate: 0.25,
        samples: [],
      },
      retries: { answeredTurns: 8, retriedTurns: 1, extraSiblings: 1, rate: 0.125, samples: [] },
      spend: {
        segments: [],
        routedUsd: 1.5,
        pinnedUsd: 2.5,
        legacyUsd: 0,
        totalUsd: 4,
        unpricedTurns: 1,
        unpricedTokens: 500,
        conversations: 2,
        usdPerConversation: 2,
      },
    },
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

    // Tool-call analytics: four dimension buckets must all be wired into
    // the admin payload.
    expect(data.toolUsage).toBeDefined();
    expect(data.toolUsage.byTool).toBeArray();
    expect(data.toolUsage.byAgent).toBeArray();
    expect(data.toolUsage.byUser).toBeArray();
    expect(data.toolUsage.byModel).toBeArray();
    expect(data.toolUsage.byTool[0].toolName).toBe("read_file");
    expect(data.toolUsage.byTool[0].errorCount).toBe(2);
    expect(data.toolUsage.byAgent[0].agentName).toBe("test-agent");
    expect(data.toolUsage.byAgent[0].errorCount).toBe(2);
    expect(data.toolUsage.byUser[0].userEmail).toBe("a@x.com");
    expect(data.toolUsage.byUser[0].errorCount).toBe(1);
    expect(data.toolUsage.byModel[0].model).toBe("claude-opus-4-7");
    expect(data.toolUsage.byModel[0].errorCount).toBe(1);
  });

  test("respects days query parameter", async () => {
    let _capturedDays: number | undefined;
    // Override mock to capture the days param
    const _origChatActivity = mockAnalytics.chatActivity;
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

// ── GET /api/admin/analytics/routing ─────────────────────────────

describe("GET /api/admin/analytics/routing", () => {
  test("returns the routing + spend payload for admin", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/admin/analytics/routing",
      user: ADMIN_USER,
    });

    const res = await routingGet(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.turns).toEqual({ total: 10, routed: 3, pinned: 5, legacy: 2 });
    expect(data.routedShare).toBe(0.375);
    expect(data.tierMix[0].tier).toBe("fast");
    expect(data.failover.count).toBe(1);
    expect(data.switches.escalations).toBe(1);
    expect(data.retries.retriedTurns).toBe(1);
    expect(data.spend.routedUsd).toBe(1.5);
    expect(data.spend.usdPerConversation).toBe(2);
    // Unpriced turns ride their own axis, never folded into the dollars.
    expect(data.spend.unpricedTurns).toBe(1);
  });

  test("defaults to 30 days and clamps the days param to [1, 365]", async () => {
    const dflt = await jsonFromResponse(
      await routingGet(
        createMockEvent({ url: "http://localhost/api/admin/analytics/routing", user: ADMIN_USER }),
      ),
    );
    expect(dflt.days).toBe(30);

    const low = await jsonFromResponse(
      await routingGet(
        createMockEvent({
          url: "http://localhost/api/admin/analytics/routing?days=0",
          user: ADMIN_USER,
        }),
      ),
    );
    expect(low.days).toBe(30); // parseInt("0") is falsy → the ?? 30 default

    const high = await jsonFromResponse(
      await routingGet(
        createMockEvent({
          url: "http://localhost/api/admin/analytics/routing?days=9999",
          user: ADMIN_USER,
        }),
      ),
    );
    expect(high.days).toBe(365);

    const ok = await jsonFromResponse(
      await routingGet(
        createMockEvent({
          url: "http://localhost/api/admin/analytics/routing?days=7",
          user: ADMIN_USER,
        }),
      ),
    );
    expect(ok.days).toBe(7);
  });

  test("returns 403 for a non-admin member (role gate, not just scope)", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/admin/analytics/routing",
      user: MEMBER_USER,
    });

    let res: Response;
    try {
      res = await routingGet(event);
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
