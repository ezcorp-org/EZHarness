/**
 * Server-handler unit tests for GET /api/runs (the run LIST endpoint).
 *
 * Focus: the per-user ownership scope (cross-tenant IDOR guard). A non-admin
 * may only list their OWN runs; an admin lists all. Mocks getExecutor at the
 * $lib/server/context boundary; requireScope/requireAuth run for real.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const mockListRuns = vi.fn();

vi.mock("$lib/server/context", () => ({
	getExecutor: () => ({ listRuns: mockListRuns }),
}));

const { GET } = await import("../routes/api/runs/+server.ts");

function makeEvent(opts: { locals?: Record<string, unknown>; projectId?: string }) {
	const u = new URL("http://x/api/runs");
	if (opts.projectId) u.searchParams.set("projectId", opts.projectId);
	return { url: u, locals: opts.locals ?? {} } as any;
}

describe("GET /api/runs (list — per-user IDOR scope)", () => {
	beforeEach(() => {
		mockListRuns.mockReset();
		mockListRuns.mockResolvedValue([]);
	});

	test("403 when the API key lacks 'read' scope", async () => {
		const res = await GET(
			makeEvent({ locals: { apiKeyScopes: ["chat"], user: { id: "u", role: "member" } } }),
		);
		expect(res.status).toBe(403);
		expect(mockListRuns).not.toHaveBeenCalled();
	});

	test("401 when unauthenticated", async () => {
		let res: Response | undefined;
		try {
			await GET(makeEvent({ locals: {} }));
			expect.fail("should have thrown");
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res!.status).toBe(401);
		expect(mockListRuns).not.toHaveBeenCalled();
	});

	test("non-admin: listing is scoped to the caller's own userId", async () => {
		await GET(makeEvent({ locals: { user: { id: "u9", role: "member" } }, projectId: "p1" }));
		expect(mockListRuns).toHaveBeenCalledWith("p1", "u9");
	});

	test("admin: lists ALL runs (no per-user scope)", async () => {
		await GET(makeEvent({ locals: { user: { id: "admin1", role: "admin" } } }));
		expect(mockListRuns).toHaveBeenCalledWith(undefined, undefined);
	});
});
