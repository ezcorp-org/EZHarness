/**
 * Server-handler tests for /api/conversations/[id]/audit (+server.ts).
 *
 * Phase 52.3 — owner-only access to the per-conversation audit
 * timeline. Covers:
 *   - 401 unauthenticated.
 *   - 403 (via scope) when API-key lacks "read".
 *   - 404 on unknown conversation.
 *   - 404 on non-owner (sec-H3 fail-closed).
 *   - admin can read any conversation (mirrors the
 *     verifyConversationOwnership pattern).
 *   - happy path returns merged entries + nextCursor.
 *   - filter forwarding (capability, status, since, until, cursor, limit).
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/conversations", () => ({
	getConversation: vi.fn(),
}));

vi.mock("$server/db/queries/audit-merge", () => ({
	mergeAuditForConversation: vi.fn(),
}));

const { getConversation } = await import("$server/db/queries/conversations");
const { mergeAuditForConversation } = await import("$server/db/queries/audit-merge");
const { GET } = await import(
	"../routes/api/conversations/[id]/audit/+server.ts"
);

function makeEvent(opts: {
	id?: string;
	locals?: Record<string, unknown>;
	search?: string;
}) {
	const id = opts.id ?? "conv-1";
	const href = `http://localhost/api/conversations/${id}/audit${opts.search ?? ""}`;
	return {
		url: new URL(href),
		locals: opts.locals ?? {},
		params: { id },
		request: new Request(href),
	} as any;
}

const ownerUser = { id: "u-owner", email: "o@x", name: "owner", role: "user" };
const otherUser = { id: "u-other", email: "x@x", name: "other", role: "user" };
const adminUser = { id: "u-admin", email: "a@x", name: "admin", role: "admin" };

describe("GET /api/conversations/[id]/audit", () => {
	beforeEach(() => {
		vi.mocked(getConversation).mockReset();
		vi.mocked(mergeAuditForConversation).mockReset();
		vi.mocked(mergeAuditForConversation).mockResolvedValue({ entries: [], nextCursor: null });
	});

	test("unauthenticated → 401", async () => {
		let res: Response | undefined;
		try {
			await GET(makeEvent({ locals: {} }));
			expect.fail("should throw");
		} catch (thrown) {
			res = thrown as Response;
		}
		expect(res!.status).toBe(401);
	});

	test("API-key with insufficient scope → 403", async () => {
		const res = await GET(
			makeEvent({ locals: { user: ownerUser, apiKeyScopes: [] } }),
		);
		expect(res.status).toBe(403);
	});

	test("unknown conversation → 404", async () => {
		vi.mocked(getConversation).mockResolvedValue(null as any);
		const res = await GET(makeEvent({ locals: { user: ownerUser } }));
		expect(res.status).toBe(404);
	});

	test("non-owner non-admin → 404 (fail-closed)", async () => {
		vi.mocked(getConversation).mockResolvedValue({ id: "conv-1", userId: "u-owner" } as any);
		const res = await GET(makeEvent({ locals: { user: otherUser } }));
		expect(res.status).toBe(404);
		expect(vi.mocked(mergeAuditForConversation)).not.toHaveBeenCalled();
	});

	test("admin can read any conversation", async () => {
		vi.mocked(getConversation).mockResolvedValue({ id: "conv-1", userId: "u-owner" } as any);
		vi.mocked(mergeAuditForConversation).mockResolvedValue({
			entries: [{ kind: "capability", id: "c1" } as any],
			nextCursor: null,
		});
		const res = await GET(makeEvent({ locals: { user: adminUser } }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { entries: unknown[] };
		expect(body.entries).toHaveLength(1);
	});

	test("owner happy path → 200 with merged entries", async () => {
		vi.mocked(getConversation).mockResolvedValue({ id: "conv-1", userId: ownerUser.id } as any);
		vi.mocked(mergeAuditForConversation).mockResolvedValue({
			entries: [{ kind: "capability", id: "c1" } as any],
			nextCursor: "cur-2",
		});
		const res = await GET(makeEvent({ locals: { user: ownerUser } }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { entries: unknown[]; nextCursor: string | null };
		expect(body.entries).toHaveLength(1);
		expect(body.nextCursor).toBe("cur-2");
	});

	test("forwards filter query params to the merger", async () => {
		vi.mocked(getConversation).mockResolvedValue({ id: "conv-1", userId: ownerUser.id } as any);
		await GET(
			makeEvent({
				locals: { user: ownerUser },
				search: "?capability=memory&status=denial&cursor=abc&limit=42",
			}),
		);
		expect(vi.mocked(mergeAuditForConversation)).toHaveBeenCalledWith(
			"conv-1",
			expect.objectContaining({
				capability: "memory",
				status: "denial",
				cursor: "abc",
				limit: 42,
			}),
		);
	});

	test("unowned conversation (userId=null) is admin-only", async () => {
		vi.mocked(getConversation).mockResolvedValue({ id: "conv-1", userId: null } as any);
		const res = await GET(makeEvent({ locals: { user: ownerUser } }));
		expect(res.status).toBe(404);
	});
});
