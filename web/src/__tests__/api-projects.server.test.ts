/**
 * Server-handler unit tests for /api/projects/+server.ts.
 * Auth gate + POST validation gate. Success branches hit the DB.
 */

import { test, expect, describe } from "vitest";
import { GET, POST } from "../routes/api/projects/+server";

function makeGetEvent(locals: Record<string, unknown> = {}) {
	return { url: new URL("http://localhost/api/projects"), locals } as any;
}

function makePostEvent(body: unknown, locals: Record<string, unknown> = {}) {
	return {
		url: new URL("http://localhost/api/projects"),
		locals,
		request: new Request("http://localhost/api/projects", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	} as any;
}

async function expectThrownResponse(
	fn: () => Promise<Response> | Response,
	status: number,
): Promise<Response> {
	let res: Response | undefined;
	try {
		const out = await fn();
		res = out;
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(Response);
		res = thrown as Response;
	}
	expect(res).toBeInstanceOf(Response);
	expect(res!.status).toBe(status);
	return res!;
}

describe("GET /api/projects", () => {
	test("rejects 401 when locals.user is missing", async () => {
		const res = await expectThrownResponse(() => GET(makeGetEvent({})), 401);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("returns 403 when API-key scope missing 'read'", async () => {
		const user = { id: "u1", email: "u@x", name: "u", role: "user" };
		const res = await GET(makeGetEvent({ user, apiKeyScopes: ["chat"] }));
		expect(res.status).toBe(403);
		const body = (await res.json()) as { required?: string };
		expect(body.required).toBe("read");
	});
});

describe("POST /api/projects", () => {
	test("rejects 401 when locals.user is missing", async () => {
		const res = await expectThrownResponse(
			() => POST(makePostEvent({ name: "x", path: "/x" }, {})),
			401,
		);
		expect(res.status).toBe(401);
	});

	test("returns 403 when API-key scope missing 'read'", async () => {
		const user = { id: "u1", email: "u@x", name: "u", role: "user" };
		const res = await POST(
			makePostEvent(
				{ name: "x", path: "/x" },
				{ user, apiKeyScopes: ["chat"] },
			),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { required?: string };
		expect(body.required).toBe("read");
	});

	test("rejects 400 when name or path missing (auth'd user)", async () => {
		const user = { id: "u1", email: "u@test.com", name: "U", role: "member" };
		// Both empty -> 400 path. Don't pass body that triggers DB on success.
		const res = await POST(makePostEvent({ name: "", path: "" }, { user }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("required");
	});
});
