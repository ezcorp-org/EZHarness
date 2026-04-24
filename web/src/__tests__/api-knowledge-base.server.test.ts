/**
 * Server-handler unit tests for /api/knowledge-base/+server.ts.
 *
 * Covers the scope/auth gates and the pre-DB validation gates. Success
 * branches hit Drizzle + embedding generation, so they're integration scope.
 */

import { test, expect, describe } from "vitest";
import { GET, POST } from "../routes/api/knowledge-base/+server";

function makeGetEvent(opts: {
	href?: string;
	locals?: Record<string, unknown>;
}) {
	const href = opts.href ?? "http://localhost/api/knowledge-base";
	return {
		url: new URL(href),
		locals: opts.locals ?? {},
		request: new Request(href, { method: "GET" }),
	} as any;
}

function makePostEvent(opts: {
	locals?: Record<string, unknown>;
	formData?: FormData;
}) {
	const fd = opts.formData ?? new FormData();
	return {
		url: new URL("http://localhost/api/knowledge-base"),
		locals: opts.locals ?? {},
		request: new Request("http://localhost/api/knowledge-base", {
			method: "POST",
			body: fd,
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

const authedUser = {
	user: { id: "u1", email: "u@x", name: "u", role: "user" },
};

describe("GET /api/knowledge-base", () => {
	test("returns 403 when API-key scope is missing 'read'", async () => {
		const res = await GET(
			makeGetEvent({
				locals: { ...authedUser, apiKeyScopes: ["chat"] },
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("read");
	});

	test("throws 401 when unauthenticated", async () => {
		const res = await expectThrownResponse(
			() => GET(makeGetEvent({})),
			401,
		);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Authentication required");
	});

	test("returns 400 when projectId query param is missing", async () => {
		const res = await GET(makeGetEvent({ locals: authedUser }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("projectId");
	});
});

describe("POST /api/knowledge-base", () => {
	test("returns 403 when API-key scope is missing 'read'", async () => {
		const res = await POST(
			makePostEvent({
				locals: { ...authedUser, apiKeyScopes: ["chat"] },
			}),
		);
		expect(res.status).toBe(403);
	});

	test("throws 401 when unauthenticated", async () => {
		await expectThrownResponse(() => POST(makePostEvent({})), 401);
	});

	test("returns 400 when projectId is missing from formData", async () => {
		const fd = new FormData();
		// No projectId -> safeParse fails with validationError (400)
		const res = await POST(
			makePostEvent({ locals: authedUser, formData: fd }),
		);
		expect(res.status).toBe(400);
	});

	test("returns 400 when projectId is not a UUID", async () => {
		const fd = new FormData();
		fd.append("projectId", "not-a-uuid");
		const res = await POST(
			makePostEvent({ locals: authedUser, formData: fd }),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Validation failed");
	});
});
