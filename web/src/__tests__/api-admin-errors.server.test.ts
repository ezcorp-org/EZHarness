/**
 * Server-handler unit tests for /api/admin/errors/+server.ts.
 *
 * Auth + role + scope gates plus the limit/offset clamping branches and
 * a happy-path walk through `listErrors` + `countErrors`. The DB layer
 * is mocked so the test stays out of integration scope.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/error-logs", () => ({
  listErrors: vi.fn(async () => []),
  countErrors: vi.fn(async () => 0),
}));

const { listErrors, countErrors } = await import(
  "$server/db/queries/error-logs"
);
const { GET } = await import("../routes/api/admin/errors/+server");

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

describe("GET /api/admin/errors", () => {
	beforeEach(() => {
		vi.mocked(listErrors).mockClear();
		vi.mocked(countErrors).mockClear();
		vi.mocked(listErrors).mockResolvedValue([] as any);
		vi.mocked(countErrors).mockResolvedValue(0 as any);
	});

	test("rejects 401 when locals.user is missing", async () => {
		const res = await expectThrownResponse(
			() => GET(makeEvent("http://localhost/api/admin/errors", {})),
			401,
		);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("rejects 403 when locals.user is non-admin", async () => {
		const member = { id: "u1", email: "u@test.com", name: "U", role: "member" };
		const res = await expectThrownResponse(
			() => GET(makeEvent("http://localhost/api/admin/errors", { user: member })),
			403,
		);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("rejects 403 when apiKeyScopes lacks 'admin'", async () => {
		const res = await GET(
			makeEvent("http://localhost/api/admin/errors", {
				apiKeyScopes: ["chat"],
			}),
		);
		expect(res).toBeInstanceOf(Response);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("admin");
	});

	test("happy path: returns errors + total with default pagination", async () => {
		vi.mocked(listErrors).mockResolvedValue([
			{ id: "e1", level: "error", message: "boom" },
		] as any);
		vi.mocked(countErrors).mockResolvedValue(1 as any);
		const res = await GET(
			makeEvent("http://localhost/api/admin/errors", adminLocals),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			errors: Array<{ id: string }>;
			total: number;
		};
		expect(body.total).toBe(1);
		expect(body.errors).toHaveLength(1);
		expect(body.errors[0]!.id).toBe("e1");
		// Defaults: limit=100, offset=0
		expect(listErrors).toHaveBeenCalledWith({ limit: 100, offset: 0 });
		expect(countErrors).toHaveBeenCalledWith();
	});

	test("respects custom limit + offset within range", async () => {
		const res = await GET(
			makeEvent(
				"http://localhost/api/admin/errors?limit=25&offset=50",
				adminLocals,
			),
		);
		expect(res.status).toBe(200);
		expect(listErrors).toHaveBeenCalledWith({ limit: 25, offset: 50 });
	});

	test("clamps limit above 500 down to 500", async () => {
		const res = await GET(
			makeEvent(
				"http://localhost/api/admin/errors?limit=99999",
				adminLocals,
			),
		);
		expect(res.status).toBe(200);
		expect(listErrors).toHaveBeenCalledWith({ limit: 500, offset: 0 });
	});

	test("clamps negative limit up to 1", async () => {
		const res = await GET(
			makeEvent(
				"http://localhost/api/admin/errors?limit=-10",
				adminLocals,
			),
		);
		expect(res.status).toBe(200);
		// parseInt("-10")=-10, -10 || 100 = -10 (truthy), Math.max(-10, 1) = 1
		expect(listErrors).toHaveBeenCalledWith({ limit: 1, offset: 0 });
	});

	test("clamps negative offset up to 0", async () => {
		const res = await GET(
			makeEvent(
				"http://localhost/api/admin/errors?offset=-5",
				adminLocals,
			),
		);
		expect(res.status).toBe(200);
		expect(listErrors).toHaveBeenCalledWith({ limit: 100, offset: 0 });
	});

	test("non-numeric limit falls back to default 100", async () => {
		const res = await GET(
			makeEvent(
				"http://localhost/api/admin/errors?limit=abc",
				adminLocals,
			),
		);
		expect(res.status).toBe(200);
		expect(listErrors).toHaveBeenCalledWith({ limit: 100, offset: 0 });
	});
});
