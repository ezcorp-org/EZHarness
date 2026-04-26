/**
 * Server-handler unit tests for /api/auth/login/+server.ts.
 *
 * Validation gates only — success/auth-failure paths hit Bun.password
 * (argon2id) + DB + audit-log, which are integration scope.
 */

import { test, expect, describe, beforeEach, vi } from "vitest";

// The handler now writes an `auth:rate_limited` audit row on the FIRST
// blocked attempt per (IP, window). Mock the audit-log module so the
// rate-limit branch doesn't try to touch a real DB connection.
vi.mock("$server/db/queries/audit-log", () => ({
	insertAuditEntry: vi.fn(async () => undefined),
}));

const { insertAuditEntry } = await import("$server/db/queries/audit-log");
const { POST, __rateLimiter } = await import("../routes/api/auth/login/+server");

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
		vi.mocked(insertAuditEntry).mockClear();
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
		vi.mocked(insertAuditEntry).mockClear();
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

	test("emits exactly one auth:rate_limited audit row when limit first fires", async () => {
		// Burn through 5 allowed attempts (each 400s on validation, no audit
		// write because the failed_login branch never runs).
		for (let i = 0; i < 5; i++) {
			await POST(makeEvent({}, "3.3.3.3"));
		}
		expect(vi.mocked(insertAuditEntry)).not.toHaveBeenCalled();

		// 6th attempt is the FIRST blocked — must emit one audit row.
		const sixth = await POST(makeEvent({}, "3.3.3.3"));
		expect(sixth.status).toBe(429);
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalledWith(
			null,
			"auth:rate_limited",
			undefined,
			{ ip: "3.3.3.3" },
		);
	});

	test("does NOT re-audit on subsequent blocks within the same window", async () => {
		// Burn through 5 + first-block (= the only audit row for this IP).
		for (let i = 0; i < 5; i++) {
			await POST(makeEvent({}, "4.4.4.4"));
		}
		const sixth = await POST(makeEvent({}, "4.4.4.4"));
		expect(sixth.status).toBe(429);
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalledTimes(1);

		// 7th and 8th are still 429 but MUST NOT emit additional audit rows
		// — Option C self-throttles to one row per (IP, window).
		const seventh = await POST(makeEvent({}, "4.4.4.4"));
		expect(seventh.status).toBe(429);
		const eighth = await POST(makeEvent({}, "4.4.4.4"));
		expect(eighth.status).toBe(429);
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalledTimes(1);
	});

	test("a separate IP that hits the limit emits its own audit row", async () => {
		// IP A burns through and gets its single audit row.
		for (let i = 0; i < 5; i++) await POST(makeEvent({}, "5.5.5.5"));
		await POST(makeEvent({}, "5.5.5.5")); // first block on A → 1 row
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalledTimes(1);

		// IP B burns through independently and gets its OWN row.
		for (let i = 0; i < 5; i++) await POST(makeEvent({}, "6.6.6.6"));
		await POST(makeEvent({}, "6.6.6.6")); // first block on B → 1 more row
		expect(vi.mocked(insertAuditEntry)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(insertAuditEntry)).toHaveBeenLastCalledWith(
			null,
			"auth:rate_limited",
			undefined,
			{ ip: "6.6.6.6" },
		);
	});
});
