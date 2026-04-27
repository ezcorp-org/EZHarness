/**
 * InlineToolCard dock-routing test.
 *
 * canvas-dock-sdk.md §5 component case (extend): when a complete tool call
 * has cardLayout="dock", InlineToolCard renders a DockOpenPill in place of
 * the full card. The dock auto-open ($effect with debounce) is exercised
 * separately in dock-store.test.ts; here we just lock the rendering branch.
 */
import { render, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach } from "vitest";
import InlineToolCard from "./InlineToolCard.svelte";
import type { InlineToolCall } from "$lib/inline-tool-store.svelte.js";

afterEach(() => cleanup());

function makeDockedCall(): InlineToolCall {
	return {
		id: "tc-inline-dock-1",
		extensionName: "claude-design",
		toolName: "claude-design__open-canvas",
		input: { draftId: "d-1" },
		status: "complete",
		retryCount: 0,
		conversationId: "conv-1",
		duration: 100,
		cardType: "design-canvas",
		cardLayout: "dock",
	};
}

describe("InlineToolCard — dock routing", () => {
	test('cardLayout="dock" + status="complete" → renders DockOpenPill, not the full card', () => {
		const { getByTestId, queryByText } = render(InlineToolCard, {
			call: makeDockedCall(),
			onretry: () => {},
			oneditretry: () => {},
			oncancel: () => {},
		});
		expect(getByTestId("dock-open-pill")).toBeInTheDocument();
		// The full-card "Running..." / "Failed" text shouldn't appear since
		// the pill replaces the entire card body.
		expect(queryByText(/Running\.\.\./)).toBeNull();
	});
});
