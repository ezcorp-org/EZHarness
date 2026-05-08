/**
 * Server-handler tests for /api/extensions/[id]/audit/stats.
 *
 * Covers:
 *   - 401 / 403 / scope-403 auth gates (regression).
 *   - 404 on unknown extension.
 *   - default range=24h passes 24*60*60*1000 ms.
 *   - range=7d / range=30d compute the right window.
 *   - unknown range silently falls back to 24h.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/extensions", () => ({
	getExtension: vi.fn(),
}));

vi.mock("$server/db/queries/audit-merge", () => ({
	statsForExtension: vi.fn(),
}));

const { getExtension } = await import("$server/db/queries/extensions");
const { statsForExtension } = await import("$server/db/queries/audit-merge");
const { GET } = await import(
	"../routes/api/extensions/[id]/audit/stats/+server.ts"
);

function makeEvent(opts: {
	id?: string;
	locals?: Record<string, unknown>;
	search?: string;
}) {
	const id = opts.id ?? "ext-1";
	const href = `http://localhost/api/extensions/${id}/audit/stats${opts.search ?? ""}`;
	return {
		url: new URL(href),
		locals: opts.locals ?? {},
		params: { id },
		request: new Request(href),
	} as any;
}

const adminUser = { id: "u1", email: "a@x", name: "a", role: "admin" };
const regularUser = { id: "u2", email: "u@x", name: "u", role: "user" };

describe("GET /api/extensions/[id]/audit/stats", () => {
	beforeEach(() => {
		vi.mocked(getExtension).mockReset();
		vi.mocked(statsForExtension).mockReset();
		vi.mocked(statsForExtension).mockResolvedValue({
			totalCalls: 0,
			totalCostUsd: 0,
			successRate: 0,
			denialCount: 0,
		});
	});

	test("unauthenticated request throws 401", async () => {
		let res: Response | undefined;
		try {
			await GET(makeEvent({ locals: {} }));
			expect.fail("should have thrown");
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res!.status).toBe(401);
	});

	test("non-admin authenticated user throws 403", async () => {
		let res: Response | undefined;
		try {
			await GET(makeEvent({ locals: { user: regularUser } }));
			expect.fail("should have thrown");
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res!.status).toBe(403);
	});

	test("API-key scope check returns 403 when scope missing", async () => {
		const res = await GET(
			makeEvent({ locals: { user: adminUser, apiKeyScopes: ["read"] } }),
		);
		expect(res.status).toBe(403);
	});

	test("unknown extension returns 404", async () => {
		vi.mocked(getExtension).mockResolvedValue(null as any);
		const res = await GET(makeEvent({ locals: { user: adminUser } }));
		expect(res.status).toBe(404);
	});

	test("default range = 24h", async () => {
		vi.mocked(getExtension).mockResolvedValue({ id: "ext-1" } as any);
		await GET(makeEvent({ locals: { user: adminUser } }));
		expect(vi.mocked(statsForExtension)).toHaveBeenCalledWith(
			"ext-1",
			24 * 60 * 60 * 1000,
		);
	});

	test("range=7d → 7 days", async () => {
		vi.mocked(getExtension).mockResolvedValue({ id: "ext-1" } as any);
		await GET(makeEvent({ locals: { user: adminUser }, search: "?range=7d" }));
		expect(vi.mocked(statsForExtension)).toHaveBeenCalledWith(
			"ext-1",
			7 * 24 * 60 * 60 * 1000,
		);
	});

	test("unknown range silently falls back to 24h", async () => {
		vi.mocked(getExtension).mockResolvedValue({ id: "ext-1" } as any);
		await GET(
			makeEvent({ locals: { user: adminUser }, search: "?range=evil" }),
		);
		expect(vi.mocked(statsForExtension)).toHaveBeenCalledWith(
			"ext-1",
			24 * 60 * 60 * 1000,
		);
	});
});
