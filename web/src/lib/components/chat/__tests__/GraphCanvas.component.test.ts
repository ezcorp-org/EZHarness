/**
 * DOM tests for GraphCanvas.svelte — the SVG chat-DAG renderer.
 *
 * The layout is fed through the REAL `layoutGraph`, not a hand-built
 * `LayoutResult`, so these tests also pin that the renderer consumes the
 * layout contract as shipped (viewBox from width/height, one `<g>` per
 * node at the laid-out coordinates, one `<path>` per edge).
 *
 * Focus is asserted via the roving `tabindex` + the drawn focus ring rather
 * than `document.activeElement`, because jsdom's focus handling for SVG
 * elements is not the behaviour under test.
 */
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, vi } from "vitest";
import GraphCanvas from "../GraphCanvas.svelte";
import { layoutGraph } from "$lib/graph/layout";
import { LABEL_GUTTER, labelFadeStart, ZOOM_MAX, ZOOM_MIN } from "$lib/graph/canvas-view";
import type { ChatGraph, GraphEdge, GraphNode } from "$server/runtime/chat-graph/types";

afterEach(() => cleanup());

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
	return {
		id,
		kind: "prompt",
		label: id,
		status: "success",
		createdAt: `2026-07-26T10:00:0${id.length}.000Z`,
		...over,
	};
}

function graph(nodes: GraphNode[], edges: GraphEdge[] = []): ChatGraph {
	return { level: 1, rootId: nodes[0]?.id ?? null, conversationId: "conv-1", nodes, edges };
}

/**
 * Two prompts in a chain, plus a spawned sub-agent hanging off the second
 * and a rewound-away sibling — one fixture that exercises every visual
 * state the canvas distinguishes.
 */
const RICH = graph(
	[
		node("p1", { drillable: true, label: "First ask", fullLabel: "First ask, in full" }),
		node("p2", { drillable: true, durationMs: 1500 }),
		node("t1", { kind: "tool", status: "error", durationMs: 120, label: "bash" }),
		node("s1", { kind: "subagent", drillable: true, subConversationId: "conv-2", label: "reviewer" }),
		node("x1", { excluded: true, label: "rewound" }),
	],
	[
		{ from: "p1", to: "p2", kind: "sequence" },
		{ from: "p1", to: "x1", kind: "branch" },
		{ from: "p2", to: "t1", kind: "sequence" },
		{ from: "p2", to: "s1", kind: "spawn" },
	],
);

function renderCanvas(g: ChatGraph = RICH, selectedId: string | null = null, focusOnMount = false) {
	const onactivate = vi.fn();
	const layout = layoutGraph(g);
	const utils = render(GraphCanvas, { layout, selectedId, focusOnMount, onactivate });
	return { ...utils, onactivate, layout };
}

/** The `<g>` for one node id. */
function nodeEl(container: HTMLElement, id: string): SVGGElement {
	const el = container.querySelector<SVGGElement>(`[data-node-id="${id}"]`);
	expect(el).not.toBeNull();
	return el!;
}

function scroller(container: HTMLElement): HTMLDivElement {
	return container.querySelector<HTMLDivElement>('[data-testid="chat-graph-scroller"]')!;
}

/** Current pan, as the scroll offsets the drag handler actually writes. */
function panOf(container: HTMLElement): [number, number] {
	const el = scroller(container);
	return [el.scrollLeft, el.scrollTop];
}

describe("GraphCanvas rendering", () => {
	test("draws one group per node and one path per edge", () => {
		const { getAllByTestId } = renderCanvas();
		expect(getAllByTestId("chat-graph-node")).toHaveLength(5);
		expect(getAllByTestId("chat-graph-edge")).toHaveLength(4);
	});

	test("the viewBox is the layout's own content box", () => {
		const { container, layout } = renderCanvas();
		const svg = container.querySelector("svg")!;
		expect(svg.getAttribute("viewBox")).toBe(`0 0 ${layout.width} ${layout.height}`);
	});

	test("at 100% the SVG is drawn at 1 viewBox unit per CSS pixel, so labels stay legible", () => {
		const { container, layout } = renderCanvas();
		const svg = container.querySelector("svg")!;
		expect(svg.getAttribute("width")).toBe(String(layout.width));
		expect(svg.getAttribute("height")).toBe(String(layout.height));
	});

	test("each node group is translated to its laid-out coordinates", () => {
		const { container, layout } = renderCanvas();
		const laid = layout.nodes.find((n) => n.id === "p1")!;
		expect(nodeEl(container, "p1").getAttribute("transform")).toBe(`translate(${laid.x},${laid.y})`);
	});

	test("node kind and status are exposed for styling", () => {
		const { container } = renderCanvas();
		expect(nodeEl(container, "t1").getAttribute("data-kind")).toBe("tool");
		expect(nodeEl(container, "t1").getAttribute("data-status")).toBe("error");
		expect(nodeEl(container, "s1").getAttribute("data-kind")).toBe("subagent");
	});

	test("a rewound-away node is flagged excluded; a live one is not", () => {
		const { container } = renderCanvas();
		expect(nodeEl(container, "x1").getAttribute("data-excluded")).toBe("true");
		expect(nodeEl(container, "p1").getAttribute("data-excluded")).toBe("false");
	});

	test("drillable nodes are flagged and get real button semantics", () => {
		const { container } = renderCanvas();
		const p1 = nodeEl(container, "p1");
		expect(p1.getAttribute("data-drillable")).toBe("true");
		expect(p1.getAttribute("role")).toBe("button");
		expect(nodeEl(container, "t1").getAttribute("data-drillable")).toBe("false");
	});

	test("the aria-label names the drill-in action", () => {
		const { container } = renderCanvas();
		expect(nodeEl(container, "p1").getAttribute("aria-label")).toContain("Opens this turn's trace.");
		expect(nodeEl(container, "s1").getAttribute("aria-label")).toContain("Opens this sub-agent's graph.");
		expect(nodeEl(container, "t1").getAttribute("aria-label")).toContain("Shows details.");
	});

	test("the title tooltip carries the untruncated label", () => {
		const { container } = renderCanvas();
		expect(nodeEl(container, "p1").querySelector("title")?.textContent).toBe("First ask, in full");
	});

	test("an absent durationMs renders an em dash, never 0ms", () => {
		const { container } = renderCanvas();
		const meta = nodeEl(container, "p1").querySelector(".node-meta")!.textContent;
		expect(meta).toBe("Prompt · —");
		expect(meta).not.toContain("0ms");
	});

	test("a known durationMs renders as a real number", () => {
		const { container } = renderCanvas();
		expect(nodeEl(container, "t1").querySelector(".node-meta")!.textContent).toBe("Tool · 120ms");
		expect(nodeEl(container, "p2").querySelector(".node-meta")!.textContent).toBe("Prompt · 1s");
	});

	test("spawn edges are dashed; sequence and branch are solid", () => {
		const { container } = renderCanvas();
		const dash = (from: string, to: string) =>
			container.querySelector(`[data-from="${from}"][data-to="${to}"]`)!.getAttribute("stroke-dasharray");
		expect(dash("p2", "s1")).toBe("6 4");
		expect(dash("p1", "p2")).toBe("none");
		expect(dash("p1", "x1")).toBe("none");
	});

	test("edge kind is exposed for styling", () => {
		const { container } = renderCanvas();
		expect(container.querySelector('[data-from="p1"][data-to="x1"]')!.getAttribute("data-kind")).toBe("branch");
	});

	test("the text mask and arrow marker ids are instance-unique", () => {
		const first = renderCanvas();
		const second = renderCanvas();
		const maskOf = (c: HTMLElement) => c.querySelector("mask")!.getAttribute("id");
		expect(maskOf(first.container)).not.toBe(maskOf(second.container));
	});

	test("an empty layout renders no nodes and still sizes the text mask", () => {
		const { container, queryAllByTestId } = renderCanvas(graph([]));
		expect(queryAllByTestId("chat-graph-node")).toHaveLength(0);
		// Falls back to the default node width (168) minus the status-dot gutter.
		expect(container.querySelector("mask rect")!.getAttribute("width")).toBe("146");
	});

	test("an overlong label fades out instead of being sliced mid-glyph", () => {
		// Labels arrive truncated to LABEL_MAX (60) but a 168px box shows ~23
		// characters, so this is the common case, not an edge case. The mask's
		// gradient must hold full opacity up to the fade, then run to zero.
		const { container } = renderCanvas();
		// `stop`, not `linearGradient stop`: jsdom lowercases type selectors, so
		// the camelCase SVG element name never matches.
		const stops = [...container.querySelectorAll("stop")].map((s) => ({
			offset: s.getAttribute("offset"),
			color: s.getAttribute("stop-color"),
		}));
		expect(stops).toEqual([
			{ offset: "0", color: "#fff" },
			{ offset: String(labelFadeStart(168 - LABEL_GUTTER)), color: "#fff" },
			{ offset: "1", color: "#000" },
		]);
		// The label group is masked by that gradient, not hard-clipped.
		const masked = nodeEl(container, "p1").querySelector(".node-label")!.parentElement!;
		expect(masked.getAttribute("mask")).toMatch(/^url\(#.*-nodemask\)$/);
	});
});

describe("GraphCanvas activation", () => {
	test("clicking a node reports it", async () => {
		const { container, onactivate } = renderCanvas();
		await fireEvent.click(nodeEl(container, "p1"));
		expect(onactivate).toHaveBeenCalledTimes(1);
		expect(onactivate.mock.calls[0]![0].id).toBe("p1");
	});

	test("clicking a leaf node reports it too — selection is not drill-only", async () => {
		const { container, onactivate } = renderCanvas();
		await fireEvent.click(nodeEl(container, "t1"));
		expect(onactivate).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }), "pointer");
	});

	test("Enter activates the focused node", async () => {
		const { container, onactivate } = renderCanvas();
		await fireEvent.keyDown(nodeEl(container, "p1"), { key: "Enter" });
		expect(onactivate).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }), "keyboard");
	});

	test("Space activates too, like a native button", async () => {
		const { container, onactivate } = renderCanvas();
		await fireEvent.keyDown(nodeEl(container, "s1"), { key: " " });
		expect(onactivate).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), "keyboard");
	});

	test("activation reports whether it came from the pointer or the keyboard", async () => {
		// The panel restores focus after a keyboard drill-in and must not after
		// a click, and DOM focus cannot tell them apart — a clicked SVG node is
		// focused too. So the handler that fired is the only witness.
		const { container, onactivate } = renderCanvas();
		await fireEvent.click(nodeEl(container, "p1"));
		expect(onactivate.mock.calls[0]![1]).toBe("pointer");
		await fireEvent.keyDown(nodeEl(container, "p2"), { key: "Enter" });
		expect(onactivate.mock.calls[1]![1]).toBe("keyboard");
		await fireEvent.keyDown(nodeEl(container, "t1"), { key: " " });
		expect(onactivate.mock.calls[2]![1]).toBe("keyboard");
	});

	test("focusOnMount takes DOM focus on the tab stop as the graph mounts", () => {
		const { container } = renderCanvas(RICH, null, true);
		expect(document.activeElement).toBe(nodeEl(container, "p1"));
	});

	test("without focusOnMount the graph never steals focus", () => {
		renderCanvas();
		expect(document.activeElement).toBe(document.body);
	});

	test("an unrelated key neither activates nor moves focus", async () => {
		const { container, onactivate } = renderCanvas();
		await fireEvent.keyDown(nodeEl(container, "p1"), { key: "q" });
		expect(onactivate).not.toHaveBeenCalled();
		expect(nodeEl(container, "p1").getAttribute("tabindex")).toBe("0");
	});
});

describe("GraphCanvas keyboard navigation", () => {
	test("the first node is the tab stop until focus moves", () => {
		const { container } = renderCanvas();
		expect(nodeEl(container, "p1").getAttribute("tabindex")).toBe("0");
		expect(nodeEl(container, "p2").getAttribute("tabindex")).toBe("-1");
	});

	test("ArrowDown moves the tab stop to the nearest node one rank down", async () => {
		const { container } = renderCanvas();
		// Focus first: in a browser the keydown target is already focused, and
		// that focus is what tells the canvas where "here" is.
		await fireEvent.focus(nodeEl(container, "p1"));
		await fireEvent.keyDown(nodeEl(container, "p1"), { key: "ArrowDown" });
		expect(nodeEl(container, "p1").getAttribute("tabindex")).toBe("-1");
		// Rank 1 holds p2 and the rewound x1, equidistant from p1's centre —
		// the tie goes to the earlier node in layout order.
		expect(container.querySelector('[tabindex="0"]')!.getAttribute("data-node-id")).toBe("p2");
	});

	test("arrowing with nothing focused yet lands on the first node", async () => {
		const { container } = renderCanvas();
		await fireEvent.keyDown(nodeEl(container, "t1"), { key: "ArrowUp" });
		expect(nodeEl(container, "p1").getAttribute("tabindex")).toBe("0");
	});

	test("End jumps to the last node and draws the focus ring there", async () => {
		const { container } = renderCanvas();
		await fireEvent.keyDown(nodeEl(container, "p1"), { key: "End" });
		const last = container.querySelector('[tabindex="0"]')!;
		expect(last.querySelector('[data-testid="chat-graph-node-ring"]')).not.toBeNull();
		expect(nodeEl(container, "p1").querySelector('[data-testid="chat-graph-node-ring"]')).toBeNull();
	});

	test("focusing a node makes it the tab stop", async () => {
		const { container } = renderCanvas();
		await fireEvent.focus(nodeEl(container, "t1"));
		expect(nodeEl(container, "t1").getAttribute("tabindex")).toBe("0");
	});

	test("the selected node keeps a ring even without focus", () => {
		const { container } = renderCanvas(RICH, "t1");
		expect(nodeEl(container, "t1").querySelector('[data-testid="chat-graph-node-ring"]')).not.toBeNull();
	});

	test("switching levels re-homes the tab stop instead of stranding it on a gone node", async () => {
		const onactivate = vi.fn();
		const { container, rerender } = render(GraphCanvas, {
			layout: layoutGraph(RICH),
			selectedId: null,
			onactivate,
		});
		// The user focuses a level-1 prompt, then drills in: the level-2 graph
		// shares NONE of its node ids. Without re-homing, every node would be
		// `tabindex="-1"` and the graph would drop out of the tab order.
		await fireEvent.focus(nodeEl(container, "p1"));
		const level2 = graph([node("thinking:a1", { kind: "thinking" }), node("a1", { kind: "assistant" })]);
		await rerender({ layout: layoutGraph(level2), selectedId: null, onactivate });

		const stops = [...container.querySelectorAll("[data-node-id]")].map((el) => el.getAttribute("tabindex"));
		expect(stops).toEqual(["0", "-1"]);
	});
});

describe("GraphCanvas zoom", () => {
	/** Rendered width ÷ viewBox width — i.e. the effective zoom. */
	const zoomOf = (container: HTMLElement, layoutWidth: number) =>
		Number(container.querySelector("svg")!.getAttribute("width")) / layoutWidth;

	test("starts at 100% and unpanned", () => {
		const { container, layout } = renderCanvas();
		expect(zoomOf(container, layout.width)).toBe(1);
		expect(panOf(container)).toEqual([0, 0]);
	});

	test("the zoom-in button scales the drawing up", async () => {
		const { container, getByTestId, layout } = renderCanvas();
		await fireEvent.click(getByTestId("chat-graph-zoom-in"));
		expect(zoomOf(container, layout.width)).toBeCloseTo(1.2, 10);
	});

	test("the zoom-out button scales the drawing down", async () => {
		const { container, getByTestId, layout } = renderCanvas();
		await fireEvent.click(getByTestId("chat-graph-zoom-out"));
		expect(zoomOf(container, layout.width)).toBeCloseTo(1 / 1.2, 10);
	});

	test("the viewBox never changes — only the rendered size does", async () => {
		const { container, getByTestId, layout } = renderCanvas();
		await fireEvent.click(getByTestId("chat-graph-zoom-in"));
		expect(container.querySelector("svg")!.getAttribute("viewBox")).toBe(`0 0 ${layout.width} ${layout.height}`);
	});

	test("wheel up zooms in, wheel down zooms out", async () => {
		const { container, layout } = renderCanvas();
		const svg = container.querySelector("svg")!;
		await fireEvent.wheel(svg, { deltaY: -120 });
		expect(zoomOf(container, layout.width)).toBeCloseTo(1.2, 10);
		await fireEvent.wheel(svg, { deltaY: 120 });
		expect(zoomOf(container, layout.width)).toBeCloseTo(1, 10);
	});

	test("zoom is clamped in both directions", async () => {
		const { container, getByTestId, layout } = renderCanvas();
		for (let i = 0; i < 20; i++) await fireEvent.click(getByTestId("chat-graph-zoom-in"));
		expect(zoomOf(container, layout.width)).toBe(ZOOM_MAX);
		for (let i = 0; i < 40; i++) await fireEvent.click(getByTestId("chat-graph-zoom-out"));
		expect(zoomOf(container, layout.width)).toBe(ZOOM_MIN);
	});

	test("Reset restores zoom and pan together", async () => {
		const { container, getByTestId, layout } = renderCanvas();
		await fireEvent.click(getByTestId("chat-graph-zoom-in"));
		scroller(container).scrollLeft = 120;
		await fireEvent.mouseDown(container.querySelector("svg")!, { clientX: 40, clientY: 40 });
		await fireEvent.mouseMove(window, { clientX: 10, clientY: 0, buttons: 1 });
		await fireEvent.mouseUp(window);
		expect(panOf(container)).not.toEqual([0, 0]);
		await fireEvent.click(getByTestId("chat-graph-zoom-reset"));
		expect(zoomOf(container, layout.width)).toBe(1);
		expect(panOf(container)).toEqual([0, 0]);
	});
});

describe("GraphCanvas pan", () => {
	test("dragging the background scrolls the container", async () => {
		const { container } = renderCanvas();
		const svg = container.querySelector("svg")!;
		scroller(container).scrollLeft = 100;
		scroller(container).scrollTop = 100;
		await fireEvent.mouseDown(svg, { clientX: 10, clientY: 10 });
		await fireEvent.mouseMove(window, { clientX: 40, clientY: 35, buttons: 1 });
		// Dragging right/down reveals content up and to the left, so the scroll
		// offsets DECREASE by the drag distance — grab-and-drag.
		expect(panOf(container)).toEqual([70, 75]);
		await fireEvent.mouseUp(window);
		// Releasing stops the drag: further movement must not pan.
		await fireEvent.mouseMove(window, { clientX: 500, clientY: 500, buttons: 1 });
		expect(panOf(container)).toEqual([70, 75]);
	});

	test("a drag that starts on a node does not pan", async () => {
		const { container } = renderCanvas();
		await fireEvent.mouseDown(nodeEl(container, "p1"), { clientX: 10, clientY: 10 });
		await fireEvent.mouseMove(window, { clientX: 90, clientY: 90, buttons: 1 });
		expect(panOf(container)).toEqual([0, 0]);
	});

	test("pan is 1:1 with the mouse at every zoom", async () => {
		// Scroll offsets and the mouse delta are both rendered CSS pixels, so
		// unlike the old viewBox transform this needs no `/ zoom` correction.
		const { container, getByTestId } = renderCanvas();
		for (let i = 0; i < 4; i++) await fireEvent.click(getByTestId("chat-graph-zoom-in"));
		scroller(container).scrollLeft = 50;
		const svg = container.querySelector("svg")!;
		await fireEvent.mouseDown(svg, { clientX: 0, clientY: 0 });
		await fireEvent.mouseMove(window, { clientX: 20, clientY: 0, buttons: 1 });
		expect(panOf(container)[0]).toBe(30);
	});

	test("mouse movement with no drag in progress is ignored", async () => {
		const { container } = renderCanvas();
		await fireEvent.mouseMove(window, { clientX: 200, clientY: 200, buttons: 1 });
		expect(panOf(container)).toEqual([0, 0]);
	});

	test("a button released outside the window does not leave the drag stuck on", async () => {
		// Releasing outside the browser fires no `mouseup` we can see, so the
		// drag would stay armed and the graph would pan with nothing held.
		const { container } = renderCanvas();
		const svg = container.querySelector("svg")!;
		scroller(container).scrollLeft = 100;
		await fireEvent.mouseDown(svg, { clientX: 50, clientY: 50 });
		// …release happens off-window here…
		await fireEvent.mouseMove(window, { clientX: 90, clientY: 50, buttons: 0 });
		expect(panOf(container)).toEqual([100, 0]);
		// And the drag is disarmed, so a later move with a button held (a fresh
		// gesture elsewhere) still does not pan without its own mousedown.
		await fireEvent.mouseMove(window, { clientX: 400, clientY: 50, buttons: 1 });
		expect(panOf(container)).toEqual([100, 0]);
	});
});
