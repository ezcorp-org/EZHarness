/**
 * DOM tests for the EZ group in MentionPopover.svelte.
 *
 * Coverage targets (per validator nice-to-have #2):
 *   - Mounting with a mixed `items` array including a `kind: "EZ"`
 *     entry renders the "EZ actions" group header.
 *   - The EZ row uses `orange-` Tailwind tokens (post-fix-#2 color
 *     consistency: chip and popover row both use orange, where the
 *     popover originally used amber and collided with `dir`).
 *   - data-mention-kind="EZ" attribute is present on the row so
 *     downstream selectors / tests can locate it the same way they
 *     locate chips.
 *
 * Pre-fix this group was only exercised by the Playwright E2E spec —
 * the chip↔popover color mismatch wasn't caught until a manual review.
 * Locking the color via jsdom prevents an amber-→-orange-→-amber
 * regression slipping in silently.
 */
import { render } from "@testing-library/svelte";
import { describe, test, expect, beforeAll } from "vitest";
import MentionPopover from "../MentionPopover.svelte";

// Local shape mirror of `MentionItem` from MentionPopover.svelte.
// Inlined because raw tsc can't resolve named exports from a `.svelte`
// module declaration (Svelte preprocesses .svelte files, but the
// scripts/typecheck.sh harness invokes raw tsc on the web workspace
// for unrelated reasons). See MentionPopover.svelte for the canonical
// definition — the kinds union is closed and lives in one place there.
type MentionKind =
	| "agent"
	| "extension"
	| "team"
	| "EZ"
	| "file"
	| "dir"
	| "dir-target"
	| "command"
	| "feature"
	| "lesson";
interface MentionItem {
	name: string;
	description: string;
	kind: MentionKind;
	source?: string;
	fileCount?: number;
}

// jsdom doesn't implement Element.prototype.scrollIntoView, but the
// popover's $effect calls it whenever the highlighted index changes.
// Stub a no-op so the effect doesn't throw.
beforeAll(() => {
	if (!Element.prototype.scrollIntoView) {
		Element.prototype.scrollIntoView = () => {};
	}
});

function ezItem(name: string, description = "test action"): MentionItem {
	return { name, description, kind: "EZ" };
}

function noop() {}

describe("MentionPopover — EZ group", () => {
	test('renders "EZ actions" group header when items contain an EZ entry', () => {
		const { getByText } = render(MentionPopover, {
			items: [ezItem("distill", "Capture a lesson from this conversation")],
			open: true,
			loading: false,
			triggerQuery: "",
			onselect: noop,
			ondismiss: noop,
		});
		// Group header rendered.
		expect(getByText("EZ actions")).toBeTruthy();
	});

	test("EZ row uses orange-* Tailwind tokens (NOT amber, which would collide with dir)", () => {
		const { container } = render(MentionPopover, {
			items: [ezItem("distill")],
			open: true,
			loading: false,
			triggerQuery: "",
			onselect: noop,
			ondismiss: noop,
		});
		// The popover row is a <button> tagged with data-mention-kind="EZ"
		// post-fix. Locate it the same way the chip test does.
		const row = container.querySelector(
			'button[data-mention-kind="EZ"]',
		) as HTMLElement | null;
		expect(row).not.toBeNull();
		const cls = row!.className;
		// Color tokens — the row uses border-orange-500/60 + the inner
		// label uses text-orange-300. Assert both: the border on the
		// row's class string, and the label's class via a child query.
		expect(cls).toContain("border-orange-500/60");
		expect(cls).not.toContain("border-amber-500/60");

		const label = row!.querySelector(
			"span.text-orange-300",
		) as HTMLElement | null;
		expect(label).not.toBeNull();
		expect(label!.textContent).toBe("!EZ:distill");
	});

	test("EZ entries DO NOT render under another group header (regression: dir/EZ collision)", () => {
		// Pre-fix the popover EZ row was styled with amber AND
		// rendered next to the dir group (also amber). Mixing dir +
		// EZ items in `items` shows both groups distinctly.
		const items: MentionItem[] = [
			ezItem("distill"),
			{
				name: "src/foo",
				description: "/src/foo",
				kind: "dir",
			},
		];
		const { container, getByText } = render(MentionPopover, {
			items,
			open: true,
			loading: false,
			triggerQuery: "",
			onselect: noop,
			ondismiss: noop,
		});

		// Both group headers present.
		expect(getByText("EZ actions")).toBeTruthy();
		expect(getByText("Folders")).toBeTruthy();

		// The EZ row carries the EZ marker; the dir row does not.
		const ezRow = container.querySelector('button[data-mention-kind="EZ"]');
		expect(ezRow).not.toBeNull();
		// Verify the dir row is a separate button. It doesn't carry
		// data-mention-kind="EZ" (no false positives).
		const allButtons = container.querySelectorAll("button[role=\"option\"]");
		// Two rows — one EZ, one dir.
		expect(allButtons.length).toBe(2);
		// Only the EZ row is tagged with the marker.
		const ezTagged = container.querySelectorAll(
			'button[data-mention-kind="EZ"]',
		);
		expect(ezTagged.length).toBe(1);
	});
});
