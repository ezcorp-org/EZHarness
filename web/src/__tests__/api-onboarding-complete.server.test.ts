/**
 * Server-handler unit tests for /api/onboarding/complete/+server.ts.
 *
 * Covers the full contract:
 *   - POST without auth → 401 (delegated to requireAuth)
 *   - POST with auth → 204 + markUserOnboarded(user.id)
 *   - markUserOnboarded returning false (already-onboarded user) → still 204 (idempotent)
 *   - DB error in markUserOnboarded → propagates as 500-class (uncaught)
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
	markUserOnboarded: vi.fn(),
}));

const { markUserOnboarded } = await import("$server/db/queries/users");
const { POST } = await import("../routes/api/onboarding/complete/+server");

function makeEvent(locals: Record<string, unknown> = {}) {
	return {
		url: new URL("http://localhost/api/onboarding/complete"),
		locals,
		cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
		request: new Request("http://localhost/api/onboarding/complete", { method: "POST" }),
	} as any;
}

describe("POST /api/onboarding/complete", () => {
	beforeEach(() => {
		vi.mocked(markUserOnboarded).mockReset();
	});

	test("unauthenticated → 401, markUserOnboarded NOT called", async () => {
		const event = makeEvent({});
		const res = (await POST(event)) as Response;
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Authentication required");
		expect(vi.mocked(markUserOnboarded)).not.toHaveBeenCalled();
	});

	test("authenticated → 204 and markUserOnboarded called with user.id", async () => {
		vi.mocked(markUserOnboarded).mockResolvedValue(true);
		const event = makeEvent({ user: { id: "u-42", email: "x@y", name: "X", role: "member" } });
		const res = (await POST(event)) as Response;
		expect(res.status).toBe(204);
		expect(vi.mocked(markUserOnboarded)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(markUserOnboarded)).toHaveBeenCalledWith("u-42");
	});

	test("idempotent — already-onboarded user (markUserOnboarded returns false) → still 204", async () => {
		// markUserOnboarded sets onboardedAt = NOW() with no preconditions, so a
		// repeat call always returns true on a real DB. The "false" return only
		// happens if the user row doesn't exist — which for an authenticated
		// request shouldn't occur, but the endpoint must not 500 if it does.
		vi.mocked(markUserOnboarded).mockResolvedValue(false);
		const event = makeEvent({ user: { id: "u-ghost", email: "g@y", name: "G", role: "member" } });
		const res = (await POST(event)) as Response;
		expect(res.status).toBe(204);
	});

	test("markUserOnboarded throws → propagates (does not get swallowed as 204)", async () => {
		vi.mocked(markUserOnboarded).mockRejectedValue(new Error("DB down"));
		const event = makeEvent({ user: { id: "u-1", email: "a@b", name: "A", role: "member" } });
		await expect(POST(event)).rejects.toThrow("DB down");
	});
});
