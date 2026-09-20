import { describe, expect, test } from "vitest";
import { shouldShowUnsandboxedBanner, UNSANDBOXED_RUNNER_MODE } from "./UnsandboxedExtensionsBanner.helpers";

describe("shouldShowUnsandboxedBanner", () => {
	test("shows for exactly the trusted-local mode the server reports", () => {
		expect(UNSANDBOXED_RUNNER_MODE).toBe("trusted-local");
		expect(shouldShowUnsandboxedBanner("trusted-local")).toBe(true);
	});

	test("never shows on a sandboxed host", () => {
		expect(shouldShowUnsandboxedBanner("isolated")).toBe(false);
	});

	test("a missing field is not evidence of the dangerous mode", () => {
		// Not fetched yet, or an older server that does not report the field.
		expect(shouldShowUnsandboxedBanner(null)).toBe(false);
		expect(shouldShowUnsandboxedBanner(undefined)).toBe(false);
	});

	test("only the exact string counts — no prefix, case, or whitespace leniency", () => {
		for (const value of ["", "Trusted-Local", " trusted-local", "trusted-local ", "trusted-local-v4", "unsandboxed"]) {
			expect(shouldShowUnsandboxedBanner(value)).toBe(false);
		}
	});
});
