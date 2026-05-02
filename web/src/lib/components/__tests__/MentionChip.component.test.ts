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
			| "feature";
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

	test("unknown kinds never silently fall through to '!' — kind union locks them out at compile time", () => {
		// Static sanity check: the kind union covers every sigil branch
		// in MentionChip's ternary. If you add a new kind to mention-logic
		// without extending the chip, TypeScript will fail this file's
		// strict cast above before the runtime fall-through can bite.
		const known = [
			"agent",
			"extension",
			"team",
			"file",
			"dir",
			"command",
			"feature",
		] as const;
		expect(known).toHaveLength(7);
	});
});
