/**
 * Server-handler unit tests for /api/knowledge-base/[id]/+server.ts.
 *
 * Covers the scope/auth gates. 404 ownership branches hit the DB, so they're
 * integration scope.
 */

import { test, expect, describe } from "vitest";
import { GET, DELETE } from "../routes/api/knowledge-base/[id]/+server";

function makeEvent(opts: {
	id?: string;
	locals?: Record<string, unknown>;
	method?: string;
}) {
	const id = opts.id ?? "kb-1";
	return {
		url: new URL(`http://localhost/api/knowledge-base/${id}`),
		locals: opts.locals ?? {},
		params: { id },
		request: new Request(`http://localhost/api/knowledge-base/${id}`, {
			method: opts.method ?? "GET",
		}),
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

describe("GET /api/knowledge-base/[id]", () => {
	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await GET(
			makeEvent({
				locals: {
					user: { id: "u1", email: "u@x", name: "u", role: "user" },
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
});

describe("DELETE /api/knowledge-base/[id]", () => {
	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await DELETE(
			makeEvent({
				locals: {
					user: { id: "u1", email: "u@x", name: "u", role: "user" },
					apiKeyScopes: ["chat"],
				},
				method: "DELETE",
			}),
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
