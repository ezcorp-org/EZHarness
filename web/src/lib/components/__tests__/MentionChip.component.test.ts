/**
 * DOM tests for MentionChip.svelte sigil mapping.
 *
 * Regression guard for the silent-fall-through bug where the sigil
 * ternary `isPath ? '@' : isCommand ? '/' : '!'` defaulted '!' for
 * any kind it didn't recognize — including the new 'feature' kind.
 * Compounded by four call sites narrowing `seg.kind` to a union that
 * dropped 'feature' before it ever reached the chip. Fix landed in
 * commit 5d3b219e; this test locks the sigil per kind so a future
 * kind addition can't silently regress to '!' again.
 *
 * The `lesson` kind reproduced the same bug shape (caught only by
 * live smoke test on 2026-05-06 — chip rendered `!use-bun-not-node`
 * despite the canonical token being `%[lesson:use-bun-not-node]`).
 * The bug existed because Phase 2A updated the parser + popover but
 * not this chip. The test cases below now lock all nine kinds.
 *
 * The COLOUR ternary had the same fall-through shape as the sigil one,
 * and it had already bitten: `extension` and `feature` both landed on the
 * purple default, so two different kinds rendered identically with no
 * type error. The palette test at the bottom now asserts every kind's
 * pill colour is unique, which is the property the union alone can't give.
 */

import { render } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import MentionChip from "../MentionChip.svelte";

beforeEach(() => {
	// Command chips lazy-fetch the prompt body on hover; stub fetch so
	// jsdom doesn't surface unhandled rejections during the smoke render.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
	);
});

describe("MentionChip — sigil per kind", () => {
	const cases: Array<{
		kind:
			| "agent"
			| "extension"
			| "team"
			| "file"
			| "dir"
			| "command"
			| "feature"
			| "lesson"
			| "workflow";
		name: string;
		expectedText: string;
	}> = [
		{ kind: "agent", name: "researcher", expectedText: "!researcher" },
		{ kind: "extension", name: "ai-kit", expectedText: "!ai-kit" },
		{ kind: "team", name: "ops", expectedText: "!ops" },
		// Path kinds render the basename in the chip; full path goes
		// into the tooltip. Dir chips append a trailing slash.
		{ kind: "file", name: "src/foo/bar.ts", expectedText: "@bar.ts" },
		{ kind: "dir", name: "src/foo", expectedText: "@foo/" },
		{ kind: "command", name: "review", expectedText: "/review" },
		{ kind: "feature", name: "chat-attachments", expectedText: "$chat-attachments" },
		{ kind: "lesson", name: "use-bun-not-node", expectedText: "%use-bun-not-node" },
		// Workflow chips render BARE (`!deploy`), not `!workflow:deploy` —
		// agent / extension / team all render bare under the `!` sigil and
		// are told apart by colour. EZ is the deliberate exception because
		// it isn't a nameable entity.
		{ kind: "workflow", name: "deploy", expectedText: "!deploy" },
	];

	for (const c of cases) {
		test(`kind="${c.kind}" → "${c.expectedText}"`, () => {
			const { container } = render(MentionChip, { name: c.name, kind: c.kind });
			// The visible chip text is the concatenation of {sigil}{displayName}
			// rendered into the inline pill span. textContent collapses any
			// nested status-dot span that has no text of its own.
			const chip = container.querySelector(
				`[data-mention-kind="${c.kind}"]`,
			) as HTMLElement | null;
			expect(chip).not.toBeNull();
			expect(chip!.textContent).toBe(c.expectedText);
		});
	}

	test("every kind gets a pill colour of its own — no two kinds render alike", () => {
		// The union alone can't catch a colour collision: `extension` and
		// `feature` were both valid kinds that both fell through to the
		// purple default, so they were indistinguishable on screen with no
		// type error. Render each kind and assert the palette classes are
		// pairwise distinct, which is the property users actually rely on.
		//
		// `EZ` is included here (it's a real kind) even though the sigil
		// cases above cover it via its `EZ:`-prefixed display name.
		const known = [
			"agent",
			"extension",
			"team",
			"EZ",
			"workflow",
			"file",
			"dir",
			"command",
			"feature",
			"lesson",
		] as const;

		// Palette classes only: `border-teal-500/30`, `bg-teal-500/20`,
		// `text-teal-300`. Skips layout/typography utilities (`border`,
		// `text-xs`, `px-1.5`) which are identical for every kind.
		const PALETTE_CLASS = /^(border|bg|text)-[a-z]+-\d+/;

		const byPalette = new Map<string, string>();
		for (const kind of known) {
			const { container } = render(MentionChip, { name: "thing", kind });
			const chip = container.querySelector(
				`[data-mention-kind="${kind}"]`,
			) as HTMLElement | null;
			expect(chip).not.toBeNull();

			const palette = [...chip!.classList]
				.filter((c) => PALETTE_CLASS.test(c))
				.sort()
				.join(" ");
			// A kind with no palette classes at all would mean the lookup
			// silently returned undefined without even the fallback.
			expect(palette).not.toBe("");

			const collidesWith = byPalette.get(palette);
			expect(
				collidesWith,
				`kind "${kind}" renders the same pill colour as "${collidesWith}"`,
			).toBeUndefined();
			byPalette.set(palette, kind);
		}

		expect(byPalette.size).toBe(known.length);
	});
});
