import { describe, expect, test } from "vitest";
import { trustedGithubPrUrl } from "./personal-pr";

describe("trustedGithubPrUrl", () => {
	test("accepts a GitHub pull request address", () => {
		expect(trustedGithubPrUrl("https://github.com/acme/widget/pull/42")).toBe("https://github.com/acme/widget/pull/42");
	});

	test.each([
		undefined,
		"not a url",
		"http://github.com/acme/widget/pull/42",
		"https://github.com.evil.test/acme/widget/pull/42",
		"https://evil.test/acme/widget/pull/42",
		"https://github.com/acme/widget/issues/42",
		"https://github.com/acme/widget/pull/42?token=secret",
		"https://user:pass@github.com/acme/widget/pull/42",
	])("rejects unsafe or unrelated address %s", (address) => {
		expect(trustedGithubPrUrl(address)).toBeNull();
	});
});
