/**
 * Phase 57 — GAP-57-A regression: BottomSheet wrap across all 9 pickers.
 *
 * Without this test, a future refactor could silently strip <BottomSheet>
 * from one picker and only the fixme'd e2e (bottom-sheet-pickers.spec.ts,
 * blocked on auth-fixture infra per Plan 57-03 SUMMARY) would catch it.
 *
 * Approach: source-text assertion (read each picker's .svelte via node:fs,
 * grep for `BottomSheet` + `bp.below`). Cheaper than mounting 9 pickers
 * with distinct prop/fetch setups, and the contract IS static-text:
 * Plan 57-02 (AssignmentPicker smoke) + Plan 57-03 (other 8 pickers) both
 * landed the wrap as `import BottomSheet ...` + `{#if open && bp.below}<BottomSheet ...>`.
 *
 * Verifier (57-VERIFICATION.md key links table) confirmed all 9 carry
 * the wrap by grep — this codifies the grep into a regression.
 *
 * Runner: vitest (jsdom env, but no DOM is used — only file IO).
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PICKERS = [
	"AgentSearchPicker.svelte",
	"AssignmentPicker.svelte",
	"ExtensionAttachPicker.svelte",
	"ExtensionSearchPicker.svelte",
	"FilePicker.svelte",
	"ModelSearchPicker.svelte",
	"ModeSearchPicker.svelte",
	"ProjectPicker.svelte",
	"ToolSearchPicker.svelte",
] as const;

function readPickerSource(filename: string): string {
	const path = resolve(__dirname, "..", filename);
	return readFileSync(path, "utf8");
}

describe("UX-01: all 9 pickers wrap body in BottomSheet on <lg (GAP-57-A)", () => {
	for (const filename of PICKERS) {
		test(`${filename} imports BottomSheet`, () => {
			const src = readPickerSource(filename);
			// Matches both `import BottomSheet from "..."` and the
			// `<BottomSheet ...>` element. A picker that loses the wrap
			// would lose BOTH and fail this assertion.
			expect(src).toContain("BottomSheet");
		});

		test(`${filename} uses bp.below conditional`, () => {
			const src = readPickerSource(filename);
			// Locks the breakpoint-gated render: `{#if ... bp.below ...}`.
			// A picker that switched to `bp.above` or removed the
			// conditional would fail here.
			expect(src).toContain("bp.below");
		});
	}
});
