/**
 * `summarizeToolFailure` — the collapsed-card failure summary.
 *
 * The defect: a failed extension-author install rendered as a red ✗,
 * the tool name, and nothing else. The host's structured `code` was
 * behind a click, so "the manifest is broken", "an admin has to grant
 * this", "the smoke test failed", and "the host answered garbage" were
 * one identical grey row. These tests pin that each class is
 * distinguishable from the collapsed header alone.
 */

import { test, expect, describe } from "bun:test";
import {
	FAILURE_CLASS_BY_CODE,
	FAILURE_CLASS_LABEL,
	summarizeToolFailure,
} from "./failure-class.js";

function err(code: string, message = "something went wrong"): string {
	return JSON.stringify({ ok: false, code, error: message });
}

describe("summarizeToolFailure — the five classes are distinguishable", () => {
	test("load: a broken manifest", () => {
		const r = summarizeToolFailure(err("MANIFEST_INVALID", "name required"), null);
		expect(r?.failureClass).toBe("load");
		expect(r?.code).toBe("MANIFEST_INVALID");
		expect(r?.label).toBe("Load failed · MANIFEST_INVALID");
		expect(r?.message).toBe("name required");
	});

	test("permission: a gate said no", () => {
		expect(summarizeToolFailure(err("NOT_ALLOWLISTED"), null)?.failureClass).toBe(
			"permission",
		);
		expect(
			summarizeToolFailure(err("NOT_FOUND_OR_NOT_MODIFIABLE"), null)?.failureClass,
		).toBe("permission");
		expect(summarizeToolFailure(err("ENV_KEY_LEAK"), null)?.failureClass).toBe(
			"permission",
		);
	});

	test("execution: it ran and failed", () => {
		expect(summarizeToolFailure(err("VERIFY_FAILED"), null)?.failureClass).toBe(
			"execution",
		);
		expect(summarizeToolFailure(err("ENABLE_FAILED"), null)?.failureClass).toBe(
			"execution",
		);
		expect(
			summarizeToolFailure(err("REGISTRY_RELOAD_FAILED"), null)?.failureClass,
		).toBe("execution");
	});

	test("response: the host answered in an untrustworthy shape", () => {
		const r = summarizeToolFailure(err("BAD_HOST_RESPONSE", "no draftId"), null);
		expect(r?.failureClass).toBe("response");
		expect(r?.label).toBe("Bad response · BAD_HOST_RESPONSE");
	});

	test("every class has its own label, and no two classes share one", () => {
		const labels = Object.values(FAILURE_CLASS_LABEL);
		expect(new Set(labels).size).toBe(labels.length);
	});

	test("the four host-emitted classes produce four distinct header labels", () => {
		const labels = [
			summarizeToolFailure(err("MANIFEST_INVALID"), null)?.label,
			summarizeToolFailure(err("NOT_ALLOWLISTED"), null)?.label,
			summarizeToolFailure(err("VERIFY_FAILED"), null)?.label,
			summarizeToolFailure(err("BAD_HOST_RESPONSE"), null)?.label,
		];
		expect(new Set(labels).size).toBe(4);
	});
});

describe("summarizeToolFailure — payload shapes", () => {
	test("reads the payload from `output` when `error` carries nothing", () => {
		const r = summarizeToolFailure(null, err("VERIFY_FAILED", "smoke test failed"));
		expect(r?.code).toBe("VERIFY_FAILED");
		expect(r?.message).toBe("smoke test failed");
	});

	test("`error` wins over `output` when both are structured", () => {
		const r = summarizeToolFailure(err("ENV_KEY_LEAK", "leak"), err("VERIFY_FAILED"));
		expect(r?.code).toBe("ENV_KEY_LEAK");
	});

	test("accepts an already-parsed object", () => {
		const r = summarizeToolFailure({ code: "NAME_COLLISION", error: "taken" }, null);
		expect(r?.code).toBe("NAME_COLLISION");
		expect(r?.failureClass).toBe("execution");
	});

	test("uses `message` when the payload has no `error`", () => {
		const r = summarizeToolFailure({ code: "INSTALL_FAILED", message: "boom" }, null);
		expect(r?.message).toBe("boom");
	});

	test("plain-text error (no JSON) → unclassified execution failure, text kept", () => {
		const r = summarizeToolFailure("Tool timed out after 30s", null);
		expect(r?.code).toBeUndefined();
		expect(r?.failureClass).toBe("execution");
		expect(r?.label).toBe("Run failed");
		expect(r?.message).toBe("Tool timed out after 30s");
	});

	test("an unknown code still reports the code, classed as execution", () => {
		const r = summarizeToolFailure(err("SOME_FUTURE_CODE", "hmm"), null);
		expect(r?.code).toBe("SOME_FUTURE_CODE");
		expect(r?.failureClass).toBe("execution");
		expect(r?.label).toBe("Run failed · SOME_FUTURE_CODE");
	});

	test("a code with no message falls back to the class label as the message", () => {
		const r = summarizeToolFailure(JSON.stringify({ code: "VERIFY_FAILED" }), null);
		expect(r?.message).toBe("Run failed");
	});

	test("long messages are truncated for the header", () => {
		const long = "x".repeat(200);
		const r = summarizeToolFailure(err("VERIFY_FAILED", long), null, 40);
		expect(r?.message.length).toBe(40);
		expect(r?.message.endsWith("...")).toBe(true);
	});

	test("nothing to say → null (caller keeps its bare treatment)", () => {
		expect(summarizeToolFailure(null, null)).toBeNull();
		expect(summarizeToolFailure(undefined, undefined)).toBeNull();
		expect(summarizeToolFailure("", "")).toBeNull();
		expect(summarizeToolFailure([1, 2], 42)).toBeNull();
		// Structured but empty: no code, no message → nothing to report.
		expect(summarizeToolFailure(JSON.stringify({ ok: false }), null)).toBeNull();
	});

	test("unparseable text is kept verbatim (it IS the error)", () => {
		const r = summarizeToolFailure("{bad json", null);
		expect(r?.message).toBe("{bad json");
		expect(r?.failureClass).toBe("execution");
	});
});

describe("FAILURE_CLASS_BY_CODE — host contract coverage", () => {
	test("every AuthorInstallErrorCode is classified", () => {
		// Mirrors `AuthorInstallErrorCode` in src/extensions/author-install.ts.
		for (const code of [
			"DRAFT_NOT_FOUND",
			"NOT_EXTENSION_DRAFT",
			"DRAFT_DIR_MISSING",
			"MANIFEST_INVALID",
			"VERIFY_FAILED",
			"NAME_COLLISION",
			"ENV_KEY_LEAK",
			"INSTALL_FAILED",
			"ROLLBACK_FAILED",
			"ENABLE_FAILED",
			"REGISTRY_RELOAD_FAILED",
		]) {
			expect(FAILURE_CLASS_BY_CODE[code]).toBeDefined();
		}
	});

	test("every ReopenErrorCode is classified", () => {
		// Mirrors `ReopenErrorCode` in src/extensions/reopen-extension.ts.
		for (const code of [
			"NOT_FOUND_OR_NOT_MODIFIABLE",
			"NO_INSTALL_PATH",
			"NO_FILES",
			"UNREADABLE_FILE",
			"DRAFT_FAILED",
		]) {
			expect(FAILURE_CLASS_BY_CODE[code]).toBeDefined();
		}
	});
});
