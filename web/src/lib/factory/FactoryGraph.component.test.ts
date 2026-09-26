import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import FactoryGraph from "./FactoryGraph.svelte";
import FactoryGraphBoundary from "./FactoryGraphBoundary.svelte";
import type { FactoryGraphProjection } from "./model";

// jsdom has no layout engine. @xyflow/svelte observes its container and reads
// CSS transforms; these stand-ins give it a fixed viewport so the real graph
// renders. They change no factory behaviour.
class FixedResizeObserver {
	constructor(private readonly callback: ResizeObserverCallback) {}
	observe(target: Element): void {
		this.callback([{ target, contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
	}
	unobserve(): void {}
	disconnect(): void {}
}
class IdentityMatrix {
	m22 = 1;
	constructor(_transform?: string) {}
}
vi.stubGlobal("ResizeObserver", FixedResizeObserver);
vi.stubGlobal("DOMMatrixReadOnly", IdentityMatrix);

function graph(labels: Record<string, number> = { prepare: 0, release: 2 }): FactoryGraphProjection {
	const ids = Object.keys(labels);
	return {
		nodes: ids.map((id, index) => ({
			id,
			nodeId: id,
			kind: index === ids.length - 1 ? ("release" as const) : ("task" as const),
			label: `${id} step`,
			diagnosticCount: labels[id]!,
		})),
		edges: ids.slice(1).map((target, index) => ({ id: `${ids[index]}->${target}`, source: ids[index]!, target })),
		childGraphs: [],
	} as FactoryGraphProjection;
}

function callbacks() {
	return { onSelectNode: vi.fn(), onConnect: vi.fn(), onDeleteNode: vi.fn(), onDeleteEdge: vi.fn() };
}

function node(id: string): HTMLElement {
	const found = screen.getAllByTestId("factory-graph-node").find(element => element.dataset.nodeId === id);
	if (!found) throw new Error(`node ${id} is not rendered`);
	return found;
}

async function rendered(count: number): Promise<void> {
	await waitFor(() => expect(screen.queryAllByTestId("factory-graph-node")).toHaveLength(count), { timeout: 5000 });
}

describe("FactoryGraphBoundary", () => {
	test("shows the loading state, then loads the real graph editor", async () => {
		render(FactoryGraphBoundary, { props: { projection: graph(), ...callbacks() } });
		expect(screen.getByTestId("factory-graph-loading").textContent).toBe("Preparing graph editor…");
		await rendered(2);
		expect(screen.queryByTestId("factory-graph-loading")).toBeNull();
		expect(screen.getByTestId("factory-graph").getAttribute("aria-label")).toBe("Factory graph editor");
	});
});

describe("FactoryGraph", () => {
	test("renders each node's kind, label, and diagnostic count", async () => {
		render(FactoryGraph, { props: { projection: graph({ prepare: 0, review: 1, release: 2 }), ...callbacks() } });
		await rendered(3);
		expect(node("prepare").querySelector(".factory-node-kind")?.textContent).toBe("task");
		expect(node("prepare").querySelector(".factory-node-label")?.getAttribute("title")).toBe("prepare step");
		expect(node("prepare").querySelector(".factory-node-diagnostics")).toBeNull();
		expect(node("prepare").classList.contains("factory-node-invalid")).toBe(false);
		expect(node("review").querySelector(".factory-node-diagnostics")?.textContent).toBe("1 issue");
		expect(node("release").querySelector(".factory-node-diagnostics")?.textContent).toBe("2 issues");
		expect(node("release").classList.contains("factory-node-invalid")).toBe(true);
		expect(screen.queryByText("No nodes in this graph.")).toBeNull();
	});

	test("an empty graph shows the empty-state guidance and no nodes", async () => {
		render(FactoryGraph, { props: { projection: graph({}), ...callbacks() } });
		expect(screen.getByText("No nodes in this graph.")).toBeTruthy();
		expect(screen.getByText("Add a node from the inspector to start this scope.")).toBeTruthy();
		await rendered(0);
	});

	test("the selected node follows the selectedNodeId prop", async () => {
		const props = { projection: graph(), selectedNodeId: "prepare", ...callbacks() };
		const view = render(FactoryGraph, { props });
		await rendered(2);
		await waitFor(() => expect(node("prepare").classList.contains("factory-node-selected")).toBe(true));
		expect(node("release").classList.contains("factory-node-selected")).toBe(false);
		await view.rerender({ ...props, selectedNodeId: "release" });
		await waitFor(() => expect(node("release").classList.contains("factory-node-selected")).toBe(true));
		expect(node("prepare").classList.contains("factory-node-selected")).toBe(false);
		await view.rerender({ ...props, selectedNodeId: null });
		await waitFor(() => expect(node("release").classList.contains("factory-node-selected")).toBe(false));
	});

	test("clicking a node selects it, and clicking the pane clears the selection", async () => {
		const handlers = callbacks();
		const { container } = render(FactoryGraph, { props: { projection: graph(), ...handlers } });
		await rendered(2);
		await fireEvent.click(node("release"));
		expect(handlers.onSelectNode).toHaveBeenLastCalledWith("release");
		const pane = container.querySelector(".svelte-flow__pane");
		expect(pane).not.toBeNull();
		await fireEvent.click(pane!);
		expect(handlers.onSelectNode).toHaveBeenLastCalledWith(null);
	});

	test("deleting the selected node reports the node and each edge that touched it", async () => {
		const handlers = callbacks();
		render(FactoryGraph, { props: { projection: graph(), selectedNodeId: "release", ...handlers } });
		await rendered(2);
		await waitFor(() => expect(node("release").classList.contains("factory-node-selected")).toBe(true));
		await fireEvent.keyDown(document.body, { key: "Delete" });
		await waitFor(() => expect(handlers.onDeleteNode).toHaveBeenCalledWith("release"));
		expect(handlers.onDeleteNode).toHaveBeenCalledTimes(1);
		expect(handlers.onDeleteEdge).toHaveBeenCalledWith("prepare", "release");
		expect(handlers.onDeleteEdge).toHaveBeenCalledTimes(1);
	});

	test("clicking a source handle, then a target handle, connects the two nodes", async () => {
		const handlers = callbacks();
		render(FactoryGraph, { props: { projection: graph({ prepare: 0, review: 0, release: 0 }), ...handlers } });
		await rendered(3);
		const source = node("prepare").querySelector(".svelte-flow__handle.source");
		const target = node("release").querySelector(".svelte-flow__handle.target");
		expect(source).not.toBeNull();
		expect(target).not.toBeNull();
		// jsdom cannot hit-test; the browser would find the target handle under the pointer.
		const elementFromPoint = vi.fn(() => target);
		Object.defineProperty(document, "elementFromPoint", { value: elementFromPoint, configurable: true });
		await fireEvent.click(source!);
		await fireEvent.click(target!);
		await waitFor(() => expect(handlers.onConnect).toHaveBeenCalledWith("prepare", "release"));
		expect(handlers.onConnect).toHaveBeenCalledTimes(1);
		Reflect.deleteProperty(document, "elementFromPoint");
	});

	test("a layout that finishes after a newer projection is discarded", async () => {
		const props = { projection: graph({ prepare: 0, release: 0 }), ...callbacks() };
		const view = render(FactoryGraph, { props });
		await view.rerender({ ...props, projection: graph({ collect: 0, enrich: 0, publish: 0 }) });
		await rendered(3);
		expect(screen.getAllByTestId("factory-graph-node").map(element => element.dataset.nodeId).sort()).toEqual(["collect", "enrich", "publish"]);
	});
});
