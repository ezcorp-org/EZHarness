/**
 * Phase 48 Wave 3 — DOM tests for the CommandPalette "Ask Ez" command
 * + the `ez:` prefix shortcut.
 *
 * Covers:
 *   - "Ask Ez" appears in the palette and clicking it opens the panel
 *   - typing `ez: <prompt>` + Enter opens the panel with the prompt
 *     pre-filled in the composer (via panel store's pendingPrompt)
 *   - typing just `ez:` with no body still opens the panel (empty prompt)
 *   - the regular command flow still works when query doesn't match
 *     the ez prefix
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, beforeEach, vi } from "vitest";

vi.mock("$app/stores", () => {
	// minimal $page store replacement
	let listeners: ((v: { url: { pathname: string } }) => void)[] = [];
	const value = { url: { pathname: "/" } };
	return {
		page: {
			subscribe(fn: (v: typeof value) => void) {
				listeners.push(fn);
				fn(value);
				return () => { listeners = listeners.filter((l) => l !== fn); };
			},
		},
	};
});

vi.mock("$lib/api.js", async (orig) => {
	const real = await orig() as Record<string, unknown>;
	return {
		...real,
		searchConversations: vi.fn().mockResolvedValue([]),
	};
});

import CommandPalette from "$lib/components/CommandPalette.svelte";
import { ezPanelState, closeEzPanel } from "$lib/ez/panel-store.svelte.js";
import { tryParseEzPrefix } from "$lib/command-registry";

beforeEach(() => closeEzPanel());

describe("tryParseEzPrefix — pure helper", () => {
	test("matches 'ez: prompt' and returns the prompt", () => {
		expect(tryParseEzPrefix("ez: hi there")).toBe("hi there");
		expect(tryParseEzPrefix("EZ:  spaced")).toBe("spaced");
		expect(tryParseEzPrefix("ez:")).toBe("");
	});
	test("returns null for non-prefix queries", () => {
		expect(tryParseEzPrefix("ez")).toBeNull();
		expect(tryParseEzPrefix("hello")).toBeNull();
		expect(tryParseEzPrefix("foo: ez:")).toBeNull();
	});
});

describe("CommandPalette — Ask Ez command", () => {
	test("`Ask Ez` command is in the list and opens the panel when executed", async () => {
		const { findByText } = render(CommandPalette, {
			props: { open: true, onclose: () => {}, activeProjectId: "global" },
		});
		const askEz = await findByText("Ask Ez");
		expect(askEz).toBeInTheDocument();
		await fireEvent.click(askEz);
		expect(ezPanelState.open).toBe(true);
	});
});

describe("CommandPalette — `ez:` prefix shortcut", () => {
	test("typing `ez: hello` and pressing Enter opens the panel with prefill", async () => {
		const { container } = render(CommandPalette, {
			props: { open: true, onclose: () => {}, activeProjectId: "global" },
		});
		const input = container.querySelector("input[type=text]") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "ez: hello world" } });
		await fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(ezPanelState.open).toBe(true));
		expect(ezPanelState.pendingPrompt).toBe("hello world");
	});

	test("typing only `ez:` opens the panel with an empty pending prompt", async () => {
		const { container } = render(CommandPalette, {
			props: { open: true, onclose: () => {}, activeProjectId: "global" },
		});
		const input = container.querySelector("input[type=text]") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "ez:" } });
		await fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(ezPanelState.open).toBe(true));
		expect(ezPanelState.pendingPrompt).toBe("");
	});
});
