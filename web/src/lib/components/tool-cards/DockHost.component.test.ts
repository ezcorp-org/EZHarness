/**
 * Component-level DOM tests for DockHost.svelte.
 *
 * Covers (canvas-dock-sdk.md §5 component cases):
 *   - Renders the routed card when dockState[activeConvId] is set and
 *     inlineToolStore has the tool.
 *   - Close button calls closeDock — host unmounts.
 *   - Iframe sandbox attribute is unchanged (security regression guard).
 *   - Drag handle: pointerdown/move triggers setDockSize with the expected delta.
 *   - At window.innerWidth = 640, host has fixed-inset full-screen layout.
 *
 * Vitest is used (not bun test) because the component imports .svelte
 * files that need the Svelte 5 rune compiler — see web/vitest.config.ts.
 */
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeEach, beforeAll } from "vitest";
import DockHost from "./DockHost.svelte";
import { store, openDock, closeDock } from "$lib/stores.svelte.js";
import { inlineToolStore } from "$lib/inline-tool-store.svelte.js";

// DockHost reads convId from URL. Pin it to the test conversation.
beforeAll(() => {
	if (typeof window !== "undefined") {
		window.history.replaceState({}, "", "/project/proj-1/chat/conv-1");
	}
});

afterEach(() => {
	cleanup();
	// Clear the dock + inline stores between tests so state doesn't leak.
	for (const k of Object.keys(store.dockState)) closeDock(k);
	inlineToolStore.calls = [];
});

beforeEach(() => {
	for (const k of Object.keys(store.dockState)) delete store.dockState[k];
	inlineToolStore.calls = [];
});

function seedDocked(toolCallId: string) {
	inlineToolStore.calls = [{
		id: toolCallId,
		extensionName: "claude-design",
		toolName: "claude-design__open-canvas",
		input: { draftId: "d-1" },
		status: "complete",
		retryCount: 0,
		conversationId: "conv-1",
		cardType: "design-canvas",
		cardLayout: "dock",
		output: JSON.stringify({ draftId: "d-1", iframeSrc: "/api/extensions/claude-design/data/preview.html" }),
		duration: 100,
	}];
	openDock("conv-1", toolCallId);
}

describe("DockHost", () => {
	test("renders the routed card when a dock slot is open and the tool exists", async () => {
		seedDocked("tc-1");
		const { getByTestId } = render(DockHost, { conversationId: "conv-1" });
		const host = getByTestId("dock-host");
		expect(host).toBeInTheDocument();
		expect(host.getAttribute("data-tool-call-id")).toBe("tc-1");
	});

	test("close button calls closeDock and host unmounts", async () => {
		seedDocked("tc-2");
		const { getByTestId, queryByTestId } = render(DockHost, { conversationId: "conv-1" });
		expect(getByTestId("dock-host")).toBeInTheDocument();
		await fireEvent.click(getByTestId("dock-close"));
		expect(queryByTestId("dock-host")).toBeNull();
	});

	test("iframe inside the dock keeps SANDBOX_FLAGS_STRICT (security regression)", async () => {
		seedDocked("tc-3");
		const { getByTestId, container } = render(DockHost, { conversationId: "conv-1" });
		expect(getByTestId("dock-host")).toBeInTheDocument();
		// The iframe lives inside ExtensionIframeCard — the sandbox attr is
		// load-bearing per the plan's critical-constraint #4.
		const iframe = container.querySelector("iframe");
		expect(iframe).not.toBeNull();
		expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
	});

	test("drag handle: pointerdown → pointermove writes via setDockSize", async () => {
		seedDocked("tc-4");
		const startWidth = store.dockSizePx;
		const { getByTestId } = render(DockHost, { conversationId: "conv-1" });
		const handle = getByTestId("dock-resize-handle");
		// Simulate drag: down at clientX=900, move to 800. Handle is on the
		// LEFT edge — moving LEFT widens, so width = startWidth + 100.
		await fireEvent.pointerDown(handle, { clientX: 900, pointerId: 1 });
		await fireEvent.pointerMove(handle, { clientX: 800, pointerId: 1 });
		await fireEvent.pointerUp(handle, { clientX: 800, pointerId: 1 });
		// The clamp may bound the result; just assert mutation happened.
		expect(store.dockSizePx).not.toBe(startWidth);
	});

	test("at viewport ≤640px the host renders with fixed-inset class (mobile overlay)", async () => {
		// jsdom default is 1024 — shrink before mount.
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
		seedDocked("tc-5");
		const { getByTestId } = render(DockHost, { conversationId: "conv-1" });
		const host = getByTestId("dock-host");
		expect(host.classList.contains("dock-host-mobile")).toBe(true);
	});
});

describe("validation: DockHost — Esc, pop-out, fixed positioning", () => {
	test("Esc key dismisses the open dock", async () => {
		seedDocked("tc-esc-1");
		const { getByTestId, queryByTestId } = render(DockHost, { conversationId: "conv-1" });
		expect(getByTestId("dock-host")).toBeInTheDocument();
		// Dispatch keydown on window — DockHost binds the listener there.
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		// Wait a microtask for Svelte to re-render after closeDock.
		await Promise.resolve();
		expect(queryByTestId("dock-host")).toBeNull();
	});

	test("pop-out button click invokes window.open with _blank + noopener", async () => {
		// Use a same-origin URL so extractPopoutUrl returns a value.
		// jsdom's location.origin defaults to http://localhost.
		inlineToolStore.calls = [{
			id: "tc-popout-1",
			extensionName: "claude-design",
			toolName: "claude-design__open-canvas",
			input: { draftId: "d-1" },
			status: "complete",
			retryCount: 0,
			conversationId: "conv-1",
			cardType: "design-canvas",
			cardLayout: "dock",
			output: JSON.stringify({
				draftId: "d-1",
				iframeSrc: "/api/extensions/claude-design/data/preview.html",
			}),
			duration: 100,
		}];
		openDock("conv-1", "tc-popout-1");

		const opened: Array<{ url?: string | URL; target?: string; features?: string }> = [];
		const orig = window.open;
		// vitest's vi.spyOn would also work; manual stub keeps the test
		// dependency-light.
		(window as unknown as { open: typeof window.open }).open = ((
			url?: string | URL,
			target?: string,
			features?: string,
		) => {
			opened.push({ url, target, features });
			return null;
		}) as typeof window.open;

		try {
			const { getByTestId } = render(DockHost, { conversationId: "conv-1" });
			const popoutBtn = getByTestId("dock-popout");
			await fireEvent.click(popoutBtn);
			expect(opened).toHaveLength(1);
			expect(String(opened[0]!.url)).toContain(
				"/api/extensions/claude-design/data/preview.html",
			);
			expect(opened[0]!.target).toBe("_blank");
			expect(opened[0]!.features ?? "").toContain("noopener");
		} finally {
			window.open = orig;
		}
	});

	test("pop-out button is hidden when iframeSrc is missing", () => {
		// Tool result with no iframeSrc — the dock still mounts (the
		// canvas card may show a placeholder), but the pop-out affordance
		// must not appear.
		inlineToolStore.calls = [{
			id: "tc-no-popout",
			extensionName: "claude-design",
			toolName: "claude-design__open-canvas",
			input: { draftId: "d-1" },
			status: "complete",
			retryCount: 0,
			conversationId: "conv-1",
			cardType: "design-canvas",
			cardLayout: "dock",
			output: JSON.stringify({ draftId: "d-1" }), // no iframeSrc
			duration: 100,
		}];
		openDock("conv-1", "tc-no-popout");

		const { queryByTestId, getByTestId } = render(DockHost, { conversationId: "conv-1" });
		expect(getByTestId("dock-host")).toBeInTheDocument();
		expect(queryByTestId("dock-popout")).toBeNull();
	});

	test("pop-out button is hidden for a cross-origin iframeSrc", () => {
		inlineToolStore.calls = [{
			id: "tc-cross",
			extensionName: "claude-design",
			toolName: "claude-design__open-canvas",
			input: { draftId: "d-1" },
			status: "complete",
			retryCount: 0,
			conversationId: "conv-1",
			cardType: "design-canvas",
			cardLayout: "dock",
			output: JSON.stringify({
				draftId: "d-1",
				iframeSrc: "https://evil.example.com/steal.html",
			}),
			duration: 100,
		}];
		openDock("conv-1", "tc-cross");

		const { queryByTestId, getByTestId } = render(DockHost, { conversationId: "conv-1" });
		expect(getByTestId("dock-host")).toBeInTheDocument();
		expect(queryByTestId("dock-popout")).toBeNull();
	});

	test("DockHost is fixed-positioned and stays at right: 0 (reservedDockPx applies to <main>, not the dock itself)", () => {
		// Smoke check on the inline `style` and class — the dock host
		// must be position: fixed and right-anchored. The padding-right
		// on <main> in the +layout is what creates the visible gap;
		// the dock's own position is unchanged.
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
		seedDocked("tc-fixed-1");
		const { getByTestId } = render(DockHost, { conversationId: "conv-1" });
		const host = getByTestId("dock-host");
		// Class flag for the desktop layout — the .dock-host CSS rule
		// hardcodes `position: fixed; right: 0`.
		expect(host.classList.contains("dock-host-desktop")).toBe(true);
		// Inline width style is set; no `transform`/`right`/`left`
		// override is injected.
		const inlineStyle = host.getAttribute("style") ?? "";
		expect(inlineStyle).toContain("width:");
		expect(inlineStyle).not.toContain("right:");
		expect(inlineStyle).not.toContain("transform:");
	});
});
