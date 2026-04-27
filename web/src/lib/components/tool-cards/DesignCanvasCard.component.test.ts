/**
 * DesignCanvasCard mode-switching tests.
 * canvas-dock-sdk.md §5 component case #DesignCanvasCard.
 *
 *   1. mode="dock" → renders the iframe in fill-mode container (the wrapping
 *      ExtensionIframeCard receives data-mode="dock", which the CSS uses to
 *      drop border + min-height).
 *   2. mode="inline" + cardLayout="dock" + status="complete" should be handled
 *      by the upstream chooser (InlineToolCard / ToolCallCard renders a
 *      DockOpenPill instead of routing here). When DesignCanvasCard IS
 *      reached in inline mode, it renders the standard inline iframe.
 */
import { render, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach } from "vitest";
import DesignCanvasCard from "./DesignCanvasCard.svelte";
import type { ToolCallState } from "$lib/stores.svelte.js";

afterEach(() => cleanup());

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
