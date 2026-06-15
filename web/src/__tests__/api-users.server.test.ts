/**
 * Server-handler unit tests for GET /api/users/+server.ts (Settings v2
 * opt-in pagination).
 *
 * Contract (locked decision 1):
 *   - NO `limit` param → full list `{ users }`, unchanged (TeamsSection +
 *     other consumers depend on this).
 *   - `limit` present → `{ users: <page>, total }`, with `offset`/`q`
 *     forwarded to the paged query; params validated (400 on garbage).
 *   - admin-role + admin-scope gated.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
	listUsers: vi.fn(async () => []),
	listUsersPage: vi.fn(async () => ({ users: [], total: 0 })),
}));

const { listUsers, listUsersPage } = await import("$server/db/queries/users");
const { GET } = await import("../routes/api/users/+server");

function makeEvent(opts: { search?: string; locals?: Record<string, unknown> }) {
	const url = `http://localhost/api/users${opts.search ?? ""}`;
	return {
		url: new URL(url),
		locals: opts.locals ?? {},
		request: new Request(url),
	} as any;
}

const admin = { user: { id: "a1", email: "a@x", name: "A", role: "admin" } };

function mkUser(i: number) {
	return {
		id: `u${i}`,
		name: `User ${i}`,
		email: `user${i}@x`,
		role: "member",
		status: "active",
		passwordHash: "secret-hash",
	};
}

async function expectThrown(fn: () => Promise<Response> | Response, status: number) {
	let res: Response | undefined;
	try {
		res = await fn();
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(Response);
		res = thrown as Response;
	}
	expect(res!.status).toBe(status);
	return res!;
}

describe("GET /api/users", () => {
	beforeEach(() => {
		vi.mocked(listUsers).mockReset().mockResolvedValue([]);
		vi.mocked(listUsersPage).mockReset().mockResolvedValue({ users: [], total: 0 });
	});

	test("rejects 401 when unauthenticated", async () => {
		await expectThrown(() => GET(makeEvent({})), 401);
	});

	test("rejects 403 when caller is not admin", async () => {
		await expectThrown(
			() => GET(makeEvent({ locals: { user: { id: "m", email: "m@x", name: "M", role: "member" } } })),
			403,
		);
	});

	test("rejects 403 when API-key lacks 'admin' scope", async () => {
		const res = await GET(makeEvent({ locals: { ...admin, apiKeyScopes: ["read"] } }));
		expect(res.status).toBe(403);
	});

	describe("no `limit` param → unchanged full-list contract", () => {
		test("returns the full list as { users } and never pages", async () => {
			vi.mocked(listUsers).mockResolvedValue([mkUser(1), mkUser(2)] as any);
			const res = await GET(makeEvent({ locals: admin }));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { users: unknown[]; total?: number };
			expect(body.users).toHaveLength(2);
			expect(body.total).toBeUndefined();
			expect(listUsersPage).not.toHaveBeenCalled();
		});

		test("strips passwordHash", async () => {
			vi.mocked(listUsers).mockResolvedValue([mkUser(1)] as any);
			const res = await GET(makeEvent({ locals: admin }));
			const body = (await res.json()) as { users: Array<Record<string, unknown>> };
			expect(body.users[0]).not.toHaveProperty("passwordHash");
			expect(body.users[0]).toMatchObject({ id: "u1", email: "user1@x" });
		});

		test("ignores offset/q when limit is absent (full-list contract)", async () => {
			await GET(makeEvent({ search: "?offset=5&q=alice", locals: admin }));
			expect(listUsers).toHaveBeenCalledTimes(1);
			expect(listUsersPage).not.toHaveBeenCalled();
		});
	});

	describe("`limit` present → opt-in paging", () => {
		test("returns { users, total } and forwards limit/offset/q", async () => {
			vi.mocked(listUsersPage).mockResolvedValue({ users: [mkUser(3)] as any, total: 42 });
			const res = await GET(makeEvent({ search: "?limit=20&offset=20&q=Alice", locals: admin }));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { users: unknown[]; total: number };
			expect(body.total).toBe(42);
			expect(body.users).toHaveLength(1);
			expect(listUsersPage).toHaveBeenCalledWith({ limit: 20, offset: 20, q: "Alice" });
			expect(listUsers).not.toHaveBeenCalled();
		});

		test("strips passwordHash from the page", async () => {
			vi.mocked(listUsersPage).mockResolvedValue({ users: [mkUser(3)] as any, total: 1 });
			const res = await GET(makeEvent({ search: "?limit=10", locals: admin }));
			const body = (await res.json()) as { users: Array<Record<string, unknown>> };
			expect(body.users[0]).not.toHaveProperty("passwordHash");
		});

		test("omits q when blank/whitespace", async () => {
			await GET(makeEvent({ search: "?limit=10&q=%20%20", locals: admin }));
			expect(listUsersPage).toHaveBeenCalledWith({ limit: 10, offset: 0, q: undefined });
		});

		test("defaults offset to 0 when absent", async () => {
			await GET(makeEvent({ search: "?limit=10", locals: admin }));
			expect(listUsersPage).toHaveBeenCalledWith({ limit: 10, offset: 0, q: undefined });
		});

		test("clamps limit to the MAX_LIMIT (100)", async () => {
			await GET(makeEvent({ search: "?limit=5000", locals: admin }));
			expect(listUsersPage).toHaveBeenCalledWith({ limit: 100, offset: 0, q: undefined });
		});
	});

	describe("param validation", () => {
		test("400 on non-numeric limit", async () => {
			const res = await GET(makeEvent({ search: "?limit=abc", locals: admin }));
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toMatch(/limit/);
			expect(listUsersPage).not.toHaveBeenCalled();
		});

		test("400 on limit=0 (must be positive)", async () => {
			const res = await GET(makeEvent({ search: "?limit=0", locals: admin }));
			expect(res.status).toBe(400);
		});

		test("400 on negative limit", async () => {
			const res = await GET(makeEvent({ search: "?limit=-5", locals: admin }));
			expect(res.status).toBe(400);
		});

		test("400 on non-numeric offset", async () => {
			const res = await GET(makeEvent({ search: "?limit=10&offset=xyz", locals: admin }));
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toMatch(/offset/);
		});

		test("400 on negative offset", async () => {
			const res = await GET(makeEvent({ search: "?limit=10&offset=-1", locals: admin }));
			expect(res.status).toBe(400);
		});
	});
});
