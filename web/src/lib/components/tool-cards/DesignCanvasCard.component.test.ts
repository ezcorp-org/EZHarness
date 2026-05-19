/**
 * DesignCanvasCard tests.
 *
 * Covers:
 *   1. mode prop forwarding (dock vs inline).
 *   2. Adaptive knob descriptor rendering + signed-delta percent encoding
 *      for scale-spacing range knobs (the load-bearing wire-shape bug fix).
 *   3. The new tweak-design apply round-trip: invokeInlineTool fires,
 *      banner renders on success/error, dirty-dot tracks form vs applied,
 *      tokens diff drawer shows when both blocks are present, revision
 *      dropdown lists when revisions.length > 1, picking a revision
 *      re-invokes the tool.
 *   4. Backwards-compat: legacy drafts (no knobValues / originalTokensBlock /
 *      revisions) still render with only the original UI — no banner stub,
 *      no diff drawer, no dropdown.
 */
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, vi, beforeEach } from "vitest";
import DesignCanvasCard from "./DesignCanvasCard.svelte";
import type { ToolCallState } from "$lib/stores.svelte.js";
import { inlineToolStore } from "$lib/inline-tool-store.svelte";

afterEach(() => {
	cleanup();
	// Reset the shared inlineToolStore between tests so calls don't leak.
	inlineToolStore.calls = [];
});

function makeCall(overrides: Partial<ToolCallState> = {}): ToolCallState {
	return {
		id: "tc-canvas-1",
		toolName: "claude-design__open-canvas",
		status: "complete",
		input: { draftId: "d-1" },
		output: JSON.stringify({
			draftId: "d-1",
			iframeSrc: "/api/extensions/claude-design/data/preview.html",
		}),
		startedAt: Date.now(),
		duration: 200,
		extensionId: "claude-design",
		cardType: "design-canvas",
		...overrides,
	};
}

describe("DesignCanvasCard — mode prop", () => {
	test('mode="dock" forwards data-mode="dock" so CSS flips to fill-mode', () => {
		const { container } = render(DesignCanvasCard, {
			toolCall: makeCall({ cardLayout: "dock" }),
			conversationId: "conv-1",
			mode: "dock",
		});
		const card = container.querySelector(".extension-iframe-card");
		expect(card).not.toBeNull();
		expect(card?.getAttribute("data-mode")).toBe("dock");
		expect(card?.classList.contains("mode-dock")).toBe(true);
	});

	test('mode="inline" (default) renders standard inline iframe wrapper', () => {
		const { container } = render(DesignCanvasCard, {
			toolCall: makeCall(),
			conversationId: "conv-1",
		});
		const card = container.querySelector(".extension-iframe-card");
		expect(card).not.toBeNull();
		expect(card?.getAttribute("data-mode")).toBe("inline");
		expect(card?.classList.contains("mode-inline")).toBe(true);
	});
});

describe("DesignCanvasCard — adaptive descriptors", () => {
	let fetchSpy: ReturnType<typeof vi.fn>;
	let lastFetchInit: RequestInit | undefined;

	beforeEach(() => {
		lastFetchInit = undefined;
		fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			lastFetchInit = init;
			return new Response("{}", {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchSpy);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function makeCallWithPayload(
		extra: Record<string, unknown>,
		overrides: Partial<ToolCallState> = {},
	): ToolCallState {
		return {
			id: "tc-canvas-2",
			toolName: "claude-design__open-canvas",
			status: "complete",
			input: { draftId: "d-2" },
			output: JSON.stringify({
				draftId: "d-2",
				iframeSrc: "/api/extensions/claude-design/data/preview.html",
				...extra,
			}),
			startedAt: Date.now(),
			duration: 200,
			extensionId: "claude-design",
			cardType: "design-canvas",
			...overrides,
		};
	}

	test("descriptor with kind=color renders one color input keyed by data-testid", () => {
		const { getByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				knobs: [
					{
						key: "accentColor",
						kind: "color",
						label: "Accent",
						var: "--color-accent",
					},
				],
			}),
			conversationId: "conv-1",
		});
		const input = getByTestId("knob-accentColor") as HTMLInputElement;
		expect(input).toBeInTheDocument();
		expect(input.tagName).toBe("INPUT");
		expect(input.type).toBe("color");
	});

	test("range descriptor with unit:'px' shows the current value + 'px' in the label", async () => {
		const { getByTestId, container } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				knobs: [
					{
						key: "borderRadius",
						kind: "range",
						label: "Border radius",
						min: 0,
						max: 24,
						step: 2,
						unit: "px",
					},
				],
			}),
			conversationId: "conv-1",
		});
		const input = getByTestId("knob-borderRadius") as HTMLInputElement;
		await fireEvent.input(input, { target: { value: "12" } });
		const label = container.querySelector("label.knob");
		expect(label?.textContent).toContain("12px");
	});

	test("falls back to LEGACY_DESCRIPTORS (5 knobs) when payload.knobs is undefined", () => {
		const { getByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({}),
			conversationId: "conv-1",
		});
		expect(getByTestId("knob-primaryColor")).toBeInTheDocument();
		expect(getByTestId("knob-secondaryColor")).toBeInTheDocument();
		expect(getByTestId("knob-spacingScale")).toBeInTheDocument();
		expect(getByTestId("knob-borderRadius")).toBeInTheDocument();
		expect(getByTestId("knob-density")).toBeInTheDocument();
	});

	test("falls back to LEGACY_DESCRIPTORS when payload.knobs is empty array", () => {
		const { getByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({ knobs: [] }),
			conversationId: "conv-1",
		});
		expect(getByTestId("knob-primaryColor")).toBeInTheDocument();
		expect(getByTestId("knob-density")).toBeInTheDocument();
	});

	test("Apply invokes /api/tool-invoke with tweak-design + flat {key:value} body", async () => {
		const { getByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				knobs: [
					{
						key: "accentColor",
						kind: "color",
						label: "Accent",
						var: "--color-accent",
					},
					{
						key: "borderRadius",
						kind: "range",
						label: "Border radius",
						min: 0,
						max: 24,
						step: 2,
						unit: "px",
					},
				],
			}),
			conversationId: "conv-1",
		});
		const colorInput = getByTestId("knob-accentColor") as HTMLInputElement;
		await fireEvent.input(colorInput, { target: { value: "#ff00aa" } });
		const rangeInput = getByTestId("knob-borderRadius") as HTMLInputElement;
		await fireEvent.input(rangeInput, { target: { value: "8" } });

		await fireEvent.click(getByTestId("design-canvas-apply"));

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0]!;
		expect(String(url)).toContain("/api/tool-invoke");
		expect(init?.method).toBe("POST");
		const body = JSON.parse(String(lastFetchInit?.body));
		expect(body.extensionName).toBe("claude-design");
		expect(body.toolName).toBe("tweak-design");
		expect(body.conversationId).toBe("conv-1");
		expect(body.input.draftId).toBe("d-2");
		expect(body.input.knobs).toEqual({
			accentColor: "#ff00aa",
			borderRadius: "8px",
		});
	});

	test("Apply emits SIGNED-DELTA percent for scale-spacing range knobs (the bug fix)", async () => {
		const { getByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				knobs: [
					{
						key: "spacingScale",
						kind: "range",
						label: "Spacing scale (%)",
						behavior: "scale-spacing",
						min: -25,
						max: 50,
						step: 5,
						unit: "%",
					},
				],
			}),
			conversationId: "conv-1",
		});
		const slider = getByTestId("knob-spacingScale") as HTMLInputElement;
		await fireEvent.input(slider, { target: { value: "30" } });
		await fireEvent.click(getByTestId("design-canvas-apply"));

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const body = JSON.parse(String(lastFetchInit?.body));
		expect(body.input.knobs).toEqual({ spacingScale: "+30%" });
	});

	test("Apply emits negative-delta percent for scale-spacing slider (unchanged sign)", async () => {
		const { getByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				knobs: [
					{
						key: "spacingScale",
						kind: "range",
						label: "Spacing scale (%)",
						behavior: "scale-spacing",
						min: -25,
						max: 50,
						step: 5,
						unit: "%",
					},
				],
			}),
			conversationId: "conv-1",
		});
		const slider = getByTestId("knob-spacingScale") as HTMLInputElement;
		await fireEvent.input(slider, { target: { value: "-15" } });
		await fireEvent.click(getByTestId("design-canvas-apply"));

		const body = JSON.parse(String(lastFetchInit?.body));
		expect(body.input.knobs).toEqual({ spacingScale: "-15%" });
	});

	test("Apply emits '+0%' when spacing slider is at 0 (meaningful zero, not skipped)", async () => {
		const { getByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				knobs: [
					{
						key: "spacingScale",
						kind: "range",
						label: "Spacing scale (%)",
						behavior: "scale-spacing",
						min: -25,
						max: 50,
						step: 5,
						unit: "%",
					},
				],
			}),
			conversationId: "conv-1",
		});
		const slider = getByTestId("knob-spacingScale") as HTMLInputElement;
		await fireEvent.input(slider, { target: { value: "0" } });
		await fireEvent.click(getByTestId("design-canvas-apply"));

		const body = JSON.parse(String(lastFetchInit?.body));
		expect(body.input.knobs).toEqual({ spacingScale: "+0%" });
	});

	test("Apply emits raw select value for density (no signed-percent encoding)", async () => {
		const { getByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				knobs: [
					{
						key: "density",
						kind: "select",
						label: "Density",
						options: ["compact", "cozy", "spacious"],
						behavior: "scale-spacing",
					},
				],
			}),
			conversationId: "conv-1",
		});
		const select = getByTestId("knob-density") as HTMLSelectElement;
		await fireEvent.change(select, { target: { value: "compact" } });
		await fireEvent.click(getByTestId("design-canvas-apply"));

		const body = JSON.parse(String(lastFetchInit?.body));
		expect(body.input.knobs).toEqual({ density: "compact" });
	});

	test("sidebar header reads payload.knobsTitle when set; defaults otherwise", () => {
		const { getByTestId, unmount } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				knobsTitle: "Hero & feature grid knobs",
			}),
			conversationId: "conv-1",
		});
		expect(getByTestId("design-canvas-knobs-title").textContent?.trim()).toBe(
			"Hero & feature grid knobs",
		);
		unmount();

		const r2 = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({}),
			conversationId: "conv-1",
		});
		expect(
			r2.getByTestId("design-canvas-knobs-title").textContent?.trim(),
		).toBe("Design knobs");
	});
});

// ── Banner / dirty-dot / diff drawer / revision dropdown ──────────

describe("DesignCanvasCard — apply banner + dirty + diff + revisions", () => {
	let fetchSpy: ReturnType<typeof vi.fn>;

	function makeCallWithPayload(
		extra: Record<string, unknown>,
		overrides: Partial<ToolCallState> = {},
	): ToolCallState {
		return {
			id: "tc-canvas-3",
			toolName: "claude-design__open-canvas",
			status: "complete",
			input: { draftId: "d-3" },
			output: JSON.stringify({
				draftId: "d-3",
				iframeSrc: "/api/extensions/claude-design/data/preview.html",
				...extra,
			}),
			startedAt: Date.now(),
			duration: 200,
			extensionId: "claude-design",
			cardType: "design-canvas",
			...overrides,
		};
	}

	beforeEach(() => {
		fetchSpy = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
			return new Response("{}", {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchSpy);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	test("success banner renders summarizeChangedVars output", async () => {
		const { getByTestId, findByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				knobs: [
					{ key: "primaryColor", kind: "color", label: "Primary", var: "--color-primary" },
				],
			}),
			conversationId: "conv-1",
		});
		const colorInput = getByTestId("knob-primaryColor") as HTMLInputElement;
		await fireEvent.input(colorInput, { target: { value: "#ff0066" } });
		await fireEvent.click(getByTestId("design-canvas-apply"));

		// Push a fake complete event into the store keyed by the
		// just-created invocation.
		const id = inlineToolStore.calls[inlineToolStore.calls.length - 1]!.id;
		inlineToolStore.updateFromEvent(id, "tool:complete", {
			output: JSON.stringify({
				draftId: "d-4",
				parentDraftId: "d-3",
				iframeSrc: "/api/extensions/claude-design/data/preview.html",
				changedVars: ["--color-primary"],
				knobValues: { primaryColor: "#ff0066" },
				tokensBlock: "--color-primary: #ff0066;",
				revisions: [],
			}),
			duration: 100,
		});

		const banner = await findByTestId("apply-banner-success");
		expect(banner.textContent ?? "").toContain("Applied — updated --color-primary");
	});

	test("success banner auto-dismisses after 4s", async () => {
		vi.useFakeTimers();
		const { getByTestId, findByTestId, queryByTestId } = render(
			DesignCanvasCard,
			{
				toolCall: makeCallWithPayload({
					knobs: [
						{
							key: "primaryColor",
							kind: "color",
							label: "Primary",
							var: "--color-primary",
						},
					],
				}),
				conversationId: "conv-1",
			},
		);
		const colorInput = getByTestId("knob-primaryColor") as HTMLInputElement;
		await fireEvent.input(colorInput, { target: { value: "#ff0066" } });
		await fireEvent.click(getByTestId("design-canvas-apply"));

		const id = inlineToolStore.calls[inlineToolStore.calls.length - 1]!.id;
		inlineToolStore.updateFromEvent(id, "tool:complete", {
			output: JSON.stringify({
				changedVars: ["--color-primary"],
				knobValues: { primaryColor: "#ff0066" },
			}),
			duration: 100,
		});

		await findByTestId("apply-banner-success");

		// Advance 4001ms so the auto-dismiss timer fires.
		await vi.advanceTimersByTimeAsync(4001);

		expect(queryByTestId("apply-banner-success")).toBeNull();
	});

	test("error banner is sticky and Retry triggers a new tool invocation", async () => {
		const { getByTestId, findByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				knobs: [
					{
						key: "primaryColor",
						kind: "color",
						label: "Primary",
						var: "--color-primary",
					},
				],
			}),
			conversationId: "conv-1",
		});
		const colorInput = getByTestId("knob-primaryColor") as HTMLInputElement;
		await fireEvent.input(colorInput, { target: { value: "#ff0066" } });
		await fireEvent.click(getByTestId("design-canvas-apply"));

		const firstId = inlineToolStore.calls[inlineToolStore.calls.length - 1]!.id;
		inlineToolStore.updateFromEvent(firstId, "tool:error", {
			error: "draft not found",
			duration: 30,
		});

		const banner = await findByTestId("apply-banner-error");
		expect(banner.textContent ?? "").toContain("draft not found");

		const retryBtn = getByTestId("apply-banner-retry");
		expect(retryBtn).toBeInTheDocument();

		const callsBefore = inlineToolStore.calls.length;
		await fireEvent.click(retryBtn);
		expect(inlineToolStore.calls.length).toBe(callsBefore + 1);
	});

	test("dirty dot appears for the changed knob only", async () => {
		const { getByTestId, queryByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				knobs: [
					{
						key: "primaryColor",
						kind: "color",
						label: "Primary",
						var: "--color-primary",
					},
					{
						key: "secondaryColor",
						kind: "color",
						label: "Secondary",
						var: "--color-secondary",
					},
				],
				knobValues: { primaryColor: "#ff0066", secondaryColor: "#00ff00" },
			}),
			conversationId: "conv-1",
		});

		// Initially nothing dirty (form is empty, applied is set — empty
		// form + applied = "user cleared it" which IS dirty per spec, BUT
		// the bind:value initialises from undefined so values map starts
		// empty. encodeKnobValue("") returns null → considered dirty when
		// applied is set. To get a clean baseline we first set the value
		// to match the applied one.
		const primary = getByTestId("knob-primaryColor") as HTMLInputElement;
		await fireEvent.input(primary, { target: { value: "#ff0066" } });
		const secondary = getByTestId("knob-secondaryColor") as HTMLInputElement;
		await fireEvent.input(secondary, { target: { value: "#00ff00" } });

		// Now dirty-dot for both should be hidden.
		expect(queryByTestId("dirty-dot-primaryColor")).toBeNull();
		expect(queryByTestId("dirty-dot-secondaryColor")).toBeNull();

		// Change just primary.
		await fireEvent.input(primary, { target: { value: "#000000" } });
		expect(queryByTestId("dirty-dot-primaryColor")).not.toBeNull();
		expect(queryByTestId("dirty-dot-secondaryColor")).toBeNull();
	});

	test("diff drawer renders when both originalTokensBlock and tokensBlock supplied", () => {
		const { getByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				originalTokensBlock: "--color-primary: red;",
				tokensBlock: "--color-primary: blue;",
			}),
			conversationId: "conv-1",
		});
		expect(getByTestId("tokens-diff-drawer")).toBeInTheDocument();
	});

	test("diff drawer hidden for legacy drafts (no originalTokensBlock)", () => {
		const { queryByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				tokensBlock: "--color-primary: blue;",
				// originalTokensBlock omitted
			}),
			conversationId: "conv-1",
		});
		expect(queryByTestId("tokens-diff-drawer")).toBeNull();
	});

	test("revision dropdown shows when revisions.length > 1", () => {
		const { getByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				revisions: [
					{
						revisionId: "r-1",
						parentDraftId: "d-3",
						knobValues: { primaryColor: "#ff0066" },
						createdAt: "2026-04-27T12:43:08.000Z",
						isOriginal: false,
					},
					{
						revisionId: "r-original",
						parentDraftId: "d-3",
						knobValues: {},
						createdAt: "2026-04-27T12:00:00.000Z",
						isOriginal: true,
					},
				],
			}),
			conversationId: "conv-1",
		});
		expect(getByTestId("design-canvas-revision-select")).toBeInTheDocument();
	});

	test("revision dropdown hidden when revisions.length <= 1", () => {
		const { queryByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				revisions: [
					{
						revisionId: "r-original",
						parentDraftId: "d-3",
						knobValues: {},
						createdAt: "2026-04-27T12:00:00.000Z",
						isOriginal: true,
					},
				],
			}),
			conversationId: "conv-1",
		});
		expect(queryByTestId("design-canvas-revision-select")).toBeNull();
	});

	test("selecting a revision triggers a new tool invocation with that revision's knobValues", async () => {
		const { getByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				knobs: [
					{
						key: "primaryColor",
						kind: "color",
						label: "Primary",
						var: "--color-primary",
					},
				],
				revisions: [
					{
						revisionId: "r-1",
						parentDraftId: "d-3",
						knobValues: { primaryColor: "#abcdef" },
						createdAt: "2026-04-27T12:43:08.000Z",
						isOriginal: false,
					},
					{
						revisionId: "r-original",
						parentDraftId: "d-3",
						knobValues: {},
						createdAt: "2026-04-27T12:00:00.000Z",
						isOriginal: true,
					},
				],
			}),
			conversationId: "conv-1",
		});

		const select = getByTestId("design-canvas-revision-select") as HTMLSelectElement;
		const callsBefore = inlineToolStore.calls.length;
		await fireEvent.change(select, {
			target: { value: JSON.stringify({ primaryColor: "#abcdef" }) },
		});

		expect(inlineToolStore.calls.length).toBe(callsBefore + 1);
		const newCall = inlineToolStore.calls[inlineToolStore.calls.length - 1]!;
		expect(newCall.toolName).toBe("tweak-design");
		expect((newCall.input as Record<string, unknown>).knobs).toEqual({
			primaryColor: "#abcdef",
		});
	});

	test("backwards-compat: legacy payload (none of the new fields) renders only the original UI", () => {
		const { queryByTestId, getByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({}),
			conversationId: "conv-1",
		});
		// Legacy descriptors render…
		expect(getByTestId("knob-primaryColor")).toBeInTheDocument();
		// …and none of the new affordances do.
		expect(queryByTestId("apply-banner-success")).toBeNull();
		expect(queryByTestId("apply-banner-error")).toBeNull();
		expect(queryByTestId("tokens-diff-drawer")).toBeNull();
		expect(queryByTestId("design-canvas-revision-select")).toBeNull();
	});

	// Gap-fill: when both blocks are present and DIFFER, the drawer's
	// inner content includes a `.d2h-diff-table` (the actual diff2html
	// table render). Locks the drawer's "renders the diff html, not just
	// the shell" contract.
	test("diff drawer produces a .d2h-diff-table when blocks differ", () => {
		const { getByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				originalTokensBlock: ":root {\n  --color-primary: red;\n}",
				tokensBlock: ":root {\n  --color-primary: blue;\n}",
			}),
			conversationId: "conv-1",
		});
		const drawer = getByTestId("tokens-diff-drawer") as HTMLDetailsElement;
		// `details` element renders its content even when collapsed in
		// jsdom (no native open/close), so the table should already be
		// present in the DOM.
		expect(drawer.querySelector(".d2h-diff-table")).not.toBeNull();
	});

	// Gap-fill: tokensBlock is absent on FIRST mount before any apply.
	// Drawer must be hidden (not throw on undefined access).
	test("diff drawer hidden on first mount before any apply (no tokensBlock yet)", () => {
		const { queryByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				// tokensBlock omitted but originalTokensBlock present — still
				// hidden because the diff text would be empty/no-current.
				originalTokensBlock: "--color-primary: red;",
			}),
			conversationId: "conv-1",
		});
		expect(queryByTestId("tokens-diff-drawer")).toBeNull();
	});

	// Architectural gap: lastInvocationId tracking via "snapshot calls
	// before invoke, find the new tail after" is brittle when two Apply
	// clicks land in quick succession. Lock that the SECOND invocation's
	// id is what gets tracked (not the first), so banner state reflects
	// the latest request.
	test("two Apply clicks in quick succession track the LATEST invocation", async () => {
		const { getByTestId } = render(DesignCanvasCard, {
			toolCall: makeCallWithPayload({
				knobs: [
					{
						key: "primaryColor",
						kind: "color",
						label: "Primary",
						var: "--color-primary",
					},
				],
			}),
			conversationId: "conv-1",
		});
		const colorInput = getByTestId("knob-primaryColor") as HTMLInputElement;
		await fireEvent.input(colorInput, { target: { value: "#aaaaaa" } });
		await fireEvent.click(getByTestId("design-canvas-apply"));
		await fireEvent.input(colorInput, { target: { value: "#bbbbbb" } });
		await fireEvent.click(getByTestId("design-canvas-apply"));

		// Two pending invocations registered in the store.
		expect(inlineToolStore.calls.length).toBe(2);
		const firstId = inlineToolStore.calls[0]!.id;
		const secondId = inlineToolStore.calls[1]!.id;
		expect(firstId).not.toBe(secondId);

		// Resolve the FIRST as error first — the component is tracking the
		// SECOND id, so the error banner should NOT appear from that.
		inlineToolStore.updateFromEvent(firstId, "tool:error", {
			error: "stale-first",
			duration: 5,
		});
		// Now resolve the second as success. The component should pick up
		// THAT outcome (success banner with the second's content).
		inlineToolStore.updateFromEvent(secondId, "tool:complete", {
			output: JSON.stringify({
				changedVars: ["--color-primary"],
				knobValues: { primaryColor: "#bbbbbb" },
			}),
			duration: 5,
		});
		// Wait a tick for the effect.
		await new Promise((r) => setTimeout(r, 0));

		// Apply banner should be the success variant — proves the second
		// (latest) id is what's tracked.
		const banner = await new Promise<HTMLElement | null>((resolve) => {
			setTimeout(() => {
				try {
					resolve(getByTestId("apply-banner-success"));
				} catch {
					resolve(null);
				}
			}, 10);
		});
		expect(banner).not.toBeNull();
		expect(banner?.textContent ?? "").toContain("--color-primary");
	});
});
