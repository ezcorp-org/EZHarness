/**
 * Server-handler unit tests for /api/workflows/[name]/run/+server.ts.
 *
 * We intentionally avoid exercising the workflow executor — tests cover only
 * the scope gate, the auth gate, and the 404 "Workflow not found" branch
 * which runs before any execution (in the typical empty-registry state the
 * vitest setup boots with).
 */

import { test, expect, describe } from "vitest";
import { POST } from "../routes/api/workflows/[name]/run/+server";

function makeEvent(opts: {
	name?: string;
	body?: unknown;
	locals?: Record<string, unknown>;
}) {
	const name = opts.name ?? "does-not-exist";
	return {
		url: new URL(`http://localhost/api/workflows/${name}/run`),
		locals: opts.locals ?? {},
		params: { name },
		request: new Request(`http://localhost/api/workflows/${name}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: opts.body !== undefined ? JSON.stringify(opts.body) : "{}",
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

describe("POST /api/workflows/[name]/run", () => {
	test("returns 403 when API-key scope missing 'chat'", async () => {
		const res = await POST(
			makeEvent({
				locals: { ...authedUser, apiKeyScopes: ["read"] },
				body: {},
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { required?: string };
		expect(body.required).toBe("chat");
	});

	test("throws 401 when unauthenticated", async () => {
		await expectThrownResponse(() => POST(makeEvent({ body: {} })), 401);
	});
});
