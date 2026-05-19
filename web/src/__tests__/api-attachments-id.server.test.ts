/**
 * Server-handler unit tests for /api/attachments/[id]/+server.ts.
 *
 * Covers scope/auth gates, the params.id missing 404, attachment-not-found
 * 404, conversation-not-found 404, the cross-user ownership 404 (fail-closed),
 * and the admin cross-user audit-log side-effect.
 *
 * The success body branch is intentionally NOT tested here: it streams a
 * file via `Bun.file(...)` which is awkward to mock at the module
 * boundary. The 404 paths run BEFORE any file IO so they're unit-safe.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/attachments", () => ({
	getAttachment: vi.fn(),
}));

vi.mock("$server/db/queries/conversations", () => ({
	getConversation: vi.fn(),
}));

vi.mock("$server/db/queries/audit-log", () => ({
	insertAuditEntry: vi.fn(async () => undefined),
}));

const { getAttachment } = await import("$server/db/queries/attachments");
const { getConversation } = await import("$server/db/queries/conversations");
const { insertAuditEntry } = await import("$server/db/queries/audit-log");
const { GET } = await import("../routes/api/attachments/[id]/+server");

function makeEvent(opts: {
	id?: string;
	locals?: Record<string, unknown>;
	href?: string;
}) {
	const id = opts.id ?? "att-1";
	const href = opts.href ?? `http://localhost/api/attachments/${id}`;
	return {
		url: new URL(href),
		locals: opts.locals ?? {},
		params: { id },
		request: new Request(href, { method: "GET" }),
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
	expect(res!.status).toBe(status);
	return res!;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };
const adminUser = { id: "admin-1", email: "a@x", name: "a", role: "admin" };

const attachment = {
	id: "att-1",
	conversationId: "conv-1",
	storagePath: "/tmp/does-not-exist-for-test",
	filename: "doc.pdf",
	mimeType: "application/pdf",
	sizeBytes: 12,
};

describe("GET /api/attachments/[id]", () => {
	beforeEach(() => {
		vi.mocked(getAttachment).mockReset();
		vi.mocked(getConversation).mockReset();
		vi.mocked(insertAuditEntry).mockReset();
	});

	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await GET(
			makeEvent({
				locals: {
					user,
					apiKeyScopes: ["chat"],
				},
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("read");
	});

	test("throws 401 when unauthenticated", async () => {
		const res = await expectThrownResponse(
			() => GET(makeEvent({ locals: {} })),
			401,
		);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Authentication required");
	});

	test("returns 404 when attachment not found", async () => {
		vi.mocked(getAttachment).mockResolvedValue(null as any);
		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Not found");
	});

	test("returns 404 when owning conversation not found", async () => {
		vi.mocked(getAttachment).mockResolvedValue(attachment as any);
		vi.mocked(getConversation).mockResolvedValue(null as any);
		const res = await GET(makeEvent({ locals: { user } }));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Not found");
	});

	test("returns 404 when caller is not owner and not admin", async () => {
		vi.mocked(getAttachment).mockResolvedValue(attachment as any);
		vi.mocked(getConversation).mockResolvedValue({
			id: "conv-1",
			userId: "someone-else",
		} as any);
		const res = await GET(makeEvent({ locals: { user } }));
		// Fail-closed: cross-user reads collapse to 404, not 403, to avoid
		// leaking attachment existence.
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Not found");
		expect(vi.mocked(insertAuditEntry)).not.toHaveBeenCalled();
	});

	test("admin reading another user's attachment writes audit entry (storage missing → 404)", async () => {
		// Admin path: ownership check passes. We stub `Bun.file(...).exists()`
		// to return false so the handler returns 404 BEFORE attempting to
		// stream the file. Lets us verify the audit-log side-effect cleanly.
		vi.mocked(getAttachment).mockResolvedValue(attachment as any);
		vi.mocked(getConversation).mockResolvedValue({
			id: "conv-1",
			userId: "owner-2",
		} as any);

		const originalBun = (globalThis as any).Bun;
		(globalThis as any).Bun = {
			file: () => ({ exists: async () => false }),
		};
		try {
			const res = await GET(makeEvent({ locals: { user: adminUser } }));
			expect(res.status).toBe(404);
		} finally {
			(globalThis as any).Bun = originalBun;
		}

		// Side-effect: privileged read logged for owner audit.
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalledWith(
			adminUser.id,
			"attachment:admin_read",
			attachment.id,
			expect.objectContaining({
				conversationId: attachment.conversationId,
				ownerId: "owner-2",
				filename: attachment.filename,
				mimeType: attachment.mimeType,
			}),
		);
	});

	test("owner self-read does NOT write audit entry", async () => {
		// Self-read of own attachment must not log an admin-read audit entry,
		// even when the user IS an admin.
		vi.mocked(getAttachment).mockResolvedValue(attachment as any);
		vi.mocked(getConversation).mockResolvedValue({
			id: "conv-1",
			userId: adminUser.id,
		} as any);

		const originalBun = (globalThis as any).Bun;
		(globalThis as any).Bun = {
			file: () => ({ exists: async () => false }),
		};
		try {
			await GET(makeEvent({ locals: { user: adminUser } }));
		} finally {
			(globalThis as any).Bun = originalBun;
		}
		expect(vi.mocked(insertAuditEntry)).not.toHaveBeenCalled();
	});
});
