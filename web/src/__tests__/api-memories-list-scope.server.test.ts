/**
 * Regression tests for the per-user scoping of GET /api/memories.
 *
 * Security bug (cross-user PII disclosure): the list handler previously
 * discarded the authenticated user and called `searchMemories` with NO
 * `userId` filter ("memories are org-wide"), so any authenticated non-admin
 * saw EVERY user's memories. That contradicts the established per-user-PII
 * model enforced on the single-row routes (`[id]/+server.ts`, sec-H3:
 * cross-user + unowned rows are 404/admin-only) and the injection path.
 *
 * The fix mirrors the single-row rule: a non-admin sees ONLY memories they
 * own (never another user's rows, never unowned/null-userId rows); an admin
 * keeps the full org-wide management view.
 *
 * These tests mock the query layer so `searchMemories` simulates the DB
 * `eq(memories.userId, …)` filter, then assert on the RESPONSE BODY — the
 * leaked content of other users must be absent — mirroring the sec-H3 IDOR
 * test style on the sibling `[id]` route.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const mockSearchMemories = vi.fn();
const mockGetProjectIdsForMemories = vi.fn();
// The route statically imports these five names from the query module. The
// factory must expose all of them (even the unused stubs) so the loader does
// not resolve against the real source module. Only `searchMemories` and
// `getProjectIdsForMemories` are exercised by the GET handler.
vi.mock("$server/db/queries/memories", () => ({
	insertMemory: vi.fn(),
	updateMemory: vi.fn(),
	searchMemories: mockSearchMemories,
	getMemoryProjectIds: vi.fn(),
	getProjectIdsForMemories: mockGetProjectIdsForMemories,
}));

const { GET } = await import("../routes/api/memories/+server");

// Two distinct users' private memories plus an unowned (null userId) orphan.
// The `content` strings are the PII the leak would expose — assertions pin
// their presence/absence in the response body.
const MEM_A = {
	id: "mem-a",
	userId: "user-a",
	content: "USER_A_PRIVATE_SECRET",
	category: "biographical",
	confidence: "high",
	status: "active",
	injectionEligible: true,
	projectId: null,
	conversationId: null,
	messageIds: null,
	provenance: null,
	lastAccessedAt: new Date("2026-05-01T00:00:00.000Z"),
	createdAt: new Date("2026-04-01T00:00:00.000Z"),
	updatedAt: new Date("2026-04-15T00:00:00.000Z"),
};
const MEM_B = { ...MEM_A, id: "mem-b", userId: "user-b", content: "USER_B_PRIVATE_SECRET" };
const MEM_UNOWNED = { ...MEM_A, id: "mem-unowned", userId: null, content: "UNOWNED_ORPHAN_SECRET" };
const ALL = [MEM_A, MEM_B, MEM_UNOWNED];

const USER_A = { id: "user-a", email: "a@x", name: "A", role: "user" };
const USER_B = { id: "user-b", email: "b@x", name: "B", role: "user" };
const ADMIN = { id: "admin-1", email: "admin@x", name: "Admin", role: "admin" };

function makeGetEvent(user: Record<string, unknown>) {
	// Cookie session (no `apiKeyScopes`) → `requireScope("read")` passes.
	return {
		url: new URL("http://localhost/api/memories"),
		locals: { user },
		request: new Request("http://localhost/api/memories", { method: "GET" }),
	} as any;
}

beforeEach(() => {
	mockSearchMemories.mockReset();
	mockGetProjectIdsForMemories.mockReset();
	// Simulate the DB `userId` filter: `eq(memories.userId, opts.userId)`
	// matches only rows with that exact owner (null-userId rows never match),
	// while an absent `userId` returns everything (admin org-wide view).
	mockSearchMemories.mockImplementation(async (opts?: { userId?: string }) => {
		if (opts?.userId === undefined) return ALL;
		return ALL.filter((m) => m.userId === opts.userId);
	});
	mockGetProjectIdsForMemories.mockResolvedValue(new Map<string, string[]>());
});

describe("GET /api/memories — per-user PII scoping", () => {
	test("non-admin does NOT receive another user's memories (nor unowned rows)", async () => {
		const res = await GET(makeGetEvent(USER_B));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ id: string; content: string }>;
		const ids = body.map((m) => m.id);

		// Sees own row, none of user A's, none of the unowned orphan.
		expect(ids).toContain("mem-b");
		expect(ids).not.toContain("mem-a");
		expect(ids).not.toContain("mem-unowned");

		// The leaked *content* of other principals must be entirely absent
		// from the serialized body (the sec-H3 IDOR assertion style).
		const wire = JSON.stringify(body);
		expect(wire).not.toContain("USER_A_PRIVATE_SECRET");
		expect(wire).not.toContain("UNOWNED_ORPHAN_SECRET");
		expect(wire).toContain("USER_B_PRIVATE_SECRET");

		// Wiring proof: the handler scoped the query to the acting user.
		expect(mockSearchMemories).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-b" }),
		);
	});

	test("non-admin receives their OWN memories", async () => {
		const res = await GET(makeGetEvent(USER_A));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ id: string; content: string }>;
		expect(body.map((m) => m.id)).toEqual(["mem-a"]);
		expect(JSON.stringify(body)).toContain("USER_A_PRIVATE_SECRET");
		expect(mockSearchMemories).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-a" }),
		);
	});

	test("admin receives ALL memories (org-wide management view, incl. unowned)", async () => {
		const res = await GET(makeGetEvent(ADMIN));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ id: string; content: string }>;
		expect(body.map((m) => m.id)).toEqual(
			expect.arrayContaining(["mem-a", "mem-b", "mem-unowned"]),
		);

		const wire = JSON.stringify(body);
		expect(wire).toContain("USER_A_PRIVATE_SECRET");
		expect(wire).toContain("USER_B_PRIVATE_SECRET");
		expect(wire).toContain("UNOWNED_ORPHAN_SECRET");

		// Admin path passes NO userId filter — the org-wide query is unchanged.
		const lastCall = mockSearchMemories.mock.calls.at(-1)![0] as { userId?: string };
		expect(lastCall.userId).toBeUndefined();
	});
});
