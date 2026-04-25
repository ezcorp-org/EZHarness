/**
 * Server-handler unit tests for /api/admin/system/+server.ts.
 *
 * Auth + role + scope gates plus a happy-path walk through the three
 * mocked analytics queries (system health / activity feed / error
 * summary). The DB layer is mocked so the test stays out of integration
 * scope.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/analytics", () => ({
  getSystemHealth: vi.fn(async () => ({ status: "ok", db: "up" })),
  getActivityFeed: vi.fn(async () => []),
  getErrorSummary: vi.fn(async () => ({ total: 0, last24h: 0 })),
}));

const { getSystemHealth, getActivityFeed, getErrorSummary } = await import(
  "$server/db/queries/analytics"
);
const { GET } = await import("../routes/api/admin/system/+server");

function makeEvent(locals: Record<string, unknown> = {}) {
	return {
		url: new URL("http://localhost/api/admin/system"),
		locals,
	} as any;
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

describe("GET /api/admin/system", () => {
	beforeEach(() => {
		vi.mocked(getSystemHealth).mockClear();
		vi.mocked(getActivityFeed).mockClear();
		vi.mocked(getErrorSummary).mockClear();
		vi.mocked(getSystemHealth).mockResolvedValue({
			status: "ok",
			db: "up",
		} as any);
		vi.mocked(getActivityFeed).mockResolvedValue([] as any);
		vi.mocked(getErrorSummary).mockResolvedValue({
			total: 0,
			last24h: 0,
		} as any);
	});

	test("rejects 401 when locals.user is missing", async () => {
		const res = await expectThrownResponse(() => GET(makeEvent({})), 401);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("rejects 403 when locals.user is non-admin", async () => {
		const member = { id: "u1", email: "u@test.com", name: "U", role: "member" };
		const res = await expectThrownResponse(
			() => GET(makeEvent({ user: member })),
			403,
		);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("rejects 403 when apiKeyScopes lacks 'admin'", async () => {
		const res = await GET(
			makeEvent({ apiKeyScopes: ["read", "chat"] }),
		);
		expect(res).toBeInstanceOf(Response);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("admin");
	});

	test("happy path: fans out to all three queries and returns combined shape", async () => {
		vi.mocked(getSystemHealth).mockResolvedValue({
			status: "ok",
			db: "up",
			cache: "warm",
		} as any);
		vi.mocked(getActivityFeed).mockResolvedValue([
			{ id: "a1", kind: "chat" },
		] as any);
		vi.mocked(getErrorSummary).mockResolvedValue({
			total: 5,
			last24h: 1,
		} as any);

		const res = await GET(makeEvent(adminLocals));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			health: { status: string; db: string; cache: string };
			activityFeed: Array<{ id: string }>;
			errorSummary: { total: number; last24h: number };
		};
		expect(body.health.status).toBe("ok");
		expect(body.health.cache).toBe("warm");
		expect(body.activityFeed).toHaveLength(1);
		expect(body.activityFeed[0]!.id).toBe("a1");
		expect(body.errorSummary).toEqual({ total: 5, last24h: 1 });
		// All three queries fan out in parallel — each called exactly once
		expect(getSystemHealth).toHaveBeenCalledTimes(1);
		expect(getActivityFeed).toHaveBeenCalledTimes(1);
		expect(getErrorSummary).toHaveBeenCalledTimes(1);
	});

	test("propagates query rejection as a 500 (caught by SvelteKit boundary)", async () => {
		vi.mocked(getSystemHealth).mockRejectedValue(new Error("db down"));
		await expect(GET(makeEvent(adminLocals))).rejects.toThrow("db down");
	});
});
