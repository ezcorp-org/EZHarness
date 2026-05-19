/**
 * Server-handler unit tests for /api/admin/analytics/+server.ts.
 *
 * Auth + role gates plus the days-clamping branch and a happy-path
 * walk through nine mocked analytics queries. The DB layer is mocked
 * so the test stays out of integration scope.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/analytics", () => ({
  getChatActivity: vi.fn(async () => []),
  getModelUsage: vi.fn(async () => []),
  getAgentStats: vi.fn(async () => ({ total: 0 })),
  getExtensionStats: vi.fn(async () => ({ total: 0 })),
  getUserStats: vi.fn(async () => ({ total: 0 })),
  getToolUsageByTool: vi.fn(async () => []),
  getToolUsageByAgent: vi.fn(async () => []),
  getToolUsageByUser: vi.fn(async () => []),
  getToolUsageByModel: vi.fn(async () => []),
}));

const queries = await import("$server/db/queries/analytics");
const { GET } = await import("../routes/api/admin/analytics/+server");

function makeEvent(href: string, locals: Record<string, unknown> = {}) {
	return { url: new URL(href), locals } as any;
}

async function expectThrownResponse(
	fn: () => Promise<Response> | Response,
	status: number,
): Promise<Response> {
	let res: Response | undefined;
	try {
		const out = await fn();
		res = out;
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(Response);
		res = thrown as Response;
	}
	expect(res).toBeInstanceOf(Response);
	expect(res!.status).toBe(status);
	return res!;
}

const adminLocals = {
	user: { id: "u1", email: "u@test.com", name: "U", role: "admin" },
};

describe("GET /api/admin/analytics", () => {
	beforeEach(() => {
		for (const fn of Object.values(queries)) {
			vi.mocked(fn as any).mockClear();
		}
	});

	test("rejects 401 when locals.user is missing", async () => {
		const res = await expectThrownResponse(
			() => GET(makeEvent("http://localhost/api/admin/analytics", {})),
			401,
		);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("rejects 403 when locals.user is non-admin", async () => {
		const member = { id: "u1", email: "u@test.com", name: "U", role: "member" };
		const res = await expectThrownResponse(
			() =>
				GET(
					makeEvent("http://localhost/api/admin/analytics", { user: member }),
				),
			403,
		);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("rejects 403 when apiKeyScopes lacks 'admin'", async () => {
		const res = await GET(
			makeEvent("http://localhost/api/admin/analytics", {
				apiKeyScopes: ["read", "chat"],
			}),
		);
		expect(res).toBeInstanceOf(Response);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("admin");
	});

	test("happy path: returns nested toolUsage shape and defaults to 30 days", async () => {
		const res = await GET(
			makeEvent("http://localhost/api/admin/analytics", adminLocals),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			chatActivity: unknown;
			modelUsage: unknown;
			agentStats: unknown;
			extensionStats: unknown;
			userStats: unknown;
			toolUsage: {
				byTool: unknown;
				byAgent: unknown;
				byUser: unknown;
				byModel: unknown;
			};
		};
		expect(body).toMatchObject({
			chatActivity: [],
			modelUsage: [],
			agentStats: { total: 0 },
			extensionStats: { total: 0 },
			userStats: { total: 0 },
			toolUsage: { byTool: [], byAgent: [], byUser: [], byModel: [] },
		});
		// Default days = 30 — passed to the four time-windowed queries
		expect(queries.getChatActivity).toHaveBeenCalledWith(30);
		expect(queries.getModelUsage).toHaveBeenCalledWith(30);
		expect(queries.getToolUsageByTool).toHaveBeenCalledWith(30);
		expect(queries.getToolUsageByAgent).toHaveBeenCalledWith(30);
		expect(queries.getToolUsageByUser).toHaveBeenCalledWith(30);
		expect(queries.getToolUsageByModel).toHaveBeenCalledWith(30);
		// Non-windowed queries take no args
		expect(queries.getAgentStats).toHaveBeenCalledWith();
		expect(queries.getExtensionStats).toHaveBeenCalledWith();
		expect(queries.getUserStats).toHaveBeenCalledWith();
	});

	test("happy path: respects custom days param within the 1..365 range", async () => {
		const res = await GET(
			makeEvent("http://localhost/api/admin/analytics?days=60", adminLocals),
		);
		expect(res.status).toBe(200);
		expect(queries.getChatActivity).toHaveBeenCalledWith(60);
		expect(queries.getToolUsageByTool).toHaveBeenCalledWith(60);
	});

	test("clamps days param above 365 down to 365", async () => {
		const res = await GET(
			makeEvent(
				"http://localhost/api/admin/analytics?days=99999",
				adminLocals,
			),
		);
		expect(res.status).toBe(200);
		expect(queries.getChatActivity).toHaveBeenCalledWith(365);
	});

	test("clamps negative days param up to 1", async () => {
		const res = await GET(
			makeEvent("http://localhost/api/admin/analytics?days=-5", adminLocals),
		);
		expect(res.status).toBe(200);
		// parseInt("-5") = -5, -5 || 30 = -5 (truthy), Math.max(-5, 1) = 1
		expect(queries.getChatActivity).toHaveBeenCalledWith(1);
	});

	test("days=0 falls back to default 30 (||-fallback truthiness)", async () => {
		// parseInt("0") = 0, 0 || 30 = 30, Math.max(30, 1) = 30 → expected 30
		const res = await GET(
			makeEvent("http://localhost/api/admin/analytics?days=0", adminLocals),
		);
		expect(res.status).toBe(200);
		expect(queries.getChatActivity).toHaveBeenCalledWith(30);
	});

	test("falls back to default 30 when days param is non-numeric", async () => {
		const res = await GET(
			makeEvent(
				"http://localhost/api/admin/analytics?days=abc",
				adminLocals,
			),
		);
		expect(res.status).toBe(200);
		expect(queries.getChatActivity).toHaveBeenCalledWith(30);
	});
});
