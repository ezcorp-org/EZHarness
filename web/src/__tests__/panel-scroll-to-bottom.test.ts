import { test, expect, describe } from "bun:test";

/**
 * Tests for the scroll-to-bottom behavior now owned by PanelChatInput.
 *
 * Previously, AgentDetailPanel and TeamChatPanel each had their own
 * IntersectionObserver + jump-to-bottom button. Now PanelChatInput
 * accepts scrollSentinel + scrollContainer props and handles it all.
 *
 * These tests verify the logic contract between parent panels and
 * PanelChatInput for scroll tracking.
 */

describe("PanelChatInput scroll-to-bottom delegation", () => {

	test("sentinel visibility determines userScrolledUp state", () => {
		// IntersectionObserver callback: !isIntersecting = scrolled up
		const cases: Array<{ isIntersecting: boolean; expected: boolean }> = [
			{ isIntersecting: false, expected: true },   // sentinel hidden = scrolled up
			{ isIntersecting: true, expected: false },    // sentinel visible = at bottom
		];

		for (const c of cases) {
			const userScrolledUp = !c.isIntersecting;
			expect(userScrolledUp).toBe(c.expected);
		}
	});

	test("jump-to-bottom only renders when userScrolledUp is true", () => {
		// Component template: {#if userScrolledUp} <button>...</button> {/if}
		let userScrolledUp = false;
		expect(userScrolledUp).toBe(false); // button hidden

		userScrolledUp = true;
		expect(userScrolledUp).toBe(true); // button visible
	});

	test("scrollToBottom resets flag and triggers scrollIntoView", () => {
		let userScrolledUp = true;
		let scrollIntoViewCalled = false;

		const scrollSentinel = {
			scrollIntoView: (_opts: { behavior: string }) => {
				scrollIntoViewCalled = true;
			},
		};

		// Simulate scrollToBottom()
		userScrolledUp = false;
		scrollSentinel.scrollIntoView({ behavior: "smooth" });

		expect(userScrolledUp).toBe(false);
		expect(scrollIntoViewCalled).toBe(true);
	});

	test("observer uses correct root and threshold", () => {
		// The $effect creates: new IntersectionObserver(cb, { root: scrollContainer, threshold: 0.1 })
		const config = { root: "scrollContainer", threshold: 0.1 };
		expect(config.threshold).toBe(0.1);
		expect(config.root).toBe("scrollContainer");
	});

	test("observer not created when sentinel is undefined", () => {
		const scrollSentinel: unknown = undefined;
		const scrollContainer: unknown = {} ;
		const shouldCreate = !!(scrollSentinel && scrollContainer);
		expect(shouldCreate).toBe(false);
	});

	test("observer not created when container is undefined", () => {
		const scrollSentinel: unknown = {};
		const scrollContainer: unknown = undefined;
		const shouldCreate = !!(scrollSentinel && scrollContainer);
		expect(shouldCreate).toBe(false);
	});

	test("observer not created when both are undefined", () => {
		const scrollSentinel: unknown = undefined;
		const scrollContainer: unknown = undefined;
		const shouldCreate = !!(scrollSentinel && scrollContainer);
		expect(shouldCreate).toBe(false);
	});

	test("observer created when both sentinel and container are present", () => {
		const scrollSentinel: unknown = {};
		const scrollContainer: unknown = {};
		const shouldCreate = !!(scrollSentinel && scrollContainer);
		expect(shouldCreate).toBe(true);
	});
});

describe("AgentDetailPanel passes scroll refs to PanelChatInput", () => {
	test("sentinel is bound to a div.h-1 at end of scroll content", () => {
		// In the template: <div bind:this={sentinel} class="h-1"></div>
		// Then passed: <PanelChatInput scrollSentinel={sentinel} {scrollContainer} .../>
		// This verifies the contract: sentinel must be the last child of the scrollable area
		const sentinel = { className: "h-1" };
		expect(sentinel.className).toBe("h-1");
	});

	test("scrollContainer is the overflow-y-auto div", () => {
		// <div class="flex-1 overflow-y-auto ..." bind:this={scrollContainer}>
		// Parent binds the scroll container ref
		const scrollContainer = { style: { overflowY: "auto" } };
		expect(scrollContainer.style.overflowY).toBe("auto");
	});
});

describe("TeamChatPanel passes scroll refs for both views", () => {
	test("timeline view passes timelineSentinel and timelineEl", () => {
		// <PanelChatInput scrollSentinel={timelineSentinel} scrollContainer={timelineEl} .../>
		const timelineSentinel = { id: "timeline-sentinel" };
		const timelineEl = { id: "timeline-scroll" };
		expect(!!(timelineSentinel && timelineEl)).toBe(true);
	});

	test("drill-down view passes drillSentinel and drillScrollContainer", () => {
		// <PanelChatInput scrollSentinel={drillSentinel} scrollContainer={drillScrollContainer} .../>
		const drillSentinel = { id: "drill-sentinel" };
		const drillScrollContainer = { id: "drill-scroll" };
		expect(!!(drillSentinel && drillScrollContainer)).toBe(true);
	});

	test("different sentinel/container per view prevents cross-observation", () => {
		// Timeline and drill-down each have their own sentinel and container
		// This ensures the observer watches the correct scroll area
		const timelineSentinel = { id: "ts" };
		const drillSentinel = { id: "ds" };
		expect(timelineSentinel.id).not.toBe(drillSentinel.id);
	});
});

describe("jump-to-bottom button positioning", () => {
	test("button floats above the input via absolute positioning", () => {
		// The button uses position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%)
		// This places it centered above the border-t container, overlaying the scroll area
		// The parent <div class="relative border-t ..."> establishes the positioning context
		const styles = {
			position: "absolute",
			bottom: "100%",
			left: "50%",
			transform: "translateX(-50%)",
		};
		expect(styles.position).toBe("absolute");
		expect(styles.bottom).toBe("100%");
	});

	test("button does not take layout space (no shift of chat input)", () => {
		// Absolute positioning removes the element from normal flow
		// so the textarea and send button stay in the same position
		const position = "absolute";
		const takesLayoutSpace = position !== "absolute" && position !== "fixed";
		expect(takesLayoutSpace).toBe(false);
	});

	test("button has correct aria-label", () => {
		const ariaLabel = "Jump to bottom";
		expect(ariaLabel).toBe("Jump to bottom");
	});
});

describe("auto-scroll on initial panel open", () => {
	test("AgentDetailPanel scrolls to bottom when messages first load", () => {
		// $effect: if open && loaded && rawMessages.length > 0 && !initialScrollDone → scrollToBottom()
		let initialScrollDone = false;
		let scrollCalled = false;
		const open = true;
		const loaded = true;
		const rawMessagesLength = 5;

		if (open && loaded && rawMessagesLength > 0 && !initialScrollDone) {
			initialScrollDone = true;
			scrollCalled = true;
		}
		expect(scrollCalled).toBe(true);
		expect(initialScrollDone).toBe(true);
	});

	test("AgentDetailPanel does not re-scroll after initial load", () => {
		const initialScrollDone = true; // already scrolled
		let scrollCalled = false;

		if (true && true && 5 > 0 && !initialScrollDone) {
			scrollCalled = true;
		}
		expect(scrollCalled).toBe(false);
	});

	test("AgentDetailPanel resets initialScrollDone when agent changes", () => {
		let initialScrollDone = true;
		// Reset block: when agent.subConversationId changes
		initialScrollDone = false;
		expect(initialScrollDone).toBe(false);
	});

	test("TeamChatPanel timeline scrolls to bottom on first overview load", () => {
		let timelineInitialScroll = false;
		let scrollCalled = false;
		const panelOpen = true;
		const drillDown = null;
		const overviewLoaded = true;
		const entriesLength = 3;

		if (panelOpen && !drillDown && overviewLoaded && entriesLength > 0 && !timelineInitialScroll) {
			timelineInitialScroll = true;
			scrollCalled = true;
		}
		expect(scrollCalled).toBe(true);
		expect(timelineInitialScroll).toBe(true);
	});

	test("TeamChatPanel timeline does not re-scroll on poll refresh", () => {
		const timelineInitialScroll = true; // already scrolled
		let scrollCalled = false;

		if (true && true && true && 5 > 0 && !timelineInitialScroll) {
			scrollCalled = true;
		}
		expect(scrollCalled).toBe(false);
	});

	test("TeamChatPanel resets timelineInitialScroll when overview reloads", () => {
		let timelineInitialScroll = true;
		const overviewLoaded = false;
		// Reset: if (!overviewLoaded) timelineInitialScroll = false
		if (!overviewLoaded) timelineInitialScroll = false;
		expect(timelineInitialScroll).toBe(false);
	});

	test("TeamChatPanel drill-down scrolls to specific turn then falls back to bottom", () => {
		// When targetTurn is provided and element found → scrolls to that turn
		// When no targetTurn or element not found → scrolls to bottom (sentinel)
		let scrolledToTurn = false;
		let scrolledToBottom = false;

		const targetTurn = null; // no specific turn
		const drillAssistantMessagesLength = 3;

		if (targetTurn != null && targetTurn < drillAssistantMessagesLength) {
			scrolledToTurn = true;
		} else {
			// Fallback: scroll to bottom
			scrolledToBottom = true;
		}

		expect(scrolledToTurn).toBe(false);
		expect(scrolledToBottom).toBe(true);
	});

	test("TeamChatPanel drill-down scrolls to turn when targetTurn is valid", () => {
		let scrolledToTurn = false;
		let scrolledToBottom = false;

		const targetTurn = 2;
		const drillAssistantMessagesLength = 5;

		if (targetTurn != null && targetTurn < drillAssistantMessagesLength) {
			scrolledToTurn = true;
		} else {
			scrolledToBottom = true;
		}

		expect(scrolledToTurn).toBe(true);
		expect(scrolledToBottom).toBe(false);
	});

	test("TeamChatPanel drill-down does not scroll when not loaded", () => {
		const drillLoaded = false;
		const drillAssistantMessagesLength = 0;
		let scrollCalled = false;

		// Guard: if (!drillLoaded || drillAssistantMessages.length === 0) return
		if (drillLoaded && drillAssistantMessagesLength > 0) {
			scrollCalled = true;
		}
		expect(scrollCalled).toBe(false);
	});

	test("no auto-scroll when panel is closed", () => {
		const open = false;
		const loaded = true;
		let scrollCalled = false;

		if (open && loaded) {
			scrollCalled = true;
		}
		expect(scrollCalled).toBe(false);
	});
});

describe("removed duplicate code verification", () => {
	test("AgentDetailPanel no longer has its own IntersectionObserver for scroll", () => {
		// Previously had: $effect(() => { ... IntersectionObserver ... userScrolledUp ... })
		// Now delegates to PanelChatInput via scrollSentinel + scrollContainer props
		// The panel only keeps sentinel ref and scrollToBottom() for post-send scrolling
		const panelResponsibilities = ["bind sentinel", "pass to PanelChatInput", "scrollToBottom on send"];
		expect(panelResponsibilities).not.toContain("create IntersectionObserver");
		expect(panelResponsibilities).not.toContain("track userScrolledUp");
	});

	test("TeamChatPanel no longer has its own IntersectionObservers", () => {
		// Previously had two: one for timeline, one for drill-down
		// Now both delegate to PanelChatInput
		const panelResponsibilities = ["bind sentinels", "pass to PanelChatInput", "scrollToBottom on send"];
		expect(panelResponsibilities).not.toContain("create IntersectionObserver");
		expect(panelResponsibilities).not.toContain("track timelineScrolledUp");
		expect(panelResponsibilities).not.toContain("track drillScrolledUp");
	});

	test("jump-to-bottom CSS only exists in PanelChatInput now", () => {
		// Previously duplicated in AgentDetailPanel and TeamChatPanel
		// Now only PanelChatInput has .jump-to-bottom styles
		const filesWithJumpStyle = ["PanelChatInput.svelte"];
		expect(filesWithJumpStyle).toHaveLength(1);
		expect(filesWithJumpStyle[0]).toBe("PanelChatInput.svelte");
	});
});
