/**
 * Server-handler unit tests for /api/marketplace/[id]/rate (+server.ts).
 *
 * Covers auth gate, scope check, validation 400, and the happy path
 * verifying upsertRating side-effect. DB query is mocked at the module
 * boundary.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/marketplace-ratings", () => ({
	upsertRating: vi.fn(async () => undefined),
}));

const { upsertRating } = await import(
	"$server/db/queries/marketplace-ratings"
);
const { POST } = await import(
	"../routes/api/marketplace/[id]/rate/+server.ts"
);

function makeEvent(opts: {
	body?: unknown;
	locals?: Record<string, unknown>;
	id?: string;
}) {
	const id = opts.id ?? "abc";
	return {
		url: new URL(`http://localhost/api/marketplace/${id}/rate`),
		locals: opts.locals ?? {},
		params: { id },
		request: new Request(`http://localhost/api/marketplace/${id}/rate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(opts.body ?? {}),
		}),
	} as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("POST /api/marketplace/[id]/rate", () => {
	beforeEach(() => {
		vi.mocked(upsertRating).mockReset();
	});

	test("unauthenticated request throws 401 Response", async () => {
		let res: Response | undefined;
		try {
			await POST(makeEvent({ body: { thumbsUp: true }, locals: {} }));
			expect.fail("should have thrown");
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			res = thrown as Response;
		}
		expect(res!.status).toBe(401);
		const body = (await res!.json()) as { error?: string };
		expect(body.error).toBe("Authentication required");
	});

	test("API-key scope check returns 403 when 'extensions' scope missing", async () => {
		const res = await POST(
			makeEvent({
				body: { thumbsUp: true },
				locals: {
					user,
					apiKeyScopes: ["read"],
				},
			}),
		);
		expect(res).toBeInstanceOf(Response);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("extensions");
	});

	test("non-boolean thumbsUp returns 400 via errorJson", async () => {
		const res = await POST(
			makeEvent({
				body: { thumbsUp: "yes" },
				locals: { user },
			}),
		);
		expect(res).toBeInstanceOf(Response);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("thumbsUp must be a boolean");
		expect(vi.mocked(upsertRating)).not.toHaveBeenCalled();
	});

	test("happy path thumbsUp=true: upsertRating called with listingId, userId, true", async () => {
		const res = await POST(
			makeEvent({
				body: { thumbsUp: true },
				locals: { user },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok?: boolean };
		expect(body.ok).toBe(true);
		// Side-effect
		expect(vi.mocked(upsertRating)).toHaveBeenCalledWith("abc", user.id, true);
	});

	test("happy path thumbsUp=false: upsertRating called with thumbsUp=false", async () => {
		const res = await POST(
			makeEvent({
				body: { thumbsUp: false },
				locals: { user },
			}),
		);
		expect(res.status).toBe(200);
		expect(vi.mocked(upsertRating)).toHaveBeenCalledWith("abc", user.id, false);
	});
});
