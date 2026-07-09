/**
 * Server-handler unit tests for /api/analytics/savings/+server.ts.
 *
 * Auth + scope gates, the days-clamping branches, own-user scoping, and an
 * exact response-CONTRACT assertion (C2 builds the UI against this shape).
 * The query module is mocked — its math is integration-tested in
 * src/__tests__/savings-analytics.test.ts.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const CONTRACT_REPORT = {
	rangeDays: 30,
	stats: {
		cacheSavedUsd: -0.0125,
		cacheReadSavedUsd: 0.002,
		cacheWriteSurchargeUsd: 0.0145,
		write1hPremiumUsd: 0.012,
		routingSavedUsd: -0.018,
		tokensCachedRead: 800,
		tokensCacheWritten: 4100,
		cacheHitRate: 0.8,
		turnsTotal: 7,
		turnsRouted: 3,
		turnsFailover: 1,
	},
	perModel: [
		{
			provider: "anthropic",
			model: "claude-x",
			turns: 5,
			cacheSavedUsd: -0.0125,
			routingSavedUsd: -0.018,
			tokensCachedRead: 800,
			cacheHitRate: 0.8,
			estimated: true,
		},
	],
	subscriptionProviders: ["openai-codex"],
	estimated: true,
};

vi.mock("$server/db/queries/savings-analytics", () => ({
	getSavingsForUser: vi.fn(async () => CONTRACT_REPORT),
}));

const queries = await import("$server/db/queries/savings-analytics");
const { GET } = await import("../routes/api/analytics/savings/+server");

function makeEvent(href: string, locals: Record<string, unknown> = {}) {
	return { url: new URL(href), locals } as any;
}

async function expectThrownResponse(
	fn: () => Promise<Response> | Response,
	status: number,
): Promise<Response> {
	let res: Response | undefined;
	try {
		res = await fn();
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(Response);
		res = thrown as Response;
	}
	expect(res).toBeInstanceOf(Response);
	expect(res!.status).toBe(status);
	return res!;
}

const memberLocals = {
	user: { id: "u1", email: "u@test.com", name: "U", role: "member" },
};

describe("GET /api/analytics/savings", () => {
	beforeEach(() => {
		vi.mocked(queries.getSavingsForUser).mockClear();
	});

	test("rejects 401 when unauthenticated", async () => {
		const res = await expectThrownResponse(
			() => GET(makeEvent("http://localhost/api/analytics/savings", {})),
			401,
		);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
		expect(queries.getSavingsForUser).not.toHaveBeenCalled();
	});

	test("rejects 403 when the API-key scope lacks 'read'", async () => {
		const res = await GET(
			makeEvent("http://localhost/api/analytics/savings", {
				user: memberLocals.user,
				apiKeyScopes: ["chat"],
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("read");
		expect(queries.getSavingsForUser).not.toHaveBeenCalled();
	});

	test("allows a 'read'-scoped API key", async () => {
		const res = await GET(
			makeEvent("http://localhost/api/analytics/savings", {
				user: memberLocals.user,
				apiKeyScopes: ["read"],
			}),
		);
		expect(res.status).toBe(200);
	});

	test("happy path: returns the EXACT contract shape, scoped to the caller's own userId", async () => {
		const res = await GET(
			makeEvent("http://localhost/api/analytics/savings", memberLocals),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual(CONTRACT_REPORT);
		// Contract keys are exact — C2 builds against these.
		expect(Object.keys(body).sort()).toEqual(
			["estimated", "perModel", "rangeDays", "stats", "subscriptionProviders"].sort(),
		);
		expect(Object.keys(body.stats).sort()).toEqual(
			[
				"cacheSavedUsd",
				"cacheReadSavedUsd",
				"cacheWriteSurchargeUsd",
				"write1hPremiumUsd",
				"routingSavedUsd",
				"tokensCachedRead",
				"tokensCacheWritten",
				"cacheHitRate",
				"turnsTotal",
				"turnsRouted",
				"turnsFailover",
			].sort(),
		);
		expect(Object.keys(body.perModel[0]).sort()).toEqual(
			[
				"provider",
				"model",
				"turns",
				"cacheSavedUsd",
				"routingSavedUsd",
				"tokensCachedRead",
				"cacheHitRate",
				"estimated",
			].sort(),
		);
		// Own userId ONLY — there is no way to query another user's report.
		expect(queries.getSavingsForUser).toHaveBeenCalledWith("u1", 30);
	});

	test("respects a custom days param within [1, 365]", async () => {
		await GET(makeEvent("http://localhost/api/analytics/savings?days=60", memberLocals));
		expect(queries.getSavingsForUser).toHaveBeenCalledWith("u1", 60);
	});

	test("clamps days above 365 down to 365", async () => {
		await GET(makeEvent("http://localhost/api/analytics/savings?days=99999", memberLocals));
		expect(queries.getSavingsForUser).toHaveBeenCalledWith("u1", 365);
	});

	test("clamps negative days up to 1", async () => {
		await GET(makeEvent("http://localhost/api/analytics/savings?days=-5", memberLocals));
		expect(queries.getSavingsForUser).toHaveBeenCalledWith("u1", 1);
	});

	test("days=0 and non-numeric days fall back to the 30-day default", async () => {
		await GET(makeEvent("http://localhost/api/analytics/savings?days=0", memberLocals));
		expect(queries.getSavingsForUser).toHaveBeenCalledWith("u1", 30);
		await GET(makeEvent("http://localhost/api/analytics/savings?days=abc", memberLocals));
		expect(queries.getSavingsForUser).toHaveBeenLastCalledWith("u1", 30);
	});

	test("non-Response errors from the query module propagate (500 path)", async () => {
		vi.mocked(queries.getSavingsForUser).mockRejectedValueOnce(new Error("boom"));
		await expect(
			GET(makeEvent("http://localhost/api/analytics/savings", memberLocals)),
		).rejects.toThrow("boom");
	});
});
