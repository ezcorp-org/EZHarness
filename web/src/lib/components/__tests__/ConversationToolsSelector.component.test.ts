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
 *   - Disabled extensions (enabled: false) are excluded from every listing
 *     path; explicit enabled: true and an omitted field both still list.
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
		preferredTier: null,
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

	test("no mode: lists ALL installed extensions' tools so they can be toggled", async () => {
		mockExtensionsApi([
			TWO_TOOL_EXT,
			{ id: "ext-2", name: "analyzer", manifest: { tools: [{ name: "scan" }] } },
		]);
		const { getByTestId, findByTestId } = render(ConversationToolsSelector, {
			selectedMode: makeMode({ extensionIds: [] }),
			value: null,
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		// Both extensions' tools listed, all checked (inherit-all baseline).
		const scan = (await findByTestId("conv-tool-ext-2-scan")) as HTMLInputElement;
		const summarize = (await findByTestId("conv-tool-ext-1-summarize")) as HTMLInputElement;
		expect(scan.checked).toBe(true);
		expect(summarize.checked).toBe(true);
		expect(getByTestId("conversation-tools-state").textContent).toContain("All extensions");
	});

	test("no mode: toggling a tool off calls onchange with the narrowed map", async () => {
		mockExtensionsApi([TWO_TOOL_EXT]);
		const onchange = vi.fn();
		const { getByTestId, findByTestId } = render(ConversationToolsSelector, {
			selectedMode: null,
			value: null,
			onchange,
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		const b = (await findByTestId("conv-tool-ext-1-tldr")) as HTMLInputElement;
		await fireEvent.click(b);
		expect(onchange).toHaveBeenCalledWith({ "ext-1": ["summarize"] });
	});

	test("master toggle: unchecking an extension emits the OFF marker (empty subset)", async () => {
		mockExtensionsApi([TWO_TOOL_EXT]);
		const onchange = vi.fn();
		const { getByTestId, findByTestId } = render(ConversationToolsSelector, {
			selectedMode: makeMode(),
			value: null,
			onchange,
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		const master = (await findByTestId("conv-ext-toggle-ext-1")) as HTMLInputElement;
		expect(master.checked).toBe(true);
		await fireEvent.click(master);
		expect(onchange).toHaveBeenCalledWith({ "ext-1": [] });
	});

	test("master toggle OFF: tools render unchecked; re-toggling clears back to inherit", async () => {
		mockExtensionsApi([TWO_TOOL_EXT]);
		const onchange = vi.fn();
		const { getByTestId, findByTestId } = render(ConversationToolsSelector, {
			selectedMode: makeMode(),
			value: { "ext-1": [] },
			onchange,
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		const master = (await findByTestId("conv-ext-toggle-ext-1")) as HTMLInputElement;
		expect(master.checked).toBe(false);
		const a = (await findByTestId("conv-tool-ext-1-summarize")) as HTMLInputElement;
		const b = (await findByTestId("conv-tool-ext-1-tldr")) as HTMLInputElement;
		expect(a.checked).toBe(false);
		expect(b.checked).toBe(false);
		// OFF counts zero active tools.
		expect(getByTestId("conversation-tools-count").textContent?.trim()).toBe("0");
		// Re-enable: the key is removed (back to "all"/inherit).
		await fireEvent.click(master);
		expect(onchange).toHaveBeenCalledWith({});
	});

	test("checking a tool while the extension is OFF re-enables it as a 1-tool subset", async () => {
		mockExtensionsApi([TWO_TOOL_EXT]);
		const onchange = vi.fn();
		const { getByTestId, findByTestId } = render(ConversationToolsSelector, {
			selectedMode: makeMode(),
			value: { "ext-1": [] },
			onchange,
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		const a = (await findByTestId("conv-tool-ext-1-summarize")) as HTMLInputElement;
		await fireEvent.click(a);
		expect(onchange).toHaveBeenCalledWith({ "ext-1": ["summarize"] });
	});

	test("orchestration extensions (ask-user) are listed under a mode that doesn't attach them", async () => {
		mockExtensionsApi([
			TWO_TOOL_EXT,
			{ id: "ext-askuser", name: "ask-user", manifest: { tools: [{ name: "ask_user_question" }] } },
		]);
		const onchange = vi.fn();
		const { getByTestId, findByTestId } = render(ConversationToolsSelector, {
			selectedMode: makeMode(), // attaches only ext-1
			value: null,
			orchestrationTools: ["ask-user__ask_user_question"],
			onchange,
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		// Mode extension AND the orchestration extension both listed.
		await findByTestId("conv-tool-ext-1-summarize");
		const askUser = (await findByTestId("conv-tool-ext-askuser-ask_user_question")) as HTMLInputElement;
		expect(askUser.checked).toBe(true);
		// Master-toggling ask-user off persists the explicit OFF marker.
		const master = (await findByTestId("conv-ext-toggle-ext-askuser")) as HTMLInputElement;
		await fireEvent.click(master);
		expect(onchange).toHaveBeenCalledWith({ "ext-askuser": [] });
	});

	test("non-orchestration extensions are NOT added to a mode's listing", async () => {
		mockExtensionsApi([
			TWO_TOOL_EXT,
			{ id: "ext-other", name: "other", manifest: { tools: [{ name: "misc" }] } },
		]);
		const { getByTestId, findByTestId, queryByTestId } = render(ConversationToolsSelector, {
			selectedMode: makeMode(), // attaches only ext-1
			value: null,
			orchestrationTools: ["ask-user__ask_user_question"],
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		await findByTestId("conv-tool-ext-1-summarize");
		// "other" isn't mode-attached and exposes no orchestration tool —
		// the mode allowlist excludes it, so no lying toggle is shown.
		expect(queryByTestId("conv-ext-toggle-ext-other")).toBeNull();
	});

	test("no mode: a DISABLED extension is not listed even though it has tools", async () => {
		mockExtensionsApi([
			TWO_TOOL_EXT,
			{
				id: "ext-scratchpad",
				name: "scratchpad",
				enabled: false,
				manifest: { tools: [{ name: "scratchpad_write" }] },
			},
		]);
		const { getByTestId, findByTestId, queryByTestId } = render(ConversationToolsSelector, {
			selectedMode: null,
			value: null,
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		await findByTestId("conv-tool-ext-1-summarize");
		// Disabled extension's tools are never registered — no lying toggle.
		expect(queryByTestId("conv-ext-toggle-ext-scratchpad")).toBeNull();
		expect(queryByTestId("conv-tool-ext-scratchpad-scratchpad_write")).toBeNull();
	});

	test("a DISABLED orchestration extension is not appended to a mode's sections", async () => {
		mockExtensionsApi([
			TWO_TOOL_EXT,
			{ id: "ext-askuser", name: "ask-user", enabled: true, manifest: { tools: [{ name: "ask_user_question" }] } },
			{
				id: "ext-scratchpad",
				name: "scratchpad",
				enabled: false,
				manifest: { tools: [{ name: "scratchpad_write" }] },
			},
		]);
		const { getByTestId, findByTestId, queryByTestId } = render(ConversationToolsSelector, {
			selectedMode: makeMode(), // attaches only ext-1
			value: null,
			orchestrationTools: ["ask-user__ask_user_question", "scratchpad__scratchpad_write"],
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		await findByTestId("conv-tool-ext-1-summarize");
		// The ENABLED orchestration extension rides through the mode allowlist…
		await findByTestId("conv-tool-ext-askuser-ask_user_question");
		// …but the DISABLED one is excluded: its tools were never registered.
		expect(queryByTestId("conv-ext-toggle-ext-scratchpad")).toBeNull();
		expect(queryByTestId("conv-tool-ext-scratchpad-scratchpad_write")).toBeNull();
	});

	test("an extension with enabled: true explicitly still lists (only false excludes)", async () => {
		mockExtensionsApi([{ ...TWO_TOOL_EXT, enabled: true }]);
		const { getByTestId, findByTestId } = render(ConversationToolsSelector, {
			selectedMode: null,
			value: null,
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		const summarize = (await findByTestId("conv-tool-ext-1-summarize")) as HTMLInputElement;
		expect(summarize.checked).toBe(true);
	});

	test("hovering a tool row shows a tooltip with the tool's description", async () => {
		mockExtensionsApi([
			{
				id: "ext-1",
				name: "summarizer",
				description: "Summarization helpers",
				manifest: { tools: [{ name: "summarize", description: "Condense long text" }] },
			},
		]);
		const { getByTestId, findByTestId, getByRole } = render(ConversationToolsSelector, {
			selectedMode: makeMode(),
			value: null,
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		const checkbox = await findByTestId("conv-tool-ext-1-summarize");
		// Tooltip listens on its wrapper span (mouseenter does not bubble):
		// checkbox → label → tooltip span.
		await fireEvent.mouseEnter(checkbox.closest("label")!.parentElement!);
		await waitFor(() => {
			const tip = getByRole("tooltip");
			expect(tip).toHaveTextContent("summarize");
			expect(tip).toHaveTextContent("Condense long text");
		});
	});

	test("hovering the extension header shows the extension's description", async () => {
		mockExtensionsApi([
			{
				id: "ext-1",
				name: "summarizer",
				description: "Summarization helpers",
				manifest: { tools: [{ name: "summarize" }] },
			},
		]);
		const { getByTestId, findByTestId, getByRole } = render(ConversationToolsSelector, {
			selectedMode: makeMode(),
			value: null,
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		const master = await findByTestId("conv-ext-toggle-ext-1");
		await fireEvent.mouseEnter(master.closest("label")!.parentElement!);
		await waitFor(() => {
			expect(getByRole("tooltip")).toHaveTextContent("Summarization helpers");
		});
	});

	test("a tool without a description shows the fallback text on hover", async () => {
		mockExtensionsApi([TWO_TOOL_EXT]);
		const { getByTestId, findByTestId, getByRole } = render(ConversationToolsSelector, {
			selectedMode: makeMode(),
			value: null,
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		const checkbox = await findByTestId("conv-tool-ext-1-summarize");
		await fireEvent.mouseEnter(checkbox.closest("label")!.parentElement!);
		await waitFor(() => {
			expect(getByRole("tooltip")).toHaveTextContent("No description provided.");
		});
	});

	test("empty state only when no installed extension exposes tools", async () => {
		mockExtensionsApi([{ id: "ext-bare", name: "bare", manifest: { tools: [] } }]);
		const { getByTestId, findByTestId, queryByTestId } = render(ConversationToolsSelector, {
			selectedMode: null,
			value: null,
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		await findByTestId("conversation-tools-empty");
		// No count badge when there is nothing to toggle.
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

/**
 * Caller-executed tools are not installed extensions — they live in the
 * conversation's metadata, declared over HTTP by a connected client device.
 * They are synthesised into one pseudo-extension section keyed by the literal
 * `"caller"` so the EXISTING toggle logic handles them with no special case:
 * `tool-scope-logic.ts` reads `map[extId]` and never assumes a UUID.
 */
describe("ConversationToolsSelector — caller-executed tools", () => {
	const CALLER_TOOLS = [
		{ name: "open_app", description: "Open an app on the device" },
		{ name: "capture_screen", description: null },
	];

	/** Serves both onMount reads; `callerTools: null` makes the second 500. */
	function mockBothApis(extensions: unknown[], callerTools: unknown[] | null) {
		const fetchMock = vi.fn(async (url: string) => {
			if (url === "/api/extensions") {
				return new Response(JSON.stringify({ extensions }), { status: 200 });
			}
			if (url === "/api/conversations/conv-1/caller-tools") {
				return callerTools === null
					? new Response("", { status: 500 })
					: new Response(JSON.stringify({ tools: callerTools }), { status: 200 });
			}
			return new Response("", { status: 404 });
		});
		(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
		return fetchMock;
	}

	test("declared tools render as their own section, alongside the extensions", async () => {
		mockBothApis([TWO_TOOL_EXT], CALLER_TOOLS);
		const { getByTestId, findByTestId } = render(ConversationToolsSelector, {
			selectedMode: null,
			value: null,
			conversationId: "conv-1",
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		await findByTestId("conv-tool-ext-1-summarize");
		const open = (await findByTestId("conv-tool-caller-open_app")) as HTMLInputElement;
		expect(open.checked).toBe(true);
		await findByTestId("conv-tool-caller-capture_screen");
		await findByTestId("conv-ext-toggle-caller");
		// 2 extension tools + 2 caller tools.
		expect(getByTestId("conversation-tools-count").textContent?.trim()).toBe("4");
	});

	test("they are listed under a mode too — a mode can never name a caller tool", async () => {
		mockBothApis([TWO_TOOL_EXT], CALLER_TOOLS);
		const { getByTestId, findByTestId } = render(ConversationToolsSelector, {
			selectedMode: makeMode(), // attaches ext-1 only
			value: null,
			conversationId: "conv-1",
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		// The mode attaches ext-1 only, and a mode CANNOT name a caller tool
		// (modes reference extension ids), so the section has to be appended
		// rather than filtered in by the mode allowlist.
		const open = (await findByTestId("conv-tool-caller-open_app")) as HTMLInputElement;
		expect(open.checked).toBe(true);
		expect((await findByTestId("conv-ext-toggle-caller")) as HTMLInputElement).toBeChecked();
	});

	test("toggling one flows through the UNMODIFIED tool-scope logic", async () => {
		mockBothApis([], CALLER_TOOLS);
		const onchange = vi.fn();
		const { getByTestId, findByTestId } = render(ConversationToolsSelector, {
			selectedMode: null,
			value: null,
			conversationId: "conv-1",
			onchange,
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		await fireEvent.click(await findByTestId("conv-tool-caller-capture_screen"));
		// Plain `map[extId]` — the literal "caller" key needs no UUID.
		expect(onchange).toHaveBeenCalledWith({ caller: ["open_app"] });
	});

	test("the master toggle emits the OFF marker the runtime reads as a revocation", async () => {
		mockBothApis([], CALLER_TOOLS);
		const onchange = vi.fn();
		const { getByTestId, findByTestId } = render(ConversationToolsSelector, {
			selectedMode: null,
			value: null,
			conversationId: "conv-1",
			onchange,
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		await fireEvent.click(await findByTestId("conv-ext-toggle-caller"));
		expect(onchange).toHaveBeenCalledWith({ caller: [] });
	});

	test("no conversation yet → the endpoint is never asked", async () => {
		const fetchMock = mockBothApis([TWO_TOOL_EXT], CALLER_TOOLS);
		const { getByTestId, findByTestId, queryByTestId } = render(ConversationToolsSelector, {
			selectedMode: null,
			value: null,
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		await findByTestId("conv-tool-ext-1-summarize");
		expect(queryByTestId("conv-ext-toggle-caller")).toBeNull();
		expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/extensions"]);
	});

	test("an empty declaration list renders no section (not an empty one)", async () => {
		mockBothApis([TWO_TOOL_EXT], []);
		const { getByTestId, findByTestId, queryByTestId } = render(ConversationToolsSelector, {
			selectedMode: null,
			value: null,
			conversationId: "conv-1",
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		await findByTestId("conv-tool-ext-1-summarize");
		expect(queryByTestId("conv-ext-toggle-caller")).toBeNull();
	});

	test("a failing caller-tools read does not hide the extensions that loaded", async () => {
		// `Promise.allSettled`, not `all` — one read failing must not take the
		// other's result down with it.
		mockBothApis([TWO_TOOL_EXT], null);
		const { getByTestId, findByTestId, queryByTestId } = render(ConversationToolsSelector, {
			selectedMode: null,
			value: null,
			conversationId: "conv-1",
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		await findByTestId("conv-tool-ext-1-summarize");
		expect(queryByTestId("conv-ext-toggle-caller")).toBeNull();
	});

	test("a malformed payload is treated as no declarations", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url === "/api/extensions") return new Response(JSON.stringify({ extensions: [TWO_TOOL_EXT] }), { status: 200 });
			return new Response(JSON.stringify({ tools: "not-an-array" }), { status: 200 });
		});
		(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
		const { getByTestId, findByTestId, queryByTestId } = render(ConversationToolsSelector, {
			selectedMode: null,
			value: null,
			conversationId: "conv-1",
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		await findByTestId("conv-tool-ext-1-summarize");
		expect(queryByTestId("conv-ext-toggle-caller")).toBeNull();
	});

	test("the conversation id is percent-encoded into the path", async () => {
		const urls: string[] = [];
		const fetchMock = vi.fn(async (url: string) => {
			urls.push(url);
			return new Response(JSON.stringify({ tools: [] }), { status: 200 });
		});
		(globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
		render(ConversationToolsSelector, {
			selectedMode: null,
			value: null,
			conversationId: "a/../b",
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		// A slash left raw would climb out of the conversation's own path.
		await waitFor(() => expect(urls).toContain("/api/conversations/a%2F..%2Fb/caller-tools"));
	});

	/** Hovering a caller tool row — the description comes from the
	 *  declaration, which is third-party text the user is entitled to read
	 *  before leaving the tool switched on. */
	async function hoverCallerTool(name: string) {
		mockBothApis([], CALLER_TOOLS);
		const { getByTestId, findByTestId, getByRole } = render(ConversationToolsSelector, {
			selectedMode: null,
			value: null,
			conversationId: "conv-1",
			onchange: vi.fn(),
			onreset: vi.fn(),
		});
		await fireEvent.click(getByTestId("conversation-tools-trigger"));
		const row = await findByTestId(`conv-tool-caller-${name}`);
		await fireEvent.mouseEnter(row.closest("label")!.parentElement!);
		return getByRole;
	}

	test("hovering a caller tool shows the declared description", async () => {
		const getByRole = await hoverCallerTool("open_app");
		await waitFor(() => expect(getByRole("tooltip")).toHaveTextContent("Open an app on the device"));
	});

	test("a caller tool with no description shows the fallback text", async () => {
		const getByRole = await hoverCallerTool("capture_screen");
		await waitFor(() => expect(getByRole("tooltip")).toHaveTextContent("No description provided."));
	});
});
