/**
 * DOM tests for the EZ kind in MentionChip.svelte (Phase 4.3 of EZ
 * Actions v1).
 *
 * Coverage targets:
 *   - EZ chip displays sigil + `EZ:<name>` as text → reads as
 *     `!EZ:<name>` in chat history
 *   - EZ chip uses orange styling (distinct from amber, which `dir`
 *     uses, and purple/blue/pink/sky/emerald used by other kinds)
 *   - data-mention-kind="EZ" attribute set for downstream selectors
 *
 * Pattern mirrors `MentionChip.component.test.ts`.
 */
import { render } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import MentionChip from "../MentionChip.svelte";

beforeEach(() => {
	// Other chip kinds lazy-fetch on hover; EZ chips don't, but we
	// stub fetch to be safe against regressions.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			new Response("{}", {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		),
	);
});

describe("MentionChip — EZ kind", () => {
	test("displays `!EZ:<name>` in the chip body", () => {
		const { container } = render(MentionChip, {
			name: "distill",
			kind: "EZ",
		});
		// The chip is the inner span carrying data-mention-kind.
		const chip = container.querySelector(
			'[data-mention-kind="EZ"]',
		) as HTMLElement | null;
		expect(chip).not.toBeNull();
		expect(chip!.textContent).toBe("!EZ:distill");
		expect(chip!.getAttribute("data-mention-name")).toBe("distill");
	});

	test("uses orange-500 color tokens (NOT amber, which is dir's)", () => {
		const { container } = render(MentionChip, {
			name: "distill",
			kind: "EZ",
		});
		const chip = container.querySelector(
			'[data-mention-kind="EZ"]',
		) as HTMLElement;
		// Tailwind utility classes — assert the orange-500 family
		// is on the chip and amber-500 is NOT.
		const cls = chip.className;
		expect(cls).toContain("border-orange-500/30");
		expect(cls).toContain("bg-orange-500/20");
		expect(cls).toContain("text-orange-300");
		// Amber is reserved for dir chips — must not collide.
		expect(cls).not.toContain("bg-amber-500/20");
	});

	test("EZ chip kind survives the same data-attribute round-trip as other kinds", () => {
		// Defensive: the popover and chip-deletion logic both rely on
		// data-mention-kind to identify chip ownership. Locking the
		// attribute value here prevents accidental rename to lowercase.
		const { container } = render(MentionChip, {
			name: "summarize",
			kind: "EZ",
		});
		const chip = container.querySelector("[data-mention-kind]");
		expect(chip!.getAttribute("data-mention-kind")).toBe("EZ");
	});
});
