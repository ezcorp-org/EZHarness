import { describe, test, expect } from "vitest";
import { isIconUrl } from "$lib/project-icon.js";

/**
 * `isIconUrl` gates project-icon <img> rendering. Only real image references
 * (data:, http(s):, app-relative /…) may become an <img src>; any other token
 * (e.g. a Lucide name arriving via the API) must fall back to a letter avatar
 * instead of firing a relative request that 404s.
 */
describe("isIconUrl", () => {
	test("accepts real image URL forms", () => {
		expect(isIconUrl("https://cdn.example.com/logo.png")).toBe(true);
		expect(isIconUrl("http://example.com/a.png")).toBe(true);
		expect(isIconUrl("data:image/png;base64,abc123")).toBe(true);
		expect(isIconUrl("/uploads/project-icon.png")).toBe(true);
	});

	test("rejects non-URL tokens", () => {
		expect(isIconUrl("FlaskConical")).toBe(false);
		expect(isIconUrl("")).toBe(false);
		expect(isIconUrl("javascript:x")).toBe(false);
	});

	test("rejects nullish values", () => {
		expect(isIconUrl(null)).toBe(false);
		expect(isIconUrl(undefined)).toBe(false);
	});
});
