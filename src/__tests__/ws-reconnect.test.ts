import { test, expect, describe } from "bun:test";
import { getBackoffDelay, MAX_ATTEMPTS, BASE_DELAY, MAX_DELAY } from "../../web/src/lib/ws";

describe("getBackoffDelay", () => {
	test("attempt 0 returns 1000ms", () => {
		expect(getBackoffDelay(0)).toBe(1000);
	});

	test("attempt 1 returns 2000ms", () => {
		expect(getBackoffDelay(1)).toBe(2000);
	});

	test("attempt 2 returns 4000ms", () => {
		expect(getBackoffDelay(2)).toBe(4000);
	});

	test("attempt 3 returns 8000ms", () => {
		expect(getBackoffDelay(3)).toBe(8000);
	});

	test("attempt 9 is capped at 30000ms", () => {
		expect(getBackoffDelay(9)).toBe(30000);
	});

	test("attempt 15 is still capped at 30000ms", () => {
		expect(getBackoffDelay(15)).toBe(30000);
	});

	test("follows exponential pattern", () => {
		for (let i = 0; i < 5; i++) {
			expect(getBackoffDelay(i)).toBe(Math.min(1000 * Math.pow(2, i), 30000));
		}
	});
});

describe("constants", () => {
	test("MAX_ATTEMPTS is 10", () => {
		expect(MAX_ATTEMPTS).toBe(10);
	});

	test("BASE_DELAY is 1000", () => {
		expect(BASE_DELAY).toBe(1000);
	});

	test("MAX_DELAY is 30000", () => {
		expect(MAX_DELAY).toBe(30000);
	});
});
