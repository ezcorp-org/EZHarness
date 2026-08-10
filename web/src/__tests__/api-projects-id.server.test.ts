/**
 * Server-handler unit tests for /api/projects/[id]/+server.ts.
 *
 * Covers scope/auth gates. Success/404 branches hit the DB, so they're
 * integration scope.
 */

import { test, expect, describe } from "vitest";
import { GET, PUT, DELETE } from "../routes/api/projects/[id]/+server";
import { expectThrownResponse } from "./helpers/server-route-test-utils";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

function makeEvent(opts: {
	id?: string;
	body?: unknown;
	locals?: Record<string, unknown>;
	method?: string;
}) {
	const id = opts.id ?? "p1";
	return makeRequestEvent(`http://localhost/api/projects/${id}`, {
	  locals: opts.locals ?? {},
	  params: { id },
	  request: {
			method: opts.method ?? "GET",
			headers: { "content-type": "application/json" },
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
		},
	});
}

const badScope = {
	user: { id: "u1", email: "u@x", name: "u", role: "user" },
	apiKeyScopes: ["chat"],
};

describe("GET /api/projects/[id]", () => {
	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await GET(makeEvent({ locals: badScope }));
		expect(res.status).toBe(403);
		const body = (await res.json()) as { required?: string };
		expect(body.required).toBe("read");
	});

	test("throws 401 when unauthenticated", async () => {
		await expectThrownResponse(() => GET(makeEvent({ locals: {} })), 401);
	});
});

describe("PUT /api/projects/[id]", () => {
	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await PUT(
			makeEvent({ locals: badScope, method: "PUT", body: {} }),
		);
		expect(res.status).toBe(403);
	});

	test("throws 401 when unauthenticated", async () => {
		await expectThrownResponse(
			() => PUT(makeEvent({ locals: {}, method: "PUT", body: {} })),
			401,
		);
	});
});

describe("DELETE /api/projects/[id]", () => {
	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await DELETE(
			makeEvent({ locals: badScope, method: "DELETE" }),
		);
		expect(res.status).toBe(403);
	});

	test("throws 401 when unauthenticated", async () => {
		await expectThrownResponse(
			() => DELETE(makeEvent({ locals: {}, method: "DELETE" })),
			401,
		);
	});
});
