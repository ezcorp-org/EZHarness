/**
 * POST /api/composer/suggest/feedback — handler tests.
 *
 * Covers the scope/auth/validation gates and the insert call. The write
 * itself is tested against real PGlite in
 * src/db/queries/__tests__/suggestion-feedback.test.ts.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const insertSuggestionFeedback = vi.fn(async () => {});
vi.mock("$server/db/queries/suggestion-feedback", () => ({ insertSuggestionFeedback }));
vi.mock("$lib/server/context", () => ({ ensureInitialized: vi.fn(async () => {}) }));

const { POST } = await import("../routes/api/composer/suggest/feedback/+server");

const owner = { id: "user-1", email: "u@x", name: "U", role: "member" };

function call(body: unknown, locals: Record<string, unknown> = { user: owner }) {
	return POST({
		locals,
		request: new Request("http://localhost/api/composer/suggest/feedback", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	} as never);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("POST /api/composer/suggest/feedback", () => {
	test("API key without 'chat' scope → 403", async () => {
		const res = await call({ kind: "tool", action: "shown" }, { user: owner, apiKeyScopes: ["read"] });
		expect(res.status).toBe(403);
		expect(insertSuggestionFeedback).not.toHaveBeenCalled();
	});

	test("unauthenticated → 401", async () => {
		try {
			const res = await call({ kind: "tool", action: "shown" }, {});
			expect(res.status).toBe(401);
		} catch (thrown) {
			expect((thrown as Response).status).toBe(401);
		}
		expect(insertSuggestionFeedback).not.toHaveBeenCalled();
	});

	test("invalid kind/action → 400", async () => {
		expect((await call({ kind: "nope", action: "shown" })).status).toBe(400);
		expect((await call({ kind: "tool", action: "exploded" })).status).toBe(400);
	});

	test("draft-text smuggling is rejected by the strict schema", async () => {
		const res = await call({ kind: "tool", action: "shown", draft: "my private text" });
		expect(res.status).toBe(400);
		expect(insertSuggestionFeedback).not.toHaveBeenCalled();
	});

	test("malformed JSON → 400", async () => {
		expect((await call("{oops")).status).toBe(400);
	});

	test("valid event → 201 and stamps the session user", async () => {
		const res = await call({
			kind: "enhance",
			action: "accepted",
			toolName: "analyzer__scan",
			conversationId: "conv-1",
			latencyMs: 1200,
		});
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ ok: true });
		expect(insertSuggestionFeedback).toHaveBeenCalledWith({
			userId: "user-1",
			kind: "enhance",
			action: "accepted",
			toolName: "analyzer__scan",
			conversationId: "conv-1",
			latencyMs: 1200,
		});
	});

	test("minimal event → 201", async () => {
		const res = await call({ kind: "tool", action: "dismissed" });
		expect(res.status).toBe(201);
		expect(insertSuggestionFeedback).toHaveBeenCalledWith({
			userId: "user-1",
			kind: "tool",
			action: "dismissed",
		});
	});
});
