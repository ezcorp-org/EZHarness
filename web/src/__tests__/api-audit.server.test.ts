/**
 * Phase 52.4 — server-handler tests for /api/audit (the global feed)
 * and /api/audit/stats. Both admin-only.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/audit-global", () => ({
	listGlobalAudit: vi.fn(),
	globalStats: vi.fn(),
}));

const { listGlobalAudit, globalStats } = await import("$server/db/queries/audit-global");
const { GET: feedGet } = await import("../routes/api/audit/+server.ts");
const { GET: statsGet } = await import("../routes/api/audit/stats/+server.ts");

function makeEvent(opts: {
	locals?: Record<string, unknown>;
	search?: string;
	path?: string;
}) {
	const path = opts.path ?? "/api/audit";
	const href = `http://localhost${path}${opts.search ?? ""}`;
	return {
		url: new URL(href),
		locals: opts.locals ?? {},
		params: {},
		request: new Request(href),
	} as any;
}

const adminUser = { id: "u-admin", email: "a@x", name: "admin", role: "admin" };
const regularUser = { id: "u", email: "u@x", name: "u", role: "user" };

describe("GET /api/audit", () => {
	beforeEach(() => {
		vi.mocked(listGlobalAudit).mockReset();
		vi.mocked(listGlobalAudit).mockResolvedValue({ entries: [], nextCursor: null });
	});

	test("unauthenticated → 401", async () => {
		let res: Response | undefined;
		try {
			await feedGet(makeEvent({ locals: {} }));
			expect.fail("should throw");
		} catch (thrown) {
			res = thrown as Response;
		}
		expect(res!.status).toBe(401);
	});

	test("non-admin → 403", async () => {
		let res: Response | undefined;
		try {
			await feedGet(makeEvent({ locals: { user: regularUser } }));
			expect.fail("should throw");
		} catch (thrown) {
			res = thrown as Response;
		}
		expect(res!.status).toBe(403);
	});

	test("API-key without admin scope → 403", async () => {
		const res = await feedGet(
			makeEvent({ locals: { user: adminUser, apiKeyScopes: ["read"] } }),
		);
		expect(res.status).toBe(403);
	});

	test("happy path forwards filter params", async () => {
		await feedGet(
			makeEvent({
				locals: { user: adminUser },
				search: "?extensionId=ext-1&capability=llm&denialOnly=true&search=foo&onBehalfOf=u-2&cursor=cur1&limit=42",
			}),
		);
		expect(vi.mocked(listGlobalAudit)).toHaveBeenCalledWith(
			expect.objectContaining({
				extensionId: "ext-1",
				capability: "llm",
				denialOnly: true,
				search: "foo",
				onBehalfOf: "u-2",
				cursor: "cur1",
				limit: 42,
			}),
		);
	});

	test("unknown capability silently dropped", async () => {
		await feedGet(
			makeEvent({ locals: { user: adminUser }, search: "?capability=evilSqlInjection" }),
		);
		expect(vi.mocked(listGlobalAudit)).toHaveBeenCalledWith(
			expect.objectContaining({ capability: undefined }),
		);
	});
});

describe("GET /api/audit/stats", () => {
	beforeEach(() => {
		vi.mocked(globalStats).mockReset();
		vi.mocked(globalStats).mockResolvedValue({
			windowMs: 86400000,
			denialCount: 0,
			totalCalls: 0,
			totalCostUsd: 0,
			topChattiest: [],
			topLlmSpenders: [],
		});
	});

	test("unauthenticated → 401", async () => {
		let res: Response | undefined;
		try {
			await statsGet(makeEvent({ locals: {}, path: "/api/audit/stats" }));
			expect.fail("should throw");
		} catch (thrown) {
			res = thrown as Response;
		}
		expect(res!.status).toBe(401);
	});

	test("non-admin → 403", async () => {
		let res: Response | undefined;
		try {
			await statsGet(makeEvent({ locals: { user: regularUser }, path: "/api/audit/stats" }));
			expect.fail("should throw");
		} catch (thrown) {
			res = thrown as Response;
		}
		expect(res!.status).toBe(403);
	});

	test("default range = 24h", async () => {
		await statsGet(makeEvent({ locals: { user: adminUser }, path: "/api/audit/stats" }));
		expect(vi.mocked(globalStats)).toHaveBeenCalledWith(24 * 60 * 60 * 1000);
	});

	test("range=7d → 7 days", async () => {
		await statsGet(
			makeEvent({ locals: { user: adminUser }, path: "/api/audit/stats", search: "?range=7d" }),
		);
		expect(vi.mocked(globalStats)).toHaveBeenCalledWith(7 * 24 * 60 * 60 * 1000);
	});
});
