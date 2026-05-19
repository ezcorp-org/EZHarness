/**
 * Integration test for the "click a per-call row → scroll to that
 * tool card in the chat" flow. Stitches together two pieces that the
 * pure-unit tests cover separately:
 *
 *   - `<ContextUsageIndicator>` (popover, click handler, callback)
 *   - `scrollToToolCall(callId)` (anchor lookup, scrollIntoView,
 *     transient highlight)
 *
 * It does NOT mount the chat page itself — the chat page only adds the
 * DOM anchors (`id="tool-call-${id}"`) on rendered tool cards, which
 * we mint by hand here. That's the same contract `ChatMessage.svelte`
 * and `+page.svelte`'s inline-card list satisfy at runtime, so the
 * round trip below proves the wiring stays correct end-to-end.
 *
 * Why integration (not just two unit tests):
 *  - Unit tests verify the indicator fires its callback with the right
 *    callId, and the helper would scroll IF given that callId. They
 *    don't prove the two pieces speak the SAME id convention.
 *  - This test catches a regression like "indicator emits the toolName
 *    instead of the callId" — both unit suites would still pass.
 */

import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import ContextUsageIndicator from "$lib/components/ContextUsageIndicator.svelte";
import { scrollToToolCall } from "$lib/scroll-to-tool-call";
import type { ContextBreakdown, ToolBreakdownEntry } from "$lib/context-usage-logic";

const breakdown: ContextBreakdown = {
	inputTokens: 8_000,
	outputTokens: 2_000,
	toolTokens: 1_500,
	totalTokens: 10_000,
	pctInput: 80,
	pctOutput: 20,
	pctTools: 15,
};

/**
 * Mint a chat-card-shaped anchor in the DOM, mirroring what
 * `ChatMessage.svelte` writes around each rendered `ToolCallCard` and
 * what the chat page writes around each `InlineToolCard`.
 */
function mintCardAnchor(callId: string): HTMLElement {
	const el = document.createElement("div");
	el.id = `tool-call-${callId}`;
	el.textContent = `Card body for ${callId}`;
	document.body.appendChild(el);
	(el as any).scrollIntoView = vi.fn();
	return el;
}

describe("ContextUsageIndicator + scrollToToolCall (integration)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		cleanup();
		document.body.innerHTML = "";
	});

	test("clicking a built-in call row scrolls the matching tool-card anchor into view", async () => {
		// End-to-end through the popover: open → expand built-in row →
		// click leaf call → assert the matching DOM anchor was scrolled.
		const card = mintCardAnchor("call-bash-1");
		const toolBreakdown: ToolBreakdownEntry[] = [
			{
				extensionName: "",
				toolName: "Bash",
				callCount: 2,
				tokens: 200,
				pct: 20,
				calls: [
					{ callId: "call-bash-1", tokens: 150, pct: 15, preview: "ls -la" },
					{ callId: "call-bash-2", tokens: 50, pct: 5, preview: "pwd" },
				],
			},
		];
		const { getByTestId, getAllByTestId } = render(ContextUsageIndicator, {
			usedTokens: 8_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
			oncallclick: (id: string) => scrollToToolCall(id, { highlightMs: 0 }),
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);
		await fireEvent.click(getByTestId("ctx-bd-tool-row"));
		const callRows = getAllByTestId("ctx-bd-call-row");
		expect(callRows[0]?.getAttribute("data-call-id")).toBe("call-bash-1");

		await fireEvent.click(callRows[0]!);
		expect((card as any).scrollIntoView).toHaveBeenCalledTimes(1);
		expect((card as any).scrollIntoView).toHaveBeenCalledWith({
			behavior: "smooth",
			block: "center",
		});
	});

	test("clicking an extension/MCP function call (two-level expand) routes to the right anchor", async () => {
		// Extension groups go through a function-row level first. Both
		// expands must wire the same callId through to the helper.
		const playwrightCard = mintCardAnchor("pw-call-1");
		const decoy = mintCardAnchor("call-bash-1");
		const toolBreakdown: ToolBreakdownEntry[] = [
			{
				extensionName: "playwright",
				toolName: "browser_click",
				callCount: 1,
				tokens: 500,
				pct: 5,
				calls: [{ callId: "pw-call-1", tokens: 500, pct: 5, preview: "btn1" }],
			},
		];
		const { getByTestId } = render(ContextUsageIndicator, {
			usedTokens: 8_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
			oncallclick: (id: string) => scrollToToolCall(id, { highlightMs: 0 }),
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);
		await fireEvent.click(getByTestId("ctx-bd-tool-row"));
		await fireEvent.click(getByTestId("ctx-bd-fn-row"));
		await fireEvent.click(getByTestId("ctx-bd-call-row"));

		expect((playwrightCard as any).scrollIntoView).toHaveBeenCalledTimes(1);
		expect((decoy as any).scrollIntoView).not.toHaveBeenCalled();
	});

	test("highlight ring is added on click and auto-removed after the timeout", async () => {
		const card = mintCardAnchor("call-h");
		const toolBreakdown: ToolBreakdownEntry[] = [
			{
				extensionName: "",
				toolName: "Bash",
				callCount: 1,
				tokens: 100,
				pct: 10,
				calls: [{ callId: "call-h", tokens: 100, pct: 10, preview: "ls" }],
			},
		];
		const { getByTestId } = render(ContextUsageIndicator, {
			usedTokens: 8_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
			oncallclick: (id: string) => scrollToToolCall(id), // default 1500ms
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);
		await fireEvent.click(getByTestId("ctx-bd-tool-row"));
		await fireEvent.click(getByTestId("ctx-bd-call-row"));

		expect(card.classList.contains("ring-2")).toBe(true);
		expect(card.classList.contains("ring-emerald-400/60")).toBe(true);

		vi.advanceTimersByTime(1501);
		expect(card.classList.contains("ring-2")).toBe(false);
		expect(card.classList.contains("ring-emerald-400/60")).toBe(false);
	});

	test("clicking a row whose anchor isn't mounted is a graceful no-op (popover still closes)", async () => {
		// Older messages outside the paginated window won't have an anchor.
		// The popover must still close so the user gets some visible
		// acknowledgement of the click; the scroll just doesn't happen.
		// (No throw, no DOM mutation on unrelated cards.)
		const decoy = mintCardAnchor("present");
		const toolBreakdown: ToolBreakdownEntry[] = [
			{
				extensionName: "",
				toolName: "Bash",
				callCount: 1,
				tokens: 100,
				pct: 10,
				calls: [{ callId: "ghost", tokens: 100, pct: 10, preview: "rm -rf" }],
			},
		];
		const { getByTestId, queryByTestId } = render(ContextUsageIndicator, {
			usedTokens: 8_000,
			contextWindow: 200_000,
			breakdown,
			toolBreakdown,
			oncallclick: (id: string) => scrollToToolCall(id, { highlightMs: 0 }),
		});

		await fireEvent.mouseEnter(getByTestId("context-usage-indicator").parentElement!);
		await fireEvent.click(getByTestId("ctx-bd-tool-row"));
		await fireEvent.click(getByTestId("ctx-bd-call-row"));

		expect(queryByTestId("context-usage-popover")).toBeNull();
		expect((decoy as any).scrollIntoView).not.toHaveBeenCalled();
		expect(decoy.classList.contains("ring-2")).toBe(false);
	});
});
