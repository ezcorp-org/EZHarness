/**
 * Server-handler unit tests for /api/marketplace/[id]/delete (+server.ts).
 *
 * Covers admin gating (requireRole throws 401/403), scope check, the 404
 * path when `deleteListing` returns false, and the happy-path with
 * insertAuditEntry side-effect.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/marketplace", () => ({
	deleteListing: vi.fn(),
}));
vi.mock("$server/db/queries/audit-log", () => ({
	insertAuditEntry: vi.fn(async () => undefined),
}));

const { deleteListing } = await import("$server/db/queries/marketplace");
const { insertAuditEntry } = await import("$server/db/queries/audit-log");
const { DELETE } = await import(
	"../routes/api/marketplace/[id]/delete/+server.ts"
);

function makeEvent(opts: {
	locals?: Record<string, unknown>;
	id?: string;
}) {
	const id = opts.id ?? "abc";
	return {
		url: new URL(`http://localhost/api/marketplace/${id}/delete`),
		locals: opts.locals ?? {},
		params: { id },
		request: new Request(`http://localhost/api/marketplace/${id}/delete`, {
			method: "DELETE",
		}),
	} as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };
const adminUser = { id: "admin-1", email: "a@x", name: "a", role: "admin" };

describe("DELETE /api/marketplace/[id]/delete", () => {
	beforeEach(() => {
		vi.mocked(deleteListing).mockReset();
		vi.mocked(insertAuditEntry).mockReset();
	});

	test("unauthenticated request throws 401 Response", async () => {
		let res: Response | undefined;
		try {
			await DELETE(makeEvent({ locals: {} }));
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
			await DELETE(makeEvent({ locals: { user } }));
			expect.fail("should have thrown");
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res!.status).toBe(403);
	});

	test("API-key scope check returns 403 when 'admin' missing", async () => {
		const res = await DELETE(
			makeEvent({
				locals: { user: adminUser, apiKeyScopes: ["read"] },
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.required).toBe("admin");
	});

	test("missing listing returns 404 via errorJson", async () => {
		vi.mocked(deleteListing).mockResolvedValue(false as any);
		const res = await DELETE(
			makeEvent({
				locals: { user: adminUser },
			}),
		);
		expect(res).toBeInstanceOf(Response);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Listing not found");
		// 404 short-circuits before audit-log writes
		expect(vi.mocked(insertAuditEntry)).not.toHaveBeenCalled();
	});

	test("happy path: deletes listing and writes audit entry", async () => {
		vi.mocked(deleteListing).mockResolvedValue(true as any);
		const res = await DELETE(
			makeEvent({
				locals: { user: adminUser },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok?: boolean };
		expect(body.ok).toBe(true);
		// Side-effects
		expect(vi.mocked(deleteListing)).toHaveBeenCalledWith("abc");
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalledWith(
			adminUser.id,
			"marketplace:delete",
			"abc",
		);
	});
});
