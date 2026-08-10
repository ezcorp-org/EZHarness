/**
 * Server-handler unit tests for /api/memories/+server.ts.
 *
 * Covers the scope/auth gates and the POST validation gates. Success paths
 * hit the DB and fire-and-forget embedding, so they're integration scope.
 */

import { test, expect, describe } from "vitest";
import { GET, POST } from "../routes/api/memories/+server";
import { expectThrownResponse, makeRequestEvent } from "./helpers/server-route-test-utils";

function makeGetEvent(opts: {
	href?: string;
	locals?: Record<string, unknown>;
}) {
	const href = opts.href ?? "http://localhost/api/memories";
	return makeRequestEvent(href, {
	  locals: opts.locals ?? {},
	  request: { method: "GET" },
	});
}

function makePostEvent(opts: {
	body?: unknown;
	locals?: Record<string, unknown>;
}) {
	return makeRequestEvent("http://localhost/api/memories", {
	  locals: opts.locals ?? {},
	  request: {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: opts.body !== undefined ? JSON.stringify(opts.body) : "{}",
		},
	});
}

const authedUser = {
	user: { id: "u1", email: "u@x", name: "u", role: "user" },
};

describe("GET /api/memories", () => {
	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await GET(
			makeGetEvent({
				locals: { ...authedUser, apiKeyScopes: ["chat"] },
			}),
		);
		expect(res.status).toBe(403);
	});

	test("throws 401 when unauthenticated", async () => {
		await expectThrownResponse(() => GET(makeGetEvent({})), 401);
	});
});

describe("POST /api/memories", () => {
	test("returns 403 when API-key scope missing 'write'", async () => {
		const res = await POST(
			makePostEvent({
				locals: { ...authedUser, apiKeyScopes: ["chat"] },
				body: { content: "x", category: "preferences" },
			}),
		);
		expect(res.status).toBe(403);
	});

	test("throws 401 when unauthenticated", async () => {
		await expectThrownResponse(
			() =>
				POST(
					makePostEvent({
						body: { content: "x", category: "preferences" },
					}),
				),
			401,
		);
	});

	test("returns 400 when content is missing", async () => {
		const res = await POST(
			makePostEvent({
				locals: authedUser,
				body: { category: "preferences" },
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("content");
	});

	test("returns 400 when content is empty string", async () => {
		const res = await POST(
			makePostEvent({
				locals: authedUser,
				body: { content: "   ", category: "preferences" },
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("content");
	});

	test("returns 400 when category is missing", async () => {
		const res = await POST(
			makePostEvent({ locals: authedUser, body: { content: "hello" } }),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("category");
	});

	test("returns 400 when category is invalid", async () => {
		const res = await POST(
			makePostEvent({
				locals: authedUser,
				body: { content: "hello", category: "bogus" },
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("category");
	});

	test("returns 400 when confidence is invalid", async () => {
		const res = await POST(
			makePostEvent({
				locals: authedUser,
				body: {
					content: "hello",
					category: "preferences",
					confidence: "bogus",
				},
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("confidence");
	});

	test("returns 400 when projectIds is not an array", async () => {
		const res = await POST(
			makePostEvent({
				locals: authedUser,
				body: {
					content: "hello",
					category: "preferences",
					projectIds: "not-array",
				},
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("projectIds");
	});

	test("returns 400 when projectIds contains non-UUID strings", async () => {
		const res = await POST(
			makePostEvent({
				locals: authedUser,
				body: {
					content: "hello",
					category: "preferences",
					projectIds: ["not-a-uuid"],
				},
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("projectIds");
	});
});
