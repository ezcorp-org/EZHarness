/**
 * Direct unit tests for `web/src/lib/server/http-errors.ts`.
 *
 * `errorJson` is the shared error-response shape used by ~130 route
 * handlers. Before this file it was only exercised transitively via a
 * handful of import-wizard route tests, which hit the bare-status and
 * extra-headers paths unevenly. This locks every branch (details merge,
 * extra-headers fork, plain fork) at the unit layer so a refactor of the
 * shape gets caught here instead of as a flaky route-shape assertion.
 */

import { describe, test, expect } from "vitest";
import { errorJson, validateRequired } from "$lib/server/http-errors";

describe("errorJson", () => {
	test("plain message → { error } at the given status", async () => {
		const res = errorJson(404, "not found");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "not found" });
	});

	test("details merge into the body alongside error", async () => {
		const res = errorJson(409, "conflict", { id: "abc", retryable: true });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "conflict", id: "abc", retryable: true });
	});

	test("extraHeaders fork sets headers and preserves status", async () => {
		const res = errorJson(429, "slow down", undefined, { "Retry-After": "30" });
		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("30");
		expect(await res.json()).toEqual({ error: "slow down" });
	});

	test("details AND extraHeaders together", async () => {
		const res = errorJson(400, "bad", { field: "name" }, { "X-Trace": "t1" });
		expect(res.status).toBe(400);
		expect(res.headers.get("X-Trace")).toBe("t1");
		expect(await res.json()).toEqual({ error: "bad", field: "name" });
	});
});

describe("validateRequired", () => {
	test("returns the value narrowed to string when present", () => {
		expect(validateRequired("abc", "id")).toBe("abc");
	});

	test("throws a 400 Response for a missing (undefined) value", async () => {
		try {
			validateRequired(undefined, "id");
			throw new Error("expected throw");
		} catch (e) {
			expect(e).toBeInstanceOf(Response);
			const res = e as Response;
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "id is required" });
		}
	});

	test("throws for an empty string", () => {
		expect(() => validateRequired("", "name")).toThrow();
	});

	test("throws for a non-string value", () => {
		expect(() => validateRequired(123, "count")).toThrow();
	});

	test("honours a custom status code", async () => {
		try {
			validateRequired(null, "token", 401);
			throw new Error("expected throw");
		} catch (e) {
			expect((e as Response).status).toBe(401);
		}
	});
});
