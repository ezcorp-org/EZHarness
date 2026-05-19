/**
 * Phase 6 sub-plan 06-01 — Agents nav link policy.
 *
 * The (app) +layout.svelte navLinks $derived expression includes the
 * Agents link in BOTH branches of the isGlobalProject ternary:
 *   - isGlobalProject=true:  group="Build"     (line 190)
 *   - isGlobalProject=false: group="Platform"  (line 202)
 *
 * Why source-read instead of render: same rationale as
 * layout-mobile-breakpoint.test.ts. jsdom doesn't reactive-derive
 * $derived from a $state-bound `isGlobalProject` cleanly, and the
 * link rendering pulls in MentionText, group-by collation, and
 * mobile drawer mounting. Source-read pins the policy without
 * per-render overhead.
 *
 * Regression: if someone removes the Agents link from EITHER
 * branch (e.g., re-orgs nav under a different label or moves it
 * to /personas), this test fails — preserving the v1.0 Phase 6
 * sub-plan 06-01 contract.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";

const layoutSrc = readFileSync(
	new URL("../routes/(app)/+layout.svelte", import.meta.url),
	"utf-8",
);

describe("(app) layout — Phase 6 Agents nav link policy", () => {
	test("global-project branch includes Agents link in Build group", () => {
		// Must match the exact shape: href, label, group as a single object literal.
		// Allow whitespace flexibility between fields, but pin all three keys.
		expect(layoutSrc).toMatch(
			/\{\s*href:\s*"\/agents",\s*label:\s*"Agents",\s*group:\s*"Build"\s*\}/,
		);
	});

	test("per-project branch includes Agents link in Platform group", () => {
		expect(layoutSrc).toMatch(
			/\{\s*href:\s*"\/agents",\s*label:\s*"Agents",\s*group:\s*"Platform"\s*\}/,
		);
	});

	test("Agents link appears exactly twice in the layout source", () => {
		// Defensive: count occurrences of the href="/agents" with adjacent label="Agents".
		// If a regression duplicates the link (e.g., into the API Docs spread or admin
		// branch), we want to know.
		const matches =
			layoutSrc.match(/href:\s*"\/agents",\s*label:\s*"Agents"/g) ?? [];
		expect(matches).toHaveLength(2);
	});
});
