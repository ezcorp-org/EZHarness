/**
 * Server-handler unit tests for /api/marketplace/[id]/flags (+server.ts).
 *
 * Covers admin gating (GET + PATCH throw 401/403), scope checks, validation
 * 400, GET happy path returning the flag list, and PATCH happy paths
 * (action=dismissed and action=removed) verifying resolveFlag +
 * insertAuditEntry side-effects.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/marketplace-ratings", () => ({
	getFlagHistory: vi.fn(),
	resolveFlag: vi.fn(async () => undefined),
}));

vi.mock("$server/db/queries/audit-log", () => ({
	insertAuditEntry: vi.fn(async () => undefined),
}));

const { getFlagHistory, resolveFlag } = await import(
	"$server/db/queries/marketplace-ratings"
);
const { insertAuditEntry } = await import("$server/db/queries/audit-log");
const { GET, PATCH } = await import(
	"../routes/api/marketplace/[id]/flags/+server.ts"
);

function makeEvent(opts: {
	method?: "GET" | "PATCH";
	body?: unknown;
	locals?: Record<string, unknown>;
	id?: string;
}) {
	const id = opts.id ?? "abc";
	const method = opts.method ?? "GET";
	return {
		url: new URL(`http://localhost/api/marketplace/${id}/flags`),
		locals: opts.locals ?? {},
		params: { id },
		request: new Request(`http://localhost/api/marketplace/${id}/flags`, {
			method,
			headers: { "Content-Type": "application/json" },
			body: method === "GET" ? undefined : JSON.stringify(opts.body ?? {}),
		}),
	} as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };
const adminUser = { id: "admin-1", email: "a@x", name: "a", role: "admin" };

describe("GET /api/marketplace/[id]/flags", () => {
	beforeEach(() => {
		vi.mocked(getFlagHistory).mockReset();
	});

	test("unauthenticated request throws 401 Response", async () => {
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

	test("non-admin authenticated request throws 403 Response", async () => {
		let res: Response | undefined;
		try {
			await GET(makeEvent({ locals: { user } }));
			expect.fail("should have thrown");
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res!.status).toBe(403);
		const body = (await res!.json()) as { error?: string };
		expect(body.error).toBe("Insufficient permissions");
	});

	test("API-key scope check returns 403 when 'admin' missing", async () => {
		const res = await GET(
			makeEvent({
				locals: { user: adminUser, apiKeyScopes: ["read"] },
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.required).toBe("admin");
	});

	test("happy path: returns flag history wrapped in { flags }", async () => {
		const flagRows = [
			{ id: "f1", reason: "spam", createdAt: new Date() },
			{ id: "f2", reason: "abuse", createdAt: new Date() },
		];
		vi.mocked(getFlagHistory).mockResolvedValue(flagRows as any);
		const res = await GET(makeEvent({ locals: { user: adminUser } }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { flags: unknown[] };
		expect(body.flags).toHaveLength(2);
		expect(vi.mocked(getFlagHistory)).toHaveBeenCalledWith("abc");
	});
});

describe("PATCH /api/marketplace/[id]/flags", () => {
	beforeEach(() => {
		vi.mocked(resolveFlag).mockReset();
		vi.mocked(insertAuditEntry).mockReset();
	});

	test("admin + invalid body returns 400 via errorJson", async () => {
		const res = await PATCH(
			makeEvent({
				method: "PATCH",
				body: { flagId: "", action: "bogus" },
				locals: { user: adminUser },
			}),
		);
		expect(res).toBeInstanceOf(Response);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe(
			"flagId and action ('dismissed' | 'removed') are required",
		);
		expect(vi.mocked(resolveFlag)).not.toHaveBeenCalled();
	});

	test("non-admin PATCH throws 403 Response", async () => {
		let res: Response | undefined;
		try {
			await PATCH(
				makeEvent({
					method: "PATCH",
					body: { flagId: "f1", action: "dismissed" },
					locals: { user },
				}),
			);
			expect.fail("should have thrown");
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res!.status).toBe(403);
	});

	test("happy path action=dismissed: resolves flag and writes audit entry", async () => {
		const res = await PATCH(
			makeEvent({
				method: "PATCH",
				body: { flagId: "f1", action: "dismissed" },
				locals: { user: adminUser },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok?: boolean };
		expect(body.ok).toBe(true);
		// Side-effects
		expect(vi.mocked(resolveFlag)).toHaveBeenCalledWith(
			"f1",
			adminUser.id,
			"dismissed",
		);
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalledWith(
			adminUser.id,
			"marketplace:flag:dismissed",
			"abc",
			{ flagId: "f1" },
		);
	});

	test("happy path action=removed: audit suffix matches action", async () => {
		const res = await PATCH(
			makeEvent({
				method: "PATCH",
				body: { flagId: "f2", action: "removed" },
				locals: { user: adminUser },
			}),
		);
		expect(res.status).toBe(200);
		expect(vi.mocked(resolveFlag)).toHaveBeenCalledWith(
			"f2",
			adminUser.id,
			"removed",
		);
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalledWith(
			adminUser.id,
			"marketplace:flag:removed",
			"abc",
			{ flagId: "f2" },
		);
	});
});
