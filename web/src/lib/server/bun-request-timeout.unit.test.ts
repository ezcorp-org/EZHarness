import { describe, expect, test, vi } from "vitest";
import { disableBunRequestIdleTimeout } from "./bun-request-timeout";

describe("disableBunRequestIdleTimeout", () => {
	test("disables the timeout for the adapter's original request", () => {
		const timeout = vi.fn();
		const request = new Request("http://localhost/api/long-operation");

		expect(disableBunRequestIdleTimeout({ server: { timeout }, request })).toBe(true);
		expect(timeout).toHaveBeenCalledWith(request, 0);
	});

	test.each([undefined, {}, { server: {} }, { server: { timeout: vi.fn() } }])("does nothing without a complete Bun adapter platform", (platform) => {
		expect(disableBunRequestIdleTimeout(platform)).toBe(false);
	});
});
