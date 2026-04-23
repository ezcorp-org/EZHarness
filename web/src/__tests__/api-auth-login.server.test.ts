/**
 * Server-handler unit tests for /api/auth/login/+server.ts.
 *
 * Validation gates only — success/auth-failure paths hit Bun.password
 * (argon2id) + DB + audit-log, which are integration scope.
 */

import { test, expect, describe } from "vitest";
import { POST } from "../routes/api/auth/login/+server";

function makeEvent(body: unknown) {
	return {
		request: new Request("http://localhost/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		cookies: {
			set: () => undefined,
			get: () => undefined,
			delete: () => undefined,
		},
		getClientAddress: () => "127.0.0.1",
	} as any;
}

describe("POST /api/auth/login — validation gate", () => {
	test("rejects 400 when email is malformed", async () => {
		const res = await POST(makeEvent({ email: "not-an-email", password: "x" }));
		expect(res).toBeInstanceOf(Response);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("rejects 400 when password is empty", async () => {
		const res = await POST(makeEvent({ email: "u@test.com", password: "" }));
		expect(res.status).toBe(400);
	});

	test("rejects 400 when fields are missing", async () => {
		const res = await POST(makeEvent({}));
		expect(res.status).toBe(400);
	});
});
