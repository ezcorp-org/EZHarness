import { beforeEach, expect, test, vi } from "vitest";

const elk = vi.hoisted(() => ({ layout: vi.fn(), constructed: 0 }));
vi.mock("elkjs/lib/elk.bundled.js", () => ({
	default: class {
		constructor() { elk.constructed += 1; }
		layout(graph: unknown) { return elk.layout(graph); }
	},
}));

const { layoutFactoryGraph } = await import("./layout");

const projection = {
	nodes: [
		{ id: "a", nodeId: "a-node", kind: "task" as const, label: "Collect", diagnosticCount: 0 },
		{ id: "b", nodeId: "b-node", kind: "release" as const, label: "Release", diagnosticCount: 3 },
		{ id: "c", nodeId: "c-node", kind: "task" as const, label: "Unplaced", diagnosticCount: 1 },
	],
	edges: [{ id: "a->b", source: "a", target: "b" }],
	childGraphs: [],
};

beforeEach(() => { elk.layout.mockReset(); elk.constructed = 0; });

test("asks ELK for a seeded, layered, right-to-left orthogonal layout of exact node boxes", async () => {
	elk.layout.mockResolvedValue({ children: [{ id: "a", x: 12, y: 5 }, { id: "b", x: 300 }] });
	const result = await layoutFactoryGraph(projection);
	expect(elk.layout).toHaveBeenCalledWith({
		id: "root",
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.direction": "RIGHT",
			"elk.edgeRouting": "ORTHOGONAL",
			"elk.randomSeed": "17",
			"elk.spacing.nodeNode": "44",
			"elk.layered.spacing.nodeNodeBetweenLayers": "96",
		},
		children: [{ id: "a", width: 224, height: 76 }, { id: "b", width: 224, height: 76 }, { id: "c", width: 224, height: 76 }],
		edges: [{ id: "a->b", sources: ["a"], targets: ["b"] }],
	});
	// A missing coordinate is the origin; a missing node is placed at the origin too.
	expect(result.nodes.map(node => node.position)).toEqual([{ x: 12, y: 5 }, { x: 300, y: 0 }, { x: 0, y: 0 }]);
	expect(result.nodes[0]).toEqual({
		id: "a", type: "factory", position: { x: 12, y: 5 },
		data: { label: "Collect", kind: "task", nodeId: "a-node", diagnosticCount: 0 },
		focusable: true, ariaRole: "button", ariaLabel: "Collect, task",
	});
	expect(result.nodes[1]!.ariaLabel).toBe("Release, release, 3 diagnostics");
	expect(result.edges).toEqual([{ id: "a->b", source: "a", target: "b", type: "smoothstep", focusable: true, ariaLabel: "b depends on a" }]);
});

test("tolerates a layout with no children, and never builds ELK for an empty graph", async () => {
	elk.layout.mockResolvedValue({});
	expect((await layoutFactoryGraph(projection)).nodes.every(node => node.position.x === 0 && node.position.y === 0)).toBe(true);
	elk.constructed = 0;
	expect(await layoutFactoryGraph({ nodes: [], edges: [{ id: "x", source: "a", target: "b" }], childGraphs: [] })).toEqual({ nodes: [], edges: [] });
	expect(elk.constructed).toBe(0);
});
