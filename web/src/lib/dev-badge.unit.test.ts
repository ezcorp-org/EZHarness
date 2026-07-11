/**
 * Unit tests for readDevBadge — the pure dataset reader behind DevBadge.svelte.
 * Covers every branch: indicator off, indicator on with no values, both
 * values, and each single-value fallback.
 */

import { describe, expect, test } from "vitest";
import { readDevBadge } from "./dev-badge.js";

// readDevBadge only reads string properties, so a plain object stands in for
// the real `document.documentElement.dataset` DOMStringMap.
function ds(props: Record<string, string>): DOMStringMap {
	return props as unknown as DOMStringMap;
}

describe("readDevBadge", () => {
	test("returns null when the dev indicator is absent", () => {
		expect(readDevBadge(ds({ devBranch: "main", devCommit: "abc1234" }))).toBeNull();
	});

	test("returns null when in dev mode but branch and commit are empty/whitespace", () => {
		expect(readDevBadge(ds({ devIndicator: "1", devBranch: "  ", devCommit: "" }))).toBeNull();
	});

	test("returns trimmed branch + commit when both are present", () => {
		expect(readDevBadge(ds({ devIndicator: "1", devBranch: "  feat/x  ", devCommit: " a1b2c3d " }))).toEqual({
			branch: "feat/x",
			commit: "a1b2c3d",
		});
	});

	test("falls back to commit='unknown' when only branch is present", () => {
		expect(readDevBadge(ds({ devIndicator: "1", devBranch: "main" }))).toEqual({
			branch: "main",
			commit: "unknown",
		});
	});

	test("falls back to branch='HEAD' when only commit is present", () => {
		expect(readDevBadge(ds({ devIndicator: "1", devCommit: "deadbee" }))).toEqual({
			branch: "HEAD",
			commit: "deadbee",
		});
	});
});
