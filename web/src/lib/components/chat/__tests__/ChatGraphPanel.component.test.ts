/**
 * DOM tests for ChatGraphPanel.svelte — the chat-DAG drawer.
 *
 * Covers the four load states (loading / error / empty / drawn), the two
 * quiet notices (degraded payload, cyclic payload), and the drill-down
 * stack: level 1 → a turn's level 2 → a sub-agent's own level 1, with the
 * breadcrumb walking back out of it.
 *
 * `fetch` is stubbed per URL so the level-1 → level-2 navigation is asserted
 * on the real endpoint shape (`?turn=<messageId>`), not on an internal call.
 */
import { render, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import { describe, test, expect, afterEach, vi } from "vitest";
import { tick } from "svelte";
import ChatGraphPanel from "../ChatGraphPanel.svelte";
import type { ChatGraph, GraphEdge, GraphNode } from "$server/runtime/chat-graph/types";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const L1_URL = "/api/conversations/conv-1/graph";
const L2_URL = "/api/conversations/conv-1/graph?turn=p1";
const SUB_URL = "/api/conversations/conv-2/graph";

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
	return { id, kind: "prompt", label: id, status: "success", createdAt: "2026-07-26T10:00:01.000Z", ...over };
}

function graph(nodes: GraphNode[], over: Partial<ChatGraph> = {}, edges: GraphEdge[] = []): ChatGraph {
	return { level: 1, rootId: nodes[0]?.id ?? null, conversationId: "conv-1", nodes, edges, ...over };
}

const LEVEL_1 = graph([
	node("p1", { drillable: true, label: "First ask" }),
	node("p2", { drillable: true, label: "Second ask" }),
]);

const LEVEL_2 = graph(
	[
		node("think", { kind: "thinking", label: "Reasoning" }),
		node("tc1", { kind: "tool", label: "bash", durationMs: 120 }),
		node("sub", { kind: "subagent", label: "reviewer", drillable: true, subConversationId: "conv-2" }),
	],
	{ level: 2, rootId: "p1" },
);

const SUB_GRAPH = graph([node("s-p1", { label: "sub prompt" })], { conversationId: "conv-2" });

/** Route each URL to its payload; anything unrouted is a 404. */
function stubFetch(routes: Record<string, ChatGraph>) {
	const spy = vi.fn(async (url: string) => {
		const body = routes[url];
		if (body === undefined) return new Response("{}", { status: 404 });
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", spy);
	return spy;
}

function open(props: Record<string, unknown> = {}) {
	const onclose = vi.fn();
	const utils = render(ChatGraphPanel, { conversationId: "conv-1", open: true, onclose, ...props });
	return { ...utils, onclose };
}

/**
 * Drain Svelte's microtask queue until the panel has finished a navigation.
 *
 * `waitFor` is not usable for the focus assertions: its retry wrapper drives
 * Svelte from outside a reactive context and throws `rune_outside_svelte`
 * before the condition can ever come true. The navigation is a fetch plus a
 * couple of render passes, so a bounded tick drain is both sufficient and
 * deterministic.
 */
async function settle() {
	for (let i = 0; i < 20; i++) await tick();
}

const nodeEl = (container: HTMLElement, id: string) =>
	container.querySelector<SVGGElement>(`[data-node-id="${id}"]`)!;

/** The single node holding the roving tabindex — what a Tab press reaches. */
const tabStop = (container: HTMLElement) =>
	container.querySelector<SVGGElement>('[data-node-id][tabindex="0"]');

const crumbText = (getAllByTestId: (id: string) => HTMLElement[]) =>
	getAllByTestId("chat-graph-crumb").map((b) => b.textContent);

describe("ChatGraphPanel drawer", () => {
	test("renders nothing while closed and does not fetch", () => {
		const spy = stubFetch({ [L1_URL]: LEVEL_1 });
		const { queryByTestId } = render(ChatGraphPanel, {
			conversationId: "conv-1",
			open: false,
			onclose: vi.fn(),
		});
		expect(queryByTestId("chat-graph-panel")).toBeNull();
		expect(spy).not.toHaveBeenCalled();
	});

	test("opening fetches level 1 and draws its nodes", async () => {
		const spy = stubFetch({ [L1_URL]: LEVEL_1 });
		const { findByTestId, getAllByTestId } = open();
		await findByTestId("chat-graph-canvas");
		expect(spy).toHaveBeenCalledWith(L1_URL);
		expect(getAllByTestId("chat-graph-node")).toHaveLength(2);
	});

	test("the heading names the level", async () => {
		stubFetch({ [L1_URL]: LEVEL_1 });
		const { findByRole } = open();
		expect(await findByRole("heading", { name: "Conversation map" })).toBeInTheDocument();
	});

	test("the close button reports up to the page", async () => {
		stubFetch({ [L1_URL]: LEVEL_1 });
		const { findByTestId, onclose } = open();
		await fireEvent.click(await findByTestId("chat-graph-close"));
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	test("shows a loading line until the payload lands", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise(() => {})),
		);
		const { findByTestId } = open();
		expect(await findByTestId("chat-graph-loading")).toHaveTextContent("Loading graph");
	});
});

describe("ChatGraphPanel load failures", () => {
	test("a 404 says the graph is gone, and does not draw a canvas", async () => {
		stubFetch({});
		const { findByTestId, queryByTestId } = open();
		expect(await findByTestId("chat-graph-error")).toHaveTextContent("no longer available");
		expect(queryByTestId("chat-graph-canvas")).toBeNull();
	});

	test("any other failure is a generic error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("nope", { status: 500 })),
		);
		const { findByTestId } = open();
		expect(await findByTestId("chat-graph-error")).toHaveTextContent("Could not load the graph.");
	});

	test("a network throw is an error, not a crash", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		const { findByTestId } = open();
		expect(await findByTestId("chat-graph-error")).toHaveTextContent("Could not load the graph.");
	});

	test("Try again refetches and recovers", async () => {
		let ok = false;
		const spy = vi.fn(async () => {
			if (!ok) return new Response("nope", { status: 500 });
			return new Response(JSON.stringify(LEVEL_1), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", spy);
		const { findByTestId, getAllByTestId } = open();
		await findByTestId("chat-graph-error");
		ok = true;
		await fireEvent.click(await findByTestId("chat-graph-retry"));
		await findByTestId("chat-graph-canvas");
		expect(getAllByTestId("chat-graph-node")).toHaveLength(2);
		expect(spy).toHaveBeenCalledTimes(2);
	});
});

describe("ChatGraphPanel quiet states", () => {
	test("an empty conversation gets a plain message, not an error", async () => {
		stubFetch({ [L1_URL]: graph([]) });
		const { findByTestId, queryByTestId } = open();
		expect(await findByTestId("chat-graph-empty")).toHaveTextContent("Nothing to map yet");
		expect(queryByTestId("chat-graph-error")).toBeNull();
	});

	test("a degraded payload still draws, with a notice", async () => {
		stubFetch({ [L1_URL]: graph([node("p1")], { degraded: true }) });
		const { findByTestId } = open();
		expect(await findByTestId("chat-graph-notice")).toHaveTextContent("Branch history is unavailable");
		expect(await findByTestId("chat-graph-canvas")).toBeInTheDocument();
	});

	test("a cyclic payload still draws, with a notice", async () => {
		const cyclic = graph(
			[node("a"), node("b")],
			{},
			[
				{ from: "a", to: "b", kind: "sequence" },
				{ from: "b", to: "a", kind: "sequence" },
			],
		);
		stubFetch({ [L1_URL]: cyclic });
		const { findByTestId } = open();
		expect(await findByTestId("chat-graph-notice")).toHaveTextContent("loop");
		expect(await findByTestId("chat-graph-canvas")).toBeInTheDocument();
	});

	test("a clean payload shows no notice and no breadcrumb", async () => {
		stubFetch({ [L1_URL]: LEVEL_1 });
		const { findByTestId, queryByTestId } = open();
		await findByTestId("chat-graph-canvas");
		expect(queryByTestId("chat-graph-notice")).toBeNull();
		expect(queryByTestId("chat-graph-breadcrumb")).toBeNull();
	});
});

function queryByTestIdIn(root: HTMLElement, id: string): HTMLElement | null {
	return root.querySelector(`[data-testid="${id}"]`);
}

describe("ChatGraphPanel drill-down", () => {
	test("clicking a level-1 prompt loads that turn's level 2", async () => {
		const spy = stubFetch({ [L1_URL]: LEVEL_1, [L2_URL]: LEVEL_2 });
		const { container, findByTestId, findByRole, getAllByTestId } = open();
		await findByTestId("chat-graph-canvas");
		await fireEvent.click(nodeEl(container, "p1"));
		await waitFor(() => expect(spy).toHaveBeenCalledWith(L2_URL));
		expect(await findByRole("heading", { name: "Turn trace" })).toBeInTheDocument();
		await waitFor(() => expect(getAllByTestId("chat-graph-node")).toHaveLength(3));
	});

	test("drilling in builds a breadcrumb whose last crumb is the current level", async () => {
		stubFetch({ [L1_URL]: LEVEL_1, [L2_URL]: LEVEL_2 });
		const { container, findByTestId, getAllByTestId } = open();
		await findByTestId("chat-graph-canvas");
		await fireEvent.click(nodeEl(container, "p1"));
		await findByTestId("chat-graph-breadcrumb");
		expect(crumbText(getAllByTestId)).toEqual(["Conversation", "First ask"]);
		const crumbs = getAllByTestId("chat-graph-crumb") as HTMLButtonElement[];
		expect(crumbs[1]!.disabled).toBe(true);
		expect(crumbs[1]!.getAttribute("aria-current")).toBe("page");
	});

	test("a keyboard drill-in hands focus to the new level's graph", async () => {
		// Navigating swaps the panel to its loading state, which unmounts the
		// canvas — so the node the user was standing on is destroyed and the
		// browser drops focus to <body>. Without a hand-off they are stranded
		// outside the graph and have to Tab back in from the top of the drawer.
		stubFetch({ [L1_URL]: LEVEL_1, [L2_URL]: LEVEL_2 });
		const { container, findByTestId } = open();
		await findByTestId("chat-graph-canvas");
		await fireEvent.keyDown(nodeEl(container, "p1"), { key: "Enter" });
		await settle();
		// Focus lands on the level-2 tab stop — asserted as "the tab stop"
		// rather than a hardcoded id, because that is the actual invariant
		// (which node sorts first is the layout's business, not this test's).
		const stop = tabStop(container);
		expect(stop).not.toBeNull();
		expect(document.activeElement).toBe(stop);
		expect(nodeEl(container, "p1")).toBeNull();
	});

	test("a MOUSE drill-in leaves focus alone — nothing was lost, so nothing moves", async () => {
		stubFetch({ [L1_URL]: LEVEL_1, [L2_URL]: LEVEL_2 });
		const { container, findByTestId } = open();
		await findByTestId("chat-graph-canvas");
		await fireEvent.click(nodeEl(container, "p1"));
		await settle();
		expect(tabStop(container)).not.toBeNull();
		expect(document.activeElement).toBe(document.body);
	});

	test("going back never grabs focus — the breadcrumb button still has it", async () => {
		stubFetch({ [L1_URL]: LEVEL_1, [L2_URL]: LEVEL_2 });
		const { container, findByTestId, getByTestId } = open();
		await findByTestId("chat-graph-canvas");
		// Keyboard in, so the drill-in DID hand focus over…
		await fireEvent.keyDown(nodeEl(container, "p1"), { key: "Enter" });
		await settle();
		expect(document.activeElement).toBe(tabStop(container));
		// …but popping back must not, or focus would jump out of the breadcrumb
		// the user is still operating.
		await fireEvent.click(getByTestId("chat-graph-back"));
		await settle();
		expect(nodeEl(container, "p1")).not.toBeNull();
		expect(document.activeElement).not.toBe(tabStop(container));
	});

	test("a sub-agent node drills into the CHILD conversation's own graph", async () => {
		const spy = stubFetch({ [L1_URL]: LEVEL_1, [L2_URL]: LEVEL_2, [SUB_URL]: SUB_GRAPH });
		const { container, findByTestId, getAllByTestId } = open();
		await findByTestId("chat-graph-canvas");
		await fireEvent.click(nodeEl(container, "p1"));
		await waitFor(() => expect(nodeEl(container, "sub")).not.toBeNull());
		await fireEvent.click(nodeEl(container, "sub"));
		await waitFor(() => expect(spy).toHaveBeenCalledWith(SUB_URL));
		await waitFor(() => expect(crumbText(getAllByTestId)).toEqual(["Conversation", "First ask", "reviewer"]));
	});

	test("the back button pops one level", async () => {
		stubFetch({ [L1_URL]: LEVEL_1, [L2_URL]: LEVEL_2 });
		const { container, findByTestId, queryByTestId } = open();
		await findByTestId("chat-graph-canvas");
		await fireEvent.click(nodeEl(container, "p1"));
		await fireEvent.click(await findByTestId("chat-graph-back"));
		await waitFor(() => expect(queryByTestId("chat-graph-breadcrumb")).toBeNull());
		await waitFor(() => expect(nodeEl(container, "p1")).not.toBeNull());
	});

	test("clicking an earlier crumb pops back to it", async () => {
		stubFetch({ [L1_URL]: LEVEL_1, [L2_URL]: LEVEL_2, [SUB_URL]: SUB_GRAPH });
		const { container, findByTestId, getAllByTestId, queryAllByTestId } = open();
		await findByTestId("chat-graph-canvas");
		await fireEvent.click(nodeEl(container, "p1"));
		await waitFor(() => expect(nodeEl(container, "sub")).not.toBeNull());
		await fireEvent.click(nodeEl(container, "sub"));
		await waitFor(() => expect(getAllByTestId("chat-graph-crumb")).toHaveLength(3));

		// Middle crumb: back to the turn trace, one frame still above the root.
		await fireEvent.click(getAllByTestId("chat-graph-crumb")[1]!);
		await waitFor(() => expect(crumbText(getAllByTestId)).toEqual(["Conversation", "First ask"]));

		// Root crumb: back to level 1, where there is nothing left to navigate.
		await fireEvent.click(getAllByTestId("chat-graph-crumb")[0]!);
		await waitFor(() => expect(queryAllByTestId("chat-graph-crumb")).toHaveLength(0));
		await waitFor(() => expect(nodeEl(container, "p1")).not.toBeNull());
	});

	test("a leaf node shows details without navigating", async () => {
		const spy = stubFetch({ [L1_URL]: LEVEL_1, [L2_URL]: LEVEL_2 });
		const { container, findByTestId, queryAllByTestId } = open();
		await findByTestId("chat-graph-canvas");
		await fireEvent.click(nodeEl(container, "p1"));
		await waitFor(() => expect(nodeEl(container, "tc1")).not.toBeNull());
		const callsBefore = spy.mock.calls.length;
		await fireEvent.click(nodeEl(container, "tc1"));
		const detail = await findByTestId("chat-graph-detail");
		expect(detail).toHaveTextContent("bash");
		expect(detail).toHaveTextContent("Tool · succeeded · 120ms");
		expect(spy.mock.calls).toHaveLength(callsBefore);
		// Still on level 2 — the leaf click selected, it did not navigate.
		expect(queryAllByTestId("chat-graph-crumb")).toHaveLength(2);
	});

	test("a node with no known duration shows an em dash, never 0ms", async () => {
		// The em dash lives in the Duration ROW; the glance line omits an unknown
		// duration entirely rather than trailing a dash after the status.
		stubFetch({ [L1_URL]: LEVEL_1 });
		const { container, findByTestId } = open();
		await findByTestId("chat-graph-canvas");
		await fireEvent.click(nodeEl(container, "p2"));
		const detail = await findByTestId("chat-graph-detail");
		expect(detail).toHaveTextContent("Prompt · succeeded");
		expect(detail).toHaveTextContent("Duration —");
		expect(detail.textContent).not.toContain("0ms");
	});

	test("hovering shows the canvas card and leaves the footer selection alone", async () => {
		// The two surfaces are deliberately split: the footer is the pinned
		// record of what you CLICKED (mouse-overable, outside the graph), the
		// canvas card is the transient thing that follows the cursor.
		stubFetch({ [L1_URL]: LEVEL_1, [L2_URL]: LEVEL_2 });
		const { container, findByTestId, queryByTestId } = open();
		await findByTestId("chat-graph-canvas");
		await fireEvent.click(nodeEl(container, "p1"));
		await waitFor(() => expect(nodeEl(container, "tc1")).not.toBeNull());

		await fireEvent.click(nodeEl(container, "tc1"));
		expect(await findByTestId("chat-graph-detail")).toHaveAttribute("data-detail-for", "tc1");

		// Hovering a different node opens the canvas card...
		await fireEvent.mouseEnter(nodeEl(container, "think"), { clientX: 40, clientY: 40 });
		await waitFor(() =>
			expect(queryByTestId("chat-graph-hover-card")).toHaveAttribute("data-detail-for", "think"),
		);
		// ...while the footer still records the selection.
		expect(queryByTestId("chat-graph-detail")).toHaveAttribute("data-detail-for", "tc1");
	});

	test("the footer's kind heading is colour-coded by node kind", async () => {
		stubFetch({ [L1_URL]: LEVEL_1, [L2_URL]: LEVEL_2 });
		const { container, findByTestId } = open();
		await findByTestId("chat-graph-canvas");
		await fireEvent.click(nodeEl(container, "p1"));
		await waitFor(() => expect(nodeEl(container, "sub")).not.toBeNull());
		await fireEvent.click(nodeEl(container, "tc1"));
		const kind = (await findByTestId("chat-graph-detail")).querySelector(".detail-kind");
		expect(kind?.getAttribute("data-kind")).toBe("tool");
	});

	test("the footer persists while the pointer roams the graph", async () => {
		// It is the mouse-overable surface (text can be selected out of it), so
		// it must not flicker away when the pointer merely moves over nodes.
		stubFetch({ [L1_URL]: LEVEL_1, [L2_URL]: LEVEL_2 });
		const { container, findByTestId, queryByTestId } = open();
		await findByTestId("chat-graph-canvas");
		await fireEvent.click(nodeEl(container, "p1"));
		await waitFor(() => expect(nodeEl(container, "tc1")).not.toBeNull());
		await fireEvent.click(nodeEl(container, "tc1"));
		await findByTestId("chat-graph-detail");

		await fireEvent.mouseEnter(nodeEl(container, "think"), { clientX: 30, clientY: 30 });
		await fireEvent.mouseLeave(nodeEl(container, "think"));
		expect(queryByTestId("chat-graph-detail")).toHaveAttribute("data-detail-for", "tc1");
	});

	test("navigating clears the previously selected node's details", async () => {
		stubFetch({ [L1_URL]: LEVEL_1, [L2_URL]: LEVEL_2 });
		const { container, findByTestId, queryByTestId } = open();
		await findByTestId("chat-graph-canvas");
		await fireEvent.click(nodeEl(container, "p1"));
		await findByTestId("chat-graph-detail");
		await fireEvent.click(await findByTestId("chat-graph-back"));
		await waitFor(() => expect(queryByTestId("chat-graph-detail")).toBeNull());
	});
});

describe("ChatGraphPanel conversation switching", () => {
	test("switching conversation re-roots the stack and refetches", async () => {
		const spy = stubFetch({
			[L1_URL]: LEVEL_1,
			[L2_URL]: LEVEL_2,
			[SUB_URL]: SUB_GRAPH,
		});
		const { container, findByTestId, queryByTestId, rerender } = open();
		await findByTestId("chat-graph-canvas");
		await fireEvent.click(nodeEl(container, "p1"));
		await findByTestId("chat-graph-breadcrumb");

		await rerender({ conversationId: "conv-2", open: true });
		await waitFor(() => expect(spy).toHaveBeenCalledWith(SUB_URL));
		// Back to a single-frame stack: no breadcrumb, and the sub-conversation's
		// own level-1 node is what's drawn.
		await waitFor(() => expect(queryByTestId("chat-graph-breadcrumb")).toBeNull());
		await waitFor(() => expect(nodeEl(container, "s-p1")).not.toBeNull());
	});

	test("a response that arrives after the user moved on is discarded", async () => {
		const pending: Array<(r: Response) => void> = [];
		const jsonOf = (g: ChatGraph) =>
			new Response(JSON.stringify(g), { status: 200, headers: { "content-type": "application/json" } });
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(url: string) =>
					new Promise<Response>((resolve) => {
						pending.push((r) => resolve(r));
						// conv-2 resolves immediately; conv-1 is held open.
						if (url === SUB_URL) resolve(jsonOf(SUB_GRAPH));
					}),
			),
		);
		const { container, findByTestId, rerender } = open();
		await waitFor(() => expect(pending).toHaveLength(1));

		await rerender({ conversationId: "conv-2", open: true });
		await findByTestId("chat-graph-canvas");
		await waitFor(() => expect(nodeEl(container, "s-p1")).not.toBeNull());

		// The stale conv-1 response lands last and must not replace conv-2's graph.
		pending[0]!(jsonOf(LEVEL_1));
		await waitFor(() => expect(nodeEl(container, "s-p1")).not.toBeNull());
		expect(nodeEl(container, "p1")).toBeNull();
	});
});
