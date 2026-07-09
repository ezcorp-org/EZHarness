/**
 * Server-handler unit tests for /api/analytics/savings/project/[id]/+server.ts.
 *
 * Auth + scope gates, the fail-closed 404 on unknown projects, the
 * admin-vs-member scoping rule (admin sees the whole project; a member gets
 * ONLY their own conversations' slice), days clamping, and the exact response
 * contract. Query + project lookups are mocked — the math is
 * integration-tested in src/__tests__/savings-analytics.test.ts.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const CONTRACT_REPORT = {
	rangeDays: 30,
	stats: {
		cacheSavedUsd: 0.002085,
		cacheReadSavedUsd: 0.00216,
		cacheWriteSurchargeUsd: 0.000075,
		write1hPremiumUsd: 0,
		routingSavedUsd: 0.004125,
		tokensCachedRead: 1300,
		tokensCacheWritten: 100,
		cacheHitRate: null,
		turnsTotal: 7,
		turnsRouted: 1,
		turnsFailover: 0,
	},
	perModel: [],
	subscriptionProviders: [],
	estimated: true,
};

vi.mock("$server/db/queries/savings-analytics", () => ({
	getSavingsForProject: vi.fn(async () => CONTRACT_REPORT),
}));

vi.mock("$server/db/queries/projects", () => ({
	getProject: vi.fn(async (id: string) =>
		id === "p1" ? { id: "p1", name: "P1", path: "/tmp/p1" } : undefined,
	),
}));

const queries = await import("$server/db/queries/savings-analytics");
const projectQueries = await import("$server/db/queries/projects");
const { GET } = await import(
	"../routes/api/analytics/savings/project/[id]/+server"
);

function makeEvent(opts: { id?: string; days?: string; locals?: Record<string, unknown> }) {
	const id = opts.id ?? "p1";
	const qs = opts.days !== undefined ? `?days=${opts.days}` : "";
	return {
		url: new URL(`http://localhost/api/analytics/savings/project/${id}${qs}`),
		params: { id },
		locals: opts.locals ?? {},
	} as any;
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
	user: { id: "u-member", email: "m@test.com", name: "M", role: "member" },
};
const adminLocals = {
	user: { id: "u-admin", email: "a@test.com", name: "A", role: "admin" },
};

describe("GET /api/analytics/savings/project/[id]", () => {
	beforeEach(() => {
		vi.mocked(queries.getSavingsForProject).mockClear();
		vi.mocked(projectQueries.getProject).mockClear();
	});

	test("rejects 401 when unauthenticated", async () => {
		await expectThrownResponse(() => GET(makeEvent({ locals: {} })), 401);
		expect(queries.getSavingsForProject).not.toHaveBeenCalled();
	});

	test("rejects 403 when the API-key scope lacks 'read'", async () => {
		const res = await GET(
			makeEvent({ locals: { user: memberLocals.user, apiKeyScopes: ["chat"] } }),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { required?: string };
		expect(body.required).toBe("read");
		expect(queries.getSavingsForProject).not.toHaveBeenCalled();
	});

	test("404s fail-closed on an unknown project without touching the query module", async () => {
		const res = await GET(makeEvent({ id: "no-such-project", locals: memberLocals }));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Not found");
		expect(queries.getSavingsForProject).not.toHaveBeenCalled();
	});

	test("member: report is scoped to the member's OWN conversations in the project", async () => {
		const res = await GET(makeEvent({ locals: memberLocals }));
		expect(res.status).toBe(200);
		expect(queries.getSavingsForProject).toHaveBeenCalledWith("p1", 30, "u-member");
	});

	test("admin: whole-project aggregate (no user scoping)", async () => {
		const res = await GET(makeEvent({ locals: adminLocals }));
		expect(res.status).toBe(200);
		expect(queries.getSavingsForProject).toHaveBeenCalledWith("p1", 30, undefined);
	});

	test("returns the EXACT contract shape from the query module", async () => {
		const res = await GET(makeEvent({ locals: adminLocals }));
		const body = await res.json();
		expect(body).toEqual(CONTRACT_REPORT);
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
	});

	test("respects a custom days param within [1, 365]", async () => {
		await GET(makeEvent({ days: "60", locals: memberLocals }));
		expect(queries.getSavingsForProject).toHaveBeenCalledWith("p1", 60, "u-member");
	});

	test("clamps days above 365 down to 365", async () => {
		await GET(makeEvent({ days: "99999", locals: adminLocals }));
		expect(queries.getSavingsForProject).toHaveBeenCalledWith("p1", 365, undefined);
	});

	test("clamps negative days up to 1", async () => {
		await GET(makeEvent({ days: "-5", locals: adminLocals }));
		expect(queries.getSavingsForProject).toHaveBeenCalledWith("p1", 1, undefined);
	});

	test("days=0 and non-numeric days fall back to the 30-day default", async () => {
		await GET(makeEvent({ days: "0", locals: adminLocals }));
		expect(queries.getSavingsForProject).toHaveBeenCalledWith("p1", 30, undefined);
		await GET(makeEvent({ days: "abc", locals: adminLocals }));
		expect(queries.getSavingsForProject).toHaveBeenLastCalledWith("p1", 30, undefined);
	});

	test("non-Response errors from the query module propagate (500 path)", async () => {
		vi.mocked(queries.getSavingsForProject).mockRejectedValueOnce(new Error("boom"));
		await expect(GET(makeEvent({ locals: adminLocals }))).rejects.toThrow("boom");
	});
});
