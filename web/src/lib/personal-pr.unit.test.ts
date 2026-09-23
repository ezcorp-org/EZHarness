import { describe, expect, test } from "vitest";
import { fileCountLabel, personalPrReason, trustedGithubPrUrl, trustedGithubUrl } from "./personal-pr";

test("labels a single file with the singular noun", () => {
	expect(fileCountLabel(0)).toBe("0 files");
	expect(fileCountLabel(1)).toBe("1 file");
	expect(fileCountLabel(2)).toBe("2 files");
});

test.each([
	[undefined, ""],
	["review_not_prepared", ""],
	["run_not_successful", "did not finish successfully"],
	["repository_not_enabled", "Enable this repository"],
	["insufficient_user_permission", "needs write access"],
	["reconnect_required", "Reconnect your GitHub account"],
	["unknown_code", "cannot continue"],
])("renders a safe message for PR reason %s", (reason, expected) => {
	expect(personalPrReason(reason)).toContain(expected);
	expect(personalPrReason(reason)).not.toContain("unknown_code");
});

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

test("GitHub setup links reject external or script addresses", () => {
	expect(trustedGithubUrl("https://github.com/apps/ezcorp/installations/new")).toBe("https://github.com/apps/ezcorp/installations/new");
	expect(trustedGithubUrl("javascript:alert(1)")).toBeNull();
	expect(trustedGithubUrl("https://github.com.evil.test/apps/ezcorp")).toBeNull();
});
