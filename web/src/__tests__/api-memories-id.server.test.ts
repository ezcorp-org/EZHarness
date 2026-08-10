/**
 * Server-handler unit tests for /api/memories/[id]/+server.ts.
 *
 * Covers scope/auth gates. Ownership 404 branches hit the DB, so they're
 * integration scope.
 */

import { test, expect, describe } from "vitest";
import { GET, PUT, DELETE } from "../routes/api/memories/[id]/+server";
import { expectThrownResponse, makeRequestEvent } from "./helpers/server-route-test-utils";

function makeEvent(opts: {
	id?: string;
	body?: unknown;
	locals?: Record<string, unknown>;
	method?: string;
}) {
	const id = opts.id ?? "m1";
	return makeRequestEvent(`http://localhost/api/memories/${id}`, {
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

/** A key that can READ this memory but, since 2026-08, cannot change it. */
const readOnlyScope = {
	user: { id: "u1", email: "u@x", name: "u", role: "user" },
	apiKeyScopes: ["read"],
};

describe("GET /api/memories/[id]", () => {
	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await GET(makeEvent({ locals: badScope }));
		expect(res.status).toBe(403);
	});

	test("throws 401 when unauthenticated", async () => {
		await expectThrownResponse(() => GET(makeEvent({ locals: {} })), 401);
	});
});

describe("PUT /api/memories/[id]", () => {
	test("returns 403 when API-key scope missing 'write'", async () => {
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

describe("DELETE /api/memories/[id]", () => {
	test("returns 403 when API-key scope missing 'write'", async () => {
		const res = await DELETE(
			makeEvent({ locals: badScope, method: "DELETE" }),
		);
		expect(res.status).toBe(403);
	});

	test("a READ-ONLY key can no longer delete a memory", async () => {
		// The headline of docs/audit/2026-08-read-scope-mutation-inventory.md:
		// until 2026-08 `read` was the scope that authorized this delete, while
		// the shipped operator doc described `read` as "no writes".
		const res = await DELETE(
			makeEvent({ locals: readOnlyScope, method: "DELETE" }),
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { required?: string }).required).toBe("write");
	});

	test("…while the same read-only key is ADMITTED by the read-gated GET", async () => {
		// Proves the refusal above is the WRITE gate and not a broken fixture:
		// the identical principal gets PAST the scope gate on GET and only then
		// dies in the query layer (this suite stubs no DB). Reaching the DB at
		// all is only possible by having been admitted.
		await expect(GET(makeEvent({ locals: readOnlyScope }))).rejects.toThrow(
			/Database not initialized/,
		);
	});

	test("throws 401 when unauthenticated", async () => {
		await expectThrownResponse(
			() => DELETE(makeEvent({ locals: {}, method: "DELETE" })),
			401,
		);
	});
});
