/**
 * DOM tests for SuggestionPopover.svelte.
 *
 * Covers the suggestion-popover contract:
 *   - closed when open=false; header + chips when open
 *   - extension chips are clickable (onselecttool); built-in chips are
 *     informational spans (no action)
 *   - enhancement row: loading shimmer, Apply → onapply, applied state
 *     swaps Apply for Undo → onundo, reason surfaces as tooltip
 *   - dismiss × fires ondismiss
 */
import { render, cleanup, fireEvent } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import SuggestionPopover from "../SuggestionPopover.svelte";
import type { SuggestedTool } from "$lib/composer-suggest-logic";

afterEach(() => cleanup());

const EXT_TOOL: SuggestedTool = {
	name: "scan",
	extension: "analyzer",
	extensionType: "extension",
	description: "Scan source code",
	score: 0.91,
};
const BUILTIN_TOOL: SuggestedTool = {
	name: "task_create",
	extension: "ez",
	extensionType: "built-in",
	description: "Create a task",
	score: 0.55,
};

function makeProps(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		open: true,
		tools: [EXT_TOOL, BUILTIN_TOOL],
		enhancement: null,
		enhanceLoading: false,
		applied: false,
		onselecttool: vi.fn(),
		onapply: vi.fn(),
		onundo: vi.fn(),
		ondismiss: vi.fn(),
		...overrides,
	};
}

describe("SuggestionPopover", () => {
	test("renders nothing when closed", () => {
		const { queryByTestId } = render(SuggestionPopover, makeProps({ open: false }));
		expect(queryByTestId("suggestion-popover")).not.toBeInTheDocument();
	});

	test("open: header, one chip per tool, dismiss control", async () => {
		const props = makeProps();
		const { getByTestId, getAllByTestId, getByText } = render(SuggestionPopover, props);
		expect(getByTestId("suggestion-popover")).toBeInTheDocument();
		expect(getByText("✦ Suggested")).toBeInTheDocument();
		expect(getAllByTestId("suggestion-tool-chip")).toHaveLength(2);
		await fireEvent.click(getByTestId("suggestion-dismiss"));
		expect(props.ondismiss).toHaveBeenCalledOnce();
	});

	test("extension chip is a button that fires onselecttool with the tool", async () => {
		const props = makeProps({ tools: [EXT_TOOL] });
		const { getByTestId } = render(SuggestionPopover, props);
		const chip = getByTestId("suggestion-tool-chip");
		expect(chip.tagName).toBe("BUTTON");
		expect(chip).toHaveAttribute("title", expect.stringContaining("Scan source code"));
		await fireEvent.click(chip);
		expect(props.onselecttool).toHaveBeenCalledWith(EXT_TOOL);
	});

	test("built-in chip is an informational span (no click action)", () => {
		const { getByTestId } = render(SuggestionPopover, makeProps({ tools: [BUILTIN_TOOL] }));
		const chip = getByTestId("suggestion-tool-chip");
		expect(chip.tagName).toBe("SPAN");
		expect(chip).toHaveAttribute("title", "Create a task");
	});

	test("enhance loading shimmer renders instead of the enhancement row", () => {
		const { getByTestId, queryByTestId } = render(
			SuggestionPopover,
			makeProps({ enhanceLoading: true, enhancement: { enhanced: "e", reason: "r" } }),
		);
		expect(getByTestId("suggestion-enhance-loading")).toBeInTheDocument();
		expect(queryByTestId("suggestion-enhance-row")).not.toBeInTheDocument();
	});

	test("enhancement row: text + reason tooltip + Apply fires onapply", async () => {
		const props = makeProps({
			enhancement: { enhanced: "Review src/ and list top 3 bugs", reason: "more specific" },
		});
		const { getByTestId, getByText } = render(SuggestionPopover, props);
		expect(getByText("Review src/ and list top 3 bugs")).toBeInTheDocument();
		const apply = getByTestId("suggestion-apply");
		expect(apply).toHaveAttribute("title", "more specific");
		await fireEvent.click(apply);
		expect(props.onapply).toHaveBeenCalledOnce();
	});

	test("applied state swaps Apply for Undo which fires onundo", async () => {
		const props = makeProps({
			enhancement: { enhanced: "Better", reason: "r" },
			applied: true,
		});
		const { getByTestId, queryByTestId } = render(SuggestionPopover, props);
		expect(queryByTestId("suggestion-apply")).not.toBeInTheDocument();
		await fireEvent.click(getByTestId("suggestion-undo"));
		expect(props.onundo).toHaveBeenCalledOnce();
	});

	test("no enhancement and not loading → only the chip row renders", () => {
		const { queryByTestId } = render(SuggestionPopover, makeProps());
		expect(queryByTestId("suggestion-enhance-row")).not.toBeInTheDocument();
		expect(queryByTestId("suggestion-enhance-loading")).not.toBeInTheDocument();
	});

	test("every extension chip label is extension-prefixed (extension first, always)", () => {
		// Short tool names collide across extensions (live: three weather
		// extensions each expose "weather-now"). Every chip now leads with its
		// extension unconditionally, so look-alike tools are always distinguishable.
		const clash = (extension: string): SuggestedTool => ({
			name: "weather-now",
			extension,
			extensionType: "extension",
			description: `Weather via ${extension}`,
			score: 0.5,
		});
		const { getAllByTestId } = render(
			SuggestionPopover,
			makeProps({ tools: [clash("open-meteo"), clash("weather-api"), EXT_TOOL] }),
		);
		const labels = getAllByTestId("suggestion-tool-chip").map((c) => c.textContent?.trim());
		expect(labels).toContain("🔧 open-meteo · weather-now");
		expect(labels).toContain("🔧 weather-api · weather-now");
		expect(labels).toContain("🔧 analyzer · scan");
	});

	test("built-in chip label is extension-prefixed too (no 🔧 glyph)", () => {
		const { getByTestId } = render(SuggestionPopover, makeProps({ tools: [BUILTIN_TOOL] }));
		expect(getByTestId("suggestion-tool-chip").textContent?.trim()).toBe("ez · task_create");
	});

	test("both chip variants carry data-tool + data-extension", () => {
		const { getAllByTestId } = render(SuggestionPopover, makeProps());
		const chips = getAllByTestId("suggestion-tool-chip");
		const extChip = chips.find((c) => c.tagName === "BUTTON")!;
		const builtinChip = chips.find((c) => c.tagName === "SPAN")!;
		expect(extChip).toHaveAttribute("data-tool", "scan");
		expect(extChip).toHaveAttribute("data-extension", "analyzer");
		expect(builtinChip).toHaveAttribute("data-tool", "task_create");
		expect(builtinChip).toHaveAttribute("data-extension", "ez");
	});
});
