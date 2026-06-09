/**
 * Prop-forwarding test for ChatInput → ConversationToolsSelector (Issue 2b of
 * the MCP tool-UI fix pass). The per-conversation Tools popover was only
 * covered transitively through the conversation-tools-scope e2e; this asserts
 * the composer itself threads `conversationExtensionTools` (value) and
 * `onextensiontoolschange` (handler) down to the selector.
 *
 * We mount the real ChatInput (not a stub) with a mode that attaches one
 * extension, stub `/api/extensions` so the selector resolves the extension's
 * tool list, and drive the rendered popover:
 *   - the forwarded narrowed `value` makes the selector render "Customized"
 *     with the dropped tool unchecked;
 *   - toggling a tool fires the forwarded `onextensiontoolschange` with the
 *     newly-narrowed map.
 */
import { render, cleanup, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import ChatInput from "./ChatInput.svelte";
import type { Mode } from "$lib/api";

const mode: Mode = {
	id: "mode-scoped",
	name: "Research",
	slug: "research",
	icon: null,
	description: "",
	systemPromptInstruction: "",
	instructionPosition: "append",
	preferredModel: null,
	preferredProvider: null,
	preferredThinkingLevel: null,
	temperature: null,
	toolRestriction: "all",
	extensionIds: ["ext-tools"],
	extensionTools: null,
	builtin: false,
};

const extensionsPayload = [
	{
		id: "ext-tools",
		name: "Toolbox",
		manifest: { tools: [{ name: "alpha" }, { name: "beta" }] },
	},
];

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/extensions")) {
				return new Response(JSON.stringify(extensionsPayload), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("[]", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function renderComposer(extra: Record<string, unknown> = {}) {
	return render(ChatInput, {
		onsubmit: () => {},
		selectedMode: mode,
		modes: [mode],
		...extra,
	});
}

describe("ChatInput → ConversationToolsSelector prop forwarding", () => {
	test("forwards the narrowed `conversationExtensionTools` value into the selector", async () => {
		// `beta` dropped → the selector should render Customized with beta
		// unchecked and alpha checked once it forwards the value through.
		const { getByTestId } = renderComposer({
			conversationExtensionTools: { "ext-tools": ["alpha"] },
			onextensiontoolschange: vi.fn(),
			onextensiontoolsreset: vi.fn(),
		});

		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		await waitFor(() => getByTestId("conversation-tools-popover"));

		expect(getByTestId("conversation-tools-state").textContent).toContain("Customized");
		await waitFor(() => {
			expect((getByTestId("conv-tool-ext-tools-alpha") as HTMLInputElement).checked).toBe(true);
			expect((getByTestId("conv-tool-ext-tools-beta") as HTMLInputElement).checked).toBe(false);
		});
	});

	test("forwards `onextensiontoolschange` — toggling a tool calls it with the narrowed map", async () => {
		const onchange = vi.fn();
		const { getByTestId } = renderComposer({
			conversationExtensionTools: null, // inherit: all tools checked
			onextensiontoolschange: onchange,
			onextensiontoolsreset: vi.fn(),
		});

		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		await waitFor(() => getByTestId("conv-tool-ext-tools-beta"));

		// Uncheck beta → narrows to [alpha]; the forwarded handler receives it.
		await fireEvent.click(getByTestId("conv-tool-ext-tools-beta"));
		expect(onchange).toHaveBeenCalledWith({ "ext-tools": ["alpha"] });
	});

	test("omits the selector when neither change nor reset handler is wired", () => {
		const { queryByTestId } = renderComposer();
		expect(queryByTestId("conversation-tools-trigger")).toBeNull();
	});
});
