import { beforeEach, describe, expect, test, vi } from "vitest";
import { layoutFactoryGraph } from "./layout";

// ELK is wrapped, not replaced: by default every layout runs through the real
// engine, and the wrapper records what it was given. A test may instead supply
// ELK's answer, to reach positions a real layout never produces.
const elk = vi.hoisted(() => ({
	constructed: 0,
	inputs: [] as unknown[],
	answer: null as null | { children?: { id: string; x?: number; y?: number }[] },
}));

vi.mock("elkjs/lib/elk.bundled.js", async importOriginal => {
	const { default: RealElk } = await importOriginal<typeof import("elkjs/lib/elk.bundled.js")>();
	class RecordingElk {
		private readonly real = new RealElk();
		constructor() {
			elk.constructed += 1;
		}
		async layout(graph: Parameters<InstanceType<typeof RealElk>["layout"]>[0]) {
			elk.inputs.push(structuredClone(graph));
			return elk.answer ?? this.real.layout(graph);
		}
	}
	return { default: RecordingElk };
});

beforeEach(() => {
	elk.constructed = 0;
	elk.inputs = [];
	elk.answer = null;
});

const projection = {
	nodes: [
		{ id: "prepare", nodeId: "prepare", kind: "task" as const, label: "Prepare a very long candidate label", diagnosticCount: 0 },
		{ id: "release", nodeId: "release", kind: "release" as const, label: "Release", diagnosticCount: 2 },
	],
	edges: [{ id: "prepare->release", source: "prepare", target: "release" }],
	childGraphs: [],
};

describe("factory ELK layout", () => {
	test("lays out the same directed graph deterministically with accessible flow records", async () => {
		const first = await layoutFactoryGraph(projection);
		const second = await layoutFactoryGraph(projection);
		expect(first).toEqual(second);
		expect(first.nodes).toEqual([
			expect.objectContaining({
				id: "prepare",
				type: "factory",
				data: { label: "Prepare a very long candidate label", kind: "task", nodeId: "prepare", diagnosticCount: 0 },
				focusable: true,
				ariaRole: "button",
				ariaLabel: "Prepare a very long candidate label, task",
			}),
			expect.objectContaining({
				id: "release",
				focusable: true,
				ariaRole: "button",
				ariaLabel: "Release, release, 2 diagnostics",
			}),
		]);
		expect(first.nodes[1]!.position.x).toBeGreaterThan(first.nodes[0]!.position.x);
		expect(first.edges).toEqual([
			{ id: "prepare->release", source: "prepare", target: "release", type: "smoothstep", focusable: true, ariaLabel: "release depends on prepare" },
		]);
	});

	test("asks ELK for a seeded, layered, left-to-right orthogonal layout of fixed-size nodes", async () => {
		await layoutFactoryGraph(projection);
		expect(elk.inputs).toEqual([
			{
				id: "root",
				layoutOptions: {
					"elk.algorithm": "layered",
					"elk.direction": "RIGHT",
					"elk.edgeRouting": "ORTHOGONAL",
					"elk.randomSeed": "17",
					"elk.spacing.nodeNode": "44",
					"elk.layered.spacing.nodeNodeBetweenLayers": "96",
				},
				children: [
					{ id: "prepare", width: 224, height: 76 },
					{ id: "release", width: 224, height: 76 },
				],
				edges: [{ id: "prepare->release", sources: ["prepare"], targets: ["release"] }],
			},
		]);
	});

	test("keeps ELK's coordinates and places what ELK leaves unplaced at the origin", async () => {
		elk.answer = { children: [{ id: "prepare", x: 30, y: 45 }, { id: "release" }] };
		const placed = await layoutFactoryGraph(projection);
		expect(placed.nodes.map(node => node.position)).toEqual([{ x: 30, y: 45 }, { x: 0, y: 0 }]);

		elk.answer = { children: [{ id: "prepare", x: 12, y: 0 }] };
		const partial = await layoutFactoryGraph(projection);
		expect(partial.nodes.map(node => node.position)).toEqual([{ x: 12, y: 0 }, { x: 0, y: 0 }]);

		elk.answer = {};
		const unplaced = await layoutFactoryGraph(projection);
		expect(unplaced.nodes.map(node => node.position)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
	});

	test("does not load ELK for an empty graph", async () => {
		expect(await layoutFactoryGraph({ nodes: [], edges: [], childGraphs: [] })).toEqual({ nodes: [], edges: [] });
		expect(elk.constructed).toBe(0);
		expect(elk.inputs).toEqual([]);
	});
});
