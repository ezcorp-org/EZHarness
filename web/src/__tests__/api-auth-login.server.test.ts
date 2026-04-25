/**
 * Server-handler unit tests for /api/auth/login/+server.ts.
 *
 * Validation gates only — success/auth-failure paths hit Bun.password
 * (argon2id) + DB + audit-log, which are integration scope.
 */

import { test, expect, describe, beforeEach } from "vitest";
import { POST, __rateLimiter } from "../routes/api/auth/login/+server";

function makeEvent(body: unknown, ip: string = "127.0.0.1") {
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
		getClientAddress: () => ip,
	} as any;
}

describe("POST /api/auth/login — validation gate", () => {
	beforeEach(() => {
		__rateLimiter.reset();
	});

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

describe("POST /api/auth/login — rate limit (5/15min per IP)", () => {
	beforeEach(() => {
		__rateLimiter.reset();
	});

	test("returns 429 on the 6th attempt from the same IP", async () => {
		// First 5 attempts pass through to the validation gate (which 400s).
		for (let i = 0; i < 5; i++) {
			const res = await POST(makeEvent({}, "9.9.9.9"));
			expect(res.status).toBe(400);
		}
		const res = await POST(makeEvent({}, "9.9.9.9"));
		expect(res.status).toBe(429);
		const body = (await res.json()) as { error?: string; retryAfter?: number };
		expect(body.error).toContain("Too many requests");
		expect(typeof body.retryAfter).toBe("number");
		expect(res.headers.get("retry-after")).toBeTruthy();
	});

	test("tracks separate IPs independently", async () => {
		for (let i = 0; i < 5; i++) {
			await POST(makeEvent({}, "1.1.1.1"));
		}
		// 1.1.1.1 is now blocked, but 2.2.2.2 should still pass through.
		const blocked = await POST(makeEvent({}, "1.1.1.1"));
		expect(blocked.status).toBe(429);
		const fresh = await POST(makeEvent({}, "2.2.2.2"));
		expect(fresh.status).toBe(400); // hits validation, not rate limit
	});
});
