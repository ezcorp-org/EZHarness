/**
 * DOM tests for ConversationToolsSelector.svelte — the chat composer's
 * per-conversation tool scoping popover (Phase 4/D).
 *
 * Coverage:
 *   - Renders the active mode's attached extensions + their tools.
 *   - Mode's own extensionTools subset constrains the listed tools.
 *   - Toggling a tool off calls onchange with the narrowed map.
 *   - "Inherited" vs "Customized" state label.
 *   - Reset is disabled when inheriting; calls onreset when customized.
 *   - Empty/disabled state when no mode (or mode has no extensions).
 *   - Count badge reflects the active tool count.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";

import ConversationToolsSelector from "$lib/components/ConversationToolsSelector.svelte";
import type { Mode } from "$lib/api";

function mockExtensionsApi(extensions: unknown[]) {
	const fetchMock = vi.fn(async (url: string) => {
		if (url === "/api/extensions") {
			return new Response(JSON.stringify({ extensions }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return new Response("", { status: 404 });
	});
	(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

const TWO_TOOL_EXT = {
	id: "ext-1",
	name: "summarizer",
	manifest: { tools: [{ name: "summarize" }, { name: "tldr" }] },
};

function makeMode(overrides: Partial<Mode> = {}): Mode {
	return {
		id: "m1",
		name: "Research",
		slug: "research",
		icon: null,
		description: "",
		systemPromptInstruction: "",
		instructionPosition: "prepend",
		preferredModel: null,
		preferredProvider: null,
		preferredThinkingLevel: null,
		temperature: null,
		toolRestriction: "all",
		extensionIds: ["ext-1"],
		extensionTools: null,
		builtin: false,
		...overrides,
	};
}

beforeEach(() => {
	vi.restoreAllMocks();
});

describe("ConversationToolsSelector", () => {
	test("renders the mode's attached extensions + tools when opened", async () => {
		mockExtensionsApi([TWO_TOOL_EXT]);
		const { getByTestId, findByTestId } = render(ConversationToolsSelector, {
			selectedMode: makeMode(),
			value: null,
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		await findByTestId("conv-tool-ext-1-summarize");
		await findByTestId("conv-tool-ext-1-tldr");
	});

	test("all tools checked by default when inheriting (value=null)", async () => {
		mockExtensionsApi([TWO_TOOL_EXT]);
		const { getByTestId, findByTestId } = render(ConversationToolsSelector, {
			selectedMode: makeMode(),
			value: null,
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		const a = (await findByTestId("conv-tool-ext-1-summarize")) as HTMLInputElement;
		const b = (await findByTestId("conv-tool-ext-1-tldr")) as HTMLInputElement;
		expect(a.checked).toBe(true);
		expect(b.checked).toBe(true);
		// State label reads "Inherited from {mode}".
		expect(getByTestId("conversation-tools-state").textContent).toContain("Inherited");
	});

	test("toggling a tool off calls onchange with the narrowed map", async () => {
		mockExtensionsApi([TWO_TOOL_EXT]);
		const onchange = vi.fn();
		const { getByTestId, findByTestId } = render(ConversationToolsSelector, {
			selectedMode: makeMode(),
			value: null,
			onchange,
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		const b = (await findByTestId("conv-tool-ext-1-tldr")) as HTMLInputElement;
		await fireEvent.click(b);
		expect(onchange).toHaveBeenCalledWith({ "ext-1": ["summarize"] });
	});

	test("the mode's own subset constrains the listed tools", async () => {
		mockExtensionsApi([TWO_TOOL_EXT]);
		const { getByTestId, findByTestId, queryByTestId } = render(ConversationToolsSelector, {
			// Mode only grants summarize → tldr should not be listed.
			selectedMode: makeMode({ extensionTools: { "ext-1": ["summarize"] } }),
			value: null,
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		await findByTestId("conv-tool-ext-1-summarize");
		expect(queryByTestId("conv-tool-ext-1-tldr")).toBeNull();
	});

	test("Customized state + Reset calls onreset", async () => {
		mockExtensionsApi([TWO_TOOL_EXT]);
		const onreset = vi.fn();
		const { getByTestId, findByTestId } = render(ConversationToolsSelector, {
			selectedMode: makeMode(),
			value: { "ext-1": ["summarize"] },
			onchange: vi.fn(),
			onreset,
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		expect((await findByTestId("conversation-tools-state")).textContent).toContain("Customized");
		const reset = (await findByTestId("conversation-tools-reset")) as HTMLButtonElement;
		expect(reset.disabled).toBe(false);
		await fireEvent.click(reset);
		expect(onreset).toHaveBeenCalledTimes(1);
	});

	test("Reset is disabled while inheriting", async () => {
		mockExtensionsApi([TWO_TOOL_EXT]);
		const { getByTestId, findByTestId } = render(ConversationToolsSelector, {
			selectedMode: makeMode(),
			value: null,
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		const reset = (await findByTestId("conversation-tools-reset")) as HTMLButtonElement;
		expect(reset.disabled).toBe(true);
	});

	test("empty/disabled state when no mode extensions are attached", async () => {
		mockExtensionsApi([TWO_TOOL_EXT]);
		const { getByTestId, findByTestId, queryByTestId } = render(ConversationToolsSelector, {
			selectedMode: makeMode({ extensionIds: [] }),
			value: null,
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		await findByTestId("conversation-tools-empty");
		// No count badge without a mode.
		expect(queryByTestId("conversation-tools-count")).toBeNull();
	});

	test("count badge reflects the active tool count", async () => {
		mockExtensionsApi([TWO_TOOL_EXT]);
		const { getByTestId } = render(ConversationToolsSelector, {
			selectedMode: makeMode(),
			value: { "ext-1": ["summarize"] },
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		// 1 active tool (summarize) under the conversation override. The count
		// derives from the loaded extension manifest, so wait for the onMount
		// fetch to resolve.
		await waitFor(() =>
			expect(getByTestId("conversation-tools-count").textContent?.trim()).toBe("1"),
		);
	});
});
